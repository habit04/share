/**
 * User-interface strings: `t('status.grid.title')`, with `{name}` parameters and
 * plural forms (`{ "one": "{count} object", "other": "{count} objects" }`,
 * chosen by Intl.PluralRules for the `count` parameter).
 *
 * src/app/locales/en.json is the source of truth: tests/i18n.test.ts scans the
 * sources for t('…') calls and fails when a key is missing from en.json (or
 * en.json keeps a key nothing uses), and checks that every other locale only
 * has keys en.json knows, with the same {parameters}. Missing translations
 * fall back to English. Keys must be string literals so the scan sees them.
 *
 * Adding a language:
 *   1. copy src/app/locales/en.json to src/app/locales/<code>.json and translate
 *      the values (leave out keys you have not translated yet);
 *   2. import it below and add it to LOCALES with its own name;
 *   3. npm test (the i18n test checks keys and placeholders).
 * The Options dialog lists LOCALES automatically; settings accept the new code.
 */
import en from './locales/en.json';
import es from './locales/es.json';

export type PluralMessage = { readonly other: string } & Partial<Record<Intl.LDMLPluralRule, string>>;
export type Message = string | PluralMessage;
export type Messages = Readonly<Record<string, Message>>;
export type Params = Readonly<Record<string, string | number>>;

export const LOCALES = {
  en: { name: 'English', messages: en as Messages },
  es: { name: 'Español', messages: es as Messages },
} as const;

export type LanguageCode = keyof typeof LOCALES;
/** The `language` setting: a locale code, or 'auto' to follow the system (navigator.languages). */
export type LanguageSetting = 'auto' | LanguageCode;

export const LANGUAGE_CODES = Object.keys(LOCALES) as LanguageCode[];
export const DEFAULT_LOCALE: LanguageCode = 'en';

const isCode = (v: string): v is LanguageCode => Object.prototype.hasOwnProperty.call(LOCALES, v);

/** The system's preferred languages, most preferred first (empty outside a browser). */
export function systemLanguages(): readonly string[] {
  const nav = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } }).navigator;
  if (!nav) return [];
  if (nav.languages && nav.languages.length) return nav.languages;
  return nav.language ? [nav.language] : [];
}

/**
 * Pick the UI locale: an explicit setting wins; 'auto' takes the first system
 * language we have (exact match, then its base language: es-MX -> es); else English.
 */
export function resolveLocale(setting: string | undefined, languages: readonly string[] = systemLanguages()): LanguageCode {
  if (setting && setting !== 'auto' && isCode(setting)) return setting;
  for (const tag of languages) {
    const lower = tag.toLowerCase();
    if (isCode(lower)) return lower;
    const base = lower.split(/[-_]/)[0] ?? '';
    if (isCode(base)) return base;
  }
  return DEFAULT_LOCALE;
}

let current: LanguageCode = DEFAULT_LOCALE;
const listeners = new Set<(code: LanguageCode) => void>();

export function getLocale(): LanguageCode {
  return current;
}

/** Switch the UI language; listeners (status bar, palettes) refresh their labels. */
export function setLocale(code: LanguageCode): void {
  if (!isCode(code) || code === current) return;
  current = code;
  if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = code;
  for (const fn of listeners) fn(code);
}

export function onLocaleChange(fn: (code: LanguageCode) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const pluralRules = new Map<string, Intl.PluralRules>();
function pluralForm(locale: string, n: number): Intl.LDMLPluralRule {
  let r = pluralRules.get(locale);
  if (!r) {
    r = new Intl.PluralRules(locale);
    pluralRules.set(locale, r);
  }
  return r.select(n);
}

function interpolate(text: string, params: Params | undefined): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m));
}

function lookup(locale: LanguageCode, key: string): Message | undefined {
  return LOCALES[locale].messages[key];
}

/** Translate a key in the current locale (English, then the key itself, as fallbacks). */
export function t(key: string, params?: Params): string {
  return translate(current, key, params);
}

/** Translate for an explicit locale (tests, previews). */
export function translate(locale: LanguageCode, key: string, params?: Params): string {
  const msg = lookup(locale, key) ?? lookup(DEFAULT_LOCALE, key);
  if (msg === undefined) return key;
  if (typeof msg === 'string') return interpolate(msg, params);
  const count = Number(params?.count ?? 0);
  const usedLocale = lookup(locale, key) !== undefined ? locale : DEFAULT_LOCALE;
  const form = pluralForm(usedLocale, count);
  return interpolate(msg[form] ?? msg.other, params);
}

/** Names for the language dropdown: each language in its own name. */
export function languageChoices(autoLabel: string): Array<[LanguageSetting, string]> {
  return [['auto', autoLabel], ...LANGUAGE_CODES.map((c): [LanguageSetting, string] => [c, LOCALES[c].name])];
}
