/**
 * Dimensioning commands: DIMLINEAR, DIMALIGNED, DIMRADIUS, DIMDIAMETER, DIMANGULAR,
 * DIMBASELINE, DIMCONTINUE, DIMTEDIT, DIMEDIT and the named-style -DIMSTYLE.
 * Prompts follow AutoCAD; "<select object>" on Enter dimensions a picked line/arc/circle.
 */
import type { Point } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity, DimensionEntity, DimKind } from '../core/entities';
import { newId, arcEndpoints, textWidth } from '../core/entities';
import type { Editor } from '../app/editor';
import type { Drawing } from '../core/document';
import {
  dimensionText,
  resolveDimStyle,
  namedDimStyles,
  findDimStyle,
  withDimStyle,
  dimStyleUsage,
  dimVarList,
  dimVarValue,
  withDimVar,
  diffDimStyles,
  DIM_VARIABLES,
  type DimStyle,
} from '../core/dimension';
import { pickEntity } from '../core/selection';
import type { Tool, ToolContext } from './types';
import { scriptTool, point, pointOrKeyword, text, number, keyword, select, matchKeyword, type Step } from './script';

export function pickAt(ctx: ToolContext, p: Point): Entity | null {
  const hidden = new Set(ctx.doc.layers.filter((l) => !l.visible).map((l) => l.name));
  return pickEntity(p, ctx.doc.entities, ctx.doc.lookupBlock, ctx.aperture(), hidden);
}

function makeDim(ctx: ToolContext, kind: DimKind, p1: Point, p2: Point, linePoint: Point, rotation = 0, extra: Partial<DimensionEntity> = {}): DimensionEntity {
  return {
    id: newId(),
    layer: ctx.doc.currentLayer,
    color: 'ByLayer',
    type: 'dimension',
    kind,
    p1,
    p2,
    linePoint,
    rotation,
    style: ctx.doc.header.dimStyle,
    ...extra,
  };
}

/** Shared "[Mtext/Text/Angle]" handling: returns the text override, or undefined. */
function* textOverride(ctx: ToolContext, sample: DimensionEntity): Step<string | undefined> {
  const current = dimensionText(sample);
  const t = yield* text(`Enter dimension text <${current}>:`, null, true);
  if (t === null || t.trim() === '' || t.trim() === current) return undefined;
  ctx.log(`Dimension text = ${t}`);
  return t;
}

/** Linear dimension orientation from where the dimension line was placed. */
function autoRotation(p1: Point, p2: Point, loc: Point): number {
  const dx = Math.abs(p2.x - p1.x);
  const dy = Math.abs(p2.y - p1.y);
  if (dx < 1e-9) return Math.PI / 2;
  if (dy < 1e-9) return 0;
  const m = g.mid(p1, p2);
  // Placing the line above/below the points gives a horizontal dimension, beside them a vertical one.
  return Math.abs(loc.y - m.y) * dx >= Math.abs(loc.x - m.x) * dy ? 0 : Math.PI / 2;
}

/** "<select object>": pick a line/arc/circle and return its two definition points. */
function* selectObjectPoints(ctx: ToolContext): Step<[Point, Point] | null> {
  for (;;) {
    const p = yield* point(ctx, 'Select object to dimension:');
    if (!p) return null;
    const e = pickAt(ctx, p);
    if (!e) continue;
    if (e.type === 'line') return [e.a, e.b];
    if (e.type === 'arc') return arcEndpoints(e);
    if (e.type === 'circle') return [{ x: e.center.x - e.radius, y: e.center.y }, { x: e.center.x + e.radius, y: e.center.y }];
    if (e.type === 'polyline' && e.points.length >= 2) {
      // nearest segment
      let best: [Point, Point] = [e.points[0]!, e.points[1]!];
      let bestD = Infinity;
      const n = e.points.length;
      const count = e.closed ? n : n - 1;
      for (let i = 0; i < count; i += 1) {
        const a = e.points[i]!;
        const b = e.points[(i + 1) % n]!;
        const d = g.distToSegment(p, a, b);
        if (d < bestD) {
          bestD = d;
          best = [a, b];
        }
      }
      return best;
    }
    ctx.log('Object selected is not a line, arc, circle, or polyline.');
  }
}

