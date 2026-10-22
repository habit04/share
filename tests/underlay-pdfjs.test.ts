import './pdfjs-node-shims';
import { describe, it, expect } from 'vitest';
import { createPdfjsEngine } from '../src/io/underlay-pdfjs';
import type { UnderlayCanvasFactory, UnderlayCanvasSlot } from '../src/io/underlay-engine';
import { DEFAULT_UNDERLAY_CAPS } from '../src/io/underlay-adapter';

// P28 wiring: the pdfjs-dist adapter behind the engine interface
// (provisional dep ruling: exact pin 6.4.299, isEvalSupported:false,
// dedicated worker, all C5 caps enforced in the adapter) and the
// malformed-PDF corpus: every case is a typed refusal or a bounded
// render — never a throw-through, never a cap breach. Deterministic, no
// network: pdfjs is fed byte arrays only.

const WORKER_SRC = new URL('../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;

/** Minimal correct-xref PDF builder (200x100pt pages, a filled rect each). */
function buildPdf(opts: { pages?: number; countOverride?: number; encrypt?: boolean } = {}): Uint8Array {
  const pages = opts.pages ?? 1;
  const kids: number[] = [];
  const objs: Array<[number, string]> = [[1, '<< /Type /Catalog /Pages 2 0 R >>']];
  for (let i = 0; i < pages; i += 1) kids.push(3 + i * 2);
  objs.push([2, `<< /Type /Pages /Count ${opts.countOverride ?? pages} /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] >>`]);
  for (let i = 0; i < pages; i += 1) {
    objs.push([3 + i * 2, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents ${4 + i * 2} 0 R /Resources << >> >>`]);
    const stream = '0 0 1 rg 10 10 50 50 re f';
    objs.push([4 + i * 2, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]);
  }
  // A bogus Standard security handler, properly xref'd: pdfjs parses it,
  // the empty password fails its check, and the open refuses.
  if (opts.encrypt) objs.push([99, '<< /Filter /Standard /V 1 /R 2 /O (xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx) /U (xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx) /P -44 >>']);
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
  out += `trailer\n<< /Size ${size} /Root 1 0 R${opts.encrypt ? ' /Encrypt 99 0 R' : ''} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** Stub canvas: records 2D calls, supplies the concrete methods pdfjs calls. */
function stubFactory(record: string[]): UnderlayCanvasFactory {
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
      get: (t, p) => (p in t ? t[p as string] : (...args: unknown[]) => { record.push(String(p)); void args; }),
      set: () => true,
    });
  };
  return {
    create: (width: number, height: number): UnderlayCanvasSlot => {
      const context = makeCtx();
      // pdfjs v6 derives contexts from the canvas itself (canvas.getContext).
      const canvas = { width, height, getContext: () => context };
      return { canvas, context, width, height };
    },
  };
}

const engine = (extra: Partial<Parameters<typeof createPdfjsEngine>[0]> = {}) =>
  createPdfjsEngine({ workerSrc: WORKER_SRC, canvasFactory: stubFactory([]), ...extra });

describe('pdfjs adapter: well-formed input', () => {
  it('opens, reports page count and size, renders a bounded raster', async () => {
    const calls: string[] = [];
    const e = engine({ canvasFactory: stubFactory(calls) });
    const opened = await e.open(buildPdf());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const doc = opened.value;
    expect(doc.pageCount).toBe(1);
    const size = await doc.pageSize(1);
    expect(size).toEqual({ ok: true, value: { width: 200, height: 100 } });
    const raster = await doc.renderPage(1, 1);
    expect(raster.ok).toBe(true);
    if (raster.ok) {
      expect(raster.value.width).toBe(200);
      expect(raster.value.height).toBe(100);
      expect(raster.value.pageSize).toEqual({ width: 200, height: 100 });
    }
    expect(calls.length).toBeGreaterThan(0); // the page's paint ops reached the canvas context
    const outOfRange = await doc.pageSize(2);
    expect(outOfRange.ok).toBe(false);
    doc.close();
  });
});

describe('pdfjs adapter: malformed-PDF corpus (typed refusal or bounded render, never a throw)', () => {
  it('truncated file', async () => {
    const bytes = buildPdf().slice(0, Math.floor(buildPdf().length * 0.4));
    const r = await engine().open(bytes);
    if (r.ok) {
      expect(r.value.pageCount).toBeLessThanOrEqual(DEFAULT_UNDERLAY_CAPS.maxPages);
      r.value.close();
    } else {
      expect(r.code).toBe('corrupt');
    }
  });

  it('bad xref (offsets zeroed)', async () => {
    const text = new TextDecoder().decode(buildPdf()).replace(/\d{10} 00000 n/g, '0000000000 00000 n');
    const r = await engine().open(new TextEncoder().encode(text));
    if (r.ok) {
      const raster = await r.value.renderPage(1, 1);
      expect(raster.ok).toBe(true); // pdfjs rebuilt the xref: a bounded render
      r.value.close();
    } else {
      expect(r.code).toBe('corrupt');
    }
  });

  it('encrypted without a password: corrupt refusal naming the password', async () => {
    const r = await engine().open(buildPdf({ encrypt: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('corrupt');
      expect(r.reason).toMatch(/password|encrypt/i);
    }
  });

  it('non-PDF bytes: corrupt refusal', async () => {
    const r = await engine().open(new TextEncoder().encode('this is not a pdf at all, just text'));
    expect(r).toMatchObject({ ok: false, code: 'corrupt' });
  });

  it('absurd page-count claim: refused by the page cap or opened with the real count — never over the cap', async () => {
    const r = await engine().open(buildPdf({ countOverride: 99_999_999 }));
    if (r.ok) {
      expect(r.value.pageCount).toBeLessThanOrEqual(DEFAULT_UNDERLAY_CAPS.maxPages);
      r.value.close();
    } else {
      expect(['too-many-pages', 'corrupt']).toContain(r.code);
    }
  });

  it('zero-page document: typed refusal, not an empty success', async () => {
    const r = await engine().open(buildPdf({ pages: 0 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('corrupt');
  });
});

describe('pdfjs adapter: C5 caps enforced in the adapter', () => {
  it('input over 64 MiB refuses before parsing (too-large)', async () => {
    const small = buildPdf();
    const big = new Uint8Array(DEFAULT_UNDERLAY_CAPS.maxBytes + 1);
    big.set(small);
    const r = await engine().open(big);
    expect(r).toMatchObject({ ok: false, code: 'too-large' });
  });

  it('a real page count over 10,000 refuses (too-many-pages)', async () => {
    const r = await engine().open(buildPdf({ pages: 10_001 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(['too-many-pages', 'corrupt']).toContain(r.code);
  });

  it('a render whose pixels exceed the 8 MiB per-page cap refuses before rendering (scan-limit)', async () => {
    const opened = await engine().open(buildPdf());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // 200x100pt at scale 11 = 2200x1100 px x 4 B = 9.68 MB > 8 MiB.
    const r = await opened.value.renderPage(1, 11);
    expect(r).toMatchObject({ ok: false, code: 'scan-limit' });
    opened.value.close();
  });

  it('the per-operation deadline refuses (deadline) when the clock runs out mid-render', async () => {
    let t = 0;
    const jumpingFactory: UnderlayCanvasFactory = {
      create: (width: number, height: number): UnderlayCanvasSlot => {
        t = 60_000; // the operation's clock jumps past the 5 s deadline
        return stubFactory([]).create(width, height);
      },
    };
    const e = engine({ canvasFactory: jumpingFactory, now: () => t });
    const opened = await e.open(buildPdf());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const r = await opened.value.renderPage(1, 1);
    expect(r).toMatchObject({ ok: false, code: 'deadline' });
    opened.value.close();
  });

  it('a pre-aborted signal refuses (cancelled) at open and at render', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await engine().open(buildPdf(), { signal: ac.signal });
    expect(r).toMatchObject({ ok: false, code: 'cancelled' });
    const opened = await engine().open(buildPdf());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const rr = await opened.value.renderPage(1, 1, { signal: ac.signal });
    expect(rr).toMatchObject({ ok: false, code: 'cancelled' });
    opened.value.close();
  });

  it('a non-finite or non-positive scale refuses instead of rendering', async () => {
    const opened = await engine().open(buildPdf());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect((await opened.value.renderPage(1, 0)).ok).toBe(false);
    expect((await opened.value.renderPage(1, Number.NaN)).ok).toBe(false);
    opened.value.close();
  });
});
