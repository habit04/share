// New builds must pass secure-origin migration; existing pre-migration releases remain testable.
import versionTools from '../electron/version.cjs';
import { basename } from 'node:path';

export function needsPackagedOrigin(version) {
  const parsed = versionTools.parseVersion(version);
  if (!parsed) throw new Error(`Invalid packaged smoke version: ${version}`);
  const [major, minor, patch] = parsed.parts;
  return major > 0 || minor > 4 || (minor === 4 && patch >= 1);
}

/** Historical installers remain testable; every 0.5 prerelease and later requires actual 3D. */
export function needsExperimental3d(version) {
  const parsed = versionTools.parseVersion(version);
  if (!parsed) throw new Error(`Invalid packaged smoke version: ${version}`);
  const [major, minor] = parsed.parts;
  return major > 0 || minor >= 5;
}

/** New default-on tools must be lazy; the published 0.5.0 opt-in installer remains testable. */
export function needsDefault3dTools(version) {
  const parsed = versionTools.parseVersion(version);
  if (!parsed) throw new Error(`Invalid packaged smoke version: ${version}`);
  const [major, minor, patch] = parsed.parts;
  return major > 0 || minor > 5 || (minor === 5 && patch >= 1);
}

/** Source candidates always prove lazy defaults, persisted opt-out and separate restart launches. */
export function shipping3dProbePhases(version, { source = false } = {}) {
  if (!needsExperimental3d(version)) return [];
  const defaultsRequired = needsDefault3dTools(version) || source;
  return [...(defaultsRequired ? ['3d-default'] : []), '3d-enable', '3d'];
}

/** Fresh-profile evidence must show available tools, inactive resources and persisted opt-out. */
export function default3dToolsProbeSucceeded(record) {
  const flags = ['toolsAvailable', 'controllerInstalled', 'controllerInactive', 'canvasDefault', 'no3dCanvas', 'kernelUnstarted', 'foreignImportDisabled', 'optionInitiallyChecked', 'disabledPersisted', 'controllerStillInactive', 'restartRequired'];
  return !!record && flags.every(key => record[key] === true) && record.phase === '3d-default' && record.testBuild === false && record.beforeRenderer === 'Canvas 2D';
}

