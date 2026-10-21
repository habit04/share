/**
 * The startup legacy-storage migration gate (P-MIG), extracted from electron/main.cjs so the
 * decision is importable and the migration tests drive the production code instead of a
 * mirrored copy. This module is Electron-free: every effect arrives through the injected
 * dependencies, which the entry point binds to the real units (app-data's preference store,
 * the state folder, renderer-origin's legacyStorage with its window arguments bound).
 *
 * The gate, in order: a committed preference checkpoint is the startup storage and no
 * migration runs; if the migration marker already exists, there is no startup storage; only
 * otherwise - and only when the legacy store is present - the extraction leg runs.
 *
 * The failure flag (ctx.legacyMigrationFailed) means "the legacy-migration LEG failed": the
 * extraction resolved { ok: false }, or the leg itself threw - the hidden window's
 * construction throws outside legacyStorage's own handling and propagates as its rejection.
 * A throw anywhere else in the gate does NOT set it - in particular a checkpoint-READ
 * failure: with the flag standing, the close-time checkpoint is skipped, so a permanently
 * corrupt checkpoint would never be overwritten on a normal close as it always has been,
 * and could never self-heal. Every throw is logged exactly once, here, and startup
 * continues with no startup storage: an unreadable/corrupt checkpoint must not fall back
 * to stale legacy values.
 */

/** @typedef {import('./context.cjs').MainContext} MainContext */

/** @typedef {{ values: Record<string, string>, source: 'checkpoint' | 'legacy' }} StartupStorage */

/**
 * @typedef {object} StartupMigrationDeps
 * @property {MainContext} ctx  the shared context: the gate writes ctx.legacyMigrationFailed
 * @property {() => Promise<Record<string, string> | null>} readCheckpoint  the last committed preference snapshot, or null when none is committed
 * @property {() => boolean} markerExists  the renderer-origin-migrated marker file is present
 * @property {() => boolean} legacyStoreExists  the legacy Local Storage leveldb is present
 * @property {() => Promise<{ values: Record<string, string> | null, ok: boolean }>} runLegacy  the legacy extraction, its window arguments bound by the caller
 * @property {(kind: string, error: unknown) => void} logError  main-process error logging (app-data's logMainError)
 */

/**
 * Run the startup migration gate and return the startup storage the renderer is served
 * from, or null when there is none (the marker already exists, the extraction declined an
 * oversize store, or the gate threw and startup proceeds without stored values).
 * @param {StartupMigrationDeps} deps
 * @returns {Promise<StartupStorage | null>}
 */
async function runStartupMigration(deps) {
  const { ctx, readCheckpoint, markerExists, legacyStoreExists, runLegacy, logError } = deps;
  let migrationLegThrew = false;
  try {
    const checkpoint = await readCheckpoint();
    if (checkpoint !== null) return { values: checkpoint, source: 'checkpoint' };
    if (markerExists()) return null;
    let outcome;
    try {
      outcome = legacyStoreExists() ? await runLegacy() : { values: {}, ok: true };
    } catch (legError) {
      migrationLegThrew = true;
      throw legError;
    }
    ctx.legacyMigrationFailed = !outcome.ok;
    return outcome.values === null ? null : { values: outcome.values, source: 'legacy' };
  } catch (error) {
    // Only a failed migration leg keeps the retry (see the header); every throw is
    // logged exactly as the entry point's inline block logged it.
    if (migrationLegThrew) ctx.legacyMigrationFailed = true;
    logError('renderer preference migration', error);
    return null;
  }
}

module.exports = { runStartupMigration };
