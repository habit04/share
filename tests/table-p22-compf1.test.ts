/**
 * P22 COMP-F1 (composition finding, jcad-p22-composed VALIDATION §5): the F3
 * span screen at the top of readJcadTable dereferences `cell.span` (and
 * `row.some`) on whatever JSON the JCAD_TABLE carrier holds. A malformed cell
 * (null) or row (null / non-array) threw inside the function's try/catch,
 * which returned null — "not a JCad table" — so the INSERT fell through to
 * the generic insert path and was imported silently, bypassing the table
 * format validation that, before F3, dropped the entity with an import-report
 * item ("invalid geometry: table cells must contain text" / "table cell rows
 * must be arrays"). These tests pin the pre-F3 posture for the whole
 * malformed-cell family on the carrier path: validation sees the payload,
 * malformed tables are dropped and reported — never a generic insert, never
 * a throw, never a silent import — while well-formed payloads, short rows
 * and F3's span discipline are exactly as before. They fail at fc13c44 for
 * the null-cell, null-row, string-row and mixed specimens.
 */
import { describe, it, expect } from 'vitest';
import type { TableEntity } from '../src/core/entities';
import { readDxf } from '../src/io/dxf';
import { importReportOf } from '../src/io/import-report';

function carrier(cells: unknown, rowHeights: number[], columnWidths: number[]): string {
  const metadata = JSON.stringify({ position: { x: 0, y: 0 }, rowHeights, columnWidths, cells, textHeight: 1 });
  return ['0', 'SECTION', '2', 'ENTITIES', '0', 'INSERT', '5', 'BAD', '8', 'TABLES', '1001', 'JCAD_TABLE', '1000', metadata, '0', 'ENDSEC', '0', 'EOF'].join('\n');
}

function droppedWith(cells: unknown, rowHeights: number[], columnWidths: number[], reasonPart: string) {
  const result = readDxf(carrier(cells, rowHeights, columnWidths));
  expect(result.entities).toEqual([]);
  expect(importReportOf(result)?.items).toContainEqual(expect.objectContaining({
    type: 'INSERT', handle: 'BAD', layer: 'TABLES', action: 'dropped',
    reason: expect.stringContaining(reasonPart),
  }));
}

describe('P22 COMP-F1: malformed carrier cells reach format validation', () => {
  it('a null cell is dropped and reported, not kept as a generic insert', () => {
    droppedWith([[null]], [1], [1], 'table cells must contain text');
  });

  it('non-object cells are dropped and reported', () => {
    for (const cell of ['plain', 42, true, ['x']]) {
      droppedWith([[cell]], [1], [1], 'table cells must contain text');
    }
  });

  it('cells without string text are dropped and reported', () => {
    droppedWith([[{}]], [1], [1], 'table cells must contain text');
    droppedWith([[{ text: 5 }]], [1], [1], 'table cells must contain text');
  });

  it('non-array rows are dropped and reported', () => {
    droppedWith([null], [1], [1], 'table cell rows must be arrays');
    droppedWith(['row'], [1], [1], 'table cell rows must be arrays');
  });

  it('a malformed cell is judged even when a sibling cell carries an out-of-bounds span claim', () => {
    const notes: string[] = [];
    const result = readDxf(carrier([[null, { text: 'b', span: { rows: 5, cols: 1 } }]], [1], [1, 1]), { notes });
    expect(result.entities).toEqual([]);
    expect(importReportOf(result)?.items).toContainEqual(expect.objectContaining({
      type: 'INSERT', action: 'dropped', reason: expect.stringContaining('table cells must contain text'),
    }));
    // The span claim was in the file and out of bounds: F3 reports it (the
    // table is then dropped by validation for the malformed cell).
    expect(notes).toEqual(['Table cell at row 1, column 2 claims a span of 5 rows x 1 columns outside the 1 x 2 table; the claim was ignored and the cell left unmerged.']);
  });

  it('short rows, empty rows and an empty grid keep their pre-F3 posture (table kept verbatim)', () => {
    const short = readDxf(carrier([[{ text: 'a' }]], [1], [1, 1]));
    expect(short.entities.map((e) => e.type)).toEqual(['table']);
    expect((short.entities[0] as TableEntity).cells).toEqual([[{ text: 'a' }]]);
    const emptyRow = readDxf(carrier([[]], [1], [1]));
    expect(emptyRow.entities.map((e) => e.type)).toEqual(['table']);
    const noRows = readDxf(carrier([], [1], [1]));
    expect(noRows.entities.map((e) => e.type)).toEqual(['table']);
    expect(importReportOf(noRows)).toBeUndefined();
  });

  it('F3 span discipline on the carrier path is unchanged for well-formed cells', () => {
    const notes: string[] = [];
    const result = readDxf(carrier([[{ text: 'a', span: { rows: 99, cols: 1 } }]], [1], [1]), { notes });
    const table = result.entities.find((e) => e.type === 'table') as TableEntity;
    expect(table).toBeDefined();
    expect(table.cells[0]![0]!.span).toBeUndefined();
    expect(table.cells[0]![0]!.text).toBe('a');
    expect(notes).toEqual(['Table cell at row 1, column 1 claims a span of 99 rows x 1 columns outside the 1 x 1 table; the claim was ignored and the cell left unmerged.']);
  });
});
