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
 * MIRROR expectation (derived, pinned here): mirroring across the Y axis maps
 * a placement (p, s, θ) to (reflect(p), s, reflect(θ)) — the position and the
 * rotation angle reflect, the (unsigned) scale is unchanged because a mirror
 * is an isometry. The model carries no mirror flag for mleader block
 * placements (the AutoCAD 47/49 transformation matrix is outside the modelled
 * group set, the slices-1/2 posture), so a mirrored placement is expressed as
 * the reflected position at the reflected angle with its scale intact.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LeaderEntity } from '../src/core/entities';
import { mirrorEntityAcross, rotateEntity, scaleEntityBy, translateEntity } from '../src/core/entities';
import { readDxf } from '../src/io/dxf';

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

  it('MIRROR across the Y axis: positions reflect, rotations reflect to PI, scales unchanged', () => {
    const mirrored = mirrorEntityAcross(fixtureLeader(), { x: 0, y: 0 }, { x: 0, y: 1 }) as LeaderEntity;
    expect(mirrored.mleader?.block?.position.x).toBeCloseTo(-5.36, 9);
    expect(mirrored.mleader?.block?.position.y).toBeCloseTo(3, 9);
    expect(mirrored.mleader?.block?.rotation).toBeCloseTo(Math.PI, 9);
    expect(mirrored.mleader?.block?.scale).toEqual({ x: 1, y: 1 });
    const c = mirrored.mleader!.contexts![0]!;
    expect(c.block?.position.x).toBeCloseTo(-6.72, 9);
    expect(c.block?.position.y).toBeCloseTo(3, 9);
    expect(c.block?.rotation).toBeCloseTo(Math.PI, 9);
    expect(c.block?.scale).toEqual({ x: 2, y: 2 });
  });
});
