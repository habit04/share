/**
 * Step-2 sub-round A seams (12.5 engine switch-over): the vendored
 * engine assets verify (and refuse when tampered or uncapped), the
 * shape request validator bounds every field, cluster tiling is
 * frame-exact in both directions, and the host admits shape jobs
 * under its own usage stamp with the existing pump discipline.
 */
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { verifyAssets, declaredMaximumMemory, ASSETS } = require('../electron/shaping/verify-assets.cjs') as {
  verifyAssets(dir?: string): { engineIdentity: string };
  declaredMaximumMemory(wasm: Uint8Array): number | null;
  ASSETS: string;
};
const { shapeFields, tileGlyphs } = require('../electron/shaping/shape-font.cjs') as {
  shapeFields(value: unknown): { text: string; itemStart: number; itemEnd: number; script: string; direction: string; features: string[] };
  tileGlyphs(
    infos: readonly { codepoint: number; cluster: number; xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }[],
    itemStart: number,
    itemEnd: number,
  ): { glyph: number; clusterStart: number; clusterEnd: number }[];
};
const { createFontMetricsHost } = require('../electron/font-metrics-host.cjs') as {
  createFontMetricsHost(options?: { workerFactory?: (request: never) => FakeWorker; timeoutMs?: number }): {
    readShape(request: unknown): Promise<unknown>;
    dispose(): Promise<void>;
  };
};

class FakeWorker extends EventEmitter {
  readonly terminate = vi.fn(async () => 0);
  constructor(readonly request: { usage?: string; shape?: unknown; font?: string }) {
    super();
  }
}

describe('vendored shaping assets', () => {
  it('verify against the build receipt, with the capped declared maximum', () => {
    const receipt = verifyAssets();
    expect(receipt.engineIdentity).toContain('cap-256MiB');
    const wasm = readFileSync(join(ASSETS, 'harfbuzz.wasm'));
    expect(declaredMaximumMemory(wasm)).toBe(268435456);
  });

  it('a tampered asset refuses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jcad-shaping-assets-'));
    for (const name of ['harfbuzz.wasm', 'harfbuzz.js', 'index.mjs', 'build-receipt.json']) {
      copyFileSync(join(ASSETS, name), join(dir, name));
    }
    const wasmPath = join(dir, 'harfbuzz.wasm');
    const bytes = readFileSync(wasmPath);
    bytes[100] = bytes[100]! ^ 0xff;
    writeFileSync(wasmPath, bytes);
    expect(() => verifyAssets(dir)).toThrow(/does not match its build receipt/);
  });

  it('the memory parser reads an uncapped declaration as what it is', () => {
    // Minimal module: memory section, one memory, limits flags=1
    // (has maximum), initial 1 page, maximum 32768 pages (2 GiB).
    const wasm = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x05, 0x06, 0x01, 0x01, 0x01, 0x80, 0x80, 0x02,
    ]);
    expect(declaredMaximumMemory(wasm)).toBe(2147483648);
  });
});

describe('shape request validation', () => {
  const base = { shape: { text: 'abc', itemStart: 0, itemEnd: 3, script: 'Latn', direction: 'ltr' } };
  it('accepts a bounded request and defaults features', () => {
    expect(shapeFields(base)).toEqual({
      text: 'abc', itemStart: 0, itemEnd: 3, script: 'Latn', direction: 'ltr', features: [],
    });
  });
  it('refuses malformed fields by name', () => {
    expect(() => shapeFields({ shape: { ...base.shape, text: '' } })).toThrow(/context text/);
    expect(() => shapeFields({ shape: { ...base.shape, text: 'x'.repeat(65537) } })).toThrow(/context text/);
    expect(() => shapeFields({ shape: { ...base.shape, itemEnd: 4 } })).toThrow(/item range/);
    expect(() => shapeFields({ shape: { ...base.shape, itemStart: 2, itemEnd: 2 } })).toThrow(/item range/);
    expect(() => shapeFields({ shape: { ...base.shape, script: 'Arabic' } })).toThrow(/script/);
    expect(() => shapeFields({ shape: { ...base.shape, direction: 'up' } })).toThrow(/direction/);
    expect(() => shapeFields({ shape: { ...base.shape, features: ['liga'] } })).toThrow(/features/);
    expect(() => shapeFields({ shape: { ...base.shape, features: Array(33).fill('kern=off') } })).toThrow(/features/);
    expect(() => shapeFields({})).toThrow(/shape request/);
  });
});

