import { afterEach, describe, expect, it } from 'vitest';
import { MAX_WINDOWS_PATH_IDENTITIES, pathIdentityKey, registerWindowsPathIdentities, registerWindowsPathIdentity, resetWindowsPathIdentitiesForTests, samePath } from '../src/app/paths';

afterEach(resetWindowsPathIdentitiesForTests);
const pair = (name: string) => ({ logical: `C:\\batch-alias\\${name}.dxf`, canonical: `C:\\batch-real\\${name}.dxf` });

describe('atomic Windows native identity publication', () => {
  it('publishes all normalized aliases and canonical self-identities together', () => {
    registerWindowsPathIdentities([pair('one'), pair('two'), pair('one')]);
    expect(samePath(pair('one').logical, pair('one').canonical)).toBe(true);
    expect(pathIdentityKey(pair('two').logical)).toBe(`native:${pair('two').canonical}`);
  });
  it('leaves the first pair unpublished when a later pair conflicts with existing evidence', () => {
    registerWindowsPathIdentity(pair('two').logical, 'C:\\existing\\two.dxf');
    expect(() => registerWindowsPathIdentities([pair('one'), pair('two')])).toThrow(/another native file/);
    expect(samePath(pair('one').logical, pair('one').canonical)).toBe(false);
    expect(samePath(pair('two').logical, 'C:\\existing\\two.dxf')).toBe(true);
  });
  it('refuses an internal canonical-self conflict without publishing any pair', () => {
    expect(() => registerWindowsPathIdentities([pair('one'), { logical: pair('one').canonical, canonical: pair('two').canonical }])).toThrow(/another native file/);
    expect(pathIdentityKey(pair('one').logical)).toMatch(/^lexical:/);
    expect(pathIdentityKey(pair('one').canonical)).toMatch(/^lexical:/);
  });
  it('reserves capacity for the entire manifest without evicting established aliases', () => {
    const keep = pair('keep'); registerWindowsPathIdentities([keep]);
    for (let i = 0; i < MAX_WINDOWS_PATH_IDENTITIES - 4; i++) registerWindowsPathIdentity(`C:\\history\\${i}.dxf`, `C:\\history\\${i}.dxf`);
    expect(() => registerWindowsPathIdentities([pair('one'), pair('two')])).toThrow(/history is full/);
    expect(pathIdentityKey(pair('one').logical)).toMatch(/^lexical:/);
    expect(pathIdentityKey(pair('two').logical)).toMatch(/^lexical:/);
    expect(samePath(keep.logical, keep.canonical)).toBe(true);
  });
  it('refuses a late invalid native path without publishing earlier valid pairs', () => {
    expect(() => registerWindowsPathIdentities([pair('one'), { logical: 'relative.dxf', canonical: pair('two').canonical }])).toThrow(/Invalid native/);
    expect(pathIdentityKey(pair('one').logical)).toMatch(/^lexical:/);
  });
  it('keeps distinct case-sensitive and Unicode leaves distinct when native evidence says so', () => {
    const paths = ['C:\\case\\A.dxf', 'C:\\case\\a.dxf', 'C:\\case\\\u0130.dxf', 'C:\\case\\I\u0307.dxf'];
    registerWindowsPathIdentities(paths.map(path => ({ logical: path, canonical: path })));
    expect(samePath(paths[0], paths[1])).toBe(false); expect(samePath(paths[2], paths[3])).toBe(false);
  });
});
