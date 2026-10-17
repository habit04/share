/**
 * Shaping preparation session (engine step 2C): the async,
 * per-context preparation the synchronous geometry lookup reads.
 *
 * For one context (identified by the caller's epoch token — the
 * geometry context's cacheKey object, compared by identity) and
 * one paragraph text, preparation:
 *   1. itemizes (§2 pipeline),
 *   2. assigns each shaped item's code points to the first face in
 *      the injected fallback chain that covers them (grapheme-safe
 *      coverage splits, §2.5),
 *   3. produces, per (item, face), a whole-context reference
 *      production and one production per subitem through the host
 *      bridge, and admits each SPLIT subitem only through the
 *      step-1 preparation layer (`admitItemProduction`) — a
 *      disagreement is a refusal, never a served approximation,
 *   4. assembles validated runs (text-shaping-produce) and seals
 *      them into one snapshot per (context, text).
 *
 * Face identity is established from the reference production's own
 * result: its worker-computed programSha256 becomes the candidate's
 * SelectedFaceRef, and every later production for that candidate
 * must echo the same hash or the item refuses (identity drift).
 * Every production is ledgered (admission charge reserved before
 * dispatch; terminal and validated/discarded recorded with the
 * result). The charge for a face whose program size is not yet
 * known reserves the result allowance only; once a production
 * reports the size, later reservations for that face charge the
 * full admission amount. A superseded preparation (a newer
 * generation) discards its late results — they are never served.
 * Lookup is synchronous and total: ready (with per-subitem runs),
 * pending, missing, or refused (with the recorded problem) —
 * silent fallback is a defect, so every non-ready state is a
 * value the consumer reports.
 */
import {
  deriveShapeKey,
  type SelectedFaceRef,
  type ShapeKey,
  type ShapedRun,
} from '../core/text-shaping';
import type {
  ShapeBridge,
  ShapeFaceCandidate,
  ShapedGlyphState,
  ShapedItemState,
  TextAppearance,
} from '../core/text-metrics';
export type { ShapeBridge, ShapeBridgeRequest, ShapeBridgeResult, ShapeFaceCandidate } from '../core/text-metrics';
import { ShapeSnapshotBuilder, type ShapeSnapshot } from '../core/text-shaping-snapshot';
import {
  ShapeTransportLedger,
  admissionChargeBytes,
  type ShapeJobTerminal,
} from '../core/text-shaping-transport';
import {
  itemizeParagraph,
  splitByCoverage,
  PIPELINE_DATA_VERSION,
  type ShapedItemDerivation,
} from '../core/text-pipeline';
import { admitItemProduction } from '../core/text-shaping-preparation';
import {
  assembleShapedRun,
  type ShapeProductionData,
} from '../core/text-shaping-produce';
import { sha256Hex } from '../core/sha256';

/** Engine identity for every key this build mints. The artifact
    digest is the vendored capped wasm's SHA-256 (build receipt,
    electron/shaping/assets/build-receipt.json); the shaping data
    version is the UCD version the engine's own build source
    records for its generated classification tables
    (src/hb-ucd-table.hh in the harfbuzzjs 1.6.3 source tree:
    Unicode 18.0.0). The pipeline pins UCD 15.1.0 — both versions
    ride in every key, so the skew is visible, never hidden. */
export const ENGINE_ARTIFACT_SHA256 = '49ee0c0de1d0ee1b6d69dd0305e1317f001cfa12e55543c7287a3f61bb590acb';
export const ENGINE_SHAPING_DATA_VERSION = 'unicode-18.0.0';

/** Ordered fallback chain for one appearance. */
export type ShapeFaceSource = (appearance: TextAppearance) => readonly ShapeFaceCandidate[];

/** The session's per-item state: the geometry-level union (core
    text-metrics) with FULL runs — the PDF writer consumes glyphs
    and bindings from here in step 3. The geometry hooks narrow
    runs to placement facts at the core boundary. */
export type PreparedItemState =
  | { readonly state: 'ready'; readonly subitems: readonly { readonly start: number; readonly end: number; readonly run: ShapedRun; readonly capitalHeight: number }[] }
  | { readonly state: 'pending' }
  | { readonly state: 'missing' }
  | { readonly state: 'refused'; readonly problem: string }
  | { readonly state: 'direct'; readonly reason: 'admitted-native' };

interface ContextRecord {
  readonly textSha256: string;
  readonly snapshot: ShapeSnapshot;
  readonly items: ReadonlyMap<string, PreparedItemState>;
}

