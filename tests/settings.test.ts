import { describe, it, expect } from 'vitest';
import { normalizeSettings, migrateSettings, DEFAULT_SETTINGS, pushRecent, formatLength, formatCoordinate } from '../src/app/settings';

describe('settings normalisation and migration', () => {
  it('fills defaults for missing keys and drops unknown ones', () => {
    const s = normalizeSettings({ gridVisible: false, bogus: 1 });
    expect(s.gridVisible).toBe(false);
    expect(s.osnap).toBe(true);
    expect((s as unknown as Record<string, unknown>).bogus).toBeUndefined();
    expect(s.paletteWidths).toEqual(DEFAULT_SETTINGS.paletteWidths);
  });
  it('rejects wrong types, clamps ranges and validates colours / enums', () => {
    const s = normalizeSettings({
      crosshairSize: 500,
      pickboxSize: -3,
      autosaveMinutes: 'ten',
      modelBackground: 'red',
      crosshairColor: '#ABCDEF',
      units: 'furlongs',
      coordDisplay: 'relative',
      recentFiles: ['a.dxf', 3, null],
      polarAdditional: [45, 'x', NaN],
      osnapModes: { endpoint: false, quadrant: 'yes' },
      statusBarItems: { grid: false, custom: true },
      paletteWidths: { properties: 300 },
    });
    expect(s.crosshairSize).toBe(100);
    expect(s.pickboxSize).toBe(0);
    expect(s.autosaveMinutes).toBe(DEFAULT_SETTINGS.autosaveMinutes);
    expect(s.modelBackground).toBe(DEFAULT_SETTINGS.modelBackground);
    expect(s.crosshairColor).toBe('#abcdef');
    expect(s.units).toBe('decimal');
    expect(s.coordDisplay).toBe('relative');
    expect(s.recentFiles).toEqual(['a.dxf']);
    expect(s.polarAdditional).toEqual([45]);
    expect(s.osnapModes.endpoint).toBe(false);
    expect(s.osnapModes.quadrant).toBe(false);
    expect(s.statusBarItems).toEqual({ grid: false, custom: true });
    expect(s.paletteWidths).toEqual({ projectManager: 268, properties: 300, toolPalettes: 240, symbolBuilder: 300 });
  });
  it('migrates a v1 blob when no v2 blob exists, and prefers v2 otherwise', () => {
    const v1 = JSON.stringify({ gridVisible: false, ribbonTab: 4, recentFiles: ['x.dxf'], symbolStandard: 'IEC' });
    const m = migrateSettings(null, v1);
    expect(m.migrated).toBe(true);
    expect(m.settings.gridVisible).toBe(false);
    expect(m.settings.ribbonTab).toBe(4);
    expect(m.settings.recentFiles).toEqual(['x.dxf']);
    expect(m.settings.symbolStandard).toBe('IEC');
    expect(m.settings.autosaveMinutes).toBe(10);
    const both = migrateSettings(JSON.stringify({ ribbonTab: 1 }), v1);
    expect(both.migrated).toBe(false);
    expect(both.settings.ribbonTab).toBe(1);
    expect(both.settings.symbolStandard).toBe('JIC');
    const broken = migrateSettings('{not json', '{also not');
    expect(broken.settings).toEqual(DEFAULT_SETTINGS);
  });
  it('recent list is capped and de-duplicated', () => {
    let l: string[] = [];
    for (let i = 0; i < 12; i += 1) l = pushRecent(l, `f${i}`);
    expect(l).toHaveLength(9);
    l = pushRecent(l, 'f5');
    expect(l[0]).toBe('f5');
    expect(l.filter((f) => f === 'f5')).toHaveLength(1);
  });
});

describe('unit formatting', () => {
  it('decimal, engineering, architectural and fractional', () => {
    expect(formatLength(1.23456, { units: 'decimal', precision: 3, unitSuffix: 'in' })).toBe('1.235');
    expect(formatLength(26.5, { units: 'engineering', precision: 2, unitSuffix: 'in' })).toBe(`2'-2.50"`);
    expect(formatLength(26.5, { units: 'architectural', precision: 4, unitSuffix: 'in' })).toBe(`2'-2 8/16"`);
    expect(formatLength(2.75, { units: 'fractional', precision: 4, unitSuffix: 'in' })).toBe('2 3/4');
    expect(formatLength(-0.5, { units: 'fractional', precision: 1, unitSuffix: 'in' })).toBe('-0 1/2');
    expect(formatCoordinate(1, 2, { units: 'decimal', precision: 1, unitSuffix: 'in' })).toBe('1.0, 2.0, 0.0');
  });
});
