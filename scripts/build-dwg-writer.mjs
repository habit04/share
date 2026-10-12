// Build a pinned native Windows writer, package corresponding source and seal its final bytes.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, lstat, copyFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareDwgWriter, patchedCrateEntries, verifyPreparedSource, readSourceArchive, sourceHash, DWG_WRITER_PINS } from './prepare-dwg-writer.mjs';
import { sealDwgWriter } from './seal-dwg-writer.mjs';

const ROOT = resolve(import.meta.dirname, '..');
function command(file, args, cwd, env, capture = false) {
  return execFileSync(file, args, { cwd, env, windowsHide: true, shell: false, timeout: 10 * 60_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
}
async function textLicenses(directory, skip = new Set()) {
  const notices = [];
  for (const name of await readdir(directory)) {
    if (skip.has(name)) continue;
    if (!/^(?:licen[cs]es?|copying|copyright|notice)(?:[._-].*)?$/i.test(name)) continue;
    const file = join(directory, name), info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error('Linked DWG dependency license file.');
    if (info.isFile()) {
      if (info.size > 4 * 1024 * 1024) throw new Error('DWG dependency license exceeds its budget.');
      notices.push({ name, text: await readFile(file, 'utf8') });
    } else if (info.isDirectory()) for (const child of await readdir(file)) {
      const nested = join(file, child), nestedInfo = await lstat(nested);
      if (nestedInfo.isSymbolicLink()) throw new Error('Linked DWG dependency license file.');
      if (nestedInfo.isFile() && nestedInfo.size <= 4 * 1024 * 1024) notices.push({ name: `${name}/${child}`, text: await readFile(nested, 'utf8') });
    }
  }
  return notices;
}
export async function writeDependencyNotices(packages, file, runtimeRoot) {
  const records = [];
  for (const pkg of packages) {
    if (pkg.source !== null && pkg.source !== 'registry+https://github.com/rust-lang/crates.io-index') throw new Error('Unexpected DWG writer dependency source.');
    if (pkg.source === null && !['jcad-dwg-writer', DWG_WRITER_PINS.crate.name].includes(pkg.name)) throw new Error('Unexpected local DWG writer dependency.');
    const notices = await textLicenses(dirname(pkg.manifest_path));
    if (!notices.length && pkg.name !== 'jcad-dwg-writer') throw new Error(`Missing DWG writer dependency license: ${pkg.name}`);
    records.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? 'See included license', source: pkg.name === 'jcad-dwg-writer' ? 'https://github.com/habit04/share' : `https://crates.io/crates/${pkg.name}/${pkg.version}`, notices });
  }
  const rust = join(runtimeRoot, 'share/doc/rust');
  // The standard-library notice is redistributed; compiler-only COPYRIGHT.html
  // covers tools absent from the app. GNU exception and full license texts remain included.
  const runtimeNotices = await textLicenses(rust, new Set(['COPYRIGHT.html']));
  if (!runtimeNotices.length) throw new Error('Missing Rust runtime license notices.');
  records.push({ name: 'Rust standard library and GNU runtime', version: DWG_WRITER_PINS.toolchain.version, license: 'See included Rust/GNU license and runtime exception notices', source: 'https://www.rust-lang.org/policies/licenses', notices: runtimeNotices });
  await writeFile(file, JSON.stringify({ schemaVersion: 1, packages: records }, null, 2) + '\n');
}
export async function bundleIntegrity(directory, metadata = {}) {
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    if (name === 'integrity.json') continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name) || name.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('Unsafe DWG writer bundle name.');
    const file = join(directory, name), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) throw new Error('DWG writer bundle contains a non-file or empty file.');
    files.push({ name, size: info.size, sha256: sourceHash(await readFile(file)) });
  }
  if (!files.some((file) => file.name === 'JcadDwgWriter.exe') || files.length > 64 || new Set(files.map((file) => file.name.toLowerCase())).size !== files.length || files.reduce((n, file) => n + file.size, 0) > 512 * 1024 * 1024) throw new Error('Invalid DWG writer bundle contents.');
  return { ...metadata, schemaVersion: 1, files };
}
export async function buildDwgWriter({ root = ROOT } = {}) {
  if (process.platform !== 'win32') throw new Error('The portable DWG helper build is currently Windows-only.');
  const helper = resolve(root, 'native/dwg-writer'), cargo = process.env.JCAD_CARGO || 'cargo', rustc = process.env.JCAD_RUSTC || 'rustc';
  const env = { ...process.env, RUSTC: rustc, CARGO_HOME: process.env.CARGO_HOME || join(helper, '.cargo-home'), CARGO_TARGET_DIR: join(helper, 'target') };
  const version = command(rustc, ['--version'], helper, env, true).trim();
  if (!version.startsWith(`rustc ${DWG_WRITER_PINS.toolchain.version} `)) throw new Error(`DWG writer requires Rust ${DWG_WRITER_PINS.toolchain.version}.`);
  const source = await prepareDwgWriter({ root });
  for (const directory of [join(helper, 'target'), resolve(root, 'release'), resolve(root, 'release/dwg-writer')]) {
    try { if ((await lstat(directory)).isSymbolicLink()) throw new Error('Linked DWG writer output directory.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const args = ['--manifest-path', join(helper, 'Cargo.toml'), '--locked'];
  command(cargo, ['test', ...args, '--release', '--target', DWG_WRITER_PINS.toolchain.target], helper, env);
  command(cargo, ['build', ...args, '--release', '--target', DWG_WRITER_PINS.toolchain.target], helper, env);
  const metadata = JSON.parse(command(cargo, ['metadata', ...args, '--format-version', '1', '--filter-platform', DWG_WRITER_PINS.toolchain.target], helper, env, true));
  const localManifests = new Map([['jcad-dwg-writer', join(helper, 'Cargo.toml')], [DWG_WRITER_PINS.crate.name, join(source, 'Cargo.toml')]]);
  for (const pkg of metadata.packages) {
    const expected = localManifests.get(pkg.name);
    if (pkg.source === null && (typeof expected !== 'string' || resolve(pkg.manifest_path).toLowerCase() !== expected.toLowerCase())) throw new Error('DWG writer contains an unreviewed local dependency path.');
  }
  const original = await readSourceArchive(process.env.JCAD_ACADRUST_ARCHIVE || join(helper, '.acadrust-0.6.4.crate'));
  await verifyPreparedSource(source, patchedCrateEntries(original));
  const output = resolve(root, 'release/dwg-writer');
  await mkdir(output, { recursive: true });
  if ((await lstat(output)).isSymbolicLink()) throw new Error('Linked DWG writer staging directory.');
  const allowed = new Set(['JcadDwgWriter.exe', 'JcadDwgWriter-Source.zip', 'ThirdPartyNotices.json', 'integrity.json']);
  if ((await readdir(output)).some((name) => !allowed.has(name))) throw new Error('DWG writer staging contains unexpected files.');
  await copyFile(join(helper, 'target', DWG_WRITER_PINS.toolchain.target, 'release/JcadDwgWriter.exe'), join(output, 'JcadDwgWriter.exe'));
  const runtimeRoot = command(rustc, ['--print', 'sysroot'], helper, env, true).trim();
  await writeDependencyNotices(metadata.packages, join(output, 'ThirdPartyNotices.json'), runtimeRoot);
  // Windows' bundled bsdtar supports ZIP; it receives explicit source paths, never build caches.
  const archive = join(output, 'JcadDwgWriter-Source.zip');
  const sources = ['native/dwg-writer/Cargo.toml', 'native/dwg-writer/Cargo.lock', 'native/dwg-writer/README.md', 'native/dwg-writer/src', 'native/dwg-writer/tests', 'native/dwg-writer/vendor/acadrust', 'vendor/acadrust-writer', 'scripts/prepare-dwg-writer.mjs', 'scripts/prepare-dwg-writer.d.mts', 'scripts/build-dwg-writer.mjs', 'scripts/build-dwg-writer.d.mts', 'scripts/seal-dwg-writer.mjs', 'LICENSE'];
  for (const name of sources) { const local = relative(root, resolve(root, name)); if (isAbsolute(local) || local.startsWith('..')) throw new Error('DWG writer source archive path escapes the repository.'); }
  command(join(process.env.SystemRoot || 'C:/Windows', 'System32/tar.exe'), ['-a', '-cf', archive, ...sources], root, env);
  const helperSigning = await sealDwgWriter(output);
  const manifest = await bundleIntegrity(output, { helperSigning, engine: { name: DWG_WRITER_PINS.crate.name, version: DWG_WRITER_PINS.crate.version, crateSha256: DWG_WRITER_PINS.crate.sha256, sourceCommit: DWG_WRITER_PINS.crate.commit, patchesSha256: sourceHash(await readFile(join(root, 'vendor/acadrust-writer/pins.json'))), cargoLockSha256: sourceHash(await readFile(join(helper, 'Cargo.lock'))), target: DWG_WRITER_PINS.toolchain.target, rustc: version } });
  const bytes = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(join(output, 'integrity.json'), bytes);
  await writeFile(join(root, 'electron/dwg-writer-integrity.json'), bytes);
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const result = await buildDwgWriter(); console.log(`DWG writer built and sealed (${result.files.length} verified bundle files).`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
