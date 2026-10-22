// P28 F+H fixes (2026-10-22): clipped/tile rendering (class F) and the
// hard render deadline (class H). Adapter legs run the REAL pdfjs adapter
// against the REAL napi canvas (the corpus harness pattern — real
// Path2D/DOMMatrix globals, or napi clip() rejects pdfjs's calls);
// planner and display-service legs are pure/interface-level.
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

const req = createRequire(import.meta.url);
const napi = req('@napi-rs/canvas') as Record<string, any>;
const g = globalThis as Record<string, unknown>;
g.Path2D = napi.Path2D; g.DOMMatrix = napi.DOMMatrix; g.ImageData = napi.ImageData;
const U8 = Uint8Array.prototype as unknown as Record<string, unknown>;
if (!U8.toHex) { U8.toHex = function (this: Uint8Array) { return [...this].map((b) => b.toString(16).padStart(2, '0')).join(''); }; U8.fromHex = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16))); U8.toBase64 = function (this: Uint8Array) { return Buffer.from(this).toString('base64'); }; U8.fromBase64 = (b64: string) => Uint8Array.from(Buffer.from(b64, 'base64')); }
const Mp = Map.prototype as unknown as Record<string, unknown>;
if (!Mp.getOrInsert) { Mp.getOrInsert = function (this: Map<unknown, unknown>, k: unknown, v: unknown) { if (!this.has(k)) this.set(k, v); return this.get(k); }; Mp.getOrInsertComputed = function (this: Map<unknown, unknown>, k: unknown, f: (k: unknown) => unknown) { if (!this.has(k)) this.set(k, f(k)); return this.get(k); }; }

import { createPdfjsEngine } from '../src/io/underlay-pdfjs';
import { planUnderlayTiles, underlayRefusal, type UnderlayCanvasFactory, type UnderlayCanvasSlot, type UnderlayRasterEngine } from '../src/io/underlay-engine';
import { DEFAULT_UNDERLAY_CAPS } from '../src/io/underlay-adapter';
import { createUnderlayDisplayService } from '../src/app/underlay-render';
import type { UnderlayDefinition } from '../src/core/underlay';
import type { UnderlayEntity } from '../src/core/entities';

