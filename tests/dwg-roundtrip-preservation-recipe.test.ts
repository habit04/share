import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { DWG_WRITER_PINS, exactSourcePatch, sourceHash, type SourcePatch } from '../scripts/prepare-dwg-writer.mjs';

// Byte-exact, unmodified src/io/dwg/dwg_writer.rs from the authenticated
// acadrust 0.6.4 crate (94862189cab6e282ed0433a801a216cd1a712953813284a48fa81c67223e38f6).
// Upstream MPL-2.0 attribution and the full license are retained in
// vendor/acadrust-writer/README.md and LICENSE-MPL-2.0.txt.
const original = await readFile(new URL('./fixtures/acadrust-0.6.4-dwg-writer.rs', import.meta.url));
const path = 'src/io/dwg/dwg_writer.rs';
const patch = DWG_WRITER_PINS.patches.find((entry) => entry.path === path)!;
const legacyPredicate = '            ObjectType::TableStyle(style) => !style.modern_overrides.is_empty(),';
const provenancePredicate = '            ObjectType::TableStyle(style) => !style.modern_overrides.is_empty()\r\n'
  + '                && style.raw_dxf_codes.is_none()\r\n'
  + '                && document.dwg_source_version.is_none(),';
const replacement = patch.replacements.find((entry) => entry.before === legacyPredicate)!;

describe('authenticated TABLESTYLE roundtrip-record preservation recipe', () => {
  it('replays all checked writer patches against the actual original source', () => {
    expect(DWG_WRITER_PINS.crate.version).toBe('0.6.4');
    expect(DWG_WRITER_PINS.crate.sha256).toBe('94862189cab6e282ed0433a801a216cd1a712953813284a48fa81c67223e38f6');
    expect(sourceHash(original)).toBe('4c693d9585aa5c896b55031bd88480cc9f0bf6535e3bc80a2aee3f285b98dd05');
    expect(patch.beforeSha256).toBe(sourceHash(original));
    const result = exactSourcePatch(original, patch);
    expect(sourceHash(result)).toBe('836f812383f248fff7c2c33c1a0d26ef7fb45cbae9245abdbdb13bd4ecc02e6e');
    const text = result.toString('utf8');
    expect(text.split(provenancePredicate)).toHaveLength(2);
    expect(text).not.toContain(legacyPredicate);
    // Native branch behavior is independently exercised by genuine DWG
    // encoding/reopening in the helper tests; this is source authentication.
    expect(text).toContain('ObjectType::VisualStyle(style) => style.properties.len() >= 58,');
    expect(text).toContain('entries.entries.retain(|(entry, _)| *entry != name);');
    expect(text).toContain('document.objects.remove(&child);');
  });

  it('refuses source drift before applying the actual recipe', () => {
    const altered = Buffer.from(original);
    altered[0] = altered[0]! ^ 1;
    expect(() => exactSourcePatch(altered, patch)).toThrow(/preimage mismatch/);
  });

  it.each([
    { name: 'missing source occurrence', before: legacyPredicate + ' changed' },
    { name: 'multiple source occurrences', before: '\r\n' },
    { name: 'unbounded replacement count', count: 2 },
  ])('refuses $name in the preservation replacement', (change) => {
    const altered: SourcePatch = {
      ...patch,
      replacements: patch.replacements.map((entry) => entry === replacement ? { ...entry, ...change } : entry),
    };
    expect(() => exactSourcePatch(original, altered)).toThrow(/occurrence mismatch/);
  });

  it.each(['raw_dxf_codes.is_none()', 'document.dwg_source_version.is_none()'])('refuses omission of %s', (guard) => {
    const altered: SourcePatch = {
      ...patch,
      replacements: patch.replacements.map((entry) => entry === replacement
        ? { ...entry, after: entry.after.replace(guard, 'true') } : entry),
    };
    expect(() => exactSourcePatch(original, altered)).toThrow(/postimage mismatch/);
  });
});
