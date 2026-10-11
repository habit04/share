/**
 * Checks of a downloaded update before it is installed (security review E-8).
 *
 * electron-updater already verifies what it downloads: the installer's SHA-512 against the
 * release's latest*.yml (Windows NSIS and Linux AppImage), and on Windows the Authenticode
 * signature against the publisher named in the installation's app-update.yml - when a publisher is
 * named there, which electron-builder does only for a signed build. These checks are repeated here,
 * independently of the library, right after the download and again just before
 * quitAndInstall: the metadata must give a SHA-512 for every file, every downloaded file must hash
 * to one of them, and on Windows, when the installation names a publisher, the installer's
 * signature must match it. A failure installs nothing (the on-quit install is switched off too).
 *
 * What remains (docs/SECURITY-REVIEW.md E-8): the hash comes from the same GitHub release as the
 * installer, so for a build without a publisher signature (an unsigned Windows build, every
 * AppImage) integrity rests on who can publish a release. Whether such builds should update in
 * place at all is the owner's decision; they still do.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

/**
 * The publisher names of app-update.yml (`publisherName: X` or a `publisherName:` list), the only
 * key read; [] when there is none (an unsigned build).
 * @param {string} text
 * @returns {string[]}
 */
function publisherNamesFrom(text) {
  const lines = String(text).split(/\r?\n/);
  const unquote = (/** @type {string} */ v) => v.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^publisherName:\s*(.*)$/.exec(lines[i] ?? '');
    if (!m) continue;
    const inline = (m[1] ?? '').trim();
    if (inline.startsWith('[')) return inline.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean);
    if (inline) return [unquote(inline)].filter(Boolean);
    const out = [];
    for (let k = i + 1; k < lines.length; k += 1) {
      const item = /^\s+-\s*(.*)$/.exec(lines[k] ?? '');
      if (!item) break;
      const v = unquote(item[1] ?? '');
      if (v) out.push(v);
    }
    return out;
  }
  return [];
}

/**
 * Why the update metadata cannot be verified, or null: every file needs a SHA-512.
 * @param {any} info  electron-updater UpdateInfo
 * @returns {string | null}
 */
function updateInfoProblem(info) {
  const files = info && Array.isArray(info.files) ? info.files : [];
  if (files.length === 0) return 'the update metadata lists no files';
  for (const f of files) if (!f || typeof f.sha512 !== 'string' || f.sha512.length < 64) return `the update metadata has no SHA-512 checksum for ${f && f.url ? String(f.url) : 'a file'}`;
  return null;
}

/**
 * SHA-512 of a file in the encodings latest*.yml uses (base64; very old metadata used hex).
 * @param {string} file
 * @returns {Promise<{ base64: string, hex: string }>}
 */
function sha512File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => h.update(chunk))
      .on('end', () => {
        const digest = h.digest();
        resolve({ base64: digest.toString('base64'), hex: digest.toString('hex') });
      });
  });
}

/**
 * Verify downloaded update files. Resolves null when they may be installed, else the reason.
 * @param {{
 *   files: readonly string[],
 *   info: any,
 *   publisherNames?: readonly string[],
 *   verifySignature?: ((names: string[], file: string) => Promise<string | null>) | null,
 *   hash?: (file: string) => Promise<{ base64: string, hex: string }>,
 * }} opts
 *   files: what downloadUpdate() resolved; info: the UpdateInfo it was downloaded for;
 *   publisherNames / verifySignature: Windows (app-update.yml names, the updater's verifier)
 * @returns {Promise<string | null>}
 */
async function verifyDownloadedUpdate({ files, info, publisherNames = [], verifySignature = null, hash = sha512File }) {
  const problem = updateInfoProblem(info);
  if (problem) return problem;
  if (!Array.isArray(files) || files.length === 0) return 'nothing was downloaded';
  const expected = new Set(info.files.map((/** @type {{ sha512: string }} */ f) => f.sha512));
  for (const file of files) {
    let digest;
    try {
      digest = await hash(file);
    } catch (err) {
      return `the downloaded file cannot be read (${(err && err.message) || err})`;
    }
    if (!expected.has(digest.base64) && !expected.has(digest.hex)) return `the downloaded file does not match the SHA-512 checksum of the release`;
    if (publisherNames.length > 0) {
      if (!verifySignature) return 'the installer signature cannot be checked';
      let why;
      try {
        why = await verifySignature([...publisherNames], file);
      } catch (err) {
        why = String((err && err.message) || err);
      }
      if (why) return `the installer is not signed by ${publisherNames.join(' / ')}: ${why}`;
    }
  }
  return null;
}

module.exports = { publisherNamesFrom, updateInfoProblem, sha512File, verifyDownloadedUpdate };
