import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Drawing } from '../src/core/document';
import type { Entity } from '../src/core/entities';
import type { Bounds, Point } from '../src/core/geometry';
import { pickEntity, selectByBox, selectByFence, selectByPolygon } from '../src/core/selection';
import { findObjectSnap, defaultSnapSettings } from '../src/core/snap';
import { spatialIndexSettings, warmSpatialIndex } from '../src/core/spatial-index';
import { writeDxf } from '../src/io/dxf';
import { REPORTS, mergeReports } from '../src/electrical/reports';
import type { Editor as EditorType } from '../src/app/editor';
import { bigDrawing } from './helpers/big-drawing';

// Interactive performance on a dense drawing (50,000 entities) and a 20-drawing project.
// Each measurement is printed with and without the spatial index (src/core/spatial-index.ts);
// docs/PERFORMANCE.md records the numbers. Budgets apply to the indexed path and, like
// tests/perf.test.ts, are about 3x the development container with a floor; JCAD_PERF_FACTOR
// scales them on slow runners. A frame is 16 ms: hover picking and snapping must fit in one.
//
// These runs take tens of seconds of CPU and would disturb the timing budgets of the other test
// files running in parallel, so they only run with JCAD_BENCH=1, on their own:
//   JCAD_BENCH=1 npx vitest run tests/perf-dense.test.ts      (CI: a separate step; npm run bench:node)
// The correctness of the index (same results as the linear scan) is tests/spatial-index.test.ts.
const BENCH = !!process.env.JCAD_BENCH;

const FACTOR = Number(process.env.JCAD_PERF_FACTOR ?? '1') || 1;
const BUDGET = { pick: 16, snap: 16, windowSelect: 16, crossingSelect: 16, indexBuild: 1500, indexRebuild: 250, edit: 250, quietHistory: 250, projectReports: 15000 };

function best<T>(fn: () => T, runs = 5): { ms: number; value: T } {
  let ms = Infinity;
  let value: T | undefined;
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    value = fn();
    ms = Math.min(ms, performance.now() - t0);
  }
  return { ms, value: value as T };
}

/** The same work with the index off (linear scan) and on; prints both. */
function compare<T>(label: string, fn: () => T, runs = 5): { linear: number; indexed: number; a: T; b: T } {
  spatialIndexSettings.enabled = false;
  const l = best(fn, runs);
  spatialIndexSettings.enabled = true;
  const r = best(fn, runs);
  console.log(`perf ${label.padEnd(22)} linear ${l.ms.toFixed(2).padStart(8)} ms   indexed ${r.ms.toFixed(2).padStart(8)} ms`);
  return { linear: l.ms, indexed: r.ms, a: l.value, b: r.value };
}

const ids = (es: readonly Entity[] | Entity | null) => (es === null ? [] : Array.isArray(es) ? es.map((e) => e.id) : [(es as Entity).id]);

