import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metadataDxfRecords, validateMetadataOracle, validateMetadataReport, validateNativeClassProjection, validateNativeClassOracle, validateNativeSourceScalarOracle, validateNativeTableStyleOracle, copyNativeTableStyleInventory, loadNativeDateOracle } from './validate-metadata-fixture.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Synthetic tokens exercise the validator boundary. They do not establish native
// DWG fidelity or replace the independently authored CAD fixture acceptance gate.
const group = (code, value) => ({ code, value: String(value) });

function sourceProjection(timezoneOffsetMinutes = 300) {
  const original = readFileSync(new URL('../../tests/fixtures/interchange/r2018-views-fields.dxf', import.meta.url), 'utf8');
  const records = metadataDxfRecords(original).filter(record => record.type !== 'EOF');
  const header = records.find(record => record.type === 'SECTION' && record.groups[0]?.value === 'HEADER');
  const variable = name => header.groups[header.groups.findIndex(pair => pair.code === 9 && pair.value === name) + 1];
  for (const [local, utc] of [['$TDCREATE', '$TDUCREATE'], ['$TDUPDATE', '$TDUUPDATE']]) variable(local).value = String(Number(variable(utc).value) - timezoneOffsetMinutes / 1440);
  const map = records.find(record => record.type === 'CELLSTYLEMAP'), parts = []; let start;
  map.groups.forEach((pair, index) => {
    if (pair.code === 1 && pair.value === 'TABLEFORMAT_BEGIN') start = index;
    if (pair.code === 309 && pair.value === 'CELLSTYLE_END') parts.push(map.groups.slice(start, index + 1));
  });
  const base = structuredClone(parts[0]), at = base.findIndex(pair => pair.code === 1 && pair.value === 'CELLSTYLE_BEGIN');
  base[at + 1].value = '4'; base[at + 2].value = '2'; base[at + 3].value = 'Table';
  const native = records.find(record => record.type === 'TABLESTYLE'), subclass = native.groups.findIndex(pair => pair.code === 100 && pair.value === 'AcDbTableStyle');
  // Deliberately unrelated keys prove that the validator checks copied stored keys,
  // rather than reconstructing them from the style id or display name.
  const keys = [91, 42, 7];
  native.groups = [...native.groups.slice(0, subclass), group(102, '{JCAD_TABLESTYLE_NATIVE_V1'), group(90, 0), group(91, 101), group(360, '0'), group(92, 3), ...keys.map(key => group(93, key)), group(102, '}'), group(100, 'AcDbTableStyle'), group(70, 0), group(3, 'Standard'), ...base, ...parts.flat()];
  const inventory = [{ handle: '155', unknown_rc: 0, name: 'Standard', unknown_bl1: 0, unknown_bl2: 101, cellstyle: '0', numoverrides: 3, keys,
    styles: [{ id: 4, type: 2, name: 'Table' }, { id: 1, type: 1, name: '_TITLE' }, { id: 2, type: 1, name: '_HEADER' }, { id: 3, type: 2, name: '_DATA' }] }];
  return { original, records, metadata: { dxf: dxf(records) }, inventory, timezoneOffsetMinutes };
}

test('stored DWG clocks are hash-bound and retain the independently proven Unicode post-DXF save timestamp', async () => {
  const expectedPath = fileURLToPath(new URL('../../tests/fixtures/interchange/r2018-unicode-metadata.expected.json', import.meta.url));
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8')), oracle = await loadNativeDateOracle(expectedPath, expected.source.dwgSha256);
  await assert.rejects(loadNativeDateOracle(expectedPath, '00'.repeat(32)), /clock hash is missing/);
  const original = readFileSync(expectedPath.replace(/\.expected\.json$/, '.dxf'), 'utf8');
  const records = metadataDxfRecords(original).filter(record => record.type !== 'EOF'), header = records.find(record => record.type === 'SECTION' && record.groups[0]?.value === 'HEADER');
  for (const [name, value] of Object.entries(oracle.values)) header.groups[header.groups.findIndex(pair => pair.code === 9 && pair.value === '$' + name) + 1].value = value.julian ?? value.days;
  const metadata = { dxf: dxf(records) };
  assert.throws(() => validateNativeSourceScalarOracle(metadata, original, 300), /TDUUPDATE changed/);
  const verified = validateNativeSourceScalarOracle(metadata, original, 300, oracle);
  const updated = verified.dateValues.find(pair => pair.variable === '$TDUUPDATE');
  assert.ok(Math.abs((updated.source - updated.sourceDxf) * 86400 - 181) < 0.0001);
  assert.equal(verified.dateValues.find(pair => pair.variable === '$TDINDWG').expected, 4 / 86400);
  header.groups[header.groups.findIndex(pair => pair.code === 9 && pair.value === '$TDCREATE') + 1].value = '2461368.816412960';
  assert.throws(() => validateNativeSourceScalarOracle({ dxf: dxf(records) }, original, 300, oracle), /TDCREATE changed/);
});

