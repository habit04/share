/**
 * Project-wide commands (commands-electrical.ts commitSheets / loadProjectSheets) must not
 * destroy work: a requested backup that fails stops that drawing, changes are applied only to
 * the revision they were calculated from, drawings are identified by full path (Windows paths,
 * equal names in different folders), and an older write never replaces a newer one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { defaultLayout } from '../src/core/layouts';

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
  /** The options of each saveDxf call (a project-wide write never asks the main process for a second .bak). */
  const writeOpts: Array<{ backup?: boolean } | undefined> = [];
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
      saveDxf: async (path: string | null, text: string, _name?: string, opts?: { backup?: boolean }) => {
        if (!path) return null;
        writes.push(path);
        writeOpts.push(opts);
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
  return { editor, disk, writes, writeOpts, backups, reads, logs };
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
  projectUi.confirmLoss = async () => false;
  projectUi.showProblems = () => {};
});
afterEach(() => {
  delete g.window;
  Object.assign(projectUi, orig);
});

const closed = () => sheetState('3', 300, [ins('HCR1_NC', 3, 8, { TAG1: 'CR100' })]);
const base = { projectPath: '/p/p.jcadproj.json', drawings: ['a.dxf', 'b.dxf', 'c.dxf'], activePath: '/p/a.dxf', tabPath: '/p/b.dxf' };

describe('geometry budgets are checked before project batch changes', () => {
  // T-FLAKE: worst variant ('active') measured p99 3.5 s under maxWorkers=2 family load (n=10 runs; solo p50 1.4 s); budget = p99 x 2 rounded up, shared by the three %s cases. The 'active' case timed out at the 5 s default in a full-suite run.
  it.each(['active', 'session', 'file'] as const)('rejects an excessive %s candidate before changing any drawing, history, active space or file', async (source) => {
    const f = fake({ ...base, files: { '/p/c.dxf': closed() } });
    f.editor.doc.transact((state) => ({ ...state, layouts: [defaultLayout('L1')], space: { layout: 'L1' } }));
    f.editor.doc.addEntities([note('paper note')]);
    const { sheets } = await loadProjectSheets(f.editor);
    const before = f.editor.doc.snapshot;
    const history = f.editor.doc.history();
    const revision = f.editor.doc.revision;
    const tabs = () => f.editor.sessions.all.map((session) => ({ state: session.state, undo: [...session.undo], redo: [...session.redo], dirty: session.dirty, revision: session.revision }));
    const beforeTabs = tabs();
    const beforeDisk = [...f.disk];
    let confirmations = 0;
    onConfirm = () => { confirmations += 1; };
    const active = sheets.findIndex((sheet) => sheet.source === 'active');
    const target = sheets.findIndex((sheet) => sheet.source === source);
    const changes = new Map([[active, { state: { ...sheets[active]!.doc.snapshot, entities: [...sheets[active]!.doc.entities, note('valid update')] }, detail: 'valid' }]]);
    changes.set(target, { state: { ...sheets[target]!.doc.snapshot, entities: [note('X'.repeat(1_000_000))] }, detail: 'excessive' });
    await expect(commitSheets(f.editor, sheets, changes, 'Budget test', 'test', true)).rejects.toThrow(/safe geometry budget/);
    expect(f.editor.doc.snapshot).toBe(before);
    expect(f.editor.doc.history()).toEqual(history);
    expect(f.editor.doc.revision).toBe(revision);
    expect(f.editor.doc.space).toEqual({ layout: 'L1' });
    expect(tabs()).toEqual(beforeTabs);
    expect([...f.disk]).toEqual(beforeDisk);
    expect(confirmations).toBe(0);
    expect(f.backups).toEqual([]);
    expect(f.writes).toEqual([]);
  }, 8000);

  it('seals accepted background batch geometry before retaining it and permits its undo', async () => {
    const f = fake({ ...base, files: { '/p/c.dxf': closed() } });
    const { sheets } = await loadProjectSheets(f.editor);
    const target = sheets.findIndex((sheet) => sheet.source === 'session');
    const previous = f.editor.sessions.all[1]!.state;
    const borrowed = { ...sheets[target]!.doc.snapshot, entities: [note('valid background update')] };
    const result = await commitSheets(f.editor, sheets, new Map([[target, { state: borrowed, detail: 'valid' }]]), 'Budget test', 'test');
    expect(result?.open).toBe(1);
    expect(f.editor.sessions.all[1]!.state).toBe(borrowed);
    expect(() => borrowed.entities.push(note('borrowed mutation'))).toThrow(TypeError);
    f.editor.sessions.switchTo(1);
    expect(f.editor.doc.undo()).toBe(true);
    expect(f.editor.doc.snapshot).toBe(previous);
  });
});

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
  // T-FLAKE: measured p99 4.8 s under maxWorkers=2 family load (n=10 runs; solo p50 2.8 s); budget = p99 x 2 rounded up. Timed out at the 5 s default in full-suite runs.
  it('the old null answer and a thrown error are failures too', async () => {
    for (const backup of [async (): Promise<LegacyBackupResult> => null, async (): Promise<LegacyBackupResult> => Promise.reject(new Error('EBUSY'))]) {
      noBackupAsked = [];
      const f = fake({ ...base, files: { '/p/c.dxf': closed() }, backup });
      await runProjectXref(f.editor);
      expect(noBackupAsked).toHaveLength(1);
      expect(f.writes).toEqual([]);
    }
    expect(noBackupAsked[0]!.error).toBe('EBUSY');
  }, 10000);
  // T-FLAKE: measured p99 3.7 s under maxWorkers=2 family load (n=10 runs; solo p50 2.1 s); budget = p99 x 2 rounded up. Timed out at the 5 s default in a full-suite run.
  it('"Continue Without Backup" for that file writes it', async () => {
    continueWithoutBackup = true;
    const f = fake({ ...base, files: { '/p/c.dxf': closed() }, backup: async () => ({ ok: false, code: 'ENOSPC', error: 'disk full' }) });
    await runProjectXref(f.editor);
    expect(f.writes).toEqual(['/p/c.dxf']);
    expect(f.logs.join('\n')).toMatch(/c\.dxf: backup failed \(disk full\); written without a backup as chosen/);
    // The write itself must not try the .bak again (a folder or locked file in the way would fail it).
    expect(f.writeOpts).toEqual([{ backup: false }]);
  }, 8000);
  // T-FLAKE: measured p99 5.2 s under maxWorkers=2 family load (n=10 runs; solo p50 2.2 s); budget = p99 x 2 rounded up. Timed out at the 5 s default in a loaded validation run.
  it('a successful backup ({ ok: true } or the old string answer) writes as before', async () => {
    const f = fake({ ...base, files: { '/p/c.dxf': closed() }, backup: async (p) => `${p}.bak` });
    await runProjectXref(f.editor);
    expect(noBackupAsked).toEqual([]);
    expect(f.writes).toEqual(['/p/c.dxf']);
  }, 11000);
});

