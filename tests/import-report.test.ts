/**
 * Import report and retained raw records (unsupported DXF content): what is dropped / simplified /
 * kept is listed with type, handle, layer and reason; safe unknown model-space records are written
 * back verbatim at the end of ENTITIES, also through the project-wide rewrite path, and survive the
 * document round trip and undo; Save over an affected source file warns.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDxf, writeDxf } from '../src/io/dxf';
import {
  importReportOf,
  rawEntitiesOf,
  lossCount,
  countOf,
  formatImportReport,
  saveOverwriteWarning,
  withImportData,
  withDwgRecoveryWarning,
  ImportReportBuilder,
  MAX_REPORT_ITEMS,
  type ImportReportItem,
} from '../src/io/import-report';
import { readDxfForOpen, confirmSaveOver, reportNeedsAttention, importReportLog } from '../src/app/import-open';
import { Drawing, type DrawingState } from '../src/core/document';
import type { Entity, InsertEntity } from '../src/core/entities';
import { newId } from '../src/core/entities';
import { withoutUnusedLibraryBlocks } from '../src/electrical/library';
import { SessionManager } from '../src/app/sessions';
import type { Editor } from '../src/app/editor';
import type { Project } from '../src/app/project';
import { runTitleBlocksAll, projectUi } from '../src/app/commands-electrical';
import { newFromTemplate, SHEET_SIZES, TITLE_BLOCK } from '../src/electrical/templates';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'latin1');
const SOURCE = '/drawings/plant.dxf';
const state = readDxf(fixture('unsupported-content.dxf'), { filePath: SOURCE });
const report = importReportOf(state)!;
const item = (type: string, handle: string): ImportReportItem | undefined => report.items.find((i) => i.type === type && i.handle === handle);

/** Pairs of the ENTITIES section of a DXF text. */
function entitiesSection(text: string): Array<[number, string]> {
  const lines = text.split(/\r\n|\n/);
  const pairs: Array<[number, string]> = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i]!.trim(), 10), lines[i + 1]!]);
  const start = pairs.findIndex(([c, v], k) => c === 0 && v === 'SECTION' && pairs[k + 1]?.[1] === 'ENTITIES');
  const end = pairs.findIndex(([c, v], k) => k > start && c === 0 && v === 'ENDSEC');
  return pairs.slice(start + 2, end);
}
/** Entity types in the ENTITIES section, in order. */
const entityKinds = (text: string) => entitiesSection(text).filter(([c]) => c === 0).map(([, v]) => v);

