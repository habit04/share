/**
 * Who made JCad Electrical and how to support it. Everything shown on Help > About
 * (and the Donate entries) comes from about.json so it can be edited without code.
 */
import raw from './about.json';

export interface AboutLink {
  label: string;
  url: string;
}
/** The program's own licence and the third-party notices, linked from Help > About. */
export interface AboutLicense {
  /** Display name, e.g. "GNU GPL v3". */
  name: string;
  /** SPDX identifier (matches the "license" field of package.json). */
  spdx: string;
  /** The LICENSE file in the repository. */
  url: string;
  noticesLabel: string;
  /** THIRD-PARTY-NOTICES.md in the repository. */
  noticesUrl: string;
}
export interface AboutInfo {
  author: { name: string; title: string; bio: string; location: string; links: AboutLink[] };
  donate: { cashtag: string; message: string };
  project: { homepage: string; issues: string; releases: string; license: string };
  license: AboutLicense;
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

/**
 * The licence link and the third-party notices link for Help > About. Each is null when its URL
 * is not an allowed https link (the licence name is then shown as plain text, the notices link
 * is left out).
 */
export function licenseLinks(): { license: AboutLink | null; notices: AboutLink | null } {
  const l = info.license;
  const licenseUrl = safeAboutUrl(l.url);
  const noticesUrl = safeAboutUrl(l.noticesUrl);
  return {
    license: licenseUrl ? { label: l.name, url: licenseUrl } : null,
    notices: noticesUrl ? { label: l.noticesLabel || 'Third-party notices', url: noticesUrl } : null,
  };
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

/**
 * "Licensed under the GNU GPL v3 · Third-party notices" as HTML for Help > About. The links carry
 * their target in `data-about-url`; the dialog opens them through the same allowlisted path as the
 * other About links (window.jcad.openExternal in the desktop app) instead of navigating the window.
 */
export function licenseLineHtml(): string {
  const { license, notices } = licenseLinks();
  const link = (l: AboutLink) => `<a href="${escHtml(l.url)}" data-about-url="${escHtml(l.url)}" rel="noopener">${escHtml(l.label)}</a>`;
  const name = license ? link(license) : escHtml(info.license.name);
  return `Licensed under the ${name}${notices ? ` · ${link(notices)}` : ''}`;
}
