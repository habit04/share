/** Read-only compatibility helpers for the shipping fuse policy.
 * Shipping installers retain their signed bytes during smoke tests. Full Playwright
 * coverage uses the separate, unpublished inspection-enabled test ASAR.
 */
export const SHIPPED_FUSES = Object.freeze({
  runAsNode: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  grantFileProtocolExtraPrivileges: false,
});

/** @param {string} executable @returns {Promise<string[]>} */
export async function shippedFuseProblems(executable) {
  try {
    const { verifyExecutableFuses } = await import('./electron-fuse-policy.mjs');
    await verifyExecutableFuses(executable, 'shipping');
    return [];
  } catch (error) {
    return [error.message];
  }
}

/** Historical released versions before 0.4.2 predate the upstream fuse contract.
 * Current build-only gates always require the actual shipping fuse policy,
 * independently of this legacy version predicate.
 * @param {string} version
 */
export function shipsFuses(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  if (!m) throw new Error(`Invalid version: ${version}`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return major > 0 || minor > 4 || (minor === 4 && patch > 1);
}