test('independent source scalar oracle checks UTC dates, normalized host dates, colors and all 58 visual-style selectors', () => {
  for (const offset of [0, 300, -345]) {
    const fixture = sourceProjection(offset), report = validateNativeSourceScalarOracle(fixture.metadata, fixture.original, offset);
    assert.equal(report.dateValues.length, 6); assert.equal(report.visualStyles.length, 24);
    assert.ok(report.visualStyles.every(style => style.selectors === 58));
  }
  const fixture = sourceProjection();
  const style = fixture.records.find(record => record.type === 'VISUALSTYLE'), lighting = style.groups.find(pair => pair.code === 177);
  lighting.value = '2'; fixture.metadata.dxf = dxf(fixture.records);
  assert.equal(validateNativeSourceScalarOracle(fixture.metadata, fixture.original, 300).lightingRepresentations.length, 1);
  lighting.value = '4'; fixture.metadata.dxf = dxf(fixture.records);
  assert.throws(() => validateNativeSourceScalarOracle(fixture.metadata, fixture.original, 300), /lighting representation/);
});

test('independent source scalar oracle refuses date units/underflow, ACI loss and omitted or changed visual properties', () => {
  for (const mutation of ['time-units', 'local-underflow', 'header-color', 'selector', 'boolean', 'aci', 'rgb']) {
    const fixture = sourceProjection(), header = fixture.records.find(record => record.type === 'SECTION' && record.groups[0]?.value === 'HEADER');
    const variable = name => header.groups[header.groups.findIndex(pair => pair.code === 9 && pair.value === name) + 1];
    const style = fixture.records.find(record => record.type === 'VISUALSTYLE');
    if (mutation === 'time-units') variable('$TDUCREATE').value = '2461326.046740000';
    else if (mutation === 'local-underflow') variable('$TDCREATE').value = '2461368.816412960';
    else if (mutation === 'header-color') variable('$CECOLOR').value = '0';
    else if (mutation === 'selector') style.groups.splice(style.groups.findIndex(pair => pair.code === 176), 1);
    else if (mutation === 'boolean') style.groups.find(pair => pair.code === 290).value = '2';
    else if (mutation === 'aci') style.groups.filter(pair => pair.code === 62).at(-1).value = '0';
    else style.groups.find(pair => pair.code === 420).value = '123456';
    fixture.metadata.dxf = dxf(fixture.records);
    assert.throws(() => validateNativeSourceScalarOracle(fixture.metadata, fixture.original, 300), undefined, mutation);
  }
});

test('independent TABLESTYLE oracle requires every ordered format and exact copied header/key values', () => {
  const fixture = sourceProjection();
  assert.equal(validateNativeTableStyleOracle(fixture.metadata, fixture.original, fixture.inventory)[0].styles.length, 4);
  for (const mutation of ['hidden-override', 'reversed', 'key', 'header', 'text-height', 'name', 'count']) {
    const fixture = sourceProjection(), record = fixture.records.find(record => record.type === 'TABLESTYLE');
    const begin = record.groups.findIndex(pair => pair.code === 100 && pair.value === 'AcDbTableStyle');
    if (mutation === 'hidden-override') {
      const last = record.groups.findLastIndex(pair => pair.code === 1 && pair.value === 'TABLEFORMAT_BEGIN'); record.groups.splice(last);
    } else if (mutation === 'reversed') fixture.inventory[0].styles.reverse();
    else if (mutation === 'key') record.groups.find(pair => pair.code === 93).value = '1';
    else if (mutation === 'header') record.groups.slice(0, begin).find(pair => pair.code === 91).value = '102';
    else if (mutation === 'text-height') record.groups.findLast(pair => pair.code === 144).value = '0.19';
    else if (mutation === 'name') record.groups.findLast(pair => pair.code === 300).value = '_CHANGED';
    else record.groups.slice(0, begin).find(pair => pair.code === 92).value = '2';
    fixture.metadata.dxf = dxf(fixture.records);
    assert.throws(() => validateNativeTableStyleOracle(fixture.metadata, fixture.original, fixture.inventory), undefined, mutation);
  }
});

test('typed TABLESTYLE copy bounds counts, pointer arithmetic and copied fields without persisting native pointers', () => {
  const fields = { numoverrides: 3, overrides: 10000, cellstyle: 0, unknown_rc: 255, name: 'Standard', unknown_bl1: 0, unknown_bl2: 101 };
  const module = { dwg_get_num_objects: () => 1, dwg_get_object: () => 1000, dwg_obj_get_handle_value: () => 0x155n,
    dwg_object_to_object_tio: () => 2000, dwg_dynapi_subclass_size: () => 128, dwg_dynapi_entity_field_offset: () => 32,
    dwg_dynapi_entity_value: (_pointer, name) => ({ success: true, data: fields[name] }),
    dwg_dynapi_subclass_value: (pointer, _schema, name) => ({ success: true, data: name === 'name' ? 'Copied' : name === 'key' ? pointer - 10000 + 9 : 1 }) };
  const inventory = copyNativeTableStyleInventory(module, 3000, { objects: [{ handle: '155', dxfType: 'TABLESTYLE' }] });
  assert.deepEqual(inventory[0].keys, [9, 137, 265]); assert.equal(inventory[0].unknown_rc, -1);
  assert.equal(inventory[0].styles.length, 4); assert.ok(!JSON.stringify(inventory).includes('10000'));
  for (const change of [{ numoverrides: 65 }, { overrides: 0 }, { overrides: 0xfffffff0 }, { unknown_bl2: -1 }]) {
    const original = { ...fields }; Object.assign(fields, change);
    assert.throws(() => copyNativeTableStyleInventory(module, 3000, { objects: [{ handle: '155', dxfType: 'TABLESTYLE' }] }));
    Object.assign(fields, original);
  }
});

