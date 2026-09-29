/**
 * Project-wide command glue (commands-electrical.ts) over a fake editor:
 * sheets come from the active drawing, another open tab and a closed file
 * read through the bridge; changes go back into the tabs and, after the
 * confirmation, into the closed file (with a .bak when the bridge can).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import type { Entity, InsertEntity, LineEntity } from '../src/core/entities';
import { newId } from '../src/core/entities';
import { ALL_SYMBOLS } from '../src/electrical/symbols';
import { DEFAULT_WD_SETTINGS, writeWdSettings } from '../src/electrical/wdm';
import { writeDxf, readDxf } from '../src/io/dxf';
import { SessionManager } from '../src/app/sessions';
import type { Editor } from '../src/app/editor';
import type { Project } from '../src/app/project';
import { loadProjectSheets, commitSheets, runProjectXref, runProjectRetag, runProjectWireNumbers, runTitleBlocksAll, projectUi, plcDeviceBlock, buildPlcModules } from '../src/app/commands-electrical';
import { newFromTemplate, SHEET_SIZES, TITLE_BLOCK } from '../src/electrical/templates';
import { modulesFromRows, parsePlcIo } from '../src/electrical/plc-import';

const ins = (block: string, x: number, y: number, attrs: Record<string, string>): InsertEntity => ({ id: newId(), layer: 'SYMS', color: 'ByLayer', type: 'insert', block, position: { x, y }, rotation: 0, scale: 1, attributes: attrs });
const ref = (y: number, t: string): Entity => ({ id: newId(), layer: 'MISC', color: 'ByLayer', type: 'text', position: { x: 0.75, y: y - 0.06 }, text: t, height: 0.125, rotation: 0, align: 'right' });
const wire = (x1: number, y: number, x2: number): LineEntity => ({ id: newId(), layer: 'WIRES', color: 'ByLayer', type: 'line', a: { x: x1, y }, b: { x: x2, y } });

function state(sheet: string, first: number, comps: InsertEntity[], withTitle = false): DrawingState {
  const d = new Drawing();
  if (withTitle) d.load(newFromTemplate(SHEET_SIZES[0]!, {}));
  d.ensureBlocks(ALL_SYMBOLS);
  writeWdSettings(d, { ...DEFAULT_WD_SETTINGS, sheet, xrefFormat: '%S.%N' });
  d.addEntities([ref(8, String(first)), ref(7, String(first + 1)), wire(1, 8, 2.6), wire(3.4, 8, 10), wire(1, 7, 2.6), wire(3.4, 7, 10), ...comps]);
  return d.snapshot;
}

interface Fake {
  editor: Editor;
  saved: Map<string, string>;
  backups: string[];
  logs: string[];
}

function fakeEditor(): Fake {
  const doc = new Drawing();
  doc.load(state('1', 100, [ins('HCR1', 8, 8, { TAG1: 'CR100' }), ins('HCR1_NO', 3, 7, { TAG1: 'CR100' })], true), '/p/a.dxf');
  const host = { doc, viewport: { center: { x: 0, y: 0 }, scale: 1 }, selection: new Set<string>(), loadState: (s: DrawingState, p: string | null) => doc.load(s, p) };
  const sessions = new SessionManager(host);
  sessions.add(state('2', 200, [ins('HCR1_NO', 3, 8, { TAG1: 'CR100' }), ins('HPB11_NO', 6, 7, { TAG1: 'PB100' })]), '/p/b.dxf');
  sessions.switchTo(0);
  const closed = state('3', 300, [ins('HCR1_NC', 3, 8, { TAG1: 'CR100' }), ins('HPB11_NO', 6, 7, { TAG1: 'PB100' }), ins('HCR1_NO', 3, 7, { TAG1: 'CR999' })], true);
  const saved = new Map<string, string>();
  const backups: string[] = [];
  const logs: string[] = [];
  const project: Project = { name: 'P', path: '/p/p.jcadproj.json', descriptions: ['ACME'], drawings: [{ file: 'a.dxf', sheet: '1', rev: 'B' }, { file: 'b.dxf', sheet: '2' }, { file: 'c.dxf', sheet: '3', description: 'CONTROL' }] };
  const editor = {
    doc,
    sessions,
    project,
    hooks: {},
    fileBridge: {
      openDxf: async () => null,
      openDrawing: async (path: string) => (path === '/p/c.dxf' ? { path, kind: 'dxf' as const, text: saved.get(path) ?? writeDxf(closed) } : null),
      saveDxf: async (path: string | null, text: string) => {
        if (path) saved.set(path, text);
        return path;
      },
      backupFile: async (path: string) => {
        backups.push(path);
        return `${path}.bak`;
      },
    },
    fileName: () => 'a.dxf',
    log: (t: string) => logs.push(t),
    notify: () => {},
  } as unknown as Editor;
  return { editor, saved, backups, logs };
}

const g = globalThis as { window?: unknown };
let confirms: Array<{ title: string; items: Array<{ name: string; kind: string }> }> = [];
const origConfirm = projectUi.confirmFiles;
const origProblems = projectUi.showProblems;

beforeEach(() => {
  g.window = { jcad: {} };
  confirms = [];
  projectUi.confirmFiles = async (title, _intro, items, opts) => {
    confirms.push({ title, items });
    return { files: true, backup: opts.backupAvailable };
  };
  projectUi.showProblems = () => {};
});
afterEach(() => {
  delete g.window;
  projectUi.confirmFiles = origConfirm;
  projectUi.showProblems = origProblems;
});

describe('project-wide command glue', () => {
  it('loads the active drawing, open tabs and closed files as sheets', async () => {
    const { editor } = fakeEditor();
    const { sheets, skipped } = await loadProjectSheets(editor);
    expect(sheets.map((s) => `${s.name}:${s.source}:${s.sheet}`)).toEqual(['a.dxf:active:1', 'b.dxf:session:2', 'c.dxf:file:3']);
    expect(skipped).toEqual([]);
    delete g.window;
    const again = await loadProjectSheets(editor);
    expect(again.sheets).toHaveLength(2);
    expect(again.skipped).toEqual(['c.dxf (not open)']);
  });
  it('AEXREF project-wide updates open tabs in memory and saves the closed drawing after confirmation', async () => {
    const { editor, saved, backups } = fakeEditor();
    await runProjectXref(editor);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.items.map((i) => `${i.name}:${i.kind}`)).toEqual(['a.dxf:open', 'b.dxf:open', 'c.dxf:file']);
    // active drawing: the coil lists contacts on sheets 1, 2 and 3 (one undo step)
    const coil = editor.doc.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === 'HCR1')!;
    expect(coil.attributes.XREFNO).toBe('1.101,2.200');
    expect(coil.attributes.XREFNC).toBe('3.300');
    expect(editor.doc.canUndo()).toBe(true);
    // other tab: state replaced, dirty, undoable
    const b = editor.sessions.all[1]!;
    expect(b.dirty).toBe(true);
    expect(b.undo).toHaveLength(1);
    expect(b.state.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === 'HCR1_NO')!.attributes.XREF).toBe('1.100');
    // closed file: written as DXF after a .bak
    expect(backups).toEqual(['/p/c.dxf']);
    const c = readDxf(saved.get('/p/c.dxf')!);
    expect(c.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === 'HCR1_NC')!.attributes.XREF).toBe('1.100');
    // running again changes nothing: no confirmation needed
    confirms = [];
    await runProjectXref(editor);
    expect(confirms).toHaveLength(0);
  });
  it('a cancelled confirmation changes nothing', async () => {
    const { editor, saved, logs } = fakeEditor();
    projectUi.confirmFiles = async () => null;
    const before = editor.doc.snapshot;
    await runProjectRetag(editor, 'all');
    expect(editor.doc.snapshot).toBe(before);
    expect(saved.size).toBe(0);
    expect(logs.join('\n')).toMatch(/cancelled/);
  });
  it('AERETAG project-wide resolves duplicates across drawings and follows with cross-references', async () => {
    const { editor, saved } = fakeEditor();
    await runProjectRetag(editor, 'duplicates');
    const b = editor.sessions.all[1]!.state;
    const c = readDxf(saved.get('/p/c.dxf')!);
    const pb = (s: DrawingState) => s.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === 'HPB11_NO')!.attributes.TAG1;
    expect(pb(b)).toBe('PB100');
    expect(pb(c)).toBe('PB301'); // duplicate PB100 on sheet 3 gets its own rung-based tag
  });
  it('AEWIRENO project-wide keeps numbers unique with sheet-based starts', async () => {
    const { editor, saved } = fakeEditor();
    await runProjectWireNumbers(editor, true);
    const labels = (s: DrawingState) => s.entities.filter((e) => e.type === 'text' && e.layer === 'WIRENO').map((e) => (e.type === 'text' ? e.text : ''));
    const all = [...labels(editor.doc.snapshot), ...labels(editor.sessions.all[1]!.state), ...labels(readDxf(saved.get('/p/c.dxf')!))];
    expect(all.length).toBeGreaterThan(3);
    expect(new Set(all).size).toBe(all.length);
  });
  it('updates the title blocks of all drawings through the project mapping', async () => {
    const { editor, saved } = fakeEditor();
    editor.project = { ...editor.project, titleBlockMap: 'PROJECT = LINE1\nTITLE = DWGDESC\nREV = REV\nSHEET = %SHEET%/%SHEETMAX%' };
    await runTitleBlocksAll(editor);
    const tb = (s: DrawingState) => s.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === TITLE_BLOCK.name)!.attributes;
    expect(tb(editor.doc.snapshot)).toMatchObject({ PROJECT: 'ACME', REV: 'B', SHEET: '1/3' });
    expect(tb(readDxf(saved.get('/p/c.dxf')!))).toMatchObject({ TITLE: 'CONTROL', SHEET: '3/3' });
  });
  it('commitSheets without closed files needs no confirmation unless asked', async () => {
    const { editor } = fakeEditor();
    const { sheets } = await loadProjectSheets(editor, { files: false });
    const next = { ...sheets[0]!.doc.snapshot, entities: [] };
    const r = await commitSheets(editor, sheets, new Map([[0, { state: next, detail: 'x' }]]), 'T', 'I');
    expect(r).toEqual({ open: 1, written: 0, failed: [] });
    expect(confirms).toHaveLength(0);
    expect(editor.doc.entities).toHaveLength(0);
  });
  it('picks PLC rung devices by tag family and lays modules out side by side', () => {
    expect(plcDeviceBlock('LS12', 'input')).toBe('HLS11_NO');
    expect(plcDeviceBlock('XYZ1', 'input')).toBe('HPB11_NO');
    expect(plcDeviceBlock('SOL4', 'output')).toBe('HSOL1');
    expect(plcDeviceBlock('Q9', 'output')).toBe('HCR1');
    const mods = modulesFromRows(parsePlcIo('Address,Device\nI:0/0,PB1\nO:0/0,M1\n').rows);
    const ents = buildPlcModules({ x: 0, y: 0 }, mods);
    const boxes = ents.filter((e) => e.type === 'polyline');
    expect(boxes).toHaveLength(2);
    const x0 = (e: Entity) => (e.type === 'polyline' ? Math.min(...e.points.map((p) => p.x)) : 0);
    expect(x0(boxes[1]!)).toBeGreaterThan(x0(boxes[0]!) + 1.5);
  });
});
