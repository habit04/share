// End-to-end check of the experimental 3D viewport (docs/3D-VIEWPORT.md): serve the built renderer
// (dist/), use the default available 3D tools, open /?demo in headless
// Chromium with SwiftShader WebGL2, and check:
//   - a fresh profile exposes the 3D ribbon and controller without activating a renderer;
//   - 3DMODE creates the WebGL canvas, 3DDEMO + 3DVIEW swiso render non-background pixels;
//   - clicking the projected centre of the demo box selects it (Shift adds, empty click clears),
//     hover highlights it;
//   - GPU id-buffer picking and CPU ray picking agree on 20 random screen points (parallel and
//     perspective), and after a WebGL context loss + restore;
//   - orbit / pan / zoom with the mouse change the camera; Undo removes the demo solids;
//   - 3DMODE again returns to the 2D canvas (WebGL canvas removed);
//   - no page errors or console errors.
// Screenshots go to screenshots-3d/ (not part of the 2D baselines).
//
//   npm run build && npm run e2e:3d
// CHROMIUM_PATH overrides the browser executable (else /opt/pw-browsers/chromium when present,
// else Playwright's own download).
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { PNG } from 'pngjs';
import { SHOT_CONTEXT } from './screenshot-env.mjs';

const root = join(process.cwd(), 'dist');
if (!existsSync(join(root, 'index.html'))) {
  console.error('dist/index.html not found: run `npm run build` first.');
  process.exit(2);
}
const outDir = join(process.cwd(), 'screenshots-3d');
await mkdir(outDir, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = join(root, decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname));
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

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

const executablePath = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({ executablePath, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ ...SHOT_CONTEXT, viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console error: ${m.text()}`);
});
await page.goto(`http://127.0.0.1:${port}/?demo&norecover`);
await page.waitForFunction(() => !!(/** @type {any} */ (window).editor));
await page.waitForTimeout(300);

/** Run a command line through the editor and let the frame render. */
const run = async (line) => {
  await page.evaluate((l) => void (/** @type {any} */ (window).editor.runCommand(l)), line);
  await page.waitForTimeout(250);
};
const shot = (name) => page.screenshot({ path: join(outDir, `${name}.png`) });

/** Non-background pixel share of a canvas region, from a real screenshot. */
async function inkShare(selector) {
  const box = await page.locator(selector).boundingBox();
  if (!box) return 0;
  const png = PNG.sync.read(await page.screenshot({ clip: box }));
  const bg = [0x21, 0x28, 0x30];
  let ink = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const d = Math.abs(png.data[i] - bg[0]) + Math.abs(png.data[i + 1] - bg[1]) + Math.abs(png.data[i + 2] - bg[2]);
    if (d > 40) ink++;
  }
  return ink / (png.width * png.height);
}

const state = () => page.evaluate(() => {
  const w = /** @type {any} */ (window);
  const vp = w.jcad3d?.viewport;
  return {
    hasHandle: !!w.jcad3d,
    active: !!w.jcad3d?.active,
    canvases: document.querySelectorAll('canvas.viewport3d').length,
    canvas2dVisibility: document.getElementById('drawing').style.visibility,
    selection: [...w.editor.selection],
    hover: w.jcad3d?.hover ?? null,
    camera: vp ? { ...vp.camera } : null,
    solids: (w.editor.doc.snapshot.model3d?.solids ?? []).map((s) => {
      const p = s.mesh.positions;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[i + k]); hi[k] = Math.max(hi[k], p[i + k]); }
      return { id: s.id, kind: s.feature.kind, center: { x: (lo[0] + hi[0]) / 2, y: (lo[1] + hi[1]) / 2, z: (lo[2] + hi[2]) / 2 } };
    }),
    capabilities: vp ? vp.device.capabilities() : null,
  };
});

/** Click at a canvas-relative CSS position. */
async function clickCanvas(p, modifiers = []) {
  const rect = await page.locator('canvas.viewport3d').boundingBox();
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.click(rect.x + p.x, rect.y + p.y);
  for (const m of modifiers) await page.keyboard.up(m);
  await page.waitForTimeout(120);
}