const itemRecordKey = (derivation: ShapedItemDerivation): string =>
  `${derivation.itemStart}:${derivation.itemEnd}:${derivation.script}:${derivation.bidiLevel}`;

/** §2.3 level-array digest: SHA-256 over the string whose code
    units are the level values (the 2B design's pinned encoding;
    levels are < 128, so UTF-8 encoding is byte-identical). */
function levelsDigest(levels: Uint8Array): string {
  let text = '';
  for (let i = 0; i < levels.length; i += 4096) {
    text += String.fromCharCode(...levels.subarray(i, i + 4096));
  }
  return sha256Hex(text);
}

interface FaceIdentity {
  ref: SelectedFaceRef;
  programBytes: number;
}

export class ShapePreparationSession {
  readonly #bridge: ShapeBridge;
  readonly #faceSource: ShapeFaceSource;
  readonly #ledger = new ShapeTransportLedger();
  readonly #records = new Map<unknown, ContextRecord>();
  readonly #pending = new Map<unknown, Set<string>>();
  readonly #identities = new Map<ShapeFaceCandidate, FaceIdentity>();
  #generation = 0;
  #jobSequence = 0;
  /** Productions are serialized session-wide: the ledger models
      the host's worker slots, and one-at-a-time keeps the ledger's
      concurrency accounting exact rather than contended. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(bridge: ShapeBridge, faceSource: ShapeFaceSource) {
    this.#bridge = bridge;
    this.#faceSource = faceSource;
  }

  /** The aggregate transport ledger (exposed for reporting/tests). */
  get ledger(): ShapeTransportLedger {
    return this.#ledger;
  }

