import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
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

/** Independent header/time/color and complete VISUALSTYLE property checks against AutoCAD DXF. */
export function validateNativeSourceScalarOracle(metadata, originalDxf, timezoneOffsetMinutes = new Date().getTimezoneOffset(), nativeDateOracle) {
  assert.ok(Number.isInteger(timezoneOffsetMinutes) && Math.abs(timezoneOffsetMinutes) <= 1440, 'Invalid host timezone offset.');
  const original = metadataDxfRecords(originalDxf), projected = metadataDxfRecords(metadata.dxf);
  const header = records => {
    const sections = records.filter(record => record.type === 'SECTION' && record.groups[0]?.code === 2 && record.groups[0].value.trim() === 'HEADER');
    assert.equal(sections.length, 1, 'The original/native HEADER must occur once.');
    const variables = new Map(); let variable;
    for (const pair of sections[0].groups.slice(1)) {
      if (pair.code === 9) { variable = pair.value.trim(); assert.ok(!variables.has(variable), 'Duplicate native header variable.'); variables.set(variable, []); }
      else if (variable) variables.get(variable).push(pair);
    }
    return variables;
  };
  const sourceHeader = header(original), nativeHeader = header(projected), dateValues = [], colorValues = [];
  const one = (variables, variable, code) => {
    const pairs = variables.get(variable)?.filter(pair => pair.code === code) ?? [];
    assert.equal(pairs.length, 1, `Independent HEADER ${variable} must expose one group${code}.`);
    const value = Number(pairs[0].value); assert.ok(Number.isFinite(value), `Independent HEADER ${variable} is not finite.`); return value;
  };
  const dates = new Map([['$TDUCREATE', '$TDUCREATE'], ['$TDCREATE', '$TDUCREATE'], ['$TDUUPDATE', '$TDUUPDATE'], ['$TDUPDATE', '$TDUUPDATE'], ['$TDINDWG', '$TDINDWG'], ['$TDUSRTIMER', '$TDUSRTIMER']]);
  for (const [variable, sourceVariable] of dates) {
    if (!sourceHeader.has(sourceVariable)) continue;
    const sourceDxf = one(sourceHeader, sourceVariable, 40);
    const clock = nativeDateOracle?.values?.[sourceVariable.slice(1)];
    const source = nativeDateOracle ? Number(clock?.julian ?? clock?.days) : sourceDxf;
    assert.ok(Number.isFinite(source), 'The independent stored DWG date is missing or non-finite.');
    // DWG stores UTC; the local DATE variables are derived using the host's timezone.
    // Preserve absent dates. The %.09f serialization rounds the last decimal place of a day.
    const wanted = source && variable !== sourceVariable ? source - timezoneOffsetMinutes / 1440 : source;
    const actual = one(nativeHeader, variable, 40);
    assert.ok(Math.abs(actual - wanted) <= Math.max(1e-9, 8 * Number.EPSILON * Math.max(1, Math.abs(wanted))), `Independent HEADER ${variable} changed: ${actual} != ${wanted}.`);
    dateValues.push({ variable, sourceVariable, source, ...(nativeDateOracle ? { sourceDxf } : {}), expected: wanted, actual });
  }
  for (const [variable, code] of [['$CECOLOR', 62], ['$INTERFERECOLOR', 62], ['$DIMCLRD', 70], ['$DIMCLRE', 70], ['$DIMCLRT', 70], ['$DIMTFILLCLR', 70]]) {
    if (!sourceHeader.has(variable)) continue;
    const wanted = one(sourceHeader, variable, code), actual = one(nativeHeader, variable, code);
    assert.equal(actual, wanted, `Independent HEADER ${variable} ACI changed.`); colorValues.push({ variable, code, expected: wanted, actual });
  }
  const identity = record => record.groups.find(pair => pair.code === (record.type === 'DIMSTYLE' ? 105 : 5))?.value.trim().toUpperCase();
  const matched = record => {
    const matches = projected.filter(value => value.type === record.type && identity(value) === identity(record));
    assert.equal(matches.length, 1, `Independent ${record.type} ${identity(record)} must project once.`); return matches[0];
  };
  for (const type of ['DIMSTYLE', 'VISUALSTYLE']) assert.equal(projected.filter(record => record.type === type).length,
    original.filter(record => record.type === type).length, `Independent ${type} record coverage changed.`);
  let dimstyleColors = 0; const explicitDimensionDefaults = [];
  for (const record of original.filter(value => value.type === 'DIMSTYLE')) {
    const native = matched(record);
    for (const code of [176, 177, 178]) {
      const wanted = record.groups.filter(pair => pair.code === code), actual = native.groups.filter(pair => pair.code === code);
      // DXFOUT omits the default ByBlock ACI. An explicit native default must be zero,
      // and is reported separately; declared source values remain exact.
      if (!wanted.length && actual.length === 1 && Number(actual[0].value) === 0) {
        explicitDimensionDefaults.push({ handle: identity(record), code, actual: 0 }); continue;
      }
      assert.equal(actual.length, wanted.length, `Independent DIMSTYLE ${identity(record)} group${code} count changed.`);
      wanted.forEach((pair, index) => { assert.equal(Number(actual[index].value), Number(pair.value), `Independent DIMSTYLE ${identity(record)} group${code} ACI changed.`); dimstyleColors++; });
    }
  }
  const visualStyles = [], lightingRepresentations = [];
  const visualBody = record => {
    const at = record.groups.findIndex(pair => pair.code === 100 && pair.value.trim() === 'AcDbVisualStyle');
    assert.ok(at >= 0, 'VISUALSTYLE subclass is missing.'); return record.groups.slice(at + 1);
  };
  const visualColors = pairs => pairs.flatMap((pair, index) => {
    const rgb = pair.code >= 420 && pair.code <= 429;
    if (pair.code >= 62 && pair.code <= 69 && pairs[index + 1]?.code === pair.code + 420 - 62) return [];
    if (!rgb) return [pair];
    const value = BigInt(pair.value.trim()); assert.ok(value >= -0x80000000n && value <= 0xffffffffn, 'Invalid VISUALSTYLE RGB storage.');
    const packed = value & 0xffffffffn, method = packed >> 24n;
    assert.ok(method === 0n || method === 0xc2n, 'Unsupported VISUALSTYLE RGB method.');
    return [{ code: pair.code, value: String(packed & 0xffffffn) }];
  });
  for (const record of original.filter(value => value.type === 'VISUALSTYLE')) {
    const native = matched(record), wanted = visualBody(record), observed = visualBody(native);
    assert.equal(wanted.filter(pair => pair.code === 176).length, 58, 'The original AutoCAD VISUALSTYLE must exercise all 58 property selectors.');
    assert.equal(observed.filter(pair => pair.code === 176).length, 58, `Independent VISUALSTYLE ${identity(record)} lost a property selector.`);
    const sourceLighting = wanted.filter(pair => pair.code === 177), nativeLighting = observed.filter(pair => pair.code === 177);
    assert.equal(sourceLighting.length, 1); assert.equal(nativeLighting.length, 1);
    const a = Number(sourceLighting[0].value), b = Number(nativeLighting[0].value);
    // The pinned binary encoder uses 2; its R2013+ DXF serializer materializes 3.
    assert.ok(a === b || a === 3 && b === 2, `Independent VISUALSTYLE ${identity(record)} lighting representation changed (${a} -> ${b}).`);
    if (a !== b) lightingRepresentations.push({ handle: identity(record), original: a, projected: b });
    const first = visualColors(wanted.filter(pair => pair.code !== 177)), second = visualColors(observed.filter(pair => pair.code !== 177));
    assert.equal(first.length, second.length, `Independent VISUALSTYLE ${identity(record)} property count changed.`);
    first.forEach((pair, index) => {
      assert.equal(second[index].code, pair.code, `Independent VISUALSTYLE ${identity(record)} property framing changed.`);
      compareValue(pair.code, second[index].value, pair.value);
    });
    visualStyles.push({ handle: identity(record), selectors: 58, groups: native.groups });
  }
  assert.ok(dateValues.some(value => value.variable === '$TDUCREATE') && colorValues.some(value => value.variable === '$INTERFERECOLOR') && visualStyles.length, 'Independent source scalar oracle lacks date/color/visual-style coverage.');
  return { timezoneOffsetMinutes, dateValues, colorValues, dimstyleColors, explicitDimensionDefaults, visualStyles, lightingRepresentations };
}

