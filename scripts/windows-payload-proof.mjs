// Static NSIS payload binding. Neither the installer nor application is executed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const require = createRequire(import.meta.url);
const MAX_FILE = 1024 * 1024 * 1024, MAX_TOTAL = 4 * MAX_FILE, MAX_FILES = 20_000;
const APP = 'JCad Electrical.exe', ASAR = 'resources/app.asar';
const MANIFEST = 'resources/dwg-writer/integrity.json';
const HELPER = 'resources/dwg-writer/JcadDwgWriter.exe';
const UNINSTALLER = 'Uninstall JCad Electrical.exe';
const publisher = 'Justin Rodriguez';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const version = value => assert.match(value, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'An exact payload version is required');

function safePath(value) {
  assert.ok(typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value), 'Invalid archive path');
  const normalized = value.replace(/\\/g, '/');
  assert.ok(!normalized.startsWith('/') && !/[<>:"|?*]/.test(normalized), 'Absolute, stream or special archive path');
  const parts = normalized.split('/');
  assert.ok(parts.every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'Unsafe archive path component');
  return normalized;
}

/** Reject ambiguous Windows names, links and extraction bombs before invoking extraction. */
export function validateWindowsArchiveEntries(entries) {
  assert.ok(Array.isArray(entries) && entries.length > 0 && entries.length <= MAX_FILES, 'Archive member count exceeds budget');
  const paths = new Map(), ancestors = new Map();
  let total = 0;
  const checked = entries.map(entry => {
    const path = safePath(entry.path), key = path.toLowerCase();
    assert.ok(!paths.has(key), 'Duplicate or case-colliding archive path');
    assert.equal(entry.link, false, 'Archive links are forbidden');
    assert.equal(typeof entry.directory, 'boolean', 'Archive entry kind is required');
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= MAX_FILE, 'Archive member size exceeds budget');
    if (entry.directory) assert.equal(entry.bytes, 0, 'Directory entry has file bytes');
    else total += entry.bytes;
    assert.ok(total <= MAX_TOTAL, 'Archive expanded size exceeds budget');
    const parts = path.split('/');
    for (let at = 1; at <= parts.length; at++) {
      const prefix = parts.slice(0, at).join('/'), folded = prefix.toLowerCase();
      assert.ok(!ancestors.has(folded) || ancestors.get(folded) === prefix, 'Case-colliding archive directory');
      ancestors.set(folded, prefix);
    }
    paths.set(key, { path, directory: entry.directory, bytes: entry.bytes });
    return { path, directory: entry.directory, bytes: entry.bytes };
  });
  for (const entry of checked) {
    const parts = entry.path.split('/');
    for (let at = 1; at < parts.length; at++) assert.ok(paths.get(parts.slice(0, at).join('/').toLowerCase())?.directory !== false, 'Archive file used as a parent directory');
  }
  return checked;
}

/** Parse only the member section of 7za's bounded technical listing. */
export function parseWindowsArchiveListing(text) {
  return parseArchiveMembers(text, 0);
}

