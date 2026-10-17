import { describe, expect, it } from 'vitest';
import { cffPdfFontFixture } from './helpers/cff-font-fixture';
import { pdfFontFixture } from './helpers/pdf-font-fixture';
import { PdfFontRegistry, writePdfFontResources, type PdfFontFace, type PdfFontObjectWriter } from '../src/io/pdf-fonts';
import { embeddableFontProgram } from '../src/io/pdf-font-subset';

/**
 * Shaped-branch CID assignment (contract §5.2/§5.3): codes are
 * per (glyph, cluster, occurrence) under the run's identity; the
 * cluster anchor carries the cluster's logical source, every
 * other occurrence the empty string, so extraction never
 * duplicates a one-to-many cluster — including a repeated GID.
 */
function objects() {
  const entries = new Map<number, string | Uint8Array[]>();
  let next = 0;
  const writer: PdfFontObjectWriter = { reserve: () => ++next, set: (id, body) => { expect(entries.has(id)).toBe(false); entries.set(id, body); } };
  const text = (id: number) => {
    const body = entries.get(id)!;
    return typeof body === 'string' ? body : body.filter((_part, index) => index !== 1).map((part) => new TextDecoder().decode(part)).join('');
  };
  const streamBytes = (id: number) => (entries.get(id)! as Uint8Array[])[1]!;
  const stream = (id: number) => new TextDecoder().decode(streamBytes(id));
  const all = () => [...entries.keys()];
  const findText = (needle: string) => all().map((id) => text(id)).find((body) => body.includes(needle));
  const findStream = (needle: string) => all().map((id) => { try { return stream(id); } catch { return ''; } }).find((body) => body.includes(needle));
  const findStreamBytes = (needle: string) => all().map((id) => { try { return stream(id).includes(needle) ? streamBytes(id) : null; } catch { return null; } }).find((body) => body !== null) ?? null;
  return { entries, writer, text, stream, findText, findStream, findStreamBytes };
}

const glyfFace = (): PdfFontFace => ({ key: 'glyf', ...pdfFontFixture({}) });

