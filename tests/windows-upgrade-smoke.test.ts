import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { assertCleanWindowsUpgradeInventory, assertOwnedUpgradePath, assertStableWindowsUpgradeRegistration, assertUpgradeProbe, assertUpgradeSignature, assertWindowsApplicationVersion, assertWindowsInstallerVersion, assertWindowsShippingPayloadTrust, assertWindowsUpgradeHost, assertWindowsUpgradeRecoveryFixture, executeWindowsUpgradeSequence, inventoryUpgradeTree, isolatedWindowsPowerShellEnvironment, needsWindowsUpgradeSmoke, seedWindowsUpgradeRecoveryFixture, selectWindowsUpgradeRegistration, WINDOWS_UPGRADE_BASELINE, WINDOWS_UPGRADE_CASES, WINDOWS_UPGRADE_RECOVERY_INPUTS, WINDOWS_UPGRADE_REGISTRATION, WINDOWS_UPGRADE_REGISTRY_QUERY, type UpgradeCase, type UpgradeDriver, type UpgradeSnapshot } from '../scripts/windows-upgrade-smoke.mjs';
import { readDxf } from '../src/io/dxf';

const hosted = { platform: 'win32', arch: 'x64', env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', GITHUB_REPOSITORY: 'habit04/share', GITHUB_JOB: 'packaged-smoke', GITHUB_WORKFLOW_REF: 'habit04/share/.github/workflows/release.yml@refs/heads/integration/windows-pr18-pr19-source', GITHUB_RUN_ID: '123456', GITHUB_SHA: 'a'.repeat(40), ImageOS: 'win25', USERNAME: 'runneradmin', USERPROFILE: 'C:\\Users\\runneradmin', RUNNER_TEMP: 'D:\\a\\_temp' } };
const signature = { status: 'Valid', publisher: 'Justin Rodriguez', thumbprint: '1'.repeat(40) };
const prefs = { gridVisible: false, crosshairSize: 17, modelBackground: '#293541', autosaveMinutes: 7, units: 'engineering', unitSuffix: 'ft', precision: 3, language: 'en' };
const validProbe = (settingsCase: UpgradeCase, phase = 'second', version = '0.5.1') => ({
  phase, version, packaged: true, testBuild: false, url: 'jcad://app/index.html', dirty: false,
  before: phase === 'first' ? 1 : 2, entities: 2, saved: phase === 'first', secure: true, bridge: true, persistent: true, privateSessionData: true, privateStorage: true, migrationMarker: true,
  settingsEvidence: { ...prefs, experimental3d: settingsCase.experimental3d, importForeign3d: settingsCase.importForeign3d, upgradeSentinel: `upgrade sentinel Δ 雷 ${settingsCase.name}`, canvasDefault: true, controllerInactive: true, no3dCanvas: true, kernelUnstarted: true, controllerInstalled: settingsCase.experimental3d },
});

describe('Windows upgrade execution admission', () => {
  it('accepts hosted release identity without equating account TEMP and RUNNER_TEMP', () => {
    expect(() => assertWindowsUpgradeHost(hosted)).not.toThrow();
    expect(() => assertWindowsUpgradeHost({ ...hosted, env: { ...hosted.env, GITHUB_JOB: 'smoke', GITHUB_WORKFLOW_REF: 'habit04/share/.github/workflows/packaged-smoke.yml@refs/tags/v0.5.1' } })).not.toThrow();
    for (const changed of [{ GITHUB_JOB: 'smoke' }, { GITHUB_WORKFLOW_REF: 'habit04/share/.github/workflows/packaged-smoke.yml@refs/heads/main' }, { GITHUB_WORKFLOW_REF: 'habit04/share/.github/workflows/release.yml@arbitrary-path' }, { GITHUB_WORKFLOW_REF: 'another/share/.github/workflows/release.yml@refs/heads/main' }]) expect(() => assertWindowsUpgradeHost({ ...hosted, env: { ...hosted.env, ...changed } })).toThrow();
  });
  it('accepts the observed official Windows VS2026 image and keeps earlier hosted images', () => {
    for (const ImageOS of ['win22', 'win25', 'win25-vs2026']) {
      expect(() => assertWindowsUpgradeHost({ ...hosted, env: { ...hosted.env, ImageOS } }), ImageOS).not.toThrow();
      expect(() => assertWindowsUpgradeHost({ ...hosted, env: { ...hosted.env, ImageOS, GITHUB_JOB: 'smoke', GITHUB_WORKFLOW_REF: 'habit04/share/.github/workflows/packaged-smoke.yml@refs/tags/v0.5.1' } }), ImageOS).not.toThrow();
    }
  });
  it('rejects altered Windows image identities and missing host markers for the VS2026 image', () => {
    for (const ImageOS of ['', 'ubuntu24', 'windows-2025-vs2026', 'win22-vs2026', 'win2025-vs2026', 'win25-vs2027', 'win25-vs2026-extra', 'win25-vs2026/other', 'WIN25-vs2026', 'win25-vs2026 ', 'win25-vs2026\n', 'win25\n']) {
      expect(() => assertWindowsUpgradeHost({ ...hosted, env: { ...hosted.env, ImageOS } }), JSON.stringify(ImageOS)).toThrow();
    }
    for (const key of Object.keys(hosted.env)) {
      const env: NodeJS.ProcessEnv = { ...hosted.env, ImageOS: 'win25-vs2026' }; delete env[key];
      expect(() => assertWindowsUpgradeHost({ ...hosted, env }), key).toThrow();
    }
    for (const changed of [{ RUNNER_ENVIRONMENT: 'self-hosted' }, { USERNAME: 'justi' }, { GITHUB_REPOSITORY: 'another/share' }, { GITHUB_JOB: 'build' }, { GITHUB_WORKFLOW_REF: 'another/share/.github/workflows/release.yml@refs/heads/main' }, { GITHUB_SHA: 'main' }, { GITHUB_RUN_ID: '../123' }]) {
      expect(() => assertWindowsUpgradeHost({ ...hosted, env: { ...hosted.env, ImageOS: 'win25-vs2026', ...changed } })).toThrow();
    }
  });
  it('rejects missing or changed markers, developer accounts, other repositories and self-hosted runners', () => {
    for (const key of Object.keys(hosted.env)) {
      const env: NodeJS.ProcessEnv = { ...hosted.env }; delete env[key];
      expect(() => assertWindowsUpgradeHost({ ...hosted, env }), key).toThrow();
    }
    for (const env of [{ RUNNER_ENVIRONMENT: 'self-hosted' }, { USERNAME: 'justi' }, { GITHUB_REPOSITORY: 'another/share' }, { GITHUB_JOB: 'build' }, { ImageOS: 'ubuntu24' }, { GITHUB_SHA: 'main' }, { GITHUB_RUN_ID: '../123' }]) expect(() => assertWindowsUpgradeHost({ ...hosted, env: { ...hosted.env, ...env } })).toThrow();
    for (const changed of [{ platform: 'linux' }, { platform: 'darwin' }, { arch: 'arm64' }]) expect(() => assertWindowsUpgradeHost({ ...hosted, ...changed })).toThrow();
  });
  it('gates new Windows releases and keeps historical v0.5.0 acceptance unchanged', () => {
    for (const version of ['0.5.1', 'v0.5.1-rc.1', '0.5.1-rc.1+build.2', '0.5.2', '0.6.0', '1.0.0']) expect(needsWindowsUpgradeSmoke(version, 'win32')).toBe(true);
    for (const version of ['0.5.0', '0.4.9']) expect(needsWindowsUpgradeSmoke(version, 'win32')).toBe(false);
    for (const platform of ['linux', 'darwin']) expect(needsWindowsUpgradeSmoke('0.5.1', platform)).toBe(false);
    for (const version of ['bad', '0.5', '0.5.1/../../file']) expect(() => needsWindowsUpgradeSmoke(version, 'win32')).toThrow();
  });
  it('pins the existing release bytes, not a mutable latest-release download', () => {
    expect(WINDOWS_UPGRADE_BASELINE).toEqual({ version: '0.5.0', publisher: 'Justin Rodriguez', url: 'https://github.com/habit04/share/releases/download/v0.5.0/jcad-electrical-0.5.0-win-x64.exe', sha256: '116845741d59ec0df32a8ef3c29f4ce9f6f1dcfabcb5cadcf96e42d75b884828', bytes: 154080840 });
    expect(Object.isFrozen(WINDOWS_UPGRADE_BASELINE)).toBe(true);
  });
  it('requires Valid status, the exact established publisher and a signer identity', () => {
    expect(() => assertUpgradeSignature(signature)).not.toThrow();
    for (const changed of [{ status: 'NotSigned' }, { status: 'UnknownError' }, { publisher: 'Another publisher' }, { publisher: 'Justin Rodriguez, Inc.' }, { thumbprint: '' }, { thumbprint: undefined }]) expect(() => assertUpgradeSignature({ ...signature, ...changed })).toThrow();
    for (const input of [null, {}, false]) expect(() => assertUpgradeSignature(input)).toThrow();
  });
  it('admits only a complete four-view inventory without registered or running JCad', () => {
    const clean = { queryCompleted: true, registryViews: 4, uninstallEntries: 307, installedJcad: [], runningJcad: [] };
    const before = structuredClone(clean); expect(() => assertCleanWindowsUpgradeInventory(clean)).not.toThrow(); expect(clean).toEqual(before);
    for (const key of Object.keys(clean)) { const changed: Record<string, unknown> = { ...clean }; delete changed[key]; expect(() => assertCleanWindowsUpgradeInventory(changed), key).toThrow(); }
    for (const changed of [{ queryCompleted: false }, { registryViews: 2 }, { registryViews: '4' }, { uninstallEntries: -1 }, { uninstallEntries: NaN }, { installedJcad: {} }, { runningJcad: {} }, { installedJcad: [{ name: 'JCad Electrical', location: 'C:\\Users\\someone\\Programs\\jcad-electrical' }] }, { runningJcad: [{ Name: 'JCad Electrical.exe', ProcessId: 12 }] }, { runningJcad: [{ Name: 'JcadDwgWriter.exe', ProcessId: 44 }] }]) expect(() => assertCleanWindowsUpgradeInventory({ ...clean, ...changed })).toThrow();
  });
  it('accepts the real old/new application PE version shapes while retaining both raw values', () => {
    for (const version of ['0.5.0', '0.5.1']) for (const productVersion of [version, version + '.0']) {
      const record = { version: productVersion, fileVersion: version }, before = { ...record };
      expect(() => assertWindowsApplicationVersion(record, version)).not.toThrow();
      expect(record).toEqual(before);
    }
  });
  it('rejects wrong application revisions, suffixes, missing fields and mismatched FileVersion', () => {
    const record = { version: '0.5.1.0', fileVersion: '0.5.1' };
    for (const version of ['0.5.0', '0.5.0.0', '0.5.1.1', '0.5.1.0.0', 'v0.5.1', '0.5.10', '0.5.1-rc.1', '0.5.1+build.1', ' 0.5.1', '0.5.1 ', '', null, undefined]) expect(() => assertWindowsApplicationVersion({ ...record, version }, '0.5.1')).toThrow();
    for (const fileVersion of ['0.5.0', '0.5.1.0', 'v0.5.1', '0.5.10', '0.5.1-rc.1', ' 0.5.1', '0.5.1 ', '', null, undefined]) expect(() => assertWindowsApplicationVersion({ ...record, fileVersion }, '0.5.1')).toThrow();
    for (const input of [null, {}, false]) expect(() => assertWindowsApplicationVersion(input, '0.5.1')).toThrow();
  });
  it('does not extend the fourth-component exception to prerelease or build strings', () => {
    for (const version of ['0.5.1-rc.1', '0.5.1+build.1']) {
      expect(() => assertWindowsApplicationVersion({ version, fileVersion: version }, version)).not.toThrow();
      expect(() => assertWindowsApplicationVersion({ version: version + '.0', fileVersion: version }, version)).toThrow();
    }
  });
  it('keeps installers on the exact ProductVersion policy, including rejection of app-style tuples', () => {
    for (const version of ['0.5.0', '0.5.1']) {
      expect(() => assertWindowsInstallerVersion({ version, fileVersion: version }, version)).not.toThrow();
      for (const rawVersion of [version + '.0', version + '.1', 'v' + version, version + ' ', '0.5.2', undefined]) expect(() => assertWindowsInstallerVersion({ version: rawVersion, fileVersion: version }, version)).toThrow();
    }
  });
  it('requires both actual installed signatures and updater publisher before executable probes', () => {
    const trusted = { expectedVersion: '0.5.1', updaterPublishers: ['Justin Rodriguez'], application: { ...signature, version: '0.5.1.0', fileVersion: '0.5.1', sha256: 'a'.repeat(64), bytes: 100 }, helper: { ...signature, version: '0.1.0', sha256: 'b'.repeat(64), bytes: 40 } };
    expect(() => assertWindowsShippingPayloadTrust(trusted, '0.5.1')).not.toThrow();
    const baseline = { ...trusted, expectedVersion: '0.5.0', application: { ...trusted.application, version: '0.5.0.0', fileVersion: '0.5.0' } };
    expect(() => assertWindowsShippingPayloadTrust(baseline, '0.5.0')).not.toThrow();
    for (const change of [{ version: '0.5.1.1' }, { fileVersion: '0.5.1.0' }, { fileVersion: '0.5.0' }, { fileVersion: undefined }]) expect(() => assertWindowsShippingPayloadTrust({ ...trusted, application: { ...trusted.application, ...change } }, '0.5.1')).toThrow();
    for (const role of ['application', 'helper'] as const) for (const change of [{ status: 'NotSigned' }, { status: 'UnknownError' }, { publisher: 'Someone Else' }, { thumbprint: '' }, { sha256: '' }, { bytes: 0 }]) expect(() => assertWindowsShippingPayloadTrust({ ...trusted, [role]: { ...trusted[role], ...change } }, '0.5.1')).toThrow();
    for (const change of [{ expectedVersion: '0.5.0' }, { updaterPublishers: ['Someone Else'] }, { updaterPublishers: ['Justin Rodriguez', 'Someone Else'] }, { updaterPublishers: [] }, { updaterPublishers: undefined }, { helper: undefined }, { application: { ...trusted.application, version: '0.5.0' } }]) expect(() => assertWindowsShippingPayloadTrust({ ...trusted, ...change }, '0.5.1')).toThrow();
    expect(() => assertWindowsShippingPayloadTrust(trusted, '0.5.1', 'Someone Else')).toThrow(/Configured publisher/);
    expect(() => assertWindowsShippingPayloadTrust({ ...trusted, helper: { ...trusted.helper, version: 'independently versioned' } }, '0.5.1')).not.toThrow();
  });
  it('rejects moved uninstall hive/view/key identity even when path and version stay equal', () => {
    const entries = [{ hive: 'CurrentUser', view: 'Registry64', key: 'fixed-jcad-app-id', location: 'owned-install-target', version: '0.5.0' }];
    const pinned = assertStableWindowsUpgradeRegistration(entries);
    expect(() => assertStableWindowsUpgradeRegistration([{ ...entries[0], version: '0.5.1' }], pinned)).not.toThrow();
    for (const change of [{ hive: 'LocalMachine' }, { view: 'Registry32' }, { key: 'other-app-id' }, { hive: undefined }, { view: undefined }, { key: undefined }]) expect(() => assertStableWindowsUpgradeRegistration([{ ...entries[0], ...change }], pinned)).toThrow();
    expect(() => assertStableWindowsUpgradeRegistration([], pinned)).toThrow();
    expect(() => assertStableWindowsUpgradeRegistration([...entries, ...entries], pinned)).toThrow(/Duplicate/);
  });
  it('isolates inherited module paths without changing the parent environment or other values', () => {
    const original = { PATH: 'fixed-system-bin', SOURCE_SHA: 'a'.repeat(40), PSModulePath: 'PowerShell-7-only-modules', PSMODULEPATH: 'other-case-inherited-path' };
    expect(isolatedWindowsPowerShellEnvironment(original)).toEqual({ PATH: 'fixed-system-bin', SOURCE_SHA: 'a'.repeat(40) });
    expect(original.PSModulePath).toBe('PowerShell-7-only-modules'); expect(original.PSMODULEPATH).toBe('other-case-inherited-path');
  });
});

describe('actual NSIS uninstall registration format', () => {
  const target = 'D:\\a\\_temp\\jcad-smoke-registry-fixture\\app';
  const options = { target, candidateVersion: '0.5.1' };
  const entry = (version = '0.5.1') => ({ hive: 'CurrentUser', view: 'Registry64', key: WINDOWS_UPGRADE_REGISTRATION.key, name: `JCad Electrical ${version}`, version, icon: `${target}\\JCad Electrical.exe,0`, installationKey: WINDOWS_UPGRADE_REGISTRATION.installationKey, installationPresent: true, location: target });
  const inventory = (entries: unknown[]) => ({ queryCompleted: true, registryViews: 4, entries });
  it('binds the fixture to the pinned builder default, app ID and separate InstallLocation key', () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    const require = createRequire(import.meta.url), { UUID } = require('builder-util-runtime');
    expect(pkg.build.appId).toBe('com.jcad.electrical'); expect(pkg.build.productName).toBe('JCad Electrical');
    for (const key of ['guid', 'uninstallDisplayName', 'include', 'script']) expect(pkg.build.nsis?.[key]).toBeUndefined();
    expect(UUID.v5(pkg.build.appId, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'))).toBe(WINDOWS_UPGRADE_REGISTRATION.key);
    const builder = readFileSync(require.resolve('app-builder-lib/out/targets/nsis/NsisTarget.js'), 'utf8');
    expect(builder).toContain('options.uninstallDisplayName || "${productName} ${version}"');
    const nsis = readFileSync(resolve('node_modules/app-builder-lib/templates/nsis/include/installer.nsh'), 'utf8');
    expect(nsis).toContain('WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"');
    expect(nsis).not.toMatch(/WriteRegStr[^\r\n]*UNINSTALL_REGISTRY_KEY[^\r\n]*InstallLocation/);
    expect(WINDOWS_UPGRADE_REGISTRY_QUERY).toContain("$location=if ($installation) { [string]$installation.GetValue('InstallLocation') }");
    expect(WINDOWS_UPGRADE_REGISTRY_QUERY).not.toContain("$entry.GetValue('InstallLocation')");
  });
  it('admits both released versioned names and the exact legacy plain name', () => {
    for (const version of ['0.5.0', '0.5.1']) {
      const row = entry(version);
      expect(selectWindowsUpgradeRegistration(inventory([row]), options)).toEqual([row]);
      const legacy = { ...row, name: 'JCad Electrical' };
      expect(selectWindowsUpgradeRegistration(inventory([legacy]), options)).toEqual([legacy]);
    }
    expect(selectWindowsUpgradeRegistration(inventory([{ ...entry(), name: 'Unrelated Application', key: 'unrelated-app', location: 'Z:\\other' }]), options)).toEqual([]);
    expect(selectWindowsUpgradeRegistration(inventory([]), options)).toEqual([]);
  });
  it('uses only the paired application path and refuses missing or conflicting ownership', () => {
    const row = { ...entry(), uninstallLocation: 'Z:\\untrusted', icon: 'Z:\\untrusted\\JCad Electrical.exe,0' };
    expect(selectWindowsUpgradeRegistration(inventory([row]), options)).toEqual([row]);
    for (const change of [{ installationPresent: false }, { installationPresent: undefined }, { installationKey: 'Software\\another-app' }, { installationKey: undefined }, { location: '' }, { location: undefined }, { location: 'D:relative-path' }, { location: '\\a\\_temp\\jcad-smoke-registry-fixture\\app' }, { location: target + '\\other' }, { location: 'Z:\\outside' }, { location: target + '\0' }]) {
      expect(() => selectWindowsUpgradeRegistration(inventory([{ ...entry(), ...change }]), options), JSON.stringify(change)).toThrow();
    }
    const spelling = { ...entry(), location: target.toLowerCase() + '\\' };
    expect(selectWindowsUpgradeRegistration(inventory([spelling]), options)).toEqual([spelling]);
  });
  it('refuses unknown JCad registrations and disguised pinned-key entries rather than hiding them', () => {
    for (const change of [{ name: 'JCad Other Product' }, { name: 'JCad Electrical 0.5.0' }, { name: 'JCad Electrical 0.5.1 ' }, { name: ' JCad Electrical' }, { name: undefined }, { name: '' }, { name: 'Unrelated Application' }, { version: '0.5.1.0' }, { version: '0.5.2' }, { version: undefined }, { key: 'another-app' }, { key: undefined }]) {
      expect(() => selectWindowsUpgradeRegistration(inventory([{ ...entry(), ...change }]), options), JSON.stringify(change)).toThrow();
    }
    expect(() => selectWindowsUpgradeRegistration(inventory([entry(), { ...entry(), name: 'JCad Other Product', key: 'other-app' }]), options)).toThrow();
    expect(() => selectWindowsUpgradeRegistration(inventory([entry(), { ...entry(), hive: 'LocalMachine', location: 'Z:\\outside' }]), options)).toThrow();
  });
  it('requires completed four-view inventory, valid namespace and no duplicate identities', () => {
    for (const change of [{ queryCompleted: false }, { queryCompleted: undefined }, { registryViews: 3 }, { registryViews: undefined }, { entries: undefined }, { entries: [null] }]) expect(() => selectWindowsUpgradeRegistration({ ...inventory([entry()]), ...change }, options)).toThrow();
    for (const change of [{ hive: 'OtherHive' }, { hive: undefined }, { view: 'OtherView' }, { view: undefined }]) expect(() => selectWindowsUpgradeRegistration(inventory([{ ...entry(), ...change }]), options)).toThrow();
    expect(() => selectWindowsUpgradeRegistration(inventory([entry(), entry()]), options)).toThrow(/Duplicate/);
    const sharedViews = [entry(), { ...entry(), view: 'Registry32' }];
    expect(selectWindowsUpgradeRegistration(inventory(sharedViews), options)).toEqual(sharedViews);
    const baseline = sharedViews.map(row => ({ ...row, name: 'JCad Electrical 0.5.0', version: '0.5.0' }));
    const stable = assertStableWindowsUpgradeRegistration(selectWindowsUpgradeRegistration(inventory(baseline), options));
    expect(() => assertStableWindowsUpgradeRegistration(selectWindowsUpgradeRegistration(inventory(sharedViews), options), stable)).not.toThrow();
    expect(() => assertStableWindowsUpgradeRegistration(selectWindowsUpgradeRegistration(inventory([entry()]), options), stable)).toThrow(/moved/);
  });
});

describe('old save to new runtime compatibility assertions', () => {
  it('checks exact explicit-off and legacy-on migration plus lazy Canvas behavior', () => {
    for (const settingsCase of WINDOWS_UPGRADE_CASES) expect(() => assertUpgradeProbe(validProbe(settingsCase), { phase: 'second', version: '0.5.1', settingsCase, upgraded: true })).not.toThrow();
  });
  it('requires actual new normalized settings, foreign-import separation and arbitrary sentinel', () => {
    for (const settingsCase of WINDOWS_UPGRADE_CASES) {
      const record = validProbe(settingsCase);
      for (const key of Object.keys(record.settingsEvidence)) {
        const changed = { ...record.settingsEvidence, [key]: typeof record.settingsEvidence[key as keyof typeof record.settingsEvidence] === 'boolean' ? !record.settingsEvidence[key as keyof typeof record.settingsEvidence] : 'changed' };
        expect(() => assertUpgradeProbe({ ...record, settingsEvidence: changed }, { phase: 'second', version: '0.5.1', settingsCase, upgraded: true }), key).toThrow();
      }
      expect(() => assertUpgradeProbe({ ...record, settingsEvidence: undefined }, { phase: 'second', version: '0.5.1', settingsCase, upgraded: true })).toThrow();
    }
  });
  it('rejects wrong binary/version/test mode/origin/entity count/dirty/migration evidence', () => {
    const settingsCase = WINDOWS_UPGRADE_CASES[0]!; const record = validProbe(settingsCase);
    for (const changed of [{ phase: 'first' }, { version: '0.5.0' }, { version: '0.5.1.0' }, { packaged: false }, { testBuild: true }, { url: 'file:///index.html' }, { before: 1 }, { entities: 1 }, { dirty: true }, { saved: true }, ...['secure', 'bridge', 'persistent', 'privateSessionData', 'privateStorage', 'migrationMarker'].map(key => ({ [key]: false }))]) expect(() => assertUpgradeProbe({ ...record, ...changed }, { phase: 'second', version: '0.5.1', settingsCase, upgraded: true })).toThrow();
  });
  it('allows historical probes without claiming they emitted new settings evidence', () => {
    const settingsCase = WINDOWS_UPGRADE_CASES[1]!;
    const historical = { ...validProbe(settingsCase, 'first', '0.5.0'), settingsEvidence: undefined };
    expect(() => assertUpgradeProbe(historical, { phase: 'first', version: '0.5.0', settingsCase })).not.toThrow();
    expect(() => assertUpgradeProbe(historical, { phase: 'first', version: '0.5.0', settingsCase, upgraded: true })).toThrow();
  });
});

function mockDriver() {
  const calls: string[] = []; let current = 'candidate'; const restored = new Set<string>();
  const snapshots = new Map<string, UpgradeSnapshot>();
  const driver: UpgradeDriver = {
    preflight: async () => { calls.push('preflight'); return { cleanHost: true }; },
    acquireBaseline: async pin => { calls.push('download-pinned-baseline'); return { sha256: pin.sha256, bytes: pin.bytes }; },
    signature: async role => { calls.push(`signature:${role}`); return signature; },
    identity: async (role, version) => { calls.push(`identity:${role}:${version}`); expect(current).toBe(role); return { role, version }; },
    uninstall: async role => { calls.push(`uninstall:${role}`); expect(current).toBe(role); current = ''; },
    install: async role => { calls.push(`install:${role}${current ? ':over-' + current : ''}`); current = role; },
    createProfile: async settingsCase => { calls.push(`profile:${settingsCase.name}`); },
    probe: async (settingsCase, phase, version) => {
      calls.push(`probe:${settingsCase.name}:${current}:${phase}`);
      if (current === 'baseline' && phase === 'second') expect(restored.has(settingsCase.name)).toBe(true);
      return validProbe(settingsCase, phase, version);
    },
    snapshot: async (settingsCase, label) => {
      calls.push(`snapshot:${settingsCase.name}:${label}`);
      const snapshot = { label, bytes: 1, files: [{ path: 'private-preferences', bytes: 1, sha256: 'a'.repeat(64) }], sha256: 'b'.repeat(64) };
      snapshots.set(`${settingsCase.name}:${label}`, snapshot); return snapshot;
    },
    assertUnchanged: async (settingsCase, snapshot) => { calls.push(`unchanged:${settingsCase.name}:${snapshot.label}`); expect(snapshot).toBe(snapshots.get(`${settingsCase.name}:${snapshot.label}`)); },
    restore: async (settingsCase, snapshot) => { calls.push(`restore:${settingsCase.name}:${snapshot.label}`); expect(snapshot.label).toBe('pre-upgrade'); restored.add(settingsCase.name); },
  };
  return { driver, calls, restored };
}

describe('installer upgrade/rollback operation order (mocked, no native processes)', () => {
  it('upgrades over the old installation, restores pre-upgrade profiles for rollback and restores the candidate', async () => {
    const { driver, calls } = mockDriver();
    const result = await executeWindowsUpgradeSequence({ expectedVersion: '0.5.1' }, driver);
    expect(calls.slice(0, 8)).toEqual(['preflight', 'download-pinned-baseline', 'signature:baseline', 'signature:candidate', 'identity:candidate:0.5.1', 'uninstall:candidate', 'install:baseline', 'identity:baseline:0.5.0']);
    expect(calls.filter(call => call.startsWith('install:'))).toEqual(['install:baseline', 'install:candidate:over-baseline', 'install:baseline', 'install:candidate']);
    for (const settingsCase of WINDOWS_UPGRADE_CASES) {
      expect(calls.indexOf(`snapshot:${settingsCase.name}:pre-upgrade`)).toBeLessThan(calls.indexOf('install:candidate:over-baseline'));
      expect(calls.indexOf(`restore:${settingsCase.name}:pre-upgrade`)).toBeLessThan(calls.indexOf(`probe:${settingsCase.name}:baseline:second`));
      expect(calls.filter(call => call === `unchanged:${settingsCase.name}:pre-downgrade`)).toHaveLength(2);
      expect(calls.filter(call => call === `unchanged:${settingsCase.name}:before-final-candidate`)).toHaveLength(2);
    }
    expect(result.finalCandidateRestored).toBe(true);
    expect(result.cases).toHaveLength(2);
    expect(result.rollback).toContain('installer-only preference compatibility is not claimed');
    expect(result.limitations.join(' ')).toContain('Recovery-manager UI remains a separate source/test-ASAR gate');
    expect(calls.at(-3)).toBe('identity:candidate:0.5.1');
  });
  it('refuses baseline or candidate signature failure before uninstalling anything', async () => {
    for (const failedRole of ['baseline', 'candidate']) {
      const { driver, calls } = mockDriver(); driver.signature = async role => role === failedRole ? { ...signature, status: 'NotSigned' } : signature;
      await expect(executeWindowsUpgradeSequence({ expectedVersion: '0.5.1' }, driver)).rejects.toThrow(/Authenticode/);
      expect(calls.some(call => call.startsWith('uninstall:'))).toBe(false);
    }
  });
  it('refuses altered baseline bytes or length before executing any installer', async () => {
    for (const changed of [{ sha256: '0'.repeat(64) }, { bytes: 1 }]) {
      const { driver, calls } = mockDriver(); driver.acquireBaseline = async () => ({ sha256: WINDOWS_UPGRADE_BASELINE.sha256, bytes: WINDOWS_UPGRADE_BASELINE.bytes, ...changed });
      await expect(executeWindowsUpgradeSequence({ expectedVersion: '0.5.1' }, driver)).rejects.toThrow(/Pinned baseline/);
      expect(calls.some(call => call.startsWith('uninstall:'))).toBe(false);
    }
  });
  it('does not reach downgrade when upgraded preferences or saved drawing evidence fail', async () => {
    const { driver, calls } = mockDriver(); const original = driver.probe;
    driver.probe = async (...args) => ({ ...await original(...args), ...(args[2] === '0.5.1' ? { entities: 1 } : {}) });
    await expect(executeWindowsUpgradeSequence({ expectedVersion: '0.5.1' }, driver)).rejects.toThrow();
    expect(calls.filter(call => call === 'install:baseline')).toHaveLength(1);
    expect(calls.some(call => call.startsWith('restore:'))).toBe(false);
  });
  it('fails on a changed closed profile before launching the upgraded app', async () => {
    const { driver, calls } = mockDriver(); driver.assertUnchanged = async () => { throw new Error('Closed profile bytes changed'); };
    await expect(executeWindowsUpgradeSequence({ expectedVersion: '0.5.1' }, driver)).rejects.toThrow(/Closed profile/);
    expect(calls.some(call => /:candidate:second$/.test(call))).toBe(false);
    expect(calls.some(call => call.startsWith('restore:'))).toBe(false);
  });
  it('stops before all installer work when the host safety preflight fails', async () => {
    const { driver, calls } = mockDriver(); driver.preflight = async () => { throw new Error('Foreign installed JCad'); };
    await expect(executeWindowsUpgradeSequence({ expectedVersion: '0.5.1' }, driver)).rejects.toThrow(/Foreign/);
    expect(calls).toEqual([]);
  });
  it('does not falsely mark success when rollback reopening fails', async () => {
    const { driver, calls } = mockDriver(); const original = driver.probe;
    driver.probe = async (...args) => { if (args[1] === 'second' && args[2] === '0.5.0') throw new Error('Rollback reopen failed'); return original(...args); };
    await expect(executeWindowsUpgradeSequence({ expectedVersion: '0.5.1' }, driver)).rejects.toThrow(/Rollback/);
    expect(calls.at(-1)).toMatch(/^unchanged:.*:pre-upgrade$/);
    expect(calls.filter(call => call.startsWith('install:candidate'))).toHaveLength(1);
  });
});

const owned: string[] = [];
afterEach(() => { for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true }); });
function privateDirectory() { const root = mkdtempSync(join(tmpdir(), 'jcad-upgrade-test-')); owned.push(root); return root; }