describe('damaged closed drawings', () => {
  it('a truncated closed drawing is skipped as damaged (not reported as a file error) and never written', async () => {
    const f = fake({ ...base, files: { '/p/c.dxf': closed() } });
    const whole = f.disk.get('/p/c.dxf')!;
    f.disk.set('/p/c.dxf', whole.slice(0, Math.floor(whole.length * 0.6)));
    const { skipped } = await loadProjectSheets(f.editor);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatch(/^c\.dxf \(damaged, not changed: The file ends early/);
    expect(skipped[0]).toMatch(/OPEN it to recover what is readable\)$/);
    await runProjectXref(f.editor);
    expect(f.writes).not.toContain('/p/c.dxf');
  });
});

describe('changes apply only to the revision they were calculated from', () => {
  it('captures open sheets before an earlier closed-sheet read can edit or replace them', async () => {
    const f = fake({ ...base, drawings: ['c.dxf', 'a.dxf', 'b.dxf'], files: { '/p/c.dxf': closed() } });
    const before = f.editor.doc.snapshot;
    const read = f.editor.fileBridge!.openDrawing!;
    f.editor.fileBridge!.openDrawing = async (path) => {
      f.editor.doc.addEntities([note('EDIT DURING READ')]);
      return read(path);
    };
    const { sheets } = await loadProjectSheets(f.editor);
    const index = sheets.findIndex((s) => s.name === 'a.dxf');
    expect(sheets[index]!.base).toBe(before);
    expect(sheets[index]!.doc.entities.some((e) => e.type === 'text' && e.text === 'EDIT DURING READ')).toBe(false);
    const result = await commitSheets(f.editor, sheets, new Map([[index, { state: sheets[index]!.doc.snapshot, detail: 'update' }]]), 'T', 'I');
    expect(result!.open).toBe(0);
    expect(result!.conflicts).toEqual(['a.dxf (edited while the command ran)']);
  });

  it('edit followed by Undo to the captured state still invalidates the batch revision', async () => {
    const f = fake({ ...base, drawings: ['a.dxf'], files: {} });
    const { sheets } = await loadProjectSheets(f.editor);
    f.editor.doc.addEntities([note('TEMP')]);
    f.editor.doc.undo();
    expect(f.editor.doc.snapshot).toBe(sheets[0]!.base);
    const result = await commitSheets(f.editor, sheets, new Map([[0, { state: sheets[0]!.doc.snapshot, detail: 'update' }]]), 'T', 'I');
    expect(result!.open).toBe(0);
    expect(result!.conflicts).toEqual(['a.dxf (edited while the command ran)']);
  });
  // T-FLAKE: measured p99 4.4 s under maxWorkers=2 family load (n=10 runs; solo p50 2.1 s) — within 12% of the 5 s default that a sibling test with a lower p99 crossed under the same load; budget = p99 x 2 rounded up.
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
  }, 9000);
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