const WORKER_SRC = new URL('../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;
const napiFactory: UnderlayCanvasFactory = {
  create(width: number, height: number): UnderlayCanvasSlot {
    const canvas = napi.createCanvas(width, height);
    const slot = { canvas, context: canvas.getContext('2d'), width, height };
    return slot as unknown as UnderlayCanvasSlot;
  },
};
const newEngine = (extra = {}) => createPdfjsEngine({ workerSrc: WORKER_SRC, canvasFactory: napiFactory, ...extra });

// ------------------------------------------------------------- PDF builder
class Pdf {
  private objs = new Map<number, Buffer>();
  private next = 1;
  alloc(): number { const n = this.next; this.next += 1; return n; }
  set(num: number, body: string | Buffer): void { this.objs.set(num, Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1')); }
  stream(num: number, dict: string, data: Buffer | string): void {
    const d = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
    this.set(num, Buffer.concat([Buffer.from(`${dict.replace(/\/Length \d+/, `/Length ${d.length}`)} stream\n`, 'latin1'), d, Buffer.from('\nendstream', 'latin1')]));
  }
  build(root: number): Uint8Array {
    const parts: Buffer[] = [Buffer.from('%PDF-1.7\n', 'latin1')];
    let len = parts[0]!.length;
    const offsets = new Map<number, number>();
    for (const num of [...this.objs.keys()].sort((a, b) => a - b)) {
      offsets.set(num, len);
      const head = Buffer.from(`${num} 0 obj\n`, 'latin1'); const tail = Buffer.from('\nendobj\n', 'latin1');
      const body = this.objs.get(num)!;
      parts.push(head, body, tail); len += head.length + body.length + tail.length;
    }
    const size = Math.max(...this.objs.keys()) + 1;
    let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let n = 1; n < size; n += 1) xref += `${String(offsets.get(n) ?? 0).padStart(10, '0')} 00000 n \n`;
    xref += `trailer\n<< /Size ${size} /Root ${root} 0 R >>\nstartxref\n${len}\n%%EOF\n`;
    parts.push(Buffer.from(xref, 'latin1'));
    return new Uint8Array(Buffer.concat(parts));
  }
}
function docOf(pages: Array<{ w: number; h: number; content: string; resources: string }>): Uint8Array {
  const pdf = new Pdf();
  const cat = pdf.alloc(); const tree = pdf.alloc();
  const kids: number[] = [];
  for (const p of pages) {
    const page = pdf.alloc(); const cont = pdf.alloc(); kids.push(page);
    pdf.set(page, `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${p.w} ${p.h}] /Contents ${cont} 0 R /Resources << ${p.resources} >> >>`);
    pdf.stream(cont, '<< /Length 0 >>', p.content);
  }
  pdf.set(cat, `<< /Type /Catalog /Pages ${tree} 0 R >>`);
  pdf.set(tree, `<< /Type /Pages /Count ${pages.length} /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] >>`);
  return pdf.build(cat);
}
const WHITE_BG = (w: number, h: number) => `1 1 1 rg 0 0 ${w} ${h} re f `;
const HELV = '/Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >>';

/** ARCH E sheet (2384x3370 pt) with a title block bottom-right, like corpus F2/F4. */
function archESheet(): Uint8Array {
  const content = WHITE_BG(2384, 3370)
    + '0 0 0 RG 2 w 40 40 2304 3290 re S '
    + '1 w 1700 60 640 120 re S 1700 120 m 2340 120 l S '
    + '0 0 0 rg BT /F1 20 Tf 1750 130 Td (TITLE) Tj ET BT /F1 16 Tf 1750 92 Td (SCALE 1:50) Tj ET';
  return docOf([{ w: 2384, h: 3370, content, resources: HELV }]);
}
/** The corpus H5 construction at a chosen depth (Fi paints F(i-1) twice at half scale). */
function billionLaughs(depth: number): Uint8Array {
  const pdf = new Pdf();
  const forms: number[] = [];
  for (let i = 0; i <= depth; i++) forms.push(pdf.alloc());
  pdf.stream(forms[0]!, '<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources << >> /Length 0 >>', '0 0 0 rg 0 0 10 10 re f');
  for (let i = 1; i <= depth; i++) {
    pdf.stream(forms[i]!, `<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources << /XObject << /G ${forms[i - 1]} 0 R >> >> /Length 0 >>`, 'q 0.5 0 0 0.5 0 0 cm /G Do Q q 0.5 0 0 0.5 5 0 cm /G Do Q');
  }
  const cat = pdf.alloc(); const tree = pdf.alloc(); const page = pdf.alloc(); const cont = pdf.alloc();
  pdf.set(cat, `<< /Type /Catalog /Pages ${tree} 0 R >>`);
  pdf.set(tree, `<< /Type /Pages /Count 1 /Kids [${page} 0 R] >>`);
  pdf.set(page, `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 300 300] /Contents ${cont} 0 R /Resources << /XObject << /FT ${forms[depth]} 0 R >> >> >>`);
  pdf.stream(cont, '<< /Length 0 >>', 'q 1 0 0 1 100 100 cm /FT Do Q');
  return pdf.build(cat);
}
function darkPixels(raster: { image: unknown; width: number; height: number }): number {
  const canvas = raster.image as { getContext(kind: string): { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } } };
  const data = canvas.getContext('2d').getImageData(0, 0, raster.width, raster.height).data;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i + 3]! > 0 && data[i]! < 128) n += 1;
  return n;
}

