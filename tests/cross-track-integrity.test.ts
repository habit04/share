/**
 * Workflows that cross the file-safety tracks: crash-safe saves and permanent autosave ids (main
 * process store, Autosaver), the import report and retained records of damaged / unsupported DXF
 * files, and the project / multi-document integrity work (background opens, project autosave and
 * Save As, Save All on close, project-wide commands with conflicts and failed backups).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Editor as EditorType, FileBridge, OpenResult, BackupResult } from '../src/app/editor';
import { Drawing, type DrawingState } from '../src/core/document';
import type { Entity, InsertEntity } from '../src/core/entities';
import { newId } from '../src/core/entities';
import { readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf, rawEntitiesOf } from '../src/io/import-report';
import { Autosaver, autosaveName, localAutosaveStore, type AutosaveStore, type KeyValueStorage } from '../src/app/autosave';
import { ProjectAutosaver, drawingAutosaves, offerProjectRecovery, isProjectAutosave } from '../src/app/project-autosave';
import { parseProject, resolveDrawingPath, type Project } from '../src/app/project';
import { runCloseWorkflow, saveSymbolForClose, settleBeforeClose, closeErrorText, type CloseDecision, type UnsavedItem } from '../src/app/closeflow';
import { SessionManager } from '../src/app/sessions';
import { pathKey } from '../src/app/paths';
import { loadProjectSheets, runTitleBlocksAll, runProjectRetag, projectUi } from '../src/app/commands-electrical';
import { ALL_SYMBOLS } from '../src/electrical/symbols';
import { DEFAULT_WD_SETTINGS, writeWdSettings } from '../src/electrical/wdm';
import { newFromTemplate, SHEET_SIZES, TITLE_BLOCK } from '../src/electrical/templates';
import { withoutUnusedLibraryBlocks } from '../src/electrical/library';

const require = createRequire(import.meta.url);
type StoreEntry = { name: string; title: string; originalPath: string | null; savedAt: number };
type MainStore = {
  migrated: Array<[string, string]>;
  write(name: string, text: string, meta: unknown): Promise<void>;
  list(): Promise<StoreEntry[]>;
  read(name: string): Promise<string | null>;
  remove(name: string): Promise<void>;
};
const { createAutosaveStore, isLegacyName } = require('../electron/autosave-store.cjs') as {
  createAutosaveStore(dir: string): MainStore;
  isLegacyName(name: string): boolean;
};
/** The renderer's view of the main-process store (what bridgeAutosaveStore hands the autosavers). */
const viaBridge = (s: MainStore): AutosaveStore => ({ write: (n, t, m) => s.write(n, t, m), list: () => s.list(), read: (n) => s.read(n), remove: (n) => s.remove(n) });

let Editor: typeof EditorType;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
});
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'latin1');
const text = (t: string): Entity => ({ id: newId(), layer: '0', color: 'ByLayer', type: 'text', position: { x: 0, y: 0 }, text: t, height: 0.2, rotation: 0, align: 'left' });
const texts = (s: DrawingState) => s.entities.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.text : ''));
const dxfWith = (...t: string[]) => {
  const d = new Drawing();
  d.addEntities(t.map(text));
  return writeDxf(d.snapshot);
};
/** The file ends without its end-of-file marker (a copy that was cut short). */
const truncated = (dxf: string) => dxf.replace(/\r?\n0\r?\nEOF\s*$/, '\r\n');

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((a) => {
    resolve = a;
  });
  return { promise, resolve };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function memoryStore(): AutosaveStore {
  const data = new Map<string, string>();
  const storage: KeyValueStorage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
  return localAutosaveStore(storage);
}

