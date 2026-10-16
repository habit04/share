/**
 * Priority 30.1 / 30.4 slice B — DYNSET: set a dynamic-block parameter
 * value on a selected block reference. A thin command adapter over the
 * pure core/parametric/apply.ts transition: validation and refusal happen
 * there, before any transact, so a refused edit leaves no undo entry, no
 * dirty flag and no revision change; an accepted edit commits through
 * exactly ONE doc.transact (one undo step).
 *
 * 30.1 covered the linear distance parameter; 30.4 slice B generalizes to
 * every modeled kind — angle (numeric, radians: the model's unit), flip
 * (On/Off keyword), visibility (state name, listed first) and lookup (row
 * name, listed first; "Custom" clears the stored choice). State and row
 * names are identities compared exactly by the model, so the prompt
 * resolves the typed text to the canonical name (exact match, else a
 * case-insensitive one) and only ever hands apply.ts a real name.
 */
import type { InsertEntity } from '../core/entities';
import type { DynamicParameter, OpaqueParameter } from '../core/parametric/definitions';
import { setDynamicParameter, type DynamicParameterEditValue } from '../core/parametric/apply';
import { validateInstanceValues } from '../core/parametric/instance';
import { matchingLookupRow } from '../core/parametric/evaluate';
import type { Tool } from './types';
import { scriptTool, text, number, keyword, select, dflt } from './script';

type EditableParameter = Exclude<DynamicParameter, OpaqueParameter>;

/** Resolve typed text to a canonical state/row name: exact, else case-insensitive. */
const resolveName = (input: string, names: readonly string[]): string | undefined => {
  const wanted = input.trim();
  return names.find((n) => n === wanted) ?? names.find((n) => n.toLowerCase() === wanted.toLowerCase());
};

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
    const editable = definition.parameters.filter((p): p is EditableParameter => p.kind !== 'opaque-parameter');
    if (editable.length === 0) {
      ctx.log(`Block "${ins.block}" has no editable parameters.`);
      return;
    }
    const validation = validateInstanceValues(definition, ins.dynamic, ins.block);
    const effOf = (id: string) => (validation.ok ? validation.effective[id] : undefined);
    /** The current value the way the prompts show it (defaults when stored values are invalid). */
    const displayOf = (p: EditableParameter): string => {
      const eff = effOf(p.id);
      switch (p.kind) {
        case 'linear-distance':
          return String(eff?.kind === 'distance' ? eff.value : p.defaultValue);
        case 'angle':
          return `${eff?.kind === 'angle' ? eff.value : p.defaultValue} rad`;
        case 'flip':
          return (eff?.kind === 'flip' ? eff.value : p.defaultValue) ? 'on' : 'off';
        case 'visibility':
          return eff?.kind === 'visibility' ? eff.value : p.defaultState;
        case 'lookup': {
          const stored = eff?.kind === 'lookup' ? eff.value : undefined;
          if (stored) return stored;
          const matched = validation.ok ? matchingLookupRow(p, validation.effective) : undefined;
          return matched ?? 'Custom';
        }
      }
    };

    // Parameter: the only one, or a prompt matched by id or display name.
    let param: EditableParameter | undefined = editable[0];
    if (editable.length > 1) {
      for (const p of editable) ctx.log(`${p.id} (${p.name}) = ${displayOf(p)}`);
      const t = yield* text('Enter parameter name:', editable[0]!.id, true);
      if (t === null) return;
      const wanted = t.trim().toLowerCase();
      param = editable.find((p) => p.id.toLowerCase() === wanted || p.name.toLowerCase() === wanted);
      if (!param) {
        ctx.log(`No parameter "${t.trim()}" on block "${ins.block}".`);
        return;
      }
    }
    const chosen = param!;

    // Value prompt per kind. The raw value goes to apply.ts untouched — it,
    // not the prompt, is the authority on refusal.
    let value: DynamicParameterEditValue;
    switch (chosen.kind) {
      case 'linear-distance':
      case 'angle': {
        const eff = effOf(chosen.id);
        const current = chosen.kind === 'angle'
          ? (eff?.kind === 'angle' ? eff.value : chosen.defaultValue)
          : (eff?.kind === 'distance' ? eff.value : chosen.defaultValue);
        const answer = yield* number(ctx, `Enter new value for ${chosen.name}${chosen.kind === 'angle' ? ' (radians)' : ''} ${dflt(current, ctx)}:`, current, {
          from: null,
          allowZero: true,
          allowNegative: true,
        });
        if (!answer || !('value' in answer)) return;
        value = answer.value;
        break;
      }
      case 'flip': {
        const eff = effOf(chosen.id);
        const current = eff?.kind === 'flip' ? eff.value : chosen.defaultValue;
        const k = yield* keyword(ctx, `Flip ${chosen.name} [On/Off] ${dflt(current ? 'On' : 'Off')}:`, ['On', 'Off'], current ? 'On' : 'Off');
        if (k === null) return;
        value = k === 'ON';
        break;
      }
      case 'visibility': {
        for (const s of chosen.states) ctx.log(`  ${s.name}`);
        const t = yield* text(`Enter state for ${chosen.name}:`, displayOf(chosen), true);
        if (t === null) return;
        const resolved = resolveName(t, chosen.states.map((s) => s.name));
        if (!resolved) {
          ctx.log(`No visibility state "${t.trim()}" on parameter "${chosen.id}".`);
          return;
        }
        value = resolved;
        break;
      }
      case 'lookup': {
        for (const r of chosen.rows) ctx.log(`  ${r.name}`);
        ctx.log('  Custom (no row)');
        const t = yield* text(`Enter row for ${chosen.name}:`, displayOf(chosen), true);
        if (t === null) return;
        if (t.trim().toLowerCase() === 'custom') {
          value = null;
          break;
        }
        const resolved = resolveName(t, chosen.rows.map((r) => r.name));
        if (!resolved) {
          ctx.log(`No lookup row "${t.trim()}" on parameter "${chosen.id}".`);
          return;
        }
        value = resolved;
        break;
      }
    }

    const result = setDynamicParameter(ctx.doc.snapshot, ins.id, chosen.id, value);
    if (result.problem) {
      ctx.log(`DYNSET refused (${result.problem}): ${result.message ?? 'the edit was not applied.'}`);
      return; // No transact: document, undo history, dirty flag and revision are untouched.
    }
    ctx.doc.transact(() => result.state);
    const shown = value === null ? 'Custom' : typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value);
    ctx.log(`${chosen.name} set to ${shown} on "${ins.block}".`);
  });
}
