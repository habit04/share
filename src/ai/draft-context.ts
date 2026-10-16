import type { DrawingState } from '../core/document';
import type { ColorSpec } from '../core/entities';
import type { UnitSettings } from '../core/units';
import { INSUNIT_NAMES } from '../core/units';
import { sealImmutableData } from '../core/immutable-data';
import { buildSelectionSnapshot } from './snapshot';
import { cadAnchoredEntityIds, draftLayerProblem, draftTargetEligibility } from './draft-eligibility';
import { AI_DRAFT_MAX_CONTEXT_BYTES, AI_MAX_OBJECTS, AI_MAX_QUESTION_CHARS } from './limits';
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
  /** Monotonic start counter for commands, selection gestures and grip edits (not view navigation). */
  interactionGeneration?(): number;
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

function ownedBinding(source: AiDraftSource): ReturnType<AiDraftSource['binding']> {
  const binding = source.binding();
  if (!Array.isArray(binding.selectionIds) || binding.selectionIds.length > AI_MAX_OBJECTS
    || binding.selectionIds.some((id) => typeof id !== 'string' || !id || id.length > 512)
    || new Set(binding.selectionIds).size !== binding.selectionIds.length) {
    throw new AiError('invalid-context', 'Draft / Edit requires at most 200 selected objects with unique bounded identities.');
  }
  return sealImmutableData({ ...binding, space: { ...binding.space }, selectionIds: [...binding.selectionIds] });
}

function ownedDefaults(source: AiDraftSource): FrozenCreationDefaults {
  const d = source.frozenDefaults();
  if (typeof d.layer !== 'string' || !d.layer || d.layer.length > 512
    || !(d.color === 'ByLayer' || (Number.isInteger(d.color) && d.color >= 0 && d.color <= 255))
    || (d.linetype !== undefined && (typeof d.linetype !== 'string' || !d.linetype || d.linetype.length > 512))
    || (d.lineWeight !== undefined && (!Number.isFinite(d.lineWeight) || Math.abs(d.lineWeight) > 1e6))) {
    throw new AiError('invalid-context', 'The drawing creation defaults are invalid.');
  }
  return sealImmutableData({ layer: d.layer, color: d.color,
    ...(d.linetype !== undefined ? { linetype: d.linetype } : {}),
    ...(d.lineWeight !== undefined ? { lineWeight: d.lineWeight } : {}) });
}

function interactionKey(source: AiDraftSource): string {
  const value = source.interactionGeneration?.() ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new AiError('invalid-context', 'The editor interaction state is invalid.');
  return String(value);
}

function ownedUnits(source: AiDraftSource): UnitSettings {
  const u = source.units();
  if (!Number.isSafeInteger(u.insunits) || u.insunits < 0 || u.insunits > 1e6
    || !Number.isInteger(u.lunits) || u.lunits < 1 || u.lunits > 5
    || !Number.isInteger(u.luprec) || u.luprec < 0 || u.luprec > 8
    || !Number.isInteger(u.auprec) || u.auprec < 0 || u.auprec > 8
    || (u.aunits !== undefined && (!Number.isInteger(u.aunits) || u.aunits < 0 || u.aunits > 4))) {
    throw new AiError('invalid-context', 'The drawing unit settings are invalid.');
  }
  return sealImmutableData({ insunits: u.insunits, lunits: u.lunits, luprec: u.luprec, auprec: u.auprec,
    ...(u.aunits !== undefined ? { aunits: u.aunits } : {}) });
}

export function captureDraftContext(
  source: AiDraftSource,
  prompt: string,
  configKey: string,
): AiDraftCapture {
  const trimmed = typeof prompt === 'string' ? prompt.trim() : '';
  if (!trimmed) throw new AiError('invalid-question', 'Describe the drawing or edit first.');
  if (trimmed.length > AI_MAX_QUESTION_CHARS) throw new AiError('invalid-question', 'The description is too long.');
  const binding = ownedBinding(source);
  if (binding.space.layout !== null || binding.space.viewport !== null) {
    throw new AiError('invalid-context', 'Draft / Edit works in the Model tab only. Switch to Model and try again.');
  }
  const state = source.modelState();
  if (state.space !== undefined) throw new AiError('invalid-context', 'Draft / Edit works in the Model tab only.');
  const defaults = ownedDefaults(source);
  const snapshot = buildSelectionSnapshot(source);
  const disclosed = new Set(snapshot.objects.map((object) => object.id));
  const anchored = cadAnchoredEntityIds(state);
  const targets: AiDraftTargetInfo[] = [];
  const bindingTargets: AiDraftTargetInfo[] = [];
  for (const id of binding.selectionIds) {
    const entity = source.entityById(id);
    if (!entity) {
      const info = { id, eligible: false, reason: `object no longer exists (${source.missingIdKind(id)})` };
      bindingTargets.push(info);
      targets.push(info);
      continue;
    }
    const verdict = draftTargetEligibility(entity, state, anchored);
    const info = verdict.eligible ? { id, eligible: true } : { id, eligible: false, reason: verdict.reason };
    bindingTargets.push(info);
    targets.push(disclosed.has(id) ? info : { id, eligible: false, reason: 'object was not included in the bounded selection snapshot' });
  }
  // Only the current layer and included eligible targets' layers are disclosed
  // as creation destinations. Large imported layer tables do not grow context.
  const wantedLayers = new Set([defaults.layer]);
  for (const target of targets) if (target.eligible) {
    const entity = source.entityById(target.id);
    if (entity) wantedLayers.add(entity.layer);
  }
  const permittedLayers: string[] = [];
  for (const name of wantedLayers) {
    if (!name || name.length > 512) throw new AiError('invalid-context', 'A draft layer name exceeds the context limit.');
    if (draftLayerProblem(state, name) === null) permittedLayers.push(name);
  }
  const units = ownedUnits(source);
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
        ? 'The drawing is UNITLESS. All plan values must be drawing units. If physical units were requested, return clarification asking for drawing-unit values; never infer a scale or convert units.'
        : `All plan values must be drawing units (${unitsName}). If physical units require conversion, return clarification asking for drawing-unit values; never perform model-side unit conversion.`,
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
  const draftBinding: AiDraftBinding = sealImmutableData({
    ask: binding,
    unitsKey: JSON.stringify(units),
    defaultsKey: JSON.stringify(defaults),
    eligibilityKey: JSON.stringify([interactionKey(source), bindingTargets]),
    configKey,
  });
  return Object.freeze({
    binding: draftBinding,
    prompt: trimmed,
    contextJson,
    state,
    units,
    defaults,
    targets: sealImmutableData(targets),
    eligibleIds: sealImmutableData(targets.filter((t) => t.eligible).map((t) => t.id)),
    permittedLayers: sealImmutableData(permittedLayers),
  });
}

/**
 * Re-capture the binding-only view used for staleness checks: same key
 * material as captureDraftContext, without rebuilding the context JSON.
 */
export function draftBindingNow(source: AiDraftSource, configKey: string): AiDraftBinding {
  const binding = ownedBinding(source);
  const state = source.modelState();
  const defaults = ownedDefaults(source);
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
  const units = ownedUnits(source);
  return {
    ask: binding,
    unitsKey: JSON.stringify(units),
    defaultsKey: JSON.stringify(defaults),
    eligibilityKey: JSON.stringify([interactionKey(source), targets]),
    configKey,
  };
}
