/**
 * Crash and fault fuzzing of the recovery store (electron/autosave-store.cjs) and of crash-safe
 * writes (electron/atomic-write.cjs) over an in-memory file system (tests/helpers/memfs.ts):
 * a crash at any file system call, injected failures (EIO, ENOSPC, EPERM / EBUSY renames that
 * fail safely after rename retries), then a new launch. Seeds are logged; replay with FUZZ_SEED.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { Rng, fuzz, check, fuzzTimeout } from './helpers/fuzz';
import { MemFs, CrashError, fsError } from './helpers/memfs';

const require = createRequire(import.meta.url);
type Entry = { name: string; title: string; originalPath: string | null; savedAt: number };
type Store = {
  migrated: Array<[string, string]>;
  ensure(): Promise<void>;
  write(name: string, text: string, meta: unknown): Promise<void>;
  list(): Promise<Entry[]>;
  read(name: string): Promise<string | null>;
  remove(name: string): Promise<void>;
};
type Writer = {
  atomicWriteFile(file: string, data: string, opts?: { backup?: boolean }): Promise<{ path: string; backup: string | null; method: string }>;
  copyFileAtomic(src: string, dest: string): Promise<string>;
};
const { createAutosaveStore } = require('../electron/autosave-store.cjs') as { createAutosaveStore(dir: string, deps?: { fs?: unknown; writer?: Writer; uuid?: () => string }): Store };
const { createAtomicWriter, isTempName } = require('../electron/atomic-write.cjs') as {
  createAtomicWriter(fs?: unknown, options?: { platform?: string; renameDelays?: number[] }): Writer;
  isTempName(name: string): boolean;
};

const DIR = '/data/autosave';
const IDS = ['11111111-1111-4111-8111-111111111111.sv.dxf', '22222222-2222-4222-8222-222222222222.sv.dxf', '33333333-3333-4333-8333-333333333333.sv.dxf', 'Project_P_0a1b2c3d_jcadproj.sv.dxf'];
const LEGACY = ['Panel_A_1.sv.dxf', 'Drawing1_2.sv.dxf'];

/** A DXF-like payload that is easy to recognise when cut short. */
const payload = (tag: string, rng: Rng) => `0\nSECTION\n${tag}\n${'x'.repeat(rng.int(0, 40))}\n0\nEOF\n`;

function makeStore(fs: MemFs, launch: number): Store {
  let n = 0;
  const uuid = () => `00000000-0000-4000-8${launch}00-${String((n += 1)).padStart(12, '0')}`;
  // Windows-like renames (EPERM / EBUSY retried, then copied over) are exercised through `inject`.
  return createAutosaveStore(DIR, { fs, writer: createAtomicWriter(fs, { platform: 'linux', renameDelays: [0, 0] }), uuid });
}

interface OpRecord {
  kind: 'write' | 'remove' | 'list' | 'read';
  name: string;
  content?: string;
  started: number;
  ok: boolean | null;
}

