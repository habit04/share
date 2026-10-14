import { describe, expect, it } from 'vitest';
import { needsPackagedOrigin, needsExperimental3d, experimental3dProbeSucceeded, needsPortableDwgExport, needsPortableDwgSave, needsRotatedLayoutViewports, needsDwgMetadataPreservation, metadataProbeSucceeded, METADATA_SMOKE_FIXTURES, METADATA_SMOKE_FLAGS, processResult, childSucceeded, dwgProbeSucceeded, validateSmokeArchitecture, macDmgTargets } from '../scripts/packaged-smoke-policy.mjs';

describe('installed experimental 3D shipping gate', () => {
  it('requires every 0.5 prerelease and later release while preserving historical smoke support', () => {
    for (const version of ['0.5.0', 'v0.5.0-alpha.1', '0.5.1', '0.6.0', '1.0.0', '1.0.0-rc.1', '2.0.0']) expect(needsExperimental3d(version), version).toBe(true);
    for (const version of ['0.4.9', '0.4.99', 'v0.4.9-beta.1', '0.3.0']) expect(needsExperimental3d(version), version).toBe(false);
    expect(() => needsExperimental3d('invalid')).toThrow(/Invalid packaged smoke version/);
  });
  it('requires actual render/worker/restart/save/refusal evidence and exact first-save backup hashes', () => {
    const flags = ['optionRestarted', 'webgl2', 'visibleInk', 'gpuPicked', 'kernelWorker', 'dxfSaveAsReopened', 'dwgRefused', 'canvasRestored', 'workerDisposed', 'dxfSecondSaveReopened', 'backupExact', 'sourceUnchanged'];
    const valid = { ...Object.fromEntries(flags.map(key => [key, true])), phase: '3d', testBuild: false, kernelName: 'Manifold 3.5.4 (worker)', workers: 1, unionVolume: 1.5, secondSaveEntities: 2, beforeRenderer: 'Canvas 2D', activeRenderer: 'WebGL2 experimental 3D modelling viewport', afterRenderer: 'Canvas 2D', capabilities: { version: 'WebGL 2.0 (OpenGL ES 3.0 Chromium)', maxTextureSize: 16384 }, sourceSha256: '0'.repeat(64), firstSaveSha256: '1'.repeat(64), outputSha256: '2'.repeat(64), backupSha256: '1'.repeat(64) };
    expect(experimental3dProbeSucceeded(valid)).toBe(true);
    for (const key of flags) for (const value of [false, undefined, 'true']) expect(experimental3dProbeSucceeded({ ...valid, [key]: value }), key).toBe(false);
    for (const changed of [
      { phase: '3d-enable' }, { testBuild: true }, { kernelName: 'Manifold 3.5.4 (in-process)' }, { workers: 0 }, { workers: 2 },
      { unionVolume: NaN }, { unionVolume: Infinity }, { unionVolume: 1 }, { secondSaveEntities: 1 },
      { beforeRenderer: 'GPU' }, { activeRenderer: 'Canvas 2D' }, { afterRenderer: valid.activeRenderer },
      { capabilities: { version: 'WebGL 1.0', maxTextureSize: 16384 } }, { capabilities: { version: 'WebGL 2.0', maxTextureSize: 0 } },
      { sourceSha256: '' }, { firstSaveSha256: 'broken' }, { backupSha256: valid.outputSha256 }, { outputSha256: valid.firstSaveSha256 },
    ]) expect(experimental3dProbeSucceeded({ ...valid, ...changed }), JSON.stringify(changed)).toBe(false);
    expect(experimental3dProbeSucceeded(null)).toBe(false);
    expect(experimental3dProbeSucceeded({})).toBe(false);
  });
});

