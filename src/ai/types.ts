import type { Entity } from '../core/entities';
import type { Bounds } from '../core/geometry';
import type { UnitSettings } from '../core/units';

/**
 * Provider-independent types for the AI assistant (docs/AI-ASSISTANT.md).
 * Nothing in this module touches the editor, the DOM, or the network.
 */

/** Active space copied by value: layout name plus viewport id when inside one. */
export interface AiSpaceBinding {
  readonly layout: string | null;
  readonly viewport: string | null;
}

/**
 * Identity of the exact selection in the exact document a request was made
 * against. Captured by value at request time and re-read before an answer is
 * shown; any difference makes the answer stale. `docRevision` is the drawing's
 * monotonic mutation counter — it advances on edits, undo, redo, loads and
 * quiet patches, so an edit-then-undo (which restores the identical state
 * object) still invalidates an in-flight request.
 */
export interface AiBinding {
  readonly sessionId: number;
  readonly docId: string;
  readonly contentGeneration: number;
  readonly docRevision: number;
  readonly docLoadCount: number;
  readonly space: AiSpaceBinding;
  readonly selectionIds: readonly string[];
}

export function aiBindingsEqual(a: AiBinding, b: AiBinding): boolean {
  return a.sessionId === b.sessionId
    && a.docId === b.docId
    && a.contentGeneration === b.contentGeneration
    && a.docRevision === b.docRevision
    && a.docLoadCount === b.docLoadCount
    && a.space.layout === b.space.layout
    && a.space.viewport === b.space.viewport
    && a.selectionIds.length === b.selectionIds.length
    && a.selectionIds.every((id, i) => id === b.selectionIds[i]);
}

/**
 * The read-only surface the snapshot builder needs. Implemented for the real
 * editor in editor-source.ts and by plain fakes in tests. There are no
 * mutating methods here on purpose: asking a question can never reach a
 * drawing, selection, tool, undo or save operation through this interface.
 */
export interface AiSnapshotSource {
  /** Current binding, copied by value. */
  binding(): AiBinding;
  /** Drawing unit settings. */
  units(): UnitSettings;
  /** Selected entities in drawing order (active space only). */
  selectedEntities(): readonly Entity[];
  /** Look up one entity by id in the active space. */
  entityById(id: string): Entity | undefined;
  /** Bounds for an entity, or null when they cannot be computed. */
  boundsFor(entity: Entity): Bounds | null;
  /**
   * Why a selected id did not resolve to an entity: a known non-entity
   * object (e.g. a 3D solid in the selection) is 'unsupported-object';
   * anything else is a stale 'missing-object'.
   */
  missingIdKind(id: string): AiOmitReason;
}

export type AiOmitReason =
  | 'unsupported-object'
  | 'missing-object'
  | 'unsupported-type'
  | 'object-limit'
  | 'byte-limit';

export interface AiOmitted {
  readonly id: string;
  readonly reason: AiOmitReason;
}

export interface AiPoint {
  readonly x: number;
  readonly y: number;
}

export type AiGeometryValue =
  | number
  | string
  | boolean
  | AiPoint
  | readonly AiPoint[];

/** One selected object, field-whitelisted per type — never a raw entity. */
export interface AiObjectSnapshot {
  readonly id: string;
  readonly type: string;
  readonly layer: string;
  readonly geometry: Readonly<Record<string, AiGeometryValue>>;
  readonly bounds?: { readonly min: AiPoint; readonly max: AiPoint };
  /** Permitted text content (text / mtext / leader / dimension override). */
  readonly text?: string;
  /** Insert attributes, tag order sorted for determinism. */
  readonly attributes?: readonly { readonly tag: string; readonly value: string; readonly hidden?: boolean }[];
  /** Table cell texts, row-major, non-empty only. */
  readonly tableText?: readonly string[];
  /** Transparency notes: truncations and exclusions applied to this object. */
  readonly notes?: readonly string[];
}

export interface AiSnapshot {
  readonly kind: 'jcad.ai.selection-snapshot';
  readonly version: 1;
  readonly units: {
    readonly insunits: number;
    readonly insunitsName: string;
    readonly lunits: number;
    readonly luprec: number;
    readonly auprec: number;
  };
  readonly space:
    | { readonly kind: 'model' }
    | { readonly kind: 'layout'; readonly layout: string; readonly viewport?: string };
  readonly selection: {
    readonly total: number;
    readonly included: number;
    readonly omittedCount: number;
    readonly omitted: readonly AiOmitted[];
    readonly omittedListTruncated: boolean;
  };
  readonly objects: readonly AiObjectSnapshot[];
  /** Exact UTF-8 byte length of the serialized snapshot. */
  readonly serializedBytes: number;
}

