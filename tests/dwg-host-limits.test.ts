/**
 * Security review E-7: the desktop DWG reader runs in a worker with bounded input (128 MiB), V8 heap,
 * WebAssembly memory and time, and never falls back to parsing in the main process. Stub workers
 * stand in for LibreDWG: one that never answers (time limit), one that allocates without end
 * (heap limit), and a missing one (start-up failure). Adapted from PR #2
 * (codex/electrical-review-fixes 2f89b0e, tests/dwg-host-limits.test.ts).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
// @ts-expect-error plain JS helper shared with Electron main / CLI
import { readDwgPayload, capWasmMemory, MAX_DWG_BYTES } from '../scripts/dwg-reader.mjs';
import { mainProcessSource } from './helpers/main-process';

const require = createRequire(import.meta.url);
type Host = { read(bytes: Uint8Array, id?: number): Promise<unknown>; cancel(id: number): boolean; dispose(): void; readonly usesWorker: boolean };
const { createDwgHost, readTimeoutFor, WORKER_RESOURCE_LIMITS } = require('../electron/dwg-host.cjs') as {
  createDwgHost(options: { scriptsDir: string; timeoutMs?: number; maxBytes?: number; resourceLimits?: Record<string, number> }): Host;
  readTimeoutFor(bytes: number): number;
  WORKER_RESOURCE_LIMITS: Record<string, number>;
};
const { MAX_DRAWING_BYTES, readLimitedFile, validateTextSize } = require('../electron/resource-limits.cjs') as {
  MAX_DRAWING_BYTES: number;
  readLimitedFile(fs: unknown, file: string, max: number, enc?: string): Promise<Buffer | string>;
  validateTextSize(text: unknown, max: number, label?: string): void;
};

const root = mkdtempSync(join(tmpdir(), 'jcad-dwg-limits-'));
/** A worker that starts and then never answers (a read that hangs). */
const silent = join(root, 'silent');
mkdirSync(silent);
writeFileSync(join(silent, 'dwg-worker.mjs'), "import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ ready: true }); parentPort.on('message', () => {});\n");
/** A worker that allocates without end on every read. */
const greedy = join(root, 'greedy');
mkdirSync(greedy);
writeFileSync(join(greedy, 'dwg-worker.mjs'), "import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ ready: true }); const keep = []; parentPort.on('message', () => { for (;;) keep.push(new Array(1e5).fill({ x: Math.random() })); });\n");
const hosts: Host[] = [];
const host = (options: Partial<Parameters<typeof createDwgHost>[0]> = {}) => {
  const h = createDwgHost({ scriptsDir: silent, ...options });
  hosts.push(h);
  return h;
};
afterAll(() => {
  for (const h of hosts) h.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe('desktop DWG resource limits (electron/dwg-host.cjs, E-7)', () => {
  it('the input limit is 128 MiB, checked before the worker starts (and by the reader itself)', async () => {
    expect(MAX_DRAWING_BYTES).toBe(128 * 1024 * 1024);
    expect(MAX_DWG_BYTES).toBe(MAX_DRAWING_BYTES);
    await expect(host({ maxBytes: 2 }).read(new Uint8Array(3))).rejects.toThrow(/larger than the supported/);
    const oversize = { byteLength: MAX_DWG_BYTES + 1, buffer: new ArrayBuffer(0), byteOffset: 0 };
    await expect(readDwgPayload(oversize, 'dwg')).rejects.toThrow(/larger than the supported 128 MB/);
  });

  it('a read that does not finish in time is stopped (slow worker), and the next read gets a fresh worker', async () => {
    const h = host({ timeoutMs: 400 });
    const t = Date.now();
    await expect(h.read(new Uint8Array(1))).rejects.toThrow(/took longer than/);
    expect(Date.now() - t).toBeLessThan(10_000);
    await expect(h.read(new Uint8Array(1))).rejects.toThrow(/took longer than/);
  });

  it('the time limit is 60 s plus 1 s per MB, at most 10 minutes', () => {
    expect(readTimeoutFor(0)).toBe(60_000);
    expect(readTimeoutFor(1)).toBe(61_000);
    expect(readTimeoutFor(100 * 1024 * 1024)).toBe(160_000);
    expect(readTimeoutFor(MAX_DRAWING_BYTES)).toBe(188_000);
    expect(readTimeoutFor(1024 * 1024 * 1024)).toBe(600_000);
  });

  it('a worker over its heap limit is stopped and the read fails with a message', () => {
    expect(WORKER_RESOURCE_LIMITS).toEqual({ maxOldGenerationSizeMb: 2048, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 });
    // V8 flags in NODE_OPTIONS (--max-old-space-size) override a worker's resourceLimits for the
    // whole process, so this runs in a child without them (the packaged app ignores NODE_OPTIONS:
    // the EnableNodeOptionsEnvironmentVariable fuse is off, E-15).
    const script = `const { createDwgHost } = require(${JSON.stringify(join(import.meta.dirname, '..', 'electron', 'dwg-host.cjs'))});
      const h = createDwgHost({ scriptsDir: ${JSON.stringify(greedy)}, timeoutMs: 60000, resourceLimits: { maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 8 } });
      h.read(new Uint8Array(1)).then(() => { console.log('RESOLVED'); process.exit(1); }, (e) => { console.log('REJECTED ' + e.message); h.dispose(); });`;
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const r = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 60_000 });
    expect(r.stdout.trim()).toBe('REJECTED The DWG reader ran out of its memory limit: the file is too large or damaged.');
  }, 70_000);

  it('cancel during start-up fails the read at once; ids cannot be reused while running', async () => {
    const h = host();
    const result = h.read(new Uint8Array(1), 12);
    const assertion = expect(result).rejects.toThrow('Open cancelled');
    await expect(h.read(new Uint8Array(1), 12)).rejects.toThrow(/request id/);
    expect(h.cancel(12)).toBe(true);
    await assertion;
    expect(h.cancel(12)).toBe(false);
  });

  it('dispose stops a start-up in progress and refuses later reads', async () => {
    const h = host();
    const result = h.read(new Uint8Array(1));
    const assertion = expect(result).rejects.toThrow(/closed/);
    h.dispose();
    await assertion;
    await expect(h.read(new Uint8Array(1))).rejects.toThrow(/closed/);
  });

  it('a worker that cannot start fails the read; nothing is parsed in the main process', async () => {
    const h = host({ scriptsDir: join(root, 'missing') });
    await expect(h.read(new Uint8Array(1))).rejects.toThrow();
    await expect(h.read(new Uint8Array(1))).rejects.toThrow();
    expect(h.usesWorker).toBe(true);
    expect(require('node:fs').readFileSync(join(import.meta.dirname, '..', 'electron', 'dwg-host.cjs'), 'utf8')).not.toMatch(/readDwgPayload|readInProcess/);
  });

  it('the WebAssembly memory cap refuses growth beyond it (the worker caps LibreDWG at 2 GiB)', () => {
    const restore = capWasmMemory(4 * 65536);
    try {
      const m = new WebAssembly.Memory({ initial: 1, maximum: 100 });
      expect(m.grow(2)).toBe(1);
      expect(() => m.grow(2)).toThrow(RangeError);
      expect(m.buffer.byteLength).toBe(3 * 65536);
      expect(m.grow(1)).toBe(3);
    } finally {
      restore();
    }
    expect(new WebAssembly.Memory({ initial: 1, maximum: 100 }).grow(10)).toBe(1);
    const worker = require('node:fs').readFileSync(join(import.meta.dirname, '..', 'scripts', 'dwg-worker.mjs'), 'utf8') as string;
    expect(worker).toMatch(/^capWasmMemory\(2 \* 1024 \* 1024 \* 1024\);$/m);
  });
});

