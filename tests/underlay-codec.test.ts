import { describe, it, expect } from 'vitest';
import {
  parseUnderlayDefinition,
  parseUnderlayEntity,
  underlayDefinitionKind,
  underlayDefinitionDxfType,
  underlayDxfType,
  underlayEntityKind,
  writeUnderlayDefinition,
  writeUnderlayEntity,
  type DxfGroupPair,
} from '../src/io/dxf/underlay-codec';

// P28 slice 1: DXF group codec for *UNDERLAY entities and *DEFINITION objects.
// On the base these records are dropped on read (read-pass "not supported"),
// so an ordinary save silently loses the reference. The codec's contract:
// parse models what JCad understands, retains every other group verbatim,
// and refuses atomically on malformed modeled data. Nothing is flattened:
// the definition's stored path comes back byte-for-byte (never normalized,
// never resolved), and write(parse(g)) preserves the group multiset of g
// (subclass-marker 100 groups are regenerated canonically and excluded).

const G = (pairs: Array<[number, string]>): DxfGroupPair[] => pairs;

/** Group multiset with structural 100 subclass markers removed. */
function multiset(pairs: readonly DxfGroupPair[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const [code, value] of pairs) {
    if (code === 100) continue;
    const key = `${code}=${value}`;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

const pdfEntityGroups = G([
  [5, '2F'],
  [330, '1F'],
  [100, 'AcDbEntity'],
  [8, 'PDF-UNDERLAY'],
  [100, 'AcDbPdfUnderlay'],
  [340, '2E'],
  [10, '10.5'],
  [20, '-20'],
  [30, '0'],
  [41, '2'],
  [42, '3'],
  [43, '1'],
  [50, '90'],
  [70, '10'],
  [280, '80'],
  [281, '15'],
  [290, '1'], // a group this model does not claim: must be retained, not dropped
  [1001, 'ACAD'], // XDATA application name: retained
  [1000, 'kept-verbatim'],
]);

const pdfDefGroups = G([
  [5, '2E'],
  [330, '10'],
  [100, 'AcDbObject'],
  [100, 'AcDbPdfDefinition'],
  [1, 'C:\\refs\\floor plan.pdf'],
  [2, 'Sheet 1'],
  [999, 'a comment group: retained'],
]);

describe('underlay DXF type mapping', () => {
  it('maps all three underlay kinds both ways', () => {
    expect(underlayEntityKind('PDFUNDERLAY')).toBe('pdf');
    expect(underlayEntityKind('DWFUNDERLAY')).toBe('dwf');
    expect(underlayEntityKind('DGNUNDERLAY')).toBe('dgn');
    expect(underlayEntityKind('IMAGE')).toBeNull();
    expect(underlayDefinitionKind('PDFDEFINITION')).toBe('pdf');
    expect(underlayDefinitionKind('DWFDEFINITION')).toBe('dwf');
    expect(underlayDefinitionKind('DGNDEFINITION')).toBe('dgn');
    expect(underlayDefinitionKind('IMAGEDEF')).toBeNull();
    expect(underlayDxfType('pdf')).toBe('PDFUNDERLAY');
    expect(underlayDxfType('dgn')).toBe('DGNUNDERLAY');
    expect(underlayDefinitionDxfType('dwf')).toBe('DWFDEFINITION');
  });
});

describe('underlay entity codec', () => {
  it('parses a PDFUNDERLAY into the retained model', () => {
    const r = parseUnderlayEntity('pdf', pdfEntityGroups, 'fallback');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.value;
    expect(p.handle).toBe('2F');
    expect(p.definitionHandle).toBe('2E');
    expect(p.layer).toBe('PDF-UNDERLAY');
    expect(p.position).toEqual({ x: 10.5, y: -20 });
    expect(p.scaleX).toBe(2);
    expect(p.scaleY).toBe(3);
    expect(p.rotation).toBeCloseTo(Math.PI / 2);
    expect(p.flags).toBe(10);
    expect(p.contrast).toBe(80);
    expect(p.fade).toBe(15);
    // Unmodeled groups retained verbatim and in order (30 = Z, 43 = Z scale are 2D-unmodeled).
    expect(p.retainedGroups).toEqual([
      [330, '1F'],
      [30, '0'],
      [43, '1'],
      [290, '1'],
      [1001, 'ACAD'],
      [1000, 'kept-verbatim'],
    ]);
  });

  it('round-trips with no group lost and no group invented (modulo regenerated 100 markers)', () => {
    const r = parseUnderlayEntity('pdf', pdfEntityGroups, 'fallback');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const written = writeUnderlayEntity(r.value);
    expect(multiset(written)).toEqual(multiset(pdfEntityGroups));
    const again = parseUnderlayEntity('pdf', written, 'fallback');
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value).toEqual(r.value);
  });

  it('defaults: layer 0, unit scales, rotation 0, underlay on', () => {
    const r = parseUnderlayEntity('dwf', G([[340, 'AA'], [10, '0'], [20, '0']]), 'x');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.layer).toBe('0');
    expect(r.value.scaleX).toBe(1);
    expect(r.value.scaleY).toBe(1);
    expect(r.value.rotation).toBe(0);
    expect(r.value.flags & 2).toBe(2);
  });

  it('parses a clip boundary from 14/24 point pairs', () => {
    const groups = G([[340, 'AA'], [10, '0'], [20, '0'], [70, '3'], [14, '0'], [24, '0'], [14, '50'], [24, '0'], [14, '50'], [24, '40']]);
    const r = parseUnderlayEntity('pdf', groups, 'x');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.clipBoundary).toEqual([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 40 }]);
    const written = writeUnderlayEntity(r.value);
    expect(multiset(written)).toEqual(multiset(groups));
  });

  it('refuses atomically: missing definition reference, missing insertion, non-numeric modeled data', () => {
    expect(parseUnderlayEntity('pdf', G([[10, '0'], [20, '0']]), 'x').ok).toBe(false);
    expect(parseUnderlayEntity('pdf', G([[340, 'AA'], [20, '0']]), 'x').ok).toBe(false);
    const badScale = parseUnderlayEntity('pdf', G([[340, 'AA'], [10, '0'], [20, '0'], [41, 'wide']]), 'x');
    expect(badScale.ok).toBe(false);
    if (!badScale.ok) expect(badScale.refusal).toMatch(/41/);
    const badPoint = parseUnderlayEntity('pdf', G([[340, 'AA'], [10, '0'], [20, '0'], [14, '1']]), 'x');
    expect(badPoint.ok).toBe(false); // a 14 with no following 24 is malformed, never half-kept
  });

  it('a duplicate scalar group keeps the first value and retains the rest (nothing silently dropped)', () => {
    const r = parseUnderlayEntity('pdf', G([[340, 'AA'], [10, '0'], [20, '0'], [41, '2'], [41, '9']]), 'x');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.scaleX).toBe(2);
    expect(r.value.retainedGroups).toContainEqual([41, '9']);
  });
});

