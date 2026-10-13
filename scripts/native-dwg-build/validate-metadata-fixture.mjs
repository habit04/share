import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const MAX_NATIVE_METADATA_DXF_BYTES = 32 * 1024 * 1024;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const unicode = (value) => value.replace(/\\U\+([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
const numeric = (code) => (code >= 10 && code <= 99) || (code >= 110 && code <= 149) ||
  (code >= 170 && code <= 179) || (code >= 210 && code <= 299) || (code >= 370 && code <= 389) ||
  (code >= 400 && code <= 469) || (code >= 1010 && code <= 1059) || code === 1070 || code === 1071;
const handle = (code) => (code >= 320 && code <= 369) || (code >= 390 && code <= 399) || code === 5 || code === 105 || code === 480 || code === 481 || code === 1005;

/** Independent token-level oracle: keeps string chunks and repeated reference order. */
export function metadataDxfRecords(text) {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.at(-1) === '') lines.pop();
  assert.equal(lines.length % 2, 0, 'Incomplete native DXF pair.');
  const records = [];
  let current;
  for (let index = 0; index < lines.length; index += 2) {
    const code = Number(lines[index].trim());
    assert.ok(Number.isInteger(code) && code >= 0 && code <= 1071, 'Invalid native DXF group code.');
    const value = lines[index + 1];
    if (code === 0) {
      current = { type: value.trim(), groups: [] };
      records.push(current);
      assert.ok(records.length <= 250000, 'Native DXF exceeds the record budget.');
    } else if (current) current.groups.push({ code, value });
  }
  assert.equal(records.at(-1)?.type, 'EOF', 'Native DXF is incomplete.');
  return records;
}

/** Verify the projected definitions against copied native class values, without class pointers. */
export function validateNativeClassProjection(metadata, inventory) {
  assert.ok(Array.isArray(inventory) && inventory.length <= 100000, 'Invalid native class inventory budget.');
  const definitions = metadataDxfRecords(metadata.dxf).filter(record => record.type === 'CLASS');
  assert.equal(definitions.length, inventory.length, 'The projection omitted or added native class definitions.');
  const byName = new Map();
  for (const definition of definitions) {
    const names = definition.groups.filter(group => group.code === 1);
    assert.equal(names.length, 1, 'A native class must expose one identity.');
    const name = unicode(names[0].value).trim().toUpperCase();
    assert.ok(name && !byName.has(name), 'Duplicate projected native class identity.');
    byName.set(name, definition);
  }
  const identities = new Set();
  for (const cls of inventory) {
    for (const key of ['dxfname', 'cppname', 'appname']) assert.ok(typeof cls?.[key] === 'string' && cls[key].length <= 1024 && !/[\r\n\0]/.test(cls[key]), 'Invalid copied native class name.');
    assert.ok(cls.dxfname && cls.cppname, 'A native class has incomplete names.');
    for (const [key, maximum] of [['proxyflag', 65535], ['is_zombie', 1], ['num_instances', 0xffffffff]]) assert.ok(Number.isSafeInteger(cls[key]) && cls[key] >= 0 && cls[key] <= maximum, 'Invalid copied native class flags or count.');
    assert.ok([0x1f2, 0x1f3].includes(cls.item_class_id), 'Invalid native class entity/object discriminator.');
    // DATATABLE has a specified native-to-DXF class-name spelling; no application value is replaced.
    const name = (cls.dxfname === 'DATATABLE' ? 'ACDBDATATABLE' : cls.dxfname).toUpperCase();
    assert.ok(!identities.has(name), 'Duplicate native class inventory identity.'); identities.add(name);
    const definition = byName.get(name); assert.ok(definition, `Native class ${name} is absent from the projection.`);
    for (const [code, wanted] of [[1, name], [2, cls.cppname], [3, cls.appname], [90, cls.proxyflag], [280, cls.is_zombie], [281, cls.item_class_id === 0x1f2 ? 1 : 0]]) {
      const groups = definition.groups.filter(group => group.code === code);
      assert.equal(groups.length, 1, `Native class ${name} group${code} is absent or duplicated.`);
      if ([90, 280, 281].includes(code)) assert.equal(Number(groups[0].value), wanted, `Native class ${name} group${code} changed.`);
      else assert.equal(unicode(groups[0].value), wanted, `Native class ${name} group${code} changed.`);
    }
    const counts = definition.groups.filter(group => group.code === 91);
    assert.ok(counts.length <= 1, 'Duplicate native class instance count.');
    if (counts.length) assert.equal(Number(counts[0].value), cls.num_instances, 'Native class instance count changed in projection.');
  }
  return definitions;
}

function classDxf(definitions) {
  assert.ok(Array.isArray(definitions) && definitions.length <= 100000, 'Invalid independent class definition budget.');
  return definitions.map(record => {
    assert.equal(record.type, 'CLASS'); assert.ok(Array.isArray(record.groups));
    return '0\nCLASS\n' + record.groups.map(({ code, value }) => {
      assert.ok(Number.isInteger(code) && code > 0 && code <= 1071 && typeof value === 'string' && !/[\r\n\0]/.test(value), 'Invalid class oracle group.');
      return `${code}\n${value}\n`;
    }).join('');
  }).join('') + '0\nEOF\n';
}

/** Compare every independently declared AutoCAD class; modern DXFOUT may omit builtins. */
export function validateNativeClassOracle(metadata, originalDxf) {
  const wanted = metadataDxfRecords(originalDxf).filter(record => record.type === 'CLASS');
  assert.ok(wanted.length > 0 && wanted.length <= 100000, 'The independent AutoCAD DXF has no bounded class oracle.');
  const observed = metadataDxfRecords(metadata.dxf).filter(record => record.type === 'CLASS'), byName = new Map();
  for (const record of observed) {
    const names = record.groups.filter(group => group.code === 1); assert.equal(names.length, 1);
    const name = unicode(names[0].value).trim().toUpperCase(); assert.ok(name && !byName.has(name), 'Duplicate projected class oracle identity.'); byName.set(name, record);
  }
  const seen = new Set();
  for (const original of wanted) {
    const names = original.groups.filter(group => group.code === 1); assert.equal(names.length, 1);
    const name = unicode(names[0].value).trim().toUpperCase(); assert.ok(name && !seen.has(name), 'Duplicate original AutoCAD class identity.'); seen.add(name);
    const actual = byName.get(name); assert.ok(actual, `Independent AutoCAD class ${name} is missing.`);
    const codes = new Set(original.groups.map(group => group.code));
    // Group91 is an instance counter rather than a class definition. AutoCAD
    // DXFOUT materializes TABLESTYLE's inline CELLSTYLEMAP as a separate object:
    // the Unicode oracle has cached DWG count0 but DXF count1. Keep native getter
    // versus C projection counts exact above; compare every independent schema
    // group here and separately report any cached/derived count differences.
    for (const code of codes) {
      const first = original.groups.filter(group => group.code === code), second = actual.groups.filter(group => group.code === code);
      assert.equal(second.length, first.length, `Independent AutoCAD class ${name} group${code} count changed.`);
      for (let index = 0; index < first.length; index++) {
        if ([90, 91, 280, 281].includes(code)) {
          assert.match(first[index].value.trim(), /^[+-]?\d{1,20}$/); assert.match(second[index].value.trim(), /^[+-]?\d{1,20}$/);
          if (code === 91) {
            for (const pair of [first[index], second[index]]) assert.ok(BigInt(pair.value.trim()) >= 0n && BigInt(pair.value.trim()) <= 0xffffffffn, 'Invalid class instance counter.');
          } else assert.equal(BigInt(second[index].value.trim()), BigInt(first[index].value.trim()), `Independent AutoCAD class ${name} group${code} changed.`);
        } else assert.equal(unicode(second[index].value), unicode(first[index].value), `Independent AutoCAD class ${name} group${code} changed.`);
      }
    }
    for (const pair of actual.groups) assert.ok(codes.has(pair.code), `Independent AutoCAD class ${name} gained unrecognized group${pair.code}.`);
  }
  return wanted;
}

function classCountDifferences(definitions, originals) {
  const byName = new Map(definitions.map(record => [unicode(record.groups.find(group => group.code === 1).value).trim().toUpperCase(), record]));
  return originals.flatMap(record => {
    const dxfname = unicode(record.groups.find(group => group.code === 1).value).trim().toUpperCase();
    const source = record.groups.find(group => group.code === 91), native = byName.get(dxfname)?.groups.find(group => group.code === 91);
    if (!source || !native) return [];
    const nativeCount = Number(native.value), sourceDxfCount = Number(source.value);
    return nativeCount === sourceDxfCount ? [] : [{ dxfname, nativeCount, sourceDxfCount }];
  });
}

function compareValue(code, actual, wanted) {
  if (code >= 160 && code <= 169) {
    assert.match(String(actual).trim(), /^-?\d+$/);
    assert.match(String(wanted).trim(), /^-?\d+$/);
    assert.equal(BigInt(String(actual).trim()), BigInt(String(wanted).trim()), `Metadata int64 group ${code} changed.`);
  } else if (numeric(code)) {
    const a = Number(actual), b = Number(wanted);
    assert.ok(Number.isFinite(a) && Number.isFinite(b), `Non-finite metadata group ${code}.`);
    assert.ok(Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(b)), `Metadata group ${code} changed: ${actual} != ${wanted}`);
  } else if (handle(code) || (code >= 310 && code <= 319) || code === 1004) {
    assert.equal(String(actual).trim().toUpperCase(), String(wanted).trim().toUpperCase(), `Metadata identity/binary group ${code} changed.`);
  } else assert.equal(unicode(String(actual)), unicode(String(wanted)), `Metadata string group ${code} changed.`);
}

export function validateMetadataOracle(metadata, expected) {
  assert.equal(metadata.readError, 0, 'Metadata fixture must decode without native warning bits.');
  assert.equal(metadata.writeError, 0, 'Metadata fixture must project without native write errors.');
  assert.equal(metadata.complete, true, 'Fixture contains incomplete native projection identities.');
  assert.equal(expected.schemaVersion, 1);
  assert.ok(Array.isArray(expected.records) && expected.records.some((record) => record.type === 'VIEW') && expected.records.some((record) => record.type === 'FIELD'), 'Independent oracle must exercise named VIEW and real FIELD records.');
  const records = metadataDxfRecords(metadata.dxf);
  const inventory = new Map(metadata.objects.map((object) => [object.handle, object]));
  const certified = [];
  for (const wanted of expected.records) {
    assert.match(wanted.handle, /^[1-9A-F][0-9A-F]{0,15}$/);
    assert.ok(Array.isArray(wanted.groups) && wanted.groups.length > 0);
    const nativeObject = inventory.get(wanted.handle);
    assert.ok(nativeObject, `Native source identity ${wanted.handle} missing.`);
    assert.equal(nativeObject.dxfType, wanted.type, `${wanted.handle}: native DXF class changed.`);
    const candidates = records.filter((record) => record.type === wanted.type && record.groups.some((group) => (group.code === 5 || group.code === 105) && group.value.trim().toUpperCase() === wanted.handle));
    assert.equal(candidates.length, 1, `${wanted.type} ${wanted.handle} must project exactly once.`);
    const actual = candidates[0];
    const combined = wanted.type === 'FIELD' ? [[2, 3], [301, 9]] : [];
    for (const codes of combined) {
      if (!wanted.groups.some((group) => codes.includes(group.code))) continue;
      const text = (groups) => unicode(groups.filter((group) => codes.includes(group.code)).map((group) => group.value).join(''));
      assert.equal(text(actual.groups), text(wanted.groups), `FIELD ${wanted.handle}: expression/cache string changed.`);
    }
    for (const code of new Set(wanted.groups.map((group) => group.code))) {
      if (combined.some((codes) => codes.includes(code))) continue;
      const a = actual.groups.filter((group) => group.code === code), b = wanted.groups.filter((group) => group.code === code);
      assert.equal(a.length, b.length, `${wanted.type} ${wanted.handle}: group ${code} count/order changed.`);
      for (let index = 0; index < b.length; index++) compareValue(code, a[index].value, b[index].value);
    }
    certified.push({ type: wanted.type, handle: wanted.handle, groups: actual.groups });
  }
  // Opaque XRECORD strings are not display text: literal DXF-looking escapes and
  // embedded JSON must match native .NET evidence without Unicode substitution.
  if (expected.opaqueStrings !== undefined) {
    assert.ok(Array.isArray(expected.opaqueStrings) && expected.opaqueStrings.length <= expected.records.length);
    for (const wanted of expected.opaqueStrings) {
      assert.match(wanted.handle, /^[1-9A-F][0-9A-F]{0,15}$/);
      assert.ok(Number.isInteger(wanted.code) && typeof wanted.value === 'string');
      const record = certified.find((entry) => entry.handle === wanted.handle && entry.type === 'XRECORD');
      assert.ok(record, 'Opaque string oracle requires a certified XRECORD.');
      const values = record.groups.filter((group) => group.code === wanted.code);
      assert.equal(values.length, 1, 'Opaque string oracle requires one exact group.');
      assert.equal(values[0].value, wanted.value, 'Opaque metadata string changed literal bytes.');
    }
  }
  return certified;
}

/** Verify copied report records against local ground truth without executing artifact code. */
export function validateMetadataReport(report, expected) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.nativeError, 0);
  assert.equal(report.writeError, 0);
  assert.equal(report.complete, true);
  assert.equal(report.maxOutputBytes, MAX_NATIVE_METADATA_DXF_BYTES);
  assert.ok(Number.isSafeInteger(report.outputBytes) && report.outputBytes > 0 && report.outputBytes <= MAX_NATIVE_METADATA_DXF_BYTES);
  assert.equal(report.limitedOutputRejected, true);
  assert.ok(Array.isArray(report.objects) && report.objects.length > 0 && report.objects.length <= 100000);
  assert.equal(report.inventoryCount, report.objects.length);
  const handles = new Set();
  for (const object of report.objects) {
    assert.match(object.handle, /^[1-9A-F][0-9A-F]{0,15}$/);
    assert.ok(!handles.has(object.handle), 'Duplicate native inventory identity.');
    handles.add(object.handle);
    for (const key of ['type', 'dxfType']) assert.ok(typeof object[key] === 'string' && object[key].length > 0 && object[key].length <= 256);
    assert.ok(['entity', 'object', 'unknown'].includes(object.supertype));
  }
  assert.ok(Array.isArray(report.records) && report.records.length === expected.records.length);
  const dxf = report.records.map((record) => {
    assert.ok(typeof record.type === 'string' && !/[\r\n]/.test(record.type));
    assert.ok(Array.isArray(record.groups));
    return `0\n${record.type}\n` + record.groups.map(({ code, value }) => {
      assert.ok(Number.isInteger(code) && code >= 0 && code <= 1071 && typeof value === 'string' && !/[\r\n]/.test(value));
      return `${code}\n${value}\n`;
    }).join('');
  }).join('') + '0\nEOF\n';
  assert.equal(report.classProjectionVerified, true, 'Native class projection proof is required.');
  assert.ok(Number.isSafeInteger(report.nativeClassCount) && report.nativeClassCount >= 0 && report.nativeClassCount <= 100000, 'Invalid native class count.');
  assert.equal(report.nativeClassCount, report.classInventory?.length);
  const projectedClasses = classDxf(report.classDefinitions);
  validateNativeClassProjection({ dxf: projectedClasses }, report.classInventory);
  if (expected.source?.dxfSha256 !== undefined) {
    assert.equal(expected.source.dxfHashEncoding, 'UTF-8; CRLF normalized to LF');
    assert.equal(report.sourceDxfSha256, expected.source.dxfSha256, 'Independent source DXF hash changed.');
    assert.equal(report.classOracleVerified, true, 'Independent AutoCAD class proof is required.');
    const original = validateNativeClassOracle({ dxf: projectedClasses }, classDxf(expected.classDefinitions));
    assert.equal(report.declaredClassCount, original.length, 'Independent AutoCAD class count changed.');
    const differences = classCountDifferences(report.classDefinitions, original);
    if (differences.length || report.classCountDifferences !== undefined) assert.deepEqual(report.classCountDifferences, differences, 'Independent class counter differences were not reported accurately.');
  }
  return validateMetadataOracle({ ...report, readError: report.nativeError, dxf }, expected);
}