test('class projection checks copied native builtin identities, application names and schema flags', () => {
  const inventory = [{ dxfname: 'ACDBPLACEHOLDER', cppname: 'AcDbPlaceHolder', appname: 'Oracle Δ App', proxyflag: 1024, is_zombie: 0, item_class_id: 0x1f3, num_instances: 1 },
    { dxfname: 'LAYOUT', cppname: 'AcDbLayout', appname: 'ObjectDBX Classes', proxyflag: 0, is_zombie: 0, item_class_id: 0x1f3, num_instances: 2 }];
  const records = inventory.map(cls => ({ type: 'CLASS', groups: [group(1, cls.dxfname), group(2, cls.cppname), group(3, cls.appname), group(90, cls.proxyflag), group(91, cls.num_instances), group(280, cls.is_zombie), group(281, 0)] }));
  assert.equal(validateNativeClassProjection({ dxf: dxf(records) }, inventory).length, 2);
  assert.throws(() => validateNativeClassProjection({ dxf: dxf(records.slice(1)) }, inventory), /omitted or added/);
  const changed = structuredClone(records); changed[0].groups.find(pair => pair.code === 3).value = 'ObjectDBX Classes';
  assert.throws(() => validateNativeClassProjection({ dxf: dxf(changed) }, inventory), /group3 changed/);
  changed[0] = structuredClone(records[0]); changed[0].groups.find(pair => pair.code === 90).value = '0';
  assert.throws(() => validateNativeClassProjection({ dxf: dxf(changed) }, inventory), /group90 changed/);
  changed[0] = structuredClone(records[0]); changed[0].groups.find(pair => pair.code === 91).value = '0';
  assert.throws(() => validateNativeClassProjection({ dxf: dxf(changed) }, inventory), /instance count changed/);
  assert.throws(() => validateNativeClassProjection({ dxf: dxf(records) }, [{ ...inventory[0], item_class_id: 0 }, inventory[1]]), /discriminator/);
  assert.throws(() => validateNativeClassProjection({ dxf: dxf(records) }, [{ ...inventory[0], appname: 'x\nCLASS' }, inventory[1]]), /name/);
});
test('whole independent AutoCAD class oracle catches shared native/projection scalar corruption', () => {
  const original = readFileSync(new URL('../../tests/fixtures/interchange/r2018-views-fields.dxf', import.meta.url), 'utf8');
  const definitions = metadataDxfRecords(original).filter(record => record.type === 'CLASS');
  assert.equal(validateNativeClassOracle({ dxf: dxf(definitions) }, original).length, 12);
  const inventory = definitions.map(record => {
    const value = code => record.groups.find(group => group.code === code)?.value.trim();
    return { dxfname: value(1), cppname: value(2), appname: value(3), proxyflag: Number(value(90)), is_zombie: Number(value(280)), item_class_id: Number(value(281)) ? 0x1f2 : 0x1f3, num_instances: Number(value(91)) };
  });
  const changed = structuredClone(definitions), source = changed.find(record => record.groups.some(group => group.code === 1 && group.value === 'ACDBSECTIONVIEWSTYLE'));
  source.groups.find(group => group.code === 90).value = '0';
  source.groups.find(group => group.code === 91).value = '256';
  const copied = inventory.map(cls => cls.dxfname === 'ACDBSECTIONVIEWSTYLE' ? { ...cls, proxyflag: 0, num_instances: 256 } : cls);
  assert.doesNotThrow(() => validateNativeClassProjection({ dxf: dxf(changed) }, copied), 'Two views of the same corrupted native state agree.');
  assert.throws(() => validateNativeClassOracle({ dxf: dxf(changed) }, original), /Independent AutoCAD class ACDBSECTIONVIEWSTYLE group90 changed/);
  for (const code of [2, 3, 90, 280, 281]) {
    const mutated = structuredClone(definitions), cls = mutated.at(-1), group = cls.groups.find(group => group.code === code);
    group.value = [2, 3].includes(code) ? group.value + 'changed' : String(Number(group.value) + 1);
    assert.throws(() => validateNativeClassOracle({ dxf: dxf(mutated) }, original), new RegExp(`group${code} changed`));
  }
  assert.throws(() => validateNativeClassOracle({ dxf: dxf(definitions.slice(0, -1)) }, original), /missing/);
  const cached = structuredClone(definitions);
  cached.find(record => record.groups.some(group => group.code === 1 && group.value === 'CELLSTYLEMAP')).groups.find(group => group.code === 91).value = '0';
  assert.doesNotThrow(() => validateNativeClassOracle({ dxf: dxf(cached) }, original), 'DWG cached counts and DXFOUT materialized counts do not define class behavior.');
});
const record = (type, handle, groups) => ({ type, handle, groups: [group(5, handle), ...groups] });
const mockRecords = () => [
  record('VIEW', 'A1', [
    group(2, 'Tilted Δ 雷'), group(10, '12.25'), group(20, '-8.5'),
    group(11, '0.25'), group(21, '-0.5'), group(31, '0.75'),
    group(12, '101.5'), group(22, '-202.25'), group(32, '303.75'),
    group(40, '24.5'), group(41, '48.25'), group(42, '50'),
    group(43, '-5.5'), group(44, '125.25'), group(50, '30'), group(71, '1'),
    group(110, '7.25'), group(120, '8.5'), group(130, '9.75'),
    group(111, '0.6'), group(121, '0.8'), group(131, '0.2'),
    group(112, '-0.8'), group(122, '0.6'), group(132, '-0.3'),
  ]),
  record('FIELD', 'B2', [
    group(1, 'AcExpr'), group(2, ' %<Δ '), group(3, '雷 😀 _FldIdx 0 _ObjIdx 1>% '),
    group(301, ' cached '), group(9, 'Δ 雷 😀 '),
    group(90, '2'), group(360, 'C3'), group(360, 'D4'),
    group(97, '2'), group(331, 'E5'), group(331, 'F6'),
  ]),
  record('XRECORD', 'C3', [
    group(1, ' raw Δ 雷 '), group(160, '9007199254740993'),
    group(161, '9223372036854775807'), group(162, '-9223372036854775808'),
    group(310, '00AaFf'), group(1004, 'BeEf'), group(330, 'A1'), group(340, 'B2'),
  ]),
];