export function dimLinearTool(): Tool {
  return scriptTool('DIMLINEAR', function* (ctx) {
    const first = yield* pointOrKeyword('Specify first extension line origin or <select object>:');
    let p1: Point;
    let p2: Point;
    if (!first) {
      const pts = yield* selectObjectPoints(ctx);
      if (!pts) return;
      [p1, p2] = pts;
    } else if ('point' in first) {
      p1 = first.point;
      const second = yield* point(ctx, 'Specify second extension line origin:', { trackFrom: p1 });
      if (!second) return;
      p2 = second;
    } else return;
    let forced: number | null = null;
    let override: string | undefined;
    const build = (loc: Point) => makeDim(ctx, 'linear', p1, p2, loc, forced ?? autoRotation(p1, p2, loc), { text: override });
    for (;;) {
      const r = yield* pointOrKeyword('Specify dimension line location or [Mtext/Text/Angle/Horizontal/Vertical/Rotated]:', ['Mtext', 'Text', 'Angle', 'Horizontal', 'Vertical', 'Rotated'], {
        preview: (c) => [build(c)],
        dyn: (c) => [dimensionText(build(c))],
        trackFrom: null,
      });
      if (!r) return;
      if ('point' in r) {
        const dim = build(r.point);
        ctx.doc.addEntities([dim]);
        ctx.log(`Dimension text = ${dimensionText(dim)}`);
        return;
      }
      if ('keyword' in r) {
        if (r.keyword === 'HORIZONTAL') forced = 0;
        else if (r.keyword === 'VERTICAL') forced = Math.PI / 2;
        else if (r.keyword === 'ROTATED') {
          const a = yield* number(ctx, 'Specify angle of dimension line <0>:', 0, { allowZero: true, allowNegative: true });
          if (a && 'value' in a) forced = g.rad(a.value);
        } else if (r.keyword === 'TEXT' || r.keyword === 'MTEXT') override = yield* textOverride(ctx, build(g.mid(p1, p2)));
        else ctx.log('Text angle is not supported; text follows the dimension line.');
      } else ctx.log(`Invalid option keyword: ${r.text}`);
    }
  });
}

export function dimAlignedTool(): Tool {
  return scriptTool('DIMALIGNED', function* (ctx) {
    const first = yield* pointOrKeyword('Specify first extension line origin or <select object>:');
    let p1: Point;
    let p2: Point;
    if (!first) {
      const pts = yield* selectObjectPoints(ctx);
      if (!pts) return;
      [p1, p2] = pts;
    } else if ('point' in first) {
      p1 = first.point;
      const second = yield* point(ctx, 'Specify second extension line origin:', { trackFrom: p1 });
      if (!second) return;
      p2 = second;
    } else return;
    let override: string | undefined;
    const build = (loc: Point) => makeDim(ctx, 'aligned', p1, p2, loc, 0, { text: override });
    for (;;) {
      const r = yield* pointOrKeyword('Specify dimension line location or [Mtext/Text/Angle]:', ['Mtext', 'Text', 'Angle'], {
        preview: (c) => [build(c)],
        dyn: (c) => [dimensionText(build(c))],
        trackFrom: null,
      });
      if (!r) return;
      if ('point' in r) {
        const dim = build(r.point);
        ctx.doc.addEntities([dim]);
        ctx.log(`Dimension text = ${dimensionText(dim)}`);
        return;
      }
      if ('keyword' in r && (r.keyword === 'TEXT' || r.keyword === 'MTEXT')) override = yield* textOverride(ctx, build(g.mid(p1, p2)));
      else if ('keyword' in r) ctx.log('Text angle is not supported.');
      else ctx.log(`Invalid option keyword: ${r.text}`);
    }
  });
}

function radialTool(kind: 'radius' | 'diameter'): Tool {
  return scriptTool(kind === 'radius' ? 'DIMRADIUS' : 'DIMDIAMETER', function* (ctx) {
    let center: Point | null = null;
    let onCircle: Point | null = null;
    while (!center) {
      const p = yield* point(ctx, 'Select arc or circle:');
      if (!p) return;
      const e = pickAt(ctx, p);
      if (!e || (e.type !== 'circle' && e.type !== 'arc')) {
        if (e) ctx.log('Object selected is not a circle or arc.');
        continue;
      }
      center = e.center;
      onCircle = g.polar(center, g.angleOf(center, p), e.radius);
    }
    let override: string | undefined;
    const c = center;
    const build = (loc: Point) => makeDim(ctx, kind, c, onCircle!, loc, 0, { text: override });
    ctx.log(`Dimension text = ${dimensionText(build(onCircle!))}`);
    for (;;) {
      const r = yield* pointOrKeyword('Specify dimension line location or [Mtext/Text/Angle]:', ['Mtext', 'Text', 'Angle'], {
        preview: (cur) => [build(cur)],
        dyn: (cur) => [dimensionText(build(cur))],
        trackFrom: null,
      });
      if (!r) return;
      if ('point' in r) {
        // A point exactly on the centre would leave no direction; nudge it onto the circle.
        const loc = g.dist(r.point, c) < 1e-9 ? onCircle! : r.point;
        ctx.doc.addEntities([build(loc)]);
        return;
      }
      if ('keyword' in r && (r.keyword === 'TEXT' || r.keyword === 'MTEXT')) override = yield* textOverride(ctx, build(onCircle!));
      else if ('keyword' in r) ctx.log('Text angle is not supported.');
      else ctx.log(`Invalid option keyword: ${r.text}`);
    }
  });
}