describe('cluster tiling', () => {
  const info = (codepoint: number, cluster: number) => ({
    codepoint, cluster, xAdvance: 500, yAdvance: 0, xOffset: 0, yOffset: 0,
  });
  it('tiles LTR glyphs item-relative', () => {
    const glyphs = tileGlyphs([info(10, 4), info(11, 5)], 4, 6);
    expect(glyphs.map((g) => [g.clusterStart, g.clusterEnd])).toEqual([[0, 1], [1, 2]]);
  });
  it('tiles RTL visual order from the boundary set (descending clusters)', () => {
    const glyphs = tileGlyphs([info(43, 9), info(42, 0)], 0, 10);
    expect(glyphs.map((g) => [g.glyph, g.clusterStart, g.clusterEnd])).toEqual([[43, 9, 10], [42, 0, 9]]);
  });
  it('glyphs sharing one cluster share its range', () => {
    const glyphs = tileGlyphs([info(7, 2), info(8, 2), info(9, 5)], 0, 6);
    expect(glyphs.map((g) => [g.clusterStart, g.clusterEnd])).toEqual([[2, 5], [2, 5], [5, 6]]);
  });
});

describe('host shape admission', () => {
  it('stamps usage host-side and delivers the validated request to the worker', async () => {
    const workers: FakeWorker[] = [];
    const host = createFontMetricsHost({
      workerFactory: (request: never) => {
        const worker = new FakeWorker(request);
        workers.push(worker);
        return worker;
      },
    });
    const pending = host.readShape({
      font: 'Noto Naskh Arabic', usage: 'pdf',
      shape: { text: 'abc', itemStart: 0, itemEnd: 3, script: 'Latn', direction: 'ltr' },
    });
    expect(workers).toHaveLength(1);
    expect(workers[0]!.request.usage).toBe('shape');
    expect(workers[0]!.request.font).toBe('Noto Naskh Arabic');
    expect(workers[0]!.request.shape).toMatchObject({ text: 'abc', itemStart: 0, itemEnd: 3 });
    workers[0]!.emit('message', { metrics: { kind: 'shaped', glyphs: [] } });
    await expect(pending).resolves.toEqual({ kind: 'shaped', glyphs: [] });
    await host.dispose();
  });

  it('an invalid shape block rejects without spawning a worker', async () => {
    const workers: FakeWorker[] = [];
    const host = createFontMetricsHost({
      workerFactory: (request: never) => {
        const worker = new FakeWorker(request);
        workers.push(worker);
        return worker;
      },
    });
    await expect(host.readShape({ font: 'X', shape: { text: '', itemStart: 0, itemEnd: 0, script: 'Latn', direction: 'ltr' } }))
      .rejects.toThrow(/context text/);
    expect(workers).toHaveLength(0);
    await host.dispose();
  });
});

describe('startup laziness (correction 3)', () => {
  it('the host loads no engine-related module until the first shape request', () => {
    // Runs in a fresh node subprocess: this test file itself requires
    // the shaping modules, so the load graph is only observable in a
    // clean process. The child requires ONLY the host, asserts none of
    // the six engine-chain modules is loaded, then makes a request
    // that passes the descriptor check and fails shape validation —
    // which must engage the lazy require (the module appears) while
    // still rejecting with the validator's own error, before any
    // worker could spawn.
    const electronDir = join(__dirname, '..', 'electron');
    const child = `
      const path = require('node:path');
      const electronDir = process.argv[2];
      const rel = (f) => path.relative(electronDir, f).split(path.sep).join('/');
      const banned = ['shaping/shape-font.cjs', 'shaping/verify-assets.cjs', 'pdf-font.cjs', 'font-metrics.cjs', 'cff-metrics.cjs', 'ttc-extract.cjs'];
      const loaded = () => Object.keys(require.cache).filter((f) => f.startsWith(electronDir)).map(rel);
      const { createFontMetricsHost } = require(path.join(electronDir, 'font-metrics-host.cjs'));
      const eager = loaded().filter((f) => banned.includes(f));
      if (eager.length) { console.log('EAGER:' + eager.join(',')); process.exit(1); }
      const host = createFontMetricsHost({ workerFactory: () => { throw new Error('must not spawn'); } });
      host.readShape({ font: 'Any' }).then(
        () => { console.log('RESOLVED'); process.exit(1); },
        (error) => {
          if (!String(error && error.message).includes('Invalid shape request')) { console.log('WRONG-ERROR:' + error); process.exit(1); }
          if (!loaded().includes('shaping/shape-font.cjs')) { console.log('NOT-LAZY'); process.exit(1); }
          console.log('OK');
          process.exit(0);
        },
      );
    `;
    const dir = mkdtempSync(join(tmpdir(), 'jcad-lazy-host-'));
    const script = join(dir, 'child.cjs');
    writeFileSync(script, child);
    const result = spawnSync(process.execPath, [script, electronDir], { encoding: 'utf8' });
    expect(result.stdout.trim()).toBe('OK');
    expect(result.status).toBe(0);
  });

  it('the worker requires the shaping reader only inside its shape dispatch', () => {
    const source = readFileSync(join(__dirname, '..', 'electron', 'font-metrics-worker.cjs'), 'utf8');
    // No top-level (line-start) require of the shaping chain…
    expect(source).not.toMatch(/^const .* = require\('\.\/shaping\/shape-font\.cjs'\);$/m);
    // …and the lazy require exists inside the dispatch arm.
    expect(source).toContain("require('./shaping/shape-font.cjs').readWindowsShapedFont(request)");
  });
});