// ------------------------------------------------------------- planner
describe('planUnderlayTiles', () => {
  it('a small region at a small scale is a single tile equal to the region', () => {
    expect(planUnderlayTiles({ x: 10, y: 20, width: 100, height: 50 }, 2, DEFAULT_UNDERLAY_CAPS.maxScanBytes))
      .toEqual([{ x: 10, y: 20, width: 100, height: 50 }]);
  });

  it('tiles cover the region exactly and every tile charges under the cap', () => {
    const region = { x: 0, y: 0, width: 2384, height: 3370 };
    const tiles = planUnderlayTiles(region, 4, DEFAULT_UNDERLAY_CAPS.maxScanBytes);
    expect(tiles.length).toBeGreaterThan(1);
    for (const t of tiles) {
      const bytes = Math.ceil(t.width * 4) * Math.ceil(t.height * 4) * 4;
      expect(bytes).toBeLessThanOrEqual(DEFAULT_UNDERLAY_CAPS.maxScanBytes);
    }
    const area = tiles.reduce((a, t) => a + t.width * t.height, 0);
    expect(area).toBeCloseTo(region.width * region.height, 6);
    // row-major, no overlaps on a shared edge grid
    const xs = [...new Set(tiles.map((t) => t.x))].sort((a, b) => a - b);
    expect(xs[0]).toBe(0);
    expect(Math.max(...tiles.map((t) => t.x + t.width))).toBeCloseTo(2384, 9);
    expect(Math.max(...tiles.map((t) => t.y + t.height))).toBeCloseTo(3370, 9);
  });

  it('an empty or invalid request plans nothing', () => {
    expect(planUnderlayTiles({ x: 0, y: 0, width: 0, height: 10 }, 2, 8_388_608)).toEqual([]);
    expect(planUnderlayTiles({ x: 0, y: 0, width: 10, height: 10 }, 0, 8_388_608)).toEqual([]);
  });
});

// ------------------------------------------------------------- class F: adapter renderRegion
// CI hygiene (lead ruling, 2026-10-22, after PR #42): these are pdfjs
// adapter tests — each gets a CI-suited 30 s per-test timeout (repo
// default is 5 s) and destroys the document it opens in a finally, so
// no loading task or session outlives its test.
describe('F: clipped region rendering (pdfjs adapter)', () => {
  it('the whole ARCH E page at scale 4 still refuses scan-limit (the F failure, unchanged)', async () => {
    const engine = newEngine();
    const opened = await engine.open(archESheet());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      const r = await opened.value.renderPage(1, 4);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('scan-limit');
    } finally {
      opened.value.close();
    }
  }, 30_000);

  it('a 400%-zoom clip of the title block renders under the cap, with the title text in it', async () => {
    const engine = newEngine();
    const opened = await engine.open(archESheet());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      // Title block in PDF coords x 1700..2340, y 60..180 -> clip space
      // (top-left origin): y = 3370-180 .. 3370-60 = 3190..3310.
      const clip = { x: 1690, y: 3180, width: 660, height: 140 };
      const r = await opened.value.renderRegion(1, clip, 4);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.region).toEqual(clip);
      expect(r.value.width).toBe(2640); // 660 * 4
      expect(r.value.height).toBe(560); // 140 * 4
      expect(r.value.width * r.value.height * 4).toBeLessThanOrEqual(DEFAULT_UNDERLAY_CAPS.maxScanBytes);
      expect(darkPixels(r.value)).toBeGreaterThan(200); // frame lines + TITLE + SCALE 1:50
    } finally {
      opened.value.close();
    }
  }, 30_000);

  it('a single clip whose raster exceeds the cap refuses scan-limit and says to tile', async () => {
    const engine = newEngine();
    const opened = await engine.open(archESheet());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      const r = await opened.value.renderRegion(1, { x: 0, y: 0, width: 1000, height: 1000 }, 4);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('scan-limit');
        expect(r.reason).toMatch(/planUnderlayTiles/);
      }
    } finally {
      opened.value.close();
    }
  }, 30_000);

  it('a clip partially outside the page is intersected; a clip fully outside refuses corrupt', async () => {
    const engine = newEngine();
    const opened = await engine.open(archESheet());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      const part = await opened.value.renderRegion(1, { x: -100, y: -50, width: 300, height: 200 }, 1);
      expect(part.ok).toBe(true);
      if (part.ok) expect(part.value.region).toEqual({ x: 0, y: 0, width: 200, height: 150 });
      const out = await opened.value.renderRegion(1, { x: 5000, y: 0, width: 100, height: 100 }, 1);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.code).toBe('corrupt');
    } finally {
      opened.value.close();
    }
  }, 30_000);
});

