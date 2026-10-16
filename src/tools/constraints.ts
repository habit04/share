/**
 * Priority 30 review §3 — the constraint commands: CONADD, CONEDIT,
 * CONDELETE, CONSOLVE, CONSTATUS. Storage and a pure adapter existed
 * (30.4 slice A) but no user-facing workflow did; these are thin command
 * adapters over src/core/constraints/apply.ts in the DYNSET pattern:
 * the pure adapter validates, solves and refuses BEFORE anything is
 * committed, an accepted operation installs through exactly ONE
 * doc.transact (one undo step), and every refusal logs its code +
 * message and transacts nothing.
 *
 * Boundaries, stated rather than implied:
 *  - Model space only. Constraints live on model-space entities
 *    (DrawingState.entities); in a layout (paper space, or a floating
 *    viewport) every command here refuses with a diagnostic instead of
 *    acting on the wrong entity list (the R08 lesson).
 *  - Constrainable entities are the model's: line, circle, arc,
 *    polyline, point (isConstrainable). Anything else is refused at the
 *    prompt with the supported list, never silently skipped.
 *  - A drawing whose JCAD_CONSTRAINTS payload is retained unmodeled
 *    refuses all five commands (the adapter's constraints-retained
 *    rule); CONSTATUS reports that state instead of guessing.
 *  - Statuses are the solver's own, reported verbatim: satisfied /
 *    violated (with the live measured value) / reference measurements /
 *    redundant / suppressed, and the honest DOF figures — including
 *    'rank-unknown' / -1 when rank work was skipped (R12), never an
 *    invented positive remainder.
 */
import type { Entity } from '../core/entities';
import { newId } from '../core/entities';
import {
  DIMENSIONAL_KINDS,
  isConstrainable,
  resolveAnchorPoint,
  segmentEndpoints,
  type AnchorRef,
  type Constraint,
  type ConstraintKind,
} from '../core/constraints/model';
import {
  addConstraint,
  removeConstraint,
  solveAndApply,
  withConstraintValue,
  type ConstraintApplyResult,
} from '../core/constraints/apply';
import { analyzeConstraints, type ConstraintDiagnostic } from '../core/constraints/solve';
import type { Tool, ToolContext } from './types';
import { scriptTool, text, number, keyword, select, dflt, type Step } from './script';

// ---------------------------------------------------------------------------
// Shared guards and result handling
// ---------------------------------------------------------------------------

/** True when the command must not run (the reason has been logged). */
function guard(ctx: ToolContext, cmd: string): boolean {
  if (ctx.doc.space) {
    ctx.log(
      `${cmd} refused: constraints live on model-space entities and the active space is a layout. ` +
        'Switch to the Model tab — paper-space constraint editing is not supported.',
    );
    return true;
  }
  if (ctx.doc.snapshot.constraintsRetained !== undefined) {
    ctx.log(
      `${cmd} refused (constraints-retained): this drawing carries constraint data this build cannot model; ` +
        'it is retained as data and cannot be edited, solved or reported on.',
    );
    return true;
  }
  return false;
}

function logRefusal(ctx: ToolContext, cmd: string, r: ConstraintApplyResult): void {
  ctx.log(`${cmd} refused (${r.code ?? 'failed'}): ${r.message ?? 'the change was not applied.'}`);
  if (r.problems) for (const p of r.problems) ctx.log(`  ${p.code}: ${p.message}`);
}

const fmt4 = (v: number | undefined): string => (v === undefined ? '?' : v.toFixed(4));

const refText = (r: AnchorRef): string => `${r.entityId}:${r.anchor}${r.index !== undefined ? ` ${r.index}` : ''}`;
const refsText = (c: Constraint): string => c.refs.map(refText).join(', ');

/** Sequential entity picker: consumes the pick-first selection first,
 *  then prompts per step (a window selection queues its remainder). */
class Picker {
  private queue: string[];
  readonly picked: string[] = [];

  constructor(ctx: ToolContext) {
    this.queue = [...ctx.selection];
  }

  private entity(ctx: ToolContext, id: string): Entity | undefined {
    return ctx.doc.snapshot.entities.find((e) => e.id === id);
  }

