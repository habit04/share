/**
 * File-safety workflows over a real Editor with a fake file bridge: opens land in the tab that
 * started them, saves to one file run in order (older revisions dropped), the project has its
 * own dirty flag with Save / Don't Save / Cancel protection and autosave recovery, project
 * Save As keeps relative paths correct, and the Save All close workflow.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Editor as EditorType, FileBridge, OpenResult } from '../src/app/editor';
import { Drawing, type DrawingState } from '../src/core/document';
import type { Entity } from '../src/core/entities';
import { newId } from '../src/core/entities';
import { writeDxf, readDxf as readDxfState } from '../src/io/dxf';
import { SaveQueue, captureRevision } from '../src/app/savequeue';
import { parseProject, resolveDrawingPath, resolveProjectPath } from '../src/app/project';
import { closeDrawingTab, collectUnsaved, runCloseWorkflow, settleBeforeClose, type CloseDecision, type UnsavedItem } from '../src/app/closeflow';
import { ProjectAutosaver, drawingAutosaves, offerProjectRecovery, projectAutosaveName, isProjectAutosave } from '../src/app/project-autosave';
import { localAutosaveStore, type KeyValueStorage } from '../src/app/autosave';
import { createApi } from '../src/app/api';

let Editor: typeof EditorType;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
});
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;

const text = (t: string): Entity => ({ id: newId(), layer: '0', color: 'ByLayer', type: 'text', position: { x: 0, y: 0 }, text: t, height: 0.2, rotation: 0, align: 'left' });
const texts = (s: DrawingState) => s.entities.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.text : ''));
const dxfWith = (...t: string[]) => {
  const d = new Drawing();
  d.addEntities(t.map(text));
  return writeDxf(d.snapshot);
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

type SaveAnswer = 'save' | 'discard' | 'cancel';
function makeEditor(bridge: Partial<FileBridge> = {}, saveAnswer: SaveAnswer = 'discard') {
  const ed = new Editor(canvas());
  const asked: string[] = [];
  ed.ui = {
    pickSymbol: async () => null,
    editComponent: async (init) => ({ tag: init.tag, desc: init.desc, mfg: '', cat: '' }),
    ladderSettings: async (init) => init,
    textInput: async (_t, _l, init) => init,
    confirm: async () => true,
    saveChanges: async (name) => {
      asked.push(name);
      return saveAnswer;
    },
  };
  ed.fileBridge = { openDxf: async () => null, saveDxf: async (p) => p, ...bridge } as FileBridge;
  return { ed, asked };
}

describe('save queue', () => {
  it('runs writes to one file in order and drops an older revision', async () => {
    const q = new SaveQueue();
    const log: string[] = [];
    q.log = (t) => log.push(t);
    const order: string[] = [];
    const first = deferred<string>();
    const r1 = captureRevision();
    const r2 = captureRevision();
    const a = q.run('C:\\Jobs\\a.dxf', r1, async () => {
      order.push('start1');
      const v = await first.promise;
      order.push('end1');
      return v;
    });
    const b = q.run('c:/jobs/A.DXF', r2, async () => {
      order.push('start2');
      return 'C:\\Jobs\\a.dxf';
    });
    await tick();
    expect(order).toEqual(['start1']); // the second write waits for the first (same file, other spelling)
    first.resolve('C:\\Jobs\\a.dxf');
    expect((await a).status).toBe('written');
    expect((await b).status).toBe('written');
    expect(order).toEqual(['start1', 'end1', 'start2']);
    // a write captured before r2 arrives late: dropped with a log line, never written
    let called = false;
    const late = await q.run('C:\\Jobs\\a.dxf', r1, async () => {
      called = true;
      return 'x';
    });
    expect(late.status).toBe('stale');
    expect(called).toBe(false);
    expect(log.join('\n')).toMatch(/older revision/);
    // a failed write does not block the queue
    const failing = q.run('/x.dxf', captureRevision(), async () => Promise.reject(new Error('EIO')));
    const after = q.run('/x.dxf', captureRevision(), async () => '/x.dxf');
    await expect(failing).rejects.toThrow('EIO');
    expect((await after).status).toBe('written');
  });
  it('Editor saves to the same file are serialised; the tab stays modified when it changed during the save', async () => {
    const writes: Array<{ path: string; text: string; done: ReturnType<typeof deferred<string | null>> }> = [];
    const { ed } = makeEditor({
      saveDxf: (path, t) => {
        const done = deferred<string | null>();
        writes.push({ path: path!, text: t, done });
        return done.promise;
      },
    });
    ed.loadState(new Drawing().snapshot, '/w/a.dxf');
    ed.doc.addEntities([text('ONE')]);
    const s1 = ed.saveFile(false);
    await tick();
    ed.doc.addEntities([text('TWO')]);
    const s2 = ed.saveFile(false);
    await tick();
    expect(writes).toHaveLength(1); // the second save waits
    writes[0]!.done.resolve('/w/a.dxf');
    expect(await s1).toBe(true);
    expect(ed.doc.dirty).toBe(true); // TWO is not on disk yet
    await tick();
    expect(writes).toHaveLength(2);
    expect(writes[1]!.text).toContain('TWO');
    writes[1]!.done.resolve('/w/a.dxf');
    expect(await s2).toBe(true);
    expect(ed.doc.dirty).toBe(false);
  });
  it('a save that finishes after a switch to another tab is applied to the tab that started it', async () => {
    const d = deferred<string | null>();
    const writes: Array<string | null> = [];
    const { ed } = makeEditor({ saveDxf: async (p) => { writes.push(p); return d.promise; } });
    const a = new Drawing();
    a.addEntities([text('A1')]);
    ed.loadState(a.snapshot, '/w/a.dxf');
    ed.doc.addEntities([text('A2')]);
    const idA = ed.sessions.current.id;
    const saving = ed.saveFile(false);
    await tick();
    expect(writes).toEqual(['/w/a.dxf']);
    ed.sessions.add();
    ed.doc.addEntities([text('B1')]);
    const idB = ed.sessions.current.id;
    d.resolve('/w/a.dxf');
    expect(await saving).toBe(true);
    const sa = ed.sessions.all.find((s) => s.id === idA)!;
    const sb = ed.sessions.all.find((s) => s.id === idB)!;
    expect([sa.dirty, sa.filePath]).toEqual([false, '/w/a.dxf']);
    expect([sb.dirty, sb.filePath]).toEqual([true, null]);
    expect(texts(ed.doc.snapshot)).toEqual(['B1']);
    expect(ed.sessions.current.id).toBe(idB);
  });
  it('a failed save reports the error and returns false', async () => {
    const { ed } = makeEditor({ saveDxf: async () => Promise.reject(new Error('EACCES: permission denied')) });
    ed.loadState(new Drawing().snapshot, '/w/ro.dxf');
    ed.doc.addEntities([text('X')]);
    expect(await ed.saveFile(false)).toBe(false);
    // The raw error, or (desktop build) the user message made from it: both name the permission problem.
    expect(ed.lastFileError).toMatch(/permission/i);
    expect(ed.doc.dirty).toBe(true);
    expect(ed.history.join('\n')).toMatch(/Save failed: .*permission/i);
  });
});

describe('opens bind to the tab that started them', () => {
  it('switching tabs in the real editor keeps each tab\'s modified flag and undo history', () => {
    const { ed } = makeEditor();
    ed.loadState(new Drawing().snapshot, '/w/a.dxf');
    ed.doc.addEntities([text('A')]);
    ed.sessions.add();
    ed.doc.addEntities([text('B')]);
    // 'file' listeners (Symbol Builder, palettes) read the session list while a tab is restored
    ed.switchSession(0);
    expect(ed.doc.dirty).toBe(true);
    expect(ed.doc.canUndo()).toBe(true);
    expect(ed.sessions.all.map((s) => s.dirty)).toEqual([true, true]);
    ed.switchSession(1);
    expect(ed.doc.dirty).toBe(true);
    expect(ed.doc.undo()).toBe(true);
    expect(texts(ed.doc.snapshot)).toEqual([]);
  });
  it('a slow open finishes in its own tab after the user switched tabs', async () => {
    const pending = deferred<OpenResult | null>();
    const { ed } = makeEditor({ openDrawing: () => pending.promise });
    ed.doc.addEntities([text('FIRST TAB')]);
    const opening = ed.sessions.openInTab('/w/b.dxf', (f) => ed.openFile(f));
    await tick();
    expect(ed.sessions.count).toBe(2);
    expect(ed.sessions.active).toBe(1);
    ed.switchSession(0); // the user goes back while the file loads
    pending.resolve({ path: '/w/b.dxf', kind: 'dxf', text: dxfWith('B CONTENT') });
    await opening;
    expect(ed.sessions.count).toBe(2);
    expect(ed.sessions.active).toBe(0);
    expect(ed.doc.filePath).toBe(null);
    expect(texts(ed.doc.snapshot)).toEqual(['FIRST TAB']);
    const b = ed.sessions.all[1]!;
    expect(b.filePath).toBe('/w/b.dxf');
    expect(b.dirty).toBe(false);
    expect(texts(b.state)).toEqual(['B CONTENT']);
    ed.switchSession(1);
    expect(texts(ed.doc.snapshot)).toEqual(['B CONTENT']);
    expect(ed.doc.dirty).toBe(false);
  });
  it('when the tab was edited meanwhile, the file opens in a new tab instead of replacing the edits', async () => {
    const pending = deferred<OpenResult | null>();
    const { ed } = makeEditor({ openDrawing: () => pending.promise });
    ed.doc.addEntities([text('FIRST TAB')]);
    const opening = ed.sessions.openInTab('/w/b.dxf', (f) => ed.openFile(f));
    await tick();
    ed.doc.addEntities([text('TYPED INTO THE NEW TAB')]);
    pending.resolve({ path: '/w/b.dxf', kind: 'dxf', text: dxfWith('B CONTENT') });
    await opening;
    expect(ed.sessions.count).toBe(3);
    expect(texts(ed.sessions.all[1]!.state)).toEqual(['TYPED INTO THE NEW TAB']);
    expect(ed.sessions.all[2]!.filePath).toBe('/w/b.dxf');
    expect(ed.history.join('\n')).toMatch(/in a new tab/);
  });
  it('an open whose tab was used meanwhile goes to a new tab in the background when the user works elsewhere', async () => {
    const slow = deferred<OpenResult | null>();
    const { ed } = makeEditor({ openDrawing: (f) => (f === '/w/b.dxf' ? slow.promise : Promise.resolve({ path: f!, kind: 'dxf', text: dxfWith('C') })) });
    ed.doc.addEntities([text('WORK')]);
    const first = ed.sessions.openInTab('/w/b.dxf', (f) => ed.openFile(f));
    await tick();
    await ed.sessions.openInTab('/w/c.dxf', (f) => ed.openFile(f)); // reuses the pristine tab made for b.dxf
    ed.switchSession(0); // back to work
    ed.doc.addEntities([text('MORE WORK')]);
    slow.resolve({ path: '/w/b.dxf', kind: 'dxf', text: dxfWith('B') });
    await first;
    expect(ed.sessions.all.map((s) => s.filePath)).toEqual([null, '/w/c.dxf', '/w/b.dxf']);
    expect(ed.sessions.active).toBe(0);
    expect(texts(ed.doc.snapshot)).toEqual(['WORK', 'MORE WORK']);
    expect(ed.doc.dirty).toBe(true);
    expect(ed.sessions.all[2]!.dirty).toBe(false);
    expect(ed.history.join('\n')).toMatch(/in a new tab in the background/);
    ed.switchSession(2);
    expect(texts(ed.doc.snapshot)).toEqual(['B']);
  });
  it('a missing file is reported in plain words', async () => {
    const { ed } = makeEditor({ openDrawing: async () => Promise.reject(new Error("Error invoking remote method 'open-drawing': Error: ENOENT: no such file or directory, open '/w/gone.dxf'")) });
    await ed.sessions.openInTab('/w/gone.dxf', (f) => ed.openFile(f));
    expect(ed.history.at(-1)).toMatch(/^Failed to open drawing: "gone\.dxf" could not be read: the file is no longer in "\/w", or that folder is not available/);
    expect(ed.history.at(-1)).not.toMatch(/invoking remote method/);
  });
  it('a file already open under another spelling switches to its tab (Windows paths)', async () => {
    let opened = 0;
    const { ed } = makeEditor({
      openDrawing: async (f) => {
        opened += 1;
        return { path: f!, kind: 'dxf', text: dxfWith('A') };
      },
    });
    await ed.sessions.openInTab('C:\\Jobs\\Line1\\A.dxf', (f) => ed.openFile(f));
    ed.sessions.add();
    await ed.sessions.openInTab('c:/jobs/line1/./a.DXF', (f) => ed.openFile(f));
    expect(opened).toBe(1);
    expect(ed.sessions.count).toBe(2);
    expect(ed.sessions.active).toBe(0);
  });
  it('a file picked in the Open dialog that is already open shows its tab instead of a second copy', async () => {
    const { ed } = makeEditor({ openDrawing: async (f) => ({ path: f ?? '/w/a.dxf', kind: 'dxf', text: dxfWith('A') }) });
    await ed.sessions.openInTab('/w/a.dxf', (f) => ed.openFile(f));
    ed.doc.addEntities([text('UNSAVED IN A')]);
    ed.sessions.add();
    ed.doc.addEntities([text('OTHER')]);
    // OPEN without a path: the dialog answers /w/a.dxf.
    await ed.sessions.openInTab(undefined, (f) => ed.openFile(f));
    expect(ed.sessions.all.filter((s) => s.filePath === '/w/a.dxf')).toHaveLength(1);
    expect(ed.sessions.count).toBe(2);
    expect(ed.sessions.active).toBe(0);
    expect(texts(ed.doc.snapshot)).toEqual(['A', 'UNSAVED IN A']);
    expect(ed.history.join('\n')).toMatch(/already open/);
  });
  it('the browser build (file names only) still opens two files with the same name', async () => {
    const { ed } = makeEditor({ openDrawing: async () => ({ path: 'a.dxf', kind: 'dxf', text: dxfWith('A') }) });
    await ed.sessions.openInTab(undefined, (f) => ed.openFile(f));
    ed.doc.addEntities([text('EDIT')]);
    await ed.sessions.openInTab(undefined, (f) => ed.openFile(f));
    expect(ed.sessions.count).toBe(2);
  });
  it('RECENT twice while the file loads opens it once', async () => {
    const reads: Array<ReturnType<typeof deferred<OpenResult | null>>> = [];
    const { ed } = makeEditor({
      openDrawing: () => {
        const d = deferred<OpenResult | null>();
        reads.push(d);
        return d.promise;
      },
    });
    ed.doc.addEntities([text('WORK')]);
    const first = ed.sessions.openInTab('/w/b.dxf', (f) => ed.openFile(f));
    await tick();
    const second = ed.sessions.openInTab('/w/b.dxf', (f) => ed.openFile(f));
    await tick();
    for (const r of reads) r.resolve({ path: '/w/b.dxf', kind: 'dxf', text: dxfWith('B') });
    await Promise.all([first, second]);
    expect(ed.sessions.all.filter((s) => s.filePath === '/w/b.dxf')).toHaveLength(1);
    expect(ed.sessions.count).toBe(2);
  });
  it('re-opening the file into the tab that holds it (a reload) still replaces it', async () => {
    const { ed } = makeEditor({ openDrawing: async (f) => ({ path: f!, kind: 'dxf', text: dxfWith('FROM DISK') }) });
    ed.loadState(new Drawing().snapshot, '/w/a.dxf');
    await ed.openFile('/w/a.dxf');
    expect(texts(ed.doc.snapshot)).toEqual(['FROM DISK']);
    expect(ed.sessions.count).toBe(1);
  });
  it('a file that fails to open is not added to the recent list', async () => {
    const { ed } = makeEditor({ openDrawing: async (f) => ({ path: f!, kind: 'dxf', text: '0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n1O\n0.0\n0\nENDSEC\n0\nEOF\n' }) });
    const before = ed.settings.recentFiles.slice();
    await ed.sessions.openInTab('/w/broken.dxf', (f) => ed.openFile(f));
    expect(ed.history.join('\n')).toMatch(/Failed to open drawing/);
    expect(ed.settings.recentFiles).toEqual(before);
    expect(ed.sessions.count).toBe(1);
  });
  it('tabs with equal file names in different folders show their folder', async () => {
    const { ed } = makeEditor({ openDrawing: async (f) => ({ path: f!, kind: 'dxf', text: dxfWith('A') }) });
    await ed.sessions.openInTab('/jobs/line1/a.dxf', (f) => ed.openFile(f));
    await ed.sessions.openInTab('/jobs/line2/a.dxf', (f) => ed.openFile(f));
    await ed.sessions.openInTab('/jobs/line2/b.dxf', (f) => ed.openFile(f));
    expect([0, 1, 2].map((i) => ed.sessions.titleOf(i))).toEqual(['a.dxf (line1)', 'a.dxf (line2)', 'b.dxf']);
    expect(ed.sessions.indexOfPath('/jobs/line2/a.dxf')).toBe(1);
  });
});

describe('project dirty flag and protection', () => {
  const projectText = JSON.stringify({ name: 'Other', drawings: [{ file: 'x.dxf' }] });

  it('project changes set the flag; PROJECTADD uses a relative entry', () => {
    const { ed } = makeEditor();
    expect(ed.projectDirty).toBe(false);
    ed.replaceProject({ name: 'P', path: '/jobs/p/p.jcadproj.json', drawings: [] });
    ed.loadState(new Drawing().snapshot, '/jobs/p/dwg/a.dxf');
    ed.runCommand('PROJECTADD');
    expect(ed.projectDirty).toBe(true);
    expect(ed.project.drawings).toEqual([{ file: 'dwg/a.dxf' }]);
    ed.runCommand('PROJECTADD');
    expect(ed.project.drawings).toHaveLength(1);
    ed.updateProject({ ...ed.project, titleBlockMap: 'TITLE = DWGDESC' });
    expect(ed.projectState.revision).toBeGreaterThan(1);
  });
  it('opening another project asks Save / Don\'t Save / Cancel first', async () => {
    for (const answer of ['cancel', 'discard', 'save'] as const) {
      const calls: string[] = [];
      const { ed, asked } = makeEditor(
        {
          openProject: async () => {
            calls.push('open');
            return { path: '/jobs/q/q.jcadproj.json', text: projectText };
          },
          chooseProjectPath: async () => '/jobs/p/p.jcadproj.json',
          saveProject: async (p) => {
            calls.push('save');
            return p;
          },
        },
        answer,
      );
      ed.replaceProject({ name: 'P', path: '/jobs/p/p.jcadproj.json', drawings: [] });
      ed.updateProject({ ...ed.project, description: 'changed' });
      const ok = await ed.openProject();
      expect(asked).toEqual(['project P']);
      if (answer === 'cancel') {
        expect(ok).toBe(false);
        expect(calls).toEqual([]);
        expect(ed.project.name).toBe('P');
        expect(ed.projectDirty).toBe(true);
      } else {
        expect(ok).toBe(true);
        expect(calls).toEqual(answer === 'save' ? ['save', 'open'] : ['open']);
        expect(ed.project.name).toBe('Other');
        expect(ed.projectDirty).toBe(false);
      }
    }
  });
  it('NEWPROJECT is protected the same way', async () => {
    const { ed, asked } = makeEditor({}, 'cancel');
    ed.replaceProject({ name: 'P', drawings: [{ file: '/a.dxf' }] }, true);
    expect(await ed.newProjectCommand('Fresh')).toBe(false);
    expect(asked).toEqual(['project P']);
    expect(ed.project.name).toBe('P');
    ed.projectDirty = false;
    expect(await ed.newProjectCommand('Fresh')).toBe(true);
    expect(ed.project).toEqual({ name: 'Fresh', drawings: [] });
    expect(ed.projectDirty).toBe(false);
  });
  it('Save As into another folder writes recalculated relative paths and keeps the files resolvable', async () => {
    const written = new Map<string, string>();
    const { ed } = makeEditor({
      chooseProjectPath: async () => '/jobs/archive/p2.jcadproj.json',
      saveProject: async (p, t) => {
        written.set(p, t);
        return p;
      },
    });
    ed.replaceProject(parseProject(JSON.stringify({ name: 'P', settings: { catalogFile: 'parts.json' }, drawings: [{ file: 'dwg/a.dxf' }, { file: 'b.dxf' }] }), '/jobs/p/p.jcadproj.json'));
    ed.updateProject({ ...ed.project, description: 'x' });
    expect(await ed.saveProject(true)).toBe(true);
    const t = written.get('/jobs/archive/p2.jcadproj.json')!;
    const saved = parseProject(t, '/jobs/archive/p2.jcadproj.json');
    expect(saved.drawings.map((d) => d.file)).toEqual(['../p/dwg/a.dxf', '../p/b.dxf']);
    expect(saved.drawings.map((d) => resolveDrawingPath(saved, d))).toEqual(['/jobs/p/dwg/a.dxf', '/jobs/p/b.dxf']);
    expect(resolveProjectPath(saved, saved.settings!.catalogFile!)).toBe('/jobs/p/parts.json');
    expect(ed.project.path).toBe('/jobs/archive/p2.jcadproj.json');
    expect(ed.project.drawings[0]!.file).toBe('../p/dwg/a.dxf');
    expect(ed.projectDirty).toBe(false);
    // PROJECTSAVE now writes to the new path without asking
    ed.updateProject({ ...ed.project, description: 'y' });
    let asked = 0;
    ed.fileBridge!.chooseProjectPath = async () => {
      asked += 1;
      return null;
    };
    expect(await ed.saveProject()).toBe(true);
    expect(asked).toBe(0);
  });
  it('PROJECTSAVE to a path the main process does not know asks where to save instead of failing', async () => {
    const written: string[] = [];
    const { ed } = makeEditor({
      chooseProjectPath: async () => '/jobs/new/p.jcadproj.json',
      saveProject: async (p) => {
        if (p === '/jobs/old/p.jcadproj.json') throw new Error("Error invoking remote method 'save-project': Error: Unknown project path");
        written.push(p);
        return p;
      },
    });
    ed.replaceProject({ name: 'P', path: '/jobs/old/p.jcadproj.json', drawings: [{ file: 'a.dxf' }] }, true);
    expect(await ed.saveProject()).toBe(true);
    expect(written).toEqual(['/jobs/new/p.jcadproj.json']);
    expect(ed.project.drawings[0]!.file).toBe('../old/a.dxf');
    expect(ed.projectDirty).toBe(false);
  });
  it('a project save applies to the project that started it; edits during the save stay unsaved', async () => {
    const pending = deferred<string | null>();
    const { ed } = makeEditor({ chooseProjectPath: async () => '/jobs/p/p.jcadproj.json', saveProject: () => pending.promise });
    ed.replaceProject({ name: 'P', path: '/jobs/p/p.jcadproj.json', drawings: [] }, true);
    const saving = ed.saveProject();
    await tick();
    ed.updateProject({ ...ed.project, description: 'typed during the save' });
    pending.resolve('/jobs/p/p.jcadproj.json');
    expect(await saving).toBe(true);
    expect(ed.projectDirty).toBe(true);
    expect(ed.project.description).toBe('typed during the save');

    const pending2 = deferred<string | null>();
    ed.fileBridge!.saveProject = () => pending2.promise;
    const saving2 = ed.saveProject(true);
    await tick();
    ed.replaceProject({ name: 'Q', path: '/jobs/q/q.jcadproj.json', drawings: [] }, true); // another project opened
    pending2.resolve('/jobs/p/p.jcadproj.json');
    expect(await saving2).toBe(true);
    expect(ed.project.name).toBe('Q');
    expect(ed.project.path).toBe('/jobs/q/q.jcadproj.json');
    expect(ed.projectDirty).toBe(true);
  });
  it('the project is autosaved while modified, removed once saved, and offered for recovery', async () => {
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
    const store = localAutosaveStore(storage);
    const { ed } = makeEditor({ chooseProjectPath: async () => '/jobs/p/p.jcadproj.json', saveProject: async (p) => p });
    const pa = new ProjectAutosaver(ed, store, () => true, 1);
    ed.replaceProject({ name: 'Plant 7', path: '/jobs/p/p.jcadproj.json', drawings: [{ file: 'a.dxf' }] });
    ed.updateProject({ ...ed.project, descriptions: ['ACME'] });
    await pa.flush();
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).not.toBe(projectAutosaveName(ed.project));
    expect(isProjectAutosave(list[0]!.name)).toBe(true);
    expect(list[0]!.name).toMatch(/^[A-Za-z0-9_-]{1,60}\.sv\.dxf$/); // the main process's autosave name rule
    expect(await drawingAutosaves(store).list()).toEqual([]); // not shown as a drawing
    // a new session (after a crash) offers it
    const { ed: next } = makeEditor();
    const answers: string[] = [];
    const rec = await offerProjectRecovery(next, store, async (name, path) => {
      answers.push(`${name}|${path}`);
      return 'open';
    });
    expect(answers).toEqual(['Plant 7|/jobs/p/p.jcadproj.json']);
    expect(rec).not.toBeNull();
    expect(next.project.descriptions).toEqual(['ACME']);
    expect(next.projectDirty).toBe(true);
    // saving the project removes the autosave
    expect(await ed.saveProject()).toBe(true);
    await pa.flush();
    expect(await store.list()).toEqual([]);
  });
});

describe('who chose the project (write access to its drawings outside its folder, electron/path-registry.cjs)', () => {
  const file = '/jobs/p/p.jcadproj.json';
  const projectText = JSON.stringify({ name: 'P', drawings: [{ file: '../shared/a.dxf' }] });
  function recording() {
    const calls: Array<{ file: string | undefined; opts: unknown }> = [];
    const { ed } = makeEditor({
      openProject: async (f?: string, opts?: unknown) => {
        calls.push({ file: f, opts });
        return { path: f ?? file, text: projectText };
      },
    });
    ed.settings = { ...ed.settings, recentFiles: [file, '/jobs/p/a.dxf'] };
    return { ed, calls };
  }

  it('RECENT (Recent Documents) counts as the user choosing the project; OPENPROJECT with a path does not', async () => {
    const { ed, calls } = recording();
    ed.runCommand('RECENT 1');
    await tick();
    expect(calls.at(-1)).toEqual({ file, opts: { userChosen: true } });
    ed.runCommand(`OPENPROJECT ${file}`);
    await tick();
    expect(calls.at(-1)).toEqual({ file, opts: undefined });
    // The dialog itself (no file) decides in the main process.
    expect(await ed.openProject()).toBe(true);
    expect(calls.at(-1)).toEqual({ file: undefined, opts: undefined });
    // A caller cannot attach the flag to the dialog either.
    await ed.openProject(undefined, { userChosen: true });
    expect(calls.at(-1)).toEqual({ file: undefined, opts: undefined });
  });

  it('a plugin running RECENT through the plugin API opens the project by name', async () => {
    const { ed, calls } = recording();
    const { api } = createApi(ed, 'test');
    api.commands.run('RECENT', '1');
    await tick();
    expect(calls.at(-1)).toEqual({ file, opts: undefined });
    expect(ed.apiCommandDepth).toBe(0);
    // The user's own RECENT afterwards counts again.
    ed.runCommand('RECENT 1');
    await tick();
    expect(calls.at(-1)).toEqual({ file, opts: { userChosen: true } });
  });
});

describe('project save generations and recovery ownership', () => {
  it('a hung project cleanup has a bounded close wait and retains its recovery copy', async () => {
    const values = new Map<string, string>();
    const pending = deferred<void>();
    const store = {
      write: async (name: string, value: string) => { values.set(name, value); },
      remove: async () => pending.promise,
      read: async (name: string) => values.get(name) ?? null,
      list: async () => [...values.keys()].map((name) => ({ name, savedAt: 1, title: 'P', originalPath: '/p/p.jcadproj.json' })),
    };
    const { ed } = makeEditor();
    const saver = new ProjectAutosaver(ed, store);
    ed.replaceProject({ name: 'P', drawings: [] }, true);
    await saver.flush();
    expect(await settleBeforeClose([saver.discard()], 5)).toBe(false);
    expect(values.size).toBe(1);
    pending.resolve();
  });

  it('a slower old Save As cannot restore an old destination or mark a newer revision clean', async () => {
    const older = deferred<string | null>();
    let choices = 0;
    const { ed } = makeEditor({
      chooseProjectPath: async () => ++choices === 1 ? '/jobs/old/p.jcadproj.json' : '/jobs/new/p.jcadproj.json',
      saveProject: async (path) => path.includes('/old/') ? older.promise : path,
    });
    ed.replaceProject({ name: 'P', path: '/jobs/original/p.jcadproj.json', drawings: [{ file: 'a.dxf' }] }, true);
    const first = ed.saveProject(true);
    await tick();
    ed.updateProject({ ...ed.project, description: 'newer' });
    expect(await ed.saveProject(true)).toBe(true);
    ed.updateProject({ ...ed.project, description: 'latest unsaved' });
    older.resolve('/jobs/old/p.jcadproj.json');
    expect(await first).toBe(true);
    expect(ed.project.path).toBe('/jobs/new/p.jcadproj.json');
    expect(ed.project.description).toBe('latest unsaved');
    expect(ed.projectDirty).toBe(true);
    expect(resolveDrawingPath(ed.project, ed.project.drawings[0]!)).toBe('/jobs/original/a.dxf');
  });

  it('same filename in a fresh generation preserves the unrecovered copy; explicit recovery adopts it', async () => {
    const entries = new Map<string, string>();
    const store = {
      write: async (name: string, value: string) => { entries.set(name, value); },
      remove: async (name: string) => { entries.delete(name); },
      read: async (name: string) => entries.get(name) ?? null,
      list: async () => [...entries.keys()].map((name) => ({ name, savedAt: 1, title: 'P', originalPath: '/p/p.jcadproj.json' })),
    };
    const { ed } = makeEditor();
    const saver = new ProjectAutosaver(ed, store);
    ed.replaceProject({ name: 'P', path: '/p/p.jcadproj.json', drawings: [], description: 'first recovery' }, true);
    await saver.flush();
    const old = [...entries][0]!;
    ed.replaceProject({ name: 'P', path: '/p/p.jcadproj.json', drawings: [], description: 'second recovery' }, true);
    await saver.flush();
    expect(entries.size).toBe(2);
    expect(entries.get(old[0])).toBe(old[1]);
    await saver.discard();
    expect([...entries.keys()]).toEqual([old[0]]);
    const { ed: recovered } = makeEditor();
    const recoveredSaver = new ProjectAutosaver(recovered, store);
    await offerProjectRecovery(recovered, store, async () => 'open', recoveredSaver);
    recovered.updateProject({ ...recovered.project, description: 'adopted edit' });
    await recoveredSaver.flush();
    expect([...entries.keys()]).toEqual([old[0]]);
    await recoveredSaver.discard();
    expect(entries.size).toBe(0);
  });

  it('project recovery retries a failed read and keeps unreadable copies on Later', async () => {
    const { ed } = makeEditor();
    const name = projectAutosaveName({ name: 'P', path: '/p/p.jcadproj.json' });
    let reads = 0;
    const store = {
      write: async () => {}, remove: async () => { throw new Error('must keep copy'); },
      list: async () => [{ name, savedAt: 1, title: 'P', originalPath: '/p/p.jcadproj.json' }],
      read: async () => { if (++reads === 1) throw new Error('temporarily locked'); return JSON.stringify({ kind: 'jcad-project-autosave', path: '/p/p.jcadproj.json', text: '{"name":"P","drawings":[]}' }); },
    };
    const errors: string[] = [];
    const entry = await offerProjectRecovery(ed, store, async () => 'open', undefined, async (_name, error) => { errors.push(String(error)); return 'retry'; });
    expect(entry?.name).toBe(name);
    expect(reads).toBe(2);
    expect(errors[0]).toContain('temporarily locked');
    const { ed: later } = makeEditor();
    store.read = async () => { throw new Error('unreadable'); };
    expect(await offerProjectRecovery(later, store, async () => 'open', undefined, async () => 'later')).toBeNull();
    expect(later.projectDirty).toBe(false);
  });
});

describe('project autosave when the changes are discarded at close', () => {
  it('discard() removes the autosave, a later flush does not write it back, the next change does', async () => {
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
    const store = localAutosaveStore(storage);
    const { ed } = makeEditor();
    const pa = new ProjectAutosaver(ed, store, () => true, 1);
    ed.replaceProject({ name: 'Thrown Away', path: '/jobs/t.jcadproj.json', drawings: [] });
    ed.updateProject({ ...ed.project, description: 'x' });
    await pa.flush();
    const ownedName = (await store.list())[0]!.name;
    expect(isProjectAutosave(ownedName)).toBe(true);
    await pa.discard();
    await pa.flush(); // what the close workflow does afterwards
    expect(await store.list()).toEqual([]);
    expect(ed.projectDirty).toBe(true);
    ed.updateProject({ ...ed.project, description: 'y' }); // the window stayed open (e.g. restart not done)
    await new Promise((r) => setTimeout(r, 5));
    await pa.flush();
    expect((await store.list()).length).toBe(1);
  });
});

describe('Save All when closing', () => {
  function closeSetup() {
    const disk = new Map<string, string>();
    const order: string[] = [];
    const saveAs: string[] = ['/w/untitled.dxf'];
    const { ed } = makeEditor({
      saveDxf: async (p, t) => {
        const path = p ?? saveAs.shift() ?? null;
        order.push(`dxf:${path}`);
        await tick();
        if (path) disk.set(path, t);
        return path;
      },
      chooseProjectPath: async () => '/w/p.jcadproj.json',
      saveProject: async (p, t) => {
        order.push(`project:${p}`);
        disk.set(p, t);
        return p;
      },
    });
    ed.loadState(new Drawing().snapshot, '/w/a.dxf');
    ed.doc.addEntities([text('A')]);
    ed.sessions.add();
    ed.doc.addEntities([text('UNTITLED')]);
    ed.sessions.add(new Drawing().snapshot, '/w/clean.dxf');
    ed.sessions.add();
    ed.doc.addEntities([text('SYMBOL')]); // stands in for a Symbol Builder tab
    const symbolId = ed.sessions.current.id;
    ed.replaceProject({ name: 'P', drawings: [] }, true);
    return { ed, disk, order, symbolId, saveAs };
  }
  const deps = (decision: (items: readonly UnsavedItem[]) => CloseDecision, log: string[] = [], ed?: EditorType) => ({
    ask: async (items: readonly UnsavedItem[]) => {
      log.push(items.map((i) => `${i.kind}:${i.title}`).join(', '));
      return decision(items);
    },
    saveSymbol: async () => {
      log.push('symbol saved');
      // Like SymbolBuilder.save: the (active) symbol tab is no longer modified.
      if (ed) ed.doc.dirty = false;
      return null;
    },
    showError: async (title: string, error: string) => {
      log.push(`error:${title}:${error}`);
    },
  });

  it('lists every modified drawing tab, the symbol tab and the project', () => {
    const { ed, symbolId } = closeSetup();
    const items = collectUnsaved(ed, (id) => id === symbolId);
    expect(items.map((i) => `${i.kind}:${i.title}:${i.detail}`)).toEqual(['drawing:a.dxf:/w/a.dxf', 'drawing:Drawing2.dxf:never saved (Save As)', 'symbol:Drawing4.dxf:unsaved symbol edits', 'project:P:never saved (Save As)']);
  });
  it('Cancel keeps everything open; Discard All closes without saving', async () => {
    const { ed, symbolId, order } = closeSetup();
    expect(await runCloseWorkflow(ed, deps(() => ({ action: 'cancel' })), (id) => id === symbolId)).toBe(false);
    expect(await runCloseWorkflow(ed, deps(() => ({ action: 'discard' })), (id) => id === symbolId)).toBe(true);
    expect(order).toEqual([]);
  });
  it('Save All saves one item after another, each awaited', async () => {
    const { ed, symbolId, order, disk } = closeSetup();
    const log: string[] = [];
    const ok = await runCloseWorkflow(ed, deps((items) => ({ action: 'save', keys: new Set(items.map((i) => i.key)) }), log, ed), (id) => id === symbolId);
    expect(ok).toBe(true);
    expect(order).toEqual(['dxf:/w/a.dxf', 'dxf:/w/untitled.dxf', 'project:/w/p.jcadproj.json']);
    expect(log).toContain('symbol saved');
    expect(disk.get('/w/a.dxf')).toContain('A');
    expect(ed.sessions.anyDirty()).toBe(false);
    expect(ed.projectDirty).toBe(false);
    expect(log.filter((l) => l !== 'symbol saved')).toHaveLength(1); // asked once: nothing changed while saving
  });
  it('per-item choice: unticked items are not saved', async () => {
    const { ed, symbolId, order } = closeSetup();
    const ok = await runCloseWorkflow(ed, deps((items) => ({ action: 'save', keys: new Set([items[0]!.key]) })), (id) => id === symbolId);
    expect(ok).toBe(true);
    expect(order).toEqual(['dxf:/w/a.dxf']);
  });
  it('the first failure aborts the close and shows its error', async () => {
    const { ed, symbolId, order, saveAs } = closeSetup();
    saveAs.length = 0; // the Save As dialog for the untitled drawing is cancelled
    const log: string[] = [];
    const ok = await runCloseWorkflow(ed, deps((items) => ({ action: 'save', keys: new Set(items.map((i) => i.key)) }), log), (id) => id === symbolId);
    expect(ok).toBe(false);
    expect(order).toEqual(['dxf:/w/a.dxf', 'dxf:null']);
    expect(log.at(-1)).toBe('error:Drawing2.dxf:the save was cancelled');
    expect(ed.projectDirty).toBe(true); // nothing after the failure was attempted
    // a write error is reported with its message
    ed.fileBridge!.saveDxf = async () => Promise.reject(new Error('ENOSPC: no space left on device'));
    const log2: string[] = [];
    expect(await runCloseWorkflow(ed, deps((items) => ({ action: 'save', keys: new Set(items.map((i) => i.key)) }), log2), (id) => id === symbolId)).toBe(false);
    expect(log2.at(-1)).toMatch(/^error:Drawing2\.dxf:.*space/);
    // ... once: '"a.dxf" could not be saved: there is not enough free space', not the file name twice
    ed.switchSession(0);
    ed.doc.addEntities([text('A2')]);
    const log3: string[] = [];
    expect(await runCloseWorkflow(ed, deps((items) => ({ action: 'save', keys: new Set(items.map((i) => i.key)) }), log3), (id) => id === symbolId)).toBe(false);
    expect(log3.at(-1)).toMatch(/^error:a\.dxf:"a\.dxf" could not be saved: there is not enough free space/);
    expect(ed.history.at(-1)).toMatch(/^Close cancelled\. "a\.dxf" could not be saved: there is not enough free space/);
    expect(ed.history.at(-1)!.match(/could not be saved/g)).toHaveLength(1);
  });
});

describe('save / close fuzzing regressions (tests/fuzz-save-close.test.ts)', () => {
  it('an older Save As finishing after a newer save does not re-point the drawing to its file (seed 65794426)', async () => {
    const disk = new Map<string, string>();
    const slow = deferred<void>();
    const dialogs = ['/net/slow.dxf', '/local/fast.dxf'];
    const { ed } = makeEditor({
      saveDxf: async (p, t) => {
        const path = p ?? dialogs.shift()!;
        if (path === '/net/slow.dxf') await slow.promise; // a network drive
        disk.set(path, t);
        return path;
      },
    });
    const first = ed.saveFile(true); // untitled: Save As, picks the slow network path
    await tick();
    ed.doc.addEntities([text('NEWER')]);
    expect(await ed.saveFile(true)).toBe(true); // Save As again, a local path, done first
    expect(ed.doc.filePath).toBe('/local/fast.dxf');
    expect(ed.doc.dirty).toBe(false);
    slow.resolve();
    expect(await first).toBe(true); // the older revision did reach its file ...
    expect(disk.get('/net/slow.dxf')).not.toContain('NEWER');
    // ... but the drawing stays bound to the newer save: its file holds exactly what is shown as saved.
    expect(ed.doc.filePath).toBe('/local/fast.dxf');
    expect(ed.doc.dirty).toBe(false);
    expect(disk.get('/local/fast.dxf')).toContain('NEWER');
  });
  it('a drawing edited while Save All saves another item is asked about again (seed 1967257802)', async () => {
    const { ed } = makeEditor({ saveDxf: async (p) => p ?? '/w/b.dxf', chooseProjectPath: async () => '/w/p.jcadproj.json', saveProject: async (p) => {
      await tick();
      ed.doc.addEntities([text('TYPED DURING THE PROJECT SAVE')]); // the window is still usable
      return p;
    } });
    ed.loadState(new Drawing().snapshot, '/w/a.dxf');
    ed.doc.addEntities([text('A')]);
    ed.replaceProject({ name: 'P', drawings: [] }, true);
    const asked: string[][] = [];
    const answers: CloseDecision[] = [];
    const ok = await runCloseWorkflow(
      ed,
      {
        ask: async (items) => {
          asked.push(items.map((i) => i.key));
          const d: CloseDecision = asked.length === 1 ? { action: 'save', keys: new Set(items.map((i) => i.key)) } : { action: 'cancel' };
          answers.push(d);
          return d;
        },
        saveSymbol: async () => null,
        showError: async () => {},
      },
      () => false,
    );
    expect(asked).toHaveLength(2);
    expect(asked[1]).toEqual([`s${ed.sessions.current.id}`]); // only the drawing changed again
    expect(ok).toBe(false); // the user cancelled the second question: nothing is lost
    expect(ed.doc.dirty).toBe(true);
  });
  it('a completed save cannot change a replacement drawing or remove its recovery copy', async () => {
    const gate = deferred<void>();
    const { ed } = makeEditor({ saveDxf: async (path) => { await gate.promise; return path; } });
    ed.loadState(new Drawing().snapshot, '/w/a.dxf');
    ed.doc.addEntities([text('A')]);
    const completed: number[] = [];
    ed.hooks.drawingSaved = (id) => { completed.push(id); };
    const pending = ed.saveFile(false);
    await tick();
    ed.loadState(new Drawing({ entities: [text('B')] }).snapshot, '/w/b.dxf');
    gate.resolve();
    expect(await pending).toBe(true);
    expect(ed.doc.filePath).toBe('/w/b.dxf');
    expect(ed.doc.entities).toContainEqual(expect.objectContaining({ text: 'B' }));
    expect(ed.doc.dirty).toBe(false);
    expect(completed).toEqual([]);
  });
  it('Discard All covers only the revision shown before its dialog opened, including edit then undo', async () => {
    const { ed } = makeEditor();
    ed.doc.addEntities([text('A')]);
    const original = ed.doc.snapshot;
    const asked: string[][] = [];
    const ok = await runCloseWorkflow(ed, {
      ask: async (items) => {
        asked.push(items.map((it) => it.key));
        if (asked.length > 1) return { action: 'cancel' };
        ed.doc.addEntities([text('DURING DIALOG')]); ed.doc.undo();
        return { action: 'discard' };
      },
      saveSymbol: async () => null,
      showError: async () => {},
    }, () => false);
    expect(ed.doc.snapshot).toBe(original);
    expect(asked).toHaveLength(2);
    expect(ok).toBe(false);
    expect(ed.doc.dirty).toBe(true);
  });
  it('a project changed while its Discard dialog was open must be reviewed again', async () => {
    const { ed } = makeEditor();
    ed.replaceProject({ name: 'P', drawings: [] }, true);
    let asked = 0;
    const ok = await runCloseWorkflow(ed, {
      ask: async () => {
        if (++asked > 1) return { action: 'cancel' };
        ed.updateProject({ ...ed.project, description: 'CHANGED DURING DIALOG' });
        return { action: 'discard' };
      },
      saveSymbol: async () => null,
      showError: async () => {},
    }, () => false);
    expect(asked).toBe(2);
    expect(ok).toBe(false);
    expect(ed.projectDirty).toBe(true);
  });
  it('work changed while the close waits for autosaves is asked about; unchanged discarded work is not', async () => {
    const { ed } = makeEditor();
    ed.loadState(new Drawing().snapshot, '/w/a.dxf');
    ed.doc.addEntities([text('A')]);
    const asked: number[] = [];
    let settled = 0;
    const ok = await runCloseWorkflow(
      ed,
      {
        ask: async (items) => {
          asked.push(items.length);
          return { action: 'discard' };
        },
        saveSymbol: async () => null,
        showError: async () => {},
        settle: async () => {
          settled += 1;
          if (settled === 1) ed.doc.addEntities([text('LATE')]); // edited while the autosaves are flushed
        },
      },
      () => false,
    );
    expect(ok).toBe(true);
    expect(asked).toEqual([1, 1]); // asked again about the late edit, then discarded explicitly
    expect(settled).toBe(2);
  });
  it('CLOSE closes the tab it asked about, also when another tab closed while the question was shown', async () => {
    const { ed } = makeEditor();
    ed.loadState(new Drawing().snapshot, '/w/opening.dxf'); // stands in for a tab whose open fails meanwhile
    ed.sessions.add(new Drawing().snapshot, '/w/b.dxf');
    ed.doc.addEntities([text('B EDIT')]);
    const bId = ed.sessions.current.id;
    ed.sessions.add(new Drawing().snapshot, '/w/c.dxf');
    ed.doc.addEntities([text('C EDIT')]);
    const cId = ed.sessions.current.id;
    ed.switchSession(1);
    const discarded: number[] = [];
    const asked: string[] = [];
    const ok = await closeDrawingTab(ed.sessions, 1, {
      confirmDiscard: async (title) => {
        asked.push(title);
        ed.sessions.close(0); // the failed open closes its tab while the question is up
        return true;
      },
      discardBackup: (id) => discarded.push(id),
    });
    expect(ok).toBe(true);
    expect(asked).toEqual(['b.dxf']);
    expect(discarded).toEqual([bId]);
    expect(ed.sessions.indexOfId(bId)).toBe(-1);
    expect(ed.sessions.indexOfId(cId)).toBeGreaterThanOrEqual(0); // c.dxf and its edits are still open
    expect(ed.sessions.all.find((s) => s.id === cId)!.dirty).toBe(true);
  });
  it('CLOSE aborts when that drawing changed during confirmation and keeps its backup', async () => {
    const { ed } = makeEditor();
    ed.doc.addEntities([text('A')]);
    const id = ed.sessions.current.id;
    const removed: number[] = [], changed: string[] = [];
    expect(await closeDrawingTab(ed.sessions, 0, {
      confirmDiscard: async () => { ed.doc.addEntities([text('NEW')]); return true; },
      discardBackup: (session) => { removed.push(session); },
      changed: (title) => { changed.push(title); },
    })).toBe(false);
    expect(ed.sessions.indexOfId(id)).toBe(0);
    expect(ed.doc.entities).toContainEqual(expect.objectContaining({ text: 'NEW' }));
    expect(removed).toEqual([]);
    expect(changed).toHaveLength(1);
  });
  it('a Save As onto the file a queued save is about to write is written after it (seed 1596464263)', async () => {
    // The main process writes requests in arrival order (electron/main/app-data.cjs writeUserFile); here every
    // write waits until the test releases it, in the order the requests arrived.
    const disk = new Map<string, string>();
    const inFlight: Array<{ path: string; text: string; go: () => void }> = [];
    const { ed } = makeEditor({
      saveDxf: async (p, t) => {
        const path = p ?? '/w/x.dxf';
        await new Promise<void>((go) => inFlight.push({ path, text: t, go }));
        disk.set(path, t);
        return path;
      },
      chooseDrawingPath: async () => '/w/x.dxf',
    });
    const release = async () => {
      for (let i = 0; i < 20 && inFlight.length === 0; i += 1) await tick();
      inFlight.shift()!.go();
      await tick();
    };
    ed.loadState(new Drawing().snapshot, '/w/x.dxf');
    ed.doc.addEntities([text('A')]);
    const s1 = ed.saveFile(false); // a slow save (Save All while closing, or Ctrl+S)
    await tick();
    ed.doc.addEntities([text('B')]);
    const s2 = ed.saveFile(false); // queued behind it
    await tick();
    ed.doc.addEntities([text('C')]);
    const s3 = ed.saveFile(true); // Save As, the same file chosen in the dialog
    await release();
    await release();
    await release();
    expect(await Promise.all([s1, s2, s3])).toEqual([true, true, true]);
    expect(ed.doc.dirty).toBe(false);
    const onDisk = texts(readDxfState(disk.get('/w/x.dxf')!));
    expect(onDisk).toEqual(['A', 'B', 'C']); // the newest revision, which the drawing shows as saved
  });
});