// ------------------------------------------------------------- class H: deadline + recovery
describe('H: hard deadline behaviour', () => {
  // The WALL-CLOCK billion-laughs case — the real depth-15 render,
  // refused by hard worker termination at ~5 s, the document answering
  // afterwards on a fresh worker, a control rendering exactly — lives
  // in the REAL-CHROMIUM harness (the F+H delivery's harness/chromium:
  // Electron renderer, production createWorker path, real dedicated
  // worker). That is its acceptance home: the hard terminate is a
  // real-worker property. Its recorded evidence: typed 'deadline'
  // refusals at 5,069 ms and 5,011 ms with fresh-worker recovery
  // (fh-chromium-results.json, F+H delivery 2026-10-22).
  //
  // The case NO LONGER RUNS in this default suite (lead ruling,
  // 2026-10-22, after PR #42 CI): in Node the pdfjs fake worker renders
  // IN-PROCESS and its render loop never yields to the event loop
  // (measured: zero timer ticks across a 121 s depth-17 render), so the
  // watchdog can only fire between operator chunks — 17.2 s on an idle
  // box, catastrophic on a loaded 2-core CI runner (240 s test timeout
  // on Node 22; an assertion failure on Node 24), after which the still
  // spinning render starved every later pdfjs test in the run. The leg
  // below pins the SAME adapter behaviour — the hostile document opens,
  // a render is refused as a typed 'deadline', the document still
  // answers, the engine still renders a control — with the deadline
  // driven by the injected operation clock, so the runaway render never
  // starts in-process. Full assertions, zero starvation surface.
  it('billion-laughs: a render whose time runs out is refused as a typed deadline and the engine stays usable', async () => {
    let t = 0;
    let jumped = false;
    const jumpOnceFactory: UnderlayCanvasFactory = {
      create(width: number, height: number): UnderlayCanvasSlot {
        if (!jumped) { jumped = true; t = 60_000; } // the render's clock jumps past the 5 s deadline
        return napiFactory.create(width, height);
      },
    };
    const engine = newEngine({ canvasFactory: jumpOnceFactory, now: () => t });
    const opened = await engine.open(billionLaughs(15));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      const r = await opened.value.renderPage(1, 1);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('deadline');
      // The document still answers afterwards.
      const sized = await opened.value.pageSize(1);
      expect(sized.ok).toBe(true);
    } finally {
      opened.value.close();
    }
    // And the engine opens + renders a control document.
    t = 0;
    const control = await engine.open(docOf([{ w: 200, h: 200, content: '0 1 0 rg 20 20 160 160 re f', resources: '' }]));
    expect(control.ok).toBe(true);
    if (!control.ok) return;
    try {
      const cr = await control.value.renderPage(1, 1);
      expect(cr.ok).toBe(true);
    } finally {
      control.value.close();
    }
  }, 30_000);
});

