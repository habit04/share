/** Portable Windows DWG copies: verify the packaged helper, convert privately, then commit atomically. */
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { runBoundedWriter } = require('./portable-dwg-process.cjs');
const { MAX_DRAWING_BYTES, readLimitedFile, validateTextSize } = require('./resource-limits.cjs');

const MAX_REPORT_BYTES = 1024 * 1024;
const MAX_HELPER_BYTES = 512 * 1024 * 1024;
const HELPER_NAME = 'JcadDwgWriter.exe';
const FORMAT = 'AC1032';
const UNAVAILABLE = 'The bundled portable DWG writer is missing or failed its integrity check. Reinstall the Windows desktop app, or save a DXF copy.';

function validateExportDxf(text) {
  validateTextSize(text, MAX_DRAWING_BYTES, 'DXF');
  if (text.includes('\0') || !/^\s*0\s*\r?\nSECTION\s*\r?\n/i.test(text) || !/\r?\n\s*0\s*\r?\nEOF\s*$/i.test(text)) throw new Error('DWG export requires a complete DXF drawing.');
}

/** The payload size sets a 60–188 second conversion budget. */
function writerTimeout(bytes) {
  return 60_000 + Math.min(128, Math.ceil(bytes / (1024 * 1024))) * 1000;
}

/** Keep runtime injection out of the native helper and use its private temporary directory. */
function writerEnvironment(workspace, inherited = process.env) {
  const env = { ...inherited };
  for (const name of Object.keys(env)) {
    if (/^(?:DOTNET_|CORECLR_|COMPLUS_|COR_|LD_|DYLD_)/i.test(name) || /^(?:NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/i.test(name)) delete env[name];
  }
  env.TMP = workspace;
  env.TEMP = workspace;
  return env;
}

function defaultLocations() {
  const { app } = require('electron');
  return app.isPackaged
    ? { directory: path.join(process.resourcesPath, 'dwg-writer'), manifest: path.join(app.getAppPath(), 'electron', 'dwg-writer-integrity.json') }
    : { directory: path.join(__dirname, '..', 'release', 'dwg-writer'), manifest: path.join(__dirname, '..', 'release', 'dwg-writer', 'integrity.json') };
}

function fileIdentity(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/** Hash through one bounded handle; refuse links, mutation and non-regular files. */
async function hashHelper(file, expectedSize, fileSystem) {
  const before = await fileSystem.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== expectedSize) throw new Error('DWG writer integrity check failed.');
  const handle = await fileSystem.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || fileIdentity(opened) !== fileIdentity(before)) throw new Error('DWG writer changed during its integrity check.');
    const hash = crypto.createHash('sha256');
    const chunk = Buffer.alloc(Math.min(1024 * 1024, expectedSize + 1));
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, expectedSize + 1 - size), null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > expectedSize) throw new Error('DWG writer changed during its integrity check.');
      hash.update(chunk.subarray(0, bytesRead));
    }
    if (size !== expectedSize || fileIdentity(await handle.stat()) !== fileIdentity(before)) throw new Error('DWG writer changed during its integrity check.');
    return { sha256: hash.digest('hex'), identity: fileIdentity(before), dev: before.dev, ino: before.ino };
  } finally { await handle.close(); }
}

/**
 * All executable paths originate here, never in renderer input. Packaged manifests are inside
 * the integrity-protected ASAR; the external helper and each managed dependency must match it.
 * @param {{ directory: string, manifest: string }} locations
 * @param {typeof fs} [fileSystem]
 */
