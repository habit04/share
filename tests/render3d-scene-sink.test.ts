import { describe, it, expect } from 'vitest';
import type { BlockDef, Entity, Layer } from '../src/core/entities';
import { DEFAULT_LAYERS, type DrawingState } from '../src/core/document';
import { emitDrawingUnderlay, emitEntity } from '../src/render3d/scene-sink';
import { SegmentCollector } from './helpers/segment-collector';
import { LineBatchBuilder, featureEdges, gridLines, gridSpec, parseCssColor, solidDisplayColor, solidVertices } from '../src/render3d/scene-data';
import { boxMesh, cylinderMesh, sphereMesh } from '../src/model3d/primitives';
import { v3 } from '../src/model3d/math';

const layers: Layer[] = [
  { name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 },
  { name: 'RED', color: 1, visible: true, locked: false, lineWeight: 0.25 },
  { name: 'OFF', color: 3, visible: false, locked: false, lineWeight: 0.25 },
  { name: 'FROZEN', color: 3, visible: true, frozen: true, locked: false, lineWeight: 0.25 },
  { name: 'TRUE', color: 5, trueColor: 0x123456, visible: true, locked: false, lineWeight: 0.25 },
];
const state = (entities: Entity[], blocks: Record<string, BlockDef> = {}): DrawingState => ({ entities, layers, blocks, currentLayer: '0' });
const collect = (entities: Entity[], blocks: Record<string, BlockDef> = {}) => {
  const sink = new SegmentCollector();
  const n = emitDrawingUnderlay(state(entities, blocks), sink);
  return { segs: sink.segments, n };
};

describe('SceneSink adapter: 2D entities on z = 0', () => {
  it('a line becomes one segment on z = 0 in its layer colour', () => {
    const { segs, n } = collect([{ id: 'l1', type: 'line', layer: 'RED', color: 'ByLayer', a: { x: 1, y: 2 }, b: { x: 4, y: 6 } }]);
    expect(n).toBe(1);
    expect(segs).toEqual([{ a: v3(1, 2, 0), b: v3(4, 6, 0), style: { color: '#ff0000', layer: 'RED', entityId: 'l1' } }]);
  });

  it('uses the entity colour over the layer colour and layer true colours', () => {
    const { segs } = collect([
      { id: 'a', type: 'line', layer: 'RED', color: 3, a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
      { id: 'b', type: 'line', layer: 'TRUE', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
    ]);
    expect(segs.map((s) => s.style.color)).toEqual(['#00ff00', '#123456']);
  });

  it('tessellates circles and arcs into closed / open chains on z = 0', () => {
    const { segs } = collect([
      { id: 'c', type: 'circle', layer: '0', color: 'ByLayer', center: { x: 5, y: 5 }, radius: 2 },
      { id: 'a', type: 'arc', layer: '0', color: 'ByLayer', center: { x: 0, y: 0 }, radius: 1, startAngle: 0, endAngle: Math.PI / 2 },
    ]);
    const circle = segs.filter((s) => s.style.entityId === 'c');
    const arc = segs.filter((s) => s.style.entityId === 'a');
    expect(circle.length).toBeGreaterThanOrEqual(32);
    for (const s of circle) {
      expect(s.a.z).toBe(0);
      expect(Math.hypot(s.a.x - 5, s.a.y - 5)).toBeCloseTo(2, 9);
    }
    // Closed: the chain ends where it starts.
    expect(circle[circle.length - 1]!.b.x).toBeCloseTo(circle[0]!.a.x, 9);
    expect(circle[circle.length - 1]!.b.y).toBeCloseTo(circle[0]!.a.y, 9);
    expect(arc[0]!.a.x).toBeCloseTo(1, 9);
    expect(arc[arc.length - 1]!.b.y).toBeCloseTo(1, 9);
  });

  it('closed polylines close, open ones do not', () => {
    const pts = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }];
    const open = collect([{ id: 'o', type: 'polyline', layer: '0', color: 'ByLayer', points: pts, closed: false }]).segs;
    const closed = collect([{ id: 'c', type: 'polyline', layer: '0', color: 'ByLayer', points: pts, closed: true }]).segs;
    expect(open).toHaveLength(2);
    expect(closed).toHaveLength(3);
    expect(closed[2]).toMatchObject({ a: v3(2, 1, 0), b: v3(0, 0, 0) });
  });

  it('skips entities on off and frozen layers, also inside blocks', () => {
    const block: BlockDef = {
      name: 'B', basePoint: { x: 0, y: 0 }, attributes: [],
      entities: [
        { id: 'in1', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
        { id: 'in2', type: 'line', layer: 'OFF', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 0, y: 1 } },
      ],
    };
    const { segs, n } = collect([
      { id: 'off', type: 'line', layer: 'OFF', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
      { id: 'fr', type: 'line', layer: 'FROZEN', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
      { id: 'ins', type: 'insert', layer: 'RED', color: 'ByLayer', block: 'B', position: { x: 10, y: 20 }, rotation: 0, scale: 2, attributes: {} },
    ], { B: block });
    expect(n).toBe(1);
    expect(segs).toHaveLength(1);
    // Block content is placed by the insert and keeps the insert's id for highlighting.
    expect(segs[0]).toMatchObject({ a: v3(10, 20, 0), b: v3(12, 20, 0), style: { entityId: 'ins' } });
  });

  it('text is drawn as stroke-font segments inside its box, or as the box when over budget', () => {
    const text: Entity = { id: 't', type: 'text', layer: '0', color: 'ByLayer', position: { x: 3, y: 4 }, text: 'AB', height: 1, rotation: 0, align: 'left' };
    const strokes = collect([text]).segs;
    expect(strokes.length).toBeGreaterThan(4);
    for (const s of strokes) {
      for (const p of [s.a, s.b]) {
        expect(p.z).toBe(0);
        expect(p.x).toBeGreaterThanOrEqual(3 - 1e-9);
        expect(p.x).toBeLessThanOrEqual(3 + 2);
        expect(p.y).toBeGreaterThanOrEqual(4 - 1e-9);
        expect(p.y).toBeLessThanOrEqual(5 + 1e-9);
      }
    }
    const sink = new SegmentCollector();
    emitDrawingUnderlay(state([text]), sink, { maxTextSegments: 0 });
    expect(sink.segments).toHaveLength(4);
  });

  it('hatches are their boundary loops', () => {
    const { segs } = collect([{ id: 'h', type: 'hatch', layer: '0', color: 'ByLayer', pattern: 'ANSI31', solid: false, angle: 0, scale: 1, loops: [{ points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }] }] }]);
    expect(segs).toHaveLength(4);
  });

  it('points are a small cross; empty text emits nothing', () => {
    const sink = new SegmentCollector();
    emitEntity({ id: 'p', type: 'point', layer: '0', color: 'ByLayer', position: { x: 1, y: 1 } }, sink, layers, () => undefined);
    emitEntity({ id: 't', type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, text: '  ', height: 1, rotation: 0, align: 'left' }, sink, layers, () => undefined);
    expect(sink.segments).toHaveLength(2);
  });

  it('works on the default layer table', () => {
    const sink = new SegmentCollector();
    emitDrawingUnderlay({ entities: [{ id: 'w', type: 'line', layer: 'WIRES', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }], layers: DEFAULT_LAYERS, blocks: {}, currentLayer: '0' }, sink);
    expect(sink.segments).toHaveLength(1);
  });
});

