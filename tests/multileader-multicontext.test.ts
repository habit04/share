/**
 * P18 slice 3 acceptance (PROPOSAL-P18-S3, FILED — prototype, UNADMITTED):
 * native MULTILEADER multi-context / annotative scale — model, DXF export +
 * reimport, layouts-routed scale resolution. At slice-2 head c1bae58 twelve
 * cases here fail: the reader merges all CONTEXT_DATA sections into one
 * representation (the second context's scale overwrites the first's, the
 * MTEXT content is concatenated, nothing is reported) and the writer emits
 * ONE context. The thirteenth case is the single-context CONTROL: it passes
 * at c1bae58 and must keep passing (it pins the primary emission shape the
 * slice must not move). Native AutoCAD edit/reopen and native annotative
 * fixtures (FIXTURE RECIPE #4) are separate Windows gates, NOT claimed here.
 */
import { describe, it, expect } from 'vitest';
import type { LeaderEntity } from '../src/core/entities';
import { translateEntity, rotateEntity, scaleEntityBy, mirrorEntityAcross } from '../src/core/entities';
import { mleaderNativeProblem } from '../src/core/multileader';
import type { MLeaderContext } from '../src/core/multileader';
import { annotativeEntity, cannoscaleValue } from '../src/core/layouts';
import * as layouts from '../src/core/layouts';
// The slice-3 layouts exports, read through the namespace so this file still
// collects at the slice-2 head (where they do not exist) and each case fails
// on its own assertion there — the failing-first evidence.
const { mleaderContextForScale, mleaderPrimaryContext, leaderWithMLeaderContext } = layouts as unknown as {
  mleaderContextForScale: (e: LeaderEntity, scaleValue: number) => MLeaderContext | undefined;
  mleaderPrimaryContext: (e: LeaderEntity) => MLeaderContext;
  leaderWithMLeaderContext: (e: LeaderEntity, ctx: MLeaderContext) => LeaderEntity;
};
import { readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf } from '../src/io/import-report';
import { Drawing } from '../src/core/document';

type Lines = string[];
const styleTableLines: Lines = [
  '0', 'SECTION', '2', 'TABLES',
  '0', 'TABLE', '2', 'STYLE', '5', '10', '330', '0', '100', 'AcDbSymbolTable', '70', '1',
  '0', 'STYLE', '5', '11', '330', '10', '100', 'AcDbSymbolTableRecord', '100', 'AcDbTextStyleTableRecord',
  '2', 'Standard', '70', '0', '40', '0', '41', '1', '50', '0', '71', '0', '42', '0.25', '3', 'txt', '4', '',
  '0', 'ENDTAB', '0', 'ENDSEC',
];

/** One MTEXT CONTEXT_DATA section (the probe's shape), parameterised. */
const mtextCtx = (opts: { scale?: string; text?: string; line: [string, string]; landing: [string, string]; textPos: [string, string] }): Lines => {
  const lines: Lines = [
    '300', 'CONTEXT_DATA{',
    '10', opts.landing[0], '20', opts.landing[1], '30', '0', '41', '0.25', '140', '0.2', '145', '0.09', '174', '1', '175', '1', '176', '0', '177', '0',
    '290', '1', '304', opts.text ?? 'PUMP P-101', '11', '0', '21', '0', '31', '1', '340', '11', '12', opts.textPos[0], '22', opts.textPos[1], '32', '0', '13', '1', '23', '0', '33', '0', '42', '0', '43', '0', '44', '0', '45', '1', '170', '1', '90', '-1073741824', '171', '1', '172', '5',
    '302', 'LEADER{', '290', '1', '291', '1', '10', opts.landing[0], '20', opts.landing[1], '30', '0', '11', '1', '21', '0', '31', '0', '90', '0', '40', '0.36',
    '304', 'LEADER_LINE{', '10', opts.line[0], '20', opts.line[1], '30', '0', '91', '0', '305', '}',
    '303', '}',
    '301', '}',
  ];
  if (opts.scale !== undefined) lines.splice(2, 0, '40', opts.scale);
  return lines;
};
const trailingMText: Lines = ['340', '12', '90', '0', '170', '1', '91', '-1056964608', '171', '-2', '290', '1', '291', '1', '41', '0.36', '42', '0.18', '172', '2'];
const dxfOf = (entityLines: Lines, withStyleTable = true): string =>
  [...(withStyleTable ? styleTableLines : []), '0', 'SECTION', '2', 'ENTITIES', ...entityLines, '0', 'ENDSEC', '0', 'EOF'].join('\n');
