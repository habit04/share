/** Real verified engine loading; authored font bytes, no installed fonts or mocked import. */
import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pdfFontFixture } from './helpers/pdf-font-fixture';

describe('shaping engine module URL', () => {
  it('loads the verified engine from a path containing spaces, URL delimiters and Unicode', () => {
    const temporary = realpathSync(tmpdir());
    const root = mkdtempSync(join(temporary, 'jcad-engine-import space # % 文-'));
    const owned = relative(temporary, realpathSync(root));
    if (!owned.startsWith('jcad-engine-import space # % 文-') || owned.includes(sep) || isAbsolute(owned)) {
      throw new Error('Unexpected shaping import test cleanup path');
    }
    try {
      const source = join(__dirname, '..', 'electron');
      const shaping = join(root, 'electron', 'shaping');
      const fonts = join(root, 'fonts');
      mkdirSync(join(shaping, 'assets'), { recursive: true });
      mkdirSync(fonts);
      // Preserve ESM interpretation of the unchanged vendored harfbuzz.js.
      writeFileSync(join(root, 'package.json'), '{"type":"module"}\n', { flag: 'wx' });
      for (const name of ['shape-font.cjs', 'verify-assets.cjs']) {
        copyFileSync(join(source, 'shaping', name), join(shaping, name));
      }
      for (const name of ['index.mjs', 'harfbuzz.js', 'harfbuzz.wasm', 'build-receipt.json']) {
        copyFileSync(join(source, 'shaping', 'assets', name), join(shaping, 'assets', name));
      }
      const fixture = pdfFontFixture({ family: 'JCad Loader Fixture' });
      writeFileSync(join(fonts, 'loader.ttf'), fixture.bytes, { flag: 'wx' });
      // Use the real confined reader/parser/permissions with its existing test-only
      // fontsDirectory seam. Only discovery is redirected; loader, verification,
      // HarfBuzz glue and capped WASM all execute unchanged in a fresh Node child.
      writeFileSync(join(root, 'electron', 'pdf-font.cjs'), `
        const {readWindowsPdfFont} = require(${JSON.stringify(join(source, 'pdf-font.cjs'))});
        const path = require('node:path');
        module.exports.readWindowsPdfFont = request => readWindowsPdfFont(request,
          {fontsDirectory:path.join(__dirname,'..','fonts')});
      `, { flag: 'wx' });
      const child = join(root, 'child.cjs');
      writeFileSync(child, `
        const {readWindowsShapedFont} = require('./electron/shaping/shape-font.cjs');
        readWindowsShapedFont({font:'loader.ttf',family:'JCad Loader Fixture',bold:false,italic:false,
          shape:{text:'AB',itemStart:0,itemEnd:2,script:'Latn',direction:'ltr',features:[]}}).then(
          value => console.log(JSON.stringify(value)),
          error => {console.error(error && error.stack || error);process.exitCode=1;});
      `, { flag: 'wx' });
      const result = spawnSync(process.execPath, [child], {
        cwd: root, encoding: 'utf8', timeout: 4000, windowsHide: true, maxBuffer: 65536,
      });
      if (result.error) throw result.error;
      expect(result.stderr, 'real engine child stderr').toBe('');
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      const shaped = JSON.parse(result.stdout) as {
        kind: string; glyphs: {glyph: number; clusterStart: number; clusterEnd: number; xAdvance: number}[];
        unitsPerEm: number; programSha256: string; programBytes: number; advanceX: number; advanceY: number;
      };
      const a = fixture.metrics.cmap[65]!, b = fixture.metrics.cmap[66]!;
      expect(shaped.kind).toBe('shaped');
      expect(shaped.programSha256).toBe(createHash('sha256').update(fixture.bytes).digest('hex'));
      expect(shaped.programBytes).toBe(fixture.bytes.length);
      expect(shaped.unitsPerEm).toBe(fixture.metrics.unitsPerEm);
      expect(shaped.glyphs.map(g => [g.glyph, g.clusterStart, g.clusterEnd, g.xAdvance])).toEqual([
        [a, 0, 1, fixture.metrics.advances[a]], [b, 1, 2, fixture.metrics.advances[b]],
      ]);
      expect(shaped.advanceX).toBe(fixture.metrics.advances[a]! + fixture.metrics.advances[b]!);
      expect(shaped.advanceY).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