describe('3D scene data', () => {
  it('parses CSS colours', () => {
    expect(parseCssColor('#ff8000')).toEqual([1, 128 / 255, 0, 1]);
    expect(parseCssColor('#0f0')).toEqual([0, 1, 0, 1]);
    expect(parseCssColor('rgba(255, 0, 0, 0.5)')).toEqual([1, 0, 0, 0.5]);
    expect(parseCssColor('nonsense', [0, 0, 0, 1])).toEqual([0, 0, 0, 1]);
  });

  it('resolves solid colours like 2D entities', () => {
    expect(solidDisplayColor({ layer: 'RED', color: 'ByLayer' }, layers)).toBe('#ff0000');
    expect(solidDisplayColor({ layer: 'RED', color: 4 }, layers)).toBe('#00ffff');
    expect(solidDisplayColor({ layer: 'TRUE', color: 'ByLayer' }, layers)).toBe('#123456');
    expect(solidDisplayColor({ layer: 'missing', color: 0 }, layers)).toBe('#ffffff');
  });

  it('de-indexes a mesh with per-triangle normals relative to its centre', () => {
    const mesh = boxMesh(2, 4, 6);
    const sv = solidVertices(mesh);
    expect(sv.vertexCount).toBe(36);
    expect(sv.origin).toEqual(v3(0, 0, 3));
    // First triangle is the bottom face: normal -Z on all three corners.
    for (let k = 0; k < 3; k++) expect(Array.from(sv.data.slice(k * 6 + 3, k * 6 + 6))).toEqual([0, 0, -1]);
    expect(sv.data[2]).toBe(-3);
  });

  it('finds feature edges: 12 on a box, only the rims on a cylinder, none on a sphere', () => {
    expect(featureEdges(boxMesh(1, 1, 1), v3(0, 0, 0)).length / 6).toBe(12);
    expect(featureEdges(cylinderMesh(1, 2, 16), v3(0, 0, 0)).length / 6).toBe(32);
    expect(featureEdges(sphereMesh(1, 32, 16), v3(0, 0, 0)).length).toBe(0);
  });

  it('builds an adaptive grid with at least 10 px minor spacing and bounded line count', () => {
    const fine = gridSpec(3, 4, 10, 0.5, 100)!;
    expect(fine.minor).toBe(0.5);
    expect(fine.major).toBe(2.5);
    const coarse = gridSpec(0, 0, 1000, 0.5, 1)!;
    expect(coarse.minor * 1).toBeGreaterThanOrEqual(10);
    expect((2 * coarse.half) / coarse.minor).toBeLessThanOrEqual(400 + 10);
    expect(gridSpec(0, 0, 10, 0, 10)).toBeNull();
    const lines = gridLines(fine);
    expect(lines.vertexCount).toBeGreaterThan(0);
    expect(lines.bounds!.min.z).toBe(0);
  });

  it('packs line batches relative to their bounds centre', () => {
    const b = new LineBatchBuilder();
    b.add(v3(100, 200, 0), v3(102, 200, 0), [1, 0, 0, 1]);
    b.polygon([v3(100, 202, 0), v3(102, 202, 0), v3(101, 203, 0)], { color: '#00ff00', layer: '0', entityId: 'x' });
    b.add(v3(NaN, 0, 0), v3(1, 1, 1), [1, 1, 1, 1]);
    expect(b.segmentCount).toBe(4);
    const built = b.build();
    expect(built.origin).toEqual(v3(101, 201.5, 0));
    expect(built.vertexCount).toBe(8);
    expect(Array.from(built.data.slice(0, 7))).toEqual([-1, -1.5, 0, 1, 0, 0, 1]);
  });
});
