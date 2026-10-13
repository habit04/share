import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { checkedReplacement, validateReplacementText, patch, pins } from './patch-source.mjs';
import { checkedNativeColor, encodedNativeAlpha } from './validate-appearance-fixture.mjs';

const before = Buffer.from('#include "binding_common.h"\nFIELD_BL (bg_fill_scale, 45);\n');
const entry = {
  path: 'controlled.c',
  gitBlob: createHash('sha1').update(`blob ${before.length}\0`).update(before).digest('hex'),
  replacements: [
    { before: '#include "binding_common.h"', after: '#include "binding_common.h"\n#include <memory>', count: 1 },
    { before: 'FIELD_BL (bg_fill_scale, 45)', after: 'FIELD_BD (bg_fill_scale, 45)', count: 1 },
  ],
};

test('checked patch accepts an insertion whose postimage contains its preimage', () => {
  const after = checkedReplacement(before, entry).toString();
  assert.equal(after, '#include "binding_common.h"\n#include <memory>\nFIELD_BD (bg_fill_scale, 45);\n');
  assert.doesNotThrow(() => validateReplacementText(after, entry));
});

test('checked patch refuses changed whole-file preimages and reapplication', () => {
  assert.throws(() => checkedReplacement(Buffer.concat([before, Buffer.from('// drift')]), entry), /Preimage mismatch/);
  assert.throws(() => checkedReplacement(checkedReplacement(before, entry), entry), /Preimage mismatch/);
});

test('checked patch refuses a wrong occurrence count before writing', () => {
  assert.throws(() => checkedReplacement(before, { ...entry, replacements: [{ ...entry.replacements[1], count: 2 }] }), /Expected 2 occurrences, found 1/);
});

test('post-autogen check refuses extra stale fields or duplicate postimages', () => {
  const after = checkedReplacement(before, entry).toString();
  assert.throws(() => validateReplacementText(after + '\nFIELD_BL (bg_fill_scale, 45);', entry), /field drift/);
  assert.throws(() => validateReplacementText(after + '\nFIELD_BD (bg_fill_scale, 45);', entry), /field drift/);
});

