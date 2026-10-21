/**
 * P31 canonicalizer acceptance tests (stage 2 of the P31 continuation).
 *
 * The digest definition under test is PROPOSAL-P31 as dispositioned by
 * RULING-P31 G1–G7 (see src/project/canonical-digest.ts, whose header carries
 * the full written spec).
 *
 * G6 disposition history, recorded per the ruling (the spec must state the
 * id/cadIdentity disposition BEFORE the gate runs; the recorded fallback
 * engages if the gate refutes id stability — it did):
 * - Primary disposition, as first filed: entity `id` digested as a field AND
 *   the ordering key within a space; `cadIdentity` digested as a field.
 * - Gate evidence (2026-10-21, continuation audit): with the header table
 *   repaired, two successive writeDxf -> readDxf imports of the same state
 *   produce canonical strings whose FIRST difference is the first entity's
 *   `id` — the DXF reader mints ids with newId() (session-random) on every
 *   import (src/io/dxf/read-core.ts), so ids are stable neither for ordering
 *   nor for inclusion. The primary disposition is REFUTED by the real round
 *   trip, and the ruling's recorded fallback is IN FORCE: entities digest in
 *   stored-sequence order within each space; `id` and `cadIdentity` are
 *   EXCLUDED from the digest (session-local identity and writer-assigned
 *   handles are not content). These tests encode the fallback.
 */
import { describe, expect, it } from 'vitest';
import { canonicalDrawingString, drawingContentDigest } from '../src/project/canonical-digest';
import { capturePreservedSignature, verifyPreservedSignature } from '../src/project/drawing-signature';
import { readDxf } from '../src/io/dxf/reader';
import { writeDxf } from '../src/io/dxf/writer';
import type { DrawingState } from '../src/core/document';
import type { Entity, Layer } from '../src/core/entities';
import type { DimStyle } from '../src/core/dimension';

const layer0: Layer = { name: '0', color: 7, visible: true, locked: false, lineWeight: -1 };

const dimStyle: DimStyle = {
  name: 'STD', textHeight: 2.5, arrowSize: 2.5, extOffset: 1, extExtend: 2, textGap: 1,
  centerMark: 2, scale: 1, decimals: 2, lunit: 2, angularDecimals: 1, baselineSpacing: 8,
  dimLineExtend: 0, suppressDimLine1: false, suppressDimLine2: false, suppressExt1: false,
  suppressExt2: false, dimLineColor: 0, extLineColor: 0, dimLineWeight: -1, extLineWeight: -1,
  arrow: 'closed', arrow2: 'closed', textVertical: 'above', textAlign: 'aligned',
  textJustify: 'centered', textColor: 0, textStyle: 'Standard', fit: 'text', textInside: true,
  dimLineInside: false, post: '', round: 0, linearFactor: 1, suppressLeadingZeros: false,
  suppressTrailingZeros: false, decimalSeparator: 46, altUnits: false, altFactor: 25.4,
  altDecimals: 2, altLunit: 2, altPost: '', altPlacement: 'after', tolerance: 'none',
  tolPlus: 0, tolMinus: 0, tolDecimals: 2, tolScale: 1, toleranceZeroSuppression: 0,
};

const minimalState = (over: Partial<DrawingState> = {}): DrawingState => ({
  entities: [],
  layers: [layer0],
  blocks: {},
  currentLayer: '0',
  ...over,
});

const line = (id: string, x2 = 10): Entity => ({
  id, type: 'line', layer: '0', color: 'ByLayer',
  a: { x: 0, y: 0 }, b: { x: x2, y: 5 },
});

const firstDiff = (a: string, b: string): string => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return `first difference at index ${i}: …${a.slice(Math.max(0, i - 40), i + 40)}… VS …${b.slice(Math.max(0, i - 40), i + 40)}…`;
  }
  return `common prefix, lengths ${a.length} vs ${b.length}`;
};

