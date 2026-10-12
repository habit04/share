import assert from 'node:assert/strict';
import { readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { sha256 } from './patch-source.mjs';

async function checkedFile(name, maximum) {
  const file = resolve(name), info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(file) !== file || info.size <= 0 || info.size > maximum) throw new Error(`Invalid native appearance fixture: ${name}`);
  return readFile(file);
}
export function checkedNativeColor(color) {
  assert.ok(color && typeof color === 'object', 'Native common color is absent.');
  assert.ok(Number.isSafeInteger(color.handle) && color.handle >= 0 && color.handle <= 0xffffffff, 'Native color reference is not a WASM32 pointer.');
  if (color.handle || (color.flag & 0x40)) {
    assert.equal(color.hasReference, true, 'Native referenced color was not identified.');
    assert.equal(color.referenceResolved, true, 'Native referenced color was not resolved exactly.');
  }
  assert.equal(typeof color.name, 'string');
  assert.equal(typeof color.book_name, 'string');
  assert.ok(Number.isInteger(color.alpha_type) && Number.isInteger(color.alpha), 'Native alpha fields are absent.');
  return color;
}
export function encodedNativeAlpha(color) {
  return color.alpha_type === 2 ? 0x02000000 + color.alpha : color.alpha_type === 1 ? 0x01000000 : 0;
}
function field(module, entity, name) {
  const result = module.dwg_dynapi_entity_value(entity, name);
  assert.equal(result?.success, true, `Native field is unavailable: ${name}`);
  return result.data;
}

