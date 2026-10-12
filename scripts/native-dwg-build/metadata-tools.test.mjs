import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metadataDxfRecords, validateMetadataOracle, validateMetadataReport } from './validate-metadata-fixture.mjs';

// Synthetic tokens exercise the validator boundary. They do not establish native
// DWG fidelity or replace the independently authored CAD fixture acceptance gate.
const group = (code, value) => ({ code, value: String(value) });
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
  for (const key of ['schemaVersion', 'nativeError', 'writeError', 'complete', 'maxOutputBytes', 'outputBytes', 'limitedOutputRejected', 'objects', 'inventoryCount', 'records']) {
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
