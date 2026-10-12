import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Drawing } from '../src/core/document';
import { distanceToEntity, entityBounds, explodeInsert, expandInsert, expansionReport, mirrorEntityAcross, rotateEntity, scaleEntityBy, snapCandidates, type BlockDef, type InsertEntity, type LineEntity } from '../src/core/entities';
import { insertArrayInstances } from '../src/core/insert-array';
import { readDxf, writeDxf } from '../src/io/dxf';
import { convertDwg, type DwgImportPayload } from '../src/io/dwg';
import { importReportOf } from '../src/io/import-report';
import { billOfMaterial, componentReport } from '../src/electrical/reports';
import { auditIssues } from '../src/electrical/audit';
// @ts-expect-error Node-side JavaScript reader shared with Electron.
import { readDwgPayload } from '../scripts/dwg-reader.mjs';

// Independent DXF input uses Autodesk's INSERT 70/71/44/45 group definitions.
const source = (columns = '3', rows = '2', columnSpacing = '7', rowSpacing = '11', sy = '3') => `0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n0\nENDSEC\n0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n2\nB\n70\n0\n10\n2\n20\n3\n0\nLINE\n8\n0\n10\n2\n20\n3\n11\n3\n21\n3\n0\nENDBLK\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nINSERT\n5\nA1\n100\nAcDbEntity\n8\n0\n100\nAcDbMInsertBlock\n2\nB\n10\n10\n20\n20\n41\n2\n42\n${sy}\n50\n90\n70\n${columns}\n71\n${rows}\n44\n${columnSpacing}\n45\n${rowSpacing}\n0\nENDSEC\n0\nEOF\n`;
const basic = (): InsertEntity => ({ type: 'insert', id: 'array', layer: '0', color: 'ByLayer', block: 'B', position: { x: 10, y: 20 }, rotation: Math.PI / 2, scale: 2, scaleY: 3, attributes: {}, columns: 3, rows: 2, columnSpacing: 7, rowSpacing: 11 });
const block: BlockDef = { name: 'B', basePoint: { x: 2, y: 3 }, entities: [{ type: 'line', id: 'edge', layer: '0', color: 'ByLayer', a: { x: 2, y: 3 }, b: { x: 3, y: 3 } }], attributes: [] };
const lookup = (name: string) => name === 'B' ? block : undefined;
const anchors = (insert: InsertEntity) => explodeInsert(insert, lookup).map(e => (e as LineEntity).a);
const near = (actual: { x: number; y: number }, expected: { x: number; y: number }) => { expect(actual.x).toBeCloseTo(expected.x, 8); expect(actual.y).toBeCloseTo(expected.y, 8); };