describe('closed drawings with import losses', () => {
  it('refuses partial source replacement regardless of the loss warning answer', async () => {
    const f = fake({ ...base, files: { '/p/c.dxf': closed() } });
    const original = readFileSync(join(__dirname, 'fixtures', 'unsupported-content.dxf'), 'latin1');
    f.disk.set('/p/c.dxf', original);
    const { sheets } = await loadProjectSheets(f.editor);
    const index = sheets.findIndex((s) => s.source === 'file');
    const asked: string[] = [];
    projectUi.confirmLoss = async (_title, message) => { asked.push(message); return false; };
    const changes = new Map([[index, { state: sheets[index]!.doc.snapshot, detail: 'update' }]]);
    const declined = await commitSheets(f.editor, sheets, changes, 'T', 'I');
    expect(asked).toEqual([]);
    expect(declined!.failed.join('\n')).toMatch(/cannot be saved over its source/);
    expect(f.writes).toEqual([]);
    expect(f.disk.get('/p/c.dxf')).toBe(original);
    projectUi.confirmLoss = async () => true;
    const accepted = await commitSheets(f.editor, sheets, changes, 'T', 'I');
    expect(accepted!.written).toBe(0);
    expect(accepted!.failed.join('\n')).toMatch(/cannot be saved over its source/);
    expect(f.backups).toEqual([]);
    expect(f.disk.get('/p/c.dxf')).toBe(original);
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
  // T-FLAKE: measured p99 6.8 s under maxWorkers=2 family load (n=10 runs; solo p50 3.3 s); budget = p99 x 2 rounded up. Timed out at the 5 s default in family and full-suite runs.
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
  }, 14000);
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

describe('stale-batch fuzzing regressions (tests/fuzz-stale-batch.test.ts)', () => {
  const commitClosed = async (f: ReturnType<typeof fake>) => {
    const { sheets } = await loadProjectSheets(f.editor);
    const i = sheets.findIndex((s) => s.source === 'file');
    return commitSheets(f.editor, sheets, new Map([[i, { state: { ...sheets[i]!.doc.snapshot, entities: [...sheets[i]!.doc.snapshot.entities, note('BATCH')] }, detail: 'x' }]]), 'T', 'I');
  };
  // T-FLAKE: measured p99 5.9 s under maxWorkers=2 family load (n=10 runs; solo p50 2.4 s); budget = p99 x 2 rounded up. Timed out at the 5 s default in a family run.
  it('a file changed on disk while "backup failed, continue?" is open is not overwritten (seed 1657033021)', async () => {
    continueWithoutBackup = true;
    const f = fake({ ...base, files: { '/p/c.dxf': closed() }, backup: async () => ({ ok: false, code: 'EACCES', error: 'EACCES' }) });
    const changed = writeDxf({ ...closed(), entities: [...closed().entities, note('SAVED ELSEWHERE')] });
    projectUi.confirmNoBackup = async () => {
      f.disk.set('/p/c.dxf', changed); // another program saves the file while the question is shown
      return true;
    };
    const r = await commitClosed(f);
    expect(r!.conflicts).toEqual(['c.dxf (changed on disk since it was read)']);
    expect(f.writes).toEqual([]);
    expect(f.disk.get('/p/c.dxf')).toBe(changed);
  }, 12000);
  it('a file opened in a tab while its backup is made is not written under the tab', async () => {
    const f = fake({ ...base, files: { '/p/c.dxf': closed() }, backup: async (p) => {
      f.editor.sessions.add(closed(), '/p/c.dxf');
      return { ok: true, path: `${p}.bak` };
    } });
    const r = await commitClosed(f);
    expect(r!.conflicts).toEqual(['c.dxf (opened in a tab while the command ran)']);
    expect(f.writes).toEqual([]);
  });
  // T-FLAKE: measured p99 4.0 s under maxWorkers=2 family load (n=10 runs; solo p50 2.2 s); budget = p99 x 2 rounded up. Timed out at the 5 s default in a full-suite run.
  it('closed drawings left unsaved by choice are named in the outcome and the log (seed 2670937247)', async () => {
    projectUi.confirmFiles = async () => ({ files: false, backup: false });
    const f = fake({ ...base, files: { '/p/c.dxf': closed() } });
    const r = await commitClosed(f);
    expect(r).toEqual({ open: 0, written: 0, failed: [], conflicts: [], notSaved: ['c.dxf'] });
    expect(f.writes).toEqual([]);
    const g2 = fake({ ...base, files: { '/p/c.dxf': closed() } });
    await runProjectXref(g2.editor);
    expect(g2.logs.join('\n')).toMatch(/Not updated \(closed drawing files were not saved, as chosen\): c\.dxf\./);
  }, 9000);
});
