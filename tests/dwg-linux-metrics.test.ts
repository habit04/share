import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';

const require = createRequire(import.meta.url);
const { createProcessMetricsReader, parseProcStat, parseProcStatus, MAX_STATUS_BYTES, MAX_STAT_BYTES } =
  require('../electron/dwg-linux-metrics.cjs') as {
    createProcessMetricsReader(options: { pid: number; getMetrics(): any[]; platform?: NodeJS.Platform; fs?: any }): () => any[];
    parseProcStat(text: string, pid: number): string;
    parseProcStatus(text: string, pid: number): { workingSetSize: number; peakWorkingSetSize: number };
    MAX_STATUS_BYTES: number;
    MAX_STAT_BYTES: number;
  };
const { createProcessMemoryGuard, DwgMemoryLimitError, DwgMemoryMonitorError } = require('../electron/dwg-process-limits.cjs');
const pid = 42;
const stat = (ticks = '987654321', command = 'reader') => `${pid} (${command}) S ${Array(18).fill('0').join(' ')} ${ticks} ${Array(30).fill('0').join(' ')}\n`;
const status = (rss = 100, peak = 200) => `Name:\treader\\nname\nTgid:\t${pid}\nPid:\t${pid}\nVmRSS:\t${rss} kB\nVmHWM:\t${peak} kB\n`;
const metric = (creationTime = 123) => ({ pid, type: 'Utility', creationTime });

function procFiles(options: { stats?: string[]; statuses?: string[]; chunk?: number; fault?: 'open' | 'stat' | 'read'; isFile?: boolean } = {}) {
  const stats = options.stats ?? [stat()];
  const statuses = options.statuses ?? [status()];
  const descriptors = new Map<number, { bytes: Buffer; offset: number }>();
  let sequence = 0;
  let statIndex = 0;
  let statusIndex = 0;
  const calls: string[] = [];
  const files = {
    openSync: vi.fn((path: string, flags: number) => {
      calls.push(path);
      expect(flags & (fs.constants.O_NOFOLLOW ?? 0)).toBe(fs.constants.O_NOFOLLOW ?? 0);
      expect(flags & (fs.constants.O_NONBLOCK ?? 0)).toBe(fs.constants.O_NONBLOCK ?? 0);
      if (options.fault === 'open') throw Object.assign(new Error('denied'), { code: 'EACCES' });
      expect(path === `/proc/${pid}/stat` || path === `/proc/${pid}/status`).toBe(true);
      const contents = path.endsWith('/stat') ? stats[Math.min(statIndex++, stats.length - 1)]! : statuses[Math.min(statusIndex++, statuses.length - 1)]!;
      const fd = ++sequence;
      descriptors.set(fd, { bytes: Buffer.from(contents), offset: 0 });
      return fd;
    }),
    fstatSync: vi.fn(() => {
      if (options.fault === 'stat') throw new Error('fstat failed');
      return { size: 0, isFile: () => options.isFile !== false };
    }),
    readSync: vi.fn((fd: number, output: Buffer, offset: number, length: number, position: null) => {
      if (options.fault === 'read') throw new Error('read failed');
      expect(position).toBeNull();
      const current = descriptors.get(fd)!;
      const count = Math.min(length, current.bytes.length - current.offset, options.chunk ?? Infinity);
      current.bytes.copy(output, offset, current.offset, current.offset + count);
      current.offset += count;
      return count;
    }),
    closeSync: vi.fn((fd: number) => { descriptors.delete(fd); }),
  };
  return { files, calls, descriptors };
}