/** GPU vs CPU picking on n seeded random points inside `area` (canvas CSS px). */
async function comparePicks(label, n, area) {
  const res = await page.evaluate(({ n, area }) => {
    let s = 12345;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const c = /** @type {any} */ (window).jcad3d;
    const out = [];
    for (let i = 0; i < n; i++) {
      const x = area.x + rnd() * area.w, y = area.y + rnd() * area.h;
      const gpu = c.pick(x, y);
      const cpu = c.pickExact(x, y);
      out.push({ x, y, gpu: gpu.id, path: gpu.path, cpu: cpu ? cpu.id : null });
    }
    return out;
  }, { n, area });
  const mismatches = res.filter((r) => r.gpu !== r.cpu);
  const hits = res.filter((r) => r.cpu !== null).length;
  check(res.every((r) => r.path === 'gpu'), `${label}: every pick answered by the GPU id buffer`);
  check(mismatches.length === 0, `${label}: GPU and CPU picking agree on ${n} random points (${hits} hits)${mismatches.length ? ` mismatches: ${JSON.stringify(mismatches)}` : ''}`);
  check(hits >= 3, `${label}: the random points hit solids (${hits})`);
}

/** Screen bounding box (canvas CSS px) of the solids' centres, padded. */
async function solidsArea() {
  const st = await state();
  const pts = await page.evaluate((cs) => cs.map((c) => /** @type {any} */ (window).jcad3d.project(c)), st.solids.map((s) => s.center));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const pad = 80;
  return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + 2 * pad, h: Math.max(...ys) - Math.min(...ys) + 2 * pad };
}

