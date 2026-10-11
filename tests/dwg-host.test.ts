import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error plain JS helper shared with Electron main / CLI
import { readDwgPayload } from '../scripts/dwg-reader.mjs';

// electron/dwg-host.cjs: the DWG reader in a worker thread (scripts/dwg-worker.mjs) must give the
// main process exactly what the in-process reader gives, Cancel must stop a read (also one whose
// worker is still starting) and leave the host usable, and a bad file must fail with a message.

const require = createRequire(import.meta.url);
const { createDwgHost, OpenCancelledError } = require('../electron/dwg-host.cjs') as {
  createDwgHost: (o: { scriptsDir: string }) => {
    read(bytes: Uint8Array, id?: number): Promise<{ payload: { entities: unknown[]; blocks: unknown[] }; version: string }>;
    cancel(id: number): boolean;
    dispose(): void;
    newId(): number;
    readonly usesWorker: boolean;
  };
  OpenCancelledError: new () => Error;
};

const scriptsDir = join(import.meta.dirname, '..', 'scripts');
const fixture = join(import.meta.dirname, '..', 'fixtures', 'example_2000.dwg');
const hosts: Array<{ dispose(): void }> = [];
const host = (delayMs = 0) => {
  process.env.JCAD_DWG_TEST_DELAY_MS = String(delayMs);
  const h = createDwgHost({ scriptsDir });
  hosts.push(h);
  return h;
};
afterAll(() => {
  delete process.env.JCAD_DWG_TEST_DELAY_MS;
  for (const h of hosts) h.dispose();
});

describe.skipIf(!existsSync(fixture))('DWG worker host (electron/dwg-host.cjs)', () => {
  it('the worker returns the same payload as the in-process reader', async () => {
    const bytes = new Uint8Array(readFileSync(fixture));
    const h = host();
    const viaWorker = await h.read(bytes);
    expect(h.usesWorker).toBe(true);
    const direct = await readDwgPayload(bytes, 'dwg');
    expect(viaWorker.version).toBe(direct.version);
    expect(viaWorker.payload.entities.length).toBeGreaterThan(10);
    // LibreDWG fills the group codes of unreadable XDATA from uninitialised memory, so they can
    // differ between two module instances (worker and main process); everything else is identical.
    const withoutXdata = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(withoutXdata);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'xdata').map(([k, x]) => [k, withoutXdata(x)]));
      return v;
    };
    const xdataShape = (v: unknown): string => JSON.stringify(v, (k, x) => (k === 'xdata' && Array.isArray(x) ? x.length : x));
    expect(JSON.stringify(withoutXdata(viaWorker.payload))).toBe(JSON.stringify(withoutXdata(direct.payload)));
    expect(xdataShape(viaWorker.payload)).toBe(xdataShape(direct.payload));
    // The caller's buffer is untouched (the worker gets a copy).
    expect(bytes.length).toBe(readFileSync(fixture).length);
  }, 120_000);

  it('cancel() during the read rejects with OpenCancelledError and the next read works', async () => {
    const bytes = new Uint8Array(readFileSync(fixture));
    const h = host(1500);
    const id = h.newId();
    const p = h.read(bytes, id);
    // The worker is still starting here: the cancel must still take effect.
    expect(h.cancel(id)).toBe(true);
    await expect(p).rejects.toBeInstanceOf(OpenCancelledError);
    expect(h.cancel(id)).toBe(false);
    // Cancel while the worker is parsing (it is up now, every read is held 1.5 s).
    const id2 = h.newId();
    const p2 = h.read(bytes, id2);
    await new Promise((r) => setTimeout(r, 300));
    expect(h.cancel(id2)).toBe(true);
    await expect(p2).rejects.toThrow('Open cancelled');
    // A fresh worker reads the next file (no delay this time).
    process.env.JCAD_DWG_TEST_DELAY_MS = '0';
    const r = await h.read(bytes);
    expect(r.payload.entities.length).toBeGreaterThan(10);
  }, 120_000);

  it('a file that is not a DWG does not break the host: it fails with a message or comes back empty ("invalid"), and the next read works', async () => {
    const h = host();
    // LibreDWG reports garbage as version "invalid" with no entities rather than failing
    // (scripts/dwg-reader.mjs); either way the worker must stay usable afterwards.
    const r0 = await h.read(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])).then(
      (r) => `ok:${r.version}:${r.payload.entities.length}`,
      (e: Error) => `error:${e.message}`,
    );
    expect(r0).toMatch(/^(ok:invalid:0|error:.+)$/);
    const r = await h.read(new Uint8Array(readFileSync(fixture)));
    expect(r.payload.entities.length).toBeGreaterThan(10);
  }, 120_000);
});
