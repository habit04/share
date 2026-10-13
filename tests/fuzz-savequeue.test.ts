/**
 * Race fuzzing of src/app/savequeue.ts: random interleavings of saves to the same and to
 * different files (several spellings of one path), random revisions captured before a random
 * dialog delay, random write durations, failures and cancellations, under fake timers.
 * Seeds are logged; replay with FUZZ_SEED.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { SaveQueue, type QueuedResult } from '../src/app/savequeue';
import { pathKey, setPathPlatform } from '../src/app/paths';
import { Rng, fuzz, check, fuzzTimeout } from './helpers/fuzz';
import { mainProcessSource, ipcHandlerSource } from './helpers/main-process';

afterEach(() => {
  vi.useRealTimers();
  setPathPlatform(null);
});

const FILES: string[][] = [
  ['C:\\Jobs\\A.dxf', 'c:/jobs/a.DXF', 'C:\\Jobs\\sub\\..\\A.dxf'],
  ['C:\\Jobs\\B.dxf', 'c:\\JOBS\\b.dxf'],
  ['/home/u/p/c.dxf', '/home/u/p/./c.dxf', '/home/u//p/c.dxf'],
  ['/home/u/p/C.dxf'],
  ['\\\\srv\\share\\d.dxf', '//srv/share/d.dxf'.replace(/\//g, '\\')],
];

interface Op {
  file: number;
  spelling: string;
  revision: number;
  /** Delay before run() is called (a save dialog, a confirmation). */
  callAt: number;
  writeMs: number;
  outcome: 'ok' | 'fail' | 'cancel' | 'redirect';
  redirectTo?: number;
}

/**
 * The main process side of a save (electron/main/app-data.cjs writeUserFile): writes of one file run one
 * at a time in arrival order. `serialize: false` models the code before that queue existed.
 */
function mainWriter(serialize: boolean) {
  const tails = new Map<string, Promise<unknown>>();
  const active = new Set<string>();
  let overlaps = 0;
  return {
    get overlaps() {
      return overlaps;
    },
    write(key: string, ms: number, land: () => void): Promise<void> {
      const job = async () => {
        if (active.has(key)) overlaps += 1;
        active.add(key);
        try {
          await new Promise((r) => setTimeout(r, ms));
          land();
        } finally {
          active.delete(key);
        }
      };
      if (!serialize) return job();
      const run = (tails.get(key) ?? Promise.resolve()).then(job, job);
      tails.set(key, run.catch(() => undefined));
      return run;
    },
  };
}

