// Approved-image comparison for the visual-review screenshots (scripts/screenshot*.mjs, run by
// e2e/run-screenshots.mjs). Every screenshots/*.png is compared with its approved copy in
// screenshots/baseline/ using pixelmatch:
//
//   npm run screenshot:compare              compare; exit 1 on a regression, a missing or a new
//                                           (not yet approved) screenshot
//   npm run screenshot:approve              copy the current screenshots over the baselines
//   npm run screenshot:approve -- a.png b   approve only these
//   ... -- --prune                          (approve) also delete baselines whose screenshot is gone
//
// Failures write <name>.diff.png (changed pixels in red over a faded copy of the baseline) and
// <name>.actual.png to screenshots/diff/ (CI uploads that folder). Tolerances live in
// screenshots/baseline/config.json: a per-pixel colour threshold (pixelmatch `threshold`,
// anti-aliased pixels ignored) and the share of pixels allowed to differ, by default and per image,
// plus masks for regions that change from run to run and images that are not compared at all.
//
// Baselines must come from the same browser and fonts CI uses: the Playwright Chromium of
// package-lock.json on ubuntu-latest (the `Screenshot baselines` workflow regenerates and commits
// them there). docs/DEVELOPMENT.md describes the workflow.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const args = process.argv.slice(2);
const approve = args.includes('--approve');
const prune = args.includes('--prune');
const only = args.filter((a) => !a.startsWith('--')).map((a) => basename(a));
const repo = resolve(import.meta.dirname, '..');
const dir = resolve(process.env.JCAD_SCREENSHOTS || join(repo, 'screenshots'));
const baseDir = join(dir, 'baseline');
const diffDir = join(dir, 'diff');
const configFile = join(baseDir, 'config.json');

/**
 * @typedef {{ threshold?: number, maxDiffRatio?: number, masks?: Array<[number, number, number, number]> }} ImageRule
 * @typedef {{ default: Required<Omit<ImageRule, 'masks'>>, images: Record<string, ImageRule>, ignore: string[] }} Config
 */
/** @type {Config} */
const config = {
  default: { threshold: 0.1, maxDiffRatio: 0.002 },
  images: {},
  ignore: [],
  ...(existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {}),
};
const ignored = new Set(config.ignore);
const pngs = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.png') && !ignored.has(f)).sort() : []);

if (approve) {
  mkdirSync(baseDir, { recursive: true });
  const current = pngs(dir).filter((f) => only.length === 0 || only.includes(f));
  if (current.length === 0) {
    console.error(`screenshot:approve: no screenshots in ${dir} (run the screenshot scripts first: node e2e/run-screenshots.mjs)`);
    process.exit(1);
  }
  for (const f of current) copyFileSync(join(dir, f), join(baseDir, f));
  let removed = 0;
  if (prune && only.length === 0) {
    for (const f of pngs(baseDir)) {
      if (!existsSync(join(dir, f))) {
        rmSync(join(baseDir, f));
        removed += 1;
      }
    }
  }
  console.log(`screenshot:approve: ${current.length} baseline(s) written to ${baseDir}${removed ? `, ${removed} stale baseline(s) removed` : ''}. Review them (git diff --stat) and commit.`);
  process.exit(0);
}

const read = (file) => PNG.sync.read(readFileSync(file));
/** Paint the mask rectangles the same colour in both images so they never count. */
function mask(png, rects) {
  for (const [x, y, w, h] of rects) {
    for (let yy = Math.max(0, y); yy < Math.min(png.height, y + h); yy += 1) {
      for (let xx = Math.max(0, x); xx < Math.min(png.width, x + w); xx += 1) {
        const i = (yy * png.width + xx) * 4;
        png.data[i] = 255;
        png.data[i + 1] = 0;
        png.data[i + 2] = 255;
        png.data[i + 3] = 255;
      }
    }
  }
}

rmSync(diffDir, { recursive: true, force: true });
const baselines = pngs(baseDir).filter((f) => only.length === 0 || only.includes(f));
const actuals = pngs(dir).filter((f) => only.length === 0 || only.includes(f));
if (baselines.length === 0) {
  console.error(`screenshot:compare: no baselines in ${baseDir}; run the screenshots, then npm run screenshot:approve`);
  process.exit(1);
}
const lines = [];
let failed = 0;
for (const f of baselines) {
  const rule = { ...config.default, ...(config.images[f] ?? {}) };
  const actualFile = join(dir, f);
  if (!existsSync(actualFile)) {
    lines.push(`FAIL ${f}: no screenshot was taken (renamed or removed? approve with --prune)`);
    failed += 1;
    continue;
  }
  const want = read(join(baseDir, f));
  const got = read(actualFile);
  if (want.width !== got.width || want.height !== got.height) {
    lines.push(`FAIL ${f}: size ${got.width}x${got.height}, approved ${want.width}x${want.height}`);
    mkdirSync(diffDir, { recursive: true });
    copyFileSync(actualFile, join(diffDir, f.replace(/\.png$/, '.actual.png')));
    failed += 1;
    continue;
  }
  if (rule.masks) {
    mask(want, rule.masks);
    mask(got, rule.masks);
  }
  const diff = new PNG({ width: want.width, height: want.height });
  const n = pixelmatch(want.data, got.data, diff.data, want.width, want.height, { threshold: rule.threshold, includeAA: false, alpha: 0.2 });
  const ratio = n / (want.width * want.height);
  const ok = ratio <= rule.maxDiffRatio;
  const pct = (r) => `${(r * 100).toFixed(3)} %`;
  lines.push(`${ok ? 'ok  ' : 'FAIL'} ${f}: ${n} pixel(s) differ (${pct(ratio)}, allowed ${pct(rule.maxDiffRatio)})`);
  if (!ok) {
    failed += 1;
    mkdirSync(diffDir, { recursive: true });
    writeFileSync(join(diffDir, f.replace(/\.png$/, '.diff.png')), PNG.sync.write(diff));
    copyFileSync(actualFile, join(diffDir, f.replace(/\.png$/, '.actual.png')));
  }
}
for (const f of actuals) {
  if (baselines.includes(f)) continue;
  lines.push(`FAIL ${f}: new screenshot without an approved baseline (npm run screenshot:approve -- ${f})`);
  failed += 1;
}
console.log(lines.join('\n'));
console.log(`\nscreenshot:compare: ${lines.filter((l) => l.startsWith('ok')).length} match, ${failed} failed${failed ? `; diff images in ${diffDir}` : ''}`);
if (failed && process.env.GITHUB_ACTIONS) {
  // A GitHub Actions annotation (shown on the run's summary page) that says what to do.
  const names = lines.filter((l) => l.startsWith('FAIL')).map((l) => l.slice(5, l.indexOf(':'))).join(', ');
  console.log(
    `::error title=Screenshots differ from the approved baselines::${failed} screenshot(s) do not match screenshots/baseline/ (${names}). ` +
      'Download the screenshot-diffs artifact (<name>.diff.png / .actual.png). If the change is intended, or the Playwright Chromium / fonts of the runner changed, ' +
      'run the "Screenshot baselines" workflow on this branch (tick "commit") to re-approve them (docs/DEVELOPMENT.md, Screenshots).',
  );
}
process.exit(failed ? 1 : 0);
