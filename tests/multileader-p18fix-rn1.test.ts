/**
 * P18 PR #43 fix (3) — DEFECT R-N1 (lead's native gate at 8731e4a, RED on
 * the block-content legs): the trailing block-attribute definition index
 * (group 177) was written 0-BASED (the model's definition position), but
 * AutoCAD's numbering is 1-BASED — genuine fixture F carries 177 = 1 for
 * PART and 177 = 2 for REV. After an AutoCAD edit + DWG save the values
 * landed on the wrong ATTDEFs (PART took REV's value; user data lost),
 * while JCad's own reader — resolving by the 330 ATTDEF handle and
 * corroborating the index under either numbering — hid it completely.
 *
 * The fix: the writer emits index + 1; the reader's index-only fallback
 * (no resolvable ATTDEF handle) reads 177 as AutoCAD's 1-based ordinal
 * (0 tolerated as the first position, for hand-made 0-based files). The
 * handle path is unchanged: the handle is authoritative and the index
 * corroborates under either numbering, so older JCad files (0-based 177
 * WITH handles) read exactly as before.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BlockDef, LeaderEntity } from '../src/core/entities';
import { DEFAULT_LAYERS, Drawing } from '../src/core/document';
import { readDxf, writeDxf } from '../src/io/dxf';

const F = readFileSync(join(__dirname, 'fixtures', 'p18-mleader-annotative-block.dxf'), 'utf8');

type Pair = readonly [number, string];
const pairsOf = (text: string): Pair[] => {
  const lines = text.split(/\r\n|\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([Number(lines[i]), lines[i + 1]!] as Pair);
  return out;
};
const fromPairs = (pairs: readonly Pair[]): string => pairs.map(([c, v]) => `${c}\n${v}`).join('\n');
const recordPairs = (text: string, kind: string): Pair[] => {
  const pairs = pairsOf(text);
  const start = pairs.findIndex((p) => p[0] === 0 && p[1] === kind);
  if (start < 0) return [];
  const out: Pair[] = [];
  for (let i = start + 1; i < pairs.length && pairs[i]![0] !== 0; i += 1) out.push(pairs[i]!);
  return out;
};
/** The trailing attribute entries of a MULTILEADER record, in file order:
 *  each entry's 177 definition index paired with its 302 value. */
const trailingEntries = (text: string): Array<{ index177: string; value: string }> => {
  const groups = recordPairs(text, 'MULTILEADER');
  const at = groups.findIndex(([c]) => c === 344);
  const entries: Array<{ index177: string; value: string }> = [];
  let pending: string | undefined;
  for (const [c, v] of groups.slice(at + 1)) {
    if (c === 177) pending = v.trim();
    if (c === 302 && pending !== undefined) {
      entries.push({ index177: pending, value: v });
      pending = undefined;
    }
  }
  return entries;
};
const leaderOf = (state: ReturnType<typeof readDxf>): LeaderEntity =>
  state.entities.find((e): e is LeaderEntity => e.type === 'leader')!;

const tagBlock: BlockDef = {
  name: 'TAGBLOCK',
  basePoint: { x: 0, y: 0 },
  entities: [{ id: 'tb-line', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }],
  attributes: [
    { tag: 'PART', prompt: 'Part?', default: 'WIDGET', position: { x: 0, y: 0 }, height: 0.25, align: 'left' },
    { tag: 'REV', prompt: 'Rev?', default: 'A', position: { x: 0, y: -0.4 }, height: 0.25, align: 'left' },
    { tag: 'FINISH', prompt: 'Finish?', default: 'RAW', position: { x: 0, y: -0.8 }, height: 0.25, align: 'left' },
  ],
};
const blockMl = (): LeaderEntity => ({
  id: 'mlb1',
  layer: 'ANNO',
  color: 'ByLayer',
  type: 'leader',
  kind: 'mleader',
  vertices: [{ x: 7, y: 3 }, { x: 10, y: 5 }],
  arrow: true,
  arrowSize: 0.2,
  dogleg: { x: 0.36, y: 0 },
  textHeight: 0.25,
  mleader: {
    contentType: 'block',
    styleName: 'Standard',
    scaleFactor: 1,
    landingGap: 0.09,
    leaderLineType: 1,
    block: {
      name: 'TAGBLOCK',
      position: { x: 10.4, y: 5 },
      scale: { x: 2, y: 2 },
      rotation: 0.35,
      attributes: [
        { index: 0, tag: 'PART', value: 'GEAR-9' },
        { index: 1, tag: 'REV', value: 'C', width: 0.8 },
        { index: 2, tag: 'FINISH', value: 'ZINC' },
      ],
    },
  },
});

