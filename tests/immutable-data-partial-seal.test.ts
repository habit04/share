/**
 * PR #41 (3) [P2] — partial-root seals (Codex review at 7331766; lead
 * ruling 2026-10-22): a seal performed WITH root-key exemptions is a
 * PARTIAL seal. It must go into a separate set, never the unconditional
 * 'sealed' fast-path set, so a later STRICT seal re-walks the root and
 * certifies the previously exempt subtrees. The admitted exemption
 * behaviour itself (AMENDMENT TO RULING-P31) is unchanged: the exempt
 * subtree is not traversed, not frozen, and isImmutableData on the root
 * certifies "sealed EXCEPT the exempt subtrees".
 */
import { describe, expect, it } from 'vitest';
import { isImmutableData, sealImmutableData } from '../src/core/immutable-data';

describe('PR #41 (3) — a partial (exempt) seal never enters the strict fast path', () => {
  it('sealImmutableData(partialRoot) without an exemption behaves strictly: a mutation the partial seal let pass is refused after the strict seal', () => {
    const exemptSubtree: { v: number } = { v: 1 };
    const root = { keep: { a: 1 }, exempt: exemptSubtree };
    sealImmutableData(root, new Set<PropertyKey>(['exempt']));
    // The admitted partial posture stands: the exempt subtree is untouched.
    expect(Object.isFrozen(exemptSubtree)).toBe(false);
    exemptSubtree.v = 2;
    expect(exemptSubtree.v).toBe(2);
    expect(isImmutableData(root)).toBe(true); // "sealed EXCEPT the exempt subtrees"
    // The strict re-seal must re-walk and certify the exempt subtree too.
    sealImmutableData(root);
    expect(Object.isFrozen(exemptSubtree)).toBe(true);
    expect(() => { exemptSubtree.v = 3; }).toThrow(TypeError);
    expect(exemptSubtree.v).toBe(2);
    expect(isImmutableData(exemptSubtree)).toBe(true);
    expect(isImmutableData(root)).toBe(true);
  });

  it('{nested: partialRoot}: sealing a strict root containing a previously partially-sealed child re-walks the child strictly', () => {
    const exemptSubtree: { v: number } = { v: 1 };
    const partialRoot = { keep: { a: 1 }, exempt: exemptSubtree };
    sealImmutableData(partialRoot, new Set<PropertyKey>(['exempt']));
    expect(Object.isFrozen(exemptSubtree)).toBe(false);
    const outer = { nested: partialRoot };
    sealImmutableData(outer);
    expect(Object.isFrozen(partialRoot)).toBe(true);
    expect(Object.isFrozen(exemptSubtree)).toBe(true);
    expect(() => { exemptSubtree.v = 9; }).toThrow(TypeError);
    expect(isImmutableData(partialRoot)).toBe(true);
    expect(isImmutableData(outer)).toBe(true);
  });
});
