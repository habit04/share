/**
 * Priority 30.4 slice B — the Properties palette's Parameters section for
 * dynamic block references: a pure row builder plus a setter, split the
 * same way as the 3D solids precedent (tools3d/properties-edit.ts
 * parameterRows / setSolidParameter) so the rows are testable headless
 * and the palette stays a thin renderer.
 *
 * Rows carry EFFECTIVE values (stored value, else the definition
 * default). Every commit goes through core/parametric/apply.ts
 * setDynamicParameter — the same path as DYNSET and grip drags — so the
 * §2.7 lookup-clearing rule, validation and refusal codes are shared, and
 * a refused edit transacts nothing: the palette re-renders and the row
 * shows the stored value again.
 */
import type { Drawing } from '../core/document';
import type { BlockDef, InsertEntity } from '../core/entities';
import { setDynamicParameter, type DynamicParameterEditValue } from '../core/parametric/apply';
import { matchingLookupRow, resolvedEffectiveValues } from '../core/parametric/evaluate';
import { validateInstanceValues } from '../core/parametric/instance';

export type DynamicParameterRow =
  /** Editable distance (drawing units). */
  | { readonly kind: 'distance'; readonly id: string; readonly name: string; readonly value: number }
  /** Editable angle (radians in the model; the palette displays degrees). */
  | { readonly kind: 'angle'; readonly id: string; readonly name: string; readonly value: number }
  /** Flip state toggle. */
  | { readonly kind: 'flip'; readonly id: string; readonly name: string; readonly value: boolean }
  /** Visibility state choice; `options` are the state names in authoring order. */
  | { readonly kind: 'visibility'; readonly id: string; readonly name: string; readonly value: string; readonly options: readonly string[] }
  /**
   * Lookup row choice. `value` is the row to show selected: the stored
   * choice, else the parameter's default row, else — display only — the
   * row the current values match (matchingLookupRow, `matchedOnly`), else
   * null, the Custom state (no row applies). Committing stores the choice;
   * committing Custom stores null, clearing any stored choice.
   */
  | { readonly kind: 'lookup'; readonly id: string; readonly name: string; readonly value: string | null; readonly matchedOnly: boolean; readonly options: readonly string[] }
  /** Read-only information (retained data, unmodeled parameters, invalid stored values). */
  | { readonly kind: 'note'; readonly id: string; readonly name: string; readonly text: string };

/**
 * The Parameters rows for one insert of `block`: one row per parameter of
 * the block's dynamic definition, in definition order. Empty when the
 * block is not dynamic. Retained payloads (either side) yield a single
 * explanatory note row — the data is protected, not editable.
 */
export function dynamicParameterRows(block: BlockDef, ins: InsertEntity): DynamicParameterRow[] {
  if (block.dynamicRetained !== undefined) {
    return [{ kind: 'note', id: '', name: 'Dynamic block', text: 'Definition retained as data; its parameters cannot be edited in this build.' }];
  }
  const definition = block.dynamic;
  if (!definition) return [];
  if (ins.dynamicRetained !== undefined) {
    return [{ kind: 'note', id: '', name: 'Dynamic block', text: 'This reference\u2019s values are retained as data and cannot be edited in this build.' }];
  }
  const validation = validateInstanceValues(definition, ins.dynamic, ins.block);
  const effective = validation.ok ? validation.effective : undefined;
  // Rows display the lookup-RESOLVED values (review R11) — the values
  // geometry is evaluated from — so a parameter covered by the active
  // row shows the row's value, not its shadowed raw stored one. The one
  // exception is the lookup parameter's own row, whose display contract
  // (stored choice -> default row -> matched row -> Custom) is defined
  // over the RAW effective values; matchingLookupRow likewise reads the
  // raw map, by its own contract.
  const resolution = validation.ok ? resolvedEffectiveValues(definition, ins.dynamic, ins.block) : undefined;
  const resolved = resolution?.ok ? resolution.resolved : undefined;
  const rows: DynamicParameterRow[] = [];
  for (const param of definition.parameters) {
    const eff = (param.kind === 'lookup' ? effective : resolved)?.[param.id];
    switch (param.kind) {
      case 'linear-distance':
        rows.push({ kind: 'distance', id: param.id, name: param.name, value: eff?.kind === 'distance' ? eff.value : param.defaultValue });
        break;
      case 'angle':
        rows.push({ kind: 'angle', id: param.id, name: param.name, value: eff?.kind === 'angle' ? eff.value : param.defaultValue });
        break;
      case 'flip':
        rows.push({ kind: 'flip', id: param.id, name: param.name, value: eff?.kind === 'flip' ? eff.value : param.defaultValue });
        break;
      case 'visibility':
        rows.push({ kind: 'visibility', id: param.id, name: param.name, value: eff?.kind === 'visibility' ? eff.value : param.defaultState, options: param.states.map((s) => s.name) });
        break;
      case 'lookup': {
        const stored = eff?.kind === 'lookup' ? eff.value : undefined;
        // `stored` is the effective choice (stored value, else defaultRow).
        // With neither, the row the current values describe is shown if one
        // matches — display only; nothing is stored until the user commits.
        const matched = stored == null && effective ? matchingLookupRow(param, effective) : undefined;
        rows.push({
          kind: 'lookup', id: param.id, name: param.name,
          value: stored ?? matched ?? null,
          matchedOnly: stored == null && matched !== undefined,
          options: param.rows.map((r) => r.name),
        });
        break;
      }
      case 'opaque-parameter':
        rows.push({ kind: 'note', id: param.id, name: param.name, text: `${param.sourceKind} parameter — not modeled in this build; retained as data.` });
        break;
    }
  }
  if (!validation.ok) {
    const first = validation.issues[0];
    rows.push({
      kind: 'note', id: '', name: 'Stored values',
      text: `Invalid (${first?.code ?? 'unknown'}): ${first?.message ?? ''} Edits are refused until the values are corrected.`,
    });
  }
  return rows;
}

/** The slice of the Editor the setter needs (the Editor satisfies it). */
export interface DynamicParameterHost {
  readonly doc: Drawing;
  log(text: string): void;
}

/**
 * Commit one parameter edit from the palette: exactly one transact on
 * success (one undo step). On refusal nothing is transacted, the refusal
 * code and message go to the command line (the palette's error idiom),
 * and false is returned so the caller re-renders the unchanged value.
 */
export function setDynamicParameterValue(host: DynamicParameterHost, insertId: string, parameterId: string, value: DynamicParameterEditValue): boolean {
  const result = setDynamicParameter(host.doc.snapshot, insertId, parameterId, value);
  if (result.problem) {
    host.log(`Parameter edit refused (${result.problem}): ${result.message ?? 'the edit was not applied.'}`);
    return false;
  }
  host.doc.transact(() => result.state);
  return true;
}