  /**
   * Synchronous, total per-item lookup for a prepared (or not)
   * context. Only shaped items are recorded; the caller answers
   * direct/refused items from its own itemization.
   */
  lookup(contextId: unknown, text: string, derivation: ShapedItemDerivation): PreparedItemState {
    const textSha = sha256Hex(text);
    const record = this.#records.get(contextId);
    if (record && record.textSha256 === textSha) {
      return record.items.get(itemRecordKey(derivation)) ?? { state: 'missing' };
    }
    if (this.#pending.get(contextId)?.has(textSha)) return { state: 'pending' };
    return { state: 'missing' };
  }

  /** Drop a context's records (epoch superseded by the caller). */
  invalidate(contextId: unknown): void {
    this.#records.delete(contextId);
    this.#pending.delete(contextId);
  }

  /**
   * Prepare one paragraph text for one context. Resolves when the
   * context's snapshot for this text is sealed (or the preparation
   * was superseded — late results are discarded, never served).
   */
  async prepareParagraph(contextId: unknown, text: string, appearance: TextAppearance): Promise<void> {
    const textSha = sha256Hex(text);
    const existing = this.#records.get(contextId);
    if (existing && existing.textSha256 === textSha) return;
    const generation = ++this.#generation;
    let pendingSet = this.#pending.get(contextId);
    if (!pendingSet) {
      pendingSet = new Set();
      this.#pending.set(contextId, pendingSet);
    }
    pendingSet.add(textSha);

    try {
      const itemized = itemizeParagraph(text);
      const builder = new ShapeSnapshotBuilder({ captureGeneration: generation, fontEpoch: contextId });
      const itemStates = new Map<string, PreparedItemState>();
      const candidates = this.#faceSource(appearance);
      const paragraphLevelsSha256 = levelsDigest(itemized.levels);

      for (const item of itemized.items) {
        if (item.route !== 'shaped') continue;
        const state = await this.#prepareItem(
          builder, contextId, item.derivation, candidates, appearance, paragraphLevelsSha256, text,
          itemized.graphemeBoundaries, itemized.paragraphLevel === 1 ? 'rtl' : 'ltr',
          () => generation === this.#generation,
        );
        if (generation !== this.#generation) return; // superseded mid-flight
        itemStates.set(itemRecordKey(item.derivation), state);
      }

      if (generation !== this.#generation) return;
      const snapshot = builder.seal();
      this.#records.set(contextId, { textSha256: textSha, snapshot, items: itemStates });
    } finally {
      pendingSet.delete(textSha);
    }
  }

  /** Prepare one shaped item: coverage assignment, productions,
      step-1 admission per split subitem, assembly into the builder. */
  async #prepareItem(
    builder: ShapeSnapshotBuilder,
    contextId: unknown,
    derivation: ShapedItemDerivation,
    candidates: readonly ShapeFaceCandidate[],
    appearance: TextAppearance,
    paragraphLevelsSha256: string,
    text: string,
    graphemeBoundaries: readonly number[],
    paragraphBaseDirection: 'ltr' | 'rtl',
    isCurrent: () => boolean,
  ): Promise<PreparedItemState> {
    interface Assignment { candidate: ShapeFaceCandidate; start: number; end: number }
    const assignments: Assignment[] = [];
    let remaining: { start: number; end: number }[] = [{ start: derivation.itemStart, end: derivation.itemEnd }];
    for (const candidate of candidates) {
      const next: { start: number; end: number }[] = [];
      for (const range of remaining) {
        const parts = splitByCoverage(
          text, range.start, range.end, graphemeBoundaries,
          (cp) => (candidate.cmap[cp] ?? 0) !== 0,
        );
        for (const part of parts) {
          if (part.covered) assignments.push({ candidate, start: part.start, end: part.end });
          else next.push({ start: part.start, end: part.end });
        }
      }
      remaining = next;
      if (remaining.length === 0) break;
    }
    if (remaining.length > 0) {
      return {
        state: 'refused',
        problem: `no-face-coverage: no face in the fallback chain covers ${remaining.map((r) => `[${r.start},${r.end})`).join(' ')} of the item`,
      };
    }
    if (assignments.length === 0) {
      return { state: 'refused', problem: 'no-face-coverage: the fallback chain is empty' };
    }

    const subitems: { start: number; end: number; run: ShapedRun; capitalHeight: number }[] = [];
    const byCandidate = new Map<ShapeFaceCandidate, Assignment[]>();
    for (const assignment of assignments) {
      const list = byCandidate.get(assignment.candidate) ?? [];
      list.push(assignment);
      byCandidate.set(assignment.candidate, list);
    }
    for (const [candidate, parts] of byCandidate) {
      // Reference production: the whole item under this candidate.
      const referenceData = await this.#produce(candidate, derivation, derivation.itemStart, derivation.itemEnd, isCurrent);
      if (!isCurrent()) return { state: 'missing' };
      if ('problem' in referenceData) return { state: 'refused', problem: referenceData.problem };
      const identity = this.#identityFor(candidate, referenceData);
      if ('problem' in identity) return { state: 'refused', problem: identity.problem };
      const referenceKey = this.#keyFor(identity.ref, contextId, derivation, derivation.itemStart, derivation.itemEnd, appearance, paragraphLevelsSha256, paragraphBaseDirection, text);
      if ('problem' in referenceKey) return { state: 'refused', problem: referenceKey.problem };
      let referenceRun: ShapedRun;
      try {
        referenceRun = assembleShapedRun(
          referenceKey.key, text.slice(derivation.itemStart, derivation.itemEnd), referenceData, candidate.metrics,
        );
      } catch (error) {
        return { state: 'refused', problem: error instanceof Error ? error.message : String(error) };
      }

      for (const part of parts) {
        const key = this.#keyFor(identity.ref, contextId, derivation, part.start, part.end, appearance, paragraphLevelsSha256, paragraphBaseDirection, text);
        if ('problem' in key) return { state: 'refused', problem: key.problem };
        let run: ShapedRun;
        if (part.start === derivation.itemStart && part.end === derivation.itemEnd) {
          run = referenceRun;
        } else {
          const produced = await this.#produce(candidate, derivation, part.start, part.end, isCurrent);
          if (!isCurrent()) return { state: 'missing' };
          if ('problem' in produced) return { state: 'refused', problem: produced.problem };
          if (produced.programSha256 !== identity.ref.programSha256) {
            return {
              state: 'refused',
              problem: `face-identity-drift: the subitem production was shaped from ${produced.programSha256}, ` +
                `not the reference production's ${identity.ref.programSha256}`,
            };
          }
          let itemRun: ShapedRun;
          try {
            itemRun = assembleShapedRun(key.key, text.slice(part.start, part.end), produced, candidate.metrics);
          } catch (error) {
            return { state: 'refused', problem: error instanceof Error ? error.message : String(error) };
          }
          const validation = {
            key: itemRun.binding,
            itemText: text.slice(part.start, part.end),
            itemTextSha256: itemRun.binding.itemTextSha256,
            glyphCount: candidate.metrics.advances.length,
            unitsPerEm: candidate.metrics.unitsPerEm,
          };
          const admission = admitItemProduction({
            contextStart: derivation.contextStart,
            contextEnd: derivation.contextEnd,
            reference: { run: referenceRun, validation: { ...validation, key: referenceRun.binding, itemText: text.slice(derivation.itemStart, derivation.itemEnd), itemTextSha256: referenceRun.binding.itemTextSha256 } },
            item: { run: itemRun, validation },
            producedByShapedRegionRules: true,
            digestSha256Hex: sha256Hex,
          });
          if (!admission.safe) return { state: 'refused', problem: admission.problem };
          run = itemRun;
        }
        const added = builder.add(run.binding, run, {
          itemText: text.slice(part.start, part.end),
          itemTextSha256: run.binding.itemTextSha256,
          glyphCount: candidate.metrics.advances.length,
          unitsPerEm: candidate.metrics.unitsPerEm,
        });
        if (!added.ok) return { state: 'refused', problem: added.problem };
        subitems.push({ start: part.start, end: part.end, run, capitalHeight: candidate.capitalHeight });
      }
    }
    subitems.sort((a, b) => a.start - b.start);
    return { state: 'ready', subitems };
  }

  /** Establish (or verify) a candidate's face identity from a
      production result: the worker-computed program hash is the
      identity; a later different hash for the same candidate is
      drift and refuses. */
  #identityFor(
    candidate: ShapeFaceCandidate,
    production: ShapeProductionData,
  ): { ref: SelectedFaceRef } | { problem: string } {
    const existing = this.#identities.get(candidate);
    if (existing) {
      if (existing.ref.programSha256 !== production.programSha256) {
        return {
          problem: `face-identity-drift: the face resolved to ${production.programSha256}, ` +
            `previously ${existing.ref.programSha256}`,
        };
      }
      return { ref: existing.ref };
    }
    const ref: SelectedFaceRef = {
      programSha256: production.programSha256,
      faceIndex: candidate.faceIndex,
      engineFaceIndex: 0,
      source: 'host-selection',
    };
    this.#identities.set(candidate, { ref, programBytes: production.programBytes });
    return { ref };
  }

