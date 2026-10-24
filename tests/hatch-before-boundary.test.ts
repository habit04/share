/**
 * v0.6.4 pre-release review finding F-B: when an associative hatch is
 * written BEFORE its boundary entity, writeHatch reserves the boundary's
 * handle early (Writer.reserveEntityHandle, P17). The boundary's first
 * record is then emitted under that RESERVED handle, not under the
 * allocator's counter — so any writer that derived "the handle I just
 * emitted" from w.lastHandle() named the wrong record:
 *
 *   - INSERT: its ATTRIB and SEQEND followers carried a 330 owner that was
 *     not the INSERT's handle (AutoCAD: orphaned attributes);
 *   - IMAGE: the IMAGEDEF_REACTOR's back-pointer (330) named the counter;
 *   - *UNDERLAY: the handle handed to the codec was the counter.
 *
 * writeEntityCommon now returns the handle it actually wrote and every
 * site uses that. The "after" variants are controls: they passed before
 * the fix and must keep passing.
 */
import { describe, it, expect } from 'vitest';
import type { Entity, HatchEntity, UnderlayEntity } from '../src/core/entities';
import type { DrawingState } from '../src/core/document';
import { Drawing } from '../src/core/document';
import { readDxf, writeDxf } from '../src/io/dxf';

type Rec = { kind: string; groups: Array<[number, string]> };
function records(text: string): Rec[] {
  const lines = text.split(/\r?\n/);
  const out: Rec[] = [];
  let cur: Rec | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]!.trim());
    const value = lines[i + 1]!;
    if (code === 0) {
      cur = { kind: value.trim(), groups: [] };
      out.push(cur);
    } else if (cur) cur.groups.push([code, value.trim()]);
  }
  return out;
}
const group = (rec: Rec, code: number): string | undefined => rec.groups.find(([c]) => c === code)?.[1];
const allGroups = (rec: Rec, code: number): string[] => rec.groups.filter(([c]) => c === code).map(([, v]) => v);
/** The boundary handles of the hatch's first 97/330 list. */
const boundaryLinks = (hatch: Rec): string[] => {
  const i97 = hatch.groups.findIndex(([c]) => c === 97);
  const count = Number(hatch.groups[i97]![1]);
  return hatch.groups.slice(i97 + 1, i97 + 1 + count).map(([, v]) => v);
};
/** Every entity record's handle must be unique in the file. */
const expectUniqueEntityHandles = (recs: Rec[]): void => {
  const handles = recs.filter((r) => r.groups.some(([c, v]) => c === 100 && v === 'AcDbEntity')).map((r) => group(r, 5));
  expect(new Set(handles).size).toBe(handles.length);
};

const props = { layer: '0', color: 'ByLayer' as const };
const sq = (x: number, y: number, s: number) => [
  { x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s },
];
const hatchOn = (id: string, boundaryId: string): HatchEntity => ({
  id, ...props, type: 'hatch', pattern: 'SOLID', solid: true, angle: 0, scale: 1,
  loops: [{ points: sq(0, 0, 10), boundaryRefs: [boundaryId] }], associative: true,
});
// Padding entities so the allocator counter moves on between the hatch and
// the boundary: that is what makes lastHandle() differ from the reserved handle.
const pad = (): Entity[] => Array.from({ length: 5 }, (_, k) => ({ id: `p${k}`, ...props, type: 'line', a: { x: 20 + k, y: 0 }, b: { x: 20 + k, y: 1 } }));

