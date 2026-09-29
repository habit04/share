import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readDxf, writeDxf } from '../src/io/dxf';
import { convertDwg, convertHatch } from '../src/io/dwg';
import { entityBounds, insertTransform, type Entity, type InsertEntity, type PolylineEntity, type HatchEntity, type TableEntity } from '../src/core/entities';
import type { DrawingState } from '../src/core/document';
// @ts-expect-error plain JS helper shared with Electron main / CLI
import { readDwgPayload } from '../scripts/dwg-reader.mjs';

// Regression tests for DXF import / export against synthetic files in tests/fixtures/, written the
// way AutoCAD writes them (group codes right-aligned, CRLF, full TABLES / BLOCKS / OBJECTS sections).

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const lookupOf = (s: DrawingState) => (n: string) => s.blocks[n];
const inserts = (s: DrawingState) => s.entities.filter((e): e is InsertEntity => e.type === 'insert');
const roundTrip = (s: DrawingState) => readDxf(writeDxf(s));

describe('ACAD_TABLE (as AutoCAD emits it, with its anonymous *T block)', () => {
  const state = readDxf(fixture('acad-table.dxf'));
  const tables = (s: DrawingState) => s.entities.filter((e): e is TableEntity => e.type === 'table');

  it('imports the table as a native table at the table insertion point (cell data present)', () => {
    expect(tables(state)).toHaveLength(1);
    const t = tables(state)[0]!;
    expect(t).toMatchObject({ layer: 'TABLE', position: { x: 5, y: 8 }, rotation: 0, rowHeights: [0.5, 0.5, 0.5], columnWidths: [2, 2] });
    expect(t.cells.length).toBeGreaterThan(0);
    // the helper *T block is not kept as a drawing block
    expect(state.blocks['*T1']).toBeUndefined();
    expect(inserts(state)).toHaveLength(0);
  });

  it('draws the grid down and to the right of the insertion point, inside the sheet border', () => {
    const t = tables(state)[0]!;
    const b = entityBounds(t, lookupOf(state))!;
    // 2 columns x 2 in, 3 rows x 0.5 in, top-left corner at (5, 8)
    expect(b.min.x).toBeCloseTo(5, 6);
    expect(b.max.x).toBeCloseTo(9, 6);
    expect(b.max.y).toBeCloseTo(8, 6);
    expect(b.min.y).toBeCloseTo(6.5, 6);
    // and inside the 17 x 11 sheet drawn by the border lines
    expect(b.min.x).toBeGreaterThan(0);
    expect(b.max.x).toBeLessThan(17);
    expect(b.max.y).toBeLessThan(11);
  });

  it('keeps the table through Save (DXF) and re-open, written as an anonymous block reference', () => {
    const text = writeDxf(state);
    // The table is written as an INSERT of an anonymous *U block (flag 1) that other readers can display.
    const lines = text.split(/\r\n/);
    let flags: number | null = null;
    for (let i = 0; i + 1 < lines.length; i += 2) {
      if (lines[i]!.trim() !== '0' || lines[i + 1] !== 'BLOCK') continue;
      const groups = new Map<string, string>();
      for (let j = i + 2; j + 1 < lines.length && lines[j]!.trim() !== '0'; j += 2) if (!groups.has(lines[j]!.trim())) groups.set(lines[j]!.trim(), lines[j + 1]!);
      if (groups.get('2')?.startsWith('*U')) flags = Number(groups.get('70'));
    }
    expect(flags, 'anonymous *U BLOCK with a flags group').not.toBeNull();
    expect(flags! & 1).toBe(1);
    const back = readDxf(text);
    expect(tables(back)).toHaveLength(1);
    expect(tables(back)[0]).toMatchObject({ position: { x: 5, y: 8 }, rowHeights: [0.5, 0.5, 0.5], columnWidths: [2, 2] });
    expect(entityBounds(tables(back)[0]!, lookupOf(back))).toEqual(entityBounds(tables(state)[0]!, lookupOf(state)));
  });
});

