/**
 * P18 slice 2 acceptance: native MULTILEADER block content + attributes
 * (PROPOSAL-P18-S2). At slice-1 head fe11aa4 every modelling case here fails:
 * block content (CONTEXT_DATA 296 = 1 / trailing 172 = 1) gets NO native data
 * and keeps the legacy LEADER write-back with a `simplified` import-report
 * entry. Slice 2 models it when the block record resolves to a block name:
 * block name (341 / trailing 344), position (context 15, fallback context 10),
 * scale (context 16, fallback trailing 10), rotation (context 46, fallback
 * trailing 43) and attribute values (trailing 330 ATTDEF handle / 177
 * definition index / 44 width / 302 text, resolved to definition tags through
 * the block's BlockDef.attributes). Unresolvable reference, hybrid block+MTEXT
 * content, or a dangling attribute => NO native data, exact slice-1 legacy
 * behaviour, `simplified` reported (RULING-P18 C5 retention discipline).
 *
 * Native AutoCAD edit/reopen and native DWG acceptance are separate Windows
 * gates and are NOT claimed by these Linux/headless tests.
 */
import { describe, it, expect } from 'vitest';
import type { BlockDef, LeaderEntity } from '../src/core/entities';
import { DEFAULT_LAYERS, Drawing } from '../src/core/document';
import { mleaderNativeProblem } from '../src/core/multileader';
import { readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf } from '../src/io/import-report';

