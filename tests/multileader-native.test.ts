/**
 * P18 slice 1 acceptance: native MULTILEADER (MTEXT content) — model, context, style,
 * DXF export and reimport. At base 038cb7b4 every case here fails: a `kind: 'mleader'`
 * entity is written back as LEADER + MTEXT and no native data is modeled.
 * Native AutoCAD edit/reopen and native DWG acceptance are separate Windows gates and
 * are NOT claimed by these Linux/headless tests.
 */
import { describe, it, expect } from 'vitest';
import type { LeaderEntity } from '../src/core/entities';
import { leaderParts, translateEntity, scaleEntityBy, mirrorEntityAcross } from '../src/core/entities';
import { defaultMLeaderNative, mleaderNativeProblem } from '../src/core/multileader';
import { readDxf, writeDxf } from '../src/io/dxf';
import { Drawing } from '../src/core/document';
import { fakeContext, drive } from './fake-context';
import { mleaderTool } from '../src/tools/drafting-annot';

const props = { layer: 'ANNO', color: 'ByLayer' as const };

/** An MTEXT-content multileader as AutoCAD writes one (two leader lines, one landing). */
const nativeMl = (over: Partial<LeaderEntity> = {}): LeaderEntity => ({
  id: 'ml1',
  ...props,
  type: 'leader',
  kind: 'mleader',
  vertices: [{ x: 7, y: 3 }, { x: 10, y: 5 }],
  extraPaths: [[{ x: 7, y: 6 }, { x: 10, y: 5 }]],
  arrow: true,
  arrowSize: 0.2,
  dogleg: { x: 0.36, y: 0 },
  text: 'PUMP P-101\nSTANDBY',
  raw: '{\\C1;PUMP} P-101\\PSTANDBY',
  textPosition: { x: 10.5, y: 5.2 },
  textHeight: 0.25,
  textAttachment: 1,
  textWidth: 0,
  mleader: { contentType: 'mtext', styleName: 'Standard', scaleFactor: 1, landingGap: 0.09, leaderLineType: 1 },
  ...over,
});

describe('P18 native MULTILEADER — DXF export', () => {
  it('writes a native MULTILEADER with CONTEXT_DATA, not LEADER + MTEXT', () => {
    const d = new Drawing();
    d.addEntities([nativeMl()]);
    const out = writeDxf(d.snapshot);
    expect(out).toContain('\r\nMULTILEADER\r\n');
    expect(out).toContain('CONTEXT_DATA{');
    expect(out).toContain('{\\C1;PUMP} P-101\\PSTANDBY'); // formatted MTEXT source in group 304
    expect(out).not.toContain('\r\nLEADER\r\n');
    expect(out).not.toContain('\r\nMTEXT\r\n');
    // The style travels as a real MLEADERSTYLE object in an ACAD_MLEADERSTYLE dictionary.
    expect(out).toContain('ACAD_MLEADERSTYLE');
    expect(out).toContain('\r\nMLEADERSTYLE\r\n');
    expect(out).toContain('AcDbMLeaderStyle');
  });

  it('a drawing without native mleaders emits no MULTILEADER / MLEADERSTYLE (fixed point)', () => {
    const d = new Drawing();
    d.addEntities([{ id: 'ln', layer: '0', color: 'ByLayer' as const, type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }]);
    const out = writeDxf(d.snapshot);
    expect(out).not.toContain('MULTILEADER');
    expect(out).not.toContain('MLEADERSTYLE');
  });

  it('plain LEADER write-back is unchanged (LEADER + MTEXT, no MULTILEADER)', () => {
    const plain: LeaderEntity = { id: 'ld', ...props, type: 'leader', kind: 'leader', vertices: [{ x: 0, y: 0 }, { x: 2, y: 2 }], arrow: true, arrowSize: 0.18, dogleg: { x: 0.36, y: 0 }, text: 'NOTE 1', textPosition: { x: 2.45, y: 2.09 }, textHeight: 0.18 };
    const d = new Drawing();
    d.addEntities([plain]);
    const out = writeDxf(d.snapshot);
    expect(out).toContain('\r\nLEADER\r\n');
    expect(out).toContain('\r\nMTEXT\r\n');
    expect(out).not.toContain('MULTILEADER');
  });

  it('a mleader WITHOUT native data keeps the legacy LEADER write-back (backward compat)', () => {
    const legacy = nativeMl();
    const { mleader: _drop, ...rest } = legacy;
    const d = new Drawing();
    d.addEntities([rest as LeaderEntity]);
    const out = writeDxf(d.snapshot);
    expect(out).not.toContain('MULTILEADER');
    expect(out.match(/\r\nLEADER\r\n/g)).toHaveLength(2); // main + extra leader line
  });
});