// ------------------------------------------------------------- display service tile wiring
const tick = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
const sdef = (over: Partial<UnderlayDefinition> = {}): UnderlayDefinition => ({
  id: 'underlaydef:41', handle: '41', kind: 'pdf', sourcePath: 'plans\\floor.pdf', retainedGroups: [], ...over,
});
const splacement = (over: Partial<UnderlayEntity> = {}): UnderlayEntity => ({
  id: 'u1', layer: 'U', color: 'ByLayer', type: 'underlay', kind: 'pdf', definitionHandle: '41',
  position: { x: 0, y: 0 }, scaleX: 1, scaleY: 1, rotation: 0, flags: 2, retainedGroups: [], ...over,
});
function recordingEngine(opts: { failTiles?: boolean } = {}) {
  const calls = { renderPage: [] as unknown[], renderRegion: [] as Array<{ region: { x: number; y: number; width: number; height: number }; scale: number }> };
  const engine: UnderlayRasterEngine = {
    kind: 'pdf',
    async open() {
      return {
        ok: true as const,
        value: {
          pageCount: 1,
          async pageSize() { return { ok: true as const, value: { width: 200, height: 100 } }; },
          async renderPage(page: number, scale: number) {
            calls.renderPage.push([page, scale]);
            return { ok: true as const, value: { image: { whole: true }, width: Math.round(200 * scale), height: Math.round(100 * scale), pageSize: { width: 200, height: 100 } } };
          },
          async renderRegion(page: number, region: { x: number; y: number; width: number; height: number }, scale: number) {
            calls.renderRegion.push({ region, scale });
            if (opts.failTiles) return underlayRefusal('scan-limit', 'fake tile refusal');
            return { ok: true as const, value: { image: { tile: true, region }, width: Math.round(region.width * scale), height: Math.round(region.height * scale), pageSize: { width: 200, height: 100 }, region } };
          },
          close() { /* no-op */ },
        },
      };
    },
  };
  return { engine, calls };
}
function stubTileFactory(draws: Array<{ dx: number; dy: number }>) {
  return {
    create(width: number, height: number) {
      const canvas = { composite: true };
      return {
        canvas, width, height,
        context: { drawImage(_image: unknown, dx: number, dy: number) { draws.push({ dx, dy }); } },
      };
    },
  };
}

describe('F: display service requests only the visible tiles', () => {
  it('with a visible-region hint: tiles only, composited at their page offsets, renderPage untouched', async () => {
    const { engine, calls } = recordingEngine();
    const draws: Array<{ dx: number; dy: number }> = [];
    const svc = createUnderlayDisplayService({
      engine,
      bytesFor: async () => new Uint8Array([1]),
      definitions: () => ({ 'underlaydef:41': sdef() }),
      targetPixels: 4096,
      visibleRegion: () => ({ x: 0, y: 0, width: 200, height: 100 }),
      tileCanvasFactory: stubTileFactory(draws),
    });
    svc.source(splacement());
    await tick();
    const ready = svc.source(splacement());
    expect(ready?.image).toBeDefined();
    expect(calls.renderPage).toEqual([]);
    // scale = 4096/200 = 20.48; page raster 4096x2048 px = 33.5 MB > cap,
    // so the plan must split into cap-sized tiles: 4 rows of 512 px.
    expect(calls.renderRegion.length).toBe(4);
    for (const c of calls.renderRegion) {
      expect(Math.round(c.region.width * c.scale) * Math.round(c.region.height * c.scale) * 4)
        .toBeLessThanOrEqual(DEFAULT_UNDERLAY_CAPS.maxScanBytes);
    }
    const covered = calls.renderRegion.reduce((a, c) => a + c.region.width * c.region.height, 0);
    expect(covered).toBeCloseTo(200 * 100, 6);
    expect(draws).toEqual([{ dx: 0, dy: 0 }, { dx: 0, dy: 512 }, { dx: 0, dy: 1024 }, { dx: 0, dy: 1536 }]);
    expect(ready?.image?.width).toBe(4096);
    expect(ready?.image?.height).toBe(2048);
  });

  it('without a hint the whole-page path is unchanged', async () => {
    const { engine, calls } = recordingEngine();
    const svc = createUnderlayDisplayService({
      engine,
      bytesFor: async () => new Uint8Array([1]),
      definitions: () => ({ 'underlaydef:41': sdef() }),
    });
    svc.source(splacement());
    await tick();
    expect(svc.source(splacement())?.image).toBeDefined();
    expect(calls.renderPage.length).toBe(1);
    expect(calls.renderRegion).toEqual([]);
  });

  it('a tile refusal fails the load closed (frame + label, no image)', async () => {
    const { engine } = recordingEngine({ failTiles: true });
    const svc = createUnderlayDisplayService({
      engine,
      bytesFor: async () => new Uint8Array([1]),
      definitions: () => ({ 'underlaydef:41': sdef() }),
      visibleRegion: () => ({ x: 0, y: 0, width: 50, height: 50 }),
      tileCanvasFactory: stubTileFactory([]),
    });
    svc.source(splacement());
    await tick();
    expect(svc.source(splacement())?.image).toBeUndefined();
  });
});
