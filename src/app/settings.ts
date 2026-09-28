/** Persisted user settings (localStorage in the renderer). */
export interface OsnapModes {
  endpoint: boolean;
  midpoint: boolean;
  center: boolean;
  quadrant: boolean;
  intersection: boolean;
  perpendicular: boolean;
  nearest: boolean;
}

export interface UserSettings {
  gridVisible: boolean;
  gridSnap: boolean;
  ortho: boolean;
  polar: boolean;
  osnap: boolean;
  dynamicInput: boolean;
  lineweightDisplay: boolean;
  crosshairSize: number;
  projectManagerVisible: boolean;
  symbolStandard: 'JIC' | 'IEC';
  ribbonTab: number;
  recentFiles: string[];
  // --- Options > Display
  modelBackground: string;
  crosshairColor: string;
  ribbonTheme: 'dark' | 'light';
  // --- Options > Drafting
  autosnapMarkerSize: number;
  autosnapMarkerColor: string;
  apertureSize: number;
  // --- Options > Selection
  pickboxSize: number;
  gripSize: number;
  gripColor: string;
  gripHoverColor: string;
  selectionEffect: 'dashed' | 'solid';
  // --- Options > Files
  autosaveMinutes: number;
  // --- Options > Units
  units: 'decimal' | 'engineering' | 'architectural' | 'fractional';
  unitSuffix: 'in' | 'mm' | 'ft' | 'm';
  precision: number;
  // --- Drafting Settings (DSETTINGS)
  snapSpacing: number;
  gridSpacing: number;
  gridStyle: 'lines' | 'dots';
  polarIncrement: number;
  polarAdditional: number[];
  osnapModes: OsnapModes;
  // --- Palettes / chrome
  paletteWidths: { projectManager: number; properties: number; toolPalettes: number; symbolBuilder: number };
  paletteAutoHide: { projectManager: boolean; properties: boolean };
  /** Symbol Builder palette: which sections are collapsed. */
  symbolBuilderCollapsed: { symbol: boolean; preview: boolean; attributes: boolean; defaults: boolean; pins: boolean };
  propertiesVisible: boolean;
  toolPalettesVisible: boolean;
  quickProperties: boolean;
  rolloverTooltips: boolean;
  statusBarItems: Record<string, boolean>;
  coordDisplay: 'absolute' | 'relative' | 'off';
  workspace: 'drafting' | 'electrical';
  annotationScale: string;
  commandWindowVisible: boolean;
  recentInput: string[];
}

export const SETTINGS_KEY = 'jcad.settings.v2';
/** Older keys, migrated on first load. */
export const LEGACY_SETTINGS_KEYS = ['jcad.settings.v1'];

export const DEFAULT_SETTINGS: UserSettings = {
  gridVisible: true,
  gridSnap: false,
  ortho: false,
  polar: false,
  osnap: true,
  dynamicInput: true,
  lineweightDisplay: false,
  crosshairSize: 5,
  projectManagerVisible: true,
  symbolStandard: 'JIC',
  ribbonTab: 2,
  recentFiles: [],
  modelBackground: '#212830',
  crosshairColor: '#ffffff',
  ribbonTheme: 'dark',
  autosnapMarkerSize: 7,
  autosnapMarkerColor: '#3ff23f',
  apertureSize: 10,
  pickboxSize: 3,
  gripSize: 4,
  gripColor: '#1a3dff',
  gripHoverColor: '#ff3d3d',
  selectionEffect: 'dashed',
  autosaveMinutes: 10,
  units: 'decimal',
  unitSuffix: 'in',
  precision: 4,
  snapSpacing: 0.5,
  gridSpacing: 0.5,
  gridStyle: 'lines',
  polarIncrement: 90,
  polarAdditional: [],
  osnapModes: { endpoint: true, midpoint: true, center: true, quadrant: false, intersection: true, perpendicular: true, nearest: false },
  paletteWidths: { projectManager: 268, properties: 250, toolPalettes: 240, symbolBuilder: 300 },
  paletteAutoHide: { projectManager: false, properties: false },
  symbolBuilderCollapsed: { symbol: false, preview: false, attributes: false, defaults: true, pins: false },
  propertiesVisible: false,
  toolPalettesVisible: false,
  quickProperties: false,
  rolloverTooltips: true,
  statusBarItems: {},
  coordDisplay: 'absolute',
  workspace: 'electrical',
  annotationScale: '1:1',
  commandWindowVisible: true,
  recentInput: [],
};

