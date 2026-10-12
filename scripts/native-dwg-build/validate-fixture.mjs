import assert from 'node:assert/strict';
import { readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { sha256 } from './patch-source.mjs';

async function checkedFile(name, maximum) {
  const file = resolve(name), info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(file) !== file || info.size > maximum) throw new Error(`Invalid or oversized input: ${name}`);
  return readFile(file);
}

/** The known native drawing is checked directly, independently of JCad/converter fallbacks. */
export async function validateFixture(factory, wasm, fixture, expected, output) {
  const wasmBytes = await checkedFile(wasm, 32 * 1024 * 1024);
  const bytes = await checkedFile(fixture, 4 * 1024 * 1024);
  const expectedBytes = await checkedFile(expected, 64 * 1024);
  const groundTruth = JSON.parse(expectedBytes.toString('utf8'));
  assert.equal(groundTruth.masks?.length, 7, 'Ground truth must contain all seven native masks.');
  assert.equal(new Set(groundTruth.masks.map((mask) => mask.text)).size, 7, 'Ground truth text IDs must be unique.');
  await checkedFile(factory, 4 * 1024 * 1024);
  const { default: createModule } = await import(pathToFileURL(resolve(factory)).href);
  const diagnostics = [];
  const log = (line) => { diagnostics.push(String(line).slice(0, 2048)); if (diagnostics.length > 50) diagnostics.shift(); };
  const module = await createModule({ wasmBinary: wasmBytes, print: log, printErr: log });
  module.FS.writeFile('/native-background.dwg', bytes);
  let data;
  const masks = [];
  let nativeError;
  try {
    const result = module.dwg_read_file('/native-background.dwg');
    data = result.data;
    nativeError = result.error;
    assert.ok(data, 'Native reader did not return a drawing.');
    assert.equal(nativeError, 0, `Native read warnings/errors: ${nativeError}; ${diagnostics.join('\n')}`);
    const count = module.dwg_get_num_objects(data);
    assert.ok(Number.isInteger(count) && count > 0 && count <= 250_000, 'Native object count exceeds fixture budget.');
    const field = (entity, name) => {
      const value = module.dwg_dynapi_entity_value(entity, name);
      assert.equal(value?.success, true, `Cannot read native MTEXT ${name}`);
      return value.data;
    };
    for (let index = 0; index < count; index++) {
      const object = module.dwg_get_object(data, index);
      if (!object || module.dwg_object_get_fixedtype(object) !== 44) continue; // DWG_TYPE_MTEXT, pinned native enum
      const entity = module.dwg_object_to_entity_tio(object);
      const text = field(entity, 'text'), flags = field(entity, 'bg_fill_flag');
      const active = Boolean(flags & 3);
      masks.push({ text, flags, ...(active ? { scale: field(entity, 'bg_fill_scale'), color: field(entity, 'bg_fill_color'), transparency: field(entity, 'bg_fill_trans') } : {}), columnType: field(entity, 'column_type'), columnWidth: field(entity, 'column_width'), gutter: field(entity, 'gutter') });
    }
    assert.equal(masks.length, 7, 'Native MTEXT records were lost or duplicated.');
    assert.equal(new Set(masks.map((mask) => mask.text)).size, 7, 'Native text IDs were lost or duplicated.');
    for (const wanted of groundTruth.masks) {
      const actual = masks.find((mask) => mask.text === wanted.text);
      assert.ok(actual, `Missing native MTEXT ${wanted.text}`);
      assert.equal(actual.flags, wanted.flags, `${wanted.text}: native flags`);
      if (wanted.scale !== undefined) assert.ok(Number.isFinite(actual.scale) && Math.abs(actual.scale - wanted.scale) < 1e-10, `${wanted.text}: native fill scale (${actual.scale})`);
      if (wanted.color !== undefined) {
        // bit_read_CMC recomputes index by a palette lookup. Preserve a valid encoded
        // ByAci index when that lookup returns 256; retain the untouched tuple in the report.
        const encoded = (actual.color?.rgb >>> 0) & 0xffffff;
        const aci = actual.color?.method === 0xc3 && encoded > 0 && encoded < 256 ? encoded : actual.color?.index;
        assert.equal(aci, wanted.color, `${wanted.text}: native ACI identity`);
      }
      if (wanted.trueColor !== undefined) assert.equal((actual.color?.rgb >>> 0) & 0xffffff, wanted.trueColor, `${wanted.text}: native RGB bytes`);
      if (wanted.colorName !== undefined) {
        const name = actual.color?.name || '', book = actual.color?.book_name || '';
        assert.equal(book ? `${book}$${name}` : name, wanted.colorName, `${wanted.text}: native color-book identity`);
      }
      if (wanted.columns) {
        assert.equal(actual.columnType, wanted.columns.type, `${wanted.text}: native column type`);
        assert.equal(actual.columnWidth, wanted.columns.width, `${wanted.text}: native column width`);
        assert.equal(actual.gutter, wanted.columns.gutter, `${wanted.text}: native column gutter`);
      }
    }
    const columns = masks.find((mask) => mask.text === 'COLUMN ONE\\NCOLUMN TWO');
    // AutoCAD's normalized record has no native 75/48/49 column fields. Its 6/3
    // layout is JCAD_MTEXT_COLUMNS XDATA, which this raw binding does not decode.
    // Do not mistake application metadata for a native column oracle.
    assert.equal(columns.columnType, 0, 'Normalized fixture has no native columns.');
    assert.equal(columns.columnWidth, 0, 'Absent native column width must remain zero.');
    assert.equal(columns.gutter, 0, 'Absent native column gutter must remain zero.');
  } finally {
    if (data) module.dwg_free(data);
    module.FS.unlink('/native-background.dwg');
  }
  const report = { schemaVersion: 1, nativeError, fixtureSha256: sha256(bytes), expectedSha256: sha256(expectedBytes), factorySha256: sha256(await readFile(factory)), wasmSha256: sha256(wasmBytes), masks, diagnostics, columnOracle: { native: { type: 0, width: 0, gutter: 0 }, applicationXdata: 'JCAD_MTEXT_COLUMNS is present in the normalized DXF but not decoded/certified by this raw factory API' } };
  await writeFile(resolve(output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`NATIVE_BACKGROUND_FIXTURE_OK ${masks.length} masks; exact flags/scales/ACI/RGB/book/columns; error=${nativeError}`);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 5) throw new Error('Usage: validate-fixture.mjs FACTORY WASM FIXTURE EXPECTED REPORT');
  const [factory, wasm, fixture, expected, output] = args;
  await validateFixture(factory, wasm, fixture, expected, output);
}
