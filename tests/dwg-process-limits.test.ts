import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createProcessMemoryGuard, measuredProcessBytes, DwgMemoryLimitError, DwgMemoryMonitorError } =
  require('../electron/dwg-process-limits.cjs');

function metric(rss = 100, peak = rss, privateBytes?: number, creationTime = 123) {
  return { pid: 42, creationTime, type: 'Utility', memory: { workingSetSize: rss, peakWorkingSetSize: peak, privateBytes } };
}

afterEach(() => { vi.useRealTimers(); });

describe('DWG process memory watchdog', () => {
  it('converts Electron KiB measurements and avoids adding overlapping memory values', () => {
    expect(measuredProcessBytes(metric(100, 200, 300).memory)).toBe(300 * 1024);
    expect(measuredProcessBytes(metric(100, 200).memory)).toBe(200 * 1024);
    for (const memory of [null, { workingSetSize: 0, peakWorkingSetSize: 0 },
      { workingSetSize: 100, peakWorkingSetSize: NaN },
      { workingSetSize: 100, peakWorkingSetSize: 100, privateBytes: -1 }]) {
      expect(() => measuredProcessBytes(memory)).toThrow(DwgMemoryMonitorError);
    }
  });

  it('blocks parser readiness until OS measurements appear, then observes external memory', async () => {
    vi.useFakeTimers();
    let metrics: ReturnType<typeof metric>[] = [];
    const failure = vi.fn();
    const guard = createProcessMemoryGuard({ pid: 42, getMetrics: () => metrics, onFailure: failure, maxBytes: 500 * 1024 });
    let ready = false;
    void guard.ready.then(() => { ready = true; });
    await vi.advanceTimersByTimeAsync(200);
    expect(ready).toBe(false);
    metrics = [metric()];
    await vi.advanceTimersByTimeAsync(100);
    expect(ready).toBe(true);
    expect(failure).not.toHaveBeenCalled();
    // Native private commitment can be high while the current JS/resident set is small.
    metrics = [metric(100, 200, 501)];
    await vi.advanceTimersByTimeAsync(100);
    expect(failure).toHaveBeenCalledOnce();
    expect(failure.mock.calls[0]![0]).toBeInstanceOf(DwgMemoryLimitError);
    expect(guard.checkNow()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects startup when metrics stay unavailable and leaves no polling timer', async () => {
    vi.useFakeTimers();
    const failure = vi.fn();
    const guard = createProcessMemoryGuard({ pid: 42, getMetrics: () => [], onFailure: failure });
    const rejected = expect(guard.ready).rejects.toBeInstanceOf(DwgMemoryMonitorError);
    await vi.advanceTimersByTimeAsync(3_000);
    await rejected;
    expect(failure).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['missing', 'reused', 'malformed', 'throws', 'duplicate', 'wrong-type'])(
    'fails closed after readiness if measurements are %s', async (change) => {
      vi.useFakeTimers();
      let metrics = [metric()];
      let throwing = false;
      const failure = vi.fn();
      const guard = createProcessMemoryGuard({ pid: 42, getMetrics: () => {
        if (throwing) throw new Error('OS metric lookup failed');
        return metrics;
      }, onFailure: failure });
      await guard.ready;
      if (change === 'missing') metrics = [];
      if (change === 'reused') metrics = [metric(100, 100, undefined, 456)];
      if (change === 'malformed') metrics = [metric(NaN)];
      if (change === 'duplicate') metrics = [metric(), metric()];
      if (change === 'wrong-type') metrics = [{ ...metric(), type: 'Browser' }];
      if (change === 'throws') throwing = true;
      await vi.advanceTimersByTimeAsync(100);
      expect(failure).toHaveBeenCalledOnce();
      expect(failure.mock.calls[0]![0]).toBeInstanceOf(DwgMemoryMonitorError);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('checks peak RSS and rejects at the exact threshold before authorizing parse', async () => {
    vi.useFakeTimers();
    const failure = vi.fn();
    const guard = createProcessMemoryGuard({ pid: 42, getMetrics: () => [metric(10, 100)],
      onFailure: failure, maxBytes: 100 * 1024 });
    await expect(guard.ready).rejects.toBeInstanceOf(DwgMemoryLimitError);
    expect(failure.mock.calls[0]![0].observedBytes).toBe(100 * 1024);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops both during bootstrap and after readiness without notifying failure', async () => {
    vi.useFakeTimers();
    const failure = vi.fn();
    const starting = createProcessMemoryGuard({ pid: 42, getMetrics: () => [], onFailure: failure });
    starting.stop();
    await expect(starting.ready).rejects.toBeInstanceOf(DwgMemoryMonitorError);
    const ready = createProcessMemoryGuard({ pid: 42, getMetrics: () => [metric()], onFailure: failure });
    await ready.ready;
    ready.stop();
    ready.stop();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(failure).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects invalid limits and process identifiers before starting a timer', () => {
    vi.useFakeTimers();
    const options = { pid: 42, getMetrics: () => [metric()], onFailure: vi.fn() };
    for (const invalid of [{ pid: 0 }, { pid: 1.5 }, { maxBytes: Infinity }, { maxBytes: 0 },
      { intervalMs: 0 }, { intervalMs: 1_001 }, { startupGraceMs: -1 }, { startupGraceMs: 15_001 }]) {
      expect(() => createProcessMemoryGuard({ ...options, ...invalid })).toThrow('Invalid DWG');
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
