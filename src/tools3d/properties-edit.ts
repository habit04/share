/**
 * Editable parameter rows of experimental 3D solids (milestone 4 of docs/3D-PLAN.md): the
 * Properties palette (src/ui/properties.ts) lists `parameterRows(solid.feature)` as inputs and
 * applies an edit with `solidParameterTool`, which re-evaluates the changed feature and replaces
 * the solid under the SAME id as one undoable step.
 *
 * - Primitives (box / wedge width, depth, height; cylinder radius, height, segments; cone base
 *   and top radius, height, segments; sphere radius, segments; torus radius, tube radius,
 *   segments), extrusions (height) and revolutions (angle in degrees, segments) re-evaluate
 *   in-process at once.
 * - A Boolean solid lists the parameters of its primitive and sweep operands ("Operand 1.2 ...",
 *   the path through the operand tree); changing one re-runs the Boolean history through the
 *   kernel asynchronously, with the Boolean commands' guard: the prompt reads "Computing the
 *   solid… (Esc abandons it)", other input is refused, Esc or another command abandons it, and
 *   nothing is applied when the solid changed meanwhile.
 * - Invalid values (non-numbers, zero / negative sizes, a tube radius not below the torus radius,
 *   segment counts that are not whole numbers in range, angles outside (0, 360]) are refused with
 *   a message and the solid stays unchanged. `mesh` features have no parameters.
 */
import { GeometryBudgetError } from '../core/geometry-budget-error';
import { parseDistance } from '../core/units';
import { FeatureEvalError, evaluateFeature } from '../model3d/feature-eval';
import { KernelError } from '../model3d/kernel/kernel';
import type { Mesh3D } from '../model3d/mesh';
import { model3dOf, replaceSolid, solidById } from '../model3d/model';
import { MAX_SEGMENTS, MIN_SEGMENTS, primitiveMesh } from '../model3d/primitives';
import { extrudeMesh, revolveMesh } from '../model3d/sweep';
import type { Feature3D, Model3D, Solid3D } from '../model3d/types';
import type { Drawing } from '../core/document';
import type { Tool, ToolContext } from '../tools/types';
import { solidsOf } from './context';
import { featureLabel } from './properties';
import { type Script3DTool, type Step3, compute, errorText, script3d } from './script3d';

/** What a parameter holds: a length, a whole tessellation count, or an angle in degrees. */
export type ParameterKind = 'length' | 'count' | 'angle';

/** One editable parameter row. */
export interface ParameterRow {
  readonly label: string;
  /** Operand path (indices into Boolean operands) plus the field name, e.g. "0.1/radius". */
  readonly key: string;
  readonly value: number;
  readonly kind: ParameterKind;
}

/** Most rows listed for one solid (a deep Boolean tree lists its first operands only). */
export const MAX_PARAMETER_ROWS = 32;

interface FieldSpec {
  readonly field: string;
  readonly label: string;
  readonly kind: ParameterKind;
}

const DEFAULT_SEGMENT_COUNT = 32;

function fieldsOf(f: Feature3D): FieldSpec[] {
  switch (f.kind) {
    case 'box': case 'wedge':
      return [{ field: 'width', label: 'Width', kind: 'length' }, { field: 'depth', label: 'Depth', kind: 'length' }, { field: 'height', label: 'Height', kind: 'length' }];
    case 'cylinder':
      return [{ field: 'radius', label: 'Radius', kind: 'length' }, { field: 'height', label: 'Height', kind: 'length' }, { field: 'segments', label: 'Segments', kind: 'count' }];
    case 'cone':
      return [{ field: 'baseRadius', label: 'Base radius', kind: 'length' }, { field: 'topRadius', label: 'Top radius', kind: 'length' }, { field: 'height', label: 'Height', kind: 'length' }, { field: 'segments', label: 'Segments', kind: 'count' }];
    case 'sphere':
      return [{ field: 'radius', label: 'Radius', kind: 'length' }, { field: 'segments', label: 'Segments', kind: 'count' }];
    case 'torus':
      return [{ field: 'majorRadius', label: 'Radius', kind: 'length' }, { field: 'minorRadius', label: 'Tube radius', kind: 'length' }, { field: 'segments', label: 'Segments', kind: 'count' }];
    case 'extrude':
      return [{ field: 'distance', label: 'Height', kind: 'length' }];
    case 'revolve':
      return [{ field: 'angle', label: 'Angle', kind: 'angle' }, { field: 'segments', label: 'Segments', kind: 'count' }];
    default:
      return [];
  }
}