export const dimRadiusTool = (): Tool => radialTool('radius');
export const dimDiameterTool = (): Tool => radialTool('diameter');

/** Intersection of two infinite lines (null when parallel). */
function lineIntersection(a1: Point, a2: Point, b1: Point, b2: Point): Point | null {
  const r = g.sub(a2, a1);
  const s = g.sub(b2, b1);
  const denom = g.cross(r, s);
  if (Math.abs(denom) < 1e-12) return null;
  const t = g.cross(g.sub(b1, a1), s) / denom;
  return g.add(a1, g.scale(r, t));
}

export function dimAngularTool(): Tool {
  return scriptTool('DIMANGULAR', function* (ctx) {
    let center: Point | null = null;
    let p1: Point | null = null;
    let p2: Point | null = null;
    const first = yield* pointOrKeyword('Select arc, circle, line, or <specify vertex>:');
    if (!first) {
      center = yield* point(ctx, 'Specify angle vertex:');
      if (!center) return;
      p1 = yield* point(ctx, 'Specify first angle endpoint:', { trackFrom: center });
      if (!p1) return;
      p2 = yield* point(ctx, 'Specify second angle endpoint:', { trackFrom: center });
      if (!p2) return;
    } else if ('point' in first) {
      const e = pickAt(ctx, first.point);
      if (!e) {
        ctx.log('Nothing selected.');
        return;
      }
      if (e.type === 'arc') {
        center = e.center;
        [p1, p2] = arcEndpoints(e);
      } else if (e.type === 'circle') {
        center = e.center;
        p1 = g.polar(e.center, g.angleOf(e.center, first.point), e.radius);
        const second = yield* point(ctx, 'Specify second angle endpoint:', { trackFrom: center });
        if (!second) return;
        p2 = g.polar(e.center, g.angleOf(e.center, second), e.radius);
      } else if (e.type === 'line') {
        let other: Entity | null = null;
        while (!other) {
          const q = yield* point(ctx, 'Select second line:');
          if (!q) return;
          other = pickAt(ctx, q);
          if (other && other.type !== 'line') {
            ctx.log('Object selected is not a line.');
            other = null;
          }
        }
        if (other.type !== 'line') return;
        center = lineIntersection(e.a, e.b, other.a, other.b);
        if (!center) {
          ctx.log('Lines are parallel.');
          return;
        }
        const far = (l: { a: Point; b: Point }, near: Point) => (g.dist(l.a, near) >= g.dist(l.b, near) ? l.a : l.b);
        // Use the ends of the legs nearer to the pick points (AutoCAD measures the angle between the picked halves).
        const nearHalf = (l: { a: Point; b: Point }, pick: Point, c: Point) => (g.dot(g.sub(pick, c), g.sub(l.a, c)) >= 0 ? l.a : l.b);
        p1 = g.dist(e.a, center) < 1e-9 || g.dist(e.b, center) < 1e-9 ? far(e, center) : nearHalf(e, first.point, center);
        p2 = far(other, center);
      } else {
        ctx.log('Object selected is not an arc, circle, or line.');
        return;
      }
    } else return;
    const c = center;
    const a = p1;
    const b = p2;
    let override: string | undefined;
    const build = (loc: Point) => makeDim(ctx, 'angular', a, b, loc, 0, { center: c, text: override });
    for (;;) {
      const r = yield* pointOrKeyword('Specify dimension arc line location or [Mtext/Text/Angle]:', ['Mtext', 'Text', 'Angle'], {
        preview: (cur) => (g.dist(cur, c) > 1e-9 ? [build(cur)] : []),
        dyn: (cur) => [dimensionText(build(cur))],
        trackFrom: null,
      });
      if (!r) return;
      if ('point' in r) {
        if (g.dist(r.point, c) < 1e-9) continue;
        const dim = build(r.point);
        ctx.doc.addEntities([dim]);
        ctx.log(`Dimension text = ${dimensionText(dim)}`);
        return;
      }
      if ('keyword' in r && (r.keyword === 'TEXT' || r.keyword === 'MTEXT')) override = yield* textOverride(ctx, build(g.polar(c, g.angleOf(c, g.mid(a, b)), Math.max(g.dist(c, a), g.dist(c, b)))));
      else if ('keyword' in r) ctx.log('Text angle is not supported.');
      else ctx.log(`Invalid option keyword: ${r.text}`);
    }
  });
}