describe('P18 PR #43 fix (3): R-N1 — trailing 177 is AutoCAD 1-based', () => {
  it('(a) the writer emits 177 = 1..n in order for a block-content multileader with n attributes', () => {
    const state = new Drawing({ entities: [blockMl()], layers: DEFAULT_LAYERS, blocks: { TAGBLOCK: tagBlock }, currentLayer: '0' }).snapshot;
    const out = writeDxf(state);
    expect(trailingEntries(out)).toEqual([
      { index177: '1', value: 'GEAR-9' },
      { index177: '2', value: 'C' },
      { index177: '3', value: 'ZINC' },
    ]);
  });

  it("(b) fixture F round trip keeps PART and REV distinct — including under AutoCAD's 1-based reading of the written file", () => {
    const once = readDxf(F);
    expect(leaderOf(once).mleader!.block!.attributes).toEqual([
      { index: 0, tag: 'PART', value: 'P-100' },
      { index: 1, tag: 'REV', value: 'A' },
    ]);
    const written = writeDxf(once);
    // JCad's own reopen: distinct values on the right tags.
    expect(leaderOf(readDxf(written)).mleader!.block!.attributes).toEqual([
      { index: 0, tag: 'PART', value: 'P-100' },
      { index: 1, tag: 'REV', value: 'A' },
    ]);
    // AutoCAD's reading of the same bytes: value -> ATTDEF at position
    // 177 - 1 of the definition (PART, REV). This is the leg that showed
    // attrs = (A A) at the native gate.
    const defs = ['PART', 'REV'];
    const byTag = new Map(trailingEntries(written).map((e) => [defs[Number(e.index177) - 1], e.value]));
    expect(byTag.get('PART')).toBe('P-100');
    expect(byTag.get('REV')).toBe('A');
  });

  it("(c) AutoCAD's own 1-based file maps each value to the right ATTDEF — by handle, and by the 177 ordinal alone", () => {
    // Genuine fixture F (177 = 1 and 2): the handle path.
    expect(leaderOf(readDxf(F)).mleader!.block!.attributes).toEqual([
      { index: 0, tag: 'PART', value: 'P-100' },
      { index: 1, tag: 'REV', value: 'A' },
    ]);
    // The same file with the trailing 330 ATTDEF handles renumbered to
    // handles no ATTDEF in the file carries (another editor's save): the
    // entries exist but resolve by handle to nothing, so the index-only
    // fallback decides — and must read 177 as the 1-based ordinal.
    const pairs = pairsOf(F);
    const start = pairs.findIndex((p) => p[0] === 0 && p[1] === 'MULTILEADER');
    const at344 = pairs.findIndex((p, i) => i > start && p[0] === 344);
    let renumbered = 0;
    const stripped = pairs.map((p, i) => (i > at344 && p[0] === 330 ? [330, `FFF${(renumbered += 1)}`] as Pair : p));
    const s = readDxf(fromPairs(stripped));
    expect(leaderOf(s).mleader!.block!.attributes).toEqual([
      { index: 0, tag: 'PART', value: 'P-100' },
      { index: 1, tag: 'REV', value: 'A' },
    ]);
  });
});
