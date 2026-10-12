import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertFusePolicy, verifyExecutableFuses, platformExecutables, validateFuseEvidence } from '../scripts/electron-fuse-policy.mjs';
import { assertRequiredSigning, appleSigningNames, azureSigningNames } from '../scripts/signing-policy.mjs';
import { configureMacSigning } from '../scripts/mac-signing-config.mjs';
const require = createRequire(import.meta.url);
const { rejectsProductionDebugging, developmentServerUrl } = require('../electron/inspection-policy.cjs');
const { shippingProbePhase } = require('../electron/main/shipping-probe.cjs');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const testBuild = require('../scripts/electron-test-build.cjs');
const shipping = { version:'1', 0:48, 2:48, 3:48, 4:49, 5:49, 7:48 };

describe('production inspection separation', () => {
  it('ignores development-server overrides for every packaged build', () => {
    expect(developmentServerUrl(true, 'http://localhost:5173')).toBeUndefined();
    expect(developmentServerUrl(false, 'http://localhost:5173')).toBe('http://localhost:5173');
    expect(developmentServerUrl(false, undefined)).toBeUndefined();
  });
  it('ships disabled inspection and isolates the only test-build difference in a non-release output', async () => {
    expect(pkg.build.electronFuses.enableNodeCliInspectArguments).toBe(false);
    expect(testBuild.electronFuses).toEqual({ ...pkg.build.electronFuses, enableNodeCliInspectArguments:true });
    expect(testBuild.directories.output).toBe('release-test');
    expect(testBuild.publish).toBeNull();
    expect(testBuild.extraMetadata.jcadTestBuild).toBe(true);
    expect(testBuild.artifactName).toMatch(/^TEST-ONLY-/);
    const { validateConfiguration } = require('app-builder-lib/out/util/config/config.js');
    await expect(validateConfiguration(testBuild, { isEnabled:false })).resolves.toBeUndefined();
  });
  it('reads fuse bytes from an executable and fails closed on an inspection-enabled or incomplete wire', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jcad-fuse-test-'));
    try {
      const file = join(dir, 'electron-binary');
      const bytes = Buffer.concat([Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, 8, 48, 49, 48, 48, 49, 49, 49, 48])]);
      writeFileSync(file, bytes);
      await expect(verifyExecutableFuses(file)).resolves.toMatchObject({ role:'shipping', EnableNodeCliInspectArguments:false });
      bytes[bytes.length - 5] = 49; writeFileSync(file, bytes);
      await expect(verifyExecutableFuses(file)).rejects.toThrow(/EnableNodeCliInspectArguments/);
      await expect(verifyExecutableFuses(file, 'test')).resolves.toMatchObject({ role:'test' });
      writeFileSync(file, 'not an Electron fuse wire');
      await expect(verifyExecutableFuses(file)).rejects.toThrow(/sentinel/);
    } finally { rmSync(dir, { recursive:true, force:true }); }
    expect(() => assertFusePolicy({ ...shipping, 5:48 })).toThrow(/OnlyLoadAppFromAsar/);
  });
  it('requires fuse evidence for every shipping platform executable', () => {
    for (const platform of ['Windows', 'macOS', 'Linux']) {
      const evidence = platformExecutables(platform).map((path) => ({ path, policy:assertFusePolicy(shipping) }));
      expect(validateFuseEvidence(platform, evidence)).toEqual(evidence);
      expect(() => validateFuseEvidence(platform, [])).toThrow(/Missing shipping/);
      evidence[0]!.policy.EnableNodeCliInspectArguments = true;
      expect(() => validateFuseEvidence(platform, evidence)).toThrow(/Unsafe or test-build/);
    }
  });
  it('rejects production Node and Chromium debugger flags and leaves source/dedicated test suites operable', () => {
    for (const arg of ['--inspect', '--inspect=9229', '--inspect-brk', '--inspect-port=0', '--remote-debugging-port=0', '--remote-debugging-pipe', '--remote-debugging-address=0.0.0.0']) {
      expect(rejectsProductionDebugging(true, false, [arg]), arg).toBe(true);
      expect(rejectsProductionDebugging(false, false, [arg]), arg).toBe(false);
      expect(rejectsProductionDebugging(true, true, [arg]), arg).toBe(false);
    }
    expect(rejectsProductionDebugging(true, false, ['--probe-dwg', '--probe-startup=first', 'drawing.dxf'])).toBe(false);
  });
  it('accepts only fixed startup probe phases, never supplied source text', () => {
    expect(shippingProbePhase([])).toBeNull();
    expect(shippingProbePhase(['--probe-startup=first'])).toBe('first');
    expect(shippingProbePhase(['--probe-startup=second'])).toBe('second');
    expect(shippingProbePhase(['--probe-startup=dwg'])).toBe('dwg');
    for (const flags of [['--probe-startup=eval(1)'], ['--probe-startup=first', '--probe-startup=second']]) expect(() => shippingProbePhase(flags)).toThrow(/Invalid/);
  });
});
describe('required publisher signing', () => {
  it('validates the installed builder signed macOS configuration without contacting Apple', async () => {
    const build = configureMacSigning(pkg.build);
    expect(build.forceCodeSigning).toBe(true);
    expect(build.mac?.hardenedRuntime).toBe(true);
    expect(build.mac?.notarize).toBe(true);
    expect(build.dmg?.sign).toBe(true);
    expect(pkg.build.mac.hardenedRuntime).toBe(false);
    const { validateConfiguration } = require('app-builder-lib/out/util/config/config.js');
    await expect(validateConfiguration(build, { isEnabled:false })).resolves.toBeUndefined();
  });
  it('fails closed without all named Windows or macOS inputs without exposing values', () => {
    for (const [platform, names] of [['Windows', azureSigningNames], ['macOS', appleSigningNames]] as const) {
      const env = Object.fromEntries(names.map((name) => [name, 'test-opaque-value']));
      expect(assertRequiredSigning(platform, true, env).enabled).toBe(true);
      delete env[names[0]!];
      expect(() => assertRequiredSigning(platform, true, env)).toThrow(/publisher signing required; missing inputs/);
      expect(assertRequiredSigning(platform, false, env).enabled).toBe(false);
    }
  });
});