/** Calls the compiled native getters directly; no application converter or palette inference. */
export async function validateAppearanceFixtures(factory, wasm, appearanceDwg, appearanceExpected, shippingDwg, shippingExpected, output) {
  const wasmBytes = await checkedFile(wasm, 32 * 1024 * 1024);
  await checkedFile(factory, 4 * 1024 * 1024);
  const { default: createModule } = await import(pathToFileURL(resolve(factory)).href);
  const diagnostics = [], log = (line) => { diagnostics.push(String(line).slice(0, 2048)); if (diagnostics.length > 50) diagnostics.shift(); };
  const module = await createModule({ wasmBinary: wasmBytes, print: log, printErr: log });
  const cases = [];
  for (const [kind, fixture, expected] of [['appearance', appearanceDwg, appearanceExpected], ['shipping', shippingDwg, shippingExpected]]) {
    const bytes = await checkedFile(fixture, 4 * 1024 * 1024), expectedBytes = await checkedFile(expected, 64 * 1024), wanted = JSON.parse(expectedBytes.toString('utf8'));
    assert.equal(sha256(bytes), wanted.dwgSha256, 'Native appearance DWG preimage changed.');
    const nativePath = `/native-${kind}.dwg`;
    module.FS.writeFile(nativePath, bytes);
    let data;
    try {
      const read = module.dwg_read_file(nativePath);
      data = read.data;
      assert.ok(data, 'Native appearance fixture did not return data.');
      assert.equal(read.error, 0, `Native ${kind} decoder warnings/errors: ${read.error}; ${diagnostics.join('\n')}`);
      const count = module.dwg_get_num_objects(data);
      assert.ok(Number.isInteger(count) && count > 0 && count <= 250_000, 'Native fixture object budget exceeded.');
      const colors = {}, arrays = [], layers = {};
      for (let i = 0; i < count; i++) {
        const object = module.dwg_get_object(data, i);
        const type = module.dwg_object_get_fixedtype(object), common = module.dwg_object_to_entity(object);
        if (common) {
          const handle = Number(module.dwg_object_get_handle_object(object).value).toString(16).toUpperCase();
          colors[handle] = checkedNativeColor(module.dwg_object_entity_get_color_object(common));
          if (type === 8) { // DWG_TYPE_MINSERT in the exact pinned native enum.
            const entity = module.dwg_object_to_entity_tio(object);
            const attributes = module.dwg_entity_insert_get_attribs(entity)?.data;
            assert.ok(Array.isArray(attributes), 'Native MINSERT attribute getter did not return an array.');
            assert.ok(attributes.length <= 100_000, 'Native attribute fixture budget exceeded.');
            arrays.push({ handle, columns: field(module, entity, 'num_cols'), rows: field(module, entity, 'num_rows'), columnSpacing: field(module, entity, 'col_spacing'), rowSpacing: field(module, entity, 'row_spacing'), attributes: attributes.map((attribute) => {
              assert.equal(module.dwg_object_get_fixedtype(attribute), 2, 'MINSERT child must be ATTRIB.');
              const child = module.dwg_object_to_entity_tio(attribute);
              return { tag: field(module, child, 'tag'), text: field(module, child, 'text_value') };
            }) });
          }
        } else if (type === 0x33) { // DWG_TYPE_LAYER.
          const layer = module.dwg_object_to_object_tio(object);
          layers[field(module, layer, 'name')] = field(module, layer, 'color');
        }
      }
      if (kind === 'appearance') {
        for (const [handle, value] of Object.entries(wanted.modelTransparencyByHandle)) {
          assert.ok(colors[handle], `Missing common entity ${handle}`);
          assert.equal(encodedNativeAlpha(colors[handle]), value, `${handle}: native transparency changed`);
        }
        for (const [handle, value] of Object.entries(wanted.namedEntityByHandle)) {
          const color = colors[handle];
          assert.ok(color, `Missing named entity ${handle}`);
          assert.equal(color.referenceResolved, true, 'Exact DBCOLOR reference did not resolve.');
          assert.equal((color.rgb >>> 0) & 0xffffff, value.rgb, `${handle}: native RGB changed`);
          assert.equal(color.book_name ? `${color.book_name}$${color.name}` : color.name, value.name, `${handle}: native Unicode color-book identity changed`);
        }
        assert.equal((layers.RICH?.rgb >>> 0) & 0xffffff, 0x123456, 'Native layer RGB changed.');
        assert.equal(`${layers.RICH?.book_name}$${layers.RICH?.name}`, 'Studio Book$Teal 雷', 'Native layer Unicode color-book identity changed.');
      } else {
        assert.equal(arrays.length, 1, 'Shipping MINSERT was lost or duplicated.');
        const array = arrays[0];
        for (const key of ['columns', 'rows', 'columnSpacing', 'rowSpacing']) assert.equal(array[key], wanted.array[key], `Shipping array ${key} changed.`);
        assert.deepEqual(array.attributes, wanted.array.attributes, 'Shipping MINSERT attributes changed.');
        const polyline = colors[wanted.polyline.handle];
        assert.ok(polyline, 'Shipping variable-width polyline was lost.');
        assert.equal((polyline.rgb >>> 0) & 0xffffff, wanted.polyline.rgb, 'Shipping polyline RGB changed.');
        assert.equal(encodedNativeAlpha(polyline), wanted.polyline.alpha, 'Shipping polyline transparency changed.');
      }
      cases.push({ kind, nativeError: read.error, fixtureSha256: sha256(bytes), expectedSha256: sha256(expectedBytes), colors, arrays, layers });
    } finally {
      if (data) module.dwg_free(data);
      module.FS.unlink(nativePath);
    }
  }
  const report = { schemaVersion: 1, factorySha256: sha256(await readFile(factory)), wasmSha256: sha256(wasmBytes), cases, diagnostics };
  await writeFile(resolve(output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log('NATIVE_APPEARANCE_FIXTURES_OK exact referenced/inline color, alpha, Unicode names and MINSERT owned attributes');
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 9) throw new Error('Usage: validate-appearance-fixture.mjs FACTORY WASM APPEARANCE_DWG APPEARANCE_EXPECTED SHIPPING_DWG SHIPPING_EXPECTED REPORT');
  await validateAppearanceFixtures(...process.argv.slice(2));
}