describe('canonical digest — definition (RULING-P31 G1–G7)', () => {
  it('produces a 64-char lowercase hex digest, deterministic across calls', () => {
    const s = minimalState({ entities: [line('e1')] });
    const d = drawingContentDigest(s);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(drawingContentDigest(s)).toBe(d);
    expect(canonicalDrawingString(s)).toBe(canonicalDrawingString(s));
  });

  it('is insensitive to property insertion order (tables fix the order, G4)', () => {
    const a = minimalState({ entities: [line('e1')] });
    const reordered = {
      b: { y: 5, x: 10 }, a: { y: 0, x: 0 },
      color: 'ByLayer', layer: '0', type: 'line', id: 'e1',
    } as unknown as Entity;
    const b = minimalState({ entities: [reordered] });
    expect(drawingContentDigest(b)).toBe(drawingContentDigest(a));
  });

  it('digests entities in stored-sequence order within a space (G6 fallback in force)', () => {
    // Under the fallback, stored sequence is the order: a permutation of the
    // same entities is different stored content and digests differently.
    const a = minimalState({ entities: [line('e1'), line('e2', 20), line('e3', 30)] });
    const b = minimalState({ entities: [line('e3', 30), line('e1'), line('e2', 20)] });
    expect(drawingContentDigest(b)).not.toBe(drawingContentDigest(a));
    expect(drawingContentDigest(a)).toBe(drawingContentDigest(minimalState({
      entities: [line('e1'), line('e2', 20), line('e3', 30)],
    })));
  });

  it('does NOT change for entity id or cadIdentity (G6 fallback: session identity is not content)', () => {
    const a = minimalState({ entities: [line('e1'), line('e2', 20)] });
    const renamed = minimalState({
      entities: [
        { ...line('e1'), id: 'session-x-1', cadIdentity: '2F' },
        { ...line('e2', 20), id: 'session-x-2', cadIdentity: '31' },
      ],
    });
    expect(drawingContentDigest(renamed)).toBe(drawingContentDigest(a));
  });

  it('orders blocks by name regardless of record insertion order (G6)', () => {
    const block = (name: string) => ({
      name, basePoint: { x: 0, y: 0 }, entities: [line(`${name}-1`)], attributes: [],
    });
    const a = minimalState({ blocks: { B: block('B'), A: block('A') } });
    const b = minimalState({ blocks: { A: block('A'), B: block('B') } });
    expect(drawingContentDigest(b)).toBe(drawingContentDigest(a));
  });

  it('changes when digested content changes (entity geometry, layer, currentLayer, space)', () => {
    const base = minimalState({ entities: [line('e1')] });
    const d0 = drawingContentDigest(base);
    expect(drawingContentDigest(minimalState({ entities: [line('e1', 11)] }))).not.toBe(d0);
    expect(drawingContentDigest(minimalState({
      entities: [line('e1')],
      layers: [{ ...layer0, color: 3 }],
    }))).not.toBe(d0);
    expect(drawingContentDigest(minimalState({ entities: [line('e1')], currentLayer: 'X' })))
      .not.toBe(d0);
    expect(drawingContentDigest(minimalState({
      entities: [line('e1')], space: { layout: 'Layout1' },
    }))).not.toBe(d0);
  });

  it('does NOT change for display-only entity fields (G5: exactly colorLayer/transparencyLayer)', () => {
    const plain = minimalState({ entities: [line('e1')] });
    const decorated = minimalState({
      entities: [{ ...line('e1'), colorLayer: 'SOMEWHERE', transparencyLayer: 'OTHER' } as Entity],
    });
    expect(drawingContentDigest(decorated)).toBe(drawingContentDigest(plain));
  });

  it('does NOT change for excluded state: signatureRecord, cadGraph, meta, model3d, constraints (G1–G3)', () => {
    const plain = minimalState({ entities: [line('e1')] });
    const d0 = drawingContentDigest(plain);
    const withMeta = minimalState({
      entities: [line('e1')],
      meta: { author: 'someone', producer: 'test' },
    } as DrawingState);
    expect(drawingContentDigest(withMeta)).toBe(d0);
    const withRecord = {
      ...plain,
      signatureRecord: capturePreservedSignature({
        payload: new Uint8Array([1, 2, 3]), contentDigest: d0, sourceFormat: 'DXF',
      }),
    } as DrawingState;
    expect(drawingContentDigest(withRecord)).toBe(d0);
  });

  it('throws on non-finite numbers — fail closed, no digest is produced (G7)', () => {
    const nan = minimalState({ entities: [{ ...line('e1'), a: { x: Number.NaN, y: 0 } } as Entity] });
    expect(() => drawingContentDigest(nan)).toThrow();
    const inf = minimalState({ header: { ltscale: Number.POSITIVE_INFINITY } } as Partial<DrawingState>);
    expect(() => drawingContentDigest(inf)).toThrow();
  });

  it('pins number encoding to JSON.stringify semantics (G7): -0 digests as 0', () => {
    const negZero = minimalState({ entities: [{ ...line('e1'), a: { x: -0, y: 0 } } as Entity] });
    const posZero = minimalState({ entities: [line('e1')] });
    expect(drawingContentDigest(negZero)).toBe(drawingContentDigest(posZero));
  });

  it('throws on a stored field missing from its allowlist table — never a silent drop (G4)', () => {
    const entityExtra = minimalState({
      entities: [{ ...line('e1'), mysteryField: 1 } as unknown as Entity],
    });
    expect(() => drawingContentDigest(entityExtra)).toThrow(/mysteryField/);
    const layerExtra = minimalState({
      layers: [{ ...layer0, mysteryField: 1 } as unknown as Layer],
    });
    expect(() => drawingContentDigest(layerExtra)).toThrow(/mysteryField/);
    const stateExtra = { ...minimalState(), mysteryField: 1 } as unknown as DrawingState;
    expect(() => drawingContentDigest(stateExtra)).toThrow(/mysteryField/);
  });

  it('throws on non-plain values (no silent stringification of class instances)', () => {
    const withDate = minimalState({
      entities: [{ ...line('e1'), a: new Date(0) } as unknown as Entity],
    });
    expect(() => drawingContentDigest(withDate)).toThrow();
  });
});

