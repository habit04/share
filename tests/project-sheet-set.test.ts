/**
 * P31A acceptance tests — sheet-set model with stable drawing/layout links.
 *
 * Written before the implementation (src/project/sheet-set.ts). The model is a
 * pure module: it does not touch Drawing state, the editor, or the filesystem.
 * Link targets are resolved through a caller-supplied resolver so integrity
 * checks (missing/renamed drawings and layouts) are testable headlessly.
 *
 * Native-format note: the DST XML adapter covers a bounded, documented subset
 * of the AutoCAD Sheet Set (.dst) XML structure. AutoCAD acceptance of emitted
 * files is a separate Windows/native gate and is NOT claimed by these tests.
 */
import { describe, expect, it } from 'vitest';
import {
  addSheet,
  createSheetSet,
  moveSheet,
  parseDstSubsetXml,
  parseSheetSetJson,
  sheetFieldValues,
  sheetSetToJson,
  toDstSubsetXml,
  validateSheetSetLinks,
  type SheetSetLinkResolver,
} from '../src/project/sheet-set';

const resolver = (files: Record<string, readonly string[]>): SheetSetLinkResolver =>
  (path) => {
    const layouts = files[path];
    return layouts ? { exists: true, layouts } : { exists: false, layouts: [] };
  };

describe('P31A sheet-set model', () => {
  it('creates an empty set and adds sheets with stable ids that survive reordering', () => {
    let set = createSheetSet({ name: 'Plant A' });
    set = addSheet(set, { number: 'E-101', title: 'Power plan', drawingPath: 'drawings/power.dwg', layoutName: 'Layout1' });
    set = addSheet(set, { number: 'E-102', title: 'Lighting plan', drawingPath: 'drawings/lighting.dwg', layoutName: 'Layout1' });
    const [idA = '', idB = ''] = set.sheets.map((s) => s.id);
    expect(idA).toBeTruthy();
    expect(idA).not.toBe(idB);
    const moved = moveSheet(set, idB, 0);
    expect(moved.sheets.map((s) => s.id)).toEqual([idB, idA]);
    expect(moved.sheets[0]?.number).toBe('E-102');
    // original untouched (immutable updates)
    expect(set.sheets.map((s) => s.id)).toEqual([idA, idB]);
  });

  it('round-trips through JSON preserving subsets, custom properties and broken links', () => {
    let set = createSheetSet({ name: 'Plant A', description: 'Rev C', customProperties: { Client: 'Acme' } });
    set = addSheet(set, {
      number: 'E-101', title: 'Power plan', drawingPath: 'drawings/gone.dwg', layoutName: 'Layout1',
      subset: 'Electrical', customProperties: { Discipline: 'E' },
    });
    const back = parseSheetSetJson(sheetSetToJson(set));
    expect(back).toEqual(set);
    expect(back.sheets).toHaveLength(1); // broken link entry is preserved, never dropped
  });

  it('rejects malformed JSON with a thrown error instead of a partial set', () => {
    expect(() => parseSheetSetJson('{"name": 42}')).toThrow();
    expect(() => parseSheetSetJson('not json')).toThrow();
  });

  it('reports missing drawings, missing layouts and duplicate numbers — and drops nothing', () => {
    let set = createSheetSet({ name: 'S' });
    set = addSheet(set, { number: 'E-101', title: 'A', drawingPath: 'a.dwg', layoutName: 'Layout1' });
    set = addSheet(set, { number: 'E-101', title: 'B', drawingPath: 'missing.dwg', layoutName: 'Layout1' });
    set = addSheet(set, { number: 'E-103', title: 'C', drawingPath: 'a.dwg', layoutName: 'NoSuchLayout' });
    const issues = validateSheetSetLinks(set, resolver({ 'a.dwg': ['Layout1', 'Layout2'] }));
    const kinds = issues.map((i) => i.kind).sort();
    expect(kinds).toEqual(['duplicate-number', 'missing-drawing', 'missing-layout']);
    expect(issues.find((i) => i.kind === 'missing-drawing')?.sheetNumber).toBe('E-101');
    expect(issues.find((i) => i.kind === 'missing-layout')?.sheetNumber).toBe('E-103');
    expect(set.sheets).toHaveLength(3);
  });

  it('a renamed drawing is a missing-drawing report for the old path, not a silent retarget', () => {
    let set = createSheetSet({ name: 'S' });
    set = addSheet(set, { number: '1', title: 'A', drawingPath: 'old-name.dwg', layoutName: 'Layout1' });
    const issues = validateSheetSetLinks(set, resolver({ 'new-name.dwg': ['Layout1'] }));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('missing-drawing');
    expect(set.sheets[0]?.drawingPath).toBe('old-name.dwg');
  });

  it('produces \\AcSm field values matching the fields.ts context keys', () => {
    let set = createSheetSet({ name: 'Plant A' });
    set = addSheet(set, { number: 'E-101', title: 'Power plan', drawingPath: 'a.dwg', layoutName: 'Layout1' });
    const values = sheetFieldValues(set, set.sheets[0]?.id ?? '');
    expect(values['Sheet.Number']).toBe('E-101');
    expect(values['Sheet.Title']).toBe('Power plan');
    expect(values['SheetSet.Name']).toBe('Plant A');
  });
});

