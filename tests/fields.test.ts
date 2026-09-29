import { describe, it, expect } from 'vitest';
import type { TextEntity, MTextEntity } from '../src/core/entities';
import { evaluateFields, formatFieldDate, formatFilename, hasFields, acVarField, julianToDate, FIELD_UNAVAILABLE, FIELD_EMPTY } from '../src/core/fields';
import { readDxf, writeDxf } from '../src/io/dxf';
import { Drawing } from '../src/core/document';
import { fakeContext, drive } from './fake-context';
import { fieldTool, updateFieldTool, updateFields } from '../src/tools/drafting-annot';

const props = { layer: '0', color: 'ByLayer' as const };
const when = new Date(2024, 2, 5, 14, 7, 9); // 5 March 2024 14:07:09 local time

describe('field expressions', () => {
  it('formats dates with .NET-style tokens', () => {
    expect(formatFieldDate(when, 'M/d/yyyy')).toBe('3/5/2024');
    expect(formatFieldDate(when, 'MM/dd/yy')).toBe('03/05/24');
    expect(formatFieldDate(when, 'dddd, MMMM d, yyyy')).toBe('Tuesday, March 5, 2024');
    expect(formatFieldDate(when, 'd-MMM-yy h:mm tt')).toBe('5-Mar-24 2:07 PM');
    expect(formatFieldDate(when, 'HH:mm:ss')).toBe('14:07:09');
  });
  it('evaluates \\AcVar Date / CreateDate / SaveDate / PlotDate with and without a format', () => {
    const ctx = { now: when, createDate: new Date(2020, 0, 2), saveDate: new Date(2023, 11, 31) };
    expect(evaluateFields('Printed %<\\AcVar Date \\f "M/d/yyyy">%', ctx)).toBe('Printed 3/5/2024');
    expect(evaluateFields('%<\\AcVar Date>%', ctx)).toBe('3/5/2024');
    expect(evaluateFields('%<\\AcVar CreateDate \\f "yyyy-MM-dd">%', ctx)).toBe('2020-01-02');
    expect(evaluateFields('%<\\AcVar SaveDate>%', ctx)).toBe('12/31/2023');
    expect(evaluateFields('%<\\AcVar PlotDate>%', ctx)).toBe(FIELD_EMPTY);
  });
  it('evaluates Filename with the %fn bit options and %tc text case', () => {
    const ctx = { filePath: 'C:\\Projects\\Plant\\E-101.dxf' };
    expect(evaluateFields('%<\\AcVar Filename>%', ctx)).toBe('E-101.dxf');
    expect(evaluateFields('%<\\AcVar Filename \\f "%fn2">%', ctx)).toBe('E-101');
    expect(evaluateFields('%<\\AcVar Filename \\f "%tc1%fn7">%', ctx)).toBe('C:\\PROJECTS\\PLANT\\E-101.DXF');
    expect(formatFilename('/home/u/a.b/sheet.dxf', '%fn1')).toBe('/home/u/a.b/');
    expect(evaluateFields('%<\\AcVar Filename>%', {})).toBe(FIELD_UNAVAILABLE);
  });
  it('evaluates drawing properties, Login, \\AcSm sheet values and flags unknown fields', () => {
    const ctx = { title: 'Motor control', author: 'jr', subject: '', comments: 'rev B', login: 'drafter', sheetSet: { 'Sheet.Number': '07' } };
    expect(evaluateFields('%<\\AcVar Title>% by %<\\AcVar Author \\f "%tc1">%', ctx)).toBe('Motor control by JR');
    expect(evaluateFields('%<\\AcVar Subject>%', ctx)).toBe(FIELD_EMPTY);
    expect(evaluateFields('%<\\AcVar Comments>%/%<\\AcVar Login>%', ctx)).toBe('rev B/drafter');
    expect(evaluateFields('Sheet %<\\AcSm Sheet.Number>%', ctx)).toBe('Sheet 07');
    expect(evaluateFields('%<\\AcObjProp Object(%<\\_ObjId 123>%).Area>%', ctx)).toBe(FIELD_UNAVAILABLE);
    expect(evaluateFields('%<\\AcVar Bogus>%', ctx)).toBe(FIELD_UNAVAILABLE);
    expect(hasFields('no fields')).toBe(false);
    expect(acVarField('Date', 'M/d/yyyy')).toBe('%<\\AcVar Date \\f "M/d/yyyy">%');
    expect(julianToDate(2440587.5)!.getTime()).toBe(0);
  });
});