describe('portable DWG shipping gate', () => {
  it('requires fixed metadata preservation evidence in Windows 0.4.9 and keeps old/platform-paused installers testable', () => {
    for (const version of ['0.4.9', '0.4.9-beta.1', 'v0.4.10', '0.5.0', '1.0.0']) {
      expect(needsDwgMetadataPreservation(version, 'win32')).toBe(true);
      for (const platform of ['darwin', 'linux']) expect(needsDwgMetadataPreservation(version, platform)).toBe(false);
    }
    for (const version of ['0.4.8', '0.4.8-beta.1', '0.3.0']) expect(needsDwgMetadataPreservation(version, 'win32')).toBe(false);
    expect(() => needsDwgMetadataPreservation('invalid', 'win32')).toThrow(/Invalid packaged smoke version/);
  });
  it('requires all three pinned metadata preimages, counts, fresh reopens, exact backup and changed output evidence', () => {
    const valid = {
      ...Object.fromEntries(METADATA_SMOKE_FLAGS.map(key => [key, true])),
      metadataEvidence: { schemaVersion: 1, fixtures: METADATA_SMOKE_FIXTURES.map(pin => ({
        name: pin.name, sourceSha256: pin.sha256, sourceBytes: 1024, entities: pin.entities, fields: pin.fields, views: 3,
        copiedEntities: pin.entities * 2, copiedFields: pin.fields * 2, finalEntities: pin.entities * 2, finalFields: pin.fields * 2,
        sourceUnchanged: true, saveAsBackup: true, saveBackup: true, saveAsReopened: true, saveReopened: true,
        connectedReferences: true, opaqueLiteralPreserved: true, atomicDeleteRefused: true,
        annotationSettings: Object.fromEntries(['edited', 'saveAsReopened', 'saveReopened'].map(stage => [stage, { cannoscale: pin.name === 'r2018-views-fields' ? '1:2' : '1:1', annoAllVisible: pin.name !== 'r2018-views-fields' }])) as Record<string, { cannoscale: string; annoAllVisible: boolean }>,
        metadataSnapshot: {
          annotationSettings: { cannoscale: pin.name === 'r2018-views-fields' ? '1:2' : '1:1', annoAllVisible: pin.name !== 'r2018-views-fields' },
          entities: Array.from({ length: pin.entities * 2 }, () => ({ type: 'line' })), views: [{ name: 'SITE_NORTH' }, { name: 'SITE_ANGLE' }, { name: 'FUTURE_3D' }],
          records: [...Array.from({ length: pin.fields * 2 }, () => ({ type: 'FIELD', groups: [] as Array<[number, string]> })), { type: 'XRECORD', groups: [[1, pin.name === 'r2018-unicode-metadata' ? 'Unicode Δ 雷 F0A \\U+0041 JSON {"literal":"\\\\U+0041","unicode":"Δ雷","hex":"F0A"}' : 'Payload F0A is literal text'], [160, '9007199254740993'], [310, '00017F80FF']] as Array<[number, string]> }],
        },
        saveAsSha256: '1'.repeat(64), outputSha256: '2'.repeat(64), backupSha256: '1'.repeat(64),
      })) },
    };
    expect(metadataProbeSucceeded(valid)).toBe(true);
    expect(metadataProbeSucceeded(Object.fromEntries(METADATA_SMOKE_FLAGS.map(key => [key, true])))).toBe(false);
    expect(metadataProbeSucceeded({ ...valid, metadataEvidence: { schemaVersion: 1, fixtures: [null, null, null] } })).toBe(false);
    for (const key of METADATA_SMOKE_FLAGS) expect(metadataProbeSucceeded({ ...valid, [key]: false }), key).toBe(false);
    const damage = (change: (value: typeof valid.metadataEvidence.fixtures[number]) => void) => {
      const broken = structuredClone(valid); change(broken.metadataEvidence.fixtures[2]!); expect(metadataProbeSucceeded(broken)).toBe(false);
    };
    damage(value => { value.sourceSha256 = '0'.repeat(64); });
    damage(value => { value.sourceBytes = 8 * 1024 * 1024 + 1; });
    damage(value => { value.fields = 2; });
    damage(value => { value.finalEntities -= 1; });
    damage(value => { value.views = 2; });
    damage(value => { value.connectedReferences = false; });
    damage(value => { value.opaqueLiteralPreserved = false; });
    damage(value => { value.saveReopened = false; });
    damage(value => { value.outputSha256 = value.saveAsSha256; });
    damage(value => { value.backupSha256 = value.outputSha256; });
    damage(value => { value.metadataSnapshot.records.pop(); });
    damage(value => { value.metadataSnapshot.records.find(record => record.type === 'XRECORD')!.groups[0]![1] = 'normalized A'; });
    const missing = structuredClone(valid); missing.metadataEvidence.fixtures.pop(); expect(metadataProbeSucceeded(missing)).toBe(false);
    const duplicate = structuredClone(valid); duplicate.metadataEvidence.fixtures[2] = duplicate.metadataEvidence.fixtures[0]!; expect(metadataProbeSucceeded(duplicate)).toBe(false);
    const missingFlag = { ...valid, metadataAnnotationSettings: undefined }; expect(metadataProbeSucceeded(missingFlag)).toBe(false);
    for (const stage of ['edited', 'saveAsReopened', 'saveReopened']) {
      const mutations: Array<(value: typeof valid.metadataEvidence.fixtures[number]) => void> = [value => { delete value.annotationSettings[stage]; }, value => { value.annotationSettings[stage]!.cannoscale = '1:1'; }, value => { value.annotationSettings[stage]!.annoAllVisible = true; }];
      for (const mutate of mutations) {
        const broken = structuredClone(valid); mutate(broken.metadataEvidence.fixtures[0]!); expect(metadataProbeSucceeded(broken), stage).toBe(false);
      }
    }
    const missingAnnotations = structuredClone(valid); Reflect.deleteProperty(missingAnnotations.metadataEvidence.fixtures[0]!, 'annotationSettings'); expect(metadataProbeSucceeded(missingAnnotations)).toBe(false);
    const finalSnapshot = structuredClone(valid); finalSnapshot.metadataEvidence.fixtures[0]!.metadataSnapshot.annotationSettings.annoAllVisible = true; expect(metadataProbeSucceeded(finalSnapshot)).toBe(false);
    const defaultScale = structuredClone(valid); defaultScale.metadataEvidence.fixtures[2]!.metadataSnapshot.annotationSettings.cannoscale = '1:2'; expect(metadataProbeSucceeded(defaultScale)).toBe(false);
  });
  it('requires actual Windows export probes starting with 0.4.6 and keeps older/platform-paused releases testable', () => {
    for (const version of ['0.4.6', '0.4.6-beta.1', '0.5.0', '1.0.0']) {
      expect(needsPortableDwgExport(version, 'win32')).toBe(true);
      for (const platform of ['darwin', 'linux']) expect(needsPortableDwgExport(version, platform)).toBe(false);
    }
    for (const version of ['0.4.5', 'v0.4.4', '0.3.0']) expect(needsPortableDwgExport(version, 'win32')).toBe(false);
    expect(() => needsPortableDwgExport('invalid', 'win32')).toThrow(/Invalid packaged smoke version/);
  });
  it('requires normal Windows DWG Save and Save As evidence from 0.4.7 without invalidating older export-only releases', () => {
    for (const version of ['0.4.7', '0.4.7-beta.1', 'v0.4.8', '0.5.0', '1.0.0']) {
      expect(needsPortableDwgSave(version, 'win32')).toBe(true);
      expect(needsPortableDwgExport(version, 'win32')).toBe(true);
      for (const platform of ['darwin', 'linux']) expect(needsPortableDwgSave(version, platform)).toBe(false);
    }
    for (const version of ['0.4.6', 'v0.4.6', '0.4.6-beta.1', '0.4.5', '0.3.0']) expect(needsPortableDwgSave(version, 'win32')).toBe(false);
    expect(needsPortableDwgExport('0.4.6', 'win32')).toBe(true);
    expect(() => needsPortableDwgSave('invalid', 'win32')).toThrow(/Invalid packaged smoke version/);
  });
  it('requires rotated viewport preservation in Windows 0.4.8 and keeps older installers testable', () => {
    for (const version of ['0.4.8', '0.4.8-beta.1', 'v0.4.9', '0.5.0', '1.0.0']) {
      expect(needsRotatedLayoutViewports(version, 'win32')).toBe(true);
      expect(needsPortableDwgSave(version, 'win32')).toBe(true);
      for (const platform of ['darwin', 'linux']) expect(needsRotatedLayoutViewports(version, platform)).toBe(false);
    }
    for (const version of ['0.4.7', 'v0.4.7', '0.4.7-beta.1', '0.4.6', '0.3.0']) expect(needsRotatedLayoutViewports(version, 'win32')).toBe(false);
    expect(() => needsRotatedLayoutViewports('invalid', 'win32')).toThrow(/Invalid packaged smoke version/);
  });
});

