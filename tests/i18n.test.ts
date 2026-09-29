/**
 * en.json is the source of truth for UI strings. This test scans src/ for
 * t('key') calls and fails when a key is missing from en.json, when en.json
 * keeps a key no code uses, when a t() call does not use a string literal, and
 * when another locale has keys or {parameters} that en.json does not.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { t, translate, resolveLocale, setLocale, getLocale, onLocaleChange, LOCALES, LANGUAGE_CODES, languageChoices, type Message } from '../src/app/i18n';
import { normalizeSettings, DEFAULT_SETTINGS } from '../src/app/settings';

const SRC = join(__dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.ts$/.test(f) ? [p] : [];
  });
}

/** Files that import the translator, and the keys they pass to t(). */
function scan(): { keys: Map<string, string[]>; dynamic: string[] } {
  const keys = new Map<string, string[]>();
  const dynamic: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    if (!/import \{[^}]*\bt\b[^}]*\} from '[./]*(app\/)?i18n'/.test(text)) continue;
    for (const m of text.matchAll(/(?<![\w.])t\(\s*([^,)]+)/g)) {
      const arg = m[1]!.trim();
      const lit = /^'([^'\\]+)'$/.exec(arg);
      if (!lit) {
        dynamic.push(`${file}: t(${arg}`);
        continue;
      }
      keys.set(lit[1]!, [...(keys.get(lit[1]!) ?? []), file.slice(SRC.length + 1)]);
    }
  }
  return { keys, dynamic };
}

const placeholders = (m: Message): string[] => {
  const all = typeof m === 'string' ? [m] : Object.values(m);
  return [...new Set(all.flatMap((s) => [...(s ?? '').matchAll(/\{(\w+)\}/g)].map((x) => x[1]!)))].sort();
};

describe('locale files', () => {
  const en = LOCALES.en.messages;
  const { keys, dynamic } = scan();

  it('every t() key used in the sources exists in en.json', () => {
    expect(keys.size).toBeGreaterThan(50);
    const missing = [...keys.keys()].filter((k) => !(k in en)).map((k) => `${k} (${keys.get(k)!.join(', ')})`);
    expect(missing).toEqual([]);
  });

  it('en.json has no keys that nothing uses', () => {
    expect(Object.keys(en).filter((k) => !keys.has(k))).toEqual([]);
  });

  it('t() is only called with string literal keys', () => {
    expect(dynamic).toEqual([]);
  });

  it('other locales only translate known keys, with the same parameters and valid plural forms', () => {
    for (const code of LANGUAGE_CODES) {
      const messages = LOCALES[code].messages;
      for (const [k, v] of Object.entries(messages)) {
        expect(en[k], `${code}.json: unknown key ${k}`).toBeDefined();
        expect(placeholders(v), `${code}.json: parameters of ${k}`).toEqual(placeholders(en[k]!));
        expect(typeof v, `${code}.json: shape of ${k}`).toBe(typeof en[k]);
        if (typeof v !== 'string') {
          expect(v.other, `${code}.json: ${k}.other`).toBeTruthy();
          const allowed = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
          for (const form of Object.keys(v)) expect(allowed, `${code}.json: ${k}.${form}`).toContain(form);
        }
      }
    }
  });

  it('es.json is a real (partial) translation', () => {
    const es = Object.keys(LOCALES.es.messages);
    expect(es.length).toBeGreaterThan(60);
    expect(es.length).toBeLessThan(Object.keys(en).length);
  });
});

describe('t()', () => {
  afterEach(() => setLocale('en'));

  it('interpolates parameters and picks plural forms', () => {
    expect(t('status.snap.spacing', { value: 0.5 })).toBe('Snap spacing 0.5');
    expect(t('dsettings.units.willScale', { count: 1, factor: 25.4 })).toBe('1 object will be scaled by 25.4 about the origin.');
    expect(t('dsettings.units.willScale', { count: 3, factor: 25.4 })).toBe('3 objects will be scaled by 25.4 about the origin.');
    expect(translate('es', 'dsettings.units.willScale', { count: 1, factor: '25,4' })).toBe('Se escalará 1 objeto por 25,4 respecto al origen.');
    expect(translate('es', 'dsettings.units.willScale', { count: 0, factor: '25,4' })).toBe('Se escalarán 0 objetos por 25,4 respecto al origen.');
    expect(t('no.such.key')).toBe('no.such.key');
    expect(t('options.sizePx', { min: 1 })).toBe('Size (1-{max} px)');
  });

  it('switches language, falls back to English for untranslated keys and tells listeners', () => {
    const seen: string[] = [];
    const off = onLocaleChange((c) => seen.push(c));
    setLocale('es');
    expect(getLocale()).toBe('es');
    expect(t('options.title')).toBe('Opciones');
    expect(t('status.model.log')).toBe(t('status.model.log')); // untranslated
    expect(translate('es', 'status.model.log')).toBe(translate('en', 'status.model.log'));
    setLocale('en');
    off();
    setLocale('es');
    expect(seen).toEqual(['es', 'en']);
  });

  it('detects the locale from navigator.language with a settings override', () => {
    expect(resolveLocale('auto', ['es-MX', 'en-US'])).toBe('es');
    expect(resolveLocale('auto', ['de-DE', 'es'])).toBe('es');
    expect(resolveLocale('auto', ['fr-FR'])).toBe('en');
    expect(resolveLocale('en', ['es-ES'])).toBe('en');
    expect(resolveLocale('es', [])).toBe('es');
    expect(resolveLocale('xx', ['es'])).toBe('es');
    expect(resolveLocale(undefined, [])).toBe('en');
  });

  it('the language setting is validated like the other enums', () => {
    expect(DEFAULT_SETTINGS.language).toBe('auto');
    expect(normalizeSettings({ language: 'es' }).language).toBe('es');
    expect(normalizeSettings({ language: 'klingon' }).language).toBe('auto');
    expect(languageChoices('System')).toEqual([['auto', 'System'], ['en', 'English'], ['es', 'Español']]);
  });
});
