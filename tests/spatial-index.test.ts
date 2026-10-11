import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Drawing } from '../src/core/document';
import type { Entity } from '../src/core/entities';
import type { Bounds, Point } from '../src/core/geometry';
import { pickEntity, selectByBox, selectByFence, selectByPolygon } from '../src/core/selection';
import { findObjectSnap, defaultSnapSettings } from '../src/core/snap';
import { spatialIndexSettings, warmSpatialIndex } from '../src/core/spatial-index';
import { wireDegree, wireDegreeCounter } from '../src/electrical/wires';
import { bigDrawing, PERF_BLOCK } from './helpers/big-drawing';

// The spatial index (src/core/spatial-index.ts) must give exactly the linear scan's results:
// same entities, same order, same tie-breaks. Timings are tests/perf-dense.test.ts (JCAD_BENCH=1).

const ids = (es: readonly Entity[] | Entity | null) => (es === null ? [] : Array.isArray(es) ? es.map((e) => e.id) : [(es as Entity).id]);

/** Run with the index off, then on (built first), and return both results. */
function both<T>(fn: () => T, warm: () => void): { linear: T; indexed: T } {
  spatialIndexSettings.enabled = false;
  const linear = fn();
  spatialIndexSettings.enabled = true;
  warm();
  return { linear, indexed: fn() };
}

describe('spatial index: same results as the linear scan on a 6,000-entity drawing', () => {
  const doc = new Drawing(bigDrawing(4500, 1000, 500));
  const ents = doc.entities;
  const lookup = doc.lookupBlock;
  const none = new Set<string>();
  const warm = () => void warmSpatialIndex(ents, lookup);
  afterAll(() => {
    spatialIndexSettings.enabled = true;
  });

  it('pick at 150 points (hover / click), including hidden and locked layers', () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const points: Point[] = Array.from({ length: 150 }, () => ({ x: rnd() * 210 - 5, y: rnd() * 160 - 5 }));
    const r = both(() => points.map((p) => pickEntity(p, ents, lookup, 0.15, none)?.id ?? null), warm);
    expect(r.indexed).toEqual(r.linear);
    expect(r.linear.filter(Boolean).length).toBeGreaterThan(20);
    const h = both(() => points.map((p) => pickEntity(p, ents, lookup, 0.15, new Set(['WIRES']), new Set(['SYMS']))?.id ?? null), warm);
    expect(h.indexed).toEqual(h.linear);
  });

  it('window / crossing / fence / polygon selection and object snap', () => {
    const boxes: Bounds[] = [
      { min: { x: 50, y: 40 }, max: { x: 70, y: 55 } },
      { min: { x: -10, y: -10 }, max: { x: 220, y: 170 } },
      { min: { x: 199, y: 149 }, max: { x: 300, y: 300 } },
      { min: { x: 500, y: 500 }, max: { x: 600, y: 600 } },
    ];
    for (const box of boxes)
      for (const mode of ['window', 'crossing'] as const) {
        const r = both(() => ids(selectByBox(box, mode, ents, lookup, none)), warm);
        expect(r.indexed).toEqual(r.linear);
      }
    const fence = [{ x: 10, y: 10 }, { x: 60, y: 70 }, { x: 90, y: 20 }];
    const f = both(() => ids(selectByFence(fence, ents, lookup, none)), warm);
    expect(f.indexed).toEqual(f.linear);
    const poly = [{ x: 30, y: 30 }, { x: 60, y: 35 }, { x: 55, y: 60 }, { x: 28, y: 50 }];
    for (const mode of ['window', 'crossing'] as const) {
      const p = both(() => ids(selectByPolygon(poly, mode, ents, lookup, none)), warm);
      expect(p.indexed).toEqual(p.linear);
    }
    const settings = defaultSnapSettings();
    const at = ents.slice(0, 40).map((e) => (e.type === 'line' ? { x: e.a.x + 0.01, y: e.a.y + 0.01 } : { x: 1, y: 1 }));
    const s = both(() => at.map((p) => findObjectSnap(p, ents, lookup, settings, 0.1, null, none)), warm);
    expect(s.indexed).toEqual(s.linear);
    expect(s.linear.filter(Boolean).length).toBeGreaterThan(10);
  });
});

