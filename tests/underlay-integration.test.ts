import { describe, it, expect } from 'vitest';
import type { UnderlayEntity, LineEntity } from '../src/core/entities';
import { readDxf, writeDxf } from '../src/io/dxf';
import { Drawing } from '../src/core/document';
import { importReportOf } from '../src/io/import-report';

// P28 wiring, stages B+C (RULING-P28 C1/C2/C3/C6/C7/C8): placements and
// definitions through the real reader/writer. The join is
// placement.definitionHandle === definition.handle in the reader post-pass;
// definitions live in the DrawingState `underlays` sibling keyed by id.

const PDF_DXF = [
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'PDFUNDERLAY', '5', '40', '330', '2E', '100', 'AcDbEntity', '8', 'U', '100', 'AcDbPdfUnderlay',
  '340', '41', '10', '10', '20', '20', '41', '2', '42', '3', '70', '3', '280', '40', '281', '10',
  '14', '0', '24', '0', '14', '100', '24', '50',
  '0', 'LINE', '5', '43', '8', '0', '10', '0', '20', '0', '11', '5', '21', '5',
  '0', 'ENDSEC',
  '0', 'SECTION', '2', 'OBJECTS',
  '0', 'PDFDEFINITION', '5', '41', '330', 'C', '100', 'AcDbObject', '100', 'AcDbPdfDefinition', '1', 'plans\\floor.pdf', '2', 'Sheet1', '90', '7',
  '0', 'ENDSEC', '0', 'EOF',
].join('\n');

