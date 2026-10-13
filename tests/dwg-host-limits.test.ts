/** Process containment, bounded IPC and queue admission for desktop DWG reads. */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
// @ts-expect-error plain JS helper shared with Electron main / CLI
import { readDwgPayload, MAX_DWG_BYTES } from '../scripts/dwg-reader.mjs';
import { mainProcessSource } from './helpers/main-process';
import { createDwgHost, OpenCancelledError, readTimeoutFor, WORKER_RESOURCE_LIMITS,
  MAX_OUTSTANDING_READS, MAX_QUEUED_BYTES, launchNodeProcess, unitMemoryGuard, stopNodeChildren,
  controlledLauncher, type ControlledDwgProcess, type DwgHost, type DwgHostOptions } from './helpers/dwg-process';

const require = createRequire(import.meta.url);
const { MAX_DRAWING_BYTES, readLimitedFile, validateTextSize } = require('../electron/resource-limits.cjs') as {
  MAX_DRAWING_BYTES: number;
  readLimitedFile(fs: unknown, file: string, max: number, enc?: string): Promise<Buffer | string>;
  validateTextSize(text: unknown, max: number, label?: string): void;
};
const realScriptsDir = join(import.meta.dirname, '..', 'scripts');
const root = mkdtempSync(join(tmpdir(), 'jcad-dwg-limits-'));
const silent = join(root, 'silent');
mkdirSync(silent);
// A valid process protocol that consumes input and then simulates a hung native parser.
writeFileSync(join(silent, 'dwg-process.mjs'), `
  let id = 0;
  process.send({ type: 'ready', protocol: 1, pid: process.pid });
  process.on('message', (message) => {
    if (message.type === 'input-start') {
      id = message.id;
      process.send({ type: 'input-ack', id, offset: 0 });
    } else if (message.type === 'input-chunk') {
      process.send({ type: 'input-ack', id, offset: message.offset + message.bytes.byteLength });
    }
  });
`);
const greedy = join(root, 'greedy');
mkdirSync(greedy);
mkdirSync(join(root, 'electron'));
// Run the production controller with its real inner Worker/resourceLimits, substituting only
// the parser workload. Its relative protocol import remains in the same directory layout.
copyFileSync(join(realScriptsDir, 'dwg-process.mjs'), join(greedy, 'dwg-process.mjs'));
copyFileSync(join(import.meta.dirname, '..', 'electron', 'dwg-protocol.cjs'), join(root, 'electron', 'dwg-protocol.cjs'));
writeFileSync(join(greedy, 'dwg-worker.mjs'), `
  import { parentPort } from 'node:worker_threads';
  import { getHeapStatistics } from 'node:v8';
  parentPort.postMessage({ ready: true, heapLimitBytes: getHeapStatistics().heap_size_limit });
  const keep = [];
  parentPort.on('message', () => { for (;;) keep.push(new Array(100_000).fill({ x: Math.random() })); });
`);
const hosts: DwgHost[] = [];
const doubles: ControlledDwgProcess[] = [];
function host(options: Partial<DwgHostOptions> = {}) {
  const h = createDwgHost({ scriptsDir: silent, launchProcess: launchNodeProcess,
    memoryGuardFactory: unitMemoryGuard, ...options });
  hosts.push(h);
  return h;
}
function controlledHost(autoExit = true, options: Partial<DwgHostOptions> = {}) {
  const launcher = controlledLauncher(autoExit);
  const h = host({ ...options, launchProcess: () => {
    const child = launcher.launchProcess();
    doubles.push(child);
    return child;
  } });
  return { h, children: launcher.children };
}
const emptyResult = { payload: { entities: [], layers: [], blocks: [] }, version: 'test' };
afterEach(async () => {
  vi.useRealTimers();
  for (const h of hosts.splice(0)) h.dispose();
  for (const child of doubles.splice(0)) child.exit();
  await stopNodeChildren();
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('desktop DWG process and IPC limits', () => {
  it('refuses input beyond 128 MiB before launching a process, and the reader also checks its limit', async () => {
    expect(MAX_DRAWING_BYTES).toBe(128 * 1024 * 1024);
    expect(MAX_DWG_BYTES).toBe(MAX_DRAWING_BYTES);
    const launcher = vi.fn(controlledLauncher().launchProcess);
    await expect(host({ maxBytes: 2, launchProcess: launcher }).read(new Uint8Array(3))).rejects.toThrow(/larger than the supported/);
    const beyondDefaultLimit = Object.defineProperty(new Uint8Array(1), 'byteLength', { value: MAX_DRAWING_BYTES + 1 });
    await expect(host({ launchProcess: launcher }).read(beyondDefaultLimit)).rejects.toThrow(/larger than the supported 128 MB/);
    expect(launcher).not.toHaveBeenCalled();
    const oversize = { byteLength: MAX_DWG_BYTES + 1, buffer: new ArrayBuffer(0), byteOffset: 0 };
    await expect(readDwgPayload(oversize, 'dwg')).rejects.toThrow(/larger than the supported 128 MB/);
  });

  it('stops a process that times out and waits for its exit before starting another read', async () => {
    const events: string[] = [];
    let count = 0;
    const h = host({ timeoutMs: 500, launchProcess: (entry, options) => {
      const n = ++count;
      events.push(`launch:${n}`);
      const child = launchNodeProcess(entry, options);
      child.on('exit', () => events.push(`exit:${n}`));
      return child;
    } });
    const start = Date.now();
    await expect(h.read(new Uint8Array(1))).rejects.toThrow(/took longer than/);
    await expect(h.read(new Uint8Array(1))).rejects.toThrow(/took longer than/);
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(events.slice(0, 3)).toEqual(['launch:1', 'exit:1', 'launch:2']);
  });

  it('sets a 60 s plus 1 s per MB deadline, with a 10 minute maximum', () => {
    expect(readTimeoutFor(0)).toBe(60_000);
    expect(readTimeoutFor(1)).toBe(61_000);
    expect(readTimeoutFor(100 * 1024 * 1024)).toBe(160_000);
    expect(readTimeoutFor(MAX_DRAWING_BYTES)).toBe(188_000);
    expect(readTimeoutFor(1024 * 1024 * 1024)).toBe(600_000);
  });

  it('contains an actual inner Worker heap exhaustion and reports a useful failure', async () => {
    expect(WORKER_RESOURCE_LIMITS).toEqual({ maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 });
    const h = host({ scriptsDir: greedy, timeoutMs: 30_000,
      resourceLimits: { maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 8 } });
    const previousOptions = process.env.NODE_OPTIONS;
    // Parent V8 flags must not override the inner Worker's deliberately small heap limit.
    process.env.NODE_OPTIONS = '--max-old-space-size=4096';
    try {
      await expect(h.read(new Uint8Array(1))).rejects.toThrow('The DWG reader ran out of its memory limit: the file is too large or damaged.');
      // An OOM disposes the controller as well: another read starts from a fresh bounded Worker.
      await expect(h.read(new Uint8Array(1))).rejects.toThrow(/ran out of its memory limit/);
    } finally {
      if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousOptions;
    }
  }, 70_000);

  it('rejects invalid limits and refuses to raise the production Worker budget', () => {
    const invalidLimits: Array<Record<string, number>> = [{ maxOldGenerationSizeMb: 513 }, { maxYoungGenerationSizeMb: 65 },
      { stackSizeMb: 9 }, { maxOldGenerationSizeMb: 15 }, { maxYoungGenerationSizeMb: NaN }, { unknown: 1 }];
    for (const resourceLimits of invalidLimits) {
      expect(() => host({ resourceLimits })).toThrow(/Invalid DWG worker resource limits/);
    }
  });

  it('cancels a starting read and a queued read without starting the queued process; duplicate ids fail', async () => {
    const { h, children } = controlledHost();
    const starting = h.read(new Uint8Array(1), 12);
    const queued = h.read(new Uint8Array(1), 13);
    const startRejected = expect(starting).rejects.toBeInstanceOf(OpenCancelledError);
    const queueRejected = expect(queued).rejects.toBeInstanceOf(OpenCancelledError);
    await expect(h.read(new Uint8Array(1), 12)).rejects.toThrow(/request id/);
    await expect(h.read(new Uint8Array(1), 13)).rejects.toThrow(/request id/);
    expect(h.cancel(13)).toBe(true);
    await queueRejected;
    expect(children).toHaveLength(1);
    expect(children[0]!.killCalls).toBe(0);
    expect(h.cancel(12)).toBe(true);
    await startRejected;
    expect(children[0]!.killCalls).toBe(1);
    expect(h.cancel(12)).toBe(false);
    expect(h.cancel(13)).toBe(false);
  });

  it('disposes active and queued reads and refuses subsequent reads', async () => {
    const { h, children } = controlledHost();
    const active = h.read(new Uint8Array(1));
    const queued = h.read(new Uint8Array(1));
    const activeRejected = expect(active).rejects.toThrow(/closed/);
    const queuedRejected = expect(queued).rejects.toThrow(/closed/);
    h.dispose();
    await Promise.all([activeRejected, queuedRejected]);
    expect(children[0]!.killCalls).toBe(1);
    expect(children).toHaveLength(1);
    await expect(h.read(new Uint8Array(1))).rejects.toThrow(/closed/);
  });

  it('refuses more than four outstanding reads and releases slots when queued reads are cancelled', async () => {
    expect(MAX_OUTSTANDING_READS).toBe(4);
    const { h, children } = controlledHost();
    const reads = [1, 2, 3, 4].map((id) => h.read(new Uint8Array(1), id).catch((error: Error) => error));
    await expect(h.read(new Uint8Array(1), 5)).rejects.toThrow(/Too many DWG files/);
    expect(children).toHaveLength(1);
    expect(h.cancel(4)).toBe(true);
    const replacement = h.read(new Uint8Array(1), 5).catch((error: Error) => error);
    for (const id of [1, 2, 3, 5]) expect(h.cancel(id)).toBe(true);
    for (const result of await Promise.all([...reads, replacement])) expect(result).toBeInstanceOf(OpenCancelledError);
  });

  it('bounds the combined active and queued input to 128 MiB and releases a cancelled reservation', async () => {
    expect(MAX_QUEUED_BYTES).toBe(MAX_DRAWING_BYTES);
    const { h, children } = controlledHost();
    // Byte-length doubles exercise admission only; no process is started or input transferred.
    // The actual one-byte backing stores avoid making the test allocate two 64 MiB buffers.
    const accountedBytes = () => Object.defineProperty(new Uint8Array(1), 'byteLength', { value: MAX_DRAWING_BYTES / 2 });
    const active = h.read(accountedBytes(), 1).catch((error: Error) => error);
    const queued = h.read(accountedBytes(), 2).catch((error: Error) => error);
    await expect(h.read(new Uint8Array(1), 3)).rejects.toThrow(/Too many DWG files/);
    expect(h.cancel(2)).toBe(true);
    const admitted = h.read(new Uint8Array(1), 3).catch((error: Error) => error);
    expect(children).toHaveLength(1);
    expect(h.cancel(1)).toBe(true);
    expect(h.cancel(3)).toBe(true);
    for (const result of await Promise.all([active, queued, admitted])) expect(result).toBeInstanceOf(OpenCancelledError);
  });

  it('does not launch a replacement until the finished process reports exit', async () => {
    const { h, children } = controlledHost(false);
    const first = h.read(new Uint8Array(1), 1);
    const next = h.read(new Uint8Array(1), 2);
    await children[0]!.start();
    children[0]!.acceptInput();
    children[0]!.respond(emptyResult);
    await expect(first).resolves.toEqual(emptyResult);
    expect(children[0]!.killCalls).toBe(1);
    expect(children).toHaveLength(1);
    children[0]!.exit();
    await Promise.resolve();
    expect(children).toHaveLength(2);
    await children[1]!.start();
    children[1]!.acceptInput();
    children[1]!.respond(emptyResult);
    await expect(next).resolves.toEqual(emptyResult);
    children[1]!.exit();
  });

  it('waits for memory monitoring readiness before handing any input to the process', async () => {
    let ready!: () => void;
    const { h, children } = controlledHost(true, { memoryGuardFactory: () => ({
      ready: new Promise<void>((resolve) => { ready = resolve; }), checkNow: () => true, stop: () => {},
    }) });
    const result = h.read(new Uint8Array(1));
    await children[0]!.start();
    expect(children[0]!.sent).toEqual([]);
    ready();
    await Promise.resolve();
    children[0]!.acceptInput();
    children[0]!.respond(emptyResult);
    await expect(result).resolves.toEqual(emptyResult);
  });

  it('snapshots caller input and transfers acknowledged chunks with at most 1 MiB per frame', async () => {
    const { h, children } = controlledHost();
    const bytes = new Uint8Array(2 * 1024 * 1024 + 3).fill(1);
    const result = h.read(bytes, 7);
    bytes.fill(9);
    const child = children[0]!;
    await child.start();
    child.acceptInput();
    const chunks = child.sent.filter((message) => message.type === 'input-chunk');
    expect(chunks.map((message) => message.offset)).toEqual([0, 1024 * 1024, 2 * 1024 * 1024]);
    expect(chunks.map((message) => message.bytes.byteLength)).toEqual([1024 * 1024, 1024 * 1024, 3]);
    for (const chunk of chunks) {
      expect(chunk.bytes).toBeInstanceOf(Uint8Array);
      expect(chunk.bytes.buffer.byteLength).toBe(chunk.bytes.byteLength);
      expect(chunk.bytes.every((byte: number) => byte === 1)).toBe(true);
    }
    const largeResult = { ...emptyResult, payload: { ...emptyResult.payload,
      notes: ['a'.repeat(700_000), 'b'.repeat(700_000), 'c'.repeat(700_000)] } };
    child.respond(largeResult);
    await expect(result).resolves.toEqual(largeResult);
    const acks = child.sent.filter((message) => message.type === 'output-ack').map((message) => message.offset);
    expect(acks.slice(0, 3)).toEqual([0, 1024 * 1024, 2 * 1024 * 1024]);
    expect(acks[3]).toBeGreaterThan(acks[2]!);
    expect(acks[3]! - acks[2]!).toBeLessThan(1024 * 1024);
  });

  it.each([64 * 1024 * 1024 + 1, Number.MAX_SAFE_INTEGER, 0, -1, NaN, Infinity])(
    'rejects an output length of %s before allocating a buffer', async (byteLength) => {
      const { h, children } = controlledHost();
      const read = h.read(new Uint8Array(1), 1);
      const rejected = expect(read).rejects.toThrow(/invalid or oversized response/);
      const child = children[0]!;
      await child.start();
      child.acceptInput();
      const allocation = vi.spyOn(Buffer, 'allocUnsafe').mockImplementation(() => { throw new Error('Unexpected output allocation'); });
      try {
        child.reply({ type: 'output-start', id: 1, byteLength });
        expect(allocation).not.toHaveBeenCalled();
      } finally { allocation.mockRestore(); }
      await rejected;
      expect(child.killCalls).toBe(1);
    },
  );

  it.each(['out-of-order', 'wrong-type', 'empty', 'too-large', 'past-end', 'early-done'])(
    'rejects a malformed output stream (%s)', async (failure) => {
      const { h, children } = controlledHost();
      const read = h.read(new Uint8Array(1), 1);
      const rejected = expect(read).rejects.toThrow(/invalid or oversized response/);
      const child = children[0]!;
      await child.start();
      child.acceptInput();
      child.reply({ type: 'output-start', id: 1, byteLength: 16 });
      if (failure === 'early-done') child.reply({ type: 'done', id: 1 });
      else child.reply({ type: 'output-chunk', id: 1, offset: failure === 'out-of-order' ? 1 : 0,
        bytes: failure === 'wrong-type' ? [1] : new Uint8Array(failure === 'empty' ? 0 : failure === 'too-large' ? 1024 * 1024 + 1 : failure === 'past-end' ? 17 : 1) });
      await rejected;
      expect(child.killCalls).toBe(1);
    },
  );

  it.each(['wrong-id', 'wrong-protocol', 'wrong-pid', 'early-output', 'bad-ack'])(
    'fails closed on invalid process messages (%s)', async (failure) => {
      const { h, children } = controlledHost();
      const read = h.read(new Uint8Array(1), 1);
      const rejected = expect(read).rejects.toThrow(/invalid or oversized response/);
      const child = children[0]!;
      await child.start({ type: 'ready', protocol: failure === 'wrong-protocol' ? 2 : 1,
        pid: failure === 'wrong-pid' ? child.pid + 1 : child.pid });
      if (failure === 'wrong-id') child.reply({ type: 'input-ack', id: 2, offset: 0 });
      if (failure === 'bad-ack') child.reply({ type: 'input-ack', id: 1, offset: 1 });
      if (failure === 'early-output') child.reply({ type: 'output-start', id: 1, byteLength: 16 });
      await rejected;
      expect(child.killCalls).toBe(1);
    },
  );

  it.each(['out-of-order', 'wrong-type', 'oversized'])(
    'the actual controller refuses malformed input chunks (%s)', async (failure) => {
      const child = launchNodeProcess(join(realScriptsDir, 'dwg-process.mjs'), { env: { ...process.env, NODE_OPTIONS: '' } });
      const [ready] = await once(child, 'message');
      expect(ready).toEqual({ type: 'ready', protocol: 1, pid: child.pid });
      const ack = once(child, 'message');
      child.postMessage({ type: 'input-start', id: 1, byteLength: 2 * 1024 * 1024, resourceLimits: WORKER_RESOURCE_LIMITS });
      expect((await ack)[0]).toEqual({ type: 'input-ack', id: 1, offset: 0 });
      const error = once(child, 'message');
      child.postMessage({ type: 'input-chunk', id: 1, offset: failure === 'out-of-order' ? 1 : 0,
        bytes: failure === 'wrong-type' ? [1] : new Uint8Array(failure === 'oversized' ? 1024 * 1024 + 1 : 1) });
      expect((await error)[0]).toMatchObject({ type: 'error', id: 1, message: 'Invalid DWG reader byte chunk.' });
    },
  );

  it('reports a process startup failure, and the default launcher never falls back when Electron is absent', async () => {
    const missing = host({ scriptsDir: join(root, 'missing') });
    await expect(missing.read(new Uint8Array(1))).rejects.toThrow(/stopped|unexpectedly|memory/i);
    await expect(missing.read(new Uint8Array(1))).rejects.toThrow(/stopped|unexpectedly|memory/i);
    const production = createDwgHost({ scriptsDir: realScriptsDir, memoryGuardFactory: unitMemoryGuard });
    hosts.push(production);
    const fixture = new Uint8Array(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'example_2000.dwg')));
    await expect(production.read(fixture)).rejects.toThrow('The isolated DWG reader is unavailable.');
    expect(production.usesProcess).toBe(true);
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
  it('plot-pdf and print-drawing reject invalid sheets before a dialog, export capture or hidden allocation', async () => {
    // Exercise the actual registered callbacks; the dialog may live in a delegated
    // helper. Electron/window APIs are fail-fast doubles, never a native app launch.
    const file = join(import.meta.dirname, '..', 'electron', 'main', 'ipc-plot.cjs'), localRequire = createRequire(file);
    const handlers = new Map<string, (ev: unknown, ...args: unknown[]) => Promise<unknown>>();
    const frame = { processId: 1, routingId: 1, parent: null, url: 'jcad://app/index.html' };
    const contents = { mainFrame: frame }, win = { isDestroyed: () => false, webContents: contents }, ev = { sender: contents, senderFrame: frame };
    const saveDialog = vi.fn(async () => { throw new Error('Invalid sheets must not open a dialog'); });
    const hiddenAllocation = vi.fn(() => { throw new Error('Invalid sheets must not allocate a hidden window'); });
    class HiddenWindow {
      constructor() { hiddenAllocation(); }
      static fromWebContents() { return win; }
    }
    const capture = vi.fn(), capturePicked = vi.fn(), writer = vi.fn(), secure = vi.fn();
    const { guardIpc } = require('../electron/ipc-guard.cjs');
    const ipcMain = guardIpc({ handle: (channel: string, callback: (ev: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, callback) }, {
      getWindow: () => win, isAppUrl: (url: string) => url === frame.url, log: { reject: vi.fn() },
    });
    const module = { exports: {} as { registerPlotIpc(ctx: unknown): void } };
    new Function('require', 'module', readFileSync(file, 'utf8'))((name: string) => {
      if (name === 'electron') return { dialog: { showSaveDialog: saveDialog }, BrowserWindow: HiddenWindow };
      if (name === './app-data.cjs') return { writeUserFile: writer, enqueueWrite: writer };
      if (name === './window.cjs') return { secureContents: secure };
      return localRequire(name);
    }, module);
    module.exports.registerPlotIpc({ ipcMain, senderWindow: () => win, saveOrder: { capture, capturePicked } });
    const badSheets = [
      { width: Infinity, height: 11 }, { width: 8.5, height: Infinity }, { width: NaN, height: 11 },
      { width: 0, height: 11 }, { width: 8.5, height: -1 }, { width: 200.01, height: 11 },
      { width: 8.5, height: 200.01 }, { width: '10', height: 11 }, { width: 1e9, height: 11, electron: 'A4' },
    ];
    for (const channel of ['plot-pdf', 'print-drawing']) for (const sheet of badSheets) {
      await expect(handlers.get(channel)!(ev, 'data:image/png;base64,YQ==', 'Invalid sheet', false, sheet), `${channel}: ${String(sheet.width)}x${sheet.height}`).rejects.toThrow(/Paper dimensions must be between 0 and 200 inches/);
    }
    expect(saveDialog).not.toHaveBeenCalled(); expect(hiddenAllocation).not.toHaveBeenCalled(); expect(secure).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled(); expect(capturePicked).not.toHaveBeenCalled(); expect(writer).not.toHaveBeenCalled();
  });
});