async function storeScenario(rng: Rng, mode: 'crash' | 'faults'): Promise<void> {
  const fs = new MemFs(rng);
  // ------------------------------------------------ what an earlier launch left behind
  const initial = new Map<string, string>();
  const legacyContents: string[] = [];
  if (rng.bool(0.85)) {
    fs.put(`${DIR}/.keep-dir`, '');
    fs.files.delete(`${DIR}/.keep-dir`);
    for (const id of IDS) if (rng.bool(0.3)) {
      const c = payload(`init ${id}`, rng);
      fs.put(`${DIR}/${id}`, c);
      initial.set(id, c);
    }
    for (const l of LEGACY) if (rng.bool(0.3)) {
      const c = payload(`legacy ${l}`, rng);
      fs.put(`${DIR}/${l}`, c);
      legacyContents.push(c);
      if (rng.bool()) fs.put(`${DIR}/${l}.json`, JSON.stringify({ title: 'Panel A.dxf', originalPath: '/jobs/a.dxf', savedAt: 5 }));
    }
    const idx = rng.pick(['valid', 'stale', 'garbage', 'none'] as const);
    if (idx !== 'none') {
      const entries: Record<string, unknown> = {};
      for (const id of IDS) if ((idx === 'valid' && initial.has(id)) || (idx === 'stale' && rng.bool())) entries[id] = { title: `t ${id}`, originalPath: null, savedAt: 10 };
      fs.put(`${DIR}/index.json`, idx === 'garbage' ? '{"version":1,"entries":{"1111' : JSON.stringify({ version: 1, entries }));
    }
    if (rng.bool(0.3)) fs.put(`${DIR}/${IDS[0]}.~0123456789ab.tmp`, 'half');
  }
  // ------------------------------------------------ this launch: random operations, then a crash / faults
  if (mode === 'crash') fs.crashAt = rng.bool(0.1) ? Infinity : rng.int(1, 160);
  else {
    fs.inject = (op, path) => {
      if (!rng.bool(0.12)) return null;
      if (op === 'rename') return fsError(rng.pick(['EPERM', 'EBUSY', 'EACCES', 'EXDEV', 'EIO']), 'rename', path);
      return fsError(rng.pick(['EIO', 'ENOSPC', 'EACCES']), op, path);
    };
  }
  const store = makeStore(fs, 1);
  const ops: OpRecord[] = [];
  const pending: Promise<unknown>[] = [];
  const contentsEver = new Map<string, Set<string>>();
  for (const [k, v] of initial) contentsEver.set(k, new Set([v]));
  const nOps = rng.int(1, 14);
  for (let i = 0; i < nOps; i += 1) {
    const kind = rng.weighted<OpRecord['kind']>([
      [5, 'write'],
      [2, 'remove'],
      [1, 'list'],
      [1, 'read'],
    ]);
    const name = rng.pick(IDS);
    const rec: OpRecord = { kind, name, started: i, ok: null };
    let pr: Promise<unknown>;
    if (kind === 'write') {
      rec.content = payload(`w${i} ${name}`, rng);
      contentsEver.set(name, new Set([...(contentsEver.get(name) ?? []), rec.content]));
      pr = store.write(name, rec.content, { title: `T${i}`, originalPath: null, savedAt: 100 + i });
    } else if (kind === 'remove') pr = store.remove(name);
    else if (kind === 'list') pr = store.list();
    else pr = store.read(name);
    ops.push(rec);
    pending.push(
      pr.then(
        () => {
          rec.ok = true;
        },
        (err) => {
          rec.ok = false;
          if (mode === 'crash') check(err instanceof CrashError || (err as { code?: string }).code === 'ECRASH' || fs.crashed, () => `non-crash failure without injection: ${String(err)}`);
        },
      ),
    );
    if (rng.bool(0.5)) await Promise.allSettled(pending);
  }
  await Promise.allSettled(pending);
  const crashedAt = fs.crashed ? fs.step : null;
  // ------------------------------------------------ next launch (after a power cut when the app crashed)
  fs.restart(mode === 'crash');
  const store2 = makeStore(fs, 2);
  const listed = await store2.list().catch((err) => {
    throw new Error(`the next launch could not list the backups (crash at step ${crashedAt}): ${String(err)}`);
  });
  const names = new Set(listed.map((e) => e.name));
  const ctx = () => `crash at step ${crashedAt}; ops ${JSON.stringify(ops.map((o) => [o.kind, o.name.slice(0, 2), o.ok]))}; files ${JSON.stringify(fs.list(DIR))}`;
  // No temporary file survives a launch; the index lists exactly the backups in the folder.
  for (const f of fs.list(DIR)) check(!isTempName(f), () => `temporary file ${f} left after the next launch (${ctx()})`);
  const svFiles = fs.list(DIR).filter((f) => f.endsWith('.sv.dxf'));
  check(JSON.stringify([...names].sort()) === JSON.stringify(svFiles), () => `listed ${JSON.stringify([...names])} but the folder has ${JSON.stringify(svFiles)} (${ctx()})`);
  const indexText = fs.get(`${DIR}/index.json`);
  // (A damaged index in a folder without backups is harmless: the next write replaces it.)
  if (indexText !== undefined && svFiles.length > 0) {
    let parsed: { entries?: Record<string, unknown> } | null = null;
    try {
      parsed = JSON.parse(indexText);
    } catch {
      /* checked below */
    }
    check(parsed && parsed.entries, () => `index.json unreadable after the next launch: ${JSON.stringify(indexText.slice(0, 60))} (${ctx()})`);
    check(JSON.stringify(Object.keys(parsed!.entries!).sort()) === JSON.stringify(svFiles), () => `index lists ${JSON.stringify(Object.keys(parsed!.entries!))}, folder has ${JSON.stringify(svFiles)} (${ctx()})`);
  } else check(svFiles.length === 0 || listed.length === svFiles.length, 'no index');
  // Every backup is complete: one of the texts ever written under its name (migrated ones: a legacy text).
  for (const e of listed) {
    const text = await store2.read(e.name);
    check(text !== null, () => `${e.name} listed but unreadable`);
    const allowed = contentsEver.get(e.name) ?? new Set(legacyContents);
    check(allowed.has(text!), () => `${e.name} holds a partial or foreign text ${JSON.stringify(text!.slice(0, 40))}... (${ctx()})`);
  }
  // Old-format backups are never lost: each legacy text is still listed somewhere.
  const texts = await Promise.all(listed.map((e) => store2.read(e.name)));
  for (const c of legacyContents) check(texts.includes(c), () => `a legacy backup was lost (${ctx()})`);
  // What completed stays done.
  for (const name of IDS) {
    const mine = ops.filter((o) => o.name === name && (o.kind === 'write' || o.kind === 'remove'));
    const lastOk = [...mine].reverse().find((o) => o.ok);
    if (!lastOk) continue;
    const later = mine.filter((o) => o.started > lastOk.started);
    if (lastOk.kind === 'write') {
      if (later.some((o) => o.kind === 'remove')) continue;
      check(names.has(name), () => `${name}: write resolved but the backup is gone (${ctx()})`);
    } else if (!later.some((o) => o.kind === 'write')) {
      check(!names.has(name), () => `${name}: remove resolved but the backup came back (${ctx()})`);
    }
    if (lastOk.kind === 'write' && names.has(name)) {
      const text = await store2.read(name);
      const ok = [lastOk.content!, ...later.filter((o) => o.kind === 'write').map((o) => o.content!)];
      check(ok.includes(text!), () => `${name}: holds an older text than the last completed write (${ctx()})`);
    }
  }
}

