// New builds must pass secure-origin migration; existing pre-migration releases remain testable.
import versionTools from '../electron/version.cjs';
import { basename } from 'node:path';

export function needsPackagedOrigin(version) {
  const parsed = versionTools.parseVersion(version);
  if (!parsed) throw new Error(`Invalid packaged smoke version: ${version}`);
  const [major, minor, patch] = parsed.parts;
  return major > 0 || minor > 4 || (minor === 4 && patch >= 1);
}

export function needsPortableDwgExport(version, platform = process.platform) {
  const parsed = versionTools.parseVersion(version);
  if (!parsed) throw new Error(`Invalid packaged smoke version: ${version}`);
  const [major, minor, patch] = parsed.parts;
  return platform === 'win32' && (major > 0 || minor > 4 || (minor === 4 && patch >= 6));
}

export function needsPortableDwgSave(version, platform = process.platform) {
  const parsed = versionTools.parseVersion(version);
  if (!parsed) throw new Error(`Invalid packaged smoke version: ${version}`);
  const [major, minor, patch] = parsed.parts;
  return platform === 'win32' && (major > 0 || minor > 4 || (minor === 4 && patch >= 7));
}

export function needsRotatedLayoutViewports(version, platform = process.platform) {
  const parsed = versionTools.parseVersion(version);
  if (!parsed) throw new Error(`Invalid packaged smoke version: ${version}`);
  const [major, minor, patch] = parsed.parts;
  return platform === 'win32' && (major > 0 || minor > 4 || (minor === 4 && patch >= 8));
}

export function processResult(result) {
  if (result.error) return `error: ${result.error.message}`;
  if (result.signal) return `signal: ${result.signal}`;
  return `exit: ${result.status}`;
}

/** spawnSync may report status0 after a timeout; errors/signals still make the process fail. */
export function childSucceeded(result) {
  return result.status === 0 && !result.error && !result.signal;
}

export function dwgProbeSucceeded(result, line, version = '0.4.4') {
  const decoded = /^PROBE_OK (\S+) entities=(\d+) blocks=(\d+)(?:\s|$)/.exec(line);
  if (!childSucceeded(result) || !decoded || decoded[1] === 'invalid' || Number(decoded[2]) <= 0) return false;
  const parsed = versionTools.parseVersion(version);
  if (!parsed) throw new Error(`Invalid packaged smoke version: ${version}`);
  const [major, minor, patch] = parsed.parts;
  const containmentRequired = major > 0 || minor > 4 || (minor === 4 && patch >= 5);
  // The smoke driver always supplies the committed example_2000.dwg fixture.
  return !containmentRequired || (decoded[1] === 'r2000' && Number(decoded[2]) === 67 && Number(decoded[3]) === 16 && /\bisolated=1 recovery=1\s*$/.test(line));
}

/** Native release jobs must identify their expected architecture and run on that host. */
export function validateSmokeArchitecture(hostArch, expectedArch = '', nativeOnly = false) {
  if (nativeOnly && !expectedArch) throw new Error('Native-only smoke requires JCAD_SMOKE_EXPECT_ARCH.');
  if (expectedArch && !['arm64', 'x64'].includes(expectedArch)) throw new Error(`Unsupported expected smoke architecture: ${expectedArch}`);
  if (expectedArch && hostArch !== expectedArch) throw new Error(`Packaged smoke requires native ${expectedArch}, but this process is ${hostArch}.`);
}

/** Strict native mode requires its named DMG; default/manual mode can also test Rosetta. */
export function macDmgTargets(files, { hostArch, expectedArch = '', nativeOnly = false, rosetta = false }) {
  validateSmokeArchitecture(hostArch, expectedArch, nativeOnly);
  if (!['arm64', 'x64'].includes(hostArch)) throw new Error(`Unsupported macOS smoke architecture: ${hostArch}`);
  const architecture = (file) => /-mac-(arm64|x64)\.dmg$/i.exec(basename(file))?.[1].toLowerCase();
  const legacyArchitecture = (file) => /(arm64|x64)/i.exec(basename(file))?.[1].toLowerCase();
  const dmgs = files.filter((file) => /\.dmg$/i.test(file));
  if (nativeOnly) {
    const native = dmgs.filter((file) => architecture(file) === expectedArch);
    if (!native.length) throw new Error(`No required native macOS ${expectedArch} DMG was found.`);
    return native;
  }
  return dmgs
    .filter((file) => !legacyArchitecture(file) || legacyArchitecture(file) === hostArch || (hostArch === 'arm64' && rosetta && legacyArchitecture(file) === 'x64'))
    .sort((a, b) => Number(legacyArchitecture(b) === hostArch) - Number(legacyArchitecture(a) === hostArch));
}