/** The value of the parameter `field` of a feature (undefined when unset or not a parameter). */
function getField(f: Feature3D, field: string): number | undefined {
  switch (f.kind) {
    case 'box': case 'wedge':
      return field === 'width' ? f.width : field === 'depth' ? f.depth : field === 'height' ? f.height : undefined;
    case 'cylinder':
      return field === 'radius' ? f.radius : field === 'height' ? f.height : field === 'segments' ? f.segments : undefined;
    case 'cone':
      return field === 'baseRadius' ? f.baseRadius : field === 'topRadius' ? f.topRadius : field === 'height' ? f.height : field === 'segments' ? f.segments : undefined;
    case 'sphere':
      return field === 'radius' ? f.radius : field === 'segments' ? f.segments : undefined;
    case 'torus':
      return field === 'majorRadius' ? f.majorRadius : field === 'minorRadius' ? f.minorRadius : field === 'segments' ? f.segments : undefined;
    case 'extrude':
      return field === 'distance' ? f.distance : undefined;
    case 'revolve':
      return field === 'angle' ? f.angle : field === 'segments' ? f.segments : undefined;
    default:
      return undefined;
  }
}

/** The feature with the parameter `field` set to `v` (radians for angles), or null when it has none. */
function setField(f: Feature3D, field: string, v: number): Feature3D | null {
  switch (f.kind) {
    case 'box': case 'wedge':
      return field === 'width' ? { ...f, width: v } : field === 'depth' ? { ...f, depth: v } : field === 'height' ? { ...f, height: v } : null;
    case 'cylinder':
      return field === 'radius' ? { ...f, radius: v } : field === 'height' ? { ...f, height: v } : field === 'segments' ? { ...f, segments: v } : null;
    case 'cone':
      return field === 'baseRadius' ? { ...f, baseRadius: v } : field === 'topRadius' ? { ...f, topRadius: v } : field === 'height' ? { ...f, height: v } : field === 'segments' ? { ...f, segments: v } : null;
    case 'sphere':
      return field === 'radius' ? { ...f, radius: v } : field === 'segments' ? { ...f, segments: v } : null;
    case 'torus':
      return field === 'majorRadius' ? { ...f, majorRadius: v } : field === 'minorRadius' ? { ...f, minorRadius: v } : field === 'segments' ? { ...f, segments: v } : null;
    case 'extrude':
      return field === 'distance' ? { ...f, distance: v } : null;
    case 'revolve':
      return field === 'angle' ? { ...f, angle: v } : field === 'segments' ? { ...f, segments: v } : null;
    default:
      return null;
  }
}

function fieldValue(f: Feature3D, spec: FieldSpec): number {
  const v = getField(f, spec.field);
  if (spec.kind === 'count') return v !== undefined && Number.isFinite(v) ? v : DEFAULT_SEGMENT_COUNT;
  if (spec.kind === 'angle') return ((v ?? 0) * 180) / Math.PI;
  return v ?? 0;
}

/** Check a count or angle value (lengths are checked per feature in `withParameter`); throws RangeError. */
function checkKind(kind: ParameterKind, v: number, label: string): void {
  if (kind === 'count') {
    if (!Number.isInteger(v) || v < MIN_SEGMENTS || v > MAX_SEGMENTS) throw new RangeError(`${label} must be a whole number from ${MIN_SEGMENTS} to ${MAX_SEGMENTS} (got ${v}).`);
  } else if (kind === 'angle') {
    if (!Number.isFinite(v) || v === 0 || Math.abs(v) > 360) throw new RangeError(`${label} must be non-zero and at most 360 degrees (got ${v}).`);
  }
}

/** The editable parameters of a feature (Boolean operands depth-first, at most MAX_PARAMETER_ROWS). */
export function parameterRows(feature: Feature3D): ParameterRow[] {
  const rows: ParameterRow[] = [];
  const walk = (f: Feature3D, path: number[], depth: number) => {
    if (rows.length >= MAX_PARAMETER_ROWS || depth > 32 || !f) return;
    if (f.kind === 'boolean') {
      if (!Array.isArray(f.operands)) return;
      f.operands.forEach((o, i) => walk(o, [...path, i], depth + 1));
      return;
    }
    const prefix = path.length ? `Operand ${path.map((i) => i + 1).join('.')} (${featureLabel(f)}) ` : '';
    for (const spec of fieldsOf(f)) {
      if (rows.length >= MAX_PARAMETER_ROWS) return;
      rows.push({ label: prefix ? `${prefix}${spec.label.toLowerCase()}` : spec.label, key: `${path.join('.')}/${spec.field}`, value: fieldValue(f, spec), kind: spec.kind });
    }
  };
  walk(feature, [], 1);
  return rows;
}

