import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { Drawing } from '../src/core/document';
import type { Entity } from '../src/core/entities';
import type { Bounds, Point } from '../src/core/geometry';
import { pickEntity, selectByBox, selectByFence, selectByPolygon } from '../src/core/selection';
import { findObjectSnap, defaultSnapSettings } from '../src/core/snap';
import { spatialIndexSettings, warmSpatialIndex } from '../src/core/spatial-index';
import { defaultLayout } from '../src/core/layouts';
import { PERF_BLOCK } from './helpers/big-drawing';

// Property-style check of src/core/spatial-index.ts: on a randomized drawing of mixed entity kinds,
// every query (pick, window, crossing, fence, polygon, object snap) gives exactly the linear scan's
// result, and it keeps doing so after every kind of edit the editor makes (replace, add, remove,
// undo, redo, a redefined block, a layout switch), because every edit yields a new entities array
// and the index is cached per array.

let seed = 20261011;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pt = (): Point => ({ x: rnd() * 300 - 50, y: rnd() * 200 - 25 });

function randomEntity(id: string, i: number): Entity {
  const layer = i % 13 === 0 ? 'HIDDEN' : i % 17 === 0 ? 'LOCKED' : '0';
  const base = { id, layer, color: 'ByLayer' as const };
  const p = pt();
  switch (i % 7) {
    case 0:
    case 1:
      return { ...base, type: 'line', a: p, b: { x: p.x + rnd() * 8 - 4, y: p.y + rnd() * 8 - 4 } };
    case 2:
      return { ...base, type: 'circle', center: p, radius: 0.2 + rnd() * 3 };
    case 3:
      return { ...base, type: 'arc', center: p, radius: 0.5 + rnd() * 4, startAngle: rnd() * Math.PI, endAngle: Math.PI + rnd() * Math.PI };
    case 4:
      return { ...base, type: 'text', position: p, text: `T${i}`, height: 0.1 + rnd(), rotation: 0, align: 'left' };
    case 5:
      return { ...base, type: 'polyline', points: [p, { x: p.x + rnd() * 5, y: p.y }, { x: p.x + rnd() * 5, y: p.y + rnd() * 5 }], closed: i % 2 === 0 };
    default:
      return { ...base, type: 'insert', block: PERF_BLOCK.name, position: p, rotation: (i % 4) * (Math.PI / 2), scale: 0.5 + rnd() * 2, attributes: { TAG1: `K${i}` } };
  }
}

const ids = (es: readonly Entity[] | Entity | null) => (es === null ? [] : Array.isArray(es) ? es.map((e) => e.id) : [(es as Entity).id]);

/** 200 random queries of every kind against `doc`, as one comparable string. */
function queries(doc: Drawing, seedAt: number): string {
  seed = seedAt;
  const ents = doc.entities;
  const lookup = doc.lookupBlock;
  const hidden = new Set(['HIDDEN']);
  const locked = new Set(['LOCKED']);
  const settings = defaultSnapSettings();
  const out: unknown[] = [];
  for (let k = 0; k < 200; k += 1) {
    const p = pt();
    const aperture = 0.05 + rnd() * 2;
    out.push(pickEntity(p, ents, lookup, aperture, hidden, locked)?.id ?? null);
    const q = pt();
    const min = { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y) };
    // Small boxes too (the typical window around one symbol).
    const box: Bounds = k % 4 === 0 ? { min, max: { x: min.x + rnd() * 6, y: min.y + rnd() * 6 } } : { min, max: { x: Math.max(p.x, q.x), y: Math.max(p.y, q.y) } };
    out.push(ids(selectByBox(box, k % 2 ? 'window' : 'crossing', ents, lookup, hidden, locked)));
    if (k % 5 === 0) out.push(ids(selectByFence([p, q, pt()], ents, lookup, hidden, locked)));
    if (k % 5 === 1) out.push(ids(selectByPolygon([p, q, pt(), pt()], k % 2 ? 'window' : 'crossing', ents, lookup, hidden, locked)));
    // Object snap near an actual entity point, so there is something to find.
    const target = ents[Math.floor(rnd() * ents.length)]!;
    const near = target.type === 'line' ? target.a : target.type === 'circle' || target.type === 'arc' ? { x: target.center.x + target.radius, y: target.center.y } : target.type === 'text' || target.type === 'insert' ? target.position : p;
    const s = findObjectSnap({ x: near.x + 0.01, y: near.y - 0.01 }, ents, lookup, settings, 0.05 + rnd() * 0.5, null, hidden);
    out.push(s ? [s.kind, s.point.x, s.point.y] : null);
  }
  return JSON.stringify(out);
}