describe('packaged secure-origin gate', () => {
  it('keeps old releases testable and requires the two-launch gate on current and future builds', () => {
    expect(needsPackagedOrigin('v0.4.0')).toBe(false);
    expect(needsPackagedOrigin('0.3.9')).toBe(false);
    for (const version of ['0.4.1', '0.4.1-beta.1', '0.4.2', '0.5.0', '1.0.0']) expect(needsPackagedOrigin(version), version).toBe(true);
    expect(() => needsPackagedOrigin('unknown')).toThrow(/Invalid packaged smoke version/);
  });

  it('records timed-out and killed children as failures with their actual cause', () => {
    expect(processResult({ status: null, signal: 'SIGTERM', error: new Error('ETIMEDOUT') })).toBe('error: ETIMEDOUT');
    expect(processResult({ status: null, signal: 'SIGKILL', error: undefined })).toBe('signal: SIGKILL');
    expect(processResult({ status: 1, signal: null, error: undefined })).toBe('exit: 1');
  });
});

describe('packaged native architecture acceptance', () => {
  const arm = '/installers/jcad-electrical-0.4.4-mac-arm64.dmg';
  const intel = '/installers/jcad-electrical-0.4.4-mac-x64.dmg';
  const unnamed = '/installers/legacy.dmg';
  const assets = [intel, arm, unnamed, '/installers/latest-mac.yml'];
  it.each(['arm64', 'x64'])('requires the exact native %s installer, even when Rosetta is available', (arch) => {
    expect(macDmgTargets(assets, { hostArch:arch, expectedArch:arch, nativeOnly:true, rosetta:true })).toEqual([arch === 'arm64' ? arm : intel]);
  });
  it('fails when the required native artifact is missing rather than testing the other architecture or an unnamed DMG', () => {
    expect(() => macDmgTargets([intel, unnamed], { hostArch:'arm64', expectedArch:'arm64', nativeOnly:true, rosetta:true })).toThrow(/No required native macOS arm64 DMG/);
    expect(() => macDmgTargets([arm], { hostArch:'x64', expectedArch:'x64', nativeOnly:true })).toThrow(/No required native macOS x64 DMG/);
  });
  it('rejects a mismatched or unspecified native host before installer execution', () => {
    expect(() => validateSmokeArchitecture('arm64', 'x64', true)).toThrow(/requires native x64/);
    expect(() => validateSmokeArchitecture('x64', 'arm64', true)).toThrow(/requires native arm64/);
    expect(() => validateSmokeArchitecture('arm64', '', true)).toThrow(/requires JCAD_SMOKE_EXPECT_ARCH/);
    expect(() => validateSmokeArchitecture('x64', 'AMD64', true)).toThrow(/Unsupported expected/);
  });
  it('keeps optional Rosetta available in default/manual mode, native first', () => {
    expect(macDmgTargets(assets, { hostArch:'arm64', rosetta:true })).toEqual([arm, intel, unnamed]);
    expect(macDmgTargets(assets, { hostArch:'arm64' })).toEqual([arm, unnamed]);
    expect(macDmgTargets(assets, { hostArch:'x64', rosetta:true })).toEqual([intel, unnamed]);
    expect(macDmgTargets(['older-arm64.dmg', 'older-x64.dmg'], { hostArch:'x64' })).toEqual(['older-x64.dmg']);
  });
  it('also validates the expected architecture on non-macOS native jobs', () => {
    expect(() => validateSmokeArchitecture('x64', 'x64', true)).not.toThrow();
    expect(() => validateSmokeArchitecture('ia32', 'x64', true)).toThrow(/requires native x64/);
    expect(() => validateSmokeArchitecture('x64')).not.toThrow();
  });
});