describe('underlay definition codec', () => {
  it('parses a PDFDEFINITION; the stored path survives byte-for-byte', () => {
    const r = parseUnderlayDefinition('pdf', pdfDefGroups, 'fallback');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.handle).toBe('2E');
    expect(r.value.sourcePath).toBe('C:\\refs\\floor plan.pdf');
    expect(r.value.page).toBe('Sheet 1');
    expect(r.value.retainedGroups).toEqual([[330, '10'], [999, 'a comment group: retained']]);
  });

  it('round-trips the definition with no group lost', () => {
    const r = parseUnderlayDefinition('pdf', pdfDefGroups, 'fallback');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const written = writeUnderlayDefinition(r.value);
    expect(multiset(written)).toEqual(multiset(pdfDefGroups));
    const again = parseUnderlayDefinition('pdf', written, 'fallback');
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value).toEqual(r.value);
  });

  it('refuses a definition with no stored file name (a reference to nothing is not a reference)', () => {
    const r = parseUnderlayDefinition('dgn', G([[5, '9'], [2, 'Default']]), 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toMatch(/file name/);
  });

  it('DGN definitions keep their model name in the page slot and retain the rest', () => {
    const r = parseUnderlayDefinition('dgn', G([[1, 'site.dgn'], [2, 'Default'], [70, '1']]), 'd1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sourcePath).toBe('site.dgn');
    expect(r.value.page).toBe('Default');
    expect(r.value.retainedGroups).toEqual([[70, '1']]);
    expect(r.value.id).toBe('d1'); // no handle in the record: the caller's fallback id is used
  });
});
