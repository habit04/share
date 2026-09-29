import { describe, it, expect } from 'vitest';
import type { LeaderEntity, MTextEntity } from '../src/core/entities';
import { leaderParts, leaderPath, entityBounds, distanceToEntity, translateEntity, mirrorEntityAcross, scaleEntityBy, gripPoints, moveGrip, snapCandidates, entityTypeName, explodeCompound } from '../src/core/entities';
import { readDxf, writeDxf } from '../src/io/dxf';
import { convertDwg, type DwgImportPayload } from '../src/io/dwg';
import { Drawing } from '../src/core/document';
import { fakeContext, drive } from './fake-context';
import { leaderTool, mleaderTool } from '../src/tools/drafting-annot';

const props = { layer: '0', color: 'ByLayer' as const };
const lookup = () => undefined;
const leader = (over: Partial<LeaderEntity> = {}): LeaderEntity => ({
  id: 'ld',
  ...props,
  type: 'leader',
  vertices: [{ x: 0, y: 0 }, { x: 2, y: 2 }],
  arrow: true,
  arrowSize: 0.18,
  dogleg: { x: 0.36, y: 0 },
  text: 'NOTE 1',
  textPosition: { x: 2.45, y: 2.09 },
  textHeight: 0.18,
  ...over,
});

describe('LEADER entity', () => {
  it('draws a line, a closed arrowhead at the first vertex and the text', () => {
    const parts = leaderParts(leader());
    const line = parts.find((p) => p.type === 'polyline' && !p.filled)!;
    const arrow = parts.find((p) => p.type === 'polyline' && p.filled)!;
    const text = parts.find((p) => p.type === 'mtext') as MTextEntity;
    expect(line.type === 'polyline' && line.points).toHaveLength(3); // with the landing
    expect(arrow.type === 'polyline' && arrow.points[0]).toEqual({ x: 0, y: 0 });
    expect(text.text).toBe('NOTE 1');
    expect(text.attachment).toBe(1);
    expect(leaderPath(leader())[2]).toEqual({ x: 2.36, y: 2 });
  });
  it('bounds, hit test, snaps, grips, transforms, explode', () => {
    const l = leader();
    const b = entityBounds(l, lookup)!;
    expect(b.min.x).toBeCloseTo(0);
    expect(b.max.x).toBeGreaterThan(2.9);
    expect(distanceToEntity({ x: 1, y: 1 }, l, lookup)).toBeCloseTo(0);
    expect(snapCandidates(l, lookup).filter((c) => c.kind === 'endpoint')).toHaveLength(3);
    expect(gripPoints(l)).toHaveLength(4);
    const moved = moveGrip(l, 0, { x: -1, y: 0 }) as LeaderEntity;
    expect(moved.vertices[0]).toEqual({ x: -1, y: 0 });
    const t = translateEntity(l, { x: 1, y: 0 }) as LeaderEntity;
    expect(t.textPosition).toEqual({ x: 3.45, y: 2.09 });
    const s = scaleEntityBy(l, { x: 0, y: 0 }, 2) as LeaderEntity;
    expect(s.textHeight).toBeCloseTo(0.36);
    expect(s.arrowSize).toBeCloseTo(0.36);
    const m = mirrorEntityAcross({ ...l, textAttachment: 1 }, { x: 0, y: 0 }, { x: 0, y: 1 }) as LeaderEntity;
    expect(m.dogleg!.x).toBeCloseTo(-0.36);
    expect(m.textAttachment).toBe(3); // text now reads leftwards of the landing
    expect(entityTypeName(l)).toBe('LEADER');
    expect(entityTypeName({ ...l, kind: 'mleader' })).toBe('MULTILEADER');
    expect(explodeCompound(l)!.map((e) => e.type).sort()).toEqual(['mtext', 'polyline', 'polyline']);
  });
});

