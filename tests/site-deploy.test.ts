import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';

// The website (GitHub Pages) must not serve a mix of old and new files after a deploy. GitHub
// Pages sends every file with the same short cache lifetime (Cache-Control: max-age=600) and no
// way to set headers, so cache-busting has to come from the file names: the browser edition's
// JS / CSS / wasm carry content hashes (Vite), index.html files stay unhashed and small, and
// nothing hard-codes a hashed name that a later build would change.

const root = join(__dirname, '..');
const HASHED = /-[A-Za-z0-9_-]{8,}\.(js|css|wasm)$/;
let out = '';
let html = '';

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'jcad-site-'));
  // Same build as scripts/build-site.mjs step 2 (vite build --mode site), into a temporary folder
  // so the test never touches site-dist/ or dist/.
  await build({ root, configFile: join(root, 'vite.config.ts'), mode: 'site', logLevel: 'silent', build: { outDir: out, emptyOutDir: true } });
  html = readFileSync(join(out, 'index.html'), 'utf8');
}, 180_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe('browser edition build (site-dist/app)', () => {
  it('references its entry script and stylesheet by hashed, relative file names', () => {
    const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]!);
    const styles = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1]!);
    expect(scripts.length).toBeGreaterThanOrEqual(1);
    expect(styles.length).toBeGreaterThanOrEqual(1);
    for (const ref of [...scripts, ...styles]) {
      // relative, so the app works under https://<user>.github.io/<repo>/app/
      expect(ref.startsWith('./assets/'), ref).toBe(true);
      expect(HASHED.test(ref), `${ref} carries a content hash`).toBe(true);
      expect(existsSync(join(out, ref)), `${ref} exists in the build`).toBe(true);
    }
  });

  it('gives every emitted asset (lazy chunks, wasm) a content hash', () => {
    const assets = readdirSync(join(out, 'assets'));
    expect(assets.some((f) => f.endsWith('.wasm'))).toBe(true);
    const unhashed = assets.filter((f) => !HASHED.test(f) && !/\.(png|svg|ttf|woff2?)$/.test(f));
    expect(unhashed).toEqual([]);
  });

  it('recovers from a chunk that vanished in a redeploy (reload once on vite:preloadError)', () => {
    const entry = /<script[^>]+src="\.\/([^"]+)"/.exec(html)![1]!;
    const code = readFileSync(join(out, entry), 'utf8');
    expect(code).toContain('vite:preloadError');
    expect(code).toContain('jcad.reloadedForStaleChunk');
  });

  it('allows the wasm reader in the web CSP only (the Electron build keeps the strict policy)', () => {
    expect(html).toMatch(/script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'/);
    const electronHtml = readFileSync(join(root, 'index.html'), 'utf8');
    expect(electronHtml).not.toContain('unsafe-eval');
  });
});

describe('landing page (site/)', () => {
  const landing = readFileSync(join(root, 'site/index.html'), 'utf8');
  const siteJs = readFileSync(join(root, 'site/site.js'), 'utf8');

  it('links the app by folder (its index.html resolves the current hashes) and hard-codes no hashed asset', () => {
    expect(landing).toMatch(/href="\.\/app\/\?/);
    for (const text of [landing, siteJs]) {
      expect(text).not.toMatch(/assets\/[^"'\s]+-[A-Za-z0-9_-]{8,}\.(js|css|wasm)/);
      expect(text).not.toMatch(/index-[A-Za-z0-9_-]{8}\.(js|css)/);
    }
  });

  it('versions the landing page stylesheet and script for cache-busting', () => {
    // The build script (landing-page step only) writes the version query; the source stays plain.
    const dir = mkdtempSync(join(tmpdir(), 'jcad-landing-'));
    try {
      execFileSync(process.execPath, [join(root, 'scripts/build-site.mjs'), '--no-app'], { cwd: root, env: { ...process.env, JCAD_SITE_OUT: dir }, stdio: 'pipe' });
      const built = readFileSync(join(dir, 'index.html'), 'utf8');
      expect(built).toMatch(/href="site\.css\?v=[a-f0-9]{10}"/);
      expect(built).toMatch(/src="site\.js\?v=[a-f0-9]{10}"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Pages workflow', () => {
  const wf = readFileSync(join(root, '.github/workflows/pages.yml'), 'utf8');
  it('builds with scripts/build-site.mjs and uploads site-dist as the Pages artifact', () => {
    expect(wf).toMatch(/run: node scripts\/build-site\.mjs/);
    expect(wf).toMatch(/uses: actions\/upload-pages-artifact@v\d+\s+with:\s+path: site-dist\b/);
    expect(wf).toMatch(/uses: actions\/deploy-pages@v\d+/);
  });
  it('rebuilds when the app, the landing page or the build script change', () => {
    for (const p of ["'site/**'", "'src/**'", "'index.html'", "'vite.config.ts'", "'scripts/build-site.mjs'"]) expect(wf).toContain(p);
  });
});
