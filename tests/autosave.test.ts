import { describe, it, expect, vi, afterEach } from 'vitest';
import { Autosaver, autosaveName, localAutosaveStore, sessionsToAutosave, type AutosaveMeta, type AutosaveSession, type AutosaveStore, type AutosaveEntry, type KeyValueStorage } from '../src/app/autosave';
import { Drawing, type DrawingState } from '../src/core/document';
import { SessionManager, newDocumentId, type SessionHost } from '../src/app/sessions';
import type { Entity } from '../src/core/entities';

function fakeStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

/** A TEXT entity whose content shows up in the DXF, so a test can tell revisions apart. */
const marker = (id: string): Entity => ({ id: `t${Math.random().toString(36).slice(2)}`, type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, text: id, height: 1, rotation: 0, align: 'left' });

/** A promise with its resolve/reject handles. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

/**
 * Fake bridge store: every write waits until the test releases it (gate), so a test can edit the
 * drawing "while the autosave is being written". Records concurrency and every call.
 */
function gatedStore() {
  const files = new Map<string, { text: string; meta: AutosaveMeta }>();
  const calls: string[] = [];
  const gates: Array<ReturnType<typeof deferred<void>>> = [];
  let active = 0;
  let maxActive = 0;
  let gated = true;
  const store: AutosaveStore = {
    async write(name, text, meta) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(`write ${name}`);
      try {
        if (gated) {
          const g = deferred<void>();
          gates.push(g);
          await g.promise;
        }
        files.set(name, { text, meta });
      } finally {
        active -= 1;
      }
    },
    async list(): Promise<AutosaveEntry[]> {
      return [...files].map(([name, f]) => ({ name, ...f.meta }));
    },
    async read(name) {
      return files.get(name)?.text ?? null;
    },
    async remove(name) {
      calls.push(`remove ${name}`);
      files.delete(name);
    },
  };
  return {
    store,
    files,
    calls,
    get maxActive() {
      return maxActive;
    },
    get pending() {
      return gates.length;
    },
    /** Let the oldest pending write finish (or fail). */
    async release(err?: unknown) {
      const g = gates.shift();
      if (!g) throw new Error('no pending write');
      if (err) g.reject(err);
      else g.resolve();
      await flushMicrotasks();
    },
    ungate() {
      gated = false;
      while (gates.length) gates.shift()!.resolve();
    },
  };
}

