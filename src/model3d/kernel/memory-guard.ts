/**
 * The hard WebAssembly memory limit of the geometry kernel (docs/SECURITY-REVIEW.md E-20).
 *
 * Which mechanism applies, and why: manifold.wasm defines and exports its own linear memory
 * (256 pages initial, 65,536 pages = 4 GiB maximum) and imports none
 * (tests/model3d-wasm-memory.test.ts), so it cannot be handed a smaller
 * `new WebAssembly.Memory({ initial, maximum })`. Every growth of that memory goes through
 * Emscripten's `growMemory` in manifold.js, which calls `wasmMemory.grow(pages)` from JavaScript
 * (the same test checks this). So the guard replaces `WebAssembly.Memory.prototype.grow` in the
 * realm before the module is instantiated and refuses any growth that would take a memory past the
 * limit. The refused `grow` throws; Emscripten's `emscripten_resize_heap` catches that and retries
 * with less headroom (1.2x, then 1.1x, then 1.05x the current size, never below what was asked
 * for). If a retry fits under the limit, the allocation succeeds and the operation goes on
 * normally. If every attempt is refused, the allocator reports out of memory and the C++ operation
 * fails with an exception (or an abort) that reaches the JavaScript caller.
 *
 * The guard does not see a `memory.grow` instruction executed by the WebAssembly code itself;
 * manifold.wasm is an Emscripten JS-runtime build, whose heap growth always calls the imported
 * `emscripten_resize_heap` (checked by the test above, and by the measurements in
 * docs/3D-KERNEL.md, where no operation ever passed the limit).
 *
 * The active `MemoryScope` records every refusal (`refusedBytes`, `refusals`) and whether the last
 * growth attempt was refused (`lastRefused`). `memoryLimitStopped` decides a request's fate: the
 * limit stopped it when it threw after a refusal, or when the last growth attempt was refused (an
 * allocation that finally failed, even if the code carried on). Then the caller discards the
 * module, because an allocation failure in the middle of C++ code may leave it inconsistent. A
 * refusal followed by a successful smaller retry is not a failure. `resetMemoryEvents` starts a
 * new request. The worker (manifold.worker.ts) uses one ambient scope for its whole life; the in-process kernel
 * (manifold-direct.ts, opt-in) scopes each synchronous Boolean with `runWithMemoryLimit`, so other
 * WebAssembly in the same Node process is not affected outside those calls.
 */

/** Bytes per WebAssembly page. */
export const WASM_PAGE_BYTES = 65_536;

/** The kernel's hard WebAssembly memory limit: 1 GiB (owner decision; do not raise without review). */
export const KERNEL_MEMORY_LIMIT_BYTES = 1024 * 1024 * 1024;

/** KERNEL_MEMORY_LIMIT_BYTES in WebAssembly pages (16,384). */
export const KERNEL_MEMORY_LIMIT_PAGES = KERNEL_MEMORY_LIMIT_BYTES / WASM_PAGE_BYTES;

/** Initial size of manifold.wasm's memory (256 pages), the floor of every peak measurement. */
export const MANIFOLD_INITIAL_MEMORY_BYTES = 256 * WASM_PAGE_BYTES;

/** "1 GiB" style text for a byte count (whole GiB, else whole MiB). */
export function memoryLimitText(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return Number.isInteger(gib) ? `${gib} GiB` : `${Math.round(bytes / 1024 ** 2)} MiB`;
}

/** What one guarded period saw. */
export interface MemoryScope {
  readonly limitBytes: number;
  /** The largest size a refused growth asked for (bytes) since the last reset, or null. */
  refusedBytes: number | null;
  /** Refused growth attempts since the last reset. */
  refusals: number;
  /** True when the most recent growth attempt was refused (a later permitted growth clears it). */
  lastRefused: boolean;
  /** The largest memory size reached by a permitted growth in this scope (bytes; 0 = no growth). */
  peakBytes: number;
}

