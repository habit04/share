/**
 * Save protection for partial imports (io/import-report.ts): a drawing that opened with
 * losses (dropped/simplified objects) or was recovered from a damaged file can never be
 * saved over its source file — every save entry point refuses and points at Save As to a
 * different file. Complete imports keep the ordinary behaviour.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import { ImportReportBuilder, importReportOf, isPartialImport, partialImportSaveBlock, withImportData, MAX_REPORT_ITEMS, type ImportReport } from '../src/io/import-report';
import { partialImportNotice } from '../src/app/import-open';
import { setPathPlatform } from '../src/app/paths';

const SOURCE = '/drawings/plant.dxf';

function stateWithReport(report: ImportReport | null): DrawingState {
  return withImportData({ ...new Drawing().snapshot, entities: [] }, report);
}

function reportWith(build: (b: ImportReportBuilder) => void, sourcePath: string | null = SOURCE): ImportReport {
  const b = new ImportReportBuilder();
  build(b);
  return b.build('DXF', sourcePath);
}

const droppedReport = () => reportWith((b) => {
  b.add({ type: 'TEXT', action: 'dropped', reason: 'invalid geometry', handle: '2A4', layer: '0', where: 'model space' });
  b.add({ type: 'HATCH', action: 'simplified', reason: 'pattern approximated', layer: '0', where: 'model space' });
});

describe('isPartialImport', () => {
  it('is true when objects were dropped or simplified, or the file was recovered', () => {
    expect(isPartialImport(stateWithReport(droppedReport()))).toBe(true);
    expect(isPartialImport(stateWithReport(reportWith((b) => b.add({ type: 'X', action: 'simplified', reason: 'r' }))))).toBe(true);
    const recovered = reportWith((b) => { b.recovered = { line: 42, message: 'file ends early' }; });
    expect(isPartialImport(stateWithReport(recovered))).toBe(true);
  });

  it('is false for kept/unsupported-only reports and for drawings without a report', () => {
    expect(isPartialImport(stateWithReport(reportWith((b) => b.add({ type: '3DSOLID', action: 'kept', reason: 'kept as it was' }))))).toBe(false);
    expect(isPartialImport(stateWithReport(reportWith((b) => b.add({ type: 'XDATA', action: 'unsupported', reason: 'not read' }))))).toBe(false);
    expect(isPartialImport(stateWithReport(null))).toBe(false);
  });
});

describe('partialImportSaveBlock', () => {
  afterEach(() => setPathPlatform(null));

  it('blocks saving a partial import over its source, naming the losses and the file', () => {
    const state = stateWithReport(droppedReport());
    const message = partialImportSaveBlock(state, SOURCE);
    expect(message).not.toBeNull();
    expect(message).toContain('partial import');
    expect(message).toContain('1 object(s) dropped');
    expect(message).toContain('1 object(s) simplified');
    expect(message).toContain('plant.dxf');
    expect(message).toContain('Save As');
  });

  it('blocks recovered drawings over their source', () => {
    const state = stateWithReport(reportWith((b) => { b.recovered = { line: 7, message: 'file ends early' }; }));
    const message = partialImportSaveBlock(state, SOURCE);
    expect(message).not.toBeNull();
    expect(message).toContain('recovered from a damaged file');
  });

  it('blocks Windows spellings of the same file (case, separators, dot segments)', () => {
    setPathPlatform('win32');
    const state = stateWithReport(reportWith((b) => b.add({ type: 'TEXT', action: 'dropped', reason: 'r' }), 'C:\\A\\B.dxf'));
    expect(partialImportSaveBlock(state, 'c:/a/./b.dxf')).not.toBeNull();
    expect(partialImportSaveBlock(state, 'C:/A/B.dxf')).not.toBeNull();
    expect(partialImportSaveBlock(state, 'C:\\a\\b.dxf')).not.toBeNull();
  });

  it('allows a different destination, and any destination for a complete import', () => {
    const partial = stateWithReport(droppedReport());
    expect(partialImportSaveBlock(partial, '/drawings/plant-copy.dxf')).toBeNull();
    expect(partialImportSaveBlock(partial, null)).toBeNull();
    const complete = stateWithReport(reportWith((b) => b.add({ type: '3DSOLID', action: 'kept', reason: 'kept as it was' })));
    expect(partialImportSaveBlock(complete, SOURCE)).toBeNull();
    expect(partialImportSaveBlock(stateWithReport(null), SOURCE)).toBeNull();
  });

  it('the attached report survives on the state used for the check', () => {
    const state = stateWithReport(droppedReport());
    expect(importReportOf(state)?.sourcePath).toBe(SOURCE);
  });
});

describe('partialImportNotice', () => {
  it('counts substituted fonts even after unrelated diagnostics fill the detail list', () => {
    const report = reportWith((builder) => {
      for (let index = 0; index < MAX_REPORT_ITEMS; index++) builder.add({ type: 'UNKNOWN', action: 'kept', reason: 'retained source record' });
      builder.add({ type: 'STYLE', action: 'unsupported', reason: 'stroke substitute for missing font' });
      builder.add({ type: 'STYLE', action: 'unsupported', reason: 'Unicode fallback for missing glyphs' });
    });
    expect(report.items).toHaveLength(MAX_REPORT_ITEMS);
    expect(report.omitted).toBe(2);
    expect(partialImportNotice(report)).toBe('Drawing opened with issues: 2 font(s) substituted. View details.');
  });

  it('renders excluded, approximated and substituted-font counts', () => {
    const report = reportWith((b) => {
      b.add({ type: 'TEXT', action: 'dropped', reason: 'invalid geometry' });
      b.add({ type: 'INSERT', action: 'dropped', reason: 'excluded' });
      b.add({ type: 'HATCH', action: 'simplified', reason: 'approximated' });
      b.add({ type: 'HATCH', action: 'simplified', reason: 'approximated' });
      b.add({ type: 'LTYPE', action: 'simplified', reason: 'approximated' });
      b.add({ type: 'STYLE', action: 'unsupported', reason: 'font "romans.shx" of style "Notes" is kept for export; a stroke font substitute approximates its appearance and metrics (font files are not embedded)' });
    });
    expect(partialImportNotice(report)).toBe('Drawing opened with issues: 2 object(s) excluded; 3 object(s) approximated; 1 font(s) substituted. View details.');
  });

  it('does not count non-substitution STYLE items as substituted fonts', () => {
    const report = reportWith((b) => {
      b.add({ type: 'STYLE', action: 'unsupported', reason: 'fixed text heights of 2 text style(s) are not exposed by the DWG reader (text keeps its own height)' });
      b.add({ type: 'TEXT', action: 'dropped', reason: 'invalid geometry' });
    });
    expect(partialImportNotice(report)).toBe('Drawing opened with issues: 1 object(s) excluded. View details.');
  });

  it('mentions recovery, and returns null for a clean import', () => {
    const recovered = reportWith((b) => { b.recovered = { line: 3, message: 'file ends early' }; });
    expect(partialImportNotice(recovered)).toContain('recovered from a damaged file');
    const clean = reportWith((b) => b.add({ type: '3DSOLID', action: 'kept', reason: 'kept as it was' }));
    expect(partialImportNotice(clean)).toBeNull();
    expect(partialImportNotice(reportWith(() => {}))).toBeNull();
  });
});