// ------------------------------------------------------------------ DIMBASELINE / DIMCONTINUE

const isChainable = (e: Entity | undefined | null): e is DimensionEntity =>
  !!e && e.type === 'dimension' && (e.kind === 'linear' || e.kind === 'aligned' || e.kind === 'angular');

/** The most recently created linear, aligned or angular dimension (DIMBASELINE / DIMCONTINUE start from it). */
export function lastChainableDimension(doc: Drawing): DimensionEntity | null {
  for (let i = doc.entities.length - 1; i >= 0; i -= 1) {
    const e = doc.entities[i];
    if (isChainable(e)) return e;
  }
  return null;
}

function linearAxes(d: DimensionEntity): { u: Point; n: Point } {
  let u: Point;
  if (d.kind === 'linear') u = { x: Math.cos(d.rotation), y: Math.sin(d.rotation) };
  else u = g.len(g.sub(d.p2, d.p1)) < 1e-12 ? { x: 1, y: 0 } : g.normalize(g.sub(d.p2, d.p1));
  return { u, n: { x: -u.y, y: u.x } };
}

/**
 * The next dimension of a baseline or continued chain.
 * `from` is the extension line origin of `base` the new dimension starts at
 * (DIMBASELINE: the base dimension's first origin; DIMCONTINUE: its second), `p` the new second origin.
 * Baseline dimension lines step away from the geometry by DIMDLI (× DIMSCALE);
 * continued dimensions share the base's dimension line.
 */
export function chainDimension(base: DimensionEntity, mode: 'baseline' | 'continue', from: Point, p: Point, style: DimStyle = base.style, id = newId()): DimensionEntity {
  const r = resolveDimStyle(style);
  const spacing = r.baselineSpacing * (r.scale || 1);
  const clean = { text: undefined, textPosition: undefined, textRotation: undefined };
  if (base.kind === 'angular' && base.center) {
    const c = base.center;
    const radius = g.dist(c, base.linePoint);
    const a0 = g.angleOf(c, from);
    const a1 = g.angleOf(c, p);
    const mid1 = a0 + g.normAngle(a1 - a0) / 2;
    const mid2 = mid1 + Math.PI;
    const baseAngle = g.angleOf(c, base.linePoint);
    const bs = g.angleOf(c, base.p1);
    const be = g.angleOf(c, base.p2);
    const baseSweep = g.angleInSweep(baseAngle, bs, be) ? [bs, be] : [be, bs];
    let mid: number;
    if (mode === 'baseline') {
      // The new angle encloses the base angle: its sweep contains the base's dimension arc.
      mid = g.angleInSweep(baseAngle, a0, a1) === g.angleInSweep(mid1, a0, a1) ? mid1 : mid2;
    } else {
      // The continued angle lies beyond the base angle, not over it.
      mid = g.angleInSweep(mid1, baseSweep[0]!, baseSweep[1]!) ? mid2 : mid1;
    }
    const rr = mode === 'baseline' ? radius + spacing : radius;
    return { ...base, ...clean, id, style, p1: from, p2: p, linePoint: g.polar(c, mid, rr) };
  }
  const { n } = linearAxes(base);
  const side = Math.sign(g.dot(g.sub(base.linePoint, from), n)) || 1;
  const linePoint = mode === 'baseline' ? g.add(base.linePoint, g.scale(n, side * spacing)) : base.linePoint;
  return { ...base, ...clean, id, style, p1: from, p2: p, linePoint };
}

