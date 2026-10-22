/**
 * P22 O-1 — the AC1032 long-cell form, as RE-PINNED by RULING O-1 (the lead's
 * native re-run, 2026-10-21).
 *
 * The original pin asserted the unchunked form (one group 1 / one group 302
 * for a >250-char cell). The native outcome was (a) HARMLESS — AutoCAD read
 * the 300-char cell intact on input and reopen (LONGCELL-LEN=300), AUDIT 0 —
 * but the lead RULES: adopt AutoCAD's own chunking, because matching the
 * native writer is the posture for other readers. AutoCAD accepts both
 * forms; this test now pins AutoCAD's: 250-char CONTINUATION groups FIRST
 * (group 2 for the plain string, group 303 for the formatted twin), then
 * the final group (1 / 302) with the remainder — the same split points on
 * both sides. The unchunked pin is superseded, not forgotten: if the writer
 * ever regresses to it, this test fails.
 *
 * The input mirrors the re-run recipe: the genuine Recipe B control
 * (r2018-table-autocad.dxf) with cell (2,1) replaced by a numbered-segment
 * string of the stated length.
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

const segments = (n: number) => Array.from({ length: n }, (_, i) => `|${String(i + 1).padStart(2, '0')}|abcdef`).join('');
const controlText = () => decodeDxfBytes(readFileSync(join(import.meta.dirname, 'fixtures', 'interchange', 'r2018-table-autocad.dxf'))).text;

function writtenWith(cellText: string): string {
  const state = readDxf(controlText());
  const table = state.entities.find((e) => e.type === 'table') as TableEntity;
  expect(table).toBeDefined();
  const edited = setCellText(table, 2, 1, cellText);
  return writeDxf({ ...state, entities: state.entities.map((e) => (e === table ? edited : e)) });
}

const values = (chunk: Pair[], code: number) => chunk.filter(([c]) => c === code).map(([, v]) => v);

describe("P22 O-1 (RULING O-1): a >250-char cell at AC1032 is written in AutoCAD's chunked form", () => {
  it('300 chars: one 250-char continuation (2/303) FIRST, then the final 1/302 with the 50-char remainder', () => {
    const LONG = segments(30);
    expect(LONG).toHaveLength(300);
    const written = writtenWith(LONG);
    expect(written).toContain('AC1032');
    const chunks = cellChunksOf(written);
    expect(chunks).toHaveLength(12);
    const cell = chunks[7]!; // (2,1), row-major
    expect(values(cell, 2)).toEqual([LONG.slice(0, 250)]);
    expect(values(cell, 1)).toEqual([LONG.slice(250)]);
    expect(values(cell, 303)).toEqual([LONG.slice(0, 250)]);
    expect(values(cell, 302)).toEqual([LONG.slice(250)]);
    expect(values(cell, 3)).toEqual([]);
    // Both sides reassemble to the full string, and the file re-reads whole.
    expect(values(cell, 2).join('') + values(cell, 1).join('')).toBe(LONG);
    expect(values(cell, 303).join('') + values(cell, 302).join('')).toBe(LONG);
    const back = readDxf(written).entities.find((e) => e.type === 'table') as TableEntity;
    expect(back.cells[2]![1]!.text).toBe(LONG);
    expect(writeDxf(readDxf(written))).toBe(written);
  });

  it('600 chars: two continuations per side, then the final group with 100 chars', () => {
    const LONG = segments(60);
    expect(LONG).toHaveLength(600);
    const cell = cellChunksOf(writtenWith(LONG))[7]!;
    expect(values(cell, 2)).toEqual([LONG.slice(0, 250), LONG.slice(250, 500)]);
    expect(values(cell, 1)).toEqual([LONG.slice(500)]);
    expect(values(cell, 303)).toEqual([LONG.slice(0, 250), LONG.slice(250, 500)]);
    expect(values(cell, 302)).toEqual([LONG.slice(500)]);
  });

  it('a short cell keeps the single-group form (no continuations)', () => {
    const cell = cellChunksOf(writtenWith('TWO'))[7]!;
    expect(values(cell, 2)).toEqual([]);
    expect(values(cell, 303)).toEqual([]);
    expect(values(cell, 1)).toEqual(['TWO']);
    expect(values(cell, 302)).toEqual(['TWO']);
  });
});
