/**
 * Project-wide commands (commands-electrical.ts commitSheets / loadProjectSheets) must not
 * destroy work: a requested backup that fails stops that drawing, changes are applied only to
 * the revision they were calculated from, drawings are identified by full path (Windows paths,
 * equal names in different folders), and an older write never replaces a newer one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import type { Entity, InsertEntity } from '../src/core/entities';
import { newId } from '../src/core/entities';
import { ALL_SYMBOLS } from '../src/electrical/symbols';
import { DEFAULT_WD_SETTINGS, writeWdSettings } from '../src/electrical/wdm';
import { writeDxf, readDxf } from '../src/io/dxf';
import { SessionManager } from '../src/app/sessions';
import { backupOutcome, type Editor, type BackupResult, type LegacyBackupResult } from '../src/app/editor';
import type { Project } from '../src/app/project';
import { loadProjectSheets, commitSheets, runProjectXref, runTitleBlocksAll, projectUi } from '../src/app/commands-electrical';
import { captureRevision, saveQueue } from '../src/app/savequeue';
import { newFromTemplate, SHEET_SIZES } from '../src/electrical/templates';

const ins = (block: string, x: number, y: number, attrs: Record<string, string>): InsertEntity => ({ id: newId(), layer: 'SYMS', color: 'ByLayer', type: 'insert', block, position: { x, y }, rotation: 0, scale: 1, attributes: attrs });
const ref = (y: number, t: string): Entity => ({ id: newId(), layer: 'MISC', color: 'ByLayer', type: 'text', position: { x: 0.75, y: y - 0.06 }, text: t, height: 0.125, rotation: 0, align: 'right' });
const note = (t: string): Entity => ({ id: newId(), layer: '0', color: 'ByLayer', type: 'text', position: { x: 20, y: 20 }, text: t, height: 0.2, rotation: 0, align: 'left' });

function sheetState(sheet: string, first: number, comps: InsertEntity[]): DrawingState {
  const d = new Drawing();
  d.load(newFromTemplate(SHEET_SIZES[0]!, {}));
  d.ensureBlocks(ALL_SYMBOLS);
  writeWdSettings(d, { ...DEFAULT_WD_SETTINGS, sheet, xrefFormat: '%S.%N' });
  d.addEntities([ref(8, String(first)), ref(7, String(first + 1)), ...comps]);
  return d.snapshot;
}

interface Opts {
  projectPath: string;
  drawings: string[];
  activePath: string;
  tabPath?: string;
  /** Closed files on "disk" by resolved path. */
  files: Record<string, DrawingState>;
  backup?: (path: string) => Promise<BackupResult | LegacyBackupResult>;
}

function fake(o: Opts) {
  const doc = new Drawing();
  doc.load(sheetState('1', 100, [ins('HCR1', 8, 8, { TAG1: 'CR100' })]), o.activePath);
  const host = { doc, viewport: { center: { x: 0, y: 0 }, scale: 1 }, selection: new Set<string>(), loadState: (s: DrawingState, p: string | null) => doc.load(s, p) };
  const sessions = new SessionManager(host);
  if (o.tabPath) {
    sessions.add(sheetState('2', 200, [ins('HCR1_NO', 3, 8, { TAG1: 'CR100' })]), o.tabPath);
    sessions.switchTo(0);
  }
  const disk = new Map<string, string>(Object.entries(o.files).map(([k, v]) => [k, writeDxf(v)]));
  const writes: string[] = [];
  const backups: string[] = [];
  const reads: string[] = [];
  const logs: string[] = [];
  const project: Project = { name: 'P', path: o.projectPath, drawings: o.drawings.map((file, i) => ({ file, sheet: String(i + 1) })) };
  const editor = {
    doc,
    sessions,
    project,
    hooks: {},
    fileBridge: {
      openDxf: async () => null,
      openDrawing: async (path: string) => {
        reads.push(path);
        const text = disk.get(path);
        if (text === undefined) throw new Error(`ENOENT ${path}`);
        return { path, kind: 'dxf' as const, text };
      },
      saveDxf: async (path: string | null, text: string) => {
        if (!path) return null;
        writes.push(path);
        disk.set(path, text);
        return path;
      },
      backupFile: async (path: string) => {
        backups.push(path);
        return o.backup ? o.backup(path) : { ok: true, path: `${path}.bak` };
      },
    },
    fileName: () => o.activePath.split(/[\\/]/).pop(),
    log: (t: string) => logs.push(t),
    notify: () => {},
  } as unknown as Editor;
  return { editor, disk, writes, backups, reads, logs };
}

