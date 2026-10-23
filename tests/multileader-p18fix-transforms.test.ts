/**
 * P18 FIX (PR #40 round), GROUP 3 — TRANSFORMS (Codex PR #40 P1).
 *
 * MOVE / ROTATE / SCALE / MIRROR must transform a native multileader's block
 * placements — the primary's `e.mleader.block` AND every annotative context's
 * `c.block` — in position, rotation AND scale. Before this fix the compound
 * transform moved only `c.block.position` (the context block's rotation and
 * scale were left behind) and never touched `e.mleader.block` at all, so an
 * edited block-content multileader wrote its blocks at the stale placement.
 *
 * Fixture F ground truth (tests/multileader-s3d-native.test.ts): the primary
 * block sits at (5.36, 3) with scale (1, 1) and rotation 0; the additional
 * (1:2) context's block sits at (6.72, 3) with scale (2, 2) and rotation 0.
 *
 * MIRROR expectation: mirroring a placement (p, s, θ) must yield the EXACT
 * affine of the mirror — position reflect(p), rotation the reflected angle,
 * and the reflection itself carried by a SIGNED scale: with the rotation at
 * the reflected angle, scale Y flips sign (the model accepts signed nonzero
 * scales), so the placement map equals reflect ∘ the original map at every
 * local point.
 *
 * OPEN CORRECTION (PR #43 round, Codex PR #43 P1): this file originally
 * pinned the WRONG expectation — that a mirror leaves the scale unsigned
 * ("a mirror is an isometry, the scale is unchanged"). An isometry it is,
 * but an orientation-REVERSING one: with unsigned scales the placement map
 * is a rotation, not the reflection, and the mirrored block lands
 * un-reflected. The MIRROR test below now asserts the signed scales, and
 * two further tests check the placement maps against the exact affine
 * (Fixture F sample points through an edit/save/reopen, and a mirror
 * across an arbitrary 30-degree axis).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LeaderEntity } from '../src/core/entities';
import { mirrorEntityAcross, rotateEntity, scaleEntityBy, translateEntity } from '../src/core/entities';
import { readDxf, writeDxf } from '../src/io/dxf';

const F = readFileSync(join(__dirname, 'fixtures', 'p18-mleader-annotative-block.dxf'), 'utf8');

const leaderOf = (state: ReturnType<typeof readDxf>): LeaderEntity =>
  state.entities.find((e): e is LeaderEntity => e.type === 'leader')!;

const fixtureLeader = (): LeaderEntity => leaderOf(readDxf(F));

describe('P18 FIX group 3: transforms move mleader block placements whole', () => {
  it('MOVE (+5,-2): the primary block lands at (10.36, 1) and the context block follows', () => {
    const moved = translateEntity(fixtureLeader(), { x: 5, y: -2 }) as LeaderEntity;
    expect(moved.mleader?.block?.position.x).toBeCloseTo(10.36, 9);
    expect(moved.mleader?.block?.position.y).toBeCloseTo(1, 9);
    const c = moved.mleader!.contexts![0]!;
    expect(c.block?.position.x).toBeCloseTo(11.72, 9);
    expect(c.block?.position.y).toBeCloseTo(1, 9);
    // A pure translation leaves rotation and scale alone.
    expect(moved.mleader?.block?.rotation).toBe(0);
    expect(moved.mleader?.block?.scale).toEqual({ x: 1, y: 1 });
    expect(c.block?.rotation).toBe(0);
    expect(c.block?.scale).toEqual({ x: 2, y: 2 });
  });

  it('ROTATE 90 degrees: both block placements rotate to 90 degrees about the origin', () => {
    const rotated = rotateEntity(fixtureLeader(), { x: 0, y: 0 }, Math.PI / 2) as LeaderEntity;
    expect(rotated.mleader?.block?.rotation).toBeCloseTo(Math.PI / 2, 9);
    expect(rotated.mleader?.block?.position.x).toBeCloseTo(-3, 9);
    expect(rotated.mleader?.block?.position.y).toBeCloseTo(5.36, 9);
    const c = rotated.mleader!.contexts![0]!;
    expect(c.block?.rotation).toBeCloseTo(Math.PI / 2, 9);
    expect(c.block?.position.x).toBeCloseTo(-3, 9);
    expect(c.block?.position.y).toBeCloseTo(6.72, 9);
    expect(c.block?.scale).toEqual({ x: 2, y: 2 });
  });

  it('SCALE x3: the extra context block scale becomes (6, 6), the primary (3, 3)', () => {
    const scaled = scaleEntityBy(fixtureLeader(), { x: 0, y: 0 }, 3) as LeaderEntity;
    const c = scaled.mleader!.contexts![0]!;
    expect(c.block?.scale).toEqual({ x: 6, y: 6 });
    expect(scaled.mleader?.block?.scale).toEqual({ x: 3, y: 3 });
    expect(c.block?.position.x).toBeCloseTo(20.16, 9);
    expect(c.block?.position.y).toBeCloseTo(9, 9);
    expect(scaled.mleader?.block?.position.x).toBeCloseTo(16.08, 9);
    expect(scaled.mleader?.block?.position.y).toBeCloseTo(9, 9);
    // A uniform scale does not rotate.
    expect(c.block?.rotation).toBe(0);
    expect(scaled.mleader?.block?.rotation).toBe(0);
  });

  it('MIRROR across the Y axis: positions reflect, rotations reflect to PI, scale Y carries the reflection (signed)', () => {
    const mirrored = mirrorEntityAcross(fixtureLeader(), { x: 0, y: 0 }, { x: 0, y: 1 }) as LeaderEntity;
    expect(mirrored.mleader?.block?.position.x).toBeCloseTo(-5.36, 9);
    expect(mirrored.mleader?.block?.position.y).toBeCloseTo(3, 9);
    expect(mirrored.mleader?.block?.rotation).toBeCloseTo(Math.PI, 9);
    // CORRECTED expectation (PR #43): the reflection is a signed scale Y —
    // the original delivery pinned { x: 1, y: 1 } / { x: 2, y: 2 } here,
    // which loses the reflection entirely (see the header note).
    expect(mirrored.mleader?.block?.scale).toEqual({ x: 1, y: -1 });
    const c = mirrored.mleader!.contexts![0]!;
    expect(c.block?.position.x).toBeCloseTo(-6.72, 9);
    expect(c.block?.position.y).toBeCloseTo(3, 9);
    expect(c.block?.rotation).toBeCloseTo(Math.PI, 9);
    expect(c.block?.scale).toEqual({ x: 2, y: -2 });
  });

  it('MIRROR across the Y axis, edit/save/reopen: the placement maps are the exact reflection (Fixture F)', () => {
    const state = readDxf(F);
    const original = leaderOf(state);
    const mirrored = mirrorEntityAcross(original, { x: 0, y: 0 }, { x: 0, y: 1 }) as LeaderEntity;
    const out = writeDxf({ ...state, entities: state.entities.map((e) => (e.id === original.id ? mirrored : e)) });
    const reopened = leaderOf(readDxf(out));
    // Codex's sample points: local (0,1) on the primary lands at (-5.36, 4);
    // on the additional context at (-6.72, 5).
    const p = place(reopened.mleader!.block!, { x: 0, y: 1 });
    expect(p.x).toBeCloseTo(-5.36, 6);
    expect(p.y).toBeCloseTo(4, 6);
    const c = place(reopened.mleader!.contexts![0]!.block!, { x: 0, y: 1 });
    expect(c.x).toBeCloseTo(-6.72, 6);
    expect(c.y).toBeCloseTo(5, 6);
    // And the whole maps agree with reflecting the original placements.
    for (const local of [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 3 }, { x: -1, y: 2 }]) {
      const want = reflectY(place(original.mleader!.block!, local));
      const got = place(reopened.mleader!.block!, local);
      expect(got.x).toBeCloseTo(want.x, 6);
      expect(got.y).toBeCloseTo(want.y, 6);
      const wantC = reflectY(place(original.mleader!.contexts![0]!.block!, local));
      const gotC = place(reopened.mleader!.contexts![0]!.block!, local);
      expect(gotC.x).toBeCloseTo(wantC.x, 6);
      expect(gotC.y).toBeCloseTo(wantC.y, 6);
    }
  });

  it('MIRROR across an arbitrary 30-degree axis: every placement equals the exact affine', () => {
    const original = fixtureLeader();
    const axis = { x: Math.cos(Math.PI / 6), y: Math.sin(Math.PI / 6) };
    const mirrored = mirrorEntityAcross(original, { x: 0, y: 0 }, axis) as LeaderEntity;
    const reflect = (p: { x: number; y: number }) => {
      const dot = p.x * axis.x + p.y * axis.y;
      return { x: 2 * dot * axis.x - p.x, y: 2 * dot * axis.y - p.y };
    };
    const placements: Array<[{ position: { x: number; y: number }; scale: { x: number; y: number }; rotation: number },
      { position: { x: number; y: number }; scale: { x: number; y: number }; rotation: number }]> = [
        [original.mleader!.block!, mirrored.mleader!.block!],
        [original.mleader!.contexts![0]!.block!, mirrored.mleader!.contexts![0]!.block!],
      ];
    for (const [before, after] of placements) {
      // The reflection is carried by the signed scale, never dropped.
      expect(after.scale.y).toBeLessThan(0);
      expect(after.scale.x).toBeGreaterThan(0);
      for (const local of [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 0 }, { x: 2, y: 3 }, { x: -1, y: 2 }]) {
        const want = reflect(place(before, local));
        const got = place(after, local);
        expect(got.x).toBeCloseTo(want.x, 9);
        expect(got.y).toBeCloseTo(want.y, 9);
      }
    }
  });
});

/** A block placement's local -> world map: position + R(rotation) * (scale . local). */
const place = (b: { position: { x: number; y: number }; scale: { x: number; y: number }; rotation: number }, local: { x: number; y: number }) => {
  const c = Math.cos(b.rotation), s = Math.sin(b.rotation);
  const lx = b.scale.x * local.x, ly = b.scale.y * local.y;
  return { x: b.position.x + c * lx - s * ly, y: b.position.y + s * lx + c * ly };
};
const reflectY = (p: { x: number; y: number }) => ({ x: -p.x, y: p.y });
