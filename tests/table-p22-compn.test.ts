/**
 * UNION FILE (P22 COMP-N re-composition): the N-2 and N-3 deltas each created
 * this file independently on the b18a748 base; the combined head unions the two
 * suites verbatim (shared pairs/records helpers deduplicated — byte-identical in
 * both). Each suite's header follows, then its describe blocks unchanged.
 */
/**
 * P22 COMP-N / N-2 (lead's Windows gate on the composed tree, 2026-10-21): gate-a
 * (AC1015) opens in AutoCAD 2027 as a real ACAD_TABLE with AUDIT 0 and the merge
 * kept, but TABLEDIT cannot pick a cell — 'edit-applied' and 'edited-text-present'
 * fail 20/22. Cause, proven by measurement against the lead's AutoCAD Recipe B
 * controls (p22-recipe-b-control-r2018.dxf / -r2000.dxf): AutoCAD stores the *T
 * picture block's geometry in the table's LOCAL frame — stored extents
 * [0, W] x [-H, 0] with BLOCK base point (0, 0), whatever the insertion point —
 * so the block reference (insertion + direction) lands the picture exactly on the
 * cell grid anchored at the insertion point. The pre-fix writer stored WORLD
 * geometry (local + position): displayed through the reference, the picture sits
 * one insertion-offset away from the cell grid (gate-a: drawn y [18.47, 20] vs
 * cell grid y [8.47, 10]), and TABLEDIT picks against the cell grid.
 *
 * These tests pin the structural invariant on JCad's output: for tables at any
 * insertion point (and any rotation), the *T block's stored geometry extents are
 * the local frame [0, W] x [-H, 0] and its base point is (0, 0), so the extents
 * relative to the INSERT match the AutoCAD control's relationship. They fail on
 * the pre-fix writer and pass after the picture is generated in the local frame.
 * Linux tests prove the structural invariant only; TABLEDIT picking itself is
 * proven by the lead's AutoCAD re-run, not here.
 */
/**
 * P22 COMP-N / N-3: at AC1032 AutoCAD reads only the ACAD_TABLE cell-value form.
 * The legacy per-cell form (text in group 1 after 92, per-cell 91 = 0, the style
 * name and the effective height/alignment restated on every cell) is read by
 * AutoCAD only at AC1015; at AC1032 it is silently discarded — the drawing
 * opens with AUDIT 0 and every cell empty (the lead's native gate, gate-b2).
 * These tests pin the written per-cell groups against the genuine AutoCAD
 * 2027 R2018 control (fixtures/interchange/r2018-table-autocad.dxf, the
 * Recipe B control: merged title, height override at (2,2), alignment
 * override at (3,0)), and pin the AC1015 output to the legacy form.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newTable, setCellText } from '../src/core/table';
import type { TableEntity } from '../src/core/entities';
import { readDxf, writeDxf } from '../src/io/dxf';
import { tableDxfForm } from '../src/io/dxf/write-annotations';
import { decodeDxfBytes } from '../src/io/encoding';
import { Drawing } from '../src/core/document';

type Pair = [number, string];

function pairs(text: string): Pair[] {
  const lines = text.split('\r\n');
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([Number(lines[i]), lines[i + 1]!]);
  return out;
}

/** Top-level records (code 0 starts) of a DXF text. */
function records(text: string): Pair[][] {
  const out: Pair[][] = [];
  let cur: Pair[] | null = null;
  for (const p of pairs(text)) {
    if (p[0] === 0) {
      cur = [p];
      out.push(cur);
    } else cur?.push(p);
  }
  return out;
}


const group = (r: Pair[], code: number) => r.find(([c]) => c === code)?.[1];
const num = (r: Pair[], code: number) => Number(group(r, code));

/** The gate-sample table (README Recipe A shape): merged title, a two-line cell. */
function gateTable(position: { x: number; y: number }, rotation = 0): TableEntity {
  let t = newTable({ id: 't', layer: '0', color: 'ByLayer' }, { position, columns: 3, dataRows: 2, columnWidth: 2 });
  t = setCellText(t, 0, 0, 'PARTS – ÄÖ');
  t = setCellText(t, 2, 2, 'line1\nline2');
  return { ...t, rotation, color: 5 };
}

function stateOf(t: TableEntity) {
  const d = new Drawing();
  d.addEntities([t]);
  return d.snapshot;
}

interface PictureMeasure {
  base: { x: number; y: number };
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  insertion: { x: number; y: number };
  direction: { x: number; y: number };
}

