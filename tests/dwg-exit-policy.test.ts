import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const { expectDwgProcessExit, forgetDwgProcessExit, shouldLogChildProcessGone, EXPECTED_EXIT_TTL_MS } = require('../electron/dwg-exit-policy.cjs');
const name = () => `JCad DWG Reader:${randomUUID()}`;
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe('expected DWG utility process cleanup', () => {
  it.each(['killed', 'clean-exit'])('does not record the specifically requested %s as an application crash', (reason) => {
    const id = name(); expectDwgProcessExit(id);
    expect(shouldLogChildProcessGone({ type: 'Utility', reason, name: id })).toBe(false);
    expect(shouldLogChildProcessGone({ type: 'Utility', reason, name: id })).toBe(true);
  });
  it.each(['crashed', 'oom', 'integrity-failure', 'launch-failed', 'abnormal-exit', 'memory-eviction'])('retains unexpected %s diagnostics even after requesting teardown', (reason) => {
    const id = name(); expectDwgProcessExit(id);
    expect(shouldLogChildProcessGone({ type: 'Utility', reason, name: id })).toBe(true);
  });
  it('never suppresses unrelated utilities, GPU failures or an unrequested kill', () => {
    const id = name(); expectDwgProcessExit(id);
    expect(shouldLogChildProcessGone({ type: 'Utility', reason: 'killed', name: name() })).toBe(true);
    expect(shouldLogChildProcessGone({ type: 'GPU', reason: 'killed', name: id })).toBe(true);
    expect(shouldLogChildProcessGone({ type: 'Utility', reason: 'killed', name: 'JCad DWG Reader' })).toBe(true);
    expect(shouldLogChildProcessGone({ type: 'Utility', reason: 'killed', serviceName: id })).toBe(false);
  });
  it('expires expected identities and removes them when a kill failed', () => {
    const expired = name(); expectDwgProcessExit(expired);
    vi.advanceTimersByTime(EXPECTED_EXIT_TTL_MS);
    expect(shouldLogChildProcessGone({ type: 'Utility', reason: 'killed', name: expired })).toBe(true);
    const refused = name(); expectDwgProcessExit(refused); forgetDwgProcessExit(refused);
    expect(shouldLogChildProcessGone({ type: 'Utility', reason: 'killed', name: refused })).toBe(true);
  });
  it('retains the 64 most recent identities without evicting another during lookup', () => {
    vi.advanceTimersByTime(EXPECTED_EXIT_TTL_MS);
    const ids = Array.from({ length: 65 }, name);
    for (const id of ids) expectDwgProcessExit(id);
    expect(shouldLogChildProcessGone({ type: 'Utility', reason: 'killed', name: ids[0] })).toBe(true);
    for (const id of ids.slice(1)) expect(shouldLogChildProcessGone({ type: 'Utility', reason: 'killed', name: id })).toBe(false);
  });
});
