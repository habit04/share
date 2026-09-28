/**
 * Who made JCad Electrical and how to support it. Everything shown on Help > About
 * (and the Donate entries) comes from about.json so it can be edited without code.
 */
import raw from './about.json';

export interface AboutLink {
  label: string;
  url: string;
}
export interface AboutInfo {
  author: { name: string; title: string; bio: string; location: string; links: AboutLink[] };
  donate: { cashtag: string; message: string };
  project: { homepage: string; issues: string; releases: string; license: string };
}

const info = raw as AboutInfo;

/** Hosts that Help > About and the Donate entries may open. */
export const ALLOWED_LINK_HOSTS = ['github.com', 'cash.app'];

export function aboutInfo(): AboutInfo {
  return info;
}

/** Cash App payment page for the configured cashtag, or null when none is set. */
export function donateUrl(): string | null {
  const tag = info.donate.cashtag.trim().replace(/^\$/, '');
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(tag)) return null;
  return `https://cash.app/$${tag}`;
}

/** Only http(s) links to the allowed hosts are ever opened from About. */
export function safeAboutUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    if (!ALLOWED_LINK_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function authorLinks(): AboutLink[] {
  return info.author.links.filter((l) => l.label && safeAboutUrl(l.url));
}
