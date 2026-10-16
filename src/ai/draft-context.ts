import type { DrawingState } from '../core/document';
import type { ColorSpec } from '../core/entities';
import type { UnitSettings } from '../core/units';
import { INSUNIT_NAMES } from '../core/units';
import { buildSelectionSnapshot } from './snapshot';
import { cadAnchoredEntityIds, draftLayerProblem, draftTargetEligibility } from './draft-eligibility';
import { AI_DRAFT_MAX_CONTEXT_BYTES, AI_MAX_QUESTION_CHARS } from './limits';
import { AiError, type AiDraftBinding, type AiSnapshotSource } from './types';

/**
 * Draft/Edit context capture (docs/AI-ASSISTANT-M3.md). Everything a draft
 * proposal is compiled and checked against is captured ONCE, by value, when
 * the user clicks Generate Preview: the immutable model-space state, the
 * eligibility verdict for every selected object (computed on the original
 * entities), the frozen creation defaults (what
 * `Drawing.withEntityDefaults()` resolves right now), the units, and the
 * exact context JSON that will be sent.
 */

/** Creation appearance frozen at capture: resolved defaults, never re-read at Apply. */
export interface FrozenCreationDefaults {
  readonly layer: string;
  readonly color: ColorSpec;
  readonly linetype?: string;
  readonly lineWeight?: number;
}

/** The extra read surface Draft needs beyond the Ask snapshot source. */
export interface AiDraftSource extends AiSnapshotSource {
  /** The immutable model-space drawing state. */
  modelState(): DrawingState;
  /** Creation defaults resolved against the live drawing at capture time. */
  frozenDefaults(): FrozenCreationDefaults;
  /** True while a tool / selection request / grip drag / gesture / pan is active. */
  interactionBusy(): boolean;
}

export interface AiDraftTargetInfo {
  readonly id: string;
  readonly eligible: boolean;
  readonly reason?: string;
}

export interface AiDraftCapture {
  readonly binding: AiDraftBinding;
  readonly prompt: string;
  /** The exact context JSON sent to the provider (also previewed in the panel). */
  readonly contextJson: string;
  readonly state: DrawingState;
  readonly units: UnitSettings;
  readonly defaults: FrozenCreationDefaults;
  readonly targets: readonly AiDraftTargetInfo[];
  readonly eligibleIds: readonly string[];
  readonly permittedLayers: readonly string[];
}

const utf8 = new TextEncoder();

export function captureDraftContext(
  source: AiDraftSource,
  prompt: string,
  configKey: string,
): AiDraftCapture {
  const trimmed = prompt.trim();
  if (!trimmed) throw new AiError('invalid-question', 'Describe the drawing or edit first.');
  if (trimmed.length > AI_MAX_QUESTION_CHARS) throw new AiError('invalid-question', 'The description is too long.');
  const binding = source.binding();
  if (binding.space.layout !== null || binding.space.viewport !== null) {
    throw new AiError('invalid-context', 'Draft / Edit works in the Model tab only. Switch to Model and try again.');
  }
  const state = source.modelState();
  const defaults = source.frozenDefaults();
  const anchored = cadAnchoredEntityIds(state);
  const targets: AiDraftTargetInfo[] = [];
  for (const id of binding.selectionIds) {
    const entity = source.entityById(id);
    if (!entity) {
      targets.push({ id, eligible: false, reason: `object no longer exists (${source.missingIdKind(id)})` });
      continue;
    }
    const verdict = draftTargetEligibility(entity, state, anchored);
    targets.push(verdict.eligible ? { id, eligible: true } : { id, eligible: false, reason: verdict.reason });
  }
  const permittedLayers = state.layers
    .filter((layer) => draftLayerProblem(state, layer.name) === null)
    .map((layer) => layer.name);
  const units = source.units();
  const snapshot = buildSelectionSnapshot(source);
  const unitsName = INSUNIT_NAMES[units.insunits] ?? `code ${units.insunits}`;
  const context = {
    kind: 'jcad.ai.draft-context',
    version: 1,
    prompt: trimmed,
    coordinateFrame: 'World XY, Model tab',
    creationOrigin: { x: 0, y: 0, note: 'Default origin is the World origin (0,0) unless the plan states explicit coordinates.' },
    units: {
      insunits: units.insunits,
      name: unitsName,
      note: units.insunits === 0
        ? 'The drawing is UNITLESS. All plan values are drawing units. If the user specified physical units, return the clarification outcome instead of assuming a scale.'
        : `All plan values are in drawing units (${unitsName}). Convert any physical units the user named into drawing units.`,
    },
    creationDefaults: {
      layer: defaults.layer,
      color: defaults.color,
      linetype: defaults.linetype ?? null,
      lineWeight: defaults.lineWeight ?? null,
      note: 'Creations without an explicit layer use the default layer with exactly this appearance.',
    },
    permittedLayers,
    targets: targets.map((t) => (t.eligible ? { id: t.id, eligible: true } : { id: t.id, eligible: false, reason: t.reason })),
    selectionSnapshot: JSON.parse(JSON.stringify(snapshot)) as unknown,
  };
  const contextJson = JSON.stringify(context);
  if (utf8.encode(contextJson).length > AI_DRAFT_MAX_CONTEXT_BYTES) {
    throw new AiError('invalid-context', 'The draft context exceeds the AI context limit. Select fewer objects and try again.');
  }
  const draftBinding: AiDraftBinding = {
    ask: binding,
    unitsKey: `${units.insunits}|${units.lunits}|${units.luprec}`,
    defaultsKey: JSON.stringify(defaults),
    eligibilityKey: targets.map((t) => `${t.id}=${t.eligible ? '1' : `0:${t.reason}`}`).join(';'),
    configKey,
  };
  return {
    binding: draftBinding,
    prompt: trimmed,
    contextJson,
    state,
    units,
    defaults,
    targets,
    eligibleIds: targets.filter((t) => t.eligible).map((t) => t.id),
    permittedLayers,
  };
}

/**
 * Re-capture the binding-only view used for staleness checks: same key
 * material as captureDraftContext, without rebuilding the context JSON.
 */
export function draftBindingNow(source: AiDraftSource, configKey: string): AiDraftBinding {
  const binding = source.binding();
  const state = source.modelState();
  const defaults = source.frozenDefaults();
  const anchored = cadAnchoredEntityIds(state);
  const parts: string[] = [];
  for (const id of binding.selectionIds) {
    const entity = source.entityById(id);
    if (!entity) {
      parts.push(`${id}=0:missing`);
      continue;
    }
    const verdict = draftTargetEligibility(entity, state, anchored);
    parts.push(`${id}=${verdict.eligible ? '1' : `0:${verdict.reason}`}`);
  }
  const units = source.units();
  return {
    ask: binding,
    unitsKey: `${units.insunits}|${units.lunits}|${units.luprec}`,
    defaultsKey: JSON.stringify(defaults),
    eligibilityKey: parts.join(';'),
    configKey,
  };
}