  *next(ctx: ToolContext, prompt: string): Step<Entity | null> {
    for (;;) {
      const id = this.queue.shift();
      if (id === undefined) break;
      const e = this.entity(ctx, id);
      if (e) {
        this.picked.push(id);
        return e;
      }
    }
    const saved = ctx.selection;
    ctx.selection = new Set();
    const ids = yield* select(ctx, prompt);
    ctx.selection = saved;
    if (ids.length === 0) return null;
    this.queue.push(...ids.slice(1));
    const e = this.entity(ctx, ids[0]!);
    if (!e) {
      ctx.log(`Entity '${ids[0]}' is not in model space.`);
      return null;
    }
    this.picked.push(ids[0]!);
    return e;
  }
}

// ---------------------------------------------------------------------------
// Anchor prompts (selection -> AnchorRef, per the model's §2.1 table)
// ---------------------------------------------------------------------------

function* indexPrompt(ctx: ToolContext, prompt: string, count: number): Step<number | null> {
  const ans = yield* number(ctx, `${prompt} (0-${count - 1}):`, 0, { from: null, integer: true, min: 0, allowZero: true });
  if (!ans || !('value' in ans)) return null;
  if (ans.value >= count) {
    ctx.log(`Index ${ans.value} is out of range (0-${count - 1}).`);
    return null;
  }
  return ans.value;
}

function* pointAnchor(ctx: ToolContext, e: Entity, label: string): Step<AnchorRef | null> {
  if (!isConstrainable(e)) {
    ctx.log(`${label}: a ${e.type} cannot be constrained (supported entities: line, circle, arc, polyline, point).`);
    return null;
  }
  switch (e.type) {
    case 'point':
      return { entityId: e.id, anchor: 'position' };
    case 'circle':
      return { entityId: e.id, anchor: 'center' };
    case 'line': {
      const k = yield* keyword(ctx, `${label} on line '${e.id}' [Start/End/Midpoint]:`, ['Start', 'End', 'Midpoint'], 'Start');
      if (!k) return null;
      return { entityId: e.id, anchor: k === 'END' ? 'end' : k === 'MIDPOINT' ? 'midpoint' : 'start' };
    }
    case 'arc': {
      const k = yield* keyword(ctx, `${label} on arc '${e.id}' [Start/End/Center]:`, ['Start', 'End', 'Center'], 'Start');
      if (!k) return null;
      return { entityId: e.id, anchor: k === 'END' ? 'end' : k === 'CENTER' ? 'center' : 'start' };
    }
    case 'polyline': {
      const k = yield* keyword(ctx, `${label} on polyline '${e.id}' [Start/End/Vertex/Midpoint]:`, ['Start', 'End', 'Vertex', 'Midpoint'], 'Start');
      if (!k) return null;
      if (k === 'START') return { entityId: e.id, anchor: 'start' };
      if (k === 'END') return { entityId: e.id, anchor: 'end' };
      if (k === 'VERTEX') {
        const i = yield* indexPrompt(ctx, `${label} vertex index`, e.points.length);
        return i === null ? null : { entityId: e.id, anchor: 'vertex', index: i };
      }
      const segCount = e.closed ? e.points.length : e.points.length - 1;
      const i = yield* indexPrompt(ctx, `${label} segment index`, Math.max(segCount, 1));
      return i === null ? null : { entityId: e.id, anchor: 'midpoint', index: i };
    }
  }
}

function* segmentRef(ctx: ToolContext, e: Entity, label: string): Step<AnchorRef | null> {
  if (e.type === 'line') return { entityId: e.id, anchor: 'whole' };
  if (e.type === 'polyline') {
    const segCount = e.closed ? e.points.length : e.points.length - 1;
    if (segCount < 1) {
      ctx.log(`${label}: polyline '${e.id}' has no segment.`);
      return null;
    }
    const i = yield* indexPrompt(ctx, `${label} segment index on polyline '${e.id}'`, segCount);
    return i === null ? null : { entityId: e.id, anchor: 'segment', index: i };
  }
  ctx.log(`${label}: a ${e.type} has no segment (a line or a polyline is required).`);
  return null;
}

function curveRef(ctx: ToolContext, e: Entity, label: string): AnchorRef | null {
  if (e.type === 'circle' || e.type === 'arc') return { entityId: e.id, anchor: 'whole' };
  ctx.log(`${label}: a ${e.type} is not a curve (a circle or an arc is required).`);
  return null;
}