async function scenario(rng: Rng, allowRedirects: boolean): Promise<void> {
  const main = mainWriter(true);
  const q = new SaveQueue();
  const logs: string[] = [];
  q.log = (t) => logs.push(t);
  const disk = new Map<string, number>(); // key -> revision on disk
  const landed = new Map<string, number[]>(); // key -> revisions in the order they reached the disk
  const redirected = new Set<string>(); // keys a redirected save (Save As dialog) wrote
  let revision = 0;
  const ops: Op[] = [];
  const n = rng.int(2, 18);
  let t = 0;
  for (let i = 0; i < n; i += 1) {
    t += rng.int(0, 30);
    const file = rng.int(0, FILES.length - 1);
    revision += 1; // captured when the snapshot is taken ...
    const outcome = rng.weighted<Op['outcome']>([
      [7, 'ok'],
      [1, 'fail'],
      [1, 'cancel'],
      [allowRedirects ? 1 : 0, 'redirect'],
    ]);
    ops.push({
      file,
      spelling: rng.pick(FILES[file]!),
      revision,
      callAt: t + rng.int(0, 60), // ... and run() is called later, so calls arrive out of revision order
      writeMs: rng.int(0, 50),
      outcome,
      redirectTo: outcome === 'redirect' ? rng.int(0, FILES.length - 1) : undefined,
    });
  }
  const results: Array<QueuedResult<string | null> | 'error' | 'pending'> = ops.map(() => 'pending');
  const writing = new Set<string>(); // keys with a write in progress (through the queue)
  const promises: Promise<unknown>[] = [];
  for (const [i, op] of ops.entries()) {
    setTimeout(() => {
      const p = q
        .run(op.spelling, op.revision, async () => {
          const key = pathKey(op.spelling);
          check(!writing.has(key), () => `two queued writes to ${key} at once`);
          writing.add(key);
          try {
            if (op.outcome === 'fail') {
              await new Promise((r) => setTimeout(r, op.writeMs));
              throw new Error(`EIO ${op.spelling}`);
            }
            // A redirect is a save whose path needed the dialog: it picks another file.
            if (op.outcome === 'redirect') await new Promise((r) => setTimeout(r, rng.int(0, 40)));
            if (op.outcome === 'cancel') return null;
            const dest = op.outcome === 'redirect' ? FILES[op.redirectTo!]![0]! : op.spelling;
            const k = pathKey(dest);
            if (op.outcome === 'redirect') redirected.add(k);
            await main.write(k, op.writeMs, () => {
              disk.set(k, op.revision);
              landed.set(k, [...(landed.get(k) ?? []), op.revision]);
            });
            return dest;
          } finally {
            writing.delete(key);
          }
        })
        .then(
          (r) => {
            results[i] = r;
          },
          () => {
            results[i] = 'error';
          },
        );
      promises.push(p);
    }, op.callAt);
  }
  await vi.runAllTimersAsync();
  await Promise.all(promises);
  // No promise is left pending.
  results.forEach((r, i) => check(r !== 'pending', () => `save ${i} (${JSON.stringify(ops[i])}) never settled`));
  // Dropped saves are logged, once each.
  const stale = results.filter((r) => r !== 'error' && r !== 'pending' && r.status === 'stale').length;
  check(stale === logs.length, () => `${stale} stale result(s) but ${logs.length} log line(s)`);
  check(main.overlaps === 0, 'two writes of one file ran at once in the main process');
  // On every file the queue alone writes: what landed only ever got newer, and the newest successful
  // write is on disk. (A file a Save As dialog picked holds the write that arrived last: the user's last action.)
  for (const [k, revs] of landed) {
    if (redirected.has(k)) continue;
    for (let j = 1; j < revs.length; j += 1) check(revs[j]! >= revs[j - 1]!, () => `${k}: revision ${revs[j]} landed after ${revs[j - 1]} (order ${revs.join(',')})`);
    const best = Math.max(...revs);
    check(disk.get(k) === best, () => `${k}: disk holds ${disk.get(k)}, newest successful write was ${best}`);
  }
  // A failure or cancellation never blocks later saves: every save that was not stale ran its write
  // (written / error), and a save is only stale when a newer revision of that file was written first.
  results.forEach((r, i) => {
    if (r === 'error' || r === 'pending' || r.status !== 'stale') return;
    const k = pathKey(ops[i]!.spelling);
    check(q.lastCompleted(k) > ops[i]!.revision, () => `save ${i} (rev ${ops[i]!.revision}) dropped although nothing newer was written to ${k}`);
    if (!redirected.has(k)) check((landed.get(k) ?? []).some((x) => x > ops[i]!.revision), () => `save ${i} (rev ${ops[i]!.revision}) dropped although nothing newer reached ${k}`);
  });
  for (const [i, op] of ops.entries()) {
    const r = results[i]!;
    if (op.outcome === 'fail') check(r === 'error' || (r !== 'pending' && r.status === 'stale'), () => `failing save ${i} resolved ${JSON.stringify(r)}`);
  }
}

describe('fuzz: save queue', () => {
  it('random saves to the same and different files: newest revision on disk, drops logged, nothing pending', async () => {
    vi.useFakeTimers();
    const runs = await fuzz('savequeue/interleavings', 1000, (rng) => scenario(rng, false));
    expect(runs).toBeGreaterThan(0);
  }, fuzzTimeout());
  it('the same with saves that land on another path (a Save As dialog picked an open file)', async () => {
    vi.useFakeTimers();
    await fuzz('savequeue/redirects', 1000, (rng) => scenario(rng, true));
  }, fuzzTimeout());
});

