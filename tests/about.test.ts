import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { donateUrl, safeAboutUrl, aboutInfo, licenseLinks, licenseLineHtml } from '../src/app/about';
import pkg from '../package.json';

describe('about / donate configuration', () => {
  it('builds a Cash App link only for a valid cashtag', () => {
    const cfg = aboutInfo();
    const original = cfg.donate.cashtag;
    cfg.donate.cashtag = '$JCadDev';
    expect(donateUrl()).toBe('https://cash.app/$JCadDev');
    cfg.donate.cashtag = 'jcad_dev-1';
    expect(donateUrl()).toBe('https://cash.app/$jcad_dev-1');
    cfg.donate.cashtag = '';
    expect(donateUrl()).toBeNull();
    cfg.donate.cashtag = 'bad tag with spaces';
    expect(donateUrl()).toBeNull();
    cfg.donate.cashtag = original;
  });
  it('only opens https links to the allowed hosts', () => {
    expect(safeAboutUrl('https://github.com/habit04/share')).toBe('https://github.com/habit04/share');
    expect(safeAboutUrl('https://cash.app/$X')).toBe('https://cash.app/$X');
    expect(safeAboutUrl('http://cash.app/$X')).toBeNull();
    expect(safeAboutUrl('https://evil.example/cash.app')).toBeNull();
    expect(safeAboutUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('about / license', () => {
  const REPO_BLOB = 'https://github.com/habit04/share/blob/claude/autocad-program-feasibility-53w7j7/';
  // The same rule electron/main.cjs applies in its open-external handler.
  const electronAllows = (u: string) => /^https:\/\/github\.com\/habit04\/share(\/|$)/.test(u);

  it('names the GNU GPL v3 and matches package.json', () => {
    const lic = aboutInfo().license;
    expect(lic.name).toBe('GNU GPL v3');
    expect(lic.spdx).toBe('GPL-3.0-only');
    expect((pkg as { license?: string }).license).toBe(lic.spdx);
  });

  it('links to LICENSE and THIRD-PARTY-NOTICES.md in the repository through the allowlist', () => {
    const { license, notices } = licenseLinks();
    expect(license).toEqual({ label: 'GNU GPL v3', url: `${REPO_BLOB}LICENSE` });
    expect(notices).toEqual({ label: 'Third-party notices', url: `${REPO_BLOB}THIRD-PARTY-NOTICES.md` });
    expect(electronAllows(license!.url)).toBe(true);
    expect(electronAllows(notices!.url)).toBe(true);
  });

  it('renders "Licensed under the GNU GPL v3 · Third-party notices" with data-about-url links', () => {
    const html = licenseLineHtml();
    expect(html.replace(/<[^>]+>/g, '')).toBe('Licensed under the GNU GPL v3 · Third-party notices');
    expect(html).toContain(`data-about-url="${REPO_BLOB}LICENSE"`);
    expect(html).toContain(`data-about-url="${REPO_BLOB}THIRD-PARTY-NOTICES.md"`);
  });

  it('drops links that fail the allowlist and escapes the text', () => {
    const lic = aboutInfo().license;
    const saved = { ...lic };
    try {
      lic.url = 'http://github.com/habit04/share/LICENSE';
      lic.noticesUrl = 'https://evil.example/notices';
      lic.name = 'GPL <v3>';
      expect(licenseLinks()).toEqual({ license: null, notices: null });
      const html = licenseLineHtml();
      expect(html).toBe('Licensed under the GPL &lt;v3&gt;');
      expect(html).not.toContain('<a');
    } finally {
      Object.assign(lic, saved);
    }
  });

  it('ships the licence files the links point at', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    expect(readFileSync(join(root, 'LICENSE'), 'utf8')).toMatch(/^\s*GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
    const notices = readFileSync(join(root, 'THIRD-PARTY-NOTICES.md'), 'utf8');
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) expect(notices).toContain(dep);
  });
});