const flushMicrotasks = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/** A fake document session list (what SessionManager.all hands the autosaver). */
function fakeSessions(n = 1) {
  const docs = Array.from({ length: n }, () => new Drawing());
  const list: AutosaveSession[] = docs.map((d, i) => ({ id: i + 1, docId: newDocumentId(), dirty: false, state: d.snapshot, filePath: null, untitledName: `Drawing${i + 1}.dxf` }));
  /** Make an edit in session i: a new revision, dirty. */
  const edit = (i: number, id = `e${Math.random()}`): DrawingState => {
    docs[i]!.addEntities([marker(id)]);
    list[i]!.state = docs[i]!.snapshot;
    list[i]!.dirty = true;
    return list[i]!.state;
  };
  return { sessions: { all: list }, list, edit };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('autosave file names', () => {
  it('come from the permanent document id, never from the title or the per-launch session number', () => {
    const id = '3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b';
    expect(autosaveName(id)).toBe(`${id}.sv.dxf`);
    expect(autosaveName('ABC/..\\x')).toBe('abcx.sv.dxf');
    expect(autosaveName('')).toBe('drawing.sv.dxf');
  });

  it('every new document gets a new id: a new launch cannot reuse the name of an unrecovered backup', () => {
    const host = (): SessionHost => {
      const doc = new Drawing();
      return { doc, viewport: { center: { x: 0, y: 0 }, scale: 1 }, selection: new Set(), loadState: (st, p) => doc.load(st, p) };
    };
    // Two "launches": session numbers restart at 1 and the untitled names repeat ...
    const first = new SessionManager(host());
    const second = new SessionManager(host());
    expect(first.current.id).toBe(second.current.id);
    expect(first.current.untitledName).toBe(second.current.untitledName);
    // ... but the document ids, and so the autosave files, differ.
    expect(first.current.docId).not.toBe(second.current.docId);
    first.add();
    const ids = new Set([...first.all, ...second.all].map((s) => s.docId));
    expect(ids.size).toBe(3);
    for (const s of first.all) expect(s.docId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('an unrecovered backup from an earlier launch survives the next launch autosaving the same title', async () => {
    const storage = fakeStorage();
    const store = localAutosaveStore(storage);
    const before = fakeSessions(1);
    before.edit(0, 'old-work');
    await new Autosaver(before.sessions, store, () => 0).runNow();
    // Next launch: session 1, Drawing1.dxf again, but a fresh document id.
    const after = fakeSessions(1);
    after.edit(0, 'new-work');
    await new Autosaver(after.sessions, store, () => 0).runNow();
    const list = await store.list();
    expect(list).toHaveLength(2);
    expect(list.every((e) => e.title === 'Drawing1.dxf')).toBe(true);
    expect((await store.read(autosaveName(before.list[0]!.docId)))).toContain('old-work');
    expect((await store.read(autosaveName(after.list[0]!.docId)))).toContain('new-work');
  });
});

describe('autosave stores', () => {
  it('local store writes, lists newest first, reads and removes', async () => {
    const store = localAutosaveStore(fakeStorage());
    await store.write('a.sv.dxf', 'AAA', { originalPath: '/x/a.dxf', title: 'a.dxf', savedAt: 10 });
    await store.write('b.sv.dxf', 'BBB', { originalPath: null, title: 'Drawing2.dxf', savedAt: 20 });
    const list = await store.list();
    expect(list.map((e) => e.name)).toEqual(['b.sv.dxf', 'a.sv.dxf']);
    expect(list[1]!.originalPath).toBe('/x/a.dxf');
    expect(await store.read('a.sv.dxf')).toBe('AAA');
    expect(await store.read('missing')).toBeNull();
    await store.remove('a.sv.dxf');
    expect((await store.list()).length).toBe(1);
  });
  it('a storage that cannot be read makes list() fail instead of answering "no backups"', async () => {
    const broken = { ...fakeStorage(), key: () => { throw new Error('SecurityError: storage blocked'); }, length: 1 } as KeyValueStorage;
    await expect(localAutosaveStore(broken).list()).rejects.toThrow(/storage blocked/);
  });
  it('only dirty sessions whose state changed since the last write are saved', () => {
    const d1 = new Drawing();
    const d2 = new Drawing();
    const sessions = [
      { id: 1, dirty: true, state: d1.snapshot },
      { id: 2, dirty: false, state: d2.snapshot },
      { id: 3, dirty: true, state: d2.snapshot },
    ];
    const last = new Map([[3, d2.snapshot]]);
    expect(sessionsToAutosave(sessions, last)).toEqual([1]);
    d2.addEntities([{ id: 'e', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }]);
    sessions[2] = { id: 3, dirty: true, state: d2.snapshot };
    expect(sessionsToAutosave(sessions, last)).toEqual([1, 3]);
  });
});

describe('Autosaver: revisions, overlap and coordination', () => {
  it('an edit made while the autosave is being written stays "not backed up" and goes out next time', async () => {
    const { sessions, list, edit } = fakeSessions(1);
    const fake = gatedStore();
    const a = new Autosaver(sessions, fake.store, () => 0);
    const r1 = edit(0, 'first');
    const run = a.runNow();
    await flushMicrotasks();
    expect(fake.pending).toBe(1);
    const r2 = edit(0, 'second'); // edit during the write
    await fake.release();
    expect(await run).toBe(1);
    // Exactly the captured revision is recorded, not "whatever the drawing is now".
    expect(a.backedUpState(1)).toBe(r1);
    expect(a.backedUpState(1)).not.toBe(r2);
    expect(sessionsToAutosave(list, new Map([[1, a.backedUpState(1)!]]))).toEqual([1]);
    expect(fake.files.get(autosaveName(list[0]!.docId))!.text).toContain('first');
    expect(fake.files.get(autosaveName(list[0]!.docId))!.text).not.toContain('second');
    const run2 = a.runNow();
    await fake.release();
    expect(await run2).toBe(1);
    expect(a.backedUpState(1)).toBe(r2);
    expect(fake.files.get(autosaveName(list[0]!.docId))!.text).toContain('second');
    // Nothing new: nothing written.
    fake.ungate();
    expect(await a.runNow()).toBe(0);
  });

  it('never runs two autosaves at once: requests during a run queue exactly one more run', async () => {
    const { sessions, edit } = fakeSessions(2);
    const fake = gatedStore();
    const a = new Autosaver(sessions, fake.store, () => 0);
    edit(0);
    edit(1);
    const p1 = a.runNow();
    await flushMicrotasks();
    edit(0); // newer revision while run 1 is writing
    const p2 = a.runNow();
    const p3 = a.runNow();
    const p4 = a.runNow();
    expect(p3).toBe(p2); // one queued run shared by every later request
    expect(p4).toBe(p2);
    expect(a.busy).toBe(true);
    // Run 1 writes its two drawings one after the other.
    expect(fake.pending).toBe(1);
    await fake.release();
    expect(fake.pending).toBe(1);
    await fake.release();
    expect(await p1).toBe(2);
    // The queued run starts only now and writes the newer revision of drawing 1.
    await flushMicrotasks();
    expect(fake.pending).toBe(1);
    await fake.release();
    expect(await p2).toBe(1);
    expect(fake.maxActive).toBe(1);
    expect(fake.calls.filter((c) => c.startsWith('write'))).toHaveLength(3);
    expect(a.busy).toBe(false);
  });

  it('records the time the revision was captured (fake clock), not the time the write finished', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T10:00:00Z'));
    const { sessions, list, edit } = fakeSessions(1);
    const fake = gatedStore();
    const a = new Autosaver(sessions, fake.store, () => 1);
    edit(0);
    a.start();
    await vi.advanceTimersByTimeAsync(60_000); // the timer fires at 10:01
    expect(fake.pending).toBe(1);
    vi.setSystemTime(new Date('2026-03-01T10:05:00Z'));
    await fake.release();
    expect(fake.files.get(autosaveName(list[0]!.docId))!.meta.savedAt).toBe(Date.parse('2026-03-01T10:01:00Z'));
    // The next tick does not overlap a slow write and writes nothing when nothing changed.
    fake.ungate();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.calls.filter((c) => c.startsWith('write'))).toHaveLength(1);
    a.stop();
  });

  it('a failed write leaves the revision not backed up and is retried', async () => {
    const { sessions, edit } = fakeSessions(1);
    const fake = gatedStore();
    const a = new Autosaver(sessions, fake.store, () => 0);
    const errors: string[] = [];
    a.onError = (title, err) => errors.push(`${title}: ${(err as Error).message}`);
    edit(0);
    const p = a.runNow();
    await flushMicrotasks();
    await fake.release(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }));
    expect(await p).toBe(0);
    expect(errors).toEqual(['Drawing1.dxf: ENOSPC: no space left on device, write']);
    expect(a.backedUpState(1)).toBeUndefined();
    fake.ungate();
    expect(await a.runNow()).toBe(1);
  });

  it('a write that fails on one interval does not stop the timer: the next interval writes it', async () => {
    vi.useFakeTimers();
    const { sessions, list, edit } = fakeSessions(1);
    const fake = gatedStore();
    const a = new Autosaver(sessions, fake.store, () => 1);
    const errors: string[] = [];
    a.onError = (title) => errors.push(title);
    const saved: number[] = [];
    a.onSaved = (n) => saved.push(n);
    edit(0, 'work');
    a.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.pending).toBe(1);
    await fake.release(Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' }));
    expect(errors).toEqual(['Drawing1.dxf']);
    expect(a.backedUpState(1)).toBeUndefined();
    expect(a.busy).toBe(false);
    // Next tick: the same revision is still due and is written.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.pending).toBe(1);
    await fake.release();
    expect(saved).toEqual([1]);
    expect(a.backedUpState(1)).toBe(list[0]!.state);
    expect(fake.files.get(autosaveName(list[0]!.docId))!.text).toContain('work');
    // A failure inside the store that is not a rejection (throws synchronously) is caught too.
    fake.store.write = () => {
      throw new Error('EBUSY: resource busy or locked');
    };
    edit(0, 'more');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(errors).toEqual(['Drawing1.dxf', 'Drawing1.dxf']);
    expect(a.busy).toBe(false);
    a.stop();
  });

  it('a manual save marks the backup clean only for the revision that was saved', async () => {
    const { sessions, list, edit } = fakeSessions(1);
    const fake = gatedStore();
    const a = new Autosaver(sessions, fake.store, () => 0);
    const name = autosaveName(list[0]!.docId);
    // 1. An autosave of revision r1 is in flight when the save of r1 completes: markSaved waits for it.
    const r1 = edit(0, 'r1');
    const run = a.runNow();
    await flushMicrotasks();
    list[0]!.dirty = false; // the save of r1 completed (applySaveResult)
    let marked: string | null = null;
    const m1 = a.markSaved(1, r1).then((r) => (marked = r));
    await flushMicrotasks();
    expect(marked).toBeNull(); // still waiting for the write in flight
    await fake.release();
    await run;
    await m1;
    expect(marked).toBe('removed');
    expect(fake.files.has(name)).toBe(false); // the late write did not survive the removal
    expect(fake.calls.slice(-2)).toEqual([`write ${name}`, `remove ${name}`]);

    // 2. The save of r2 completes but the user already made r3: the backup stays and r3 is still due.
    fake.ungate();
    const r2 = edit(0, 'r2');
    await a.runNow();
    const r3 = edit(0, 'r3');
    expect(await a.markSaved(1, r2)).toBe('kept');
    expect(fake.files.has(name)).toBe(true);
    expect(a.backedUpState(1)).toBe(r2);
    expect(sessionsToAutosave(list, new Map([[1, a.backedUpState(1)!]]))).toEqual([1]);
    await a.runNow();
    expect(a.backedUpState(1)).toBe(r3);

    // 3. A clean drawing without a backup: nothing to remove.
    list[0]!.dirty = false;
    expect(await a.markSaved(1, r3)).toBe('removed');
    expect(await a.markSaved(1, r3)).toBe('none');
  });

  it('closing waits for the write in flight, so the backup is not re-created after Discard', async () => {
    const { sessions, list, edit } = fakeSessions(1);
    const fake = gatedStore();
    const a = new Autosaver(sessions, fake.store, () => 0);
    edit(0);
    const run = a.runNow();
    await flushMicrotasks();
    const closing = a.discardFor(1);
    await fake.release();
    await run;
    expect(await closing).toBe(true);
    expect(fake.files.has(autosaveName(list[0]!.docId))).toBe(false);
    expect(a.nameFor(1)).toBeUndefined();
  });

  it('flush waits for the run in flight and the queued one (quit)', async () => {
    const { sessions, edit } = fakeSessions(1);
    const fake = gatedStore();
    const a = new Autosaver(sessions, fake.store, () => 0);
    edit(0);
    void a.runNow();
    await flushMicrotasks();
    edit(0);
    void a.runNow();
    let flushed = false;
    const f = a.flush().then(() => (flushed = true));
    await fake.release();
    await flushMicrotasks();
    expect(flushed).toBe(false); // the queued run is writing now
    await fake.release();
    await f;
    expect(flushed).toBe(true);
    expect(a.busy).toBe(false);
  });

  it('a recovered drawing keeps writing to the backup it was opened from; owns() reports it', async () => {
    const { sessions, list, edit } = fakeSessions(1);
    const fake = gatedStore();
    fake.ungate();
    const a = new Autosaver(sessions, fake.store, () => 0);
    a.adopt(1, 'old-backup.sv.dxf');
    expect(a.owns('old-backup.sv.dxf')).toBe(true);
    edit(0);
    await a.runNow();
    expect(fake.files.has('old-backup.sv.dxf')).toBe(true);
    expect(fake.files.has(autosaveName(list[0]!.docId))).toBe(false);
  });
});
