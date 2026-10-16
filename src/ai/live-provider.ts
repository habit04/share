import { AI_DRAFT_MAX_CONTEXT_BYTES, AI_MAX_QUESTION_CHARS, AI_MAX_SNAPSHOT_BYTES } from './limits';
import { parseAiDraftResponse, type AiDraftResponse } from './draft-plan';
import {
  AiError,
  type AiAnswer,
  type AiAskRequest,
  type AiDraftProvider,
  type AiDraftRefineRequest,
  type AiDraftRequest,
  type AiProvider,
  type AiUsage,
} from './types';

/**
 * Live provider adapter (milestone 2, docs/AI-ASSISTANT-M2.md). The panel
 * constructs this over the guarded host bridge (`src/ai/host-bridge.ts`)
 * when the Electron preload exposes one; the host owns configuration,
 * credentials and the network. The adapter can only talk through the
 * injected bridge (the renderer cannot reach the network — the page CSP
 * has no connect-src), carries no endpoint or key material, and an
 * incompletely configured instance refuses every request with
 * 'provider-not-configured'. In a plain browser (no bridge) it stays
 * inactive exactly as in milestone 1.
 */

/**
 * The narrow registered host bridge.
 * The bridge must forward cancellation to the sender-scoped host, removing
 * queued jobs and aborting running work. An AbortSignal itself cannot cross
 * Electron IPC: WindowAiConnection translates it to host.cancel(requestId).
 */
export interface AiHostBridge {
  ask(request: AiAskRequest, signal: AbortSignal): Promise<AiAnswer>;
  /**
   * Milestone 3: optional because a host without drafting support must
   * refuse cleanly ('host-unavailable'), never fall back to ask.
   */
  draft?(request: AiDraftRequest, signal: AbortSignal): Promise<AiDraftWireResult>;
  /**
   * Milestone 4: optional because a host without refinement support must
   * refuse cleanly ('host-unavailable'), never fall back to draft or ask.
   */
  draftRefine?(request: AiDraftRefineRequest, signal: AbortSignal): Promise<AiDraftWireResult>;
}

/**
 * What the bridge returns for a draft: the host-validated response value
 * (still untrusted here — LiveDraftProvider applies the plan contract)
 * plus usage counters when the host reported them.
 */
export interface AiDraftWireResult {
  readonly response: unknown;
  readonly configGeneration?: string;
  readonly usage?: AiUsage;
}

/** Non-secret configuration only. Endpoint and credentials stay host-side. */
export interface LiveProviderConfig {
  readonly providerId: string;
  readonly model: string;
  readonly configGeneration?: string;
}

export class LiveProvider implements AiProvider {
  readonly id: string;
  private readonly bridge?: AiHostBridge;
  private readonly config?: LiveProviderConfig;

  constructor(bridge?: AiHostBridge, config?: LiveProviderConfig) {
    this.bridge = bridge;
    this.config = config ? { ...config } : undefined;
    this.id = config?.providerId ?? 'live-unconfigured';
  }

  /** True only when a host bridge and a complete agreed config are present. */
  get configured(): boolean {
    return this.bridge !== undefined
      && this.config !== undefined
      && this.config.providerId.length > 0
      && this.config.model.length > 0;
  }