function makeEditor(bridge: Partial<FileBridge> = {}) {
  const ed = new Editor(canvas());
  const confirms: string[] = [];
  let confirmAnswer = true;
  ed.ui = {
    pickSymbol: async () => null,
    editComponent: async (init) => ({ tag: init.tag, desc: init.desc, mfg: '', cat: '' }),
    ladderSettings: async (init) => init,
    textInput: async (_t, _l, init) => init,
    confirm: async (title) => {
      confirms.push(title);
      return confirmAnswer;
    },
    saveChanges: async () => 'discard',
  };
  ed.fileBridge = { openDxf: async () => null, saveDxf: async (p) => p, ...bridge } as FileBridge;
  return {
    ed,
    confirms,
    answer(v: boolean) {
      confirmAnswer = v;
    },
  };
}

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jcad-cross-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('project and drawing autosaves across a crash (main-process store)', () => {
  it('a new start keeps the project autosave under its own name and offers it, apart from the drawing backups', async () => {
    const folder = join(dir, 'autosave');
    mkdirSync(folder);
    writeFileSync(join(folder, 'Panel_A_1.sv.dxf'), dxfWith('OLD')); // a 0.4.0 backup: migrated
    writeFileSync(join(folder, 'Line_1_0a1b2c3d_jcadproj.sv.dxf'), '{"kind":"jcad-project-autosave","path":null,"text":"{\\"name\\":\\"Line 1\\",\\"drawings\\":[]}"}');
    const store = createAutosaveStore(folder);
    const list = await store.list();
    expect(list.find((e) => e.name === 'Line_1_0a1b2c3d_jcadproj.sv.dxf')?.title).toBe('Recovered project');
    expect(store.migrated.map(([from]) => from)).toEqual(['Panel_A_1.sv.dxf']);
    expect(isLegacyName('Drawing1_12.sv.dxf')).toBe(true);
    expect(isLegacyName('Line_1_0a1b2c3d_jcadproj.sv.dxf')).toBe(false);
    expect(isLegacyName('0b5c9f3e-1111-4222-8333-444455556666.sv.dxf')).toBe(false);
    const { ed } = makeEditor();
    expect((await offerProjectRecovery(ed, viaBridge(store), async () => 'open'))?.name).toBe('Line_1_0a1b2c3d_jcadproj.sv.dxf');
    expect(ed.project.name).toBe('Line 1');
  });

  it('Project Save As with project + drawing autosaves, then a crash: both are recovered, each where it belongs', async () => {
    const folder = join(dir, 'autosave');
    const store1 = viaBridge(createAutosaveStore(folder));
    const { ed } = makeEditor({ chooseProjectPath: async () => '/jobs/archive/p2.jcadproj.json', saveProject: async (p) => p });
    ed.replaceProject(parseProject(JSON.stringify({ name: 'Line 1', drawings: [{ file: 'dwg/a.dxf' }] }), '/jobs/p/p.jcadproj.json'));
    // The drawing holds records JCad keeps without showing (retained raw entities) and an edit.
    ed.loadState(readDxf(fixture('unsupported-content.dxf'), { filePath: '/jobs/p/dwg/a.dxf' }), '/jobs/p/dwg/a.dxf');
    const retained = rawEntitiesOf(ed.doc.snapshot).length;
    expect(retained).toBe(2);
    ed.doc.addEntities([text('EDIT')]);
    const autosaver = new Autosaver(ed.sessions, drawingAutosaves(store1), () => 10);
    const pa = new ProjectAutosaver(ed, store1, () => true, 60_000);
    ed.updateProject({ ...ed.project, description: 'changed' });
    await pa.flush();
    expect(await autosaver.runNow()).toBe(1);
    const first = (await store1.list()).find((e) => isProjectAutosave(e.name))!.name;
    expect((await store1.list()).map((e) => e.name).sort()).toEqual([autosaveName(ed.sessions.current.docId), first].sort());

    // Save As into another folder: the project is saved (its autosave goes), the drawing backup stays.
    expect(await ed.saveProject(true)).toBe(true);
    await pa.flush();
    expect((await store1.list()).map((e) => e.name)).toEqual([autosaveName(ed.sessions.current.docId)]);
    // More changes use this generation's ownership UUID; the payload carries the new location.
    ed.updateProject({ ...ed.project, descriptions: ['ACME'] });
    await pa.flush();
    const second = (await store1.list()).find((e) => isProjectAutosave(e.name))!.name;
    expect(second).toBe(first);
    expect((await store1.list()).filter((e) => isProjectAutosave(e.name)).map((e) => e.name)).toEqual([second]);

    // Crash: the next start reads the same folder through a new store.
    const store2 = viaBridge(createAutosaveStore(folder));
    const { ed: next } = makeEditor();
    const rec = await offerProjectRecovery(next, store2, async () => 'open');
    expect(rec?.name).toBe(second);
    expect(next.projectDirty).toBe(true);
    expect(next.project.path).toBe('/jobs/archive/p2.jcadproj.json');
    expect(next.project.descriptions).toEqual(['ACME']);
    expect(next.project.drawings.map((d) => resolveDrawingPath(next.project, d))).toEqual(['/jobs/p/dwg/a.dxf']);
    const drawings = await drawingAutosaves(store2).list();
    expect(drawings.map((e) => [e.title, e.originalPath])).toEqual([['a.dxf', '/jobs/p/dwg/a.dxf']]);
    const back = readDxf((await store2.read(drawings[0]!.name))!);
    expect(texts(back)).toContain('EDIT');
    expect(rawEntitiesOf(back)).toHaveLength(retained);
    // Nothing was renamed behind the project's back.
    expect(readdirSync(folder).filter((f) => f.endsWith('.sv.dxf')).sort()).toEqual([drawings[0]!.name, second].sort());
  });
});

