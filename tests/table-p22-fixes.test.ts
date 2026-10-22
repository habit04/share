/**
 * P22 slice 1 — acceptance-fix regressions (F1 / F2 / F3). Each test names the
 * acceptance finding it closes and fails at the slice head fe4b9e9 for that
 * finding's stated reason; the delivery VALIDATION carries the red/green logs.
 *
 * F1: plain cell text containing MTEXT control-sequence lookalikes was altered
 * or lost on the native round trip (silent content loss, regression vs base).
 * F2: write -> read -> write was not a fixed point at the SECOND write for
 * title-less tables (a), carrier tables (b) and some rotated tables (c).
 * F3: an out-of-bounds span claim on import was modelled verbatim, unreported.
 */
import { describe, it, expect } from 'vitest';
import type { TableCell, TableEntity } from '../src/core/entities';
import { newTable, setCellText, tableSize } from '../src/core/table';
import { readDxf, writeDxf } from '../src/io/dxf';
import { Drawing } from '../src/core/document';

const props = { layer: '0', color: 'ByLayer' as const };
const stateOf = (t: TableEntity) => { const d = new Drawing(); d.addEntities([t]); return d.snapshot; };
const roundTrip = (t: TableEntity) => {
  const w1 = writeDxf(stateOf(t));
  const back = readDxf(w1).entities.find((e) => e.type === 'table') as TableEntity;
  return { w1, back, w2: writeDxf(readDxf(w1)) };
};
const patchCells = (t: TableEntity, fn: (cell: TableCell, r: number, c: number) => TableCell): TableEntity =>
  ({ ...t, cells: t.cells.map((row, r) => row.map((cell, c) => fn(cell, r, c))) });

describe('P22 fix F1: plain cell text round-trips byte-exact through the native path', () => {
  const samples = [
    // The acceptance samples (probe file 1 + diag C + the FAIL report).
    'A\\PB', 'X\\U+0041Y', '{}', '{\\fArial|b1;HACK}', 'a\\fb', 'C:\\new\\path',
    'trail\\', '\\P', 'A\\nB', 'under\\lscore', 'over\\Oline',
    // Same class: parser-consumed %% codes as literal text.
    '%%u', 'x%%65y', '%%{', '%%\\',
    // Controls that already round-tripped and must not move.
    'plain text', 'ANGLE %%d 90', '50%% DONE', 'a;b;;c', 'first\nsecond', '  padded  ',
  ];
  it('every sample survives as plain text (text exact, no raw invented)', () => {
    let t = newTable({ id: 'f1', ...props }, { position: { x: 0, y: 0 }, columns: 1, dataRows: samples.length, title: false, header: false });
    samples.forEach((s, i) => { t = setCellText(t, i, 0, s); });
    const { w1, back, w2 } = roundTrip(t);
    samples.forEach((s, i) => {
      const got = back.cells[i]![0]!;
      expect(got.text, `sample ${JSON.stringify(s)}`).toBe(s);
      expect(got.raw, `sample ${JSON.stringify(s)} raw`).toBeUndefined();
    });
    expect(w2).toBe(w1);
  });

  it('a genuinely formatted cell is written from its raw, never double-escaped', () => {
    let t = newTable({ id: 'f1r', ...props }, { position: { x: 0, y: 0 }, columns: 2, dataRows: 1, title: false, header: false });
    t = patchCells(t, (cell, r, c) => (r === 0 && c === 0 ? { text: 'BOLD', raw: '{\\fArial|b1;BOLD}' } : cell));
    const { w1, back, w2 } = roundTrip(t);
    expect(w1).toContain('{\\fArial|b1;BOLD}');
    expect(back.cells[0]![0]!.text).toBe('BOLD');
    expect(back.cells[0]![0]!.raw).toBe('{\\fArial|b1;BOLD}');
    expect(w2).toBe(w1);
  });

  it('a stale raw (no longer matching the text) falls back to the plain path', () => {
    let t = newTable({ id: 'f1s', ...props }, { position: { x: 0, y: 0 }, columns: 1, dataRows: 1, title: false, header: false });
    t = patchCells(t, () => ({ text: 'A\\PB', raw: '{\\fArial;OTHER}' }));
    const { back } = roundTrip(t);
    expect(back.cells[0]![0]!.text).toBe('A\\PB');
    expect(back.cells[0]![0]!.raw).toBeUndefined();
  });
});

