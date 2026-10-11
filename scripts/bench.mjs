// Interactive performance of the built renderer in headless Chromium, on a dense drawing
// (50,000 entities: 38,000 wires, 8,000 symbol inserts, 4,000 labels - the generator of
// tests/helpers/big-drawing.ts, repeated here so the page can build it).
//
//   npm run build && npm run bench           (JCAD_BENCH_OUT=<folder> keeps bench.json there)
//
// Measures, best of several runs each:
//   render (extents)   one full redraw of the whole drawing (Viewport.render + a 1-pixel read-back,
//                      which waits for the canvas to finish rasterising)
//   render (zoomed)    the same, zoomed in to a 1/16 of the sheet (culling)
//   hover              Editor.onMouseMove over the drawing: rollover pick + overlay update
//   window select      press, drag and release on empty space (selectByBox + selection update)
//   load               Editor.loadState of the 50,000-entity state (includes ZOOM E)
// The Node-side numbers (pick / select / snap with and without the spatial index, the 20-drawing
// project reports) come from tests/perf-dense.test.ts; docs/PERFORMANCE.md collects both.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { checkBrowserBudgets, BROWSER_BUDGETS } from './bench-budgets.mjs';

const root = join(process.cwd(), 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let p = join(root, url.pathname === '/' ? 'index.html' : url.pathname);
  try {
    if ((await stat(p)).isDirectory()) p = join(p, 'index.html');
    res.setHeader('Content-Type', types[extname(p)] ?? 'application/octet-stream');
    res.end(await readFile(p));
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGE ERROR ${e.message}`));
await page.goto(`http://127.0.0.1:${port}/?norecover`);
await page.waitForFunction(() => !!window.editor, null, { timeout: 30_000 });

const result = await page.evaluate(async () => {
  const ed = window.editor;
  // ---- the dense drawing (same generator as tests/helpers/big-drawing.ts)
  const block = {
    name: 'PERF_SYM',
    basePoint: { x: 0, y: 0 },
    entities: [
      { id: 'b1', layer: '0', color: 'ByLayer', type: 'line', a: { x: -0.25, y: 0 }, b: { x: -0.05, y: 0 } },
      { id: 'b2', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0.05, y: 0 }, b: { x: 0.25, y: 0 } },
      { id: 'b3', layer: '0', color: 'ByLayer', type: 'line', a: { x: -0.05, y: -0.1 }, b: { x: -0.05, y: 0.1 } },
      { id: 'b4', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0.05, y: -0.1 }, b: { x: 0.05, y: 0.1 } },
      { id: 'b5', layer: '0', color: 'ByLayer', type: 'circle', center: { x: 0, y: 0.2 }, radius: 0.03 },
    ],
    attributes: [{ tag: 'TAG1', prompt: 'Tag', default: 'X', position: { x: 0, y: 0.25 }, height: 0.1, align: 'center' }],
  };
  const entities = [];
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 38000; i += 1) {
    const x = rnd() * 200;
    const y = rnd() * 150;
    const len = 0.5 + rnd() * 5;
    entities.push({ id: `L${i}`, layer: 'WIRES', color: 'ByLayer', type: 'line', a: { x, y }, b: i % 2 === 0 ? { x: x + len, y } : { x, y: y + len } });
  }
  for (let i = 0; i < 8000; i += 1) {
    entities.push({ id: `I${i}`, layer: 'SYMS', color: 'ByLayer', type: 'insert', block: block.name, position: { x: rnd() * 200, y: rnd() * 150 }, rotation: i % 4 === 0 ? Math.PI / 2 : 0, scale: 1, attributes: { TAG1: `K${i}` } });
  }
  for (let i = 0; i < 4000; i += 1) {
    entities.push({ id: `T${i}`, layer: 'DESC', color: 'ByLayer', type: 'text', position: { x: rnd() * 200, y: rnd() * 150 }, text: `LABEL ${i} MOTOR STARTER`, height: 0.125, rotation: 0, align: 'left' });
  }
  const base = ed.doc.snapshot;
  const layers = [...base.layers, ...['WIRES', 'SYMS', 'DESC'].filter((n) => !base.layers.some((l) => l.name === n)).map((name, i) => ({ name, color: i + 1, visible: true, locked: false, lineWeight: 0 }))];
  const state = { ...base, entities, layers, blocks: { ...base.blocks, PERF_SYM: block } };

  /** Median of `runs` timings (the best one for the slow, repeatable draws). */
  const measure = async (fn, runs, pickBest = false) => {
    const times = [];
    for (let i = 0; i < runs; i += 1) {
      const t0 = performance.now();
      await fn(i);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return pickBest ? times[0] : times[Math.floor(times.length / 2)];
  };
  const best = (fn, runs) => measure(fn, runs, true);
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('drawing'));
  const ctx = canvas.getContext('2d');
  const flush = () => ctx.getImageData(0, 0, 1, 1);
  const out = {};

  out.load = await best(() => {
    ed.loadState(state, null);
  }, 2);
  ed.runCommand('ZOOM E');
  ed.selection = new Set();
  const ov = ed.overlay;
  ov.selection = ed.selection;
  ed.viewport.render(ov); // first draw pays for the geometry caches
  flush();
  out.renderExtents = await best(() => {
    ed.viewport.render(ov);
    flush();
  }, 5);
  const view = { c: { ...ed.viewport.center }, s: ed.viewport.scale };
  ed.viewport.scale *= 4;
  out.renderZoomed = await best(() => {
    ed.viewport.render(ov);
    flush();
  }, 5);
  ed.viewport.center = view.c;
  ed.viewport.scale = view.s;

  const rect = canvas.getBoundingClientRect();
  const at = (fx, fy) => ({ clientX: rect.left + rect.width * fx, clientY: rect.top + rect.height * fy, bubbles: true });
  // Hover: the first two moves after a load build the spatial index; then every move is a lookup.
  ed.onMouseMove(new MouseEvent('mousemove', at(0.3, 0.3)));
  ed.onMouseMove(new MouseEvent('mousemove', at(0.31, 0.3)));
  out.hover = await measure((i) => {
    ed.onMouseMove(new MouseEvent('mousemove', at(0.2 + (i % 50) * 0.012, 0.25 + (i % 7) * 0.07)));
  }, 60);
  // Window selection from the empty margin left of the sheet (nothing to pick there): press,
  // drag right into the drawing, release.
  const left = ed.viewport.toScreen({ x: -2, y: 75 });
  const fx = Math.max(0.005, left.x / rect.width);
  out.windowSelect = await measure(async (i) => {
    ed.selection = new Set();
    const a = at(fx, 0.35 + i * 0.002);
    const b = at(fx + 0.12, 0.5 + i * 0.002);
    ed.onMouseDown(new MouseEvent('mousedown', { ...a, button: 0 }));
    ed.onMouseMove(new MouseEvent('mousemove', b));
    ed.onMouseUp(new MouseEvent('mouseup', { ...b, button: 0 }));
  }, 11);
  out.selected = ed.selection.size;
  out.entities = ed.doc.entities.length;
  return out;
});

