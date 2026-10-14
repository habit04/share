import { describe, expect, it, vi } from 'vitest';
import { MAX_NATIVE_METADATA_DXF_BYTES, metadataGeometryReader, projectNativeMetadata, validateNativeMetadata } from '../scripts/dwg-native-metadata.mjs';

const projection = () => ({ schemaVersion: 1, dxf: '  0\r\nEOF\r\n', objects: [
  { handle: 'FFFFFFFFFFFFFFFF', type: 'VIEW', dxfType: 'VIEW', supertype: 'object' },
], writeError: 0, complete: true, notes: ['Source coverage must be checked.'] });

describe('copied native DWG metadata boundary', () => {
  it('bypasses both unsafe borrowed getters while forwarding legacy geometry calls', () => {
    const borrowed = vi.fn(() => { throw new Error('unsafe borrowed decoder'); });
    const instance = { dwg_object_entity_get_xdata: borrowed, dwg_object_xrecord_get_xdata: borrowed,
      geometry() { return [this.dwg_object_entity_get_xdata(), this.dwg_object_xrecord_get_xdata(), 42]; } };
    expect(metadataGeometryReader(instance).geometry()).toEqual([[], [], 42]);
    expect(borrowed).not.toHaveBeenCalled();
  });
  it('keeps exact 64-bit identities and copies inventory without native pointer properties', () => {
    const source = projection();
    const object = { ...source.objects[0]!, ptr: 12345 };
    source.objects = [object];
    const metadata = validateNativeMetadata(source, 0);
    expect(metadata.objects[0]).toEqual({ handle: 'FFFFFFFFFFFFFFFF', type: 'VIEW', dxfType: 'VIEW', supertype: 'object' });
    expect(metadata.objects[0]).not.toBe(object);
    expect(metadata.complete).toBe(true);
    expect(metadata.readError).toBe(0);
  });
  it('does not certify completeness with native decoder or exporter flags', () => {
    const warned = validateNativeMetadata(projection(), 64);
    expect(warned.complete).toBe(false);
    expect(warned.notes).toContainEqual(expect.stringContaining('64'));
    expect(validateNativeMetadata({ ...projection(), writeError: 1 }, 0).complete).toBe(false);
    expect(validateNativeMetadata({ ...projection(), complete: false }, 0).complete).toBe(false);
  });
  it.each(['0', '0001', 'abcd', '10000000000000000', '1n', ''])('refuses noncanonical native identity %s', (handle) => {
    const source = projection(); source.objects[0]!.handle = handle;
    expect(() => validateNativeMetadata(source, 0)).toThrow(/inventory/);
  });
  it('refuses duplicate identities, unknown status shapes and oversized UTF-8 output', () => {
    const source = projection(); source.objects.push({ ...source.objects[0]! });
    expect(() => validateNativeMetadata(source, 0)).toThrow(/inventory/);
    expect(() => validateNativeMetadata({ ...projection(), writeError: -1 }, 0)).toThrow(/projection/);
    expect(() => validateNativeMetadata(projection(), 0x4000)).toThrow(/projection/);
    expect(() => validateNativeMetadata({ ...projection(), dxf: 'x'.repeat(MAX_NATIVE_METADATA_DXF_BYTES + 1) }, 0)).toThrow(/projection/);
    expect(() => validateNativeMetadata({ ...projection(), dxf: '雷'.repeat(Math.floor(MAX_NATIVE_METADATA_DXF_BYTES / 3) + 1) }, 0)).toThrow(/projection/);
  });
  it('treats an absent factory export as an explicit older-runtime limitation', () => {
    const result = projectNativeMetadata({}, 123, 0);
    expect(result.abandon).toBe(false);
    expect(result.metadata).toMatchObject({ complete: false, dxf: '', objects: [], writeError: null });
    expect(result.metadata.notes[0]).toMatch(/no checked metadata/);
  });
  it('requires discarding a trapped module while preserving already-copied geometry', () => {
    const native = vi.fn(() => { throw new WebAssembly.RuntimeError('table index is out of bounds'); });
    const result = projectNativeMetadata({ jcad_dwg_export_metadata: native }, 123, 0);
    expect(native).toHaveBeenCalledWith(123, MAX_NATIVE_METADATA_DXF_BYTES);
    expect(result.abandon).toBe(true);
    expect(result.metadata.complete).toBe(false);
    expect(result.metadata.notes[0]).toMatch(/supported geometry was imported/);
  });
  it('invalid copied output reports a limitation without discarding a healthy module', () => {
    const result = projectNativeMetadata({ jcad_dwg_export_metadata: () => ({ ...projection(), schemaVersion: 2 }) }, 123, 0);
    expect(result.abandon).toBe(false);
    expect(result.metadata.complete).toBe(false);
    expect(result.metadata.notes[0]).toMatch(/invalid or oversized/);
  });
});