/** Installed evidence must cover the real opt-in restart, rendering, worker and both saves. */
export function experimental3dProbeSucceeded(record) {
  const flags = ['optionRestarted', 'webgl2', 'visibleInk', 'gpuPicked', 'kernelWorker', 'dxfSaveAsReopened', 'dwgRefused', 'canvasRestored', 'workerDisposed', 'dxfSecondSaveReopened', 'backupExact', 'sourceUnchanged'];
  if (!record || flags.some(key => record[key] !== true)) return false;
  return record.phase === '3d' && record.testBuild === false && /^Manifold .* \(worker\)$/.test(record.kernelName) && record.workers === 1 && Number.isFinite(record.unionVolume) && Math.abs(record.unionVolume - 1.5) < 1e-9 && record.secondSaveEntities === 2 && record.beforeRenderer === 'Canvas 2D' && record.activeRenderer === 'WebGL2 experimental 3D modelling viewport' && record.afterRenderer === 'Canvas 2D' && /WebGL 2/.test(record.capabilities?.version) && Number.isInteger(record.capabilities?.maxTextureSize) && record.capabilities.maxTextureSize > 0 && ['sourceSha256', 'firstSaveSha256', 'outputSha256', 'backupSha256'].every(key => typeof record[key] === 'string' && /^[a-f0-9]{64}$/.test(record[key])) && record.backupSha256 === record.firstSaveSha256 && record.outputSha256 !== record.firstSaveSha256;
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

export function needsDwgMetadataPreservation(version, platform = process.platform) {
  const parsed = versionTools.parseVersion(version);
  if (!parsed) throw new Error(`Invalid packaged smoke version: ${version}`);
  const [major, minor, patch] = parsed.parts;
  return platform === 'win32' && (major > 0 || minor > 4 || (minor === 4 && patch >= 9));
}

export const METADATA_SMOKE_FIXTURES = Object.freeze([
  Object.freeze({ name: 'r2018-views-fields', file: 'shipping-metadata-views-fields.dwg', sha256: '5f5a9bd4a0ffd2e545f6f5404bed9edb27f2c41411c3b26a264f0696a649f105', entities: 3, fields: 2 }),
  Object.freeze({ name: 'r2018-field-object-reference', file: 'shipping-metadata-object-reference.dwg', sha256: '78f2e61f66e84f2e24d589071faf0afe3a68d0127405e7a53fbd5ebc020749c6', entities: 4, fields: 4 }),
  Object.freeze({ name: 'r2018-unicode-metadata', file: 'shipping-metadata-unicode.dwg', sha256: 'cf75bd2670ad88b29694fa4f96db4309fc2f8689f7bfa63cf9d0906447cb54f6', entities: 4, fields: 4 }),
]);
export const METADATA_SMOKE_FLAGS = Object.freeze(['metadataNamedViews', 'metadataFields', 'metadataXRecords', 'metadataReferences', 'metadataConnectedCopy', 'metadataSaveReopen', 'metadataDeleteRefused', 'metadataAnnotationSettings']);

/** Production metadata evidence comes only from the fixed private-profile probe. */
export function metadataProbeSucceeded(record) {
  if (!record || METADATA_SMOKE_FLAGS.some(key => record[key] !== true) || record.metadataEvidence?.schemaVersion !== 1 || !Array.isArray(record.metadataEvidence.fixtures) || record.metadataEvidence.fixtures.length !== METADATA_SMOKE_FIXTURES.length) return false;
  return METADATA_SMOKE_FIXTURES.every(pin => {
    const matches = record.metadataEvidence.fixtures.filter(value => value && typeof value === 'object' && value.name === pin.name);
    if (matches.length !== 1) return false;
    const value = matches[0];
    const snapshot = value.metadataSnapshot;
    if (!Array.isArray(snapshot?.entities) || !Array.isArray(snapshot?.views) || !Array.isArray(snapshot?.records) || snapshot.entities.length !== pin.entities * 2 || snapshot.views.length !== 3 || snapshot.records.filter(record => record?.type === 'FIELD').length !== pin.fields * 2) return false;
    const edited = pin.name === 'r2018-views-fields', annotations = value.annotationSettings;
    for (const observed of [snapshot.annotationSettings, annotations?.edited, annotations?.saveAsReopened, annotations?.saveReopened]) {
      if (observed?.cannoscale !== (edited ? '1:2' : '1:1') || observed?.annoAllVisible !== !edited) return false;
    }
    const literal = pin.name === 'r2018-unicode-metadata' ? 'Unicode Δ 雷 F0A \\U+0041 JSON {"literal":"\\\\U+0041","unicode":"Δ雷","hex":"F0A"}' : 'Payload F0A is literal text';
    const payload = snapshot.records.find(record => record?.type === 'XRECORD' && Array.isArray(record.groups) && record.groups.some(group => Array.isArray(group) && group[0] === 1 && group[1] === literal));
    if (!payload || !payload.groups.some(group => group[0] === 160 && group[1] === '9007199254740993') || !payload.groups.some(group => group[0] === 310 && group[1] === '00017F80FF')) return false;
    return value.sourceSha256 === pin.sha256 && Number.isSafeInteger(value.sourceBytes) && value.sourceBytes > 0 && value.sourceBytes <= 8 * 1024 * 1024 && value.entities === pin.entities && value.fields === pin.fields && value.views === 3 && value.copiedEntities === pin.entities * 2 && value.copiedFields === pin.fields * 2 && value.finalEntities === pin.entities * 2 && value.finalFields === pin.fields * 2 && ['sourceUnchanged', 'saveAsBackup', 'saveBackup', 'saveAsReopened', 'saveReopened', 'connectedReferences', 'opaqueLiteralPreserved', 'atomicDeleteRefused'].every(key => value[key] === true) && ['saveAsSha256', 'outputSha256', 'backupSha256'].every(key => typeof value[key] === 'string' && /^[a-f0-9]{64}$/.test(value[key])) && value.backupSha256 === value.saveAsSha256 && value.outputSha256 !== value.saveAsSha256;
  });
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