await browser.close();
server.close();
const fmt = (ms) => `${ms.toFixed(1).padStart(8)} ms`;
console.log(`bench: ${result.entities} entities (Chromium ${browser.version()}, ${process.platform} ${process.arch})`);
console.log(`  load (loadState + ZOOM E)  ${fmt(result.load)}`);
console.log(`  render, whole drawing      ${fmt(result.renderExtents)}`);
console.log(`  render, zoomed 4x          ${fmt(result.renderZoomed)}`);
console.log(`  hover (pick + overlay)     ${fmt(result.hover)}   (median of 60 moves)`);
console.log(`  window select              ${fmt(result.windowSelect)}   (median of 11 drags, ${result.selected} selected)`);
if (process.env.JCAD_BENCH_OUT) {
  const dir = resolve(process.env.JCAD_BENCH_OUT);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'bench.json'), JSON.stringify({ ...result, chromium: browser.version(), platform: `${process.platform} ${process.arch}`, at: new Date().toISOString() }, null, 2));
}
for (const e of errors) console.error(e);
if (process.env.JCAD_BENCH_ASSERT === '1') {
  const factor = Number(process.env.JCAD_PERF_FACTOR ?? 1);
  const failures = checkBrowserBudgets(result, factor);
  errors.push(...failures);
  for (const failure of failures) console.error(`FAIL browser performance: ${failure}`);
  console.log(`bench budgets: ${failures.length ? 'FAILED' : 'OK'} (factor ${factor}; ${JSON.stringify(BROWSER_BUDGETS)})`);
}
process.exit(errors.length ? 1 : 0);
