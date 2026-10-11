/**
 * Race fuzzing of the Drawing Recovery Manager actions (src/app/recovery-actions.ts): random
 * clicks on Open / Discard / Discard All (double clicks included) while reads, opens and removes
 * take random time and sometimes fail, under fake timers. Seeds are logged; replay with FUZZ_SEED.
 *
 * Invariants: an opened backup is never deleted (by Discard or Discard All); a backup is opened at
 * most once; only one action runs at a time; every action settles; the list shows exactly the
 * entries neither opened nor removed; failures stay listed with their error.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RecoveryActions } from '../src/app/recovery-actions';
import type { AutosaveEntry } from '../src/app/autosave';
import { Rng, fuzz, check } from './helpers/fuzz';

afterEach(() => {
  vi.useRealTimers();
});

async function scenario(rng: Rng): Promise<void> {
  const n = rng.int(1, 6);
  const entries: AutosaveEntry[] = Array.from({ length: n }, (_, i) => ({ name: `${i}0000000-0000-4000-8000-000000000000.sv.dxf`, title: `D${i}.dxf`, originalPath: null, savedAt: i }));
  const files = new Map(entries.map((e) => [e.name, `DXF ${e.name}`]));
  const opened: string[] = [];
  const removed: string[] = [];
  let running = 0;
  const violations: string[] = [];
  const op = async <T>(what: string, fn: () => T): Promise<T> => {
    running += 1;
    if (running > 1) violations.push(`${what} ran while another action was running`);
    try {
      await new Promise((r) => setTimeout(r, rng.int(0, 30)));
      return fn();
    } finally {
      running -= 1;
    }
  };
  const actions = new RecoveryActions(entries, {
    read: (name) =>
      op('read', () => {
        if (rng.bool(0.1)) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        return files.get(name) ?? null;
      }),
    remove: (name) =>
      op('remove', () => {
        if (opened.includes(name)) violations.push(`removed ${name} after it was opened`);
        if (rng.bool(0.15)) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
        files.delete(name);
        removed.push(name);
      }),
    openRecovered: async (e, text) => {
      await new Promise((r) => setTimeout(r, rng.int(0, 20)));
      if (rng.bool(0.1)) throw new Error('damaged');
      if (opened.includes(e.name)) violations.push(`${e.name} opened twice`);
      if (text !== `DXF ${e.name}`) violations.push(`${e.name} opened with another text`);
      opened.push(e.name);
    },
  });
  const pending: Promise<unknown>[] = [];
  let done = 0;
  const track = (p: Promise<unknown>) => pending.push(p.finally(() => (done += 1)));
  const clicks = rng.int(1, 14);
  for (let i = 0; i < clicks; i += 1) {
    await vi.advanceTimersByTimeAsync(rng.int(0, 25));
    const e = rng.pick(entries).name;
    const what = rng.weighted<string>([
      [3, 'open'],
      [2, 'discard'],
      [1, 'discardAll'],
    ]);
    const click = () => (what === 'open' ? actions.open(e) : what === 'discard' ? actions.discard(e) : actions.discardAll());
    track(click());
    if (rng.bool(0.3)) track(click()); // double click
  }
  await vi.runAllTimersAsync();
  check(done === pending.length, () => `${pending.length - done} action(s) never settled`);
  check(violations.length === 0, () => violations.join('; '));
  check(!actions.busy, 'still busy after every action settled');
  for (const e of entries) {
    const isOpened = opened.includes(e.name);
    const isRemoved = removed.includes(e.name);
    check(!(isOpened && isRemoved), () => `${e.name} both opened and removed`);
    check(actions.isListed(e.name) === (!isOpened && !isRemoved), () => `${e.name}: listed ${actions.isListed(e.name)} but opened ${isOpened}, removed ${isRemoved}`);
    check(actions.wasOpened(e.name) === isOpened, () => `${e.name}: wasOpened disagrees`);
    if (isOpened) check(files.has(e.name), () => `opened backup ${e.name} is gone from disk`);
  }
  totals.opened += opened.length;
  totals.removed += removed.length;
}
const totals = { opened: 0, removed: 0 };

describe('fuzz: Drawing Recovery Manager actions', () => {
  it('opened backups are never deleted, nothing runs twice at once, everything settles', async () => {
    vi.useFakeTimers();
    const runs = await fuzz('recovery-actions/clicks', 2000, scenario);
    console.log(`recovery-actions: ${runs} runs, ${totals.opened} backups opened, ${totals.removed} removed`);
    expect(runs).toBeGreaterThan(0);
    if (!process.env.FUZZ_SEED) expect(totals.opened).toBeGreaterThan(100);
  }, 600_000);
});
