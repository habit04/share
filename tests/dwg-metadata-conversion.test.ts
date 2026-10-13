import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { convertDwg, type DwgImportPayload } from '../src/io/dwg';
import type { NativeDwgMetadata } from '../scripts/dwg-native-metadata.mjs';
import type { DwgEntity } from '@mlightcad/libredwg-web';
const dxf = readFileSync(new URL('./fixtures/interchange/r2018-views-fields.dxf', import.meta.url), 'utf8');
const oracle = JSON.parse(readFileSync(new URL('./fixtures/interchange/r2018-views-fields.expected.json', import.meta.url), 'utf8')) as { records: { type: string; handle: string }[] };
const metadata = (): NativeDwgMetadata => ({ schemaVersion: 1, dxf, objects: oracle.records.map(record => ({ handle: record.handle, type: record.type, dxfType: record.type, supertype: 'object' })), readError: 0, writeError: 0, complete: true, notes: [] });
const payload = (): DwgImportPayload => ({ header: {}, entities: [
  { type: 'LINE', handle: '18D', layer: '0', colorIndex: 256, startPoint: { x: 100, y: 200, z: 0 }, endPoint: { x: 110, y: 200, z: 0 } },
  { type: 'LINE', handle: '18E', layer: '0', colorIndex: 256, startPoint: { x: 100, y: 210, z: 0 }, endPoint: { x: 105, y: 215, z: 0 } },
  { type: 'MTEXT', handle: '18F', layer: '0', colorIndex: 256, insertionPoint: { x: 100, y: 205, z: 0 }, textHeight: 1, rectWidth: 30, text: 'Drawing: filename' },
] as unknown as DwgEntity[], layers: [], blocks: [], nativeMetadata: metadata() });
describe('Windows native DWG metadata interpretation', () => {
  it('uses the checked projection for named cameras, native fields, annotation and exact object graph', () => {
    const result = convertDwg(payload(), 'C:/Drawings/north-site.dwg');
    expect(result.state.cadGraph?.sourceFormat).toBe('DWG');
    expect(result.state.header!.views).toHaveLength(3);
    expect(result.state.entities.find(e => e.type === 'mtext')).toMatchObject({ text: 'Drawing: north-site', field: { code: 'Drawing: %<\\AcVar Filename \\f "%fn2">%' } });
    expect(result.state.cadGraph!.nodes.find(node => node.type === 'XRECORD' && node.groups.some(([code]) => code === 160))!.groups.find(([code]) => code === 160)![1].trim()).toBe('9007199254740993');
    expect(result.report?.counts.XDATA?.unsupported).toBeUndefined();
  });
  it('requires inventory coverage rather than trusting writeError zero or the complete flag', () => {
    const data = payload(); data.nativeMetadata!.objects.push({ handle: 'FFFFFFFFFFFFFFFF', type: 'FIELD', dxfType: 'FIELD', supertype: 'object' });
    const result = convertDwg(data);
    expect(result.state.cadGraph).toBeUndefined();
    expect(result.report!.items).toContainEqual(expect.objectContaining({ type: 'CAD_METADATA', action: 'unsupported', reason: expect.stringContaining('FIELD FFFFFFFFFFFFFFFF') }));
  });
  it('falls back with explicit loss when native read status is not clean', () => {
    const data = payload(); data.nativeMetadata!.readError = 64;
    const result = convertDwg(data);
    expect(result.state.cadGraph).toBeUndefined();
    expect(result.report!.counts.CAD_METADATA!.unsupported).toBe(1);
  });
});
