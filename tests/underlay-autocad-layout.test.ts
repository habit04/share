/**
 * v0.6.4 pre-release review finding F-F (P0): the underlay codec used the
 * wrong DXF layout — subclass markers AcDbPdfUnderlay / AcDbPdfDefinition,
 * flags as 70, contrast as 280, fade as 281, clip as 14/24, a definition
 * with no 100 marker at all, and CLASS records naming AcDbPdfUnderlay under
 * app "ISM". AutoCAD 2027 discarded every JCad-saved drawing holding a PDF
 * underlay ("Class separator for class AcDbUnderlayReference expected",
 * then "Unexpected DXF group code: 70", ...), and read an AutoCAD record's
 * 280 = 3 as contrast 3 and 281 = 40 as fade 40.
 *
 * Ground truth: the AutoCAD DXF Reference (UNDERLAY / UNDERLAYDEFINITION),
 * ezdxf 1.3.5 (entities/underlay.py, sections/classes.py), and the gate's
 * AutoCAD 2027 DXFOUT committed as
 * tests/fixtures/interchange/r2018-pdf-underlay-acad2027.dxf (provenance
 * in PROVENANCE.md). Entity: 100 AcDbUnderlayReference; 340 definition;
 * 10/20/30 insertion; 41/42/43 scales; 50 rotation; 280 flags; 281
 * contrast (20..100); 282 fade (0..80); clip as repeated 11/21 pairs.
 * Definition: 100 AcDbUnderlayDefinition; 1 file; 2 page. CLASS:
 * PDFUNDERLAY -> AcDbPdfReference / "ObjectDBX Classes" / 4095 / entity;
 * PDFDEFINITION -> AcDbPdfDefinition / "ObjectDBX Classes" / 1153.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { UnderlayEntity } from '../src/core/entities';
import { readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf } from '../src/io/import-report';
import { parseUnderlayEntity, writeUnderlayEntity, writeUnderlayDefinition } from '../src/io/dxf/underlay-codec';

const GOLDEN = 'tests/fixtures/interchange/r2018-pdf-underlay-acad2027.dxf';

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
const group = (rec: Rec, code: number): string | undefined => rec.groups.find(([c]) => c === code)?.[1];
const codes = (rec: Rec): number[] => rec.groups.map(([c]) => c);
const classOf = (recs: Rec[], name: string, cpp: string): Rec | undefined => recs.find((r) => r.kind === 'CLASS' && group(r, 1) === name && group(r, 2) === cpp);

describe('F-F: AutoCAD 2027 PDFUNDERLAY fixture (read)', () => {
  const state = readDxf(readFileSync(GOLDEN, 'utf8'));
  const e = state.entities.find((x) => x.type === 'underlay') as UnderlayEntity;

  it('models AutoCAD\'s groups under the right names: flags 280, contrast 281, fade 282, clip 11/21', () => {
    expect(e).toBeDefined();
    expect(e).toMatchObject({ kind: 'pdf', layer: 'U', definitionHandle: '41', position: { x: 10, y: 20 }, scaleX: 2, scaleY: 2, rotation: 0, flags: 3, contrast: 40, fade: 10 });
    expect(e.clipBoundary).toEqual([{ x: 0, y: 50 }, { x: 100, y: 0 }]);
    // Unmodelled groups (Z, proxy graphics) ride retainedGroups; nothing of the record was misread.
    expect(e.retainedGroups).toContainEqual([30, '0.0']);
    expect(e.retainedGroups.some(([c]) => c === 310)).toBe(true);
    expect(e.retainedGroups.some(([c]) => c === 280 || c === 281 || c === 282 || c === 11 || c === 21)).toBe(false);
  });

  it('the dangling definition (AutoCAD\'s console DXFOUT left the PDFDEFINITION out) is reported, not refused', () => {
    expect(state.underlays).toBeUndefined();
    const items = importReportOf(state)?.items.filter((i) => i.type === 'PDFUNDERLAY') ?? [];
    expect(items.map((i) => i.action)).toEqual(['simplified']);
  });
});

describe('F-F: the written records are laid out as AutoCAD writes them', () => {
  const text = readFileSync(GOLDEN, 'utf8');

  it('PDFUNDERLAY: AcDbUnderlayReference, groups in AutoCAD order, retained Z / proxy graphics in place', () => {
    const out = writeDxf(readDxf(text));
    const recs = records(out);
    const und = recs.filter((r) => r.kind === 'PDFUNDERLAY');
    expect(und).toHaveLength(1);
    const u = und[0]!;
    expect(codes(u)).toEqual([5, 330, 100, 8, 160, 310, 100, 340, 10, 20, 30, 41, 42, 280, 281, 282, 11, 21, 11, 21]);
    expect(u.groups.filter(([c]) => c === 100).map(([, v]) => v)).toEqual(['AcDbEntity', 'AcDbUnderlayReference']);
    expect(group(u, 8)).toBe('U');
    expect(group(u, 340)).toBe('41'); // the stored reference, verbatim (dangling)
    expect(u.groups.filter(([c]) => c >= 280 && c <= 282).map(([, v]) => v)).toEqual(['3', '40', '10']);
    expect(u.groups.filter(([c]) => c === 11 || c === 21).map(([, v]) => v)).toEqual(['0', '50', '100', '0']);
    expect(out).not.toContain('AcDbPdfUnderlay\r\n340'); // never the old marker on the entity
    // CLASS registration as AutoCAD writes it.
    const cls = classOf(recs, 'PDFUNDERLAY', 'AcDbPdfReference')!;
    expect(cls).toBeDefined();
    expect(group(cls, 3)).toBe('ObjectDBX Classes');
    expect(group(cls, 90)!.trim()).toBe('4095');
    expect(group(cls, 281)!.trim()).toBe('1');
    // The second save writes the identical placement record.
    const again = records(writeDxf(readDxf(out))).find((r) => r.kind === 'PDFUNDERLAY')!;
    expect(again.groups).toEqual(u.groups);
  });

  it('PDFDEFINITION: AcDbUnderlayDefinition marker, 1 file, 2 page; joined to the placement; CLASS 1153', () => {
    // Supply the definition AutoCAD's console DXFOUT omitted, in AutoCAD's own layout.
    const withDef = text.replace(/\r?\n\s*0\r?\nENDSEC\r?\n\s*0\r?\nEOF/, '\r\n  0\r\nPDFDEFINITION\r\n  5\r\n41\r\n330\r\nC\r\n100\r\nAcDbUnderlayDefinition\r\n  1\r\nreal.pdf\r\n  2\r\n1\r\n  0\r\nENDSEC\r\n  0\r\nEOF');
    expect(withDef).not.toBe(text);
    const state = readDxf(withDef);
    expect(Object.values(state.underlays ?? {})).toHaveLength(1);
    expect(Object.values(state.underlays!)[0]).toMatchObject({ handle: '41', kind: 'pdf', sourcePath: 'real.pdf', page: '1' });
    // Joined: no 'simplified' (dangling) or 'dropped' entry for the placement.
    expect(importReportOf(state)?.items.filter((i) => i.type === 'PDFUNDERLAY') ?? []).toEqual([]);
    const out = writeDxf(state);
    const recs = records(out);
    const def = recs.find((r) => r.kind === 'PDFDEFINITION')!;
    expect(def).toBeDefined();
    expect(codes(def)).toEqual([5, 102, 330, 102, 330, 100, 1, 2]); // B-2: reactor + owner name ACAD_PDFDEFINITIONS
    expect(group(def, 100)).toBe('AcDbUnderlayDefinition');
    expect(group(def, 1)).toBe('real.pdf');
    expect(group(def, 2)).toBe('1');
    const und = recs.find((r) => r.kind === 'PDFUNDERLAY')!;
    expect(group(und, 340)).toBe(group(def, 5));
    const cls = classOf(recs, 'PDFDEFINITION', 'AcDbPdfDefinition')!;
    expect(cls).toBeDefined();
    expect(group(cls, 3)).toBe('ObjectDBX Classes');
    expect(group(cls, 90)!.trim()).toBe('1153');
    expect(group(cls, 281)!.trim()).toBe('0');
    expect(out).not.toContain('AcDbObject\r\n100\r\nAcDbPdfDefinition');
  });

  it('a JCad-authored state (no retained groups) writes the same layout', () => {
    const out = writeDxf({
      entities: [{ id: 'u', layer: '0', color: 'ByLayer', type: 'underlay', kind: 'dwf', definitionHandle: '41', position: { x: 1, y: 2 }, scaleX: 1, scaleY: 1, rotation: 0, flags: 2, contrast: 50, fade: 10, retainedGroups: [] }],
      layers: [], blocks: {}, currentLayer: '0',
      underlays: { 'underlaydef:41': { id: 'underlaydef:41', handle: '41', kind: 'dwf', sourcePath: 'site.dwf', page: 'Sheet A', retainedGroups: [] } },
    });
    const recs = records(out);
    const u = recs.find((r) => r.kind === 'DWFUNDERLAY')!;
    expect(codes(u)).toEqual([5, 330, 100, 8, 100, 340, 10, 20, 281, 282]);
    expect(group(u, 100)).toBe('AcDbEntity');
    expect(u.groups[4]).toEqual([100, 'AcDbUnderlayReference']);
    const def = recs.find((r) => r.kind === 'DWFDEFINITION')!;
    expect(codes(def)).toEqual([5, 102, 330, 102, 330, 100, 1, 2]);
    expect(classOf(recs, 'DWFUNDERLAY', 'AcDbDwfReference')).toBeDefined();
    expect(classOf(recs, 'DWFDEFINITION', 'AcDbDwfDefinition')).toBeDefined();
  });
});

describe('F-F: codec semantics', () => {
  it('the reviewer\'s scenario: 280 3 / 281 100 / 282 0 / 11 0 21 0 11 100 21 50 reads as flags 3, contrast 100, fade 0, a 2-point clip', () => {
    const r = parseUnderlayEntity('pdf', [[340, '41'], [10, '0'], [20, '0'], [280, '3'], [281, '100'], [282, '0'], [11, '0'], [21, '0'], [11, '100'], [21, '50']], 'x');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ flags: 3, contrast: 100, fade: 0, clipBoundary: [{ x: 0, y: 0 }, { x: 100, y: 50 }] });
  });

  it('contrast and fade are clamped to AutoCAD\'s ranges on write only; the parsed value is kept as read', () => {
    const r = parseUnderlayEntity('pdf', [[340, '41'], [10, '0'], [20, '0'], [281, '3'], [282, '100']], 'x');
    expect(r.ok && r.value.contrast).toBe(3);
    expect(r.ok && r.value.fade).toBe(100);
    if (!r.ok) return;
    const w = writeUnderlayEntity(r.value);
    expect(w.find(([c]) => c === 281)![1]).toBe('20');
    expect(w.find(([c]) => c === 282)![1]).toBe('80');
    // A 70 / 14 / 24 group is NOT an underlay field any more: retained verbatim, never a model value.
    const old = parseUnderlayEntity('pdf', [[340, '41'], [10, '0'], [20, '0'], [70, '3'], [14, '1'], [24, '2']], 'x');
    expect(old.ok && old.value.flags).toBe(2);
    expect(old.ok && old.value.clipBoundary).toBeUndefined();
    expect(old.ok && old.value.retainedGroups).toEqual([[70, '3'], [14, '1'], [24, '2']]);
  });

  it('the definition record carries exactly one subclass marker', () => {
    const groups = writeUnderlayDefinition({ id: 'd', handle: '41', kind: 'dgn', sourcePath: 'site.dgn', page: 'Default', retainedGroups: [[330, 'C']] });
    expect(groups).toEqual([[5, '41'], [330, 'C'], [100, 'AcDbUnderlayDefinition'], [1, 'site.dgn'], [2, 'Default']]);
  });
});