describe('shaped CID assignment (glyf)', () => {
  it('gives a repeated GID in one cluster two codes, one anchor value, one explicit empty', () => {
    const registry = new PdfFontRegistry([glyfFace()]);
    const assigned = registry.encodeShaped('glyf', 'run-1', [
      { glyph: 2, clusterStart: 0, clusterEnd: 1 },
      { glyph: 2, clusterStart: 0, clusterEnd: 1 },
    ], () => 'A');
    expect(assigned?.codes).toEqual([1, 2]);
    const out = objects();
    writePdfFontResources(registry, out.writer);
    const toUnicode = out.findStream('/CMapType 2 def')!;
    expect(toUnicode).toContain('<0001> <0041>');
    expect(toUnicode).toContain('<0002> <>');
    // Both CIDs resolve to GID 2 in the CIDToGIDMap stream.
    const cidMap = out.findStreamBytes('')!;
    void cidMap;
    const streams = [...out.entries.values()].filter((body) => Array.isArray(body)) as Uint8Array[][];
    const mapStream = streams.map((parts) => parts[1]!).find((bytes) => bytes.length === (2 + 1) * 2);
    expect(mapStream).toBeDefined();
    expect([...mapStream!]).toEqual([0, 0, 0, 2, 0, 2]);
    expect(registry.requiredVersion).toEqual([1, 5]);
  });

  it('keeps aliased clusters distinct: the same glyph in two clusters extracts as each source', () => {
    const registry = new PdfFontRegistry([glyfFace()]);
    const assigned = registry.encodeShaped('glyf', 'run-2', [
      { glyph: 2, clusterStart: 0, clusterEnd: 1 },
      { glyph: 2, clusterStart: 1, clusterEnd: 2 },
    ], (start) => (start === 0 ? 'A' : 'B'));
    expect(assigned?.codes).toEqual([1, 2]);
    const out = objects();
    writePdfFontResources(registry, out.writer);
    const toUnicode = out.findStream('/CMapType 2 def')!;
    expect(toUnicode).toContain('<0001> <0041>');
    expect(toUnicode).toContain('<0002> <0042>');
  });

  it('carries a many-to-one cluster whole on its anchor (ligature-shaped run)', () => {
    const registry = new PdfFontRegistry([glyfFace()]);
    const assigned = registry.encodeShaped('glyf', 'run-3', [
      { glyph: 4, clusterStart: 0, clusterEnd: 3 },
    ], () => 'ffi');
    expect(assigned?.codes).toEqual([1]);
    const out = objects();
    writePdfFontResources(registry, out.writer);
    expect(out.findStream('/CMapType 2 def')).toContain('<0001> <006600660069>');
  });

  it('assigns nothing when any glyph is unusable (atomic refusal)', () => {
    const registry = new PdfFontRegistry([glyfFace()]);
    expect(registry.encodeShaped('glyf', 'run-4', [
      { glyph: 2, clusterStart: 0, clusterEnd: 1 },
      { glyph: 99, clusterStart: 1, clusterEnd: 2 },
    ], () => 'A')).toBeNull();
    expect(registry.resources()).toHaveLength(0);
    // The next direct encode still receives code 1: nothing leaked.
    expect(registry.encode('glyf', 'A')?.hex).toBe('0001');
  });

  it('enforces the shared code budget over the whole face', () => {
    const registry = new PdfFontRegistry([glyfFace()]);
    const glyphs = Array.from({ length: 65535 }, (_, i) => ({ glyph: 2, clusterStart: i, clusterEnd: i + 1 }));
    expect(registry.encodeShaped('glyf', 'huge', glyphs, () => 'A')).toBeNull();
    const fits = Array.from({ length: 65534 }, (_, i) => ({ glyph: 2, clusterStart: i, clusterEnd: i + 1 }));
    expect(registry.encodeShaped('glyf', 'huge', fits, () => 'A')?.codes).toHaveLength(65534);
    // One more code, of either kind, now exceeds the budget.
    expect(registry.encodeShaped('glyf', 'one-more', [{ glyph: 2, clusterStart: 0, clusterEnd: 1 }], () => 'A')).toBeNull();
    expect(registry.encode('glyf', 'B')).toBeNull();
  });

  it('includes shaped glyphs in the subset program', () => {
    const face = glyfFace();
    const registry = new PdfFontRegistry([face]);
    registry.encodeShaped('glyf', 'run-5', [{ glyph: 3, clusterStart: 0, clusterEnd: 1 }], () => 'g');
    const out = objects();
    writePdfFontResources(registry, out.writer);
    const programs = [...out.entries.values()].filter((body) => Array.isArray(body)) as Uint8Array[][];
    const expected = embeddableFontProgram(face.bytes, new Set([3]));
    expect(programs.some((parts) => parts[1]!.length === expected.length && parts[1]!.every((byte, i) => byte === expected[i]))).toBe(true);
  });
});

describe('shaped CID assignment (CFF)', () => {
  it('maps shaped codes to CID = GID through the custom Encoding CMap', () => {
    const face: PdfFontFace = { key: 'cff', ...cffPdfFontFixture({ alias: true }) };
    const registry = new PdfFontRegistry([face]);
    const assigned = registry.encodeShaped('cff', 'run-cff', [
      { glyph: 2, clusterStart: 0, clusterEnd: 2 },
      { glyph: 2, clusterStart: 0, clusterEnd: 2 },
    ], () => 'AB');
    expect(assigned?.codes).toEqual([1, 2]);
    const out = objects();
    writePdfFontResources(registry, out.writer);
    expect(out.findStream('/CMapType 0 def')).toContain('<0001> 2\n<0002> 2');
    const toUnicode = out.findStream('/CMapType 2 def')!;
    expect(toUnicode).toContain('<0001> <00410042>');
    expect(toUnicode).toContain('<0002> <>');
    expect(registry.requiredVersion).toEqual([1, 6]);
  });
});
