/**
 * Race fuzzing of R1 + R2 together over a real Editor: random sequences of edits, autosave ticks,
 * Save / Save As, tab switches, new / closed tabs, project edits and saves, Save All close requests
 * (Save All, a subset, Discard All, Cancel) and crashes, under fake timers. The drawing files go
 * through a fake main process (dialogs, per-file write order like electron/main.cjs writeUserFile,
 * failures); autosaves go through the real electron/autosave-store.cjs + atomic-write.cjs over an
 * in-memory file system behind an ordered IPC channel. Seeds are logged; replay with FUZZ_SEED.
 *
 * Invariants:
 *  - a drawing (and the project) is never marked clean unless that revision is the file on disk;
 *  - after a crash at any point, every modified drawing that had been autosaved (or was opened from
 *    a backup) can be recovered from the next launch's store, and a modified project that had been
 *    autosaved is offered by project recovery;
 *  - an approved close leaves nothing unsaved that the user did not choose to discard;
 *  - no two autosave writes (or a write and a remove) of one backup overlap.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import type { Editor as EditorType, FileBridge } from '../src/app/editor';
import type { DrawingState } from '../src/core/document';
import type { Entity } from '../src/core/entities';
import { newId } from '../src/core/entities';
import { writeDxf } from '../src/io/dxf';
import { withoutUnusedLibraryBlocks } from '../src/electrical/library';
import { Autosaver, type AutosaveStore, type AutosaveEntry, type AutosaveMeta } from '../src/app/autosave';
import { ProjectAutosaver, drawingAutosaves, offerProjectRecovery, isProjectAutosave } from '../src/app/project-autosave';
import { runCloseWorkflow, type CloseDecision, type UnsavedItem } from '../src/app/closeflow';
import { serializeProject } from '../src/app/project';
import { pathKey } from '../src/app/paths';
import { Rng, fuzz, check } from './helpers/fuzz';
import { MemFs } from './helpers/memfs';

const require = createRequire(import.meta.url);
type Store = { write(n: string, t: string, m: unknown): Promise<void>; list(): Promise<AutosaveEntry[]>; read(n: string): Promise<string | null>; remove(n: string): Promise<void> };
const { createAutosaveStore } = require('../electron/autosave-store.cjs') as { createAutosaveStore(dir: string, deps?: { fs?: unknown; writer?: unknown; uuid?: () => string }): Store };
const { createAtomicWriter } = require('../electron/atomic-write.cjs') as { createAtomicWriter(fs?: unknown, options?: { platform?: string; renameDelays?: number[] }): unknown };

let Editor: typeof EditorType;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
});
afterEach(() => {
  vi.useRealTimers();
});
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;
const text = (t: string): Entity => ({ id: newId(), layer: '0', color: 'ByLayer', type: 'text', position: { x: 0, y: 0 }, text: t, height: 0.2, rotation: 0, align: 'left' });
const dxfOf = (s: DrawingState) => writeDxf(withoutUnusedLibraryBlocks(s));
const DIR = '/appdata/autosave';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Options {
  /** Model electron/main.cjs writeUserFile (one write per file, arrival order); false = the code before it. */
  mainWriteOrder: boolean;
}