// ---------------------------------------------------------------------------
// CONADD — build refs per kind, then role/value for dimensional kinds
// ---------------------------------------------------------------------------

interface BuiltRefs {
  readonly refs: AnchorRef[];
  readonly distanceMode?: 'horizontal' | 'vertical';
}

function* buildRefs(ctx: ToolContext, picker: Picker, kind: ConstraintKind): Step<BuiltRefs | null> {
  const twoPoints = function* (firstLabel: string, secondLabel: string): Step<BuiltRefs | null> {
    const e1 = yield* picker.next(ctx, `Select first object (${firstLabel}):`);
    if (!e1) return null;
    const r1 = yield* pointAnchor(ctx, e1, firstLabel);
    if (!r1) return null;
    const e2 = yield* picker.next(ctx, `Select second object (${secondLabel}):`);
    if (!e2) return null;
    const r2 = yield* pointAnchor(ctx, e2, secondLabel);
    if (!r2) return null;
    return { refs: [r1, r2] };
  };
  const twoSegments = function* (): Step<BuiltRefs | null> {
    const e1 = yield* picker.next(ctx, 'Select first segment object:');
    if (!e1) return null;
    const r1 = yield* segmentRef(ctx, e1, 'First segment');
    if (!r1) return null;
    const e2 = yield* picker.next(ctx, 'Select second segment object:');
    if (!e2) return null;
    const r2 = yield* segmentRef(ctx, e2, 'Second segment');
    if (!r2) return null;
    return { refs: [r1, r2] };
  };
  const twoCurves = function* (firstLabel: string, secondLabel: string): Step<BuiltRefs | null> {
    const e1 = yield* picker.next(ctx, `Select first curve (${firstLabel}):`);
    if (!e1) return null;
    const r1 = curveRef(ctx, e1, firstLabel);
    if (!r1) return null;
    const e2 = yield* picker.next(ctx, `Select second curve (${secondLabel}):`);
    if (!e2) return null;
    const r2 = curveRef(ctx, e2, secondLabel);
    if (!r2) return null;
    return { refs: [r1, r2] };
  };

  switch (kind) {
    case 'fixed': {
      const e = yield* picker.next(ctx, 'Select object to fix:');
      if (!e) return null;
      const r = yield* pointAnchor(ctx, e, 'Fixed point');
      return r ? { refs: [r] } : null;
    }
    case 'coincident': {
      const form = yield* keyword(ctx, 'Coincident form [Points/Object]:', ['Points', 'Object'], 'Points');
      if (!form) return null;
      if (form === 'POINTS') return yield* twoPoints('first point', 'second point');
      const e1 = yield* picker.next(ctx, 'Select object with the point:');
      if (!e1) return null;
      const r1 = yield* pointAnchor(ctx, e1, 'Point');
      if (!r1) return null;
      const e2 = yield* picker.next(ctx, 'Select object the point lies on:');
      if (!e2) return null;
      if (!isConstrainable(e2) || e2.type === 'point') {
        ctx.log(`Object: a ${e2.type} cannot be lain on (a line, circle, arc or polyline is required).`);
        return null;
      }
      return { refs: [r1, { entityId: e2.id, anchor: 'whole' }] };
    }
    case 'horizontal':
    case 'vertical': {
      const form = yield* keyword(ctx, `${kind} form [Segment/Points]:`, ['Segment', 'Points'], 'Segment');
      if (!form) return null;
      if (form === 'POINTS') return yield* twoPoints('first point', 'second point');
      const e = yield* picker.next(ctx, 'Select segment object:');
      if (!e) return null;
      const r = yield* segmentRef(ctx, e, 'Segment');
      return r ? { refs: [r] } : null;
    }
    case 'parallel':
    case 'perpendicular':
    case 'angle':
      return yield* twoSegments();
    case 'equal': {
      const form = yield* keyword(ctx, 'Equal form [Length/Radius]:', ['Length', 'Radius'], 'Length');
      if (!form) return null;
      return form === 'LENGTH' ? yield* twoSegments() : yield* twoCurves('first curve', 'second curve');
    }
    case 'concentric':
      return yield* twoCurves('first curve', 'second curve');
    case 'tangent': {
      const e1 = yield* picker.next(ctx, 'Select line or curve:');
      if (!e1) return null;
      let r1: AnchorRef | null;
      let firstIsCurve = false;
      if (e1.type === 'circle' || e1.type === 'arc') {
        r1 = curveRef(ctx, e1, 'First object');
        firstIsCurve = true;
      } else {
        r1 = yield* segmentRef(ctx, e1, 'First object');
      }
      if (!r1) return null;
      const e2 = yield* picker.next(ctx, 'Select curve (or the segment, if the first was a curve):');
      if (!e2) return null;
      if (e2.type === 'circle' || e2.type === 'arc') {
        const r2 = curveRef(ctx, e2, 'Second object');
        return r2 ? { refs: [r1, r2] } : null;
      }
      if (firstIsCurve) {
        const r2 = yield* segmentRef(ctx, e2, 'Second object');
        return r2 ? { refs: [r1, r2] } : null;
      }
      ctx.log('Tangent needs a curve on one side: two segments cannot be tangent.');
      return null;
    }
    case 'distance': {
      const form = yield* keyword(ctx, 'Distance form [Points/PointLine/Length]:', ['Points', 'PointLine', 'Length'], 'Points');
      if (!form) return null;
      if (form === 'LENGTH') {
        const e = yield* picker.next(ctx, 'Select segment object:');
        if (!e) return null;
        const r = yield* segmentRef(ctx, e, 'Segment');
        return r ? { refs: [r] } : null;
      }
      if (form === 'POINTLINE') {
        const e1 = yield* picker.next(ctx, 'Select object with the point:');
        if (!e1) return null;
        const r1 = yield* pointAnchor(ctx, e1, 'Point');
        if (!r1) return null;
        const e2 = yield* picker.next(ctx, 'Select segment object:');
        if (!e2) return null;
        const r2 = yield* segmentRef(ctx, e2, 'Segment');
        return r2 ? { refs: [r1, r2] } : null;
      }
      const built = yield* twoPoints('first point', 'second point');
      if (!built) return null;
      const mode = yield* keyword(ctx, 'Distance mode [Aligned/Horizontal/Vertical]:', ['Aligned', 'Horizontal', 'Vertical'], 'Aligned');
      if (!mode) return null;
      return mode === 'ALIGNED' ? built : { ...built, distanceMode: mode === 'HORIZONTAL' ? 'horizontal' : 'vertical' };
    }
    case 'radius':
    case 'diameter': {
      const e = yield* picker.next(ctx, 'Select circle or arc:');
      if (!e) return null;
      const r = curveRef(ctx, e, 'Curve');
      return r ? { refs: [r] } : null;
    }
  }
}

