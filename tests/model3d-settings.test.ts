/** The experimental 3D feature flag: off by default, junk normalises to the default. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, migrateSettings, normalizeSettings } from '../src/app/settings';

describe('experimental3d setting', () => {
  it('defaults to off', () => {
    expect(DEFAULT_SETTINGS.experimental3d).toBe(false);
    expect(normalizeSettings({}).experimental3d).toBe(false);
    expect(normalizeSettings(null).experimental3d).toBe(false);
  });

  it('keeps a stored boolean and rejects anything else', () => {
    expect(normalizeSettings({ experimental3d: true }).experimental3d).toBe(true);
    expect(normalizeSettings({ experimental3d: false }).experimental3d).toBe(false);
    for (const junk of ['true', 1, null, {}, [], 'yes']) expect(normalizeSettings({ experimental3d: junk }).experimental3d).toBe(false);
  });

  it('settings saved before the flag existed load with it off', () => {
    const old = JSON.stringify({ gridVisible: false, ortho: true });
    const { settings } = migrateSettings(old, null);
    expect(settings.experimental3d).toBe(false);
    expect(settings.gridVisible).toBe(false);
  });
});
