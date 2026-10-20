/**
 * The startup legacy-storage migration gate (P-MIG), extracted from electron/main.cjs so the
 * decision is importable and the migration tests drive the production code instead of a
 * mirrored copy. This module is Electron-free: every effect arrives through the injected
 * dependencies, which the entry point binds to the real units (app-data's preference store,
 * the state folder, renderer-origin's legacyStorage with its window arguments bound).
 *
 * Ported to this line from the P-MIG source (electron/main/startup-migration.cjs, gate at
 * lines 44-66) as part of the PR23 ASAR fix. This line's legacyStorage resolves a
 * dictionary (or null for an incomplete read) and throws on failure, so the entry point's
 * runLegacy binding adapts it to the { values, ok } outcome this gate consumes.
 *
 * Round-2/3 extension on this line (lead rulings, PR23 ASAR fix gates): a checkpoint-READ
 * failure additionally sets ctx.checkpointUnreadable. P-MIG left a corrupt checkpoint to
 * self-heal via the next committed checkpoint; this line's data-protection rule is
 * stricter — while the flag stands, neither the migrated checkpoint nor a close-time
 * checkpoint may overwrite the unreadable checkpoint file or write the migration
 * marker. Since round 3 the gate also tries to rename the unreadable file aside
 * (renderer-preferences.json.unreadable-<timestamp>, bytes preserved, never deleted):
 * only a successful rename clears the flag, so the normal writers resume on a fresh
 * checkpoint while the evidence survives; a failed rename keeps the guard, and the
 * next launch retries. The gate below is P-MIG's except for exactly this
 * checkpoint-read tracking and recovery.
 *
 * The gate, in order: a committed preference checkpoint is the startup storage and no
 * migration runs; if the migration marker already exists, there is no startup storage; only
 * otherwise - and only when the legacy store is present - the extraction leg runs.
 *
 * The failure flag (ctx.legacyMigrationFailed) means "the legacy-migration LEG failed": the
 * extraction resolved { ok: false }, or the leg itself threw - the hidden window's
 * construction throws outside legacyStorage's own handling and propagates as its rejection.
 * A throw anywhere else in the gate does NOT set it - in particular a checkpoint-READ
 * failure sets the separate ctx.checkpointUnreadable instead (rounds 2-3, see above):
 * with THAT flag standing, the checkpoint file and the marker are protected from
 * overwrite; a successful rename-aside clears it again within the same gate run.
 * Every throw is logged exactly once, here, and startup
 * continues with no startup storage: an unreadable/corrupt checkpoint must not fall back
 * to stale legacy values.
 */

/** @typedef {import('./context.cjs').MainContext} MainContext */

/** @typedef {{ values: Record<string, string>, source: 'checkpoint' | 'legacy' }} StartupStorage */

/**
 * @typedef {object} StartupMigrationDeps
 * @property {MainContext} ctx  the shared context: the gate writes ctx.legacyMigrationFailed
 * @property {() => Promise<Record<string, string> | null>} readCheckpoint  the last committed preference snapshot, or null when none is committed
 * @property {() => Promise<string>} renameCheckpointAside  move the unreadable checkpoint file aside (bytes preserved); resolves to the new path, rejects when the rename fails
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
  const { ctx, readCheckpoint, renameCheckpointAside, markerExists, legacyStoreExists, runLegacy, logError } = deps;
  let checkpoint;
  try {
    checkpoint = await readCheckpoint();
  } catch (readError) {
    // Rounds 2-3 (see the header): an unreadable checkpoint — corrupt or over the
    // size limit — is protected from overwrite, and the gate tries to rename it
    // aside. Only a successful rename clears the protection, letting the normal
    // writers resume on a fresh checkpoint; a failed rename keeps the guard for
    // the whole launch. Startup continues with no stored values either way: an
    // unreadable checkpoint never falls back to stale legacy values.
    ctx.checkpointUnreadable = true;
    logError('renderer preference migration', readError);
    try {
      const aside = await renameCheckpointAside();
      ctx.checkpointUnreadable = false;
      logError('renderer preference migration', new Error(`Unreadable checkpoint preserved at ${aside}`));
    } catch { /* the guard stands; the read failure above is the logged error */ }
    return null;
  }
  let migrationLegThrew = false;
  try {
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
