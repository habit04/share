// Destructive installer operations are confined to the disposable hosted Windows release
// job. Stock Electron only seeds private DOM storage; production keeps its shipping fuses.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { load as loadYaml } from 'js-yaml';
import { verifyExecutableFuses } from './electron-fuse-policy.mjs';

export const WINDOWS_UPGRADE_BASELINE = Object.freeze({
  version: '0.5.0', publisher: 'Justin Rodriguez',
  url: 'https://github.com/habit04/share/releases/download/v0.5.0/jcad-electrical-0.5.0-win-x64.exe',
  sha256: '116845741d59ec0df32a8ef3c29f4ce9f6f1dcfabcb5cadcf96e42d75b884828', bytes: 154080840,
});
// electron-builder's UUIDv5(com.jcad.electrical, 50e065bc-3134-11e6-9bab-38c9862bdaf3).
// Both released v0.5.0 and the candidate use these keys without NSIS overrides.
export const WINDOWS_UPGRADE_REGISTRATION = Object.freeze({
  key: 'c1233997-d5fc-5715-924c-8a725ad91ad6',
  installationKey: 'Software\\c1233997-d5fc-5715-924c-8a725ad91ad6',
});
/** Read every uninstall row and pair the application key within the same hive/view.
 * The NSIS InstallLocation is stored in the application key, not the uninstall row.
 * No registry command string or icon path is used to infer installation ownership.
 */
export const WINDOWS_UPGRADE_REGISTRY_QUERY = `$items=@(); $views=0
foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)) {
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
    $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
    try {
      $installation=$base.OpenSubKey('${WINDOWS_UPGRADE_REGISTRATION.installationKey}')
      try {
        $location=if ($installation) { [string]$installation.GetValue('InstallLocation') } else { '' }
        $key=$base.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall')
        if ($key) { try { foreach ($name in $key.GetSubKeyNames()) {
          $entry=$key.OpenSubKey($name)
          if (!$entry) { throw 'Uninstall entry disappeared during identity inventory' }
          try { $items+=@{hive=[string]$hive;view=[string]$view;key=$name;name=[string]$entry.GetValue('DisplayName');version=[string]$entry.GetValue('DisplayVersion');icon=[string]$entry.GetValue('DisplayIcon');installationKey='${WINDOWS_UPGRADE_REGISTRATION.installationKey}';installationPresent=[bool]$installation;location=$location} }
          finally { $entry.Dispose() }
        } } finally { $key.Dispose() } }
      } finally { if ($installation) { $installation.Dispose() } }
      $views++
    } finally { $base.Dispose() }
  }
}
ConvertTo-Json -InputObject @{queryCompleted=$true;registryViews=$views;entries=@($items)} -Depth 4 -Compress`;
export const WINDOWS_UPGRADE_CASES = Object.freeze([
  Object.freeze({ name: 'explicit-3d-off', experimental3d: false, importForeign3d: false }),
  Object.freeze({ name: 'legacy-3d-on', experimental3d: true, importForeign3d: true }),
]);
// These four production inputs were read from released v0.5.0 commit a580c9c6e27952c2b15e0a75b940facd3ec4f1fc.
// Both exact byte encodings are explicit: Git LF and Windows checkout CRLF; no other change is accepted.
export const WINDOWS_UPGRADE_RECOVERY_INPUTS = Object.freeze([
  { file: 'electron/autosave-store.cjs', lf: 'dcfa48923a403006f39c327ebad59400e0d3f330c7ef3fea2b257a6e7cec180b', crlf: 'de19c88607ae1819c6fde894f63c9964d5ce3458c73ba4198043ca1bf5dffa39' },
  { file: 'electron/atomic-write.cjs', lf: '4529d23cd18703370540cb72ec18a54bb2329ce525835662a6c5ff847a96e786', crlf: '7bebcac839cb041c6d2f8e1f009bec70baaf7f23a27ab02051e4fa0bfd03cdd4' },
  { file: 'electron/resource-limits.cjs', lf: 'd526a132d10c12b9e7a3b4b4f290b21eee549ea157c99770c7b86b94ab863628', crlf: '3720b62e4e792deb4c13cffa29392811e6817ed75c4c94dcf18e5f5708191d42' },
  { file: 'electron/file-errors.cjs', lf: '26a77b23ac28c7f259b91acf876a7a26dcfc32f4913afdf23b329a237ad8af55', crlf: '0946ffcd24ad054dddc7ee69196be3a93df663c54523cb54cac5afe716873c25' },
].map(input => Object.freeze(input)));
const fixtureText = '0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n10\n20\n10\n11\n20\n21\n20\n0\nENDSEC\n0\nEOF\n';
const preferences = Object.freeze({ gridVisible: false, crosshairSize: 17, modelBackground: '#293541', autosaveMinutes: 7, units: 'engineering', unitSuffix: 'ft', precision: 3, language: 'en' });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** PowerShell 7/bundled host module paths must not poison Windows PowerShell 5 cmdlets. */
export function isolatedWindowsPowerShellEnvironment(source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  return env;
}