export async function loadNativeDateOracle(expectedPath, dwgSha256) {
  const oracle = JSON.parse(await readFile(resolve(dirname(expectedPath), 'native-dwg-date-oracle.json'), 'utf8'));
  assert.equal(oracle.schemaVersion, 1); assert.match(oracle.software, /AutoCAD/);
  assert.ok(Array.isArray(oracle.cases) && oracle.cases.length === 3, 'Invalid independent DWG clock inventory.');
  const cases = oracle.cases.filter(value => value.sourceDwgSha256 === dwgSha256);
  assert.equal(cases.length, 1, 'Independent DWG clock hash is missing or duplicated.');
  const record = cases[0]; assert.equal(record.readOnly, true); assert.equal(record.sourceAndCopyUnchanged, true);
  assert.match(record.software, /AutoCAD.*detached/);
  assert.deepEqual(Object.keys(record.values).sort(), ['TDCREATE', 'TDINDWG', 'TDUPDATE', 'TDUCREATE', 'TDUSRTIMER', 'TDUUPDATE'].sort());
  for (const [name, value] of Object.entries(record.values)) {
    assert.match(value.ticks, /^\d{1,19}$/); const ticks = BigInt(value.ticks), dayTicks = 864000000000n;
    const wanted = name === 'TDINDWG' || name === 'TDUSRTIMER' ? Number(ticks) / Number(dayTicks)
      : Number(ticks / dayTicks) + 1721426 + Number(ticks % dayTicks) / Number(dayTicks);
    const actual = Number(value.julian ?? value.days); assert.ok(Number.isFinite(actual) && Math.abs(actual - wanted) <= 1e-9, 'Independent DWG clock differs from its exact .NET ticks.');
  }
  return record;
}

