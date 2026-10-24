/**
 * v0.6.4 pre-release review finding F-G (P1): SCALE / ROTATE of an imported
 * underlay wrote two conflicting groups. The codec keeps explicit
 * default-valued copies (41 1.0, 42 1.0, 50 0.0, ...) as retained groups so
 * an unchanged record round-trips verbatim; affineCompound changes
 * scaleX / scaleY / rotation but keeps retainedGroups, and the writer
 * emitted the retained copies after the canonical groups — "41 2 ... 41
 * 1.0", and AutoCAD took the last value, losing the edit.
 *
 * The codec now slots retained groups into AutoCAD's order and drops a
 * retained copy of any code the canonical emission writes: each code
 * appears once, with the edited value. An unchanged record still writes
 * its explicit defaults verbatim.
 */
import { describe, it, expect } from 'vitest';
import type { UnderlayEntity } from '../src/core/entities';
import { rotateEntity, scaleEntityBy } from '../src/core/entities';
import { readDxf, writeDxf } from '../src/io/dxf';

const DXF = [
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'PDFUNDERLAY', '5', '40', '330', '1F', '100', 'AcDbEntity', '8', 'U', '100', 'AcDbUnderlayReference',
  '340', '41', '10', '10.0', '20', '20.0', '30', '0.0', '41', '1.0', '42', '1.0', '43', '1.0', '50', '0.0', '280', '2', '281', '100', '282', '0',
  '0', 'ENDSEC',
  '0', 'SECTION', '2', 'OBJECTS',
  '0', 'PDFDEFINITION', '5', '41', '330', 'C', '100', 'AcDbUnderlayDefinition', '1', 'real.pdf', '2', '1',
  '0', 'ENDSEC', '0', 'EOF',
].join('\n');

type Rec = { kind: string; groups: Array<[number, string]> };
function underlayRecord(text: string): Rec {
  const lines = text.split(/\r?\n/);
  let cur: Rec | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]!.trim());
    const value = lines[i + 1]!.trim();
    if (code === 0) { if (cur) return cur; if (value === 'PDFUNDERLAY') cur = { kind: value, groups: [] }; } else cur?.groups.push([code, value]);
  }
  return cur!;
}
const values = (rec: Rec, code: number): string[] => rec.groups.filter(([c]) => c === code).map(([, v]) => v);

describe('F-G: an edited imported underlay writes each group once, with the new value', () => {
  it('unchanged: the explicit defaults round-trip verbatim, once each', () => {
    const rec = underlayRecord(writeDxf(readDxf(DXF)));
    expect(values(rec, 41)).toEqual(['1.0']);
    expect(values(rec, 42)).toEqual(['1.0']);
    expect(values(rec, 50)).toEqual(['0.0']);
    expect(values(rec, 280)).toEqual(['2']);
    expect(rec.groups.map(([c]) => c)).toEqual([5, 330, 100, 8, 100, 340, 10, 20, 30, 41, 42, 43, 50, 280, 281, 282]);
  });

  it('SCALE x2 then ROTATE 90°: 41 / 42 / 50 appear exactly once, with the edited values', () => {
    const state = readDxf(DXF);
    const e = state.entities.find((x) => x.type === 'underlay') as UnderlayEntity;
    const scaled = scaleEntityBy(e, { x: 0, y: 0 }, 2) as UnderlayEntity;
    const edited = rotateEntity(scaled, { x: 0, y: 0 }, Math.PI / 2) as UnderlayEntity;
    expect(edited.retainedGroups).toBe(e.retainedGroups); // transforms never touch retained data
    const text = writeDxf({ ...state, entities: state.entities.map((x) => (x === e ? edited : x)) });
    const rec = underlayRecord(text);
    expect(values(rec, 41)).toEqual(['2']);
    expect(values(rec, 42)).toEqual(['2']);
    expect(values(rec, 50)).toEqual(['90']);
    // Untouched retained groups (Z, Z scale, flags, contrast, fade) are still there once each, in order.
    expect(rec.groups.map(([c]) => c)).toEqual([5, 330, 100, 8, 100, 340, 10, 20, 30, 41, 42, 43, 50, 280, 281, 282]);
    expect(values(rec, 43)).toEqual(['1.0']);
    // And the edit survives a reopen.
    const back = readDxf(text).entities.find((x) => x.type === 'underlay') as UnderlayEntity;
    expect(back.scaleX).toBe(2);
    expect(back.scaleY).toBe(2);
    expect(back.rotation).toBeCloseTo(Math.PI / 2);
  });
});