/** Deterministic on-disk format fixture, authored by pinned production storage code. */
export async function seedWindowsUpgradeRecoveryFixture({ profile, repo, baselineArchive = null }) {
  const code = join(profile, 'upgrade-recovery-code'); mkdirSync(code);
  const inputs = [], asar = baselineArchive ? createRequire(import.meta.url)('@electron/asar') : null;
  if (asar) asar.uncache(baselineArchive);
  for (const pin of WINDOWS_UPGRADE_RECOVERY_INPUTS) {
    const current = readFileSync(join(repo, ...pin.file.split('/')));
    const original = asar ? asar.extractFile(baselineArchive, pin.file, false) : current;
    const currentHash = sha256(current), originalHash = sha256(original);
    assert.ok([pin.lf, pin.crlf].includes(originalHash), `${pin.file}: baseline production storage input differs`);
    assert.ok([pin.lf, pin.crlf].includes(currentHash), `${pin.file}: current production storage input differs`);
    writeFileSync(join(code, basename(pin.file)), original, { flag: 'wx' });
    inputs.push({ file: pin.file, baselineGitSha256: pin.lf, baselineLoadedSha256: originalHash, currentSha256: currentHash,
      exactBytesEqual: original.equals(current), baselineEncoding: originalHash === pin.lf ? 'git-lf' : 'windows-checkout-crlf', currentEncoding: currentHash === pin.lf ? 'git-lf' : 'windows-checkout-crlf' });
  }
  const store = createRequire(import.meta.url)(join(code, 'autosave-store.cjs')).createAutosaveStore(join(profile, 'autosave'));
  const name = '5cbdbccb-7343-468b-bd55-07ed0d82af8f.sv.dxf';
  const text = fixtureText.replace('10\n10\n20\n10\n11\n20\n21\n20', '10\n31\n20\n41\n11\n59\n21\n26');
  await store.write(name, text, { title: 'Untitled upgrade recovery Δ 雷', originalPath: null, savedAt: 1710000000000 });
  const listed = await store.list(); assert.equal(listed.length, 1); assert.equal(listed[0].name, name);
  const files = ['autosave/index.json', 'autosave/' + name].map(file => {
    const bytes = readFileSync(join(profile, ...file.split('/'))); return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
  });
  return { source: baselineArchive ? 'installed pinned v0.5.0 production ASAR storage code' : 'checkout code matched to pinned v0.5.0 production inputs (unit fixture)', inputs, files,
    scope: 'Deterministic synthetic untitled entry in the existing production storage format; not a dirty autosave generated by the old shipping application. Recovery UI remains a separate test-ASAR gate.' };
}

export function assertWindowsUpgradeRecoveryFixture(profile, proof) {
  assert.ok(Array.isArray(proof?.files) && proof.files.length === 2, 'Recovery index and document proofs are required');
  assert.deepEqual(proof.files.map(file => file.path).sort(), ['autosave/5cbdbccb-7343-468b-bd55-07ed0d82af8f.sv.dxf', 'autosave/index.json'], 'Recovery proof must include exactly one index and one drawing');
  for (const file of proof.files) {
    assert.ok(file.path === 'autosave/index.json' || file.path === 'autosave/5cbdbccb-7343-468b-bd55-07ed0d82af8f.sv.dxf', 'Only the fixed recovery fixture paths are admitted');
    const target = join(profile, ...file.path.split('/')), stat = lstatSync(target);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Recovery fixture must remain a regular file');
    const data = readFileSync(target); assert.equal(data.length, file.bytes); assert.equal(sha256(data), file.sha256, 'Existing recovery index/document bytes changed');
  }
}

/** No opt-in environment variable can enable destructive validation on a developer PC. */
export function assertWindowsUpgradeHost({ platform, arch, env }) {
  assert.equal(platform, 'win32', 'Upgrade validation requires Windows');
  assert.equal(arch, 'x64', 'The pinned baseline is Windows x64');
  for (const [key, expected] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', GITHUB_REPOSITORY: 'habit04/share' })) assert.equal(env[key], expected, `Upgrade validation requires hosted release CI: ${key}`);
  const workflow = env.GITHUB_JOB === 'packaged-smoke' ? 'release.yml' : env.GITHUB_JOB === 'smoke' ? 'packaged-smoke.yml' : null;
  assert.ok(workflow, 'Only reviewed packaged-smoke job identities may execute installers');
  const prefix = `habit04/share/.github/workflows/${workflow}@`;
  assert.ok(env.GITHUB_WORKFLOW_REF?.startsWith(prefix) && /^refs\/(?:heads|tags)\/.+$/.test(env.GITHUB_WORKFLOW_REF.slice(prefix.length)), 'Only the matching reviewed repository workflow may execute installers');
  assert.match(env.GITHUB_RUN_ID || '', /^\d+$/, 'A hosted run identity is required');
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/, 'An exact hosted source commit is required');
  // GitHub's Windows 2025 / Visual Studio 2026 image publishes this exact variant.
  assert.match(env.ImageOS || '', /^(?:win\d+|win25-vs2026)$/, 'A hosted Windows image identity is required');
  assert.equal((env.USERNAME || '').toLowerCase(), 'runneradmin', 'Only the disposable hosted Windows account is permitted');
  assert.ok(env.RUNNER_TEMP && env.USERPROFILE, 'Hosted private paths are required');
}

export function needsWindowsUpgradeSmoke(version, platform = process.platform) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  assert.ok(match, 'Invalid upgrade smoke version');
  const [, major, minor, patch] = match.map(Number);
  return platform === 'win32' && (major > 0 || minor > 5 || (minor === 5 && patch >= 1));
}

export function assertUpgradeSignature(record, publisher = WINDOWS_UPGRADE_BASELINE.publisher) {
  assert.equal(record?.status, 'Valid', 'An Authenticode Valid signature is required before execution');
  assert.equal(record?.publisher, publisher, 'The installer/executable must match the established updater publisher');
  assert.match(record?.thumbprint || '', /^[a-f0-9]{40,64}$/i, 'Signer certificate identity is required');
}

/** Installer PE ProductVersion remains exact; application tuple rules do not apply. */
export function assertWindowsInstallerVersion(record, expectedVersion) {
  assert.equal(record?.version, expectedVersion, 'Installer version identity differs');
}

/** Compare both raw application PE strings without normalizing arbitrary suffixes/revisions.
 * Electron's stable Windows application ProductVersion may append one zero revision.
 * FileVersion must still identify the exact semantic release; runtime probes stay exact.
 */
export function assertWindowsApplicationVersion(record, expectedVersion) {
  assert.ok(typeof expectedVersion === 'string' && expectedVersion.length > 0, 'Expected application version is required');
  const zeroRevision = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(expectedVersion) && record?.version === expectedVersion + '.0';
  assert.ok(record?.version === expectedVersion || zeroRevision, 'Installed application ProductVersion differs');
  assert.equal(record?.fileVersion, expectedVersion, 'Installed application FileVersion differs');
}