test('production patch covers both main and embedded fields with pinned source', () => {
  assert.equal(patch.upstream.commit, pins.source.commit);
  const header = patch.files.find((file) => file.path === 'include/dwg.h');
  const api = patch.files.find((file) => file.path === 'src/dynapi.c');
  assert.equal(header.replacements[0].count, 2);
  assert.equal(api.replacements[0].count, 2);
  assert.ok(patch.files.some((file) => file.path === 'src/dwg_spec_shared.h'));
  assert.ok(patch.files.some((file) => file.path === 'bindings/javascript/embind/binding_dynapi.cpp'));
  assert.ok(patch.files.some((file) => file.path === 'bindings/javascript/embind/binding_common.cpp'));
  assert.ok(patch.files.some((file) => file.path === 'bindings/javascript/embind/binding_ent.cpp'));
  for (const path of ['src/common_entity_data.spec', 'src/common_entity_handle_data.spec', 'src/decode.c']) {
    assert.ok(patch.files.some((file) => file.path === path), `Missing checked decoder ordering preimage: ${path}`);
  }
  const attributeRepair = patch.files.find((file) => file.path === 'src/dwg.spec').replacements.find((replacement) => replacement.before.includes('keep_duplicate_records'));
  assert.ok(attributeRepair, 'ATTRIB must not decode a DXF-only trailing byte.');
  assert.equal(attributeRepair.count, 1, 'ATTDEF retains its real second version byte.');
  assert.match(attributeRepair.after, /#ifndef IS_DECODER\n[\s\S]*FIELD_RC \(keep_duplicate_records, 0\);[\s\S]*#endif\n {2}}\n {2}COMMON_ENTITY_HANDLE_DATA;/);
  assert.match(attributeRepair.before, /FIELD_HANDLE \(style, 5, 0\); \/\/ unexpected here in DXF/, 'The replacement must bind the ATTRIB-only ending.');
});

test('native color gate refuses unresolved references and impossible pointers', () => {
  const color = { handle: 1024, flag: 0xe0, hasReference: true, referenceResolved: true, name: 'Pearl Δ', book_name: 'Studio Book', alpha_type: 2, alpha: 127 };
  assert.equal(checkedNativeColor(color), color);
  assert.equal(encodedNativeAlpha(color), 33554559);
  assert.throws(() => checkedNativeColor({ ...color, referenceResolved: false }), /not resolved exactly/);
  assert.throws(() => checkedNativeColor({ ...color, handle: 0, referenceResolved: false }), /not resolved exactly/);
  assert.throws(() => checkedNativeColor({ ...color, handle: 0x100000000 }), /WASM32/);
  assert.throws(() => checkedNativeColor({ ...color, name: null }), /string/);
  assert.equal(encodedNativeAlpha({ alpha_type: 1, alpha: 255 }), 0x01000000);
  assert.equal(encodedNativeAlpha({ alpha_type: 0, alpha: 255 }), 0);
});

test('metadata native patch uses one owned bounded stream and copied identities without output paths', () => {
  const entry = patch.files.find((file) => file.path === 'bindings/javascript/embind/binding_func.cpp');
  assert.ok(entry?.gitBlob, 'Metadata export must have a complete pinned-file preimage.');
  const after = entry.replacements.find((replacement) => replacement.after.includes('jcad_dwg_export_metadata_wrapper')).after;
  assert.match(after, /uint32_t max_bytes/);
  assert.match(after, /32u \* 1024u \* 1024u/);
  assert.match(after, /dwg->num_objects > 100000/);
  assert.match(after, /fmemopen\(buffer\.get\(\), static_cast<size_t>\(max_bytes\) \+ 1u, "w"\)/);
  assert.match(after, /fflush\(stream\)/);
  assert.match(after, /ferror\(stream\)/);
  assert.match(after, /fclose\(stream\)/);
  assert.match(after, /"%llX"/);
  assert.equal((after.match(/notes\.call<void>\("push", std::string\(/g) ?? []).length, 8);
  assert.doesNotMatch(after, /notes\.call<void>\("push", (?:"|over_limit)/);
  assert.doesNotMatch(after, /FS\.|input_filename|output_filename|reinterpret_cast<uintptr_t>\(obj/);
  const values = patch.files.find((file) => file.path === 'src/dwg_spec_shared.h').replacements.find((replacement) => replacement.after.includes('JCAD_TABLE_VALUE_BODY_FLAGS 1')).after;
  assert.match(values, /# if defined\(IS_DXF\) \|\| defined\(IS_FREE\)\n# {2}define JCAD_TABLE_VALUE_BODY_FLAGS 1/);
  assert.match(values, /# else\n# {2}define JCAD_TABLE_VALUE_BODY_FLAGS 3/);
});

test('metadata projection retains stored builtin class definitions and their actual application names', () => {
  const classes = patch.files.find(file => file.path === 'src/out_dxf.c');
  assert.ok(classes?.gitBlob, 'Class projection requires the complete pinned native-file preimage.');
  const builtins = classes.replacements.find(replacement => replacement.before.includes('// some classes are now builtin'));
  assert.ok(builtins); assert.equal(builtins.count, 1);
  assert.match(builtins.before, /ACDBPLACEHOLDER[\s\S]*LAYOUT[\s\S]*continue;/);
  assert.doesNotMatch(builtins.after, /continue|return/);
  const application = classes.replacements.find(replacement => replacement.before.includes('special-cased for DXF'));
  assert.ok(application); assert.equal(application.count, 1);
  assert.match(application.before, /SPATIAL_INDEX[\s\S]*VALUE_TFF \("AutoCAD 2000", 3\)/);
  assert.match(application.after, /VALUE_T \(dwg->dwg_class\[j\]\.appname, 3\)/);
  assert.doesNotMatch(application.after, /AutoCAD 2000|VALUE_TFF/);
});

test('native candidate upload is gated by exact color and MINSERT acceptance', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/native-dwg-background.yml', import.meta.url), 'utf8');
  assert.match(workflow, /timeout 90s node scripts\/native-dwg-build\/validate-appearance-fixture\.mjs/);
  assert.ok(workflow.indexOf('Exact native color reference and MINSERT attribute gate') > workflow.indexOf('Compile matching factory glue'));
  assert.ok(workflow.indexOf('Exact native color reference and MINSERT attribute gate') < workflow.indexOf('Package corresponding source'));
  assert.match(workflow, /r2018-portable-appearance\.dwg.*r2018-native-shipping\.dwg.*appearance-report\.json/);
});

test('metadata candidate provenance requires the independent native oracle before packaging', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/native-dwg-background.yml', import.meta.url), 'utf8');
  assert.match(workflow, /timeout 90s node scripts\/native-dwg-build\/validate-metadata-fixture\.mjs/);
  assert.ok(workflow.indexOf('Exact native VIEW FIELD and typed metadata oracle gate') > workflow.indexOf('Exact native color reference and MINSERT attribute gate'));
  assert.ok(workflow.indexOf('Exact native VIEW FIELD and typed metadata oracle gate') < workflow.indexOf('Package corresponding source'));
  assert.match(workflow, /r2018-views-fields\.dwg.*r2018-views-fields\.expected\.json.*metadata-report\.json/);
  const provenance = readFileSync(new URL('./write-provenance.mjs', import.meta.url), 'utf8');
  assert.match(provenance, /validateMetadataReport\(metadata, metadataExpected\)/);
  assert.match(provenance, /metadata\.factorySha256, fixture\.factorySha256/);
  assert.match(provenance, /metadata\.wasmSha256, fixture\.wasmSha256/);
});

test('normal CI checks the accepted native bytes against all three independent metadata fixtures', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /name: Accepted native reader matches all three independent metadata fixtures\r?\n {8}if: matrix\.node == 24\r?\n {8}run: \|/);
  assert.match(workflow, /node --test scripts\/native-dwg-build\/tooling\.test\.mjs scripts\/native-dwg-build\/metadata-tools\.test\.mjs/);
  assert.match(workflow, /node scripts\/native-dwg-build\/validate-vendored-metadata\.mjs native-metadata-output/);
  assert.match(workflow, /name: native-metadata-fixtures\r?\n {10}path: native-metadata-output\/\r?\n {10}if-no-files-found: error/);
  const gate = readFileSync(new URL('./validate-vendored-metadata.mjs', import.meta.url), 'utf8');
  for (const stem of ['r2018-views-fields', 'r2018-field-object-reference', 'r2018-unicode-metadata']) assert.ok(gate.includes(`'${stem}'`));
  assert.match(gate, /repairPolicy: 'metadata-graph'/);
  assert.doesNotMatch(gate, /execFile|spawn|build:|copyFile/);
});

test('native workflow initializes runner paths inside steps, not unavailable job env context', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/native-dwg-background.yml', import.meta.url), 'utf8');
  const jobEnv = workflow.match(/^ {4}env:\r?\n((?: {6}.*\r?\n)+)/m)?.[1];
  assert.ok(jobEnv, 'Expected explicit pinned job environment.');
  const check = (text) => {
    for (const [, expression] of text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) assert.doesNotMatch(expression, /\b(?:runner|steps|job|env)\s*\./, 'GitHub job env does not allow runtime contexts.');
  };
  check(jobEnv);
  assert.throws(() => check(jobEnv + '      NATIVE_SOURCE: ${{ runner.temp }}/native-dwg-source\n'), /runtime contexts/);
  assert.match(workflow, /printf 'NATIVE_SOURCE=%s\/native-dwg-source\\n' "\$RUNNER_TEMP" >> "\$GITHUB_ENV"/);
  assert.match(workflow, /printf 'NATIVE_SDK=%s\/native-dwg-sdk\\n' "\$RUNNER_TEMP" >> "\$GITHUB_ENV"/);
  assert.match(workflow, /printf 'NATIVE_ARTIFACT=%s\/native-dwg-artifact\\n' "\$RUNNER_TEMP" >> "\$GITHUB_ENV"/);
});

test('declaration generation uses an isolated version/integrity pin before unchanged native build', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/native-dwg-background.yml', import.meta.url), 'utf8');
  const manifest = JSON.parse(readFileSync(new URL('./declaration-tools/package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('./declaration-tools/package-lock.json', import.meta.url), 'utf8')).packages['node_modules/typescript'];
  assert.equal(manifest.dependencies.typescript, '5.7.3');
  assert.equal(pins.declarationCompiler.version, '5.7.3');
  for (const key of ['version', 'resolved', 'integrity']) assert.equal(lock[key], pins.declarationCompiler[key]);
  assert.match(lock.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  assert.match(workflow, /npm ci --prefix "\$NATIVE_DECLARATION_TOOLS" --ignore-scripts --no-audit --no-fund/);
  assert.match(workflow, /export PATH="\$NATIVE_DECLARATION_TOOLS\/node_modules\/\.bin:\$PATH"/);
  assert.match(workflow, /tsc" --outFile "\$NATIVE_DECLARATION_TOOLS\/probe\.d\.ts" --skipLibCheck --declaration --emitDeclarationOnly --allowJs/);
  assert.ok(workflow.indexOf('Install integrity-pinned declaration compiler') < workflow.indexOf('Compile matching factory glue'));
  assert.match(workflow, /npm run build:prepare && npm run build:obj && npm run build:wasm/);
});