describe('HATCH', () => {
  // LibreDWG-shaped payload of the same three hatches as tests/fixtures/hatch.dxf (the DWG import path).
  const dwgHatch = (extra: Record<string, unknown>) => ({ type: 'HATCH', handle: 'H1', layer: 'FILL', colorIndex: 256, ...extra }) as unknown as Parameters<typeof convertHatch>[0];
  const rect = dwgHatch({ solidFill: 1, patternName: 'SOLID', boundaryPaths: [{ boundaryPathTypeFlag: 3, vertices: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }] }] });
  const pentagon = dwgHatch({
    solidFill: 1,
    patternName: 'SOLID',
    boundaryPaths: [
      { boundaryPathTypeFlag: 3, vertices: [{ x: 10, y: 0 }, { x: 14, y: 0 }, { x: 15, y: 2 }, { x: 12, y: 4 }, { x: 9, y: 2 }] },
      { boundaryPathTypeFlag: 2, vertices: [{ x: 11, y: 1 }, { x: 13, y: 1 }, { x: 13, y: 2 }, { x: 11, y: 2 }] },
    ],
  });
  const ansi31 = dwgHatch({
    layer: 'PATTERN',
    solidFill: 0,
    patternName: 'ANSI31',
    boundaryPaths: [
      {
        boundaryPathTypeFlag: 1,
        edges: [
          { type: 1, start: { x: 20, y: 0 }, end: { x: 22, y: 0 } },
          { type: 2, center: { x: 22, y: 1 }, radius: 1, startAngle: 270, endAngle: 90, isCounterClockwise: 1 },
          { type: 1, start: { x: 22, y: 2 }, end: { x: 20, y: 2 } },
          { type: 1, start: { x: 20, y: 2 }, end: { x: 20, y: 0 } },
        ],
      },
    ],
  });

  it('DWG path: a SOLID hatch becomes a filled closed boundary, islands stay outlines', () => {
    const [outer] = convertHatch(rect) as PolylineEntity[];
    expect(outer).toMatchObject({ type: 'polyline', closed: true, filled: true, layer: 'FILL' });
    expect(outer!.points).toHaveLength(4);
    const parts = convertHatch(pentagon) as PolylineEntity[];
    expect(parts.map((p) => Boolean(p.filled))).toEqual([true, false]);
    expect(parts[0]!.points).toHaveLength(5);
  });

  it('DWG path: an ANSI31 pattern hatch keeps its (line + arc) boundary as an outline', () => {
    const parts = convertHatch(ansi31) as PolylineEntity[];
    expect(parts).toHaveLength(1);
    expect(parts[0]!.filled).toBeUndefined();
    expect(parts[0]!.closed).toBe(true);
    const xs = parts[0]!.points.map((p) => p.x);
    expect(Math.max(...xs)).toBeCloseTo(23, 6); // arc apex
  });

  it('DWG path: filled triangles / quads survive Save as DXF (written as SOLID)', () => {
    const [outer] = convertHatch(rect);
    const back = roundTrip({ entities: [outer!], layers: [], blocks: {}, currentLayer: '0' });
    expect(back.entities[0]).toMatchObject({ type: 'polyline', closed: true, filled: true });
  });

  it('DWG path: a filled boundary with more than 4 vertices keeps its fill through Save as DXF (as a SOLID hatch)', () => {
    const [outer] = convertHatch(pentagon);
    const back = roundTrip({ entities: [outer!], layers: [], blocks: {}, currentLayer: '0' });
    expect(back.entities).toHaveLength(1);
    expect(back.entities[0]).toMatchObject({ type: 'hatch', solid: true, pattern: 'SOLID' });
    expect((back.entities[0] as HatchEntity).loops[0]!.points).toHaveLength(5);
  });

  it('DXF path: readDxf imports HATCH entities (SOLID filled, ANSI31 pattern with an arc edge)', () => {
    const s = readDxf(fixture('hatch.dxf'));
    expect(s.layers.map((l) => l.name)).toEqual(expect.arrayContaining(['FILL', 'PATTERN']));
    const hatches = s.entities.filter((e): e is HatchEntity => e.type === 'hatch');
    expect(hatches).toHaveLength(3);
    expect(hatches.filter((h) => h.solid)).toHaveLength(2);
    const island = hatches.find((h) => h.loops.length === 2)!;
    expect(island.layer).toBe('FILL');
    const ansi = hatches.find((h) => !h.solid)!;
    expect(ansi).toMatchObject({ pattern: 'ANSI31', layer: 'PATTERN' });
    expect(ansi.loops[0]!.bulges!.some((b) => Math.abs(b - 1) < 1e-9)).toBe(true);
    // and they survive Save / re-open
    const back = roundTrip(s);
    expect(back.entities.filter((e) => e.type === 'hatch')).toHaveLength(3);
  });
});

