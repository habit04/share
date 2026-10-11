import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, matchesGlob } from 'node:path';
import yaml from 'js-yaml';
import { createRequire } from 'node:module';
import { expectedInstallers, writeBuildProvenance, verifyReleaseProvenance, signingSummary } from '../scripts/release-provenance.mjs';
const sha = 'a'.repeat(40);
const require = createRequire(import.meta.url);
const { getAppUpdatePublishConfiguration } = require('app-builder-lib/out/publish/PublishManager.js');
const { createUpdateInfoTasks, writeUpdateInfoFiles } = require('app-builder-lib/out/publish/updateInfoBuilder.js');
const { AppInfo } = require('app-builder-lib/out/appInfo.js');
const { Platform } = require('app-builder-lib');
const { Arch } = require('builder-util');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const updateAssets: Record<string, string[]> = {
  Windows: ['latest.yml', 'jcad-electrical-0.4.1-win-x64.exe.blockmap'],
  macOS: ['latest-mac.yml', 'jcad-electrical-0.4.1-mac-arm64.dmg.blockmap', 'jcad-electrical-0.4.1-mac-x64.dmg.blockmap'],
  Linux: ['latest-linux.yml'],
};
async function prepared(run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'jcad-provenance-'));
  try {
    for (const platform of ['Windows', 'macOS', 'Linux']) {
      const out = join(dir, platform); mkdirSync(out);
      for (const name of expectedInstallers('0.4.1', platform)) writeFileSync(join(out, name), `installer ${name}`);
      for (const name of updateAssets[platform]!) writeFileSync(join(out, name), `update ${name}`);
      await writeBuildProvenance(out, platform, '0.4.1', sha, platform === 'macOS' ? 'ad-hoc' : 'unsigned');
    }
    await run(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
describe('release artifact provenance', () => {
  it.each(['0.4.1', '0.4.2-alpha.1', '0.4.2-beta.1'])('accepts the installed builder GitHub updater feeds for %s', async (version) => {
    const dir = mkdtempSync(join(tmpdir(), 'jcad-builder-updates-'));
    try {
      for (const [platform, builderPlatform] of [['Windows', Platform.WINDOWS], ['macOS', Platform.MAC], ['Linux', Platform.LINUX]]) {
        const out = join(dir, platform); mkdirSync(out);
        const info = { metadata: { ...pkg, version }, config: pkg.build };
        const appInfo = new AppInfo(info);
        const packager = {
          platform: builderPlatform,
          platformSpecificBuildOptions: pkg.build[builderPlatform.buildConfigurationKey],
          config: pkg.build,
          info: { ...info, appInfo },
          appInfo,
          expandMacro: (value: string) => value,
          getResource: async () => null,
          emitArtifactCreated: async () => undefined,
        };
        // Resolve the actual configured GitHub provider, without network, signing or packaging.
        const publishConfig = await getAppUpdatePublishConfiguration(packager, null, Arch.x64, false);
        expect(publishConfig.provider).toBe('github');
        const tasks = [];
        for (const name of expectedInstallers(version, platform)) {
          const file = join(out, name); writeFileSync(file, `installer ${name}`);
          if (platform !== 'Linux') writeFileSync(`${file}.blockmap`, `blockmap ${name}`);
          tasks.push(...await createUpdateInfoTasks({ packager, target: { outDir: out }, file, arch: name.includes('arm64') ? Arch.arm64 : Arch.x64 }, [publishConfig]));
        }
        await writeUpdateInfoFiles(tasks, packager);
        const feed = platform === 'Windows' ? 'latest.yml' : platform === 'macOS' ? 'latest-mac.yml' : 'latest-linux.yml';
        const metadata = yaml.load(readFileSync(join(out, feed), 'utf8')) as { version: string; files: { url: string }[] };
        expect(metadata.version).toBe(version);
        expect(metadata.files.map((file) => file.url).sort()).toEqual(expectedInstallers(version, platform).sort());
        await writeBuildProvenance(out, platform, version, sha, platform === 'macOS' ? 'ad-hoc' : 'unsigned');
      }
      await expect(verifyReleaseProvenance(dir, version, sha)).resolves.toMatchObject({ version, sourceSha: sha });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('verifies every expected platform and writes source-bound checksums', async () => prepared(async (dir) => {
    const record = await verifyReleaseProvenance(dir, '0.4.1', sha);
    expect(record.builds.map((build: { signing: string }) => build.signing)).toEqual(['unsigned', 'ad-hoc', 'unsigned']);
    expect(signingSummary(record)).toContain('Windows: unsigned.');
    expect(signingSummary(record)).toContain('macOS: ad-hoc signature verified; no publisher identity or notarization.');
    expect(readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8').trim().split('\n')).toHaveLength(11);
  }));
  it('keeps emitted provenance identical to the real workflow public upload contract', async () => prepared(async (dir) => {
    const workflow = yaml.load(readFileSync(join(import.meta.dirname, '../.github/workflows/release.yml'), 'utf8')) as {
      jobs: { build: { strategy: { matrix: { include: { platform: string; artifact: string; glob: string }[] } } } };
    };
    const downloaded = join(dir, 'downloaded'); mkdirSync(downloaded);
    for (const entry of workflow.jobs.build.strategy.matrix.include) {
      const out = join(dir, entry.platform);
      writeFileSync(join(out, 'builder-debug.yml'), 'diagnostic: true\n');
      writeFileSync(join(out, 'builder-effective-config.yaml'), 'effectiveConfig: true\n');
      const feed = updateAssets[entry.platform]!.find((name) => name.endsWith('.yml'))!;
      const installers = expectedInstallers('0.4.1', entry.platform);
      writeFileSync(join(out, feed), yaml.dump({ version: '0.4.1', files: installers.map((url) => ({ url, size: readFileSync(join(out, url)).length })), path: installers[0] }));
      const record = await writeBuildProvenance(out, entry.platform, '0.4.1', sha, entry.platform === 'macOS' ? 'ad-hoc' : 'unsigned');
      const patterns = entry.glob.trim().split(/\r?\n/).map((pattern) => pattern.trim());
      const uploaded = readdirSync(out).filter((name) => patterns.some((pattern) => matchesGlob(`release/${name}`, pattern)));
      const publicFiles = [...installers, ...updateAssets[entry.platform]!].sort();
      expect(record.artifacts.map((artifact) => artifact.name).sort()).toEqual(publicFiles);
      expect(uploaded.sort()).toEqual([...publicFiles, `JCad-Electrical-${entry.platform}-provenance.json`].sort());
      const destination = join(downloaded, entry.artifact); mkdirSync(destination);
      for (const name of uploaded) copyFileSync(join(out, name), join(destination, name));
    }
    const aggregate = await verifyReleaseProvenance(downloaded, '0.4.1', sha);
    expect(aggregate.builds.flatMap((build) => build.artifacts)).toHaveLength(11);
    // The actual failed rehearsal omitted both DMG blockmaps from upload. A single omission fails.
    rmSync(join(downloaded, 'JCad-Electrical-macOS', 'jcad-electrical-0.4.1-mac-arm64.dmg.blockmap'));
    await expect(verifyReleaseProvenance(downloaded, '0.4.1', sha)).rejects.toThrow(/missing or duplicate artifact: .*mac-arm64\.dmg\.blockmap/);
  }));
  it.each(Object.entries(updateAssets).flatMap(([platform, names]) => names.map((name) => [platform, name])))('requires %s update asset %s before recording or verifying', async (platform, name) => prepared(async (dir) => {
    const out = join(dir, platform!);
    rmSync(join(out, name!));
    await expect(writeBuildProvenance(out, platform!, '0.4.1', sha, platform === 'macOS' ? 'ad-hoc' : 'unsigned')).rejects.toThrow(/missing .* update asset/);
    // Even a record deliberately edited to omit the missing output cannot claim a complete release.
    const manifest = join(out, `JCad-Electrical-${platform}-provenance.json`);
    const record = JSON.parse(readFileSync(manifest, 'utf8'));
    record.artifacts = record.artifacts.filter((artifact: { name: string }) => artifact.name !== name);
    writeFileSync(manifest, JSON.stringify(record));
    await expect(verifyReleaseProvenance(dir, '0.4.1', sha)).rejects.toThrow(/missing .* update asset/);
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
