// P28 finish slice — R-5 gate tests for the redesigned display service
// (design section 3.7 + addendum A.3.4 + the Codex sourceVersion tests).
// Written BEFORE the section 3 rewrite: the red state is recorded in
// ~/workspace/jcad-six/p28-finish-logs/step1-red-state.md.
//
// The harness is the one the manifest verification called for: a DEFERRED,
// SIGNAL-AWARE, CLOSE-COUNTING fake engine. The fake in
// tests/underlay-engine.test.ts resolves on microtasks, ignores opts.signal
// and has an uncounted no-op close(); none of the retirement tests can be
// expressed against it.

import { describe, it, expect } from 'vitest';
import type { UnderlayEntity } from '../src/core/entities';
import type { UnderlayDefinition } from '../src/core/underlay';
import { underlayRefusal, type UnderlayRasterEngine, type UnderlayResult } from '../src/io/underlay-engine';
import { createUnderlayDisplayService } from '../src/app/underlay-render';

const tick = async (n = 3): Promise<void> => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

interface PendingCall {
  readonly method: 'open' | 'pageSize' | 'renderPage' | 'renderRegion';
  readonly signal?: AbortSignal;
  settle: (value: unknown) => void;
  settled: boolean;
}

/** Deferred fake engine: every call parks until the test settles it. An
 * abort of the call's signal settles it as a `cancelled` refusal, exactly
 * like the real adapter contract. close() is counted. */
export function deferredEngine(opts: { pages?: number; pageW?: number; pageH?: number } = {}) {
  const pageCount = opts.pages ?? 3;
  const pw = opts.pageW ?? 200;
  const ph = opts.pageH ?? 100;
  const state = {
    opens: 0,
    closes: 0,
    calls: [] as PendingCall[],
    /** When set, calls settle themselves on the next microtask. */
    auto: false,
  };
  const resultFor = (call: PendingCall): unknown => {
    if (call.method === 'pageSize') return { ok: true, value: { width: pw, height: ph } };
    if (call.method === 'renderPage') return { ok: true, value: { image: { tag: `page-${state.opens}` }, width: pw * 2, height: ph * 2, pageSize: { width: pw, height: ph } } };
    if (call.method === 'renderRegion') return { ok: true, value: { image: { tag: `region-${state.opens}` }, width: 20, height: 20, pageSize: { width: pw, height: ph }, region: { x: 0, y: 0, width: 10, height: 10 } } };
    return undefined; // open is settled with the document below
  };
  const park = <T>(method: PendingCall['method'], signal?: AbortSignal): Promise<T> => new Promise<T>((resolve) => {
    const call: PendingCall = {
      method, signal, settled: false,
      settle: (value: unknown) => { if (!call.settled) { call.settled = true; resolve(value as T); } },
    };
    state.calls.push(call);
    if (signal) {
      if (signal.aborted) call.settle(underlayRefusal('cancelled', 'aborted'));
      else signal.addEventListener('abort', () => call.settle(underlayRefusal('cancelled', 'aborted')), { once: true });
    }
    if (state.auto && method !== 'open') queueMicrotask(() => call.settle(resultFor(call)));
  });
  const makeDoc = () => ({
    pageCount,
    pageSize: (page: number, o?: { signal?: AbortSignal }) => park<UnderlayResult<{ width: number; height: number }>>('pageSize', o?.signal)
      .then((r) => (page >= 1 && page <= pageCount ? r : underlayRefusal('corrupt', 'out of range'))),
    renderPage: (_page: number, _scale: number, o?: { signal?: AbortSignal }) => park('renderPage', o?.signal),
    renderRegion: (_page: number, _region: unknown, _scale: number, o?: { signal?: AbortSignal }) => park('renderRegion', o?.signal),
    close() { state.closes += 1; },
  });
  const engine: UnderlayRasterEngine = {
    kind: 'pdf',
    open: (_bytes: Uint8Array, o?: { signal?: AbortSignal }) => {
      state.opens += 1;
      const p = park<UnderlayResult<ReturnType<typeof makeDoc>>>('open', o?.signal);
      if (state.auto) queueMicrotask(() => {
        const call = state.calls[state.calls.length - 1]!;
        call.settle({ ok: true, value: makeDoc() });
      });
      return p;
    },
  };
  /** Settle every parked call with its standard success value. */
  const settleAll = (): void => {
    for (const call of [...state.calls]) {
      if (call.settled) continue;
      if (call.method === 'open') call.settle({ ok: true, value: makeDoc() });
      else call.settle(resultFor(call));
    }
  };
  /** Drive the service until no new calls appear (auto mode + pumping). */
  const pump = async (): Promise<void> => {
    state.auto = true;
    for (let i = 0; i < 12; i += 1) { settleAll(); await tick(1); }
  };
  return { engine, state, settleAll, pump, makeDoc };
}