describe.skipIf(!BENCH)('dense drawing: 50,000 entities', () => {
  const state = bigDrawing(38_000, 8_000, 4_000);
  const doc = new Drawing(state);
  const lookup = doc.lookupBlock;
  const none = new Set<string>();
  const ents = doc.entities;

  afterAll(() => {
    spatialIndexSettings.enabled = true;
  });

  it('has 50,000 entities', () => {
    expect(ents.length).toBe(50_000);
  });

  it('validates dense edits and quiet history changes within interactive budgets', () => {
    const edited = new Drawing(state);
    let slowest = 0;
    for (let index = 0; index < 30; index += 1) {
      const entity = edited.entities[index]!;
      const started = performance.now();
      edited.replaceEntities([{ ...entity, color: index % 7 + 1 } as Entity]);
      slowest = Math.max(slowest, performance.now() - started);
    }
    const started = performance.now();
    edited.setHeader({ ltscale: 2 });
    const quiet = performance.now() - started;
    console.log(`perf geometry edit (50k)     maximum ${slowest.toFixed(1)} ms; quiet history ${quiet.toFixed(1)} ms`);
    expect(slowest).toBeLessThan(BUDGET.edit * FACTOR);
    expect(quiet).toBeLessThan(BUDGET.quietHistory * FACTOR);
    expect(edited.history().undo).toHaveLength(30);
    expect(edited.undo()).toBe(true);
    expect(edited.header.ltscale).toBe(2);
  });

  it('builds the spatial index within budget', () => {
    spatialIndexSettings.enabled = true;
    const t0 = performance.now();
    // A fresh array (the index is cached per array).
    const copy = [...ents];
    const idx = warmSpatialIndex(copy, lookup);
    const ms = performance.now() - t0;
    console.log(`perf ${'index build (50k)'.padEnd(22)} ${ms.toFixed(1).padStart(8)} ms`);
    expect(idx).not.toBeNull();
    expect(ms).toBeLessThan(BUDGET.indexBuild * FACTOR);
    // After an edit: a new array of (mostly) the same entity objects, whose geometry caches are
    // warm. Best of three (the first rebuilds still pay for JIT compilation).
    let rebuild = Infinity;
    for (let k = 1; k <= 3; k += 1) {
      const edited = [...ents.slice(k), ...ents.slice(0, k)];
      const t1 = performance.now();
      warmSpatialIndex(edited, lookup);
      rebuild = Math.min(rebuild, performance.now() - t1);
    }
    console.log(`perf ${'index rebuild (edit)'.padEnd(22)} ${rebuild.toFixed(1).padStart(8)} ms`);
    expect(rebuild).toBeLessThan(BUDGET.indexRebuild * FACTOR);
  });

  it('pick (hover / click) at 60 points: same result, within a frame', () => {
    warmSpatialIndex(ents, lookup);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const points: Point[] = Array.from({ length: 60 }, () => ({ x: rnd() * 210 - 5, y: rnd() * 160 - 5 }));
    const r = compare('pick x60', () => points.map((p) => pickEntity(p, ents, lookup, 0.08, none)), 3);
    expect(r.b.map((e) => e?.id ?? null)).toEqual(r.a.map((e) => e?.id ?? null));
    expect(r.b.filter(Boolean).length).toBeGreaterThan(5);
    const perPick = r.indexed / points.length;
    console.log(`perf ${'pick (one)'.padEnd(22)} linear ${(r.linear / points.length).toFixed(3).padStart(8)} ms   indexed ${perPick.toFixed(3).padStart(8)} ms`);
    expect(perPick).toBeLessThan(BUDGET.pick * FACTOR);
  });

  it('window and crossing selection: same result, within a frame', () => {
    warmSpatialIndex(ents, lookup);
    const box: Bounds = { min: { x: 50, y: 40 }, max: { x: 70, y: 55 } };
    const w = compare('window select', () => selectByBox(box, 'window', ents, lookup, none));
    expect(ids(w.b)).toEqual(ids(w.a));
    expect(w.b.length).toBeGreaterThan(100);
    expect(w.indexed).toBeLessThan(BUDGET.windowSelect * FACTOR);
    const c = compare('crossing select', () => selectByBox(box, 'crossing', ents, lookup, none));
    expect(ids(c.b)).toEqual(ids(c.a));
    expect(c.indexed).toBeLessThan(BUDGET.crossingSelect * FACTOR);
    // A window around everything: the index cannot help, and must not be much slower.
    const all = compare('window select (all)', () => selectByBox({ min: { x: -10, y: -10 }, max: { x: 220, y: 170 } }, 'window', ents, lookup, none), 2);
    expect(ids(all.b)).toEqual(ids(all.a));
    expect(all.indexed).toBeLessThan(all.linear * 3 + 50);
  });

  it('fence and polygon selection: same result', () => {
    warmSpatialIndex(ents, lookup);
    const fence = [{ x: 10, y: 10 }, { x: 60, y: 70 }, { x: 90, y: 20 }];
    const f = compare('fence select', () => selectByFence(fence, ents, lookup, none), 2);
    expect(ids(f.b)).toEqual(ids(f.a));
    const poly = [{ x: 30, y: 30 }, { x: 60, y: 35 }, { x: 55, y: 60 }, { x: 28, y: 50 }];
    for (const mode of ['window', 'crossing'] as const) {
      const p = compare(`polygon select ${mode}`, () => selectByPolygon(poly, mode, ents, lookup, none), 2);
      expect(ids(p.b)).toEqual(ids(p.a));
    }
  });

  it('object snap near the cursor: same result, within a frame', () => {
    warmSpatialIndex(ents, lookup);
    const settings = defaultSnapSettings();
    const target = ents[12_345]!;
    if (target.type !== 'line') throw new Error('fixture: expected a line');
    const at = { x: target.a.x + 0.01, y: target.a.y + 0.01 };
    const s = compare('object snap', () => findObjectSnap(at, ents, lookup, settings, 0.1, null, none));
    expect(s.b).toEqual(s.a);
    expect(s.b).not.toBeNull();
    expect(s.indexed).toBeLessThan(BUDGET.snap * FACTOR);
  });
});