function chainTool(mode: 'baseline' | 'continue'): Tool {
  return scriptTool(mode === 'baseline' ? 'DIMBASELINE' : 'DIMCONTINUE', function* (ctx) {
    let base: DimensionEntity | null = lastChainableDimension(ctx.doc);
    let from: Point | null = null;
    const pickBase = function* (): Step<boolean> {
      for (;;) {
        const q = yield* point(ctx, mode === 'baseline' ? 'Select base dimension:' : 'Select continued dimension:');
        if (!q) return false;
        const e = pickAt(ctx, q);
        if (!isChainable(e)) {
          ctx.log(e ? 'Dimension must be linear, ordinate, or angular.' : 'Nothing selected.');
          continue;
        }
        base = e;
        // The extension line nearest the pick becomes the base (baseline) or the continuation point.
        from = g.dist(q, e.p1) <= g.dist(q, e.p2) ? e.p1 : e.p2;
        return true;
      }
    };
    if (!base) {
      if (!(yield* pickBase())) return;
    } else from = mode === 'baseline' ? base.p1 : base.p2;
    const history: Array<{ id: string; base: DimensionEntity; from: Point }> = [];
    for (;;) {
      const b = base!;
      const f = from!;
      const build = (p: Point) => chainDimension(b, mode, f, p, ctx.doc.header.dimStyle, 'preview');
      const r = yield* pointOrKeyword('Specify a second extension line origin or [Undo/Select] <Select>:', ['Undo', 'Select'], {
        preview: (cur) => [build(cur)],
        dyn: (cur) => [dimensionText(build(cur))],
        trackFrom: f,
      });
      if (!r || ('keyword' in r && r.keyword === 'SELECT')) {
        if (!(yield* pickBase())) return;
        continue;
      }
      if ('keyword' in r && r.keyword === 'UNDO') {
        const last = history.pop();
        if (!last) {
          ctx.log('Nothing to undo.');
          continue;
        }
        ctx.doc.removeEntities([last.id]);
        base = last.base;
        from = last.from;
        continue;
      }
      if (!('point' in r)) {
        ctx.log(`Invalid option keyword: ${'text' in r ? r.text : r.keyword}`);
        continue;
      }
      const dim = chainDimension(b, mode, f, r.point, ctx.doc.header.dimStyle);
      ctx.doc.addEntities([dim]);
      ctx.log(`Dimension text = ${dimensionText(dim)}`);
      history.push({ id: dim.id, base: b, from: f });
      base = dim;
      from = mode === 'baseline' ? dim.p1 : dim.p2;
    }
  });
}

export const dimBaselineTool = (): Tool => chainTool('baseline');
export const dimContinueTool = (): Tool => chainTool('continue');

// ------------------------------------------------------------------ DIMTEDIT / DIMEDIT

/** Ends of the dimension line of a linear/aligned dimension (where the extension lines meet it). */
function dimLineEnds(d: DimensionEntity): [Point, Point] {
  const { u } = linearAxes(d);
  const project = (p: Point) => g.add(d.linePoint, g.scale(u, g.dot(g.sub(p, d.linePoint), u)));
  return [project(d.p1), project(d.p2)];
}

/** DIMTEDIT Left / Right / Center: text position along the dimension line. */
export function justifiedTextPosition(d: DimensionEntity, where: 'left' | 'right' | 'center'): Point | undefined {
  if (d.kind !== 'linear' && d.kind !== 'aligned') return undefined;
  const [a1, a2] = dimLineEnds(d);
  if (where === 'center') return g.mid(a1, a2);
  const s = resolveDimStyle(d.style);
  const k = s.scale || 1;
  const w = textWidth(dimensionText(d), s.textHeight * k);
  // "Left" is the end further left (or lower, for a vertical dimension).
  const leftFirst = Math.abs(a1.x - a2.x) > 1e-9 ? a1.x < a2.x : a1.y < a2.y;
  const [start, end] = (where === 'left') === leftFirst ? [a1, a2] : [a2, a1];
  const dir = g.normalize(g.sub(end, start));
  return g.add(start, g.scale(dir, (s.arrowSize + s.textGap) * k + w / 2));
}

