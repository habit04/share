/**
 * P22 F-1 — written row heights fit multi-line cells (the lead's native re-run
 * item A15, Leg A: AutoCAD's own save grew a 0.36 row to 0.6 to fit the
 * two-line cell (2,2), so JCad's 141s did not survive an AutoCAD save
 * unchanged).
 *
 * The ruled formula, exactly as implemented in tableDxfForm (write-annotations):
 * for each row, written height = max(stored height, floor), where the floor is
 * the maximum over the row's owner cells with TWO OR MORE written lines of
 *   rowHeightFor(lines, cellHeight, margin)
 *     = lines x cellHeight x 4/3 + 2 x margin
 * (cellHeight = the cell's override else the table text height; margin = the
 * table's margin else 0.06; lines counted on the written content, '\n' having
 * become '\P', escapes skipped in pairs). Single-line rows are never floored:
 * AutoCAD's genuine controls carry authored single-line heights below a
 * height-override cell's fit height and those are preserved verbatim.
 * A15's numbers reproduce exactly: lines 2, height 0.18, margin 0.06 ->
 * 2 x 0.18 x 4/3 + 0.12 = 0.60.
 */
import { describe, it, expect } from 'vitest';
import { newTable, setCellText, rowHeightFor, type TableEntity } from '../src/core/table';
import { Drawing } from '../src/core/document';
import { readDxf, writeDxf } from '../src/io/dxf';

const props = { layer: '0', color: 'ByLayer' as const };
const stateOf = (t: TableEntity) => {
  const d = new Drawing();
  d.addEntities([t]);
  return d.snapshot;
};

/** The ACAD_TABLE record's group-141 row heights, as printed. */
function writtenRowHeights(text: string): number[] {
  const lines = text.split(/\r?\n/);
  const pairs: Array<[number, string]> = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i]!, 10), lines[i + 1]!]);
  const start = pairs.findIndex(([c, v]) => c === 0 && v === 'ACAD_TABLE');
  const out: number[] = [];
  for (let i = start + 1; i < pairs.length && pairs[i]![0] !== 0; i += 1) {
    if (pairs[i]![0] === 141) out.push(Number(pairs[i]![1]));
  }
  return out;
}

function baseTable(): TableEntity {
  // Title + header + 2 data rows; stored heights are newTable's own
  // single-line fits: [0.45333…, 0.36, 0.36, 0.36] at text height 0.18.
  return newTable({ id: 't', ...props }, { position: { x: 0, y: 10 }, columns: 3, dataRows: 2, columnWidth: 2 });
}

describe('P22 F-1: written row heights fit multi-line cells', () => {
  it('A15 reproduced: the two-line cell (2,2) writes row 2 at 0.6; single-line rows unchanged', () => {
    const t = setCellText(baseTable(), 2, 2, 'line1\nline2');
    expect(t.rowHeights[2]).toBeCloseTo(0.36, 12);
    const written = writtenRowHeights(writeDxf(stateOf(t)));
    // lines x textHeight + top/bottom margins is the brief's floor form; the
    // writer's fit (rowHeightFor) is 2 x 0.18 x 4/3 + 2 x 0.06 = 0.6 exactly.
    expect(written[2]).toBeGreaterThanOrEqual(2 * 0.18 + 2 * 0.06);
    expect(written[2]).toBe(Number(rowHeightFor(2, 0.18, 0.06).toFixed(10)));
    expect(written[2]).toBeCloseTo(0.6, 9);
    expect(written[0]).toBeCloseTo(0.4533333333, 10);
    expect(written[1]).toBeCloseTo(0.36, 10);
    expect(written[3]).toBeCloseTo(0.36, 10);
  });

  it('a stored height above the floor is written unchanged', () => {
    let t = setCellText(baseTable(), 2, 2, 'line1\nline2');
    t = { ...t, rowHeights: [0.4533333333333333, 0.36, 0.9, 0.36] };
    expect(writtenRowHeights(writeDxf(stateOf(t)))[2]).toBeCloseTo(0.9, 10);
  });

  it("a multi-line cell's own height override sets the floor (3 lines at 0.3)", () => {
    let t = setCellText(baseTable(), 3, 1, 'a\nb\nc');
    t = { ...t, cells: t.cells.map((row, r) => row.map((c, col) => (r === 3 && col === 1 ? { ...c, height: 0.3 } : c))) };
    const written = writtenRowHeights(writeDxf(stateOf(t)));
    expect(written[3]).toBe(Number(rowHeightFor(3, 0.3, 0.06).toFixed(10)));
    expect(written[3]).toBeCloseTo(1.32, 9);
  });

  it("paragraph breaks in a cell's formatted source count as lines; an escaped literal \\P does not", () => {
    let t = setCellText(baseTable(), 2, 0, 'one\ntwo');
    t = { ...t, cells: t.cells.map((row, r) => row.map((c, col) => (r === 2 && col === 0 ? { ...c, raw: 'one\\Ptwo' } : c))) };
    expect(writtenRowHeights(writeDxf(stateOf(t)))[2]).toBeCloseTo(0.6, 9);
    const literal = setCellText(baseTable(), 2, 0, 'a\\Pb');
    expect(writtenRowHeights(writeDxf(stateOf(literal)))[2]).toBeCloseTo(0.36, 10);
  });

  it('the floored write is a fixed point', () => {
    const t = setCellText(baseTable(), 2, 2, 'line1\nline2');
    const written = writeDxf(stateOf(t));
    expect(writeDxf(readDxf(written))).toBe(written);
  });

  it('a carrier-bearing table (covered cell with text) with a multi-line cell is also a fixed point', () => {
    let t = setCellText(baseTable(), 0, 0, 'TITLE');
    t = setCellText(t, 0, 1, 'covered words'); // under the title merge -> rides the JCAD_TABLE carrier
    t = setCellText(t, 2, 2, 'line1\nline2');
    const written = writeDxf(stateOf(t));
    expect(writeDxf(readDxf(written))).toBe(written);
    const back = readDxf(written).entities.find((e) => e.type === 'table') as TableEntity;
    expect(back.cells[0]![1]!.text).toBe('covered words');
  });
});