// ------------------------------------------------------------------ large project
let Editor: typeof EditorType;
describe.skipIf(!BENCH)('project of 20 drawings: every project-wide report', () => {
  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    g.requestAnimationFrame = () => 1;
    g.cancelAnimationFrame = () => {};
    Editor = (await import('../src/app/editor')).Editor;
  });

  it('reads 20 DXF sheets and builds every report within budget', async () => {
    const { projectDocuments } = await import('../src/app/commands-electrical');
    const canvas = { getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement;
    const ed = new Editor(canvas);
    // 20 sheets of 3,000 wires, 600 tagged components and 300 labels each, held as DXF text.
    const files = new Map<string, string>();
    for (let i = 0; i < 20; i += 1) {
      const st = bigDrawing(3000, 600, 300);
      const ents = st.entities.map((e) => (e.type === 'insert' ? { ...e, attributes: { TAG1: `S${i}-${e.attributes.TAG1}`, MFG: i % 2 ? 'AB' : 'SIEMENS', CAT: `CAT${i % 5}` } } : e));
      files.set(`/proj/sheet${String(i + 1).padStart(2, '0')}.dxf`, writeDxf({ ...st, entities: ents }));
    }
    const paths = [...files.keys()];
    (ed as unknown as { fileBridge: unknown }).fileBridge = {
      openDrawing: async (p: string) => ({ path: p, kind: 'dxf', text: files.get(p)! }),
      openDxf: async () => null,
      saveDxf: async () => null,
    };
    ed.project.drawings = paths.map((p) => ({ file: p })) as typeof ed.project.drawings;
    const t0 = performance.now();
    const docs = await projectDocuments(ed);
    const tRead = performance.now() - t0;
    const t1 = performance.now();
    const sizes: string[] = [];
    for (const def of REPORTS) {
      const t = performance.now();
      const merged = mergeReports(docs.map((d) => ({ drawing: d.name, report: def.build(d.doc) })));
      sizes.push(`${def.key}:${merged.rows.length}/${(performance.now() - t).toFixed(0)}ms`);
    }
    const tReports = performance.now() - t1;
    console.log(`perf ${'project: read 20 DXF'.padEnd(22)} ${tRead.toFixed(0).padStart(8)} ms`);
    console.log(`perf ${`project: ${REPORTS.length} reports`.padEnd(22)} ${tReports.toFixed(0).padStart(8)} ms   (${sizes.join(' ')})`);
    expect(docs.length).toBe(21); // the open (empty) drawing + 20 sheets
    expect(sizes.find((s) => s.startsWith('components:'))).toMatch(/^components:12000\//);
    expect(tRead + tReports).toBeLessThan(BUDGET.projectReports * FACTOR);
  }, 60_000);
});