describe('P18 native MULTILEADER — DXF round-trip', () => {
  it('reimports text, geometry, style, scale, gap and attachment intact; second write is stable', () => {
    const d = new Drawing();
    d.addEntities([nativeMl()]);
    const out = writeDxf(d.snapshot);
    const back = readDxf(out);
    const leaders = back.entities.filter((e): e is LeaderEntity => e.type === 'leader');
    expect(leaders).toHaveLength(1);
    const l = leaders[0]!;
    expect(l.kind).toBe('mleader');
    expect(l.vertices).toEqual([{ x: 7, y: 3 }, { x: 10, y: 5 }]);
    expect(l.extraPaths).toEqual([[{ x: 7, y: 6 }, { x: 10, y: 5 }]]);
    expect(l.dogleg!.x).toBeCloseTo(0.36);
    expect(l.text).toBe('PUMP P-101\nSTANDBY');
    expect(l.raw).toContain('\\C1;');
    expect(l.textPosition).toEqual({ x: 10.5, y: 5.2 });
    expect(l.textHeight).toBeCloseTo(0.25);
    expect(l.arrowSize).toBeCloseTo(0.2);
    expect(l.textAttachment).toBe(1);
    expect(l.mleader).toEqual({ contentType: 'mtext', styleName: 'Standard', scaleFactor: 1, landingGap: 0.09, leaderLineType: 1 });
    // Re-exporting the reimported entity reproduces the same native groups.
    const out2 = writeDxf(back);
    expect(out2).toContain('\r\nMULTILEADER\r\n');
    const back2 = readDxf(out2);
    const l2 = back2.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
    expect(l2.mleader).toEqual(l.mleader);
    expect(l2.text).toBe(l.text);
    expect(l2.vertices).toEqual(l.vertices);
  });

  it('round-trips a non-Standard style name through the MLEADERSTYLE dictionary', () => {
    const d = new Drawing();
    d.addEntities([nativeMl({ mleader: { contentType: 'mtext', styleName: 'NOTES', scaleFactor: 2, landingGap: 0.12, leaderLineType: 1 } })]);
    const out = writeDxf(d.snapshot);
    expect(out).toContain('NOTES');
    const back = readDxf(out);
    const l = back.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
    expect(l.mleader?.styleName).toBe('NOTES');
    expect(l.mleader?.scaleFactor).toBeCloseTo(2);
    expect(l.mleader?.landingGap).toBeCloseTo(0.12);
  });

  it('reads the AutoCAD CONTEXT_DATA fixture as native data (not a flattened leader)', () => {
    const dxf = [
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'MULTILEADER', '5', '3F', '8', 'ANNO', '100', 'AcDbEntity', '100', 'AcDbMLeader', '270', '2',
      '300', 'CONTEXT_DATA{', '40', '1', '10', '10', '20', '5', '30', '0', '41', '0.25', '140', '0.2', '145', '0.09', '174', '1', '175', '1', '176', '0', '177', '0',
      '290', '1', '304', '{\\C1;PUMP} P-101\\PSTANDBY', '11', '0', '21', '0', '31', '1', '340', '11', '12', '10.5', '22', '5.2', '32', '0', '13', '1', '23', '0', '33', '0', '42', '0', '43', '0', '44', '0', '45', '1', '170', '1', '90', '-1073741824', '171', '1', '172', '5',
      '302', 'LEADER{', '290', '1', '291', '1', '10', '10', '20', '5', '30', '0', '11', '1', '21', '0', '31', '0', '90', '0', '40', '0.36',
      '304', 'LEADER_LINE{', '10', '7', '20', '3', '30', '0', '91', '0', '305', '}',
      '303', '}',
      '301', '}',
      '340', '12', '90', '0', '170', '1', '91', '-1056964608', '171', '-2', '290', '1', '291', '1', '41', '0.36', '42', '0.18', '172', '2',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const s = readDxf(dxf);
    const l = s.entities[0] as LeaderEntity;
    expect(l.mleader?.contentType).toBe('mtext');
    expect(l.mleader?.landingGap).toBeCloseTo(0.09);
    expect(l.mleader?.scaleFactor).toBeCloseTo(1);
    expect(l.mleader?.leaderLineType).toBe(1);
    // And it now writes back natively instead of as LEADER + MTEXT.
    const out = writeDxf(s);
    expect(out).toContain('\r\nMULTILEADER\r\n');
    expect(out).not.toContain('\r\nLEADER\r\n');
  });

  it('block-content MULTILEADER is retained and reported, never silently flattened to native MTEXT', () => {
    const dxf = [
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'MULTILEADER', '5', '40', '8', 'ANNO', '100', 'AcDbEntity', '100', 'AcDbMLeader', '270', '2',
      '300', 'CONTEXT_DATA{', '40', '1', '10', '10', '20', '5', '30', '0', '41', '0.25', '140', '0.2', '145', '0.09',
      '296', '1', '304', '', '12', '10.5', '22', '5.2', '32', '0', '171', '1',
      '302', 'LEADER{', '290', '1', '291', '1', '10', '10', '20', '5', '30', '0', '11', '1', '21', '0', '31', '0', '40', '0.36',
      '304', 'LEADER_LINE{', '10', '7', '20', '3', '30', '0', '91', '0', '305', '}',
      '303', '}',
      '301', '}',
      '340', '12', '170', '1', '172', '1',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const notes: string[] = [];
    const s = readDxf(dxf, { notes });
    const l = s.entities[0] as LeaderEntity;
    expect(l.kind).toBe('mleader');
    // Slice 1 does not model block content: no native data is claimed for it,
    // and the simplification is reported (import note), not silent.
    expect(l.mleader).toBeUndefined();
    expect(notes.join(' ')).toMatch(/block content/);
  });

  it('a native mleader inside a block definition round-trips natively', () => {
    const d = new Drawing();
    d.addEntities([]);
    const state = { ...d.snapshot, blocks: { TAGBLK: { name: 'TAGBLK', basePoint: { x: 0, y: 0 }, entities: [nativeMl({ id: 'mlb' })], attributes: [] } } };
    const out = writeDxf(state);
    expect(out).toContain('\r\nMULTILEADER\r\n');
    const back = readDxf(out);
    const inBlock = back.blocks['TAGBLK']?.entities.find((e): e is LeaderEntity => e.type === 'leader');
    expect(inBlock?.kind).toBe('mleader');
    expect(inBlock?.mleader?.styleName).toBe('Standard');
    expect(inBlock?.text).toBe('PUMP P-101\nSTANDBY');
  });
});

describe('P18 native MULTILEADER — model, editing, rendering', () => {
  it('MLEADER command authors native data (Standard style)', () => {
    const doc = new Drawing();
    const ctx = fakeContext(doc);
    drive(mleaderTool(), ctx, [{ x: 0, y: 0 }, { x: -3, y: 1 }, 'MOTOR M1', '']);
    const l = doc.entities[0] as LeaderEntity;
    expect(l.kind).toBe('mleader');
    expect(l.mleader?.contentType).toBe('mtext');
    expect(l.mleader?.styleName).toBe('Standard');
    const out = writeDxf(doc.snapshot);
    expect(out).toContain('\r\nMULTILEADER\r\n');
  });

  it('copy/transforms keep the native data; rendering parts are unchanged', () => {
    const l = nativeMl();
    const moved = translateEntity(l, { x: 5, y: -2 }) as LeaderEntity;
    expect(moved.vertices[0]).toEqual({ x: 12, y: 1 });
    expect(moved.textPosition).toEqual({ x: 15.5, y: 3.2 });
    expect(moved.mleader).toEqual(l.mleader);
    const scaled = scaleEntityBy(l, { x: 0, y: 0 }, 2) as LeaderEntity;
    expect(scaled.textHeight).toBeCloseTo(0.5);
    expect(scaled.arrowSize).toBeCloseTo(0.4);
    expect(scaled.mleader).toEqual(l.mleader);
    const mirrored = mirrorEntityAcross({ ...l, textAttachment: 1 }, { x: 0, y: 0 }, { x: 0, y: 1 }) as LeaderEntity;
    expect(mirrored.mleader).toEqual(l.mleader);
    // Canvas and plot both consume leaderParts: native data must not change the parts.
    const strip = (e: LeaderEntity) => leaderParts(e).map((p) => ({ ...p, id: p.type }));
    expect(strip(nativeMl())).toEqual(strip({ ...nativeMl(), mleader: undefined }));
  });

  it('undo/redo/dirty: one transaction adds the mleader, undo removes it, redo restores it intact', () => {
    const doc = new Drawing();
    expect(doc.dirty).toBe(false);
    doc.addEntities([nativeMl()]);
    expect(doc.dirty).toBe(true);
    expect(doc.entities).toHaveLength(1);
    expect(doc.undo()).toBe(true);
    expect(doc.entities).toHaveLength(0);
    expect(doc.redo()).toBe(true);
    const l = doc.entities[0] as LeaderEntity;
    expect(l.mleader?.styleName).toBe('Standard');
    expect(l.text).toBe('PUMP P-101\nSTANDBY');
  });

  it('validation rejects impossible native data', () => {
    expect(mleaderNativeProblem(defaultMLeaderNative())).toBeUndefined();
    expect(mleaderNativeProblem({ ...defaultMLeaderNative(), scaleFactor: 0 })).toMatch(/scale/);
    expect(mleaderNativeProblem({ ...defaultMLeaderNative(), scaleFactor: Number.NaN })).toMatch(/scale/);
    expect(mleaderNativeProblem({ ...defaultMLeaderNative(), landingGap: -1 })).toMatch(/landing gap/);
    expect(mleaderNativeProblem({ ...defaultMLeaderNative(), styleName: '' })).toMatch(/style/);
    expect(mleaderNativeProblem({ ...defaultMLeaderNative(), leaderLineType: 7 as never })).toMatch(/leader line type/);
  });
});
