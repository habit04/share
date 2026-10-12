/** Fixed production diagnostics must never modify a normal profile, linked source or pre-existing destination. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';

const sourceFile = resolve('electron/main/shipping-dwg-probe.cjs');
const source = readFileSync(sourceFile, 'utf8');
const originalRequire = createRequire(sourceFile);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
    expect(root).toMatch(/jcad-(?:shipping-smoke|dwg-probe)-/);
    rmSync(root, { recursive: true, force: true });
  }
});
function profile(prefix = 'jcad-shipping-smoke-') {
  const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root;
}
function load(root: string) {
  const dialog = { showSaveDialog: vi.fn() };
  const executeJavaScript = vi.fn();
  const module = { exports: {} as { runShippingDwgProbe(ctx: unknown, testBuild: boolean): Promise<unknown> } };
  new Function('require', 'module', '__dirname', 'process', source)((name: string) => name === 'electron' ? { app: { getPath: () => root }, dialog } : originalRequire(name), module, dirname(sourceFile), { platform: 'win32' });
  return { run: () => module.exports.runShippingDwgProbe({ mainWindow: { isDestroyed: () => false, webContents: { executeJavaScript } } }, false), dialog, executeJavaScript };
}
describe('fixed DWG shipping probe confinement', () => {
  it('refuses an ordinary profile before executing renderer code or choosing destinations', async () => {
    const root = profile('jcad-dwg-probe-'); const f = load(root);
    await expect(f.run()).rejects.toThrow(/temporary smoke profile/);
    expect(f.executeJavaScript).not.toHaveBeenCalled(); expect(f.dialog.showSaveDialog).not.toHaveBeenCalled();
  });
  it('refuses a fixture symlink outside its smoke profile', async context => {
    const root = profile(), outside = profile('jcad-dwg-probe-'); const file = join(outside, 'original.dxf'); writeFileSync(file, 'original source');
    try { symlinkSync(file, join(root, 'shipping-startup.dxf')); } catch (error: any) { if (error.code === 'EPERM') { context.skip(); return; } throw error; }
    const f = load(root); await expect(f.run()).rejects.toThrow(/regular file inside/);
    expect(readFileSync(file, 'utf8')).toBe('original source'); expect(f.executeJavaScript).not.toHaveBeenCalled();
  });
  it('uses exclusive creation and never overwrites an existing fixed destination', async () => {
    const root = profile(); writeFileSync(join(root, 'shipping-startup.dxf'), 'fixture'); const target = join(root, 'shipping-export.dwg'); writeFileSync(target, 'existing file');
    const f = load(root), originalDialog = f.dialog.showSaveDialog; await expect(f.run()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(target, 'utf8')).toBe('existing file'); expect(f.executeJavaScript).not.toHaveBeenCalled(); expect(f.dialog.showSaveDialog).toBe(originalDialog);
  });
  it('never overwrites a pre-existing normal Save As destination in the temporary profile', async () => {
    const root = profile(); writeFileSync(join(root, 'shipping-startup.dxf'), 'fixture'); const target = join(root, 'shipping-normal-save.dwg'); writeFileSync(target, 'existing normal save');
    const f = load(root), originalDialog = f.dialog.showSaveDialog; await expect(f.run()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(target, 'utf8')).toBe('existing normal save'); expect(f.executeJavaScript).not.toHaveBeenCalled(); expect(f.dialog.showSaveDialog).toBe(originalDialog);
  });
});