describe('canonical digest — maximally populated fixtures (G4 completeness)', () => {
  it('digests one populated entity of every variant without throwing', () => {
    const entities: Entity[] = [
      line('v-line'),
      { id: 'v-circle', type: 'circle', layer: '0', color: 3, center: { x: 1, y: 1 }, radius: 4, filled: true, linetype: 'DASHED', lineWeight: 25, ltscale: 2, trueColor: 0x102030, colorName: 'Book$Teal', transparency: 64, annotative: true, cadIdentity: 'A1' },
      { id: 'v-arc', type: 'arc', layer: '0', color: 'ByLayer', center: { x: 0, y: 0 }, radius: 5, startAngle: 0.1, endAngle: 2.2 },
      { id: 'v-poly', type: 'polyline', layer: '0', color: 'ByLayer', points: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }], closed: true, bulges: [0, 0.5, 0], width: 1.5, widths: [{ start: 1, end: 2 }], vertexIds: [11, 12, 13], filled: false },
      { id: 'v-text', type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, firstAlignmentPoint: { x: 0, y: 0 }, text: 'Hello', height: 2.5, rotation: 0.3, align: 'left', widthFactor: 0.8, oblique: 0.1, bold: true, style: 'Standard', justification: { horizontal: 0, vertical: 0 }, alignmentPoint: { x: 1, y: 1 }, field: { native: false, code: '%<\\AcSm Sheet.Number>%', value: 'E-101' } },
      { id: 'v-insert', type: 'insert', layer: '0', color: 'ByLayer', block: 'BLK', position: { x: 1, y: 2 }, rotation: 0.5, scale: 2, scaleY: 3, mirror: true, attributes: { TAG1: 'value1' }, columns: 2, rows: 3, columnSpacing: 10, rowSpacing: 12, hiddenAttributes: ['TAG2'], attributePlacements: { TAG1: { position: { x: 0, y: 0 }, height: 2.5, align: 'left', rotation: 0.2, layer: '0', color: 2, trueColor: 0x505050, colorName: 'Book$Gray', transparency: 8, style: 'Standard' } }, dynamic: { block: 'BLK', values: { Length: { kind: 'distance', value: 42 }, Flip: { kind: 'flip', value: true }, Vis: { kind: 'visibility', value: 'Shown' }, Look: { kind: 'lookup', value: null }, Opq: { kind: 'opaque', payload: 'AA==' }, Ang: { kind: 'angle', value: 1.5 } } } },
      { id: 'v-ellipse', type: 'ellipse', layer: '0', color: 'ByLayer', center: { x: 0, y: 0 }, majorAxis: { x: 6, y: 0 }, ratio: 0.5, startParam: 0, endParam: 3.1 },
      { id: 'v-point', type: 'point', layer: '0', color: 'ByLayer', position: { x: 7, y: 8 } },
      { id: 'v-xline', type: 'xline', layer: '0', color: 'ByLayer', base: { x: 0, y: 0 }, direction: { x: 1, y: 0 } },
      { id: 'v-ray', type: 'ray', layer: '0', color: 'ByLayer', base: { x: 0, y: 0 }, direction: { x: 0, y: 1 } },
      { id: 'v-spline', type: 'spline', layer: '0', color: 'ByLayer', degree: 3, knots: [0, 0, 0, 0, 1, 1, 1, 1], controlPoints: [{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 3, y: 2 }, { x: 4, y: 0 }], weights: [1, 1, 1, 1], fitPoints: [{ x: 0, y: 0 }, { x: 4, y: 0 }], closed: false, periodic: false, startTangent: { x: 1, y: 0 }, endTangent: { x: -1, y: 0 } },
      { id: 'v-hatch', type: 'hatch', layer: '0', color: 'ByLayer', pattern: 'ANSI31', solid: false, angle: 0.785, scale: 2, origin: { x: 0, y: 0 }, loops: [{ points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }], bulges: [0, 0, 0] }], patternLines: [{ angle: 0.785, base: { x: 0, y: 0 }, offset: { x: 0, y: 3 }, dashes: [2, -1] }], associative: false, style: 0, patternType: 1, double: false, gradient: { name: 'Linear', angle: 0, shift: 0, singleColor: false, tint: 0.5, colors: [{ position: 0, color: 1 }, { position: 1, color: 5, trueColor: 0x202020 }], kind: 1, reserved: 0, colorMode: 0, colorCount: 2 }, gradientFrame: { origin: { x: 0, y: 0 }, x: { x: 1, y: 0 }, y: { x: 0, y: 1 } } },
      { id: 'v-leader', type: 'leader', layer: '0', color: 'ByLayer', vertices: [{ x: 0, y: 0 }, { x: 5, y: 5 }], arrow: true, arrowSize: 2.5, dogleg: { x: 3, y: 0 }, spline: false, extraPaths: [[{ x: 1, y: 1 }, { x: 6, y: 6 }]], text: 'Note', raw: 'Note', textPosition: { x: 6, y: 5 }, textHeight: 2.5, textAttachment: 5, textWidth: 20, textRotation: 0.1, textBackground: { flags: 1, scale: 1.5, color: 2, trueColor: 0x303030, colorName: 'Book$Red', transparency: 32, colorLayer: '0' }, textAppearance: { layer: 'NOTES', color: 4, trueColor: 0x111111, colorName: 'Book$Ink', transparency: 12, colorLayer: 'SRC', transparencyLayer: 'SRC2' }, textLayer: 'NOTES', textLineSpacing: 1.25, textColumns: { type: 2, count: 2, width: 18, gutter: 4, autoHeight: true, reversed: false, heights: [30] }, kind: 'mleader' },
      { id: 'v-image', type: 'image', layer: '0', color: 'ByLayer', path: 'img.png', position: { x: 0, y: 0 }, u: { x: 1, y: 0 }, v: { x: 0, y: 1 }, size: { x: 100, y: 50 }, clip: [{ x: 0, y: 0 }, { x: 10, y: 10 }], clipOn: true, flags: 3, brightness: 50, contrast: 50, fade: 0 },
      { id: 'v-mtext', type: 'mtext', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, text: 'Body', height: 2.5, width: 40, rotation: 0, attachment: 1, lineSpacing: 1.5, style: 'Standard', columns: { type: 2, count: 2, width: 18, gutter: 4, autoHeight: false, reversed: false, heights: [30, 30] }, background: { flags: 1, scale: 1.5, color: 2, trueColor: 0x303030, colorName: 'Book$Red', transparency: 32, colorLayer: '0' } },
      { id: 'v-dim', type: 'dimension', layer: '0', color: 'ByLayer', kind: 'linear', p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, linePoint: { x: 0, y: -5 }, rotation: 0, ordinateAxis: 'x', ordinateRotation: 0, center: { x: 0, y: 0 }, text: '10.00', textPosition: { x: 5, y: -5 }, textRotation: 0, oblique: 0, style: dimStyle, styleOverrides: { DIMTXT: 3 } },
      { id: 'v-table', type: 'table', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, rotation: 0, rowHeights: [8, 8], columnWidths: [30, 30], cells: [[{ text: 'A1', height: 2.5, attachment: 5, span: { rows: 1, cols: 2 } }, { text: 'B1', raw: 'B1' }], [{ text: 'A2' }, { text: 'B2' }]], textHeight: 2.5, margin: 1.5 },
    ];
    const state = minimalState({ entities });
    expect(() => drawingContentDigest(state)).not.toThrow();
    expect(drawingContentDigest(state)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('digests a populated header, block (with dynamic definition) and layout without throwing', () => {
    const state = minimalState({
      entities: [line('e1')],
      blocks: {
        DYN: {
          name: 'DYN', basePoint: { x: 0, y: 0 },
          entities: [line('inner-1')],
          attributes: [{
            tag: 'TAG1', prompt: 'Enter', default: 'DEF', invisible: false, style: 'Standard',
            position: { x: 0, y: 0 }, height: 2.5, align: 'left', rotation: 0,
            layer: '0', color: 2, trueColor: 0x404040, colorName: 'Book$Blue', transparency: 16,
          }],
          description: 'A dynamic block',
          xref: { path: 'xref.dwg', overlay: true },
          dynamic: {
            version: 1,
            parameters: [
              { kind: 'linear-distance', id: 'p1', name: 'Length', basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, defaultValue: 10, constraint: { kind: 'range', min: 1, max: 99 }, grips: [{ role: 'base', movesWithValue: false }, { role: 'value', movesWithValue: true }] },
              { kind: 'linear-distance', id: 'p1b', name: 'Step', basePoint: { x: 0, y: 0 }, direction: { x: 0, y: 1 }, defaultValue: 5, constraint: { kind: 'increment', min: 0, max: 50, increment: 5 }, grips: [] },
              { kind: 'linear-distance', id: 'p1c', name: 'Choice', basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, defaultValue: 12, constraint: { kind: 'list', values: [6, 12, 24] }, grips: [] },
              { kind: 'angle', id: 'p1d', name: 'Swing', basePoint: { x: 0, y: 0 }, defaultValue: 0.5, constraint: { kind: 'range', min: 0, max: 3 }, grips: [{ role: 'value', movesWithValue: true }] },
              { kind: 'flip', id: 'p1e', name: 'Handed', basePoint: { x: 0, y: 0 }, defaultValue: false },
              { kind: 'visibility', id: 'p2', name: 'Vis', basePoint: { x: 0, y: 5 }, defaultState: 'On', states: [{ name: 'On', visible: ['inner-1'] }, { name: 'Off', visible: [] }] },
              { kind: 'lookup', id: 'p3', name: 'Size', basePoint: { x: 5, y: 0 }, inputs: ['Length'], defaultRow: null, rows: [{ name: 'Small', key: { Length: { kind: 'distance', value: 5 } }, assignments: { Vis: { kind: 'visibility', value: 'On' } } }] },
              { kind: 'opaque-parameter', id: 'p4', name: 'Future', sourceKind: 'xy', payload: 'QkxPQg==' },
            ],
            actions: [
              { kind: 'stretch', id: 'a1', name: 'Stretch', parameterId: 'p1', frame: { kind: 'rectangle', min: { x: 0, y: 0 }, max: { x: 10, y: 10 } }, selection: [{ entityId: 'inner-1', points: { kind: 'points', indices: [0, 1] } }], distanceMultiplier: 1, angleOffset: 0 },
              { kind: 'move', id: 'a2', name: 'Move', parameterId: 'p1', selection: [{ entityId: 'inner-1' }] },
              { kind: 'rotate', id: 'a2b', name: 'Rotate', parameterId: 'p1d', center: { x: 0, y: 0 }, selection: [{ entityId: 'inner-1' }] },
              { kind: 'scale', id: 'a2c', name: 'Scale', parameterId: 'p1', basePoint: { x: 0, y: 0 }, selection: [{ entityId: 'inner-1' }] },
              { kind: 'flip', id: 'a2d', name: 'Flip', parameterId: 'p1e', axisA: { x: 0, y: 0 }, axisB: { x: 0, y: 10 }, selection: [{ entityId: 'inner-1' }] },
              { kind: 'array', id: 'a2e', name: 'Array', parameterId: 'p1', selection: [{ entityId: 'inner-1' }], spacing: 12 },
              { kind: 'opaque-action', id: 'a3', name: 'Mystery', parameterId: 'p1', sourceKind: 'grip-edit', payload: 'AAAA' },
            ],
            alignment: { basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, mode: 'perpendicular' },
          },
          dynamicRetained: 'RAW-PAYLOAD',
        },
      },
      header: {
        units: { lunits: 2, luprec: 4, insunits: 1, auprec: 2, aunits: 0 },
        ltscale: 1,
        limits: { min: { x: 0, y: 0 }, max: { x: 420, y: 297 } },
        pdmode: 0, pdsize: 0,
        dimStyle,
        linetypes: [{
          name: 'DASHED', description: 'Dashed __ ', pattern: [2, -1],
          complex: {
            flags: 2, alignment: 65, totalPatternLength: 3,
            elements: [{ flags: 2, shapeNumber: 5, style: { kind: 'text', name: 'Standard', sourceHandle: '1A' }, scale: 1, rotation: 0, offsetX: 0, offsetY: 0, text: 'X' }],
          },
        }],
        views: [{
          name: 'V1', center: { x: 10, y: 10 }, height: 50, width: 80, twist: 0,
          camera: {
            displayCenter: { x: 10, y: 10 }, direction: { x: 0, y: 0, z: 1 }, target: { x: 0, y: 0, z: 0 },
            width: 80, twist: 0, lensLength: 50, frontClip: 0, backClip: 0, mode: 0, flags: 0,
          },
        }],
        celtype: 'ByLayer', celweight: -1, celtscale: 1, textStyle: 'Standard',
        cannoscale: '1:1', annoAllVisible: true,
      },
      layouts: [{
        name: 'Layout1',
        paper: { id: 'a4', width: 297, height: 210, units: 'mm', orientation: 'landscape' },
        plotScale: 1,
        margins: { left: 10, bottom: 10, right: 10, top: 10 },
        entities: [line('paper-1')],
        viewports: [{
          id: 'vp1', center: { x: 100, y: 100 }, width: 200, height: 150,
          view: { center: { x: 0, y: 0 }, scale: 1, twist: 0, locked: false },
          layer: '0', on: true, frozenLayers: ['X'], clipOn: false,
        }],
        plotStyle: 'monochrome', screening: 100, plotLineweights: true, usePlotStyles: true, pristine: false,
      }],
      space: { layout: 'Layout1', viewport: 'vp1' },
    });
    expect(() => drawingContentDigest(state)).not.toThrow();
    expect(drawingContentDigest(state)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('canonical digest — save/reopen stability GATE (acceptance example 1, state level)', () => {
  const gateSource = (): DrawingState => minimalState({
    entities: [
      line('g-line'),
      { id: 'g-circle', type: 'circle', layer: '0', color: 3, center: { x: 5, y: 5 }, radius: 3 },
      { id: 'g-text', type: 'text', layer: '0', color: 'ByLayer', position: { x: 1, y: 1 }, text: 'Gate', height: 2.5, align: 'left' },
      { id: 'g-poly', type: 'polyline', layer: '0', color: 'ByLayer', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }], closed: true, bulges: [0, 0, 0] },
    ],
    blocks: {
      GATEBLK: { name: 'GATEBLK', basePoint: { x: 0, y: 0 }, entities: [line('g-inner')], attributes: [] },
    },
  });

  it('digest over imported state is EQUAL after a full write/read cycle', () => {
    const imported = readDxf(writeDxf(gateSource()));
    const d1 = drawingContentDigest(imported);
    const reopened = readDxf(writeDxf(imported));
    const d2 = drawingContentDigest(reopened);
    if (d2 !== d1) {
      throw new Error(`digest changed across save/reopen: ${firstDiff(canonicalDrawingString(imported), canonicalDrawingString(reopened))}`);
    }
    expect(d2).toBe(d1);
  });

  it('a record captured over imported state verifies content-match after save/reopen', () => {
    const imported = readDxf(writeDxf(gateSource()));
    const record = capturePreservedSignature({
      payload: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      contentDigest: drawingContentDigest(imported),
      sourceFormat: 'DXF',
    });
    const reopened = readDxf(writeDxf(imported));
    expect(verifyPreservedSignature(record, drawingContentDigest(reopened))).toBe('content-match');
  });

  it('an out-of-band entity change after reopen verifies tampered; an excluded-only change stays content-match (C5)', () => {
    const imported = readDxf(writeDxf(gateSource()));
    const record = capturePreservedSignature({
      payload: new Uint8Array([1, 2, 3]),
      contentDigest: drawingContentDigest(imported),
      sourceFormat: 'DXF',
    });
    // Tamper with the first line entity of the IMPORTED state (imported ids
    // are session-minted, so select by type, not by the source fixture id).
    const lineIndex = imported.entities.findIndex((e) => e.type === 'line');
    expect(lineIndex).toBeGreaterThanOrEqual(0);
    const tampered: DrawingState = {
      ...imported,
      entities: imported.entities.map((e, i) => (i === lineIndex && e.type === 'line'
        ? { ...e, b: { x: e.b.x + 1, y: e.b.y } }
        : e)),
    };
    expect(verifyPreservedSignature(record, drawingContentDigest(tampered))).toBe('tampered');
    const metaOnly = { ...imported, meta: { ...imported.meta, producer: 'changed' } } as DrawingState;
    expect(verifyPreservedSignature(record, drawingContentDigest(metaOnly))).toBe('content-match');
  });
});
