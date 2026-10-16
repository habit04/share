/**
 * Priority 30.1 — DYNSET: set a dynamic-block parameter value on a selected
 * block reference. A thin command adapter over the pure
 * core/parametric/apply.ts transition: validation and refusal happen there,
 * before any transact, so a refused edit leaves no undo entry, no dirty flag
 * and no revision change; an accepted edit commits through exactly ONE
 * doc.transact (one undo step).
 */
import type { InsertEntity } from '../core/entities';
import type { LinearDistanceParameter } from '../core/parametric/definitions';
import { setDynamicParameter } from '../core/parametric/apply';
import { validateInstanceValues } from '../core/parametric/instance';
import type { Tool } from './types';
import { scriptTool, text, number, select, dflt } from './script';

export function dynSetTool(): Tool {
  return scriptTool('DYNSET', function* (ctx) {
    // Target: a selected insert (pick-first), else prompt for a selection.
    let target: InsertEntity | undefined;
    const fromSelection = (): InsertEntity | undefined =>
      ctx.doc.entities.find(
        (e): e is InsertEntity => e.type === 'insert' && ctx.selection.has(e.id),
      );
    target = fromSelection();
    if (!target) {
      const ids = yield* select(ctx, 'Select a dynamic block reference:');
      if (ids.length === 0) return;
      ctx.selection = new Set(ids);
      target = fromSelection();
    }
    if (!target) {
      ctx.log('DYNSET requires a block reference.');
      return;
    }
    const ins = target;
    const block = ctx.doc.blocks[ins.block];
    if (!block) {
      ctx.log(`Block "${ins.block}" is not defined.`);
      return;
    }
    if (block.dynamicRetained !== undefined || !block.dynamic) {
      ctx.log(
        block.dynamicRetained !== undefined
          ? `Block "${ins.block}" has a dynamic definition this build cannot model; it is retained as data and its parameters cannot be edited.`
          : `Block "${ins.block}" is not a dynamic block.`,
      );
      return;
    }
    const definition = block.dynamic;
    const modeled = definition.parameters.filter(
      (p): p is LinearDistanceParameter => p.kind === 'linear-distance',
    );
    if (modeled.length === 0) {
      ctx.log(`Block "${ins.block}" has no editable (distance) parameters.`);
      return;
    }
    const validation = validateInstanceValues(definition, ins.dynamic, ins.block);
    const currentOf = (p: LinearDistanceParameter): number => {
      const v = validation.ok ? validation.effective[p.id] : undefined;
      return v?.kind === 'distance' ? v.value : p.defaultValue;
    };

    // Parameter: the only one, or a prompt matched by id or display name.
    let param: LinearDistanceParameter | undefined = modeled[0];
    if (modeled.length > 1) {
      for (const p of modeled) ctx.log(`${p.id} (${p.name}) = ${currentOf(p)}`);
      const t = yield* text('Enter parameter name:', modeled[0]!.id, true);
      if (t === null) return;
      const wanted = t.trim().toLowerCase();
      param = modeled.find((p) => p.id.toLowerCase() === wanted || p.name.toLowerCase() === wanted);
      if (!param) {
        ctx.log(`No parameter "${t.trim()}" on block "${ins.block}".`);
        return;
      }
    }
    const chosen = param!;
    const current = currentOf(chosen);
    // The raw value goes to apply.ts untouched — it, not the prompt, is the
    // authority on range/list/increment refusal — so zero/negative input must
    // reach it instead of being filtered out here.
    const answer = yield* number(ctx, `Enter new value for ${chosen.name} ${dflt(current, ctx)}:`, current, {
      from: null,
      allowZero: true,
      allowNegative: true,
    });
    if (!answer || !('value' in answer)) return;

    const result = setDynamicParameter(ctx.doc.snapshot, ins.id, chosen.id, answer.value);
    if (result.problem) {
      ctx.log(`DYNSET refused (${result.problem}): ${result.message ?? 'the edit was not applied.'}`);
      return; // No transact: document, undo history, dirty flag and revision are untouched.
    }
    ctx.doc.transact(() => result.state);
    ctx.log(`${chosen.name} set to ${answer.value} on "${ins.block}".`);
  });
}