export interface AiAskRequest {
  /**
   * Unique across controller recreation and page reloads: minted by
   * `mintAiRequestId()` (page-instance salt + monotonic counter), so a
   * recreated controller can never collide with a previous controller's
   * in-flight host job (milestone 2, docs/AI-ASSISTANT-M2.md).
   */
  readonly requestId: string;
  readonly question: string;
  readonly snapshot: AiSnapshot;
  readonly binding: AiBinding;
  /** Live requests pin the destination shown in the panel; the host rejects mismatches. */
  readonly destination?: { readonly provider: string; readonly model: string };
}

let requestSalt: string | null = null;
let requestCounter = 0;

/** Mint a request id unique to this page instance and monotonic within it. */
export function mintAiRequestId(): string {
  if (requestSalt === null) {
    let salt = '';
    try {
      const bytes = new Uint8Array(8);
      crypto.getRandomValues(bytes);
      salt = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch { /* fall through to the time-based salt */ }
    if (!salt) salt = `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
    requestSalt = salt;
  }
  requestCounter += 1;
  return `ai-${requestSalt}-${requestCounter}`;
}

export interface AiUsage {
  readonly inputBytes?: number;
  readonly outputChars?: number;
  readonly durationMs?: number;
  /** Provider-reported token usage, when the provider supplies it (milestone 2). */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface AiAnswer {
  readonly text: string;
  /** Object ids the answer discusses; validated against the snapshot before display. */
  readonly references: readonly string[];
  readonly usage?: AiUsage;
}

export type AiErrorKind =
  | 'provider-not-configured'
  | 'provider-failure'
  | 'host-unavailable'
  | 'timeout'
  | 'cancelled'
  | 'stale'
  | 'invalid-question'
  | 'invalid-context'
  | 'invalid-answer'
  | 'output-too-large'
  | 'disposed'
  // Milestone 2 (live provider): produced host-side and reconstructed in
  // the renderer from the structured IPC error payload.
  | 'live-disabled'
  | 'auth-failed'
  | 'model-access'
  | 'rate-limited'
  | 'network'
  | 'refused'
  | 'credential-unavailable'
  | 'credential-corrupt'
  | 'credential-delete-failed'
  | 'credential-rollback-failed'
  | 'invalid-request'
  // Milestone 3 (Draft / Edit).
  | 'invalid-plan'
  | 'busy';

export class AiError extends Error {
  readonly kind: AiErrorKind;
  constructor(kind: AiErrorKind, message: string) {
    super(message);
    this.name = 'AiError';
    this.kind = kind;
  }
}

/** A provider answers questions about a snapshot. It receives no editor access. */
export interface AiProvider {
  readonly id: string;
  ask(request: AiAskRequest, signal: AbortSignal): Promise<AiAnswer>;
}

// ---- Milestone 3 (Draft / Edit): docs/AI-ASSISTANT-M3.md ----

import type { AiDraftResponse } from './draft-plan';

/**
 * Everything a staged draft proposal is bound to: the full Ask binding plus
 * fingerprints of the units, the frozen creation defaults and the target
 * eligibility in force at generation, and the provider configuration key
 * (provider | model | configuration generation). Any difference at Apply
 * time makes the proposal stale; it is discarded, never rebased.
 */
export interface AiDraftBinding {
  readonly ask: AiBinding;
  readonly unitsKey: string;
  readonly defaultsKey: string;
  readonly eligibilityKey: string;
  readonly configKey: string;
}

export function aiDraftBindingsEqual(a: AiDraftBinding, b: AiDraftBinding): boolean {
  return aiBindingsEqual(a.ask, b.ask)
    && a.unitsKey === b.unitsKey
    && a.defaultsKey === b.defaultsKey
    && a.eligibilityKey === b.eligibilityKey
    && a.configKey === b.configKey;
}

/** A draft request: the user's wording plus the exact context JSON shown in the panel. */
export interface AiDraftRequest {
  readonly requestId: string;
  readonly prompt: string;
  /** The serialized draft context (snapshot + eligibility/defaults/units blocks). */
  readonly contextJson: string;
  readonly binding: AiDraftBinding;
  /** Live requests pin the destination shown in the panel; the host rejects mismatches. */
  readonly destination?: { readonly provider: string; readonly model: string };
}

/** A draft provider returns a validated plan response. It receives no editor access. */
export interface AiDraftProvider {
  readonly id: string;
  draft(request: AiDraftRequest, signal: AbortSignal): Promise<AiDraftResponse>;
}