/** The value the dimensional prompt offers as its default: what the new
 *  constraint measures on the current geometry. */
function measuredDefault(entities: readonly Entity[], kind: ConstraintKind, built: BuiltRefs): number {
  const byId = new Map(entities.map((e) => [e.id, e] as const));
  const segOf = (r: AnchorRef) => segmentEndpoints(byId.get(r.entityId)!, r);
  switch (kind) {
    case 'distance': {
      if (built.refs.length === 1) {
        const [a, b] = segOf(built.refs[0]!)!;
        return Math.hypot(b.x - a.x, b.y - a.y);
      }
      const segRef = built.refs.find((r) => segOf(r) !== null);
      if (segRef) {
        const pointRef = built.refs.find((r) => r !== segRef)!;
        const p = resolveAnchorPoint(byId.get(pointRef.entityId)!, pointRef);
        const [a, b] = segOf(segRef)!;
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        return len === 0 ? Math.hypot(p.x - a.x, p.y - a.y) : Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / len;
      }
      const p = resolveAnchorPoint(byId.get(built.refs[0]!.entityId)!, built.refs[0]!);
      const q = resolveAnchorPoint(byId.get(built.refs[1]!.entityId)!, built.refs[1]!);
      if (built.distanceMode === 'horizontal') return Math.abs(q.x - p.x);
      if (built.distanceMode === 'vertical') return Math.abs(q.y - p.y);
      return Math.hypot(q.x - p.x, q.y - p.y);
    }
    case 'angle': {
      const [a1, b1] = segOf(built.refs[0]!)!;
      const [a2, b2] = segOf(built.refs[1]!)!;
      const t1 = Math.atan2(b1.y - a1.y, b1.x - a1.x);
      const t2 = Math.atan2(b2.y - a2.y, b2.x - a2.x);
      const wrapped = Math.atan2(Math.sin(t2 - t1), Math.cos(t2 - t1));
      return wrapped;
    }
    case 'radius':
    case 'diameter': {
      const e = byId.get(built.refs[0]!.entityId)!;
      const r = e.type === 'circle' || e.type === 'arc' ? e.radius : 0;
      return kind === 'radius' ? r : 2 * r;
    }
    default:
      return 0;
  }
}

