/**
 * Priority 30 review corrections — DXF/expansion group (R07, R09, R10).
 *
 * R07: dynamic attribute placement through DXF save/reopen and subsequent
 * parameter edits — imported placement overrides must not undo or freeze
 * evaluated attribute motion.
 * R09: nested dynamic instances decode independently of block-definition
 * order — forward references retain values and evaluated geometry.
 * R10: EXPLODE checks every nested dynamic reference it actually consumes —
 * a nested evaluation refusal refuses the explode atomically.
 */
import { describe, it, expect } from 'vitest';
import { readDxf, writeDxf } from '../src/io/dxf';
import {
  explodeInsert,
  insertEvaluationRefusal,
  type AttributeDef,
  type BlockDef,
  type Entity,
  type InsertEntity,
  type LineEntity,
  type TextEntity,
} from '../src/core/entities';
import { Drawing, type DrawingState } from '../src/core/document';
import type { DynamicBlockDefinition, LinearDistanceParameter, StretchAction } from '../src/core/parametric/definitions';
import { setDynamicParameter } from '../src/core/parametric/apply';
import { ExplodeTool } from '../src/tools/edit';
import { fakeContext, drive } from './fake-context';

// --- Shared fixture: PANEL, a dynamic block whose stretch selection -------
// --- includes the TAG attribute (position inside the frame). --------------
const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by },
});

const widthParam = (id = 'width'): LinearDistanceParameter => ({
  kind: 'linear-distance',
  id,
  name: 'Width',
  basePoint: { x: 0, y: 0 },
  direction: { x: 1, y: 0 },
  defaultValue: 10,
  constraint: { kind: 'range', min: 5, max: 20 },
  grips: [
    { role: 'base', movesWithValue: false },
    { role: 'value', movesWithValue: true },
  ],
});

const stretchOver = (selection: StretchAction['selection']): StretchAction => ({
  kind: 'stretch',
  id: 'S1',
  name: 'Stretch',
  parameterId: 'width',
  frame: { kind: 'rectangle', min: { x: 5, y: -1 }, max: { x: 15, y: 6 } },
  selection,
});

const panelDefinition = (): DynamicBlockDefinition => ({
  version: 1,
  parameters: [widthParam()],
  actions: [stretchOver([
    { entityId: 'L2', points: { kind: 'frame' } },
    { entityId: 'L1', points: { kind: 'frame' } },
    { entityId: 'L3', points: { kind: 'frame' } },
    { entityId: 'TAG', points: { kind: 'frame' } },
  ])],
});

const panelBlock = (name: string): BlockDef => ({
  name,
  basePoint: { x: 0, y: 0 },
  entities: [
    line('L1', 0, 0, 10, 0),
    line('L2', 10, 0, 10, 5),
    line('L3', 10, 5, 0, 5),
    line('L4', 0, 5, 0, 0),
  ],
  attributes: [{ tag: 'TAG', prompt: 'Tag', default: 'D1', position: { x: 7, y: 2 }, height: 2, align: 'left' }],
  dynamic: panelDefinition(),
});

const layers = [{ name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 }];

const lookupOf = (state: DrawingState) => (n: string) => state.blocks[n];

/** World position of an insert's TAG attribute text in its expansion. */
const tagTextPosition = (state: DrawingState, ins: InsertEntity): { x: number; y: number } => {
  const text = explodeInsert(ins, lookupOf(state)).find((e): e is TextEntity => e.type === 'text' && e.id === `${ins.id}:TAG`);
  if (!text) throw new Error('TAG attribute text not in expansion');
  return text.position;
};

const panelInsert = (id: string, x: number, y: number, width: number): InsertEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'insert', block: 'PANEL',
  position: { x, y }, rotation: 0, scale: 1,
  attributes: { TAG: 'P1' },
  dynamic: { block: 'PANEL', values: { width: { kind: 'distance', value: width } } },
});

