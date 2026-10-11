// Run fixed diagnostics in the exact installer executable with no debugger transport.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { verifyExecutableFuses } from './electron-fuse-policy.mjs';

const repo = resolve(import.meta.dirname, '..');
const source = process.argv[2] === '--source';
const executable = source ? createRequire(import.meta.url)('electron') : resolve(process.argv[2] || '');
const appArgs = source ? ['.'] : [];
assert.ok(process.argv[2] && existsSync(executable), 'Provide the exact installed shipping executable, or --source for probe development only');
const expectedVersion = process.env.JCAD_E2E_EXPECT_VERSION || JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
const out = resolve(process.env.JCAD_E2E_OUT || join(repo, 'packaged-smoke-output')); mkdirSync(out, { recursive:true });
const scratchParent = realpathSync.native(tmpdir());
const profile = mkdtempSync(join(scratchParent, 'jcad-shipping-smoke-'));
function cleanProfile() {
  const checked = realpathSync.native(profile);
  if (dirname(checked) !== scratchParent || !basename(checked).startsWith('jcad-shipping-smoke-')) throw new Error('Unexpected shipping smoke profile');
  rmSync(checked, { recursive:true, force:true, maxRetries:3 });
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
  const errors = join(profile, 'error.log');
  assert.ok(!existsSync(errors) || readFileSync(errors, 'utf8').trim() === '', 'No main-process errors');
  // The CLI debugger is not an alternative way to run the production app.
  if (!source) {
    const denied = spawnSync(executable, ['--remote-debugging-port=0', `--user-data-dir=${profile}`, ...linuxArgs], { cwd:repo, env, encoding:'utf8', windowsHide:true, timeout:15_000, maxBuffer:1024 * 1024 });
    assert.equal(denied.error, undefined); assert.equal(denied.status, 2); assert.match(denied.stdout || '', /SHIPPING_DEBUG_DISABLED/);
  }
  const record = { mode:source ? 'source-probe-development' : 'shipping-no-inspection', expectedVersion, executable, fuses, launches, remoteDebugRejected:!source, noMainErrors:true };
  writeFileSync(join(out, 'shipping-runtime-result.json'), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`${source ? 'Source probe validation (no shipping fuse/signature evidence)' : 'Exact shipping runtime smoke'}: startup, DXF open/save/backup/reopen, secure origin, two-launch migration, private persistent storage and clean exit passed.`);
} finally {
  cleanProfile();
}
