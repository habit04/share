// Smoke test of the installers electron-builder produced: install or extract each one for this
// operating system. Shipping builds must pass their actual binary fuse policy, headless DWG
// reader, and fixed startup/DXF save/backup/reopen/private-storage/migration/clean-exit probes
// without any inspection transport. The broader Playwright suite runs on source Electron and
// a dedicated unpublished test ASAR, whose inspection fuse is deliberately enabled.
// Older published inspection-enabled installers retain their explicitly labelled legacy E2E path.
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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { needsPackagedOrigin, processResult } from './packaged-smoke-policy.mjs';
import { verifyExecutableFuses } from './electron-fuse-policy.mjs';

const repo = resolve(import.meta.dirname, '..');
const dir = resolve(process.argv[2] || join(repo, 'release'));
const outRoot = resolve(process.env.JCAD_SMOKE_OUT || join(repo, 'packaged-smoke-output'));
mkdirSync(outRoot, { recursive: true });
const product = 'JCad Electrical';
const executableName = 'jcad-electrical'; // package.json "name": the Linux binary
const expectedVersion = process.env.JCAD_E2E_EXPECT_VERSION || JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
const originRequired = needsPackagedOrigin(expectedVersion);

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
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 180_000, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}${r.error ? ` (${r.error.message})` : ''}\n${(r.stdout || '').slice(-2000)}\n${(r.stderr || '').slice(-2000)}`);
  return r.stdout || '';
}

/** Wait until a file exists (NSIS returns before the files are all in place on slow disks). */
function waitFor(file, ms = 60_000) {
  const until = Date.now() + ms;
  while (!existsSync(file) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  return existsSync(file);
}

/** @type {Array<{ label: string, executable: string }>} */
const targets = [];
const files = walk(dir);
const scratchParent = realpathSync.native(tmpdir());
const tmp = mkdtempSync(join(scratchParent, 'jcad-smoke-'));
function cleanScratch() {
  if (process.env.JCAD_SMOKE_KEEP) return;
  try {
    const checked = realpathSync.native(tmp);
    if (dirname(checked) !== scratchParent || !basename(checked).startsWith('jcad-smoke-')) throw new Error('Unexpected packaged smoke temporary path');
    rmSync(checked, { recursive:true, force:true, maxRetries:3 });
  } catch (error) { console.warn(`Could not remove smoke temporary directory: ${error.message}`); }
}

try {
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
  const rosetta = native === 'arm64' && spawnSync('/usr/bin/arch', ['-x86_64', '/usr/bin/true'], { timeout: 15_000, windowsHide: true }).status === 0;
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

if (targets.length === 0) throw new Error(`packaged-smoke: no installer for ${process.platform} in ${dir}`);

const summary = [];
const results = [];
let failed = 0;
for (const t of targets) {
  console.log(`\n=== ${t.label}: ${t.executable}`);
  const out = join(outRoot, t.label.replace(/[^A-Za-z0-9._-]+/g, '-'));
  mkdirSync(out, { recursive: true });
  if (!existsSync(t.executable)) {
    summary.push(`FAIL ${t.label}: executable missing (${t.executable})`);
    const result = { label: t.label, expectedVersion, ok: false, probe: { ok: false, result: 'not run: executable missing', output: '' }, e2e: 'not run: executable missing', origin: { required: originRequired, result: 'not run: executable missing' } };
    results.push(result);
    writeFileSync(join(out, 'packaged-smoke-result.json'), `${JSON.stringify(result, null, 2)}\n`);
    failed += 1;
    continue;
  }
  // 1. The headless DWG probe: LibreDWG (worker thread, unpacked from the asar) in the packaged layout.
  const probeArgs = ['--probe-dwg', join(repo, 'fixtures', 'example_2000.dwg')];
  if (process.platform === 'linux') probeArgs.push('--no-sandbox');
  const probe = spawnSync(t.executable, probeArgs, { encoding: 'utf8', timeout: 120_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  const probeLine = `${probe.stdout || ''}`.split(/\r?\n/).find((l) => l.startsWith('PROBE_')) ?? `(no output; exit ${probe.status}${probe.error ? `, ${probe.error.message}` : ''})`;
  const probeOk = probe.status === 0 && /^PROBE_OK \S+ entities=\d+/.test(probeLine);
  console.log(`${probeOk ? 'ok  ' : 'FAIL'} --probe-dwg: ${probeLine}`);
  // The current release gate requires disabled inspection. Older published builds
  // remain testable through the legacy driver; they are explicitly reported as legacy.
  let shipping = false;
  try { await verifyExecutableFuses(t.executable, 'shipping'); shipping = true; }
  catch (error) { if (process.env.JCAD_SMOKE_REQUIRE_SHIPPING === '1') throw error; }
  if (shipping) {
    const runtime = spawnSync(process.execPath, [join(repo, 'scripts', 'shipping-runtime-smoke.mjs'), t.executable], {
      stdio:'inherit', env:{ ...process.env, JCAD_E2E_OUT:out }, timeout:4 * 60 * 1000, windowsHide:true,
    });
    const ok = probeOk && runtime.status === 0;
    if (!ok) failed += 1;
    const result = { label:t.label, expectedVersion, mode:'shipping-no-inspection', ok, probe:{ ok:probeOk, result:processResult(probe), output:probeLine }, shippingRuntime:processResult(runtime) };
    results.push(result);
    writeFileSync(join(out, 'packaged-smoke-result.json'), `${JSON.stringify(result, null, 2)}\n`);
    summary.push(`${ok ? 'ok  ' : 'FAIL'} ${t.label}: shipping fuses, DWG probe and fixed runtime/restart probes ${processResult(runtime)}`);
    continue;
  }
  // 2. The end-to-end checks against the packaged application.
  const e2e = spawnSync(process.execPath, ['--experimental-strip-types', join(repo, 'scripts', 'e2e-electron.mjs'), '--packaged', t.executable], {
    stdio: 'inherit',
    env: { ...process.env, JCAD_E2E_OUT: out },
    timeout: 15 * 60 * 1000,
    windowsHide: true,
  });
  // 3. Seed only legacy storage with stock Electron, then launch the installed build twice.
  // Older published releases used file:// and intentionally predate this migration.
  const origin = originRequired ? spawnSync(process.execPath, [join(repo, 'scripts', 'e2e-origin.mjs'), '--packaged', t.executable], {
    encoding: 'utf8',
    timeout: 4 * 60 * 1000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env },
  }) : null;
  const originResult = origin ? processResult(origin) : `skipped: ${expectedVersion} predates secure-origin migration`;
  if (origin) {
    const output = `${origin.stdout || ''}${origin.stderr || ''}`;
    process.stdout.write(output);
    writeFileSync(join(out, 'origin-migration.log'), output);
  }
  const ok = probeOk && e2e.status === 0 && (!originRequired || origin?.status === 0);
  if (!ok) failed += 1;
  const result = { label: t.label, expectedVersion, mode:'legacy-inspection-enabled', ok, probe: { ok: probeOk, result: processResult(probe), output: probeLine }, e2e: processResult(e2e), origin: { required: originRequired, result: originResult } };
  results.push(result);
  writeFileSync(join(out, 'packaged-smoke-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  summary.push(`${ok ? 'ok  ' : 'FAIL'} ${t.label}: probe ${probeOk ? 'ok' : 'failed'}, e2e ${processResult(e2e)}, origin ${originResult}`);
}
console.log(`\npackaged-smoke (${process.platform} ${process.arch}):\n${summary.join('\n')}`);
writeFileSync(join(outRoot, 'packaged-smoke-results.json'), `${JSON.stringify({ platform: process.platform, arch: process.arch, expectedVersion, results, failed }, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
} finally { cleanScratch(); }
