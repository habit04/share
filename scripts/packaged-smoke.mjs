// Smoke test of the installers electron-builder produced: install or extract each one for this
// operating system, then run the end-to-end checks of scripts/e2e-electron.mjs against the packaged
// application (start-up, open the committed DXF and DWG fixtures, SAVEAS, AUTOSAVE / recovery copy,
// vector PDF through save-pdf, large-DWG progress and Cancel, IPC guard, clean close, no error log)
// plus the headless `--probe-dwg` reader of the packaged build, and the Electron fuses the build
// ships with (scripts/electron-fuses.mjs: RunAsNode, NODE_OPTIONS and --inspect off, the app
// from app.asar only). Playwright attaches with --inspect, so after the fuse check the test's own
// copy gets EnableNodeCliInspectArguments switched back on before it is driven.
//
//   node scripts/packaged-smoke.mjs <folder with installers>   (default: release/)
//
// Windows  *.exe (NSIS): installed silently with `/S /D=<temp folder>`; a `win-unpacked` folder next
//          to it is tested too when present.
// macOS    *.dmg: mounted with `hdiutil attach`, the .app copied out with `ditto`; the disk image
//          that matches this Mac's architecture is tested, and the other one too when it can run
//          (x64 under Rosetta on Apple silicon).
// Linux    *.AppImage: `--appimage-extract`; *.deb: unpacked with `dpkg-deb -x` (no root needed).
//          Run under a display (xvfb-run -a on CI).
//
// JCAD_SMOKE_OUT (default packaged-smoke-output/) receives one folder of e2e output per installer.
// Exits non-zero when no installer was found or any check failed.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { allowInspectForTests, shippedFuseProblems, shipsFuses } from './electron-fuses.mjs';

const repo = resolve(import.meta.dirname, '..');
const dir = resolve(process.argv[2] || join(repo, 'release'));
const outRoot = resolve(process.env.JCAD_SMOKE_OUT || join(repo, 'packaged-smoke-output'));
mkdirSync(outRoot, { recursive: true });
const product = 'JCad Electrical';
const executableName = 'jcad-electrical'; // package.json "name": the Linux binary
/** The version of the installers (an older release through the manual workflow, else this one). */
const expectedVersion = process.env.JCAD_E2E_EXPECT_VERSION || JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;

/** Every file below `root` (depth-limited), for the installer search. */
function walk(root, depth = 3) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (depth > 0) out.push(...walk(p, depth - 1));
    } else out.push(p);
  }
  return out;
}

