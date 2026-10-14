import type { Point } from '../core/geometry';
import type { ShxTextRun } from './shx-fonts';

export type ShxPathSegment = { readonly from: Point; readonly to: Point; readonly controls?: readonly [Point, Point] };
/** Geometry is transformed before painting so physical stroke width does not follow font shear. */
export function shxTextPaths(run: Extract<ShxTextRun, { ok: true }>, text: { position: Point; rotation: number; widthFactor?: number; oblique?: number }, offset: number): readonly ShxPathSegment[] {
  const c = Math.cos(text.rotation), s = Math.sin(text.rotation), wf = text.widthFactor ?? 1, slant = Math.tan(text.oblique ?? 0);
  const world = (x: number, y: number): Point => {
    const lx = (x + offset) * wf + y * slant;
    return { x: text.position.x + lx * c - y * s, y: text.position.y + lx * s + y * c };
  };
  const paths: ShxPathSegment[] = [];
  for (const segment of run.segments) {
    if (segment.kind === 'line') { paths.push({ from: world(...segment.from), to: world(...segment.to) }); continue; }
    const count = Math.max(1, Math.ceil(Math.abs(segment.sweep) / (Math.PI / 2))), step = segment.sweep / count;
    for (let i = 0; i < count; i++) {
      const a = segment.startAngle + i * step, b = a + step, factor = 4 / 3 * Math.tan(step / 4);
      const at = (angle: number) => [segment.center[0] + segment.radius * Math.cos(angle), segment.center[1] + segment.radius * Math.sin(angle)] as const;
      const from = at(a), to = at(b);
      paths.push({ from: world(...from), to: world(...to), controls: [
        world(from[0] - factor * segment.radius * Math.sin(a), from[1] + factor * segment.radius * Math.cos(a)),
        world(to[0] + factor * segment.radius * Math.sin(b), to[1] - factor * segment.radius * Math.cos(b)),
      ] });
    }
  }
  return paths;
}