describe('a damaged drawing that finishes opening in a background tab', () => {
  it('is recovered and modified in its own tab, reported under its own name, autosaved under its permanent id', async () => {
    const pending = deferred<OpenResult | null>();
    const { ed, confirms, answer } = makeEditor({ openDrawing: () => pending.promise });
    const shown: string[] = [];
    ed.hooks.importReport = (r, name) => shown.push(`${name}:${r.recovered ? 'recovered' : 'report'}`);
    ed.loadState(new Drawing().snapshot, '/w/first.dxf');
    ed.doc.addEntities([text('FIRST TAB')]);
    const opening = ed.sessions.openInTab('/w/b.dxf', (f) => ed.openFile(f));
    await tick();
    ed.switchSession(0); // the user goes back while the file loads
    pending.resolve({ path: '/w/b.dxf', kind: 'dxf', text: truncated(dxfWith('B1', 'B2')) });
    await opening;
    expect(confirms).toEqual(['Damaged drawing file']);
    expect(shown).toEqual(['b.dxf:recovered']);
    // The tab the user is in is untouched.
    expect(ed.sessions.active).toBe(0);
    expect(ed.doc.filePath).toBe('/w/first.dxf');
    expect(ed.doc.dirty).toBe(true);
    expect(importReportOf(ed.doc.snapshot)).toBeUndefined();
    // The background tab holds the recovered drawing, marked modified.
    const b = ed.sessions.all[1]!;
    expect([b.filePath, b.dirty]).toEqual(['/w/b.dxf', true]);
    expect(importReportOf(b.state)?.recovered).toBeTruthy();
    expect(texts(b.state)).toEqual(['B1', 'B2']);
    expect(ed.history.join('\n')).toMatch(/Opened \/w\/b\.dxf: .*\(in the tab it was opened from\)/);

    // Autosave backs it up under its own permanent id; the Recovery Manager would list it by name and path.
    const store = memoryStore();
    const autosaver = new Autosaver(ed.sessions, store, () => 10);
    expect(await autosaver.runNow()).toBe(2);
    const entry = (await store.list()).find((e) => e.name === autosaveName(b.docId))!;
    expect([entry.title, entry.originalPath]).toEqual(['b.dxf', '/w/b.dxf']);
    expect(texts(readDxf((await store.read(entry.name))!))).toEqual(['B1', 'B2']);

    // In its tab: IMPORTREPORT shows its report, and SAVE asks before replacing the damaged original.
    ed.switchSession(1);
    expect(ed.doc.dirty).toBe(true);
    ed.runCommand('IMPORTREPORT');
    expect(shown).toEqual(['b.dxf:recovered', 'b.dxf:recovered']);
    const writes: Array<string | null> = [];
    ed.fileBridge!.saveDxf = async (p) => {
      writes.push(p);
      return null; // the Save As dialog is cancelled
    };
    answer(false); // "No" keeps the original: Save As
    expect(await ed.saveFile(false)).toBe(false);
    expect(confirms.at(-1)).toBe('Save over the original file?');
    expect(writes).toEqual([null]);
    expect(ed.doc.dirty).toBe(true);
  });
});