describe('fields in DXF TEXT / MTEXT', () => {
  const dxf = (entities: string[], header: string[] = []) => ['0', 'SECTION', '2', 'HEADER', ...header, '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', ...entities, '0', 'ENDSEC', '0', 'EOF'].join('\n');
  it('shows the evaluated value and writes the field code back', () => {
    const text = dxf(
      [
        '0', 'TEXT', '8', '0', '10', '0', '20', '0', '40', '0.2', '1', 'DWG: %<\\AcVar Filename \\f "%fn2">%',
        '0', 'MTEXT', '8', '0', '10', '0', '20', '5', '40', '0.2', '41', '0', '71', '1', '1', 'Created %<\\AcVar CreateDate \\f "yyyy">%\\Pby %<\\AcVar Author>%',
      ],
      ['9', '$TDCREATE', '40', '2451545.0'],
    );
    const s = readDxf(text, { filePath: '/jobs/E-200.dxf', fieldContext: { author: 'JR' } });
    const [t, m] = s.entities as [TextEntity, MTextEntity];
    expect(t.text).toBe('DWG: E-200');
    expect(t.field!.code).toBe('DWG: %<\\AcVar Filename \\f "%fn2">%');
    expect(m.text).toBe('Created 2000\nby JR');
    const out = writeDxf(s);
    expect(out).toContain('DWG: %<\\AcVar Filename \\f "%fn2">%');
    expect(out).toContain('Created %<\\AcVar CreateDate \\f "yyyy">%\\Pby %<\\AcVar Author>%');
    // An edited text drops the field.
    const out2 = writeDxf({ ...s, entities: [{ ...t, text: 'MANUAL' }] });
    expect(out2).not.toContain('AcVar');
  });
});

describe('FIELD and UPDATEFIELD commands', () => {
  it('FIELD inserts text holding a Filename field', () => {
    const doc = new Drawing();
    doc.filePath = '/jobs/panel-3.dxf';
    const ctx = fakeContext(doc);
    drive(fieldTool(), ctx, ['Filename', 'N', { x: 1, y: 2 }]);
    const t = doc.entities[0] as TextEntity;
    expect(t.text).toBe('panel-3');
    expect(t.field!.code).toBe('%<\\AcVar Filename \\f "%fn2">%');
    expect(t.position).toEqual({ x: 1, y: 2 });
  });
  it('FIELD with a date format picked by number', () => {
    const doc = new Drawing();
    const ctx = fakeContext(doc);
    drive(fieldTool(), ctx, ['Date', '5', { x: 0, y: 0 }]);
    const t = doc.entities[0] as TextEntity;
    expect(t.field!.code).toBe('%<\\AcVar Date \\f "yyyy-MM-dd">%');
    expect(t.text).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('UPDATEFIELD re-evaluates selected fields; edited texts are left alone', () => {
    const doc = new Drawing();
    const code = '%<\\AcVar Filename>%';
    doc.addEntities([
      { id: 'a', ...props, type: 'text', position: { x: 0, y: 0 }, text: '####', height: 0.2, rotation: 0, align: 'left', field: { code, value: '####' } },
      { id: 'b', ...props, type: 'text', position: { x: 0, y: 1 }, text: 'typed over', height: 0.2, rotation: 0, align: 'left', field: { code, value: '####' } },
    ]);
    doc.filePath = '/x/y/sheet.dxf';
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['a', 'b']);
    drive(updateFieldTool(), ctx, []);
    expect((doc.entity('a') as TextEntity).text).toBe('sheet.dxf');
    expect((doc.entity('b') as TextEntity).text).toBe('typed over');
    expect(ctx.logs).toContain('2 field(s) found.');
    expect(ctx.logs).toContain('1 field(s) updated.');
    expect(updateFields(doc.entities, { filePath: '/x/y/sheet.dxf' }).changed).toHaveLength(0);
  });
});