try {
  let st = await state();
  check(st.hasHandle, 'window.jcad3d exists with tools available by default');
  check(await page.evaluate(() => window.editor.settings.experimental3d === true && window.editor.settings.importForeign3d === false && !(/** @type {any} */ (window).jcad3d.kernelStarted)), 'fresh profile exposes 3D tools without foreign import or a kernel');
  check(await page.locator('.ribbon-tab', { hasText: /^3D$/ }).count() === 1, '3D ribbon tab is shown');
  check(st.canvases === 0, 'no WebGL canvas before 3DMODE');

  await run('3DMODE');
  st = await state();
  check(st.active && st.canvases === 1, '3DMODE creates the 3D canvas');
  check(st.canvas2dVisibility === 'hidden', '2D canvas hidden behind the 3D view');
  console.log(`     GPU: ${JSON.stringify(st.capabilities)}`);
  check(!!st.capabilities && /webgl 2/i.test(st.capabilities.version), 'WebGL2 context created');
  await page.waitForTimeout(200);
  const planInk = await inkShare('canvas.viewport3d');
  check(planInk > 0.005, `plan view draws the 2D underlay and grid (${(planInk * 100).toFixed(2)} % ink)`);
  await shot('01-3d-plan');

  await run('3DDEMO');
  await run('3DVIEW swiso');
  st = await state();
  check(st.solids.length === 3, '3DDEMO added box, cylinder and sphere');
  const isoInk = await inkShare('canvas.viewport3d');
  check(isoInk > 0.02, `SW isometric view renders the solids (${(isoInk * 100).toFixed(2)} % ink)`);
  await shot('02-demo-swiso');

  const box = st.solids.find((s) => s.kind === 'box');
  const sphere = st.solids.find((s) => s.kind === 'sphere');
  const boxAt = await page.evaluate((c) => /** @type {any} */ (window).jcad3d.project(c), box.center);
  const sphereAt = await page.evaluate((c) => /** @type {any} */ (window).jcad3d.project(c), sphere.center);
  await clickCanvas(boxAt);
  st = await state();
  check(st.selection.length === 1 && st.selection[0] === box.id, 'clicking the projected box centre selects the box');
  await clickCanvas(sphereAt, ['Shift']);
  st = await state();
  check(st.selection.length === 2 && st.selection.includes(sphere.id), 'Shift+click adds the sphere');
  await shot('03-selected');
  await clickCanvas({ x: 20, y: 20 });
  st = await state();
  check(st.selection.length === 0, 'clicking empty space clears the selection');
  const rect = await page.locator('canvas.viewport3d').boundingBox();
  await page.mouse.move(rect.x + boxAt.x, rect.y + boxAt.y);
  await page.waitForTimeout(120);
  st = await state();
  check(st.hover === box.id, 'hovering the box highlights it');

  await comparePicks('SW iso, parallel', 20, await solidsArea());

  // Orbit with Shift + middle drag, pan with middle drag, zoom with the wheel.
  const cam0 = (await state()).camera;
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
  await page.mouse.move(cx, cy);
  await page.keyboard.down('Shift');
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(cx + 60, cy + 25, { steps: 5 });
  await page.mouse.up({ button: 'middle' });
  await page.keyboard.up('Shift');
  const cam1 = (await state()).camera;
  check(Math.abs(cam1.yaw - cam0.yaw) > 0.1 && Math.abs(cam1.pitch - cam0.pitch) > 0.01, 'Shift + middle drag orbits');
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(cx + 40, cy - 30, { steps: 4 });
  await page.mouse.up({ button: 'middle' });
  const cam2 = (await state()).camera;
  check(cam2.yaw === cam1.yaw && (cam2.target.x !== cam1.target.x || cam2.target.y !== cam1.target.y), 'middle drag pans');
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(150);
  const cam3 = (await state()).camera;
  check(cam3.orthoHeight < cam2.orthoHeight, 'wheel zooms in');
  await run('3DZOOMEXTENTS');
  await shot('04-orbit');
  await comparePicks('orbited, parallel', 20, await solidsArea());

  await run('3DPERSPECTIVE');
  st = await state();
  check(st.camera.projection === 'perspective', '3DPERSPECTIVE switches to perspective');
  await shot('05-perspective');
  await comparePicks('orbited, perspective', 20, await solidsArea());

  // 3DORBIT: left drag orbits until Esc.
  await run('3DORBIT');
  const camA = (await state()).camera;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 50, cy, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press('Escape');
  const camB = (await state()).camera;
  const toolAfter = await page.evaluate(() => /** @type {any} */ (window).editor.tool);
  check(Math.abs(camB.yaw - camA.yaw) > 0.1 && toolAfter === null, '3DORBIT orbits with the left button and Esc ends it');

  // Context loss and restore: buffers are rebuilt and picking still agrees.
  await page.evaluate(() => {
    const vp = /** @type {any} */ (window).jcad3d.viewport;
    /** @type {any} */ (window).__lose = vp.device.gl.getExtension('WEBGL_lose_context');
    /** @type {any} */ (window).__lose.loseContext();
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => /** @type {any} */ (window).__lose.restoreContext());
  await page.waitForTimeout(400);
  st = await state();
  check(st.capabilities.contextLosses === 1, `context loss counted (${st.capabilities.contextLosses})`);
  await run('PLAN');
  await run('3DVIEW seiso');
  const restoredInk = await inkShare('canvas.viewport3d');
  check(restoredInk > 0.02, `renders again after the context is restored (${(restoredInk * 100).toFixed(2)} % ink)`);
  await comparePicks('after context restore, perspective SE iso', 20, await solidsArea());
  await shot('06-restored-seiso');

  await page.evaluate(() => /** @type {any} */ (window).editor.doc.undo());
  await page.waitForTimeout(150);
  st = await state();
  check(st.solids.length === 0, 'Undo removes the demo solids');

  await run('3DMODE');
  st = await state();
  check(!st.active && st.canvases === 0, '3DMODE again removes the 3D canvas');
  check(st.canvas2dVisibility === '', '2D canvas visible again');
  await page.waitForTimeout(200);
  const ink2d = await inkShare('#drawing');
  check(ink2d > 0.005, `2D view draws the drawing again (${(ink2d * 100).toFixed(2)} % ink)`);
  await shot('07-back-to-2d');
} catch (err) {
  failures.push(`exception: ${err instanceof Error ? err.stack : String(err)}`);
  console.error(err);
}

check(errors.length === 0, `no page or console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
await browser.close();
server.close();
if (failures.length) {
  console.error(`\ne2e-3d: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\ne2e-3d: all checks passed');