describe('Save All across the tracks', () => {
  const ENTRY_ACCESS = "Error invoking remote method 'save-dxf': Error: EACCES: permission denied, copy '/w/b.dxf.bak'";
  function setup() {
    const order: string[] = [];
    let bakFails = true;
    const { ed, confirms } = makeEditor({
      saveDxf: async (p, t) => {
        order.push(`dxf:${p}`);
        await tick();
        if (p === '/w/b.dxf' && bakFails) throw new Error(ENTRY_ACCESS);
        expect(t).toContain('EOF');
        return p;
      },
      chooseProjectPath: async () => '/w/p.jcadproj.json',
      saveProject: async (p) => {
        order.push(`project:${p}`);
        return p;
      },
    });
    const errors: string[] = [];
    ed.hooks.saveError = async (info, name) => {
      errors.push(`${name}: ${info.message}`);
      return 'cancel';
    };
    // a.dxf came with content JCad could not keep (import report) and was edited.
    ed.loadState(readDxf(fixture('unsupported-content.dxf'), { filePath: '/w/a.dxf' }), '/w/a.dxf');
    ed.doc.addEntities([text('A EDIT')]);
    // b.dxf: its .bak copy cannot be made, so its save fails.
    ed.sessions.add(readDxf(dxfWith('B')), '/w/b.dxf', true);
    // c.dxf: clean (a Symbol Builder save may change it).
    ed.sessions.add(readDxf(dxfWith('C')), '/w/c.dxf', false);
    // A Symbol Builder tab (stand-in) and the modified project.
    ed.sessions.add();
    ed.doc.addEntities([text('SYMBOL')]);
    const symbolId = ed.sessions.current.id;
    ed.replaceProject({ name: 'P', path: '/w/p.jcadproj.json', drawings: [{ file: 'a.dxf' }] }, true);
    const store = memoryStore();
    const autosaver = new Autosaver(ed.sessions, drawingAutosaves(store), () => 10, (id) => id === symbolId);
    const pa = new ProjectAutosaver(ed, store, () => true, 60_000);
    ed.hooks.drawingSaved = (id, st) => void autosaver.markSaved(id, st);
    return { ed, confirms, order, errors, store, autosaver, pa, symbolId, fixBak: () => (bakFails = false) };
  }
  const id = (ed: EditorType, path: string) => ed.sessions.all.find((s) => s.filePath === path)!;
  const backups = async (store: AutosaveStore) => (await store.list()).map((e) => e.title).sort();

  it('saves in order, stops at the failed .bak with its own question first, and keeps flags and autosaves right', async () => {
    const s = setup();
    const { ed } = s;
    await s.pa.flush();
    expect(await s.autosaver.runNow()).toBe(2); // a.dxf and b.dxf (the symbol tab is never autosaved)
    expect(await backups(s.store)).toEqual(['Project P', 'a.dxf', 'b.dxf']);
    const asked: string[] = [];
    const shownErrors: string[] = [];
    const symbolSaves: number[] = [];
    const deps = {
      ask: async (items: readonly UnsavedItem[]): Promise<CloseDecision> => {
        asked.push(items.map((i) => `${i.kind}:${i.title}`).join(', '));
        return { action: 'save', keys: new Set(items.map((i) => i.key)) };
      },
      saveSymbol: async (sid: number) => {
        symbolSaves.push(sid);
        ed.doc.dirty = false;
        return null;
      },
      showError: async (title: string, error: string) => {
        shownErrors.push(`${title}: ${error}`);
      },
    };
    const isSymbol = (sid: number) => sid === s.symbolId;
    expect(await runCloseWorkflow(ed, deps, isSymbol)).toBe(false);
    expect(asked).toEqual(['drawing:a.dxf, drawing:b.dxf, symbol:Drawing4.dxf, project:P']);
    // a.dxf: the import-report question came first (Yes = save over it), then the write.
    expect(s.confirms).toEqual(['Save over the original file?']);
    expect(s.order).toEqual(['dxf:/w/a.dxf', 'dxf:/w/b.dxf']);
    // Two dialogs, in this order: the save error (Retry / Save As / Cancel), then why the close stopped.
    expect(s.errors).toEqual([expect.stringMatching(/^b\.dxf: "b\.dxf" could not be saved: you do not have permission/)]);
    expect(shownErrors).toEqual([expect.stringMatching(/^b\.dxf: "b\.dxf" could not be saved: you do not have permission/)]);
    expect(symbolSaves).toEqual([]);
    expect(ed.history.join('\n')).toMatch(/^Close cancelled\. "b\.dxf" could not be saved: you do not have permission/m);
    expect(closeErrorText('Drawing2.dxf', 'the save was cancelled')).toBe('Drawing2.dxf could not be saved: the save was cancelled');
    expect([id(ed, '/w/a.dxf').dirty, id(ed, '/w/b.dxf').dirty, ed.projectDirty]).toEqual([false, true, true]);
    expect(ed.sessions.isDirty(ed.sessions.indexOfId(s.symbolId))).toBe(true);
    // The saved drawing's backup goes; the failed one, the project's and the symbol's state are kept.
    await settleBeforeClose([s.pa.flush(), s.autosaver.idle()]);
    expect(await backups(s.store)).toEqual(['Project P', 'b.dxf']);

    // Next close, once the .bak can be made: what is left is saved and the window may close.
    s.fixBak();
    asked.length = 0;
    expect(await runCloseWorkflow(ed, deps, isSymbol)).toBe(true);
    expect(asked).toEqual(['drawing:b.dxf, symbol:Drawing4.dxf, project:P']);
    expect(symbolSaves).toEqual([s.symbolId]);
    expect(s.order.slice(2)).toEqual(['dxf:/w/b.dxf', 'project:/w/p.jcadproj.json']);
    expect(ed.sessions.anyDirty()).toBe(false);
    expect(ed.projectDirty).toBe(false);
    expect(await settleBeforeClose([s.pa.flush(), s.autosaver.idle()])).toBe(true);
    expect(await backups(s.store)).toEqual([]);
  });

  it('a drawing changed by a later save in the same round (Symbol Builder refresh) is asked about again', async () => {
    const s = setup();
    const { ed } = s;
    s.fixBak();
    const asked: string[] = [];
    let round = 0;
    const deps = {
      ask: async (items: readonly UnsavedItem[]): Promise<CloseDecision> => {
        round += 1;
        asked.push(items.map((i) => i.title).join(', '));
        return round === 1 ? { action: 'save', keys: new Set(items.map((i) => i.key)) } : { action: 'cancel' };
      },
      saveSymbol: async () => {
        // SymbolBuilder.save redefines the block in open drawings that use it: c.dxf (clean) and a.dxf (just saved).
        for (const p of ['/w/a.dxf', '/w/c.dxf']) {
          const x = id(ed, p);
          x.state = { ...x.state, blocks: { ...x.state.blocks } };
          x.dirty = true;
        }
        ed.doc.dirty = false;
        return null;
      },
      showError: async () => {},
    };
    expect(await runCloseWorkflow(ed, deps, (sid) => sid === s.symbolId)).toBe(false);
    expect(asked).toEqual(['a.dxf, b.dxf, Drawing4.dxf, P', 'a.dxf, c.dxf']);
    expect(ed.history.join('\n')).toMatch(/Close cancelled\./);
  });

  it('an unticked item stays unsaved and is not asked about again', async () => {
    const s = setup();
    const { ed } = s;
    s.fixBak();
    const asked: string[] = [];
    const deps = {
      ask: async (items: readonly UnsavedItem[]): Promise<CloseDecision> => {
        asked.push(items.map((i) => i.title).join(', '));
        return { action: 'save', keys: new Set(items.filter((i) => i.title !== 'b.dxf').map((i) => i.key)) };
      },
      saveSymbol: async () => {
        ed.doc.dirty = false;
        return null;
      },
      showError: async () => {},
    };
    expect(await runCloseWorkflow(ed, deps, (sid) => sid === s.symbolId)).toBe(true);
    expect(asked).toHaveLength(1);
    expect(id(ed, '/w/b.dxf').dirty).toBe(true);
  });
});

