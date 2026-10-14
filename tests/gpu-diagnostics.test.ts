import { describe, expect, it, vi } from 'vitest';
import { collectGpuDiagnostics, emptyGpuDiagnostics, gpuDiagnosticsLines } from '../src/app/gpu-diagnostics';
import { issueUrl, reportText, type ReportInput } from '../src/app/diagnostics';

describe('GPU diagnostic summary', () => {
  it('keeps the collector partial response after its two bounded collection windows', async () => {
    vi.useFakeTimers();
    try {
      const partial = emptyGpuDiagnostics('unavailable');
      partial.hardwareAcceleration = true;
      partial.features = { '2d_canvas': 'enabled' };
      const result = collectGpuDiagnostics({ gpuDiagnostics: () => new Promise((resolve) => setTimeout(() => resolve(partial), 10000)) });
      await vi.advanceTimersByTimeAsync(10001);
      expect(await result).toBe(partial);
    } finally { vi.useRealTimers(); }
  });
  it('distinguishes the renderer from Chromium and preserves unknowns', () => {
    const text = gpuDiagnosticsLines(emptyGpuDiagnostics()).join('\n');
    expect(text).toContain('JCad renderer: Canvas 2D');
    expect(text).toContain('do not establish which GPU JCad uses');
    expect(text).toContain('enabled: Unknown');
    expect(text).toContain('Adapters: Unknown');
    expect(text).toContain('Pending (retry available)');
    expect(text).toContain('Canvas rendering (Chromium): Unknown');
    expect(text).toContain('Compositing (Chromium): Unknown');
    expect(text).not.toContain('Chromium driver:');
  });

  it('formats multiple adapters, explicit false and only known Chromium features', () => {
    const d = emptyGpuDiagnostics('ready', '0.4.8');
    d.hardwareAcceleration = false;
    d.adapters = [true, false, null].map((active) => ({ name: 'Adapter', vendorId: '0x1234', deviceId: '0x5678', active, driverVendor: 'Vendor', driverVersion: '1.2' }));
    d.features = { webgl: 'enabled', webgpu: 'disabled_software', arbitraryPrivateField: 'secret' };
    const text = gpuDiagnosticsLines(d).join('\n');
    expect(text).toContain('enabled: No');
    for (const flag of ['Yes', 'No', 'Unknown']) expect(text).toContain(`active (Chromium): ${flag}`);
    expect(text).toContain('webgl=enabled; webgpu=disabled_software');
    expect(text).not.toContain('secret');
  });

  it('includes identical safe summary lines in reports and GitHub diagnostics even with private details enabled', () => {
    const d = { ...emptyGpuDiagnostics('ready'), fallback: 'Driver at C:\\Users\\private-user\\driver.dll', reasons: ['See /home/private-user/gpu.log'], rawInfo: { machineName: 'secret-machine' } };
    const lines = gpuDiagnosticsLines(d);
    const input: ReportInput = { title: '', happened: 'Problem', expected: '', steps: '', version: '1', platform: 'win32', arch: 'x64', history: [], errors: [], extra: lines, includePrivateDetails: true };
    const report = reportText(input);
    const issue = new URL(issueUrl(input)).searchParams.get('diagnostics')!;
    for (const line of lines) { expect(report).toContain(line); expect(issue).toContain(line); }
    for (const secret of ['private-user', 'secret-machine', 'rawInfo']) { expect(report).not.toContain(secret); expect(issue).not.toContain(secret); }
  });

  it('handles missing, rejecting and incompatible bridges without exposing errors', async () => {
    expect((await collectGpuDiagnostics()).state).toBe('unavailable');
    expect((await collectGpuDiagnostics({ gpuDiagnostics: () => Promise.reject(new Error('private path')) })).state).toBe('unavailable');
    expect((await collectGpuDiagnostics({ gpuDiagnostics: async () => null as never })).state).toBe('unavailable');
  });

  it('labels Canvas/compositing raw statuses and an optional global driver separately', () => {
    const d = emptyGpuDiagnostics('ready');
    d.features = { '2d_canvas': 'enabled', gpu_compositing: 'disabled_software' };
    d.driver = { vendor: 'Global vendor', version: '3.4' };
    const text = gpuDiagnosticsLines(d).join('\n');
    expect(text).toContain('Canvas rendering (Chromium): enabled');
    expect(text).toContain('Compositing (Chromium): disabled_software');
    expect(text).toContain('Chromium driver: Global vendor 3.4');
    expect(text).toContain('Adapters: Unknown');
  });

  it('rejects malformed versions/features and optional driver objects', async () => {
    for (const key of ['versions', 'features', 'driver']) {
      for (const invalid of ['invalid', [], 1, null, new Date()]) {
        const d = { ...emptyGpuDiagnostics('ready'), [key]: invalid };
        expect((await collectGpuDiagnostics({ gpuDiagnostics: async () => d as never })).state).toBe('unavailable');
      }
    }
  });

  it('bounds a stalled request and supports a later retry', async () => {
    expect((await collectGpuDiagnostics({ gpuDiagnostics: () => new Promise(() => {}) }, '', 5)).state).toBe('pending');
    const ready = emptyGpuDiagnostics('ready');
    expect(await collectGpuDiagnostics({ gpuDiagnostics: async () => ready })).toBe(ready);
  });
});