const KIND_KEYWORDS = ['Coincident', 'Horizontal', 'Vertical', 'Parallel', 'Perpendicular', 'Equal', 'Concentric', 'Tangent', 'Fixed', 'Distance', 'Angle', 'Radius', 'Diameter'];
const KIND_BY_KEYWORD: Readonly<Record<string, ConstraintKind>> = {
  COINCIDENT: 'coincident',
  HORIZONTAL: 'horizontal',
  VERTICAL: 'vertical',
  PARALLEL: 'parallel',
  PERPENDICULAR: 'perpendicular',
  EQUAL: 'equal',
  CONCENTRIC: 'concentric',
  TANGENT: 'tangent',
  FIXED: 'fixed',
  DISTANCE: 'distance',
  ANGLE: 'angle',
  RADIUS: 'radius',
  DIAMETER: 'diameter',
};

export function conAddTool(): Tool {
  return scriptTool('CONADD', function* (ctx) {
    if (guard(ctx, 'CONADD')) return;
    const kw = yield* keyword(
      ctx,
      'Constraint kind [Coincident/Horizontal/Vertical/Parallel/Perpendicular/Equal/Concentric/Tangent/Fixed/Distance/Angle/Radius/Diameter]:',
      KIND_KEYWORDS,
      null,
    );
    if (!kw) return;
    const kind = KIND_BY_KEYWORD[kw];
    if (!kind) return;
    const picker = new Picker(ctx);
    const built = yield* buildRefs(ctx, picker, kind);
    if (!built) return;

    let role: 'driving' | 'reference' = 'driving';
    let value: number | undefined;
    if (DIMENSIONAL_KINDS.has(kind)) {
      const rk = yield* keyword(ctx, 'Constraint role [Driving/Reference]:', ['Driving', 'Reference'], 'Driving');
      if (!rk) return;
      role = rk === 'REFERENCE' ? 'reference' : 'driving';
      if (role === 'driving') {
        const def = measuredDefault(ctx.doc.snapshot.entities, kind, built);
        const ans = yield* number(ctx, `Enter driving value for ${kind}${kind === 'angle' ? ' (radians)' : ''} ${dflt(def, ctx)}:`, def, {
          from: null,
          allowZero: true,
          allowNegative: true,
        });
        if (!ans || !('value' in ans)) return;
        value = ans.value;
      }
    }

    const existing = new Set((ctx.doc.snapshot.constraints?.constraints ?? []).map((c) => c.id));
    let id = `c-${newId()}`;
    while (existing.has(id)) id = `c-${newId()}`;
    const constraint: Constraint = {
      id,
      kind,
      role,
      refs: built.refs,
      ...(value !== undefined ? { value } : {}),
      ...(built.distanceMode ? { distanceMode: built.distanceMode } : {}),
    };
    // The pure adapter solves FIRST (design §6); only a success is
    // installed, through exactly one transact.
    const r = addConstraint(ctx.doc.snapshot, constraint);
    if (!r.ok) {
      logRefusal(ctx, 'CONADD', r);
      return;
    }
    ctx.doc.transact(() => r.state);
    if (picker.picked.length > 0) ctx.selection = new Set(picker.picked);
    ctx.log(`Constraint '${id}' (${kind}${role === 'reference' ? ', reference' : ''}) added on ${refsText(constraint)}. Solve: ${r.status}.`);
  });
}

// ---------------------------------------------------------------------------
// CONEDIT / CONDELETE — pick a constraint by id from the logged list
// ---------------------------------------------------------------------------

