/**
 * P22 slice 1 acceptance: tables are written as native ACAD_TABLE DXF entities
 * (with a generated *T picture block and a synthesized TABLESTYLE object), not as
 * an INSERT picture + JCAD_TABLE xdata. These tests fail on the pre-P22 writer,
 * which emits zero ACAD_TABLE records.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TableEntity } from '../src/core/entities';
import { newTable, setCellText } from '../src/core/table';
import { readDxf, writeDxf } from '../src/io/dxf';
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
const groups = (r: Pair[], code: number) => r.filter(([c]) => c === code).map(([, v]) => v);

const props = { layer: '0', color: 'ByLayer' as const };

/** Title (merged) + header + 2 data rows, 3 columns; one height/attachment override, one formatted cell. */
function sample(): TableEntity {
  let t = newTable({ id: 't', ...props }, { position: { x: 5, y: 20 }, columns: 3, dataRows: 2, columnWidth: 2 });
  t = setCellText(t, 0, 0, 'PARTS LIST');
  t = setCellText(t, 1, 0, 'TAG');
  t = setCellText(t, 1, 1, 'DESCRIPTION');
  t = setCellText(t, 1, 2, 'QTY');
  t = setCellText(t, 2, 0, 'M1');
  t = setCellText(t, 2, 1, 'Motor 5 HP');
  t = setCellText(t, 2, 2, '2');
  t = setCellText(t, 3, 0, 'K1');
  t = setCellText(t, 3, 1, 'Contactor');
  t = setCellText(t, 3, 2, '1');
  const cells = t.cells.map((row, r) => row.map((c, col) => (r === 3 && col === 1 ? { ...c, height: 0.3, attachment: 6 as const } : r === 2 && col === 1 ? { ...c, raw: '{\\fArial|b1;Motor 5 HP}' } : c)));
  return { ...t, cells };
}

const stateOf = (t: TableEntity) => {
  const d = new Drawing();
  d.addEntities([t]);
  return d.snapshot;
};

/** The cell chunks of an ACAD_TABLE record: head groups, then one chunk per cell starting at 171. */
function cellChunks(rec: Pair[]): { head: Pair[]; cells: Pair[][] } {
  const start = rec.findIndex(([c, v]) => c === 100 && v === 'AcDbTable');
  const body = rec.slice(start + 1);
  const first = body.findIndex(([c]) => c === 171);
  const cells: Pair[][] = [];
  let cur: Pair[] | null = null;
  for (const p of body.slice(first)) {
    if (p[0] === 171) {
      cur = [p];
      cells.push(cur);
    } else if (p[0] === 1001) cur = null;
    else cur?.push(p);
  }
  return { head: body.slice(0, first), cells };
}

