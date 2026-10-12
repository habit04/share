import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkedReplacement, validateReplacementText, patch, pins } from './patch-source.mjs';

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
});
