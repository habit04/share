import { describe, it, expect } from 'vitest';
import { drawingKindOf, versionLabel, wasmSupported, describeDwgError, readDwgInBrowser } from '../src/io/dwg-browser';

// The WebAssembly conversion itself needs a browser page (Vite asset URL for the wasm,
// CSP with 'unsafe-eval'); it is exercised by `node scripts/screenshot-site.mjs`, which
// opens fixtures/*.dwg in the built browser edition with Playwright. These tests cover the
// pure helpers the file bridge relies on.
describe('dwg-browser helpers', () => {
  it('classifies picked file names', () => {
    expect(drawingKindOf('panel.dwg')).toBe('dwg');
    expect(drawingKindOf('PANEL.DWG')).toBe('dwg');
    expect(drawingKindOf('sheet 1.dxf')).toBe('dxf');
    expect(drawingKindOf(' notes.Dxf ')).toBe('dxf');
    expect(drawingKindOf('archive.dwg.zip')).toBeNull();
    expect(drawingKindOf('readme')).toBeNull();
    expect(drawingKindOf('')).toBeNull();
  });

  it('turns LibreDWG version objects into the label the desktop reader logs', () => {
    expect(versionLabel({ type: 'R_2000' })).toBe('R_2000');
    expect(versionLabel('r2018')).toBe('r2018');
    expect(versionLabel(undefined)).toBe('');
    expect(versionLabel({ other: 1 })).toBe('');
  });

  it('detects WebAssembly support from the given scope', () => {
    expect(wasmSupported({ WebAssembly: { instantiate: () => undefined } })).toBe(true);
    expect(wasmSupported({})).toBe(false);
    expect(wasmSupported({ WebAssembly: {} })).toBe(false);
    expect(wasmSupported()).toBe(true); // Node has WebAssembly
  });

  it('explains wasm and memory failures in one line', () => {
    expect(describeDwgError(new RangeError('WebAssembly.Memory(): could not allocate memory'))).toMatch(/Not enough memory/);
    expect(describeDwgError(new Error('CompileError: wasm validation failed'))).toMatch(/could not be loaded/);
    expect(describeDwgError(new Error('LibreDWG could not read this file'))).toBe('LibreDWG could not read this file');
    expect(describeDwgError('plain string')).toBe('plain string');
  });

  it('refuses to load the reader outside a web build (Electron / vitest)', async () => {
    await expect(readDwgInBrowser(new ArrayBuffer(8))).rejects.toThrow(/desktop application/);
  });
});
