import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FontMetricsRequest, NativeFontMetrics } from '../src/core/text-metrics';

const require = createRequire(import.meta.url);
type Host = { read(request: unknown): Promise<unknown>; dispose(): Promise<void> };
const { createFontMetricsHost, fontRequest } = require('../electron/font-metrics-host.cjs') as {
  createFontMetricsHost(options?: { workerFactory?: (request: FontMetricsRequest) => FakeWorker; timeoutMs?: number }): Host;
  fontRequest(request: unknown): FontMetricsRequest;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** A worker stays physically alive until acknowledgeStop emits exit and resolves terminate. */
class FakeWorker extends EventEmitter {
  readonly stop = deferred<number>();
  readonly terminate = vi.fn(() => this.stop.promise);
  stopped = false;
  constructor(readonly request: FontMetricsRequest) { super(); }
  acknowledgeStop(code = 0) {
    if (this.stopped) return;
    this.stopped = true;
    this.emit('exit', code);
    this.stop.resolve(code);
  }
}
const hosts: Host[] = [];
const workers: FakeWorker[] = [];
const requests: Promise<unknown>[] = [];
function read(host: Host, request: unknown) {
  const result = host.read(request);
  // Install a handler immediately: intentional disposal/overflow errors may happen before assertions.
  void result.catch(() => {});
  requests.push(result);
  return result;
}
function fixture(timeoutMs = 1_000) {
  const created: FakeWorker[] = [];
  let peak = 0;
  const factory = vi.fn((request: FontMetricsRequest) => {
    const worker = new FakeWorker(request);
    created.push(worker); workers.push(worker);
    peak = Math.max(peak, created.filter((entry) => !entry.stopped).length);
    return worker;
  });
  const host = createFontMetricsHost({ workerFactory: factory, timeoutMs });
  hosts.push(host);
  return { host, factory, created, peak: () => peak };
}
function stateOf(promise: Promise<unknown>) {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  void promise.then(() => { state = 'resolved'; }, () => { state = 'rejected'; });
  return () => state;
}
async function flush() { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }
const descriptor = (index: number): FontMetricsRequest => ({ font: `font-${index}.ttf` });
const metrics = (family: string) => ({ family, capitalHeight: 700, unitsPerEm: 1_000 });

afterEach(async () => {
  const disposing = hosts.splice(0).map((host) => host.dispose());
  for (const worker of workers.splice(0)) worker.acknowledgeStop();
  await Promise.allSettled(disposing);
  await Promise.allSettled(requests.splice(0));
  vi.useRealTimers();
});

describe('bounded font metric descriptors', () => {
  it('rejects invalid shapes, oversized strings, control characters and non-boolean face flags before launch', async () => {
    const f = fixture();
    const invalid = [null, undefined, [], 'Arial', 1, {}, { font: 1 },
      { font: 'X'.repeat(257) }, { font: 'arial\0.ttf' }, { font: 'Arial\nBold' },
      { font: 'Arial', family: 1 }, { font: 'Arial', family: 'X'.repeat(257) },
      { font: 'Arial', family: 'Arial\tBold' }, { font: 'Arial', bold: 1 },
      { font: 'Arial', bold: 'false' }, { font: 'Arial', italic: {} }];
    for (const value of invalid) {
      expect(() => fontRequest(value)).toThrow(/Invalid font/);
      await expect(read(f.host, value)).rejects.toThrow(/Invalid font/);
    }
    expect(f.factory).not.toHaveBeenCalled();
  });

  it('copies only descriptor fields and never forwards caller paths, font bytes or trusted-directory options', async () => {
    const f = fixture();
    const input = { font: 'Arial', family: 'Arial', bold: true, italic: false,
      path: 'C:\\private\\external.ttf', fontsDirectory: 'C:\\private', bytes: new Uint8Array([1, 2, 3]), ignored: 'X'.repeat(1_000) };
    const result = read(f.host, input);
    expect(f.created[0]!.request).toEqual({ font: 'Arial', family: 'Arial', bold: true, italic: false });
    expect(f.created[0]!.request).not.toBe(input);
    expect(input.bytes).toEqual(new Uint8Array([1, 2, 3]));
    f.created[0]!.emit('message', { metrics: null });
    f.created[0]!.acknowledgeStop();
    await expect(result).resolves.toBeNull();
  });

  it('preserves absent face flags rather than changing a literal bold/italic font filename to regular', () => {
    expect(fontRequest({ font: 'arialbd.ttf' })).toEqual({ font: 'arialbd.ttf' });
    expect(fontRequest({ font: 'ariali.ttf', bold: undefined, italic: undefined })).toEqual({ font: 'ariali.ttf' });
    expect(fontRequest({ font: 'Arial', bold: false, italic: true })).toEqual({ font: 'Arial', bold: false, italic: true });
  });
});

describe('font metric worker scheduling and containment', () => {
  it('deduplicates equal pending descriptors despite property order or ignored caller data', async () => {
    const f = fixture();
    const first = read(f.host, { font: 'Arial', family: 'Arial', italic: true, bold: true });
    const second = read(f.host, { bold: true, family: 'Arial', font: 'Arial', italic: true, path: 'C:\\ignored.ttf' });
    expect(second).toBe(first); expect(f.factory).toHaveBeenCalledOnce();
    f.created[0]!.emit('message', { metrics: metrics('Arial') });
    f.created[0]!.acknowledgeStop();
    await expect(first).resolves.toEqual(metrics('Arial'));
    await expect(second).resolves.toEqual(metrics('Arial'));
    // Deduplication is only pending work; it cannot pin stale installed font data forever.
    const later = read(f.host, { font: 'Arial', family: 'Arial', italic: true, bold: true });
    expect(later).not.toBe(first); expect(f.factory).toHaveBeenCalledTimes(2);
  });

  it('keeps unspecified face selection distinct from explicit false flags', async () => {
    const f = fixture();
    const implicit = read(f.host, { font: 'arialbd.ttf' });
    const explicit = read(f.host, { font: 'arialbd.ttf', bold: false, italic: false });
    expect(implicit).not.toBe(explicit); expect(f.factory).toHaveBeenCalledTimes(2);
    expect(f.created[0]!.request).toEqual({ font: 'arialbd.ttf' });
    expect(f.created[1]!.request).toEqual({ font: 'arialbd.ttf', bold: false, italic: false });
  });

  it('runs two workers in FIFO order and waits for physical termination before reusing a slot', async () => {
    const f = fixture();
    const first = read(f.host, descriptor(1)), second = read(f.host, descriptor(2));
    const third = read(f.host, descriptor(3)), fourth = read(f.host, descriptor(4));
    const firstState = stateOf(first);
    expect(f.created.map((worker) => worker.request.font)).toEqual(['font-1.ttf', 'font-2.ttf']);
    f.created[0]!.emit('message', { metrics: metrics('FIRST') });
    await flush();
    expect(firstState()).toBe('pending'); expect(f.factory).toHaveBeenCalledTimes(2);
    expect(f.created[0]!.terminate).toHaveBeenCalledOnce();
    f.created[0]!.acknowledgeStop();
    await expect(first).resolves.toEqual(metrics('FIRST'));
    expect(f.created.map((worker) => worker.request.font)).toEqual(['font-1.ttf', 'font-2.ttf', 'font-3.ttf']);
    f.created[1]!.emit('message', { metrics: metrics('SECOND') }); f.created[1]!.acknowledgeStop();
    await expect(second).resolves.toEqual(metrics('SECOND'));
    expect(f.created[3]!.request.font).toBe('font-4.ttf'); expect(f.peak()).toBe(2);
    f.created[2]!.emit('message', { metrics: metrics('THIRD') }); f.created[2]!.acknowledgeStop();
    f.created[3]!.emit('message', { metrics: metrics('FOURTH') }); f.created[3]!.acknowledgeStop();
    await expect(third).resolves.toEqual(metrics('THIRD')); await expect(fourth).resolves.toEqual(metrics('FOURTH'));
  });

  it('caps total distinct pending work at 32 while still accepting an existing duplicate', async () => {
    const f = fixture();
    const accepted = Array.from({ length: 32 }, (_, i) => read(f.host, descriptor(i)));
    expect(f.factory).toHaveBeenCalledTimes(2);
    await expect(read(f.host, descriptor(32))).rejects.toThrow(/Too many pending/);
    expect(read(f.host, descriptor(31))).toBe(accepted[31]);
    f.created[0]!.emit('message', { metrics: metrics('FINISHED') });
    await flush();
    await expect(read(f.host, descriptor(33))).rejects.toThrow(/Too many pending/);
    f.created[0]!.acknowledgeStop(); await accepted[0]; await flush();
    const replacement = read(f.host, descriptor(33));
    expect(stateOf(replacement)()).toBe('pending'); expect(f.factory).toHaveBeenCalledTimes(3);
    expect(f.peak()).toBe(2);
  });

  it.each(['message error', 'worker error', 'early exit'] as const)('settles %s without poisoning the next queued request', async (mode) => {
    const f = fixture();
    const first = read(f.host, descriptor(1)); read(f.host, descriptor(2));
    const third = read(f.host, descriptor(3)), status = stateOf(first), worker = f.created[0]!;
    if (mode === 'message error') worker.emit('message', { error: 'font is damaged' });
    else if (mode === 'worker error') worker.emit('error', new Error('worker failed'));
    else worker.acknowledgeStop(1);
    if (mode !== 'early exit') {
      await flush(); expect(status()).toBe('pending'); expect(f.factory).toHaveBeenCalledTimes(2);
      worker.acknowledgeStop(1);
    }
    await expect(first).rejects.toThrow(mode === 'message error' ? /font is damaged/ : mode === 'worker error' ? /worker failed/ : /exited before/);
    expect(f.created[2]!.request.font).toBe('font-3.ttf'); expect(f.peak()).toBe(2);
    f.created[2]!.emit('message', { metrics: metrics('RECOVERED') }); f.created[2]!.acknowledgeStop();
    await expect(third).resolves.toEqual(metrics('RECOVERED'));
  });

  it('honors the first terminal event and ignores a late error/message while termination is pending', async () => {
    const f = fixture(), result = read(f.host, descriptor(1)), worker = f.created[0]!;
    worker.emit('message', { metrics: metrics('FIRST') });
    worker.emit('error', new Error('late error'));
    worker.emit('message', { metrics: metrics('LATE') });
    expect(worker.terminate).toHaveBeenCalledOnce();
    worker.acknowledgeStop();
    await expect(result).resolves.toEqual(metrics('FIRST'));
  });

  it('times out, waits for acknowledged termination, then admits queued work without accepting a late success', async () => {
    vi.useFakeTimers();
    const f = fixture(50), first = read(f.host, descriptor(1)); read(f.host, descriptor(2));
    const third = read(f.host, descriptor(3)), status = stateOf(first);
    await vi.advanceTimersByTimeAsync(50);
    expect(status()).toBe('pending'); expect(f.factory).toHaveBeenCalledTimes(2);
    expect(f.created[0]!.terminate).toHaveBeenCalledOnce();
    f.created[0]!.emit('message', { metrics: metrics('TOO LATE') });
    f.created[0]!.acknowledgeStop();
    await expect(first).rejects.toThrow(/timed out/);
    expect(f.created[2]!.request.font).toBe('font-3.ttf');
    f.created[2]!.emit('message', { metrics: metrics('NEXT') }); f.created[2]!.acknowledgeStop();
    await expect(third).resolves.toEqual(metrics('NEXT')); expect(f.peak()).toBe(2);
  });

  it('a synchronous worker-launch error leaves the host available for a fresh request', async () => {
    const worker = new FakeWorker(descriptor(2)); workers.push(worker);
    const factory = vi.fn().mockImplementationOnce(() => { throw new Error('launch refused'); }).mockReturnValue(worker);
    const host = createFontMetricsHost({ workerFactory: factory }); hosts.push(host);
    await expect(read(host, descriptor(1))).rejects.toThrow(/launch refused/);
    const next = read(host, descriptor(2));
    worker.emit('message', { metrics: metrics('NEXT') }); worker.acknowledgeStop();
    await expect(next).resolves.toEqual(metrics('NEXT')); expect(factory).toHaveBeenCalledTimes(2);
  });

  it('a rejected terminate without exit evidence keeps its worker slot occupied and refuses the result', async () => {
    const f = fixture(), first = read(f.host, descriptor(1)); read(f.host, descriptor(2));
    const queued = read(f.host, descriptor(3)), firstState = stateOf(first), worker = f.created[0]!;
    worker.emit('message', { metrics: metrics('UNCONTAINED') });
    worker.stop.reject(new Error('stop refused'));
    await flush();
    expect(firstState()).not.toBe('resolved');
    expect(f.factory).toHaveBeenCalledTimes(2); expect(worker.stopped).toBe(false);
    worker.acknowledgeStop(1);
    await expect(first).rejects.toThrow(/stop refused|terminat|exited before/);
    await flush();
    expect(f.created[2]!.request.font).toBe('font-3.ttf'); expect(f.factory).toHaveBeenCalledTimes(3);
    expect(f.peak()).toBe(2);
    f.created[2]!.emit('message', { metrics: metrics('QUEUED') }); f.created[2]!.acknowledgeStop();
    await expect(queued).resolves.toEqual(metrics('QUEUED'));
    expect(f.factory).toHaveBeenCalledTimes(3);
  });

  it('dispose rejects queued work and late results, waits for both workers to stop, and prevents slot reuse', async () => {
    const f = fixture(), first = read(f.host, descriptor(1)), second = read(f.host, descriptor(2));
    const queued = read(f.host, descriptor(3)), closing = f.host.dispose(), closed = stateOf(closing);
    await expect(queued).rejects.toThrow(/closed/);
    await expect(read(f.host, descriptor(4))).rejects.toThrow(/closed/);
    f.created[0]!.emit('message', { metrics: metrics('LATE AFTER DISPOSE') });
    await flush();
    expect(closed()).toBe('pending'); expect(f.factory).toHaveBeenCalledTimes(2);
    f.created[0]!.acknowledgeStop();
    await expect(first).rejects.toThrow(/closed/);
    expect(closed()).toBe('pending');
    f.created[1]!.acknowledgeStop();
    await expect(second).rejects.toThrow(/closed|exited before/);
    await closing; expect(closed()).toBe('resolved'); expect(f.factory).toHaveBeenCalledTimes(2);
  });

  it('dispose cannot report completion when termination rejects before an active worker exits', async () => {
    const f = fixture(), first = read(f.host, descriptor(1)), second = read(f.host, descriptor(2));
    const queued = read(f.host, descriptor(3)), closing = f.host.dispose(), closed = stateOf(closing);
    f.created[0]!.stop.reject(new Error('stop refused'));
    f.created[1]!.acknowledgeStop();
    await expect(queued).rejects.toThrow(/closed/);
    await expect(second).rejects.toThrow(/closed|exited before/);
    await flush();
    expect(closed()).toBe('pending');
    expect(f.factory).toHaveBeenCalledTimes(2);
    f.created[0]!.acknowledgeStop(1);
    await expect(first).rejects.toThrow(/stop refused|terminat|closed|exited before/);
    await closing;
    expect(closed()).toBe('resolved'); expect(f.factory).toHaveBeenCalledTimes(2);
  });
});

const installedBoldArial = join(process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows', 'Fonts', 'arialbd.ttf');
describe('actual Windows font metric worker', () => {
  it.runIf(process.platform === 'win32' && existsSync(installedBoldArial))('reads installed bold Arial in the real worker without substituting the regular face or returning font bytes', async () => {
    const host = createFontMetricsHost({ timeoutMs: 10_000 }); hosts.push(host);
    const value = await read(host, { font: 'arialbd.ttf', family: 'Arial' }) as NativeFontMetrics & { resolvedFilename: string };
    expect(value.family).toBe('Arial'); expect(value.bold).toBe(true); expect(value.italic).toBe(false);
    expect(value.resolvedFilename.toLowerCase()).toBe('arialbd.ttf');
    expect(value.unitsPerEm).toBeGreaterThan(0); expect(value.capitalHeight).toBeGreaterThan(0);
    expect(value.cmap).toHaveLength(65_536); expect(value.advances.length).toBe(value.glyphBounds.length);
    const a = value.cmap[0x41]!;
    expect(a).toBeGreaterThan(0); expect(value.advances[a]).toBeGreaterThan(0);
    expect(value.glyphBounds[a]![3]).toBe(value.capitalHeight);
    expect(Object.values(value).some((field) => field instanceof Uint8Array)).toBe(false);
    expect(value).not.toHaveProperty('bytes'); expect(value).not.toHaveProperty('path');
  }, 15_000);
});
