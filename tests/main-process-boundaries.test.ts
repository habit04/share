/**
 * Module boundaries of the main process: electron/main.cjs and the modules it wires
 * (electron/main/*.cjs). IPC handlers are registered only on the guarded ipcMain
 * (electron/ipc-guard.cjs), and paths are granted and checked only through the one path registry
 * (electron/path-registry.cjs) and path policy that main.cjs creates.
 */
import { describe, it, expect } from 'vitest';
import { mainProcessFiles, readSource } from './helpers/main-process';

describe('main process module boundaries', () => {
  const files = mainProcessFiles();

  it('covers the entry and the modules under electron/main/', () => {
    expect(files[0]).toBe('electron/main.cjs');
    expect(files.length).toBeGreaterThan(1);
  });

  it("only main.cjs touches Electron's own ipcMain, and only to guard it", () => {
    for (const f of files) {
      const src = readSource(f);
      expect(src, f).not.toMatch(/\brawIpcMain\.\w+\(/);
      expect(src, f).not.toMatch(/require\('electron'\)\.ipcMain/);
      if (f === 'electron/main.cjs') {
        expect(src).toMatch(/^const \{[^}\n]*\bipcMain: rawIpcMain\b[^}\n]*\} = require\('electron'\);$/m);
        expect(src).toMatch(/const ipcMain = guardIpc\(rawIpcMain, \{/);
        expect(src.match(/\brawIpcMain\b/g)).toHaveLength(2);
      } else {
        expect(src, f).not.toMatch(/\bipcMain\b[^;\n]*require\('electron'\)/);
        expect(src, f).not.toMatch(/\brawIpcMain\b/);
      }
    }
  });

  it('the guard, the rejection log, the path registry and the path policy are created once, in main.cjs', () => {
    for (const f of files) {
      const src = readSource(f);
      const count = (re: RegExp) => (src.match(re) ?? []).length;
      const expected = f === 'electron/main.cjs' ? 1 : 0;
      for (const re of [/\bguardIpc\(/g, /\bcreateRejectionLog\(/g, /\bcreatePathRegistry\(/g, /\bcreatePathPolicy\(/g]) expect(count(re), `${f} ${re}`).toBe(expected);
    }
  });

  it('a module registers IPC only on the ipcMain of the shared context', () => {
    for (const f of files.slice(1)) {
      const src = readSource(f);
      if (!/\bipcMain\.(handle|on|once)\(/.test(src)) continue;
      expect(src, f).toMatch(/const \{[^}]*\bipcMain\b[^}]*\} = ctx;/);
    }
  });
});
