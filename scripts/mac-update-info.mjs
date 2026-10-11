#!/usr/bin/env node
/**
 * mac-update-info: write the macOS version a release needs into its macOS update metadata.
 *
 *   node scripts/mac-update-info.mjs [dir]      (dir: electron-builder's output, default release)
 *
 * package.json build.mac.minimumSystemVersion sets LSMinimumSystemVersion in the application's
 * Info.plist, but electron-builder 26 does not write it into latest-mac.yml, and macOS copies of
 * JCad Electrical learn about a release through the GitHub API, not electron-updater. So the
 * release's latest-mac.yml gets `minimumSystemVersion: '<version>'` (the field electron-updater's
 * UpdateInfo defines) from the same setting, and the updater (electron/updater.cjs) does not offer
 * the download to a Mac with an older system. Run by .github/workflows/release.yml on the macOS
 * build, after electron-builder and before the provenance record (which hashes the result).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * latest-mac.yml with `minimumSystemVersion` set (after `version:`, replacing an earlier one).
 * @param {string} yml
 * @param {string} version  "13.0"
 */
export function withMinimumSystemVersion(yml, version) {
  if (!/^\d{1,3}(?:\.\d{1,4}){0,2}$/.test(String(version))) throw new Error(`invalid macOS version: ${version}`);
  const lines = String(yml).replace(/\r\n/g, '\n').split('\n').filter((line) => !/^minimumSystemVersion:/.test(line));
  const at = lines.findIndex((line) => /^version:/.test(line));
  if (at < 0) throw new Error('latest-mac.yml has no version');
  lines.splice(at + 1, 0, `minimumSystemVersion: '${version}'`);
  return lines.join('\n');
}

/** build.mac.minimumSystemVersion of a package.json object (required). */
export function macMinimumOf(pkg) {
  const v = pkg && pkg.build && pkg.build.mac && pkg.build.mac.minimumSystemVersion;
  if (typeof v !== 'string' || !v) throw new Error('package.json build.mac.minimumSystemVersion is not set');
  return v;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const dir = resolve(process.argv[2] || 'release');
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'));
    const version = macMinimumOf(pkg);
    const file = join(dir, 'latest-mac.yml');
    writeFileSync(file, withMinimumSystemVersion(readFileSync(file, 'utf8'), version));
    console.log(`mac-update-info: ${file} needs macOS ${version}`);
  } catch (err) {
    console.error(`mac-update-info: ${err && err.message}`);
    process.exitCode = 1;
  }
}
