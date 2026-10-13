/**
 * Solid Booleans (experimental, milestone 3): UNION, SUBTRACT, INTERSECT.
 *
 * The geometry kernel (`ctx.kernel`, Manifold in a worker in the app, created on first use) runs
 * asynchronously: the command line shows "Computing the union…", the command refuses other input
 * until the result arrives (Esc abandons it). Kernel errors (`KernelError`: invalid or open
 * operands, empty results, timeouts, an unavailable kernel) are logged verbatim and the drawing is
 * left unchanged. On success the result replaces the operands in ONE undoable step: it keeps the
 * first operand's id, layer, colour and name, and its feature is the Boolean of the operand
 * features, folded left to right (`{ op, operands: [((a op b) op c), d] }`), so Undo restores every
 * operand. If the operands changed while the kernel was busy, nothing is applied.
 *
 * SUBTRACT follows AutoCAD: the solids to subtract from are united first, then each solid of the
 * second set is subtracted in turn.
 */
import type { Mesh3D } from '../model3d/mesh';
import { meshVolume } from '../model3d/mesh';
import { newSolid, removeSolids, replaceSolid, solidById } from '../model3d/model';
import type { BooleanFeature, Feature3D, Solid3D } from '../model3d/types';
import type { BooleanOp } from '../model3d/kernel/kernel';
import { select } from '../tools/script';
import type { ToolContext } from '../tools/types';
import { solidsOf } from './context';
import { modelSpaceOnly } from './primitives';
import { type Script3DTool, type Step3, clearingSelection, compute, errorText, script3d } from './script3d';

/** One step of a fold: combine the running result with `solid` by `op`. */
export interface BooleanStep {
  readonly op: BooleanOp;
  readonly solid: Solid3D;
}

const NOUN: Readonly<Record<BooleanOp, string>> = { union: 'union', subtract: 'subtraction', intersect: 'intersection' };

/** Feature of the folded Boolean: ((first op1 s1) op2 s2) ... */
export function foldFeature(first: Feature3D, steps: readonly BooleanStep[]): Feature3D {
  let f = first;
  for (const s of steps) f = { kind: 'boolean', op: s.op, operands: [f, s.solid.feature] } satisfies BooleanFeature;
  return f;
}

/** The solids among `ids` (selection order, no duplicates) and how many ids were not solids. */
export function solidsAmong(ctx: ToolContext, ids: readonly string[]): { solids: Solid3D[]; others: number } {
  const model = solidsOf(ctx);
  const solids: Solid3D[] = [];
  const seen = new Set<string>();
  let others = 0;
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const s = solidById(model, id);
    if (s) solids.push(s);
    else others++;
  }
  return { solids, others };
}

function reportOthers(ctx: ToolContext, others: number): void {
  if (others) ctx.log(others === 1 ? '1 object is not a 3D solid and was ignored.' : `${others} objects are not 3D solids and were ignored.`);
}

/**
 * Run the fold on the kernel and apply the result (see the module comment). `NAME` prefixes
 * messages; `op` names the command's own operation for the prompt.
 */
function* runBoolean(ctx: ToolContext, NAME: string, op: BooleanOp, first: Solid3D, steps: readonly BooleanStep[]): Step3<void> {
  const kernel = ctx.kernel;
  if (!kernel) {
    ctx.log(`${NAME}: Solid Boolean operations are unavailable here: no geometry kernel. The drawing is unchanged.`);
    return;
  }
  const operands = [first, ...steps.map((s) => s.solid)];
  const run = async (): Promise<Mesh3D> => {
    let acc = first.mesh;
    for (const s of steps) acc = await kernel.boolean(s.op, acc, s.solid.mesh);
    return acc;
  };
  // An async function never throws synchronously: every failure arrives as a rejection.
  const r = yield* compute(`Computing the ${NOUN[op]}… (Esc abandons it)`, run());
  if (!r.ok) {
    ctx.log(`${NAME}: ${errorText(r.error)}`);
    ctx.log(`${NAME}: the drawing is unchanged.`);
    return;
  }
  const model = solidsOf(ctx);
  if (operands.some((s) => solidById(model, s.id) !== s)) {
    ctx.log(`${NAME}: the solids changed while the ${NOUN[op]} was computed; nothing was applied.`);
    return;
  }
  const result = newSolid({ id: first.id, mesh: r.value, feature: foldFeature(first.feature, steps), layer: first.layer, color: first.color, name: first.name });
  ctx.doc.updateModel3D((m) => removeSolids(replaceSolid(m, result), operands.slice(1).map((s) => s.id)));
  ctx.log(`${NAME}: ${operands.length} solids combined into one (volume ${meshVolume(r.value).toFixed(4)}).`);
}

function* unionOrIntersect(ctx: ToolContext, op: 'union' | 'intersect'): Step3<void> {
  const NAME = op.toUpperCase();
  if (!modelSpaceOnly(ctx, NAME)) return;
  const ids = yield* select(ctx, 'Select objects:');
  if (ids.length === 0) return;
  const { solids, others } = solidsAmong(ctx, ids);
  reportOthers(ctx, others);
  if (solids.length < 2) {
    ctx.log(`${NAME}: select at least two solids (${solids.length} selected).`);
    return;
  }
  yield* runBoolean(ctx, NAME, op, solids[0]!, solids.slice(1).map((solid) => ({ op, solid })));
}

function* subtractScript(ctx: ToolContext): Step3<void> {
  const NAME = 'SUBTRACT';
  if (!modelSpaceOnly(ctx, NAME)) return;
  ctx.log('Select solids to subtract from ..');
  const keepIds = yield* select(ctx, 'Select objects:');
  const keep = solidsAmong(ctx, keepIds);
  reportOthers(ctx, keep.others);
  if (keep.solids.length === 0) {
    ctx.log(`${NAME}: no solids to subtract from.`);
    return;
  }
  ctx.log('Select solids to subtract ..');
  const subIds = yield* select(ctx, 'Select objects:', false);
  const sub = solidsAmong(ctx, subIds);
  reportOthers(ctx, sub.others);
  const kept = new Set(keep.solids.map((s) => s.id));
  const cut = sub.solids.filter((s) => !kept.has(s.id));
  if (cut.length < sub.solids.length) ctx.log(`${sub.solids.length - cut.length} solid(s) in both sets were left out of the second set.`);
  if (cut.length === 0) {
    ctx.log(`${NAME}: no solids to subtract.`);
    return;
  }
  const steps: BooleanStep[] = [...keep.solids.slice(1).map((solid) => ({ op: 'union' as const, solid })), ...cut.map((solid) => ({ op: 'subtract' as const, solid }))];
  yield* runBoolean(ctx, NAME, 'subtract', keep.solids[0]!, steps);
}

/** UNION: select two or more solids; they become one. */
export const unionTool = (): Script3DTool => script3d('UNION', (ctx) => clearingSelection(ctx, unionOrIntersect(ctx, 'union')));
/** INTERSECT: select two or more solids; their common volume remains. */
export const intersectTool = (): Script3DTool => script3d('INTERSECT', (ctx) => clearingSelection(ctx, unionOrIntersect(ctx, 'intersect')));
/** SUBTRACT: select solids to subtract from, Enter, then the solids to subtract, Enter. */
export const subtractTool = (): Script3DTool => script3d('SUBTRACT', (ctx) => clearingSelection(ctx, subtractScript(ctx)));