  async ask(request: AiAskRequest, signal: AbortSignal): Promise<AiAnswer> {
    if (!this.configured || !this.bridge) {
      throw new AiError(
        'provider-not-configured',
        'No live AI provider has been selected. The live adapter is inactive until a provider, endpoint, credentials and data handling are agreed.',
      );
    }
    if (signal.aborted) throw new AiError('cancelled', 'The request was cancelled.');
    // Defence in depth: the host re-validates everything, but an out-of-bound
    // envelope is refused here rather than handed to the bridge at all.
    if (request.question.length > AI_MAX_QUESTION_CHARS) {
      throw new AiError('invalid-question', 'The question exceeds the permitted length.');
    }
    if (new TextEncoder().encode(JSON.stringify(request.snapshot)).length > AI_MAX_SNAPSHOT_BYTES) {
      throw new AiError('invalid-context', 'The snapshot exceeds the permitted size.');
    }
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new AiError('cancelled', 'The request was cancelled.'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      if (signal.aborted) throw new AiError('cancelled', 'The request was cancelled.');
      const pinned = { ...request, destination: { provider: this.config!.providerId, model: this.config!.model } };
      return await Promise.race([this.bridge.ask(pinned, signal), aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Live draft provider (milestone 3, docs/AI-ASSISTANT-M3.md): the draft
 * twin of LiveProvider. It pins the same destination from its config, the
 * host rejects mismatches, and the returned value is validated against
 * the plan contract here before the draft controller may stage it. A
 * bridge without a draft method means the host predates drafting: that is
 * 'host-unavailable', never a silent fallback to the ask path.
 */
export class LiveDraftProvider implements AiDraftProvider {
  readonly id: string;
  private readonly bridge?: AiHostBridge;
  private readonly config?: LiveProviderConfig;

  constructor(bridge?: AiHostBridge, config?: LiveProviderConfig) {
    this.bridge = bridge;
    this.config = config ? { ...config } : undefined;
    this.id = config?.providerId ?? 'live-unconfigured';
  }

  /** True only when a host bridge with draft support and a complete agreed config are present. */
  get configured(): boolean {
    return this.bridge !== undefined
      && typeof this.bridge.draft === 'function'
      && this.config !== undefined
      && this.config.providerId.length > 0
      && this.config.model.length > 0
      && typeof this.config.configGeneration === 'string'
      && this.config.configGeneration.length > 0;
  }

  async draft(request: AiDraftRequest, signal: AbortSignal): Promise<AiDraftResponse> {
    if (!this.bridge || typeof this.bridge.draft !== 'function') {
      throw new AiError(
        'host-unavailable',
        'The AI host does not support drafting. Update the application and try again.',
      );
    }
    if (!this.config || this.config.providerId.length === 0 || this.config.model.length === 0) {
      throw new AiError(
        'provider-not-configured',
        'No live AI provider has been selected. The live adapter is inactive until a provider, endpoint, credentials and data handling are agreed.',
      );
    }
    if (!this.config.configGeneration) {
      throw new AiError('host-unavailable', 'The AI host cannot verify its current connection settings. Reopen the panel or update JCad before drafting.');
    }
    if (signal.aborted) throw new AiError('cancelled', 'The request was cancelled.');
    // Defence in depth: the host re-validates everything, but an
    // out-of-bound envelope is refused here rather than handed over.
    if (request.prompt.length > AI_MAX_QUESTION_CHARS) {
      throw new AiError('invalid-question', 'The draft prompt exceeds the permitted length.');
    }
    if (new TextEncoder().encode(request.contextJson).length > AI_DRAFT_MAX_CONTEXT_BYTES) {
      throw new AiError('invalid-context', 'The draft context exceeds the permitted size.');
    }
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new AiError('cancelled', 'The request was cancelled.'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      if (signal.aborted) throw new AiError('cancelled', 'The request was cancelled.');
      // Only the wire fields cross: the parsed context object and the
      // local byte count are renderer bookkeeping the host validator
      // would (and must) ignore anyway.
      const pinned = {
        requestId: request.requestId,
        prompt: request.prompt,
        contextJson: request.contextJson,
        binding: request.binding,
        destination: { provider: this.config.providerId, model: this.config.model, configGeneration: this.config.configGeneration },
      };
      const result = await Promise.race([this.bridge.draft(pinned, signal), aborted]);
      if (result?.configGeneration !== this.config.configGeneration) {
        throw new AiError('stale', 'The AI connection settings changed — generate again.');
      }
      const parsed = parseAiDraftResponse(result?.response);
      if (!parsed.ok) throw new AiError('invalid-plan', parsed.error);
      return parsed.response;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Milestone 4: one refinement of the staged preview. Mirrors draft():
   * the bridge must carry a draftRefine method (an older host refuses
   * with 'host-unavailable', never a fallback to draft/ask), the
   * destination — including the verified configuration generation — is
   * pinned from this instance's config, the returned configuration
   * generation must match, and the returned value passes the same plan
   * contract before the draft controller may stage the replacement.
   * Refinement availability is checked here, at call time: `configured`
   * keeps its draft meaning for panel routing.
   */
  async refine(request: AiDraftRefineRequest, signal: AbortSignal): Promise<AiDraftResponse> {
    if (!this.bridge || typeof this.bridge.draftRefine !== 'function') {
      throw new AiError(
        'host-unavailable',
        'The AI host does not support preview refinement. Update the application and try again.',
      );
    }
    if (!this.config || this.config.providerId.length === 0 || this.config.model.length === 0) {
      throw new AiError(
        'provider-not-configured',
        'No live AI provider has been selected. The live adapter is inactive until a provider, endpoint, credentials and data handling are agreed.',
      );
    }
    if (!this.config.configGeneration) {
      throw new AiError('host-unavailable', 'The AI host cannot verify its current connection settings. Reopen the panel or update JCad before refining.');
    }
    if (signal.aborted) throw new AiError('cancelled', 'The request was cancelled.');
    // Defence in depth: the host re-validates everything, but an
    // out-of-bound follow-up or envelope is refused here, not handed over.
    if (request.followUp.length > AI_MAX_QUESTION_CHARS) {
      throw new AiError('invalid-question', 'The follow-up instruction exceeds the permitted length.');
    }
    if (new TextEncoder().encode(request.envelopeJson).length > AI_DRAFT_MAX_CONTEXT_BYTES) {
      throw new AiError('invalid-context', 'The refinement context exceeds the permitted size.');
    }
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new AiError('cancelled', 'The request was cancelled.'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      if (signal.aborted) throw new AiError('cancelled', 'The request was cancelled.');
      // Only the wire fields cross, exactly as for drafts.
      const pinned: AiDraftRefineRequest = {
        requestId: request.requestId,
        followUp: request.followUp,
        envelopeJson: request.envelopeJson,
        binding: request.binding,
        destination: { provider: this.config.providerId, model: this.config.model, configGeneration: this.config.configGeneration },
      };
      const result = await Promise.race([this.bridge.draftRefine(pinned, signal), aborted]);
      if (result?.configGeneration !== this.config.configGeneration) {
        throw new AiError('stale', 'The AI connection settings changed — generate again.');
      }
      const parsed = parseAiDraftResponse(result?.response);
      if (!parsed.ok) throw new AiError('invalid-plan', parsed.error);
      return parsed.response;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
