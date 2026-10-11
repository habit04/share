#!/usr/bin/env node
/**
 * Release notes for a tag, taken from CHANGELOG.md (Keep a Changelog format): the section
 * `## [0.4.1] - <date>` of the version, or `## [Unreleased]` when the version has no section yet
 * (a dress rehearsal before the changelog is cut). A download / first-launch footer is appended;
 * its macOS sentence follows the signing status the macOS build recorded
 * (scripts/release-provenance.mjs): notarized, ad-hoc, or a neutral sentence when it is not known.
 * Used by .github/workflows/release.yml as the body of the GitHub Release
 * (softprops/action-gh-release `body_path`), by .github/workflows/release-notes.yml to rewrite the
 * notes of an existing release, and to write docs/releases/v<x.y.z>.md.
 *
 *   node scripts/release-notes.mjs v0.4.1                 -> stdout
 *   node scripts/release-notes.mjs v0.4.1 --out notes.md  -> file
 *   node scripts/release-notes.mjs v0.4.1 --strict        -> exit 1 when the version has no section
 *   node scripts/release-notes.mjs v0.4.2 --provenance artifacts
 *       the macOS sentence from the macOS build record (JCad-Electrical-macOS-provenance.json) in
 *       that folder (the release job's downloaded artifacts); given a release's published
 *       release-provenance.json (file, or a folder holding it), also its "Verified build" list,
 *       after the release job verified the downloaded artifacts
 *   node scripts/release-notes.mjs v0.4.2 --mac-signing developer-id-notarized   (or ad-hoc)
 *       the macOS sentence for a known signing status, without a record
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signingSummary } from './release-provenance.mjs';

/** The footer's macOS first-launch sentence for each signing status a macOS build records. */
const MAC_FIRST_LAUNCH = {
  'developer-id-notarized': 'macOS builds are signed with a Developer ID and notarized by Apple, so macOS only asks once whether to open an app downloaded from the internet (Open).',
  'ad-hoc': 'macOS builds are not notarized and open once through System Settings > Privacy & Security > Open Anyway.',
};
/** When the macOS build's signing is not known: true of either kind of build. */
const MAC_UNKNOWN = 'a macOS build that is not notarized opens once through System Settings > Privacy & Security > Open Anyway.';
export const MAC_SIGNING = Object.keys(MAC_FIRST_LAUNCH);

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
 * @param {{ macSigning?: string }} [options]  macSigning: the macOS build's recorded signing status
 *   ("developer-id-notarized" or "ad-hoc"); left out, the footer's macOS sentence is neutral
 * @returns {string}
 */
export function releaseNotes(changelog, version, repo = 'habit04/share', options = {}) {
  const v = String(version).trim().replace(/^v(?=\d)/, '');
  const body = sectionFor(changelog, v) ?? sectionFor(changelog, 'Unreleased') ?? 'See CHANGELOG.md.';
  const [owner, name] = repo.split('/');
  const { macSigning } = options;
  if (macSigning !== undefined && !MAC_SIGNING.includes(macSigning)) throw new Error(`unknown macOS signing status: ${macSigning}`);
  const mac = macSigning === undefined ? MAC_UNKNOWN : MAC_FIRST_LAUNCH[/** @type {keyof typeof MAC_FIRST_LAUNCH} */ (macSigning)];
  const footer = [
    '',
    '---',
    '',
    `**Downloads:** Windows \`jcad-electrical-${v}-win-x64.exe\` · macOS \`jcad-electrical-${v}-mac-arm64.dmg\` (Apple Silicon) / \`jcad-electrical-${v}-mac-x64.dmg\` (Intel) · Linux \`.AppImage\` / \`.deb\`.`,
    'Installed copies offer the release download. Windows builds configured with a trusted signing publisher install a verified update only after you choose Restart Now; unsigned Windows and all Linux/macOS builds use manual installation.',
    '',
    'Signing varies by release. When published, inspect `release-provenance.json` and its signed attestation for the verified status.',
    `First launch: Windows SmartScreen may say "Windows protected your PC" (More info > Run anyway); ${mac}`,
    `Website and browser edition: https://${owner}.github.io/${name}/ · Full history: https://github.com/${repo}/blob/v${v}/CHANGELOG.md`,
  ];
  return `${body}\n${footer.join('\n')}\n`;
}

/**
 * The release pipeline's record of the macOS build (scripts/release-provenance.mjs). `path` is a
 * record file (a build's JCad-Electrical-macOS-provenance.json, or a release's verified
 * release-provenance.json) or a folder holding one (the release's own record is preferred).
 * Returns the macOS signing status and, when the record is a release's verified record, that
 * record; null when there is none.
 * @param {string} path
 * @returns {{ macSigning: string, release: { sourceSha: string, builds: { platform: string, signing: string }[] } | null } | null}
 */
export function readProvenance(path) {
  if (!existsSync(path)) return null;
  let file = path;
  if (statSync(path).isDirectory()) {
    const files = readdirSync(path, { recursive: true }).map((f) => join(path, String(f)));
    const pick = (/** @type {string} */ n) => files.find((f) => basename(f) === n);
    const found = pick('release-provenance.json') ?? pick('JCad-Electrical-macOS-provenance.json');
    if (!found) return null;
    file = found;
  }
  const record = JSON.parse(readFileSync(file, 'utf8'));
  const release = Array.isArray(record?.builds) ? record : null;
  const mac = release ? release.builds.find((/** @type {{ platform?: string }} */ b) => b?.platform === 'macOS') : record;
  if (mac?.platform !== 'macOS' || !MAC_SIGNING.includes(mac.signing)) throw new Error(`${file}: no macOS build with a known signing status`);
  return { macSigning: mac.signing, release };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const valued = ['--out', '--provenance', '--mac-signing'];
  const option = (/** @type {string} */ name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const [version] = args.filter((a, i) => !a.startsWith('--') && !valued.includes(args[i - 1] ?? ''));
  if (!version) {
    console.error('usage: node scripts/release-notes.mjs <tag> [--out file] [--strict] [--provenance file|folder | --mac-signing developer-id-notarized|ad-hoc]');
    process.exit(2);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  if (args.includes('--strict') && sectionFor(changelog, version) === null) {
    console.error(`release-notes: CHANGELOG.md has no section for ${version}`);
    process.exit(1);
  }
  let macSigning = option('--mac-signing');
  if (macSigning !== undefined && !MAC_SIGNING.includes(macSigning)) {
    console.error(`release-notes: --mac-signing is one of ${MAC_SIGNING.join(', ')}`);
    process.exit(2);
  }
  let summary = '';
  const from = option('--provenance');
  if (from) {
    const provenance = readProvenance(from);
    if (!provenance) {
      console.error(`release-notes: no macOS build record (release-provenance.json, JCad-Electrical-macOS-provenance.json) in ${from}`);
      process.exit(1);
    }
    macSigning = provenance.macSigning;
    if (provenance.release) summary = signingSummary(provenance.release);
  }
  const notes = releaseNotes(changelog, version, process.env.GITHUB_REPOSITORY || undefined, { macSigning }) + summary;
  const out = option('--out');
  if (out) writeFileSync(out, notes);
  else process.stdout.write(notes);
}