describe('LEADER / MLEADER commands', () => {
  it('LEADER: points, then annotation lines; a hook line is added for a sloped last segment', () => {
    const doc = new Drawing();
    const ctx = fakeContext(doc);
    drive(leaderTool(), ctx, [{ x: 0, y: 0 }, { x: 2, y: 2 }, '', 'FIRST', 'SECOND', '']);
    const l = doc.entities[0] as LeaderEntity;
    expect(l.type).toBe('leader');
    expect(l.text).toBe('FIRST\nSECOND');
    expect(l.dogleg).toBeDefined();
    expect(ctx.prompts).toEqual(['Specify leader start point:', 'Specify next point:', 'Specify next point or [Annotation/Format/Undo] <Annotation>:', 'Enter first line of annotation text or <options>:', 'Enter next line of annotation text:', 'Enter next line of annotation text:']);
  });
  it('LEADER Format None removes the arrowhead', () => {
    const doc = new Drawing();
    drive(leaderTool(), fakeContext(doc), [{ x: 0, y: 0 }, { x: 2, y: 0 }, 'F', 'N', '', '']);
    const l = doc.entities[0] as LeaderEntity;
    expect(l.arrow).toBe(false);
    expect(l.text).toBeUndefined();
  });
  it('MLEADER: arrowhead, landing, text', () => {
    const doc = new Drawing();
    const ctx = fakeContext(doc);
    drive(mleaderTool(), ctx, [{ x: 0, y: 0 }, { x: -3, y: 1 }, 'MOTOR M1', '']);
    const l = doc.entities[0] as LeaderEntity;
    expect(l.kind).toBe('mleader');
    expect(l.dogleg!.x).toBeCloseTo(-0.36);
    expect(l.textAttachment).toBe(3);
    expect(l.textPosition!.x).toBeLessThan(-3.36);
    expect(ctx.prompts[0]).toBe('Specify leader arrowhead location or [leader Landing first/Content first/Options] <Options>:');
  });
});