function dxf(records, newline = '\n') {
  return records.flatMap(({ type, groups }) => [group(0, type), ...groups])
    .concat(group(0, 'EOF')).flatMap(({ code, value }) => [String(code), value])
    .join(newline) + newline;
}

function mockFixture() {
  const records = mockRecords();
  return {
    expected: { schemaVersion: 1, records: structuredClone(records) },
    metadata: {
      schemaVersion: 1, dxf: dxf(records),
      objects: records.map(({ type, handle }) => ({ handle, type, dxfType: type, supertype: 'object' })),
      readError: 0, writeError: 0, complete: true, notes: [],
    },
    records,
  };
}

function changeRecord(fixture, type, mutate) {
  mutate(fixture.records.find((entry) => entry.type === type));
  fixture.metadata.dxf = dxf(fixture.records);
}

function replaceGroups(entry, codes, replacement) {
  const first = entry.groups.findIndex(({ code }) => codes.includes(code));
  entry.groups = entry.groups.filter(({ code }) => !codes.includes(code));
  entry.groups.splice(first, 0, ...replacement);
}

function mockReport(fixture = mockFixture()) {
  return {
    fixture,
    report: {
      schemaVersion: 1, nativeError: 0, writeError: 0, complete: true,
      maxOutputBytes: 32 * 1024 * 1024, outputBytes: Buffer.byteLength(fixture.metadata.dxf),
      limitedOutputRejected: true, objects: structuredClone(fixture.metadata.objects),
      inventoryCount: fixture.metadata.objects.length,
      records: validateMetadataOracle(fixture.metadata, fixture.expected),
      classProjectionVerified: true, nativeClassCount: 0, classInventory: [], classDefinitions: [],
    },
  };
}

test('token parser retains Unicode, raw whitespace, chunks and repeated reference order across line endings', () => {
  const records = mockRecords();
  const wanted = records.map(({ type, groups }) => ({ type, groups })).concat({ type: 'EOF', groups: [] });
  for (const newline of ['\n', '\r\n', '\r']) {
    assert.deepEqual(metadataDxfRecords(dxf(records, newline)), wanted);
  }
  assert.deepEqual(metadataDxfRecords(dxf(records).slice(0, -1)), wanted);
});

test('oracle certifies every requested group in the synthetic VIEW, FIELD and XRECORD', () => {
  const fixture = mockFixture();
  const actual = validateMetadataOracle(fixture.metadata, fixture.expected);
  assert.deepEqual(actual, fixture.records);
  assert.deepEqual(validateMetadataReport(mockReport(fixture).report, fixture.expected), actual);
});

test('FIELD expression and cache allow equivalent raw Unicode and escape text with different chunk boundaries', () => {
  const fixture = mockFixture();
  changeRecord(fixture, 'VIEW', (entry) => {
    entry.groups.find(({ code }) => code === 2).value = 'Tilted \\U+0394 \\U+96f7';
  });
  changeRecord(fixture, 'FIELD', (entry) => {
    replaceGroups(entry, [2, 3], [group(2, ' %<\\U+03'), group(3, '94 \\U+96F7 '), group(3, '\\U+D83D\\U+DE00 _FldIdx 0 _ObjIdx 1>% ')]);
    replaceGroups(entry, [301, 9], [group(301, ' cached \\U+0394'), group(9, ' \\U+96F7 '), group(9, '\\U+D83D\\U+DE00 ')]);
  });
  const actual = validateMetadataOracle(fixture.metadata, fixture.expected);
  assert.deepEqual(actual, fixture.records);
  assert.notDeepEqual(actual, fixture.expected.records, 'Certified records must retain the observed escape/chunk representation.');
  assert.deepEqual(validateMetadataReport(mockReport(fixture).report, fixture.expected), actual);
});