const g = globalThis as { window?: unknown };
let noBackupAsked: Array<{ name: string; path: string; error: string }> = [];
let continueWithoutBackup = false;
let onConfirm: (() => void) | null = null;
const orig = { ...projectUi };

beforeEach(() => {
  g.window = { jcad: {} };
  noBackupAsked = [];
  continueWithoutBackup = false;
  onConfirm = null;
  projectUi.confirmFiles = async (_t, _i, _items, opts) => {
    onConfirm?.();
    return { files: true, backup: opts.backupAvailable };
  };
  projectUi.confirmNoBackup = async (name, path, error) => {
    noBackupAsked.push({ name, path, error });
    return continueWithoutBackup;
  };
  projectUi.showProblems = () => {};
});
afterEach(() => {
  delete g.window;
  Object.assign(projectUi, orig);
});

const closed = () => sheetState('3', 300, [ins('HCR1_NC', 3, 8, { TAG1: 'CR100' })]);
const base = { projectPath: '/p/p.jcadproj.json', drawings: ['a.dxf', 'b.dxf', 'c.dxf'], activePath: '/p/a.dxf', tabPath: '/p/b.dxf' };

describe('failed backups stop the write', () => {
  it('reads every backup answer shape', () => {
    expect(backupOutcome({ ok: true, path: '/p/c.dxf.bak' })).toEqual({ ok: true });
    expect(backupOutcome({ ok: false, code: 'EACCES', error: 'EACCES' })).toEqual({ ok: false, error: 'EACCES' });
    expect(backupOutcome('/p/c.dxf.bak').ok).toBe(true);
    expect(backupOutcome(null).ok).toBe(false);
    expect(backupOutcome(undefined).ok).toBe(false);
    expect(backupOutcome(false).ok).toBe(false);
    expect(backupOutcome(true).ok).toBe(true);
    expect(backupOutcome({ ok: false, error: '' }).error).toMatch(/could not be written/);
  });
  it('{ ok: false } skips the drawing, names it in the question and in the summary', async () => {
    const f = fake({ ...base, files: { '/p/c.dxf': closed() }, backup: async () => ({ ok: false, code: 'EACCES', error: 'EACCES: permission denied' }) });
    const before = f.disk.get('/p/c.dxf');
    await runProjectXref(f.editor);
    expect(f.backups).toEqual(['/p/c.dxf']);
    expect(noBackupAsked).toEqual([{ name: 'c.dxf', path: '/p/c.dxf', error: 'EACCES: permission denied' }]);
    expect(f.writes).toEqual([]);
    expect(f.disk.get('/p/c.dxf')).toBe(before);
    expect(f.logs.join('\n')).toMatch(/Not updated: c\.dxf \(backup failed: EACCES: permission denied; not written\)/);
    // the open drawings are still updated in their tabs (nothing is written to disk for them)
    expect(f.editor.doc.canUndo()).toBe(true);
  });
  it('the old null answer and a thrown error are failures too', async () => {
    for (const backup of [async (): Promise<LegacyBackupResult> => null, async (): Promise<LegacyBackupResult> => Promise.reject(new Error('EBUSY'))]) {
      noBackupAsked = [];
      const f = fake({ ...base, files: { '/p/c.dxf': closed() }, backup });
      await runProjectXref(f.editor);
      expect(noBackupAsked).toHaveLength(1);
      expect(f.writes).toEqual([]);
    }
    expect(noBackupAsked[0]!.error).toBe('EBUSY');
  });
  it('"Continue Without Backup" for that file writes it', async () => {
    continueWithoutBackup = true;
    const f = fake({ ...base, files: { '/p/c.dxf': closed() }, backup: async () => ({ ok: false, code: 'ENOSPC', error: 'disk full' }) });
    await runProjectXref(f.editor);
    expect(f.writes).toEqual(['/p/c.dxf']);
    expect(f.logs.join('\n')).toMatch(/c\.dxf: backup failed \(disk full\); written without a backup as chosen/);
  });
  it('a successful backup ({ ok: true } or the old string answer) writes as before', async () => {
    const f = fake({ ...base, files: { '/p/c.dxf': closed() }, backup: async (p) => `${p}.bak` });
    await runProjectXref(f.editor);
    expect(noBackupAsked).toEqual([]);
    expect(f.writes).toEqual(['/p/c.dxf']);
  });
});