describe('import report of unsupported DXF content', () => {
  it('warns about unreadable DWG metadata even when no drawing objects were dropped', () => {
    const b = new ImportReportBuilder();
    b.add({ type: 'XDATA', action: 'unsupported', reason: 'Not exposed by the DWG reader' });
    const imported = withImportData(new Drawing().snapshot, b.build('DWG', '/d/source.dwg'));
    expect(lossCount(importReportOf(imported)!)).toBe(0);
    expect(saveOverwriteWarning(imported, '/d/source.dwg')).toMatch(/properties JCad cannot read.*Save As/);
    expect(saveOverwriteWarning(imported, '/d/copy.dwg')).toBeNull();
  });

  it('restores source-loss caution after DWG recovery from a DXF autosave', () => {
    const original = new Drawing();
    original.addEntities([{ id: 'recovered-line', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 2, y: 3 } }]);
    const snapshot = readDxf(writeDxf(original.snapshot), { filePath: '/d/original.dwg' });
    expect(importReportOf(snapshot)).toBeUndefined();
    const recovered = withDwgRecoveryWarning(snapshot, '/d/original.dwg');
    expect(recovered.entities).toBe(snapshot.entities);
    expect(importReportOf(snapshot)).toBeUndefined();
    expect(importReportOf(recovered)).toMatchObject({ format: 'DWG', sourcePath: '/d/original.dwg' });
    expect(saveOverwriteWarning(recovered, '/d/original.dwg')).toMatch(/properties JCad cannot read/);
    expect(saveOverwriteWarning(recovered, '/d/copy.dwg')).toBeNull();
    expect(withDwgRecoveryWarning(snapshot, '/d/source.dxf')).toBe(snapshot);
  });

  it('records type, handle, layer, place and reason of every dropped, simplified or kept object', () => {
    expect(report.format).toBe('DXF');
    expect(report.sourcePath).toBe(SOURCE);
    expect(item('WIPEOUT', '104')).toMatchObject({ action: 'dropped', layer: '0', where: 'model space', reason: expect.stringMatching(/wipeout/i) });
    expect(item('MLINE', '105')).toMatchObject({ action: 'dropped', reason: expect.stringMatching(/multiline/i) });
    expect(item('POLYLINE', '107')).toMatchObject({ action: 'dropped', reason: expect.stringMatching(/polyface/) });
    expect(item('INSERT', '106')).toBeUndefined();
    expect(state.entities.find((e) => e.type === 'insert' && e.columns === 3 && e.rows === 2)).toBeDefined();
    expect(item('LINE', '100')).toMatchObject({ action: 'kept', layer: 'WIRES', reason: expect.stringMatching(/VIA_WD_WIRE/) });
    expect(item('TEXT', '10E')).toMatchObject({ action: 'simplified', reason: expect.stringMatching(/extrusion/) });
    expect(item('REGION', '103')).toMatchObject({ action: 'dropped', reason: expect.stringMatching(/stored outside the object/) });
    expect(item('3DFACE', '60')).toMatchObject({ action: 'dropped', where: 'block "HAS3D"' });
    expect(item('3DFACE', '10F')).toMatchObject({ action: 'dropped', where: 'layout "Layout1"' });
    expect(item('GROUP', '2B0')).toMatchObject({ action: 'kept', reason: expect.stringMatching(/Motor feed/) });
    expect(item('3DFACE', '101')).toMatchObject({ action: 'kept', layer: 'SOLIDS' });
    expect(item('3DSOLID', '102')).toMatchObject({ action: 'kept', layer: 'SOLIDS' });
    expect(item('WIPEOUT', '104')!.line).toBeGreaterThan(1);
    expect(report.counts['3DFACE']).toEqual({ dropped: 2, kept: 1 });
    expect(lossCount(report)).toBe(7);
    expect(countOf(report, 'kept')).toBe(4);
  });

  it('the copied report lists counts and every item', () => {
    const text = formatImportReport(report, 'plant.dxf');
    expect(text).toMatch(/DXF import report: plant\.dxf/);
    expect(text).toMatch(/7 object\(s\) dropped or simplified, 4 kept/);
    expect(text).toMatch(/3DFACE: 2 dropped, 1 kept/);
    expect(text).toMatch(/WIPEOUT dropped \(handle 104, layer "0", model space, line \d+\)/);
  });

  it('caps the item list but keeps exact counts', () => {
    const b = new ImportReportBuilder();
    for (let i = 0; i < MAX_REPORT_ITEMS + 5; i += 1) b.add({ type: 'MLINE', action: 'dropped', reason: 'x' });
    const r = b.build('DXF');
    expect(r.items).toHaveLength(MAX_REPORT_ITEMS);
    expect(r.omitted).toBe(5);
    expect(r.counts.MLINE!.dropped).toBe(MAX_REPORT_ITEMS + 5);
  });

  it('a clean file has no report, a file with only kept content is not flagged for attention', () => {
    expect(importReportOf(readDxf(writeDxf(new Drawing().snapshot)))).toBeUndefined();
    expect(importReportOf(readDxf(fixture('all-entities.dxf')))?.items).toEqual([expect.objectContaining({ type: 'ACAD_TABLE', action: 'simplified' })]);
    const keptOnly = readDxf(writeDxf(state));
    const r = importReportOf(keptOnly)!;
    expect(lossCount(r)).toBe(0);
    expect(countOf(r, 'kept')).toBe(4);
    expect(reportNeedsAttention(r)).toBe(false);
    expect(reportNeedsAttention(report)).toBe(true);
    expect(importReportLog(report).join('\n')).toMatch(/7 object\(s\) dropped or simplified, 4 kept/);
  });
  it('reports malformed table cell metadata without throwing during format validation', () => {
    const metadata = JSON.stringify({ position: { x: 0, y: 0 }, rowHeights: [1], columnWidths: [1], cells: [[null]], textHeight: 1 });
    const source = ['0', 'SECTION', '2', 'ENTITIES', '0', 'INSERT', '5', 'BAD', '8', 'TABLES', '1001', 'JCAD_TABLE', '1000', metadata, '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const result = readDxf(source);
    expect(result.entities).toEqual([]);
    expect(importReportOf(result)?.items).toContainEqual(expect.objectContaining({ type: 'INSERT', handle: 'BAD', layer: 'TABLES', action: 'dropped', reason: expect.stringContaining('table cells must contain text') }));
  });
});