describe('P22 fix F2: write -> read -> write is byte-stable at the SECOND write', () => {
  it('(a) title-less tables: the synthesized TABLESTYLE no longer drifts', () => {
    let t = newTable({ id: 'f2a', ...props }, { position: { x: 0, y: 0 }, columns: 2, dataRows: 2, title: false, header: false });
    t = setCellText(t, 0, 0, 'x');
    const { w1, w2 } = roundTrip(t);
    expect(w2).toBe(w1);
    const one = setCellText(newTable({ id: 'f2a1', ...props }, { position: { x: 0, y: 0 }, columns: 1, dataRows: 1, title: false, header: false }), 0, 0, 'SOLO');
    expect(roundTrip(one).w2).toBe(roundTrip(one).w1);
  });

  it('(a) a no-title table with a header row and data merges is stable', () => {
    let t = newTable({ id: 'f2a2', ...props }, { position: { x: -3, y: 7 }, columns: 5, dataRows: 3, title: false, textHeight: 0.2 });
    t = { ...t, columnWidths: [1, 2, 3, 4, 5], rowHeights: [0.5, 0.61, 0.72, 0.83] };
    t = patchCells(t, (cell, r, c) => (r === 1 && c === 1 ? { ...cell, text: 'MERGED', span: { rows: 2, cols: 2 } } : { ...cell, text: `c${r}${c}` }));
    const { w1, w2 } = roundTrip(t);
    expect(w2).toBe(w1);
  });

  it('(b) a carrier table (covered cell holds text) is stable at the first re-save', () => {
    let t = newTable({ id: 'f2b', ...props }, { position: { x: 0, y: 10 }, columns: 3, dataRows: 2, title: false, header: false });
    t = patchCells(t, (cell, r, c) => (r === 0 && c === 0 ? { ...cell, text: 'OWNER', span: { rows: 1, cols: 2 } } : cell));
    t = setCellText(t, 0, 1, 'GHOST');
    const c1 = writeDxf(stateOf(t));
    const c2 = writeDxf(readDxf(c1));
    const c3 = writeDxf(readDxf(c2));
    expect(c2).toBe(c1);
    expect(c3).toBe(c2);
  });

  it('(b) a carrier table whose covered cell carries formatting is stable', () => {
    let t = newTable({ id: 'f2b2', ...props }, { position: { x: 0, y: 10 }, columns: 3, dataRows: 2, title: false, header: false });
    t = patchCells(t, (cell, r, c) => (r === 0 && c === 0 ? { ...cell, text: 'OWNER', span: { rows: 1, cols: 2 } } : cell));
    t = setCellText(t, 0, 1, 'GHOST');
    t = patchCells(t, (cell, r, c) => (r === 0 && c === 1 ? { ...cell, raw: '{\\fArial;GHOST}' } : cell));
    t = setCellText(t, 1, 0, 'below');
    const { w1, back, w2 } = roundTrip(t);
    expect(back.cells[0]![1]!.text).toBe('GHOST');
    expect(back.cells[0]![1]!.raw).toBe('{\\fArial;GHOST}');
    expect(w2).toBe(w1);
  });

  it('(c) rotated tables converge immediately (no 11/21 reconstruction drift)', () => {
    for (const rotation of [-0.35, Math.PI / 6, 0.1, 1.0, 2.2, -2.9, 3.0, 0.777]) {
      let t = newTable({ id: 'f2c', ...props }, { position: { x: 1.5, y: -2.25 }, columns: 3, dataRows: 2, columnWidth: 1.75 });
      t = { ...t, rotation, rowHeights: [0.4533333333333333, 0.36, 0.36, 0.36] };
      t = setCellText(t, 2, 2, 'corner');
      const { w1, w2 } = roundTrip(t);
      expect(w2, `rotation ${rotation}`).toBe(w1);
    }
  });
});

describe('P22 fix F3: out-of-bounds span claims are reported, never modelled', () => {
  const attack = (code: '175' | '176') => {
    let t = newTable({ id: 'f3', ...props }, { position: { x: 0, y: 0 }, columns: 2, dataRows: 1, header: false });
    t = setCellText(t, 0, 0, 'T');
    const lines = writeDxf(stateOf(t)).split('\r\n');
    for (let i = 0; i + 1 < lines.length; i += 2) if (lines[i] === code) lines[i + 1] = '99';
    const notes: string[] = [];
    const back = readDxf(lines.join('\r\n'), { notes }).entities.find((e) => e.type === 'table') as TableEntity;
    return { back, notes };
  };

  it('span groups of 99 (both directions) are dropped with an import-report note', () => {
    for (const code of ['175', '176'] as const) {
      const { back, notes } = attack(code);
      expect(back, `code ${code}`).toBeDefined();
      expect(back.cells[0]![0]!.span, `code ${code}`).toBeUndefined();
      for (const row of back.cells) for (const cell of row) {
        const span = cell.span ?? { rows: 1, cols: 1 };
        expect(span.rows).toBeLessThanOrEqual(back.cells.length);
        expect(span.cols).toBeLessThanOrEqual(2);
      }
      expect(notes.length, `code ${code} notes`).toBeGreaterThan(0);
      expect(notes.join(' ')).toMatch(/span/i);
      expect(tableSize(back)).toEqual({ width: 5, height: back.rowHeights.reduce((a, b) => a + b, 0) });
      // P22 F-2 successor consequence, recorded: a written AC1015 table now
      // carries the native roundtrip chain, so on re-read its entity keeps a
      // CAD identity (the graph's rule for records carrying a 102 block) —
      // the same treatment a genuine AutoCAD table already had. Re-homing
      // such an entity into a fresh Drawing bare is refused by design, so
      // the re-save below strips the identity; the span assertions above and
      // below are untouched.
      const re = writeDxf(stateOf({ ...back, cadIdentity: undefined }));
      expect(re).not.toContain('\r\n99\r\n');
    }
  });

  it('in-bounds spans (including boundary-exact) import silently and unchanged', () => {
    let t = newTable({ id: 'f3ok', ...props }, { position: { x: 0, y: 0 }, columns: 2, dataRows: 1, header: false });
    t = setCellText(t, 0, 0, 'T');
    const notes: string[] = [];
    const back = readDxf(writeDxf(stateOf(t)), { notes }).entities.find((e) => e.type === 'table') as TableEntity;
    expect(back.cells[0]![0]!.span).toEqual({ rows: 1, cols: 2 });
    expect(notes).toEqual([]);
  });
});
