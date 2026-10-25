// P28 hygiene slice — R-5 #11(ii) PAGE-CHANGE PIN.
//
// The finish-slice adjudication (p28-finish-logs/ADJUDICATION.md, item 4)
// discharged R-5 #11 compositionally and recorded one coverage gap:
// trigger (ii) PAGE CHANGE had no dedicated named test. It was enforced
// only structurally — pageIndex is a component of BOTH entry key builders
// (startLoad, which stores entries, and keyFor, which looks them up).
//
// This file pins the trigger three ways:
//   a. behaviourally, on the ready path: a page edit serves the NEW page's
//      raster, never the old page's; returning to a rendered page serves
//      its retained entry synchronously, with no re-render.
//   b. behaviourally, mid-flight: a raster that lands after the page edit
//      never publishes for the new page.
//   c. structurally: pageIndex is a component of both key builders. The
//      behavioural tests cannot see a one-sided keyFor regression —
//      startLoad's own dedupe plus the bestReady pageIndex field check
//      mask it — so the enforcement mechanism itself is pinned here,
//      in the repo's established source-reading test style
//      (tests/about.test.ts, tests/ai-host.test.ts).
//
// Mutation check (recorded in p28-hygiene-logs/page-change-pin.md):
// removing pageIndex from startLoad fails (a) and (b); removing it from
// keyFor fails (c). The pin passes on the real tree.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UnderlayEntity } from '../src/core/entities';
import type { UnderlayDefinition } from '../src/core/underlay';
import { type UnderlayDocument, type UnderlayRaster, type UnderlayRasterEngine, type UnderlayResult } from '../src/io/underlay-engine';
import { createUnderlayDisplayService } from '../src/app/underlay-render';

const tick = async (n = 3): Promise<void> => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

interface PendingCall {
  readonly method: 'open' | 'pageSize' | 'renderPage';
  readonly page?: number;
  settle: (value: unknown) => void;
  settled: boolean;
}

/** Page-aware fake engine: every page has a DISTINCT size and renders a
 * DISTINCT raster tag, so cross-page serving is directly observable.
 * Calls park until settled (or auto-settle on a microtask in auto mode). */
function pageEngine() {
  const pageCount = 3;
  const sizeOf = (p: number): { width: number; height: number } => ({ width: 100 * p + 100, height: 50 * p + 50 });
  const state = {
    opens: 0,
    closes: 0,
    /** Pages passed to renderPage, in call order — the render census. */
    renders: [] as number[],
    calls: [] as PendingCall[],
    auto: false,
  };
  const resultFor = (call: PendingCall): unknown => {
    if (call.method === 'pageSize') return { ok: true, value: sizeOf(call.page!) };
    if (call.method === 'renderPage') {
      const size = sizeOf(call.page!);
      return { ok: true, value: { image: { tag: `raster-page-${call.page}` }, width: size.width * 2, height: size.height * 2, pageSize: size } };
    }
    return undefined; // open is settled with the document below
  };
  const park = <T>(method: PendingCall['method'], page?: number): Promise<T> => new Promise<T>((resolve) => {
    const call: PendingCall = {
      method, page, settled: false,
      settle: (value: unknown) => { if (!call.settled) { call.settled = true; resolve(value as T); } },
    };
    state.calls.push(call);
    if (state.auto && method !== 'open') queueMicrotask(() => call.settle(resultFor(call)));
  });
  const makeDoc = (): UnderlayDocument => ({
    pageCount,
    pageSize: (page: number) => park<UnderlayResult<{ width: number; height: number }>>('pageSize', page),
    renderPage: (page: number) => { state.renders.push(page); return park<UnderlayResult<UnderlayRaster>>('renderPage', page); },
    renderRegion: () => { throw new Error('the pin never renders regions'); },
    close() { state.closes += 1; },
  });
  const engine: UnderlayRasterEngine = {
    kind: 'pdf',
    open: () => {
      state.opens += 1;
      const p = park<UnderlayResult<UnderlayDocument>>('open');
      if (state.auto) queueMicrotask(() => {
        const call = state.calls[state.calls.length - 1]!;
        call.settle({ ok: true, value: makeDoc() });
      });
      return p;
    },
  };
  const settleAll = (): void => {
    for (const call of [...state.calls]) {
      if (call.settled) continue;
      if (call.method === 'open') call.settle({ ok: true, value: makeDoc() });
      else call.settle(resultFor(call));
    }
  };
  const pump = async (): Promise<void> => {
    state.auto = true;
    for (let i = 0; i < 12; i += 1) { settleAll(); await tick(1); }
  };
  return { engine, state, settleAll, pump };
}