function parseArchiveMembers(text, expectedWarnings) {
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 16 * 1024 * 1024, 'Archive listing exceeds budget');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const separators = lines.flatMap((line, i) => /^-{10,}$/.test(line) ? [i] : []);
  assert.equal(separators.length, 1, 'Exactly one archive member listing is required');
  const start = separators[0];
  assert.ok(start >= 0, 'Archive member listing separator is missing');
  const entries = [], fields = new Map();
  function finish() {
    if (!fields.size) return;
    assert.ok(fields.has('Path') && fields.has('Size'), 'Archive member identity/size is missing');
    const size = fields.get('Size');
    assert.match(size, /^\d+$/, 'Invalid archive member size');
    const attributes = fields.get('Attributes') || '';
    const link = [...fields.keys()].some(key => /(?:symbolic|hard) link|reparse|alternate stream/i.test(key))
      || /(?:^|\s)l[rwxstST-]{9}(?:\s|$)/.test(attributes) || /L/.test(attributes);
    const directory = fields.get('Folder') === '+' || /^D/.test(attributes) || /(?:^|\s)d[rwxstST-]{9}(?:\s|$)/.test(attributes);
    assert.ok(!fields.has('Encrypted') || fields.get('Encrypted') === '-', 'Encrypted payload members are forbidden');
    assert.ok(!fields.has('Anti') || fields.get('Anti') === '-', 'Archive deletion entries are forbidden');
    entries.push({ path: fields.get('Path'), bytes: Number(size), directory, link }); fields.clear();
  }
  let footerSeen = false;
  for (const line of lines.slice(start + 1)) {
    if (line === '') { finish(); continue; }
    assert.ok(!footerSeen, 'Unexpected data after archive warning footer');
    if (/^Warnings: /.test(line)) {
      assert.ok(fields.size === 0 && entries.length > 0 && expectedWarnings === 1 && line === 'Warnings: 1', 'Unexpected archive warning footer');
      footerSeen = true; continue;
    }
    const match = /^([^=\x00-\x1f]+?) = (.*)$/.exec(line);
    assert.ok(match, 'Malformed archive member listing');
    assert.ok(!fields.has(match[1]), 'Duplicate archive member property');
    fields.set(match[1], match[2]);
  }
  finish();
  assert.equal(footerSeen, expectedWarnings === 1, 'Archive warning footer differs from validated header');
  return validateWindowsArchiveEntries(entries);
}

/** Bound an autodetected embedded 7z or full NSIS listing to the exact input file. */
export function parseWindowsInstallerArchiveListing(text, { archivePath, archiveBytes, role = 'installer' }) {
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 16 * 1024 * 1024, 'Archive listing exceeds budget');
  assert.ok(['installer', 'payload'].includes(role), 'Unsupported archive role');
  assert.ok(Number.isSafeInteger(archiveBytes) && archiveBytes > 0 && archiveBytes <= (role === 'installer' ? 2 * MAX_FILE : MAX_FILE), 'Invalid archive byte length');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const headerStarts = lines.flatMap((line, i) => line === '--' ? [i] : []);
  const memberStarts = lines.flatMap((line, i) => /^-{10,}$/.test(line) ? [i] : []);
  assert.ok(headerStarts.length === 1 && memberStarts.length === 1 && memberStarts[0] > headerStarts[0], 'Exactly one complete archive header/member listing is required');
  const fields = new Map(), warnings = [];
  const accepted = new Set(['Path', 'Type', 'Offset', 'Physical Size', 'Tail Size', 'Headers Size', 'Method', 'Solid', 'Blocks', 'SubType', 'Embedded Stub Size']);
  let warningSection = false;
  for (const line of lines.slice(headerStarts[0] + 1, memberStarts[0])) {
    if (line === '') continue;
    if (line === 'WARNINGS:') { assert.ok(!warningSection, 'Duplicate archive warning section'); warningSection = true; continue; }
    if (line === 'There are data after the end of archive') {
      assert.ok(warningSection && warnings.length === 0, 'Unexpected or repeated archive warning'); warnings.push(line); continue;
    }
    const match = /^([^=\x00-\x1f]+?) = (.*)$/.exec(line);
    assert.ok(match && accepted.has(match[1]) && !fields.has(match[1]), 'Unsupported or duplicate archive header field');
    fields.set(match[1], match[2]);
  }
  assert.equal(warningSection, warnings.length === 1, 'Unsupported archive warning section');
  assert.ok(fields.has('Path') && samePath(resolve(fields.get('Path')), resolve(archivePath)), 'Archive header path differs from exact input');
  const number = (key, fallback) => {
    const value = fields.get(key);
    if (value === undefined && fallback !== undefined) return fallback;
    assert.match(value || '', /^(?:0|[1-9]\d*)$/, 'Invalid archive header number: ' + key);
    const result = Number(value); assert.ok(Number.isSafeInteger(result), 'Archive header number exceeds budget: ' + key); return result;
  };
  const type = fields.get('Type'), offset = number('Offset', 0), physicalSize = number('Physical Size', undefined), tailSize = number('Tail Size', 0);
  assert.ok(physicalSize > 0 && physicalSize <= MAX_FILE && offset >= 0 && tailSize >= 0 && offset + physicalSize + tailSize === archiveBytes, 'Archive offset/physical/tail sizes differ from input byte length');
  for (const key of ['Headers Size', 'Blocks', 'Embedded Stub Size']) if (fields.has(key)) assert.ok(number(key, undefined) <= physicalSize, 'Archive header count/size exceeds archive');
  if (fields.has('Solid')) assert.ok(['+', '-'].includes(fields.get('Solid')), 'Invalid archive solid-mode field');
  let extractionMode;
  if (role === 'payload') {
    assert.ok(type === '7z' && offset === 0 && tailSize === 0 && warnings.length === 0, 'Inner payload must be one complete unwrapped 7z without warnings');
    extractionMode = 'inner-7z';
  } else if (type === '7z') {
    assert.ok(offset > 0 && tailSize > 0 && warnings.length === 1, 'Embedded installer 7z requires its bounded stub, tail and exact tail warning');
    extractionMode = 'embedded-7z';
  } else {
    assert.ok(type === 'Nsis' && offset === 0 && tailSize === 0 && warnings.length === 0, 'Unsupported installer archive format or warnings');
    extractionMode = 'nsis-member';
  }
  const entries = parseArchiveMembers(text, warnings.length);
  if (extractionMode === 'embedded-7z') {
    assert.ok(entries.some(entry => entry.path === APP && !entry.directory) && entries.some(entry => entry.path === ASAR && !entry.directory), 'Embedded archive must directly contain one application payload');
    assert.ok(!entries.some(entry => /^\$PLUGINSDIR\/app-(?:32|64|arm64)\.(?:7z|zip)$/i.test(entry.path)), 'Ambiguous embedded/nested installer payloads');
  }
  return { extractionMode, entries, evidence: { type, offset, physicalSize, tailSize, warnings, warningCount: warnings.length, listingSha256: digest(text) } };
}

