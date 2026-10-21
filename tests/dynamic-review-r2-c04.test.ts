/**
 * Review round 2, C04 — ATTRIB placement/appearance folds must not
 * depend on block-definition order.
 *
 * The defect: when the BLOCKS section defines a parent block before
 * the child block its nested INSERT references (a forward reference —
 * including JCad's own output whenever state lists the outer block
 * first), the nested insert was read before the child's definition
 * existed. The R09 deferred pass restored the dynamic VALUES, but the
 * ATTRIB placements and appearance had already been discarded during
 * the parent's read, so the reopened nested attribute lost its genuine
 * per-instance offset and colour.
 *
 * The contract pinned here: the reader retains the raw ATTRIB follower
 * records for exactly those inserts and replays the COMPLETE fold
 * (values, hidden flags, local placement conversion, R07 authored-frame
 * rebase) once every definition is known — the reopened state is
 * identical for both block orders, for dynamic and static targets, at
 * any nesting depth, and genuinely unmodelable instance payloads stay
 * retained.
 */
import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { explodeInsert, type BlockDef, type InsertEntity, type TextEntity } from '../src/core/entities';
import type { DynamicBlockDefinition } from '../src/core/parametric/definitions';
import { readDxf, writeDxf } from '../src/io/dxf';

const definition = (): DynamicBlockDefinition => ({
  version: 1,
  parameters: [{ kind: 'linear-distance', id: 'width', name: 'Width', basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, defaultValue: 10,
    constraint: { kind: 'range', min: 5, max: 20 }, grips: [{ role: 'value', movesWithValue: true }] }],
  actions: [{ kind: 'stretch', id: 'stretch', name: 'Stretch', parameterId: 'width', frame: { kind: 'rectangle', min: { x: 5, y: -1 }, max: { x: 15, y: 5 } },
    selection: [{ entityId: 'line', points: { kind: 'frame' } }, { entityId: 'TAG', points: { kind: 'frame' } }] }],
});
const child = (): BlockDef => ({ name: 'CHILD', basePoint: { x: 0, y: 0 },
  entities: [{ id: 'line', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }],
  attributes: [{ tag: 'TAG', prompt: 'Tag', default: 'DEFAULT', position: { x: 6, y: 1 }, height: 1, align: 'left' }], dynamic: definition() });
const nestedInsert = (): InsertEntity => ({ id: 'nested', type: 'insert', layer: '0', color: 'ByLayer', block: 'CHILD',
  position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: { TAG: 'USER-TAG' },
  dynamic: { block: 'CHILD', values: { width: { kind: 'distance', value: 14 } } },
  // Genuine per-instance offset: authored TAG x6 placed at x8, coloured red.
  attributePlacements: { TAG: { position: { x: 8, y: 1 }, height: 1, align: 'left', color: 1 } } });
const parent = (nested: InsertEntity = nestedInsert()): BlockDef => ({ name: 'PARENT', basePoint: { x: 0, y: 0 }, entities: [nested], attributes: [] });
const outer = (): InsertEntity => ({ id: 'outer', type: 'insert', layer: '0', color: 'ByLayer', block: 'PARENT',
  position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {} });

const roundTrip = (blocks: Record<string, BlockDef>): Drawing =>
  new Drawing(readDxf(writeDxf(new Drawing({ entities: [outer()], blocks }).snapshot)));

const reopenedNested = (doc: Drawing): InsertEntity => doc.blocks.PARENT!.entities[0] as InsertEntity;

const expandedTag = (doc: Drawing): TextEntity => {
  const found = explodeInsert(doc.entities[0] as InsertEntity, doc.lookupBlock)
    .find((e): e is TextEntity => e.type === 'text' && e.text === 'USER-TAG');
  if (!found) throw new Error('missing expanded TAG');
  return found;
};

