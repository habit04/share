// New builds must pass secure-origin migration; existing pre-migration releases remain testable.
import versionTools from '../electron/version.cjs';

export function needsPackagedOrigin(version) {
  const parsed = versionTools.parseVersion(version);
  if (!parsed) throw new Error(`Invalid packaged smoke version: ${version}`);
  const [major, minor, patch] = parsed.parts;
  return major > 0 || minor > 4 || (minor === 4 && patch >= 1);
}

export function processResult(result) {
  if (result.error) return `error: ${result.error.message}`;
  if (result.signal) return `signal: ${result.signal}`;
  return `exit: ${result.status}`;
}
