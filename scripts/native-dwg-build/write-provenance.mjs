import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, copyFile, lstat, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pins, sha256, validatePatchedSource } from './patch-source.mjs';
import { validateMetadataReport } from './validate-metadata-fixture.mjs';

const [sourceArg, sdkArg, artifactArg] = process.argv.slice(2);
if (!sourceArg || !sdkArg || !artifactArg || process.argv.length !== 5) throw new Error('Usage: write-provenance.mjs SOURCE SDK ARTIFACT');
const source = resolve(sourceArg), sdk = resolve(sdkArg), artifact = resolve(artifactArg);
const here = dirname(fileURLToPath(import.meta.url));
const gitHead = (directory) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();
assert.equal(gitHead(source), pins.source.commit, 'Source SHA changed during build.');
assert.equal(gitHead(sdk), pins.compiler.commit, 'SDK SHA changed during build.');
for (const submodule of pins.submodules) assert.equal(gitHead(join(source, submodule.path)), submodule.commit, 'Submodule SHA changed during build.');
const releaseTags = JSON.parse(await readFile(join(sdk, 'emscripten-releases-tags.json'), 'utf8'));
assert.equal(releaseTags.releases[pins.compiler.version], pins.compiler.releaseHash, 'Emscripten release binary pin changed.');
const compiler = execFileSync('emcc', ['--version'], { encoding: 'utf8' }).trim();
assert.match(compiler.split('\n')[0], /\b4\.0\.23\b/, 'Wrong active Emscripten compiler.');
assert.ok(process.env.NATIVE_DECLARATION_TOOLS, 'Missing isolated declaration compiler directory.');
const declarationPackage = JSON.parse(await readFile(join(process.env.NATIVE_DECLARATION_TOOLS, 'node_modules/typescript/package.json'), 'utf8'));
const declarationLock = JSON.parse(await readFile(join(process.env.NATIVE_DECLARATION_TOOLS, 'package-lock.json'), 'utf8')).packages['node_modules/typescript'];
assert.equal(declarationPackage.version, pins.declarationCompiler.version);
for (const key of ['version', 'resolved', 'integrity']) assert.equal(declarationLock[key], pins.declarationCompiler[key], 'Declaration compiler pin changed.');
const declarationVersion = execFileSync('tsc', ['--version'], { encoding: 'utf8' }).trim();
assert.equal(declarationVersion, `Version ${pins.declarationCompiler.version}`, 'Wrong active declaration compiler.');
await validatePatchedSource(source);
const patchReport = JSON.parse(await readFile(join(artifact, 'patch-report.json'), 'utf8'));
assert.equal(patchReport.source.commit, pins.source.commit);
const fixture = JSON.parse(await readFile(join(artifact, 'fixture-report.json'), 'utf8'));
assert.equal(fixture.nativeError, 0, 'Fixture validation did not complete successfully.');
assert.equal(fixture.masks.length, 7);
const appearance = JSON.parse(await readFile(join(artifact, 'appearance-report.json'), 'utf8'));
assert.equal(appearance.cases?.length, 2, 'Native appearance/shipping validation did not complete.');
for (const result of appearance.cases) assert.equal(result.nativeError, 0, 'Native appearance/shipping fixture has decoder errors.');
const metadata = JSON.parse(await readFile(join(artifact, 'metadata-report.json'), 'utf8'));
const metadataFixture = await readFile(resolve(here, '../..', pins.metadataFixture));
const metadataExpectedBytes = await readFile(resolve(here, '../..', pins.metadataExpected));
const metadataExpected = JSON.parse(metadataExpectedBytes.toString('utf8'));
assert.equal(metadataExpected.source?.dwgSha256, sha256(metadataFixture));
assert.match(metadataExpected.source?.software || '', /AutoCAD/);
assert.deepEqual(metadataExpected.source?.audit, { errors: 0, fixed: 0 });
assert.equal(metadata.fixtureSha256, sha256(metadataFixture));
assert.equal(metadata.expectedSha256, sha256(Buffer.from(metadataExpectedBytes.toString('utf8').replace(/\r\n/g, '\n'))));
validateMetadataReport(metadata, metadataExpected);
assert.equal(metadata.classProjectionVerified, true, 'Every stored native CLASS definition must be exposed and checked.');
const packageManifest = JSON.parse(await readFile(join(source, 'bindings/javascript/package.json'), 'utf8'));
for (const filename of ['pins.json', 'mtext-background-scale.patch.json', 'README.md', 'patch-source.mjs', 'validate-fixture.mjs', 'validate-appearance-fixture.mjs', 'validate-metadata-fixture.mjs', 'write-provenance.mjs']) await copyFile(join(here, filename), join(artifact, filename));
await mkdir(join(artifact, 'declaration-tools'), { recursive: true });
for (const filename of ['package.json', 'package-lock.json']) await copyFile(join(here, 'declaration-tools', filename), join(artifact, 'declaration-tools', filename));
await copyFile(join(source, 'COPYING'), join(artifact, 'COPYING'));
const files = ['factory/libredwg-web.js', 'factory/libredwg-web.wasm', 'factory/package.json', 'modified-source.tar.gz', 'COPYING', 'pins.json', 'mtext-background-scale.patch.json', 'README.md', 'patch-source.mjs', 'validate-fixture.mjs', 'validate-appearance-fixture.mjs', 'validate-metadata-fixture.mjs', 'write-provenance.mjs', 'patch-report.json', 'fixture-report.json', 'appearance-report.json', 'metadata-report.json', 'declaration-tools/package.json', 'declaration-tools/package-lock.json'];
const assets = [];
for (const filename of files) {
  const path = join(artifact, filename), stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Not a regular artifact: ${filename}`);
  assets.push({ path: filename, bytes: stat.size, sha256: sha256(await readFile(path)) });
}
assert.equal(assets.find((asset) => asset.path === 'factory/libredwg-web.js').sha256, fixture.factorySha256);
assert.equal(assets.find((asset) => asset.path === 'factory/libredwg-web.wasm').sha256, fixture.wasmSha256);
assert.equal(appearance.factorySha256, fixture.factorySha256, 'Appearance gate used different factory bytes.');
assert.equal(appearance.wasmSha256, fixture.wasmSha256, 'Appearance gate used different WASM bytes.');
assert.equal(metadata.factorySha256, fixture.factorySha256, 'Metadata gate used different factory bytes.');
assert.equal(metadata.wasmSha256, fixture.wasmSha256, 'Metadata gate used different WASM bytes.');
assert.equal(assets.find((asset) => asset.path === 'mtext-background-scale.patch.json').sha256, patchReport.patchSha256);
const provenance = {
  schemaVersion: 1,
  purpose: 'Controlled native appearance and bounded VIEW/FIELD/typed metadata projection repair; no release publication or installed dependency mutation',
  source: pins.source,
  submodules: pins.submodules,
  compiler: { ...pins.compiler, observedVersion: compiler },
  declarationCompiler: { ...pins.declarationCompiler, observedVersion: declarationVersion },
  license: { packageSpdx: 'GPL-3.0', nativeSourceNotice: 'GPL-3.0-or-later; see each source file and COPYING', correspondingSource: 'modified-source.tar.gz' },
  build: { commands: ['./autogen.sh', 'npm run build:prepare', 'npm run build:obj', 'npm run build:wasm'], makeFlags: '-j2', scripts: Object.fromEntries(['build:prepare', 'build:obj', 'build:wasm'].map((name) => [name, packageManifest.scripts[name]])), observedTools: { node: process.version, ...Object.fromEntries(['npm', 'autoconf', 'automake', 'libtoolize', 'make', 'gcc', 'pkg-config'].map((command) => [command, execFileSync(command, ['--version'], { encoding: 'utf8' }).trim().split('\n')[0]])) } },
  validation: { fixtureSha256: fixture.fixtureSha256, expectedSha256: fixture.expectedSha256, nativeError: fixture.nativeError, maskCount: fixture.masks.length, report: 'fixture-report.json', appearanceReport: 'appearance-report.json', appearanceCases: appearance.cases.map(({ kind, fixtureSha256, expectedSha256, nativeError }) => ({ kind, fixtureSha256, expectedSha256, nativeError })),
    metadata: { report: 'metadata-report.json', fixtureSha256: metadata.fixtureSha256, expectedSha256: metadata.expectedSha256, nativeError: 0, writeError: 0, complete: true, recordCount: metadata.records.length, maxOutputBytes: metadata.maxOutputBytes, limitedOutputRejected: true,
      classProjectionVerified: true, nativeClassCount: metadata.nativeClassCount } },
  workflow: { repository: process.env.GITHUB_REPOSITORY || '', commit: process.env.GITHUB_SHA || '', runId: process.env.GITHUB_RUN_ID || '', runAttempt: process.env.GITHUB_RUN_ATTEMPT || '' },
  patchedFiles: await Promise.all(patchReport.files.map(async (file) => ({ ...file, builtSourceSha256: sha256(await readFile(join(source, file.path))) }))),
  assets,
  limitations: ['The original npm binary compiler version is not recorded upstream; this rebuild uses the pinned compiler above.', 'The independent fixtures validate these native decoder fields and selected typed metadata records, not all DWG versions/entities or final application adapters.', 'The native DXF projection is bounded to 32 MiB and 100000 source objects; its complete flag requires application reconciliation of projected objects with the source inventory.', 'Unknown DWG schemas, raw binary objects, native embedded MTEXT and arbitrary FIELD evaluators are not certified by this fixture.', 'SHA256 records bind artifact bytes; this workflow does not sign or publish artifacts.'],
};
await writeFile(join(artifact, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx' });
const checksums = [...assets, { path: 'provenance.json', sha256: sha256(await readFile(join(artifact, 'provenance.json'))) }].map((asset) => `${asset.sha256}  ${asset.path}`).join('\n') + '\n';
await writeFile(join(artifact, 'SHA256SUMS'), checksums, { flag: 'wx' });
console.log(`NATIVE_PROVENANCE_OK source=${pins.source.commit} sdk=${pins.compiler.version} assets=${assets.length}`);