describe('P22: native ACAD_TABLE DXF export', () => {
  it('writes a native ACAD_TABLE, not an INSERT + JCAD_TABLE', () => {
    const text = writeDxf(stateOf(sample()));
    const tables = records(text).filter((r) => r[0]![1] === 'ACAD_TABLE');
    expect(tables).toHaveLength(1);
    expect(records(text).filter((r) => r[0]![1] === 'INSERT' && r.some(([c, v]) => c === 1001 && v === 'JCAD_TABLE'))).toHaveLength(0);
    const rec = tables[0]!;
    expect(rec.some(([c, v]) => c === 100 && v === 'AcDbTable')).toBe(true);
    expect(group(rec, 2)).toMatch(/^\*T\d+$/);
    expect(group(rec, 10)).toBe('5');
    expect(group(rec, 20)).toBe('20');
    const { head, cells } = cellChunks(rec);
    expect(groups(head, 91)).toEqual(['4']);
    expect(groups(head, 92)).toEqual(['3']);
    expect(groups(head, 141).map(Number)).toEqual(sample().rowHeights.map((h) => Number(h.toFixed(10))));
    expect(groups(head, 142)).toEqual(['2', '2', '2']);
    expect(cells).toHaveLength(12);
  });

  it('emits the *T picture block, its BLOCK_RECORD (343) and a TABLESTYLE (342) that resolve', () => {
    const text = writeDxf(stateOf(sample()));
    const rec = records(text).find((r) => r[0]![1] === 'ACAD_TABLE')!;
    const name = group(rec, 2)!;
    const blockRecord = records(text).find((r) => r[0]![1] === 'BLOCK_RECORD' && group(r, 2) === name)!;
    expect(blockRecord).toBeDefined();
    expect(group(rec, 343)).toBe(group(blockRecord, 5));
    const block = records(text).find((r) => r[0]![1] === 'BLOCK' && group(r, 2) === name)!;
    expect(block).toBeDefined();
    // The picture block holds the rendered grid (border lines and cell texts).
    const section = text.slice(text.indexOf('\r\nBLOCKS\r\n'), text.indexOf('\r\nENTITIES\r\n'));
    expect(section).toContain(name);
    const styleHandle = group(rec, 342)!;
    const style = records(text).find((r) => r[0]![1] === 'TABLESTYLE' && group(r, 5) === styleHandle)!;
    expect(style).toBeDefined();
    expect(group(style, 3)).toBe('Standard');
    // Margins from the table model (Standard default 0.06), cell styles data/title/header.
    const subclass = style.slice(style.findIndex(([c, v]) => c === 100 && v === 'AcDbTableStyle') + 1);
    expect(groups(subclass, 40)).toEqual(['0.06']);
    expect(groups(subclass, 41)).toEqual(['0.06']);
    expect(groups(subclass, 140)).toEqual(['0.18', '0.25', '0.18']);
    expect(groups(subclass, 170)).toEqual(['2', '5', '5']);
    // The style is reachable from the root dictionary's ACAD_TABLESTYLE dictionary.
    expect(text).toContain('ACAD_TABLESTYLE');
    const classes = records(text).filter((r) => r[0]![1] === 'CLASS').map((r) => group(r, 1));
    expect(classes).toContain('ACAD_TABLE');
    expect(classes).toContain('TABLESTYLE');
  });

  it('writes sizes, styles, alignment, margins and merges per cell', () => {
    const text = writeDxf(stateOf(sample()));
    const { cells } = cellChunks(records(text).find((r) => r[0]![1] === 'ACAD_TABLE')!);
    const title = cells[0]!;
    expect(group(title, 175)).toBe('3');
    expect(group(title, 176)).toBe('1');
    expect(group(title, 1)).toBe('PARTS LIST');
    expect(group(title, 140)).toBe('0.25');
    expect(group(title, 170)).toBe('5');
    // Cells covered by the title merge are virtual and carry no text.
    for (const covered of [cells[1]!, cells[2]!]) {
      expect(group(covered, 173)).toBe('1');
      expect(group(covered, 1)).toBeUndefined();
    }
    const data = cells[7]!; // row 2, col 1: formatted raw content
    expect(group(data, 1)).toBe('{\\fArial|b1;Motor 5 HP}');
    const override = cells[10]!; // row 3, col 1
    expect(group(override, 140)).toBe('0.3');
    expect(group(override, 170)).toBe('6');
  });

  it('round-trips through JCad read: edit, undo, redo, save, reopen', () => {
    const doc = new Drawing();
    doc.addEntities([sample()]);
    doc.transact((s) => ({ ...s, entities: s.entities.map((e) => (e.type === 'table' ? setCellText(e, 2, 0, 'M2') : e)) }));
    expect(doc.dirty).toBe(true);
    expect(doc.undo()).toBe(true);
    expect((doc.snapshot.entities[0] as TableEntity).cells[2]![0]!.text).toBe('M1');
    expect(doc.redo()).toBe(true);
    const saved = writeDxf(doc.snapshot);
    const back = readDxf(saved).entities[0] as TableEntity;
    expect(back.type).toBe('table');
    expect(back.position).toEqual({ x: 5, y: 20 });
    // DXF reals are written at 10-decimal precision (write-core fmt), as everywhere else.
    expect(back.rowHeights).toEqual(sample().rowHeights.map((h) => Number(h.toFixed(10))));
    expect(back.columnWidths).toEqual([2, 2, 2]);
    const expectedTexts = sample().cells.map((r) => r.map((c) => c.text));
    expectedTexts[2]![0] = 'M2';
    expect(back.cells.map((r) => r.map((c) => c.text))).toEqual(expectedTexts);
    expect(back.cells[0]![0]!.span).toEqual({ rows: 1, cols: 3 });
    expect(back.cells[0]![0]).toMatchObject({ height: 0.25, attachment: 5 });
    expect(back.cells[3]![1]).toMatchObject({ height: 0.3, attachment: 6 });
    expect(back.cells[2]![1]!.raw).toBe('{\\fArial|b1;Motor 5 HP}');
    expect(back.textHeight).toBe(0.18);
    expect(back.margin).toBe(0.06);
    // The native write is a fixed point.
    expect(writeDxf(readDxf(saved))).toBe(saved);
  });

  it('keeps text in a merged-away cell via the JCAD_TABLE preservation carrier', () => {
    let t = sample();
    t = setCellText(t, 0, 1, 'HIDDEN');
    const text = writeDxf(stateOf(t));
    const rec = records(text).find((r) => r[0]![1] === 'ACAD_TABLE')!;
    expect(rec.some(([c, v]) => c === 1001 && v === 'JCAD_TABLE')).toBe(true);
    const { cells } = cellChunks(rec);
    expect(group(cells[1]!, 173)).toBe('1');
    expect(group(cells[1]!, 1)).toBeUndefined();
    const back = readDxf(text).entities[0] as TableEntity;
    expect(back.cells[0]![1]!.text).toBe('HIDDEN');
    expect(back.cells[0]![0]!.span).toEqual({ rows: 1, cols: 3 });
  });

  it('writes an imported table (synthetic r2018 fixture) natively and re-reads it whole', () => {
    const source = decodeDxfBytes(readFileSync(join(import.meta.dirname, 'fixtures', 'interchange', 'r2018-table.dxf'))).text;
    const state = readDxf(source);
    const written = writeDxf(state);
    const tables = records(written).filter((r) => r[0]![1] === 'ACAD_TABLE');
    expect(tables).toHaveLength(1);
    expect(records(written).filter((r) => r[0]![1] === 'INSERT' && r.some(([c, v]) => c === 1001 && v === 'JCAD_TABLE'))).toHaveLength(0);
    const back = readDxf(written).entities[0] as TableEntity;
    const orig = state.entities[0] as TableEntity;
    expect(back.cells.map((r) => r.map((c) => c.text))).toEqual(orig.cells.map((r) => r.map((c) => c.text)));
    expect(back.rowHeights).toEqual([9, 7, 7, 7]);
    expect(back.columnWidths).toEqual([40, 25, 25]);
    expect(back.margin).toBe(1.5);
    expect(back.cells[0]![0]!.span).toEqual({ rows: 1, cols: 3 });
    expect(back.cells[2]![2]!.raw).toBe('{\\fArial|b1;16 A}');
    expect(back.cells[3]![0]!.height).toBe(3);
    expect(back.cells[3]![1]!.attachment).toBe(6);
    expect(writeDxf(readDxf(written))).toBe(written);
  });

  it('reopens an all-empty table as an editable table (carrier), not a picture insert', () => {
    const t = newTable({ id: 'e', ...props }, { position: { x: 1, y: 2 }, columns: 2, dataRows: 1 });
    const text = writeDxf(stateOf(t));
    const rec = records(text).find((r) => r[0]![1] === 'ACAD_TABLE')!;
    expect(rec.some(([c, v]) => c === 1001 && v === 'JCAD_TABLE')).toBe(true);
    const back = readDxf(text).entities[0] as TableEntity;
    expect(back.type).toBe('table');
    // The carrier is the exact JSON model, so heights come back at full precision.
    expect(back.rowHeights).toEqual(t.rowHeights);
    expect(back.columnWidths).toEqual([2.5, 2.5]);
  });

  it('handles several tables, long and non-ASCII cell text, and rotation', () => {
    const long = 'X'.repeat(600);
    let a = setCellText(sample(), 2, 0, long);
    a = setCellText(a, 3, 0, 'PARTS – ÄÖ');
    const b = { ...newTable({ id: 'u', ...props }, { position: { x: 0, y: 0 }, columns: 1, dataRows: 1 }), rotation: Math.PI / 6 };
    const d = new Drawing();
    d.addEntities([a, b]);
    const text = writeDxf(d.snapshot);
    const tables = records(text).filter((r) => r[0]![1] === 'ACAD_TABLE');
    expect(tables).toHaveLength(2);
    expect(new Set(tables.map((r) => group(r, 342))).size).toBe(1);
    expect(new Set(tables.map((r) => group(r, 2))).size).toBe(2);
    const back = readDxf(text);
    const ta = back.entities.find((e) => e.type === 'table' && Math.abs(e.position.y - 20) < 1e-9) as TableEntity;
    expect(ta.cells[2]![0]!.text).toBe(long);
    expect(ta.cells[3]![0]!.text).toBe('PARTS – ÄÖ');
    const tb = back.entities.find((e) => e.type === 'table' && Math.abs(e.position.y) < 1e-9) as TableEntity;
    expect(tb.rotation).toBeCloseTo(Math.PI / 6, 9);
  });

  it('cad graph: a retained TABLESTYLE/dictionary is not duplicated by the synthesized style', () => {
    // The r2018 fixture's state carries a cad graph with the source TABLESTYLE object and
    // its ACAD_TABLESTYLE dictionary. The write must compose with graph preservation:
    // exactly one TABLESTYLE and one dictionary entry afterwards, 342 resolving to it,
    // and no accumulation on a second save.
    const source = decodeDxfBytes(readFileSync(join(import.meta.dirname, 'fixtures', 'interchange', 'r2018-table.dxf'))).text;
    const once = writeDxf(readDxf(source));
    const styles = records(once).filter((r) => r[0]![1] === 'TABLESTYLE');
    expect(styles).toHaveLength(1);
    expect(once.split('ACAD_TABLESTYLE')).toHaveLength(2); // one root-dictionary key, nothing else
    const table = records(once).find((r) => r[0]![1] === 'ACAD_TABLE')!;
    expect(group(table, 342)).toBe(group(styles[0]!, 5));
    const twice = writeDxf(readDxf(once));
    expect(records(twice).filter((r) => r[0]![1] === 'TABLESTYLE')).toHaveLength(1);
    expect(twice).toBe(once);
  });

  it('emits no table machinery for a table-free drawing', () => {
    const d = new Drawing();
    d.addEntities([{ id: 'l', ...props, type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }]);
    const text = writeDxf(d.snapshot);
    expect(text).not.toContain('ACAD_TABLE');
    expect(text).not.toContain('TABLESTYLE');
  });
});