describe('Linux DWG process metric parsing', () => {
  it('parses start ticks exactly even when stat comm contains parentheses, spaces and newlines', () => {
    expect(parseProcStat(stat('9007199254740993', 'odd ) reader (\nname ) tail'), pid)).toBe('9007199254740993');
    expect(parseProcStat(stat('18446744073709551615', ''), pid)).toBe('18446744073709551615');
    for (const text of [stat('0'), stat('-1'), stat('1.5'), stat('18446744073709551616'), stat('9'.repeat(100)),
      stat().replace('42 (', '43 ('), stat().replace(') S ', ') ? '), stat().replace(') S ', ') Z '), stat().replace(') S ', ') X '),
      stat().replace(') S ', ') x '), stat().replace(' S 0 ', ' S garbage '), stat().replace(' S 0 ', ' S 0\n'),
      '42 (reader) S 0', `${stat()}\0`, 'x'.repeat(MAX_STAT_BYTES + 1)]) {
      expect(() => parseProcStat(text, pid)).toThrow();
    }
  });

  it('uses positive RSS/HWM KiB and requires exact single process identity and unit fields', () => {
    expect(parseProcStatus(status(), pid)).toEqual({ workingSetSize: 100, peakWorkingSetSize: 200 });
    for (const text of [status(0), status(100, 0), status(200, 100), status(-1), status(1.5), status(Number.MAX_SAFE_INTEGER),
      status().replace('Pid:\t42', 'Pid:\t43'), status().replace('Tgid:\t42', 'Tgid:\t43'),
      status().replace('100 kB', '100 MB'), status().replace('VmHWM', 'NotHWM'), `${status()}VmRSS:\t100 kB\n`,
      `${status()}Pid:\t42\n`, `${status()}\0`, 'x'.repeat(MAX_STATUS_BYTES + 1)]) {
      expect(() => parseProcStatus(text, pid)).toThrow();
    }
  });
});

