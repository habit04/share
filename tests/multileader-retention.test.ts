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
