/**
 * Tiny property-based / race fuzzing helper (no dependency): a seeded PRNG and a runner that
 * reports the failing seed so a failure can be replayed exactly.
 *
 *   FUZZ_SEED=<n>   run only that seed (reproduce a failure printed by a test)
 *   FUZZ_RUNS=<k>   multiply every property's run count (soak testing)
 *
 * Every property logs one line: its name, how many runs passed and the seed range used.
 */

/** mulberry32: small, fast, good enough for test generation; deterministic per seed. */
export class Rng {
  private s: number;
  constructor(readonly seed: number) {
    this.s = seed >>> 0;
  }
  /** Uniform in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [lo, hi] (inclusive). */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from an empty list');
    return items[Math.floor(this.next() * items.length)]!;
  }
  /** Weighted choice: [[weight, value], ...]. */
  weighted<T>(items: ReadonlyArray<readonly [number, T]>): T {
    const total = items.reduce((s, [w]) => s + w, 0);
    let r = this.next() * total;
    for (const [w, v] of items) {
      r -= w;
      if (r < 0) return v;
    }
    return items[items.length - 1]![1];
  }
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}

function hashName(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return h >>> 0;
}

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

/** Seeds a property runs with: FUZZ_SEED alone, else `runs` (times FUZZ_RUNS) seeds derived from the name. */
export function seedsFor(name: string, runs: number): number[] {
  if (env.FUZZ_SEED) return [Number(env.FUZZ_SEED) >>> 0];
  const n = Math.max(1, Math.round(runs * (Number(env.FUZZ_RUNS) || 1)));
  const base = hashName(name);
  return Array.from({ length: n }, (_, i) => (base + i * 0x9e3779b1) >>> 0);
}

export class FuzzFailure extends Error {
  constructor(
    readonly property: string,
    readonly seed: number,
    readonly failure: unknown,
  ) {
    super(`[fuzz] property "${property}" failed for seed ${seed} (replay: FUZZ_SEED=${seed}): ${failure instanceof Error ? failure.message : String(failure)}`);
    if (failure instanceof Error && failure.stack) this.stack = `${this.message}\n--- failure ---\n${failure.stack}`;
  }
}

/** Run a synchronous property for every seed; throws FuzzFailure naming the first failing seed. */
export function fuzzSync(name: string, runs: number, body: (rng: Rng, seed: number) => void): number {
  const seeds = seedsFor(name, runs);
  for (const seed of seeds) {
    try {
      body(new Rng(seed), seed);
    } catch (err) {
      if (env.FUZZ_SEED) console.error(err);
      throw new FuzzFailure(name, seed, err);
    }
  }
  console.log(`fuzz ${name}: ${seeds.length} run(s) passed, seeds ${seeds[0]}..${seeds[seeds.length - 1]}`);
  return seeds.length;
}

/** Async variant (each run awaited before the next). */
export async function fuzz(name: string, runs: number, body: (rng: Rng, seed: number) => Promise<void>): Promise<number> {
  const seeds = seedsFor(name, runs);
  for (const seed of seeds) {
    try {
      await body(new Rng(seed), seed);
    } catch (err) {
      if (env.FUZZ_SEED) console.error(err);
      throw new FuzzFailure(name, seed, err);
    }
  }
  console.log(`fuzz ${name}: ${seeds.length} run(s) passed, seeds ${seeds[0]}..${seeds[seeds.length - 1]}`);
  return seeds.length;
}

/** Assertion that throws a plain Error (keeps the fuzz loop independent of the test framework). */
export function check(cond: unknown, msg: string | (() => string)): asserts cond {
  if (!cond) throw new Error(typeof msg === 'string' ? msg : msg());
}

/** Test timeout for a fuzz property: 10 minutes, times FUZZ_RUNS (soaks run longer). */
export function fuzzTimeout(ms = 600_000): number {
  return ms * Math.max(1, Number(env.FUZZ_RUNS) || 1);
}