test('FIELD expression/cache changes, lost whitespace and reversed chunks are refused', () => {
  for (const codes of [[2, 3], [301, 9]]) {
    for (const mutation of ['changed', 'trimmed', 'reversed']) {
      const fixture = mockFixture();
      changeRecord(fixture, 'FIELD', (entry) => {
        const chunks = entry.groups.filter(({ code }) => codes.includes(code));
        if (mutation === 'changed') chunks[0].value += '!';
        else if (mutation === 'trimmed') chunks[0].value = chunks[0].value.trim();
        else replaceGroups(entry, codes, chunks.reverse());
      });
      assert.throws(() => validateMetadataOracle(fixture.metadata, fixture.expected), /expression\/cache string changed/);
    }
  }
});

test('ordered FIELD 331 and 360 references require every original identity and exact multiplicity', () => {
  for (const code of [331, 360]) {
    for (const mutation of ['reversed', 'replaced', 'removed', 'duplicated']) {
      const fixture = mockFixture();
      changeRecord(fixture, 'FIELD', (entry) => {
        const references = entry.groups.filter((item) => item.code === code);
        if (mutation === 'reversed') references.reverse();
        else if (mutation === 'replaced') references[1].value = 'ABC';
        else if (mutation === 'removed') references.pop();
        else references.push({ ...references[0] });
        replaceGroups(entry, [code], references);
      });
      assert.throws(() => validateMetadataOracle(fixture.metadata, fixture.expected), /identity\/binary group|count\/order changed/);
    }
  }
});

test('FIELD child and object reference count fields cannot change', () => {
  for (const code of [90, 97]) {
    const fixture = mockFixture();
    changeRecord(fixture, 'FIELD', (entry) => {
      entry.groups.find((item) => item.code === code).value = '1';
    });
    assert.throws(() => validateMetadataOracle(fixture.metadata, fixture.expected), /Metadata group .* changed/);
  }
});

test('named VIEW direction, target and UCS retain all three dimensions', () => {
  for (const code of [11, 21, 31, 12, 22, 32, 110, 120, 130, 111, 121, 131, 112, 122, 132]) {
    const fixture = mockFixture();
    changeRecord(fixture, 'VIEW', (entry) => {
      entry.groups.find((item) => item.code === code).value = '0';
    });
    assert.throws(() => validateMetadataOracle(fixture.metadata, fixture.expected), new RegExp(`Metadata group ${code} changed`));
  }
});

test('named VIEW camera, clipping, dimensions and twist cannot change', () => {
  for (const code of [10, 20, 40, 41, 42, 43, 44, 50, 71]) {
    const fixture = mockFixture();
    changeRecord(fixture, 'VIEW', (entry) => {
      entry.groups.find((item) => item.code === code).value = '-999';
    });
    assert.throws(() => validateMetadataOracle(fixture.metadata, fixture.expected), new RegExp(`Metadata group ${code} changed`));
  }
});

test('numeric lexical equivalents pass while non-finite view parameters are refused', () => {
  const fixture = mockFixture();
  changeRecord(fixture, 'VIEW', (entry) => {
    entry.groups.find(({ code }) => code === 32).value = '3.0375e2';
  });
  assert.doesNotThrow(() => validateMetadataOracle(fixture.metadata, fixture.expected));
  for (const value of ['NaN', 'Infinity', '-Infinity']) {
    const invalid = mockFixture();
    changeRecord(invalid, 'VIEW', (entry) => {
      entry.groups.find(({ code }) => code === 32).value = value;
    });
    assert.throws(() => validateMetadataOracle(invalid.metadata, invalid.expected), /Non-finite metadata group 32/);
  }
});

test('XRECORD int64 values beyond Number precision require exact signed integer identity', () => {
  for (const code of [160, 161, 162]) {
    const fixture = mockFixture();
    changeRecord(fixture, 'XRECORD', (entry) => {
      const item = entry.groups.find((item) => item.code === code);
      item.value = String(BigInt(item.value) + 1n);
    });
    assert.throws(() => validateMetadataOracle(fixture.metadata, fixture.expected), new RegExp(`Metadata int64 group ${code} changed`));
  }
  for (const value of ['9007199254740993.0', '9.007199254740993e15', 'NaN']) {
    const fixture = mockFixture();
    changeRecord(fixture, 'XRECORD', (entry) => {
      entry.groups.find(({ code }) => code === 160).value = value;
    });
    assert.throws(() => validateMetadataOracle(fixture.metadata, fixture.expected));
  }
});

test('identity and binary hex normalization accepts case but refuses changed bytes or references', () => {
  const fixture = mockFixture();
  changeRecord(fixture, 'XRECORD', (entry) => {
    for (const item of entry.groups.filter(({ code }) => [5, 310, 1004, 330, 340].includes(code))) {
      item.value = ` ${item.value.toLowerCase()} `;
    }
  });
  assert.doesNotThrow(() => validateMetadataOracle(fixture.metadata, fixture.expected));
  for (const code of [310, 1004, 330, 340]) {
    const invalid = mockFixture();
    changeRecord(invalid, 'XRECORD', (entry) => {
      entry.groups.find((item) => item.code === code).value = 'FFFF';
    });
    assert.throws(() => validateMetadataOracle(invalid.metadata, invalid.expected), new RegExp(`identity/binary group ${code} changed`));
  }
});

