/**
 * P22 slice 1 — F-1b regression (fix-delta acceptance, P22-SLICE1-FIX-DELTA-
 * ACCEPTANCE §2): the F1 guard escape \U+005C (guardDxfEscapes, 7 chars)
 * STRADDLING a 250-char chunk boundary was never decoded on read —
 * decodeUnicodeEscapes runs per group value (reader.ts) — so the MTEXT
 * parser (native cell content, groups 3/1) or the JSON parser (JCAD_TABLE
 * carrier, group 1000) consumed the sequence itself and the following
 * U+XXXX survived literally: authored '%%u' came back '%\U+0025u', an
 * authored literal '\U+0041' came back '\U+005CU+0041'. The guard straddles
 * exactly when it starts at chunk-relative offset 244..249 (a start at 243
 * ends exactly at the boundary and already worked). These tests fail at
 * 5128994 for that reason; they pass once chunk splits keep the guard
 * sequence whole, as they already keep surrogate pairs whole. Content whose
 * guard sequences do not straddle must keep the 5128994 chunking byte-exact.
 */
import { describe, it, expect } from 'vitest';
import type { TableCell, TableEntity } from '../src/core/entities';
import { newTable, setCellText } from '../src/core/table';
import { readDxf, writeDxf } from '../src/io/dxf';
import { Drawing } from '../src/core/document';

const props = { layer: '0', color: 'ByLayer' as const };
const stateOf = (t: TableEntity) => { const d = new Drawing(); d.addEntities([t]); return d.snapshot; };
const patchCells = (t: TableEntity, fn: (cell: TableCell, r: number, c: number) => TableCell): TableEntity =>
  ({ ...t, cells: t.cells.map((row, r) => row.map((cell, c) => fn(cell, r, c))) });

type Pair = [number, string];
function pairs(text: string): Pair[] {
  const lines = text.split('\r\n');
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([Number(lines[i]), lines[i + 1]!]);
  return out;
}
function acadTableRecord(text: string): Pair[] {
  let cur: Pair[] | null = null;
  for (const p of pairs(text)) {
    if (p[0] === 0) { if (cur && cur[0]![1] === 'ACAD_TABLE') return cur; cur = [p]; }
    else cur?.push(p);
  }
  if (cur && cur[0]![1] === 'ACAD_TABLE') return cur;
  throw new Error('no ACAD_TABLE record');
}
/** The visible cell's content chunks (group 3 + final group 1) from the ACAD_TABLE record. */
function cellChunks(text: string): string[] {
  const rec = acadTableRecord(text);
  return [...rec.filter(([c]) => c === 3).map(([, v]) => v), ...rec.filter(([c]) => c === 1).map(([, v]) => v)];
}
/** The carrier payload chunks (group 1000) from the ACAD_TABLE record. */
function carrierChunks(text: string): string[] {
  return acadTableRecord(text).filter(([c]) => c === 1000).map(([, v]) => v);
}
const GUARD = '\\U+005C';
/** Assert every guard occurrence in the joined content lies whole inside one chunk. */
function expectNoGuardStraddle(chunks: string[]): void {
  const bounds: Array<[number, number]> = [];
  let at = 0;
  for (const c of chunks) { bounds.push([at, at + c.length]); at += c.length; }
  const joined = chunks.join('');
  for (let i = joined.indexOf(GUARD); i !== -1; i = joined.indexOf(GUARD, i + 1)) {
    expect(bounds.some(([s, e]) => s <= i && i + GUARD.length <= e), `guard at ${i} straddles chunks ${JSON.stringify(chunks.map((c) => c.length))}`).toBe(true);
  }
}

function plainTable(text: string): TableEntity {
  let t = newTable({ id: 'f1b', ...props }, { position: { x: 0, y: 0 }, columns: 1, dataRows: 1, title: false, header: false });
  t = setCellText(t, 0, 0, text);
  return t;
}
function roundTripText(t: TableEntity): { w1: string; w2: string; back: TableEntity } {
  const w1 = writeDxf(stateOf(t));
  const back = readDxf(w1).entities.find((e) => e.type === 'table') as TableEntity;
  return { w1, w2: writeDxf(readDxf(w1)), back };
}

