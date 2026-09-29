import { describe, it, expect } from 'vitest';
import type { TableEntity, MTextEntity, LineEntity } from '../src/core/entities';
import { tableParts, entityBounds, distanceToEntity, translateEntity, rotateEntity, mirrorEntityAcross, scaleEntityBy, entityTypeName, explodeCompound, gripPoints, snapCandidates } from '../src/core/entities';
import { newTable, cellAt, setCellText, tableGeometry, cellOwners, tableSize, rowHeightFor } from '../src/core/table';
import { readDxf, writeDxf } from '../src/io/dxf';
import { convertDwg, convertTable, type DwgImportPayload } from '../src/io/dwg';
import { Drawing } from '../src/core/document';
import { fakeContext, drive } from './fake-context';
import { tableTool, tableEditTool } from '../src/tools/drafting-annot';
import { DraftingExplodeTool } from '../src/tools/drafting-modify';

const props = { layer: '0', color: 'ByLayer' as const };
const lookup = () => undefined;
const make = () => newTable({ id: 't', ...props }, { position: { x: 0, y: 10 }, columns: 3, dataRows: 2, columnWidth: 2 });

describe('TABLE entity', () => {
  it('builds a Standard table: merged title row, header row, data rows', () => {
    const t = make();
    expect(t.rowHeights).toHaveLength(4);
    expect(t.columnWidths).toEqual([2, 2, 2]);
    expect(t.cells[0]![0]!.span).toEqual({ rows: 1, cols: 3 });
    expect(cellOwners(t)[0]![2]).toEqual([0, 0]);
    expect(tableSize(t).width).toBe(6);
    expect(rowHeightFor(1, 0.18)).toBeCloseTo(0.36);
  });
  it('draws borders without lines inside merged cells', () => {
    const t = make();
    const geo = tableGeometry(t);
    // Vertical lines at x = 2 and x = 4 must not cross the title row.
    const titleBottom = 10 - t.rowHeights[0]!;
    for (const [a, b] of geo.lines) if (Math.abs(a.x - b.x) < 1e-9 && (Math.abs(a.x - 2) < 1e-9 || Math.abs(a.x - 4) < 1e-9)) expect(Math.max(a.y, b.y)).toBeLessThanOrEqual(titleBottom + 1e-9);
    expect(geo.texts).toHaveLength(0);
  });
  it('places cell text by the cell alignment and wraps to the cell width', () => {
    let t = setCellText(make(), 0, 0, 'PARTS LIST');
    t = setCellText(t, 2, 1, 'MOTOR');
    const texts = tableParts(t).filter((p): p is MTextEntity => p.type === 'mtext');
    expect(texts).toHaveLength(2);
    const title = texts.find((m) => m.text === 'PARTS LIST')!;
    expect(title.position.x).toBeCloseTo(3); // centred over the merged title
    expect(title.attachment).toBe(5);
    const data = texts.find((m) => m.text === 'MOTOR')!;
    expect(data.width).toBeCloseTo(2 - 0.12);
    expect(data.attachment).toBe(2);
  });
  it('finds the cell under a point (merged cells map to their owner)', () => {
    const t = make();
    expect(cellAt(t, { x: 5, y: 9.9 })).toEqual({ row: 0, col: 0 });
    expect(cellAt(t, { x: 3, y: 10 - t.rowHeights[0]! - t.rowHeights[1]! - 0.05 })).toEqual({ row: 2, col: 1 });
    expect(cellAt(t, { x: -1, y: 9 })).toBeNull();
    const rotated = rotateEntity(t, { x: 0, y: 10 }, Math.PI / 2) as TableEntity;
    expect(cellAt(rotated, { x: 0.1, y: 15 })).toEqual({ row: 0, col: 0 });
  });
  it('bounds, hit test, grips, snaps, transforms, explode', () => {
    const t = setCellText(make(), 1, 0, 'TAG');
    const b = entityBounds(t, lookup)!;
    expect(b.max.x).toBeCloseTo(6);
    expect(b.max.y).toBeCloseTo(10);
    expect(distanceToEntity({ x: 1, y: 10 }, t, lookup)).toBeCloseTo(0);
    expect(gripPoints(t)).toEqual([{ x: 0, y: 10 }]);
    expect(snapCandidates(t, lookup)[0]!.kind).toBe('insertion');
    expect((translateEntity(t, { x: 1, y: 1 }) as TableEntity).position).toEqual({ x: 1, y: 11 });
    const s = scaleEntityBy(t, { x: 0, y: 10 }, 2) as TableEntity;
    expect(s.columnWidths[0]).toBe(4);
    expect(s.textHeight).toBeCloseTo(0.36);
    // Mirrored across a vertical line the table stays readable: its top-left is the mirrored top-right.
    const m = mirrorEntityAcross(t, { x: 10, y: 0 }, { x: 10, y: 1 }) as TableEntity;
    expect(m.rotation).toBeCloseTo(0);
    expect(m.position.x).toBeCloseTo(14);
    expect(m.position.y).toBeCloseTo(10);
    expect(entityTypeName(t)).toBe('ACAD_TABLE');
    const parts = explodeCompound(t)!;
    expect(parts.some((p) => p.type === 'mtext')).toBe(true);
    expect(parts.filter((p): p is LineEntity => p.type === 'line').length).toBeGreaterThan(6);
  });
});

