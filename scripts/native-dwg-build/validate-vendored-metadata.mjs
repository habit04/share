/** Real-file regression gate for the accepted runtime; never rebuilds or replaces it. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNativeRuntime } from '../vendor-native-runtime.mjs';
import { validateMetadataFixture } from './validate-metadata-fixture.mjs';

export const METADATA_FIXTURES = Object.freeze([
  'r2018-views-fields', 'r2018-field-object-reference', 'r2018-unicode-metadata',
]);

/** @param {string} [outputDirectory] */
export async function validateVendoredMetadata(outputDirectory) {
  const root = resolve(import.meta.dirname, '../..');
  const vendor = join(root, 'vendor/libredwg-web-bg');
  const fixtures = join(root, 'tests/fixtures/interchange');
  const runtime = await verifyNativeRuntime(vendor, join(fixtures, 'r2018-mtext-background.dwg'),
    join(fixtures, 'r2018-mtext-background.expected.json'), { repairPolicy: 'metadata-graph' });
  const output = outputDirectory ? resolve(outputDirectory) : undefined;
  if (output) await mkdir(output, { recursive: true });
  const cases = [];
  for (const stem of METADATA_FIXTURES) {
    const expectedPath = join(fixtures, `${stem}.expected.json`);
    const expected = JSON.parse(await readFile(expectedPath, 'utf8'));
    if (stem === 'r2018-unicode-metadata') {
      assert.ok(expected.opaqueStrings?.some((entry) => entry.value.includes('\\U+0041')),
        'The independently reopened Unicode fixture must exercise literal DXF-looking escapes.');
    }
    if (stem === 'r2018-field-object-reference') {
      assert.ok(expected.records?.some((record) => record.type === 'FIELD' &&
        record.groups.some((group) => group.code === 1 && group.value === 'AcObjProp') &&
        record.groups.some((group) => group.code === 331)),
      'The independent FIELD fixture must exercise a real object reference vector.');
    }
    const report = await validateMetadataFixture(join(vendor, 'factory/libredwg-web.js'),
      join(vendor, 'factory/libredwg-web.wasm'), join(fixtures, `${stem}.dwg`), expectedPath,
      output ? join(output, `${stem}.json`) : undefined);
    assert.equal(report.factorySha256, runtime.factorySha256);
    assert.equal(report.wasmSha256, runtime.wasmSha256);
    cases.push({ fixture: stem, fixtureSha256: report.fixtureSha256, expectedSha256: report.expectedSha256,
      nativeError: report.nativeError, writeError: report.writeError, complete: report.complete,
      recordCount: report.records.length, inventoryCount: report.inventoryCount,
      maxOutputBytes: report.maxOutputBytes, limitedOutputRejected: report.limitedOutputRejected });
    console.log(`VENDORED_METADATA_FIXTURE_OK ${stem}: ${report.records.length} independent records; decoder=0 projection=0; bounded output`);
  }
  const summary = { schemaVersion: 1, source: runtime.source, workflow: runtime.workflow,
    factorySha256: runtime.factorySha256, wasmSha256: runtime.wasmSha256, cases };
  if (output) await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('Usage: validate-vendored-metadata.mjs [REPORT_DIRECTORY]');
  await validateVendoredMetadata(process.argv[2]);
}