type Pair = readonly [number, string];
const pairsOf = (text: string): Pair[] => {
  const lines = text.split(/\r\n|\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([Number(lines[i]), lines[i + 1]!] as Pair);
  return out;
};
/** The group pairs of one top-level record (0 <kind> ... up to the next 0). */
const recordPairs = (text: string, kind: string, from = 0): Pair[] => {
  const pairs = pairsOf(text);
  const start = pairs.findIndex((p, i) => i >= from && p[0] === 0 && p[1] === kind);
  if (start < 0) return [];
  const out: Pair[] = [];
  for (let i = start + 1; i < pairs.length && pairs[i]![0] !== 0; i += 1) out.push(pairs[i]!);
  return out;
};
const firstVal = (pairs: Pair[], code: number): string | undefined => pairs.find((p) => p[0] === code)?.[1];
/** BLOCK_RECORD handle for a block name, from the TABLES section of a written file. */
const blockRecordHandleOf = (text: string, name: string): string | undefined => {
  const pairs = pairsOf(text);
  for (let i = 0; i < pairs.length; i += 1) {
    if (pairs[i]![0] === 0 && pairs[i]![1] === 'BLOCK_RECORD') {
      const rec = recordPairs(text, 'BLOCK_RECORD', i);
      if (firstVal(rec, 2) === name) return firstVal(rec, 5);
    }
  }
  return undefined;
};
/** ATTDEF handles in file order (the attributed block's definitions). */
const attdefHandlesOf = (text: string): string[] => {
  const pairs = pairsOf(text);
  const out: string[] = [];
  for (let i = 0; i < pairs.length; i += 1) {
    if (pairs[i]![0] === 0 && pairs[i]![1] === 'ATTDEF') out.push(firstVal(recordPairs(text, 'ATTDEF', i), 5)!);
  }
  return out;
};
/** MLEADERSTYLE group maps by style name (dictionary order), from a written file. */
const stylesByName = (text: string): Map<string, Map<number, string[]>> => {
  const pairs = pairsOf(text);
  const out = new Map<string, Map<number, string[]>>();
  const byHandle = new Map<string, Map<number, string[]>>();
  let dict: Pair[] | null = null;
  for (let i = 0; i < pairs.length; i += 1) {
    if (pairs[i]![0] !== 0) continue;
    if (pairs[i]![1] === 'DICTIONARY') dict = recordPairs(text, 'DICTIONARY', i);
    if (pairs[i]![1] === 'MLEADERSTYLE') {
      const rec = recordPairs(text, 'MLEADERSTYLE', i);
      const map = new Map<number, string[]>();
      for (const [c, v] of rec) {
        const arr = map.get(c) ?? [];
        arr.push(v);
        map.set(c, arr);
      }
      byHandle.set(firstVal(rec, 5)!, map);
    }
  }
  if (dict) {
    for (let k = 0; k + 1 < dict.length; k += 1) {
      if (dict[k]![0] === 3 && dict[k + 1]![0] === 350) {
        const style = byHandle.get(dict[k + 1]![1]);
        if (style) out.set(dict[k]![1], style);
      }
    }
  }
  return out;
};
const simplifiedForBlock = (state: ReturnType<typeof readDxf>) =>
  (importReportOf(state)?.items ?? []).some((i) => i.type === 'MULTILEADER' && i.action === 'simplified' && /block content/.test(i.reason));

// ---------------------------------------------------------------- authored state

const tagBlock: BlockDef = {
  name: 'TAGBLOCK',
  basePoint: { x: 0, y: 0 },
  entities: [{ id: 'tb-line', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }],
  attributes: [
    { tag: 'PART', prompt: 'Part?', default: 'WIDGET', position: { x: 0, y: 0 }, height: 0.25, align: 'left' },
    { tag: 'REV', prompt: 'Rev?', default: 'A', position: { x: 0, y: -0.4 }, height: 0.25, align: 'left' },
  ],
};

const blockMl = (over: Partial<LeaderEntity> = {}): LeaderEntity => ({
  id: 'mlb1',
  layer: 'ANNO',
  color: 'ByLayer',
  type: 'leader',
  kind: 'mleader',
  vertices: [{ x: 7, y: 3 }, { x: 10, y: 5 }],
  arrow: true,
  arrowSize: 0.2,
  dogleg: { x: 0.36, y: 0 },
  textHeight: 0.25,
  mleader: {
    contentType: 'block',
    styleName: 'Standard',
    scaleFactor: 1,
    landingGap: 0.09,
    leaderLineType: 1,
    block: {
      name: 'TAGBLOCK',
      position: { x: 10.4, y: 5 },
      scale: { x: 2, y: 2 },
      rotation: 0.35,
      attributes: [
        { index: 0, tag: 'PART', value: 'GEAR-9' },
        { index: 1, tag: 'REV', value: 'C', width: 0.8 },
      ],
    },
  },
  ...over,
});

const drawingWith = (entities: LeaderEntity[], blocks: Record<string, BlockDef>) =>
  new Drawing({ entities, layers: DEFAULT_LAYERS, blocks, currentLayer: '0' }).snapshot;

describe('P18 slice 2: authored block-content multileader — DXF export + reimport', () => {
  it('writes a native MULTILEADER whose attribute 330 handles are the ATTDEF handles of the same file', () => {
    const out = writeDxf(drawingWith([blockMl()], { TAGBLOCK: tagBlock }));
    expect(out).toContain('\r\nMULTILEADER\r\n');
    expect(out).not.toContain('\r\nLEADER\r\n');
    const rec = recordPairs(out, 'MULTILEADER');
    const recordHandle = blockRecordHandleOf(out, 'TAGBLOCK');
    expect(recordHandle).toBeDefined();
    // Context: block signalled, record named, placement carried.
    expect(firstVal(rec, 296)).toBe('1');
    expect(firstVal(rec, 341)).toBe(recordHandle);
    expect(firstVal(rec, 15)).toBe('10.4');
    expect(firstVal(rec, 16)).toBe('2');
    expect(firstVal(rec, 46)).toBe('0.35');
    // Trailing: content type block, record named again, scale + rotation repeated.
    expect(firstVal(rec, 172)).toBe('1');
    expect(firstVal(rec, 344)).toBe(recordHandle);
    expect(firstVal(rec, 43)).toBe('0.35');
    // Attribute entries name THIS file's ATTDEF handles, in order, with values.
    // (The record's first 330 is the entity owner, before CONTEXT_DATA; the
    // attribute entries are the 330s after the context closes at 301 '}'.)
    const attdefs = attdefHandlesOf(out);
    expect(attdefs).toHaveLength(2);
    const closeIdx = rec.findIndex((p) => p[0] === 301);
    const attr330 = rec.slice(closeIdx).filter((p) => p[0] === 330).map((p) => p[1]);
    expect(attr330).toEqual(attdefs);
    expect(rec.slice(closeIdx).filter((p) => p[0] === 302).map((p) => p[1])).toEqual(['GEAR-9', 'C']);
    // The synthesized style is a block style naming the same record.
    const style = stylesByName(out).get('Standard')!;
    expect(style.get(170)?.[0]).toBe('1');
    expect(style.get(343)?.[0]).toBe(recordHandle);
    expect(style.get(47)?.[0]).toBe('2');
    expect(style.get(49)?.[0]).toBe('2');
    expect(style.get(140)?.[0]).toBe('1');
    expect(style.get(141)?.[0]).toBe('0.35');
  });

  it('round-trips block name/position/scale/rotation/attribute values with no simplification reported', () => {
    const notes: string[] = [];
    const back = readDxf(writeDxf(drawingWith([blockMl()], { TAGBLOCK: tagBlock })), { notes });
    const l = back.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
    expect(l.mleader).toEqual(blockMl().mleader);
    expect(simplifiedForBlock(back)).toBe(false);
    expect(notes.some((n) => /kept as native data/.test(n))).toBe(true);
    // Fixed point: a second save reproduces the identical native payload.
    const back2 = readDxf(writeDxf(back));
    const l2 = back2.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
    expect(l2.mleader).toEqual(l.mleader);
  });

  it('refuses atomically when the content block is not in the drawing', () => {
    expect(() => writeDxf(drawingWith([blockMl()], {}))).toThrow(/Cannot write native MULTILEADER/);
  });

  it('refuses atomically when the ATTDEF handles are written later in the same pass (mleader inside an earlier block definition)', () => {
    const host: BlockDef = { name: 'HOST', basePoint: { x: 0, y: 0 }, entities: [blockMl()], attributes: [] };
    const state = drawingWith([], { HOST: host, TAGBLOCK: tagBlock });
    expect(() => writeDxf(state)).toThrow(/Cannot write native MULTILEADER/);
  });

  it('validation: block content without a payload, or with a bad attribute, is a problem', () => {
    const base = blockMl().mleader!;
    expect(mleaderNativeProblem({ ...base, block: undefined })).toBeDefined();
    expect(mleaderNativeProblem({ ...base, block: { ...base.block!, name: '' } })).toBeDefined();
    expect(mleaderNativeProblem({ ...base, block: { ...base.block!, attributes: [{ index: -1, tag: 'PART', value: 'X' }] } })).toBeDefined();
    expect(mleaderNativeProblem(base)).toBeUndefined();
  });
});

// ---------------------------------------------------------------- AutoCAD-shaped specimen

type Lines = string[];
const attdefLines = (handle: string, tag: string, def: string, y: number): Lines => [
  '0', 'ATTDEF', '5', handle, '330', 'E1', '100', 'AcDbEntity', '8', '0', '100', 'AcDbText',
  '10', '0', '20', String(y), '30', '0', '40', '0.25', '1', def, '50', '0', '41', '1', '51', '0', '7', 'Standard',
  '71', '0', '72', '0', '100', 'AcDbAttributeDefinition', '3', `${tag}?`, '2', tag, '70', '0',
];
const specimen = (opts: {
  blockHandle?: string;
  trailingBlockHandle?: string;
  withBlockDef?: boolean;
  hybridText?: boolean;
  attrIndex2?: string;
  fallbacksOnly?: boolean;
} = {}): string => {
  const bh = opts.blockHandle ?? 'E1';
  const parts: Lines = [];
  parts.push('0', 'SECTION', '2', 'TABLES',
    '0', 'TABLE', '2', 'BLOCK_RECORD', '5', '9', '330', '0', '100', 'AcDbSymbolTable', '70', '1',
    '0', 'BLOCK_RECORD', '5', 'E1', '330', '9', '100', 'AcDbSymbolTableRecord', '100', 'AcDbBlockTableRecord', '2', 'TAGBLOCK', '70', '0', '280', '1', '281', '0',
    '0', 'ENDTAB', '0', 'ENDSEC');
  if (opts.withBlockDef !== false) {
    parts.push('0', 'SECTION', '2', 'BLOCKS',
      '0', 'BLOCK', '5', 'E0', '330', 'E1', '100', 'AcDbEntity', '8', '0', '100', 'AcDbBlockBegin', '2', 'TAGBLOCK', '70', '2', '10', '0', '20', '0', '30', '0', '3', 'TAGBLOCK', '1', '',
      '0', 'LINE', '5', 'A0', '330', 'E1', '100', 'AcDbEntity', '8', '0', '100', 'AcDbLine', '10', '0', '20', '0', '30', '0', '11', '1', '21', '0', '31', '0',
      ...attdefLines('A1', 'PART', 'WIDGET', 0),
      ...attdefLines('A2', 'REV', 'A', -0.4),
      '0', 'ENDBLK', '5', 'E9', '330', 'E1', '100', 'AcDbEntity', '8', '0', '100', 'AcDbBlockEnd',
      '0', 'ENDSEC');
  }
  const ctx: Lines = [
    '0', 'MULTILEADER', '5', '3F', '8', 'ANNO', '100', 'AcDbEntity', '100', 'AcDbMLeader', '270', '2',
    '300', 'CONTEXT_DATA{', '40', '1', '10', '10.4', '20', '5', '30', '0', '41', '0.25', '140', '0.2', '145', '0.09', '174', '1', '175', '1', '176', '0', '177', '0', '290', '1',
  ];
  if (opts.hybridText) ctx.push('304', 'HYBRID TEXT');
  ctx.push('296', '1', '341', bh);
  if (!opts.fallbacksOnly) ctx.push('15', '10.4', '25', '5', '35', '0', '16', '2', '26', '2', '36', '1', '46', '0.35');
  ctx.push('170', '1', '90', '-1073741824',
    '302', 'LEADER{', '290', '1', '291', '1', '10', '10', '20', '5', '30', '0', '11', '1', '21', '0', '31', '0', '90', '0', '40', '0.36',
    '304', 'LEADER_LINE{', '10', '7', '20', '3', '30', '0', '91', '0', '305', '}', '303', '}', '301', '}',
    '340', 'AB', '90', '0', '170', '1', '91', '-1056964608', '171', '-2', '290', '1', '291', '1', '41', '0.36', '42', '0.2', '172', '1',
    '344', opts.trailingBlockHandle ?? bh, '10', '2', '20', '2', '30', '0', '43', '0.35',
    '330', 'A1', '177', '0', '302', 'GEAR-9',
    '330', 'A2', '177', opts.attrIndex2 ?? '1', '44', '0.8', '302', 'C');
  parts.push('0', 'SECTION', '2', 'ENTITIES', ...ctx, '0', 'ENDSEC');
  parts.push('0', 'SECTION', '2', 'OBJECTS',
    '0', 'DICTIONARY', '5', 'C', '330', '0', '100', 'AcDbDictionary', '281', '1', '3', 'ACAD_MLEADERSTYLE', '350', 'D1',
    '0', 'DICTIONARY', '5', 'D1', '330', 'C', '100', 'AcDbDictionary', '281', '1', '3', 'Standard', '350', 'AB',
    '0', 'MLEADERSTYLE', '5', 'AB', '330', 'D1', '100', 'AcDbMLeaderStyle', '170', '1', '46', '0.18', '47', '1', '49', '1', '140', '1', '141', '0', '271', '0', '272', '9', '273', '9', '298', '0',
    '0', 'ENDSEC');
  parts.push('0', 'EOF');
  return parts.join('\n');
};

describe('P18 slice 2: AutoCAD-shaped block-content specimen imports as native data', () => {
  it('models the block content with NO simplified entry', () => {
    const notes: string[] = [];
    const s = readDxf(specimen(), { notes });
    const l = s.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
    expect(l.mleader?.contentType).toBe('block');
    expect(l.mleader?.block).toEqual({
      name: 'TAGBLOCK',
      position: { x: 10.4, y: 5 },
      scale: { x: 2, y: 2 },
      rotation: 0.35,
      attributes: [
        { index: 0, tag: 'PART', value: 'GEAR-9' },
        { index: 1, tag: 'REV', value: 'C', width: 0.8 },
      ],
    });
    expect(simplifiedForBlock(s)).toBe(false);
    expect(notes.some((n) => /kept as native data/.test(n))).toBe(true);
  });

  it('falls back to context 10 / trailing 10 / trailing 43 when the context block groups are absent', () => {
    const s = readDxf(specimen({ fallbacksOnly: true }));
    const l = s.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
    expect(l.mleader?.block?.position).toEqual({ x: 10.4, y: 5 });
    expect(l.mleader?.block?.scale).toEqual({ x: 2, y: 2 });
    expect(l.mleader?.block?.rotation).toBe(0.35);
  });

  it('dangling block handle: no native data, simplified reported, legacy write-back', () => {
    const s = readDxf(specimen({ blockHandle: 'FF', trailingBlockHandle: 'FF' }));
    const l = s.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
    expect(l.mleader).toBeUndefined();
    expect(simplifiedForBlock(s)).toBe(true);
    expect(writeDxf(s)).not.toContain('\r\nMULTILEADER\r\n');
  });

  it('block record resolves but the block definition is absent: no native data, simplified reported', () => {
    const s = readDxf(specimen({ withBlockDef: false }));
    const l = s.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
    expect(l.mleader).toBeUndefined();
    expect(simplifiedForBlock(s)).toBe(true);
  });

  it('hybrid block + MTEXT content: no native data, simplified reported', () => {
    const s = readDxf(specimen({ hybridText: true }));
    const l = s.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
    expect(l.mleader).toBeUndefined();
    expect(simplifiedForBlock(s)).toBe(true);
  });

  it('dangling attribute index: no native data, simplified reported', () => {
    const s = readDxf(specimen({ attrIndex2: '7' }));
    const l = s.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
    expect(l.mleader).toBeUndefined();
    expect(simplifiedForBlock(s)).toBe(true);
  });
});