describe('native INSERT rectangular arrays', () => {
  it('reads native MINSERT from an independently normalized AutoCAD DWG and DXF', async () => {
    const folder = join(__dirname, 'fixtures', 'interchange');
    const payload = await readDwgPayload(readFileSync(join(folder, 'r2018-minsert.dwg')));
    const dwg = convertDwg(payload.payload).state;
    const dxf = readDxf(readFileSync(join(folder, 'r2018-minsert.dxf'), 'utf8'));
    for (const state of [dwg, dxf]) {
      const insert = state.entities.find((entity): entity is InsertEntity => entity.type === 'insert')!;
      expect(insert).toMatchObject({ columns: 3, rows: 2, columnSpacing: 7, rowSpacing: 11 });
      const lines = explodeInsert(insert, name => state.blocks[name]) as LineEntity[];
      expect(lines).toHaveLength(6);
      near(lines[1]!.a, { x: 10, y: 27 }); near(lines[3]!.a, { x: -1, y: 20 });
      const back = readDxf(writeDxf(state));
      const again = explodeInsert(back.entities[0] as InsertEntity, name => back.blocks[name]) as LineEntity[];
      expect(again).toHaveLength(6);
      lines.forEach((line, index) => { near(again[index]!.a, line.a); near(again[index]!.b, line.b); });
    }
  });
  it('reads row/column counts and drawing-unit spacing without multiplying spacing by block scale', () => {
    const state = readDxf(source());
    const insert = state.entities[0] as InsertEntity;
    expect(insert).toMatchObject({ columns: 3, rows: 2, columnSpacing: 7, rowSpacing: 11, scale: 2, scaleY: 3 });
    const parts = explodeInsert(insert, name => state.blocks[name]);
    expect(parts).toHaveLength(6);
    const expected = [{ x: 10, y: 20 }, { x: 10, y: 27 }, { x: 10, y: 34 }, { x: -1, y: 20 }, { x: -1, y: 27 }, { x: -1, y: 34 }];
    parts.forEach((part, index) => near((part as LineEntity).a, expected[index]!));
    parts.forEach(part => expect((part as LineEntity).b.y - (part as LineEntity).a.y).toBeCloseTo(2));
    const bounds = entityBounds(insert, name => state.blocks[name])!;
    near(bounds.min, { x: -1, y: 20 }); near(bounds.max, { x: 10, y: 36 });
    expect(distanceToEntity({ x: -1, y: 35 }, insert, name => state.blocks[name])).toBeLessThan(1e-8);
    expect(snapCandidates(insert, name => state.blocks[name]).filter(p => p.kind === 'insertion')).toHaveLength(6);
    const exported = writeDxf(state);
    expect(exported).toContain('AcDbMInsertBlock');
    const back = readDxf(exported);
    expect(back.entities[0]).toMatchObject({ columns: 3, rows: 2, columnSpacing: 7, rowSpacing: 11 });
    expect(expansionReport(state.blocks, state.entities).total).toBe(6);
  });

  it('keeps signed-scale arrays on their original grid through re-export', () => {
    const state = readDxf(source('3', '2', '7', '11', '-3'));
    const insert = state.entities[0] as InsertEntity;
    const parts = explodeInsert(insert, name => state.blocks[name]);
    near((parts[1] as LineEntity).a, { x: 10, y: 27 });
    near((parts[3] as LineEntity).a, { x: -1, y: 20 });
    const back = readDxf(writeDxf(state));
    const again = explodeInsert(back.entities[0] as InsertEntity, name => back.blocks[name]);
    parts.forEach((part, index) => { near((again[index] as LineEntity).a, (part as LineEntity).a); near((again[index] as LineEntity).b, (part as LineEntity).b); });
  });

  it('keeps declared grid spacing when an array is temporarily reduced to one instance', () => {
    const state = readDxf(source('1', '1'));
    const exported = writeDxf(state);
    expect(exported).toContain('AcDbBlockReference');
    const back = readDxf(exported);
    expect(back.entities[0]).toMatchObject({ columns: 1, rows: 1, columnSpacing: 7, rowSpacing: 11 });
    const expanded = { ...back.entities[0], columns: 3, rows: 2 } as InsertEntity;
    anchors(expanded).forEach((point, index) => near(point, anchors(basic())[index]!));
  });

  it('moves every grid anchor consistently during scale, rotation and mirror', () => {
    const original = basic();
    const scaled = scaleEntityBy(original, { x: 0, y: 0 }, 2) as InsertEntity;
    expect(scaled.columnSpacing).toBe(14); expect(scaled.rowSpacing).toBe(22);
    anchors(scaled).forEach((point, index) => near(point, { x: anchors(original)[index]!.x * 2, y: anchors(original)[index]!.y * 2 }));
    const rotated = rotateEntity(original, { x: 0, y: 0 }, Math.PI / 2) as InsertEntity;
    anchors(rotated).forEach((point, index) => near(point, { x: -anchors(original)[index]!.y, y: anchors(original)[index]!.x }));
    const mirrored = mirrorEntityAcross(original, { x: 0, y: 0 }, { x: 0, y: 1 }) as InsertEntity;
    anchors(mirrored).forEach((point, index) => near(point, { x: -anchors(original)[index]!.x, y: anchors(original)[index]!.y }));
  });

  it('transforms nested grid positions before applying nonuniform parent scale', () => {
    const child = { ...basic(), position: { x: 0, y: 0 }, columns: 2, rows: 2, rotation: Math.PI / 4 };
    const parentBlock: BlockDef = { name: 'P', basePoint: { x: 0, y: 0 }, entities: [child], attributes: [] };
    const parent: InsertEntity = { ...basic(), block: 'P', position: { x: 0, y: 0 }, rotation: 0, scale: 2, scaleY: 3, columns: 1, rows: 1 };
    const parts = explodeInsert(parent, name => name === 'P' ? parentBlock : lookup(name));
    expect(parts).toHaveLength(4);
    const cells = [...insertArrayInstances(child)];
    cells.forEach((cell, index) => near((parts[index] as LineEntity).a, { x: cell.position.x * 2, y: cell.position.y * 3 }));
  });

  it('accepts LibreDWG row/column data and round-trips it as native DXF arrays', () => {
    const payload = { header: {}, layers: [], entities: [{ type: 'INSERT', handle: 'A', layer: '0', name: 'B', insertionPoint: { x: 10, y: 20 }, xScale: 2, yScale: 3, rotation: Math.PI / 2, columnCount: 3, rowCount: 2, columnSpacing: 7, rowSpacing: 11 }], blocks: [{ name: 'B', basePoint: block.basePoint, entities: [{ type: 'LINE', handle: 'L', layer: '0', startPoint: { x: 2, y: 3 }, endPoint: { x: 3, y: 3 } }], description: '' }] } as unknown as DwgImportPayload;
    const { state } = convertDwg(payload);
    expect(state.entities[0]).toMatchObject({ columns: 3, rows: 2, columnSpacing: 7, rowSpacing: 11 });
    expect(explodeInsert(state.entities[0] as InsertEntity, name => state.blocks[name])).toHaveLength(6);
    expect(readDxf(writeDxf(state)).entities[0]).toMatchObject({ columns: 3, rows: 2 });
  });

  it.each(['0', '-1', '1.5', '65536'])('drops malformed row/column count %s with source evidence', value => {
    const state = readDxf(source(value));
    expect(state.entities).toHaveLength(0);
    expect(importReportOf(state)?.items.some(item => item.action === 'dropped' && /integer|numeric/.test(item.reason))).toBe(true);
  });

  it('rejects excessive multiplication before edits, geometry expansion or snapping allocate copies', () => {
    const doc = new Drawing({ blocks: { B: block } });
    const before = doc.snapshot;
    const bomb = { ...basic(), columns: 32767, rows: 32767 };
    expect(() => doc.addEntities([bomb])).toThrow(/geometry budget/);
    expect(doc.snapshot).toBe(before);
    expect(() => explodeInsert(bomb, lookup)).toThrow(/geometry budget/);
    expect(() => snapCandidates(bomb, lookup)).toThrow(/geometry budget/);
    const tooHeavy = { ...basic(), columns: 32767, rows: 2 };
    expect(() => doc.addEntities([tooHeavy])).toThrow(/geometry budget/);
    expect(doc.snapshot).toBe(before);
  });

  it('shares the expansion object budget across all instances', () => {
    expect(expandInsert(basic(), lookup, 3)).toMatchObject({ truncated: true, entities: expect.any(Array) });
    expect(expandInsert(basic(), lookup, 3).entities).toHaveLength(3);
  });

  it('counts physical component/BOM instances and discloses shared electrical attributes', () => {
    const component = { ...basic(), attributes: { TAG1: 'PB1', MFG: 'Example', CAT: 'C1' } };
    const doc = new Drawing({ blocks: { B: block }, entities: [component] });
    const rows = componentReport(doc).rows;
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map(row => row[9])).size).toBe(6);
    expect(billOfMaterial(doc).rows[0]?.[1]).toBe('6');
    expect(auditIssues(doc)).toContainEqual(expect.objectContaining({ check: 'Shared array attributes', entityId: component.id }));
  });
});
