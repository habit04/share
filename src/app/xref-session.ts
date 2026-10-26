/**
 * Priority 20, slice 1 — per-document xref session controller (design
 * sections 1-2). One controller per open document: it owns an XrefStore
 * and a lazily created reader handle, builds every load/refresh attempt
 * the same way from the CURRENT host state, and publishes nothing itself —
 * the store's token/generation/host-epoch guard is the publication line,
 * and this controller's abort is the first line of defence.
 *
 * The controller is live only for a document with a non-null ABSOLUTE
 * file path on a bridge that exposes the xref methods (D3); otherwise it
 * is inert with a typed reason and never touches the broker. An unsaved
 * host is never anchored lexically (D4): the controller passes hostPath
 * only, and the core obtains host identity through the reader's identify.
 *
 * No merge, detach, unload or retype operation exists here (L5): the
 * surface is bind / reload / status / context / dispose.
 */
import type { DrawingState } from '../core/document';
import {
  collectXrefReferences,
  XrefStore,
  type XrefCommitResult,
  type XrefFailure,
  type XrefNode,
  type XrefSnapshot,
  type XrefSnapshotStats,
} from '../io/xref-loading';
import { createXrefReader, type XrefBrokerBridge, type XrefReaderHandle } from './xref-reader';
import type { FileBridge } from './editor/types';
import { buildResolvedXrefContext, type ResolvedXrefContext, type XrefSessionStamp } from './xref-resolved';

export interface XrefBinding {
  readonly docId: string;
  readonly contentGeneration: number | string;
  readonly filePath: string | null;
}

export type XrefInertReason = 'unsaved-host' | 'no-bridge';
export type XrefSessionPhase = 'idle' | 'loading' | 'ready' | 'failed';

export interface XrefNodeStatus {
  readonly blockName: string;
  readonly originalPath: string;
  /** The broker-resolved path, or null when the reference never resolved (XrefNode/XrefFailure carry string | null). */
  readonly resolvedPath: string | null;
  readonly overlay: boolean;
  readonly depth: number;
  readonly status: string;
  readonly message?: string;
  readonly unsupportedFeatures: readonly string[];
}

export interface XrefAttemptSummary {
  readonly kind: 'load' | 'refresh';
  readonly committed: boolean;
  readonly preserved: boolean;
  readonly stale: boolean;
  readonly cancelled: boolean;
  readonly failures: readonly XrefFailure[];
}

export interface XrefSessionStatus {
  readonly binding: { readonly docId: string; readonly contentGeneration: number | string; readonly hostPath: string | null };
  readonly live: boolean;
  readonly inertReason?: XrefInertReason;
  readonly phase: XrefSessionPhase;
  readonly generation: number;
  readonly nodes: readonly XrefNodeStatus[];
  readonly lastAttempt?: XrefAttemptSummary;
  readonly stats?: XrefSnapshotStats;
}

export interface XrefControllerDeps {
  /** Resolved lazily on every use, never cached (the bridge may appear later). */
  readonly bridge: () => FileBridge | null;
  readonly getBinding: () => XrefBinding | null;
  readonly getState: () => DrawingState | null;
  readonly onSnapshotChanged?: () => void;
  readonly log?: (text: string) => void;
}

const isAbsoluteCadPath = (path: string): boolean => /^([a-zA-Z]:[\\/]|\/|\\\\)/.test(path);

function brokerSubset(bridge: FileBridge): XrefBrokerBridge | null {
  const { beginXrefContext, identifyXref, readXref, cancelXref, closeXrefContext } = bridge;
  if (!beginXrefContext || !identifyXref || !readXref || !cancelXref || !closeXrefContext) return null;
  return {
    beginXrefContext: beginXrefContext.bind(bridge),
    identifyXref: identifyXref.bind(bridge),
    readXref: readXref.bind(bridge),
    cancelXref: cancelXref.bind(bridge),
    closeXrefContext: closeXrefContext.bind(bridge),
  };
}