function tableStyleParts(record) {
  const parts = []; let start;
  record.groups.forEach((pair, index) => {
    if (pair.code === 1 && pair.value === 'TABLEFORMAT_BEGIN') { assert.equal(start, undefined, 'Nested TABLESTYLE format.'); start = index; }
    if (pair.code === 309 && pair.value === 'CELLSTYLE_END') {
      assert.notEqual(start, undefined, 'Unmatched TABLESTYLE style ending.'); parts.push(record.groups.slice(start, index + 1)); start = undefined;
    }
  });
  assert.equal(start, undefined, 'Unterminated TABLESTYLE format.');
  return parts;
}

function tableStyleWrapper(record) {
  const starts = record.groups.flatMap((pair, index) => pair.code === 102 && pair.value === '{JCAD_TABLESTYLE_NATIVE_V1' ? [index] : []);
  assert.equal(starts.length, 1, 'TABLESTYLE must expose its typed native header once.');
  const start = starts[0], end = record.groups.findIndex((pair, index) => index > start && pair.code === 102);
  assert.ok(end > start && record.groups[end].value === '}', 'TABLESTYLE native header must have bounded braced framing.');
  assert.ok(end < record.groups.findIndex(pair => pair.code === 100 && pair.value === 'AcDbTableStyle'), 'TABLESTYLE native header must precede its subclass.');
  const pairs = record.groups.slice(start + 1, end);
  assert.deepEqual(pairs.slice(0, 4).map(pair => pair.code), [90, 91, 360, 92], 'TABLESTYLE native header scalar framing changed.');
  const integer = pair => { assert.match(pair.value.trim(), /^\d{1,10}$/); const value = Number(pair.value); assert.ok(value <= 0xffffffff); return value; };
  const count = integer(pairs[3]); assert.ok(count <= 64, 'TABLESTYLE override count exceeds its codec budget.');
  assert.equal(pairs.length, count + 4, 'TABLESTYLE header omitted or added override keys.');
  assert.ok(pairs.slice(4).every(pair => pair.code === 93), 'TABLESTYLE ordered key framing changed.');
  assert.match(pairs[2].value.trim(), /^[0-9a-f]{1,16}$/i, 'Invalid TABLESTYLE cellstyle handle.');
  return { unknown_bl1: integer(pairs[0]), unknown_bl2: integer(pairs[1]), cellstyle: pairs[2].value.trim().toUpperCase(), numoverrides: count, keys: pairs.slice(4).map(integer) };
}

