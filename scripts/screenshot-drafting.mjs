// Screenshots of the core drafting features (dimensions, linetypes, polyline arcs, arrays)
// from the built renderer in headless Chromium. Run `npx vite build` first.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

const root = join(process.cwd(), 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
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
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
await mkdir('screenshots', { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('CONSOLE', m.text());
});
await page.goto(`http://localhost:${port}/`);
await page.waitForTimeout(400);

/** Run command-line input exactly as a user would type it. */
const type = (lines) =>
  page.evaluate((ls) => {
    const ed = window.editor;
    for (const l of ls) ed.submitInput(l);
  }, lines);

// Home tab so the Draw/Modify panels are visible
await page.evaluate(() => document.querySelectorAll('.ribbon-tab')[0]?.click());

// ---- 1. Dimensions: a plate with a hole, dimensioned every way
await type([
  'LINE', '0,0', '6,0', '', 'ARC', '6,0', '7,1', '6,2', 'LINE', '6,2', '0,2', '0,0', '',
  'CIRCLE', '2,1', '0.5',
  'LINE', '0,2', '2,4', '',
  'DIMLINEAR', '0,0', '6,0', '3,-1',
  'DIMLINEAR', '0,0', '0,2', '-1.2,1',
  'DIMALIGNED', '0,2', '2,4', '0.4,3.6',
  'DIMRADIUS', '7,1', '8.2,1.8',
  'DIMDIAMETER', '2.5,1', '3.4,2.4',
  'DIMANGULAR', '3,2', '1,3', '1.3,2.5',
  'ZOOM', 'E',
]);
await page.waitForTimeout(250);
await page.screenshot({ path: 'screenshots/10-dimensions.png' });

// ---- 2. Linetypes: layer linetypes and per-entity linetypes with LTSCALE
await page.evaluate(() => {
  window.editor.doc.dirty = false;
  window.editor.runCommand('NEW');
});
await page.waitForTimeout(100);
await type([
  'LAYER New HIDDEN,CENTER,PHANTOM',
  'LAYER Ltype HIDDEN HIDDEN',
  'LAYER Ltype CENTER CENTER',
  'LAYER Ltype PHANTOM PHANTOM',
  'LAYER Color 1 HIDDEN',
  'LAYER Color 3 CENTER',
  'LAYER Color 4 PHANTOM',
  'LTSCALE 0.5',
  'LINE', '0,4', '8,4', '',
  'LAYER Set HIDDEN', 'LINE', '0,3', '8,3', '',
  'LAYER Set CENTER', 'LINE', '0,2', '8,2', '', 'CIRCLE', '10,2', '1.5',
  'LAYER Set PHANTOM', 'LINE', '0,1', '8,1', '',
  'LAYER Set 0',
  'CELTYPE DASHED', 'RECTANG', '0,-1', '8,0', 'CELTYPE ByLayer',
  'LWEIGHT 0.7', 'LINE', '0,-2', '8,-2', '', 'LWEIGHT ByLayer',
  'TEXT', '8.3,3.9', 'Continuous', '', 'TEXT', '8.3,2.9', 'HIDDEN (layer)', '', 'TEXT', '8.3,1.9', 'CENTER (layer)', '', 'TEXT', '8.3,0.9', 'PHANTOM (layer)', '', 'TEXT', '8.3,-0.6', 'DASHED (CELTYPE)', '', 'TEXT', '8.3,-2.1', 'LW 0.70 mm', '',
  'LWDISPLAY',
  'ZOOM', 'E',
]);
await page.waitForTimeout(250);
await page.screenshot({ path: 'screenshots/11-linetypes.png' });

// ---- 3. Polyline with arcs and width, donut, polygon, ellipse, mtext
await page.evaluate(() => {
  window.editor.doc.dirty = false;
  window.editor.runCommand('NEW');
  window.editor.runCommand('LWDISPLAY');
});
await page.waitForTimeout(100);
await type([
  'PLINE', '0,0', 'W', '0.15', '', '4,0', 'A', '6,2', '4,4', 'L', '0,4', 'A', 'CL',
  'PLINE', '8,0', 'A', 'CE', '9,0', '10,0', 'L', '10,4', 'A', 'R', '1', '8,4', 'L', 'C',
  'DONUT', '0.3', '0.8', '13,2', '',
  'POLYGON', '6', '13,4.5', 'I', '1',
  'ELLIPSE', 'C', '13,-0.5', '15,-0.5', '0.8',
  'MTEXT', '0,-1', '10,-3', 'Polylines carry per-vertex bulges and a constant width;', 'MTEXT wraps to the reference rectangle width.', '',
  'ZOOM', 'E',
]);
await page.waitForTimeout(250);
await page.screenshot({ path: 'screenshots/12-polyline-arcs.png' });

// ---- 4. Arrays: rectangular and polar, plus FILLET/CHAMFER
await page.evaluate(() => {
  window.editor.doc.dirty = false;
  window.editor.runCommand('NEW');
});
await page.waitForTimeout(100);
await type([
  'RECTANG', '0,0', '1,0.6',
  'CIRCLE', '0.5,0.3', '0.15',
  'SELECT', 'ALL', '',
  'ARRAYRECT', '3', '4', '1', '1.5',
  'CIRCLE', '9,1.5', '0.25',
  'SELECT', 'L', '',
  'ARRAYPOLAR', '9,3.5', '8', '360', 'Y',
  // the polar array copies the circle around itself; add a spoke and fillet a corner
  'LINE', '12,0', '16,0', '', 'LINE', '16,0', '16,3', '',
  'FILLET', 'R', '1', '13,0', '16,2',
  'LINE', '12,-1', '16,-1', '', 'LINE', '16,-1', '16,-3', '',
  'CHAMFER', 'D', '0.6', '0.4', '13,-1', '16,-2',
  'ZOOM', 'E',
]);
await page.waitForTimeout(250);
await page.screenshot({ path: 'screenshots/13-arrays-fillet.png' });

await browser.close();
server.close();
console.log('drafting screenshots written to ./screenshots');