describe('parent-owned Linux process metric collector', () => {
  it('enriches only the target using bounded fd reads despite zero proc stat sizes and partial reads', () => {
    const proc = procFiles({ chunk: 7 });
    const other = { pid: 99, type: 'Browser', creationTime: 100, memory: { unchanged: true } };
    const target = { ...metric(), memory: { workingSetSize: 1, peakWorkingSetSize: 1, privateBytes: 1 } };
    const input = [other, target];
    const getMetrics = createProcessMetricsReader({ pid, getMetrics: () => input, platform: 'linux', fs: proc.files });
    const output = getMetrics();
    expect(output[0]).toBe(other);
    expect(output[1]).toEqual({ ...metric(), memory: { workingSetSize: 100, peakWorkingSetSize: 200 } });
    expect(target.memory.workingSetSize).toBe(1);
    expect(proc.calls).toEqual([`/proc/${pid}/stat`, `/proc/${pid}/status`, `/proc/${pid}/stat`]);
    expect(proc.files.closeSync).toHaveBeenCalledTimes(3);
    expect(proc.descriptors.size).toBe(0);
  });

  it('delegates unchanged metrics on other platforms without reading proc', () => {
    const proc = procFiles();
    const input = [{ ...metric(), memory: { workingSetSize: 100, peakWorkingSetSize: 200 } }];
    for (const platform of ['darwin', 'win32'] as const) {
      expect(createProcessMetricsReader({ pid, getMetrics: () => input, platform, fs: proc.files })()).toBe(input);
    }
    expect(proc.files.openSync).not.toHaveBeenCalled();
  });

  it('leaves a missing Electron process absent for the guard while rejecting invalid identities immediately', () => {
    const proc = procFiles();
    expect(createProcessMetricsReader({ pid, getMetrics: () => [], platform: 'linux', fs: proc.files })()).toEqual([]);
    expect(proc.files.openSync).not.toHaveBeenCalled();
    for (const input of [[metric(), metric()], [{ ...metric(), type: 'Browser' }], [metric(0)], [metric(NaN)], null]) {
      expect(() => createProcessMetricsReader({ pid, getMetrics: () => input as any, platform: 'linux', fs: proc.files })()).toThrow();
    }
    expect(proc.files.openSync).not.toHaveBeenCalled();
  });

  it('fails closed on PID reuse within a stat/status/stat bracket or across samples', () => {
    const raced = procFiles({ stats: [stat('100'), stat('200')] });
    expect(() => createProcessMetricsReader({ pid, getMetrics: () => [metric()], platform: 'linux', fs: raced.files })()).toThrow();
    expect(raced.descriptors.size).toBe(0);
    const died = procFiles({ stats: [stat('100'), stat('100').replace(') S ', ') Z ')] });
    expect(() => createProcessMetricsReader({ pid, getMetrics: () => [metric()], platform: 'linux', fs: died.files })()).toThrow();
    const reused = procFiles({ stats: [stat('100'), stat('100'), stat('200'), stat('200')] });
    const read = createProcessMetricsReader({ pid, getMetrics: () => [metric()], platform: 'linux', fs: reused.files });
    read();
    expect(() => read()).toThrow();
    const proc = procFiles();
    let creationTime = 123;
    const creationChanged = createProcessMetricsReader({ pid, getMetrics: () => [metric(creationTime)], platform: 'linux', fs: proc.files });
    creationChanged(); creationTime++;
    expect(() => creationChanged()).toThrow();
  });

  it.each(['open', 'stat', 'read'] as const)('refuses %s failures and closes every acquired descriptor', (fault) => {
    const proc = procFiles({ fault });
    expect(() => createProcessMetricsReader({ pid, getMetrics: () => [metric()], platform: 'linux', fs: proc.files })()).toThrow();
    expect(proc.descriptors.size).toBe(0);
    expect(proc.files.closeSync).toHaveBeenCalledTimes(fault === 'open' ? 0 : 1);
  });

  it('rejects an oversized proc file using an overflow byte, and refuses nonregular entries', () => {
    for (const options of [{ stats: ['x'.repeat(MAX_STAT_BYTES + 1)] }, { statuses: ['x'.repeat(MAX_STATUS_BYTES + 1)] }, { isFile: false }]) {
      const proc = procFiles(options);
      expect(() => createProcessMetricsReader({ pid, getMetrics: () => [metric()], platform: 'linux', fs: proc.files })()).toThrow();
      expect(proc.descriptors.size).toBe(0);
    }
    const exactStat = stat('100', 'x'.repeat(MAX_STAT_BYTES - Buffer.byteLength(stat('100', ''))));
    const exactStatus = `${status()}${'x'.repeat(MAX_STATUS_BYTES - Buffer.byteLength(status()))}`;
    const proc = procFiles({ stats: [exactStat], statuses: [exactStatus] });
    expect(createProcessMetricsReader({ pid, getMetrics: () => [metric()], platform: 'linux', fs: proc.files })()[0].memory)
      .toEqual({ workingSetSize: 100, peakWorkingSetSize: 200 });
    expect(proc.descriptors.size).toBe(0);
  });

  it('uses proc peak RSS to stop the real watchdog at its exact threshold and preserves monitor failure semantics', async () => {
    const proc = procFiles();
    const failure = vi.fn();
    const guard = createProcessMemoryGuard({ pid, getMetrics: createProcessMetricsReader({ pid, getMetrics: () => [metric()], platform: 'linux', fs: proc.files }),
      onFailure: failure, maxBytes: 200 * 1024 });
    await expect(guard.ready).rejects.toBeInstanceOf(DwgMemoryLimitError);
    expect(failure.mock.calls[0]![0].observedBytes).toBe(200 * 1024);
    const unavailable = createProcessMemoryGuard({ pid, getMetrics: createProcessMetricsReader({ pid, getMetrics: () => [metric()], platform: 'linux', fs: procFiles({ fault: 'open' }).files }), onFailure: () => {} });
    await expect(unavailable.ready).rejects.toBeInstanceOf(DwgMemoryMonitorError);
  });

  it('refuses invalid PIDs and collectors before any OS access', () => {
    for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createProcessMetricsReader({ pid: invalid, getMetrics: () => [] })).toThrow();
    }
    expect(() => createProcessMetricsReader({ pid, getMetrics: undefined as any })).toThrow();
  });
});