const def = (over: Partial<UnderlayDefinition> = {}): UnderlayDefinition => ({
  id: 'underlaydef:41', handle: '41', kind: 'pdf', sourcePath: 'plans\\floor.pdf', retainedGroups: [], ...over,
});
const placement = (over: Partial<UnderlayEntity> = {}): UnderlayEntity => ({
  id: 'u1', layer: 'U', color: 'ByLayer', type: 'underlay', kind: 'pdf', definitionHandle: '41',
  position: { x: 0, y: 0 }, scaleX: 1, scaleY: 1, rotation: 0, flags: 2, retainedGroups: [], ...over,
});

const BYTES_A = new Uint8Array([1, 2, 3]);
const BYTES_B = new Uint8Array([9, 8, 7, 6]);

describe('R-5 gate (design 3.7)', () => {
  it('1. identity is not path: a path-edited copy loads its own file, the original is untouched', async () => {
    const h = deferredEngine();
    const seen: string[] = [];
    const svc = createUnderlayDisplayService({
      engine: h.engine,
      bytesFor: async (d) => { seen.push(d.sourcePath); return BYTES_A; },
      definitions: () => ({ a: def(), b: def({ id: 'underlaydef:99', handle: '99', sourcePath: 'plans\\other.pdf' }) }),
    });
    svc.source(placement());
    await h.pump();
    expect(svc.source(placement())?.image).toBeDefined();
    const opensForA = h.state.opens;
    // A different definition (copy with edited path, different id+handle).
    svc.source(placement({ id: 'u2', definitionHandle: '99' }));
    await h.pump();
    expect(h.state.opens).toBeGreaterThan(opensForA);
    expect(seen).toContain('plans\\other.pdf');
  });

  it('2. clear() during load: the late settle publishes nothing and requests no redraw', async () => {
    const h = deferredEngine();
    let redraws = 0;
    const svc = createUnderlayDisplayService({
      engine: h.engine, bytesFor: async () => BYTES_A,
      definitions: () => ({ a: def() }), requestRedraw: () => { redraws += 1; },
    });
    svc.source(placement());
    await tick(); // the load is parked inside the engine
    expect(h.state.calls.some((c) => !c.settled)).toBe(true);
    svc.clear();
    const abortsSeen = h.state.calls.filter((c) => c.signal?.aborted).length;
    expect(abortsSeen).toBeGreaterThan(0); // the in-flight signal was aborted
    h.settleAll();
    await tick();
    expect(redraws).toBe(0);
    // A later source() starts a FRESH load; the retired one never published.
    const again = svc.source(placement());
    expect(again?.image).toBeUndefined();
    await h.pump();
    expect(svc.source(placement())?.image).toBeDefined();
  });

  it('3. clear() during open: the late-opened document is closed, never rendered into the new session', async () => {
    const h = deferredEngine();
    const svc = createUnderlayDisplayService({
      engine: h.engine, bytesFor: async () => BYTES_A, definitions: () => ({ a: def() }),
    });
    svc.source(placement());
    await tick();
    svc.clear();
    h.settleAll(); // the parked open resolves AFTER retirement
    await tick();
    expect(h.state.closes).toBeGreaterThan(0); // late document closed, not leaked
    const renders = h.state.calls.filter((c) => c.method === 'renderPage' || c.method === 'renderRegion');
    expect(renders.every((c) => c.signal?.aborted)).toBe(true);
  });

  it('4. definition edit mid-flight: the settle is dropped; the next source() loads afresh', async () => {
    const h = deferredEngine();
    let current = def();
    const svc = createUnderlayDisplayService({
      engine: h.engine, bytesFor: async () => BYTES_A, definitions: () => ({ a: current }),
    });
    svc.source(placement());
    await tick();
    current = def({ sourcePath: 'plans\\revised.pdf' }); // Save-As class edit: same id, new path
    h.settleAll();
    await tick();
    // Nothing published from the stale-path load.
    expect(svc.source(placement())?.image).toBeUndefined();
    await h.pump();
    expect(svc.source(placement())?.image).toBeDefined();
  });

  it('5. region refinement failure keeps serving the old raster and never marks it failed', async () => {
    const h = deferredEngine();
    h.state.auto = true;
    let region: { x: number; y: number; width: number; height: number } | undefined;
    const svc = createUnderlayDisplayService({
      engine: h.engine, bytesFor: async () => BYTES_A, definitions: () => ({ a: def() }),
      visibleRegion: () => region,
    });
    svc.source(placement());
    await h.pump();
    const whole = svc.source(placement())?.image;
    expect(whole).toBeDefined();
    // Ask for a sub-region the current raster does not cover: a refinement starts...
    region = { x: 150, y: 50, width: 50, height: 50 };
    h.state.auto = false;
    svc.source(placement());
    await tick();
    // ...and FAILS. The old raster keeps serving.
    for (const c of h.state.calls) if (!c.settled) c.settle(underlayRefusal('corrupt', 'refinement failed'));
    await tick();
    expect(svc.source(placement())?.image).toBe(whole);
  });

  it('6. failure posture: a failed load retries only on key change, invalidate, or clear', async () => {
    const h = deferredEngine();
    h.state.auto = true;
    let fail = true;
    let opens = 0;
    const svc = createUnderlayDisplayService({
      engine: {
        kind: 'pdf',
        open: async (b: Uint8Array, o?: { signal?: AbortSignal }) => {
          opens += 1;
          return fail ? underlayRefusal('corrupt', 'bad pdf') : h.engine.open(b, o);
        },
      },
      bytesFor: async () => BYTES_A, definitions: () => ({ a: def() }),
    });
    svc.source(placement());
    await tick(6);
    expect(opens).toBe(1);
    svc.source(placement());
    svc.source(placement());
    await tick(6);
    expect(opens).toBe(1); // settled-failed: redraws never re-open
    fail = false;
    svc.invalidate();
    svc.source(placement());
    await h.pump();
    expect(opens).toBe(2); // invalidate() is the retry surface
    expect(svc.source(placement())?.image).toBeDefined();
  });

  it('7. superseding loads keep serving the old raster until the new one publishes', async () => {
    const h = deferredEngine();
    h.state.auto = true;
    let region: { x: number; y: number; width: number; height: number } | undefined;
    const svc = createUnderlayDisplayService({
      engine: h.engine, bytesFor: async () => BYTES_A, definitions: () => ({ a: def() }),
      visibleRegion: () => region,
    });
    svc.source(placement());
    await h.pump();
    const first = svc.source(placement())?.image;
    expect(first).toBeDefined();
    h.state.auto = false;
    region = { x: 100, y: 0, width: 100, height: 100 }; // a bucket the old raster does not cover
    const during = svc.source(placement());
    expect(during?.image).toBe(first); // old raster served during the superseding load
    await h.pump();
    expect(svc.source(placement())?.image).toBeDefined();
  });

  it('8. eviction: a third definition beyond the entry budget evicts the least recently used; the MRU survives', async () => {
    const h = deferredEngine();
    h.state.auto = true;
    const defs: Record<string, UnderlayDefinition> = {
      a: def(), b: def({ id: 'underlaydef:42', handle: '42', sourcePath: 'p\\b.pdf' }),
      c: def({ id: 'underlaydef:43', handle: '43', sourcePath: 'p\\c.pdf' }),
    };
    const svc = createUnderlayDisplayService({
      engine: h.engine, bytesFor: async () => BYTES_A, definitions: () => defs,
      cacheLimits: { maxEntries: 2 },
    });
    const at = (handle: string) => placement({ id: `u-${handle}`, definitionHandle: handle });
    svc.source(at('41')); await h.pump();
    svc.source(at('42')); await h.pump();
    svc.source(at('41')); // touch 41 -> 42 is now LRU
    svc.source(at('43')); await h.pump();
    expect(svc.source(at('41'))?.image).toBeDefined(); // MRU survived, no reload
    const opensBefore = h.state.opens;
    svc.source(at('42')); // evicted: must load again
    await h.pump();
    expect(h.state.opens).toBeGreaterThan(opensBefore);
  });

  it('9. superseded engine documents are closed exactly once', async () => {
    const h = deferredEngine();
    h.state.auto = true;
    const svc = createUnderlayDisplayService({
      engine: h.engine, bytesFor: async () => BYTES_A, definitions: () => ({ a: def() }),
    });
    svc.source(placement());
    await h.pump();
    expect(h.state.closes).toBe(0);
    svc.invalidate('underlaydef:41');
    svc.source(placement());
    await h.pump();
    expect(h.state.closes).toBe(1); // the superseded session document
    svc.clear();
    expect(h.state.closes).toBe(2); // the live one, at retirement
  });
});

