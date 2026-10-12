import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const pins = JSON.parse(await readFile(join(here, 'pins.json'), 'utf8'));
export const patch = JSON.parse(await readFile(join(here, 'mtext-background-scale.patch.json'), 'utf8'));
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const blobHash = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

export function validateReplacementText(text, entry) {
  for (const replacement of entry.replacements) {
    const postimageCount = text.split(replacement.after).length - 1;
    // Insertions can legitimately retain the old text inside the complete new postimage.
    const outsidePostimages = text.split(replacement.after).join('');
    if (outsidePostimages.includes(replacement.before) || postimageCount !== replacement.count) throw new Error(`Patched native field drift: ${entry.path}`);
  }
}

export function checkedReplacement(before, entry) {
  if (blobHash(before) !== entry.gitBlob) throw new Error(`Preimage mismatch: ${entry.path}`);
  let text = before.toString('utf8');
  for (const replacement of entry.replacements) {
    const count = text.split(replacement.before).length - 1;
    if (count !== replacement.count) throw new Error(`Expected ${replacement.count} occurrences, found ${count}: ${entry.path}`);
    text = text.split(replacement.before).join(replacement.after);
  }
  validateReplacementText(text, entry);
  return Buffer.from(text, 'utf8');
}

export async function sourceFile(root, name) {
  const file = resolve(root, name), rel = relative(root, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Source path escapes checkout: ${name}`);
  if ((await lstat(file)).isSymbolicLink() || await realpath(file) !== file) throw new Error(`Linked source file: ${name}`);
  return file;
}

/** Validate every preimage before making any change; a partial/repeated patch is refused. */
export async function applyCheckedPatch(source, output) {
  const root = await realpath(resolve(source));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (head !== pins.source.commit || patch.upstream.commit !== head) throw new Error(`Wrong source HEAD: ${head}`);
  for (const sub of pins.submodules) {
    const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(root, sub.path), encoding: 'utf8' }).trim();
    if (actual !== sub.commit) throw new Error(`Wrong submodule HEAD: ${sub.path}`);
  }
  const manifest = await readFile(await sourceFile(root, 'bindings/javascript/package.json'));
  if (blobHash(manifest) !== pins.packageManifestGitBlob || JSON.parse(manifest.toString()).version !== '0.7.14') throw new Error('Upstream build scripts/version changed.');
  const license = await readFile(await sourceFile(root, 'COPYING'));
  if (blobHash(license) !== pins.licenseGitBlob) throw new Error('Upstream GPL license changed.');
  const changes = [];
  for (const entry of patch.files) {
    const file = await sourceFile(root, entry.path), before = await readFile(file);
    const after = checkedReplacement(before, entry);
    changes.push({ file, after, path: entry.path, beforeSha256: sha256(before), afterSha256: sha256(after), replacements: entry.replacements.reduce((sum, item) => sum + item.count, 0) });
  }
  for (const change of changes) await writeFile(change.file, change.after);
  await validatePatchedSource(root);
  const record = { schemaVersion: 1, source: pins.source, patchSha256: sha256(await readFile(join(here, 'mtext-background-scale.patch.json'))), files: changes.map(({ path, beforeSha256, afterSha256, replacements }) => ({ path, beforeSha256, afterSha256, replacements })) };
  await writeFile(resolve(output), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  console.log(`NATIVE_PATCH_OK ${changes.length} files / ${record.files.reduce((sum, item) => sum + item.replacements, 0)} checked replacements`);
  return record;
}

/** Autogen can regenerate dynamic metadata; recheck all production declarations afterwards. */
export async function validatePatchedSource(source) {
  const root = await realpath(resolve(source));
  for (const entry of patch.files) {
    const text = await readFile(await sourceFile(root, entry.path), 'utf8');
    validateReplacementText(text, entry);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, source, output] = process.argv.slice(2);
  if (mode === 'apply' && source && output) await applyCheckedPatch(source, output);
  else if (mode === 'verify' && source && !output) { await validatePatchedSource(source); console.log('NATIVE_FIELD_TYPES_OK'); }
  else throw new Error('Usage: patch-source.mjs apply SOURCE REPORT | verify SOURCE');
}