describe('INSERT scale groups 41 / 42 / 43 (negative = mirror)', () => {
  const state = readDxf(fixture('insert-scales.dxf'));
  const byTag = (s: DrawingState, tag: string) => inserts(s).find((i) => i.attributes.TAG1 === tag)!;
  const deg = (r: number) => ((((r * 180) / Math.PI) % 360) + 360) % 360;

  it('reads mirror, non-uniform and negative-Y inserts into the insert fields', () => {
    expect(inserts(state)).toHaveLength(6);
    const plain = byTag(state, 'PLAIN');
    expect(plain.scale).toBe(1);
    expect(plain.scaleY).toBeUndefined();
    expect(plain.mirror).toBeUndefined();

    const mirror = byTag(state, 'MIRROR');
    expect(mirror).toMatchObject({ scale: 1, mirror: true, position: { x: 10, y: 0 } });
    expect(mirror.scaleY).toBeUndefined();
    expect(deg(mirror.rotation)).toBeCloseTo(0, 9);

    const stretch = byTag(state, 'STRETCH');
    expect(stretch).toMatchObject({ scale: 2, scaleY: 0.5 });
    expect(stretch.mirror).toBeUndefined();
    expect(deg(stretch.rotation)).toBeCloseTo(30, 9);

    const both = byTag(state, 'MIRSTRETCH');
    expect(both).toMatchObject({ scale: 1.5, scaleY: 3, mirror: true });

    // 42 < 0: the same mirror followed by a half turn
    const flipY = byTag(state, 'FLIPY');
    expect(flipY).toMatchObject({ scale: 1, mirror: true });
    expect(deg(flipY.rotation)).toBeCloseTo(180, 9);

    // 41 < 0 and 42 < 0: no mirror, a half turn on top of the 90 degrees
    const bothNeg = byTag(state, 'BOTHNEG');
    expect(bothNeg).toMatchObject({ scale: 2 });
    expect(bothNeg.mirror).toBeUndefined();
    expect(bothNeg.scaleY).toBeUndefined();
    expect(deg(bothNeg.rotation)).toBeCloseTo(270, 9);
  });

  it('places block geometry exactly where the signed DXF scales put it', () => {
    const block = state.blocks.ASYM!;
    // Block point (2, 0.25) -> world with DXF semantics: position + R(rot) * (sx * x, sy * y)
    const expectPt = (tag: string, sx: number, sy: number, rotDeg: number, at: { x: number; y: number }) => {
      const ins = byTag(state, tag);
      const r = (rotDeg * Math.PI) / 180;
      const lx = sx * 2;
      const ly = sy * 0.25;
      const want = { x: at.x + lx * Math.cos(r) - ly * Math.sin(r), y: at.y + lx * Math.sin(r) + ly * Math.cos(r) };
      const got = insertTransform(ins, block)({ x: 2, y: 0.25 });
      expect(got.x, tag).toBeCloseTo(want.x, 9);
      expect(got.y, tag).toBeCloseTo(want.y, 9);
    };
    expectPt('MIRROR', -1, 1, 0, { x: 10, y: 0 });
    expectPt('STRETCH', 2, 0.5, 30, { x: 20, y: 0 });
    expectPt('MIRSTRETCH', -1.5, 3, 0, { x: 30, y: 0 });
    expectPt('FLIPY', 1, -1, 0, { x: 40, y: 0 });
    expectPt('BOTHNEG', -2, -2, 90, { x: 50, y: 0 });
  });

  it('write -> read round-trips every insert exactly (fields and placed geometry)', () => {
    const back = roundTrip(state);
    expect(inserts(back)).toHaveLength(6);
    for (const a of inserts(state)) {
      const b = byTag(back, a.attributes.TAG1!);
      expect(b.block).toBe(a.block);
      expect(b.position).toEqual(a.position);
      expect(b.scale).toBe(a.scale);
      expect(b.scaleY).toBe(a.scaleY);
      expect(b.mirror).toBe(a.mirror);
      expect(deg(b.rotation)).toBeCloseTo(deg(a.rotation), 9);
      const block = back.blocks[b.block]!;
      for (const p of [{ x: 0, y: 0 }, { x: 2, y: 0.25 }, { x: 0, y: 1 }]) {
        const pa = insertTransform(a, state.blocks[a.block]!)(p);
        const pb = insertTransform(b, block)(p);
        expect(pb.x).toBeCloseTo(pa.x, 9);
        expect(pb.y).toBeCloseTo(pa.y, 9);
      }
    }
    // A second trip is a fixed point.
    expect(writeDxf(roundTrip(back)).replace(/\r\n5\r\n[0-9A-F]+/g, '')).toBe(writeDxf(back).replace(/\r\n5\r\n[0-9A-F]+/g, ''));
  });
});

