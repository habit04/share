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
