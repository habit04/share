/**
 * v0.6.4 re-review follow-up (2): records written by the pre-fix JCad
 * codec (subclass marker AcDbPdfUnderlay / AcDbDwfUnderlay /
 * AcDbDgnUnderlay, flags 70, contrast 280, fade 281, clip 14/24) are
 * remapped to AutoCAD's codes on read, so they read as intended and are
 * written in AutoCAD's layout with no stray 70 / 14 / 24. A record with
 * AutoCAD's marker is never remapped.
 */
import { describe, it, expect } from 'vitest';
import type { UnderlayEntity } from '../src/core/entities';
import { readDxf, writeDxf } from '../src/io/dxf';
import { parseUnderlayEntity, writeUnderlayEntity } from '../src/io/dxf/underlay-codec';

const LEGACY = [
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'PDFUNDERLAY', '5', '40', '330', '1F', '100', 'AcDbEntity', '8', 'U', '100', 'AcDbPdfUnderlay',
  '340', '41', '10', '10', '20', '20', '41', '2', '42', '3', '70', '3', '280', '100', '281', '10',
  '14', '0', '24', '0', '14', '100', '24', '50',
  '0', 'ENDSEC',
  '0', 'SECTION', '2', 'OBJECTS',
  '0', 'PDFDEFINITION', '5', '41', '330', 'C', '100', 'AcDbObject', '100', 'AcDbPdfDefinition', '1', 'plans\\floor.pdf', '2', 'Sheet1',
  '0', 'ENDSEC', '0', 'EOF',
].join('\n');

type Rec = { kind: string; groups: Array<[number, string]> };
function records(text: string): Rec[] {
  const lines = text.split(/\r?\n/);
  const out: Rec[] = [];
  let cur: Rec | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]!.trim());
    const value = lines[i + 1]!.trim();
    if (code === 0) { cur = { kind: value, groups: [] }; out.push(cur); } else cur?.groups.push([code, value]);
  }
  return out;
}

describe('re-review (2): pre-fix JCad underlay records are remapped on read', () => {
  it('codec: 70 3 / 280 100 / 281 10 / 14-24 clip under AcDbPdfUnderlay reads as flags 3, contrast 100, fade 10, clip', () => {
    const r = parseUnderlayEntity('pdf', [[100, 'AcDbEntity'], [8, 'U'], [100, 'AcDbPdfUnderlay'], [340, '41'], [10, '0'], [20, '0'], [70, '3'], [280, '100'], [281, '10'], [14, '0'], [24, '0'], [14, '100'], [24, '50']], 'x');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ flags: 3, contrast: 100, fade: 10, clipBoundary: [{ x: 0, y: 0 }, { x: 100, y: 50 }] });
    expect(r.value.retainedGroups).toEqual([]);
    const written = writeUnderlayEntity(r.value);
    const codes = written.map(([c]) => c);
    expect(codes.filter((c) => [70, 14, 24].includes(c))).toEqual([]);
    expect(codes).toEqual([100, 8, 100, 340, 10, 20, 280, 281, 282, 11, 21, 11, 21]);
    expect(written.filter(([c]) => c === 100).map(([, v]) => v)).toEqual(['AcDbEntity', 'AcDbUnderlayReference']);
  });

  it('codec: the same codes under AutoCAD\'s marker are NOT remapped (70 / 14 / 24 stay retained groups)', () => {
    const r = parseUnderlayEntity('pdf', [[100, 'AcDbUnderlayReference'], [340, '41'], [10, '0'], [20, '0'], [70, '3'], [280, '100'], [281, '10'], [14, '1'], [24, '2']], 'x');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ flags: 100, contrast: 10 });
    expect(r.value.fade).toBeUndefined();
    expect(r.value.clipBoundary).toBeUndefined();
    expect(r.value.retainedGroups).toEqual([[70, '3'], [14, '1'], [24, '2']]);
  });

  it('full read -> write of a pre-fix file: model as intended, output in AutoCAD\'s layout, second save stable', () => {
    const state = readDxf(LEGACY);
    const e = state.entities.find((x) => x.type === 'underlay') as UnderlayEntity;
    expect(e).toMatchObject({ flags: 3, contrast: 100, fade: 10, scaleX: 2, scaleY: 3 });
    expect(e.clipBoundary).toEqual([{ x: 0, y: 0 }, { x: 100, y: 50 }]);
    const out = writeDxf(state);
    const u = records(out).find((r) => r.kind === 'PDFUNDERLAY')!;
    expect(u.groups.map(([c]) => c)).toEqual([5, 330, 100, 8, 100, 340, 10, 20, 41, 42, 280, 281, 282, 11, 21, 11, 21]);
    expect(u.groups.filter(([c]) => c === 100).map(([, v]) => v)).toEqual(['AcDbEntity', 'AcDbUnderlayReference']);
    expect(u.groups.filter(([c]) => c >= 280 && c <= 282).map(([, v]) => v)).toEqual(['3', '100', '10']);
    expect(out).not.toContain('AcDbPdfUnderlay\r\n340');
    expect(writeDxf(readDxf(out))).toBe(out);
  });
});