function regularDirectory(directory) {
  const path = resolve(directory), stat = lstatSync(path);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && samePath(realpathSync.native(path), path), 'Directory is linked or redirected');
  return path;
}

function pinDirectory(directory) {
  const path = regularDirectory(directory), before = lstatSync(path);
  return () => {
    regularDirectory(path); const after = lstatSync(path);
    assert.ok(after.dev === before.dev && after.ino === before.ino, 'Owned payload directory changed during validation');
  };
}

function fileProof(file, max = MAX_FILE) {
  const path = resolve(file), before = lstatSync(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= max && samePath(realpathSync.native(path), path), 'Payload file is linked, redirected or over budget');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    assert.ok(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size, 'Payload file changed while opening');
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0, count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      bytes += count; assert.ok(bytes <= max, 'Payload file grew beyond budget'); hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(fd), named = lstatSync(path);
    assert.ok(bytes === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs && named.dev === before.dev && named.ino === before.ino && named.mtimeMs === before.mtimeMs && !named.isSymbolicLink(), 'Payload file changed during hashing');
    return { bytes, sha256: hash.digest('hex') };
  } finally { closeSync(fd); }
}

/** Full regular-file inventory, including empty directories; no links or Windows aliases. */
export function inventoryWindowsPayload(directory) {
  const root = regularDirectory(directory), files = [], directories = [], entries = [];
  function walk(parent, depth = 0) {
    assert.ok(depth <= 32, 'Payload directory depth exceeds budget');
    regularDirectory(parent);
    for (const name of readdirSync(parent).sort()) {
      const file = join(parent, name), path = relative(root, file).split(sep).join('/'), stat = lstatSync(file);
      assert.ok(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()), 'Payload links or special files are forbidden');
      entries.push({ path, directory: stat.isDirectory(), bytes: stat.isDirectory() ? 0 : stat.size, link: false });
      assert.ok(entries.length <= MAX_FILES, 'Payload member count exceeds budget');
      if (stat.isDirectory()) { directories.push(path); walk(file, depth + 1); }
      else files.push({ path, ...fileProof(file) });
    }
    regularDirectory(parent);
  }
  walk(root); validateWindowsArchiveEntries(entries);
  files.sort((a, b) => a.path.localeCompare(b.path, 'en')); directories.sort();
  return { files, directories, inventorySha256: digest(JSON.stringify({ files, directories })) };
}

