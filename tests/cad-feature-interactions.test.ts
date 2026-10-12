import { describe, expect, it } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import {
  bakeInheritedColor, blockTransform, entityBounds, explodeInsert, leaderParts,
  mirrorEntityAcross, rotateEntity, scaleEntityBy, translateEntity,
  type BlockDef, type Entity, type InsertEntity, type LeaderEntity, type LineEntity,
  type MTextEntity, type PolylineEntity,
} from '../src/core/entities';
import { resolveAlpha, type TransparencySpec } from '../src/core/appearance';
import { readDxf, writeDxf } from '../src/io/dxf';
import { resolveColor } from '../src/render/draw';

const near = (actual: { x: number; y: number }, expected: { x: number; y: number }) => {
  expect(actual.x).toBeCloseTo(expected.x, 7);
  expect(actual.y).toBeCloseTo(expected.y, 7);
};
const alpha = (e: Entity, state: DrawingState) => Math.round(resolveAlpha(e, state.layers) * 255);
const reference = (block: string, properties: Partial<InsertEntity> = {}): InsertEntity => ({
  id: `ref:${block}`, type: 'insert', block, layer: 'HOST', color: 'ByLayer',
  position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {}, ...properties,
});
const block = (name: string, entities: readonly Entity[]): BlockDef => ({ name, entities, basePoint: { x: 0, y: 0 }, attributes: [] });
const flattened = (state: DrawingState): Entity[] => state.entities.flatMap((e) => e.type === 'insert' ? explodeInsert(e, (name) => state.blocks[name]) : [e]);

// Read native code/value pairs independently of the importer. The version and appearance
// assertions below must fail even if JCad's reader and writer share the same regression.
const nativeRecords = (text: string, kind: string) => {
  const lines = text.trimEnd().split(/\r?\n/);
  const records: Array<Array<[number, string]>> = [];
  let record: Array<[number, string]> = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const pair: [number, string] = [Number(lines[i]), lines[i + 1]!];
    if (pair[0] === 0) { if (record.length) records.push(record); record = []; }
    record.push(pair);
  }
  if (record.length) records.push(record);
  return records.filter((r) => r[0]?.[1] === kind);
};
const values = (record: Array<[number, string]>, code: number) => record.filter(([c]) => c === code).map(([, value]) => value);
const nativeVersion = (text: string) => {
  const lines = text.trimEnd().split(/\r?\n/);
  const at = lines.findIndex((value, i) => i % 2 === 1 && value === '$ACADVER' && Number(lines[i - 1]) === 9);
  expect(at).toBeGreaterThan(0);
  expect(Number(lines[at + 1])).toBe(1);
  return lines[at + 2];
};

