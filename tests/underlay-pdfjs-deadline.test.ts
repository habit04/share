import './pdfjs-node-shims';
import { describe, it, expect } from 'vitest';
import { createPdfjsEngine } from '../src/io/underlay-pdfjs';
import type { UnderlayCanvasFactory, UnderlayCanvasSlot } from '../src/io/underlay-engine';
import { DEFAULT_UNDERLAY_CAPS } from '../src/io/underlay-adapter';
import { gatedWorkerFactory } from './pdfjs-gated-worker';

// P28 PR #42 fix (1) — Codex P1: the deadline and abort must cover the
// WHOLE operation, not only the final render. Before the fix only the
// render await had a watchdog; a worker that stalled the open, a
// pageSize or a getPage hung the operation forever. These tests gate
// the worker's message channel (tests/pdfjs-gated-worker.ts) so the
// chosen request is NEVER answered — the refusal can then only come
// from the operation-wide deadline/abort supervisor, at any CPU speed.
// The cap is shrunk to 2,000 ms so a refusal is quick while a healthy
// gated worker (real thread boot + parse, a few hundred ms) still fits
// comfortably inside it; determinism comes from the gate, not timing.

const CAPS = { ...DEFAULT_UNDERLAY_CAPS, deadlineMs: 2_000 };
const TEST_TIMEOUT = 30_000;