export function dimTeditTool(): Tool {
  return scriptTool('DIMTEDIT', function* (ctx) {
    let dim: DimensionEntity | null = null;
    while (!dim) {
      const p = yield* point(ctx, 'Select dimension:');
      if (!p) return;
      const e = pickAt(ctx, p);
      if (e && e.type === 'dimension') dim = e;
      else ctx.log(e ? 'Object selected is not a dimension.' : 'Nothing selected.');
    }
    const d = dim;
    const r = yield* pointOrKeyword('Specify new location for dimension text or [Left/Right/Center/Home/Angle]:', ['Left', 'Right', 'Center', 'Home', 'Angle'], {
      preview: (cur) => [{ ...d, id: 'preview', textPosition: cur }],
      trackFrom: null,
    });
    if (!r) return;
    let next: DimensionEntity | null = null;
    if ('point' in r) next = { ...d, textPosition: r.point };
    else if ('keyword' in r) {
      switch (r.keyword) {
        case 'LEFT':
        case 'RIGHT':
        case 'CENTER': {
          const at = justifiedTextPosition(d, r.keyword.toLowerCase() as 'left' | 'right' | 'center');
          if (!at) ctx.log('Left/Right/Center apply to linear and aligned dimensions.');
          else next = { ...d, textPosition: at };
          break;
        }
        case 'HOME':
          next = { ...d, textPosition: undefined, textRotation: undefined };
          break;
        case 'ANGLE': {
          const a = yield* number(ctx, 'Specify angle for dimension text:', null, { allowZero: true, allowNegative: true });
          if (!a || !('value' in a)) return;
          next = { ...d, textRotation: g.rad(a.value) };
          break;
        }
      }
    } else ctx.log(`Invalid option keyword: ${r.text}`);
    if (next) ctx.doc.replaceEntities([next]);
  });
}

/** DIMEDIT on a set of dimensions (pure, for the command and tests). */
export function editDimensions(dims: readonly DimensionEntity[], op: { kind: 'home' } | { kind: 'new'; text: string } | { kind: 'rotate'; angle: number } | { kind: 'oblique'; angle: number | undefined }): DimensionEntity[] {
  return dims.flatMap((d): DimensionEntity[] => {
    switch (op.kind) {
      case 'home':
        return [{ ...d, textPosition: undefined, textRotation: undefined }];
      case 'new':
        // Empty text restores the measurement; "<>" keeps it inside the new text.
        return [{ ...d, text: op.text === '' || op.text === '<>' ? undefined : op.text }];
      case 'rotate':
        return [{ ...d, textRotation: op.angle }];
      case 'oblique':
        return d.kind === 'linear' || d.kind === 'aligned' ? [{ ...d, oblique: op.angle }] : [];
    }
  });
}

export function dimEditTool(): Tool {
  return scriptTool('DIMEDIT', function* (ctx) {
    const kind = yield* keyword(ctx, 'Enter type of dimension editing [Home/New/Rotate/Oblique] <Home>:', ['Home', 'New', 'Rotate', 'Oblique'], 'Home');
    if (!kind) return;
    let op: Parameters<typeof editDimensions>[1];
    const dimsOf = (ids: string[]) => {
      const set = new Set(ids);
      return ctx.doc.entities.filter((e): e is DimensionEntity => set.has(e.id) && e.type === 'dimension');
    };
    let ids: string[];
    if (kind === 'NEW') {
      const t = yield* text('Enter dimension text (<> = measurement) <<>>:', '<>', true);
      if (t === null) return;
      op = { kind: 'new', text: t };
      ids = yield* select(ctx);
    } else if (kind === 'ROTATE') {
      const a = yield* number(ctx, 'Specify angle for dimension text:', null, { allowZero: true, allowNegative: true });
      if (!a || !('value' in a)) return;
      op = { kind: 'rotate', angle: g.rad(a.value) };
      ids = yield* select(ctx);
    } else if (kind === 'OBLIQUE') {
      ids = yield* select(ctx);
      const a = yield* number(ctx, 'Enter obliquing angle (press ENTER for none):', null, { allowZero: true, allowNegative: true });
      op = { kind: 'oblique', angle: a && 'value' in a ? g.rad(a.value) : undefined };
    } else {
      op = { kind: 'home' };
      ids = yield* select(ctx);
    }
    const dims = dimsOf(ids);
    const edited = editDimensions(dims, op);
    ctx.doc.replaceEntities(edited);
    ctx.log(`${edited.length} dimension(s) edited.`);
  });
}

// ------------------------------------------------------------------ -DIMSTYLE (named styles)

function fmtVar(v: number | string): string {
  return typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : `"${v}"`;
}

function listVars(ctx: ToolContext, s: DimStyle): void {
  ctx.log(`Dimension style: ${s.name}`);
  for (const r of dimVarList(s)) ctx.log(`  ${r.name.padEnd(10)} ${fmtVar(r.value).padEnd(14)} ${r.description}`);
}

/** Make `style` current (header) without history, like AutoCAD system variables. */
function setCurrent(doc: Drawing, style: DimStyle): void {
  doc.setHeader({ dimStyle: style });
}

/**
 * Command-line DIMSTYLE over the drawing's named styles (state.meta.dimStyles):
 * [Save/Restore/STatus/Variables/Apply/?]. `Restore ~name` lists the differences to the current style.
 */
