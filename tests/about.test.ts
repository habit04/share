import { describe, it, expect } from 'vitest';
import { donateUrl, safeAboutUrl, aboutInfo } from '../src/app/about';

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
