/**
 * P18 slice-1 acceptance must-fixes — retention regressions (slice 2 work order).
 *
 * V-2: block content signalled ONLY by the trailing group 172 = 1 (no CONTEXT_DATA
 * 296) must still produce the caller's `simplified` import-report entry and note
 * (CONTRACT-P18-P22-DXF R-MLEADER-18 requires it for BOTH triggers). At slice-1
 * head fe11aa4 it was reported nowhere and silently written back as LEADER.
 * Modelled on the acceptance owner's probe cases (b2)/(b3)
 * (reviews/P18-SLICE1-ACCEPTANCE.md).
 *
 * V-1 (added with its fix): MLEADERSTYLE specimen values in groups
 * 46/47/49/140/271/272/273/298 (probe case (b1)) must survive read -> write.
 *
 * Native AutoCAD edit/reopen and native DWG acceptance are separate Windows
 * gates and are NOT claimed by these Linux/headless tests.
 */
import { describe, it, expect } from 'vitest';
import type { LeaderEntity } from '../src/core/entities';
import { readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf } from '../src/io/import-report';

/** Hand-built MULTILEADER entity lines (MTEXT-shaped context), parameterised like the probe's. */
const mlEntityLines = (opts: { styleHandle?: string; text?: string; trailing172?: number; block296?: boolean } = {}): string[] => {
  const lines = [
    '0', 'MULTILEADER', '5', '3F', '8', 'ANNO', '100', 'AcDbEntity', '100', 'AcDbMLeader', '270', '2',
    '300', 'CONTEXT_DATA{', '40', '1', '10', '10', '20', '5', '30', '0', '41', '0.25', '140', '0.2', '145', '0.09', '174', '1', '175', '1', '176', '0', '177', '0', '290', '1',
  ];
  if (opts.block296) lines.push('296', '1');
  lines.push('304', opts.text ?? 'SPECIMEN NOTE', '11', '0', '21', '0', '31', '1', '340', '11', '12', '10.5', '22', '5.2', '32', '0', '170', '1', '172', '5');
  lines.push(
    '302', 'LEADER{', '290', '1', '291', '1', '10', '10', '20', '5', '30', '0', '11', '1', '21', '0', '31', '0', '90', '0', '40', '0.36',
    '304', 'LEADER_LINE{', '10', '7', '20', '3', '30', '0', '91', '0', '305', '}',
    '303', '}',
  );
  lines.push('301', '}');
  if (opts.styleHandle) lines.push('340', opts.styleHandle);
  lines.push('90', '0', '170', '1', '172', String(opts.trailing172 ?? 2));
  return lines;
};
const dxfOf = (entityLines: string[], objectsLines?: string[]): string => {
  const parts = ['0', 'SECTION', '2', 'ENTITIES', ...entityLines, '0', 'ENDSEC'];
  if (objectsLines) parts.push('0', 'SECTION', '2', 'OBJECTS', ...objectsLines, '0', 'ENDSEC');
  parts.push('0', 'EOF');
  return parts.join('\n');
};
const reportItems = (state: ReturnType<typeof readDxf>) =>
  (importReportOf(state)?.items ?? []).map((i) => ({ type: i.type, action: i.action, reason: i.reason }));
const simplifiedForBlock = (state: ReturnType<typeof readDxf>) =>
  reportItems(state).some((i) => i.type === 'MULTILEADER' && i.action === 'simplified' && /block content/.test(i.reason));