/** Compare all ordered formats materialized by independent AutoCAD DXFOUT. */
export function validateNativeTableStyleOracle(metadata, originalDxf, inventory) {
  const original = metadataDxfRecords(originalDxf), projected = metadataDxfRecords(metadata.dxf);
  const source = original.filter(record => record.type === 'TABLESTYLE');
  assert.ok(source.length > 0 && Array.isArray(inventory) && inventory.length === source.length, 'TABLESTYLE source/inventory coverage changed.');
  const seen = new Set(), proofs = [];
  for (const record of source) {
    const handle = record.groups.find(pair => pair.code === 5)?.value.trim().toUpperCase();
    assert.ok(handle && !seen.has(handle), 'Duplicate original TABLESTYLE identity.'); seen.add(handle);
    const matches = projected.filter(value => value.type === 'TABLESTYLE' && value.groups.some(pair => pair.code === 5 && pair.value.trim().toUpperCase() === handle));
    assert.equal(matches.length, 1, 'TABLESTYLE must project exactly once.'); const native = matches[0];
    const copies = inventory.filter(value => value.handle === handle); assert.equal(copies.length, 1, 'TABLESTYLE typed inventory identity changed.'); const copied = copies[0];
    const wrapper = tableStyleWrapper(native), { handle: _handle, unknown_rc, name, styles, ...header } = copied;
    assert.deepEqual(wrapper, header, 'TABLESTYLE native header/ordered keys differ from typed getters.');
    assert.ok(Number.isInteger(unknown_rc) && unknown_rc >= -128 && unknown_rc <= 127 && typeof name === 'string' && !/[\r\n\0]/.test(name), 'Invalid copied TABLESTYLE byte flag/name.');
    const at = native.groups.findIndex(pair => pair.code === 100 && pair.value === 'AcDbTableStyle');
    assert.equal(Number(native.groups[at + 1]?.value), unknown_rc, 'TABLESTYLE byte flag differs from typed getter.'); assert.equal(native.groups[at + 1]?.code, 70);
    assert.equal(unicode(native.groups[at + 2]?.value), name, 'TABLESTYLE name differs from typed getter.'); assert.equal(native.groups[at + 2]?.code, 3);
    const sourceName = record.groups.find(pair => pair.code === 3)?.value; assert.equal(unicode(sourceName), name, 'Independent TABLESTYLE name changed.');
    const dictionaries = original.filter(value => value.type === 'DICTIONARY' && value.groups.some(pair => pair.code === 5 && record.groups.some(ref => ref.code === 360 && ref.value.trim().toUpperCase() === pair.value.trim().toUpperCase())));
    assert.equal(dictionaries.length, 1, 'Independent TABLESTYLE extension dictionary is missing.');
    const mapReferences = dictionaries[0].groups.filter((pair, index, groups) => [350, 360].includes(pair.code) && groups[index - 1]?.code === 3
      && ['ACAD_CELLSTYLEMAP', 'ACAD_ROUNDTRIP_2008_TABLESTYLE_CELLSTYLEMAP'].includes(groups[index - 1].value));
    assert.equal(mapReferences.length, 1, 'Independent TABLESTYLE cell-style-map dictionary reference changed.');
    const mapHandle = mapReferences[0].value.trim().toUpperCase();
    const maps = original.filter(value => value.type === 'CELLSTYLEMAP' && value.groups.some(pair => pair.code === 5 && pair.value.trim().toUpperCase() === mapHandle));
    assert.equal(maps.length, 1, 'Independent TABLESTYLE materialized cell-style map is missing.');
    const wanted = tableStyleParts(maps[0]), observed = tableStyleParts(native);
    assert.equal(wanted.length, wrapper.numoverrides, 'TABLESTYLE override count differs from the independent materialized map.');
    assert.equal(observed.length, wanted.length + 1, 'TABLESTYLE omitted or added an ordered native style.');
    assert.ok(Array.isArray(styles) && styles.length === observed.length, 'TABLESTYLE typed style inventory count changed.');
    observed.forEach((pairs, index) => {
      const begin = pairs.findIndex(pair => pair.code === 1 && pair.value === 'CELLSTYLE_BEGIN'), identity = pairs.slice(begin + 1, -1);
      assert.deepEqual(identity.map(pair => pair.code), [90, 91, 300], 'TABLESTYLE identity framing changed.');
      const style = styles[index]; assert.ok(Number.isSafeInteger(style?.id) && Number.isSafeInteger(style?.type) && typeof style?.name === 'string', 'Invalid copied TABLESTYLE style.');
      assert.deepEqual([Number(identity[0].value), Number(identity[1].value), unicode(identity[2].value)], [style.id, style.type, style.name], 'TABLESTYLE ordered style differs from typed getters.');
      if (!index) return;
      assert.equal(pairs.length, wanted[index - 1].length, 'Independent TABLESTYLE format group count changed.');
      pairs.forEach((pair, item) => { assert.equal(pair.code, wanted[index - 1][item].code, 'Independent TABLESTYLE format order changed.'); compareValue(pair.code, pair.value, wanted[index - 1][item].value); });
    });
    proofs.push({ handle, name, ...wrapper, styles });
  }
  return proofs;
}

