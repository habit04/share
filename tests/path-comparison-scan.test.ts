import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPathComparator, registerWindowsPathIdentity, resetWindowsPathIdentitiesForTests, samePath, setPathPlatform } from '../src/app/paths';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetWindowsPathIdentitiesForTests(); setPathPlatform(null); });
type Path = string | null | undefined;

describe('bounded synchronous path comparison', () => {
  it.each(['win32', 'linux'])('matches unchanged samePath before and after normalization reuse (%s)', platform => {
    setPathPlatform(platform);
    const compare = createPathComparator();
    const cases: Array<[Path, Path]> = [
      ['C:\\Jobs\\Line1\\A.DXF', 'c:/jobs/Line1/./a.dxf'],
      ['C:\\Jobs\\A.dxf', 'C:\\Else\\A.dxf'],
      ['\\\\server\\share\\folder\\..\\A.dxf', '//SERVER/share/a.dxf'],
      ['relative\\A.dxf', 'relative/a.dxf'], ['../../A.dxf', '../../a.dxf'],
      ['/home/p/Jose\u0301.dxf', '/home/p/Jos\u00e9.dxf'],
      ['C:\\p\\Jos\u00e9.dxf', 'C:\\p\\Jose\u0301.dxf'],
      ['C:\\p\\\u0130.dxf', 'C:\\p\\I\u0307.dxf'], ['C:\\p\\\u212a.dxf', 'C:\\p\\K.dxf'],
      ['C:', 'C:\\'], ['\\Rooted\\A.dxf', '\\rooted\\a.dxf'],
      [null, null], [undefined, ''], ['', ''], [null, 'C:\\a.dxf'],
    ];
    for (let repeat = 0; repeat < 4; repeat++) for (const [a, b] of cases) expect(compare(a, b)).toBe(samePath(a, b));
  });

  it('keeps Windows Unicode siblings distinct while preserving POSIX NFC', () => {
    const compare = createPathComparator(); setPathPlatform('win32');
    expect(compare('C:\\p\\\u0130.dxf', 'C:\\p\\I\u0307.dxf')).toBe(false);
    expect(compare('C:\\p\\\u212a.dxf', 'C:\\p\\K.dxf')).toBe(false);
    expect(compare('C:\\p\\Jos\u00e9.dxf', 'C:\\p\\Jose\u0301.dxf')).toBe(false);
    setPathPlatform('linux');
    expect(compare('/p/Jos\u00e9.dxf', '/p/Jose\u0301.dxf')).toBe(true);
    expect(compare('/p/A.dxf', '/p/a.dxf')).toBe(false);
  });

  it('observes newly published native case-sensitive identities after strings are cached', () => {
    const a = 'C:\\picked\\Part.dxf', b = 'C:\\picked\\part.dxf', compare = createPathComparator();
    expect(compare(a, b)).toBe(true);
    registerWindowsPathIdentity(a, 'C:\\physical\\Part.dxf');
    // One unknown side retains samePath's lexical fallback.
    expect(compare(a, b)).toBe(true); expect(compare(a, b)).toBe(samePath(a, b));
    registerWindowsPathIdentity(b, 'C:\\physical\\part.dxf');
    expect(compare(a, b)).toBe(false); expect(compare(a, b)).toBe(samePath(a, b));
  });

  it('observes native aliases with different lexical paths after previous comparisons', () => {
    const alias = 'C:\\picked\\alias.dxf', physical = 'D:\\real\\source.dxf', compare = createPathComparator();
    expect(compare(alias, physical)).toBe(false);
    registerWindowsPathIdentity(alias, physical);
    expect(compare(alias, physical)).toBe(true); expect(compare(physical, alias)).toBe(true);
    expect(compare(alias, physical)).toBe(samePath(alias, physical));
  });

  it('reinterprets cached relative paths after explicit and detected platform changes', () => {
    const compare = createPathComparator(), a = 'folder\\A.dxf', b = 'folder/a.dxf';
    setPathPlatform('win32'); expect(compare(a, b)).toBe(true);
    setPathPlatform('linux'); expect(compare(a, b)).toBe(false);
    setPathPlatform('win32'); expect(compare(a, b)).toBe(true);
    setPathPlatform(null); const bridge = { platform: 'linux' }; vi.stubGlobal('window', { jcad: bridge });
    expect(compare(a, b)).toBe(false);
    bridge.platform = 'win32'; expect(compare(a, b)).toBe(true);
  });

  it('preserves platform getter observation order during a comparison, including hot entries', () => {
    const compare = createPathComparator(), a = 'Folder\\A.dxf', b = 'folder/a.dxf';
    setPathPlatform('win32'); expect(compare(a, b)).toBe(true); setPathPlatform(null);
    for (const sequence of [
      ['win32', 'linux', 'win32', 'linux', 'win32', 'linux'],
      ['linux', 'win32', 'linux', 'win32', 'linux', 'win32'],
      ['win32', 'win32', 'linux', 'linux', 'win32', 'win32'],
    ]) {
      const run = (comparison: typeof samePath) => {
        const observations: string[] = [];
        vi.stubGlobal('window', { jcad: { get platform() { const value = sequence[observations.length % sequence.length]!; observations.push(value); return value; } } });
        return { result: comparison(a, b), observations };
      };
      const expected = run(samePath), actual = run(compare);
      expect(actual).toEqual(expected); expect(actual.observations).toHaveLength(6);
    }
  });

  it('reuses normalization inside the scan without changing comparison results', () => {
    setPathPlatform('linux'); const compare = createPathComparator(), normalize = vi.spyOn(String.prototype, 'normalize');
    for (let i = 0; i < 20; i++) expect(compare('/p/A.dxf', '/p/./A.dxf')).toBe(true);
    expect(normalize).toHaveBeenCalledTimes(2);
    const fresh = createPathComparator(); expect(fresh('/p/A.dxf', '/p/./A.dxf')).toBe(true);
    expect(normalize).toHaveBeenCalledTimes(4);
  });

  it('compares uncached after 1024 interpretations while keeping native evidence live', () => {
    setPathPlatform('linux'); const compare = createPathComparator();
    for (let i = 0; i < 1024; i++) expect(compare(`/bounded/${i}`, `/bounded/${i}`)).toBe(true);
    const normalize = vi.spyOn(String.prototype, 'normalize');
    expect(compare('/overflow/item', '/overflow/item')).toBe(true);
    expect(compare('/overflow/item', '/overflow/item')).toBe(true);
    expect(normalize).toHaveBeenCalledTimes(8);
    const alias = 'C:\\overflow\\alias.dxf', physical = 'D:\\overflow\\real.dxf';
    expect(compare(alias, physical)).toBe(false); registerWindowsPathIdentity(alias, physical);
    expect(compare(alias, physical)).toBe(true); expect(compare(alias, physical)).toBe(samePath(alias, physical));
  });

  it('bounds aggregate cached string characters without evicting or rejecting comparisons', () => {
    setPathPlatform('linux'); const compare = createPathComparator(), tail = 'x'.repeat(800_000);
    const first = `/first/${tail}`, second = `/second/${tail}`, overflow = `/third/${tail}`;
    expect(compare(first, first)).toBe(true); expect(compare(second, second)).toBe(true);
    const normalize = vi.spyOn(String.prototype, 'normalize');
    expect(compare(overflow, overflow)).toBe(true); expect(compare(overflow, overflow)).toBe(true);
    expect(normalize).toHaveBeenCalledTimes(8);
    expect(compare(first, first)).toBe(true); expect(normalize).toHaveBeenCalledTimes(8);
    expect(compare(overflow, first)).toBe(samePath(overflow, first));
  });
});
