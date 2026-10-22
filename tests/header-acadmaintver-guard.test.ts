/**
 * P22 COMP-N Series 3 (lead ruling, 2026-10-21): the retained $ACADMAINTVER header
 * variable passes through on write ONLY when its (version, group code) pair is the
 * valid one for the written $ACADVER (AC1015 -> group 70; AC1018 and later ->
 * group 90) AND the written $ACADVER equals the source's. Anything else is omitted:
 * the synthetic interchange fixtures' 70/105 at AC1032 is a pair AutoCAD 2027
 * refuses outright. The value itself is never judged.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDxf, writeDxf } from '../src/io/dxf';
import { decodeDxfBytes } from '../src/io/encoding';

type Pair = [number, string];

function pairs(text: string): Pair[] {
  const lines = text.split(/\r?\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([Number(lines[i]), lines[i + 1]!]);
  return out;
}

/** The [code, trimmed value] group carrying $ACADMAINTVER in the HEADER, or undefined. */
function maintVerOf(text: string): Pair | undefined {
  const ps = pairs(text);
  const at = ps.findIndex(([c, v]) => c === 9 && v.trim() === '$ACADMAINTVER');
  const group = at >= 0 ? ps[at + 1] : undefined;
  return group ? [group[0], group[1].trim()] : undefined;
}

const fixture = (rel: string) => decodeDxfBytes(readFileSync(join(import.meta.dirname, rel))).text;

describe('P22 COMP-N Series 3: the $ACADMAINTVER guard', () => {
  it('a source header carrying 70/105 paired with AC1032 is NOT emitted on write', () => {
    const source = fixture('fixtures/interchange/r2018-table.dxf');
    expect(maintVerOf(source)).toEqual([70, '105']);
    const written = writeDxf(readDxf(source));
    expect(written).toContain('AC1032');
    expect(maintVerOf(written)).toBeUndefined();
  });

  it('a genuine AC1015 pair (70) passes through untouched', () => {
    const written = writeDxf(readDxf(fixture('fixtures/interchange/r2000-dimensions.dxf')));
    expect(maintVerOf(written)).toEqual([70, '20']);
  });

  it('a genuine AC1032 pair (90) passes through untouched', () => {
    const written = writeDxf(readDxf(fixture('fixtures/interchange/r2018-table-autocad.dxf')));
    expect(maintVerOf(written)).toEqual([90, '427']);
  });

  it('a valid pair is still dropped when the written version moves off the source version', () => {
    // The genuine control relabelled AC1027 (its first AC1032 is the $ACADVER
    // value): (AC1027, 90) is a valid pair and 90 would be valid at AC1032 too.
    // A framed MTEXT (background flag 16) is the one appearance that raises the
    // written version to AC1032, so only the version move drops the pair here —
    // isolating the ruling's version-change condition from pair validity.
    const source = fixture('fixtures/interchange/r2018-table-autocad.dxf').replace('AC1032', 'AC1027');
    expect(maintVerOf(source)).toEqual([90, '427']);
    const state = readDxf(source);
    const framed = {
      type: 'mtext', id: 'n3-frame', layer: '0', color: 'ByLayer',
      position: { x: 0, y: 0 }, text: 'frame', height: 0.2, width: 2,
      rotation: 0, attachment: 1, lineSpacing: 1,
      background: { flags: 16, scale: 1.5, color: 7 },
    } as const;
    const written = writeDxf({ ...state, entities: [...state.entities, framed] });
    expect(written).toContain('AC1032');
    expect(maintVerOf(written)).toBeUndefined();
  });
});