describe('packaged child exit evidence', () => {
  const success = { status:0, signal:null, error:undefined };
  const line = 'PROBE_OK r2000 entities=67 blocks=16';
  it('requires a successful child and the actual DWG success marker', () => {
    expect(childSucceeded(success)).toBe(true);
    expect(dwgProbeSucceeded(success, line)).toBe(true);
    expect(dwgProbeSucceeded(success, 'PROBE_FAIL reader stopped')).toBe(false);
    expect(dwgProbeSucceeded(success, '')).toBe(false);
  });
  it('rejects ETIMEDOUT despite status0 and even a success line emitted before the hang', () => {
    const timeout = { status:0, signal:null, error:new Error('ETIMEDOUT') };
    expect(childSucceeded(timeout)).toBe(false);
    expect(dwgProbeSucceeded(timeout, line)).toBe(false);
    expect(processResult(timeout)).toBe('error: ETIMEDOUT');
  });
  it('rejects a killed or nonzero child even with a success marker', () => {
    expect(dwgProbeSucceeded({ status:0, signal:'SIGTERM', error:undefined }, line)).toBe(false);
    expect(dwgProbeSucceeded({ status:1, signal:null, error:undefined }, line)).toBe(false);
  });
  it('requires isolated DWG cancellation and damaged-file recovery in new shipping installers', () => {
    expect(dwgProbeSucceeded(success, line, '0.4.4')).toBe(true);
    for (const version of ['0.4.5', '0.4.5-beta.1', '0.5.0', '1.0.0']) {
      expect(dwgProbeSucceeded(success, line, version)).toBe(false);
      expect(dwgProbeSucceeded(success, `${line} isolated=1 recovery=1`, version)).toBe(true);
      expect(dwgProbeSucceeded(success, `${line} isolated=1 recovery=0`, version)).toBe(false);
      expect(dwgProbeSucceeded(success, 'PROBE_OK invalid entities=0 blocks=0 isolated=1 recovery=1', version)).toBe(false);
      expect(dwgProbeSucceeded(success, 'PROBE_OK r2000 entities=1 blocks=16 isolated=1 recovery=1', version)).toBe(false);
      expect(dwgProbeSucceeded(success, 'PROBE_OK r2000 entities=67 blocks=0 isolated=1 recovery=1', version)).toBe(false);
    }
    expect(() => dwgProbeSucceeded(success, line, 'unknown')).toThrow(/Invalid packaged smoke version/);
  });
});
