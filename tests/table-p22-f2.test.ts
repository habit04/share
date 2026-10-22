/**
 * P22 F-2 — AC1015 cells are written in AutoCAD's own R2000 form.
 *
 * At the lead's native re-run, JCad's pre-F-2 legacy form (per-cell
 * 91/92/7, unconditional 140/170, no text group on covered cells) loaded in
 * AutoCAD with every cell's text EMPTY until a regen (entget showed 91=0),
 * and the title cell's height/alignment never appeared in any phase.
 * AutoCAD's R2000 form — the genuine control
 * tests/fixtures/interchange/r2000-table-autocad.dxf (the Recipe B table
 * saved at AC1015; see PROVENANCE.md) — is: 171..176 head with group 177
 * carrying the override flags (0x20 height, 0x1 alignment), 178, 145, the
 * text in 3-chunks + a group 1 EVERY cell carries ('' for merge-covered
 * cells, whose spans are 1, not 0), and 140/170 only where the cell departs
 * from its row role's style defaults, after the text.
 *
 * This is the golden test: the control's per-cell group layout, compared
 * canonicalised (reals/int via Number/parseInt, strings verbatim — the
 * compn canon), must equal the layout JCad writes for the same table.
 * The record HEAD is out of scope (AutoCAD's cached 92/310 binary data is
 * not JCad's to reproduce); the AC1032 CELL_VALUE form is unchanged (N-3).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDxf, writeDxf } from '../src/io/dxf';
import { decodeDxfBytes } from '../src/io/encoding';

type Pair = [number, string];

function records(text: string): Pair[][] {
  const lines = text.split(/\r?\n/);
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i]!, 10), lines[i + 1]!]);
  const out: Pair[][] = [];
  let cur: Pair[] | null = null;
  for (const p of pairs) {
    if (p[0] === 0) {
      cur = [p];
      out.push(cur);
    } else cur?.push(p);
  }
  return out;
}

function tableRecord(text: string): Pair[] {
  const rec = records(text).find((r) => r[0]![1] === 'ACAD_TABLE');
  expect(rec, 'an ACAD_TABLE record').toBeDefined();
  return rec!;
}

/** The per-cell chunks of an ACAD_TABLE record (171 .. end of cell), row-major. */
function cellChunksOf(text: string): Pair[][] {
  const rec = tableRecord(text);
  const sub = rec.findIndex(([c, v]) => c === 100 && v === 'AcDbTable');
  const gs = rec.slice(sub + 1);
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

const REAL_CELL_CODES = new Set([140, 145]);
const INT_CELL_CODES = new Set([91, 92, 93, 90, 94, 170, 171, 172, 173, 174, 175, 176, 177, 178]);
const canonCell = (chunk: Pair[]): string[] =>
  chunk.map(([c, v]) => (REAL_CELL_CODES.has(c) ? `${c}=n:${Number(v)}` : INT_CELL_CODES.has(c) ? `${c}=i:${parseInt(v, 10)}` : `${c}=s:${v}`));

const r2000Text = () => decodeDxfBytes(readFileSync(join(import.meta.dirname, 'fixtures', 'interchange', 'r2000-table-autocad.dxf'))).text;
const r2018Text = () => decodeDxfBytes(readFileSync(join(import.meta.dirname, 'fixtures', 'interchange', 'r2018-table-autocad.dxf'))).text;
const group = (chunk: Pair[], code: number) => chunk.find(([c]) => c === code)?.[1];

describe("P22 F-2: AC1015 cells in AutoCAD's R2000 form (golden: the genuine AC1015 control)", () => {
  it("JCad's written per-cell layout equals the control's, cell for cell", () => {
    const written = writeDxf(readDxf(r2000Text()));
    expect(written).toContain('AC1015');
    expect(cellChunksOf(written).map(canonCell)).toEqual(cellChunksOf(r2000Text()).map(canonCell));
    // The grid: 141/142 as numbers (the control carries full precision; JCad
    // writes at its 10-decimal precision — equal within 1e-9).
    const grid = (t: string, code: number) => tableRecord(t).filter(([c]) => c === code).map(([, v]) => Number(v));
    for (const code of [141, 142]) {
      const mine = grid(written, code);
      const oracle = grid(r2000Text(), code);
      expect(mine).toHaveLength(oracle.length);
      mine.forEach((v, i) => expect(Math.abs(v - oracle[i]!)).toBeLessThan(1e-9));
    }
  });

  it('the shape pins: 177 flags, overrides after the text, covered cells carry an empty group 1', () => {
    const chunks = cellChunksOf(writeDxf(readDxf(r2000Text())));
    expect(chunks).toHaveLength(12);
    for (const chunk of chunks) {
      expect(chunk.filter(([c]) => c === 1)).toHaveLength(1);
      expect(chunk.some(([c]) => c === 91 || c === 92 || c === 7 || c === 301)).toBe(false);
    }
    // Merge-covered (0,1) and (0,2): virtual, spans 1, no overrides, empty text.
    for (const idx of [1, 2]) {
      expect(group(chunks[idx]!, 173)).toBe('1');
      expect(group(chunks[idx]!, 175)).toBe('1');
      expect(group(chunks[idx]!, 176)).toBe('1');
      expect(group(chunks[idx]!, 177)).toBe('0');
      expect(group(chunks[idx]!, 1)).toBe('');
    }
    // (2,2) 'BOLT': height override — 177 = 0x20, the 140 AFTER the group 1.
    const bolt = chunks[8]!;
    expect(group(bolt, 1)).toBe('BOLT');
    expect(parseInt(group(bolt, 177)!, 10)).toBe(0x20);
    expect(bolt.map(([c]) => c).indexOf(140)).toBeGreaterThan(bolt.map(([c]) => c).indexOf(1));
    expect(Number(group(bolt, 140))).toBeCloseTo(0.3, 12);
    // (3,0) 'B-200': alignment override — 177 = 0x1, the 170 after the group 1.
    const b200 = chunks[9]!;
    expect(group(b200, 1)).toBe('B-200');
    expect(parseInt(group(b200, 177)!, 10)).toBe(0x1);
    expect(b200.map(([c]) => c).indexOf(170)).toBeGreaterThan(b200.map(([c]) => c).indexOf(1));
    expect(group(b200, 170)).toBe('6');
  });

  it('the AC1032 cell-value form is unchanged by F-2', () => {
    const written = writeDxf(readDxf(r2018Text()));
    expect(written).toContain('AC1032');
    const chunks = cellChunksOf(written);
    expect(chunks.some((chunk) => chunk.some(([c, v]) => c === 301 && v === 'CELL_VALUE'))).toBe(true);
    expect(chunks.some((chunk) => chunk.some(([c]) => c === 177))).toBe(false);
  });

  it('the R2000 round trip is a fixed point', () => {
    const written = writeDxf(readDxf(r2000Text()));
    expect(writeDxf(readDxf(written))).toBe(written);
  });
});
