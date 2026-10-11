/** Release provenance, ported from PR #2 (codex/electrical-review-fixes 2f89b0e). */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectedInstallers, writeBuildProvenance, verifyReleaseProvenance, signingSummary } from '../scripts/release-provenance.mjs';
const sha = 'a'.repeat(40);
async function prepared(run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'jcad-provenance-'));
  try {
    for (const platform of ['Windows', 'macOS', 'Linux']) {
      const out = join(dir, platform); mkdirSync(out);
      for (const name of expectedInstallers('0.4.1', platform)) writeFileSync(join(out, name), `installer ${name}`);
      await writeBuildProvenance(out, platform, '0.4.1', sha, platform === 'macOS' ? 'ad-hoc' : 'unsigned');
    }
    await run(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
describe('release artifact provenance', () => {
  it('verifies every expected platform and writes source-bound checksums', async () => prepared(async (dir) => {
    const record = await verifyReleaseProvenance(dir, '0.4.1', sha);
    expect(record.builds.map((build: { signing: string }) => build.signing)).toEqual(['unsigned', 'ad-hoc', 'unsigned']);
    expect(signingSummary(record)).toContain('Windows: unsigned.');
    expect(signingSummary(record)).toContain('macOS: ad-hoc signature verified; no publisher identity or notarization.');
    expect(readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8').trim().split('\n')).toHaveLength(5);
  }));
  it('rejects a moved source commit, changed artifact bytes and missing platform output', async () => prepared(async (dir) => {
    await expect(verifyReleaseProvenance(dir, '0.4.1', 'b'.repeat(40))).rejects.toThrow(/tested source/);
    writeFileSync(join(dir, 'Windows', expectedInstallers('0.4.1', 'Windows')[0]!), 'tampered');
    await expect(verifyReleaseProvenance(dir, '0.4.1', sha)).rejects.toThrow(/checksum mismatch/);
    rmSync(join(dir, 'Windows'), { recursive: true });
    await expect(verifyReleaseProvenance(dir, '0.4.1', sha)).rejects.toThrow(/missing platform provenance/);
  }));
  it('rejects mismatched versions and extra untracked installers', async () => prepared(async (dir) => {
    await expect(verifyReleaseProvenance(dir, '0.5.0', sha)).rejects.toThrow(/tested source/);
    writeFileSync(join(dir, 'Linux', 'unexpected.deb'), 'extra');
    await expect(verifyReleaseProvenance(dir, '0.4.1', sha)).rejects.toThrow(/no provenance/);
  }));
  it('rejects an extra installer even if its bytes were added to a platform record', async () => prepared(async (dir) => {
    const file = join(dir, 'Linux/JCad-Electrical-Linux-provenance.json');
    const record = JSON.parse(readFileSync(file, 'utf8'));
    record.artifacts.push({ ...record.artifacts[0], name: 'unexpected.deb' });
    writeFileSync(file, JSON.stringify(record));
    await expect(verifyReleaseProvenance(dir, '0.4.1', sha)).rejects.toThrow(/unexpected Linux installer/);
  }));
});