async function verifyPortableWriter(locations, fileSystem = fs) {
  const directory = path.resolve(locations.directory);
  const folder = await fileSystem.lstat(directory);
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error('DWG writer directory is not a regular bundled directory.');
  const resolved = await fileSystem.realpath(directory);
  const manifestBytes = /** @type {Buffer} */ (await readLimitedFile(fileSystem, locations.manifest, MAX_REPORT_BYTES));
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { throw new Error('Invalid DWG writer integrity manifest.'); }
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 64) throw new Error('Invalid DWG writer integrity manifest.');
  const names = new Set();
  const verified = [];
  let total = 0;
  for (const item of manifest.files) {
    if (!item || typeof item.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(item.name) || item.name.endsWith('.') || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > MAX_HELPER_BYTES) throw new Error('Invalid DWG writer integrity manifest.');
    const key = item.name.toLowerCase();
    if (names.has(key) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(item.name)) throw new Error('Invalid DWG writer integrity manifest.');
    names.add(key);
    total += item.size;
    if (total > MAX_HELPER_BYTES) throw new Error('DWG writer bundle exceeds its supported size.');
    const file = path.join(directory, item.name);
    const result = await hashHelper(file, item.size, fileSystem);
    if (result.sha256 !== item.sha256) throw new Error('DWG writer integrity check failed.');
    verified.push({ file, identity: result.identity, dev: result.dev, ino: result.ino, size: item.size, sha256: item.sha256 });
  }
  if (!manifest.files.some((item) => item.name === HELPER_NAME)) throw new Error('DWG writer executable is missing from its integrity manifest.');
  // Additional DLLs could be automatically loaded by the runtime. A bundle may only contain
  // the verified files and its development manifest, never an unlisted executable dependency.
  const listed = await fileSystem.readdir(directory);
  if (listed.some((name) => name !== 'integrity.json' && !names.has(name.toLowerCase()))) throw new Error('DWG writer bundle contains an unverified file.');
  const check = async () => {
    const current = await fileSystem.lstat(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== folder.ino || current.dev !== folder.dev || await fileSystem.realpath(directory) !== resolved) throw new Error('DWG writer directory changed.');
    for (const item of verified) {
      const stat = await fileSystem.lstat(item.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== item.dev || stat.ino !== item.ino || stat.size !== item.size) throw new Error('DWG writer changed after its integrity check.');
      // Windows timestamps can collide or be restored after a same-size edit. Each admission
      // checks actual bounded bytes; harmless executable timestamp changes still pass.
      const result = await hashHelper(item.file, item.size, fileSystem);
      if (result.dev !== item.dev || result.ino !== item.ino || result.sha256 !== item.sha256) throw new Error('DWG writer changed after its integrity check.');
      item.identity = result.identity;
    }
    if ((await fileSystem.readdir(directory)).some((name) => name !== 'integrity.json' && !names.has(name.toLowerCase()))) throw new Error('DWG writer bundle contains an unverified file.');
  };
  await check();
  return { executable: path.join(directory, HELPER_NAME), check };
}