/** Copy bounded typed header/ordered identities while the native drawing is alive. */
export function copyNativeTableStyleInventory(module, pointer, metadata) {
  const identities = new Set(metadata.objects.filter(object => object.dxfType === 'TABLESTYLE').map(object => object.handle));
  const inventory = [], count = module.dwg_get_num_objects(pointer);
  assert.ok(Number.isSafeInteger(count) && count >= 0 && count <= 100000, 'Invalid native TABLESTYLE object budget.');
  const address = value => { assert.ok(Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff, 'Invalid native TABLESTYLE pointer.'); return value; };
  const result = value => { assert.equal(value?.success, true, 'Native TABLESTYLE getter failed.'); assert.notEqual(value.data, undefined, 'Native TABLESTYLE getter omitted its value.'); return value.data; };
  const integer = value => { assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff, 'Invalid native TABLESTYLE scalar.'); return value; };
  const text = value => { assert.ok(typeof value === 'string' && value.length <= 1024 && !/[\r\n\0]/.test(value), 'Invalid native TABLESTYLE string.'); return value; };
  const size = module.dwg_dynapi_subclass_size('TABLESTYLE_CellStyle');
  assert.ok(Number.isSafeInteger(size) && size > 0 && size <= 4096, 'Invalid native TABLESTYLE element size.');
  const style = value => Object.fromEntries(['id', 'type', 'name'].map(key => {
    const data = result(module.dwg_dynapi_subclass_value(address(value), 'TABLESTYLE_CellStyle', key));
    return [key, key === 'name' ? text(data) : integer(data)];
  }));
  for (let index = 0; index < count; index++) {
    const object = address(module.dwg_get_object(pointer, index));
    const handle = module.dwg_obj_get_handle_value(object).toString(16).toUpperCase();
    if (!identities.has(handle)) continue;
    const tio = address(module.dwg_object_to_object_tio(object));
    const field = key => result(module.dwg_dynapi_entity_value(tio, key));
    const numoverrides = integer(field('numoverrides')); assert.ok(numoverrides <= 64, 'Native TABLESTYLE override count exceeds its codec budget.');
    const array = field('overrides'); assert.ok(Number.isSafeInteger(array) && array >= 0 && array <= 0xffffffff, 'Invalid native TABLESTYLE array pointer.');
    assert.ok(!numoverrides || array && array + numoverrides * size <= 0x100000000, 'Native TABLESTYLE override array range overflows.');
    const baseOffset = module.dwg_dynapi_entity_field_offset(tio, 'sty');
    assert.ok(Number.isSafeInteger(baseOffset) && baseOffset >= 0 && baseOffset <= 4096 && tio + baseOffset + size <= 0x100000000, 'Invalid native TABLESTYLE base offset.');
    const keys = [], styles = [style(tio + baseOffset)];
    for (let item = 0; item < numoverrides; item++) {
      const element = address(array + item * size);
      keys.push(integer(result(module.dwg_dynapi_subclass_value(element, 'TABLESTYLE_CellStyle', 'key')))); styles.push(style(element));
    }
    const ref = field('cellstyle'); assert.ok(Number.isSafeInteger(ref) && ref >= 0 && ref <= 0xffffffff, 'Invalid TABLESTYLE handle-reference pointer.');
    const cellstyle = ref ? module.dwg_ref_get_handle_value(ref).toString(16).toUpperCase() : '0';
    const rawByte = field('unknown_rc'); assert.ok(Number.isInteger(rawByte) && rawByte >= 0 && rawByte <= 255, 'Invalid native TABLESTYLE byte flag.');
    // The typed RC getter copies unsigned storage; FIELD_RCd projects its signed byte.
    const unknown_rc = rawByte >= 128 ? rawByte - 256 : rawByte;
    inventory.push({ handle, unknown_rc, name: text(field('name')), unknown_bl1: integer(field('unknown_bl1')), unknown_bl2: integer(field('unknown_bl2')), cellstyle, numoverrides, keys, styles });
  }
  assert.equal(inventory.length, identities.size, 'Native TABLESTYLE typed coverage changed.');
  return inventory;
}

function sourceOracleRecords(metadata) {
  return metadataDxfRecords(metadata.dxf).filter(record => ['DIMSTYLE', 'VISUALSTYLE', 'TABLESTYLE'].includes(record.type)
    || record.type === 'SECTION' && record.groups[0]?.code === 2 && record.groups[0].value.trim() === 'HEADER');
}