/** Stored geometry of the *T block a written ACAD_TABLE references: LINE endpoints + MTEXT insertions. */
function measurePicture(text: string): PictureMeasure {
  const recs = records(text);
  const table = recs.find((r) => r[0]![1] === 'ACAD_TABLE')!;
  expect(table).toBeDefined();
  const name = group(table, 2)!;
  const insertion = { x: num(table, 10), y: num(table, 20) };
  const direction = { x: num(table, 11), y: num(table, 21) };
  const start = recs.findIndex((r) => r[0]![1] === 'BLOCK' && group(r, 2) === name);
  expect(start).toBeGreaterThanOrEqual(0);
  const block = recs[start]!;
  const base = { x: num(block, 10), y: num(block, 20) };
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = start + 1; i < recs.length && recs[i]![0]![1] !== 'ENDBLK'; i += 1) {
    const r = recs[i]!;
    if (r[0]![1] === 'LINE') pts.push({ x: num(r, 10), y: num(r, 20) }, { x: num(r, 11), y: num(r, 21) });
    else if (r[0]![1] === 'MTEXT') pts.push({ x: num(r, 10), y: num(r, 20) });
  }
  expect(pts.length).toBeGreaterThan(0);
  return {
    base,
    insertion,
    direction,
    minX: Math.min(...pts.map((p) => p.x)),
    maxX: Math.max(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)),
    maxY: Math.max(...pts.map((p) => p.y)),
  };
}

/** The AutoCAD invariant: stored extents are the local frame; the displayed picture lands on the cell grid. */
function expectLocalFrame(t: TableEntity) {
  // The grid of record is the written one (tableDxfForm): since P22 F-1 its row
  // heights carry the multi-line fit floor, so the frame is measured against the
  // form, not the raw model (whose row 2 is still the under-fit 0.36).
  const form = tableDxfForm(t);
  const W = form.columnWidths.reduce((a, b) => a + b, 0);
  const H = form.rowHeights.reduce((a, b) => a + b, 0);
  const m = measurePicture(writeDxf(stateOf(t)));
  expect(m.base).toEqual({ x: 0, y: 0 });
  expect(m.minX).toBeCloseTo(0, 9);
  expect(m.maxX).toBeCloseTo(W, 9);
  expect(m.minY).toBeCloseTo(-H, 9);
  expect(m.maxY).toBeCloseTo(0, 9);
  // Displayed through the block reference (insertion + stored - base), the grid
  // occupies exactly the cell grid anchored at the insertion point.
  expect(m.insertion.x + (m.minX - m.base.x)).toBeCloseTo(t.position.x, 9);
  expect(m.insertion.x + (m.maxX - m.base.x)).toBeCloseTo(t.position.x + W, 9);
  expect(m.insertion.y + (m.minY - m.base.y)).toBeCloseTo(t.position.y - H, 9);
  expect(m.insertion.y + (m.maxY - m.base.y)).toBeCloseTo(t.position.y, 9);
  return m;
}

const REAL_CELL_CODES = new Set([140, 145]);
const INT_CELL_CODES = new Set([91, 92, 93, 90, 94, 170, 171, 172, 173, 174, 175, 176, 178]);

/** One cell's groups (171 .. end of its CELL_VALUE block), canonicalised for comparison. */
function canonCell(chunk: Pair[]): string[] {
  return chunk.map(([c, v]) => (REAL_CELL_CODES.has(c) ? `${c}=n:${Number(v)}` : INT_CELL_CODES.has(c) ? `${c}=i:${parseInt(v, 10)}` : `${c}=s:${v}`));
}

/** The ACAD_TABLE record's per-cell group chunks, in row-major order. */
function cellChunksOf(text: string): Pair[][] {
  const rec = records(text).find((r) => r[0]![1] === 'ACAD_TABLE');
  expect(rec, 'an ACAD_TABLE record').toBeDefined();
  const sub = rec!.findIndex(([c, v]) => c === 100 && v === 'AcDbTable');
  const gs = rec!.slice(sub + 1);
  const chunks: Pair[][] = [];
  let cur: Pair[] | null = null;
  for (const p of gs) {
    if (p[0] === 171) {
      cur = [];
      chunks.push(cur);
    }
    if (p[0] === 280 || p[0] === 281) cur = null;
    cur?.push(p);
  }
  return chunks;
}

const controlText = () => decodeDxfBytes(readFileSync(join(import.meta.dirname, 'fixtures', 'interchange', 'r2018-table-autocad.dxf'))).text;

const cellModel = (t: TableEntity) => t.cells.map((row) => row.map((c) => ({ text: c.text, height: c.height, attachment: c.attachment, span: c.span })));

describe('P22 COMP-N N-2: the *T picture block is stored in the table-local frame', () => {
  it('gate-a shape at (0, 10): stored extents are [0, W] x [-H, 0], not world y [8.47, 10]', () => {
    expectLocalFrame(gateTable({ x: 0, y: 10 }));
  });

  it('a non-trivial insertion point (37.5, -12.25) stores the identical local frame', () => {
    expectLocalFrame(gateTable({ x: 37.5, y: -12.25 }));
  });

  it('a rotated table (pi/6) at (5, 20) stores the local frame; the reference carries the rotation', () => {
    const t = gateTable({ x: 5, y: 20 }, Math.PI / 6);
    const m = expectLocalFrame(t);
    expect(m.direction.x).toBeCloseTo(Math.cos(Math.PI / 6), 9);
    expect(m.direction.y).toBeCloseTo(Math.sin(Math.PI / 6), 9);
  });

  it('the native write stays a fixed point and the model round-trips (guard)', () => {
    const text = writeDxf(stateOf(gateTable({ x: 0, y: 10 })));
    expect(writeDxf(readDxf(text))).toBe(text);
    const back = readDxf(text).entities[0] as TableEntity;
    expect(back.type).toBe('table');
    expect(back.position).toEqual({ x: 0, y: 10 });
    expect(back.cells[0]![0]!.text).toBe('PARTS – ÄÖ');
    expect(back.cells[2]![2]!.text).toBe('line1\nline2');
  });
});