function readPackedJson(archive, name) {
  // Bound the Pickle header before @electron/asar allocates its archive header.
  const fd = openSync(archive, 'r'), prefix = Buffer.alloc(8);
  try {
    assert.equal(readSync(fd, prefix, 0, 8, 0), 8, 'Truncated ASAR header');
    assert.ok(prefix.readUInt32LE(4) > 0 && prefix.readUInt32LE(4) <= 16 * 1024 * 1024, 'ASAR header exceeds budget');
  } finally { closeSync(fd); }
  const asar = require('@electron/asar'); asar.uncache(archive);
  const stat = asar.statFile(archive, name, false);
  assert.ok(stat && 'size' in stat && !Object.hasOwn(stat, 'link') && !stat.unpacked && stat.size > 0 && stat.size <= 4 * 1024 * 1024, 'Required ASAR metadata must be a bounded packed file');
  return asar.extractFile(archive, name, false);
}

function inspectPayload(root, expectedVersion, inventory) {
  version(expectedVersion);
  const byPath = new Map(inventory.files.map(file => [file.path, file]));
  for (const name of [APP, ASAR, HELPER, MANIFEST]) assert.ok(byPath.has(name), 'Required Windows payload file missing: ' + name);
  const archive = join(root, ASAR), pkg = JSON.parse(readPackedJson(archive, 'package.json').toString('utf8'));
  assert.equal(pkg.version, expectedVersion, 'Extracted application version differs');
  assert.equal(pkg.name, 'jcad-electrical', 'Extracted application identity differs');
  assert.equal(pkg.main, 'electron/main.cjs', 'Extracted application entry differs');
  assert.ok(!Object.hasOwn(pkg, 'jcadTestBuild'), 'A test ASAR cannot certify the shipping payload');
  assert.ok(byPath.get(MANIFEST).bytes <= 4 * 1024 * 1024, 'Native helper manifest exceeds metadata byte budget');
  const embedded = readPackedJson(archive, 'electron/dwg-writer-integrity.json'), external = readFileSync(join(root, MANIFEST));
  assert.ok(embedded.equals(external), 'Embedded and bundled DWG helper manifests differ');
  const manifest = JSON.parse(external.toString('utf8'));
  assert.equal(manifest.schemaVersion, 1, 'Invalid native helper manifest');
  assert.equal(manifest.helperSigning, 'authenticode-verified', 'Payload requires the signed helper manifest; signatures are independently verified before execution');
  const required = ['JcadDwgWriter.exe', 'JcadDwgWriter-Source.zip', 'ThirdPartyNotices.json'];
  assert.ok(Array.isArray(manifest.files) && manifest.files.length === required.length, 'Complete native helper/source/notices manifest required');
  for (const name of required) {
    const records = manifest.files.filter(file => file?.name === name), actual = byPath.get('resources/dwg-writer/' + name);
    assert.ok(records.length === 1 && actual, 'Native helper bundle member missing or duplicated');
    assert.equal(records[0].size, actual.bytes, 'Native helper member size differs');
    assert.equal(records[0].sha256, actual.sha256, 'Native helper member hash differs');
  }
  assert.deepEqual(inventory.files.filter(file => file.path.startsWith('resources/dwg-writer/')).map(file => file.path).sort(), [MANIFEST, ...required.map(name => 'resources/dwg-writer/' + name)].sort(), 'Unverified native helper resource');
  return { executable: byPath.get(APP), asar: byPath.get(ASAR), helper: byPath.get(HELPER), helperManifest: byPath.get(MANIFEST), helperSigning: manifest.helperSigning };
}

function checkProof(proof) {
  assert.ok(proof?.schemaVersion === 1 && proof.kind === 'windows-installer-payload', 'A Windows installer payload proof is required');
  version(proof.expectedVersion);
  assert.ok(Array.isArray(proof.files) && Array.isArray(proof.directories), 'Payload file/directory inventories are required');
  validateWindowsArchiveEntries([...proof.files.map(file => ({ ...file, directory: false, link: false })), ...proof.directories.map(path => ({ path, bytes: 0, directory: true, link: false }))]);
  for (const file of proof.files) assert.match(file.sha256 || '', /^[a-f0-9]{64}$/, 'Invalid payload file digest');
  assert.equal(proof.inventorySha256, digest(JSON.stringify({ files: proof.files, directories: proof.directories })), 'Payload proof inventory digest differs');
  assert.match(proof.installer?.sha256 || '', /^[a-f0-9]{64}$/, 'Installer provenance digest is required');
}

