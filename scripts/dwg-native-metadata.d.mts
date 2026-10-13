export interface NativeMetadataObject {
  handle: string;
  type: string;
  dxfType: string;
  supertype: 'entity' | 'object' | 'unknown';
}
export interface NativeDwgMetadata {
  schemaVersion: 1;
  dxf: string;
  objects: NativeMetadataObject[];
  readError: number;
  writeError: number | null;
  /** Requires additional source-inventory/DXF graph coverage checks in the application. */
  complete: boolean;
  notes: string[];
}
export const MAX_NATIVE_METADATA_DXF_BYTES: number;
export const MAX_NATIVE_METADATA_OBJECTS: 100000;
export function metadataGeometryReader<T extends object>(instance: T): T;
export function validateNativeMetadata(value: unknown, readError: number): NativeDwgMetadata;
export function projectNativeMetadata(module: { jcad_dwg_export_metadata?: (pointer: number, maxBytes: number) => unknown }, pointer: number, readError: number): { metadata: NativeDwgMetadata; abandon: boolean };