describe('the close waits for autosave work, but not forever', () => {
  it('Autosaver.idle waits for a backup removal started after a save', async () => {
    const removing = deferred<void>();
    const removed: string[] = [];
    const store: AutosaveStore = {
      write: async () => {},
      list: async () => [],
      read: async () => null,
      remove: async (n) => {
        await removing.promise;
        removed.push(n);
      },
    };
    const host = { doc: new Drawing(), viewport: { center: { x: 0, y: 0 }, scale: 1 }, selection: new Set<string>(), loadState: () => {} };
    const sessions = new SessionManager(host);
    host.doc.addEntities([text('X')]);
    const saver = new Autosaver(sessions, store, () => 10);
    await saver.runNow();
    const saved = host.doc.snapshot;
    host.doc.dirty = false;
    void saver.markSaved(sessions.current.id, saved); // what the drawingSaved hook does
    let idle = false;
    const waiting = saver.idle().then(() => (idle = true));
    await tick();
    expect(idle).toBe(false);
    removing.resolve();
    await waiting;
    expect(removed).toEqual([autosaveName(sessions.current.docId)]);
  });
  it('settleBeforeClose gives up on a hung write after the timeout', async () => {
    const t0 = Date.now();
    expect(await settleBeforeClose([new Promise(() => {})], 30)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await settleBeforeClose([Promise.resolve(), Promise.reject(new Error('x'))], 1000)).toBe(true);
  });
  it('a Symbol Builder save counts only once the user library file is written', async () => {
    const lib = { lastError: null as string | null, flushed: 0, async flush() {
      this.flushed += 1;
    } };
    expect(await saveSymbolForClose({ save: async () => ({}), firstError: () => null }, lib)).toBeNull();
    expect(lib.flushed).toBe(1);
    lib.lastError = 'ENOSPC: no space left on device';
    expect(await saveSymbolForClose({ save: async () => ({}), firstError: () => null }, lib)).toMatch(/user symbol library could not be written: ENOSPC/);
    expect(await saveSymbolForClose({ save: async () => null, firstError: () => 'Name is missing' }, lib)).toBe('Name is missing');
    expect(await saveSymbolForClose({ save: async () => null, firstError: () => null }, lib)).toBe('the symbol was not saved');
  });
});