test('ordinary XRECORD strings preserve Unicode and meaningful surrounding spaces', () => {
  const fixture = mockFixture();
  changeRecord(fixture, 'XRECORD', (entry) => {
    entry.groups.find(({ code }) => code === 1).value = ' raw \\U+0394 \\U+96F7 ';
  });
  assert.doesNotThrow(() => validateMetadataOracle(fixture.metadata, fixture.expected));
  changeRecord(fixture, 'XRECORD', (entry) => {
    entry.groups.find(({ code }) => code === 1).value = 'raw Δ 雷';
  });
  assert.throws(() => validateMetadataOracle(fixture.metadata, fixture.expected), /Metadata string group 1 changed/);
});

test('opaque XRECORD literals retain Unicode, DXF-looking escapes and JSON bytes exactly', () => {
  const fixture = mockFixture();
  const literal = 'Δ雷 literal \\U+0041 {"escaped":"\\\\U+0041","unicode":"Δ雷"}';
  changeRecord(fixture, 'XRECORD', (entry) => {
    entry.groups.find(({ code }) => code === 1).value = literal;
  });
  fixture.expected.records = structuredClone(fixture.records);
  fixture.expected.opaqueStrings = [{ handle: 'C3', code: 1, value: literal }];
  assert.doesNotThrow(() => validateMetadataOracle(fixture.metadata, fixture.expected));
  changeRecord(fixture, 'XRECORD', (entry) => {
    entry.groups.find(({ code }) => code === 1).value = literal.replace('literal \\U+0041', 'literal A');
  });
  const { opaqueStrings: _opaque, ...ordinaryOracle } = fixture.expected;
  assert.doesNotThrow(() => validateMetadataOracle(fixture.metadata, ordinaryOracle), 'Ordinary Unicode normalization alone cannot certify opaque literal content.');
  assert.throws(() => validateMetadataOracle(fixture.metadata, fixture.expected), /Opaque metadata string changed/);
});

test('native warning bits, write errors and incomplete projection are refused before certification', () => {
  for (const [key, value, message] of [
    ['readError', 1, /without native warning bits/],
    ['readError', 0x3fff, /without native warning bits/],
    ['writeError', 1, /without native write errors/],
    ['writeError', null, /without native write errors/],
    ['complete', false, /incomplete native projection identities/],
  ]) {
    const fixture = mockFixture();
    fixture.metadata[key] = value;
    assert.throws(() => validateMetadataOracle(fixture.metadata, fixture.expected), message);
  }
});

test('oracle refuses missing native inventory identities and changed DXF classes', () => {
  const missing = mockFixture();
  missing.metadata.objects = missing.metadata.objects.filter(({ handle }) => handle !== 'B2');
  assert.throws(() => validateMetadataOracle(missing.metadata, missing.expected), /Native source identity B2 missing/);
  const changed = mockFixture();
  changed.metadata.objects.find(({ handle }) => handle === 'B2').dxfType = 'FIELDLIST';
  assert.throws(() => validateMetadataOracle(changed.metadata, changed.expected), /native DXF class changed/);
});

test('each requested identity must project exactly once with the original type and handle', () => {
  for (const mutation of ['missing', 'duplicate', 'handle', 'type']) {
    const fixture = mockFixture();
    if (mutation === 'missing') fixture.records = fixture.records.filter(({ type }) => type !== 'FIELD');
    else if (mutation === 'duplicate') fixture.records.push(structuredClone(fixture.records.find(({ type }) => type === 'FIELD')));
    else if (mutation === 'handle') fixture.records.find(({ type }) => type === 'FIELD').groups[0].value = 'ABC';
    else fixture.records.find(({ type }) => type === 'FIELD').type = 'FIELDLIST';
    fixture.metadata.dxf = dxf(fixture.records);
    assert.throws(() => validateMetadataOracle(fixture.metadata, fixture.expected), /FIELD B2 must project exactly once/);
  }
});

test('oracle cannot certify a schema drift or omit its required named VIEW and FIELD coverage', () => {
  const version = mockFixture();
  version.expected.schemaVersion = 2;
  assert.throws(() => validateMetadataOracle(version.metadata, version.expected));
  for (const type of ['VIEW', 'FIELD']) {
    const fixture = mockFixture();
    fixture.expected.records = fixture.expected.records.filter((entry) => entry.type !== type);
    assert.throws(() => validateMetadataOracle(fixture.metadata, fixture.expected), /must exercise named VIEW and real FIELD/);
  }
});

test('token parser refuses missing EOF, trailing records and truncated code/value pairs', () => {
  for (const text of ['', '0\nVIEW\n5\nA1\n', '0\nEOF\n0\nVIEW\n']) {
    assert.throws(() => metadataDxfRecords(text), /Native DXF is incomplete/);
  }
  for (const text of ['0\nVIEW\n5\n', '0\nVIEW\n5\nA1\n0\n', '0\nEOF\n5\n']) {
    assert.throws(() => metadataDxfRecords(text), /Incomplete native DXF pair/);
  }
});