/** Minimal correct-xref PDF (200x100pt pages, a filled rect); `pages` = 1 or 2. */
function buildPdf(pages: 1 | 2 = 1): Uint8Array {
  const stream = '0 0 1 rg 10 10 50 50 re f';
  const objs: Array<[number, string]> = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, pages === 1
      ? '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'
      : '<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << >> >>'],
    [4, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`],
  ];
  if (pages === 2) {
    objs.push([5, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 6 0 R /Resources << >> >>']);
    objs.push([6, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]);
  }
  objs.sort((a, b) => a[0] - b[0]);
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [num, content] of objs) {
    offsets[num] = out.length;
    out += `${num} 0 obj\n${content}\nendobj\n`;
  }
  const xrefAt = out.length;
  const size = Math.max(...objs.map(([n]) => n)) + 1;
  out += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n += 1) out += `${String(offsets[n] ?? 0).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** Stub canvas in the underlay-pdfjs.test.ts pattern (pdfjs calls what it calls; the proxy records nothing here). */
function stubFactory(): UnderlayCanvasFactory {
  const makeCtx = (): unknown => {
    const base: Record<string, unknown> = {
      measureText: (t: string) => ({ width: t.length * 6 }),
      createLinearGradient: () => ({ addColorStop: () => undefined }),
      createRadialGradient: () => ({ addColorStop: () => undefined }),
      createPattern: () => ({}),
      getImageData: (x: number, y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(0, w * h * 4)), width: w, height: h }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      getLineDash: () => [],
    };
    return new Proxy(base, {
      get: (t, p) => (p in t ? t[p as string] : () => undefined),
      set: () => true,
    });
  };
  return {
    create: (width: number, height: number): UnderlayCanvasSlot => {
      const context = makeCtx();
      const canvas = { width, height, getContext: () => context };
      return { canvas, context, width, height } as unknown as UnderlayCanvasSlot;
    },
  };
}

const newGatedEngine = (configure?: Parameters<typeof gatedWorkerFactory>[0], caps = CAPS) => {
  const gate = gatedWorkerFactory(configure);
  const engine = createPdfjsEngine({ createWorker: gate.createWorker, canvasFactory: stubFactory(), caps });
  return { engine, gate };
};

describe('operation-wide deadline (PR #42 fix 1)', () => {
  it('a healthy gated worker opens, sizes and renders (fixture control)', async () => {
    const { engine, gate } = newGatedEngine();
    const opened = await engine.open(buildPdf());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      const sized = await opened.value.pageSize(1);
      expect(sized.ok).toBe(true);
      const rendered = await opened.value.renderPage(1, 1);
      expect(rendered.ok).toBe(true);
      expect(gate.workers).toHaveLength(1);
      expect(gate.workers[0]!.terminations).toBe(0);
    } finally {
      opened.value.close();
    }
  }, TEST_TIMEOUT);

  it('a worker that never replies to open: open refuses deadline at the cap, worker terminated exactly once', async () => {
    const { engine, gate } = newGatedEngine((worker, index) => { if (index === 0) worker.drop('GetDocRequest'); });
    const t0 = Date.now();
    const opened = await engine.open(buildPdf());
    const wallMs = Date.now() - t0;
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.code).toBe('deadline');
    expect(wallMs).toBeLessThan(10_000);
    expect(gate.workers).toHaveLength(1);
    expect(gate.workers[0]!.terminations).toBe(1);
  }, TEST_TIMEOUT);

  it('a worker that never replies to pageSize: deadline refusal, exactly one terminate, the next call succeeds on a fresh worker', async () => {
    const { engine, gate } = newGatedEngine((worker, index) => { if (index === 0) worker.drop('GetPage'); });
    const opened = await engine.open(buildPdf());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      const stalled = await opened.value.pageSize(1);
      expect(stalled.ok).toBe(false);
      if (!stalled.ok) expect(stalled.code).toBe('deadline');
      expect(gate.workers[0]!.terminations).toBe(1);
      // Recovery: the next call re-opens a terminated session on a fresh worker.
      const sized = await opened.value.pageSize(1);
      expect(sized.ok).toBe(true);
      if (sized.ok) expect(sized.value).toEqual({ width: 200, height: 100 });
      expect(gate.workers).toHaveLength(2);
      expect(gate.workers[1]!.terminations).toBe(0);
    } finally {
      opened.value.close();
    }
  }, TEST_TIMEOUT);

  it('a worker that never replies to the getPage inside a render: deadline refusal, exactly one terminate, the next render succeeds', async () => {
    // pageSize(1)'s getPage is the first; the render of page 2 sends
    // its own (pdfjs caches page 1, so the render must target page 2).
    const { engine, gate } = newGatedEngine((worker, index) => { if (index === 0) worker.dropAfter('GetPage', 1); });
    const opened = await engine.open(buildPdf(2));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      const sized = await opened.value.pageSize(1);
      expect(sized.ok).toBe(true);
      const stalled = await opened.value.renderPage(2, 1);
      expect(stalled.ok).toBe(false);
      if (!stalled.ok) expect(stalled.code).toBe('deadline');
      expect(gate.workers[0]!.sentCount('GetPage')).toBe(2);
      expect(gate.workers[0]!.terminations).toBe(1);
      const rendered = await opened.value.renderPage(2, 1);
      expect(rendered.ok).toBe(true);
      expect(gate.workers).toHaveLength(2);
    } finally {
      opened.value.close();
    }
  }, TEST_TIMEOUT);

  it('a worker that never replies to render: deadline refusal at the cap, exactly one terminate, the next render succeeds', async () => {
    const { engine, gate } = newGatedEngine((worker, index) => { if (index === 0) worker.drop('GetOperatorList'); });
    const opened = await engine.open(buildPdf());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      const stalled = await opened.value.renderPage(1, 1);
      expect(stalled.ok).toBe(false);
      if (!stalled.ok) expect(stalled.code).toBe('deadline');
      expect(gate.workers[0]!.terminations).toBe(1);
      const rendered = await opened.value.renderPage(1, 1);
      expect(rendered.ok).toBe(true);
      expect(gate.workers).toHaveLength(2);
      expect(gate.workers[1]!.terminations).toBe(0);
    } finally {
      opened.value.close();
    }
  }, TEST_TIMEOUT);

  it('aborting a pending open settles cancelled and terminates the worker exactly once', async () => {
    const { engine, gate } = newGatedEngine(
      (worker, index) => { if (index === 0) worker.drop('GetDocRequest'); },
      { ...DEFAULT_UNDERLAY_CAPS, deadlineMs: 60_000 }, // the abort, not the cap, must settle this
    );
    const controller = new AbortController();
    const pending = engine.open(buildPdf(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const opened = await pending;
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.code).toBe('cancelled');
    expect(gate.workers).toHaveLength(1);
    expect(gate.workers[0]!.terminations).toBe(1);
  }, TEST_TIMEOUT);
});

