export interface NativeDwgModule {
  FS: {
    writeFile(path: string, bytes: Uint8Array): void;
    analyzePath(path: string, dontResolveLastLink?: boolean): { exists: boolean };
    unlink(path: string): void;
  };
  dwg_read_file(path: string): { data: number; error: number };
  dxf_read_file?(path: string): { data: number; error: number };
  dwg_free(pointer: number): void;
  dwg_abandon(pointer: number): void;
}
export const DWG_CRITICAL_ERROR: 128;
/** Transfers successful pointer ownership to caller; failed pointer and native FS input are released. */
export function readNativeDwg(module: NativeDwgModule, input: Uint8Array | ArrayBuffer, kind?: 'dwg' | 'dxf'): number;