test('token parser refuses invalid, fractional and out-of-range group codes', () => {
  for (const code of ['invalid', '-1', '1.5', '1072', 'Infinity']) {
    assert.throws(() => metadataDxfRecords(`0\nVIEW\n${code}\nvalue\n0\nEOF\n`), /Invalid native DXF group code/);
  }
});

test('report acceptance rechecks actual captured records against the local token oracle', () => {
  const { report, fixture } = mockReport();
  assert.deepEqual(validateMetadataReport(report, fixture.expected), fixture.records);
  for (const [type, code, value] of [
    ['VIEW', 32, '0'], ['VIEW', 71, '0'], ['FIELD', 2, 'changed expression'],
    ['XRECORD', 160, '9007199254740994'], ['XRECORD', 310, '00AAFE'], ['XRECORD', 340, 'F6'],
  ]) {
    const changed = structuredClone(report);
    changed.records.find((entry) => entry.type === type).groups.find((item) => item.code === code).value = value;
    assert.throws(() => validateMetadataReport(changed, fixture.expected));
  }
  for (const code of [331, 360]) {
    const changed = structuredClone(report);
    const field = changed.records.find(({ type }) => type === 'FIELD');
    replaceGroups(field, [code], field.groups.filter((item) => item.code === code).reverse());
    assert.throws(() => validateMetadataReport(changed, fixture.expected), /identity\/binary group .* changed/);
  }
});

test('report acceptance requires native success, completeness and the exercised fixed output cap', () => {
  const { report, fixture } = mockReport();
  for (const key of ['schemaVersion', 'nativeError', 'writeError', 'complete', 'maxOutputBytes', 'outputBytes', 'limitedOutputRejected', 'objects', 'inventoryCount', 'records', 'classProjectionVerified', 'nativeClassCount', 'classInventory', 'classDefinitions']) {
    const missing = structuredClone(report);
    delete missing[key];
    assert.throws(() => validateMetadataReport(missing, fixture.expected), `Missing ${key}`);
  }
  for (const [key, value] of [
    ['schemaVersion', 2], ['nativeError', 1], ['writeError', 1], ['writeError', null],
    ['complete', false], ['limitedOutputRejected', false], ['maxOutputBytes', 16 * 1024 * 1024],
    ['outputBytes', 0], ['outputBytes', -1], ['outputBytes', 1.5], ['outputBytes', NaN],
    ['outputBytes', 32 * 1024 * 1024 + 1], ['outputBytes', Number.MAX_SAFE_INTEGER + 1],
  ]) {
    const changed = structuredClone(report);
    changed[key] = value;
    assert.throws(() => validateMetadataReport(changed, fixture.expected), `${key}=${value}`);
  }
  const boundary = { ...report, outputBytes: 32 * 1024 * 1024 };
  assert.doesNotThrow(() => validateMetadataReport(boundary, fixture.expected));
});