describe('P22 COMP-N N-3: the AC1032 cell-value form', () => {
  it('the reader holds the genuine control whole: all 12 texts and both overrides', () => {
    const t = readDxf(controlText()).entities.find((e) => e.type === 'table') as TableEntity;
    expect(t.cells.map((r) => r.map((c) => c.text))).toEqual([
      ['P22 CONTROL TABLE', '', ''],
      ['PART', 'QTY', 'DESC'],
      ['A-100', 'TWO', 'BOLT'],
      ['B-200', 'FOUR', 'NUT'],
    ]);
    expect(t.cells[0]![0]!.span).toEqual({ rows: 1, cols: 3 });
    expect(t.cells[2]![2]!.height).toBe(0.3);
    expect(t.cells[3]![0]!.attachment).toBe(6);
  });

  it('round-tripping the control at AC1032 writes the control\u2019s cell-value structure group-for-group', () => {
    const source = controlText();
    const written = writeDxf(readDxf(source));
    expect(written).toContain('AC1032');
    const mine = cellChunksOf(written).map(canonCell);
    const oracle = cellChunksOf(source).map(canonCell);
    expect(mine).toHaveLength(12);
    expect(mine).toEqual(oracle);
  });

  it('the rewritten control re-reads to the identical cell model (no loss through the new form)', () => {
    const before = readDxf(controlText()).entities.find((e) => e.type === 'table') as TableEntity;
    const written = writeDxf(readDxf(controlText()));
    const after = readDxf(written).entities.find((e) => e.type === 'table') as TableEntity;
    expect(cellModel(after)).toEqual(cellModel(before));
    expect(writeDxf(readDxf(written))).toBe(written);
  });
});

describe('P22 COMP-N Series 2: the synthesized TABLESTYLE writes AutoCAD\u2019s normalised row-type 90', () => {
  it('each of the three cell-style row blocks carries group 90 = 4, not 512', () => {
    const written = writeDxf(readDxf(controlText()));
    const style = records(written).find((r) => r[0]![1] === 'TABLESTYLE');
    expect(style, 'a TABLESTYLE object').toBeDefined();
    const nineties = style!.filter(([c]) => c === 90).map(([, v]) => v);
    expect(nineties).toEqual(['4', '4', '4']);
  });
});

describe('P22 COMP-N N-3: the AC1015 output keeps the legacy per-cell form', () => {
  function authored(): TableEntity {
    let t = newTable({ id: 't', layer: '0', color: 'ByLayer' }, { position: { x: 0, y: 10 }, columns: 3, dataRows: 2, columnWidth: 2.5 });
    t = setCellText(t, 0, 0, 'P22 CONTROL TABLE');
    t = setCellText(t, 1, 0, 'PART');
    t = setCellText(t, 1, 1, 'QTY');
    t = setCellText(t, 1, 2, 'DESC');
    t = setCellText(t, 2, 0, 'A-100');
    t = setCellText(t, 2, 1, 'TWO');
    t = setCellText(t, 2, 2, 'BOLT');
    t = setCellText(t, 3, 0, 'B-200');
    t = setCellText(t, 3, 1, 'FOUR');
    t = setCellText(t, 3, 2, 'NUT');
    const cells = t.cells.map((row, r) => row.map((c, col) => (r === 2 && col === 2 ? { ...c, height: 0.3 } : r === 3 && col === 0 ? { ...c, attachment: 6 as const } : c)));
    return { ...t, cells };
  }

  it('no CELL_VALUE blocks, text in group 1, style name and per-cell 140/170 as today', () => {
    const d = new Drawing();
    d.addEntities([authored()]);
    const written = writeDxf(d.snapshot);
    expect(written).not.toContain('CELL_VALUE');
    const chunks = cellChunksOf(written);
    expect(chunks).toHaveLength(12);
    for (const chunk of chunks) {
      expect(chunk.find(([c]) => c === 91)?.[1]).toBe('0');
      expect(chunk.some(([c]) => c === 301)).toBe(false);
    }
    const visible = chunks.filter((chunk) => chunk.find(([c]) => c === 173)?.[1] === '0');
    for (const chunk of visible) {
      expect(chunk.some(([c]) => c === 1)).toBe(true);
      expect(chunk.some(([c]) => c === 7)).toBe(true);
      expect(chunk.some(([c]) => c === 140)).toBe(true);
      expect(chunk.some(([c]) => c === 170)).toBe(true);
    }
    expect(writeDxf(readDxf(written))).toBe(written);
  });
});
