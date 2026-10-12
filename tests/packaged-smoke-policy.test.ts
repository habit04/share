import { describe, expect, it } from 'vitest';
import { needsPackagedOrigin, processResult, childSucceeded, dwgProbeSucceeded, validateSmokeArchitecture, macDmgTargets } from '../scripts/packaged-smoke-policy.mjs';

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
