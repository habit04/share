/**
 * Packaging plumbing that CI cannot exercise without building installers: the application icon
 * (re-rendered by scripts/make-icons.mjs and compared with the committed files), the icon and
 * file-association entries of the electron-builder configuration (checked with electron-builder's
 * own schema), and the OS hand-over in the main process that the associations rely on.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative } from 'node:path';
import { buildAll, pngPixels, sameIcon, ICO_SIZES, PNG_SIZES } from '../scripts/make-icons.mjs';
import { mainProcessSource } from './helpers/main-process';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
const pkg = JSON.parse(read('package.json'));
const build = pkg.build;
const pngSize = (b: Buffer) => [b.readUInt32BE(16), b.readUInt32BE(20)];

describe('application icon (scripts/make-icons.mjs)', () => {
  const files = buildAll();

  it('the committed icons are what the generator draws today', () => {
    expect([...files.keys()].sort()).toEqual(
      ['build/icon.icns', 'build/icon.ico', 'build/icon.png', 'build/icon.svg', 'public/favicon.svg', 'site/img/icon.svg', ...PNG_SIZES.map((s) => `build/icons/${s}x${s}.png`)].sort(),
    );
    for (const [name, data] of files) {
      expect(existsSync(new URL(name, root)), name).toBe(true);
      expect(sameIcon(name, readFileSync(new URL(name, root)), data), `${name} differs from a fresh render (run npm run icons)`).toBe(true);
    }
  });

  it('notices a changed picture', () => {
    const png = files.get('build/icons/32x32.png')!;
    const other = files.get('build/icons/24x24.png')!;
    expect(sameIcon('build/icons/32x32.png', png, other)).toBe(false);
    const ico = Buffer.from(files.get('build/icon.ico')!);
    expect(sameIcon('build/icon.ico', ico, files.get('build/icon.icns')!)).toBe(false);
  });

  it('ICO holds PNG images from 16 to 256 px', () => {
    const ico = readFileSync(new URL('build/icon.ico', root));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const n = ico.readUInt16LE(4);
    const sizes: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const off = ico.readUInt32LE(6 + i * 16 + 12);
      expect(ico.subarray(off + 1, off + 4).toString('latin1')).toBe('PNG');
      const [w, h] = pngSize(ico.subarray(off));
      expect(w).toBe(h);
      expect(ico[6 + i * 16]).toBe(w! >= 256 ? 0 : w);
      sizes.push(w!);
    }
    expect(sizes).toEqual(ICO_SIZES);
  });

  it('ICNS has a valid header and the standard and retina entries', () => {
    const icns = readFileSync(new URL('build/icon.icns', root));
    expect(icns.subarray(0, 4).toString('latin1')).toBe('icns');
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    const types: string[] = [];
    for (let o = 8; o < icns.length; o += icns.readUInt32BE(o + 4)) types.push(icns.subarray(o, o + 4).toString('latin1'));
    expect(types).toEqual(['icp4', 'icp5', 'icp6', 'ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12', 'ic13', 'ic14']);
  });

  it('the Linux icon folder uses NxN.png names with matching pixel sizes; the PNGs are RGBA with transparent corners', () => {
    for (const s of PNG_SIZES) {
      const b = readFileSync(new URL(`build/icons/${s}x${s}.png`, root));
      expect(pngSize(b)).toEqual([s, s]);
      expect(b[25]).toBe(6); // colour type RGBA
      const px = pngPixels(b); // filter byte, then RGBA per pixel, row by row
      expect(px[4], `${s} px: top left corner`).toBe(0);
      const mid = (s / 2) * (s * 4 + 1) + 1 + (s / 2) * 4;
      expect(px[mid + 3], `${s} px: centre`).toBe(255);
    }
    expect(readFileSync(new URL('build/icon.png', root)).equals(readFileSync(new URL('build/icons/1024x1024.png', root)))).toBe(true);
  });

  it('the SVG master is plain vector artwork (no embedded images, scripts or text)', () => {
    const svg = read('build/icon.svg');
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1024 1024"/);
    expect(svg).not.toMatch(/<(image|script|text|foreignObject)\b|href=|data:/i);
    expect(read('public/favicon.svg')).toBe(svg);
    expect(read('site/img/icon.svg')).toBe(svg);
  });

  it('the application page and the website use it as their favicon', () => {
    expect(read('index.html')).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
    expect(read('site/index.html')).toContain('<link rel="icon" href="img/icon.svg" type="image/svg+xml" />');
  });
});

describe('electron-builder configuration', () => {
  it('passes electron-builder schema validation', async () => {
    const { validateConfiguration } = require('app-builder-lib/out/util/config/config.js');
    const { DebugLogger } = require('builder-util');
    await expect(validateConfiguration(build, new DebugLogger(false))).resolves.toBeUndefined();
  });

  it('gives the installers and the application the generated icon on every OS', () => {
    expect(build.win.icon).toBe('build/icon.ico');
    expect(build.mac.icon).toBe('build/icon.icns');
    expect(build.linux.icon).toBe('build/icons');
    for (const p of [build.win.icon, build.mac.icon, `${build.linux.icon}/256x256.png`, 'build/entitlements.mac.plist']) expect(existsSync(new URL(p, root)), p).toBe(true);
  });

  it('registers .dxf drawings and .jcadproj.json projects with the OS', () => {
    const assoc = build.fileAssociations as Array<{ ext: string; name: string; mimeType: string; role: string }>;
    expect(assoc.map((a) => a.ext)).toEqual(['dxf', 'jcadproj.json']);
    for (const a of assoc) {
      expect(a.name).toBeTruthy();
      expect(a.mimeType).toMatch(/^[a-z]+\/[a-z0-9.+-]+$/);
      expect(a.role).toBe('Editor');
    }
  });

  it('includes the shared support configuration and every native DWG adapter under the real builder filters', () => {
    const { getMainFileMatchers, getFileMatchers } = require('app-builder-lib/out/fileMatcher.js');
    const from = fileURLToPath(root);
    const output = join(from, 'release');
    const macroExpander = (pattern: string) => pattern;
    // Use the full builder function: its default exclusions drop package-lock.json
    // under a plain vendor/** glob, while a dedicated file mapping preserves it.
    const info = { projectDir: from, buildResourcesDir: 'build', config: build, debugLogger: { isEnabled: false } };
    const mainMatchers = getMainFileMatchers(from, output, macroExpander, {}, { info }, output, false);
    const unpackMatchers = getFileMatchers(build, 'asarUnpack', from, { macroExpander, customBuildOptions: {}, globalOutDir: output, defaultSrc: from });
    const accepted = (matchers: Array<{ from: string; createFilter: () => (file: string, info: ReturnType<typeof lstatSync>) => boolean }>, file: URL) => {
      const path = fileURLToPath(file), stat = lstatSync(file);
      return matchers.some((matcher) => {
        const rel = relative(matcher.from, path);
        return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && matcher.createFilter()(path, stat);
      });
    };
    const support = new URL('electron/support.json', root), supportInfo = lstatSync(support);
    expect(supportInfo.isFile()).toBe(true);
    expect(accepted(mainMatchers, support), 'Main-process mailto authorization requires the packaged shared JSON').toBe(true);
    const adapters = ['dwg-reader.mjs', 'dwg-worker.mjs', 'dwg-process.mjs', 'dwg-wasm-memory.mjs', 'dwg-native-read.mjs', 'dwg-array-conversion.mjs', 'dwg-appearance-conversion.mjs', 'dwg-mtext-background.mjs'];
    for (const name of adapters) {
      const source = new URL(`scripts/${name}`, root), info = lstatSync(source);
      expect(info.isFile(), name).toBe(true);
      expect(accepted(mainMatchers, source), `${name} must be packaged`).toBe(true);
      expect(accepted(unpackMatchers, source), `${name} must remain importable by the real native worker outside ASAR`).toBe(true);
    }
    const protocol = new URL('electron/dwg-protocol.cjs', root);
    expect(accepted(mainMatchers, protocol), 'The shared bounded transport must be packaged').toBe(true);
    expect(accepted(unpackMatchers, protocol), 'The isolated ESM scripts import the shared protocol outside ASAR').toBe(true);
    for (const name of ['check-dwg-containment.mjs', 'dwg-containment-probe.cjs']) {
      expect(accepted(mainMatchers, new URL(`scripts/${name}`, root)), 'Allocation test harnesses must not ship with the application').toBe(false);
    }
    const provenance = JSON.parse(read('vendor/libredwg-web-bg/provenance.json')) as { assets: Array<{ path: string; bytes: number }> };
    expect(provenance.assets).toHaveLength(15);
    expect(provenance.assets.some((asset) => asset.path === 'declaration-tools/package-lock.json')).toBe(true);
    for (const name of [...provenance.assets.map((asset) => asset.path), 'provenance.json', 'SHA256SUMS']) {
      const source = new URL(`vendor/libredwg-web-bg/${name}`, root), stat = lstatSync(source);
      expect(stat.isFile() && !stat.isSymbolicLink(), name).toBe(true);
      expect(accepted(mainMatchers, source), `${name} must not be dropped by builder default exclusions`).toBe(true);
      expect(accepted(unpackMatchers, source), `${name} belongs to the full unpacked native artifact`).toBe(true);
    }
  });

  it('the main process accepts what the associations hand over (command line, second launch, macOS open-file)', () => {
    const main = mainProcessSource();
    const m = /const HANDOVER_FILE = (\/.+\/i);/.exec(main);
    expect(m).not.toBeNull();
    const re = new Function(`return ${m![1]}`)() as RegExp;
    for (const a of build.fileAssociations as Array<{ ext: string }>) expect(re.test(`C:\\Jobs\\plant.${a.ext}`), a.ext).toBe(true);
    for (const f of ['plant.json', 'notes.txt', 'plant.dxf.exe', 'evil.jcadproj.json.lnk']) expect(re.test(f), f).toBe(false);
    // Every path goes through the same function: drawingArgs (argv) and the macOS open-file event.
    expect(main).toMatch(/app\.on\('open-file', \(ev, file\) => \{\s*ev\.preventDefault\(\);\s*if \(typeof file === 'string' && HANDOVER_FILE\.test\(file\)\) handOverFiles\(\[file\]\);/);
    expect(main).toMatch(/app\.on\('second-instance', \(_ev, argv, workingDirectory\) => \{[\s\S]*?handOverFiles\(drawingArgs\(argv, workingDirectory\)\)/);
    expect(main).toMatch(/handOverFiles\(drawingArgs\(process\.argv, process\.cwd\(\)\)\)/);
  });
});
