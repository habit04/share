// Fetch a content-pinned source crate and apply exact, reviewed private-writer patches.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rename, rm, lstat, readdir, open } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
export const DWG_WRITER_PINS = JSON.parse(await readFile(join(ROOT, 'vendor/acadrust-writer/pins.json'), 'utf8'));
export const sourceHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const MAX_ARCHIVE = 32 * 1024 * 1024;
const MAX_SOURCE = 128 * 1024 * 1024;

export async function readSourceArchive(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ARCHIVE) throw new Error('DWG writer source archive is not a bounded regular file.');
  const handle = await open(file, 'r');
  try {
    const chunks = []; let size = 0;
    for (;;) { const buffer = Buffer.alloc(64 * 1024); const result = await handle.read(buffer, 0, buffer.length, null); if (!result.bytesRead) break; size += result.bytesRead; if (size > MAX_ARCHIVE) throw new Error('DWG writer source archive exceeds its budget.'); chunks.push(buffer.subarray(0, result.bytesRead)); }
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}

export function verifySourceArchive(bytes, expected = DWG_WRITER_PINS.crate.sha256) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_ARCHIVE || !/^[a-f0-9]{64}$/.test(expected) || sourceHash(bytes) !== expected) throw new Error('DWG writer crate checksum mismatch.');
}
function sourceName(name) {
  const parts = name.split('/');
  if (!name || isAbsolute(name) || name.includes('\\') || /[\x00-\x1f<>:"|?*]/.test(name) || parts.some((p) => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('Unsafe DWG writer source path.');
  return name;
}
export function crateEntries(bytes, prefix = 'acadrust-0.6.4') {
  const tar = gunzipSync(bytes, { maxOutputLength: MAX_SOURCE });
  const entries = new Map(); const folded = new Set(); let offset = 0;
  const string = (header, from, length) => header.subarray(from, from + length).toString('utf8').split('\0')[0];
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const checksum = parseInt(string(header, 148, 8).trim(), 8);
    const sum = header.reduce((out, byte, i) => out + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (!Number.isSafeInteger(checksum) || checksum !== sum) throw new Error('Invalid DWG writer source tar checksum.');
    const length = parseInt(string(header, 124, 12).trim(), 8);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SOURCE || offset + 512 + length > tar.length) throw new Error('Invalid DWG writer source tar length.');
    const base = string(header, 0, 100), directory = string(header, 345, 155);
    let name = directory ? `${directory}/${base}` : base;
    const kind = header[156];
    if (kind === 53) name = name.replace(/\/$/, '');
    sourceName(name);
    if (!name.startsWith(`${prefix}/`) || ![0, 48, 53].includes(kind)) throw new Error('Unexpected or linked DWG writer crate entry.');
    const local = sourceName(name.slice(prefix.length + 1));
    if (folded.has(local.toLowerCase()) || folded.size >= 5000) throw new Error('Duplicate or excessive DWG writer source entries.');
    folded.add(local.toLowerCase());
    if (kind !== 53) entries.set(local, Buffer.from(tar.subarray(offset + 512, offset + 512 + length)));
    offset += 512 + Math.ceil(length / 512) * 512;
  }
  if (!entries.size) throw new Error('DWG writer source archive is empty.');
  return entries;
}
export function exactSourcePatch(bytes, patch) {
  if (sourceHash(bytes) !== patch.beforeSha256) throw new Error(`DWG writer patch preimage mismatch: ${patch.path}`);
  let text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('DWG writer patch is not valid UTF-8.');
  for (const replacement of patch.replacements) {
    if (!replacement.before || !replacement.after || replacement.count !== 1 || text.split(replacement.before).length !== 2) throw new Error(`DWG writer patch occurrence mismatch: ${patch.path}`);
    text = text.replace(replacement.before, replacement.after);
  }
  const result = Buffer.from(text, 'utf8');
  if (sourceHash(result) !== patch.afterSha256) throw new Error(`DWG writer patch postimage mismatch: ${patch.path}`);
  return result;
}
export function patchedCrateEntries(bytes, pins = DWG_WRITER_PINS) {
  verifySourceArchive(bytes, pins.crate.sha256);
  const entries = crateEntries(bytes, `${pins.crate.name}-${pins.crate.version}`);
  const vcs = JSON.parse(entries.get('.cargo_vcs_info.json')?.toString('utf8') ?? '{}');
  if (vcs.git?.sha1 !== pins.crate.commit) throw new Error('DWG writer crate source commit mismatch.');
  for (const patch of pins.patches) {
    sourceName(patch.path);
    const original = entries.get(patch.path);
    if (!original) throw new Error(`Missing DWG writer patch file: ${patch.path}`);
    entries.set(patch.path, exactSourcePatch(original, patch));
  }
  return entries;
}
async function regularFiles(dir, prefix = '') {
  const entries = [];
  for (const name of await readdir(dir)) {
    const file = join(dir, name), info = await lstat(file), local = prefix ? `${prefix}/${name}` : name;
    if (info.isSymbolicLink()) throw new Error('Linked DWG writer source directory.');
    if (info.isDirectory()) entries.push(...await regularFiles(file, local));
    else if (info.isFile()) entries.push(local);
    else throw new Error('Non-file DWG writer source entry.');
  }
  return entries.sort();
}
export async function verifyPreparedSource(dir, entries) {
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid prepared DWG writer source directory.');
  const actual = (await regularFiles(dir)).filter((name) => name !== '.jcad-source.json');
  if (JSON.stringify(actual) !== JSON.stringify([...entries.keys()].sort())) throw new Error('Prepared DWG writer source file set mismatch.');
  for (const [name, bytes] of entries) if (sourceHash(await readFile(join(dir, name))) !== sourceHash(bytes)) throw new Error(`Prepared DWG writer source checksum mismatch: ${name}`);
}
export async function prepareDwgWriter({ root = ROOT, archivePath = process.env.JCAD_ACADRUST_ARCHIVE } = {}) {
  const helper = resolve(root, 'native/dwg-writer'), vendor = join(helper, 'vendor'), destination = join(vendor, 'acadrust');
  const within = relative(helper, destination);
  if (isAbsolute(within) || within.startsWith('..')) throw new Error('DWG writer source destination escapes the helper.');
  for (const parent of [resolve(root), join(root, 'native'), helper, vendor]) {
    try { if ((await lstat(parent)).isSymbolicLink()) throw new Error('Linked DWG writer build directory.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(vendor, { recursive: true });
  for (const parent of [helper, vendor]) if ((await lstat(parent)).isSymbolicLink()) throw new Error('Linked DWG writer build directory.');
  const cache = join(helper, '.acadrust-0.6.4.crate');
  let bytes;
  if (archivePath) bytes = await readSourceArchive(resolve(archivePath));
  else {
    try { bytes = await readSourceArchive(cache); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const response = await fetch(DWG_WRITER_PINS.crate.url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok || Number(response.headers.get('content-length')) > MAX_ARCHIVE) throw new Error('Could not fetch the pinned DWG writer crate.');
      const chunks = []; let size = 0; const reader = response.body.getReader();
      try {
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > MAX_ARCHIVE) throw new Error('DWG writer crate download exceeds its budget.'); chunks.push(chunk.value); }
      } finally { await reader.cancel(); }
      bytes = Buffer.concat(chunks);
      verifySourceArchive(bytes);
      await writeFile(cache, bytes, { flag: 'wx' });
    }
  }
  const entries = patchedCrateEntries(bytes);
  try {
    await verifyPreparedSource(destination, entries);
    return destination;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const scratch = await mkdtemp(join(vendor, '.jcad-prepare-'));
  try {
    for (const [name, content] of entries) { const file = join(scratch, name); await mkdir(dirname(file), { recursive: true }); await writeFile(file, content, { flag: 'wx' }); }
    await writeFile(join(scratch, '.jcad-source.json'), JSON.stringify({ schemaVersion: 1, crateSha256: DWG_WRITER_PINS.crate.sha256, sourceCommit: DWG_WRITER_PINS.crate.commit, patches: DWG_WRITER_PINS.patches.map(({ path, afterSha256 }) => ({ path, sha256: afterSha256 })) }, null, 2) + '\n');
    await verifyPreparedSource(scratch, entries);
    await rename(scratch, destination);
  } finally { await rm(scratch, { recursive: true, force: true }); }
  return destination;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(`DWG writer source prepared: ${await prepareDwgWriter()}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