describe('spatial index edge cases', () => {
  afterAll(() => {
    spatialIndexSettings.minEntities = 2000;
    spatialIndexSettings.enabled = true;
  });
  beforeAll(() => {
    spatialIndexSettings.minEntities = 10;
  });

  const line = (id: string, ax: number, ay: number, bx: number, by: number, layer = '0'): Entity => ({ id, layer, color: 'ByLayer', type: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by } });

  it('agrees with the linear scan with stray far objects, construction lines, overlaps and hidden layers', () => {
    const es: Entity[] = [];
    for (let i = 0; i < 400; i += 1) es.push(line(`L${i}`, (i % 20) * 2, Math.floor(i / 20) * 2, (i % 20) * 2 + 1.5, Math.floor(i / 20) * 2));
    es.push(line('FAR', 1e7, 1e7, 1e7 + 1, 1e7));
    es.push(line('NEG', -5e6, 3, -5e6, 4));
    es.push({ id: 'XL', layer: '0', color: 'ByLayer', type: 'xline', base: { x: 0, y: 0 }, direction: { x: 1, y: 1 } } as Entity);
    es.push(line('BIG', -1, -1, 50, 50));
    es.push(line('DUP', 4, 4, 5.5, 4)); // overlaps L42: tie-breaks must match
    es.push(line('HID', 6, 6, 7, 6, 'HIDDEN'));
    const lookup = () => undefined;
    const hidden = new Set(['HIDDEN']);
    const run = () => {
      const out: unknown[] = [];
      for (let k = 0; k < 300; k += 1) {
        const p = { x: (k * 7.3) % 45 - 2, y: (k * 3.1) % 45 - 2 };
        out.push(pickEntity(p, es, lookup, 0.6, hidden)?.id ?? null);
      }
      out.push(pickEntity({ x: 1e7 + 0.5, y: 1e7 }, es, lookup, 0.1, hidden)?.id ?? null);
      out.push(pickEntity({ x: -5e6, y: 3.5 }, es, lookup, 0.1, hidden)?.id ?? null);
      out.push(ids(selectByBox({ min: { x: 3, y: 3 }, max: { x: 12, y: 9 } }, 'window', es, lookup, hidden)));
      out.push(ids(selectByBox({ min: { x: 3, y: 3 }, max: { x: 12, y: 9 } }, 'crossing', es, lookup, hidden)));
      out.push(ids(selectByBox({ min: { x: 9e6, y: 9e6 }, max: { x: 2e7, y: 2e7 } }, 'window', es, lookup, hidden)));
      out.push(ids(selectByBox({ min: { x: NaN, y: 0 }, max: { x: 1, y: 1 } }, 'crossing', es, lookup, hidden)));
      return JSON.stringify(out);
    };
    spatialIndexSettings.enabled = false;
    const linear = run();
    spatialIndexSettings.enabled = true;
    warmSpatialIndex(es, lookup);
    expect(run()).toBe(linear);
    expect(linear).toContain('"FAR"');
    expect(linear).toContain('"NEG"');
  });

  it('is rebuilt when a block definition changes (same entities array)', () => {
    const doc = new Drawing({ blocks: { [PERF_BLOCK.name]: PERF_BLOCK } });
    const es: Entity[] = [];
    for (let i = 0; i < 50; i += 1) es.push(line(`L${i}`, i, 0, i + 0.5, 0));
    es.push({ id: 'INS', layer: '0', color: 'ByLayer', type: 'insert', block: PERF_BLOCK.name, position: { x: 100, y: 100 }, rotation: 0, scale: 1, attributes: {} });
    doc.addEntities(es);
    const ents = doc.entities;
    warmSpatialIndex(ents, doc.lookupBlock);
    expect(pickEntity({ x: 100.25, y: 100 }, ents, doc.lookupBlock, 0.05, new Set())?.id).toBe('INS');
    expect(pickEntity({ x: 110, y: 100 }, ents, doc.lookupBlock, 0.05, new Set())).toBeNull();
    // Redefine the block far to the right: the entities array is unchanged, the bounds are not.
    doc.patchQuiet((s) => ({ ...s, blocks: { ...s.blocks, [PERF_BLOCK.name]: { ...PERF_BLOCK, entities: [{ id: 'z', layer: '0', color: 'ByLayer', type: 'line', a: { x: 9.5, y: 0 }, b: { x: 10.5, y: 0 } }], attributes: [] } } }));
    expect(doc.entities).toBe(ents);
    expect(pickEntity({ x: 110, y: 100 }, ents, doc.lookupBlock, 0.05, new Set())?.id).toBe('INS');
    expect(pickEntity({ x: 100.25, y: 100 }, ents, doc.lookupBlock, 0.05, new Set())).toBeNull();
  });
});

describe('wire degree for many points (the audit)', () => {
  it('wireDegreeCounter gives exactly wireDegree, with and without the index', () => {
    const st = bigDrawing(2500, 0, 0);
    const ents = st.entities;
    const pts = ents.slice(0, 400).flatMap((e) => (e.type === 'line' ? [e.a, e.b, { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 }] : []));
    pts.push({ x: -50, y: -50 }, { x: 1e9, y: 0 });
    const expected = pts.map((p) => wireDegree(ents, p));
    expect(expected.some((n) => n >= 2)).toBe(true);
    const indexed = wireDegreeCounter(ents);
    expect(pts.map((p) => indexed(p))).toEqual(expected);
    spatialIndexSettings.enabled = false;
    try {
      const linear = wireDegreeCounter(ents);
      expect(pts.map((p) => linear(p))).toEqual(expected);
    } finally {
      spatialIndexSettings.enabled = true;
    }
  });
});