test('report acceptance requires an independent original class proof whenever the committed oracle includes it', async () => {
  const { report, fixture } = mockReport();
  const original = readFileSync(new URL('../../tests/fixtures/interchange/r2018-views-fields.expected.json', import.meta.url), 'utf8'), expectedClasses = JSON.parse(original);
  const expected = { ...fixture.expected, source: expectedClasses.source, classDefinitions: expectedClasses.classDefinitions };
  const definitions = structuredClone(expectedClasses.classDefinitions), inventory = definitions.map(record => {
    const value = code => record.groups.find(group => group.code === code)?.value.trim();
    return { dxfname: value(1), cppname: value(2), appname: value(3), proxyflag: Number(value(90)), is_zombie: Number(value(280)), item_class_id: Number(value(281)) ? 0x1f2 : 0x1f3, num_instances: Number(value(91)) };
  });
  const projection = sourceProjection(), nativeDateOracle = await loadNativeDateOracle(fileURLToPath(new URL('../../tests/fixtures/interchange/r2018-views-fields.expected.json', import.meta.url)), expected.source.dwgSha256);
  const scalar = validateNativeSourceScalarOracle(projection.metadata, projection.original, 300, nativeDateOracle);
  const valid = { ...report, classDefinitions: definitions, nativeClassCount: inventory.length, classInventory: inventory, classOracleVerified: true, sourceDxfSha256: expectedClasses.source.dxfSha256, declaredClassCount: definitions.length,
    sourceScalarOracleVerified: true, sourceDateOracle: nativeDateOracle, sourceTableStyleOracleVerified: true, tableStyleInventory: projection.inventory,
    sourceOracleRecords: projection.records.filter(record => ['DIMSTYLE', 'VISUALSTYLE', 'TABLESTYLE'].includes(record.type) || record.type === 'SECTION' && record.groups[0]?.value === 'HEADER'),
    sourceScalarSummary: { ...scalar, visualStyles: scalar.visualStyles.map(({ handle, selectors }) => ({ handle, selectors })) },
    sourceTableStyleSummary: validateNativeTableStyleOracle(projection.metadata, projection.original, projection.inventory) };
  assert.doesNotThrow(() => validateMetadataReport(valid, expected, projection.original, nativeDateOracle));
  assert.throws(() => validateMetadataReport(valid, expected), /original source DXF is required/);
  for (const key of ['classOracleVerified', 'sourceDxfSha256', 'declaredClassCount', 'sourceScalarOracleVerified', 'sourceDateOracle', 'sourceTableStyleOracleVerified', 'sourceOracleRecords', 'sourceScalarSummary', 'tableStyleInventory', 'sourceTableStyleSummary']) {
    const missing = { ...valid }; delete missing[key]; assert.throws(() => validateMetadataReport(missing, expected, projection.original, nativeDateOracle), `Missing ${key}`);
  }
  const changed = structuredClone(valid), cls = changed.classInventory.find(cls => cls.dxfname === 'FIELD');
  cls.proxyflag = 0;
  changed.classDefinitions.find(record => record.groups.some(group => group.code === 1 && group.value === 'FIELD')).groups.find(group => group.code === 90).value = '0';
  assert.throws(() => validateMetadataReport(changed, expected, projection.original, nativeDateOracle), /Independent AutoCAD class FIELD group90 changed/);
  const cached = structuredClone(valid);
  cached.classInventory.find(cls => cls.dxfname === 'CELLSTYLEMAP').num_instances = 0;
  cached.classDefinitions.find(record => record.groups.some(group => group.code === 1 && group.value === 'CELLSTYLEMAP')).groups.find(group => group.code === 91).value = '0';
  assert.throws(() => validateMetadataReport(cached, expected, projection.original, nativeDateOracle), /counter differences were not reported accurately/);
  cached.classCountDifferences = [{ dxfname: 'CELLSTYLEMAP', nativeCount: 0, sourceDxfCount: 1 }];
  assert.doesNotThrow(() => validateMetadataReport(cached, expected, projection.original, nativeDateOracle));
  assert.throws(() => validateMetadataReport({ ...cached, classCountDifferences: [] }, expected, projection.original, nativeDateOracle), /counter differences were not reported accurately/);
  const dishonest = structuredClone(cached); dishonest.classCountDifferences[0].sourceDxfCount = 0;
  assert.throws(() => validateMetadataReport(dishonest, expected, projection.original, nativeDateOracle), /counter differences were not reported accurately/);
  const dishonestScalar = structuredClone(valid); dishonestScalar.sourceScalarSummary.colorValues[0].actual = 0;
  assert.throws(() => validateMetadataReport(dishonestScalar, expected, projection.original, nativeDateOracle), /scalar evidence was not reported accurately/);
  const changedCaptured = structuredClone(valid), visual = changedCaptured.sourceOracleRecords.find(record => record.type === 'VISUALSTYLE');
  visual.groups.find(pair => pair.code === 290).value = '2';
  assert.throws(() => validateMetadataReport(changedCaptured, expected, projection.original, nativeDateOracle), /Metadata group 290 changed/);
});

test('report acceptance refuses missing, duplicate, malformed and inconsistent inventory identities', () => {
  const { report, fixture } = mockReport();
  const missing = structuredClone(report);
  missing.objects = missing.objects.filter(({ handle }) => handle !== 'B2');
  missing.inventoryCount = missing.objects.length;
  assert.throws(() => validateMetadataReport(missing, fixture.expected), /Native source identity B2 missing/);
  const duplicate = structuredClone(report);
  duplicate.objects.push(structuredClone(duplicate.objects[0]));
  duplicate.inventoryCount++;
  assert.throws(() => validateMetadataReport(duplicate, fixture.expected), /Duplicate native inventory identity/);
  for (const handle of ['0', '00A1', 'a1', '0xA1', '10000000000000000']) {
    const changed = structuredClone(report);
    changed.objects[0].handle = handle;
    assert.throws(() => validateMetadataReport(changed, fixture.expected));
  }
  for (const [key, value] of [['type', ''], ['type', 'X'.repeat(257)], ['dxfType', 'FIELDLIST'], ['supertype', 'pointer']]) {
    const changed = structuredClone(report);
    changed.objects[0][key] = value;
    assert.throws(() => validateMetadataReport(changed, fixture.expected));
  }
  assert.throws(() => validateMetadataReport({ ...report, inventoryCount: report.inventoryCount + 1 }, fixture.expected));
  assert.throws(() => validateMetadataReport({ ...report, objects: [], inventoryCount: 0 }, fixture.expected));
  assert.throws(() => validateMetadataReport({ ...report, objects: Array(100001).fill(report.objects[0]), inventoryCount: 100001 }, fixture.expected));
});

test('report records cannot inject DXF lines, lose identities or duplicate a projection', () => {
  const { report, fixture } = mockReport();
  for (const mutation of ['type-newline', 'value-newline', 'fractional-code', 'number-value', 'missing-identity', 'duplicate-projection', 'missing-record']) {
    const changed = structuredClone(report);
    const field = changed.records.find(({ type }) => type === 'FIELD');
    if (mutation === 'type-newline') field.type += '\n0\nEOF';
    else if (mutation === 'value-newline') field.groups[1].value += '\n0\nEOF';
    else if (mutation === 'fractional-code') field.groups[1].code = 1.5;
    else if (mutation === 'number-value') field.groups[1].value = 42;
    else if (mutation === 'missing-identity') field.groups = field.groups.filter(({ code }) => code !== 5);
    else if (mutation === 'duplicate-projection') changed.records[0] = structuredClone(field);
    else changed.records.pop();
    assert.throws(() => validateMetadataReport(changed, fixture.expected), mutation);
  }
});
