// This ASAR build deliberately enables inspection for Playwright. It is never a
// shipping installer, and its output/name/metadata are isolated from release assets.
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyExecutableFuses } from './electron-fuse-policy.mjs';
const repo = resolve(import.meta.dirname, '..');
const root = join(repo, 'release-test');
let executable;
if (process.platform === 'win32') executable = join(root, 'win-unpacked', 'JCad Electrical.exe');
else if (process.platform === 'linux') executable = join(root, 'linux-unpacked', 'jcad-electrical');
else {
  const folder = readdirSync(root).find((name) => name === (process.arch === 'arm64' ? 'mac-arm64' : 'mac'));
  if (!folder) throw new Error('Native test-build app directory missing');
  executable = join(root, folder, 'JCad Electrical.app', 'Contents', 'MacOS', 'JCad Electrical');
}
if (!existsSync(executable)) throw new Error(`Test-build executable missing: ${executable}`);
console.log(`Dedicated test-build fuse configuration: ${JSON.stringify(await verifyExecutableFuses(executable, 'test'))}`);
/** @type {Array<[string, string[]]>} */
const suites = [['e2e-electron.mjs', ['--experimental-strip-types']], ['e2e-origin.mjs', []]];
for (const [script, args] of suites) {
  const result = spawnSync(process.execPath, [...args, join(repo, 'scripts', script), '--packaged', executable], { stdio:'inherit', windowsHide:true, timeout:15 * 60 * 1000 });
  if (result.error || result.status !== 0) throw new Error(`Dedicated test build ${script} failed: ${result.error?.message || result.signal || result.status}`);
}