describe('TABLE / TABLEEDIT commands', () => {
  it('TABLE: columns, rows, Width option, insertion point', () => {
    const doc = new Drawing();
    const ctx = fakeContext(doc);
    drive(tableTool(), ctx, ['4', '3', 'W', '1.5', { x: 2, y: 8 }]);
    const t = doc.entities[0] as TableEntity;
    expect(t.type).toBe('table');
    expect(t.columnWidths).toEqual([1.5, 1.5, 1.5, 1.5]);
    expect(t.rowHeights).toHaveLength(5);
    expect(t.position).toEqual({ x: 2, y: 8 });
    expect(ctx.prompts.slice(0, 3)).toEqual(['Enter number of columns or [Auto] <5>:', 'Enter number of data rows or [Auto] <1>:', 'Specify insertion point or [Style/Width/Height]:']);
  });
  it('TABLEEDIT: pick a cell and type its text', () => {
    const doc = new Drawing();
    doc.addEntities([make()]);
    const ctx = fakeContext(doc);
    drive(tableEditTool(), ctx, [{ x: 1, y: 9.9 }, 'CONTROL PANEL']);
    const t = doc.entities[0] as TableEntity;
    expect(t.cells[0]![0]!.text).toBe('CONTROL PANEL');
    expect(ctx.prompts).toEqual(['Pick a table cell:', 'Enter cell text <>:']);
  });
  it('EXPLODE turns a table into lines and text', () => {
    const doc = new Drawing();
    doc.addEntities([setCellText(make(), 0, 0, 'X')]);
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['t']);
    drive(new DraftingExplodeTool(), ctx, []);
    expect(doc.entities.some((e) => e.type === 'table')).toBe(false);
    expect(doc.entities.some((e) => e.type === 'mtext')).toBe(true);
  });
});

