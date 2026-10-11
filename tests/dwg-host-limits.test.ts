import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
type Host = { read(bytes: Uint8Array, id?: number): Promise<unknown>; cancel(id: number): boolean; dispose(): void };
const { createDwgHost } = require('../electron/dwg-host.cjs') as { createDwgHost(options: { scriptsDir: string; timeoutMs?: number; maxBytes?: number }): Host };
const root = mkdtempSync(join(tmpdir(), 'jcad-dwg-limits-'));
writeFileSync(join(root, 'dwg-worker.mjs'), "import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ready:true}); parentPort.on('message',()=>{});\n");
const hosts: Host[] = [];
const host = (options = {}) => { const h = createDwgHost({ scriptsDir: root, ...options }); hosts.push(h); return h; };
afterAll(() => {
  for (const h of hosts) h.dispose();
  if (!root.startsWith(join(tmpdir(), 'jcad-dwg-limits-'))) throw new Error('Unexpected temporary test folder');
  rmSync(root, { recursive: true, force: true });
});
describe('desktop DWG resource limits', () => {
  it('rejects oversized input before starting the worker', async () => {
    await expect(host({ maxBytes: 2 }).read(new Uint8Array(3))).rejects.toThrow(/size limit/);
  });
  it('terminates a worker that never completes its read', async () => {
    await expect(host({ timeoutMs: 500 }).read(new Uint8Array(1))).rejects.toThrow(/time limit/);
  });
  it('cancels a request during startup immediately and refuses duplicate request IDs', async () => {
    const h = host(), result = h.read(new Uint8Array(1), 12);
    const assertion = expect(result).rejects.toThrow('Open cancelled');
    await expect(h.read(new Uint8Array(1), 12)).rejects.toThrow(/request ID/);
    expect(h.cancel(12)).toBe(true);
    await assertion; expect(h.cancel(12)).toBe(false);
  });
  it('disposes an in-progress startup and rejects later reads', async () => {
    const h = host(), result = h.read(new Uint8Array(1));
    const assertion = expect(result).rejects.toThrow(/closed/);
    h.dispose(); await assertion;
    await expect(h.read(new Uint8Array(1))).rejects.toThrow(/closed/);
  });
  it('reports worker startup failure on successive reads without parsing on the main thread', async () => {
    const h = host({ scriptsDir: join(root, 'missing'), timeoutMs: 1000 });
    await expect(h.read(new Uint8Array(1))).rejects.toThrow();
    await expect(h.read(new Uint8Array(1))).rejects.toThrow();
  });
});