describe('P31A DST XML subset interop', () => {
  const DST = `<?xml version="1.0" encoding="UTF-8"?>
<AcSmSheetSet>
  <Name>Plant A</Name>
  <AcSmSubset><Name>Electrical</Name>
    <AcSmSheet><Number>E-101</Number><Title>Power plan</Title><LayoutName>Layout1</LayoutName><FilePath>drawings/power.dwg</FilePath></AcSmSheet>
  </AcSmSubset>
  <AcSmSheet><Number>E-001</Number><Title>Cover</Title><LayoutName>Layout1</LayoutName><FilePath>drawings/cover.dwg</FilePath><VendorExtension>opaque-keepme</VendorExtension></AcSmSheet>
  <FutureComponent version="99">unmodeled</FutureComponent>
</AcSmSheetSet>`;

  it('parses the subset structure and preserves unmodeled XML verbatim', () => {
    const set = parseDstSubsetXml(DST);
    expect(set.name).toBe('Plant A');
    expect(set.sheets.map((s) => s.number)).toEqual(['E-101', 'E-001']);
    expect(set.sheets[0]?.subset).toBe('Electrical');
    expect(set.opaqueFragments?.join('\n')).toContain('FutureComponent');
    expect(set.opaqueFragments?.join('\n')).toContain('VendorExtension');
  });

  it('emits XML that re-parses to the same sheets and keeps opaque fragments', () => {
    const set = parseDstSubsetXml(DST);
    const xml = toDstSubsetXml(set);
    const back = parseDstSubsetXml(xml);
    expect(back.sheets.map((s) => [s.number, s.title, s.drawingPath, s.layoutName])).toEqual(
      set.sheets.map((s) => [s.number, s.title, s.drawingPath, s.layoutName]),
    );
    expect(xml).toContain('FutureComponent');
    expect(xml).toContain('opaque-keepme');
  });

  it('escapes XML special characters in titles and paths', () => {
    let set = createSheetSet({ name: 'A & B <Plant>' });
    set = addSheet(set, { number: '1', title: 'R&D <notes>', drawingPath: 'a&b.dwg', layoutName: 'L' });
    const xml = toDstSubsetXml(set);
    expect(xml).toContain('R&amp;D &lt;notes&gt;');
    const back = parseDstSubsetXml(xml);
    expect(back.name).toBe('A & B <Plant>');
    expect(back.sheets[0]?.title).toBe('R&D <notes>');
    expect(back.sheets[0]?.drawingPath).toBe('a&b.dwg');
  });
});

describe('P31A DST preservation regressions (checkpoint-1 acceptance b3/b4)', () => {
  const DST_ATTR = `<AcSmSheetSet Version="3"><Name>Plant A</Name><AcSmSubset SubId="7"><Name>Electrical</Name><AcSmSheet DataOwner="smith"><Number fmt="p">E-101</Number><Title>Power plan</Title><LayoutName>Layout1</LayoutName><FilePath>drawings/power.dwg</FilePath></AcSmSheet></AcSmSubset></AcSmSheetSet>`;

  it('(b3) attributes on modeled DST elements are preserved and re-emitted, not silently dropped', () => {
    const set = parseDstSubsetXml(DST_ATTR);
    expect(set.dstAttributes).toEqual({ Version: '3' });
    expect(set.dstSubsetAttributes).toEqual({ Electrical: { SubId: '7' } });
    expect(set.sheets[0]?.dstAttributes).toEqual({ DataOwner: 'smith' });
    expect(set.sheets[0]?.dstLeafAttributes).toEqual({ Number: { fmt: 'p' } });
    const xml = toDstSubsetXml(set);
    expect(xml).toContain('<AcSmSheetSet Version="3">');
    expect(xml).toContain('<AcSmSubset SubId="7">');
    expect(xml).toContain('<AcSmSheet DataOwner="smith">');
    expect(xml).toContain('<Number fmt="p">E-101</Number>');
    // and they survive a second round trip (parse the re-emission)
    const back = parseDstSubsetXml(xml);
    expect(back.dstAttributes).toEqual({ Version: '3' });
    expect(back.sheets[0]?.dstAttributes).toEqual({ DataOwner: 'smith' });
    expect(back.sheets[0]?.dstLeafAttributes).toEqual({ Number: { fmt: 'p' } });
  });

  it('(b3) DST attributes also survive the JSON form', () => {
    const set = parseDstSubsetXml(DST_ATTR);
    const back = parseSheetSetJson(sheetSetToJson(set));
    expect(back).toEqual(set);
    expect(back.sheets[0]?.dstLeafAttributes).toEqual({ Number: { fmt: 'p' } });
  });

  it('(b4) an unknown element nested inside a modeled leaf is preserved, never silently discarded', () => {
    const xml = `<AcSmSheetSet><Name>Plant A</Name><AcSmSheet><Number>E-101</Number><Title>Plan <Emph>North</Emph> Wing</Title><LayoutName>Layout1</LayoutName><FilePath>drawings/power.dwg</FilePath></AcSmSheet></AcSmSheetSet>`;
    const set = parseDstSubsetXml(xml);
    // the leaf's own text is still the concatenation of its text nodes
    expect(set.sheets[0]?.title).toBe('Plan  Wing');
    // and the nested element is carried verbatim in opaqueFragments
    expect(set.opaqueFragments?.join('\n')).toContain('<Emph>North</Emph>');
    const out = toDstSubsetXml(set);
    expect(out).toContain('<Emph>North</Emph>');
  });

  it('malformed attribute syntax in a DST document throws (atomic refusal, no partial set)', () => {
    expect(() => parseDstSubsetXml('<AcSmSheetSet Version=3><Name>X</Name></AcSmSheetSet>')).toThrow();
    expect(() => parseDstSubsetXml('<AcSmSheetSet Version="3><Name>X</Name></AcSmSheetSet>')).toThrow();
  });
});