describe('LEADER and MULTILEADER in DXF', () => {
  it('writes LEADER + MTEXT and reads them back as one leader', () => {
    const d = new Drawing();
    d.addEntities([leader({ layer: 'NOTES', color: 2 }), leader({ id: 'ld2', text: undefined, textPosition: undefined, dogleg: undefined, arrowSize: 0.5 })]);
    const text = writeDxf(d.snapshot);
    expect(text).toContain('\r\nLEADER\r\n');
    expect(text).toContain('\r\nMTEXT\r\n');
    const back = readDxf(text);
    const leaders = back.entities.filter((e): e is LeaderEntity => e.type === 'leader');
    expect(leaders).toHaveLength(2);
    expect(back.entities.some((e) => e.type === 'mtext')).toBe(false);
    const [a, b] = leaders as [LeaderEntity, LeaderEntity];
    expect(a.text).toBe('NOTE 1');
    expect(a.textPosition!.x).toBeCloseTo(2.45);
    expect(a.dogleg!.x).toBeCloseTo(0.36);
    expect(a.vertices).toHaveLength(2);
    expect(a.layer).toBe('NOTES');
    expect(b.text).toBeUndefined();
    expect(b.arrowSize).toBeCloseTo(0.5); // DIMASZ override in the ACAD DSTYLE xdata
  });
  it('reads a LEADER without annotation and one pointing at a TEXT', () => {
    const dxf = [
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'TEXT', '5', '2A', '8', '0', '10', '5', '20', '5', '40', '0.2', '1', 'SEE NOTE',
      '0', 'LEADER', '5', '2B', '8', '0', '100', 'AcDbLeader', '3', 'Standard', '71', '1', '73', '0', '76', '2', '10', '0', '20', '0', '10', '4', '20', '5', '340', '2A',
      '0', 'LEADER', '5', '2C', '8', '0', '100', 'AcDbLeader', '71', '0', '73', '3', '76', '3', '10', '0', '20', '0', '10', '1', '20', '0', '10', '1', '20', '1',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const s = readDxf(dxf);
    expect(s.entities).toHaveLength(2);
    const [a, b] = s.entities as [LeaderEntity, LeaderEntity];
    expect(a.text).toBe('SEE NOTE');
    expect(a.textPosition).toEqual({ x: 5, y: 5 });
    expect(b.arrow).toBe(false);
    expect(b.vertices).toHaveLength(3);
  });
  it('reads MULTILEADER context data: leader line, landing, MTEXT content', () => {
    const dxf = [
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'MULTILEADER', '5', '3F', '8', 'ANNO', '100', 'AcDbEntity', '100', 'AcDbMLeader', '270', '2',
      '300', 'CONTEXT_DATA{', '40', '1', '10', '10', '20', '5', '30', '0', '41', '0.25', '140', '0.2', '145', '0.09', '174', '1', '175', '1', '176', '0', '177', '0',
      '290', '1', '304', '{\\C1;PUMP} P-101\\PSTANDBY', '11', '0', '21', '0', '31', '1', '340', '11', '12', '10.5', '22', '5.2', '32', '0', '13', '1', '23', '0', '33', '0', '42', '0', '43', '0', '44', '0', '45', '1', '170', '1', '90', '-1073741824', '171', '1', '172', '5',
      '302', 'LEADER{', '290', '1', '291', '1', '10', '10', '20', '5', '30', '0', '11', '1', '21', '0', '31', '0', '90', '0', '40', '0.36',
      '304', 'LEADER_LINE{', '10', '7', '20', '3', '30', '0', '91', '0', '305', '}',
      '304', 'LEADER_LINE{', '10', '7', '20', '6', '30', '0', '91', '1', '305', '}',
      '303', '}',
      '301', '}',
      '340', '12', '90', '0', '170', '1', '91', '-1056964608', '171', '-2', '290', '1', '291', '1', '41', '0.36', '42', '0.18', '172', '2',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const notes: string[] = [];
    const s = readDxf(dxf, { notes });
    const l = s.entities[0] as LeaderEntity;
    expect(l.type).toBe('leader');
    expect(l.kind).toBe('mleader');
    expect(l.vertices).toEqual([{ x: 7, y: 3 }, { x: 10, y: 5 }]);
    expect(l.extraPaths).toEqual([[{ x: 7, y: 6 }, { x: 10, y: 5 }]]);
    expect(l.dogleg!.x).toBeCloseTo(0.36);
    expect(l.text).toBe('PUMP P-101\nSTANDBY');
    expect(l.raw).toContain('\\C1;');
    expect(l.textPosition).toEqual({ x: 10.5, y: 5.2 });
    expect(l.textHeight).toBeCloseTo(0.25);
    expect(l.arrowSize).toBeCloseTo(0.2);
    // Written back as LEADER + MTEXT (plus a LEADER for the second leader line).
    const out = writeDxf(s);
    expect(out.match(/\r\nLEADER\r\n/g)).toHaveLength(2);
    expect(out).toContain('{\\C1;PUMP} P-101\\PSTANDBY');
  });
  it('degrades gracefully when the MULTILEADER has no context data', () => {
    const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'MULTILEADER', '8', '0', '100', 'AcDbMLeader', '170', '1', '0', 'ENDSEC', '0', 'EOF'].join('\n');
    expect(readDxf(dxf).entities).toHaveLength(0);
  });
});

describe('LEADER / MULTILEADER from DWG', () => {
  it('merges a LEADER with its MTEXT annotation and converts a MULTILEADER', () => {
    const payload: DwgImportPayload = {
      header: {},
      layers: [{ name: '0', colorIndex: 7, off: false, frozen: false, locked: false, lineweight: 29 }],
      blocks: [],
      entities: [
        { type: 'MTEXT', handle: 'M1', layer: '0', text: 'VALVE', insertionPoint: { x: 5, y: 5, z: 0 }, textHeight: 0.2, rectWidth: 0, attachmentPoint: 4 } as never,
        { type: 'LEADER', handle: 'L1', layer: '0', vertices: [{ x: 0, y: 0, z: 0 }, { x: 4, y: 5, z: 0 }], isArrowheadEnabled: true, associatedAnnotation: 'M1' } as never,
        {
          type: 'MULTILEADER',
          handle: 'ML',
          layer: '0',
          textContent: 'TAG',
          textAnchor: { x: 20, y: 1, z: 0 },
          textHeight: 0.3,
          arrowheadSize: 0.25,
          leaderSections: [{ lastLeaderLinePoint: { x: 19, y: 1, z: 0 }, doglegVector: { x: 1, y: 0, z: 0 }, doglegLength: 0.5, leaderLines: [{ vertices: [{ x: 15, y: 0, z: 0 }] }] }],
          contentType: 2,
        } as never,
      ],
    };
    const { state, skipped } = convertDwg(payload);
    expect(skipped).toEqual({});
    expect(state.entities).toHaveLength(2);
    const [l, m] = state.entities as [LeaderEntity, LeaderEntity];
    expect(l.text).toBe('VALVE');
    expect(l.textAttachment).toBe(4);
    expect(m.kind).toBe('mleader');
    expect(m.vertices).toEqual([{ x: 15, y: 0 }, { x: 19, y: 1 }]);
    expect(m.dogleg).toEqual({ x: 0.5, y: 0 });
    expect(m.text).toBe('TAG');
    expect(m.arrowSize).toBe(0.25);
  });
});
