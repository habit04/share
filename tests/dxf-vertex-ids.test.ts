/**
 * LWPOLYLINE persistent vertex identifiers (DXF group 91) — Q11 F4.
 *
 * AutoCAD's ASSOC geom dependencies address polyline vertices by these IDs;
 * dropping them (the pre-fix behavior: the reader never parsed group 91 and
 * the model had no vertex-ID concept) left Q12's constraint web unsolvable
 * after a JCad save — the property set, the geometry never re-evaluated.
 * The lead's Windows probes proved the IDs necessary and sufficient.
 *
 * Rules pinned here: IDs are carried reader -> model -> writer VERBATIM
 * (position after the vertex's group-20, AutoCAD's 9-char right-justified
 * value field); they are NEVER synthesized — a vertex or polyline without
 * IDs writes byte-identically to the pre-fix writer.
 */
import { describe, expect, it } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import { moveGrip, type PolylineEntity } from '../src/core/entities';
import { readDxf, writeDxf } from '../src/io/dxf';

/** Raw lines of every LWPOLYLINE entity span in a DXF text. */
function lwSpans(text: string): string[][] {
  const lines = text.split('\r\n');
  const spans: string[][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i]!.trim() === '0' && lines[i + 1]!.trim() === 'LWPOLYLINE') {
      const span = [lines[i]!, lines[i + 1]!];
      for (let j = i + 2; j + 1 < lines.length; j += 2) {
        if (lines[j]!.trim() === '0') break;
        span.push(lines[j]!, lines[j + 1]!);
      }
      spans.push(span);
    }
  }
  return spans;
}

/** Line index of the first LWPOLYLINE's opening code line in a DXF text. */
function lwSpanStart(text: string): number {
  const lines = text.split('\r\n');
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i]!.trim() === '0' && lines[i + 1]!.trim() === 'LWPOLYLINE') return i;
  }
  throw new Error('no LWPOLYLINE');
}

/**
 * Splice AutoCAD-shaped group-91 pairs (9-char value field, after each
 * group-20) into the first LWPOLYLINE of a text — the construction of the
 * lead's sufficiency probe. Returns the new text and the spliced span lines.
 */
function spliceIds(text: string): { text: string; span: string[] } {
  const lines = text.split('\r\n');
  const start = lwSpanStart(text);
  const span = lwSpans(text)[0]!;
  const spliced: string[] = [];
  let id = 0;
  for (let i = 0; i + 1 < span.length; i += 2) {
    spliced.push(span[i]!, span[i + 1]!);
    if (span[i]!.trim() === '20') spliced.push('91', String(++id).padStart(9));
  }
  return { text: [...lines.slice(0, start), ...spliced, ...lines.slice(start + span.length)].join('\r\n'), span: spliced };
}

/** (code, raw value) pairs of one span. */
const spanPairs = (span: string[]): Array<[number, string]> => {
  const out: Array<[number, string]> = [];
  for (let i = 0; i + 1 < span.length; i += 2) out.push([parseInt(span[i]!.trim(), 10), span[i + 1]!]);
  return out;
};

const stateWith = (entities: DrawingState['entities']): DrawingState => new Drawing({ entities }).snapshot;

const plate = (extra: Partial<PolylineEntity> = {}): PolylineEntity => ({
  id: 'p1', layer: '0', color: 'ByLayer', type: 'polyline',
  points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }],
  closed: true, ...extra,
});

