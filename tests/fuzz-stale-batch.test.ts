/**
 * Race fuzzing of the project-wide commands' commit step (src/app/commands-electrical.ts
 * loadProjectSheets / commitSheets): random projects (5-20 drawings, equal file names in
 * different folders, Windows and POSIX paths), random open tabs, and random events at every
 * await of the commit (files changed on disk, tabs edited / opened / closed / switched / saved,
 * backups failing in every answer shape, writes failing). Seeds are logged; replay with FUZZ_SEED.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import type { Entity } from '../src/core/entities';
import { newId } from '../src/core/entities';
import { writeDxf, readDxf } from '../src/io/dxf';
import { rawEntitiesOf } from '../src/io/import-report';
import { SessionManager } from '../src/app/sessions';
import type { Editor, BackupResult, LegacyBackupResult } from '../src/app/editor';
import { resolveDrawingPath, resolveProjectPath, type Project } from '../src/app/project';
import { loadProjectSheets, commitSheets, projectUi, runTitleBlocksAll, type SheetChange, type CommitResult } from '../src/app/commands-electrical';
import { newFromTemplate, SHEET_SIZES } from '../src/electrical/templates';
import { captureRevision, saveQueue } from '../src/app/savequeue';
import { pathKey, samePath, setPathPlatform } from '../src/app/paths';
import { Rng, fuzz, check, fuzzTimeout } from './helpers/fuzz';

const g = globalThis as { window?: unknown };
const orig = { ...projectUi };
beforeEach(() => {
  g.window = { jcad: {} };
});
afterEach(() => {
  delete g.window;
  Object.assign(projectUi, orig);
  setPathPlatform(null);
});

const text = (t: string): Entity => ({ id: newId(), layer: '0', color: 'ByLayer', type: 'text', position: { x: 1, y: 1 }, text: t, height: 0.2, rotation: 0, align: 'left' });
const has = (s: DrawingState, t: string) => s.entities.some((e) => e.type === 'text' && e.text === t);
const dxfHas = (dxf: string, t: string) => dxf.split(/\r?\n/).some((l) => l === t);

/** A model-space 3DFACE: an entity type JCad does not draw but keeps as a raw record. */
const face = (i: number) => ['0', '3DFACE', '8', 'SOLIDS', '10', String(7000 + i), '20', '0', '30', '0', '11', '1', '21', '0', '31', '0', '12', '1', '22', '1', '32', '0', '13', '0', '23', '1', '33', '0'].join('\n') + '\n';
function withFace(dxf: string, i: number): string {
  const m = /\n\s*2\r?\nENTITIES\r?\n/.exec(dxf);
  if (!m) throw new Error('no ENTITIES section');
  const at = m.index + m[0].length;
  return dxf.slice(0, at) + face(i) + dxf.slice(at);
}
/** Retained 3DFACE records in a DXF text (a cheap count; the reader keeps them as raw records, see the check below). */
const faces = (dxf: string) => dxf.split(/\r?\n/).filter((l) => l.trim() === '3DFACE').length;

/** A sheet with a title block is a large DXF (about 2 MB): written once, then labelled per drawing. */
let titleSheet: string | null = null;
function drawingText(label: string, rawFace: number | null, titleBlock = false): string {
  let dxf: string;
  if (titleBlock) {
    if (!titleSheet) {
      const d = new Drawing();
      d.load(newFromTemplate(SHEET_SIZES[0]!, {}));
      d.addEntities([text('LABEL-PLACEHOLDER')]);
      titleSheet = writeDxf(d.snapshot);
    }
    dxf = titleSheet.replace(/\nLABEL-PLACEHOLDER\r?\n/, `\n${label}\n`);
  } else {
    const d = new Drawing();
    d.addEntities([text(label)]);
    dxf = writeDxf(d.snapshot);
  }
  return rawFace === null ? dxf : withFace(dxf, rawFace);
}

interface World {
  editor: Editor;
  sessions: SessionManager;
  doc: Drawing;
  disk: Map<string, string>;
  /** key -> seq of every change to the file after the command read it. */
  mutations: Array<{ key: string; seq: number; source: 'ext' | 'tab' | 'cmd' }>;
  violations: string[];
}

