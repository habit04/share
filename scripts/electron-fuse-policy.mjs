import { getCurrentFuseWire, FuseVersion, FuseV1Options } from '@electron/fuses';
import { join } from 'node:path';
import { shippingFuseValues, platformExecutables } from './electron-fuse-evidence.mjs';
export { platformExecutables, validateFuseEvidence } from './electron-fuse-evidence.mjs';
export function assertFusePolicy(wire, role = 'shipping') {
  if (!['shipping', 'test'].includes(role) || wire.version !== FuseVersion.V1) throw new Error('Unsupported executable role or fuse wire');
  const expected = { ...shippingFuseValues, EnableNodeCliInspectArguments: role === 'test' };
  for (const [name, enabled] of Object.entries(expected)) {
    if (wire[FuseV1Options[name]] !== (enabled ? 49 : 48)) throw new Error(`${role} fuse ${name} must be ${enabled ? 'enabled' : 'disabled'}`);
  }
  return { role, version: wire.version, ...expected };
}
export async function verifyExecutableFuses(executable, role = 'shipping') {
  return assertFusePolicy(await getCurrentFuseWire(executable), role);
}
export async function verifyPlatformFuses(dir, platform) {
  const evidence = [];
  for (const path of platformExecutables(platform)) evidence.push({ path, policy:await verifyExecutableFuses(join(dir, path), 'shipping') });
  return evidence;
}