  #keyFor(
    face: SelectedFaceRef,
    contextId: unknown,
    derivation: ShapedItemDerivation,
    start: number,
    end: number,
    appearance: TextAppearance,
    paragraphLevelsSha256: string,
    paragraphBaseDirection: 'ltr' | 'rtl',
    text: string,
  ): { key: ShapeKey } | { problem: string } {
    const flags: string[] = [];
    if (start === derivation.contextStart) flags.push('bot');
    if (end === derivation.contextEnd) flags.push('eot');
    const derived = deriveShapeKey(
      {
        paragraphText: text,
        itemStart: start,
        itemEnd: end,
        appearance,
        face,
        direction: derivation.direction,
        bidiLevel: derivation.bidiLevel,
        contextKind: 'paragraph',
        contextStart: derivation.contextStart,
        contextEnd: derivation.contextEnd,
      },
      {
        engineArtifactSha256: ENGINE_ARTIFACT_SHA256,
        shapingDataVersion: ENGINE_SHAPING_DATA_VERSION,
        pipelineDataVersion: PIPELINE_DATA_VERSION,
        script: derivation.script,
        paragraphBaseDirection,
        features: derivation.features,
        bufferFlags: flags,
        paragraphSha256: sha256Hex(text),
        contextSha256: sha256Hex(text.slice(derivation.contextStart, derivation.contextEnd)),
        paragraphLevelsSha256,
        lineLevelsSha256: null,
        fontEpoch: contextId,
      },
    );
    return derived.ok ? { key: derived.value } : { problem: derived.problem };
  }

  /** One ledgered production through the bridge, serialized. */
  #produce(
    candidate: ShapeFaceCandidate,
    derivation: ShapedItemDerivation,
    itemStart: number,
    itemEnd: number,
    isCurrent: () => boolean,
  ): Promise<ShapeProductionData | { problem: string }> {
    const run = async (): Promise<ShapeProductionData | { problem: string }> => {
      const jobId = `shape-${++this.#jobSequence}`;
      const knownBytes = candidate.programBytes ?? this.#identities.get(candidate)?.programBytes;
      const reserved = this.#ledger.reserve(jobId, admissionChargeBytes(knownBytes ?? 0));
      if (!reserved.ok) return { problem: reserved.problem };
      const activated = this.#ledger.activate(jobId);
      if (!activated.ok) return { problem: activated.problem };
      let terminal: ShapeJobTerminal = 'error';
      try {
        const result = await this.#bridge({
          descriptor: candidate.descriptor,
          shape: {
            text: derivation.text,
            itemStart,
            itemEnd,
            script: derivation.script,
            direction: derivation.direction,
            features: derivation.features,
          },
        });
        if (result === null) {
          terminal = 'error';
          return { problem: 'shaping-bridge-unavailable: the host shape bridge returned no result' };
        }
        if (result.shaped === null) {
          terminal = 'refused';
          return { problem: result.problem };
        }
        terminal = 'success';
        const data = result.shaped;
        this.#ledger.noteTerminal(jobId, terminal);
        if (!isCurrent()) {
          this.#ledger.noteResultDiscarded(jobId);
          this.#ledger.noteWorkerExited(jobId);
          return { problem: 'superseded: the preparation was replaced by a newer generation' };
        }
        this.#ledger.noteResultValidated(jobId);
        this.#ledger.noteWorkerExited(jobId);
        return data;
      } finally {
        if (terminal !== 'success') {
          this.#ledger.noteTerminal(jobId, terminal);
          this.#ledger.noteWorkerExited(jobId);
        }
      }
    };
    const result = this.#tail.then(run, run);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * The geometry-context hooks for one context: binds a session to
 * the caller's epoch token (read fresh at every call, so an epoch
 * change is a new context to the session) and a face source over
 * the caller's own font resolution. `shaped` finds the item by
 * range in a fresh itemization — direct and pipeline-refused
 * items are answered from the itemization itself; shaped items
 * consult the session's records.
 */