describe('save queue fuzzing regressions', () => {
  it('a save whose dialog picked another file does not mark the requested file as written (seed 4013212960)', async () => {
    const q = new SaveQueue();
    const logs: string[] = [];
    q.log = (t) => logs.push(t);
    // rev 5 was meant for A.dxf, but the dialog wrote B.dxf
    const r = await q.run('/p/A.dxf', 5, async () => '/p/B.dxf');
    expect(r).toEqual({ status: 'written', value: '/p/B.dxf' });
    expect(q.lastCompleted('/p/B.dxf')).toBe(5);
    expect(q.lastCompleted('/p/A.dxf')).toBe(0);
    // an older revision of A.dxf is still written: nothing newer ever reached A.dxf
    let wrote = false;
    const older = await q.run('/p/A.dxf', 4, async () => {
      wrote = true;
      return '/p/A.dxf';
    });
    expect(older.status).toBe('written');
    expect(wrote).toBe(true);
    expect(logs).toEqual([]);
  });
  it('the IPC save channels use the shared user-file writer', () => {
    // Queue ordering and aliases are exercised through app-data.cjs in main-write-queue.test.ts.
    const handler = ipcHandlerSource;
    for (const name of ['save-dxf', 'save-project', 'save-text', 'save-pdf']) {
      expect(handler(name), name).toMatch(/(?:await writeUserFile|(?:await|return) writeAdmittedText)\(/);
      expect(handler(name), name).not.toMatch(/await atomicWriteFile\(/);
    }
  });
  it('Save As asks for the file first (choose-drawing-path) and writes nothing itself; the preload exposes it', () => {
    const src = mainProcessSource();
    const start = src.indexOf("ipcMain.handle('choose-drawing-path'");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf('ipcMain.handle(', start + 10));
    expect(body).toMatch(/showSaveDialog/);
    // Registered on the guarded ipcMain (electron/ipc-guard.cjs): only the application page may call it.
    expect(src).toMatch(/const ipcMain = guardIpc\(rawIpcMain,/);
    expect(src).not.toMatch(/rawIpcMain\.(handle|on|once)\(/);
    expect(body).toMatch(/senderWindow\(ev\)/);
    // The chosen drawing becomes writable only after its supported extension is validated and
    // completed (with confirmation when that completed path exists). Format behavior is exercised
    // through the actual IPC handlers in portable-dwg-ipc.test.ts.
    expect(body).toMatch(/const file = await completeSavePath\(win, res\.filePath,[^;]+;\s*if \(!file \|\| pathPolicy\.shapeProblem\(file\)\) return null;\s*registry\.grant\(file\);\s*return file;/);
    const helper = src.slice(src.indexOf('async function completeSavePath('), src.indexOf('ipcMain.handle(', src.indexOf('async function completeSavePath(')));
    expect(helper).toMatch(/const file = type\.test\(chosen\) \? chosen : `\$\{chosen\}\$\{ext\}`;/);
    expect(helper).toMatch(/dialog\.showMessageBox\(win,[\s\S]*buttons: \['Replace', 'Cancel'\][\s\S]*cancelId: 1/);
    expect(helper).toMatch(/return r\.response === 0 \? file : null;/);
    // save-dxf's own Save As dialog and Save Project As complete the name the same way.
    const saveDxf = src.slice(src.indexOf("ipcMain.handle('save-dxf'"), src.indexOf('ipcMain.handle(', src.indexOf("ipcMain.handle('save-dxf'") + 10));
    expect(saveDxf).toMatch(/target = await completeSavePath\(win, res\.filePath, DXF_FILE, '\.dxf'\);\s*if \(!target\) return null;/);
    const project = src.slice(src.indexOf("ipcMain.handle('choose-project-path'"), src.indexOf('ipcMain.handle(', src.indexOf("ipcMain.handle('choose-project-path'") + 10));
    expect(project).toMatch(/const file = await completeSavePath\(win, res\.filePath, PROJECT_FILE, '\.jcadproj\.json'\);\s*if \(!file\) return null;\s*registry\.grant\(file\);/);
    expect(body).not.toMatch(/writeUserFile|atomicWriteFile/);
    const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
    expect(preload).toMatch(/chooseDrawingPath: \(suggestName, format\) => ipcRenderer\.invoke\('choose-drawing-path', String\(suggestName \|\| ''\), format\)/);
  });
});
