import type { Vec3 } from '../../src/model3d/math';
import type { SceneSink, SinkStyle } from '../../src/render3d/scene-sink';

/** Test sink: records every primitive as segments (polygons become closed loops). */
export class SegmentCollector implements SceneSink {
  readonly segments: Array<{ a: Vec3; b: Vec3; style: SinkStyle }> = [];
  line(a: Vec3, b: Vec3, style: SinkStyle): void {
    this.segments.push({ a, b, style });
  }
  polygon(points: readonly Vec3[], style: SinkStyle): void {
    for (let i = 0; i < points.length && points.length > 1; i++) this.segments.push({ a: points[i]!, b: points[(i + 1) % points.length]!, style });
  }
}