describe('affine wide-polyline wrappers and CAD opacity', () => {
  it.each([
    { title: 'top-level ByBlock is opaque on a translucent layer', opacity: 'ByBlock', parent: undefined, expected: 255 },
    { title: 'nested ByBlock inherits the explicit parent alpha', opacity: 'ByBlock', parent: 96, expected: 96 },
    { title: 'explicit source alpha overrides its parent', opacity: 127, parent: 96, expected: 127 },
    { title: 'source ByLayer keeps its own layer alpha', opacity: 'ByLayer', parent: 96, expected: 128 },
  ] as const)('$title through native wrapper save/reopen', ({ opacity, parent, expected }) => {
    const source: PolylineEntity = {
      id: 'taper', type: 'polyline', layer: 'HOST', color: 'ByLayer', transparency: opacity,
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], bulges: [1, 0], closed: false,
      widths: [{ start: 1, end: 4 }, { start: 0, end: 0 }],
    };
    const transformed = blockTransform(source, (p) => ({ x: 7 + 2 * p.x + p.y, y: 3 + p.y }), 0, 2, 1, false) as PolylineEntity;
    expect(transformed.widthFrame).toBeDefined();
    const state = new Drawing({
      layers: [{ name: 'HOST', color: 3, visible: true, locked: false, lineWeight: 0.25, transparency: 128 }],
      entities: parent === undefined ? [transformed] : [reference('P', { transparency: parent })],
      blocks: parent === undefined ? {} : { P: block('P', [transformed]) },
    }).snapshot;
    const exported = writeDxf(state), reopened = readDxf(exported);
    // The affine width is represented by two actual native block references, not flattened
    // centerline geometry. Each wrapper must pass ByBlock through to its enclosing reference.
    expect(nativeRecords(exported, 'INSERT').length).toBeGreaterThanOrEqual(2);
    const before = flattened(state), after = flattened(reopened);
    expect(before).toHaveLength(1); expect(after).toHaveLength(1);
    expect(after[0]?.type).toBe('polyline');
    expect(alpha(before[0]!, state)).toBe(expected);
    expect(alpha(after[0]!, reopened)).toBe(expected);
    const a = entityBounds(before[0]!, () => undefined)!, b = entityBounds(after[0]!, () => undefined)!;
    near(b.min, a.min); near(b.max, a.max);
    expect((after[0] as PolylineEntity).widthFrame?.widths).toEqual(source.widths);
    expect(source.widths).toEqual([{ start: 1, end: 4 }, { start: 0, end: 0 }]);
  });
});

describe('nested MINSERT geometry under an anisotropic ancestor', () => {
  it.each([false, true])('preserves every grid anchor and sheared endpoint offset (mirror=%s)', (mirror) => {
    const edge: LineEntity = { id: 'edge', type: 'line', layer: '0', color: 'ByLayer', a: { x: 2, y: 3 }, b: { x: 3, y: 4 } };
    const child = reference('B', { id: 'child', layer: '0', position: { x: 0, y: 0 }, rotation: Math.PI / 4, scale: 2, scaleY: 3, columns: 2, rows: 2, columnSpacing: 7, rowSpacing: 11 });
    const state = new Drawing({
      entities: [reference('P', { position: { x: 10, y: 20 }, scale: 2, scaleY: 3, mirror })],
      blocks: { B: { ...block('B', [edge]), basePoint: { x: 2, y: 3 } }, P: block('P', [child]) },
    }).snapshot;
    const sign = mirror ? -1 : 1, root2 = Math.SQRT2;
    // Spacing is in child drawing units before the parent transform. It does not inherit
    // the child's scale. The diagonal endpoint does, and its resulting shear is essential.
    const anchors = [
      { x: 10, y: 20 }, { x: 10 + sign * 14 / root2, y: 20 + 21 / root2 },
      { x: 10 - sign * 22 / root2, y: 20 + 33 / root2 },
      { x: 10 - sign * 8 / root2, y: 20 + 54 / root2 },
    ];
    const offset = { x: -sign * 2 / root2, y: 15 / root2 };
    for (const drawing of [state, readDxf(writeDxf(state))]) {
      const lines = flattened(drawing);
      expect(lines).toHaveLength(4);
      lines.forEach((entity, index) => {
        expect(entity.type).toBe('line');
        const line = entity as LineEntity, anchor = anchors[index]!;
        near(line.a, anchor);
        near(line.b, { x: anchor.x + offset.x, y: anchor.y + offset.y });
        near({ x: line.b.x - line.a.x, y: line.b.y - line.a.y }, offset);
      });
    }
  });
});

