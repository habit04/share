/** A durable, bounded checkpoint of the desktop renderer's own DOM preferences. */
'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { atomicWriteFile, createWriteQueue } = require('./atomic-write.cjs');
const { readLimitedFile } = require('./resource-limits.cjs');

const MAX_PREFERENCE_BYTES = 8 * 1024 * 1024;
const MIGRATION_KEY = 'jcad-origin-migrated';
const CHECKPOINT_NAME = 'renderer-preferences.json';
const MIGRATION_NAME = 'renderer-origin-migrated';
const RENDERER_LOAD_TIMEOUT_MS = 15_000;
const PREFERENCE_CAPTURE_TIMEOUT_MS = 5_000;

/** Reject accessors and non-string values without executing renderer-supplied code. */
function preferenceDictionary(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values) ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(values)) || Object.getOwnPropertySymbols(values).length) {
    throw new Error('Invalid renderer preferences');
  }
  const result = Object.create(null);
  let bytes = 2;
  let count = 0;
  for (const key of Object.getOwnPropertyNames(values)) {
    const descriptor = Object.getOwnPropertyDescriptor(values, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') throw new Error('Invalid renderer preferences');
    if (key === MIGRATION_KEY) continue;
    // Account for actual UTF-8 JSON escaping, colon, commas and braces.
    bytes += Buffer.byteLength(JSON.stringify(key)) + 1 + Buffer.byteLength(JSON.stringify(descriptor.value)) + (count++ ? 1 : 0);
    if (bytes > MAX_PREFERENCE_BYTES) throw new Error('Renderer preferences exceed 8 MiB');
    result[key] = descriptor.value;
  }
  return result;
}

function decodePreferences(text) {
  if (typeof text !== 'string' || text.length > MAX_PREFERENCE_BYTES || Buffer.byteLength(text) > MAX_PREFERENCE_BYTES) throw new Error('Renderer preferences exceed 8 MiB');
  return preferenceDictionary(JSON.parse(text));
}

// The isolated world has its own intrinsics: application/plugin code cannot replace the
// storage methods or serializer. Bound the result before it crosses into the main process.
const SNAPSHOT_SCRIPT = `(() => {
  const values = Object.create(null), storage = globalThis.localStorage;
  const encoder = new TextEncoder(); let bytes = 2, count = 0;
  for (let i = 0; i < storage.length; i++) {
    const key = Storage.prototype.key.call(storage, i);
    if (key === null || key === ${JSON.stringify(MIGRATION_KEY)}) continue;
    const value = Storage.prototype.getItem.call(storage, key);
    if (value === null) continue;
    bytes += encoder.encode(JSON.stringify(key)).byteLength + 1 + encoder.encode(JSON.stringify(value)).byteLength + (count++ ? 1 : 0);
    if (bytes > ${MAX_PREFERENCE_BYTES}) throw new Error('Renderer preferences exceed 8 MiB');
    values[key] = value;
  }
  return JSON.stringify(values);
})()`;

function assertPreferencesRenderer(contents) {
  if (contents.isDestroyed() || contents.isCrashed()) throw new Error('No trusted preferences renderer');
  const url = new URL(contents.getURL());
  if (url.protocol !== 'jcad:' || url.hostname !== 'app' || url.port || url.username || url.password || url.pathname !== '/index.html') throw new Error('No trusted preferences renderer');
}

/**
 * Electron v44.7 defers executeJavaScriptInIsolatedWorld until the main frame stops loading.
 * Initial preload migration arrives before that point, so load readiness has its own bounded
 * phase. The execution deadline must measure capture time rather than bundled page startup.
 */
function waitForPreferencesRenderer(contents) {
  assertPreferencesRenderer(contents);
  if (!contents.isLoadingMainFrame()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      contents.removeListener('did-finish-load', onReady);
      contents.removeListener('did-stop-loading', onReady);
      contents.removeListener('did-fail-load', onFailed);
      contents.removeListener('did-fail-provisional-load', onFailed);
      contents.removeListener('render-process-gone', onGone);
      contents.removeListener('destroyed', onGone);
    };
    const finish = (/** @type {Error | null} */ error = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(undefined);
    };
    const onReady = () => {
      try {
        assertPreferencesRenderer(contents);
        // Match Electron's execution predicate: finish-load may precede stop-loading.
        if (!contents.isLoadingMainFrame()) finish();
      } catch (error) { finish(error); }
    };
    const onFailed = (_event, _code, _description, _url, isMainFrame) => {
      if (isMainFrame) finish(new Error('Renderer preference page failed to load'));
    };
    const onGone = () => finish(new Error('Renderer preference page stopped before it was ready'));
    contents.on('did-finish-load', onReady);
    contents.on('did-stop-loading', onReady);
    contents.on('did-fail-load', onFailed);
    contents.on('did-fail-provisional-load', onFailed);
    contents.on('render-process-gone', onGone);
    contents.on('destroyed', onGone);
    timer = setTimeout(() => finish(new Error('Renderer preference page load timed out')), RENDERER_LOAD_TIMEOUT_MS);
    // Close the state-check/listener-registration race without restarting either deadline.
    onReady();
  });
}

/** No renderer-chosen path or payload is accepted; capture only the built application page. */
async function snapshotPreferences(contents) {
  await waitForPreferencesRenderer(contents);
  assertPreferencesRenderer(contents);
  let timer;
  try {
    const text = await Promise.race([
      contents.executeJavaScriptInIsolatedWorld(999, [{ code: SNAPSHOT_SCRIPT }]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Renderer preference checkpoint timed out')), PREFERENCE_CAPTURE_TIMEOUT_MS); }),
    ]);
    return decodePreferences(text);
  } finally { clearTimeout(timer); }
}

/**
 * All captures and commits run in call order, including migration and close. A slow earlier
 * capture cannot replace a later setting change. Failed commits preserve the last checkpoint.
 * @param {{ stateDir: () => string, fs?: typeof fs, write?: typeof atomicWriteFile, snapshot?: typeof snapshotPreferences }} options
 */
function createPreferenceStore({ stateDir, fs: files = fs, write = atomicWriteFile, snapshot = snapshotPreferences }) {
  const enqueue = createWriteQueue();
  /** @type {Record<string, string> | null} */
  let latest = null;
  async function read() {
    const file = path.join(stateDir(), CHECKPOINT_NAME);
    try {
      const stat = await files.lstat(file);
      if (stat.isSymbolicLink()) throw new Error('Renderer preference checkpoint is a symbolic link');
      latest = decodePreferences(await readLimitedFile(files, file, MAX_PREFERENCE_BYTES, 'utf8'));
      return latest;
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }
  function checkpoint(contents, migration = false) {
    return enqueue('preferences', async () => {
      const values = preferenceDictionary(await snapshot(contents));
      const dir = stateDir();
      await files.mkdir(dir, { recursive: true });
      await write(path.join(dir, CHECKPOINT_NAME), JSON.stringify(values));
      latest = values;
      // A permanent migration marker must never outrun the durable preference checkpoint.
      if (migration) await write(path.join(dir, MIGRATION_NAME), '1');
      return values;
    });
  }
  return { read, checkpoint, latest: () => latest };
}

module.exports = { MAX_PREFERENCE_BYTES, MIGRATION_KEY, CHECKPOINT_NAME, MIGRATION_NAME, preferenceDictionary, decodePreferences, SNAPSHOT_SCRIPT, snapshotPreferences, createPreferenceStore };
