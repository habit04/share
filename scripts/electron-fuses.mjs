/**
 * Electron fuses of the packaged application (security review E-15), shared by the build
 * configuration check (tests/packaging.test.ts) and the packaged smoke test
 * (scripts/packaged-smoke.mjs).
 *
 * The installers ship with (package.json build.electronFuses, flipped by electron-builder before
 * signing):
 *   RunAsNode                             off  ELECTRON_RUN_AS_NODE does not turn the signed binary into Node
 *   EnableNodeOptionsEnvironmentVariable  off  NODE_OPTIONS is ignored (no --require of other code, and V8
 *                                              heap flags cannot lift the DWG worker's limits)
 *   EnableNodeCliInspectArguments         off  --inspect / --inspect-brk are ignored (no debugger attach)
 *   OnlyLoadAppFromAsar                   on   the application code comes from app.asar only
 *
 * The end-to-end checks drive the application through Playwright, which attaches with --inspect.
 * The packaged smoke test therefore verifies the shipped fuses first, then switches only
 * EnableNodeCliInspectArguments back on in its own extracted / installed copy before driving it.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** Fuse states in the wire (@electron/fuses FuseState, which the package does not export). */
const DISABLE = 48;
const ENABLE = 49;

/** package.json build.electronFuses keys -> FuseV1Options names. */
export const SHIPPED_FUSES = Object.freeze({
  runAsNode: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  onlyLoadAppFromAsar: true,
});
const OPTION = /** @type {const} */ ({
  runAsNode: 'RunAsNode',
  enableNodeOptionsEnvironmentVariable: 'EnableNodeOptionsEnvironmentVariable',
  enableNodeCliInspectArguments: 'EnableNodeCliInspectArguments',
  onlyLoadAppFromAsar: 'OnlyLoadAppFromAsar',
});

/** @electron/fuses (a dependency of electron-builder). */
function fusesLib() {
  return require('@electron/fuses');
}

/**
 * The shipped fuses that do not have their intended state in `executable` (the Electron binary,
 * or the application's executable inside a macOS .app); empty when all are as intended.
 * @param {string} executable
 * @returns {Promise<string[]>}
 */
export async function shippedFuseProblems(executable) {
  const { getCurrentFuseWire, FuseV1Options } = fusesLib();
  const wire = await getCurrentFuseWire(executable);
  const problems = [];
  for (const [key, want] of Object.entries(SHIPPED_FUSES)) {
    const name = OPTION[/** @type {keyof typeof OPTION} */ (key)];
    const state = wire[FuseV1Options[name]];
    const expected = want ? ENABLE : DISABLE;
    if (state !== expected) problems.push(`${name} is ${state === ENABLE ? 'on' : state === DISABLE ? 'off' : `in state ${state}`}, expected ${want ? 'on' : 'off'}`);
  }
  return problems;
}

/**
 * Switch EnableNodeCliInspectArguments on in a copy that only the tests run, so Playwright can
 * attach; on macOS the copy is signed ad hoc again.
 * @param {string} executable
 */
export async function allowInspectForTests(executable) {
  const { flipFuses, FuseVersion, FuseV1Options } = fusesLib();
  await flipFuses(executable, { version: FuseVersion.V1, resetAdHocDarwinSignature: process.platform === 'darwin', [FuseV1Options.EnableNodeCliInspectArguments]: true });
}

/**
 * Do installers of `version` ship the fuses? From the release after 0.4.1; the packaged smoke test
 * of an older published release skips the check.
 * @param {string} version
 */
export function shipsFuses(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  if (!m) throw new Error(`Invalid version: ${version}`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return major > 0 || minor > 4 || (minor === 4 && patch > 1);
}