function listConstraints(ctx: ToolContext, cmd: string): readonly Constraint[] {
  const all = ctx.doc.snapshot.constraints?.constraints ?? [];
  if (all.length === 0) {
    ctx.log(`${cmd}: this drawing has no constraints.`);
    return all;
  }
  for (const c of all) {
    const bits = [
      c.role === 'reference' ? 'reference' : c.value !== undefined ? `= ${c.value}` : '',
      c.suppressed ? 'suppressed' : '',
    ].filter(Boolean);
    ctx.log(`  ${c.id} (${c.kind}) ${refsText(c)}${bits.length > 0 ? ` — ${bits.join(', ')}` : ''}`);
  }
  return all;
}

function* pickConstraintId(ctx: ToolContext, all: readonly Constraint[], promptText: string, dfltId: string): Step<Constraint | null> {
  const t = yield* text(promptText, dfltId, true);
  if (t === null) return null;
  const target = all.find((c) => c.id === t.trim());
  if (!target) {
    ctx.log(`No constraint '${t.trim()}'.`);
    return null;
  }
  return target;
}

export function conEditTool(): Tool {
  return scriptTool('CONEDIT', function* (ctx) {
    if (guard(ctx, 'CONEDIT')) return;
    const all = listConstraints(ctx, 'CONEDIT');
    if (all.length === 0) return;
    const editable = all.filter((c) => DIMENSIONAL_KINDS.has(c.kind) && c.role === 'driving' && !c.suppressed);
    if (editable.length === 0) {
      ctx.log('CONEDIT: no driving dimensional constraint to edit — geometric and reference constraints carry no editable value.');
      return;
    }
    const target = yield* pickConstraintId(ctx, all, 'Enter constraint id to edit:', editable[0]!.id);
    if (!target) return;
    if (!DIMENSIONAL_KINDS.has(target.kind) || target.role !== 'driving') {
      ctx.log(
        `CONEDIT refused: constraint '${target.id}' (${target.kind}${target.role === 'reference' ? ', reference' : ''}) has no driving value to edit.`,
      );
      return;
    }
    if (target.suppressed) {
      ctx.log(`CONEDIT refused: constraint '${target.id}' is suppressed; unsuppress it before editing its value.`);
      return;
    }
    const ans = yield* number(
      ctx,
      `Enter new value for ${target.id} (${target.kind})${target.kind === 'angle' ? ' (radians)' : ''} ${dflt(target.value!, ctx)}:`,
      target.value!,
      { from: null, allowZero: true, allowNegative: true },
    );
    if (!ans || !('value' in ans)) return;
    const r = withConstraintValue(ctx.doc.snapshot, target.id, ans.value);
    if (!r.ok) {
      logRefusal(ctx, 'CONEDIT', r);
      return;
    }
    ctx.doc.transact(() => r.state);
    ctx.log(`Constraint '${target.id}' set to ${ans.value}. Solve: ${r.status}.`);
  });
}

export function conDeleteTool(): Tool {
  return scriptTool('CONDELETE', function* (ctx) {
    if (guard(ctx, 'CONDELETE')) return;
    const all = listConstraints(ctx, 'CONDELETE');
    if (all.length === 0) return;
    const target = yield* pickConstraintId(ctx, all, 'Enter constraint id to delete:', all[0]!.id);
    if (!target) return;
    const r = removeConstraint(ctx.doc.snapshot, target.id);
    if (!r.ok) {
      logRefusal(ctx, 'CONDELETE', r);
      return;
    }
    ctx.doc.transact(() => r.state);
    ctx.log(
      r.state.constraints === undefined
        ? `Constraint '${target.id}' deleted; the constraint set is now empty. Solve: ${r.status}.`
        : `Constraint '${target.id}' deleted. Solve: ${r.status}.`,
    );
  });
}

// ---------------------------------------------------------------------------
// CONSOLVE / CONSTATUS — prompt-free commands, so they are plain Tools
// (the modify.ts class pattern), not generator scripts.
// ---------------------------------------------------------------------------

function immediateTool(name: string, run: (ctx: ToolContext) => void): Tool {
  return {
    name,
    start(ctx) {
      run(ctx);
      ctx.finish();
    },
    onPoint() {},
    onMove() {},
    onText() {},
    onEnter(ctx) {
      ctx.finish();
    },
    onCancel(ctx) {
      ctx.finish();
    },
  };
}