describe('private profile ownership and exact tree evidence', () => {
  it('detects changed bytes, added/removed paths and empty directories independently', () => {
    const root = privateDirectory(); mkdirSync(join(root, 'Local Storage')); mkdirSync(join(root, 'empty'));
    writeFileSync(join(root, 'Local Storage', 'prefs'), 'a');
    const initial = inventoryUpgradeTree(root);
    writeFileSync(join(root, 'Local Storage', 'prefs'), 'b');
    expect(inventoryUpgradeTree(root).sha256).not.toBe(initial.sha256);
    writeFileSync(join(root, 'Local Storage', 'prefs'), 'a'); expect(inventoryUpgradeTree(root)).toEqual(initial);
    rmSync(join(root, 'empty'), { recursive: true }); expect(inventoryUpgradeTree(root).sha256).not.toBe(initial.sha256);
    mkdirSync(join(root, 'empty')); writeFileSync(join(root, 'extra'), 'x'); expect(inventoryUpgradeTree(root).sha256).not.toBe(initial.sha256);
    expect(readFileSync(join(root, 'Local Storage', 'prefs'), 'utf8')).toBe('a');
  });
  it('admits canonical owned paths, including not-yet-created install targets', () => {
    const parent = privateDirectory(), root = join(parent, 'jcad-smoke-owned'); mkdirSync(root);
    expect(assertOwnedUpgradePath(join(root, 'new', 'JCad Electrical.exe'), parent, 'jcad-smoke-')).toBe(resolve(root, 'new', 'JCad Electrical.exe'));
  });
  it('rejects prefix lookalikes, parent/root escapes and unowned descendants', () => {
    const parent = privateDirectory(); mkdirSync(join(parent, 'jcad-smoke-owned')); mkdirSync(join(parent, 'unowned'));
    for (const path of [parent, dirnameForTest(parent), join(parent, 'unowned', 'JCad Electrical.exe'), join(parent, 'jcad-smoke-owned', '..', 'unowned')]) expect(() => assertOwnedUpgradePath(path, parent, 'jcad-smoke-')).toThrow();
  });
  it('refuses a linked root, a linked ancestor and profile contents pointing elsewhere', () => {
    const parent = privateDirectory(), real = join(parent, 'actual'); mkdirSync(real); writeFileSync(join(real, 'private'), 'preserve');
    const linked = join(parent, 'jcad-smoke-linked'); symlinkSync(real, linked, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => assertOwnedUpgradePath(join(linked, 'private'), parent, 'jcad-smoke-')).toThrow(/link/);
    expect(() => inventoryUpgradeTree(linked)).toThrow(/linked/);
    const profile = join(parent, 'profile'); mkdirSync(profile); symlinkSync(real, join(profile, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => inventoryUpgradeTree(profile)).toThrow(/links/);
    expect(readFileSync(join(real, 'private'), 'utf8')).toBe('preserve');
  });
});

describe('synthetic untitled recovery entry produced by pinned production storage inputs', () => {
  it('creates the existing version-1 index and readable unsaved drawing deterministically', async () => {
    const profile = privateDirectory(), other = privateDirectory();
    const proof = await seedWindowsUpgradeRecoveryFixture({ profile, repo: resolve('.') });
    const again = await seedWindowsUpgradeRecoveryFixture({ profile: other, repo: resolve('.') });
    expect(proof.files).toEqual(again.files); expect(proof.inputs).toHaveLength(4);
    expect(proof.inputs.every(input => input.exactBytesEqual)).toBe(true);
    expect(proof.scope).toContain('not a dirty autosave generated by the old shipping application');
    assertWindowsUpgradeRecoveryFixture(profile, proof);
    const index = JSON.parse(readFileSync(join(profile, 'autosave', 'index.json'), 'utf8'));
    expect(index.version).toBe(1); expect(Object.values(index.entries)).toEqual([{ title: 'Untitled upgrade recovery Δ 雷', originalPath: null, savedAt: 1710000000000 }]);
    const drawing = readDxf(readFileSync(join(profile, proof.files.find(file => file.path.endsWith('.dxf'))!.path), 'utf8'));
    expect(drawing.entities).toHaveLength(1); expect(drawing.entities[0]).toMatchObject({ type: 'line', a: { x: 31, y: 41 }, b: { x: 59, y: 26 } });
  });
  it('refuses changed recovery drawing/index bytes and incomplete or duplicate proofs', async () => {
    const profile = privateDirectory(), proof = await seedWindowsUpgradeRecoveryFixture({ profile, repo: resolve('.') });
    for (const file of proof.files) {
      const path = join(profile, file.path), original = readFileSync(path);
      writeFileSync(path, Buffer.concat([original, Buffer.from('changed')])); expect(() => assertWindowsUpgradeRecoveryFixture(profile, proof)).toThrow();
      writeFileSync(path, original); assertWindowsUpgradeRecoveryFixture(profile, proof);
    }
    expect(() => assertWindowsUpgradeRecoveryFixture(profile, { ...proof, files: [proof.files[0], proof.files[0]] })).toThrow(/exactly one/);
    expect(() => assertWindowsUpgradeRecoveryFixture(profile, { ...proof, files: [proof.files[0]] })).toThrow();
  });
  it('refuses modified storage code before it can produce a convincing fixture', async () => {
    const parent = privateDirectory(), profile = join(parent, 'profile'), fakeRepo = join(parent, 'repo'); mkdirSync(profile); mkdirSync(join(fakeRepo, 'electron'), { recursive: true });
    for (const input of WINDOWS_UPGRADE_RECOVERY_INPUTS) writeFileSync(join(fakeRepo, input.file), readFileSync(resolve(input.file)));
    writeFileSync(join(fakeRepo, 'electron', 'autosave-store.cjs'), 'throw new Error("counterfeit storage producer");');
    await expect(seedWindowsUpgradeRecoveryFixture({ profile, repo: fakeRepo })).rejects.toThrow(/production storage input differs/);
  });
});

function dirnameForTest(path: string) { return resolve(path, '..'); }