describe('retained raw records', () => {
  it('keeps safe unknown model-space records without handles, owners, reactors or extended data', () => {
    const raw = rawEntitiesOf(state);
    expect(raw.map((r) => `${r.type}@${r.layer}`)).toEqual(['3DFACE@SOLIDS', '3DSOLID@SOLIDS']);
    const face = raw[0]!;
    expect(face.handle).toBe('101');
    const codes = face.groups.map(([c]) => c);
    for (const c of [5, 330, 102, 1001, 1000]) expect(codes).not.toContain(c);
    expect(face.groups).toContainEqual([6, 'HIDDEN2']);
    expect(face.groups).toContainEqual([32, '5.0']);
    expect(raw[1]!.groups.map(([c]) => c)).not.toContain(350); // history pointer to an object that is not kept
    expect(raw[1]!.groups).toContainEqual([1, 'mnnmi mi ofoo jl ofoo jl']);
  });

  it('writes retained geometry with stable identities and remapped model-space owners', () => {
    const out = writeDxf(state);
    const kinds = entityKinds(out);
    expect(kinds.filter(kind => ['3DFACE', '3DSOLID'].includes(kind)).sort()).toEqual(['3DFACE', '3DSOLID']);
    const sec = entitiesSection(out);
    const at = sec.findIndex(([c, v]) => c === 0 && v === '3DFACE');
    const face = sec.slice(at + 1, sec.findIndex(([c], k) => k > at && c === 0));
    expect(face[0]![0]).toBe(5);
    expect(face[0]![1]).toBe('101');
    const modelHandle = readDxf(out).cadGraph!.nodes.find(node => node.type === 'BLOCK_RECORD' && node.groups.some(([code, value]) => code === 2 && value === '*Model_Space'))?.sourceHandle;
    expect(modelHandle).toBeDefined();
    expect(face[1]).toEqual([330, modelHandle]);
    const geometryStart = face.findIndex(([code, value]) => code === 100 && value === 'AcDbEntity');
    const applicationStart = face.findIndex(([code]) => code === 1001);
    expect(face.slice(geometryStart, applicationStart)).toEqual(rawEntitiesOf(state)[0]!.groups);
    expect(face).toContainEqual([102, '{ACAD_REACTORS']);
    expect(face).toContainEqual([1001, 'SOMEAPP']);
    expect(face).toContainEqual([1000, 'lost']);
    // The linetype it names exists in the LTYPE table and its layer in the LAYER table.
    expect(out).toMatch(/\r\nLTYPE\r\n5\r\n[0-9A-F]+\r\n330\r\n[0-9A-F]+\r\n100\r\nAcDbSymbolTableRecord\r\n100\r\nAcDbLinetypeTableRecord\r\n2\r\nHIDDEN2\r\n/);
    expect(out).toMatch(/AcDbLayerTableRecord\r\n2\r\nSOLIDS\r\n/);
  });

  it('survive the document round trip (read, write, read, write gives the same records)', () => {
    const once = readDxf(writeDxf(state));
    expect(rawEntitiesOf(once)).toEqual(rawEntitiesOf(state).map((r) => ({ ...r, handle: expect.any(String) })));
    const twice = readDxf(writeDxf(once));
    expect(rawEntitiesOf(twice).map((r) => r.groups)).toEqual(rawEntitiesOf(state).map((r) => r.groups));
  });

  it('survive undo and redo of edits, and a deleted layer is written back for them', () => {
    const d = new Drawing(state);
    d.addEntities([{ id: 'n', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }]);
    d.removeEntities(d.entities.map((e) => e.id));
    d.removeLayers(['SOLIDS']);
    expect(rawEntitiesOf(d.snapshot)).toHaveLength(2);
    d.undo();
    d.undo();
    expect(rawEntitiesOf(d.snapshot)).toHaveLength(2);
    d.redo();
    d.redo();
    expect(d.layer('SOLIDS')).toBeUndefined();
    const out = writeDxf(d.snapshot);
    expect(entityKinds(out)).toEqual(expect.arrayContaining(['3DFACE', '3DSOLID']));
    expect(readDxf(out).layers.some((l) => l.name === 'SOLIDS')).toBe(true);
  });

  it('withImportData replaces the report and records without touching other meta', () => {
    const s = withImportData({ ...state, meta: { ...state.meta, other: 1 } }, null, []);
    expect(s.meta).toEqual({ other: 1 });
    expect(withImportData({ entities: [], layers: [], blocks: {}, currentLayer: '0' }, null)).not.toHaveProperty('meta');
  });
});

