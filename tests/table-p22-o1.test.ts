/**
 * P22 O-1 PIN — the repo-side record of the AC1032 long-cell behaviour, written for
 * the lead's native re-run to judge (gate item O-1, P22 COMP-N).
 *
 * Question: at AC1032 (R2018), how must a table cell whose text exceeds 250 chars be
 * stored — one unchunked string, or chunked? AutoCAD's own AC1032 cell-value form
 * (the genuine control, tests/fixtures/interchange/r2018-table-autocad.dxf) stores
 * each cell's text in a single group 1 with its formatted twin in a single group 302,
 * and JCad's writer follows that form at any length: no 250-char chunking, no
 * group 3 / 303 continuations. This test PINS that behaviour — it asserts the
 * current, admitted writer behaviour as the record; whether AutoCAD accepts the
 * unchunked 300-char form on open is exactly what the lead's native re-run
 * (rerun-o1-longcell.dxf, built from this same shape) decides. If the native
 * verdict ever requires chunking, this test is the failing-first record of the
 * change, not a test to weaken quietly.
 *
 * The input mirrors the re-run recipe: the genuine Recipe B control with cell
 * (2,1) replaced by a 300-char numbered-segment string.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setCellText, type TableEntity } from '../src/core/table';
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

/** The ACAD_TABLE record's per-cell group chunks, in row-major order (the compn grammar). */
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

/** Thirty numbered 10-char segments: |01|abcdef|02|abcdef|…|30|abcdef — exactly 300 chars. */
const LONG = Array.from({ length: 30 }, (_, i) => `|${String(i + 1).padStart(2, '0')}|abcdef`).join('');

const controlText = () => decodeDxfBytes(readFileSync(join(import.meta.dirname, 'fixtures', 'interchange', 'r2018-table-autocad.dxf'))).text;

describe('P22 O-1 pin: a >250-char cell at AC1032 is written as ONE unchunked group 1/302', () => {
  it('the long cell (2,1) of the genuine control, replaced by 300 chars, writes unchunked', () => {
    expect(LONG).toHaveLength(300);
    const state = readDxf(controlText());
    const table = state.entities.find((e) => e.type === 'table') as TableEntity;
    expect(table).toBeDefined();
    const edited = setCellText(table, 2, 1, LONG);
    const written = writeDxf({ ...state, entities: state.entities.map((e) => (e === table ? edited : e)) });

    // The written file is AC1032 (the control's version; nothing forces higher).
    expect(written).toContain('AC1032');

    // Cell (2,1) is row-major chunk 7 of 12. Exactly ONE group 1 and ONE group 302,
    // each the full 300-char string; no group 3 / 303 continuation chunking.
    const chunks = cellChunksOf(written);
    expect(chunks).toHaveLength(12);
    const cell = chunks[7]!;
    const ones = cell.filter(([c]) => c === 1);
    const formatted = cell.filter(([c]) => c === 302);
    expect(ones).toHaveLength(1);
    expect(ones[0]![1]).toBe(LONG);
    expect(formatted).toHaveLength(1);
    expect(formatted[0]![1]).toBe(LONG);
    expect(cell.some(([c]) => c === 3 || c === 303)).toBe(false);

    // And the written file re-reads with the full text intact at (2,1).
    const back = readDxf(written).entities.find((e) => e.type === 'table') as TableEntity;
    expect(back.cells[2]![1]!.text).toBe(LONG);
  });
});