/** The value as the palette shows it (lengths and angles four decimals, counts whole). */
export function parameterText(row: ParameterRow): string {
  return row.kind === 'count' ? String(Math.round(row.value)) : row.value.toFixed(4);
}

/** Parse and check a typed value for `kind`; throws RangeError with the reason. */
export function parseParameter(kind: ParameterKind, text: string, label: string): number {
  const v = parseDistance(text.trim());
  if (v === null || !Number.isFinite(v)) throw new RangeError(`${label} must be a number (got "${text.trim()}").`);
  checkKind(kind, v, label);
  return v;
}

/**
 * The feature with the parameter at `key` set to `value` (degrees for angles), checked: throws
 * RangeError for a value the feature cannot take or a key that does not exist.
 */
export function withParameter(feature: Feature3D, key: string, value: number): Feature3D {
  const slash = key.lastIndexOf('/');
  const path = key.slice(0, slash).split('.').filter((s) => s !== '').map(Number);
  const field = key.slice(slash + 1);
  const set = (f: Feature3D, i: number): Feature3D => {
    const idx = path[i];
    if (idx !== undefined) {
      if (f.kind !== 'boolean' || !Array.isArray(f.operands) || !(idx >= 0 && idx < f.operands.length)) throw new RangeError(`Unknown parameter ${key}.`);
      const operands = f.operands.map((o, k) => (k === idx ? set(o, i + 1) : o));
      return { ...f, operands };
    }
    const spec = fieldsOf(f).find((s) => s.field === field);
    if (!spec) throw new RangeError(`Unknown parameter ${key}.`);
    const label = spec.label;
    checkKind(spec.kind, value, label);
    if (spec.kind === 'length') {
      const allowZero = f.kind === 'cone';
      const allowNegative = f.kind === 'extrude';
      if (!Number.isFinite(value) || (value < 0 && !allowNegative) || (value === 0 && !allowZero)) {
        throw new RangeError(`${label} must be ${allowNegative ? 'non-zero' : allowZero ? 'zero or positive' : 'positive'} and finite (got ${value}).`);
      }
    }
    const next = setField(f, field, spec.kind === 'angle' ? (value * Math.PI) / 180 : value);
    if (!next) throw new RangeError(`Unknown parameter ${key}.`);
    if (next.kind === 'cone' && !(next.baseRadius > 0 || next.topRadius > 0)) throw new RangeError('A cone needs a base radius or a top radius above zero.');
    if (next.kind === 'torus' && !(next.minorRadius < next.majorRadius)) throw new RangeError(`The tube radius must be smaller than the torus radius (${next.majorRadius}); self-intersecting tori are not supported.`);
    return next;
  };
  return set(feature, 0);
}

/** True when evaluating the feature needs the kernel (a Boolean anywhere). */
export function needsKernel(f: Feature3D): boolean {
  return f.kind === 'boolean';
}

/** In-process evaluation of a feature without Booleans (primitives and sweeps). */
export function evaluateLocal(f: Feature3D): Mesh3D {
  switch (f.kind) {
    case 'box': case 'cylinder': case 'sphere': case 'cone': case 'torus': case 'wedge':
      return primitiveMesh(f);
    case 'extrude':
      return extrudeMesh(f.profile, f.distance);
    case 'revolve':
      return revolveMesh(f.profile, f.axis, f.angle, f.segments);
    default:
      throw new FeatureEvalError('This solid needs the geometry kernel to re-evaluate.');
  }
}

function isUserError(err: unknown): err is Error {
  return err instanceof RangeError || err instanceof GeometryBudgetError || err instanceof FeatureEvalError || err instanceof KernelError;
}

const NAME = 'PROPERTIES';

/** A checked parameter edit, ready to evaluate. */
interface PreparedEdit {
  readonly solid: Solid3D;
  readonly row: ParameterRow;
  readonly value: number;
  readonly feature: Feature3D;
}

/** Check an edit against the current model; a string is the refusal message (already prefixed). */
function prepareEdit(model: Model3D, solidId: string, key: string, text: string): PreparedEdit | string {
  const solid = solidById(model, solidId);
  if (!solid) return `${NAME}: the solid ${solidId} no longer exists.`;
  const row = parameterRows(solid.feature).find((r) => r.key === key);
  if (!row) return `${NAME}: this solid has no parameter ${key}.`;
  try {
    const value = parseParameter(row.kind, text, row.label);
    return { solid, row, value, feature: withParameter(solid.feature, key, value) };
  } catch (err) {
    if (!isUserError(err)) throw err;
    return `${NAME}: ${err.message} The solid is unchanged.`;
  }
}

