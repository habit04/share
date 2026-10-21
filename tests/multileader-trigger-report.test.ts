/**
 * P18 slice 2 — F-1 regression: the block-content trigger predicate must be
 * TOTAL between reader and caller (acceptance finding F-1,
 * reviews/P18-SLICE2-ACCEPTANCE.md; RULING-P18 C5; CONTRACT-P18-P22-DXF
 * R-MLEADER-18).
 *
 * At slice-2 head 0535850, readMLeader (read-annotations.ts) treats block
 * content as signalled when the CONTEXT_DATA group 296 parses to a NONZERO
 * integer (`int(p.value) !== 0`) or the trailing content type (172) parses
 * to 1 — while the caller in read-entities.ts reported the simplification
 * only for the exact strings '1'. In the gap (296 = '2' or '01', or a
 * trailing 172 = '01', with an unresolvable block reference) the reader
 * withheld native data but the caller reported NOTHING: no `simplified`
 * import-report entry, no note — the entity kept the legacy LEADER
 * write-back in silence. That is the V-2 failure mode, one predicate-width
 * narrower. 296 is a boolean AutoCAD writes as 0/1, so these are
 * malformed-input specimens; the reporting totality must hold anyway.
 *
 * The contract invariant: the set of inputs whose native block data is
 * withheld EQUALS the set that is either modelled (with the caller's
 * informational note) or reported `simplified`. Both sides must use ONE
 * shared predicate so they cannot drift apart again.
 *
 * Hand-built specimens only (AutoCAD group order of the slice-2 specimen);
 * no AutoCAD-authored fixture exists. Native/DWG acceptance is a separate
 * Windows gate and is NOT claimed here.
 */
import { describe, it, expect } from 'vitest';
import type { LeaderEntity } from '../src/core/entities';
import { readDxf } from '../src/io/dxf';
import { importReportOf } from '../src/io/import-report';

const simplifiedForBlock = (state: ReturnType<typeof readDxf>) =>
  (importReportOf(state)?.items ?? []).some((i) => i.type === 'MULTILEADER' && i.action === 'simplified' && /block content/.test(i.reason));
const leadersOf = (state: ReturnType<typeof readDxf>) => state.entities.filter((e): e is LeaderEntity => e.type === 'leader');

// ------------------------------------------------------------------ fixtures

interface MlOpts {
  handle?: string;
  ctx296?: string | null; // null = group absent
  ctxHandle?: string | null; // context 341; null = absent
  trailHandle?: string | null; // trailing 344; null = absent
  trailing172?: string | null; // null = absent
}
/** One MULTILEADER record (block-content shape, AutoCAD group order). */
const mlRecord = (o: MlOpts = {}): string[] => {
  const bh = o.ctxHandle === undefined ? 'E1' : o.ctxHandle;
  const lines: string[] = [
    '0', 'MULTILEADER', '5', o.handle ?? '3F', '8', 'ANNO', '100', 'AcDbEntity', '100', 'AcDbMLeader', '270', '2',
    '300', 'CONTEXT_DATA{', '40', '1', '10', '10.4', '20', '5', '30', '0', '41', '0.25', '140', '0.2', '145', '0.09',
    '174', '1', '175', '1', '176', '0', '177', '0', '290', '1',
  ];
  if (o.ctx296 !== null) lines.push('296', o.ctx296 ?? '1');
  if (bh !== null) lines.push('341', bh!);
  lines.push('15', '10.4', '25', '5', '35', '0', '16', '2', '26', '2', '36', '1', '46', '0.35');
  lines.push('170', '1', '90', '-1073741824',
    '302', 'LEADER{', '290', '1', '291', '1', '10', '10', '20', '5', '30', '0', '11', '1', '21', '0', '31', '0', '90', '0', '40', '0.36',
    '304', 'LEADER_LINE{', '10', '7', '20', '3', '30', '0', '91', '0', '305', '}', '303', '}', '301', '}',
    '340', 'AB', '90', '0', '170', '1', '91', '-1056964608', '171', '-2', '290', '1', '291', '1', '41', '0.36', '42', '0.2');
  if (o.trailing172 !== null) lines.push('172', o.trailing172 ?? '1');
  const th = o.trailHandle === undefined ? (bh ?? undefined) : o.trailHandle;
  if (th !== null && th !== undefined) lines.push('344', th);
  lines.push('10', '2', '20', '2', '30', '0', '43', '0.35');
  for (const a of [{ handle: 'A1', index: '0', value: 'GEAR-9' }, { handle: 'A2', index: '1', width: '0.8', value: 'C' }]) {
    lines.push('330', a.handle, '177', a.index);
    if (a.width !== undefined) lines.push('44', a.width);
    lines.push('302', a.value);
  }
  return lines;
};