/** Settle-or-sentinel race: distinguishes "refused" from "still pending" without a test-timeout death. */
const settleWithin = async <T,>(p: Promise<T>, ms: number): Promise<{ settled: true; value: T } | { settled: false }> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ settled: false }>((resolve) => { timer = setTimeout(() => resolve({ settled: false }), ms); });
  const raced = await Promise.race([p.then((value) => ({ settled: true as const, value })), timeout]);
  if (timer) clearTimeout(timer);
  return raced;
};

/** A page tree with /Count 0: getDocument resolves with numPages === 0 (probed at b95f2d5). */
function buildZeroPagePdf(): Uint8Array {
  const objs: Array<[number, string]> = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 0 /Kids [] >>'],
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [num, content] of objs) {
    offsets[num] = out.length;
    out += `${num} 0 obj\n${content}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += 'xref\n0 3\n0000000000 65535 f \n';
  for (let n = 1; n < 3; n += 1) out += `${String(offsets[n] ?? 0).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe('unsuccessful-open cleanup owns the session (PR #42 cleanup 1)', () => {
  // Codex P1 at b95f2d5: the cap refusals' cleanup awaited
  // loadingTask.destroy() BEFORE the hard terminate, outside the
  // supervisor. A worker that withholds its 'Terminate' reply holds
  // that await forever: the open stays pending past the deadline with
  // ZERO terminations, and an abort cannot settle it. A deadline/abort
  // landing right after a successful parse likewise returned the
  // refusal with the session's worker left alive. The session is owned
  // by the operation until open succeeds: every unsuccessful open
  // hard-terminates the worker FIRST, synchronously, and the graceful
  // destroy trails fire-and-forget.

  it('over-page-cap + a worker that withholds Terminate: open settles with the cap refusal, worker terminated exactly once', async () => {
    const { engine, gate } = newGatedEngine(
      (worker, index) => { if (index === 0) worker.drop('Terminate'); },
      { ...DEFAULT_UNDERLAY_CAPS, deadlineMs: 10_000, maxPages: 1 },
    );
    const opened = await settleWithin(engine.open(buildPdf(2)), 6_000);
    expect(opened.settled).toBe(true);
    if (!opened.settled) return;
    expect(opened.value.ok).toBe(false);
    if (!opened.value.ok) expect(opened.value.code).toBe('too-many-pages');
    expect(gate.workers).toHaveLength(1);
    expect(gate.workers[0]!.terminations).toBe(1);
  }, TEST_TIMEOUT);

  it('zero-page + a worker that withholds Terminate: open settles corrupt, worker terminated exactly once', async () => {
    const { engine, gate } = newGatedEngine(
      (worker, index) => { if (index === 0) worker.drop('Terminate'); },
      { ...DEFAULT_UNDERLAY_CAPS, deadlineMs: 10_000 },
    );
    const opened = await settleWithin(engine.open(buildZeroPagePdf()), 6_000);
    expect(opened.settled).toBe(true);
    if (!opened.settled) return;
    expect(opened.value.ok).toBe(false);
    if (!opened.value.ok) expect(opened.value.code).toBe('corrupt');
    expect(gate.workers).toHaveLength(1);
    expect(gate.workers[0]!.terminations).toBe(1);
  }, TEST_TIMEOUT);

  it('a deadline landing right after a successful parse disposes the session (worker terminated, not left alive)', async () => {
    // The injected clock drives the cooperative deadline: open() reads
    // it at op start, at its first check, after the module load, and
    // after createSession — the 4th read is the post-parse check, and
    // it jumps past the cap, so the refusal is produced by the parse
    // having SUCCEEDED too late, with a live session in hand.
    let calls = 0;
    const now = (): number => { calls += 1; return calls >= 4 ? 60_000 : 0; };
    const gate = gatedWorkerFactory();
    const engine = createPdfjsEngine({ createWorker: gate.createWorker, canvasFactory: stubFactory(), caps: { ...DEFAULT_UNDERLAY_CAPS, deadlineMs: 5_000 }, now });
    const opened = await engine.open(buildPdf());
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.code).toBe('deadline');
    expect(gate.workers).toHaveLength(1);
    expect(gate.workers[0]!.terminations).toBe(1);
  }, TEST_TIMEOUT);

  it('an abort landing right after a successful parse settles cancelled and disposes the session', async () => {
    // The abort is delivered WITH the worker's GetDocRequest reply:
    // it must settle 'cancelled' with the worker terminated exactly
    // once — never a hang, never a live worker left behind, never a
    // double terminate. Honest scoping: this leg also passes at
    // b95f2d5, where the supervisor race's own teardown does the
    // disposing — pdfjs's promise chain gives a test no deterministic
    // purchase on the narrower post-parse continuation window for
    // the abort flavor. The FAILING-FIRST proof for that window is
    // the deadline leg above (same guard.check -> dispose path,
    // re-verified RED at b95f2d5 by stashing the fix: the refusal
    // returned with zero terminations); this leg pins the abort
    // flavor's settlement shape against regressions either way.
    const controller = new AbortController();
    const gate = gatedWorkerFactory((worker) => {
      let docCallback: number | undefined;
      const post = worker.postMessage.bind(worker) as (message: { action?: string; callbackId?: number }) => void;
      worker.postMessage = (message: { action?: string; callbackId?: number }): void => {
        if (message?.action === 'GetDocRequest' && docCallback === undefined) {
          docCallback = message.callbackId;
          worker.addEventListener('message', (event) => {
            const data = event.data as { callbackId?: number } | undefined;
            if (data?.callbackId === docCallback) void Promise.resolve().then(() => controller.abort());
          });
        }
        post(message);
      };
    });
    const engine = createPdfjsEngine({ createWorker: gate.createWorker, canvasFactory: stubFactory(), caps: { ...DEFAULT_UNDERLAY_CAPS, deadlineMs: 60_000 } });
    const opened = await engine.open(buildPdf(), { signal: controller.signal });
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.code).toBe('cancelled');
    expect(gate.workers).toHaveLength(1);
    expect(gate.workers[0]!.terminations).toBe(1);
  }, TEST_TIMEOUT);

  it('aborting while a withheld-Terminate cleanup is in flight cannot strand the open', async () => {
    const { engine, gate } = newGatedEngine(
      (worker, index) => { if (index === 0) worker.drop('Terminate'); },
      { ...DEFAULT_UNDERLAY_CAPS, deadlineMs: 60_000, maxPages: 1 },
    );
    const controller = new AbortController();
    let settledFlag = false;
    const pending = engine.open(buildPdf(2), { signal: controller.signal }).then((result) => { settledFlag = true; return result; });
    // Wait until the cleanup is entered (the graceful destroy has
    // asked the worker to Terminate; the gated worker never answers)
    // or the open settles, then abort: at b95f2d5 the open is inside
    // the awaited destroy and the abort settles nothing — the open
    // hangs past the bound below.
    const enterBy = Date.now() + 5_000;
    while (!settledFlag && (gate.workers[0]?.sentCount('Terminate') ?? 0) === 0 && Date.now() < enterBy) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    const opened = await settleWithin(pending, 5_000);
    expect(opened.settled).toBe(true);
    if (!opened.settled) return;
    expect(opened.value.ok).toBe(false);
    // With the fix, disposal is synchronous (terminate first, destroy
    // fire-and-forget), so the cap refusal the operation had already
    // produced is the settlement — what this pins is that the abort
    // cannot strand the open the way the awaited destroy let it.
    if (!opened.value.ok) expect(opened.value.code).toBe('too-many-pages');
    expect(gate.workers[0]!.terminations).toBe(1);
  }, TEST_TIMEOUT);
});