describe('P22 F-1b: guard escapes never straddle a 250-char chunk boundary (native cell content)', () => {
  it('sweep: a %%u guard at every start offset across the first boundary round-trips exact', () => {
    const failures: string[] = [];
    // Guard starts at content offset pad + 1: pads 0..249 put it at 1..250 —
    // every chunk-relative offset of chunk 1, plus offset 0 of chunk 2 (250).
    for (let pad = 0; pad <= 249; pad += 1) {
      const v = 'a'.repeat(pad) + '%%u' + 'b'.repeat(600);
      const { w1, w2, back } = roundTripText(plainTable(v));
      const cell = back.cells[0]![0]!;
      if (cell.text !== v || cell.raw !== undefined) failures.push(`pad=${pad} text exact=${cell.text === v} raw=${cell.raw !== undefined}`);
      if (w2 !== w1) failures.push(`pad=${pad} not a first-write fixed point`);
      expectNoGuardStraddle(cellChunks(w1));
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('sweep: guards approaching the SECOND boundary (offset 500) round-trip exact', () => {
    const failures: string[] = [];
    for (let pad = 478; pad <= 512; pad += 1) {
      const v = 'a'.repeat(pad) + '%%u' + 'b'.repeat(400);
      const { w1, back } = roundTripText(plainTable(v));
      if (back.cells[0]![0]!.text !== v) failures.push(`pad=${pad}`);
      expectNoGuardStraddle(cellChunks(w1));
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('boundary-exact controls: a guard ending exactly at 250 and one starting exactly at 250', () => {
    // pad 242: guard occupies [243, 250) — ends exactly at the boundary.
    const ends = roundTripText(plainTable('a'.repeat(242) + '%%u' + 'b'.repeat(400)));
    expect(ends.back.cells[0]![0]!.text).toBe('a'.repeat(242) + '%%u' + 'b'.repeat(400));
    expect(cellChunks(ends.w1).map((c) => c.length)).toEqual([250, 250, 157]);
    // pad 249: guard starts at 250 — offset 0 of the second chunk.
    const starts = roundTripText(plainTable('a'.repeat(249) + '%%u' + 'b'.repeat(400)));
    expect(starts.back.cells[0]![0]!.text).toBe('a'.repeat(249) + '%%u' + 'b'.repeat(400));
    expect(cellChunks(starts.w1).map((c) => c.length)).toEqual([250, 250, 164]);
  });

  it('chunk-shape invariant: non-straddle content keeps the 5128994 chunking; a straddle pulls the split back to the guard start', () => {
    // Guard at content offset 101 — no straddle: chunks stay 250-aligned.
    const calm = writeDxf(stateOf(plainTable('a'.repeat(100) + '%%u' + 'b'.repeat(600))));
    expect(cellChunks(calm).map((c) => c.length)).toEqual([250, 250, 215]);
    // Guard at content offset 245 (pad 244) — straddled at 5128994: the first
    // split must move back to the guard start so the sequence stays whole.
    const split = writeDxf(stateOf(plainTable('a'.repeat(244) + '%%u' + 'b'.repeat(400))));
    const chunks = cellChunks(split);
    expect(chunks[0]!.length).toBe(245);
    expect(chunks[0]).toMatch(/%$/);
    expect(chunks[1]).toMatch(/^\\U\+005C/);
  });

  it("the acceptance owner's 1000-char control-laden specimen round-trips byte-exact", () => {
    const v = 'x\\P{y}%%u\\'.repeat(100);
    const { w1, w2, back } = roundTripText(plainTable(v));
    expect(back.cells[0]![0]!.text).toBe(v);
    expect(back.cells[0]![0]!.raw).toBeUndefined();
    expect(w2).toBe(w1);
    expectNoGuardStraddle(cellChunks(w1));
  });
});

describe('P22 F-1b: guard escapes never straddle a chunk boundary (JCAD_TABLE carrier JSON)', () => {
  function carrierTable(coveredText: string): TableEntity {
    let t = newTable({ id: 'f1bc', ...props }, { position: { x: 0, y: 0 }, columns: 2, dataRows: 1, title: false, header: false });
    t = patchCells(t, (cell, r, c) => {
      if (r === 0 && c === 0) return { ...cell, text: 'OWNER', span: { rows: 1, cols: 2 } };
      if (r === 0 && c === 1) return { ...cell, text: coveredText };
      return cell;
    });
    return t;
  }

  it('sweep: a literal \\U+0041 in a covered cell at every pad across the payload boundaries', () => {
    const failures: string[] = [];
    for (let pad = 0; pad <= 520; pad += 1) {
      const covered = 'a'.repeat(pad) + '\\U+0041' + 'b'.repeat(400);
      const { w1, back } = roundTripText(carrierTable(covered));
      if (back.cells[0]![1]!.text !== covered) failures.push(`pad=${pad}`);
      const chunks = carrierChunks(w1);
      if (chunks.length === 0) failures.push(`pad=${pad} carrier missing`);
      expectNoGuardStraddle(chunks);
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('a straddling carrier guard is pulled whole into one group-1000 chunk', () => {
    // Find a pad whose payload guard straddled at 5128994 (start ≡ 244..249
    // mod 250 in the payload) from the emitted chunks themselves.
    let specimen: { pad: number; chunks: string[] } | null = null;
    for (let pad = 0; pad <= 249 && !specimen; pad += 1) {
      const covered = 'a'.repeat(pad) + '\\U+0041' + 'b'.repeat(400);
      const w1 = writeDxf(stateOf(carrierTable(covered)));
      const chunks = carrierChunks(w1);
      const joined = chunks.join('');
      const guardAt = joined.indexOf(GUARD);
      if (guardAt !== -1 && guardAt % 250 >= 244) specimen = { pad, chunks };
    }
    expect(specimen).not.toBeNull();
    expectNoGuardStraddle(specimen!.chunks);
    const covered = 'a'.repeat(specimen!.pad) + '\\U+0041' + 'b'.repeat(400);
    expect(roundTripText(carrierTable(covered)).back.cells[0]![1]!.text).toBe(covered);
  }, 120_000);
});
