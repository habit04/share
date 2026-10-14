import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
async function cleanupOwnedDirectory(parent: string, directory: string) {
  if (path.dirname(path.resolve(directory)) !== parent ||
      !path.basename(directory).startsWith('jcad-time-context-suite-') ||
      await realpath(directory) !== directory) throw new Error('Refused unsafe time-context suite cleanup');
  await rm(directory, { recursive: true, force: true });
}

it('checks source time contexts with actual isolated Node controller/worker probes (parser and monitor doubles)', async () => {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(parent, 'jcad-time-context-suite-'));
  const script = path.resolve(import.meta.dirname, '../scripts/dwg-time-context.test.cjs');
  try {
    const { stdout } = await execute(process.execPath, ['--test', script], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, TMP: directory, TEMP: directory },
      timeout: 45_000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    expect(stdout).toMatch(/(?:# |ℹ )tests 12\b/);
    expect(stdout).toMatch(/(?:# |ℹ )pass 12\b/);
    expect(stdout).toMatch(/(?:# |ℹ )fail 0\b/);
    expect(stdout).toContain('JCAD_TIME_CONTEXT_OWNED_CHILDREN_CLOSED=0');
  } finally {
    await cleanupOwnedDirectory(parent, directory);
  }
}, 60_000);