describe('bounded reads and writes in the main process (electron/resource-limits.cjs)', () => {
  /** A file handle whose stat reports `reportedSize` while it holds `content`. */
  const reader = (reportedSize: number, content: string) => {
    let offset = 0;
    let closed = 0;
    let reads = 0;
    const handle = {
      stat: async () => ({ size: reportedSize, isFile: () => true }),
      read: async (buffer: Buffer, at: number, length: number) => {
        reads += 1;
        const source = Buffer.from(content);
        const bytesRead = Math.min(length, source.length - offset);
        source.copy(buffer, at, offset, offset + bytesRead);
        offset += bytesRead;
        return { bytesRead };
      },
      close: async () => {
        closed += 1;
      },
    };
    return { fs: { open: async () => handle }, closed: () => closed, reads: () => reads };
  };
  it('refuses an oversized file before reading it and always closes the handle', async () => {
    const r = reader(101, 'abc');
    await expect(readLimitedFile(r.fs, '/x/drawing.dxf', 100)).rejects.toThrow(/drawing\.dxf is larger than/);
    expect(r.reads()).toBe(0);
    expect(r.closed()).toBe(1);
  });
  it('detects a file that grew after the size check instead of reading past the limit', async () => {
    const r = reader(3, 'abcd');
    await expect(readLimitedFile(r.fs, '/x/drawing.dxf', 100)).rejects.toThrow(/changed while it was read/);
    expect(r.closed()).toBe(1);
  });
  it('reads a file at exactly the limit, as bytes or text', async () => {
    expect(await readLimitedFile(reader(3, 'abc').fs, 'd.dxf', 3, 'utf8')).toBe('abc');
    expect(Buffer.isBuffer(await readLimitedFile(reader(3, 'abc').fs, 'd.dxf', 3))).toBe(true);
  });
  it.skipIf(process.platform === 'win32')('a FIFO under a drawing name is refused at once instead of waiting for a writer for ever', async () => {
    // Before: open() for reading blocked until something wrote to the pipe, holding one of the
    // four libuv threads, and the process could not exit while it waited.
    const dir = mkdtempSync(join(tmpdir(), 'jcad-fifo-'));
    try {
      const fifo = join(dir, 'drawing.dxf');
      execFileSync('mkfifo', [fifo]);
      const t = performance.now();
      const outcome = await Promise.race([
        readLimitedFile(fsp, fifo, 100).then(() => 'read', (e: NodeJS.ErrnoException) => e.code ?? e.message),
        new Promise((resolve) => setTimeout(() => resolve('still waiting'), 3000)),
      ]);
      expect(outcome).toBe('EISDIR');
      expect(performance.now() - t).toBeLessThan(3000);
      // Regular files read as before.
      writeFileSync(join(dir, 'ok.dxf'), 'abc');
      expect(await readLimitedFile(fsp, join(dir, 'ok.dxf'), 3, 'utf8')).toBe('abc');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('write payloads are measured in UTF-8 bytes, like reads', () => {
    expect(() => validateTextSize('雷Δ', 4, 'project')).toThrow(/project payload/);
    expect(() => validateTextSize('雷Δ', 5, 'project')).not.toThrow();
    expect(() => validateTextSize(null, 5)).toThrow(/payload/);
  });
  it('the drawing, project, image and pack channels read through readLimitedFile', () => {
    const src = mainProcessSource();
    expect(src).not.toMatch(/\bfs\.readFile\(/);
    expect(src).toMatch(/readLimitedFile\(fs, file, MAX_DRAWING_BYTES\)/);
    expect(src).toMatch(/readLimitedFile\(fs, file, MAX_PROJECT_BYTES, 'utf8'\)/);
    expect(src).toMatch(/validateTextSize\(text, MAX_DRAWING_BYTES, 'DXF'\)/);
  });
});

describe('plot and print sheet sizes (security review E-18)', () => {
  const { validatePaperDimensions, MAX_PAPER_INCHES } = require('../electron/resource-limits.cjs') as { validatePaperDimensions(sheet: unknown): void; MAX_PAPER_INCHES: number };
  it('accepts finite positive sizes up to 200 inches, refuses everything else', () => {
    expect(MAX_PAPER_INCHES).toBe(200);
    for (const sheet of [undefined, null, {}, { width: 8.5, height: 11 }, { width: 46.8, height: 33.1 }, { width: 200, height: 0.5 }, { electron: 'A4' }]) expect(() => validatePaperDimensions(sheet), JSON.stringify(sheet)).not.toThrow();
    for (const width of [Infinity, -Infinity, NaN, -1, 0, 200.01, 1e9, '10', null]) expect(() => validatePaperDimensions({ width, height: 11 }), String(width)).toThrow(/Paper dimensions must be between 0 and 200 inches/);
  });
  it('plot-pdf and print-drawing check the sheet before anything else', () => {
    const plot = require('node:fs').readFileSync(join(import.meta.dirname, '..', 'electron', 'main', 'ipc-plot.cjs'), 'utf8') as string;
    for (const channel of ['plot-pdf', 'print-drawing']) {
      const body = plot.slice(plot.indexOf(`ipcMain.handle('${channel}'`));
      const check = body.indexOf('validatePaperDimensions(sheet);');
      expect(check, channel).toBeGreaterThan(0);
      expect(check, channel).toBeLessThan(body.indexOf('new BrowserWindow('));
      if (channel === 'plot-pdf') expect(check).toBeLessThan(body.indexOf('showSaveDialog'));
    }
  });
});