export async function validateMetadataFixture(factory, wasmPath, fixturePath, expectedPath, output) {
  const [wasm, bytes, expectedBytes] = await Promise.all([readFile(wasmPath), readFile(fixturePath), readFile(expectedPath)]);
  const expected = JSON.parse(expectedBytes.toString('utf8'));
  assert.equal(sha256(bytes), expected.source?.dwgSha256, 'Independent metadata fixture bytes changed.');
  assert.match(expected.source?.software ?? '', /AutoCAD/);
  assert.deepEqual(expected.source?.audit, { errors: 0, fixed: 0 }, 'Independent native CAD audit must have no errors/fixes.');
  assert.match(expected.source?.dxfSha256 ?? '', /^[a-f0-9]{64}$/, 'Independent source DXF hash is required.');
  assert.equal(expected.source.dxfHashEncoding, 'UTF-8; CRLF normalized to LF');
  assert.match(fixturePath, /\.dwg$/i);
  const originalBytes = await readFile(fixturePath.replace(/\.dwg$/i, '.dxf'));
  assert.ok(originalBytes.length <= MAX_NATIVE_METADATA_DXF_BYTES, 'Independent source DXF exceeds its budget.');
  const originalDxf = originalBytes.toString('utf8').replace(/\r\n/g, '\n'), sourceDxfSha256 = sha256(Buffer.from(originalDxf));
  assert.equal(sourceDxfSha256, expected.source.dxfSha256, 'Independent source DXF hash changed.');
  assert.deepEqual(metadataDxfRecords(originalDxf).filter(record => record.type === 'CLASS'), expected.classDefinitions, 'Committed class oracle differs from its original AutoCAD DXF.');
  const diagnostics = [];
  const createModule = (await import(pathToFileURL(resolve(factory)).href)).default;
  const module = await createModule({ wasmBinary: wasm, printErr: (message) => { if (diagnostics.length < 32) diagnostics.push(String(message).slice(0, 1024)); } });
  assert.equal(typeof module.jcad_dwg_export_metadata, 'function', 'Candidate has no checked native metadata export.');
  let pointer, readError;
  try {
    module.FS.writeFile('/native-metadata.dwg', bytes);
    const read = module.dwg_read_file('/native-metadata.dwg');
    pointer = read.data;
    readError = read.error;
    assert.ok(Number.isInteger(pointer) && pointer > 0 && pointer <= 0xffffffff);
    assert.equal(readError, 0, 'Independent metadata fixture has native decoder flags.');
    const limited = module.jcad_dwg_export_metadata(pointer, 128);
    assert.ok(limited.writeError > 0 && limited.dxf === '' && limited.complete === false, 'Output cap must stop native writes without returning partial metadata.');
    const metadata = { ...module.jcad_dwg_export_metadata(pointer, MAX_NATIVE_METADATA_DXF_BYTES), readError };
    assert.equal(metadata.schemaVersion, 1);
    assert.equal(typeof metadata.dxf, 'string');
    assert.ok(Buffer.byteLength(metadata.dxf) <= MAX_NATIVE_METADATA_DXF_BYTES);
    assert.ok(Array.isArray(metadata.objects) && metadata.objects.length <= 100000);
    const handles = new Set();
    for (const object of metadata.objects) {
      assert.match(object.handle, /^[1-9A-F][0-9A-F]{0,15}$/);
      assert.ok(!handles.has(object.handle), 'Duplicate native inventory identity.');
      handles.add(object.handle);
      assert.ok(typeof object.type === 'string' && object.type.length > 0 && object.type.length <= 256);
      assert.ok(typeof object.dxfType === 'string' && object.dxfType.length > 0 && object.dxfType.length <= 256);
      assert.ok(['entity', 'object', 'unknown'].includes(object.supertype));
    }
    const records = validateMetadataOracle(metadata, expected);
    const nativeClassCount = module.dwg_get_num_classes(pointer);
    assert.ok(Number.isSafeInteger(nativeClassCount) && nativeClassCount >= 0 && nativeClassCount <= 100000, 'Native class count exceeds its budget.');
    const classInventory = Array.from({ length: nativeClassCount }, (_, index) => module.dwg_get_class(pointer, index));
    const classDefinitions = validateNativeClassProjection(metadata, classInventory);
    const originalClasses = validateNativeClassOracle(metadata, originalDxf);
    const report = { schemaVersion: 1, nativeError: readError, writeError: metadata.writeError,
      factorySha256: sha256(await readFile(factory)), wasmSha256: sha256(wasm), fixtureSha256: sha256(bytes), expectedSha256: sha256(Buffer.from(expectedBytes.toString('utf8').replace(/\r\n/g, '\n'))),
      maxOutputBytes: MAX_NATIVE_METADATA_DXF_BYTES, outputBytes: Buffer.byteLength(metadata.dxf), inventoryCount: metadata.objects.length,
      limitedOutputRejected: true, objects: metadata.objects, complete: metadata.complete, records, diagnostics,
      classProjectionVerified: true, nativeClassCount, classInventory, classDefinitions,
      classOracleVerified: true, sourceDxfSha256, declaredClassCount: originalClasses.length,
      classCountDifferences: classCountDifferences(classDefinitions, originalClasses) };
    if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    return report;
  } finally {
    if (pointer) module.dwg_free(pointer);
    if (module.FS.analyzePath('/native-metadata.dwg').exists) module.FS.unlink('/native-metadata.dwg');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [factory, wasm, fixture, expected, output] = process.argv.slice(2);
  if (!output || process.argv.length !== 7) throw new Error('Usage: validate-metadata-fixture.mjs FACTORY WASM DWG EXPECTED REPORT');
  const report = await validateMetadataFixture(factory, wasm, fixture, expected, output);
  console.log(`NATIVE_METADATA_FIXTURE_OK ${report.records.length} independent VIEW/FIELD/typed metadata records; bounded output; error=${report.nativeError}`);
}