type Phase = 'confirm' | 'backup' | 'noBackup' | 'reread' | 'write';

/** synthetic: commitSheets with random changes; titleblocks: the real AETITLEBLOCK project command. */
async function batchScenario(rng: Rng, mode: 'synthetic' | 'titleblocks' = 'synthetic'): Promise<void> {
  const real = mode === 'titleblocks';
  const win = rng.bool(0.4);
  setPathPlatform(win ? 'win32' : 'linux');
  const projectPath = win ? 'C:\\Jobs\\P\\p.jcadproj.json' : '/jobs/p/p.jcadproj.json';
  // ------------------------------------------------------------ project: 5-20 drawings, colliding names
  const folders = ['', 'line1', 'line2', 'sub/deep', win ? 'LINE1' : 'Line1', '../shared'];
  const bases = ['a.dxf', 'b.dxf', 'c.dxf', win ? 'A.DXF' : 'A.dxf', 'x.dwg'];
  const entries: string[] = [];
  const target = real ? rng.int(4, 6) : rng.int(5, 20); // title block sheets are slow to read and write
  for (let tries = 0; entries.length < target && tries < 200; tries += 1) {
    const f = rng.pick(folders);
    const b = rng.pick(bases);
    let e = f ? `${f}/${b}` : b;
    if (win && rng.bool(0.3)) e = e.replace(/\//g, '\\');
    if (rng.bool(0.1)) e = `./${e}`;
    const at = { name: 'P', path: projectPath, drawings: [] };
    if (rng.bool(0.08)) e = resolveProjectPath(at, e); // absolute entry
    const p = resolveProjectPath(at, e);
    if (entries.some((x) => samePath(resolveProjectPath(at, x), p))) continue;
    entries.push(e);
  }
  const project: Project = { name: 'P', path: projectPath, drawings: entries.map((file) => ({ file })) };
  const paths = project.drawings.map((d) => resolveDrawingPath(project, d));
  // ------------------------------------------------------------ disk and tabs
  const disk = new Map<string, string>();
  const original = new Map<string, string>();
  paths.forEach((p, i) => {
    if (rng.bool(0.08)) return; // missing file
    const t = drawingText(`SHEET-${i}`, rng.bool(0.5) ? i : null, real);
    disk.set(pathKey(p), t);
    original.set(pathKey(p), t);
  });
  const doc = new Drawing();
  const host = { doc, viewport: { center: { x: 0, y: 0 }, scale: 1 }, selection: new Set<string>(), loadState: (s: DrawingState, p: string | null) => doc.load(s, p) };
  const sessions = new SessionManager(host);
  const spellOpen = (p: string) => (win && rng.bool(0.5) ? p.toLowerCase().replace(/\\/g, '/') : p);
  const openable = paths.filter((p) => disk.has(pathKey(p)) && !/\.dwg$/i.test(p));
  const toOpen = rng.shuffle(openable).slice(0, rng.int(0, Math.min(4, openable.length)));
  toOpen.forEach((p, i) => {
    const state = readDxf(disk.get(pathKey(p))!);
    if (i === 0 && rng.bool(0.6)) {
      doc.load(state, spellOpen(p));
    } else sessions.add(state, spellOpen(p));
  });
  if (sessions.count > 1) sessions.switchTo(rng.int(0, sessions.count - 1));
  // ------------------------------------------------------------ bridge with chaos at every await
  let seq = 0;
  const mutations: World['mutations'] = [];
  const violations: string[] = [];
  const tabEdits: Array<{ sessionId: number; label: string }> = [];
  const closedTabs = new Set<number>(); // closed by an event (a change applied before is gone with the tab)
  const backupAnswer = new Map<string, 'ok' | 'failed'>();
  const noBackupAnswer = new Map<string, boolean>();
  const cmdWrites = new Map<number, string>(); // sheet index -> key written
  let loaded = false;
  let editN = 0;
  const logs: string[] = [];

  const chaos = async (phase: Phase): Promise<void> => {
    if (!loaded) return;
    const n = rng.weighted([
      [6, 0],
      [3, 1],
      [1, 2],
    ]);
    for (let k = 0; k < n; k += 1) {
      const ev = rng.pick(['ext', 'ext', 'tabEdit', 'openTab', 'closeTab', 'switch', 'tabSave'] as const);
      editN += 1;
      if (ev === 'ext') {
        const keys = [...disk.keys()];
        if (!keys.length) continue;
        const key = rng.pick(keys);
        disk.set(key, drawingText(`EXT-${editN}`, null));
        mutations.push({ key, seq: (seq += 1), source: 'ext' });
      } else if (ev === 'tabEdit') {
        const i = rng.int(0, sessions.count - 1);
        const label = `TAB-${editN}`;
        if (i === sessions.active) doc.addEntities([text(label)]);
        else {
          const s = sessions.all[i]!;
          s.undo.push(s.state);
          s.state = { ...s.state, entities: [...s.state.entities, text(label)] };
          s.dirty = true;
        }
        tabEdits.push({ sessionId: sessions.all[i]!.id, label });
      } else if (ev === 'openTab') {
        const closed = paths.filter((p) => disk.has(pathKey(p)) && !/\.dwg$/i.test(p) && sessions.indexOfPath(p) < 0);
        if (!closed.length) continue;
        const p = rng.pick(closed);
        const before = sessions.active;
        sessions.add(readDxf(disk.get(pathKey(p))!), spellOpen(p));
        if (rng.bool()) sessions.switchTo(before);
      } else if (ev === 'closeTab') {
        if (sessions.count < 2) continue;
        const i = rng.pick([...Array(sessions.count).keys()].filter((x) => x !== sessions.active));
        closedTabs.add(sessions.all[i]!.id);
        sessions.close(i);
      } else if (ev === 'switch') {
        if (sessions.count > 1) sessions.switchTo(rng.int(0, sessions.count - 1));
      } else {
        const withPath = sessions.all.filter((s) => s.filePath);
        if (!withPath.length) continue;
        const s = rng.pick(withPath);
        const state = sessions.all.find((x) => x.id === s.id)!.state;
        const p = s.filePath!;
        await saveQueue.run(p, captureRevision(), async () => {
          disk.set(pathKey(p), writeDxf(state));
          mutations.push({ key: pathKey(p), seq: (seq += 1), source: 'tab' });
          return p;
        });
      }
    }
    void phase;
  };

  const backupShapes: Array<() => BackupResult | LegacyBackupResult> = [
    () => ({ ok: false, code: 'EACCES', error: 'EACCES: permission denied' }),
    () => ({ ok: false, code: 'ENOSPC', error: '' }),
    () => null,
    () => false,
    () => undefined as unknown as LegacyBackupResult,
  ];
  const editor = {
    doc,
    sessions,
    project,
    hooks: {},
    fileBridge: {
      openDxf: async () => null,
      openDrawing: async (p: string) => {
        await chaos('reread');
        const t = disk.get(pathKey(p));
        if (t === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' });
        if (/\.dwg$/i.test(p)) return { path: p, kind: 'dwg' as const, payload: new Uint8Array(4) };
        return { path: p, kind: 'dxf' as const, text: t };
      },
      saveDxf: async (p: string | null, t: string) => {
        if (!p) return null;
        const key = pathKey(p);
        // Checked when the command sends the write; what happens while it is on its way cannot be prevented here.
        const m = /\nCHG-(\d+)\r?\n/.exec(t);
        const sheet = m ? Number(m[1]) : real ? paths.findIndex((x) => samePath(x, p)) : -1;
        // ---- the invariants of a command write
        if (sheet < 0) violations.push(`wrote ${p} without a change of its own`);
        const changedAfterRead = mutations.some((x) => x.key === key);
        if (changedAfterRead) violations.push(`overwrote ${p} (sheet ${sheet}) although it changed after it was read (${mutations.filter((x) => x.key === key).map((x) => x.source).join(', ')})`);
        if (sessions.indexOfPath(p) >= 0) violations.push(`wrote ${p} while it is open in a tab`);
        if (backupAnswer.get(key) === 'failed' && noBackupAnswer.get(key) !== true) violations.push(`wrote ${p} after its backup failed without "Continue Without Backup"`);
        const before = original.get(key);
        if (before && faces(t) !== faces(before)) violations.push(`${p}: ${faces(before)} retained 3DFACE record(s) before, ${faces(t)} written`);
        const own = before && /\nSHEET-\d+\r?\n/.exec(before)?.[0].trim();
        if (own && !dxfHas(t, own)) violations.push(`${p}: the write lost the drawing's own content (${own})`);
        await chaos('write');
        if (rng.bool(0.05)) throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' });
        disk.set(key, t);
        mutations.push({ key, seq: (seq += 1), source: 'cmd' });
        if (cmdWrites.has(sheet)) violations.push(`sheet ${sheet} written twice`);
        cmdWrites.set(sheet, key);
        return p;
      },
      backupFile: rng.bool(0.85)
        ? async (p: string) => {
            await chaos('backup');
            const key = pathKey(p);
            if (rng.bool(0.25)) {
              backupAnswer.set(key, 'failed');
              if (rng.bool(0.2)) throw new Error('EIO: i/o error');
              return rng.pick(backupShapes)();
            }
            backupAnswer.set(key, 'ok');
            return rng.pick<() => BackupResult | LegacyBackupResult>([() => ({ ok: true, path: `${p}.bak` }), () => `${p}.bak`, () => true])();
          }
        : undefined,
    },
    fileName: () => 'active.dxf',
    log: (t: string) => logs.push(t),
    notify: () => {},
  } as unknown as Editor;

  let choseFiles = true;
  let backupRequested = false;
  projectUi.confirmFiles = async (_t, _i, _items, opts) => {
    loaded = true;
    await chaos('confirm');
    if (rng.bool(0.05)) return null;
    choseFiles = rng.bool(0.85);
    backupRequested = opts.backupAvailable && rng.bool(0.75);
    return { files: choseFiles, backup: backupRequested };
  };
  projectUi.confirmNoBackup = async (_name, p) => {
    await chaos('noBackup');
    const go = rng.bool(0.4);
    noBackupAnswer.set(pathKey(p), go);
    return go;
  };
  // ------------------------------------------------------------ the command
  if (real) {
    await runTitleBlocksAll(editor);
    const ctx = () => `win=${win}; ${paths.length} drawings; logs ${JSON.stringify(logs)}`;
    check(violations.length === 0, () => `${violations.join('; ')} (${ctx()})`);
    for (const e of tabEdits) {
      const i = sessions.indexOfId(e.sessionId);
      if (i < 0) continue;
      check(has(i === sessions.active ? doc.snapshot : sessions.all[i]!.state, e.label), () => `tab edit ${e.label} lost (${ctx()})`);
    }
    for (const [key, t] of original) {
      if (mutations.some((m) => m.key === key)) continue;
      check(disk.get(key) === t, () => `${key} changed without a recorded write`);
    }
    // (Raw records and the drawing's own content are checked on every write, in saveDxf.)
    commandWrites += cmdWrites.size;
    return;
  }
  const { sheets } = await loadProjectSheets(editor);
  loaded = true;
  const changes = new Map<number, SheetChange>();
  for (const [i, sh] of rng.shuffle([...sheets.entries()])) {
    if (!rng.bool(0.7)) continue;
    const s = sh.doc.snapshot;
    changes.set(i, { state: { ...s, entities: [...s.entities, text(`CHG-${i}`)] }, detail: 'fuzz' });
  }
  const r: CommitResult | null = await commitSheets(editor, sheets, changes, 'Fuzz', 'fuzz', rng.bool(0.3));
  // ------------------------------------------------------------ invariants
  const ctx = () => `win=${win}; ${sheets.length} sheets (${sheets.map((s, i) => `${i}:${s.source}${changes.has(i) ? '*' : ''}`).join(' ')}); result ${JSON.stringify(r)}; logs ${JSON.stringify(logs)}`;
  check(violations.length === 0, () => `${violations.join('; ')} (${ctx()})`);
  // Edits made in tabs while the command ran are never lost.
  for (const e of tabEdits) {
    const i = sessions.indexOfId(e.sessionId);
    if (i < 0) continue;
    const state = i === sessions.active ? doc.snapshot : sessions.all[i]!.state;
    check(has(state, e.label), () => `tab edit ${e.label} lost (${ctx()})`);
  }
  // Untouched drawings: byte-identical on disk.
  for (const [key, t] of original) {
    if (mutations.some((m) => m.key === key)) continue;
    check(disk.get(key) === t, () => `${key} changed without a recorded write`);
  }
  if (!r) {
    check(cmdWrites.size === 0, 'cancelled but written');
    for (const [i] of changes) {
      const sh = sheets[i]!;
      if (sh.source === 'file') continue;
      const k = sessions.indexOfId(sh.sessionId!);
      if (k >= 0) check(!has(k === sessions.active ? doc.snapshot : sessions.all[k]!.state, `CHG-${i}`), 'cancelled but applied');
    }
    return;
  }
  // Every change appears exactly once in the outcome.
  let openApplied = 0;
  let closedAfterApply = 0;
  for (const [i] of changes) {
    const sh = sheets[i]!;
    const named = (list: string[]) => list.filter((x) => x === sh.name || x.startsWith(`${sh.name} (`)).length;
    let applied = 0;
    if (sh.source !== 'file') {
      const k = sessions.indexOfId(sh.sessionId!);
      if (k >= 0 && has(k === sessions.active ? doc.snapshot : sessions.all[k]!.state, `CHG-${i}`)) applied = 1;
      openApplied += applied;
    }
    const written = cmdWrites.has(i) ? 1 : 0;
    const count = applied + written + named(r.failed) + named(r.conflicts) + named(r.notSaved);
    const gone = sh.sessionId !== undefined && closedTabs.has(sh.sessionId) && count === 0;
    if (gone) closedAfterApply += 1;
    check(count === 1 || gone, () => `sheet ${i} (${sh.name}, ${sh.source}) appears ${count} times in the outcome (applied ${applied}, written ${written}) (${ctx()})`);
  }
  check(r.open >= openApplied && r.open <= openApplied + closedAfterApply, () => `open count ${r.open} but ${openApplied} applied (${ctx()})`);
  check(r.written === cmdWrites.size, () => `written count ${r.written} but ${cmdWrites.size} writes (${ctx()})`);
  // Backups only when asked for, and only of files that are written.
  if (!backupRequested) check(backupAnswer.size === 0, 'backup made although not requested');
}

let commandWrites = 0;

describe('fuzz: project-wide commands never overwrite newer work', () => {
  it('the generated drawings carry a retained raw 3DFACE record the reader keeps and the writer writes back', () => {
    for (const tb of [false, true]) {
      const dxf = drawingText('SHEET-1', 3, tb);
      const state = readDxf(dxf);
      expect(rawEntitiesOf(state).map((r) => r.type)).toEqual(['3DFACE']);
      expect(faces(dxf)).toBe(1);
      expect(faces(writeDxf(state))).toBe(1);
    }
  });
  it('random projects, tabs, disk edits, backups and failures through loadProjectSheets + commitSheets', async () => {
    const runs = await fuzz('stale-batch/commit', 100, (rng) => batchScenario(rng, 'synthetic'));
    expect(runs).toBeGreaterThan(0);
  }, fuzzTimeout());
  it('the real project title block command (AETITLEBLOCK for all drawings) under the same events keeps retained records', async () => {
    commandWrites = 0;
    // Each run reads and writes several 2 MB sheets: few runs by default (FUZZ_RUNS=20 for a soak).
    await fuzz('stale-batch/titleblocks', 3, (rng) => batchScenario(rng, 'titleblocks'));
    if (!process.env.FUZZ_SEED) expect(commandWrites).toBeGreaterThan(0); // the property exercised real writes
  }, fuzzTimeout());
});