// ------------------------------------------------------------------ project-wide commands, everything at once
const ins = (block: string, x: number, y: number, attrs: Record<string, string>): InsertEntity => ({ id: newId(), layer: 'SYMS', color: 'ByLayer', type: 'insert', block, position: { x, y }, rotation: 0, scale: 1, attributes: attrs });
function sheetState(sheet: string, comps: InsertEntity[]): DrawingState {
  const d = new Drawing();
  d.load(newFromTemplate(SHEET_SIZES[0]!, {}));
  d.ensureBlocks(ALL_SYMBOLS);
  writeWdSettings(d, { ...DEFAULT_WD_SETTINGS, sheet });
  d.addEntities(comps);
  return d.snapshot;
}
/** A sheet file as SAVE writes it (library blocks it does not use are left out, which keeps the files small). */
const sheetFile = (s: DrawingState) => writeDxf(withoutUnusedLibraryBlocks(s));
const titleSheet = (s: DrawingState) => s.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === TITLE_BLOCK.name)?.attributes.SHEET;

function projectRun() {
  const unsupported = readDxf(fixture('unsupported-content.dxf'));
  const files: Record<string, string> = {
    '/p/c.dxf': truncated(sheetFile(sheetState('3', [ins('HCR1_NC', 3, 8, { TAG1: 'CR300' })]))),
    '/p/d.dxf': sheetFile(sheetState('4', [ins('HCR1_NC', 4, 8, { TAG1: 'CR400' })])),
    '/p/e.dxf': sheetFile(sheetState('5', [ins('HCR1_NC', 5, 8, { TAG1: 'CR500' })])),
    '/p/f.dxf': sheetFile({ ...sheetState('6', [ins('HCR1_NC', 6, 8, { TAG1: 'CR600' })]), meta: { dxfRawEntities: rawEntitiesOf(unsupported) } }),
  };
  const disk = new Map(Object.entries(files));
  const doc = new Drawing();
  doc.load(sheetState('1', [ins('HCR1', 8, 8, { TAG1: 'CR100' })]), '/p/a.dxf');
  const layout = doc.layouts[0]!.name;
  doc.setSpace({ layout }); // the active tab shows a layout
  const host = { doc, viewport: { center: { x: 0, y: 0 }, scale: 1 }, selection: new Set<string>(), loadState: (s: DrawingState, p: string | null) => doc.load(s, p) };
  const sessions = new SessionManager(host);
  sessions.add(sheetState('2', [ins('HCR1_NO', 3, 8, { TAG1: 'CR100' })]), '/p/b.dxf');
  sessions.switchTo(0);
  const writes: string[] = [];
  const logs: string[] = [];
  const project: Project = { name: 'P', path: '/p/p.jcadproj.json', drawings: ['a', 'b', 'c', 'd', 'e', 'f'].map((n, i) => ({ file: `${n}.dxf`, sheet: String(i + 1) })) };
  const editor = {
    doc,
    sessions,
    project,
    hooks: {},
    fileBridge: {
      openDxf: async () => null,
      openDrawing: async (path: string) => {
        const t = disk.get(path);
        if (t === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
        return { path, kind: 'dxf' as const, text: t };
      },
      saveDxf: async (path: string | null, t: string) => {
        if (!path) return null;
        writes.push(path);
        disk.set(path, t);
        return path;
      },
      backupFile: async (path: string): Promise<BackupResult> =>
        path === '/p/e.dxf' ? { ok: false, code: 'ENOSPC', error: 'The backup copy of "e.dxf" could not be made: there is not enough free space on the disk. Free some space or choose another drive.' } : { ok: true, path: `${path}.bak` },
    },
    fileName: () => 'a.dxf',
    log: (t: string) => logs.push(t),
    notify: () => {},
  } as unknown as EditorType;
  return { editor, disk, writes, logs, layout, modelCount: doc.snapshot.entities.length, paperCount: doc.entities.length };
}

describe('project-wide commands with every kind of trouble in one run', () => {
  const g = globalThis as { window?: unknown };
  const orig = { ...projectUi };
  let skipBackup: string[] = [];
  beforeEach(() => {
    g.window = { jcad: {} };
    skipBackup = [];
  });
  afterEach(() => {
    delete g.window;
    Object.assign(projectUi, orig);
  });
  const install = (r: ReturnType<typeof projectRun>) => {
    projectUi.confirmFiles = async (_t, _i, items, opts) => {
      // d.dxf is saved by someone else while the confirmation is up.
      r.disk.set('/p/d.dxf', sheetFile(sheetState('4', [ins('HCR1_NC', 9, 9, { TAG1: 'SAVED ELSEWHERE' })])));
      expect(items.map((i) => i.name)).not.toContain('c.dxf');
      return { files: true, backup: opts.backupAvailable };
    };
    projectUi.confirmNoBackup = async (name) => {
      skipBackup.push(name);
      return false;
    };
    projectUi.showProblems = () => {};
  };

  it('AETITLEBLOCKALL: damaged skipped, changed-on-disk conflict, failed backup skipped, retained records written once, layout tab kept', async () => {
    const r = projectRun();
    install(r);
    const fBefore = rawEntitiesOf(readDxf(r.disk.get('/p/f.dxf')!)).length;
    await runTitleBlocksAll(r.editor);
    expect(r.writes).toEqual(['/p/f.dxf']);
    expect(skipBackup).toEqual(['e.dxf']);
    const f = readDxf(r.disk.get('/p/f.dxf')!);
    expect(rawEntitiesOf(f)).toHaveLength(fBefore);
    expect(fBefore).toBe(2);
    expect(r.disk.get('/p/f.dxf')!.match(/\r\n3DFACE\r\n/g)).toHaveLength(1);
    expect(titleSheet(f)).toBe('6 OF 6');
    expect(r.disk.get('/p/c.dxf')).not.toMatch(/EOF\s*$/); // the damaged file was not touched
    // The active drawing changed in model space; its layout tab is still shown.
    const doc = r.editor.doc;
    expect(doc.space?.layout).toBe(r.layout);
    expect(doc.entities).toHaveLength(r.paperCount);
    expect(titleSheet(doc.snapshot)).toBe('1 OF 6');
    expect(doc.dirty).toBe(true);
    expect(titleSheet(r.editor.sessions.all[1]!.state)).toBe('2 OF 6');
    const log = r.logs.join('\n');
    expect(log).toMatch(/^Title blocks: 2 open drawing\(s\) updated, 1 closed drawing file\(s\) saved\.$/m);
    expect(log).toMatch(/^Not updated: e\.dxf \(backup failed: The backup copy of "e\.dxf" could not be made: .*; not written\)\.$/m);
    expect(log).toMatch(/^Not updated because they changed while the command ran \(run it again\): d\.dxf \(changed on disk since it was read\)\.$/m);
    expect(log).toMatch(/^Skipped: c\.dxf \(damaged, not changed: The file ends early at line \d+: .*end-of-file marker is missing\. The file is truncated or damaged\. OPEN it to recover what is readable\)\.$/m);
  });

  it('AERETAGPROJECT: the same outcome for every kind of trouble', async () => {
    const r = projectRun();
    install(r);
    await runProjectRetag(r.editor, 'all');
    expect(r.writes).toEqual(['/p/f.dxf']);
    expect(skipBackup).toEqual(['e.dxf']);
    expect(rawEntitiesOf(readDxf(r.disk.get('/p/f.dxf')!))).toHaveLength(2);
    expect(r.editor.doc.space?.layout).toBe(r.layout);
    const log = r.logs.join('\n');
    expect(log).toMatch(/^RETAG project \(\d+ tag\(s\)\): 2 open drawing\(s\) updated, 1 closed drawing file\(s\) saved\.$/m);
    expect(log).toMatch(/Not updated: e\.dxf \(backup failed/);
    expect(log).toMatch(/d\.dxf \(changed on disk since it was read\)/);
    expect(log).toMatch(/Skipped: c\.dxf \(damaged, not changed/);
  });

  it('Windows-style entries: equal names in two folders are two drawings; one file listed twice is written once', async () => {
    const r = projectRun();
    // A hand-edited project: line1\\a.dxf, line2/a.dxf, and line1\\a.dxf again under another spelling.
    r.editor.project = { name: 'P', path: 'C:\\Jobs\\P\\p.jcadproj.json', drawings: [{ file: 'line1\\a.dxf', sheet: '1' }, { file: 'line2/a.dxf', sheet: '2' }, { file: 'LINE1\\A.DXF', sheet: '3' }] };
    // The disk answers like Windows: case and separators do not matter.
    const files = new Map([
      [pathKey('C:\\Jobs\\P\\line1\\a.dxf'), sheetFile(sheetState('1', []))],
      [pathKey('C:\\Jobs\\P\\line2\\a.dxf'), sheetFile(sheetState('2', []))],
    ]);
    const writes: string[] = [];
    const bridge = r.editor.fileBridge!;
    bridge.openDrawing = async (p?: string) => ({ path: p!, kind: 'dxf' as const, text: files.get(pathKey(p!))! });
    bridge.saveDxf = async (p: string | null, t: string) => {
      writes.push(p!);
      files.set(pathKey(p!), t);
      return p;
    };
    const { sheets, skipped } = await loadProjectSheets(r.editor);
    expect(skipped).toEqual([]);
    expect(sheets.map((s) => s.path)).toEqual(['C:\\Jobs\\P\\line1\\a.dxf', 'C:\\Jobs\\P\\line2\\a.dxf', 'C:\\Jobs\\P\\LINE1\\A.DXF']);
    expect(new Set(sheets.map((s) => s.name)).size).toBe(3);
    projectUi.confirmFiles = async () => ({ files: true, backup: false });
    await runTitleBlocksAll(r.editor);
    // The second copy of line1\\a.dxf was calculated from the file the first write replaced: a conflict, not a second write.
    expect(writes.map((w) => pathKey(w))).toEqual([pathKey('C:\\Jobs\\P\\line1\\a.dxf'), pathKey('C:\\Jobs\\P\\line2\\a.dxf')]);
    expect(r.logs.join('\n')).toMatch(/changed on disk since it was read/);
  });
});

describe('opening a file that is gone', () => {
  it('says so in plain words, keeps the recent list and drops the tab made for it', async () => {
    const { ed } = makeEditor({
      openDrawing: async () => {
        throw new Error("Error invoking remote method 'open-drawing': Error: ENOENT: no such file or directory, open '/w/gone.dxf'");
      },
    });
    ed.settings = { ...ed.settings, recentFiles: ['/w/gone.dxf', '/w/other.dxf'] };
    ed.doc.addEntities([text('KEEP')]);
    await ed.sessions.openInTab('/w/gone.dxf', (f) => ed.openFile(f));
    expect(ed.history.at(-1)).toBe('Failed to open drawing: "gone.dxf" could not be read: the file is no longer in "/w", or that folder is not available. It may have been moved or deleted, or the network or removable drive is disconnected.');
    expect(ed.lastFileError).toMatch(/could not be read/);
    expect(ed.settings.recentFiles).toEqual(['/w/gone.dxf', '/w/other.dxf']);
    expect(ed.sessions.count).toBe(1);
    expect(texts(ed.doc.snapshot)).toEqual(['KEEP']);
    // Not a file error: the reader's own message, without the IPC wrapper.
    ed.fileBridge!.openDrawing = async () => {
      throw new Error("Error invoking remote method 'open-drawing': Error: Unknown file path");
    };
    await ed.sessions.openInTab('/w/x.dxf', (f) => ed.openFile(f));
    expect(ed.history.at(-1)).toBe('Failed to open drawing: Unknown file path');
  });
});
