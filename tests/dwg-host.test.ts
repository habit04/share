import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error plain JS helper shared with Electron main / CLI
import { readDwgPayload } from '../scripts/dwg-reader.mjs';
import { createDwgHost, OpenCancelledError, launchNodeProcess, unitMemoryGuard, stopNodeChildren,
  type DwgHost, type DwgHostOptions } from './helpers/dwg-process';

const scriptsDir = join(import.meta.dirname, '..', 'scripts');
const fixture = join(import.meta.dirname, '..', 'fixtures', 'example_2000.dwg');
const hosts: DwgHost[] = [];
function host(options: Partial<DwgHostOptions> = {}) {
  const h = createDwgHost({ scriptsDir, launchProcess: launchNodeProcess,
    memoryGuardFactory: unitMemoryGuard, allowTestHooks: true, ...options });
  hosts.push(h);
  return h;
}
afterEach(async () => {
  delete process.env.JCAD_DWG_TEST_DELAY_MS;
  for (const h of hosts.splice(0)) h.dispose();
  await stopNodeChildren();
});

describe('DWG process host (electron/dwg-host.cjs)', () => {
  it('returns the same payload as the capped reader and preserves every byte of the caller buffer', async () => {
    const original = new Uint8Array(readFileSync(fixture));
    const backing = new Uint8Array(original.byteLength + 16).fill(0xa5);
    const bytes = backing.subarray(8, backing.length - 8);
    bytes.set(original);
    const before = backing.slice();
    const h = host();
    const viaProcess = await h.read(bytes);
    expect(h.usesProcess).toBe(true);
    expect(h.usesWorker).toBe(true);
    const direct = await readDwgPayload(bytes, 'dwg');
    expect(viaProcess.version).toBe(direct.version);
    expect(viaProcess.payload.entities.length).toBeGreaterThan(10);
    // LibreDWG may fill unreadable XDATA group codes from uninitialised memory. Its array
    // shapes and the remaining drawing data must match across independent native instances.
    const withoutXdata = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(withoutXdata);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'xdata').map(([k, x]) => [k, withoutXdata(x)]));
      return v;
    };
    const xdataShape = (v: unknown): string => JSON.stringify(v, (k, x) => (k === 'xdata' && Array.isArray(x) ? x.length : x));
    expect(withoutXdata(viaProcess.payload)).toEqual(withoutXdata(direct.payload));
    expect(xdataShape(viaProcess.payload)).toBe(xdataShape(direct.payload));
    expect(backing).toEqual(before);
  }, 120_000);

  it('cancels both a starting process and a delayed read, then opens the next drawing', async () => {
    process.env.JCAD_DWG_TEST_DELAY_MS = '1500';
    const sentByProcess: any[][] = [];
    const h = host({ launchProcess: (entry, options) => {
      const child = launchNodeProcess(entry, options);
      const sent: any[] = [];
      sentByProcess.push(sent);
      child.on('sent', (message) => sent.push(message));
      return child;
    } });
    const bytes = new Uint8Array(readFileSync(fixture));
    const id = h.newId();
    const starting = h.read(bytes, id);
    expect(h.cancel(id)).toBe(true);
    await expect(starting).rejects.toBeInstanceOf(OpenCancelledError);
    expect(h.cancel(id)).toBe(false);

    const id2 = h.newId();
    const parsing = h.read(bytes, id2);
    // The real controller has acknowledged all input before it starts its inner parser.
    await vi.waitFor(() => expect(sentByProcess[1]?.some((message) => message.type === 'input-end')).toBe(true), { timeout: 15_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.cancel(id2)).toBe(true);
    await expect(parsing).rejects.toBeInstanceOf(OpenCancelledError);
    process.env.JCAD_DWG_TEST_DELAY_MS = '0';
    const recovered = await h.read(bytes);
    expect(recovered.payload.entities.length).toBeGreaterThan(10);
    expect(sentByProcess).toHaveLength(3);
  }, 120_000);

  it('rejects damaged native input with a message and reads a valid drawing in a fresh process', async () => {
    const h = host();
    await expect(h.read(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).rejects.toThrow(/LibreDWG|native|corrupt|damaged/i);
    const recovered = await h.read(new Uint8Array(readFileSync(fixture)));
    expect(recovered.payload.entities.length).toBeGreaterThan(10);
  }, 120_000);
});
