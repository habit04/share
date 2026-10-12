import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, copyFileSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, matchesGlob } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { createRequire } from 'node:module';
import { assertFusePolicy, platformExecutables } from '../scripts/electron-fuse-policy.mjs';
import { expectedInstallers, expectedUpdateAssets, isReleaseAsset, writeBuildProvenance, verifyReleaseProvenance, signingSummary } from '../scripts/release-provenance.mjs';
const sha = 'a'.repeat(40);
const require = createRequire(import.meta.url);
const { getAppUpdatePublishConfiguration } = require('app-builder-lib/out/publish/PublishManager.js');
const { createUpdateInfoTasks, writeUpdateInfoFiles } = require('app-builder-lib/out/publish/updateInfoBuilder.js');
const { AppInfo } = require('app-builder-lib/out/appInfo.js');
const { Platform } = require('app-builder-lib');
const { Arch } = require('builder-util');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const shippingFuses = (platform: string) => platformExecutables(platform).map((path) => ({ path, policy:assertFusePolicy({ version:'1', 0:48, 2:48, 3:48, 4:49, 5:49, 7:48 }) }));
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
      writeFileSync(join(out, 'builder-debug.yml'), 'diagnostics, not a release asset');
      await writeBuildProvenance(out, platform, '0.4.1', sha, platform === 'macOS' ? 'ad-hoc' : 'unsigned', shippingFuses(platform));
    }
    await run(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
describe('release artifact provenance', () => {
  it('requires an explicit Windows-only policy and still rejects missing Windows outputs and unsigned publication', async () => prepared(async (dir) => {
    const options = { policy: 'windows-only' as const, requireSigning: true };
    await expect(verifyReleaseProvenance(dir, '0.4.1', sha, options)).rejects.toThrow(/unexpected platform/);
    rmSync(join(dir, 'macOS'), { recursive: true });
    rmSync(join(dir, 'Linux'), { recursive: true });
    await expect(verifyReleaseProvenance(dir, '0.4.1', sha)).rejects.toThrow(/missing platform provenance/);
    await expect(verifyReleaseProvenance(dir, '0.4.1', sha, options)).rejects.toThrow(/publisher signing is required/);
    const out = join(dir, 'Windows');
    await writeBuildProvenance(out, 'Windows', '0.4.1', sha, 'authenticode-verified', shippingFuses('Windows'));
    const aggregate = await verifyReleaseProvenance(dir, '0.4.1', sha, options);
    expect(aggregate.releasePolicy).toBe('windows-only');
    expect(aggregate.builds.map((record) => record.platform)).toEqual(['Windows']);
    writeFileSync(join(dir, 'latest-mac.yml'), 'unexpected feed');
    await expect(verifyReleaseProvenance(dir, '0.4.1', sha, options)).rejects.toThrow(/artifact has no provenance/);
    rmSync(join(dir, 'latest-mac.yml'));
    rmSync(join(out, expectedInstallers('0.4.1', 'Windows')[0]!));
    await expect(verifyReleaseProvenance(dir, '0.4.1', sha, options)).rejects.toThrow(/missing or duplicate artifact/);
  }));
  it('rejects unknown release policies', async () => prepared(async (dir) => {
    await expect(verifyReleaseProvenance(dir, '0.4.1', sha, { policy: 'auto' as never })).rejects.toThrow(/invalid release policy/);
  }));
  it('exports the same installer, feed and blockmap contract for callers without diagnostic YAML', () => {
    for (const platform of ['Windows', 'macOS', 'Linux']) expect(expectedUpdateAssets('0.4.1', platform)).toEqual(updateAssets[platform]);
    expect(isReleaseAsset('builder-debug.yml')).toBe(false);
    expect(isReleaseAsset('builder-effective-config.yaml')).toBe(false);
    expect(isReleaseAsset('latest-mac.yml')).toBe(true);
    expect(isReleaseAsset('jcad-electrical-0.4.1-mac-arm64.dmg.blockmap')).toBe(true);
  });
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
        await writeBuildProvenance(out, platform, version, sha, platform === 'macOS' ? 'ad-hoc' : 'unsigned', shippingFuses(platform));
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
    expect(readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8')).not.toContain('builder-debug');
  }));
  it('verifies the aggregate on a clean consumer with no npm dependencies', async () => prepared(async (dir) => {
    const consumer = join(dir, 'consumer'); mkdirSync(consumer);
    for (const name of ['release-provenance.mjs', 'electron-fuse-evidence.mjs']) copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(consumer, name));
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "const m = await import(process.argv[1]); await m.verifyReleaseProvenance(process.argv[2], '0.4.1', 'a'.repeat(40));", pathToFileURL(join(consumer, 'release-provenance.mjs')).href, dir], { cwd: consumer, encoding:'utf8', windowsHide:true, timeout:10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'release-provenance.json'), 'utf8')).sourceSha).toBe(sha);
  }));
  it('rejects linked directories before collecting release bytes', async () => prepared(async (dir) => {
    symlinkSync(join(dir, 'Windows'), join(dir, 'linked-output'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(verifyReleaseProvenance(dir, '0.4.1', sha)).rejects.toThrow(/symlink in release artifacts/);
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
      const record = await writeBuildProvenance(out, entry.platform, '0.4.1', sha, entry.platform === 'macOS' ? 'ad-hoc' : 'unsigned', shippingFuses(entry.platform));
      const patterns = entry.glob.trim().split(/\r?\n/).map((pattern) => pattern.trim());
      const uploaded = readdirSync(out).filter((name) => patterns.some((pattern) => matchesGlob(`release/${name}`, pattern)));
      const publicFiles = [...installers, ...updateAssets[entry.platform]!].sort();
      expect(record.artifacts.map((artifact) => artifact.name).sort()).toEqual(publicFiles);
      expect(uploaded.sort()).toEqual([...publicFiles, `JCad-Electrical-${entry.platform}-provenance.json`].sort());
      const destination = join(downloaded, entry.artifact); mkdirSync(destination);
      for (const name of uploaded) copyFileSync(join(out, name), join(destination, name));
    }
    const aggregate = await verifyReleaseProvenance(downloaded, '0.4.1', sha, { policy: 'windows-only' });
    expect(aggregate.builds.flatMap((build) => build.artifacts)).toHaveLength(3);
    // The Windows contract failed rehearsal omitted requires its external blockmap. A single omission fails.
    rmSync(join(downloaded, 'JCad-Electrical-Windows', 'jcad-electrical-0.4.1-win-x64.exe.blockmap'));
    await expect(verifyReleaseProvenance(downloaded, '0.4.1', sha)).rejects.toThrow(/missing or duplicate artifact: .*win-x64\.exe\.blockmap/);
  }));
  it.each(Object.entries(updateAssets).flatMap(([platform, names]) => names.map((name) => [platform, name])))('requires %s update asset %s before recording or verifying', async (platform, name) => prepared(async (dir) => {
    const out = join(dir, platform!);
    rmSync(join(out, name!));
    await expect(writeBuildProvenance(out, platform!, '0.4.1', sha, platform === 'macOS' ? 'ad-hoc' : 'unsigned', shippingFuses(platform!))).rejects.toThrow(/missing .* update asset/);
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
  it('rejects inspection-enabled or absent shipping fuse evidence in the aggregate', async () => prepared(async (dir) => {
    const file = join(dir, 'Windows/JCad-Electrical-Windows-provenance.json');
    const record = JSON.parse(readFileSync(file, 'utf8'));
    record.executableFuses[0].policy.EnableNodeCliInspectArguments = true;
    writeFileSync(file, JSON.stringify(record));
    await expect(verifyReleaseProvenance(dir, '0.4.1', sha)).rejects.toThrow(/Unsafe or test-build fuse evidence/);
    delete record.executableFuses; writeFileSync(file, JSON.stringify(record));
    await expect(verifyReleaseProvenance(dir, '0.4.1', sha)).rejects.toThrow(/Missing shipping executable fuse evidence/);
  }));
});