/** The queries with the index off, then on (built), must agree. */
function agree(doc: Drawing, seedAt: number): void {
  spatialIndexSettings.enabled = false;
  const linear = queries(doc, seedAt);
  spatialIndexSettings.enabled = true;
  warmSpatialIndex(doc.entities, doc.lookupBlock);
  const indexed = queries(doc, seedAt);
  expect(indexed).toBe(linear);
  // Something was found (the comparison is not trivially empty).
  expect(linear).toMatch(/"[A-Z]\d+"/);
}

describe('spatial index on a randomized drawing of 2,000 mixed entities', () => {
  beforeAll(() => {
    spatialIndexSettings.minEntities = 500;
  });
  afterAll(() => {
    spatialIndexSettings.minEntities = 2000;
    spatialIndexSettings.enabled = true;
  });
  const doc = new Drawing({ blocks: { [PERF_BLOCK.name]: PERF_BLOCK } });
  doc.addEntities(Array.from({ length: 2000 }, (_, i) => randomEntity(`E${i}`, i)));

  it('pick, window / crossing / fence / polygon selection and object snap match the linear scan (200 random queries each)', () => {
    agree(doc, 777);
  });

  it('stays in step through replace, add, remove, undo, redo, a block redefinition and a layout switch', () => {
    const before = doc.entities;
    warmSpatialIndex(before, doc.lookupBlock);
    // 1. Move every 9th entity far away (grips / MOVE / TRIM / EXPLODE all replace entities).
    doc.transact((s) => ({
      ...s,
      entities: s.entities.map((e, i) => {
        if (i % 9 !== 0) return e;
        if (e.type === 'line') return { ...e, a: { x: e.a.x + 500, y: e.a.y }, b: { x: e.b.x + 500, y: e.b.y } };
        if (e.type === 'circle' || e.type === 'arc') return { ...e, center: { x: e.center.x + 500, y: e.center.y } };
        if (e.type === 'text' || e.type === 'insert') return { ...e, position: { x: e.position.x + 500, y: e.position.y } };
        return e;
      }),
    }));
    expect(doc.entities).not.toBe(before);
    agree(doc, 1001);
    // Nothing moved is picked at its old place any more, with or without the index.
    const moved = before.filter((e, i) => i % 9 === 0 && e.type === 'circle');
    expect(moved.length).toBeGreaterThan(5);
    for (const c of moved.slice(0, 10)) {
      if (c.type !== 'circle') continue;
      const hit = pickEntity({ x: c.center.x + c.radius, y: c.center.y }, doc.entities, doc.lookupBlock, 0.01, new Set(), new Set());
      expect(hit?.id).not.toBe(c.id);
    }
    // 2. Add 300 and remove 200.
    doc.addEntities(Array.from({ length: 300 }, (_, i) => randomEntity(`N${i}`, i + 3)));
    agree(doc, 1002);
    doc.transact((s) => ({ ...s, entities: s.entities.filter((_, i) => i % 10 !== 3) }));
    agree(doc, 1003);
    // 3. Undo twice, redo once: the restored arrays are the earlier ones.
    expect(doc.undo()).toBe(true);
    agree(doc, 1004);
    expect(doc.undo()).toBe(true);
    agree(doc, 1005);
    expect(doc.redo()).toBe(true);
    agree(doc, 1006);
    // 4. Redefine the block (same entities array): insert bounds change.
    const bigBlock = { ...PERF_BLOCK, entities: PERF_BLOCK.entities.map((e) => (e.type === 'line' ? { ...e, a: { x: e.a.x * 20, y: e.a.y * 20 }, b: { x: e.b.x * 20, y: e.b.y * 20 } } : e)) };
    const arr = doc.entities;
    doc.patchQuiet((s) => ({ ...s, blocks: { ...s.blocks, [PERF_BLOCK.name]: bigBlock } }));
    expect(doc.entities).toBe(arr);
    agree(doc, 1007);
    // 5. A layout (paper space) switch: the active entities array is the layout's while a tab is
    //    open (edits there go to the layout), and the model array again afterwards.
    const modelEntities = doc.entities;
    doc.patchQuiet((s) => ({ ...s, layouts: [defaultLayout('Layout1')] }), false);
    doc.setSpace({ layout: 'Layout1' });
    const paperBefore = doc.entities.length;
    doc.transact((s) => ({ ...s, entities: [...s.entities, { id: 'PAPER', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }] }));
    expect(doc.entities.length).toBe(paperBefore + 1);
    expect(doc.entities.some((e) => e.id === 'PAPER')).toBe(true);
    doc.setSpace(undefined);
    expect(doc.entities).toBe(modelEntities);
    agree(doc, 1008);
  }, 30_000);
});
