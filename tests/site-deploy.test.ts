import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { runInNewContext } from 'node:vm';

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

  it.each(['win', 'linux'])('keeps legacy downloads pinned when the latest release contains only Windows (%s visitor)', async (os) => {
    const keys = ['auto', 'win', 'mac-arm64', 'mac-x64', 'linux-appimage', 'linux-deb'];
    const buttons = keys.map((key) => {
      const attributes = new Map([['data-asset', key]]);
      return { href: '', getAttribute: (name: string) => attributes.get(name) ?? null, setAttribute: (name: string, value: string) => attributes.set(name, value), removeAttribute: (name: string) => attributes.delete(name) };
    });
    const label = { textContent: '' };
    let done!: () => void;
    const completed = new Promise<void>((resolve) => { done = resolve; });
    runInNewContext(siteJs, {
      document: { querySelector: (s: string) => s === '#primary-download .btn-label' ? label : null, querySelectorAll: (s: string) => s === '[data-asset]' ? buttons : [], getElementById: (s: string) => s === 'primary-download' ? buttons[0] : null },
      navigator: { platform: os === 'win' ? 'Win32' : 'Linux x86_64', userAgent: '' },
      sessionStorage: { getItem: () => null, setItem: () => {} },
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ tag_name:'v0.4.6', assets:[{ name:'jcad-electrical-0.4.6-win-x64.exe', browser_download_url:'https://example.test/windows.exe' }] }) }),
      setTimeout: () => 1, clearTimeout: done,
    });
    await completed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(buttons[1]!.href).toBe('https://example.test/windows.exe');
    expect(buttons[0]!.href).toBe(os === 'win' ? 'https://example.test/windows.exe' : '#download');
    for (const button of buttons.slice(2)) expect(button.href).toMatch(/^https:\/\/github.com\/habit04\/share\/releases\/download\/v0\.4\.5\/jcad-electrical-0\.4\.5-/);
    if (os === 'linux') expect(label.textContent).toBe('Older Linux downloads');
    expect(landing).toContain('updates paused');
  });

  it('links the app by folder (its index.html resolves the current hashes) and hard-codes no hashed asset', () => {
    expect(landing).toMatch(/href="\.\/app\/\?/);
    for (const text of [landing, siteJs]) {
      expect(text).not.toMatch(/assets\/[^"'\s]+-[A-Za-z0-9_-]{8,}\.(js|css|wasm)/);
      expect(text).not.toMatch(/index-[A-Za-z0-9_-]{8}\.(js|css)/);
    }
  });

  it.each(['Intel Mac OS X 10_15_7', 'Mac OS X 14_0'])('offers an explicit Mac architecture choice for %s instead of guessing an installer', async (agent) => {
    expect(landing).toContain('<section id="download"');
    expect(landing).toContain('data-asset="mac-arm64"');
    expect(landing).toContain('data-asset="mac-x64"');
    const releases = 'https://github.com/habit04/share/releases';
    const makeButton = (asset: string) => {
      const attributes = new Map([['data-asset', asset]]);
      return { href: releases, attributes, getAttribute: (name: string) => attributes.get(name) ?? null, setAttribute: (name: string, value: string) => attributes.set(name, value), removeAttribute: (name: string) => attributes.delete(name) };
    };
    for (const online of [true, false]) {
      const hero = makeButton('auto'), arm = makeButton('mac-arm64'), intel = makeButton('mac-x64');
      arm.href = 'https://github.com/habit04/share/releases/download/v0.4.5/jcad-electrical-0.4.5-mac-arm64.dmg';
      intel.href = 'https://github.com/habit04/share/releases/download/v0.4.5/jcad-electrical-0.4.5-mac-x64.dmg';
      const label = { textContent: '' }, fallback = { hidden: true };
      const buttons = [hero, arm, intel];
      let done!: () => void;
      const completed = new Promise<void>((resolve) => { done = resolve; });
      const document = {
        querySelector: (selector: string) => selector === '#primary-download .btn-label' ? label : null,
        querySelectorAll: (selector: string) => selector === '[data-asset]' ? buttons : [],
        getElementById: (id: string) => id === 'primary-download' ? hero : id === 'dl-fallback' ? fallback : null,
      };
      runInNewContext(siteJs, {
        document, navigator: { platform: 'MacIntel', userAgent: `Mozilla/5.0 (Macintosh; ${agent})` },
        sessionStorage: { getItem: () => null, setItem: () => {} },
        fetch: () => online ? Promise.resolve({ ok: true, json: () => Promise.resolve({ tag_name: 'v0.4.4', html_url: releases, assets: [
          { name: 'jcad-electrical-0.4.4-mac-x64.dmg', browser_download_url: 'https://example.test/intel.dmg' },
          { name: 'jcad-electrical-0.4.4-mac-arm64.dmg', browser_download_url: 'https://example.test/arm.dmg' },
        ] }) }) : Promise.reject(new Error('offline')),
        setTimeout: () => 1, clearTimeout: done,
      });
      await completed;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(label.textContent).toBe('Older Mac downloads');
      expect(hero.href).toBe('#download');
      expect(hero.attributes.has('download')).toBe(false);
      expect(arm.href).toBe('https://github.com/habit04/share/releases/download/v0.4.5/jcad-electrical-0.4.5-mac-arm64.dmg');
      expect(intel.href).toBe('https://github.com/habit04/share/releases/download/v0.4.5/jcad-electrical-0.4.5-mac-x64.dmg');
      expect(fallback.hidden).toBe(online);
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
    expect(wf).toMatch(/uses: actions\/upload-pages-artifact@[0-9a-f]{40} # v\d+\s+with:\s+path: site-dist\b/);
    expect(wf).toMatch(/uses: actions\/deploy-pages@[0-9a-f]{40} # v\d+/);
  });
  it('rebuilds when the app, the landing page or the build script change', () => {
    for (const p of ["'site/**'", "'src/**'", "'index.html'", "'vite.config.ts'", "'scripts/build-site.mjs'"]) expect(wf).toContain(p);
  });
});