describe('changes apply only to the revision they were calculated from', () => {
  it('an open tab edited while the command waits is reported and left alone', async () => {
    const f = fake({ ...base, files: { '/p/c.dxf': closed() } });
    onConfirm = () => {
      f.editor.doc.addEntities([note('USER EDIT')]); // active tab
      const s = f.editor.sessions.all[1]!; // other tab
      s.state = { ...s.state, entities: [...s.state.entities, note('OTHER EDIT')] };
    };
    const r = await (async () => {
      const { sheets } = await loadProjectSheets(f.editor);
      const changes = new Map(sheets.map((s, i) => [i, { state: { ...s.doc.snapshot, entities: [] }, detail: 'wipe' }]));
      return commitSheets(f.editor, sheets, changes, 'T', 'I', true);
    })();
    expect(r!.conflicts).toEqual(['a.dxf (edited while the command ran)', 'b.dxf (edited while the command ran)']);
    expect(r!.open).toBe(0);
    expect(f.editor.doc.entities.some((e) => e.type === 'text' && e.text === 'USER EDIT')).toBe(true);
    expect(f.editor.sessions.all[1]!.state.entities.some((e) => e.type === 'text' && e.text === 'OTHER EDIT')).toBe(true);
    expect(r!.written).toBe(1); // the closed file did not change
  });
  it('a closed file changed on disk since it was read is not overwritten', async () => {
    const f = fake({ ...base, files: { '/p/c.dxf': closed() } });
    const { sheets } = await loadProjectSheets(f.editor);
    const changed = writeDxf({ ...closed(), entities: [...closed().entities, note('SAVED ELSEWHERE')] });
    f.disk.set('/p/c.dxf', changed);
    const i = sheets.findIndex((s) => s.source === 'file');
    const r = await commitSheets(f.editor, sheets, new Map([[i, { state: sheets[i]!.doc.snapshot, detail: 'x' }]]), 'T', 'I');
    expect(r!.conflicts).toEqual(['c.dxf (changed on disk since it was read)']);
    expect(f.writes).toEqual([]);
    expect(f.disk.get('/p/c.dxf')).toBe(changed);
  });
  it('a closed file opened in a tab meanwhile is not written under it', async () => {
    const f = fake({ ...base, files: { '/p/c.dxf': closed() } });
    const { sheets } = await loadProjectSheets(f.editor);
    f.editor.sessions.add(closed(), '/p/c.dxf');
    f.editor.sessions.switchTo(0);
    const i = sheets.findIndex((s) => s.source === 'file');
    const r = await commitSheets(f.editor, sheets, new Map([[i, { state: sheets[i]!.doc.snapshot, detail: 'x' }]]), 'T', 'I');
    expect(r!.conflicts).toEqual(['c.dxf (opened in a tab while the command ran)']);
    expect(f.writes).toEqual([]);
  });
  it('a newer save of the same file wins over the batch write (save queue revision)', async () => {
    const f = fake({ ...base, files: { '/p/c.dxf': closed() } });
    const { sheets } = await loadProjectSheets(f.editor);
    saveQueue.markCompleted('/p/c.dxf', captureRevision()); // a save started after the batch read the file
    const i = sheets.findIndex((s) => s.source === 'file');
    const r = await commitSheets(f.editor, sheets, new Map([[i, { state: sheets[i]!.doc.snapshot, detail: 'x' }]]), 'T', 'I');
    expect(r!.conflicts).toEqual(['c.dxf (a newer version was saved meanwhile)']);
    expect(f.writes).toEqual([]);
  });
  it('switching tabs while files load does not change what is calculated or where it goes', async () => {
    const f = fake({ ...base, files: { '/p/c.dxf': closed() } });
    const realOpen = f.editor.fileBridge!.openDrawing!;
    f.editor.fileBridge!.openDrawing = async (p?: string) => {
      f.editor.sessions.switchTo(1); // the user clicks the other tab during the read
      return realOpen(p);
    };
    const { sheets } = await loadProjectSheets(f.editor);
    const a = sheets.find((s) => s.name === 'a.dxf')!;
    expect(a.source).toBe('active');
    expect(a.doc.entities.some((e) => e.type === 'insert' && e.block === 'HCR1')).toBe(true); // a.dxf content, not b.dxf
    f.editor.fileBridge!.openDrawing = realOpen;
    const idx = sheets.indexOf(a);
    const r = await commitSheets(f.editor, sheets, new Map([[idx, { state: { ...a.doc.snapshot, entities: [...a.doc.snapshot.entities, note('XREF')] }, detail: 'x' }]]), 'T', 'I');
    expect(r!.open).toBe(1);
    // a.dxf is no longer the active tab: its session record got the change, b.dxf is untouched
    const aSession = f.editor.sessions.all.find((s) => s.filePath === '/p/a.dxf')!;
    expect(aSession.dirty).toBe(true);
    expect(aSession.state.entities.some((e) => e.type === 'text' && e.text === 'XREF')).toBe(true);
    expect(f.editor.doc.filePath).toBe('/p/b.dxf');
    expect(f.editor.doc.entities.some((e) => e.type === 'text' && e.text === 'XREF')).toBe(false);
  });
});