describe('P18 V-2: block content signalled only by trailing 172 = 1 is reported', () => {
  it('produces the simplified entry and the note, attaches no native data, writes back as LEADER', () => {
    const notes: string[] = [];
    const s = readDxf(dxfOf(mlEntityLines({ trailing172: 1, text: 'BLOCKTEXT' })), { notes });
    const l = s.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
    expect(l).toBeDefined();
    expect(l.kind).toBe('mleader');
    expect(l.mleader).toBeUndefined();
    expect(simplifiedForBlock(s)).toBe(true);
    expect(notes.some((n) => /block content/.test(n))).toBe(true);
    const out = writeDxf(s);
    expect(out).toContain('\r\nLEADER\r\n');
    expect(out).not.toContain('\r\nMULTILEADER\r\n');
  });

  it('control: the 296-signalled case keeps its simplified entry (slice-1 behaviour)', () => {
    const notes: string[] = [];
    const s = readDxf(dxfOf(mlEntityLines({ block296: true, trailing172: 1, text: '' })), { notes });
    const l = s.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
    expect(l.mleader).toBeUndefined();
    expect(simplifiedForBlock(s)).toBe(true);
    expect(notes.some((n) => /block content/.test(n))).toBe(true);
  });

  it('control: MTEXT content (context 172 = 5 flow, trailing 172 = 2) reports no block simplification', () => {
    const notes: string[] = [];
    const s = readDxf(dxfOf(mlEntityLines({ trailing172: 2 })), { notes });
    const l = s.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
    expect(l.mleader).toBeDefined();
    expect(l.mleader?.contentType).toBe('mtext');
    expect(simplifiedForBlock(s)).toBe(false);
    expect(notes.some((n) => /block content/.test(n))).toBe(false);
  });
});