// Independent LEADER/MTEXT association. The line and its attached text intentionally
// disagree in every foreground property; folding two records must not merge their style.
const leaderDxf = (textCodes: readonly (string | number)[] = [], textLayer = 'NOTES') => [
  0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1024', 0, 'ENDSEC',
  0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 70, 3,
  0, 'LAYER', 2, 'LEADERS', 70, 0, 62, 1, 6, 'CONTINUOUS',
  0, 'LAYER', 2, 'NOTES', 70, 0, 62, 3, 420, 3430008, 430, 'Book$Notes', 6, 'CONTINUOUS', 1001, 'AcCmTransparency', 1071, 33554560,
  0, 'LAYER', 2, 'HOST', 70, 0, 62, 4, 420, 7833753, 430, 'Book$Host', 6, 'CONTINUOUS', 1001, 'AcCmTransparency', 1071, 33554560,
  0, 'ENDTAB', 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES',
  0, 'MTEXT', 5, 'A1', 100, 'AcDbEntity', 8, textLayer, ...textCodes,
  100, 'AcDbMText', 10, 4, 20, 5, 40, 1, 41, 20, 71, 1, 1, 'Independent foreground',
  0, 'LEADER', 5, 'B1', 100, 'AcDbEntity', 8, 'LEADERS', 62, 1, 420, 11206656, 430, 'Book$Leader', 440, 33554632,
  100, 'AcDbLeader', 71, 1, 72, 0, 76, 2, 10, -10, 20, -10, 10, 0, 20, 0, 340, 'A1',
  0, 'ENDSEC', 0, 'EOF',
].join('\n');
const attached = (leader: LeaderEntity): MTextEntity => {
  const texts = leaderParts(leader).filter((e): e is MTextEntity => e.type === 'mtext');
  expect(texts).toHaveLength(1);
  return texts[0]!;
};
const onlyLeader = (state: DrawingState): LeaderEntity => {
  expect(state.entities).toHaveLength(1);
  expect(state.entities[0]?.type).toBe('leader');
  return state.entities[0] as LeaderEntity;
};
const leaderTransforms = (leader: LeaderEntity): LeaderEntity[] => [
  leader, translateEntity(leader, { x: 7, y: 9 }), rotateEntity(leader, { x: 0, y: 0 }, 0.4),
  scaleEntityBy(leader, { x: 0, y: 0 }, 2), mirrorEntityAcross(leader, { x: 0, y: 0 }, { x: 1, y: 0 }),
] as LeaderEntity[];

