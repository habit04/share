import type { ArcEntity } from '../../core/entities';
import { EPS, normAngle } from '../../core/geometry';

const TAU = Math.PI * 2;
// DXF's usual [0, 2π] and wrapped negative angles, plus generated DIM intervals.
// Larger nonfull angles need native normalization/precision evidence before admission.
const MAX_NONFULL_ANGLE = TAU * 2;

export type CanvasArcAdmission =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly startAngle: number; readonly sweep: number; readonly fullCircle: boolean };

/** Match draw.ts's full-circle shortcut and Canvas's directional raw-sweep semantics. */
export function canvasArcAdmission(arc: Pick<ArcEntity, 'startAngle' | 'endAngle'>): CanvasArcAdmission {
  if (![arc.startAngle, arc.endAngle].every(Number.isFinite)) return { ok: false, reason: 'Invalid ARC angles' };
  const rawSweep = arc.endAngle - arc.startAngle;
  if (!Number.isFinite(rawSweep)) return { ok: false, reason: 'Invalid ARC sweep' };
  const sweep = normAngle(rawSweep);
  // Canvas deliberately ignores the original angles on this branch. Retaining a huge
  // start would round away every tessellation increment even though Canvas draws a circle.
  if (sweep < EPS) return { ok: true, startAngle: 0, sweep: TAU, fullCircle: true };
  // Canvas clamps a positive raw revolution to a circle; modulo reduction would instead
  // draw a partial arc. Negative wrapped sweeps retain Canvas's ordinary CCW behavior.
  if (rawSweep > TAU) return { ok: false, reason: 'Unsupported Canvas ARC sweep beyond one revolution' };
  if (Math.abs(arc.startAngle) > MAX_NONFULL_ANGLE || Math.abs(arc.endAngle) > MAX_NONFULL_ANGLE) return { ok: false, reason: 'Unsupported Canvas ARC angular precision range' };
  return { ok: true, startAngle: arc.startAngle, sweep, fullCircle: false };
}