/** A file whose TAGBLOCK resolves (BLOCK_RECORD E1 + BLOCK + ATTDEFs + style). */
const blockFile = (entities: string[][]): string => {
  const parts: string[] = [];
  parts.push('0', 'SECTION', '2', 'TABLES',
    '0', 'TABLE', '2', 'BLOCK_RECORD', '5', '9', '330', '0', '100', 'AcDbSymbolTable', '70', '1',
    '0', 'BLOCK_RECORD', '5', 'E1', '330', '9', '100', 'AcDbSymbolTableRecord', '100', 'AcDbBlockTableRecord', '2', 'TAGBLOCK', '70', '0', '280', '1', '281', '0',
    '0', 'ENDTAB', '0', 'ENDSEC');
  parts.push('0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '5', 'E0', '330', 'E1', '100', 'AcDbEntity', '8', '0', '100', 'AcDbBlockBegin', '2', 'TAGBLOCK', '70', '2', '10', '0', '20', '0', '30', '0', '3', 'TAGBLOCK', '1', '');
  for (const a of [{ handle: 'A1', tag: 'PART', def: 'WIDGET' }, { handle: 'A2', tag: 'REV', def: 'A' }]) {
    parts.push('0', 'ATTDEF', '5', a.handle, '330', 'E1', '100', 'AcDbEntity', '8', '0', '100', 'AcDbText',
      '10', '0', '20', '0', '30', '0', '40', '0.25', '1', a.def, '50', '0', '41', '1', '51', '0', '7', 'Standard',
      '71', '0', '72', '0', '100', 'AcDbAttributeDefinition', '3', `${a.tag}?`, '2', a.tag, '70', '0');
  }
  parts.push('0', 'ENDBLK', '5', 'E9', '330', 'E1', '100', 'AcDbEntity', '8', '0', '100', 'AcDbBlockEnd', '0', 'ENDSEC');
  parts.push('0', 'SECTION', '2', 'ENTITIES', ...entities.flat(), '0', 'ENDSEC');
  parts.push('0', 'SECTION', '2', 'OBJECTS',
    '0', 'DICTIONARY', '5', 'C', '330', '0', '100', 'AcDbDictionary', '281', '1', '3', 'ACAD_MLEADERSTYLE', '350', 'D1',
    '0', 'DICTIONARY', '5', 'D1', '330', 'C', '100', 'AcDbDictionary', '281', '1', '3', 'Standard', '350', 'AB',
    '0', 'MLEADERSTYLE', '5', 'AB', '330', 'D1', '100', 'AcDbMLeaderStyle',
    '170', '1', '46', '0.18', '47', '1', '49', '1', '140', '1', '141', '0', '271', '0', '272', '9', '273', '9', '298', '0',
    '0', 'ENDSEC', '0', 'EOF');
  return parts.join('\n');
};

/** MTEXT-shaped MULTILEADER (slice-1 shape) with trigger knobs. */
const mtextRecord = (o: { ctx296?: string | null; trailing172?: string | null; flow172?: string } = {}): string[] => {
  const lines = [
    '0', 'MULTILEADER', '5', '3F', '8', 'ANNO', '100', 'AcDbEntity', '100', 'AcDbMLeader', '270', '2',
    '300', 'CONTEXT_DATA{', '40', '1', '10', '10', '20', '5', '30', '0', '41', '0.25', '140', '0.2', '145', '0.09', '174', '1', '175', '1', '176', '0', '177', '0', '290', '1',
  ];
  if (o.ctx296 !== null && o.ctx296 !== undefined) lines.push('296', o.ctx296);
  lines.push('304', 'SPECIMEN NOTE', '11', '0', '21', '0', '31', '1', '340', '11', '12', '10.5', '22', '5.2', '32', '0', '170', '1', '172', o.flow172 ?? '5',
    '302', 'LEADER{', '290', '1', '291', '1', '10', '10', '20', '5', '30', '0', '11', '1', '21', '0', '31', '0', '90', '0', '40', '0.36',
    '304', 'LEADER_LINE{', '10', '7', '20', '3', '30', '0', '91', '0', '305', '}', '303', '}', '301', '}',
    '340', 'AB', '90', '0', '170', '1');
  if (o.trailing172 !== null) lines.push('172', o.trailing172 ?? '2');
  return lines;
};
const dxfOfEntities = (entityLines: string[][]): string =>
  ['0', 'SECTION', '2', 'ENTITIES', ...entityLines.flat(), '0', 'ENDSEC', '0', 'EOF'].join('\n');

// ------------------------------------------------------------- F-1 gap cases

describe('F-1: trigger predicate totality — malformed 296/172 spellings', () => {
  it("296='2' + trailing 172='2' + DANGLING block -> legacy WITH the simplified entry (acceptance M6b)", () => {
    const notes: string[] = [];
    const s = readDxf(blockFile([mlRecord({ ctx296: '2', trailing172: '2', ctxHandle: 'FF', trailHandle: 'FF' })]), { notes });
    const l = leadersOf(s)[0]!;
    expect(l?.mleader).toBeUndefined();
    expect(simplifiedForBlock(s)).toBe(true);
    expect(notes.some((n) => /block content is not drawn/.test(n))).toBe(true);
  });

  it("296='01' + trailing 172='2' + DANGLING block -> legacy WITH the simplified entry (acceptance '01' variant)", () => {
    const notes: string[] = [];
    const s = readDxf(blockFile([mlRecord({ ctx296: '01', trailing172: '2', ctxHandle: 'FF', trailHandle: 'FF' })]), { notes });
    const l = leadersOf(s)[0]!;
    expect(l?.mleader).toBeUndefined();
    expect(simplifiedForBlock(s)).toBe(true);
    expect(notes.some((n) => /block content is not drawn/.test(n))).toBe(true);
  });

  it("trailing 172='01' alone (no 296) + DANGLING block -> legacy WITH the simplified entry", () => {
    const notes: string[] = [];
    const s = readDxf(blockFile([mlRecord({ ctx296: null, trailing172: '01', ctxHandle: 'FF', trailHandle: 'FF' })]), { notes });
    const l = leadersOf(s)[0]!;
    expect(l?.mleader).toBeUndefined();
    expect(simplifiedForBlock(s)).toBe(true);
    expect(notes.some((n) => /block content is not drawn/.test(n))).toBe(true);
  });

  it("296='2' + trailing 172='2' + RESOLVABLE block -> modelled block AND the caller's informational note", () => {
    const notes: string[] = [];
    const s = readDxf(blockFile([mlRecord({ ctx296: '2', trailing172: '2' })]), { notes });
    const l = leadersOf(s)[0]!;
    expect(l?.mleader?.contentType).toBe('block');
    expect(simplifiedForBlock(s)).toBe(false);
    expect(notes.some((n) => /kept as native data/.test(n))).toBe(true);
  });
});

// -------------------------------------------------- pins that must not move

describe('F-1 guards: well-formed triggers and non-block content unchanged', () => {
  it("296='1' + DANGLING block -> legacy WITH the simplified entry (classic V-2 296 leg)", () => {
    const s = readDxf(blockFile([mlRecord({ ctx296: '1', trailing172: '2', ctxHandle: 'FF', trailHandle: 'FF' })]));
    const l = leadersOf(s)[0]!;
    expect(l?.mleader).toBeUndefined();
    expect(simplifiedForBlock(s)).toBe(true);
  });

  it('MTEXT: context flow 172=1, trailing 172 ABSENT -> modelled mtext, NO block report (no over-reporting)', () => {
    const s = readDxf(dxfOfEntities([mtextRecord({ flow172: '1', trailing172: null })]));
    const l = leadersOf(s)[0]!;
    expect(l?.mleader?.contentType).toBe('mtext');
    expect(simplifiedForBlock(s)).toBe(false);
  });

  it("MTEXT: 296='0' + trailing 172='2' -> modelled mtext, NO block report", () => {
    const s = readDxf(dxfOfEntities([mtextRecord({ ctx296: '0', trailing172: '2' })]));
    const l = leadersOf(s)[0]!;
    expect(l?.mleader?.contentType).toBe('mtext');
    expect(simplifiedForBlock(s)).toBe(false);
  });
});
