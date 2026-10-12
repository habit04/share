import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readNativeDwg, type NativeDwgModule } from '../scripts/dwg-native-read.mjs';
// @ts-expect-error plain JS reader shared with Electron/CLI
import { readDwgPayload } from '../scripts/dwg-reader.mjs';

const badBytes = Buffer.from('This is intentionally not a DWG file.\n');
const root = join(__dirname, '..');

function stub(result: unknown = { data: 17, error: 0 }) {
  let exists = false;
  const module = {
    FS: {
      writeFile: vi.fn(() => { exists = true; }),
      analyzePath: vi.fn(() => ({ exists })),
      unlink: vi.fn(() => { exists = false; }),
    },
    dwg_read_file: vi.fn(() => result),
    dwg_free: vi.fn(),
    dwg_abandon: vi.fn(),
  };
  return module;
}
const checked = (module: ReturnType<typeof stub>, input: Uint8Array | ArrayBuffer = badBytes) => readNativeDwg(module as unknown as NativeDwgModule, input);

describe('checked native drawing read ownership', () => {
  it('transfers a successful pointer only after deleting the native FS input', () => {
    const module = stub();
    expect(checked(module)).toBe(17);
    expect(module.FS.writeFile).toHaveBeenCalledWith('/jcad-input.dwg', badBytes);
    expect(module.FS.unlink).toHaveBeenCalledWith('/jcad-input.dwg');
    expect(module.dwg_free).not.toHaveBeenCalled();
    expect(module.dwg_abandon).not.toHaveBeenCalled();
  });
  it('retains noncritical compatibility warnings without accepting a null pointer', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(checked(stub({ data: 17, error: 67 }))).toBe(17);
      expect(warning).toHaveBeenCalledWith('Open dwg file with error code:', 67);
      expect(() => checked(stub({ data: 0, error: 67 }))).toThrow(/could not read/);
    } finally { warning.mockRestore(); }
  });
  it.each([128, 256, 512, 1024, 2048, 4096, 2049])('rejects critical flags %i despite a non-null pointer, frees and unlinks', (error) => {
    const module = stub({ data: 17, error });
    expect(() => checked(module)).toThrow(new RegExp(`native error ${error}`));
    expect(module.dwg_free).toHaveBeenCalledExactlyOnceWith(17);
    expect(module.dwg_abandon).not.toHaveBeenCalled();
    expect(module.FS.unlink).toHaveBeenCalledExactlyOnceWith('/jcad-input.dwg');
  });
  it('preserves the out-of-memory abandon path instead of walking partial native graphs', () => {
    const module = stub({ data: 17, error: 8192 | 64 });
    expect(() => checked(module)).toThrow(/out of WASM memory/);
    expect(module.dwg_abandon).toHaveBeenCalledExactlyOnceWith(17);
    expect(module.dwg_free).not.toHaveBeenCalled();
    expect(module.FS.unlink).toHaveBeenCalledExactlyOnceWith('/jcad-input.dwg');
  });
  it.each([-1, 16384, Number.NaN, Number.POSITIVE_INFINITY, '2048', undefined])('rejects malformed error flags %s and releases the valid pointer', (error) => {
    const module = stub({ data: 17, error });
    expect(() => checked(module)).toThrow(/invalid native error flags/);
    expect(module.dwg_free).toHaveBeenCalledExactlyOnceWith(17);
    expect(module.FS.unlink).toHaveBeenCalledExactlyOnceWith('/jcad-input.dwg');
  });
  it.each([0, -1, 0x1_0000_0000, 1.5, '17', undefined])('does not free an invalid pointer %s', (data) => {
    const module = stub({ data, error: 0 });
    expect(() => checked(module)).toThrow(/could not read/);
    expect(module.dwg_free).not.toHaveBeenCalled();
    expect(module.dwg_abandon).not.toHaveBeenCalled();
    expect(module.FS.unlink).toHaveBeenCalledExactlyOnceWith('/jcad-input.dwg');
  });
  it('unlinks after a write or native decode throws', () => {
    const write = stub();
    write.FS.writeFile.mockImplementation(() => { throw new Error('write failed'); });
    write.FS.analyzePath.mockReturnValue({ exists: true }); // write failed after creating a partial FS file
    expect(() => checked(write)).toThrow('write failed');
    expect(write.dwg_read_file).not.toHaveBeenCalled();
    expect(write.FS.unlink).toHaveBeenCalledExactlyOnceWith('/jcad-input.dwg');
    const read = stub();
    read.dwg_read_file.mockImplementation(() => { throw new Error('native trap'); });
    expect(() => checked(read)).toThrow('native trap');
    expect(read.FS.unlink).toHaveBeenCalledExactlyOnceWith('/jcad-input.dwg');
  });
  it('frees a successful pointer if native FS cleanup fails before ownership transfer', () => {
    const module = stub();
    module.FS.unlink.mockImplementation(() => { throw new Error('unlink failed'); });
    expect(() => checked(module)).toThrow('unlink failed');
    expect(module.dwg_free).toHaveBeenCalledExactlyOnceWith(17);
  });
  it('propagates a falsy native exception while still deleting its input', () => {
    const module = stub();
    module.dwg_read_file.mockImplementation(() => { throw 0; });
    let caught = false;
    try { checked(module); } catch (error) { caught = true; expect(error).toBe(0); }
    expect(caught).toBe(true);
    expect(module.FS.unlink).toHaveBeenCalledExactlyOnceWith('/jcad-input.dwg');
  });
  it('rejects unsupported native DXF before writing, rather than using the DWG decoder', () => {
    const module = stub();
    expect(() => readNativeDwg(module as unknown as NativeDwgModule, badBytes, 'dxf')).toThrow(/does not expose DXF/);
    expect(module.FS.writeFile).not.toHaveBeenCalled();
    expect(module.dwg_read_file).not.toHaveBeenCalled();
  });
  it('uses the exact DXF binding when a runtime exposes it', () => {
    const module = { ...stub(), dxf_read_file: vi.fn(() => ({ data: 23, error: 0 })) };
    expect(readNativeDwg(module as unknown as NativeDwgModule, badBytes.buffer as ArrayBuffer, 'dxf')).toBe(23);
    expect(module.dxf_read_file).toHaveBeenCalledExactlyOnceWith('/jcad-input.dxf');
    expect(module.dwg_read_file).not.toHaveBeenCalled();
    expect(module.FS.unlink).toHaveBeenCalledExactlyOnceWith('/jcad-input.dxf');
  });
});

