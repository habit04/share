import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The module only touches Electron APIs inside functions; requiring it under Node is safe.
const { compareVersions, parseVersion } = require('../electron/updater.cjs') as {
  compareVersions: (a: string, b: string) => number;
  parseVersion: (v: string) => { parts: number[]; pre: string } | null;
};

describe('updater version comparison', () => {
  it('parses tags with and without the v prefix', () => {
    expect(parseVersion('v0.2.0')).toEqual({ parts: [0, 2, 0], pre: '' });
    expect(parseVersion('1.10.3-beta.2')).toEqual({ parts: [1, 10, 3], pre: 'beta.2' });
    expect(parseVersion('latest')).toBeNull();
  });
  it('orders releases numerically, not lexically', () => {
    expect(compareVersions('0.2.0', '0.1.1')).toBe(1);
    expect(compareVersions('0.1.1', '0.2.0')).toBe(-1);
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('v0.2.0', '0.2.0')).toBe(0);
  });
  it('treats a pre-release as older than the final build', () => {
    expect(compareVersions('0.2.0-beta.1', '0.2.0')).toBe(-1);
    expect(compareVersions('0.2.0', '0.2.0-rc.1')).toBe(1);
    expect(compareVersions('0.2.0-rc.2', '0.2.0-rc.1')).toBe(1);
  });
  it('never reports an update for unparsable versions', () => {
    expect(compareVersions('nightly', '0.2.0')).toBe(0);
  });
});
