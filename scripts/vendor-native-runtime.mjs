/** Read-only acceptance of the controlled native artifact. Never loads JS or instantiates WASM. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wasmMemoryLimits } from './dwg-wasm-memory.mjs';
import { checkedNativeColor, encodedNativeAlpha } from './native-dwg-build/validate-appearance-fixture.mjs';
import { validateMetadataReport } from './native-dwg-build/validate-metadata-fixture.mjs';
export { wasmMemoryLimits } from './dwg-wasm-memory.mjs';

export const NATIVE_SOURCE = Object.freeze({ repository: 'https://github.com/mlightcad/libredwg-web', tag: 'v0.7.14', commit: '1dd682f46339f37b67c5ff1085d10d04a8c16d7e' });
const SDK = { version: '4.0.23', commit: 'c0bb220cb6e6f4e0fabb6f6db9efd53390ef5e56', releaseHash: 'aaa43392544d695232b70eda706d751f18980c2a' };
const DECLARATION = { name: 'typescript', version: '5.7.3', resolved: 'https://registry.npmjs.org/typescript/-/typescript-5.7.3.tgz', integrity: 'sha512-84MVSjMEHP+FQRPy3pX9sTVV/INIex71s9TL2Gm5FG/WG1SqXeKyZ0k7/blY/4FdOzI12CBy1vGc4og/eus0fw==' };
const PATCH_SHA256 = 'f666e69a0316536df7e344efe2b0a9c550918d06ad57b65ecbc4c523540f8cf6';
const APPEARANCE_PATCH_SHA256 = '98c701b374f44baeebf36aca079b9258da87b6ecef13784b7e1a6d294e222aae';
const METADATA_PATCH_SHA256 = '5eeaa4eaf3291895eab76065b2fd012fb30098764559e02cbbbb10e695c16322';
const ASSETS = ['factory/libredwg-web.js', 'factory/libredwg-web.wasm', 'factory/package.json', 'modified-source.tar.gz', 'COPYING', 'pins.json', 'mtext-background-scale.patch.json', 'README.md', 'patch-source.mjs', 'validate-fixture.mjs', 'write-provenance.mjs', 'patch-report.json', 'fixture-report.json', 'declaration-tools/package.json', 'declaration-tools/package-lock.json'];
const APPEARANCE_ASSETS = [...ASSETS, 'validate-appearance-fixture.mjs', 'appearance-report.json'];
const METADATA_ASSETS = [...APPEARANCE_ASSETS, 'validate-metadata-fixture.mjs', 'metadata-report.json'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

async function regularFile(root, name, maxBytes) {
  assert.ok(!name.includes('\\') && !name.includes('\0') && !isAbsolute(name), 'Invalid native artifact path.');
  const path = resolve(root, name), rel = relative(root, path);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Native artifact path escapes directory.');
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maxBytes, `Invalid/oversized native artifact: ${name}`);
  assert.ok(samePath(await realpath(path), path), `Linked native artifact: ${name}`);
  return readFile(path);
}

/** All inputs are mandatory. Byte hashes establish consistency, not GitHub run authenticity. */
export async function verifyNativeRuntime(directory, fixturePath, expectedPath, { repairPolicy = 'appearance-arrays' } = {}) {
  assert.ok(['background', 'appearance-arrays', 'metadata-graph'].includes(repairPolicy), 'Unknown native repair policy.');
  const metadataPolicy = repairPolicy === 'metadata-graph', appearancePolicy = repairPolicy !== 'background';
  const assets = metadataPolicy ? METADATA_ASSETS : appearancePolicy ? APPEARANCE_ASSETS : ASSETS;
  const checkedPatchHash = metadataPolicy ? METADATA_PATCH_SHA256 : appearancePolicy ? APPEARANCE_PATCH_SHA256 : PATCH_SHA256;
  assert.ok(directory && fixturePath && expectedPath, 'Native runtime, fixture and ground truth are required.');
  const root = await realpath(resolve(directory));
  const json = async (name) => JSON.parse((await regularFile(root, name, 512 * 1024)).toString('utf8'));
  const provenanceBytes = await regularFile(root, 'provenance.json', 512 * 1024), provenance = JSON.parse(provenanceBytes.toString());
  assert.equal(provenance.schemaVersion, 1); assert.deepEqual(provenance.source, NATIVE_SOURCE);
  for (const [key, value] of Object.entries(SDK)) assert.equal(provenance.compiler?.[key], value, `Native SDK ${key} mismatch.`);
  assert.match(provenance.compiler?.observedVersion || '', /\b4\.0\.23\b/);
  for (const [key, value] of Object.entries(DECLARATION)) assert.equal(provenance.declarationCompiler?.[key], value, `Declaration compiler ${key} mismatch.`);
  assert.equal(provenance.declarationCompiler?.observedVersion, 'Version 5.7.3');
  assert.equal(provenance.workflow?.repository, 'habit04/share'); assert.match(provenance.workflow?.commit || '', /^[a-f0-9]{40}$/);
  assert.match(provenance.workflow?.runId || '', /^[1-9]\d*$/); assert.match(provenance.workflow?.runAttempt || '', /^[1-9]\d*$/);
  assert.deepEqual(provenance.assets?.map((asset) => asset.path).sort(), [...assets].sort(), 'Native public asset contract mismatch.');
  const checksumBytes = await regularFile(root, 'SHA256SUMS', 16 * 1024), checksums = new Map();
  for (const line of checksumBytes.toString('utf8').trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) {2}([^\r\n]+)$/.exec(line); assert.ok(match, 'Malformed native checksum line.');
    assert.ok(!checksums.has(match[2]), 'Duplicate native checksum path.'); checksums.set(match[2], match[1]);
  }
  assert.deepEqual([...checksums.keys()].sort(), [...assets, 'provenance.json'].sort());
  assert.equal(checksums.get('provenance.json'), digest(provenanceBytes), 'Native provenance checksum mismatch.');
  const bytes = new Map();
  for (const asset of provenance.assets) {
    assert.match(asset.sha256, /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(asset.bytes) && asset.bytes > 0);
    const maximum = asset.path.endsWith('.wasm') ? 32 * 1024 * 1024 : asset.path.endsWith('.tar.gz') ? 128 * 1024 * 1024 : 4 * 1024 * 1024;
    const content = await regularFile(root, asset.path, maximum);
    assert.equal(content.length, asset.bytes, `Native size mismatch: ${asset.path}`);
    assert.equal(digest(content), asset.sha256, `Native hash mismatch: ${asset.path}`);
    assert.equal(checksums.get(asset.path), asset.sha256, `Native checksum/manifest mismatch: ${asset.path}`);
    bytes.set(asset.path, content);
  }
  assert.equal(digest(bytes.get('mtext-background-scale.patch.json')), checkedPatchHash, 'Checked native patch changed.');
  const copying = bytes.get('COPYING');
  assert.equal(createHash('sha1').update(`blob ${copying.length}\0`).update(copying).digest('hex'), '94a9ed024d3859793618152ea559a168bbcbb5e2', 'Original native COPYING changed.');
  assert.equal(provenance.license?.correspondingSource, 'modified-source.tar.gz');
  assert.equal((await json('factory/package.json')).type, 'module');
  const pins = await json('pins.json'); assert.deepEqual(pins.source, NATIVE_SOURCE);
  for (const [key, value] of Object.entries(SDK)) assert.equal(pins.compiler?.[key], value);
  assert.deepEqual(pins.declarationCompiler, DECLARATION);
  const declarationLock = (await json('declaration-tools/package-lock.json')).packages['node_modules/typescript'];
  for (const key of ['version', 'resolved', 'integrity']) assert.equal(declarationLock[key], DECLARATION[key]);
  assert.equal((await json('declaration-tools/package.json')).dependencies.typescript, DECLARATION.version);
  const submodules = [{ path: 'jsmn', repository: 'https://github.com/zserge/jsmn', commit: '85695f3d5903b1cd5b4030efe50db3b4f5f3c928' }];
  assert.deepEqual(pins.submodules, submodules); assert.deepEqual(provenance.submodules, submodules);
  const patch = await json('patch-report.json'); assert.deepEqual(patch.source, NATIVE_SOURCE); assert.equal(patch.patchSha256, checkedPatchHash);
  const fileCount = metadataPolicy ? 13 : appearancePolicy ? 11 : 6;
  assert.equal(patch.files?.length, fileCount); assert.equal(provenance.patchedFiles?.length, fileCount);
  const checkedPatch = await json('mtext-background-scale.patch.json');
  assert.deepEqual(patch.files.map((file) => file.path).sort(), checkedPatch.files.map((file) => file.path).sort());
  for (const file of checkedPatch.files) {
    const record = patch.files.find((item) => item.path === file.path);
    assert.match(record.beforeSha256, /^[a-f0-9]{64}$/); assert.match(record.afterSha256, /^[a-f0-9]{64}$/);
    assert.equal(record.replacements, file.replacements.reduce((sum, replacement) => sum + replacement.count, 0));
    const built = provenance.patchedFiles.find((item) => item.path === file.path);
    assert.ok(built, `Missing built-source patch record ${file.path}`);
    const { builtSourceSha256, ...base } = built;
    assert.deepEqual(base, record); assert.match(builtSourceSha256, /^[a-f0-9]{64}$/);
  }
  const report = await json('fixture-report.json');
  assert.equal(report.nativeError, 0); assert.equal(report.masks?.length, 7);
  assert.equal(report.factorySha256, digest(bytes.get('factory/libredwg-web.js'))); assert.equal(report.wasmSha256, digest(bytes.get('factory/libredwg-web.wasm')));
  const fixture = await readFile(resolve(fixturePath)), expectedBytes = await readFile(resolve(expectedPath));
  assert.ok(fixture.length > 0 && fixture.length <= 4 * 1024 * 1024 && expectedBytes.length <= 64 * 1024, 'Native fixture budget exceeded.');
  assert.equal(report.fixtureSha256, digest(fixture), 'Native input preimage changed.');
  assert.equal(report.expectedSha256, digest(Buffer.from(expectedBytes.toString('utf8').replace(/\r\n/g, '\n'))), 'Native ground truth preimage changed.');
  assert.equal(provenance.validation?.fixtureSha256, report.fixtureSha256); assert.equal(provenance.validation?.expectedSha256, report.expectedSha256);
  assert.equal(provenance.validation?.nativeError, 0); assert.equal(provenance.validation?.maskCount, 7);
  const expected = JSON.parse(expectedBytes.toString('utf8'));
  assert.equal(expected.masks?.length, 7); assert.equal(new Set(expected.masks.map((mask) => mask.text)).size, 7); assert.equal(new Set(report.masks.map((mask) => mask.text)).size, 7);
  for (const wanted of expected.masks) {
    const actual = report.masks.find((mask) => mask.text === wanted.text); assert.ok(actual, `Missing native mask ${wanted.text}`);
    assert.equal(actual.flags, wanted.flags);
    if (wanted.scale !== undefined) assert.ok(Number.isFinite(actual.scale) && Math.abs(actual.scale - wanted.scale) < 1e-10);
    if (wanted.color !== undefined) {
      const encoded = (actual.color?.rgb >>> 0) & 0xffffff;
      assert.equal(actual.color?.method === 0xc3 && encoded > 0 && encoded < 256 ? encoded : actual.color?.index, wanted.color);
    }
    if (wanted.trueColor !== undefined) assert.equal((actual.color?.rgb >>> 0) & 0xffffff, wanted.trueColor);
    if (wanted.colorName !== undefined) assert.equal(actual.color?.book_name ? `${actual.color.book_name}$${actual.color.name}` : actual.color?.name, wanted.colorName);
  }
  let appearance;
  if (appearancePolicy) {
    appearance = await json('appearance-report.json');
    assert.equal(appearance.schemaVersion, 1);
    assert.equal(appearance.factorySha256, report.factorySha256, 'Native appearance factory differs.');
    assert.equal(appearance.wasmSha256, report.wasmSha256, 'Native appearance WASM differs.');
    assert.deepEqual(appearance.cases?.map((entry) => entry.kind), ['appearance', 'shipping']);
    const sourceRoot = resolve(import.meta.dirname, '..');
    const appearancePaths = { appearanceFixture: 'tests/fixtures/interchange/r2018-portable-appearance.dwg', appearanceExpected: 'tests/fixtures/interchange/r2018-portable-appearance.expected.json', shippingFixture: 'tests/fixtures/interchange/r2018-native-shipping.dwg', shippingExpected: 'tests/fixtures/interchange/r2018-native-shipping.expected.json' };
    for (const [key, value] of Object.entries(appearancePaths)) assert.equal(pins[key], value, 'Native appearance fixture path changed.');
    for (const [index, fixtureKey, expectedKey] of [[0, 'appearanceFixture', 'appearanceExpected'], [1, 'shippingFixture', 'shippingExpected']]) {
      const entry = appearance.cases[index];
      const fixture = await readFile(resolve(sourceRoot, pins[fixtureKey])), expectedBytes = await readFile(resolve(sourceRoot, pins[expectedKey]));
      assert.ok(fixture.length > 0 && fixture.length <= 4 * 1024 * 1024 && expectedBytes.length <= 64 * 1024, 'Native appearance input budget exceeded.');
      const wanted = JSON.parse(expectedBytes.toString('utf8'));
      assert.equal(entry.fixtureSha256, digest(fixture));
      assert.equal(entry.fixtureSha256, wanted.dwgSha256);
      assert.equal(entry.expectedSha256, digest(Buffer.from(expectedBytes.toString('utf8').replace(/\r\n/g, '\n'))));
      assert.equal(entry.nativeError, 0);
      for (const color of Object.values(entry.colors ?? {})) checkedNativeColor(color);
      assert.ok(Object.keys(entry.colors ?? {}).length > 0, 'Native common colors are absent.');
      if (index === 0) {
        for (const [handle, alpha] of Object.entries(wanted.modelTransparencyByHandle)) assert.equal(encodedNativeAlpha(entry.colors[handle]), alpha);
        for (const [handle, color] of Object.entries(wanted.namedEntityByHandle)) {
          const actual = checkedNativeColor(entry.colors[handle]);
          assert.equal(actual.referenceResolved, true);
          assert.equal((actual.rgb >>> 0) & 0xffffff, color.rgb);
          assert.equal(actual.book_name ? `${actual.book_name}$${actual.name}` : actual.name, color.name);
        }
        assert.equal((entry.layers?.RICH?.rgb >>> 0) & 0xffffff, 0x123456);
        assert.equal(`${entry.layers?.RICH?.book_name}$${entry.layers?.RICH?.name}`, 'Studio Book$Teal 雷');
      } else {
        assert.equal(entry.arrays?.length, 1);
        const { handle: _handle, ...array } = entry.arrays[0];
        assert.deepEqual(array, wanted.array);
        const polyline = checkedNativeColor(entry.colors[wanted.polyline.handle]);
        assert.equal((polyline.rgb >>> 0) & 0xffffff, wanted.polyline.rgb);
        assert.equal(encodedNativeAlpha(polyline), wanted.polyline.alpha);
      }
    }
    assert.deepEqual(provenance.validation?.appearanceCases, appearance.cases.map(({ kind, fixtureSha256, expectedSha256, nativeError }) => ({ kind, fixtureSha256, expectedSha256, nativeError })));
  }
  let metadata;
  if (metadataPolicy) {
    assert.equal(pins.metadataFixture, 'tests/fixtures/interchange/r2018-views-fields.dwg');
    assert.equal(pins.metadataExpected, 'tests/fixtures/interchange/r2018-views-fields.expected.json');
    const sourceRoot = resolve(import.meta.dirname, '..');
    const [fixture, expectedBytes] = await Promise.all([readFile(resolve(sourceRoot, pins.metadataFixture)), readFile(resolve(sourceRoot, pins.metadataExpected))]);
    assert.ok(fixture.length > 0 && fixture.length <= 4 * 1024 * 1024 && expectedBytes.length <= 128 * 1024);
    const wanted = JSON.parse(expectedBytes.toString('utf8'));
    assert.equal(wanted.source?.dwgSha256, digest(fixture));
    assert.match(wanted.source?.software || '', /AutoCAD/);
    assert.deepEqual(wanted.source?.audit, { errors: 0, fixed: 0 });
    metadata = await json('metadata-report.json');
    assert.equal(metadata.factorySha256, report.factorySha256);
    assert.equal(metadata.wasmSha256, report.wasmSha256);
    assert.equal(metadata.fixtureSha256, digest(fixture));
    assert.equal(metadata.expectedSha256, digest(Buffer.from(expectedBytes.toString('utf8').replace(/\r\n/g, '\n'))));
    validateMetadataReport(metadata, wanted);
    assert.deepEqual(provenance.validation?.metadata, { report: 'metadata-report.json', fixtureSha256: metadata.fixtureSha256, expectedSha256: metadata.expectedSha256,
      nativeError: 0, writeError: 0, complete: true, recordCount: wanted.records.length, maxOutputBytes: metadata.maxOutputBytes, limitedOutputRejected: true });
  }
  const memory = wasmMemoryLimits(bytes.get('factory/libredwg-web.wasm'));
  assert.deepEqual(memory, [{ origin: 'defined', flags: 1, minPages: 16384, maxPages: 65536, minBytes: 1073741824, maxBytes: 4294967296 }], 'Native memory policy differs from distributed baseline.');
  return { directory: root, source: provenance.source, compiler: SDK.version, declarationCompiler: DECLARATION.version, workflow: provenance.workflow, factorySha256: report.factorySha256, wasmSha256: report.wasmSha256, memory: memory[0], masks: report.masks, repairPolicy, ...(appearance ? { appearance } : {}), ...(metadata ? { metadata } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, fixture, expected, option, policy] = process.argv.slice(2);
  if (process.argv.length !== 5 && !(process.argv.length === 7 && option === '--policy')) throw new Error('Usage: vendor-native-runtime.mjs VENDOR_DIRECTORY DWG_FIXTURE EXPECTED_JSON [--policy metadata-graph|appearance-arrays|background]');
  console.log(JSON.stringify(await verifyNativeRuntime(directory, fixture, expected, policy ? { repairPolicy: policy } : {}), null, 2));
}