const def = (over: Partial<UnderlayDefinition> = {}): UnderlayDefinition => ({
  id: 'underlaydef:41', handle: '41', kind: 'pdf', sourcePath: 'plans\\floor.pdf', retainedGroups: [], ...over,
});
const placement = (over: Partial<UnderlayEntity> = {}): UnderlayEntity => ({
  id: 'u1', layer: 'U', color: 'ByLayer', type: 'underlay', kind: 'pdf', definitionHandle: '41',
  position: { x: 0, y: 0 }, scaleX: 1, scaleY: 1, rotation: 0, flags: 2, retainedGroups: [], ...over,
});
const BYTES = new Uint8Array([1, 2, 3]);

describe('R-5 #11(ii) page-change retirement pin', () => {
  it('11(ii)-a. page change serves the new page, never the old raster; returning serves the retained entry without re-render', async () => {
    const h = pageEngine();
    h.state.auto = true;
    let current = def({ page: '1' });
    const svc = createUnderlayDisplayService({
      engine: h.engine, bytesFor: async () => BYTES, definitions: () => ({ a: current }),
    });
    svc.source(placement());
    await h.pump();
    const first = svc.source(placement());
    expect(first?.page).toEqual({ width: 200, height: 100 });
    expect(first?.image?.bitmap).toEqual({ tag: 'raster-page-1' });
    expect(h.state.renders).toEqual([1]);

    // The page edit: same definition identity, same path, page 1 -> page 2.
    current = def({ page: '2' });
    const during = svc.source(placement());
    expect(during?.image).toBeUndefined(); // the old page's raster is never served for the new page
    await h.pump();
    const second = svc.source(placement());
    expect(second?.page).toEqual({ width: 300, height: 150 });
    expect(second?.image?.bitmap).toEqual({ tag: 'raster-page-2' });
    expect(h.state.renders).toEqual([1, 2]);

    // Returning to page 1 serves its RETAINED entry synchronously — the
    // page-1 load is not repeated, because page 1's entry still keys apart
    // from page 2's.
    current = def({ page: '1' });
    const back = svc.source(placement());
    expect(back?.image?.bitmap).toEqual({ tag: 'raster-page-1' });
    await h.pump();
    expect(h.state.renders).toEqual([1, 2]);
  });

  it('11(ii)-b. page change mid-flight: the old page\'s late raster never publishes for the new page', async () => {
    const h = pageEngine();
    let current = def({ page: '1' });
    const svc = createUnderlayDisplayService({
      engine: h.engine, bytesFor: async () => BYTES, definitions: () => ({ a: current }),
    });
    svc.source(placement());
    // Drive the page-1 load until its render is parked inside the engine.
    for (let i = 0; i < 6 && !h.state.calls.some((c) => c.method === 'renderPage' && !c.settled); i += 1) {
      h.settleAll(); await tick(1);
    }
    expect(h.state.renders).toEqual([1]);

    // The page edit lands while page 1's render is still in flight.
    current = def({ page: '2' });
    h.settleAll(); // page 1's raster now lands, after the edit
    await tick();
    // It may retire into page 1's own entry, but it must NOT publish for
    // page 2: the placement shows frame + label until page 2 lands.
    expect(svc.source(placement())?.image).toBeUndefined();
    await h.pump();
    const second = svc.source(placement());
    expect(second?.page).toEqual({ width: 300, height: 150 });
    expect(second?.image?.bitmap).toEqual({ tag: 'raster-page-2' });
    expect(h.state.renders).toEqual([1, 2]); // page 2 rendered exactly once, page 1 never re-rendered
  });

  it('11(ii)-c. structural: pageIndex is a component of BOTH entry key builders (startLoad and keyFor)', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const src = readFileSync(join(root, 'src/app/underlay-render.ts'), 'utf8');
    const segments = (list: string): string[] => list.split(',').map((x) => x.trim());
    // startLoad's stored-entry key: `const key = [...]`.
    const stored = /const key = \[([^\]]+)\]\.join\('\|'\)/.exec(src);
    expect(stored).not.toBeNull();
    expect(segments(stored![1]!)).toHaveLength(7);
    expect(segments(stored![1]!)).toContain('pageIndex');
    // keyFor's lookup key: the array literal in the keyFor builder.
    const keyForAt = src.indexOf('const keyFor');
    expect(keyForAt).toBeGreaterThan(0);
    const lookup = /\[([^\]]+)\]\.join\('\|'\)/.exec(src.slice(keyForAt));
    expect(lookup).not.toBeNull();
    expect(segments(lookup![1]!)).toHaveLength(7);
    expect(segments(lookup![1]!)).toContain('underlayPageIndex(def)');
  });
});