/** Read and authenticate raw PE identity before any installer/application execution. */
function verifySignedWindowsVersionInfo(file) {
  assertWindowsUpgradeHost({ platform: process.platform, arch: process.arch, env: process.env });
  assert.ok(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'Signed executable must be a regular file');
  const literal = `'${realpathSync.native(file).replace(/'/g, "''")}'`;
  const script = `$ErrorActionPreference='Stop'; $f=${literal}; $s=Get-AuthenticodeSignature -LiteralPath $f; if (!$s.SignerCertificate) { throw 'Missing signer certificate' }; $v=(Get-Item -LiteralPath $f).VersionInfo; @{status=[string]$s.Status;publisher=$s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false);thumbprint=$s.SignerCertificate.Thumbprint;version=$v.ProductVersion;fileVersion=$v.FileVersion} | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: isolatedWindowsPowerShellEnvironment(), encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.ok(!result.error && result.status === 0 && !result.signal, `Executable signature verification failed: ${result.error?.message || result.signal || result.status}: ${result.stderr || ''}`);
  const signature = JSON.parse(result.stdout.trim()); assertUpgradeSignature(signature);
  const data = readFileSync(file);
  return { ...signature, sha256: sha256(data), bytes: data.length };
}

/** Authenticate the installer before the caller's first clean-install execution. */
export function verifyWindowsUpgradeInstaller(file, expectedVersion) {
  const record = verifySignedWindowsVersionInfo(file);
  assertWindowsInstallerVersion(record, expectedVersion);
  return record;
}

/** Authenticate the application's distinct raw PE version representation. */
export function verifyWindowsUpgradeApplication(file, expectedVersion) {
  const record = verifySignedWindowsVersionInfo(file);
  assertWindowsApplicationVersion(record, expectedVersion);
  return record;
}

/** Pure signature/publisher/hash admission for the exact installed app and native helper.
 * @param {string} configuredPublisher
 */
export function assertWindowsShippingPayloadTrust(record, expectedVersion, configuredPublisher = WINDOWS_UPGRADE_BASELINE.publisher) {
  assert.equal(configuredPublisher.trim(), WINDOWS_UPGRADE_BASELINE.publisher, 'Configured publisher differs from the established Windows publisher');
  assert.equal(record?.expectedVersion, expectedVersion);
  assert.deepEqual(record?.updaterPublishers, [WINDOWS_UPGRADE_BASELINE.publisher], 'Updater publisher does not match the established signer');
  for (const role of ['application', 'helper']) {
    const file = record?.[role]; assertUpgradeSignature(file);
    assert.match(file?.sha256 || '', /^[a-f0-9]{64}$/, `${role}: exact signed bytes are required`);
    assert.ok(Number.isSafeInteger(file?.bytes) && file.bytes > 0, `${role}: signed file byte count is required`);
  }
  assertWindowsApplicationVersion(record.application, expectedVersion);
  // The independently versioned native helper must not be assigned the application's version.
}

/** Authenticate actual installed executables before any --probe-dwg/startup execution. */
export function verifyWindowsShippingPayloadTrust({ executable, expectedVersion }) {
  assertWindowsUpgradeHost({ platform: process.platform, arch: process.arch, env: process.env });
  const application = verifyWindowsUpgradeApplication(executable, expectedVersion);
  const helper = join(dirname(executable), 'resources', 'dwg-writer', 'JcadDwgWriter.exe');
  assert.ok(lstatSync(helper).isFile() && !lstatSync(helper).isSymbolicLink(), 'The installed native helper must be a regular file');
  const updateFile = join(dirname(executable), 'resources', 'app-update.yml'), stat = lstatSync(updateFile);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 65536, 'Installed updater identity must be bounded regular YAML');
  const updater = loadYaml(readFileSync(updateFile, 'utf8'));
  assert.ok(updater && typeof updater === 'object' && 'publisherName' in updater, 'Installed updater publisher identity missing');
  const updaterPublishers = typeof updater.publisherName === 'string' ? [updater.publisherName] : updater.publisherName;
  const literal = `'${realpathSync.native(helper).replace(/'/g, "''")}'`;
  const script = `$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath ${literal}; if (!$s.SignerCertificate) { throw 'Native helper signer missing' }; @{status=[string]$s.Status;publisher=$s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false);thumbprint=$s.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: isolatedWindowsPowerShellEnvironment(), encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.ok(!result.error && result.status === 0 && !result.signal, `Native helper signature verification failed: ${result.error?.message || result.signal || result.status}: ${result.stderr || ''}`);
  const data = readFileSync(helper);
  const record = { expectedVersion, updaterPublishers, application, helper: { ...JSON.parse(result.stdout.trim()), sha256: sha256(data), bytes: data.length } };
  assertWindowsShippingPayloadTrust(record, expectedVersion, process.env.AZURE_PUBLISHER_NAME || WINDOWS_UPGRADE_BASELINE.publisher);
  return record;
}

/** Admit only the pinned NSIS application identity and its same-hive/view install path. */
export function selectWindowsUpgradeRegistration(inventory, { target, candidateVersion }) {
  assert.equal(inventory?.queryCompleted, true, 'Uninstall identity inventory must complete');
  assert.equal(inventory?.registryViews, 4, 'Uninstall identity requires all four registry views');
  assert.ok(Array.isArray(inventory?.entries) && inventory.entries.length <= 10000, 'Bounded uninstall identity inventory is required');
  const fullyQualified = value => typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value) && !value.includes('\0');
  assert.ok(fullyQualified(target), 'The owned installation target must be an absolute Windows path');
  const owned = win32.resolve(target).toLowerCase();
  const entries = inventory.entries.filter(entry => {
    assert.ok(entry && typeof entry === 'object', 'Malformed uninstall identity row');
    return /^\s*JCad\b/i.test(entry.name || '') || (typeof entry.key === 'string' && entry.key.toLowerCase() === WINDOWS_UPGRADE_REGISTRATION.key);
  });
  for (const entry of entries) {
    assert.equal(typeof entry.key === 'string' && entry.key.toLowerCase(), WINDOWS_UPGRADE_REGISTRATION.key, 'JCad uninstall key differs from the pinned application');
    assert.ok([WINDOWS_UPGRADE_BASELINE.version, candidateVersion].includes(entry.version), 'Unrecognized JCad registry version');
    assert.ok(entry.name === 'JCad Electrical' || entry.name === `JCad Electrical ${entry.version}`, 'JCad display name differs from its registered version');
    assert.equal(entry.installationKey, WINDOWS_UPGRADE_REGISTRATION.installationKey, 'Paired application registry key differs');
    assert.equal(entry.installationPresent, true, 'Paired application installation key is missing');
    assert.ok(fullyQualified(entry.location), 'Paired InstallLocation must be an absolute Windows path');
    assert.equal(win32.resolve(entry.location).toLowerCase(), owned, 'A JCad installation exists outside the owned CI target');
  }
  // Also validates raw hive/view/key identities and duplicate rows before destructive work.
  if (entries.length) assertStableWindowsUpgradeRegistration(entries);
  return entries;
}

/** Keep the exact uninstall registration namespace stable across upgrade and rollback. */
export function assertStableWindowsUpgradeRegistration(entries, expected = null) {
  assert.ok(Array.isArray(entries) && entries.length > 0, 'Installed uninstall registration identity missing');
  const identities = entries.map(entry => {
    assert.ok(['CurrentUser', 'LocalMachine'].includes(entry.hive), 'Uninstall hive identity missing');
    assert.ok(['Registry32', 'Registry64'].includes(entry.view), 'Uninstall registry view identity missing');
    assert.ok(typeof entry.key === 'string' && entry.key.length > 0 && entry.key.length <= 256, 'Uninstall registry key identity missing');
    return { hive: entry.hive, view: entry.view, key: entry.key };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.equal(new Set(identities.map(value => JSON.stringify(value))).size, identities.length, 'Duplicate uninstall identity');
  if (expected !== null) assert.deepEqual(identities, expected, 'Uninstall registration moved between hive/view/key during upgrade or rollback');
  return identities;
}

/** Fail closed when the read-only inventory is incomplete or any JCad is already present. */
export function assertCleanWindowsUpgradeInventory(inventory) {
  assert.equal(inventory?.queryCompleted, true, 'Clean-install inventory must complete every query');
  assert.equal(inventory?.registryViews, 4, 'Clean install requires HKCU/HKLM, 32/64-bit uninstall views');
  assert.ok(Number.isSafeInteger(inventory?.uninstallEntries) && inventory.uninstallEntries >= 0, 'Uninstall enumeration count is required');
  assert.ok(Array.isArray(inventory?.installedJcad), 'Installed JCad inventory is required');
  assert.ok(Array.isArray(inventory?.runningJcad), 'Running JCad inventory is required');
  assert.equal(inventory.installedJcad.length, 0, 'Clean install refuses an existing registered JCad installation');
  assert.equal(inventory.runningJcad.length, 0, 'Clean install refuses running JCad applications or DWG helpers');
}

/** Read-only hosted inventory, called BEFORE the first candidate NSIS execution. */
export function assertCleanWindowsUpgradeHostBeforeInstall({ repo, outDir }) {
  assertWindowsUpgradeHost({ platform: process.platform, arch: process.arch, env: process.env });
  const script = `$ErrorActionPreference='Stop'; $items=@(); $views=0; $entries=0;
foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)) {
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
    $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view);
    try { $key=$base.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall');
      if ($key) { try { foreach ($name in $key.GetSubKeyNames()) {
        $entry=$key.OpenSubKey($name); if (!$entry) { throw 'Uninstall entry disappeared during inventory' }
        try { $entries++; $display=[string]$entry.GetValue('DisplayName'); if ($display -match '^\\s*JCad\\b') {
          $items+=@{name=$display.Substring(0,[Math]::Min(256,$display.Length));location=[string]$entry.GetValue('InstallLocation')}
        } } finally { $entry.Dispose() }
      } } finally { $key.Dispose() } }
      $views++;
    } finally { $base.Dispose() }
  }
}
$processes=@(Get-CimInstance Win32_Process -Filter "Name = 'JCad Electrical.exe' OR Name = 'jcad-electrical.exe' OR Name = 'JCad.exe' OR Name = 'JcadDwgWriter.exe'" | Select-Object ProcessId,Name,ExecutablePath);
@{queryCompleted=$true;registryViews=$views;uninstallEntries=$entries;installedJcad=@($items);runningJcad=@($processes)} | ConvertTo-Json -Depth 4 -Compress`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: isolatedWindowsPowerShellEnvironment(), encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.ok(!result.error && result.status === 0 && !result.signal, `Clean-install inventory failed: ${result.error?.message || result.signal || result.status}: ${result.stderr || ''}`);
  const inventory = JSON.parse(result.stdout.trim()); assertCleanWindowsUpgradeInventory(inventory);
  const evidence = join(resolve(outDir), 'clean-install-no-autocad-inventory.json'); mkdirSync(dirname(evidence), { recursive: true });
  const noCad = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(resolve(repo), 'scripts', 'check-no-autocad.ps1'), '-EvidencePath', evidence], {
    cwd: resolve(repo), env: isolatedWindowsPowerShellEnvironment({ ...process.env, SOURCE_SHA: process.env.GITHUB_SHA }), encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.ok(!noCad.error && noCad.status === 0 && !noCad.signal, `Clean-install AutoCAD absence inventory failed: ${noCad.error?.message || noCad.signal || noCad.status}: ${noCad.stderr || ''}`);
  return { hostedWindows: true, sourceSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, inventory,
    noAutoCadEvidence: basename(evidence),
    scope: 'Before first NSIS: four uninstall registry views and known JCad/portable DWG helper process names; separate full AutoCAD absence inventory. Arbitrary unregistered portable JCad directories are not searched.' };
}

/** Runtime evidence comes only from the existing fixed, non-inspectable startup probe. */
export function assertUpgradeProbe(record, { phase, version, settingsCase, upgraded = false }) {
  assert.equal(record?.phase, phase); assert.equal(record?.version, version);
  assert.equal(record?.packaged, true); assert.equal(record?.testBuild, false);
  assert.equal(record?.url, 'jcad://app/index.html'); assert.equal(record?.dirty, false);
  assert.equal(record?.before, phase === 'first' ? 1 : 2); assert.equal(record?.entities, 2);
  assert.equal(record?.saved, phase === 'first');
  for (const key of ['secure', 'bridge', 'persistent', 'privateSessionData', 'privateStorage', 'migrationMarker']) assert.equal(record?.[key], true, key);
  if (upgraded) {
    const evidence = record.settingsEvidence;
    assert.ok(evidence, 'The new runtime must report actual normalized settings');
    for (const [key, value] of Object.entries(preferences)) assert.equal(evidence[key], value, `Preserved preference ${key}`);
    assert.equal(evidence.experimental3d, settingsCase.experimental3d);
    assert.equal(evidence.importForeign3d, settingsCase.importForeign3d, 'Legacy opt-in/explicit opt-out migration');
    assert.equal(evidence.upgradeSentinel, `upgrade sentinel Δ 雷 ${settingsCase.name}`);
    for (const key of ['canvasDefault', 'controllerInactive', 'no3dCanvas', 'kernelUnstarted']) assert.equal(evidence[key], true, key);
    assert.equal(evidence.controllerInstalled, settingsCase.experimental3d, 'Restarted controller follows the preserved explicit setting');
  }
}

/**
 * The orchestration is separately testable without spawning any installer/application.
 * Adapter results are checked before subsequent destructive operations are admitted.
 * @param {{ expectedVersion: string }} options
 * @param {import('./windows-upgrade-smoke.mjs').UpgradeDriver} driver
 */
export async function executeWindowsUpgradeSequence({ expectedVersion }, driver) {
  assert.ok(needsWindowsUpgradeSmoke(expectedVersion, 'win32'), 'Upgrade gate requires a new candidate version');
  const record = { baseline: WINDOWS_UPGRADE_BASELINE, expectedVersion, cleanHost: null, signatures: [], identities: [], cases: [], rollback: 'restored pre-upgrade private profiles; installer-only preference compatibility is not claimed', finalCandidateRestored: false,
    limitations: ['Recovery preservation is scoped to deterministic synthetic v0.5.0-format index/document bytes produced by pinned production storage code; no dirty autosave generated by the old shipping process is claimed. Recovery-manager UI remains a separate source/test-ASAR gate with its own attribution.'] };
  record.cleanHost = await driver.preflight();
  const baseline = await driver.acquireBaseline(WINDOWS_UPGRADE_BASELINE);
  assert.equal(baseline.sha256, WINDOWS_UPGRADE_BASELINE.sha256, 'Pinned baseline bytes changed');
  assert.equal(baseline.bytes, WINDOWS_UPGRADE_BASELINE.bytes, 'Pinned baseline size changed');
  for (const role of ['baseline', 'candidate']) {
    const signature = await driver.signature(role); assertUpgradeSignature(signature);
    record.signatures.push({ role, ...signature });
  }
  record.identities.push(await driver.identity('candidate', expectedVersion));
  await driver.uninstall('candidate');
  await driver.install('baseline');
  record.identities.push(await driver.identity('baseline', WINDOWS_UPGRADE_BASELINE.version));
  for (const settingsCase of WINDOWS_UPGRADE_CASES) {
    await driver.createProfile(settingsCase);
    const first = await driver.probe(settingsCase, 'first', WINDOWS_UPGRADE_BASELINE.version);
    assertUpgradeProbe(first, { phase: 'first', version: WINDOWS_UPGRADE_BASELINE.version, settingsCase });
    const before = await driver.snapshot(settingsCase, 'pre-upgrade');
    record.cases.push({ name: settingsCase.name, first, preUpgrade: before });
  }
  // This is the actual upgrade: the new installer runs over the old installed application.
  await driver.install('candidate');
  record.identities.push(await driver.identity('candidate', expectedVersion));
  for (const [i, settingsCase] of WINDOWS_UPGRADE_CASES.entries()) {
    await driver.assertUnchanged(settingsCase, record.cases[i].preUpgrade);
    const second = await driver.probe(settingsCase, 'second', expectedVersion);
    assertUpgradeProbe(second, { phase: 'second', version: expectedVersion, settingsCase, upgraded: true });
    record.cases[i].upgraded = second;
    record.cases[i].preDowngrade = await driver.snapshot(settingsCase, 'pre-downgrade');
  }
  await driver.uninstall('candidate');
  for (const [i, settingsCase] of WINDOWS_UPGRADE_CASES.entries()) await driver.assertUnchanged(settingsCase, record.cases[i].preDowngrade);
  await driver.install('baseline');
  record.identities.push(await driver.identity('baseline', WINDOWS_UPGRADE_BASELINE.version));
  for (const [i, settingsCase] of WINDOWS_UPGRADE_CASES.entries()) {
    await driver.assertUnchanged(settingsCase, record.cases[i].preDowngrade);
    await driver.restore(settingsCase, record.cases[i].preUpgrade);
    await driver.assertUnchanged(settingsCase, record.cases[i].preUpgrade);
    const rollback = await driver.probe(settingsCase, 'second', WINDOWS_UPGRADE_BASELINE.version);
    assertUpgradeProbe(rollback, { phase: 'second', version: WINDOWS_UPGRADE_BASELINE.version, settingsCase });
    record.cases[i].rollback = rollback;
    record.cases[i].beforeFinalCandidate = await driver.snapshot(settingsCase, 'before-final-candidate');
  }
  await driver.uninstall('baseline');
  for (const [i, settingsCase] of WINDOWS_UPGRADE_CASES.entries()) await driver.assertUnchanged(settingsCase, record.cases[i].beforeFinalCandidate);
  await driver.install('candidate');
  record.identities.push(await driver.identity('candidate', expectedVersion));
  for (const [i, settingsCase] of WINDOWS_UPGRADE_CASES.entries()) await driver.assertUnchanged(settingsCase, record.cases[i].beforeFinalCandidate);
  record.finalCandidateRestored = true;
  return record;
}

/** Canonical tree inventory rejects links/special files and bounds private profile copies. */
export function inventoryUpgradeTree(directory) {
  assert.ok(!lstatSync(directory).isSymbolicLink(), 'Upgrade tree root may not be linked');
  const root = realpathSync.native(directory), files = [];
  let bytes = 0;
  const visit = (folder, depth) => {
    assert.ok(depth < 32, 'Private profile depth exceeds the upgrade bound');
    for (const name of readdirSync(folder).sort()) {
      const file = join(folder, name), stat = lstatSync(file);
      assert.ok(!stat.isSymbolicLink(), 'Private upgrade trees may not contain links');
      assert.ok(files.length < 10000, 'Private profile exceeds the upgrade file bound');
      if (stat.isDirectory()) { files.push({ path: relative(root, file).split(sep).join('/'), directory: true }); visit(file, depth + 1); }
      else {
        assert.ok(stat.isFile(), 'Private upgrade tree must contain regular files');
        bytes += stat.size; assert.ok(bytes <= 256 * 1024 * 1024, 'Private profile exceeds the upgrade byte bound');
        files.push({ path: relative(root, file).split(sep).join('/'), bytes: stat.size, sha256: sha256(readFileSync(file)) });
      }
    }
  };
  visit(root, 0);
  return { files, bytes, sha256: sha256(JSON.stringify(files)) };
}

function assertBelow(file, root) {
  const path = relative(root, file);
  assert.ok(path && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path), 'Upgrade path escaped its owned directory');
}

/** Require a canonical direct TEMP child, not a similarly named or linked user directory. */
export function assertOwnedUpgradePath(file, scratchParent, prefix) {
  const parent = realpathSync.native(scratchParent), absolute = resolve(file);
  assertBelow(absolute, parent);
  const root = join(parent, relative(parent, absolute).split(sep)[0]);
  assert.ok(basename(root).startsWith(prefix), 'Upgrade path is not in the freshly owned smoke directory');
  let current = parent;
  for (const part of relative(parent, absolute).split(sep)) {
    current = join(current, part);
    if (!existsSync(current)) break;
    assert.ok(!lstatSync(current).isSymbolicLink(), 'Upgrade paths may not traverse links');
    assert.equal(realpathSync.native(current).toLowerCase(), current.toLowerCase(), 'Upgrade path must remain canonical');
  }
  return absolute;
}

/**
 * Called only for the already clean-installed shipping target by packaged-smoke.mjs.
 * There is no command-line entry point or local opt-in to native installer operations.
 * @param {{ candidateInstaller: string, installedExecutable: string, expectedVersion: string, outDir: string, repo: string, verifyInstalledPayload: (executable: string) => Promise<unknown> }} options
 */
export async function runWindowsUpgradeSmoke(options) {
  assertWindowsUpgradeHost({ platform: process.platform, arch: process.arch, env: process.env });
  assert.equal(typeof options.verifyInstalledPayload, 'function', 'An independent exact installer payload verifier is required');
  const scratchParent = realpathSync.native(tmpdir());
  // RUNNER_TEMP and the Windows account TEMP are different on some hosted images.
  assert.ok(lstatSync(realpathSync.native(process.env.RUNNER_TEMP)).isDirectory(), 'Hosted runner temporary directory missing');
  assert.equal(basename(process.env.USERPROFILE).toLowerCase(), 'runneradmin');
  const executable = assertOwnedUpgradePath(options.installedExecutable, scratchParent, 'jcad-smoke-');
  assert.equal(basename(executable), 'JCad Electrical.exe');
  const target = dirname(executable);
  const installer = realpathSync.native(options.candidateInstaller);
  assert.ok(lstatSync(installer).isFile() && !lstatSync(options.candidateInstaller).isSymbolicLink(), 'Candidate installer must be a regular file');
  const scratch = mkdtempSync(join(scratchParent, 'jcad-upgrade-smoke-'));
  const out = resolve(options.outDir); mkdirSync(out, { recursive: true });
  const profiles = new Map(), recoveryFixtures = new Map();
  const baselineInstaller = join(scratch, 'jcad-electrical-0.5.0-win-x64.exe');
  /** @type {NodeJS.ProcessEnv} */
  const env = isolatedWindowsPowerShellEnvironment({ ...process.env, SOURCE_SHA: process.env.GITHUB_SHA }); delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.VITE_DEV_SERVER_URL;
  let sequence = 0;
  const run = (binary, args, timeout = 90_000, extra = {}) => {
    const result = spawnSync(binary, args, { cwd: options.repo, env, windowsHide: true, shell: false, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout, ...extra });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    writeFileSync(join(out, `${String(sequence++).padStart(2, '0')}-${basename(binary).replace(/[^A-Za-z0-9.-]/g, '-')}.log`), output);
    assert.ok(!result.error && result.status === 0 && !result.signal, `Upgrade child failed: ${result.error?.message || result.signal || result.status}: ${output.slice(-1500)}`);
    return output;
  };
  const powershell = (body, timeout = 30_000) => {
    const file = join(scratch, `fixed-${sequence}.ps1`); writeFileSync(file, `$ErrorActionPreference = 'Stop'\n${body}\n`, { flag: 'wx' });
    return run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', file], timeout).trim();
  };
  const psString = value => `'${value.replace(/'/g, "''")}'`;
  const signature = file => JSON.parse(powershell(`$s = Get-AuthenticodeSignature -LiteralPath ${psString(file)}\nif (!$s.SignerCertificate) { throw 'Missing signer certificate' }\n@{status=[string]$s.Status;publisher=$s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false);thumbprint=$s.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress`));
  const installerFor = role => role === 'baseline' ? baselineInstaller : installer;
  const privateProfile = settingsCase => {
    const profile = profiles.get(settingsCase.name); assert.ok(profile, 'Unknown private upgrade profile');
    return assertOwnedUpgradePath(profile, scratchParent, 'jcad-shipping-smoke-');
  };
  const waitFor = (predicate, message) => {
    const deadline = Date.now() + 60_000;
    while (!predicate() && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    assert.ok(predicate(), message);
  };
  const registryInventory = () => selectWindowsUpgradeRegistration(JSON.parse(powershell(WINDOWS_UPGRADE_REGISTRY_QUERY)), { target, candidateVersion: options.expectedVersion });
  let registrationIdentity = null;
  const assertRegistry = (version = null) => {
    const entries = registryInventory();
    for (const entry of entries) {
      if (version !== null) assert.equal(entry.version, version, 'Installer registry version differs');
    }
    if (version !== null) registrationIdentity = assertStableWindowsUpgradeRegistration(entries, registrationIdentity);
    return entries;
  };
  const closed = () => {
    const ownedPaths = [scratch, ...profiles.values()].map(psString).join(',');
    const processes = JSON.parse(powershell(`$owned = @(${ownedPaths}); $p = @(Get-CimInstance Win32_Process -Filter "Name = 'JCad Electrical.exe' OR Name = 'electron.exe'" | Where-Object { if ($_.Name -eq 'JCad Electrical.exe') { $true } else { $line = [string]$_.CommandLine; @($owned | Where-Object { $line.IndexOf($_,[StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -gt 0 } }); ConvertTo-Json -InputObject @($p | Select-Object ProcessId,ExecutablePath) -Compress`));
    assert.deepEqual(processes, [], 'All JCad and owned storage-seeding processes must be closed before installer/profile operations');
  };
  const driver = {
    async preflight() {
      closed(); const registry = assertRegistry(options.expectedVersion);
      // Existing native inventory checks installed programs, COM, PATH, standard trees
      // and processes. A fresh JCad profile alone is not evidence of clean Windows.
      run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(options.repo, 'scripts', 'check-no-autocad.ps1'), '-EvidencePath', join(out, 'upgrade-no-autocad-inventory.json')], 30_000);
      return { hostedWindows: true, repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID, sourceSha: process.env.GITHUB_SHA, noAutoCadInventory: 'upgrade-no-autocad-inventory.json', registry, privateInstallTarget: target };
    },
    async acquireBaseline(pin) {
      const response = await fetch(pin.url, { signal: AbortSignal.timeout(120_000) });
      assert.ok(response.ok, `Baseline installer download failed: ${response.status}`);
      assert.ok(response.body, 'Baseline installer response has no body');
      const chunks = []; let bytes = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.length; assert.ok(bytes <= pin.bytes, 'Baseline download exceeds its pinned size'); chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const data = Buffer.concat(chunks); const digest = sha256(data);
      assert.equal(bytes, pin.bytes); assert.equal(digest, pin.sha256, 'Baseline installer checksum differs');
      writeFileSync(baselineInstaller, data, { flag: 'wx' }); return { bytes, sha256: digest };
    },
    async signature(role) { return verifyWindowsUpgradeInstaller(installerFor(role), role === 'baseline' ? WINDOWS_UPGRADE_BASELINE.version : options.expectedVersion); },
    async identity(role, version) {
      closed(); const registry = assertRegistry(version);
      waitFor(() => existsSync(executable), 'Installer did not create its exact private executable');
      assertOwnedUpgradePath(executable, scratchParent, 'jcad-smoke-');
      const signed = signature(executable); assertUpgradeSignature(signed);
      const fuses = await verifyExecutableFuses(executable, 'shipping');
      const info = JSON.parse(powershell(`$v = (Get-Item -LiteralPath ${psString(executable)}).VersionInfo; @{version=$v.ProductVersion;fileVersion=$v.FileVersion;product=$v.ProductName} | ConvertTo-Json -Compress`));
      assertWindowsApplicationVersion(info, version); assert.equal(info.product, 'JCad Electrical');
      const updater = loadYaml(readFileSync(join(target, 'resources', 'app-update.yml'), 'utf8'));
      assert.ok(updater && typeof updater === 'object' && 'publisherName' in updater, 'Updater publisher identity missing');
      const publishers = typeof updater.publisherName === 'string' ? [updater.publisherName] : updater.publisherName;
      assert.deepEqual(publishers, [WINDOWS_UPGRADE_BASELINE.publisher], 'Updater publisher identity must match the installed signer');
      const payload = role === 'candidate' ? await options.verifyInstalledPayload(executable) : null;
      assert.ok(role !== 'candidate' || payload, 'Exact installed candidate payload proof is required');
      const trust = verifyWindowsShippingPayloadTrust({ executable, expectedVersion: version });
      return { role, version, registry, product: info.product, versionInfo: info, signature: signed, updaterPublisher: publishers, fuses, payload, trust, executableSha256: sha256(readFileSync(executable)), installerSha256: sha256(readFileSync(installerFor(role))) };
    },
    async uninstall(_role) {
      closed(); assertRegistry();
      const uninstallers = readdirSync(target).filter(name => /^Uninstall.*\.exe$/i.test(name));
      assert.equal(uninstallers.length, 1, 'Exactly one owned uninstaller is required');
      const file = assertOwnedUpgradePath(join(target, uninstallers[0]), scratchParent, 'jcad-smoke-');
      assertUpgradeSignature(signature(file));
      run(file, ['/S', `_?=${target}`], 180_000, { windowsVerbatimArguments: true });
      waitFor(() => !existsSync(executable), 'Owned uninstaller did not remove its application');
      assert.deepEqual(assertRegistry(), [], 'Uninstall identity remains after the owned uninstall');
      if (existsSync(target)) rmSync(assertOwnedUpgradePath(target, scratchParent, 'jcad-smoke-'), { recursive: true, force: true, maxRetries: 3 });
    },
    async install(role) {
      closed(); assertRegistry(); assertUpgradeSignature(signature(installerFor(role)));
      assertOwnedUpgradePath(target, scratchParent, 'jcad-smoke-');
      run(installerFor(role), ['/S', `/D=${target}`], 180_000, { windowsVerbatimArguments: true });
      waitFor(() => existsSync(executable), 'Installer did not honour the private target');
    },
    async createProfile(settingsCase) {
      closed(); const profile = mkdtempSync(join(scratchParent, 'jcad-shipping-smoke-')); profiles.set(settingsCase.name, profile);
      writeFileSync(join(profile, 'shipping-startup.dxf'), fixtureText, { flag: 'wx' });
      const values = { 'jcad-origin-test': 'legacy preference Δ 雷', 'jcad-upgrade-sentinel': `upgrade sentinel Δ 雷 ${settingsCase.name}`, 'jcad.settings.v2': JSON.stringify({ ...preferences, experimental3d: settingsCase.experimental3d }) };
      const file = join(scratch, `seed-${settingsCase.name}.cjs`);
      writeFileSync(file, `const {app,BrowserWindow,protocol}=require('electron');\nprotocol.registerSchemesAsPrivileged([{scheme:'jcad',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);\napp.whenReady().then(async()=>{protocol.handle('jcad',()=>new Response('<!doctype html>',{headers:{'content-type':'text/html'}}));const w=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});await w.loadURL('jcad://app/index.html');await w.webContents.executeJavaScript(${JSON.stringify(`for(const [key,value] of Object.entries(${JSON.stringify(values)})) localStorage.setItem(key,value);`)});w.webContents.session.flushStorageData();w.destroy();app.quit();}).catch(error=>{console.error(error);app.exit(1)});\n`, { flag: 'wx' });
      run(createRequire(import.meta.url)('electron'), [file, `--user-data-dir=${profile}`], 30_000);
    },
    async probe(settingsCase, phase, _version) {
      closed(); const profile = privateProfile(settingsCase);
      const output = run(executable, [`--probe-startup=${phase}`, `--user-data-dir=${profile}`, join(profile, 'shipping-startup.dxf')], 90_000);
      const lines = output.split(/\r?\n/).filter(line => line.startsWith('SHIPPING_PROBE_OK '));
      assert.equal(lines.length, 1, 'One exact fixed shipping result is required');
      const checkpoint = JSON.parse(readFileSync(join(profile, 'renderer-preferences.json'), 'utf8'));
      // The file is a dictionary serialized by the application, not a helper-written assertion.
      assert.equal(checkpoint['jcad-upgrade-sentinel'], `upgrade sentinel Δ 雷 ${settingsCase.name}`);
      assert.equal(checkpoint['jcad-origin-test'], 'new preference');
      assert.equal(sha256(readFileSync(join(profile, 'shipping-startup.dxf.bak'))), sha256(fixtureText), 'Old first save must preserve the exact authored source backup');
      if (phase === 'first') {
        const proof = await seedWindowsUpgradeRecoveryFixture({ profile, repo: options.repo, baselineArchive: join(target, 'resources', 'app.asar') });
        recoveryFixtures.set(settingsCase.name, proof);
        writeFileSync(join(out, `${settingsCase.name}-recovery-format-proof.json`), `${JSON.stringify(proof, null, 2)}\n`);
      }
      const recovery = recoveryFixtures.get(settingsCase.name); assert.ok(recovery, 'Baseline-format recovery fixture proof missing');
      assertWindowsUpgradeRecoveryFixture(profile, recovery);
      return { ...JSON.parse(lines[0].slice('SHIPPING_PROBE_OK '.length)), recovery: { ...recovery, indexAndDocumentBytesPreserved: true, actualRecoveryUiExercised: false } };
    },
    async snapshot(settingsCase, label) {
      closed(); const profile = privateProfile(settingsCase), manifest = inventoryUpgradeTree(profile);
      const saved = join(scratch, `${settingsCase.name}-${label}`); mkdirSync(saved, { recursive: false });
      for (const entry of manifest.files) {
        const into = join(saved, ...entry.path.split('/'));
        if (entry.directory) mkdirSync(into, { recursive: true });
        else { mkdirSync(dirname(into), { recursive: true }); copyFileSync(join(profile, ...entry.path.split('/')), into); }
      }
      assert.deepEqual(inventoryUpgradeTree(saved), manifest, 'Private profile snapshot must match every path and byte');
      writeFileSync(join(out, `${settingsCase.name}-${label}-manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);
      return { label, ...manifest };
    },
    async assertUnchanged(settingsCase, snapshot) {
      closed(); assert.deepEqual(inventoryUpgradeTree(privateProfile(settingsCase)), { files: snapshot.files, bytes: snapshot.bytes, sha256: snapshot.sha256 }, 'Closed profile tree changed during installer operation/restoration');
    },
    async restore(settingsCase, snapshot) {
      closed(); const profile = privateProfile(settingsCase), saved = join(scratch, `${settingsCase.name}-${snapshot.label}`);
      assertOwnedUpgradePath(saved, scratchParent, 'jcad-upgrade-smoke-');
      assert.deepEqual(inventoryUpgradeTree(saved), { files: snapshot.files, bytes: snapshot.bytes, sha256: snapshot.sha256 }, 'Rollback snapshot changed');
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); mkdirSync(profile);
      for (const entry of snapshot.files) {
        const into = join(profile, ...entry.path.split('/'));
        if (entry.directory) mkdirSync(into, { recursive: true });
        else { mkdirSync(dirname(into), { recursive: true }); copyFileSync(join(saved, ...entry.path.split('/')), into); }
      }
    },
  };
  // A failure must retain which gates actually ran. Child logs and per-snapshot manifests
  // remain available even when no final passing receipt can be produced.
  const events = [];
  // Preserve the complete structural adapter shape while decorating each actual method.
  const audited = { ...driver };
  for (const [operation, action] of Object.entries(driver)) {
    audited[operation] = async (...args) => {
      const event = { operation, arguments: args.map(value => typeof value === 'string' ? value : value?.name || value?.label || null), started: new Date().toISOString(), completed: null, ok: false, error: null };
      events.push(event);
      const save = () => writeFileSync(join(out, 'windows-upgrade-events.json'), `${JSON.stringify(events, null, 2)}\n`);
      save();
      try { const result = await action(...args); event.ok = true; return result; }
      catch (error) { event.error = error.message; throw error; }
      finally { event.completed = new Date().toISOString(); save(); }
    };
  }
  let result, failure;
  try {
    result = await executeWindowsUpgradeSequence(options, audited);
    writeFileSync(join(out, 'windows-upgrade-result.json'), `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  } catch (error) {
    writeFileSync(join(out, 'windows-upgrade-result.json'), `${JSON.stringify({ ok: false, expectedVersion: options.expectedVersion, error: error.message, gatesAfterFailure: 'unrun' }, null, 2)}\n`);
    failure = error;
  }
  try { closed(); }
  catch (error) {
    const cleanup = { removed: false, reason: error.message, retainedScratch: scratch, retainedProfiles: [...profiles.values()] };
    writeFileSync(join(out, 'windows-upgrade-cleanup.json'), `${JSON.stringify(cleanup, null, 2)}\n`);
    const resultFile = join(out, 'windows-upgrade-result.json');
    const prior = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : {};
    writeFileSync(resultFile, `${JSON.stringify({ ...prior, ok: false, cleanup }, null, 2)}\n`);
    throw new Error('Upgrade cleanup could not prove all owned application processes closed; private trees retained', { cause: error });
  }
  for (const profile of profiles.values()) if (existsSync(profile)) rmSync(assertOwnedUpgradePath(profile, scratchParent, 'jcad-shipping-smoke-'), { recursive: true, force: true, maxRetries: 3 });
  if (existsSync(scratch)) rmSync(assertOwnedUpgradePath(scratch, scratchParent, 'jcad-upgrade-smoke-'), { recursive: true, force: true, maxRetries: 3 });
  if (failure) throw failure;
  return result;
}