export function createShapingHooks(init: {
  readonly bridge: ShapeBridge;
  readonly contextId: () => unknown;
  readonly candidatesFor: (appearance: TextAppearance) => readonly ShapeFaceCandidate[];
}): {
  readonly prepare: (text: string, appearance: TextAppearance) => Promise<void>;
  readonly shaped: (text: string, appearance: TextAppearance, itemStart: number, itemEnd: number) => ShapedItemState;
  readonly shapedGlyphs: (text: string, appearance: TextAppearance, itemStart: number, itemEnd: number) => ShapedGlyphState;
  readonly session: ShapePreparationSession;
} {
  const session = new ShapePreparationSession(init.bridge, init.candidatesFor);
  return {
    session,
    prepare: (text, appearance) => session.prepareParagraph(init.contextId(), text, appearance),
    shaped: (text, _appearance, itemStart, itemEnd) => {
      const itemized = itemizeParagraph(text);
      for (const item of itemized.items) {
        const start = item.route === 'shaped' ? item.derivation.itemStart : item.itemStart;
        const end = item.route === 'shaped' ? item.derivation.itemEnd : item.itemEnd;
        if (start !== itemStart || end !== itemEnd) continue;
        if (item.route === 'direct') return { state: 'direct', reason: 'admitted-native' };
        if (item.route === 'refused') return { state: 'refused', problem: item.problem };
        const state = session.lookup(init.contextId(), text, item.derivation);
        if (state.state !== 'ready') return state;
        return {
          state: 'ready',
          subitems: state.subitems.map((subitem) => ({
            start: subitem.start,
            end: subitem.end,
            run: { advanceX: subitem.run.advanceX, ink: subitem.run.ink },
            capitalHeight: subitem.capitalHeight,
          })),
        };
      }
      return { state: 'missing' };
    },
    shapedGlyphs: (text, _appearance, itemStart, itemEnd) => {
      const itemized = itemizeParagraph(text);
      for (const item of itemized.items) {
        const start = item.route === 'shaped' ? item.derivation.itemStart : item.itemStart;
        const end = item.route === 'shaped' ? item.derivation.itemEnd : item.itemEnd;
        if (start !== itemStart || end !== itemEnd) continue;
        if (item.route === 'direct') return { state: 'direct', reason: 'admitted-native' };
        if (item.route === 'refused') return { state: 'refused', problem: item.problem };
        const state = session.lookup(init.contextId(), text, item.derivation);
        if (state.state !== 'ready') return state;
        return {
          state: 'ready',
          subitems: state.subitems.map((subitem) => ({
            start: subitem.start,
            end: subitem.end,
            programSha256: subitem.run.binding.programSha256,
            glyphs: subitem.run.glyphs,
          })),
        };
      }
      return { state: 'missing' };
    },
  };
}
