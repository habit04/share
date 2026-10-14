/** Actual serialized fixed probe preconditions; Electron, DOM and storage are doubled, never WebGL. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

afterEach(() => vi.unstubAllGlobals());

function fixture(file: string, functionName: string) {
  const sourceFile = resolve('electron/main', file), source = readFileSync(sourceFile, 'utf8');
  const originalRequire = createRequire(sourceFile);
  const fixedRenderer = new Function('require', 'module', `${source}\nreturn ${functionName};`)(
    (name: string) => name === 'electron' ? {} : originalRequire(name), { exports: {} },
  ) as (...args: unknown[]) => Promise<unknown>;
  const { shippingGpuAssertLazy3d } = originalRequire('./shipping-gpu-lazy-3d.cjs') as { shippingGpuAssertLazy3d: (...args: unknown[]) => void };
  const renderer = new Function(`const shippingGpuAssertLazy3d=(${shippingGpuAssertLazy3d.toString()});return (${fixedRenderer.toString()});`)() as typeof fixedRenderer;
  const reachedApp = new Error('Actual probe passed startup guards');
  const appInfo = vi.fn(async () => { throw reachedApp; });
  const controller = { active: false, viewport: null as unknown, kernelStarted: false };
  const ed = { doc: { filePath: 'private/fixture.dxf' },
    settings: { experimental3d: true, importForeign3d: false },
    commands: new Map(['GPURENDERER', 'SHXFONT', 'BOX', '3DMODE', '3DVIEW', 'UNION'].map(name => [name, {}])),
    viewport: { canvas: { style: { visibility: 'visible' } } },
  };
  const w = { editor: ed, jcad: { appInfo }, jcad3d: controller as typeof controller | undefined, gpuPrototype: undefined as unknown };
  const canvases: unknown[] = [];
  vi.stubGlobal('window', w);
  vi.stubGlobal('document', { querySelector: () => null, querySelectorAll: () => canvases });
  vi.stubGlobal('localStorage', { getItem: () => '1' });
  vi.stubGlobal('location', { href: 'jcad://app/index.html' });
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('crypto', { subtle: {} });
  return { ed, w, controller, canvases, reachedApp, appInfo,
    run: (stage = 'first') => renderer(stage, ed.doc.filePath, 'private/output.dxf', [], null) };
}

describe.each([
  ['ordinary GPU', 'shipping-probe.cjs', 'shippingGpu2dRenderer'],
  ['genuine SHX', 'shipping-gpu-shx-probe.cjs', 'shippingShxRenderer'],
])('%s fixed probe with default-ready 3D tools', (_label, file, renderer) => {
  it.each(['first', 'second'])('accepts the inactive lazy controller at the %s stage', async stage => {
    const f = fixture(file, renderer);
    await expect(f.run(stage)).rejects.toBe(f.reachedApp);
    expect(f.appInfo).toHaveBeenCalledOnce();
    expect(f.controller).toEqual({ active: false, viewport: null, kernelStarted: false });
  });
  it.each(['off', 'foreign', 'missing-controller', 'active', 'viewport', 'kernel', 'canvas', 'hidden-canvas',
    'BOX', '3DMODE', '3DVIEW', 'UNION', 'GPURENDERER', 'development-global', 'development-command'])('rejects %s before reaching the application', async damage => {
    const f = fixture(file, renderer);
    if (damage === 'off') f.ed.settings.experimental3d = false;
    else if (damage === 'foreign') f.ed.settings.importForeign3d = true;
    else if (damage === 'missing-controller') f.w.jcad3d = undefined;
    else if (damage === 'active') f.controller.active = true;
    else if (damage === 'viewport') f.controller.viewport = {};
    else if (damage === 'kernel') f.controller.kernelStarted = true;
    else if (damage === 'canvas') f.canvases.push({});
    else if (damage === 'hidden-canvas') f.ed.viewport.canvas.style.visibility = 'hidden';
    else if (damage === 'development-global') f.w.gpuPrototype = {};
    else if (damage === 'development-command') f.ed.commands.set('GPU3DDEMO', {});
    else f.ed.commands.delete(damage);
    await expect(f.run()).rejects.toThrow(/GPU acceptance|development|Ordinary GPU command/);
    expect(f.appInfo).not.toHaveBeenCalled();
  });
});