// --- DXF text surgery helpers (pair-level, on writeDxf output) -------------
const toPairs = (dxf: string): [string, string][] => {
  const lines = dxf.split('\r\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([lines[i]!, lines[i + 1]!]);
  return pairs;
};
const fromPairs = (pairs: readonly [string, string][]): string =>
  pairs.map(([c, v]) => `${c}\r\n${v}`).join('\r\n') + '\r\n';

/** Add dx to the group-10 (position x) of the ATTRIB record for `tag`. */
const offsetAttribX = (dxf: string, tag: string, dx: number): string => {
  const pairs = toPairs(dxf);
  for (let i = 0; i < pairs.length; i += 1) {
    if (pairs[i]![0] !== '0' || pairs[i]![1] !== 'ATTRIB') continue;
    let end = i + 1;
    while (end < pairs.length && pairs[end]![0] !== '0') end += 1;
    const isTag = pairs.slice(i, end).some(([c, v]) => c === '2' && v === tag);
    if (!isTag) continue;
    const at = pairs.slice(i, end).findIndex(([c]) => c === '10');
    if (at < 0) throw new Error('ATTRIB has no group 10');
    const idx = i + at;
    pairs[idx] = ['10', String(Number(pairs[idx]![1]) + dx)];
    return fromPairs(pairs);
  }
  throw new Error(`ATTRIB for ${tag} not found`);
};

/** Reorder the BLOCK records of the BLOCKS section so `firstName` comes first. */
const reorderBlockRecords = (dxf: string, firstName: string): string => {
  const pairs = toPairs(dxf);
  const isSection = (i: number, name: string) =>
    pairs[i]?.[0] === '0' && pairs[i]?.[1] === 'SECTION' && pairs[i + 1]?.[0] === '2' && pairs[i + 1]?.[1] === name;
  let start = -1;
  for (let i = 0; i + 1 < pairs.length; i += 1) if (isSection(i, 'BLOCKS')) { start = i; break; }
  if (start < 0) throw new Error('no BLOCKS section');
  let end = start + 2;
  while (end < pairs.length && !(pairs[end]![0] === '0' && pairs[end]![1] === 'ENDSEC')) end += 1;
  // Chunks: BLOCK object .. ENDBLK object (each object runs to the next code 0).
  const chunks: { name: string; range: [number, number] }[] = [];
  let i = start + 2;
  while (i < end) {
    if (!(pairs[i]![0] === '0' && pairs[i]![1] === 'BLOCK')) throw new Error(`expected BLOCK at pair ${i}`);
    let j = i;
    let name = '';
    // BLOCK object's own groups: find its group 2 before the next code 0.
    for (let k = i + 1; k < end && pairs[k]![0] !== '0'; k += 1) if (pairs[k]![0] === '2') { name = pairs[k]![1]; break; }
    // Advance past objects until ENDBLK's object is consumed.
    for (;;) {
      const kind = pairs[j]![1];
      j += 1;
      while (j < end && pairs[j]![0] !== '0') j += 1;
      if (kind === 'ENDBLK' || j >= end) break;
    }
    chunks.push({ name, range: [i, j] });
    i = j;
  }
  const first = chunks.filter((c) => c.name === firstName);
  const rest = chunks.filter((c) => c.name !== firstName);
  if (!first.length) throw new Error(`block ${firstName} not found`);
  const ordered = [...pairs.slice(0, start + 2)];
  for (const c of [...first, ...rest]) ordered.push(...pairs.slice(c.range[0], c.range[1]));
  ordered.push(...pairs.slice(end));
  return fromPairs(ordered);
};

// ===========================================================================
describe('R07 — dynamic attribute placement through save/reopen and re-edit', () => {
  it('an attribute inside the stretch selection keeps its evaluated motion through save/reopen and a further parameter edit', () => {
    const state: DrawingState = {
      entities: [panelInsert('p1', 100, 50, 14)],
      layers,
      blocks: { PANEL: panelBlock('PANEL') },
      currentLayer: '0',
    };
    // Width 14 vs default 10: the stretch moves TAG from (7,2) to (11,2)
    // in definition space, i.e. world (111,52) for this insert.
    expect(tagTextPosition(state, state.entities[0] as InsertEntity)).toEqual({ x: 111, y: 52 });

    const reopened = readDxf(writeDxf(state));
    const rins = reopened.entities.find((e): e is InsertEntity => e.type === 'insert')!;
    expect(rins.dynamic).toEqual({ block: 'PANEL', values: { width: { kind: 'distance', value: 14 } } });
    // The reopen alone must not move the attribute back to the authored spot.
    expect(tagTextPosition(reopened, rins)).toEqual({ x: 111, y: 52 });

    // A further parameter edit must move the attribute exactly as the
    // never-saved path does.
    const edited = setDynamicParameter(reopened, rins.id, 'width', 18);
    expect(edited.problem).toBeUndefined();
    const eins = edited.state.entities.find((e): e is InsertEntity => e.type === 'insert')!;
    expect(tagTextPosition(edited.state, eins)).toEqual({ x: 115, y: 52 });

    const direct = setDynamicParameter(state, 'p1', 'width', 18);
    expect(direct.problem).toBeUndefined();
    const dins = direct.state.entities.find((e): e is InsertEntity => e.type === 'insert')!;
    expect(tagTextPosition(direct.state, dins)).toEqual(tagTextPosition(edited.state, eins));
  });

  it('a genuine imported attribute offset survives reopen and moves WITH later evaluation (rebased, not pinned)', () => {
    const state: DrawingState = {
      entities: [panelInsert('p1', 100, 50, 14)],
      layers,
      blocks: { PANEL: panelBlock('PANEL') },
      currentLayer: '0',
    };
    // Simulate a file authored elsewhere: the user dragged the attribute
    // 2 units right of its evaluated position at width 14 (world x 111 -> 113).
    const dxf = offsetAttribX(writeDxf(state), 'TAG', 2);
    const reopened = readDxf(dxf);
    const rins = reopened.entities.find((e): e is InsertEntity => e.type === 'insert')!;
    expect(tagTextPosition(reopened, rins)).toEqual({ x: 113, y: 52 });
    // After an edit the offset rides on the new evaluated position.
    const edited = setDynamicParameter(reopened, rins.id, 'width', 18);
    expect(edited.problem).toBeUndefined();
    const eins = edited.state.entities.find((e): e is InsertEntity => e.type === 'insert')!;
    expect(tagTextPosition(edited.state, eins)).toEqual({ x: 117, y: 52 });
  });

  it('static (non-dynamic) block attribute overrides behave exactly as before (regression pin)', () => {
    const plain: BlockDef = {
      name: 'PLAIN',
      basePoint: { x: 0, y: 0 },
      entities: [line('PL1', 0, 0, 4, 0)],
      attributes: [{ tag: 'TAG', prompt: 'Tag', default: 'D1', position: { x: 1, y: 1 }, height: 2, align: 'left' }],
    };
    const ins: InsertEntity = {
      id: 's1', layer: '0', color: 'ByLayer', type: 'insert', block: 'PLAIN',
      position: { x: 10, y: 10 }, rotation: 0, scale: 1,
      attributes: { TAG: 'S1' },
      // As imported from a file whose ATTRIB the user had moved.
      attributePlacements: { TAG: { position: { x: 4, y: 3 }, height: 2, align: 'left' } },
    };
    const state: DrawingState = { entities: [ins], layers, blocks: { PLAIN: plain }, currentLayer: '0' };
    expect(tagTextPosition(state, ins)).toEqual({ x: 14, y: 13 });
    const reopened = readDxf(writeDxf(state));
    const rins = reopened.entities.find((e): e is InsertEntity => e.type === 'insert')!;
    expect(rins.attributePlacements?.TAG?.position).toEqual({ x: 4, y: 3 });
    expect(tagTextPosition(reopened, rins)).toEqual({ x: 14, y: 13 });
  });
});

// ===========================================================================
describe('R09 — nested dynamic instances decode independently of block order', () => {
  const innerBlock = (): BlockDef => {
    const b = panelBlock('INNER');
    // Rename entity ids IL1..IL4 and remap the definition's selections to
    // match (attribute selections stay as the TAG name).
    const remap = (id: string) => (id.startsWith('L') ? `I${id}` : id);
    return {
      ...b,
      entities: b.entities.map((e) => ({ ...e, id: remap(e.id) })),
      dynamic: {
        ...b.dynamic!,
        actions: b.dynamic!.actions.map((a) => (a.kind === 'stretch'
          ? { ...a, selection: a.selection.map((s) => ({ ...s, entityId: remap(s.entityId) })) }
          : a)),
      },
    };
  };
  const outerBlock = (): BlockDef => ({
    name: 'OUTER',
    basePoint: { x: 0, y: 0 },
    entities: [
      line('OFRAME', 0, 8, 20, 8),
      {
        id: 'NI', layer: '0', color: 'ByLayer', type: 'insert', block: 'INNER',
        position: { x: 0, y: 0 }, rotation: 0, scale: 1,
        attributes: {},
        dynamic: { block: 'INNER', values: { width: { kind: 'distance', value: 16 } } },
      } satisfies InsertEntity,
    ],
    attributes: [],
  });
  const nestedState = (): DrawingState => ({
    entities: [{
      id: 'TOP', layer: '0', color: 'ByLayer', type: 'insert', block: 'OUTER',
      position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {},
    }],
    layers,
    blocks: { OUTER: outerBlock(), INNER: innerBlock() },
    currentLayer: '0',
  });

  const geometrySummary = (state: DrawingState): string[] => {
    const top = state.entities.find((e): e is InsertEntity => e.type === 'insert')!;
    return explodeInsert(top, lookupOf(state)).map((e) => {
      if (e.type === 'line') return `line ${e.a.x},${e.a.y}-${e.b.x},${e.b.y}`;
      if (e.type === 'text') return `text ${e.text}@${e.position.x},${e.position.y}`;
      return e.type;
    }).sort();
  };

  it('a forward-referenced nested instance retains its values and evaluated geometry after save/reopen', () => {
    const state = nestedState();
    const dxf = writeDxf(state);
    // writeDxf emits the blocks in state order (OUTER first), so normalize
    // both variants explicitly: control = INNER's record first.
    const inOrder = readDxf(reorderBlockRecords(dxf, 'INNER'));
    const reordered = readDxf(reorderBlockRecords(dxf, 'OUTER'));

    for (const [label, read] of [['in-order', inOrder], ['forward-ref', reordered]] as const) {
      const nested = read.blocks['OUTER']!.entities.find((e): e is InsertEntity => e.type === 'insert');
      expect(nested, label).toBeDefined();
      expect(nested!.dynamicRetained, label).toBeUndefined();
      expect(nested!.dynamic, label).toEqual({ block: 'INNER', values: { width: { kind: 'distance', value: 16 } } });
      // INNER evaluated at width 16: its right edge sits at x=16, not the authored 10.
      const summary = geometrySummary(read);
      expect(summary, label).toContain('line 16,0-16,5');
      expect(summary, label).not.toContain('line 10,0-10,5');
      expect(summary, label).toEqual(geometrySummary(inOrder));
    }
  });
});

// ===========================================================================
describe('R10 — EXPLODE checks every nested dynamic reference it consumes', () => {
  const dynBlock = (): BlockDef => panelBlock('DYN');
  const outerWith = (nested: InsertEntity, name = 'OUTER'): BlockDef => ({
    name,
    basePoint: { x: 0, y: 0 },
    entities: [line('OFRAME', 0, 8, 20, 8), nested],
    attributes: [],
  });
  const nestedInsert = (id: string, width: number): InsertEntity => ({
    id, layer: '0', color: 'ByLayer', type: 'insert', block: 'DYN',
    position: { x: 0, y: 0 }, rotation: 0, scale: 1,
    attributes: { TAG: 'N1' },
    dynamic: { block: 'DYN', values: { width: { kind: 'distance', value: width } } },
  });
  const docWith = (blocks: Record<string, BlockDef>, topBlock: string): Drawing => new Drawing({
    entities: [{
      id: 'MO', layer: '0', color: 'ByLayer', type: 'insert', block: topBlock,
      position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {},
    }],
    blocks,
    currentLayer: '0',
  });

  it('refuses atomically when a nested dynamic insert inside a static outer block refuses evaluation', () => {
    const doc = docWith({ OUTER: outerWith(nestedInsert('ND', 25)), DYN: dynBlock() }, 'OUTER');
    const before = doc.snapshot;
    const mo = doc.entities[0] as InsertEntity;
    // The probe sees the nested refusal even though the top insert is static.
    const probe = insertEvaluationRefusal(mo, (n) => doc.snapshot.blocks[n]);
    expect(probe).not.toBeNull();
    expect(probe!.code).toBe('invalid-instance');
    expect(probe!.insertId).toBe('ND');

    const ctx = fakeContext(doc);
    ctx.selection = new Set(['MO']);
    drive(new ExplodeTool(), ctx, []);
    expect(ctx.logs.some((l) => l.includes('not exploded') && l.includes('invalid-instance'))).toBe(true);
    expect(doc.snapshot).toBe(before);
    expect(doc.entities.map((e) => e.id)).toEqual(['MO']);
    expect(doc.canUndo()).toBe(false);
    expect(doc.dirty).toBe(false);
  });

  it('explodes a nested evaluating dynamic insert to its evaluated geometry, visibility rules intact', () => {
    // VIS: a visibility dynamic block (cabinet pattern): 'Open' shows
    // L1/L2/C1/NOTE, 'Closed' (default) shows L1/L3 only.
    const vis: BlockDef = {
      name: 'VIS',
      basePoint: { x: 0, y: 0 },
      entities: [
        line('L1', 0, 0, 10, 0),
        line('L2', 10, 0, 10, 5),
        line('L3', 0, 5, 10, 5),
        { id: 'C1', layer: '0', color: 'ByLayer', type: 'circle', center: { x: 5, y: 2.5 }, radius: 1 },
      ],
      attributes: [{ tag: 'NOTE', prompt: 'Note', default: '', position: { x: 1, y: 1 }, height: 2, align: 'left' } as AttributeDef],
      dynamic: {
        version: 1,
        parameters: [{
          kind: 'visibility', id: 'vis', name: 'Visibility', basePoint: { x: 0, y: 6 },
          defaultState: 'Closed',
          states: [
            { name: 'Open', visible: ['L1', 'L2', 'C1', 'NOTE'] },
            { name: 'Closed', visible: ['L1', 'L3'] },
          ],
        }],
        actions: [],
      },
    };
    const nestedVis: InsertEntity = {
      id: 'NV', layer: '0', color: 'ByLayer', type: 'insert', block: 'VIS',
      position: { x: 0, y: 0 }, rotation: 0, scale: 1,
      attributes: { NOTE: 'N7' },
      dynamic: { block: 'VIS', values: { vis: { kind: 'visibility', value: 'Closed' } } },
    };
    const doc = docWith({ OUTERV: outerWith(nestedVis, 'OUTERV'), VIS: vis }, 'OUTERV');
    const mo = doc.entities[0] as InsertEntity;
    expect(insertEvaluationRefusal(mo, (n) => doc.snapshot.blocks[n])).toBeNull();

    const ctx = fakeContext(doc);
    ctx.selection = new Set(['MO']);
    drive(new ExplodeTool(), ctx, []);
    expect(ctx.logs.some((l) => l.includes('1 object(s) exploded.'))).toBe(true);
    expect(doc.entities.filter((e) => e.type === 'insert')).toEqual([]);
    const segments = doc.entities.filter((e): e is LineEntity => e.type === 'line').map((l) => [l.a, l.b]);
    // Outer frame line + Closed-visible L1 and L3 only: no L2, no circle, no NOTE text.
    expect(segments).toContainEqual([{ x: 0, y: 8 }, { x: 20, y: 8 }]);
    expect(segments).toContainEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    expect(segments).toContainEqual([{ x: 0, y: 5 }, { x: 10, y: 5 }]);
    expect(segments).toHaveLength(3);
    expect(doc.entities.filter((e) => e.type === 'circle')).toEqual([]);
    expect(doc.entities.filter((e) => e.type === 'text')).toEqual([]);
  });

  it('does not refuse for a dynamic reference beyond the expansion depth limit (never consumed)', () => {
    // Chain D0 -> D1 -> ... -> D9; only D9 holds the refusing dynamic insert.
    // Expansion stops at MAX_INSERT_DEPTH (8): D9's contents are never
    // consumed, so the probe must not refuse on their account either.
    const blocks: Record<string, BlockDef> = { DYN: dynBlock() };
    for (let i = 9; i >= 0; i -= 1) {
      const inner: InsertEntity = i === 9
        ? nestedInsert('DEEP', 25)
        : {
          id: `N${i}`, layer: '0', color: 'ByLayer', type: 'insert', block: `D${i + 1}`,
          position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {},
        };
      blocks[`D${i}`] = {
        name: `D${i}`,
        basePoint: { x: 0, y: 0 },
        entities: [line(`M${i}`, 0, i, 1, i), inner],
        attributes: [],
      };
    }
    const doc = docWith(blocks, 'D0');
    const mo = doc.entities[0] as InsertEntity;
    expect(insertEvaluationRefusal(mo, (n) => doc.snapshot.blocks[n])).toBeNull();
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['MO']);
    drive(new ExplodeTool(), ctx, []);
    expect(ctx.logs.some((l) => l.includes('dynamic evaluation refused'))).toBe(false);
    expect(ctx.logs.some((l) => l.includes('1 object(s) exploded.'))).toBe(true);
  });
});