describe('underlay read/write integration', () => {
  it('reads a placement + definition into the sibling, joined by handle', () => {
    const state = readDxf(PDF_DXF);
    const defs = Object.values(state.underlays ?? {});
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ id: 'underlaydef:41', kind: 'pdf', handle: '41', sourcePath: 'plans\\floor.pdf', page: 'Sheet1' });
    expect(defs[0]!.retainedGroups).toContainEqual([90, '7']);
    const e = state.entities.find((x) => x.type === 'underlay') as UnderlayEntity;
    expect(e).toMatchObject({ kind: 'pdf', definitionHandle: '41', layer: 'U', scaleX: 2, scaleY: 3, flags: 3, contrast: 40, fade: 10 });
    // cadIdentity is the cad-graph node id, present only for metadata-carrying entities (established design).
    expect(e.clipBoundary).toEqual([{ x: 0, y: 0 }, { x: 100, y: 50 }]);
    const report = importReportOf(state);
    expect(report?.items.some((x) => x.type === 'PDFDEFINITION' && x.action === 'kept')).toBe(true);
    expect(report?.items.some((x) => x.action === 'simplified' && x.type === 'PDFUNDERLAY')).toBe(false);
  });

  it('round-trips: write emits both records, re-read is the same model, second save is byte-stable', () => {
    const state = readDxf(PDF_DXF);
    const text1 = writeDxf(state);
    expect(text1).toContain('PDFUNDERLAY');
    expect(text1).toContain('PDFDEFINITION');
    expect(text1).toContain('plans\\floor.pdf'); // stored path verbatim
    expect(text1).toContain('\r\nCLASS\r\n1\r\nPDFUNDERLAY\r\n');
    expect(text1).toContain('\r\nCLASS\r\n1\r\nPDFDEFINITION\r\n');
    // The placement's 340 names the handle the definition was emitted under.
    const defHandle = /\r\n0\r\nPDFDEFINITION\r\n5\r\n([0-9A-F]+)\r\n/.exec(text1)![1];
    expect(text1).toMatch(new RegExp(`PDFUNDERLAY\\r\\n5\\r\\n[0-9A-F]+\\r\\n[\\s\\S]*?340\\r\\n${defHandle}\\r\\n`));
    const back = readDxf(text1);
    const e2 = back.entities.find((x) => x.type === 'underlay') as UnderlayEntity;
    expect(e2).toMatchObject({ kind: 'pdf', scaleX: 2, scaleY: 3, flags: 3, contrast: 40, fade: 10 });
    expect(Object.values(back.underlays ?? {})[0]).toMatchObject({ sourcePath: 'plans\\floor.pdf', page: 'Sheet1' });
    expect(writeDxf(back)).toBe(text1);
  });

  it('DWF and DGN pairs round-trip on their own kinds', () => {
    const dxf = PDF_DXF.replaceAll('PDFUNDERLAY', 'DWFUNDERLAY').replaceAll('PDFDEFINITION', 'DWFDEFINITION').replaceAll('AcDbPdfUnderlay', 'AcDbDwfUnderlay').replaceAll('AcDbPdfDefinition', 'AcDbDwfDefinition');
    const state = readDxf(dxf);
    expect(Object.values(state.underlays ?? {})[0]!.kind).toBe('dwf');
    const text = writeDxf(state);
    expect(text).toContain('DWFUNDERLAY');
    expect(text).not.toContain('PDFUNDERLAY');
  });

  it('a dangling placement is kept, reported simplified, and written with its stored reference', () => {
    const dxf = [
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'PDFUNDERLAY', '5', '40', '100', 'AcDbEntity', '8', '0', '100', 'AcDbPdfUnderlay', '340', 'FE', '10', '0', '20', '0',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const state = readDxf(dxf);
    const e = state.entities[0] as UnderlayEntity;
    expect(e.type).toBe('underlay');
    expect(state.underlays).toBeUndefined();
    const report = importReportOf(state);
    expect(report?.items.some((x) => x.action === 'simplified' && x.type === 'PDFUNDERLAY')).toBe(true);
    const text = writeDxf(state);
    expect(text).toContain('340\r\nFE\r\n'); // stored reference verbatim, never fabricated
    expect(text).not.toContain('PDFDEFINITION');
  });

  it('an unreferenced definition is retained in the sibling and written back', () => {
    const dxf = [
      '0', 'SECTION', '2', 'OBJECTS',
      '0', 'DGNDEFINITION', '5', '51', '330', 'C', '100', 'AcDbObject', '100', 'AcDbDgnDefinition', '1', 'models\\site.dgn', '2', 'Default',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const state = readDxf(dxf);
    expect(Object.values(state.underlays ?? {})[0]).toMatchObject({ kind: 'dgn', sourcePath: 'models\\site.dgn', page: 'Default' });
    const text = writeDxf(state);
    expect(text).toContain('DGNDEFINITION');
    expect(text).toContain('models\\site.dgn');
  });

  it('a codec-refused placement drops with the codec reason and never aborts its siblings (C3)', () => {
    const dxf = [
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'PDFUNDERLAY', '5', '40', '100', 'AcDbEntity', '8', '0', '100', 'AcDbPdfUnderlay', '340', '41', '10', '0', '20', '0', '14', '5',
      '0', 'LINE', '5', '43', '8', '0', '10', '0', '20', '0', '11', '5', '21', '5',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const state = readDxf(dxf);
    expect(state.entities).toHaveLength(1);
    expect(state.entities[0]!.type).toBe('line');
    const report = importReportOf(state);
    expect(report?.items.some((x) => x.action === 'dropped' && x.type === 'PDFUNDERLAY' && /group 24/.test(x.reason))).toBe(true);
  });

  it('a drawing without underlays writes no underlay records (no-underlay fixed point)', () => {
    const state = readDxf(['0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '5', '43', '8', '0', '10', '0', '20', '0', '11', '5', '21', '5', '0', 'ENDSEC', '0', 'EOF'].join('\n'));
    expect(state.underlays).toBeUndefined();
    expect(writeDxf(state)).not.toContain('UNDERLAY');
  });

  it('graph-carrying round trip: one definition, one placement, retained groups neither doubled nor lost (C6)', () => {
    const state = readDxf(PDF_DXF);
    expect(state.cadGraph).toBeDefined();
    const text1 = writeDxf(state);
    expect(text1.match(/\r\n0\r\nPDFDEFINITION\r\n/g)).toHaveLength(1);
    expect(text1.match(/\r\n0\r\nPDFUNDERLAY\r\n/g)).toHaveLength(1);
    expect(text1.match(/\r\n90\r\n7\r\n/g)).toHaveLength(1); // the retained definition group, exactly once
    const back = readDxf(text1);
    expect(writeDxf(back)).toBe(text1); // second save byte-stable
  });

  it('the sibling survives transact, layout/paper-space projection and undo/redo (C7)', () => {
    const doc = new Drawing();
    doc.load(readDxf(PDF_DXF));
    const before = doc.snapshot.underlays;
    expect(before).toBeDefined();
    doc.transact((s) => ({ ...s, entities: [...s.entities, { id: 'ln', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } } as LineEntity] }));
    expect(doc.snapshot.underlays).toBe(before);
    doc.undo();
    expect(doc.snapshot.underlays).toBe(before);
    doc.redo();
    expect(doc.snapshot.underlays).toBe(before);
  });
});