describe('project-wide rewrite keeps the retained records', () => {
  const g = globalThis as { window?: unknown };
  const orig = projectUi.confirmFiles;
  beforeEach(() => {
    g.window = { jcad: {} };
    projectUi.confirmFiles = async (_t, _i, _items, opts) => ({ files: true, backup: opts.backupAvailable });
  });
  afterEach(() => {
    delete g.window;
    projectUi.confirmFiles = orig;
  });

  it('a closed drawing rewritten by a project command still has its unknown records', async () => {
    const active = new Drawing();
    active.load(newFromTemplate(SHEET_SIZES[0]!, {}), '/p/a.dxf');
    // The closed sheet: a title block drawing that also holds the unsupported content.
    const closedState: DrawingState = { ...newFromTemplate(SHEET_SIZES[0]!, {}), meta: { dxfRawEntities: rawEntitiesOf(state) } };
    const saved = new Map<string, string>();
    saved.set('/p/c.dxf', writeDxf(closedState));
    const host = { doc: active, viewport: { center: { x: 0, y: 0 }, scale: 1 }, selection: new Set<string>(), loadState: (s: DrawingState, p: string | null) => active.load(s, p) };
    const project: Project = { name: 'P', path: '/p/p.jcadproj.json', descriptions: ['ACME'], drawings: [{ file: 'a.dxf', sheet: '1' }, { file: 'c.dxf', sheet: '3', description: 'CONTROL' }], titleBlockMap: 'TITLE = DWGDESC' };
    const editor = {
      doc: active,
      sessions: new SessionManager(host),
      project,
      hooks: {},
      fileBridge: {
        openDxf: async () => null,
        openDrawing: async (path: string) => (saved.has(path) ? { path, kind: 'dxf' as const, text: saved.get(path)! } : null),
        saveDxf: async (path: string | null, text: string) => {
          if (path) saved.set(path, text);
          return path;
        },
      },
      fileName: () => 'a.dxf',
      log: () => {},
      notify: () => {},
    } as unknown as Editor;
    const before = saved.get('/p/c.dxf');
    await runTitleBlocksAll(editor);
    const after = saved.get('/p/c.dxf')!;
    expect(after).not.toBe(before);
    const back = readDxf(after);
    const tb = back.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === TITLE_BLOCK.name)!;
    expect(tb.attributes.TITLE).toBe('CONTROL');
    expect(entityKinds(after).slice(-2)).toEqual(['3DFACE', '3DSOLID']);
    expect(rawEntitiesOf(back).map((r) => r.groups)).toEqual(rawEntitiesOf(state).map((r) => r.groups));
  });

  it('withoutUnusedLibraryBlocks (the save path) keeps them', () => {
    const extra: Entity = { id: newId(), layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } };
    const s = withoutUnusedLibraryBlocks({ ...state, entities: [...state.entities, extra] });
    expect(rawEntitiesOf(s)).toHaveLength(2);
  });
});

describe('Save over the source file', () => {
  it('warns while the drawing came from that file and content was lost', () => {
    const w = saveOverwriteWarning(state, SOURCE);
    expect(w).toMatch(/plant\.dxf contained 7 object\(s\) JCad cannot keep/);
    expect(w).toMatch(/Save As/);
    expect(saveOverwriteWarning(state, '/drawings/copy.dxf')).toBeNull();
    expect(saveOverwriteWarning(state, null)).toBeNull();
    expect(saveOverwriteWarning(state, SOURCE.replace('plant.dxf', './folder/../plant.dxf'))).not.toBeNull();
    expect(saveOverwriteWarning(readDxf(writeDxf(state)), SOURCE)).toBeNull(); // nothing lost (kept records only)
  });

  it('asks once: No switches to Save As, Yes saves and is remembered for that file', async () => {
    const asked: string[] = [];
    expect(await confirmSaveOver(state, SOURCE, async (t) => (asked.push(t), false))).toBe('save-as');
    expect(await confirmSaveOver(state, SOURCE, async (t) => (asked.push(t), true))).toBe('save');
    expect(await confirmSaveOver(state, SOURCE, async (t) => (asked.push(t), false))).toBe('save');
    expect(asked).toHaveLength(2);
    expect(await confirmSaveOver(readDxf(writeDxf(state)), '/other.dxf', async () => false)).toBe('save');
  });

  it('readDxfForOpen opens intact files without asking', async () => {
    let asked = 0;
    const s = await readDxfForOpen(fixture('unsupported-content.dxf'), SOURCE, async () => (asked++, true));
    expect(asked).toBe(0);
    expect(importReportOf(s!)?.sourcePath).toBe(SOURCE);
  });
});