describe('Reload + generation retirement (A.3.4)', () => {
  it('10. Reload happy path: invalidate() retires memos; new bytes serve; the epoch advances', async () => {
    const h = deferredEngine();
    h.state.auto = true;
    let bytes = BYTES_A;
    let fetches = 0;
    const svc = createUnderlayDisplayService({
      engine: h.engine, bytesFor: async () => { fetches += 1; return bytes; }, definitions: () => ({ a: def() }),
    });
    svc.source(placement());
    await h.pump();
    expect(svc.source(placement())?.image).toBeDefined();
    const fetchesBefore = fetches;
    bytes = BYTES_B; // the file changed on disk
    svc.invalidate();
    svc.source(placement());
    await h.pump();
    expect(fetches).toBeGreaterThan(fetchesBefore); // bytes re-captured, not memo-served
    expect(svc.source(placement())?.image).toBeDefined();
  });

  it('12. a stale worker cannot repopulate: settle after invalidate() is dropped', async () => {
    const h = deferredEngine();
    const svc = createUnderlayDisplayService({
      engine: h.engine, bytesFor: async () => BYTES_A, definitions: () => ({ a: def() }),
    });
    svc.source(placement());
    await tick();
    svc.invalidate('underlaydef:41');
    h.settleAll();
    await tick();
    const after = svc.source(placement());
    expect(after?.image).toBeUndefined(); // fresh load started, stale result dropped
    await h.pump();
    expect(svc.source(placement())?.image).toBeDefined();
  });

  it('13. failed reload: the new generation settles failed and never serves the retired raster', async () => {
    const h = deferredEngine();
    h.state.auto = true;
    let failOpen = false;
    const svc = createUnderlayDisplayService({
      engine: {
        kind: 'pdf',
        open: async (b: Uint8Array, o?: { signal?: AbortSignal }) => (failOpen ? underlayRefusal('corrupt', 'now broken') : h.engine.open(b, o)),
      },
      bytesFor: async () => BYTES_A, definitions: () => ({ a: def() }),
    });
    svc.source(placement());
    await h.pump();
    expect(svc.source(placement())?.image).toBeDefined();
    failOpen = true;
    svc.invalidate('underlaydef:41');
    const during = svc.source(placement());
    expect(during?.image).toBeUndefined(); // RETIRED raster is not served after Reload (A.3.2)
    await tick(8);
    expect(svc.source(placement())?.image).toBeUndefined();
    // Recovery: a later Reload with a working file serves again.
    failOpen = false;
    svc.invalidate('underlaydef:41');
    svc.source(placement());
    await h.pump();
    expect(svc.source(placement())?.image).toBeDefined();
  });

  it('Codex test 2: same path, changed bytes — the hash differs, a new entry loads, no cross-serving', async () => {
    const h = deferredEngine();
    h.state.auto = true;
    let bytes = BYTES_A;
    const svc = createUnderlayDisplayService({
      engine: h.engine, bytesFor: async () => bytes, definitions: () => ({ a: def() }),
    });
    svc.source(placement());
    await h.pump();
    const first = svc.source(placement())?.image;
    expect(first).toBeDefined();
    bytes = BYTES_B;
    svc.invalidate('underlaydef:41'); // Reload captures the new snapshot
    svc.source(placement());
    await h.pump();
    const second = svc.source(placement())?.image;
    expect(second).toBeDefined();
    expect(second).not.toBe(first); // rendered from the new snapshot, never cross-served
  });
});

describe('section 3.6 additions', () => {
  it('pageSizeOf reports the loaded page size and ensure() settles with content', async () => {
    const h = deferredEngine();
    h.state.auto = true;
    const svc = createUnderlayDisplayService({
      engine: h.engine, bytesFor: async () => BYTES_A, definitions: () => ({ a: def() }),
    });
    expect(svc.pageSizeOf('underlaydef:41')).toBeUndefined();
    const settled = await svc.ensure(placement());
    expect(settled?.image).toBeDefined();
    expect(svc.pageSizeOf('underlaydef:41')).toEqual({ width: 200, height: 100 });
  });

  it('ensure() on a non-PDF definition resolves definition-only and never opens the engine', async () => {
    const h = deferredEngine();
    const svc = createUnderlayDisplayService({
      engine: h.engine, bytesFor: async () => BYTES_A,
      definitions: () => ({ a: def({ kind: 'dwf' }) }),
    });
    const settled = await svc.ensure(placement({ kind: 'dwf' }));
    expect(settled?.definition.kind).toBe('dwf');
    expect(h.state.opens).toBe(0);
  });
});