async function getPinnedArchiveTool() {
  assert.ok(!process.env.ELECTRON_BUILDER_7ZIP_PATH, 'Archive tool override is forbidden for payload evidence');
  return require('app-builder-lib/out/toolsets/7zip.js').getPath7za();
}
function runArchive(tool, args) {
  return execFileSync(tool, args, { encoding: 'utf8', windowsHide: true, shell: false, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
}
function verifyUninstaller(file) {
  assert.equal(process.platform, 'win32', 'Uninstaller signature verification requires Windows');
  const literal = "'" + file.replace(/'/g, "''") + "'";
  const script = `$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath ${literal}; if (!$s.SignerCertificate) { throw 'Missing uninstaller signer' }; @{status=[string]$s.Status;publisher=$s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)} | ConvertTo-Json -Compress`;
  const env = { ...process.env }; for (const name of Object.keys(env)) if (name.toLowerCase() === 'psmodulepath') delete env[name];
  return JSON.parse(execFileSync(join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000, maxBuffer: 1024 * 1024 }));
}

/** Explicit dependency injection is for archive/filesystem unit tests, never environment policy. */
export function createWindowsPayloadVerifier(dependencies = {}) {
  const getTool = dependencies.getArchiveTool || getPinnedArchiveTool;
  const archive = dependencies.runArchive || runArchive;
  const signature = dependencies.verifyUninstaller || verifyUninstaller;
  return {
    async extractWindowsInstallerPayload({ installer, expectedVersion, scratchParent = realpathSync.native(tmpdir()), outDir }) {
      version(expectedVersion);
      const input = resolve(installer), installerBefore = fileProof(input, 2 * MAX_FILE), parent = regularDirectory(scratchParent);
      const owned = outDir ? resolve(outDir) : mkdtempSync(join(parent, 'jcad-windows-payload-'));
      assert.ok(dirname(owned) === parent && basename(owned) !== '.', 'Extraction output must be a new direct child of the private scratch parent');
      if (outDir) mkdirSync(owned); // Existing paths are never reused or removed.
      regularDirectory(owned);
      const outer = join(owned, 'outer'), payloadRoot = join(owned, 'payload'); mkdirSync(outer); mkdirSync(payloadRoot);
      const pins = [parent, owned, outer, payloadRoot].map(pinDirectory);
      const checkOwned = () => { for (const check of pins) check(); };
      const tool = await getTool();
      checkOwned();
      const listed = parseWindowsInstallerArchiveListing(await archive(tool, ['l', '-slt', '-sccUTF-8', '--', input]), { archivePath: input, archiveBytes: installerBefore.bytes });
      let entries = listed.entries;
      if (listed.extractionMode === 'embedded-7z') {
        checkOwned();
        await archive(tool, ['x', '-y', '-o' + payloadRoot, '--', input]);
      } else {
        const members = listed.entries.filter(entry => entry.path === '$PLUGINSDIR/app-64.7z');
        assert.ok(members.length === 1 && !members[0].directory && members[0].bytes > 0, 'One bounded regular $PLUGINSDIR/app-64.7z is required');
        assert.ok(!listed.entries.some(entry => /^\$PLUGINSDIR\/app-(?:32|arm64)\.(?:7z|zip)$/i.test(entry.path)), 'Ambiguous installer architecture payloads');
        checkOwned();
        await archive(tool, ['x', '-y', '-o' + outer, '--', input, '$PLUGINSDIR/app-64.7z']);
        checkOwned();
        const intermediate = inventoryWindowsPayload(outer);
        assert.deepEqual(intermediate.files.map(file => ({ path: file.path, bytes: file.bytes })), [{ path: members[0].path, bytes: members[0].bytes }], 'Outer extraction contains unexpected bytes/files');
        assert.deepEqual(intermediate.directories, ['$PLUGINSDIR'], 'Outer extraction contains unexpected directories');
        const inner = join(outer, '$PLUGINSDIR', 'app-64.7z');
        const innerBefore = fileProof(inner);
        entries = parseWindowsInstallerArchiveListing(await archive(tool, ['l', '-slt', '-sccUTF-8', '--', inner]), { archivePath: inner, archiveBytes: innerBefore.bytes, role: 'payload' }).entries;
        checkOwned();
        await archive(tool, ['x', '-y', '-o' + payloadRoot, '--', inner]);
        assert.deepEqual(fileProof(inner), innerBefore, 'Inner payload archive changed during extraction');
      }
      checkOwned();
      assert.deepEqual(fileProof(input, 2 * MAX_FILE), installerBefore, 'Installer changed during extraction');
      const inventory = inventoryWindowsPayload(payloadRoot);
      assert.deepEqual(inventory.files.map(file => ({ path: file.path, bytes: file.bytes })).sort((a, b) => a.path.localeCompare(b.path, 'en')), entries.filter(entry => !entry.directory).map(({ path, bytes }) => ({ path, bytes })).sort((a, b) => a.path.localeCompare(b.path, 'en')), 'Extracted payload differs from its validated member listing');
      const expectedDirectories = new Set();
      for (const entry of entries) {
        const parts = entry.path.split('/');
        for (let at = 1; at <= parts.length - (entry.directory ? 0 : 1); at++) expectedDirectories.add(parts.slice(0, at).join('/'));
      }
      assert.deepEqual(inventory.directories, [...expectedDirectories].sort(), 'Extracted directories differ from the validated member listing');
      const criticalFiles = inspectPayload(payloadRoot, expectedVersion, inventory);
      assert.deepEqual(inventoryWindowsPayload(payloadRoot), inventory, 'Payload changed during metadata verification');
      checkOwned();
      return { schemaVersion: 1, kind: 'windows-installer-payload', expectedVersion, installer: { path: input, ...installerBefore }, extractionRoot: owned, payloadRoot, extractionMode: listed.extractionMode, archiveEvidence: listed.evidence, ...inventory, criticalFiles, signatureAndFuseEvidence: 'required-separately; static extraction never executes installer/application' };
    },
    async verifyInstalledWindowsPayload({ executable, payloadProof }) {
      checkProof(payloadProof);
      const named = resolve(executable), root = regularDirectory(dirname(named));
      const checkRoot = pinDirectory(root);
      assert.equal(basename(named), APP, 'The exact installed application executable is required');
      const actual = inventoryWindowsPayload(root), expected = new Map(payloadProof.files.map(file => [file.path, file]));
      const extra = actual.files.filter(file => !expected.has(file.path));
      assert.ok(extra.every(file => file.path === UNINSTALLER) && extra.length <= 1 && !expected.has(UNINSTALLER), 'Unexpected installed payload file');
      const installed = actual.files.filter(file => expected.has(file.path));
      assert.deepEqual(installed, payloadProof.files, 'Installed payload differs: missing or modified installer file');
      assert.deepEqual(actual.directories, payloadProof.directories, 'Unexpected or missing installed payload directory');
      const criticalFiles = inspectPayload(root, payloadProof.expectedVersion, actual);
      assert.deepEqual(criticalFiles, payloadProof.criticalFiles, 'Critical installed executable/ASAR/helper binding differs');
      const uninstaller = [];
      for (const file of extra) {
        const result = await signature(join(root, file.path));
        assert.equal(result?.status, 'Valid', 'Installed uninstaller requires a valid Authenticode signature');
        assert.equal(result?.publisher, publisher, 'Installed uninstaller publisher differs');
        uninstaller.push({ ...file, signature: result });
      }
      assert.deepEqual(inventoryWindowsPayload(root), actual, 'Installed payload changed during verification');
      checkRoot();
      return { schemaVersion: 1, expectedVersion: payloadProof.expectedVersion, executable: named, payloadFilesMatched: installed.length, inventorySha256: payloadProof.inventorySha256, installer: payloadProof.installer, criticalFiles, uninstaller, exactPayloadMatch: true, signatureAndFuseEvidence: 'application/helper checked separately before execution' };
    },
  };
}

const production = createWindowsPayloadVerifier();
export const extractWindowsInstallerPayload = production.extractWindowsInstallerPayload;
export const verifyInstalledWindowsPayload = production.verifyInstalledWindowsPayload;