async function scenario(rng: Rng, opts: Options): Promise<{ closed: boolean; crashed: boolean }> {
  const violations: string[] = [];
  const trace: string[] = [];
  const fail = (m: string) => violations.push(m);
  // ------------------------------------------------------------ fake main process: drawing / project files
  const disk = new Map<string, string>();
  const known = new Set<string>();
  let crashed = false;
  const tails = new Map<string, Promise<unknown>>();
  const mainWrite = (key: string, data: string, ms: number): Promise<void> => {
    const job = async () => {
      await sleep(ms);
      if (crashed) throw new Error('crashed');
      if (rng.bool(0.05)) throw Object.assign(new Error(`EACCES: permission denied, open '${key}'`), { code: 'EACCES' });
      disk.set(key, data);
    };
    if (!opts.mainWriteOrder) return job();
    const run = (tails.get(key) ?? Promise.resolve()).then(job, job);
    tails.set(key, run.catch(() => undefined));
    return run;
  };
  let modal = 0;
  /** A modal dialog: while it is open the user cannot edit, switch tabs or start commands. */
  const dialog = async <T>(fn: () => T, opened = false): Promise<T> => {
    if (!opened) modal += 1;
    try {
      await sleep(rng.int(1, 40));
      return fn();
    } finally {
      modal -= 1;
    }
  };
  let editor!: EditorType;
  const bridge: FileBridge = {
    openDxf: async () => null,
    saveDxf: async (path, data, suggest) => {
      // The Save dialog suggests the drawing's own name; each drawing picks from its own two names
      // (or its current file): Save As onto a file open in another tab is not part of this model.
      const base = suggest.replace(/^(alt-)+/, '').replace(/[\\/]/g, '_');
      const own = editor.doc.filePath; // Save As runs right away for the active drawing
      const current = path ?? (own && own.split('/').pop() === suggest ? own : null);
      let target = path && known.has(pathKey(path)) ? path : null;
      if (!target) modal += 1; // the main process shows the Save dialog as soon as the request arrives
      await sleep(rng.int(0, 3));
      if (!target) {
        // Save As: often the drawing's own file again (overwrite), else one of the tab's two names.
        target = await dialog(() => (rng.bool(0.1) ? null : current && rng.bool(0.5) ? current : rng.pick([`/d/${base}`, `/d/alt-${base}`])), true);
        if (!target) return null;
      }
      // Most writes are quick; some are slow (a network drive), so later saves overtake them.
      const lab = data.split(/\r?\n/).filter((l) => /^E\d+$/.test(l)).join('+') || '-';
      trace.push(`[t${Date.now() % 100000} send ${path ?? 'null'}->${target} ${lab}]`);
      await mainWrite(pathKey(target), data, rng.bool(0.3) ? rng.int(40, 150) : rng.int(0, 10));
      known.add(pathKey(target));
      trace.push(`[t${Date.now() % 100000} landed ${target} ${lab}]`);
      return target;
    },
    chooseProjectPath: async () => {
      const p = await dialog(() => (rng.bool(0.1) ? null : `/d/project-${rng.int(0, 1)}.jcadproj.json`));
      if (p) known.add(pathKey(p));
      return p;
    },
    saveProject: async (path, data) => {
      await sleep(rng.int(0, 3));
      if (!known.has(pathKey(path))) throw new Error('Unknown project path');
      await mainWrite(pathKey(path), data, rng.int(0, 30));
      return path;
    },
  };
  // ------------------------------------------------------------ the recovery store behind an ordered IPC channel
  const fs = new MemFs(rng);
  let launch = 0;
  const makeStore = () => {
    launch += 1;
    let n = 0;
    const l = launch;
    return createAutosaveStore(DIR, { fs, writer: createAtomicWriter(fs, { platform: 'linux', renameDelays: [0] }), uuid: () => `00000000-0000-4000-8${l}00-${String((n += 1)).padStart(12, '0')}` });
  };
  let main = makeStore();
  let lastDelivery = 0;
  const ipc = <T>(fn: () => Promise<T>): Promise<T> => {
    // Requests reach the main process in the order they were sent; answers come back when done.
    const at = Math.max(lastDelivery, Date.now() + rng.int(0, 5));
    lastDelivery = at;
    return new Promise<T>((resolve, reject) => {
      setTimeout(() => {
        if (crashed) return; // the process is gone: no answer ever comes
        fn().then(
          (v) => setTimeout(() => !crashed && resolve(v), rng.int(0, 5)),
          (e) => setTimeout(() => !crashed && reject(e), rng.int(0, 5)),
        );
      }, at - Date.now());
    });
  };
  /** Autosave texts sent per backup name, in order, and which of them completed. */
  const sent = new Map<string, string[]>();
  const busy = new Map<string, string>();
  const projectWritesDone: Array<{ at: number; name: string }> = [];
  const guard = async <T>(name: string, what: string, fn: () => Promise<T>): Promise<T> => {
    const other = busy.get(name);
    if (other && (what === 'write' || other === 'write')) fail(`overlapping autosave ${other} and ${what} of ${name}`);
    busy.set(name, what);
    try {
      return await fn();
    } finally {
      if (busy.get(name) === what) busy.delete(name);
    }
  };
  const raw: AutosaveStore = {
    write: (n: string, t: string, m: AutosaveMeta) => {
      sent.set(n, [...(sent.get(n) ?? []), t]);
      return guard(n, 'write', () => ipc(() => main.write(n, t, m))).then(() => {
        if (isProjectAutosave(n)) projectWritesDone.push({ at: Date.now(), name: n });
      });
    },
    list: () => ipc(() => main.list()),
    read: (n) => ipc(() => main.read(n)),
    remove: (n) => guard(n, 'remove', () => ipc(() => main.remove(n))),
  };
  // ------------------------------------------------------------ the app (as src/main.ts wires it)
  editor = new Editor(canvas());
  editor.ui = {
    pickSymbol: async () => null,
    editComponent: async (init) => ({ tag: init.tag, desc: init.desc, mfg: '', cat: '' }),
    ladderSettings: async (init) => init,
    textInput: async (_t, _l, init) => init,
    confirm: async () => true,
  };
  editor.fileBridge = bridge;
  const autosaver = new Autosaver(editor.sessions, drawingAutosaves(raw), () => 1);
  autosaver.onError = () => {};
  editor.hooks.drawingSaved = (sessionId, state) => void autosaver.markSaved(sessionId, state);
  editor.on('file', () => {
    if (!editor.doc.dirty && editor.doc.filePath) void autosaver.markSaved(editor.sessions.activeId, editor.doc.snapshot);
  });
  const projectAutosaver = new ProjectAutosaver(editor, raw, () => true, 1500);
  projectAutosaver.onError = () => {};
  let projectDirtySince: number | null = null;
  editor.on('project', () => {
    if (editor.projectDirty && projectDirtySince === null) projectDirtySince = Date.now();
    if (!editor.projectDirty) projectDirtySince = null;
  });
  // A drawing recovered from an earlier launch's backup (src/ui/recovery.ts openRecovered).
  const recovered = new Map<number, string>();
  if (rng.bool(0.3)) {
    const name = '99999999-9999-4999-8999-999999999999.sv.dxf';
    const st = (() => {
      const d = new (editor.doc.constructor as new () => typeof editor.doc)();
      d.addEntities([text('RECOVERED')]);
      return d.snapshot;
    })();
    fs.put(`${DIR}/${name}`, dxfOf(st));
    sent.set(name, [dxfOf(st)]);
    const idx = editor.sessions.add(st, rng.bool() ? '/d/orig.dxf' : null, true);
    const id = editor.sessions.all[idx]!.id;
    autosaver.adopt(id, name);
    recovered.set(id, name);
  }
  // ------------------------------------------------------------ invariants checked between steps
  const checkClean = (where: string) => {
    for (const s of editor.sessions.all) {
      if (s.dirty || !s.filePath || !known.has(pathKey(s.filePath))) continue;
      const labels = (t: string | undefined) => (t ?? '').split(/\r?\n/).filter((l) => /^(E\d+|RECOVERED)$/.test(l)).join('+') || '-';
      if (disk.get(pathKey(s.filePath)) !== dxfOf(s.state)) fail(`${where}: session ${s.id} is clean but ${s.filePath} on disk is another revision (disk ${labels(disk.get(pathKey(s.filePath)))}, drawing ${labels(dxfOf(s.state))})`);
    }
    if (!editor.projectDirty && editor.project.path && disk.has(pathKey(editor.project.path)) && disk.get(pathKey(editor.project.path)) !== serializeProject(editor.project)) {
      fail(`${where}: the project is clean but ${editor.project.path} holds another revision`);
    }
  };
  // ------------------------------------------------------------ random operations
  let closing: Promise<boolean> | null = null;
  let closed = false;
  let decision: CloseDecision | null = null;
  let asked: readonly UnsavedItem[] = [];
  /** Item key -> the revision the user chose not to save (the close may drop exactly that). */
  const discardedAt = new Map<string, unknown>();
  const revisionOf = (key: string): unknown => (key === 'project' ? editor.project : editor.sessions.all.find((s) => `s${s.id}` === key)?.state);
  let edits = 0;
  const steps = rng.int(5, 40);
  for (let step = 0; step < steps && !closed && !crashed; step += 1) {
    await vi.advanceTimersByTimeAsync(rng.int(0, 60));
    if (closed) break;
    const op = rng.weighted<string>([
      [8, 'edit'],
      [4, 'tick'],
      [4, 'save'],
      [2, 'saveAs'],
      [2, 'switch'],
      [1, 'newTab'],
      [1, 'closeTab'],
      [2, 'projectEdit'],
      [1, 'projectSave'],
      [2, 'close'],
      [0.4, 'crash'],
    ]);
    trace.push(`${step}:${op}@t${Date.now() % 100000}${modal ? '(modal)' : ''}`);
    if (op === 'tick') void autosaver.runNow();
    else if (op === 'crash') {
      crashed = true;
      fs.crashAt = 0;
      fs.crashed = true;
    } else if (modal > 0) {
      continue; // a dialog is open: the user cannot edit, switch or start commands
    } else if (op === 'edit') {
      edits += 1;
      editor.doc.addEntities([text(`E${edits}`)]);
    } else if (op === 'save') void editor.saveFile(false);
    else if (op === 'saveAs') void editor.saveFile(true);
    else if (op === 'switch') {
      if (editor.sessions.count > 1) editor.switchSession(rng.int(0, editor.sessions.count - 1));
    } else if (op === 'newTab') editor.sessions.add();
    else if (op === 'closeTab') {
      // src/main.ts closeTab (runs on its own; the loop goes on while its question is open)
      const i = rng.int(0, editor.sessions.count - 1);
      const id = editor.sessions.all[i]!.id;
      const dirty = editor.sessions.isDirty(i);
      void (async () => {
        const discard = !dirty || (await dialog(() => rng.bool()));
        const k = editor.sessions.indexOfId(id);
        if (discard && k >= 0 && !crashed) {
          void autosaver.discardFor(id);
          editor.sessions.close(k);
          recovered.delete(id);
        }
      })();
    } else if (op === 'projectEdit') {
      edits += 1;
      editor.updateProject({ ...editor.project, descriptions: [`D${edits}`] });
    } else if (op === 'projectSave') void editor.saveProject(rng.bool(0.2));
    else if (op === 'close' && !closing) {
      closing = runCloseWorkflow(
        editor,
        {
          ask: (items) => {
            asked = items;
            return dialog(() => {
              const pick = rng.weighted<CloseDecision['action'] | 'subset'>([
                [4, 'save'],
                [2, 'subset'],
                [2, 'discard'],
                [2, 'cancel'],
              ]);
              const d: CloseDecision =
                pick === 'subset'
                  ? { action: 'save', keys: new Set(items.filter(() => rng.bool()).map((x) => x.key)) }
                  : pick === 'save'
                    ? { action: 'save', keys: new Set(items.map((x) => x.key)) }
                    : { action: pick };
              decision = d;
              // What the user chose not to save: exactly the revision shown.
              for (const it of items) {
                if (d.action === 'discard' || (d.action === 'save' && !d.keys.has(it.key))) discardedAt.set(it.key, revisionOf(it.key));
              }
              return d;
            });
          },
          saveSymbol: async () => null,
          showError: () => dialog(() => undefined),
          settle: async () => {
            await Promise.allSettled([projectAutosaver.flush(), autosaver.flush()]);
          },
        },
        () => false,
      )
        .then((ok) => {
          closing = null;
          if (!ok || crashed) return ok;
          closed = true;
          // ---- an approved close: nothing unsaved that the user did not discard
          const d = decision as CloseDecision | null;
          const discarded = (key: string) => discardedAt.has(key) && discardedAt.get(key) === revisionOf(key);
          editor.sessions.all.forEach((s, i) => {
            if (editor.sessions.isDirty(i) && !discarded(`s${s.id}`)) fail(`close approved with unsaved drawing ${editor.sessions.titleOf(i)} (session ${s.id}, last answer ${d ? d.action : 'none'}, asked ${asked.map((x) => x.key).join(',')})`);
          });
          if (editor.projectDirty && !discarded('project')) fail(`close approved with the project unsaved (${d ? d.action : 'no question'})`);
          return ok;
        });
    }
    if (!crashed) checkClean(`after ${op}`);
  }
  // ------------------------------------------------------------ crash: what the next launch can recover
  if (!closed && !crashed && rng.bool(0.5)) {
    crashed = true;
    fs.crashed = true;
  }
  if (crashed) {
    const atCrash = editor.sessions.all.map((s, i) => ({ id: s.id, dirty: editor.sessions.isDirty(i), backedUp: autosaver.backedUpState(s.id), name: autosaver.nameFor(s.id) }));
    const projectDirty = editor.projectDirty;
    const since = projectDirtySince;
    const crashTime = Date.now();
    await vi.runAllTimersAsync();
    fs.restart();
    main = makeStore();
    const store2: AutosaveStore = { write: (n, t, m) => main.write(n, t, m), list: () => main.list(), read: (n) => main.read(n), remove: (n) => main.remove(n) };
    let listed: AutosaveEntry[] = [];
    try {
      listed = await drawingAutosaves(store2).list();
    } catch (err) {
      fail(`the next launch cannot list the backups: ${String(err)}`);
    }
    for (const s of atCrash) {
      if (!s.dirty) continue;
      const name = s.name;
      // Never autosaved (and not holding the backup it was recovered from, which a save releases): nothing to promise.
      const holdsRecovered = recovered.has(s.id) && name === recovered.get(s.id);
      if (s.backedUp === undefined && !holdsRecovered) continue;
      if (!name || !listed.some((e) => e.name === name)) {
        fail(`session ${s.id} was modified and autosaved, but its backup ${name} is gone after the crash`);
        continue;
      }
      const t = await store2.read(name);
      const texts = sent.get(name) ?? [];
      const from = s.backedUp ? texts.lastIndexOf(dxfOf(s.backedUp)) : 0;
      if (t === null || from < 0 || !texts.slice(from).includes(t)) fail(`session ${s.id}: the backup ${name} holds an older or foreign revision after the crash`);
    }
    if (projectDirty && since !== null && projectWritesDone.some((w) => w.at >= since && w.at <= crashTime)) {
      const got: string[] = [];
      await offerProjectRecovery({ projectDirty: false, replaceProject: (p) => got.push(p.name), log: () => {} }, store2, async () => 'later');
      const entries = (await store2.list()).filter((e) => isProjectAutosave(e.name));
      if (entries.length === 0) fail('the project was modified and autosaved, but no project autosave survives the crash');
    }
  } else {
    await vi.runAllTimersAsync();
    if (!closed) checkClean('at rest');
  }
  check(violations.length === 0, () => `${[...new Set(violations)].join('; ')}\n  trace: ${trace.join(' ')}`);
  return { closed, crashed };
}

describe('fuzz: autosave, Save, Save As, Save All and crashes together', () => {
  it('a drawing is clean only when on disk, autosaved work survives crashes, close keeps what was not discarded', async () => {
    vi.useFakeTimers();
    let closed = 0;
    let crashed = 0;
    const runs = await fuzz('save-close/editor', 300, async (rng) => {
      const r = await scenario(rng, { mainWriteOrder: process.env.FUZZ_NO_MAIN_ORDER ? false : true });
      if (r.closed) closed += 1;
      if (r.crashed) crashed += 1;
    });
    console.log(`save-close/editor: ${runs} runs, ${closed} approved closes, ${crashed} crashes`);
    expect(runs).toBeGreaterThan(0);
  }, 600_000);
});
