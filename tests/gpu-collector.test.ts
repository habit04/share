import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { createGPUCollector, projectGPUInfo } = require('../electron/gpu-diagnostics.cjs');
const versions = { jcad: '0.4.8', electron: '44.7.0', chromium: '152.0', windows: '10.0.26100' };
const hardware = { gpuDevice: [{ deviceString: 'NVIDIA GPU', vendorId: 0x10de, deviceId: 0x1234, active: true, driverVendor: 'NVIDIA', driverVersion: '32.0' }] };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function setup(raw: unknown = hardware) {
  const app = Object.assign(new EventEmitter(), {
    getGPUInfo: vi.fn(async (_kind: string) => raw),
    getGPUFeatureStatus: vi.fn(() => ({ webgl: 'enabled', gpu_compositing: 'enabled' })),
    isHardwareAccelerationEnabled: vi.fn(() => true),
  });
  const collector = createGPUCollector(app, { versions, timeoutMs: 100 });
  return { app, collector };
}
afterEach(() => { vi.useRealTimers(); });

describe('GPU diagnostics projection', () => {
  it('projects hardware fields without assuming hardware means every feature is accelerated', () => {
    const result = projectGPUInfo(hardware, { webgl: 'enabled', video_decode: 'disabled_off' }, true, versions);
    expect(result.adapters[0]).toEqual({ name: 'NVIDIA GPU', vendorId: '0x10de', deviceId: '0x1234', active: true, driverVendor: 'NVIDIA', driverVersion: '32.0' });
    expect(result.features.video_decode).toBe('disabled_off');
    expect(result.reasons).toEqual(['video_decode: disabled_off']);
    expect(result.fallback).toBe('Unknown');
    expect(result.versions).toEqual(versions);
  });
  it('distinguishes software fallback for each reported feature', () => {
    const result = projectGPUInfo(hardware, { webgl: 'unavailable_software', video_decode: 'disabled_software', gpu_compositing: 'enabled' }, true, versions);
    expect(result.reasons).toEqual(['video_decode: disabled_software', 'webgl: unavailable_software']);
    expect(result.fallback).toBe('Software fallback reported');
    expect(result.features.gpu_compositing).toBe('enabled');
  });
  it.each([{ auxAttributes: { softwareRendering: true } }, { auxAttributes: { glRenderer: 'ANGLE (SwiftShader Device)' } }, { softwareRendering: true }])('uses explicit software evidence %j', (raw) => {
    expect(projectGPUInfo(raw, {}, false, versions).fallback).toBe('Software fallback reported');
  });
  it('does not infer software fallback from acceleration being off or adapter ordering', () => {
    const result = projectGPUInfo({ gpuDevice: [{ deviceString: 'First' }, { deviceString: 'Second', active: true }, { active: false }] }, {}, false, versions);
    expect(result.adapters.map((a: any) => a.active)).toEqual([null, true, false]);
    expect(result.fallback).toBe('Unknown');
  });
  it('labels missing and malformed information Unknown', () => {
    const result = projectGPUInfo({ gpuDevice: [null, { active: 'true', vendorId: -1 }] }, null, undefined, versions);
    expect(result.adapters[0]).toEqual({ name: 'Unknown', vendorId: 'Unknown', deviceId: 'Unknown', active: null, driverVendor: 'Unknown', driverVersion: 'Unknown' });
    expect(result.adapters[1].active).toBeNull();
    expect(result.hardwareAcceleration).toBeNull();
    expect(Object.values(result.features).every((v) => v === 'Unknown')).toBe(true);
  });
  it('bounds output, omits raw fields and suppresses paths and credentials', () => {
    const raw = { gpuDevice: Array.from({ length: 100 }, () => ({ deviceString: 'A\u0000' + 'B'.repeat(200), driverVendor: 'C:\\Users\\private', driverVersion: 'token=private', secret: 'private' })), auxAttributes: { glRenderer: 'private' }, private: 'private' };
    const result = projectGPUInfo(raw, { webgl: 'https://user:pass@host', secret: 'private' }, true, versions);
    expect(result.adapters).toHaveLength(16);
    expect(result.adapters[0].name).toHaveLength(160);
    expect(result.adapters[0].driverVendor).toBe('Unknown');
    expect(result.adapters[0].driverVersion).toBe('Unknown');
    expect(result.features.webgl).toBe('Unknown');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(Object.keys(result).sort()).toEqual(['adapters', 'driver', 'fallback', 'features', 'hardwareAcceleration', 'reasons', 'state', 'versions']);
  });
  it('normalizes control characters before rejecting credentials', () => {
    for (const name of ['api_key=private', 'to\u0000ken=private']) {
      expect(projectGPUInfo({ gpuDevice: [{ deviceString: name }] }, {}, true, versions).adapters[0].name).toBe('Unknown');
    }
  });
  it('keeps global Chromium driver details separate from adapter drivers', () => {
    const result = projectGPUInfo({ ...hardware, auxAttributes: { driverVendor: 'Global vendor', driverVersion: '32.1' } }, {}, false, versions);
    expect(result.driver).toEqual({ vendor: 'Global vendor', version: '32.1' });
    expect(result.adapters[0].driverVendor).toBe('NVIDIA');
    expect(result.reasons).toContain('Electron reports hardware acceleration disabled; underlying reason Unknown.');
    expect(result.fallback).toBe('Unknown');
    expect(projectGPUInfo({}, { webgl: 'unavailable_off' }, true, versions).reasons).toEqual(['webgl: unavailable_off']);
  });
});