/** Run a command; throw with its output when it fails. */
function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}${r.error ? ` (${r.error.message})` : ''}\n${(r.stdout || '').slice(-2000)}\n${(r.stderr || '').slice(-2000)}`);
  return r.stdout || '';
}

/** Wait until a file exists (NSIS returns before the files are all in place on slow disks). */
function waitFor(file, ms = 60_000) {
  const until = Date.now() + ms;
  while (!existsSync(file) && Date.now() < until) spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 500)']);
  return existsSync(file);
}

/** @type {Array<{ label: string, executable: string }>} */
const targets = [];
const files = walk(dir);
const tmp = mkdtempSync(join(tmpdir(), 'jcad-smoke-'));

if (process.platform === 'win32') {
  for (const exe of files.filter((f) => /\.exe$/i.test(f) && !/[\\/]win-unpacked[\\/]/i.test(f) && !/uninstall/i.test(basename(f)))) {
    const target = join(tmp, basename(exe, '.exe').replace(/[^A-Za-z0-9._-]/g, '-'));
    // NSIS: /S silent, /D=<folder> must come last and unquoted.
    run(exe, ['/S', `/D=${target}`], { windowsVerbatimArguments: true, shell: false });
    // electron-builder's installer honours /D; its per-user default folder (<LocalAppData>\Programs\<package
    // name> for a one-click installer) is only a fallback in case a future template stops doing so.
    const programs = join(process.env.LOCALAPPDATA || '', 'Programs');
    const candidates = [join(target, `${product}.exe`), join(programs, executableName, `${product}.exe`), join(programs, product, `${product}.exe`)];
    const app = candidates.find((c) => waitFor(c, c === candidates[0] ? 60_000 : 5_000));
    if (!app) throw new Error(`the installer ${basename(exe)} did not install ${candidates.join(' or ')}`);
    targets.push({ label: `${basename(exe)} (installed)`, executable: app });
  }
  const unpacked = join(dir, 'win-unpacked', `${product}.exe`);
  if (existsSync(unpacked)) targets.push({ label: 'win-unpacked', executable: unpacked });
} else if (process.platform === 'darwin') {
  const dmgs = files.filter((f) => /\.dmg$/i.test(f));
  const native = process.arch === 'arm64' ? 'arm64' : 'x64';
  // Native first; the other architecture only when this Mac can run it (Rosetta on Apple silicon).
  const rosetta = native === 'arm64' && spawnSync('/usr/bin/arch', ['-x86_64', '/usr/bin/true']).status === 0;
  for (const dmg of dmgs.sort((a, b) => Number(b.includes(native)) - Number(a.includes(native)))) {
    const isNative = basename(dmg).includes(native) || !/(arm64|x64)/.test(basename(dmg));
    if (!isNative && !rosetta) {
      console.log(`skipping ${basename(dmg)}: this Mac cannot run that architecture`);
      continue;
    }
    const mount = join(tmp, `mnt-${basename(dmg, '.dmg')}`);
    mkdirSync(mount, { recursive: true });
    run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg]);
    const copy = join(tmp, `app-${basename(dmg, '.dmg')}`);
    try {
      mkdirSync(copy, { recursive: true });
      run('ditto', [join(mount, `${product}.app`), join(copy, `${product}.app`)]);
    } finally {
      run('hdiutil', ['detach', mount, '-force']);
    }
    // The signature must still hold after the copy (ad-hoc or Developer ID).
    run('codesign', ['--verify', '--deep', '--strict', join(copy, `${product}.app`)]);
    targets.push({ label: basename(dmg), executable: join(copy, `${product}.app`, 'Contents', 'MacOS', product) });
  }
} else {
  for (const image of files.filter((f) => /\.AppImage$/i.test(f))) {
    const into = join(tmp, `appimage-${basename(image, '.AppImage')}`);
    mkdirSync(into, { recursive: true });
    chmodSync(image, 0o755);
    run(image, ['--appimage-extract'], { cwd: into });
    targets.push({ label: basename(image), executable: join(into, 'squashfs-root', executableName) });
  }
  for (const deb of files.filter((f) => /\.deb$/i.test(f))) {
    const into = join(tmp, `deb-${basename(deb, '.deb')}`);
    run('dpkg-deb', ['-x', deb, into]);
    targets.push({ label: basename(deb), executable: join(into, 'opt', product, executableName) });
  }
}

if (targets.length === 0) {
  console.error(`packaged-smoke: no installer for ${process.platform} in ${dir}`);
  process.exit(1);
}

const summary = [];
let failed = 0;
for (const t of targets) {
  console.log(`\n=== ${t.label}: ${t.executable}`);
  if (!existsSync(t.executable)) {
    summary.push(`FAIL ${t.label}: executable missing (${t.executable})`);
    failed += 1;
    continue;
  }
  // 1. The headless DWG probe: LibreDWG (worker thread, unpacked from the asar) in the packaged layout.
  const probeArgs = ['--probe-dwg', join(repo, 'fixtures', 'example_2000.dwg')];
  if (process.platform === 'linux') probeArgs.push('--no-sandbox');
  const probe = spawnSync(t.executable, probeArgs, { encoding: 'utf8', timeout: 120_000 });
  const probeLine = `${probe.stdout || ''}`.split(/\r?\n/).find((l) => l.startsWith('PROBE_')) ?? `(no output; exit ${probe.status}${probe.error ? `, ${probe.error.message}` : ''})`;
  const probeOk = probe.status === 0 && /^PROBE_OK \S+ entities=\d+/.test(probeLine);
  console.log(`${probeOk ? 'ok  ' : 'FAIL'} --probe-dwg: ${probeLine}`);
  // 2. The fuses as shipped (security review E-15); then --inspect on in this copy only, for Playwright.
  let fusesOk = true;
  let fuseLine = `skipped: ${expectedVersion} predates the fuses`;
  if (shipsFuses(expectedVersion)) {
    const problems = await shippedFuseProblems(t.executable).catch((err) => [`cannot read the fuses: ${err && err.message}`]);
    fusesOk = problems.length === 0;
    fuseLine = fusesOk ? 'as shipped (RunAsNode, NODE_OPTIONS and --inspect off, app.asar only)' : problems.join('; ');
    if (fusesOk) {
      try {
        await allowInspectForTests(t.executable);
      } catch (err) {
        fusesOk = false;
        fuseLine = `could not enable --inspect for the tests: ${err && err.message}`;
      }
    }
  }
  console.log(`${fusesOk ? 'ok  ' : 'FAIL'} fuses: ${fuseLine}`);
  // 3. The end-to-end checks against the packaged application.
  const out = join(outRoot, t.label.replace(/[^A-Za-z0-9._-]+/g, '-'));
  const e2e = spawnSync(process.execPath, ['--experimental-strip-types', join(repo, 'scripts', 'e2e-electron.mjs'), '--packaged', t.executable], {
    stdio: 'inherit',
    env: { ...process.env, JCAD_E2E_OUT: out },
    timeout: 15 * 60 * 1000,
  });
  const ok = probeOk && fusesOk && e2e.status === 0;
  if (!ok) failed += 1;
  summary.push(`${ok ? 'ok  ' : 'FAIL'} ${t.label}: probe ${probeOk ? 'ok' : 'failed'}, fuses ${fusesOk ? 'ok' : 'failed'}, e2e exit ${e2e.status}`);
}
console.log(`\npackaged-smoke (${process.platform} ${process.arch}):\n${summary.join('\n')}`);
// The extracted / installed copies are large; keep them only when asked (JCAD_SMOKE_KEEP=1).
if (!process.env.JCAD_SMOKE_KEEP) {
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    console.log(`(could not remove ${tmp})`);
  }
}
process.exit(failed ? 1 : 0);