/** Replace the solid with its re-evaluated mesh and feature (one undo step); false when refused. */
function applyEdit(doc: Drawing, log: (text: string) => void, edit: PreparedEdit, mesh: Mesh3D): boolean {
  const next: Solid3D = { ...edit.solid, mesh, feature: edit.feature };
  try {
    doc.updateModel3D((m) => replaceSolid(m, next));
  } catch (err) {
    if (!isUserError(err)) throw err;
    log(`${NAME}: ${err.message} The solid is unchanged.`);
    return false;
  }
  log(`${NAME}: ${edit.row.label} = ${parameterText({ ...edit.row, value: edit.value })}.`);
  return true;
}

function* parameterScript(ctx: ToolContext, solidId: string, key: string, text: string): Step3<void> {
  const edit = prepareEdit(solidsOf(ctx), solidId, key, text);
  if (typeof edit === 'string') {
    ctx.log(edit);
    return;
  }
  let mesh: Mesh3D;
  if (needsKernel(edit.feature)) {
    const kernel = ctx.kernel;
    if (!kernel) {
      ctx.log(`${NAME}: re-evaluating a Boolean needs the geometry kernel, which is unavailable here. The solid is unchanged.`);
      return;
    }
    let promise: Promise<Mesh3D>;
    try {
      promise = evaluateFeature(edit.feature, kernel);
    } catch (err) {
      promise = Promise.reject(err);
    }
    const r = yield* compute('Computing the solid… (Esc abandons it)', promise);
    if (!r.ok) {
      ctx.log(`${NAME}: ${errorText(r.error)}`);
      ctx.log(`${NAME}: the solid is unchanged.`);
      return;
    }
    if (solidById(solidsOf(ctx), solidId) !== edit.solid) {
      ctx.log(`${NAME}: the solid changed while it was computed; nothing was applied.`);
      return;
    }
    mesh = r.value;
  } else {
    try {
      mesh = evaluateLocal(edit.feature);
    } catch (err) {
      if (!isUserError(err)) throw err;
      ctx.log(`${NAME}: ${err.message} The solid is unchanged.`);
      return;
    }
  }
  applyEdit(ctx.doc, (t) => ctx.log(t), edit, mesh);
}

/**
 * The Boolean path of a parameter edit as a command: re-evaluates the feature through the kernel
 * behind "Computing…" and replaces the solid under the same id (see the module comment).
 * Primitives and sweeps work too (synchronously), which `setSolidParameter` does without a tool.
 */
export const solidParameterTool = (solidId: string, key: string, text: string): Script3DTool => script3d('PROPERTIES', (ctx) => parameterScript(ctx, solidId, key, text));

/** What `setSolidParameter` needs from the editor. */
export interface ParameterHost {
  readonly doc: Drawing;
  /** The running command, if any. */
  readonly tool: Tool | null;
  log(text: string): void;
  startTool(tool: Tool): void | Promise<void>;
}

/** How a parameter edit ended: applied now, refused (message logged), or computing (a Boolean). */
export type ParameterOutcome = 'applied' | 'refused' | 'computing';

/**
 * The Properties palette's edit. Primitives and sweeps are re-evaluated and replaced at once
 * through `Drawing.updateModel3D`, like the Name and Layer rows, so a running command is not
 * interrupted. A Boolean solid re-runs through the kernel as the PROPERTIES command
 * (`solidParameterTool`); while another command runs that is refused with a message instead of
 * cancelling it.
 */
export function setSolidParameter(host: ParameterHost, solidId: string, key: string, text: string): ParameterOutcome {
  const log = (t: string) => host.log(t);
  const edit = prepareEdit(model3dOf(host.doc.snapshot), solidId, key, text);
  if (typeof edit === 'string') {
    log(edit);
    return 'refused';
  }
  if (needsKernel(edit.feature)) {
    if (host.tool) {
      log(`${NAME}: a Boolean solid is re-evaluated as a command; finish or cancel the running command (Esc) first. The solid is unchanged.`);
      return 'refused';
    }
    void host.startTool(solidParameterTool(solidId, key, text));
    return 'computing';
  }
  let mesh: Mesh3D;
  try {
    mesh = evaluateLocal(edit.feature);
  } catch (err) {
    if (!isUserError(err)) throw err;
    log(`${NAME}: ${err.message} The solid is unchanged.`);
    return 'refused';
  }
  return applyEdit(host.doc, log, edit, mesh) ? 'applied' : 'refused';
}
