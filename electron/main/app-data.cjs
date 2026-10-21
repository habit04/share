/**
 * The main process's own files in the app-data folder and its diagnostics: where they live,
 * crash-safe writes (one at a time per file, in call order) of its state files (recent.json,
 * window-state.json) and of user files (drawings, projects, exports), and error.log, where
 * main-process failures go (uncaught exceptions, crashed renderers and helper processes).
 */
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { atomicWriteFile, createCanonicalWriteQueue } = require('../atomic-write.cjs');
const { createPreferenceStore, CHECKPOINT_NAME } = require('../renderer-preferences.cjs');
const { shouldLogChildProcessGone } = require('../dwg-exit-policy.cjs');

const stateDir = () => app.getPath('userData');
const recentFile = () => path.join(stateDir(), 'recent.json');
const windowStateFile = () => path.join(stateDir(), 'window-state.json');
const autosaveDir = () => path.join(stateDir(), 'autosave');
const rendererPreferences = createPreferenceStore({ stateDir });
const readRendererPreferences = rendererPreferences.read;
/** Whether a path currently exists (any error other than absence counts as unknown → false). */
async function pathExists(file) { try { await fs.stat(file); return true; } catch { return false; } }
/**
 * Move an unreadable renderer-preferences checkpoint aside (PR23 ASAR rounds 3-4): the
 * bytes are preserved at renderer-preferences.json.unreadable-<timestamp>, never deleted,
 * so the startup gate can let the normal writers resume on a fresh checkpoint while the
 * unreadable evidence survives. fs.rename REPLACES an existing destination on Windows,
 * so when the timestamped name is already taken (an earlier preserved checkpoint) a
 * counter suffix is added until the name is free — an existing file is never replaced.
 * Rejects when the rename fails.
 * @returns {Promise<string>} the path the checkpoint was moved to
 */
async function renameUnreadableCheckpoint() {
  const from = path.join(stateDir(), CHECKPOINT_NAME);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let aside = `${from}.unreadable-${stamp}`;
  for (let counter = 2; await pathExists(aside); counter += 1) aside = `${from}.unreadable-${stamp}-${counter}`;
  await fs.rename(from, aside);
  return aside;
}
const checkpointRendererPreferences = rendererPreferences.checkpoint;
const latestRendererPreferences = rendererPreferences.latest;
/** Writes of the same app-data file (recent list, window state) run one at a time, in call order. */
const enqueueWrite = createCanonicalWriteQueue();
/** Crash-safe write of a small app-data file; failures are logged, never shown (the app keeps working). */
function writeStateFile(file, text, what) {
  return enqueueWrite(file, async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWriteFile(file, text);
  }).catch((err) => logMainError(what, err));
}
/**
 * Crash-safe write of a user file (drawing, project, export). Writes of one file run one at a time,
 * in the order the requests arrived. Canonical parent paths make real folders, linked aliases
 * and case aliases share a queue; asynchronous resolution cannot reorder its reservations.
 * The renderer orders the saves of one file by revision (src/app/savequeue.ts), but a
 * Save As (and a save whose path needed the dialog) only learns its file here: without this queue
 * a slower Save of the same file that started earlier could land after it and replace the newer
 * content while the drawing is shown as saved.
 */
function writeUserFile(file, data, opts) {
  return enqueueWrite(file, (key) => atomicWriteFile(file, data, { ...opts, expectedDestination: key }));
}

// Main-process failures go to a log the user can send with a problem report.
const errorLog = () => path.join(stateDir(), 'error.log');
function logMainError(kind, err) {
  const line = `[${new Date().toISOString()}] ${kind}: ${err && err.stack ? err.stack : String(err)}\n`;
  try {
    fsSync.mkdirSync(stateDir(), { recursive: true });
    fsSync.appendFileSync(errorLog(), line);
  } catch {
    /* nothing else we can do */
  }
}
/** Flush queued DOM storage while its renderer still exists; Electron exposes no durability acknowledgement. @param {Electron.WebContents} contents */
function flushRendererPreferences(contents) {
  try {
    contents.session.flushStorageData();
    return true;
  } catch (err) {
    logMainError('renderer preference persistence', err);
    return false;
  }
}
/** Uncaught exceptions, unhandled rejections and crashed renderer / helper processes go to error.log. */
function installCrashLogging() {
  process.on('uncaughtException', (err) => logMainError('uncaughtException', err));
  process.on('unhandledRejection', (err) => logMainError('unhandledRejection', err));
  app.on('render-process-gone', (_ev, _wc, details) => logMainError('render-process-gone', new Error(`${details.reason} (exit code ${details.exitCode})`)));
  app.on('child-process-gone', (_ev, details) => {
    if (shouldLogChildProcessGone(details)) logMainError('child-process-gone', new Error(`${details.type} ${details.reason}`));
  });
}

module.exports = { stateDir, recentFile, windowStateFile, autosaveDir, enqueueWrite, writeStateFile, writeUserFile, logMainError, flushRendererPreferences, readRendererPreferences, renameUnreadableCheckpoint, checkpointRendererPreferences, latestRendererPreferences, installCrashLogging };