describe('fuzz: recovery store crashes and faults', () => {
  it('a crash at any file system call leaves a consistent, complete recovery folder', async () => {
    const runs = await fuzz('recovery-store/crash', 800, (rng) => storeScenario(rng, 'crash'));
    expect(runs).toBeGreaterThan(0);
  }, fuzzTimeout());
  it('injected failures (EIO, ENOSPC, EPERM / EBUSY / EXDEV renames) never leave partial backups or a broken index', async () => {
    await fuzz('recovery-store/faults', 800, (rng) => storeScenario(rng, 'faults'));
  }, fuzzTimeout());
});

// ------------------------------------------------------------------ user files: atomicWriteFile with .bak
async function userFileScenario(rng: Rng): Promise<void> {
  const fs = new MemFs(rng);
  const file = '/jobs/p/a.dxf';
  const old = payload('old', rng);
  const oldBak = rng.bool() ? payload('older', rng) : undefined;
  const exists = rng.bool(0.85);
  if (exists) fs.put(file, old);
  else fs.put('/jobs/p/.placeholder', '');
  if (oldBak !== undefined) fs.put(`${file}.bak`, oldBak);
  const writer = createAtomicWriter(fs, { platform: rng.pick(['linux', 'win32']), renameDelays: [0, 0, 0] });
  const next = payload('new', rng);
  // Include the path-identity checks, backup creation, and final rename, plus successful runs.
  fs.crashAt = rng.bool(0.75) ? rng.int(1, 200) : Infinity;
  const renameFails = rng.bool(0.4);
  const ioFailureAt = rng.bool(0.3) ? rng.int(1, 200) : Infinity;
  fs.inject = (op, path, step) => {
    if (op === 'rename' && renameFails && rng.bool(0.8)) return fsError(rng.pick(['EPERM', 'EBUSY', 'EXDEV']), 'rename', path);
    if (step === ioFailureAt) return fsError('EIO', op, path);
    return null;
  };
  let resolved = false;
  await writer.atomicWriteFile(file, next, { backup: true }).then(
    () => {
      resolved = true;
    },
    () => {},
  );
  const crashed = fs.crashed;
  const trace = [...fs.trace];
  fs.restart();
  const now = fs.get(file);
  const bak = fs.get(`${file}.bak`);
  const ctx = () => `crash ${crashed}, rename fails ${renameFails}; trace ${trace.join('; ')}; file ${JSON.stringify(now?.slice(0, 20))}, bak ${JSON.stringify(bak?.slice(0, 20))}`;
  if (resolved) check(now === next, () => `write resolved but the file holds ${JSON.stringify(now)} (${ctx()})`);
  // User destinations and completed backups are always whole; partial data may exist only in temps.
  if (exists) check(now === next || now === old, () => `drawing destination was damaged (${ctx()})`);
  else check(now === undefined || now === next, () => `new file holds partial or foreign text (${ctx()})`);
  check(bak === undefined || bak === oldBak || bak === old, () => `backup destination was damaged (${ctx()})`);
}