/** Pin the destination parent and existing file; detect another program changing either. */
async function destinationGuard(file, fileSystem = fs) {
  const parent = path.dirname(file);
  const resolved = await fileSystem.realpath(parent);
  const pinned = await fileSystem.stat(resolved);
  if (!pinned.isDirectory()) throw new Error('DWG export destination is not a directory.');
  const readTarget = async () => {
    try {
      const stat = await fileSystem.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('DWG export destination is not a regular file.');
      return fileIdentity(stat);
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const original = await readTarget();
  const check = async () => {
    const now = await fileSystem.stat(resolved);
    if (!now.isDirectory() || now.dev !== pinned.dev || now.ino !== pinned.ino || await fileSystem.realpath(parent) !== resolved) throw new Error('DWG export destination folder changed. Choose the destination again.');
    if (await readTarget() !== original) throw new Error('The destination DWG changed while exporting. Choose the destination again.');
  };
  await check();
  return check;
}

function verifyWriterReport(bytes, output) {
  let report;
  try { report = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('The DWG writer returned an invalid verification report.'); }
  if (report?.schemaVersion !== 1 || report.success !== true || report.outputFormat !== FORMAT || !/^[a-f0-9]{64}$/.test(report.outputSha256) || !Array.isArray(report.warnings) || report.warnings.length || !Array.isArray(report.errors) || report.errors.length) throw new Error('The DWG writer reported unsupported or incomplete drawing content. The destination was not changed.');
  if (report.processMemoryLimitBytes !== 1024 * 1024 * 1024 || !Number.isSafeInteger(report.inputEntityCount) || report.inputEntityCount < 0 || report.inputEntityCount > 250_000 || report.outputEntityCount !== report.inputEntityCount) throw new Error('The DWG writer did not verify its memory budget or retained entity count. The destination was not changed.');
  if (output.length < 128 || output.subarray(0, 6).toString('ascii') !== FORMAT || crypto.createHash('sha256').update(output).digest('hex') !== report.outputSha256) throw new Error('The DWG writer output did not match its verification report. The destination was not changed.');
  return report;
}

/**
 * @param {string} text
 * @param {{ fs?: typeof fs, locations?: () => { directory: string, manifest: string }, temporaryRoot?: string, signal?: AbortSignal, run?: typeof runBoundedWriter }} [opts]
 * @returns {Promise<Buffer>}
 */
async function convertDxfToDwg(text, opts = {}) {
  validateExportDxf(text);
  const fileSystem = opts.fs || fs;
  if (opts.signal?.aborted) throw new Error('DWG export canceled.');
  const installation = await verifyPortableWriter((opts.locations || defaultLocations)(), fileSystem);
  const temporaryRoot = path.resolve(opts.temporaryRoot || os.tmpdir());
  const workspace = await fileSystem.mkdtemp(path.join(temporaryRoot, 'jcad-dwg-'));
  const workspaceReal = await fileSystem.realpath(workspace);
  let keepWorkspace = false;
  try {
    await fileSystem.writeFile(path.join(workspace, 'input.dxf'), text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const checkLimits = async () => {
      const limits = /** @type {Array<[string, number]>} */ ([['output.dwg', MAX_DRAWING_BYTES], ['report.json', MAX_REPORT_BYTES]]);
      for (const [name, limit] of limits) {
        let stat;
        try { stat = await fileSystem.lstat(path.join(workspace, name)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('The DWG writer exceeded its output size limit or wrote an invalid output.');
      }
    };
    await installation.check();
    const log = await (opts.run || runBoundedWriter)(installation.executable, ['convert', 'input.dxf', 'output.dwg', 'report.json'], { cwd: workspace, env: writerEnvironment(workspace), signal: opts.signal, timeoutMs: writerTimeout(Buffer.byteLength(text, 'utf8')), checkLimits });
    if (Buffer.byteLength(log, 'utf8') > 1024 * 1024) throw new Error('The DWG writer exceeded its diagnostic size limit.');
    if (opts.signal?.aborted) throw new Error('DWG export canceled.');
    await checkLimits();
    await installation.check();
    const output = /** @type {Buffer} */ (await readLimitedFile(fileSystem, path.join(workspace, 'output.dwg'), MAX_DRAWING_BYTES));
    const report = /** @type {Buffer} */ (await readLimitedFile(fileSystem, path.join(workspace, 'report.json'), MAX_REPORT_BYTES));
    verifyWriterReport(report, output);
    return output;
  } catch (error) {
    let failure = error;
    if (error.code === 'DWG_STOP_UNCONFIRMED') keepWorkspace = true;
    if (error.code === 'DWG_WRITER_EXIT') {
      // The runner has acknowledged exit, so a bounded failure report can explain refusals.
      // A crash or missing/malformed report retains the generic failure; it never authorizes output.
      try {
        const reportFile = path.join(workspace, 'report.json');
        const info = await fileSystem.lstat(reportFile);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid failure report.');
        const bytes = /** @type {Buffer} */ (await readLimitedFile(fileSystem, reportFile, MAX_REPORT_BYTES));
        const report = JSON.parse(bytes.toString('utf8'));
        if (report?.schemaVersion === 1 && report.success === false && report.outputFormat === FORMAT && Array.isArray(report.errors) && report.errors.length > 0 && report.errors.length <= 10 && report.errors.every((message) => typeof message === 'string' && message.length > 0 && message.length <= 2000)) {
          failure = new Error(`DWG export refused: ${report.errors.join(' ').replace(/[\x00-\x1f\x7f]/g, ' ')} The destination was not changed.`);
        }
      } catch { /* Preserve the acknowledged process failure without trusting an invalid report. */ }
    }
    throw failure;
  } finally {
    // Only remove the exact fresh mkdtemp child while it still resolves to the pinned location.
    // A child whose stop was not acknowledged may still be writing: leave its directory alone.
    const relative = path.relative(temporaryRoot, workspace);
    if (!keepWorkspace && relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      const stat = await fileSystem.lstat(workspace).catch(() => null);
      if (stat?.isDirectory() && !stat.isSymbolicLink() && await fileSystem.realpath(workspace).catch(() => null) === workspaceReal) await fileSystem.rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** @param {{ platform?: string, fs?: typeof fs, locations?: () => { directory: string, manifest: string }, convert?: typeof convertDxfToDwg }} [opts] */
function createPortableDwgExporter(opts = {}) {
  let busy = false;
  let poisoned = false;
  const platform = opts.platform || process.platform;
  const fileSystem = opts.fs || fs;
  return {
    async status() {
      if (platform !== 'win32') return { available: false, reason: 'Portable DWG export is available in the Windows desktop edition.' };
      if (poisoned) return { available: false, reason: 'Restart JCad before another DWG export; its previous writer process could not be stopped.' };
      try { await verifyPortableWriter((opts.locations || defaultLocations)(), fileSystem); return { available: true }; }
      catch { return { available: false, reason: UNAVAILABLE }; }
    },
    async export(file, text, commit, signal) {
      if (platform !== 'win32') throw new Error('Portable DWG export is available in the Windows desktop edition.');
      if (poisoned) throw new Error('Restart JCad before another DWG export; its previous writer process could not be stopped.');
      if (busy) throw new Error('Another DWG export is already running. Wait for it to finish.');
      if (typeof file !== 'string' || !path.isAbsolute(file) || !/\.dwg$/i.test(file) || file.length > 4096 || file.includes('\0')) throw new Error('Invalid DWG export destination.');
      busy = true;
      try {
        validateExportDxf(text);
        const checkDestination = await destinationGuard(file, fileSystem);
        const check = async () => { if (signal?.aborted) throw new Error('DWG export canceled.'); await checkDestination(); };
        const data = await (opts.convert || convertDxfToDwg)(text, { locations: opts.locations, fs: fileSystem, signal });
        await check();
        await commit(file, data, check);
        return file;
      } catch (error) {
        if (error.code === 'DWG_STOP_UNCONFIRMED') poisoned = true;
        throw error;
      } finally {
        // Poisoned admission remains closed even after this failed request settles.
        if (!poisoned) busy = false;
      }
    },
  };
}

module.exports = { createPortableDwgExporter, convertDxfToDwg, verifyPortableWriter, verifyWriterReport, destinationGuard, validateExportDxf, writerTimeout, writerEnvironment, FORMAT, HELPER_NAME, MAX_REPORT_BYTES };