/** A fresh scope with `limitBytes` (default KERNEL_MEMORY_LIMIT_BYTES). */
export function memoryScope(limitBytes: number = KERNEL_MEMORY_LIMIT_BYTES): MemoryScope {
  if (!(limitBytes > 0) || limitBytes % WASM_PAGE_BYTES !== 0) throw new RangeError(`memory limit must be a positive multiple of ${WASM_PAGE_BYTES} bytes`);
  return { limitBytes, refusedBytes: null, refusals: 0, lastRefused: false, peakBytes: 0 };
}

/** Forget the refusals of earlier requests (the peak is kept: memory never shrinks). */
export function resetMemoryEvents(scope: MemoryScope): void {
  scope.refusedBytes = null;
  scope.refusals = 0;
  scope.lastRefused = false;
}

/** True when the most recent growth attempt in `scope` was refused. */
export function memoryLimitReached(scope: MemoryScope): boolean {
  return scope.lastRefused;
}

/**
 * Did the memory limit stop the request that just ran in `scope`? `threw`: the operation threw
 * (or aborted). A refusal that a smaller retry recovered from does not count unless it threw.
 */
export function memoryLimitStopped(scope: MemoryScope, threw: boolean): boolean {
  return scope.lastRefused || (threw && scope.refusals > 0);
}

type Grow = (this: WebAssembly.Memory, delta: number) => number;

let originalGrow: Grow | null = null;
let ambient: MemoryScope | null = null;
let active: MemoryScope | null = null;

/** Replace WebAssembly.Memory.prototype.grow once in this realm (idempotent). */
function installGuard(): void {
  if (originalGrow) return;
  const proto = WebAssembly.Memory.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'grow');
  const value: unknown = descriptor?.value;
  if (typeof value !== 'function') throw new Error('WebAssembly.Memory.prototype.grow is not available');
  const grow = value as Grow;
  originalGrow = grow;
  function guardedGrow(this: WebAssembly.Memory, delta: number): number {
    const scope = active ?? ambient;
    if (!scope) return grow.call(this, delta);
    const pages = Number(delta);
    const before = this.buffer.byteLength;
    if (Number.isFinite(pages) && pages > 0 && before + pages * WASM_PAGE_BYTES > scope.limitBytes) {
      const asked = before + pages * WASM_PAGE_BYTES;
      scope.refusedBytes = Math.max(scope.refusedBytes ?? 0, asked);
      scope.refusals++;
      scope.lastRefused = true;
      throw new RangeError(`WebAssembly.Memory.grow(): refused growth to ${asked} bytes; the 3D kernel memory limit is ${scope.limitBytes} bytes`);
    }
    const result = grow.call(this, delta);
    scope.lastRefused = false;
    scope.peakBytes = Math.max(scope.peakBytes, this.buffer.byteLength);
    return result;
  }
  Object.defineProperty(proto, 'grow', { ...descriptor, value: guardedGrow });
}

/**
 * Make `scope` apply to every memory growth in this realm from now on (the kernel worker calls it
 * before instantiating the module). Pass null to stop applying an ambient limit.
 */
export function setAmbientMemoryLimit(scope: MemoryScope | null): void {
  installGuard();
  ambient = scope;
}

/** Run the synchronous `fn` with `scope` applied to every memory growth it causes. */
export function runWithMemoryLimit<T>(scope: MemoryScope, fn: () => T): T {
  installGuard();
  const previous = active;
  active = scope;
  try {
    return fn();
  } finally {
    active = previous;
  }
}

/** Tests only: restore the original `grow` and forget every scope. */
export function uninstallMemoryGuard(): void {
  if (originalGrow) {
    const descriptor = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, 'grow');
    Object.defineProperty(WebAssembly.Memory.prototype, 'grow', { ...descriptor, value: originalGrow });
  }
  originalGrow = null;
  ambient = null;
  active = null;
}
