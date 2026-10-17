import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { verifyPackedNotices } from '../scripts/check-ci-test-asar.mjs';

const require = createRequire(import.meta.url), asar = require('@electron/asar');
const repo = resolve(import.meta.dirname, '..');
const privateRoot = join(repo, '.codex-local', 'packaged-notice-tests');
const roots: string[] = [], names = ['LICENSE', 'THIRD-PARTY-NOTICES.md'];

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== privateRoot) throw new Error('Unsafe private notice-test cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});

async function archive(change?: { name: string; missing?: boolean; suffix?: string; prefix?: string }) {
  mkdirSync(privateRoot, { recursive: true });
  const root = mkdtempSync(join(privateRoot, 'case-')); roots.push(root);
  const source = join(root, 'source'); mkdirSync(source);
  for (const name of names) {
    if (name === change?.name && change.missing) continue;
    const bytes = readFileSync(join(repo, name));
    writeFileSync(join(source, name), name === change?.name
      ? Buffer.concat([Buffer.from(change.prefix ?? ''), bytes, Buffer.from(change.suffix ?? '')]) : bytes);
  }
  const file = join(root, 'app.asar');
  await finished(await asar.createPackage(source, file));
  return file;
}

describe('actual packaged project notices', () => {
  it('binds both exact source documents from a real ASAR to its proof', async () => {
    const file = await archive();
    expect(verifyPackedNotices(file, repo)).toEqual(names.map(name => {
      const bytes = readFileSync(join(repo, name));
      return { path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }));
  });
  it.each(names)('refuses an archive missing %s', async name => {
    const file = await archive({ name, missing: true });
    expect(() => verifyPackedNotices(file, repo)).toThrow();
  });
  it.each(names)('refuses stale or modified %s', async name => {
    const file = await archive({ name, suffix: '\nobsolete or changed notice\n' });
    expect(() => verifyPackedNotices(file, repo)).toThrow(/must match the source notice bytes/);
  });
  it.each(names)('refuses a BOM prepended to %s', async name => {
    const file = await archive({ name, prefix: '\uFEFF' });
    expect(() => verifyPackedNotices(file, repo)).toThrow(/must match the source notice bytes/);
  });
});
