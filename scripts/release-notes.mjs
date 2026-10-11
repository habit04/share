#!/usr/bin/env node
/**
 * Release notes for a tag, taken from CHANGELOG.md (Keep a Changelog format): the section
 * `## [0.4.1] - <date>` of the version, or `## [Unreleased]` when the version has no section yet
 * (a dress rehearsal before the changelog is cut). A download / first-launch footer is appended.
 * Used by .github/workflows/release.yml as the body of the GitHub Release
 * (softprops/action-gh-release `body_path`), and to write docs/releases/v<x.y.z>.md for a release
 * that was published without notes.
 *
 *   node scripts/release-notes.mjs v0.4.1                 -> stdout
 *   node scripts/release-notes.mjs v0.4.1 --out notes.md  -> file
 *   node scripts/release-notes.mjs v0.4.1 --strict        -> exit 1 when the version has no section
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The body of the changelog section for `version` ("v0.4.1", "0.4.1" or "Unreleased"), without
 * its heading, up to the next `## [` heading or the link list; null when there is no such section.
 * @param {string} changelog
 * @param {string} version
 * @returns {string | null}
 */
export function sectionFor(changelog, version) {
  const v = String(version).trim().replace(/^v(?=\d)/, '').toLowerCase();
  const lines = changelog.split(/\r?\n/);
  const isHead = (/** @type {string} */ l) => /^## \[/.test(l);
  const start = lines.findIndex((l) => isHead(l) && l.slice(4).toLowerCase().startsWith(`${v}]`));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && (isHead(l) || /^\[[^\]]+\]:\s/.test(l)));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

/**
 * Notes for a release: the version's section (else Unreleased) and the download footer.
 * @param {string} changelog
 * @param {string} version  the tag, e.g. "v0.4.1"
 * @param {string} [repo]   owner/name of the GitHub repository
 * @returns {string}
 */
export function releaseNotes(changelog, version, repo = 'habit04/share') {
  const v = String(version).trim().replace(/^v(?=\d)/, '');
  const body = sectionFor(changelog, v) ?? sectionFor(changelog, 'Unreleased') ?? 'See CHANGELOG.md.';
  const [owner, name] = repo.split('/');
  const footer = [
    '',
    '---',
    '',
    `**Downloads:** Windows \`jcad-electrical-${v}-win-x64.exe\` · macOS \`jcad-electrical-${v}-mac-arm64.dmg\` (Apple Silicon) / \`jcad-electrical-${v}-mac-x64.dmg\` (Intel) · Linux \`.AppImage\` / \`.deb\`.`,
    'Installed copies learn about this release on their own: the Windows installer and the AppImage update in place; macOS and `.deb` installs offer the download.',
    '',
    'First launch: Windows SmartScreen may say "Windows protected your PC" (More info > Run anyway); macOS builds are not notarized and open once through System Settings > Privacy & Security > Open Anyway.',
    `Website and browser edition: https://${owner}.github.io/${name}/ · Full history: https://github.com/${repo}/blob/v${v}/CHANGELOG.md`,
  ];
  return `${body}\n${footer.join('\n')}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [version] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--out');
  if (!version) {
    console.error('usage: node scripts/release-notes.mjs <tag> [--out file] [--strict]');
    process.exit(2);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  if (process.argv.includes('--strict') && sectionFor(changelog, version) === null) {
    console.error(`release-notes: CHANGELOG.md has no section for ${version}`);
    process.exit(1);
  }
  const notes = releaseNotes(changelog, version, process.env.GITHUB_REPOSITORY || undefined);
  const i = process.argv.indexOf('--out');
  if (i > 0 && process.argv[i + 1]) writeFileSync(process.argv[i + 1], notes);
  else process.stdout.write(notes);
}