describe('TABLE in DXF', () => {
  it('survives a JCad save / reopen (INSERT of an anonymous block + JCAD_TABLE xdata)', () => {
    const d = new Drawing();
    let t = setCellText(make(), 0, 0, 'PARTS – ÄÖ'); // non-ASCII survives the 7-bit xdata
    t = setCellText(t, 2, 2, 'line1\nline2');
    d.addEntities([{ ...t, layer: 'TABLES', color: 5 }]);
    const text = writeDxf(d.snapshot);
    expect(text).toContain('JCAD_TABLE');
    expect(text).toMatch(/\r\n2\r\n\*U\d+\r\n70\r\n1\r\n/);
    const back = readDxf(text);
    const tt = back.entities[0] as TableEntity;
    expect(tt.type).toBe('table');
    expect(tt.layer).toBe('TABLES');
    expect(tt.cells[0]![0]!.text).toBe('PARTS – ÄÖ');
    expect(tt.cells[2]![2]!.text).toBe('line1\nline2');
    expect(tt.rowHeights).toEqual(t.rowHeights);
    // The drawing block is not kept as a separate block definition.
    expect(Object.keys(back.blocks).filter((n) => n.startsWith('*U'))).toHaveLength(0);
    // Saving again gives the same table.
    const again = readDxf(writeDxf(back)).entities[0] as TableEntity;
    expect(again.cells).toEqual(tt.cells);
  });
  it('reads ACAD_TABLE cell data (91/92, 141/142, 171.. cells with 1/3 text) as a native table', () => {
    const cell = (text: string, extra: string[] = []) => ['171', '1', '172', '0', '173', '0', '174', '0', '175', '1', '176', '1', '91', '0', '178', '0', '145', '0', ...extra, '1', text, '7', 'Standard', '140', '0.18', '170', '5'];
    const dxf = [
      '0', 'SECTION', '2', 'BLOCKS',
      '0', 'BLOCK', '8', '0', '2', '*T3', '70', '1', '10', '0', '20', '0', '3', '*T3',
      '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '4', '21', '0',
      '0', 'ENDBLK',
      '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'ACAD_TABLE', '5', '7A', '8', 'TBL', '100', 'AcDbEntity', '100', 'AcDbBlockReference', '2', '*T3', '10', '1', '20', '9', '30', '0',
      '100', 'AcDbTable', '280', '0', '342', 'C0', '343', 'C1', '11', '1', '21', '0', '31', '0', '90', '22', '91', '2', '92', '2', '93', '0', '94', '0', '95', '0', '96', '0',
      '141', '0.5', '141', '0.4', '142', '3', '142', '1.5',
      '171', '1', '172', '0', '173', '0', '174', '0', '175', '2', '176', '1', '91', '0', '178', '0', '145', '0', '1', 'TITLE', '7', 'Standard', '140', '0.25', '170', '5',
      ...cell(''),
      ...cell('B', ['3', 'LONG ']),
      ...cell('{\\C1;X}'),
      '280', '0', '281', '0',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const s = readDxf(dxf);
    const t = s.entities[0] as TableEntity;
    expect(t.type).toBe('table');
    expect(t.position).toEqual({ x: 1, y: 9 });
    expect(t.rowHeights).toEqual([0.5, 0.4]);
    expect(t.columnWidths).toEqual([3, 1.5]);
    expect(t.cells[0]![0]).toMatchObject({ text: 'TITLE', height: 0.25, attachment: 5, span: { rows: 1, cols: 2 } });
    expect(t.cells[1]![0]!.text).toBe('LONG B');
    expect(t.cells[1]![1]).toMatchObject({ text: 'X', raw: '{\\C1;X}' });
    expect(s.blocks['*T3']).toBeUndefined();
  });
  it('keeps the *T block insert when the ACAD_TABLE carries no cell data', () => {
    const dxf = [
      '0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '8', '0', '2', '*T9', '70', '1', '10', '0', '20', '0', '3', '*T9', '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '5', '21', '0', '0', 'ENDBLK', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES', '0', 'ACAD_TABLE', '8', 'TBL', '2', '*T9', '10', '3.5', '20', '20', '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const s = readDxf(dxf);
    expect(s.entities[0]).toMatchObject({ type: 'insert', block: '*T9' });
  });
});

describe('TABLE from DWG', () => {
  const cell = (text: string, extra: Record<string, unknown> = {}) => ({ text, attachmentPoint: 5, cellType: 1, topBorderVisibility: true, bottomBorderVisibility: true, leftBorderVisibility: true, rightBorderVisibility: true, textHeight: 0.18, ...extra });
  it('converts cell data to a native table and drops its *T block', () => {
    const payload: DwgImportPayload = {
      header: {},
      layers: [{ name: '0', colorIndex: 7, off: false, frozen: false, locked: false, lineweight: 29 }],
      blocks: [{ name: '*T2', handle: 'B1', basePoint: { x: 0, y: 0, z: 0 }, entities: [{ type: 'LINE', handle: 'L', layer: '0', startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 0 } } as never], description: '' }],
      entities: [
        {
          type: 'ACAD_TABLE',
          handle: 'T1',
          layer: '0',
          blockRecordHandle: 'B1',
          startPoint: { x: 2, y: 3, z: 0 },
          directionVector: { x: 1, y: 0, z: 0 },
          rowCount: 2,
          columnCount: 2,
          rowHeightArr: [0.5, 0.4],
          columnWidthArr: [2, 2],
          cells: [cell('HEAD', { borderWidth: 2 }), cell(''), cell('A'), cell('B')],
        } as never,
      ],
    };
    expect(convertTable(payload.entities[0]!)).not.toBeNull();
    const { state } = convertDwg(payload);
    const t = state.entities[0] as TableEntity;
    expect(t.type).toBe('table');
    expect(t.cells[0]![0]!.span).toEqual({ rows: 1, cols: 2 });
    expect(t.cells[1]![1]!.text).toBe('B');
    expect(state.blocks.ANON_T2).toBeUndefined();
  });
});
