/** Fixed serialized preference observation, with DOM/storage doubled; no native install claim. */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve('electron/main/shipping-probe.cjs'), originalRequire = createRequire(file);
const module = { exports: {} as { shippingStartupSettingsEvidence: (...args: any[]) => any } };
new Function('require', 'module', readFileSync(file, 'utf8'))((name: string) => name === 'electron' ? {} : originalRequire(name), module);
const observe = new Function(`return (${module.exports.shippingStartupSettingsEvidence.toString()});`)() as typeof module.exports.shippingStartupSettingsEvidence;
function fixture(on = true) {
  const settings = { experimental3d: on, importForeign3d: false as boolean | undefined, gridVisible: false, crosshairSize: 37,
    modelBackground: '#123456', autosaveMinutes: 7, units: 'engineering', unitSuffix: 'mm', precision: 3, language: 'es' };
  const controller = { active: false, kernelStarted: false };
  const w = { editor: { settings, viewport: { canvas: { style: { visibility: 'visible' } } } }, jcad3d: on ? controller : undefined };
  const counts = { three: 0, gpu: 0 }, storage = { getItem: () => 'private upgrade Δ 雷' };
  const dom = { querySelectorAll: (selector: string) => Array.from({ length: selector === 'canvas.viewport3d' ? counts.three : counts.gpu }) };
  return { w, settings, controller, counts, storage, read: () => observe(w, dom, storage) };
}
describe('bounded private startup preference evidence', () => {
  it.each([true, false])('observes persisted settings without changing the %s controller/profile', on => {
    const f = fixture(on), before = structuredClone(f.w), result = f.read();
    expect(result).toMatchObject({ ...f.settings, upgradeSentinel: 'private upgrade Δ 雷', controllerInstalled: on,
      controllerInactive: true, kernelUnstarted: true, no3dCanvas: true, canvasDefault: true });
    expect(f.w).toEqual(before);
  });
  it('distinguishes an absent old preference and preserves a legacy opted-in migration result', () => {
    const f = fixture(); f.settings.importForeign3d = undefined; expect(f.read().importForeign3d).toBeNull();
    f.settings.importForeign3d = true; expect(f.read().importForeign3d).toBe(true);
  });
  it.each(['active', 'three-canvas', 'gpu-canvas', 'hidden', 'kernel'])('reports actual %s resource state', damage => {
    const f = fixture();
    if (damage === 'active') f.controller.active = true;
    else if (damage === 'three-canvas') f.counts.three = 1;
    else if (damage === 'gpu-canvas') f.counts.gpu = 1;
    else if (damage === 'hidden') f.w.editor.viewport.canvas.style.visibility = 'hidden';
    else f.controller.kernelStarted = true;
    const r = f.read();
    if (damage === 'kernel') expect(r.kernelUnstarted).toBe(false);
    else expect(r.canvasDefault).toBe(false);
  });
  it('bounds the private sentinel and handles its absence', () => {
    const f = fixture(); f.storage.getItem = () => 'x'.repeat(512); expect(f.read().upgradeSentinel).toHaveLength(128);
    expect(observe(f.w, { querySelectorAll: () => [] }, { getItem: () => null }).upgradeSentinel).toBeNull();
  });
});