describe('GPU collector lifecycle', () => {
  it('registers early and calls no GPU APIs before the event, including after timeout', async () => {
    vi.useFakeTimers();
    const { app, collector } = setup();
    expect(app.listenerCount('gpu-info-update')).toBe(1);
    expect(collector.get().state).toBe('pending');
    await vi.advanceTimersByTimeAsync(101);
    expect(collector.get().state).toBe('unavailable');
    expect(app.getGPUInfo).not.toHaveBeenCalled();
    expect(app.getGPUFeatureStatus).not.toHaveBeenCalled();
    expect(app.isHardwareAccelerationEnabled).not.toHaveBeenCalled();
    app.emit('gpu-info-update');
    await flush();
    expect(collector.get().state).toBe('ready');
    expect(app.getGPUInfo).toHaveBeenCalledWith('complete');
    collector.dispose();
  });
  it.each(['getGPUInfo', 'getGPUFeatureStatus', 'isHardwareAccelerationEnabled'] as const)('recovers from %s throwing without exposing exception text', async (method) => {
    const { app, collector } = setup();
    app[method].mockImplementationOnce(() => { throw new Error('C:\\Users\\private token=secret'); });
    app.emit('gpu-info-update');
    await flush();
    const recovered = await collector.get();
    expect(recovered.state).toBe('ready');
    expect(JSON.stringify(recovered)).not.toContain('private');
    collector.dispose();
  });
  it('bounds hangs, coalesces calls and ignores late results after recovery', async () => {
    vi.useFakeTimers();
    const { app, collector } = setup();
    let resolveLate!: (value: unknown) => void;
    app.getGPUInfo.mockImplementationOnce(() => new Promise((resolve) => { resolveLate = resolve; }));
    app.emit('gpu-info-update');
    app.emit('gpu-info-update');
    await flush();
    expect(app.getGPUInfo).toHaveBeenCalledTimes(1);
    expect(collector.get().state).toBe('pending');
    await vi.advanceTimersByTimeAsync(101);
    expect((await collector.get()).state).toBe('ready');
    resolveLate({ gpuDevice: [{ deviceString: 'Stale' }] });
    await flush();
    expect(collector.get().adapters[0].name).toBe('NVIDIA GPU');
    collector.dispose();
    expect(app.listenerCount('gpu-info-update')).toBe(0);
  });
  it('refreshes on later events and returns isolated snapshots', async () => {
    const { app, collector } = setup();
    app.emit('gpu-info-update');
    await flush();
    collector.get().adapters[0].name = 'Mutated';
    expect(collector.get().adapters[0].name).toBe('NVIDIA GPU');
    app.getGPUInfo.mockResolvedValueOnce({});
    app.emit('gpu-info-update');
    await flush();
    expect((await collector.get()).adapters).toEqual([]);
    collector.dispose();
  });
  it('retains independent fields on rejection and timeout', async () => {
    vi.useFakeTimers();
    const { app, collector } = setup();
    app.getGPUInfo.mockRejectedValue(new Error('private'));
    app.emit('gpu-info-update');
    await flush();
    const partial = await collector.get();
    expect(partial.state).toBe('unavailable');
    expect(partial.features.webgl).toBe('enabled');
    expect(partial.hardwareAcceleration).toBe(true);
    app.getGPUInfo.mockImplementation(() => new Promise(() => {}));
    const retry = collector.get();
    await vi.advanceTimersByTimeAsync(101);
    const timeout = await retry;
    expect(timeout.state).toBe('unavailable');
    expect(timeout.features.webgl).toBe('enabled');
    expect(timeout.hardwareAcceleration).toBe(true);
    collector.dispose();
  });
  it('refreshes a dirty collection once without looping on self-emitted events', async () => {
    const { app, collector } = setup();
    let first!: (value: unknown) => void;
    app.getGPUInfo.mockImplementationOnce(() => new Promise((resolve) => { first = resolve; }));
    app.emit('gpu-info-update');
    await flush();
    app.getGPUFeatureStatus.mockReturnValue({ webgl: 'disabled_off', gpu_compositing: 'enabled' });
    app.emit('gpu-info-update');
    app.getGPUInfo.mockImplementation(async () => { app.emit('gpu-info-update'); return hardware; });
    first(hardware);
    await flush();
    await flush();
    expect(app.getGPUInfo).toHaveBeenCalledTimes(2);
    expect(collector.get().features.webgl).toBe('disabled_off');
    expect(collector.get().state).toBe('ready');
    collector.dispose();
  });
  it('does not loop on asynchronous GPU-info events after a settled collection', async () => {
    vi.useFakeTimers();
    const { app, collector } = setup();
    app.getGPUInfo.mockImplementation(async () => {
      setTimeout(() => app.emit('gpu-info-update'), 1);
      return hardware;
    });
    app.emit('gpu-info-update');
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(app.getGPUInfo).toHaveBeenCalledTimes(1);
    const refreshed = await collector.get();
    expect(refreshed.state).toBe('ready');
    await vi.advanceTimersByTimeAsync(500);
    expect(app.getGPUInfo).toHaveBeenCalledTimes(2);
    collector.dispose();
  });
  it('settles a timed-out retry independently of a dirty follow-up', async () => {
    vi.useFakeTimers();
    const { app, collector } = setup();
    app.getGPUInfo.mockRejectedValueOnce(new Error('private'));
    app.emit('gpu-info-update');
    await flush();
    app.getGPUInfo.mockImplementation(() => new Promise(() => {}));
    let settled: any;
    const retry = Promise.resolve(collector.get()).then((value) => { settled = value; });
    await flush();
    app.emit('gpu-info-update');
    await vi.advanceTimersByTimeAsync(101);
    expect(settled?.state).toBe('unavailable');
    expect(settled?.features.webgl).toBe('enabled');
    expect(app.getGPUInfo).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(101);
    await retry;
    expect(settled.state).toBe('unavailable');
    expect(JSON.stringify(settled)).not.toContain('private');
    collector.dispose();
  });
  it('keeps the last settled snapshot available during an event storm and hung refresh', async () => {
    vi.useFakeTimers();
    const { app, collector } = setup();
    app.emit('gpu-info-update');
    await flush();
    app.getGPUInfo.mockImplementation(() => new Promise(() => {}));
    for (let i = 0; i < 100; i++) app.emit('gpu-info-update');
    const refresh = collector.get();
    await flush();
    for (let i = 0; i < 100; i++) app.emit('gpu-info-update');
    const previous = await collector.get();
    expect(previous.state).toBe('ready');
    expect(previous.adapters[0].name).toBe('NVIDIA GPU');
    expect(app.getGPUInfo).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(101);
    expect((await refresh).state).toBe('unavailable');
    await vi.advanceTimersByTimeAsync(101);
    expect(app.getGPUInfo).toHaveBeenCalledTimes(3);
    collector.dispose();
  });
  it('wires the channel through guarded IPC and exposes the narrow preload method', () => {
    const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
    expect(main).toContain("ipcMain.handle('gpu-diagnostics', () => gpuCollector.get())");
    expect(main).not.toContain("rawIpcMain.handle('gpu-diagnostics'");
    expect(readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8')).toContain("gpuDiagnostics: () => ipcRenderer.invoke('gpu-diagnostics')");
  });
});