type Pair = readonly [number, string];
/** OBJECTS section: root dict -> ACAD_MLEADERSTYLE dict -> entries [name, handle]; plus style objects. */
const objectsForStyles = (entries: Array<{ name: string; handle: string; groups?: Pair[] }>): string[] => {
  const lines: string[] = ['0', 'DICTIONARY', '5', 'C', '330', '0', '100', 'AcDbDictionary', '281', '1', '3', 'ACAD_MLEADERSTYLE', '350', 'D1',
    '0', 'DICTIONARY', '5', 'D1', '330', 'C', '100', 'AcDbDictionary', '281', '1'];
  for (const e of entries) lines.push('3', e.name, '350', e.handle);
  for (const e of entries) {
    lines.push('0', 'MLEADERSTYLE', '5', e.handle, '330', 'D1', '100', 'AcDbMLeaderStyle');
    for (const [c, v] of e.groups ?? []) lines.push(String(c), v);
  }
  return lines;
};
const pairsOf = (text: string): Pair[] => {
  const lines = text.split(/\r\n|\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([Number(lines[i]), lines[i + 1]!] as Pair);
  return out;
};
/** Group map of the first MLEADERSTYLE object in the OBJECTS section of a written DXF. */
const styleObjectGroups = (text: string): Map<number, string[]> => {
  const pairs = pairsOf(text);
  const map = new Map<number, string[]>();
  let inObj = false;
  for (let i = 0; i < pairs.length; i += 1) {
    const [code, value] = pairs[i]!;
    if (code === 0 && value === 'MLEADERSTYLE') inObj = true;
    else if (code === 0 && inObj) break;
    else if (inObj) {
      const arr = map.get(code) ?? [];
      arr.push(value!);
      map.set(code, arr);
    }
  }
  return map;
};

describe('P18 V-1: MLEADERSTYLE specimen values survive read -> write', () => {
  // The acceptance probe's (b1) specimen: every value below that differs from
  // the writer's specimen constants was silently reset at fe11aa4 (writer
  // constant in the comment). 141 is the same class (block rotation) at its
  // constant 0 in the probe; here it diverges too.
  const specimenGroups: Pair[] = [
    [179, '2'], [170, '2'], [171, '1'], [172, '0'], [90, '2'], [40, '0'], [41, '0'], [173, '1'],
    [91, '-1056964608'], [92, '-2'], [290, '1'], [42, '0.09'], [291, '1'], [43, '0.36'], [3, ''], [44, '0.2'],
    [300, ''], [174, '1'], [178, '6'], [175, '1'], [176, '0'], [93, '-1056964608'], [45, '0.25'], [292, '0'],
    [297, '0'], [46, '0.5'], [94, '-1056964608'], [47, '3'], [49, '2.5'], [140, '2.5'], [293, '1'], [141, '0.7'],
    [294, '1'], [177, '0'], [142, '1'], [295, '0'], [296, '0'], [143, '0.125'], [271, '1'], [272, '3'], [273, '4'], [298, '1'],
  ];
  // 46: 0.5 (0.18), 47: 3 (1), 49: 2.5 (1), 140: 2.5 (1), 141: 0.7 (0),
  // 271: 1 (0), 272: 3 (9), 273: 4 (9), 298: 1 (0)
  const inputValues: Record<number, string> = { 46: '0.5', 47: '3', 49: '2.5', 140: '2.5', 141: '0.7', 271: '1', 272: '3', 273: '4', 298: '1' };

  it('the divergent style values are carried on the entity and written back verbatim', () => {
    const objects = objectsForStyles([{ name: 'Standard', handle: 'AB', groups: specimenGroups }]);
    const s = readDxf(dxfOf(mlEntityLines({ styleHandle: 'AB' }), objects));
    const l = s.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
    expect(l.mleader?.styleName).toBe('Standard');
    expect(l.mleader?.styleRetained).toEqual({
      alignSpace: 0.5,
      blockScale: { x: 3, y: 2.5, z: 2.5 },
      blockRotation: 0.7,
      textAttachmentDirection: 1,
      bottomTextAttachmentDirection: 3,
      topTextAttachmentDirection: 4,
      flag298: 1,
    });
    const written = styleObjectGroups(writeDxf(s));
    for (const [code, v] of Object.entries(inputValues)) expect(written.get(Number(code))?.[0]).toBe(v);
  });

  it('the retained values are a round-trip fixed point (second read and write keep them)', () => {
    const objects = objectsForStyles([{ name: 'Standard', handle: 'AB', groups: specimenGroups }]);
    const s1 = readDxf(dxfOf(mlEntityLines({ styleHandle: 'AB' }), objects));
    const s2 = readDxf(writeDxf(s1));
    const l1 = s1.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
    const l2 = s2.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
    expect(l2.mleader).toEqual(l1.mleader);
    const written = styleObjectGroups(writeDxf(s2));
    for (const [code, v] of Object.entries(inputValues)) expect(written.get(Number(code))?.[0]).toBe(v);
  });

  it('control: a style object carrying only the specimen constants attaches nothing and writes the constants', () => {
    const constantGroups: Pair[] = specimenGroups.map(([c, v]) => {
      const constants: Record<number, string> = { 46: '0.18', 47: '1', 49: '1', 140: '1', 141: '0', 271: '0', 272: '9', 273: '9', 298: '0' };
      return [c, constants[c] ?? v] as Pair;
    });
    const objects = objectsForStyles([{ name: 'Standard', handle: 'AB', groups: constantGroups }]);
    const s = readDxf(dxfOf(mlEntityLines({ styleHandle: 'AB' }), objects));
    const l = s.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
    expect(l.mleader).toBeDefined();
    expect(l.mleader?.styleRetained).toBeUndefined();
    const written = styleObjectGroups(writeDxf(s));
    expect(written.get(46)?.[0]).toBe('0.18');
    expect(written.get(47)?.[0]).toBe('1');
    expect(written.get(272)?.[0]).toBe('9');
    expect(written.get(298)?.[0]).toBe('0');
  });

  it('control: a partially divergent style retains only the divergent groups', () => {
    const groups: Pair[] = specimenGroups.map(([c, v]) => (c === 46 ? [c, '0.5'] as Pair : [c, { 47: '1', 49: '1', 140: '1', 141: '0', 271: '0', 272: '9', 273: '9', 298: '0' }[c] ?? v] as Pair));
    const objects = objectsForStyles([{ name: 'Standard', handle: 'AB', groups }]);
    const s = readDxf(dxfOf(mlEntityLines({ styleHandle: 'AB' }), objects));
    const l = s.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
    expect(l.mleader?.styleRetained).toEqual({ alignSpace: 0.5 });
    const written = styleObjectGroups(writeDxf(s));
    expect(written.get(46)?.[0]).toBe('0.5');
    expect(written.get(47)?.[0]).toBe('1');
  });
});
