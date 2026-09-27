/** Persisted user settings (localStorage in the renderer). */
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
}

const KEY = 'voltcad.settings.v1';

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
};

export function loadSettings(): UserSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<UserSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed, recentFiles: Array.isArray(parsed.recentFiles) ? parsed.recentFiles.filter((f) => typeof f === 'string') : [] };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: UserSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

export function pushRecent(list: string[], file: string, max = 9): string[] {
  return [file, ...list.filter((f) => f !== file)].slice(0, max);
}
