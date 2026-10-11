import { describe, expect, it } from 'vitest';
import { needsPackagedOrigin, processResult } from '../scripts/packaged-smoke-policy.mjs';

describe('packaged secure-origin gate', () => {
  it('keeps old releases testable and requires the two-launch gate on current and future builds', () => {
    expect(needsPackagedOrigin('v0.4.0')).toBe(false);
    expect(needsPackagedOrigin('0.3.9')).toBe(false);
    for (const version of ['0.4.1', '0.4.1-beta.1', '0.4.2', '0.5.0', '1.0.0']) expect(needsPackagedOrigin(version), version).toBe(true);
    expect(() => needsPackagedOrigin('unknown')).toThrow(/Invalid packaged smoke version/);
  });

  it('records timed-out and killed children as failures with their actual cause', () => {
    expect(processResult({ status: null, signal: 'SIGTERM', error: new Error('ETIMEDOUT') })).toBe('error: ETIMEDOUT');
    expect(processResult({ status: null, signal: 'SIGKILL', error: undefined })).toBe('signal: SIGKILL');
    expect(processResult({ status: 1, signal: null, error: undefined })).toBe('exit: 1');
  });
});
