/** Run actual Electron DWG process/OS-memory containment checks without packaging test hooks. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const electron = /** @type {string} */ (/** @type {unknown} */ (require('electron')));
assert.equal(typeof electron, 'string', 'Run this launcher with Node, not Electron.');
const temporary = mkdtempSync(join(tmpdir(), 'jcad-dwg-containment-'));
const nonce = randomUUID();
const fixture = readFileSync(join(root, 'fixtures', 'example_2000.dwg'));
assert.ok(fixture.length > 0 && fixture.length <= 128 * 1024 * 1024, 'Containment fixture is missing or oversized.');
writeFileSync(join(temporary, 'fixture.dwg'), fixture);
writeFileSync(join(temporary, 'config.json'), JSON.stringify({ nonce, fixtureBytes: fixture.length }));
const profile = join(temporary, 'profile');
mkdirSync(profile);
const env = { ...process.env };
for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'JCAD_DWG_TEST_DELAY_MS']) delete env[name];
const args = [join(root, 'scripts', 'dwg-containment-probe.cjs'), `--containment-dir=${temporary}`, `--containment-nonce=${nonce}`, `--user-data-dir=${profile}`];
// GitHub's Linux test runner has no configured SUID chrome-sandbox helper. This switch belongs
// only to the unpackaged test main; installer/application security configuration is unchanged.
if (process.platform === 'linux') args.push('--no-sandbox');
const child = spawn(electron, args,
  { env, cwd: root, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
let diagnostic = '';
let diagnosticBytes = 0;
const diagnosticLimit = 128 * 1024;
let forced = false;

function terminateOwnedTree() {
  if (forced || !child.pid) return;
  forced = true;
  if (process.platform === 'win32') {
    // Numeric PID came from the process this launcher created; no shell or broad image-name kill.
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    execFile(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }, () => {});
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

const capture = (bytes) => {
  diagnosticBytes += bytes.length;
  if (diagnosticBytes > diagnosticLimit) { terminateOwnedTree(); return; }
  diagnostic += bytes.toString('utf8');
};
child.stdout?.on('data', capture);
child.stderr?.on('data', capture);
const deadline = setTimeout(terminateOwnedTree, 120_000);
const interrupted = () => terminateOwnedTree();
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);

try {
  const code = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', resolveExit);
  });
  assert.equal(forced, false, `Containment probe exceeded its runtime/output budget. ${diagnostic.slice(-4_096)}`);
  let probeError = '';
  if (code !== 0 && existsSync(join(temporary, 'result.json'))) {
    const failedReport = readFileSync(join(temporary, 'result.json'));
    if (failedReport.length <= 64 * 1024) probeError = JSON.parse(failedReport.toString('utf8')).error ?? '';
  }
  assert.equal(code, 0, `Containment probe failed (exit ${code}). ${probeError} ${diagnostic.slice(-4_096)}`);
  const reportBytes = readFileSync(join(temporary, 'result.json'));
  assert.ok(reportBytes.length <= 64 * 1024, 'Containment result is unexpectedly large.');
  const report = JSON.parse(reportBytes.toString('utf8'));
  assert.equal(report.nonce, nonce, 'Containment report did not belong to this run.');
  assert.equal(realpathSync(report.userDataPath), realpathSync(profile), 'Containment probe did not use its isolated temporary profile.');
  assert.equal(report.ok, true, report.error ?? 'Containment checks did not pass.');
  assert.equal(report.cases.length, 5, 'A required containment case did not run.');
  assert.ok(report.cases.every((item) => item.ok === true), 'Containment report has a failed case.');
  const output = join(root, 'e2e-output');
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'dwg-containment.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearTimeout(deadline);
  process.off('SIGINT', interrupted);
  process.off('SIGTERM', interrupted);
  // Verify the absolute target before recursively deleting the fresh, named temporary directory.
  const canonicalTemporary = realpathSync(temporary);
  const canonicalBase = realpathSync(tmpdir());
  assert.ok(resolve(canonicalTemporary).startsWith(`${resolve(canonicalBase)}${sep}`) && basename(canonicalTemporary).startsWith('jcad-dwg-containment-'),
    'Refusing cleanup outside the generated containment temporary directory.');
  rmSync(canonicalTemporary, { recursive: true, force: true });
}
