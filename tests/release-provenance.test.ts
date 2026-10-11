/** Release provenance, ported from PR #2 (codex/electrical-review-fixes 2f89b0e). */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectedInstallers, expectedUpdateAssets, writeBuildProvenance, verifyReleaseProvenance, signingSummary } from '../scripts/release-provenance.mjs';
const sha = 'a'.repeat(40);
async function prepared(run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'jcad-provenance-'));
  try {
    for (const platform of ['Windows', 'macOS', 'Linux']) {
      const out = join(dir, platform); mkdirSync(out);
      for (const name of [...expectedInstallers('0.4.1', platform), ...expectedUpdateAssets('0.4.1', platform)]) writeFileSync(join(out, name), `installer ${name}`);
      writeFileSync(join(out, 'builder-debug.yml'), 'diagnostics, not a release asset');
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
    // 5 installers, 3 updater feeds, the NSIS and both DMG blockmaps; not builder-debug.yml.
    const sums = readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
    expect(sums).toHaveLength(11);
    expect(sums.some((line) => line.endsWith('  jcad-electrical-0.4.1-mac-arm64.dmg.blockmap'))).toBe(true);
    expect(sums.some((line) => line.includes('builder-debug'))).toBe(false);
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
  it('every recorded file must be uploaded: a DMG blockmap the build recorded but the upload left out fails', async () => prepared(async (dir) => {
    // What happened with the upload globs of the release after 0.4.1 (release/*.dmg only): the
    // build records the .dmg.blockmap files, the release job does not find them.
    rmSync(join(dir, 'macOS', 'jcad-electrical-0.4.1-mac-x64.dmg.blockmap'));
    await expect(verifyReleaseProvenance(dir, '0.4.1', sha)).rejects.toThrow(/missing or duplicate artifact: jcad-electrical-0\.4\.1-mac-x64\.dmg\.blockmap/);
  }));
  it('a build without its updater feed or a separate blockmap is refused before anything is recorded', async () => {
    const out = mkdtempSync(join(tmpdir(), 'jcad-provenance-'));
    try {
      for (const name of expectedInstallers('0.4.1', 'macOS')) writeFileSync(join(out, name), name);
      writeFileSync(join(out, 'latest-mac.yml'), 'version: 0.4.1');
      await expect(writeBuildProvenance(out, 'macOS', '0.4.1', sha, 'ad-hoc')).rejects.toThrow(/missing macOS update asset: jcad-electrical-0\.4\.1-mac-arm64\.dmg\.blockmap/);
      expect(expectedUpdateAssets('0.4.1', 'Linux')).toEqual(['latest-linux.yml']); // the AppImage embeds its blockmap
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
});