describe('drawings are identified by full path', () => {
  it('Windows-style project paths: case and separators do not matter', async () => {
    const f = fake({
      projectPath: 'C:\\Jobs\\P\\p.jcadproj.json',
      drawings: ['dwg\\A.dxf', 'dwg/B.dxf', 'dwg\\C.dxf'],
      activePath: 'c:/jobs/p/DWG/a.dxf',
      tabPath: 'C:\\JOBS\\P\\dwg\\b.DXF',
      files: { 'C:\\Jobs\\P\\dwg\\C.dxf': closed() },
    });
    const { sheets, skipped } = await loadProjectSheets(f.editor);
    expect(skipped).toEqual([]);
    expect(sheets.map((s) => `${s.name}:${s.source}`)).toEqual(['A.dxf:active', 'B.dxf:session', 'C.dxf:file']);
    expect(f.reads).toEqual(['C:\\Jobs\\P\\dwg\\C.dxf']);
  });
  it('equal file names in different folders are separate drawings with distinct names', async () => {
    const f = fake({
      projectPath: '/jobs/p/p.jcadproj.json',
      drawings: ['line1/a.dxf', 'line2/a.dxf'],
      activePath: '/jobs/p/line1/a.dxf',
      files: { '/jobs/p/line2/a.dxf': closed() },
    });
    const { sheets } = await loadProjectSheets(f.editor);
    expect(sheets.map((s) => `${s.name}:${s.source}:${s.path}`)).toEqual(['a.dxf (line1):active:/jobs/p/line1/a.dxf', 'a.dxf (line2):file:/jobs/p/line2/a.dxf']);
    await runTitleBlocksAll(f.editor);
    // only the closed line2 drawing is written; line1 changes in its tab
    expect(f.writes).toEqual(['/jobs/p/line2/a.dxf']);
    const tb = (s: DrawingState) => s.entities.find((e): e is InsertEntity => e.type === 'insert' && e.attributes.SHEET !== undefined)!.attributes.SHEET;
    expect(tb(readDxf(f.disk.get('/jobs/p/line2/a.dxf')!))).toBe('2 OF 2');
    expect(tb(f.editor.doc.snapshot)).toBe('1 OF 2');
  });
});

describe('a drawing shown in a layout tab', () => {
  it('gets the change in model space and keeps its layout tab', async () => {
    const f = fake({ ...base, drawings: ['a.dxf'], files: {} });
    const doc = f.editor.doc;
    const layoutName = doc.layouts[0]!.name;
    doc.setSpace({ layout: layoutName });
    const modelCount = doc.snapshot.entities.length;
    const paperCount = doc.entities.length;
    const { sheets } = await loadProjectSheets(f.editor, { files: false });
    // Calculations see model space, not the paper entities of the layout.
    expect(sheets[0]!.doc.snapshot.space).toBeUndefined();
    expect(sheets[0]!.doc.entities).toHaveLength(modelCount);
    const changes = new Map([[0, { state: { ...sheets[0]!.doc.snapshot, entities: [...sheets[0]!.doc.snapshot.entities, note('ADDED')] }, detail: 'add' }]]);
    const r = await commitSheets(f.editor, sheets, changes, 'T', 'I');
    expect(r!.open).toBe(1);
    expect(doc.space?.layout).toBe(layoutName);
    expect(doc.snapshot.entities).toHaveLength(modelCount + 1);
    expect(doc.snapshot.entities.some((e) => e.type === 'text' && e.text === 'ADDED')).toBe(true);
    expect(doc.entities).toHaveLength(paperCount); // the paper space is untouched
    expect(doc.dirty).toBe(true);
  });
});