function sourceOracleDxf(records) {
  assert.ok(Array.isArray(records) && records.length > 0 && records.length <= 100000, 'Invalid source oracle record budget.');
  const text = records.map(record => {
    assert.ok(['SECTION', 'DIMSTYLE', 'VISUALSTYLE', 'TABLESTYLE'].includes(record.type) && Array.isArray(record.groups) && record.groups.length <= 100000, 'Invalid source oracle record.');
    return `0\n${record.type}\n` + record.groups.map(({ code, value }) => {
      assert.ok(Number.isInteger(code) && code > 0 && code <= 1071 && typeof value === 'string' && !/[\r\n\0]/.test(value), 'Invalid source oracle pair.'); return `${code}\n${value}\n`;
    }).join('');
  }).join('') + '0\nEOF\n';
  assert.ok(Buffer.byteLength(text) <= MAX_NATIVE_METADATA_DXF_BYTES, 'Source oracle report exceeds its byte budget.'); return text;
}

function scalarSummary(scalar) {
  return { ...scalar, visualStyles: scalar.visualStyles.map(({ handle, selectors }) => ({ handle, selectors })) };
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
export function validateMetadataReport(report, expected, originalDxf, nativeDateOracle) {
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
    assert.ok(typeof originalDxf === 'string' && Buffer.byteLength(originalDxf) <= MAX_NATIVE_METADATA_DXF_BYTES, 'The independent original source DXF is required for offline scalar/style verification.');
    assert.equal(sha256(Buffer.from(originalDxf.replace(/\r\n/g, '\n'))), expected.source.dxfSha256, 'Offline independent source DXF hash changed.');
    assert.equal(report.sourceScalarOracleVerified, true, 'Independent native date/color/VISUALSTYLE proof is required.');
    assert.equal(report.sourceTableStyleOracleVerified, true, 'Independent ordered TABLESTYLE proof is required.');
    const captured = { dxf: sourceOracleDxf(report.sourceOracleRecords) };
    assert.equal(nativeDateOracle?.sourceDwgSha256, expected.source.dwgSha256, 'Independent stored DWG clock proof is required.');
    assert.deepEqual(report.sourceDateOracle, nativeDateOracle, 'Independent stored DWG clock evidence changed.');
    const scalar = validateNativeSourceScalarOracle(captured, originalDxf, report.sourceScalarSummary?.timezoneOffsetMinutes, nativeDateOracle);
    assert.deepEqual(report.sourceScalarSummary, scalarSummary(scalar), 'Independent source scalar evidence was not reported accurately.');
    const styles = validateNativeTableStyleOracle(captured, originalDxf, report.tableStyleInventory);
    assert.deepEqual(report.sourceTableStyleSummary, styles, 'Independent TABLESTYLE evidence was not reported accurately.');
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
    const sourceDateOracle = await loadNativeDateOracle(expectedPath, expected.source.dwgSha256);
    const scalar = validateNativeSourceScalarOracle(metadata, originalDxf, undefined, sourceDateOracle);
    const tableStyleInventory = copyNativeTableStyleInventory(module, pointer, metadata);
    const styles = validateNativeTableStyleOracle(metadata, originalDxf, tableStyleInventory);
    const report = { schemaVersion: 1, nativeError: readError, writeError: metadata.writeError,
      factorySha256: sha256(await readFile(factory)), wasmSha256: sha256(wasm), fixtureSha256: sha256(bytes), expectedSha256: sha256(Buffer.from(expectedBytes.toString('utf8').replace(/\r\n/g, '\n'))),
      maxOutputBytes: MAX_NATIVE_METADATA_DXF_BYTES, outputBytes: Buffer.byteLength(metadata.dxf), inventoryCount: metadata.objects.length,
      limitedOutputRejected: true, objects: metadata.objects, complete: metadata.complete, records, diagnostics,
      classProjectionVerified: true, nativeClassCount, classInventory, classDefinitions,
      classOracleVerified: true, sourceDxfSha256, declaredClassCount: originalClasses.length,
      classCountDifferences: classCountDifferences(classDefinitions, originalClasses),
      sourceScalarOracleVerified: true, sourceDateOracle, sourceOracleRecords: sourceOracleRecords(metadata), sourceScalarSummary: scalarSummary(scalar),
      sourceTableStyleOracleVerified: true, tableStyleInventory, sourceTableStyleSummary: styles };
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