describe('F-B: associative hatch written before an INSERT with attributes', () => {
  const build = (hatchFirst: boolean): string => {
    const d = new Drawing();
    d.defineBlock({
      name: 'B',
      basePoint: { x: 0, y: 0 },
      entities: [{ id: 'bl', ...props, type: 'polyline', points: sq(0, 0, 10), closed: true }],
      attributes: [{ tag: 'TAG', prompt: 'TAG', default: 'x', position: { x: 1, y: 1 }, height: 0.5, align: 'left' as const }],
    });
    const insert: Entity = { id: 'i1', ...props, type: 'insert', block: 'B', position: { x: 0, y: 0 }, scale: 1, rotation: 0, attributes: { TAG: 'v' } };
    d.addEntities(hatchFirst ? [hatchOn('h1', 'i1'), ...pad(), insert] : [insert, ...pad(), hatchOn('h1', 'i1')]);
    return writeDxf(d.snapshot);
  };

  for (const hatchFirst of [true, false]) {
    it(`ATTRIB and SEQEND owners (330) name the INSERT's written handle (hatch ${hatchFirst ? 'BEFORE' : 'after'} insert)`, () => {
      const text = build(hatchFirst);
      const recs = records(text);
      const ins = recs.find((r) => r.kind === 'INSERT')!;
      const attrib = recs.find((r) => r.kind === 'ATTRIB')!;
      const seqend = recs.find((r) => r.kind === 'SEQEND')!;
      const hatch = recs.find((r) => r.kind === 'HATCH')!;
      const insHandle = group(ins, 5)!;
      expect(group(hatch, 71)).toBe('1');
      expect(boundaryLinks(hatch)).toEqual([insHandle]);
      expect(group(attrib, 330)).toBe(insHandle);
      expect(group(seqend, 330)).toBe(insHandle);
      expectUniqueEntityHandles(recs);
      // The reactor pass keys off the same handle: the INSERT carries the back-pointer.
      expect(allGroups(ins, 330)).toContain(group(hatch, 5));
      const back = readDxf(text);
      const rt = back.entities.find((e) => e.type === 'insert');
      expect(rt?.type === 'insert' && rt.attributes).toEqual({ TAG: 'v' });
      const h = back.entities.find((e) => e.type === 'hatch') as HatchEntity;
      expect(h.loops[0]!.boundaryRefs).toEqual([rt!.id]);
    });
  }
});

describe('F-B: associative hatch written before an IMAGE', () => {
  const build = (hatchFirst: boolean): string => {
    const image: Entity = { id: 'im', ...props, type: 'image', path: 'logo.png', position: { x: 0, y: 0 }, u: { x: 0.01, y: 0 }, v: { x: 0, y: 0.01 }, size: { x: 200, y: 100 } };
    const state: DrawingState = {
      entities: hatchFirst ? [hatchOn('h1', 'im'), ...pad(), image] : [image, ...pad(), hatchOn('h1', 'im')],
      layers: [], blocks: {}, currentLayer: '0',
    };
    return writeDxf(state);
  };
  for (const hatchFirst of [true, false]) {
    it(`IMAGEDEF_REACTOR owner and back-pointer (330) name the IMAGE's written handle (hatch ${hatchFirst ? 'BEFORE' : 'after'} image)`, () => {
      const recs = records(build(hatchFirst));
      const img = recs.find((r) => r.kind === 'IMAGE')!;
      const reactor = recs.find((r) => r.kind === 'IMAGEDEF_REACTOR')!;
      const hatch = recs.find((r) => r.kind === 'HATCH')!;
      const imgHandle = group(img, 5)!;
      expect(boundaryLinks(hatch)).toEqual([imgHandle]);
      // Both 330s of the reactor (owner and the AcDbRasterImageDefReactor
      // back-pointer) name the image.
      expect(allGroups(reactor, 330)).toEqual([imgHandle, imgHandle]);
      // The image names its reactor by the hard reference the writer uses (360).
      expect(group(img, 360)).toBe(group(reactor, 5));
      expectUniqueEntityHandles(recs);
    });
  }
});

describe('F-B: associative hatch written before a PDFUNDERLAY', () => {
  const build = (hatchFirst: boolean): string => {
    const underlay: UnderlayEntity = {
      id: 'u1', ...props, type: 'underlay', kind: 'pdf', definitionHandle: '41',
      position: { x: 0, y: 0 }, scaleX: 1, scaleY: 1, rotation: 0, flags: 2, retainedGroups: [],
    };
    const state: DrawingState = {
      entities: hatchFirst ? [hatchOn('h1', 'u1'), ...pad(), underlay] : [underlay, ...pad(), hatchOn('h1', 'u1')],
      layers: [], blocks: {}, currentLayer: '0',
      underlays: { 'underlaydef:41': { id: 'underlaydef:41', handle: '41', kind: 'pdf', sourcePath: 'plans/floor.pdf', retainedGroups: [] } },
    };
    return writeDxf(state);
  };
  for (const hatchFirst of [true, false]) {
    it(`the hatch link names the PDFUNDERLAY's written handle and the placement names its definition (hatch ${hatchFirst ? 'BEFORE' : 'after'} underlay)`, () => {
      const recs = records(build(hatchFirst));
      const und = recs.find((r) => r.kind === 'PDFUNDERLAY')!;
      const def = recs.find((r) => r.kind === 'PDFDEFINITION')!;
      const hatch = recs.find((r) => r.kind === 'HATCH')!;
      expect(boundaryLinks(hatch)).toEqual([group(und, 5)]);
      expect(group(und, 340)).toBe(group(def, 5));
      // Exactly one handle group on the placement: the codec's copy is skipped.
      expect(allGroups(und, 5)).toHaveLength(1);
      expectUniqueEntityHandles(recs);
    });
  }
});