describe('C04 — nested attribute fold is independent of block order', () => {
  it('parent-first and child-first reopen to the identical nested state', () => {
    const childFirst = roundTrip({ CHILD: child(), PARENT: parent() });
    const parentFirst = roundTrip({ PARENT: parent(), CHILD: child() });
    const a = reopenedNested(childFirst);
    const b = reopenedNested(parentFirst);
    expect(b.dynamicRetained).toBeUndefined();
    expect(b.dynamic).toEqual(a.dynamic);
    // Placement equality modulo cadIdentity — the file handle, which
    // legitimately differs between the two writes (record order).
    const strip = (p: InsertEntity['attributePlacements']) => Object.fromEntries(
      Object.entries(p ?? {}).map(([tag, pl]) => [tag, Object.fromEntries(Object.entries(pl).filter(([k]) => k !== 'cadIdentity'))]));
    expect(strip(b.attributePlacements)).toEqual(strip(a.attributePlacements));
    expect(b.attributePlacements?.TAG?.color).toBe(1);
    // The evaluated TAG: authored x6 + stretch +4, plus the genuine +2 offset.
    for (const doc of [childFirst, parentFirst]) {
      const tag = expandedTag(doc);
      expect(tag.position).toEqual({ x: 12, y: 1 });
      expect(tag.color).toBe(1);
    }
  });

  it('three levels deep, outermost first: the innermost fold still completes', () => {
    const grandparent: BlockDef = { name: 'GRANDPARENT', basePoint: { x: 0, y: 0 },
      entities: [{ id: 'mid', type: 'insert', layer: '0', color: 'ByLayer', block: 'PARENT', position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {} }],
      attributes: [] };
    const top: InsertEntity = { ...outer(), block: 'GRANDPARENT' };
    const doc = new Drawing(readDxf(writeDxf(new Drawing({
      entities: [top],
      blocks: { GRANDPARENT: grandparent, PARENT: parent(), CHILD: child() },
    }).snapshot)));
    const nested = reopenedNested(doc);
    expect(nested.dynamicRetained).toBeUndefined();
    expect(nested.attributePlacements?.TAG?.color).toBe(1);
    const tag = explodeInsert(doc.entities[0] as InsertEntity, doc.lookupBlock)
      .find((e): e is TextEntity => e.type === 'text' && e.text === 'USER-TAG');
    expect(tag?.position).toEqual({ x: 12, y: 1 });
    expect(tag?.color).toBe(1);
  });

  it('a forward-referenced STATIC nested insert keeps its placement and colour too', () => {
    const statik: BlockDef = { name: 'STATIC', basePoint: { x: 0, y: 0 }, entities: [],
      attributes: [{ tag: 'NOTE', prompt: 'Note', default: 'N', position: { x: 2, y: 2 }, height: 1, align: 'left' }] };
    const inner: InsertEntity = { id: 'inner', type: 'insert', layer: '0', color: 'ByLayer', block: 'STATIC',
      position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: { NOTE: 'HELLO' },
      attributePlacements: { NOTE: { position: { x: 3, y: 2 }, height: 1, align: 'left', color: 3 } } };
    const wrap: BlockDef = { name: 'WRAP', basePoint: { x: 0, y: 0 }, entities: [inner], attributes: [] };
    const top: InsertEntity = { ...outer(), block: 'WRAP' };
    const doc = new Drawing(readDxf(writeDxf(new Drawing({
      entities: [top],
      blocks: { WRAP: wrap, STATIC: statik },
    }).snapshot)));
    const reopened = doc.blocks.WRAP!.entities[0] as InsertEntity;
    expect(reopened.attributePlacements?.NOTE?.color).toBe(3);
    const note = explodeInsert(doc.entities[0] as InsertEntity, doc.lookupBlock)
      .find((e): e is TextEntity => e.type === 'text' && e.text === 'HELLO');
    expect(note?.position).toEqual({ x: 3, y: 2 });
    expect(note?.color).toBe(3);
  });

  it('a per-instance hidden attribute survives the forward reference', () => {
    const nested: InsertEntity = { ...nestedInsert(), hiddenAttributes: ['TAG'] };
    const doc = roundTrip({ PARENT: parent(nested), CHILD: child() });
    expect(reopenedNested(doc).hiddenAttributes).toEqual(['TAG']);
  });

  it('an unmodelable nested payload stays retained in parent-first order — and its placements still fold', () => {
    const nested: InsertEntity = { ...nestedInsert(), dynamic: undefined, dynamicRetained: '{"version":99,"bogus":true}' };
    const doc = roundTrip({ PARENT: parent(nested), CHILD: child() });
    const reopened = reopenedNested(doc);
    expect(reopened.dynamic).toBeUndefined();
    expect(reopened.dynamicRetained).toBeDefined();
    // Retained instances display authored geometry; their ATTRIB
    // placements are ordinary data and fold like any other insert's.
    expect(reopened.attributePlacements?.TAG?.color).toBe(1);
  });
});