describe('associated LEADER text appearance across feature boundaries', () => {
  it.each([
    { title: 'explicit independent foreground', codes: [62, 5, 420, 1193046, 430, 'Book$Text 雷', 440, 33554559], color: '#123456', opacity: 127, name: 'Book$Text 雷' },
    { title: 'absent properties use the annotation layer', codes: [], color: '#345678', opacity: 128, name: undefined },
  ])('keeps $title on native import/save and all direct transforms', ({ codes, color, opacity, name }) => {
    const original = readDxf(leaderDxf(codes));
    for (const state of [original, readDxf(writeDxf(original))]) {
      const leader = onlyLeader(state);
      expect(leader).toMatchObject({ trueColor: 0xab0000, colorName: 'Book$Leader', transparency: 200 });
      for (const transformed of leaderTransforms(leader)) {
        const text = attached(transformed);
        expect(resolveColor(text, state.layers)).toBe(color);
        expect(alpha(text, state)).toBe(opacity);
        expect(text.colorName).toBe(name);
        if (!codes.length) {
          expect(text.trueColor).toBeUndefined(); expect(text.transparency).toBeUndefined();
          expect(text.color).toBe('ByLayer'); expect(text.layer).toBe('NOTES');
        }
        const line = leaderParts(transformed).find((e) => e.type === 'polyline')!;
        expect(resolveColor(line, state.layers)).toBe('#ab0000'); expect(alpha(line, state)).toBe(200);
      }
    }
    const native = nativeRecords(writeDxf(original), 'MTEXT')[0]!;
    expect(values(native, 8)).toEqual(['NOTES']);
    expect(values(native, 420)).toEqual(codes.length ? ['1193046'] : []);
    expect(values(native, 430)).toEqual(codes.length ? ['Book$Text 雷'] : []);
    expect(values(native, 440)).toEqual(codes.length ? ['33554559'] : []);
  });

  it.each([
    { title: 'ByBlock annotation', codes: [62, 0, 440, 16777216], layer: '0', color: '#2468ac', opacity: 96, name: 'Book$Parent' },
    { title: 'layer-zero ByLayer annotation', codes: [], layer: '0', color: '#778899', opacity: 128, name: undefined },
    { title: 'annotation on its own ByLayer layer', codes: [], layer: 'NOTES', color: '#345678', opacity: 128, name: undefined },
    { title: 'explicit annotation inside blocks', codes: [62, 5, 420, 1193046, 430, 'Book$Text 雷', 440, 33554559], layer: 'NOTES', color: '#123456', opacity: 127, name: 'Book$Text 雷' },
  ])('keeps $title independent through nesting, permanent explode and native save', ({ codes, layer, color, opacity, name }) => {
    const imported = readDxf(leaderDxf(codes, layer)), leader = onlyLeader(imported);
    const state = new Drawing({
      layers: imported.layers,
      blocks: { NOTE: block('NOTE', [leader]), WRAPPER: block('WRAPPER', [reference('NOTE', { layer: '0', color: 0, transparency: 'ByBlock' })]) },
      entities: [reference('WRAPPER', { position: { x: 10, y: 20 }, rotation: 0.2, scale: 2, color: 2, trueColor: 0x2468ac, colorName: 'Book$Parent', transparency: 96 })],
    }).snapshot;
    for (const drawing of [state, readDxf(writeDxf(state))]) {
      const entities = flattened(drawing);
      expect(entities).toHaveLength(1); expect(entities[0]?.type).toBe('leader');
      const visible = entities[0] as LeaderEntity, text = attached(visible);
      expect(resolveColor(text, drawing.layers)).toBe(color); expect(alpha(text, drawing)).toBe(opacity);
      expect(text.colorName).toBe(name);
      expect(resolveColor(leaderParts(visible)[0]!, drawing.layers)).toBe('#ab0000');
      expect(alpha(leaderParts(visible)[0]!, drawing)).toBe(200);
      const baked = bakeInheritedColor(visible, drawing.layers);
      const permanent = new Drawing({ layers: drawing.layers, entities: [baked] }).snapshot;
      const reopened = readDxf(writeDxf(permanent)), reopenedText = attached(onlyLeader(reopened));
      expect(resolveColor(reopenedText, reopened.layers)).toBe(color); expect(alpha(reopenedText, reopened)).toBe(opacity);
      // Layer identity is baked when inheritance is made permanent, but the independently
      // named foreground must survive whenever the annotation explicitly carries a name.
      if (name !== undefined) expect(reopenedText.colorName).toBe(name);
      near(reopenedText.position, text.position);
    }
  });

  it.each([
    { appearance: { color: 'ByLayer' as const, transparency: 127 as TransparencySpec }, version: 'AC1024', code: 440, value: '33554559' },
    { appearance: { color: 'ByLayer' as const, colorName: 'Book$Text only' }, version: 'AC1018', code: 430, value: 'Book$Text only' },
  ])('promotes native DXF to $version when only associated text requires it', ({ appearance, version, code, value }) => {
    const source = onlyLeader(readDxf(leaderDxf()));
    const leader: LeaderEntity = { ...source, layer: '0', color: 'ByLayer', trueColor: undefined, colorName: undefined, transparency: undefined, textLayer: '0', textAppearance: appearance };
    const state = new Drawing({ entities: [leader] }).snapshot;
    const native = writeDxf(state);
    expect(nativeVersion(native)).toBe(version);
    const text = nativeRecords(native, 'MTEXT')[0]!, line = nativeRecords(native, 'LEADER')[0]!;
    expect(values(text, code)).toEqual([value]); expect(values(line, code)).toEqual([]);
    expect(onlyLeader(readDxf(native)).textAppearance).toMatchObject(appearance);
  });
});
