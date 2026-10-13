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
/** Check a copied native projection independently of the already-correct appearance DTO. */
export function checkedBookColorProjection(metadata, expected) {
  const maximum = 32 * 1024 * 1024;
  assert.equal(metadata?.schemaVersion, 1, 'Native book-color metadata schema changed.');
  assert.equal(metadata.complete, true, 'Native book-color projection is incomplete.');
  assert.equal(metadata.writeError, 0, 'Native book-color projection failed.');
  assert.equal(typeof metadata.dxf, 'string');
  assert.ok(metadata.dxf.length > 0 && metadata.dxf.length <= maximum && !metadata.dxf.includes('\0'), 'Native book-color projection exceeds its budget or has invalid text.');
  const outputBytes = Buffer.byteLength(metadata.dxf, 'utf8');
  assert.ok(outputBytes <= maximum, 'Native book-color projection exceeds its UTF-8 budget.');
  assert.ok(Array.isArray(metadata.objects) && metadata.objects.length <= 100_000, 'Native book-color inventory is absent or excessive.');
  const inventory = metadata.objects.filter(object => object?.handle === expected.handle);
  assert.equal(inventory.length, 1, 'Native book-color source identity is missing or duplicated.');
  assert.equal(inventory[0].type, 'DBCOLOR'); assert.equal(inventory[0].dxfType, 'DBCOLOR'); assert.equal(inventory[0].supertype, 'object');
  const lines = metadata.dxf.split(/\r\n|\n|\r/); while (lines.at(-1) === '') lines.pop();
  assert.ok(lines.length % 2 === 0 && lines.length / 2 <= 2_000_000, 'Native book-color projection has incomplete or excessive group pairs.');
  const records = []; let section = '', current, closed = false;
  for (let index = 0; index < lines.length; index += 2) {
    const raw = lines[index].trim(), code = Number(raw), value = lines[index + 1];
    assert.ok(/^\d+$/.test(raw) && Number.isInteger(code) && code <= 1071, 'Native book-color projection has an invalid group code.');
    if (code === 0) {
      current = undefined;
      if (value === 'SECTION') {
        assert.ok(!section && lines[index + 2]?.trim() === '2', 'Native book-color section framing changed.');
        section = lines[index + 3]; index += 2;
      } else if (value === 'ENDSEC') { assert.ok(section, 'Native book-color projection has an unmatched ENDSEC.'); section = ''; }
      else if (value === 'EOF') { assert.ok(!section && index === lines.length - 2, 'Native book-color EOF framing changed.'); closed = true; }
      else if (section === 'OBJECTS') { current = { type: value, groups: [] }; records.push(current); }
    } else if (current) current.groups.push([code, value]);
  }
  assert.equal(closed, true, 'Native book-color projection is truncated.');
  const matches = records.filter(record => record.groups.some(([code, value]) => code === 5 && value.trim().toUpperCase() === expected.handle));
  assert.equal(matches.length, 1, 'Native book-color DXF identity is missing or duplicated.');
  const record = matches[0]; assert.equal(record.type, 'DBCOLOR', 'Native book-color source class changed.');
  const values = code => record.groups.filter(([number]) => number === code).map(([, value]) => value);
  assert.equal(values(5).length, 1, 'Native book-color has conflicting identities.');
  assert.deepEqual(values(430), [expected.name], 'Native DBCOLOR Unicode color-book projection changed.');
  const rgb = values(420); assert.equal(rgb.length, 1, 'Native book-color RGB is absent or duplicated.');
  assert.match(rgb[0].trim(), /^[+-]?\d+$/);
  const encoded = BigInt(rgb[0].trim());
  assert.ok(encoded >= -2147483648n && encoded <= 4294967295n, 'Native book-color RGB is outside its 32-bit storage.');
  assert.equal((encoded >> 24n) & 255n, 0xc2n, 'Native book-color true-color method changed.');
  assert.equal(Number(encoded & 0xffffffn), expected.rgb, 'Native book-color projection RGB changed.');
  return { schemaVersion: metadata.schemaVersion, complete: metadata.complete, writeError: metadata.writeError,
    outputBytes, inventoryCount: metadata.objects.length, handle: expected.handle, type: record.type,
    name: values(430)[0], rgb: Number(encoded & 0xffffffn), groups: record.groups };
}
/** Recheck copied compiled evidence during offline artifact acceptance. */
export function validateBookColorProjectionReport(projection, expected) {
  assert.ok(projection && typeof projection === 'object', 'Native book-color projection proof is required.');
  assert.equal(projection.type, 'DBCOLOR'); assert.equal(projection.handle, expected.handle);
  assert.ok(Number.isSafeInteger(projection.outputBytes) && projection.outputBytes > 0 && projection.outputBytes <= 32 * 1024 * 1024, 'Invalid native book-color output byte count.');
  assert.ok(Number.isSafeInteger(projection.inventoryCount) && projection.inventoryCount > 0 && projection.inventoryCount <= 100000, 'Invalid native book-color inventory count.');
  assert.ok(Array.isArray(projection.groups) && projection.groups.length > 0 && projection.groups.length <= 4096, 'Invalid native book-color record groups.');
  const groups = projection.groups.map(pair => {
    assert.ok(Array.isArray(pair) && pair.length === 2, 'Invalid native book-color group pair.');
    const [code, value] = pair;
    assert.ok(Number.isInteger(code) && code > 0 && code <= 1071 && typeof value === 'string' && value.length <= 1024 * 1024 && !/[\r\n\0]/.test(value), 'Invalid native book-color group storage.');
    return `${code}\n${value}\n`;
  }).join('');
  const dxf = `0\nSECTION\n2\nOBJECTS\n0\nDBCOLOR\n${groups}0\nENDSEC\n0\nEOF\n`;
  const checked = checkedBookColorProjection({ schemaVersion: projection.schemaVersion, complete: projection.complete,
    writeError: projection.writeError, dxf,
    objects: [{ handle: projection.handle, type: projection.type, dxfType: projection.type, supertype: 'object' }] }, expected);
  assert.ok(projection.outputBytes >= checked.outputBytes, 'Native book-color output byte count is inconsistent.');
  assert.equal(projection.name, checked.name); assert.equal(projection.rgb, checked.rgb);
  assert.deepEqual(projection.groups, checked.groups);
  return projection;
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
      let bookColorProjection;
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
        // The independent AutoCAD DXFOUT color object is 14F; a correct entity DTO
        // alone cannot detect the native exporter double-decoding UTF-8 strings.
        const expectedColor = { handle: '14F', name: 'Studio Book$Pearl Δ', rgb: 0xabcdef };
        assert.deepEqual(wanted.namedEntityByHandle['14B'], { rgb: expectedColor.rgb, name: expectedColor.name }, 'Independent named-color fixture oracle changed.');
        assert.equal(typeof module.jcad_dwg_export_metadata, 'function', 'Compiled native appearance gate requires bounded metadata projection.');
        bookColorProjection = checkedBookColorProjection(module.jcad_dwg_export_metadata(data, 32 * 1024 * 1024), expectedColor);
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
      cases.push({ kind, nativeError: read.error, fixtureSha256: sha256(bytes), expectedSha256: sha256(expectedBytes), colors, arrays, layers, ...(bookColorProjection ? { bookColorProjection } : {}) });
    } finally {
      if (data) module.dwg_free(data);
      module.FS.unlink(nativePath);
    }
  }
  const report = { schemaVersion: 1, factorySha256: sha256(await readFile(factory)), wasmSha256: sha256(wasmBytes), cases, diagnostics };
  await writeFile(resolve(output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log('NATIVE_APPEARANCE_FIXTURES_OK exact referenced/inline color, alpha, Unicode names, DBCOLOR14F raw projection and MINSERT owned attributes');
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 9) throw new Error('Usage: validate-appearance-fixture.mjs FACTORY WASM APPEARANCE_DWG APPEARANCE_EXPECTED SHIPPING_DWG SHIPPING_EXPECTED REPORT');
  await validateAppearanceFixtures(...process.argv.slice(2));
}
