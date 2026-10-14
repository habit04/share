import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, migrateSettings, normalizeSettings } from '../src/app/settings';

describe('3D tool availability and foreign import preferences', () => {
  it('makes tools available for new profiles without opting into foreign import', () => {
    for (const settings of [DEFAULT_SETTINGS, normalizeSettings({}), normalizeSettings(null), migrateSettings(null, null).settings]) {
      expect(settings.experimental3d).toBe(true);
      expect(settings.importForeign3d).toBe(false);
    }
  });

  it('preserves explicit tool opt-outs and uses safe defaults for malformed values', () => {
    expect(normalizeSettings({ experimental3d: false }).experimental3d).toBe(false);
    for (const junk of ['true', 1, null, {}, [], 'yes']) {
      const settings = normalizeSettings({ experimental3d: junk, importForeign3d: junk });
      expect(settings.experimental3d).toBe(true);
      expect(settings.importForeign3d).toBe(false);
    }
  });

  it('migrates old missing/off preferences without changing their import interpretation', () => {
    for (const raw of [{ gridVisible: false, ortho: true }, { gridVisible: false, experimental3d: false }]) {
      for (const legacy of [false, true]) {
        const { settings } = migrateSettings(legacy ? null : JSON.stringify(raw), legacy ? JSON.stringify(raw) : null);
        expect(settings.experimental3d).toBe(raw.experimental3d !== false);
        expect(settings.importForeign3d).toBe(false);
        expect(settings.gridVisible).toBe(false);
      }
    }
  });

  it('preserves the previous foreign-import behavior of an explicit old 3D opt-in', () => {
    for (const legacy of [false, true]) {
      const raw = JSON.stringify({ experimental3d: true, ortho: true });
      const { settings } = migrateSettings(legacy ? null : raw, legacy ? raw : null);
      expect(settings.experimental3d).toBe(true);
      expect(settings.importForeign3d).toBe(true);
      expect(settings.ortho).toBe(true);
      expect(migrateSettings(JSON.stringify(settings), null).settings).toEqual(settings);
    }
  });

  it('keeps a new explicit import decision instead of inferring the legacy opt-in', () => {
    for (const importForeign3d of [true, false]) {
      const settings = normalizeSettings({ experimental3d: true, importForeign3d });
      expect(settings.importForeign3d).toBe(importForeign3d);
      expect(migrateSettings(JSON.stringify(settings), null).settings).toEqual(settings);
    }
    expect(normalizeSettings({ experimental3d: true, importForeign3d: null }).importForeign3d).toBe(false);
  });
});
