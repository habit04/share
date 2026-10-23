import { describe, it, expect, vi, afterEach } from 'vitest';

// P28 PR #42 cleanup (3) — Codex P2: the Promise.try polyfill must be
// the ES2025 algorithm, not `try { Promise.resolve(fn(...args)) }
// catch { Promise.reject(e) }`. The spec (NewPromiseCapability):
// the receiver is the promise constructor — a non-constructor
// receiver throws TypeError BEFORE the callback runs — and the
// callback's result settles a FRESH capability promise of the
// receiver's class, never the callback's own promise returned as-is.
// On Node 24 a native Promise.try exists and serves as the parity
// reference; the shim is forced in by deleting the native property
// and re-importing the module (its install runs at import time, only
// when the method is missing). On Node 22 there is no native: the
// same shapes assert the spec outcomes directly.

type PromiseTryFn = (this: unknown, fn: (...args: readonly unknown[]) => unknown, ...args: unknown[]) => Promise<unknown>;

const nativeDescriptor = Object.getOwnPropertyDescriptor(Promise, 'try');
const nativeTry = nativeDescriptor ? (Promise as unknown as { try: PromiseTryFn }).try : undefined;

function restoreNative(): void {
  if (nativeDescriptor) Object.defineProperty(Promise, 'try', nativeDescriptor);
  else delete (Promise as { try?: unknown }).try;
}
afterEach(restoreNative);

/** Delete Promise.try and re-import the shim module so its install path runs. */
async function installShim(): Promise<PromiseTryFn> {
  delete (Promise as { try?: unknown }).try;
  vi.resetModules();
  await import('../src/io/pdfjs-runtime-shims');
  return (Promise as unknown as { try: PromiseTryFn }).try;
}

function shapes(name: string, getImpl: () => PromiseTryFn | Promise<PromiseTryFn>): void {
  describe(name, () => {
    it('resolves with the callback value and passes the arguments through', async () => {
      const impl = await getImpl();
      const seen: unknown[][] = [];
      const result = impl.call(Promise, (a, b) => {
        seen.push([a, b]);
        return (a as number) + (b as number);
      }, 2, 3);
      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBe(5);
      expect(seen).toEqual([[2, 3]]);
    });

    it('rejects with the exact error the callback throws', async () => {
      const impl = await getImpl();
      const err = new Error('boom');
      await expect(impl.call(Promise, () => { throw err; })).rejects.toBe(err);
    });

    it('adopts a returned promise but never returns it as-is; subclass receivers are honored', async () => {
      const impl = await getImpl();
      class Sub extends Promise<unknown> {}
      const inner = Promise.resolve(7);
      const out = impl.call(Sub, () => inner);
      expect(out).not.toBe(inner);
      expect(out).toBeInstanceOf(Sub);
      await expect(out).resolves.toBe(7);
      const plain = impl.call(Sub, () => 9);
      expect(plain).toBeInstanceOf(Sub);
      await expect(plain).resolves.toBe(9);
    });

    it('throws TypeError for a non-constructor receiver BEFORE calling the callback', async () => {
      const impl = await getImpl();
      let calls = 0;
      const fn = (): number => { calls += 1; return 1; };
      expect(() => impl.call({}, fn)).toThrow(TypeError);
      expect(() => impl.call(() => 1, fn)).toThrow(TypeError);
      expect(calls).toBe(0);
    });
  });
}

if (nativeTry) shapes('native Promise.try (parity reference)', () => nativeTry);
shapes('Promise.try polyfill (forced installation)', installShim);

describe('Promise.try polyfill installation', () => {
  it('installs with the spec property shape: non-enumerable, writable, configurable', async () => {
    const shim = await installShim();
    expect(typeof shim).toBe('function');
    const descriptor = Object.getOwnPropertyDescriptor(Promise, 'try');
    expect(descriptor).toMatchObject({ enumerable: false, writable: true, configurable: true });
    expect(Object.keys(Promise)).not.toContain('try');
  });

  it('installs ONLY when missing: a present native Promise.try is left untouched', async () => {
    vi.resetModules();
    await import('../src/io/pdfjs-runtime-shims');
    if (nativeTry) {
      expect((Promise as unknown as { try: PromiseTryFn }).try).toBe(nativeTry);
    } else {
      // Node 22: nothing was there, so the import installed the shim.
      expect(typeof (Promise as unknown as { try?: unknown }).try).toBe('function');
    }
  });
});