describe('fuzz: crash-safe user file writes', () => {
  it('a crash at any step keeps the drawing or a complete .bak of it', async () => {
    await fuzz('atomic-write/crash', 1500, userFileScenario);
  }, fuzzTimeout());
});

describe('recovery store fuzzing regressions', () => {
  it('the project autosave survives the next launch under its own name, so project recovery finds it (seed 3239990580)', async () => {
    const { ProjectAutosaver, offerProjectRecovery, drawingAutosaves, isProjectAutosave } = await import('../src/app/project-autosave');
    const { bridgeAutosaveStore } = await import('../src/app/autosave');
    const rng = new Rng(3239990580);
    const fs = new MemFs(rng);
    const asStore = (s: Store) => bridgeAutosaveStore({ autosaveWrite: (n, t, m) => s.write(n, t, m), autosaveList: () => s.list(), autosaveRead: (n) => s.read(n), autosaveRemove: (n) => s.remove(n) });
    // Launch 1: the project is modified and autosaved, then the app dies.
    const host = { project: { name: 'Line 2', path: '/jobs/line2.jcadproj.json', drawings: [{ file: 'a.dxf' }] }, projectDirty: true, on: () => () => {} };
    const pa = new ProjectAutosaver(host, asStore(makeStore(fs, 1)));
    await pa.flush();
    const written = fs.list(DIR).filter(isProjectAutosave);
    expect(written).toHaveLength(1);
    fs.restart();
    // Launch 2: project recovery runs first (src/main.ts), the Drawing Recovery Manager after it.
    const store2 = asStore(makeStore(fs, 2));
    const asked: string[] = [];
    const replaced: unknown[] = [];
    const recovered = await offerProjectRecovery(
      { projectDirty: false, replaceProject: (p) => replaced.push(p), log: () => {} },
      store2,
      async (name) => {
        asked.push(name);
        return 'open';
      },
    );
    expect(asked).toEqual(['Line 2']);
    expect(recovered?.name).toBe(written[0]);
    expect(replaced).toHaveLength(1);
    // ... and it is not offered as a drawing.
    expect(await drawingAutosaves(store2).list()).toEqual([]);
  });
  it('a write and a remove of one backup take effect in call order (seed 3863811055)', async () => {
    const fs = new MemFs(new Rng(1));
    const store = makeStore(fs, 1);
    const name = IDS[0]!;
    await store.write(name, 'first', { title: 'a', savedAt: 1 });
    const w = store.write(name, 'second', { title: 'a', savedAt: 2 });
    const r = store.remove(name);
    await Promise.all([w, r]);
    expect(fs.list(DIR)).toEqual(['index.json']);
    expect(await store.list()).toEqual([]);
    expect(await makeStore(fs, 2).list()).toEqual([]);
    // and the other way round
    const r2 = store.remove(name);
    const w2 = store.write(name, 'third', { title: 'a', savedAt: 3 });
    await Promise.all([r2, w2]);
    expect(await store.read(name)).toBe('third');
    expect((await makeStore(fs, 3).list()).map((e) => e.name)).toEqual([name]);
  });
});