describe('DXF LWPOLYLINE group-91 vertex identifiers (Q11 F4)', () => {
  it('writer emits a carried ID after the vertex point, value right-justified in the 9-char field; vertices without IDs get none', () => {
    const text = writeDxf(stateWith([plate({ vertexIds: [7, undefined, 12, undefined] })]));
    const pairs = spanPairs(lwSpans(text)[0]!);
    const vertexGroups = pairs.filter(([c]) => c === 10 || c === 20 || c === 91);
    expect(vertexGroups).toEqual([
      [10, '0'], [20, '0'], [91, '        7'],
      [10, '100'], [20, '0'],
      [10, '100'], [20, '60'], [91, '       12'],
      [10, '0'], [20, '60'],
    ]);
    // Read back: the model carries exactly the same sparse IDs.
    const back = readDxf(text).entities[0] as PolylineEntity;
    expect(back.vertexIds).toEqual([7, undefined, 12, undefined]);
  });

  it('reader takes group 91 from raw DXF text into the model, and the re-write reproduces the pairs byte-identically', () => {
    // Splice AutoCAD-shaped 91 pairs (9-char field, after each group-20) into an
    // ID-free write — the same construction as the lead's sufficiency probe.
    const plain = writeDxf(stateWith([plate()]));
    const { text: withIds, span: spliced } = spliceIds(plain);
    const read = readDxf(withIds).entities[0] as PolylineEntity;
    expect(read.type).toBe('polyline');
    expect(read.vertexIds).toEqual([1, 2, 3, 4]);
    const rewritten = writeDxf(readDxf(withIds));
    expect(spanPairs(lwSpans(rewritten)[0]!)).toEqual(spanPairs(spliced));
  });

  it('no fabrication: an ID-free polyline writes byte-identically to the pre-fix writer', () => {
    // Pair sequences captured from the writer BEFORE the F4 change; any
    // synthesized group-91 (or any other drift) breaks these bytes.
    const text = writeDxf(stateWith([
      plate(),
      { id: 'p2', layer: '0', color: 'ByLayer', type: 'polyline', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: false, bulges: [0, 0.5, 0], widths: [{ start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 4 }] } as PolylineEntity,
    ]));
    const spans = lwSpans(text);
    expect(spans[0]).toEqual(['0', 'LWPOLYLINE', '5', '11B', '330', '1F', '100', 'AcDbEntity', '8', '0', '100', 'AcDbPolyline', '90', '4', '70', '1', '10', '0', '20', '0', '10', '100', '20', '0', '10', '100', '20', '60', '10', '0', '20', '60']);
    expect(spans[1]).toEqual(['0', 'LWPOLYLINE', '5', '11C', '330', '1F', '100', 'AcDbEntity', '8', '0', '100', 'AcDbPolyline', '90', '3', '70', '0', '10', '0', '20', '0', '40', '1', '41', '2', '10', '10', '20', '0', '40', '2', '41', '3', '42', '0.5', '10', '10', '20', '10', '40', '3', '41', '4']);
    expect(text.split('\r\n').filter((l) => l.trim() === '91')).toHaveLength(0);
    // Model-created polylines carry no vertexIds field at all.
    expect((readDxf(text).entities[0] as PolylineEntity).vertexIds).toBeUndefined();
  });

  it('a vertex-ID-carrying donut is NOT converted to a filled circle on read (the IDs are the constraint web\u2019s addresses)', () => {
    // The filled-circle write IS the zero-hole donut form (2 bulge-1 vertices,
    // constant width); without IDs it reads back as a filled circle (existing
    // behavior), with IDs the conversion must not fire — a circle has no
    // vertices for the web to address.
    const donutText = writeDxf(stateWith([{ id: 'c1', layer: '0', color: 'ByLayer', type: 'circle', center: { x: 50, y: 30 }, radius: 20, filled: true }]));
    const asCircle = readDxf(donutText).entities[0]!;
    expect(asCircle.type).toBe('circle');
    const { text: withIds } = spliceIds(donutText);
    const read = readDxf(withIds).entities[0] as PolylineEntity;
    expect(read.type).toBe('polyline');
    expect(read.vertexIds).toEqual([1, 2]);
  });

  it('a pure grip move keeps every vertex ID (the moved vertex keeps its own)', () => {
    const e = plate({ vertexIds: [1, 2, 3, 4] });
    const moved = moveGrip(e, 1, { x: 140, y: 5 }) as PolylineEntity;
    expect(moved.points[1]).toEqual({ x: 140, y: 5 });
    expect(moved.vertexIds).toEqual([1, 2, 3, 4]);
  });
});