const tripleKey = (binding: XrefBinding): string => `${binding.docId}\n${String(binding.contentGeneration)}\n${binding.filePath ?? ''}`;

export class XrefSessionController {
  readonly #deps: XrefControllerDeps;
  readonly #store = new XrefStore();
  #reader: XrefReaderHandle | null = null;
  #readerBridge: FileBridge | null = null;
  #bound: XrefBinding | null = null;
  #live = false;
  #phase: XrefSessionPhase = 'idle';
  #lastAttempt: XrefAttemptSummary | undefined;
  #abort: AbortController | null = null;
  #attemptSeq = 0;
  #inFlight: Promise<unknown> | null = null;
  #inFlightKey: string | null = null;
  #disposed = false;

  constructor(deps: XrefControllerDeps) {
    this.#deps = deps;
  }

  #gate(binding: XrefBinding): { live: true } | { live: false; reason: XrefInertReason } {
    if (!binding.filePath || !isAbsoluteCadPath(binding.filePath)) return { live: false, reason: 'unsaved-host' };
    const bridge = this.#deps.bridge();
    if (!bridge || !brokerSubset(bridge)) return { live: false, reason: 'no-bridge' };
    return { live: true };
  }

  /**
   * The single binding entry (design 1.2). Idempotent on the unchanged
   * (docId, contentGeneration, hostPath) triple while liveness is
   * unchanged; a later-appearing bridge activates the same controller.
   * On a changed path or generation the old binding is retired in the
   * design's order: abort in-flight, retarget the reader session, close
   * the store on a generation change, rebind the host, drop the derived
   * context, then schedule the initial load for the new binding.
   */
  bind(): void {
    if (this.#disposed) return;
    const binding = this.#deps.getBinding();
    if (!binding) return;
    const gate = this.#gate(binding);
    const unchanged = this.#bound !== null && tripleKey(binding) === tripleKey(this.#bound) && gate.live === this.#live;
    if (unchanged) return;
    const previous = this.#bound;
    this.#abort?.abort();
    this.#abort = null;
    if (previous && binding.filePath === previous.filePath && binding.docId === previous.docId
      && String(binding.contentGeneration) !== String(previous.contentGeneration)) {
      this.#store.close(); // same path, new content generation: the old graph must not survive (1.2 step 3)
    }
    if (gate.live) {
      this.#ensureReader(binding);
      this.#store.bindHost(binding.filePath!);
    } else if (previous) {
      this.#store.close();
    }
    this.#bound = binding;
    this.#live = gate.live;
    if (!gate.live) { this.#phase = 'idle'; return; }
    // Schedule the initial load unless an attempt for THIS binding is
    // already in flight (an in-flight attempt for a previous binding was
    // aborted above and is stale by construction).
    if (this.#store.current === null && (this.#inFlight === null || this.#inFlightKey !== tripleKey(binding))) {
      const state = this.#deps.getState();
      if (state && collectXrefReferences(state).length > 0) {
        this.#track(this.#runAttempt(), tripleKey(binding));
      }
    }
  }

  /** XREFRELOAD semantics: abort-and-restart the attempt for the active binding. Null when inert or reference-free. */
  async reload(): Promise<XrefCommitResult | null> {
    if (this.#disposed) return null;
    if (!this.#bound) this.bind();
    const binding = this.#deps.getBinding() ?? this.#bound;
    if (!binding) return null;
    const gate = this.#gate(binding);
    if (!gate.live) return null;
    if (tripleKey(binding) !== (this.#bound ? tripleKey(this.#bound) : '')) this.bind();
    this.#live = true;
    return this.#track(this.#runAttempt(), tripleKey(binding));
  }

  status(): XrefSessionStatus {
    const binding = this.#bound ?? this.#deps.getBinding();
    const gate = binding ? this.#gate(binding) : { live: false, reason: 'no-bridge' as XrefInertReason };
    const live = this.#bound ? this.#live && gate.live : gate.live;
    const snapshot = this.#store.current;
    const ctx = snapshot && live ? this.context() : null;
    const nodes: XrefNodeStatus[] = [];
    if (snapshot) {
      const flatten = (node: XrefNode): void => {
        nodes.push({
          blockName: node.blockName,
          originalPath: node.originalPath,
          resolvedPath: node.resolvedPath,
          overlay: node.overlay,
          depth: node.depth,
          status: node.status,
          ...(node.message ? { message: node.message } : {}),
          unsupportedFeatures: ctx?.unsupportedFeaturesFor(node.blockName) ?? [],
        });
        for (const child of node.children) flatten(child);
      };
      for (const node of snapshot.nodes) flatten(node);
    } else if (this.#lastAttempt) {
      for (const failure of this.#lastAttempt.failures) {
        nodes.push({
          blockName: failure.blockName,
          originalPath: failure.originalPath,
          resolvedPath: failure.resolvedPath,
          overlay: false,
          depth: failure.depth,
          status: failure.kind,
          message: failure.message,
          unsupportedFeatures: [],
        });
      }
    }
    return {
      binding: {
        docId: binding?.docId ?? '',
        contentGeneration: binding?.contentGeneration ?? 0,
        hostPath: binding?.filePath ?? null,
      },
      live,
      ...(live ? {} : { inertReason: gate.live ? (this.#bound && !this.#live ? 'no-bridge' : undefined) : gate.reason }),
      phase: this.#phase,
      generation: this.#store.generation,
      nodes,
      ...(this.#lastAttempt ? { lastAttempt: this.#lastAttempt } : {}),
      ...(snapshot ? { stats: snapshot.stats } : {}),
    };
  }

  /** The committed snapshot, or null. Identity is the store's own object. */
  snapshot(): XrefSnapshot | null {
    return this.#store.current;
  }

  /** The resolved context for the committed snapshot under the current binding stamp, or null. */
  context(): ResolvedXrefContext | null {
    if (this.#disposed || !this.#bound || !this.#live) return null;
    const snapshot = this.#store.current;
    if (!snapshot) return null;
    const state = this.#deps.getState();
    if (!state) return null;
    return buildResolvedXrefContext(snapshot, { docId: this.#bound.docId, contentGeneration: this.#bound.contentGeneration }, state);
  }

  /** Resolves when no attempt is in flight. */
  async whenIdle(): Promise<void> {
    while (this.#inFlight) {
      const current = this.#inFlight;
      await current;
      if (this.#inFlight === current) break;
    }
  }

  /** Tab close / shutdown: abort, close the store, dispose the reader. Never blocks the close path. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#abort?.abort();
    this.#store.close();
    const reader = this.#reader;
    this.#reader = null;
    this.#readerBridge = null;
    if (reader) await reader.dispose();
  }

  #ensureReader(binding: XrefBinding): XrefReaderHandle | null {
    const bridge = this.#deps.bridge();
    if (!bridge) return null;
    const subset = brokerSubset(bridge);
    if (!subset) return null;
    const session = { docId: binding.docId, contentGeneration: binding.contentGeneration, hostPath: binding.filePath! };
    if (this.#reader && this.#readerBridge === bridge) {
      this.#reader.setSession(session);
      return this.#reader;
    }
    const stale = this.#reader;
    this.#reader = createXrefReader(subset, session);
    this.#readerBridge = bridge;
    if (stale) void stale.dispose();
    return this.#reader;
  }

  #track<T>(promise: Promise<T>, key: string): Promise<T> {
    this.#inFlight = promise;
    this.#inFlightKey = key;
    const clear = (): void => { if (this.#inFlight === promise) { this.#inFlight = null; this.#inFlightKey = null; } };
    void promise.then(clear, clear);
    return promise;
  }

  async #runAttempt(): Promise<XrefCommitResult | null> {
    const binding = this.#bound;
    const state = this.#deps.getState();
    if (!binding || !state || this.#disposed) return null;
    if (collectXrefReferences(state).length === 0) return null;
    const reader = this.#ensureReader(binding);
    if (!reader) return null;
    this.#abort?.abort();
    const abort = new AbortController();
    this.#abort = abort;
    const seq = ++this.#attemptSeq;
    const kind: 'load' | 'refresh' = this.#store.current === null ? 'load' : 'refresh';
    this.#phase = 'loading';
    let result: XrefCommitResult;
    try {
      const input = { hostState: state, hostPath: binding.filePath! };
      const deps = { reader: reader.reader };
      const options = { signal: abort.signal, hostKey: binding.filePath! };
      result = kind === 'load'
        ? await this.#store.load(input, deps, { ...options, mode: 'partial' })
        : await this.#store.refresh(input, deps, options);
    } catch {
      if (seq === this.#attemptSeq && !this.#disposed) this.#phase = this.#store.current ? 'ready' : 'failed';
      return null;
    }
    if (seq === this.#attemptSeq && !this.#disposed) {
      this.#lastAttempt = {
        kind,
        committed: result.committed,
        preserved: result.preserved,
        stale: result.stale,
        cancelled: result.cancelled,
        failures: result.failures,
      };
      this.#phase = this.#store.current ? 'ready' : 'failed';
      if (result.committed) {
        this.#deps.log?.(`xref: ${kind === 'load' ? 'loaded' : 'reloaded'} ${result.current?.stats.filesLoaded ?? 0} file(s), generation ${this.#store.generation}`);
        this.#deps.onSnapshotChanged?.();
      }
    }
    return result;
  }
}

export interface XrefRegistryDeps {
  readonly bridge: () => FileBridge | null;
  readonly getBinding: (docId: string) => XrefBinding | null;
  readonly getState: (docId: string) => DrawingState | null;
  readonly onSnapshotChanged?: (docId: string) => void;
  readonly log?: (text: string) => void;
}

/** Per-document registry (design 1.1): the editor owns one; controllers are created lazily per document. */
export class XrefSessionRegistry {
  readonly #deps: XrefRegistryDeps;
  readonly #controllers = new Map<string, XrefSessionController>();

  constructor(deps: XrefRegistryDeps) {
    this.#deps = deps;
  }

  bind(docId: string): XrefSessionController {
    let controller = this.#controllers.get(docId);
    if (!controller) {
      controller = new XrefSessionController({
        bridge: this.#deps.bridge,
        getBinding: () => this.#deps.getBinding(docId),
        getState: () => this.#deps.getState(docId),
        onSnapshotChanged: this.#deps.onSnapshotChanged ? () => this.#deps.onSnapshotChanged!(docId) : undefined,
        log: this.#deps.log,
      });
      this.#controllers.set(docId, controller);
    }
    controller.bind();
    return controller;
  }

  controller(docId: string): XrefSessionController | undefined {
    return this.#controllers.get(docId);
  }

  statusFor(docId: string): XrefSessionStatus | undefined {
    return this.#controllers.get(docId)?.status();
  }

  /**
   * The display/plot provider seam (design 3.4): the context for exactly
   * this session stamp, or null — a stamp mismatch proceeds with NO
   * context (placeholders), never with another document's graph.
   */
  currentContextFor(stamp: XrefSessionStamp): ResolvedXrefContext | null {
    const controller = this.#controllers.get(stamp.docId);
    if (!controller) return null;
    const context = controller.context();
    if (!context) return null;
    if (context.stamp.docId !== stamp.docId || String(context.stamp.contentGeneration) !== String(stamp.contentGeneration)) return null;
    return context;
  }

  async dispose(docId: string): Promise<void> {
    const controller = this.#controllers.get(docId);
    if (!controller) return;
    this.#controllers.delete(docId);
    await controller.dispose();
  }

  async disposeAll(): Promise<void> {
    const all = [...this.#controllers.values()];
    this.#controllers.clear();
    await Promise.all(all.map((controller) => controller.dispose()));
  }
}