describe('every entity kind the DXF reader supports', () => {
  const state = readDxf(fixture('all-entities.dxf'));
  const ALL: Entity['type'][] = ['line', 'circle', 'arc', 'polyline', 'text', 'mtext', 'insert', 'ellipse', 'point', 'xline', 'ray', 'dimension'];

  it('reads all of them from the fixture', () => {
    const types = new Set(state.entities.map((e) => e.type));
    for (const t of ALL) expect(types.has(t), t).toBe(true);
    // 6 dimension kinds: linear, aligned, 2-line angular, diameter, radius, 3-point angular
    const dims = state.entities.filter((e) => e.type === 'dimension').map((e) => (e.type === 'dimension' ? e.kind : ''));
    expect(dims.sort()).toEqual(['aligned', 'angular', 'angular', 'diameter', 'linear', 'radius']);
    // SOLID and TRACE -> filled polylines; the donut -> filled circle; POLYLINE/VERTEX -> polyline
    expect(state.entities.filter((e) => e.type === 'polyline' && e.filled)).toHaveLength(2);
    expect(state.entities.filter((e) => e.type === 'circle' && e.filled)).toHaveLength(1);
    expect(state.entities.some((e) => e.type === 'polyline' && e.points.length === 3 && e.closed && !e.filled)).toBe(true);
    expect(inserts(state).map((i) => i.block).sort()).toEqual(['*T1', 'SYM']);
    expect(inserts(state).find((i) => i.block === 'SYM')!.attributes).toEqual({ TAG1: 'M1' });
  });

  it('round-trips through writeDxf / readDxf with the same entity count, order and kinds', () => {
    const back = roundTrip(state);
    expect(back.entities.length).toBe(state.entities.length);
    expect(back.entities.map((e) => e.type)).toEqual(state.entities.map((e) => e.type));
    const detail = (s: DrawingState) =>
      s.entities.map((e) => (e.type === 'dimension' ? `dimension:${e.kind}` : e.type === 'polyline' ? `polyline:${e.points.length}:${Boolean(e.filled)}` : e.type === 'circle' ? `circle:${Boolean(e.filled)}` : e.type));
    expect(detail(back)).toEqual(detail(state));
    expect(Object.keys(back.blocks).sort()).toEqual(Object.keys(state.blocks).sort());
    // Extents are preserved (within the writer's 10-decimal precision).
    const ext = (s: DrawingState) => {
      const b = s.entities.filter((e) => e.type !== 'xline' && e.type !== 'ray').map((e) => entityBounds(e, lookupOf(s))!);
      return { minX: Math.min(...b.map((x) => x.min.x)), minY: Math.min(...b.map((x) => x.min.y)), maxX: Math.max(...b.map((x) => x.max.x)), maxY: Math.max(...b.map((x) => x.max.y)) };
    };
    const [a, b] = [ext(state), ext(back)];
    for (const k of ['minX', 'minY', 'maxX', 'maxY'] as const) expect(b[k]).toBeCloseTo(a[k], 6);
  });
});

// Customer drawings supplied for debugging. They are NOT part of the repository: the test only runs
// when they sit in the session scratchpad (or where JCAD_CUSTOMER_DWG_DIR points).
const customerDir = process.env.JCAD_CUSTOMER_DWG_DIR ?? '/tmp/claude-0/-home-user-share/03786577-e448-596c-8184-7685de9ef2d4/scratchpad';
describe('customer DWG files (skipped when absent)', () => {
  for (const name of ['cable.dwg', 'reactor.dwg']) {
    const path = join(customerDir, name);
    it.skipIf(!existsSync(path))(`${name} opens through scripts/dwg-reader.mjs and survives Save as DXF`, async () => {
      const { payload, version } = await readDwgPayload(readFileSync(path), 'dwg');
      const { state, skipped } = convertDwg(payload);
      console.log(`${name}: ${version}, ${state.entities.length} entities, ${Object.keys(state.blocks).length} blocks, skipped ${JSON.stringify(skipped)}`);
      expect(state.entities.length).toBeGreaterThan(0);
      for (const e of state.entities) if (e.type === 'insert') expect(state.blocks[e.block], `block ${e.block}`).toBeDefined();
      for (const e of state.entities) {
        const b = entityBounds(e, lookupOf(state));
        if (b) for (const v of [b.min.x, b.min.y, b.max.x, b.max.y]) expect(Number.isFinite(v)).toBe(true);
      }
      const back = roundTrip(state);
      expect(back.entities.length).toBe(state.entities.length);
      expect(back.entities.map((e) => e.type)).toEqual(state.entities.map((e) => e.type));
    }, 120000);
  }
});
