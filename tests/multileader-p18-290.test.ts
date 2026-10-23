/**
 * Lane B (Hub task 7376005d) — P18 follow-up: block-content MLEADER context
 * writes 290 = 0.
 *
 * CONTEXT_DATA group 290 is the context's has-text flag. AutoCAD writes 0
 * when the mleader's content is a BLOCK and 1 when it is MTEXT. At base
 * b6cdd69 the modeled context emission (emitMLeaderContext) writes 290 = 1
 * unconditionally, so every block-content context claims text it does not
 * have. This file pins the rule:
 *   - block content  -> context preamble 290 = 0  (RED at b6cdd69)
 *   - MTEXT content  -> context preamble 290 = 1  (already true at base)
 * and pins the scope: the LEADER{ cluster's own 290 (a different flag) is
 * untouched, and group 177 / the section merge are not in play here.
 *
 * Native AutoCAD edit/reopen acceptance is a separate Windows gate and is
 * NOT claimed by these Linux/headless tests.
 */
import { describe, it, expect } from 'vitest';
import type { BlockDef, LeaderEntity } from '../src/core/entities';
import { DEFAULT_LAYERS, Drawing } from '../src/core/document';
import { readDxf, writeDxf } from '../src/io/dxf';

type Pair = readonly [number, string];
const pairsOf = (text: string): Pair[] => {
  const lines = text.split(/\r\n|\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([Number(lines[i]), lines[i + 1]!] as Pair);
  return out;
};
/** The group pairs of one top-level record (0 <kind> ... up to the next 0). */
const recordPairs = (text: string, kind: string, from = 0): Pair[] => {
  const pairs = pairsOf(text);
  const start = pairs.findIndex((p, i) => i >= from && p[0] === 0 && p[1] === kind);
  if (start < 0) return [];
  const out: Pair[] = [];
  for (let i = start + 1; i < pairs.length && pairs[i]![0] !== 0; i += 1) out.push(pairs[i]!);
  return out;
};
/** The inline CONTEXT_DATA preamble 290 (has-text) of the written MULTILEADER:
 *  the first 290 after the 300 'CONTEXT_DATA{' opener. */
const contextHasText = (text: string): string | undefined => {
  const rec = recordPairs(text, 'MULTILEADER');
  const open = rec.findIndex((p) => p[0] === 300 && p[1].trim() === 'CONTEXT_DATA{');
  if (open < 0) return undefined;
  return rec.slice(open + 1).find((p) => p[0] === 290)?.[1].trim();
};
/** The first 290 of the first LEADER{ cluster (NOT the has-text flag). */
const leaderCluster290 = (text: string): string | undefined => {
  const rec = recordPairs(text, 'MULTILEADER');
  const open = rec.findIndex((p) => p[0] === 302 && p[1].trim() === 'LEADER{');
  if (open < 0) return undefined;
  return rec.slice(open + 1).find((p) => p[0] === 290)?.[1].trim();
};

// ---------------------------------------------------------------- authored state

const tagBlock: BlockDef = {
  name: 'TAGBLOCK',
  basePoint: { x: 0, y: 0 },
  entities: [{ id: 'tb-line', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }],
  attributes: [
    { tag: 'PART', prompt: 'Part?', default: 'WIDGET', position: { x: 0, y: 0 }, height: 0.25, align: 'left' },
    { tag: 'REV', prompt: 'Rev?', default: 'A', position: { x: 0, y: -0.4 }, height: 0.25, align: 'left' },
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
      ],
    },
  },
});

const mtextMl = (): LeaderEntity => ({
  id: 'mlt1',
  layer: 'ANNO',
  color: 'ByLayer',
  type: 'leader',
  kind: 'mleader',
  vertices: [{ x: 7, y: 3 }, { x: 10, y: 5 }],
  arrow: true,
  arrowSize: 0.2,
  dogleg: { x: 0.36, y: 0 },
  text: 'PUMP P-101',
  textPosition: { x: 10.5, y: 5.2 },
  textHeight: 0.25,
  textAttachment: 1,
  textWidth: 0,
  mleader: { contentType: 'mtext', styleName: 'Standard', scaleFactor: 1, landingGap: 0.09, leaderLineType: 1 },
});

const drawingWith = (entities: LeaderEntity[], blocks: Record<string, BlockDef> = {}) =>
  new Drawing({ entities, layers: DEFAULT_LAYERS, blocks, currentLayer: '0' }).snapshot;

describe('Lane B: CONTEXT_DATA 290 (has-text) follows the content type', () => {
  it('block content writes context 290 = 0', () => {
    const out = writeDxf(drawingWith([blockMl()], { TAGBLOCK: tagBlock }));
    expect(out).toContain('\r\nMULTILEADER\r\n');
    // The block section is really there (296 signal), so this is the block path.
    expect(recordPairs(out, 'MULTILEADER').some((p) => p[0] === 296 && p[1].trim() === '1')).toBe(true);
    expect(contextHasText(out)).toBe('0');
  });

  it('block content keeps 290 = 0 across a read/write round trip, model intact', () => {
    const out1 = writeDxf(drawingWith([blockMl()], { TAGBLOCK: tagBlock }));
    const back = readDxf(out1);
    const l = back.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
    expect(l.mleader).toEqual(blockMl().mleader);
    const out2 = writeDxf(back);
    expect(contextHasText(out2)).toBe('0');
  });

  it('MTEXT content keeps context 290 = 1', () => {
    const out = writeDxf(drawingWith([mtextMl()]));
    expect(out).toContain('\r\nMULTILEADER\r\n');
    expect(contextHasText(out)).toBe('1');
  });

  it("scope pin: the LEADER{ cluster's own 290 stays 1 for block content", () => {
    const out = writeDxf(drawingWith([blockMl()], { TAGBLOCK: tagBlock }));
    expect(leaderCluster290(out)).toBe('1');
  });
});
