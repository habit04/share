import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDwgWithWorker, type DwgWorkerLike } from '../src/io/dwg-worker-client';

class FakeWorker implements DwgWorkerLike {
  onmessage: DwgWorkerLike['onmessage'] = null;
  onerror: DwgWorkerLike['onerror'] = null;
  onmessageerror: DwgWorkerLike['onmessageerror'] = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  reply(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}
afterEach(() => vi.useRealTimers());
describe('browser DWG worker lifecycle', () => {
  it('returns a result, terminates and transfers a copy of the original bytes', async () => {
    const worker = new FakeWorker(), bytes = new Uint8Array([1, 2, 3]).buffer;
    const result = readDwgWithWorker(bytes, () => worker);
    const sent = worker.postMessage.mock.calls[0]![0] as { bytes: ArrayBuffer };
    expect(sent.bytes).not.toBe(bytes);
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3]));
    worker.reply({ ok: true, payload: { entities: [] }, version: 'R_2000' });
    expect((await result).version).toBe('R_2000');
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.onmessage).toBeNull();
  });
  it('rejects oversized or already cancelled reads before creating a worker', async () => {
    const factory = vi.fn(), controller = new AbortController();
    await expect(readDwgWithWorker(new ArrayBuffer(9), factory, { maxBytes: 8 })).rejects.toThrow(/size limit/);
    controller.abort();
    await expect(readDwgWithWorker(new ArrayBuffer(1), factory, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(factory).not.toHaveBeenCalled();
  });
  it('cancels a live parser and terminates it immediately', async () => {
    const worker = new FakeWorker(), controller = new AbortController();
    const result = readDwgWithWorker(new ArrayBuffer(1), () => worker, { signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('terminates a parser that exceeds its deadline', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const result = readDwgWithWorker(new ArrayBuffer(1), () => worker, { timeoutMs: 20 });
    const assertion = expect(result).rejects.toThrow(/time limit/);
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('releases a failed parser and reports its error', async () => {
    const worker = new FakeWorker();
    const result = readDwgWithWorker(new ArrayBuffer(1), () => worker);
    worker.reply({ ok: false, message: 'corrupt DWG' });
    await expect(result).rejects.toThrow('corrupt DWG');
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