export function dimstyleCommandTool(arg?: string): Tool {
  return scriptTool('-DIMSTYLE', function* (ctx) {
    const doc = ctx.doc;
    const kws = ['Save', 'Restore', 'STatus', 'Variables', 'Apply', '?'];
    const parts = (arg ?? '').split(/\s+/).filter(Boolean);
    let opt = parts[0] ? matchKeyword(parts[0], kws) : null;
    if (!opt) {
      ctx.log(`Current dimension style: ${doc.header.dimStyle.name}`);
      opt = yield* keyword(ctx, 'Enter a dimension style option [Save/Restore/STatus/Variables/Apply/?] <Restore>:', kws, 'Restore');
      if (!opt) return;
    }
    const current = doc.header.dimStyle;
    const listNames = () => {
      const names = namedDimStyles(doc.snapshot);
      ctx.log('Named dimension styles:');
      for (const s of names) ctx.log(`  ${s.name}${s.name.toUpperCase() === current.name.toUpperCase() ? '  (current)' : ''}  ${dimStyleUsage(doc.snapshot, s.name)} dimension(s)`);
    };
    const pickDimStyle = function* (): Step<DimStyle | null> {
      for (;;) {
        const p = yield* point(ctx, 'Select dimension:');
        if (!p) return null;
        const e = pickAt(ctx, p);
        if (e && e.type === 'dimension') return e.style;
        ctx.log(e ? 'Object selected is not a dimension.' : 'Nothing selected.');
      }
    };
    switch (opt) {
      case '?':
        listNames();
        return;
      case 'STATUS':
        listVars(ctx, current);
        return;
      case 'VARIABLES': {
        const n = parts[1] ?? (yield* text('Enter a dimension style name, [?] or <select dimension>:', '', true));
        if (n === null) return;
        if (n.trim() === '?') return listNames();
        const s = n.trim() ? findDimStyle(doc.snapshot, n) : yield* pickDimStyle();
        if (!s) {
          if (n.trim()) ctx.log(`Cannot find dimension style "${n.trim()}".`);
          return;
        }
        listVars(ctx, s);
        return;
      }
      case 'RESTORE': {
        const n = parts[1] ?? (yield* text('Enter a dimension style name, [?] or <select dimension>:', '', true));
        if (n === null) return;
        const name = n.trim();
        if (name === '?') return listNames();
        if (name.startsWith('~')) {
          const other = findDimStyle(doc.snapshot, name.slice(1));
          if (!other) {
            ctx.log(`Cannot find dimension style "${name.slice(1)}".`);
            return;
          }
          const diff = diffDimStyles(current, other);
          ctx.log(`Differences between ${other.name} and current settings:`);
          if (diff.length === 0) ctx.log('  None');
          for (const d of diff) ctx.log(`  ${d.name.padEnd(10)} ${fmtVar(d.b).padEnd(14)} ${fmtVar(d.a)}`);
          return;
        }
        const s = name ? findDimStyle(doc.snapshot, name) : yield* pickDimStyle();
        if (!s) {
          if (name) ctx.log(`Cannot find dimension style "${name}".`);
          return;
        }
        setCurrent(doc, s);
        ctx.log(`Current dimension style: ${s.name}`);
        return;
      }
      case 'SAVE': {
        let n = parts[1] ?? (yield* text('Enter name for new dimension style or [?]:', null, true));
        if (!n) return;
        n = n.trim();
        if (n === '?') return listNames();
        if (!/^[^<>/\\":;?*|,=`]{1,255}$/.test(n)) {
          ctx.log('Invalid dimension style name.');
          return;
        }
        const existing = findDimStyle(doc.snapshot, n);
        if (existing && existing.name.toUpperCase() !== current.name.toUpperCase()) {
          const yes = yield* keyword(ctx, 'That name is already in use, redefine it? [Yes/No] <N>:', ['Yes', 'No'], 'No');
          if (yes !== 'YES') return;
        }
        const saved: DimStyle = { ...current, name: existing?.name ?? n };
        doc.transact((s) => withDimStyle(s, saved));
        setCurrent(doc, saved);
        ctx.log(`Dimension style "${saved.name}" saved and made current.`);
        return;
      }
      case 'APPLY': {
        const ids = yield* select(ctx);
        const set = new Set(ids);
        const dims = doc.entities.filter((e): e is DimensionEntity => set.has(e.id) && e.type === 'dimension');
        doc.replaceEntities(dims.map((d) => ({ ...d, style: current })));
        ctx.log(`${dims.length} dimension(s) updated to style ${current.name}.`);
        return;
      }
    }
  });
}

// ------------------------------------------------------------------ registration

/** DIM* variables that do not have a command yet (the drafting set registers DIMTXT, DIMASZ ...). */
const EXTRA_DIMVARS = [...DIM_VARIABLES.map((v) => ({ name: v.name, description: v.description })), { name: 'DIMBLK', description: 'Arrow block (both ends)' }, { name: 'DIMTOL', description: 'Generate tolerances (0/1)' }, { name: 'DIMLIM', description: 'Generate dimension limits (0/1)' }, { name: 'DIMTIH', description: 'Text inside horizontal (0/1)' }, { name: 'DIMTOH', description: 'Text outside horizontal (0/1)' }, { name: 'DIMSAH', description: 'Separate arrow blocks (0/1)' }, { name: 'DIMZIN', description: 'Zero suppression (4 leading, 8 trailing)' }];

function dimVarCommand(editor: Editor, name: string, description: string): void {
  const apply = (ed: Editor, raw: string) => {
    let v = raw.trim().replace(/^"(.*)"$/, '$1');
    const numeric = typeof dimVarValue(ed.doc.header.dimStyle, name) === 'number';
    // Colours: BYBLOCK / BYLAYER mean "the dimension's own colour" (0).
    if (numeric && /^by(block|layer)$/i.test(v)) v = '0';
    if (numeric && !Number.isFinite(parseFloat(v))) {
      ed.log(`Invalid value for ${name}.`);
      return;
    }
    const next = withDimVar(ed.doc.header.dimStyle, name, numeric ? parseFloat(v) : v);
    ed.doc.setHeader({ dimStyle: next });
    ed.log(`${name} = ${fmtVar(dimVarValue(next, name))}`);
    ed.render();
  };
  editor.register({
    name,
    aliases: [],
    description,
    startsTool: true,
    run: (ed, arg) => {
      if (arg !== undefined) {
        apply(ed, arg);
        return;
      }
      ed.startTool(
        scriptTool(name, function* () {
          const cur = dimVarValue(ed.doc.header.dimStyle, name);
          const t = yield* text(`Enter new value for ${name} <${fmtVar(cur)}>:`, null, typeof cur === 'string');
          if (t !== null && t.trim() !== '') apply(ed, t);
        }),
      );
    },
  });
}

/**
 * DIMSTYLE (Dimension Style Manager dialog), -DIMSTYLE (named styles on the command line),
 * DIMBASELINE, DIMCONTINUE, DIMTEDIT, DIMEDIT and the DIM* variables that have no command yet.
 * Call after the drafting commands: Editor.register replaces an existing name / alias.
 */
export function registerDimStyleCommands(editor: Editor): void {
  const reg = (name: string, aliases: string[], description: string, run: (ed: Editor, arg?: string) => void, startsTool = true) => editor.register({ name, aliases, description, run, startsTool });
  reg(
    'DIMSTYLE',
    ['D', 'DST', 'DDIM', 'DIMSTY'],
    'Dimension Style Manager (with an option: DIMSTYLE Save|Restore|STatus|Variables|Apply|? <name>)',
    (ed, arg) => {
      if ((arg && arg.trim()) || typeof document === 'undefined') {
        ed.startTool(dimstyleCommandTool(arg));
        return;
      }
      void import('../ui/dimstyle')
        .then((m) => m.dimStyleManager(ed))
        .catch((err: unknown) => ed.log(`Dimension Style Manager failed: ${(err as Error).message}`));
    },
    false,
  );
  reg('-DIMSTYLE', [], 'Dimension style on the command line [Save/Restore/STatus/Variables/Apply/?]', (ed, arg) => ed.startTool(dimstyleCommandTool(arg)));
  reg('DIMBASELINE', ['DBA', 'DIMBASE'], 'Baseline dimension from the previous or a selected dimension', (ed) => ed.startTool(dimBaselineTool()));
  reg('DIMCONTINUE', ['DCO', 'DIMCONT'], 'Continued dimension from the previous or a selected dimension', (ed) => ed.startTool(dimContinueTool()));
  reg('DIMTEDIT', ['DIMTED'], 'Move or rotate dimension text [Left/Right/Center/Home/Angle]', (ed) => ed.startTool(dimTeditTool()));
  reg('DIMEDIT', ['DED', 'DIMED'], 'Edit dimensions [Home/New/Rotate/Oblique]', (ed) => ed.startTool(dimEditTool()));
  for (const v of EXTRA_DIMVARS) if (!editor.commands.has(v.name)) dimVarCommand(editor, v.name, v.description);
}
