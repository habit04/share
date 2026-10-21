import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import type { FontMetricsRequest } from '../src/core/text-metrics';

const require = createRequire(import.meta.url);
type Host = {
  read(request: unknown): Promise<unknown>;
  readPdf(request: unknown): Promise<unknown>;
  admittedPreviewPrint(request: unknown): boolean;
  dispose(): Promise<void>;
};
const { createFontMetricsHost, fontRequest } = require('../electron/font-metrics-host.cjs') as {
  createFontMetricsHost(options?: { workerFactory?: (request: FontMetricsRequest & { usage?: string; restricted?: boolean }) => FakeWorker; timeoutMs?: number }): Host;
  fontRequest(request: unknown): FontMetricsRequest & { restricted?: boolean };
};

class FakeWorker extends EventEmitter {
  stopped = false;
  constructor(readonly request: FontMetricsRequest & { usage?: string; restricted?: boolean }) { super(); }
  async terminate(): Promise<number> { this.stopped = true; this.emit('exit', 0); return 0; }
}

const hosts: Host[] = [];
function fixture() {
  const created: FakeWorker[] = [];
  const factory = vi.fn((request: FontMetricsRequest & { usage?: string; restricted?: boolean }) => {
    const worker = new FakeWorker(request);
    created.push(worker);
    return worker;
  });
  const host = createFontMetricsHost({ workerFactory: factory, timeoutMs: 5_000 }) as Host;
  hosts.push(host);
  return { host, created };
}
afterEach(async () => { await Promise.allSettled(hosts.splice(0).map((host) => host.dispose())); });

const face = (previewPrint: boolean) => ({ bytes: new Uint8Array([1, 2, 3]), metrics: { family: 'JCad Fixture' }, postscriptName: 'JCadFixture', ...(previewPrint ? { previewPrint: true } : {}) });

describe('restricted flag plumbing (12.4)', () => {
  it('fontRequest carries an explicit restricted=true and drops false/absent', () => {
    expect(fontRequest({ font: 'fixture.ttf', restricted: true })).toEqual({ font: 'fixture.ttf', restricted: true });
    expect(fontRequest({ font: 'fixture.ttf', restricted: false })).toEqual({ font: 'fixture.ttf' });
    expect(fontRequest({ font: 'fixture.ttf' })).toEqual({ font: 'fixture.ttf' });
  });

  it('fontRequest rejects a non-boolean restricted value before launch', async () => {
    const f = fixture();
    expect(() => fontRequest({ font: 'fixture.ttf', restricted: 'yes' })).toThrow(/Invalid font/);
    await expect(f.host.readPdf({ font: 'fixture.ttf', restricted: 1 })).rejects.toThrow(/Invalid font/);
    expect(f.created).toHaveLength(0);
  });

  it('readPdf forwards usage and the restricted flag to the worker request', async () => {
    const f = fixture();
    const pending = f.host.readPdf({ font: 'fixture.ttf', family: 'JCad Fixture', restricted: true });
    expect(f.created[0]!.request).toEqual({ font: 'fixture.ttf', family: 'JCad Fixture', restricted: true, usage: 'pdf' });
    f.created[0]!.emit('message', { metrics: face(true) });
    await expect(pending).resolves.toEqual(face(true));
  });
});

describe('main-side preview/print admission records (12.4)', () => {
  it('records only faces the host itself admitted as preview/print under a restricted pdf read', async () => {
    const f = fixture();
    expect(f.host.admittedPreviewPrint({ font: 'fixture.ttf', family: 'JCad Fixture' })).toBe(false);
    const pending = f.host.readPdf({ font: 'fixture.ttf', family: 'JCad Fixture', restricted: true });
    f.created[0]!.emit('message', { metrics: face(true) });
    await pending;
    // The registration claim carries the plain request identity (no mode flag).
    expect(f.host.admittedPreviewPrint({ font: 'fixture.ttf', family: 'JCad Fixture' })).toBe(true);
    expect(f.host.admittedPreviewPrint({ family: 'JCad Fixture', font: 'fixture.ttf' })).toBe(true);
    // A different face identity is not covered by the record.
    expect(f.host.admittedPreviewPrint({ font: 'fixture.ttf', family: 'JCad Fixture', bold: true })).toBe(false);
    expect(f.host.admittedPreviewPrint({ font: 'other.ttf', family: 'JCad Fixture' })).toBe(false);
  });

  it('does not record when the read was not restricted, even if a result claims the flag', async () => {
    const f = fixture();
    const pending = f.host.readPdf({ font: 'fixture.ttf', family: 'JCad Fixture' });
    f.created[0]!.emit('message', { metrics: face(true) });
    await pending;
    expect(f.host.admittedPreviewPrint({ font: 'fixture.ttf', family: 'JCad Fixture' })).toBe(false);
  });

  it('does not record an ordinary (non-flagged) restricted admission', async () => {
    const f = fixture();
    const pending = f.host.readPdf({ font: 'fixture.ttf', family: 'JCad Fixture', restricted: true });
    f.created[0]!.emit('message', { metrics: face(false) });
    await pending;
    expect(f.host.admittedPreviewPrint({ font: 'fixture.ttf', family: 'JCad Fixture' })).toBe(false);
  });

  it('metrics (non-pdf) reads never record', async () => {
    const f = fixture();
    const pending = f.host.read({ font: 'fixture.ttf', family: 'JCad Fixture', restricted: true });
    f.created[0]!.emit('message', { metrics: face(true) });
    await pending;
    expect(f.host.admittedPreviewPrint({ font: 'fixture.ttf', family: 'JCad Fixture' })).toBe(false);
  });
});