describe('mandatory real native fatal-input handling', () => {
  it.each(['baseline', 'repaired'])('%s factory rejects invalid bytes and a truncated genuine header', async (mode) => {
    const require = createRequire(import.meta.url);
    const folder = mode === 'baseline'
      ? join(dirname(require.resolve('@mlightcad/libredwg-web')), '../wasm')
      : join(root, 'vendor/libredwg-web-bg/factory');
    const { default: createModule } = await import(pathToFileURL(join(folder, 'libredwg-web.js')).href);
    const wasmBinary = await readFile(join(folder, 'libredwg-web.wasm'));
    const genuine = await readFile(join(root, 'tests/fixtures/interchange/r2018-mtext-background.dwg'));
    for (const bytes of [badBytes, genuine.subarray(0, 64)]) {
      const module = await createModule({ wasmBinary });
      expect(() => readNativeDwg(module, bytes)).toThrow(/could not read|out of WASM memory/);
      expect(module.FS.analyzePath('/jcad-input.dwg', false).exists).toBe(false);
    }
  }, 60_000);
  it('resets the Node instance after a fatal read before a successful older-version read', async () => {
    await expect(readDwgPayload(badBytes)).rejects.toThrow(/native error 2048/);
    const older = await readDwgPayload(await readFile(join(root, 'fixtures/example_2000.dwg')));
    expect(older.version).toContain('2000');
    expect(older.payload.entities.length).toBeGreaterThan(10);
    expect(older.payload.entities.some((entity: { type: string; text?: string }) => entity.type === 'TEXT' && entity.text === 'teksto simpla')).toBe(true);
    const masks = await readDwgPayload(await readFile(join(root, 'tests/fixtures/interchange/r2018-mtext-background.dwg')));
    expect(masks.payload.entities.filter((entity: { type: string }) => entity.type === 'MTEXT')).toHaveLength(7);
  }, 60_000);
});