const RANGES: Partial<Record<keyof UserSettings, [number, number]>> = {
  crosshairSize: [1, 100],
  autosnapMarkerSize: [1, 20],
  apertureSize: [1, 50],
  pickboxSize: [0, 20],
  gripSize: [1, 20],
  autosaveMinutes: [0, 240],
  precision: [0, 8],
  snapSpacing: [1e-6, 1e6],
  gridSpacing: [1e-6, 1e6],
  polarIncrement: [1, 180],
  ribbonTab: [0, 50],
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isHexColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

/**
 * Validate an arbitrary parsed object against the defaults: wrong types fall back,
 * numbers are clamped, nested objects are merged key by key. Unknown keys are dropped.
 */
export function normalizeSettings(input: unknown): UserSettings {
  const src = isRecord(input) ? input : {};
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(DEFAULT_SETTINGS) as Array<[keyof UserSettings, unknown]>) {
    const v = src[key];
    if (Array.isArray(def)) {
      const elemType = key === 'polarAdditional' ? 'number' : 'string';
      out[key] = Array.isArray(v) ? v.filter((x) => typeof x === elemType && (elemType !== 'number' || Number.isFinite(x))) : [...def];
    } else if (isRecord(def)) {
      const merged: Record<string, unknown> = { ...def };
      if (isRecord(v)) {
        for (const [k, dv] of Object.entries(def)) if (typeof v[k] === typeof dv) merged[k] = v[k];
        if (key === 'statusBarItems') for (const [k, bv] of Object.entries(v)) if (typeof bv === 'boolean') merged[k] = bv;
      }
      out[key] = merged;
    } else if (typeof def === 'number') {
      let n = typeof v === 'number' && Number.isFinite(v) ? v : def;
      const r = RANGES[key];
      if (r) n = Math.min(r[1], Math.max(r[0], n));
      out[key] = n;
    } else if (typeof def === 'boolean') {
      out[key] = typeof v === 'boolean' ? v : def;
    } else if (typeof def === 'string' && def.startsWith('#')) {
      out[key] = isHexColor(v) ? v.toLowerCase() : def;
    } else {
      out[key] = typeof v === 'string' && ENUMS[key]?.includes(v) ? v : def;
    }
  }
  return out as unknown as UserSettings;
}

const ENUMS: Partial<Record<keyof UserSettings, string[]>> = {
  symbolStandard: ['JIC', 'IEC'],
  ribbonTheme: ['dark', 'light'],
  selectionEffect: ['dashed', 'solid'],
  units: ['decimal', 'engineering', 'architectural', 'fractional'],
  unitSuffix: ['in', 'mm', 'ft', 'm'],
  gridStyle: ['lines', 'dots'],
  coordDisplay: ['absolute', 'relative', 'off'],
  workspace: ['drafting', 'electrical'],
  annotationScale: ['1:1', '1:2', '1:4', '1:8', '1:16', '1:32', '2:1', '4:1', '8:1'],
};

/** Choose the current-version blob when present, else migrate the legacy one. */
export function migrateSettings(currentRaw: string | null, legacyRaw: string | null): { settings: UserSettings; migrated: boolean } {
  const parse = (raw: string | null): unknown => {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  const cur = parse(currentRaw);
  if (cur) return { settings: normalizeSettings(cur), migrated: false };
  const legacy = parse(legacyRaw);
  if (legacy) return { settings: normalizeSettings(legacy), migrated: true };
  return { settings: { ...DEFAULT_SETTINGS }, migrated: false };
}

export function loadSettings(): UserSettings {
  try {
    const legacy = LEGACY_SETTINGS_KEYS.map((k) => localStorage.getItem(k)).find((v) => v) ?? null;
    const { settings, migrated } = migrateSettings(localStorage.getItem(SETTINGS_KEY), legacy);
    if (migrated) saveSettings(settings);
    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: UserSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

export function pushRecent(list: string[], file: string, max = 9): string[] {
  return [file, ...list.filter((f) => f !== file)].slice(0, max);
}

/** Format a coordinate pair for the status bar according to the unit settings. */
export function formatCoordinate(x: number, y: number, s: Pick<UserSettings, 'units' | 'precision' | 'unitSuffix'>): string {
  const f = (v: number) => formatLength(v, s);
  return `${f(x)}, ${f(y)}, ${f(0)}`;
}

export function formatLength(v: number, s: Pick<UserSettings, 'units' | 'precision' | 'unitSuffix'>): string {
  const p = Math.max(0, Math.min(8, s.precision));
  switch (s.units) {
    case 'engineering': {
      const ft = Math.trunc(v / 12);
      const inch = v - ft * 12;
      return `${ft}'-${inch.toFixed(p)}"`;
    }
    case 'architectural': {
      const neg = v < 0;
      const a = Math.abs(v);
      const ft = Math.floor(a / 12);
      const rem = a - ft * 12;
      const whole = Math.floor(rem);
      const denom = 1 << Math.min(6, Math.max(0, p));
      let num = Math.round((rem - whole) * denom);
      let w = whole;
      if (num === denom) {
        w += 1;
        num = 0;
      }
      const frac = num ? ` ${num}/${denom}` : '';
      return `${neg ? '-' : ''}${ft}'-${w}${frac}"`;
    }
    case 'fractional': {
      const neg = v < 0;
      const a = Math.abs(v);
      const whole = Math.floor(a);
      const denom = 1 << Math.min(6, Math.max(0, p));
      let num = Math.round((a - whole) * denom);
      let w = whole;
      if (num === denom) {
        w += 1;
        num = 0;
      }
      let d = denom;
      while (num && num % 2 === 0) {
        num /= 2;
        d /= 2;
      }
      return `${neg ? '-' : ''}${w}${num ? ` ${num}/${d}` : ''}`;
    }
    default:
      return v.toFixed(p);
  }
}