export function conSolveTool(): Tool {
  return immediateTool('CONSOLVE', (ctx) => {
    if (guard(ctx, 'CONSOLVE')) return;
    const r = solveAndApply(ctx.doc.snapshot);
    if (!r.ok) {
      if (r.code === 'no-constraints') {
        ctx.log('CONSOLVE: this drawing has no constraints.');
        return;
      }
      ctx.log(`CONSOLVE failed (${r.status ?? 'refused'} / ${r.code ?? 'failed'}): ${r.message ?? 'the constraint set does not solve.'}`);
      const ids = r.solve?.failure?.constraintIds ?? [];
      if (ids.length > 0) ctx.log(`  Involved constraint(s): ${ids.join(', ')}`);
      if (r.problems) for (const p of r.problems) ctx.log(`  ${p.code}: ${p.message}`);
      return;
    }
    ctx.doc.transact(() => r.state);
    const dof = r.solve!.dof;
    ctx.log(
      `CONSOLVE: ${r.status} — DOF remaining ${dof.remaining === -1 ? 'unknown (rank work skipped)' : dof.remaining} of ${dof.total}.`,
    );
  });
}

function stateText(c: Constraint, d: ConstraintDiagnostic | undefined): string {
  if (c.suppressed) return 'suppressed';
  if (!d) return 'not analyzed';
  const unit = c.kind === 'angle' ? ' rad' : '';
  let text: string;
  switch (d.state) {
    case 'reference':
      text = `reference — measured ${fmt4(d.measured)}${unit}`;
      break;
    case 'suppressed':
      text = 'suppressed';
      break;
    case 'redundant':
      text = 'redundant (satisfied, consumes no additional DOF)';
      break;
    case 'satisfied':
      text =
        c.role === 'driving' && c.value !== undefined
          ? `satisfied (target ${c.value}, measured ${fmt4(d.measured)}${unit})`
          : 'satisfied';
      break;
    case 'violated':
      text =
        c.role === 'driving' && c.value !== undefined
          ? `VIOLATED (target ${c.value}, measured ${fmt4(d.measured)}${unit})`
          : `VIOLATED (normalized residual ${d.residual})`;
      break;
    default:
      // Analysis (no solve) reports an unsatisfied driving constraint as
      // 'unresolved' — 'violated' is the solver's post-solve verdict —
      // but the measured-vs-target readout is still the useful surface.
      text =
        c.role === 'driving' && c.value !== undefined
          ? `not satisfied (target ${c.value}, measured ${fmt4(d.measured)}${unit})`
          : 'unresolved at current geometry';
      break;
  }
  return d.branch ? `${text} [tangent branch: ${d.branch}]` : text;
}

export function conStatusTool(): Tool {
  return immediateTool('CONSTATUS', (ctx) => {
    if (ctx.doc.space) {
      ctx.log('CONSTATUS refused: constraints live on model-space entities and the active space is a layout. Switch to the Model tab.');
      return;
    }
    const state = ctx.doc.snapshot;
    if (state.constraintsRetained !== undefined) {
      ctx.log('CONSTATUS: this drawing carries constraint data this build cannot model (retained verbatim); no status is available.');
      return;
    }
    const set = state.constraints;
    if (!set || set.constraints.length === 0) {
      ctx.log('CONSTATUS: no constraints in this drawing.');
      return;
    }
    const a = analyzeConstraints(state.entities, set);
    if (a.problems.length > 0) {
      ctx.log(`CONSTATUS: the constraint set has ${a.problems.length} problem(s) — solving and constraint edits are refused until it is repaired:`);
      for (const p of a.problems) ctx.log(`  ${p.code}: ${p.message}`);
    }
    const diagById = new Map(a.diagnostics.map((d) => [d.constraintId, d] as const));
    for (const c of set.constraints) ctx.log(`  ${c.id} (${c.kind}) ${refsText(c)} — ${stateText(c, diagById.get(c.id))}`);
    if (a.problems.length > 0) return;
    const dof = a.dof;
    const rankPartial = dof.perEntity.some((p) => p.remaining === -1);
    ctx.log(
      `CONSTATUS: ${a.status} — DOF total ${dof.total}, consumed ${dof.effectiveConsumed}, remaining ${
        rankPartial ? 'unknown (rank work skipped for part of the set)' : dof.remaining
      }.`,
    );
  });
}
