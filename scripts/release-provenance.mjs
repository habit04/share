// Bind each platform's actual output bytes to the checked commit before publication.
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync, lstatSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PLATFORMS = ['Windows', 'macOS', 'Linux'];
const SIGNING = { Windows: ['unsigned', 'authenticode-verified'], macOS: ['ad-hoc', 'developer-id-notarized'], Linux: ['unsigned'] };
const ASSET = /\.(?:exe|dmg|AppImage|deb|blockmap)$/;
// Match the public upload contract: builder-debug.yml and builder-effective-config.yaml
// are diagnostics; only updater feeds (latest*.yml) accompany the installers/blockmaps.
const isReleaseAsset = (file) => ASSET.test(basename(file)) || /^latest.*\.yml$/.test(basename(file));
export function expectedInstallers(version, platform) {
  const prefix = `jcad-electrical-${version}-`;
  return { Windows: [`${prefix}win-x64.exe`], macOS: [`${prefix}mac-arm64.dmg`, `${prefix}mac-x64.dmg`], Linux: [`${prefix}linux-x86_64.AppImage`, `${prefix}linux-amd64.deb`] }[platform];
}
function expectedUpdateAssets(version, platform) {
  // This repository uses GitHub without a channel override. The installed builder keeps
  // latest for that provider even when the application version has an alpha/beta suffix;
  // tests exercise its actual publish configuration and generated feeds for those versions.
  const feeds = { Windows: 'latest.yml', macOS: 'latest-mac.yml', Linux: 'latest-linux.yml' };
  // NSIS and DMG targets emit separate blockmaps. AppImage embeds its blockmap.
  const blockmaps = platform === 'Linux' ? [] : expectedInstallers(version, platform).map((name) => `${name}.blockmap`);
  return [feeds[platform], ...blockmaps];
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function validateIdentity(platform, version, sha, signing) {
  if (!PLATFORMS.includes(platform) || !SIGNING[platform].includes(signing)) throw new Error(`invalid platform/signing status: ${platform}/${signing}`);
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('invalid release version or source SHA');
}
export async function writeBuildProvenance(dir, platform, version, sha, signing) {
  validateIdentity(platform, version, sha, signing);
  const names = readdirSync(dir).filter(isReleaseAsset).sort();
  const expected = expectedInstallers(version, platform);
  for (const name of expected) if (!names.includes(name)) throw new Error(`missing ${platform} installer: ${name}`);
  for (const name of expectedUpdateAssets(version, platform)) if (!names.includes(name)) throw new Error(`missing ${platform} update asset: ${name}`);
  for (const name of names.filter((name) => /\.(?:exe|dmg|AppImage|deb)$/.test(name))) if (!expected.includes(name)) throw new Error(`unexpected installer: ${name}`);
  const artifacts = [];
  for (const name of names) {
    const file = join(dir, name);
    const info = lstatSync(file);
    if (!info.isFile() || info.size === 0) throw new Error(`empty or non-file artifact: ${name}`);
    artifacts.push({ name, bytes: info.size, sha256: await digest(file) });
  }
  const record = { schemaVersion: 1, platform, version, sourceSha: sha, signing, artifacts };
  writeFileSync(join(dir, `JCad-Electrical-${platform}-provenance.json`), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const file = join(dir, name);
    const info = lstatSync(file);
    if (info.isSymbolicLink()) throw new Error(`symlink in release artifacts: ${file}`);
    return info.isDirectory() ? walk(file) : [file];
  });
}
export async function verifyReleaseProvenance(dir, version, sha) {
  const files = walk(dir);
  const manifests = files.filter((file) => /^JCad-Electrical-(?:Windows|macOS|Linux)-provenance\.json$/.test(basename(file)));
  const records = []; const seen = new Set(); const covered = new Set();
  for (const file of manifests) {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    validateIdentity(record.platform, record.version, record.sourceSha, record.signing);
    if (record.schemaVersion !== 1 || record.version !== version || record.sourceSha !== sha) throw new Error(`provenance does not match tested source/version: ${file}`);
    if (basename(file) !== `JCad-Electrical-${record.platform}-provenance.json`) throw new Error('platform provenance filename does not match its record');
    if (seen.has(record.platform)) throw new Error(`duplicate platform provenance: ${record.platform}`);
    seen.add(record.platform);
    if (!Array.isArray(record.artifacts) || !record.artifacts.length) throw new Error(`empty provenance artifacts: ${file}`);
    const names = new Set();
    for (const artifact of record.artifacts) {
      if (typeof artifact.name !== 'string' || basename(artifact.name) !== artifact.name || !isReleaseAsset(artifact.name) || names.has(artifact.name)) throw new Error('invalid or duplicate artifact name');
      names.add(artifact.name);
      if (/\.(?:exe|dmg|AppImage|deb)$/.test(artifact.name) && !expectedInstallers(version, record.platform).includes(artifact.name)) throw new Error(`unexpected ${record.platform} installer: ${artifact.name}`);
      const matches = files.filter((candidate) => basename(candidate) === artifact.name);
      if (matches.length !== 1) throw new Error(`missing or duplicate artifact: ${artifact.name}`);
      const actual = matches[0]; const info = lstatSync(actual);
      if (covered.has(actual)) throw new Error(`artifact claimed by more than one platform: ${artifact.name}`);
      if (!info.isFile() || info.size !== artifact.bytes || artifact.bytes <= 0 || !/^[0-9a-f]{64}$/.test(artifact.sha256) || await digest(actual) !== artifact.sha256) throw new Error(`artifact checksum mismatch: ${artifact.name}`);
      covered.add(actual);
    }
    for (const name of expectedInstallers(version, record.platform)) if (!names.has(name)) throw new Error(`missing ${record.platform} installer: ${name}`);
    for (const name of expectedUpdateAssets(version, record.platform)) if (!names.has(name)) throw new Error(`missing ${record.platform} update asset: ${name}`);
    records.push(record);
  }
  for (const platform of PLATFORMS) if (!seen.has(platform)) throw new Error(`missing platform provenance: ${platform}`);
  for (const file of files.filter(isReleaseAsset)) if (!covered.has(file)) throw new Error(`artifact has no provenance: ${basename(file)}`);
  records.sort((a, b) => PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform));
  const aggregate = { schemaVersion: 1, version, sourceSha: sha, builds: records };
  writeFileSync(join(dir, 'release-provenance.json'), `${JSON.stringify(aggregate, null, 2)}\n`);
  writeFileSync(join(dir, 'SHA256SUMS.txt'), records.flatMap((record) => record.artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`)).join('\n') + '\n');
  return aggregate;
}
export function signingSummary(record) {
  const descriptions = { unsigned: 'unsigned', 'authenticode-verified': 'Authenticode signature verified', 'ad-hoc': 'ad-hoc signature verified; no publisher identity or notarization', 'developer-id-notarized': 'Developer ID signature, hardened runtime and notarization verified' };
  return `\n**Verified build:** source commit \`${record.sourceSha}\`.\n\n${record.builds.map((build) => `- ${build.platform}: ${descriptions[build.signing]}.`).join('\n')}\n\nChecksums and signing results: \`release-provenance.json\`. The GitHub-signed attestation is \`release-provenance.sigstore.json\`; it attests the build's origin and artifact bytes and does not replace OS code signing.\n`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, dir = 'release', platform, signing] = process.argv.slice(2);
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'));
    const builtSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const expectedSha = process.env.SOURCE_SHA;
    if (!expectedSha || builtSha !== expectedSha) throw new Error('checked out HEAD does not match SOURCE_SHA from release checks');
    if (mode === 'build') await writeBuildProvenance(resolve(dir), platform, pkg.version, expectedSha, signing);
    else if (mode === 'verify') {
      const record = await verifyReleaseProvenance(resolve(dir), pkg.version, expectedSha);
      if (platform === '--notes' && signing) appendFileSync(resolve(signing), signingSummary(record));
    }
    else throw new Error('usage: release-provenance.mjs build <dir> <Windows|macOS|Linux> <signing-status> | verify <dir>');
    console.log(`release-provenance: ${mode} verified at ${expectedSha}`);
  } catch (error) { console.error(`release-provenance: ${error.message}`); process.exitCode = 1; }
}