const mlHead: Lines = ['0', 'MULTILEADER', '5', '3F', '8', 'ANNO', '100', 'AcDbEntity', '100', 'AcDbMLeader', '270', '2'];

const ctx1 = mtextCtx({ scale: '1', line: ['7', '3'], landing: ['10', '5'], textPos: ['10.5', '5.2'] });
const ctx2 = mtextCtx({ scale: '0.5', line: ['4', '1.5'], landing: ['5', '2.5'], textPos: ['5.5', '2.6'] });
const twoCtxDxf = dxfOf([...mlHead, ...ctx1, ...ctx2, ...trailingMText]);

const reportOf = (state: ReturnType<typeof readDxf>) =>
  (importReportOf(state)?.items ?? []).map((i) => ({ type: i.type, action: i.action, reason: i.reason }));
const ctxCount = (dxf: string) => (dxf.match(/CONTEXT_DATA\{/g) ?? []).length;

describe('P18 slice 3: two-context MTEXT multileader imports as modelled contexts', () => {
  it('keeps the primary intact (no doubled text, no overwritten scale) and models the second context', () => {
    const notes: string[] = [];
    const s = readDxf(twoCtxDxf, { notes });
    const l = s.entities[0] as LeaderEntity;
    expect(l.kind).toBe('mleader');
    expect(l.text).toBe('PUMP P-101');
    expect(l.textPosition).toEqual({ x: 10.5, y: 5.2 });
    expect(l.vertices).toEqual([{ x: 7, y: 3 }, { x: 10, y: 5 }]);
    expect(l.extraPaths).toBeUndefined();
    expect(l.mleader?.scaleFactor).toBe(1);
    const contexts = l.mleader?.contexts;
    expect(contexts).toHaveLength(1);
    const c = contexts![0]!;
    expect(c.scaleFactor).toBe(0.5);
    expect(c.paths).toEqual([[{ x: 4, y: 1.5 }, { x: 5, y: 2.5 }]]);
    expect(c.dogleg).toEqual({ x: 0.36, y: 0 });
    expect(c.text).toBe('PUMP P-101');
    expect(c.textPosition).toEqual({ x: 5.5, y: 2.6 });
    expect(c.textHeight).toBeCloseTo(0.25);
    expect(c.arrowSize).toBeCloseTo(0.2);
    expect(c.landingGap).toBeCloseTo(0.09);
    expect(c.textStyleName).toBe('Standard');
    expect(c.textAttachment).toBe(1);
    // Modelled multi-context content is reported by note only, never simplified.
    expect(notes.join(' ')).toMatch(/annotative contexts are kept as native data/);
    expect(reportOf(s).some((i) => i.action === 'simplified')).toBe(false);
  });

  it('write -> read is a fixed point with both contexts in file order', () => {
    const s = readDxf(twoCtxDxf);
    const out = writeDxf(s);
    expect(ctxCount(out)).toBe(2);
    const back = readDxf(out);
    const l = back.entities[0] as LeaderEntity;
    expect(l.mleader).toEqual((s.entities[0] as LeaderEntity).mleader);
    expect(l.text).toBe('PUMP P-101');
    expect(l.vertices).toEqual([{ x: 7, y: 3 }, { x: 10, y: 5 }]);
    // And the fixed point is stable: a second write is byte-identical.
    expect(writeDxf(back)).toBe(out);
  });

  it('an authored multi-context entity writes every context with its own scale and text', () => {
    const d = new Drawing();
    d.addEntities([authored()]);
    const out = writeDxf(d.snapshot);
    expect(ctxCount(out)).toBe(2);
    const back = readDxf(out);
    const l = back.entities[0] as LeaderEntity;
    expect(l.mleader?.contexts).toHaveLength(1);
    expect(l.mleader?.contexts![0]!.scaleFactor).toBe(0.5);
    expect(l.mleader?.contexts![0]!.paths).toEqual([[{ x: 4, y: 1.5 }, { x: 5, y: 2.5 }]]);
    expect(l.mleader?.contexts![0]!.text).toBe('PUMP P-101');
  });
});

const authored = (contexts?: MLeaderContext[]): LeaderEntity => ({
  id: 'am1',
  layer: 'ANNO',
  color: 'ByLayer' as const,
  type: 'leader',
  kind: 'mleader',
  vertices: [{ x: 7, y: 3 }, { x: 10, y: 5 }],
  arrow: true,
  arrowSize: 0.2,
  dogleg: { x: 0.36, y: 0 },
  text: 'PUMP P-101',
  textPosition: { x: 10.5, y: 5.2 },
  textHeight: 0.25,
  textAttachment: 1,
  mleader: {
    contentType: 'mtext',
    styleName: 'Standard',
    scaleFactor: 1,
    landingGap: 0.09,
    leaderLineType: 1,
    contexts: contexts ?? [{
      scaleFactor: 0.5, landingGap: 0.09, textHeight: 0.25, arrowSize: 0.2,
      paths: [[{ x: 4, y: 1.5 }, { x: 5, y: 2.5 }]], dogleg: { x: 0.36, y: 0 },
      text: 'PUMP P-101', textPosition: { x: 5.5, y: 2.6 }, textAttachment: 1,
    }],
  },
});

describe('P18 slice 3: layouts-routed annotative scale resolution', () => {
  const imported = () => readDxf(twoCtxDxf).entities[0] as LeaderEntity;

  it('resolves contexts by canonical scale name (layouts.ts machinery only)', () => {
    const l = imported();
    expect(mleaderPrimaryContext(l).scaleFactor).toBe(1);
    expect(mleaderPrimaryContext(l).paths).toEqual([[{ x: 7, y: 3 }, { x: 10, y: 5 }]]);
    expect(mleaderContextForScale(l, cannoscaleValue('1:2'))?.scaleFactor).toBe(0.5);
    expect(mleaderContextForScale(l, 1)?.scaleFactor).toBe(1);
    expect(mleaderContextForScale(l, 0.25)).toBeUndefined();
    expect(leaderWithMLeaderContext(l, mleaderPrimaryContext(l))).toBe(l);
  });

  it('annotativeEntity shows the matching context representation, not a uniform scale', () => {
    const l = imported();
    const at2 = annotativeEntity(l, 2) as LeaderEntity; // factor 2 <=> annotation scale 1:2
    expect(at2).not.toBe(l);
    expect(at2.vertices).toEqual([{ x: 4, y: 1.5 }, { x: 5, y: 2.5 }]);
    expect(at2.textPosition).toEqual({ x: 5.5, y: 2.6 });
    expect(at2.textHeight).toBeCloseTo(0.25); // the context's own height — NOT doubled
    expect(at2.mleader?.scaleFactor).toBe(0.5);
    expect(at2.mleader?.contexts).toHaveLength(1);
    expect(at2.mleader?.contexts![0]!.scaleFactor).toBe(1); // old primary demoted, order kept
    // At the primary's own scale the entity is returned unchanged (no double-apply).
    expect(annotativeEntity(l, 1)).toBe(l);
    // No matching context: today's uniform scaling, untouched.
    const at4 = annotativeEntity(l, 4) as LeaderEntity;
    expect(at4.textHeight).toBeCloseTo(1);
    expect(at4.vertices).toEqual([{ x: 7, y: 3 }, { x: 10, y: 5 }]);
  });
});

describe('P18 slice 3: transforms carry every context with the primary', () => {
  it('translate / rotate / scale / mirror move context geometry; scaleFactor and landingGap never transform', () => {
    const e = authored();
    const moved = translateEntity(e, { x: 10, y: 0 }) as LeaderEntity;
    expect(moved.mleader?.contexts![0]!.paths).toEqual([[{ x: 14, y: 1.5 }, { x: 15, y: 2.5 }]]);
    expect(moved.mleader?.contexts![0]!.textPosition).toEqual({ x: 15.5, y: 2.6 });
    expect(moved.mleader?.contexts![0]!.dogleg).toEqual({ x: 0.36, y: 0 });

    const rotated = rotateEntity(e, { x: 0, y: 0 }, Math.PI / 2) as LeaderEntity;
    const rp = rotated.mleader?.contexts![0]!.paths[0]!;
    expect(rp[0]!.x).toBeCloseTo(-1.5);
    expect(rp[0]!.y).toBeCloseTo(4);
    expect(rp[1]!.x).toBeCloseTo(-2.5);
    expect(rp[1]!.y).toBeCloseTo(5);

    const scaled = scaleEntityBy(e, { x: 0, y: 0 }, 2) as LeaderEntity;
    expect(scaled.mleader?.contexts![0]!.paths).toEqual([[{ x: 8, y: 3 }, { x: 10, y: 5 }]]);
    expect(scaled.mleader?.contexts![0]!.textHeight).toBeCloseTo(0.5);
    expect(scaled.mleader?.contexts![0]!.scaleFactor).toBe(0.5);
    expect(scaled.mleader?.contexts![0]!.landingGap).toBeCloseTo(0.09);

    const mirrored = mirrorEntityAcross(e, { x: 0, y: 0 }, { x: 0, y: 1 }) as LeaderEntity;
    expect(mirrored.mleader?.contexts![0]!.paths).toEqual([[{ x: -4, y: 1.5 }, { x: -5, y: 2.5 }]]);
    expect(mirrored.mleader?.contexts![0]!.textAttachment).toBe(3); // the primary's attachment flip, per context
  });

  it('model validation refuses invalid contexts before any group is written', () => {
    const good = authored().mleader!;
    expect(mleaderNativeProblem(good)).toBeUndefined();
    expect(mleaderNativeProblem({ ...good, contexts: [] })).toBeDefined();
    expect(mleaderNativeProblem({ ...good, contexts: [{ ...good.contexts![0]!, scaleFactor: -1 }] })).toBeDefined();
    expect(mleaderNativeProblem({ ...good, contexts: [{ ...good.contexts![0]!, paths: [[{ x: NaN, y: 0 }, { x: 1, y: 1 }]] }] })).toBeDefined();
    const d = new Drawing();
    d.addEntities([authored([{ ...good.contexts![0]!, scaleFactor: 0 }])]);
    expect(() => writeDxf(d.snapshot)).toThrow(/Cannot write native MULTILEADER/);
  });
});

describe('P18 slice 3: unmodellable contexts withhold native data and are reported', () => {
  const expectWithheld = (dxf: string) => {
    const notes: string[] = [];
    const s = readDxf(dxf, { notes });
    const l = s.entities[0] as LeaderEntity;
    expect(l.mleader).toBeUndefined();
    // The fallback is the primary context alone — never the merged mangle.
    expect(l.text).toBe('PUMP P-101');
    expect(l.vertices).toEqual([{ x: 7, y: 3 }, { x: 10, y: 5 }]);
    expect(notes.join(' ')).toMatch(/annotative contexts are not kept/);
    expect(reportOf(s).some((i) => i.type === 'MULTILEADER' && i.action === 'simplified' && /annotative contexts/.test(i.reason))).toBe(true);
    const out = writeDxf(s);
    expect(out).toContain('\r\nLEADER\r\n');
    expect(out).not.toContain('MULTILEADER');
  };

  it('a second context without a usable group 40 is withheld + reported', () => {
    const noScale = mtextCtx({ line: ['4', '1.5'], landing: ['5', '2.5'], textPos: ['5.5', '2.6'] });
    expectWithheld(dxfOf([...mlHead, ...ctx1, ...noScale, ...trailingMText]));
  });

  it('a second context with a non-positive group 40 is withheld + reported', () => {
    const badScale = mtextCtx({ scale: '-0.5', line: ['4', '1.5'], landing: ['5', '2.5'], textPos: ['5.5', '2.6'] });
    expectWithheld(dxfOf([...mlHead, ...ctx1, ...badScale, ...trailingMText]));
  });
});

// ---------------------------------------------------------------- block content, three contexts

const attdefLines = (handle: string, tag: string, def: string, y: number): Lines => [
  '0', 'ATTDEF', '5', handle, '330', 'E1', '100', 'AcDbEntity', '8', '0', '100', 'AcDbText',
  '10', '0', '20', String(y), '30', '0', '40', '0.25', '1', def, '50', '0', '41', '1', '51', '0', '7', 'Standard',
  '71', '0', '72', '0', '100', 'AcDbAttributeDefinition', '3', `${tag}?`, '2', tag, '70', '0',
];
const blockCtx = (opts: { scale: string; handle?: string; pos: [string, string]; bscale: string; line: [string, string]; landing: [string, string]; text?: string }): Lines => {
  const lines: Lines = [
    '300', 'CONTEXT_DATA{', '40', opts.scale, '10', opts.pos[0], '20', opts.pos[1], '30', '0', '41', '0.25', '140', '0.2', '145', '0.09', '174', '1', '175', '1', '176', '0', '177', '0', '290', '1',
  ];
  if (opts.text !== undefined) lines.push('304', opts.text);
  lines.push('296', '1', '341', opts.handle ?? 'E1',
    '15', opts.pos[0], '25', opts.pos[1], '35', '0', '16', opts.bscale, '26', opts.bscale, '36', '1', '46', '0.35',
    '170', '1', '90', '-1073741824',
    '302', 'LEADER{', '290', '1', '291', '1', '10', opts.landing[0], '20', opts.landing[1], '30', '0', '11', '1', '21', '0', '31', '0', '90', '0', '40', '0.36',
    '304', 'LEADER_LINE{', '10', opts.line[0], '20', opts.line[1], '30', '0', '91', '0', '305', '}', '303', '}', '301', '}');
  return lines;
};
const blockDxf = (contexts: Lines[], extraRecords = false): string => {
  const parts: Lines = [
    '0', 'SECTION', '2', 'TABLES',
    '0', 'TABLE', '2', 'BLOCK_RECORD', '5', '9', '330', '0', '100', 'AcDbSymbolTable', '70', '1',
    '0', 'BLOCK_RECORD', '5', 'E1', '330', '9', '100', 'AcDbSymbolTableRecord', '100', 'AcDbBlockTableRecord', '2', 'TAGBLOCK', '70', '0', '280', '1', '281', '0',
  ];
  if (extraRecords) parts.push('0', 'BLOCK_RECORD', '5', 'E2', '330', '9', '100', 'AcDbSymbolTableRecord', '100', 'AcDbBlockTableRecord', '2', 'OTHERBLK', '70', '0', '280', '1', '281', '0');
  parts.push('0', 'ENDTAB', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '5', 'E0', '330', 'E1', '100', 'AcDbEntity', '8', '0', '100', 'AcDbBlockBegin', '2', 'TAGBLOCK', '70', '2', '10', '0', '20', '0', '30', '0', '3', 'TAGBLOCK', '1', '',
    ...attdefLines('A1', 'PART', 'WIDGET', 0),
    ...attdefLines('A2', 'REV', 'A', -0.4),
    '0', 'ENDBLK', '5', 'E9', '330', 'E1', '100', 'AcDbEntity', '8', '0', '100', 'AcDbBlockEnd');
  if (extraRecords) {
    parts.push('0', 'BLOCK', '5', 'F0', '330', 'E2', '100', 'AcDbEntity', '8', '0', '100', 'AcDbBlockBegin', '2', 'OTHERBLK', '70', '0', '10', '0', '20', '0', '30', '0', '3', 'OTHERBLK', '1', '',
      '0', 'ENDBLK', '5', 'F9', '330', 'E2', '100', 'AcDbEntity', '8', '0', '100', 'AcDbBlockEnd');
  }
  parts.push('0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES', ...mlHead, ...contexts.flat(),
    '340', 'AB', '90', '0', '170', '1', '91', '-1056964608', '171', '-2', '290', '1', '291', '1', '41', '0.36', '42', '0.2', '172', '1',
    '344', 'E1', '10', '2', '20', '2', '30', '0', '43', '0.35',
    '330', 'A1', '177', '0', '302', 'GEAR-9',
    '330', 'A2', '177', '1', '44', '0.8', '302', 'C',
    '0', 'ENDSEC', '0', 'EOF');
  return parts.join('\n');
};
const bc1 = blockCtx({ scale: '1', pos: ['10.4', '5'], bscale: '2', line: ['7', '3'], landing: ['10', '5'] });
const bc2 = blockCtx({ scale: '0.5', pos: ['5.2', '2.5'], bscale: '1', line: ['4', '1.5'], landing: ['5', '2.5'] });
const bc3 = blockCtx({ scale: '0.25', pos: ['2.6', '1.25'], bscale: '0.5', line: ['2', '0.75'], landing: ['2.5', '1.25'] });

describe('P18 slice 3: three-context block-content multileader', () => {
  it('models per-context block placements; attributes stay entity-level and are written once', () => {
    const notes: string[] = [];
    const s = readDxf(blockDxf([bc1, bc2, bc3]), { notes });
    const l = s.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
    expect(l.mleader?.contentType).toBe('block');
    expect(l.mleader?.block?.name).toBe('TAGBLOCK');
    expect(l.mleader?.block?.position).toEqual({ x: 10.4, y: 5 });
    expect(l.mleader?.block?.attributes.map((a) => a.value)).toEqual(['GEAR-9', 'C']);
    const contexts = l.mleader?.contexts;
    expect(contexts).toHaveLength(2);
    expect(contexts![0]!.scaleFactor).toBe(0.5);
    expect(contexts![0]!.block).toEqual({ position: { x: 5.2, y: 2.5 }, scale: { x: 1, y: 1 }, rotation: 0.35 });
    expect(contexts![1]!.scaleFactor).toBe(0.25);
    expect(contexts![1]!.block).toEqual({ position: { x: 2.6, y: 1.25 }, scale: { x: 0.5, y: 0.5 }, rotation: 0.35 });
    expect(notes.join(' ')).toMatch(/annotative contexts are kept as native data/);
    const out = writeDxf(s);
    expect(ctxCount(out)).toBe(3);
    expect((out.match(/GEAR-9/g) ?? []).length).toBe(1);
    const back = readDxf(out);
    const lb = back.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
    expect(lb.mleader).toEqual(l.mleader);
  });

  it('a hybrid second context (block signal + MTEXT text) withholds everything and reports', () => {
    const hybrid2 = blockCtx({ scale: '0.5', pos: ['5.2', '2.5'], bscale: '1', line: ['4', '1.5'], landing: ['5', '2.5'], text: 'SNEAKY' });
    const notes: string[] = [];
    const s = readDxf(blockDxf([bc1, hybrid2]), { notes });
    const l = s.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
    expect(l.mleader).toBeUndefined();
    expect(reportOf(s).some((i) => i.action === 'simplified' && /annotative contexts/.test(i.reason))).toBe(true);
  });

  it('a second context naming a DIFFERENT block withholds everything and reports', () => {
    const other2 = blockCtx({ scale: '0.5', handle: 'E2', pos: ['5.2', '2.5'], bscale: '1', line: ['4', '1.5'], landing: ['5', '2.5'] });
    const s = readDxf(blockDxf([bc1, other2], true));
    const l = s.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
    expect(l.mleader).toBeUndefined();
    expect(reportOf(s).some((i) => i.action === 'simplified' && /annotative contexts/.test(i.reason))).toBe(true);
  });
});

describe('P18 slice 3: single-context control (slice-1/2 behaviour unchanged)', () => {
  it('a single-context record gains no contexts field and writes the exact primary shape', () => {
    const s = readDxf(dxfOf([...mlHead, ...ctx1, ...trailingMText]));
    const l = s.entities[0] as LeaderEntity;
    expect(l.mleader).toBeDefined();
    expect(l.mleader?.contexts).toBeUndefined();
    const out = writeDxf(s);
    expect(ctxCount(out)).toBe(1);
    // The primary context section's group-code sequence is byte-shape-identical
    // to the slice-1 writer's (codes only; values follow the model).
    const seg = out.slice(out.indexOf('CONTEXT_DATA{') - '300\r\n'.length, out.indexOf('LEADER{'));
    const codes = seg.split('\r\n').filter((_, i) => i % 2 === 0).map((v) => v.trim());
    expect(codes.join(',')).toBe('300,40,10,20,30,41,140,145,174,175,176,177,290,304,11,21,31,340,12,22,32,13,23,33,42,43,44,45,170,90,171,172,302');
  });
});
