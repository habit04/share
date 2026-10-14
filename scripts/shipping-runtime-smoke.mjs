// Run fixed diagnostics in the exact installer executable with no debugger transport.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, lstatSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { verifyExecutableFuses } from './electron-fuse-policy.mjs';
import { needsPortableDwgExport, needsPortableDwgSave, needsRotatedLayoutViewports, needsDwgMetadataPreservation, needsExperimental3d, experimental3dProbeSucceeded, metadataProbeSucceeded, METADATA_SMOKE_FIXTURES, METADATA_SMOKE_FLAGS } from './packaged-smoke-policy.mjs';

const repo = resolve(import.meta.dirname, '..');
const source = process.argv[2] === '--source';
const executable = source ? createRequire(import.meta.url)('electron') : resolve(process.argv[2] || '');
const appArgs = source ? ['.'] : [];
assert.ok(process.argv[2] && existsSync(executable), 'Provide the exact installed shipping executable, or --source for probe development only');
const expectedVersion = process.env.JCAD_E2E_EXPECT_VERSION || JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
const out = resolve(process.env.JCAD_E2E_OUT || join(repo, 'packaged-smoke-output')); mkdirSync(out, { recursive:true });
const scratchParent = realpathSync.native(tmpdir());
const profile = mkdtempSync(join(scratchParent, 'jcad-shipping-smoke-'));
let threeDProfile = '';
function cleanProfile() {
  for (const owned of [profile, threeDProfile].filter(Boolean)) {
    const checked = realpathSync.native(owned);
    if (dirname(checked) !== scratchParent || !basename(checked).startsWith('jcad-shipping-smoke-')) throw new Error('Unexpected shipping smoke profile');
    rmSync(checked, { recursive:true, force:true, maxRetries:3 });
  }
}
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
const linuxArgs = process.platform === 'linux' ? ['--no-sandbox'] : [];
const archive = join(dirname(executable), process.platform === 'darwin' ? '../Resources/app.asar' : 'resources/app.asar');
const index = source ? join(repo, 'dist', 'index.html') : join(archive, 'dist', 'index.html');
const fixture = join(profile, 'shipping-startup.dxf');
function run(binary, args, timeout = 90_000) {
  const result = spawnSync(binary, args, { cwd:repo, env, encoding:'utf8', windowsHide:true, timeout, maxBuffer:2 * 1024 * 1024 });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  process.stdout.write(output);
  if (result.error || result.status !== 0) throw new Error(`Shipping smoke process failed: ${result.error?.message || result.signal || result.status}\n${output.slice(-2000)}`);
  return output;
}
try {
  writeFileSync(fixture, '0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n10\n20\n10\n11\n20\n21\n20\n0\nENDSEC\n0\nEOF\n');
  if (needsDwgMetadataPreservation(expectedVersion)) for (const pin of METADATA_SMOKE_FIXTURES) {
    const file = join(repo, 'tests/fixtures/interchange', pin.name + '.dwg'), stat = lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 8 * 1024 * 1024, 'Metadata smoke source must be a bounded regular fixture');
    const bytes = readFileSync(file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256, pin.name + ': independent source preimage');
    writeFileSync(join(profile, pin.file), bytes, { flag: 'wx' });
  }
  const fuses = source ? null : await verifyExecutableFuses(executable, 'shipping');
  const seed = join(profile, 'legacy-seed.cjs');
  writeFileSync(seed, `const {app,BrowserWindow,protocol}=require('electron');
app.whenReady().then(async()=>{
protocol.handle('file',()=>new Response('<!doctype html>',{headers:{'content-type':'text/html'}}));
const w=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
await w.loadFile(${JSON.stringify(index)});
await w.webContents.executeJavaScript("localStorage.setItem('jcad-origin-test','legacy preference Δ 雷');");
w.webContents.session.flushStorageData(); w.destroy(); app.quit();
}).catch(error=>{console.error(error);app.exit(1)});`);
  run(createRequire(import.meta.url)('electron'), [seed, `--user-data-dir=${profile}`, ...linuxArgs], 30_000);
  const launches = [];
  for (const phase of ['first', 'second']) {
    const output = run(executable, [...appArgs, `--probe-startup=${phase}`, `--user-data-dir=${profile}`, ...linuxArgs, realpathSync.native(fixture)]);
    const line = output.split(/\r?\n/).find((entry) => entry.startsWith('SHIPPING_PROBE_OK '));
    assert.ok(line, `Missing successful shipping startup result (${phase})`);
    const result = JSON.parse(line.slice('SHIPPING_PROBE_OK '.length));
    assert.equal(result.phase, phase); assert.equal(result.version, expectedVersion); assert.equal(result.packaged, !source); assert.equal(result.testBuild, false);
    assert.equal(result.before, phase === 'first' ? 1 : 2); assert.equal(result.entities, 2);
    for (const key of ['secure', 'bridge', 'persistent', 'privateSessionData', 'privateStorage', 'migrationMarker']) assert.equal(result[key], true, key);
    assert.equal(result.dirty, false); assert.equal(result.url, 'jcad://app/index.html');
    launches.push(result);
  }
  assert.ok(existsSync(`${fixture}.bak`), 'A real drawing save must preserve its backup');
  let portableDwg = null;
  if (needsPortableDwgExport(expectedVersion)) {
    const output = run(executable, [...appArgs, '--probe-startup=dwg', `--user-data-dir=${profile}`, realpathSync.native(fixture)], needsDwgMetadataPreservation(expectedVersion) ? 240_000 : 90_000);
    const line = output.split(/\r?\n/).find(entry => entry.startsWith('SHIPPING_PROBE_OK '));
    assert.ok(line, 'Missing successful portable DWG shipping result');
    portableDwg = JSON.parse(line.slice('SHIPPING_PROBE_OK '.length));
    assert.equal(portableDwg.phase, 'dwg'); assert.equal(portableDwg.version, expectedVersion); assert.equal(portableDwg.packaged, !source); assert.equal(portableDwg.testBuild, false);
    for (const key of ['writer', 'reopened', 'arrays', 'attributes', 'widths', 'appearance', 'workingPreserved', 'rejectedContent', 'backup', 'integrityRefused']) assert.equal(portableDwg[key], true, key);
    if (needsPortableDwgSave(expectedVersion)) {
      for (const key of ['saveAsDwg', 'saveDwg', 'normalSaveBackup']) assert.equal(portableDwg[key], true, key);
      if (needsDwgMetadataPreservation(expectedVersion)) {
        assert.equal(portableDwg.normalSaveLossEligibilityVerified, true, 'normalSaveLossEligibilityVerified');
        assert.equal(typeof portableDwg.normalSaveLossConsentRequired, 'boolean', 'Actual source-loss eligibility is explicit');
        assert.equal(typeof portableDwg.normalSaveLossConsent, 'boolean', 'Actual consent is explicit');
        assert.equal(portableDwg.normalSaveLossConsent, portableDwg.normalSaveLossConsentRequired, 'Consent matches actual source-loss eligibility');
        assert.equal(portableDwg.openedSourceRefused, true, 'openedSourceRefused');
      } else assert.equal(portableDwg.normalSaveLossConsent, true, 'normalSaveLossConsent'); // Pre-metadata builds required their proven reader-loss warning.
    }
    if (needsRotatedLayoutViewports(expectedVersion)) assert.equal(portableDwg.viewportRotation, true, 'viewportRotation');
    if (needsDwgMetadataPreservation(expectedVersion)) {
      for (const key of METADATA_SMOKE_FLAGS) assert.equal(portableDwg[key], true, key);
      assert.equal(metadataProbeSucceeded(portableDwg), true, 'All three fixed metadata fixtures require complete source/copy/save/reopen evidence');
    }
    assert.equal(portableDwg.entities, 4);
  }
  const errors = join(profile, 'error.log');
  assert.ok(!existsSync(errors) || readFileSync(errors, 'utf8').trim() === '', 'No main-process errors');
  let experimental3d = null;
  if (needsExperimental3d(expectedVersion)) {
    // A second fresh profile proves default-off Options, persistence and a real process restart;
    // the original first/second/DWG profile and its native metadata fixed points stay independent.
    threeDProfile = mkdtempSync(join(scratchParent, 'jcad-shipping-smoke-'));
    const threeDFixture = join(threeDProfile, 'shipping-startup.dxf');
    writeFileSync(threeDFixture, '0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n10\n20\n10\n11\n20\n21\n20\n0\nENDSEC\n0\nEOF\n', { flag:'wx' });
    let enabled = null;
    for (const phase of ['3d-enable', '3d']) {
      const output = run(executable, [...appArgs, `--probe-startup=${phase}`, `--user-data-dir=${threeDProfile}`, ...linuxArgs, realpathSync.native(threeDFixture)], phase === '3d' ? 120_000 : 90_000);
      const line = output.split(/\r?\n/).find(entry => entry.startsWith('SHIPPING_PROBE_OK '));
      assert.ok(line, `Missing successful shipping 3D result (${phase})`);
      const result = JSON.parse(line.slice('SHIPPING_PROBE_OK '.length));
      assert.equal(result.phase, phase); assert.equal(result.version, expectedVersion); assert.equal(result.packaged, !source); assert.equal(result.testBuild, false);
      if (phase === '3d-enable') {
        assert.equal(result.optionPersisted, true); assert.equal(result.restartRequired, true); assert.equal(result.beforeRenderer, 'Canvas 2D');
        enabled = result;
      } else {
        assert.equal(experimental3dProbeSucceeded(result), true, 'Actual 3D viewport/worker, exact DXF reopens/backup, DWG refusal and Canvas diagnostics are mandatory');
        experimental3d = { enabled, ...result };
      }
    }
    const threeDErrors = join(threeDProfile, 'error.log');
    assert.ok(!existsSync(threeDErrors) || readFileSync(threeDErrors, 'utf8').trim() === '', 'No 3D main-process errors');
  }
  // The CLI debugger is not an alternative way to run the production app.
  if (!source) {
    const denied = spawnSync(executable, ['--remote-debugging-port=0', `--user-data-dir=${profile}`, ...linuxArgs], { cwd:repo, env, encoding:'utf8', windowsHide:true, timeout:15_000, maxBuffer:1024 * 1024 });
    assert.equal(denied.error, undefined); assert.equal(denied.status, 2); assert.match(denied.stdout || '', /SHIPPING_DEBUG_DISABLED/);
  }
  const record = { mode:source ? 'source-probe-development' : 'shipping-no-inspection', expectedVersion, executable, fuses, launches, portableDwg, experimental3d, remoteDebugRejected:!source, noMainErrors:true };
  writeFileSync(join(out, 'shipping-runtime-result.json'), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`${source ? 'Source probe validation (no shipping fuse/signature evidence)' : 'Exact shipping runtime smoke'}: startup, DXF open/save/backup/reopen${portableDwg?.saveDwg ? ', DWG Save As/save/backup/reopen' : ''}${portableDwg?.viewportRotation ? ', rotated layout viewports' : ''}${portableDwg?.metadataSaveReopen ? ', three native metadata fixtures with connected copies and exact literals' : ''}${experimental3d ? ', opted-in WebGL2 3D/Manifold worker, exact DXF first/second saves and guarded DWG refusal' : ''}, secure origin, two-launch migration, private persistent storage and clean exit passed.`);
} finally {
  // Preserve only fixed, generated smoke artifacts for native-reader diagnosis. The private
  // profile is still removed, and ordinary user files can never be selected by this probe.
  for (const [name, saved] of [['shipping-startup.dxf', 'shipping-dwg-fixture.dxf'], ['shipping-rotated-layout.dxf', 'shipping-rotated-layout.dxf'], ['shipping-export.dwg', 'shipping-dwg-output.dwg'], ['shipping-export.dwg.bak', 'shipping-dwg-backup.bak'], ['shipping-normal-save.dwg', 'shipping-dwg-normal-save.dwg'], ['shipping-normal-save.dwg.bak', 'shipping-dwg-normal-save.bak']]) {
    const file = join(profile, name);
    if (existsSync(file)) {
      const stat = lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && dirname(realpathSync.native(file)) === realpathSync.native(profile)) copyFileSync(file, join(out, saved));
    }
  }
  for (const pin of METADATA_SMOKE_FIXTURES) for (const suffix of ['.dwg', '.dwg.bak']) {
    const name = pin.file.replace(/\.dwg$/, '-copy') + suffix, file = join(profile, name);
    if (existsSync(file)) {
      const stat = lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && dirname(realpathSync.native(file)) === realpathSync.native(profile)) copyFileSync(file, join(out, name));
    }
  }
  if (threeDProfile) for (const name of ['shipping-3d-output.dxf', 'shipping-3d-output.dxf.bak']) {
    const file = join(threeDProfile, name);
    if (existsSync(file)) {
      const stat = lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && dirname(realpathSync.native(file)) === realpathSync.native(threeDProfile)) copyFileSync(file, join(out, name));
    }
  }
  cleanProfile();
}
