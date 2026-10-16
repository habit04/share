import { AI_MAX_QUESTION_CHARS, AI_MAX_SNAPSHOT_BYTES } from './limits';
import { AiError, type AiAnswer, type AiAskRequest, type AiProvider } from './types';

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
 * The narrow host bridge a future preload registration would provide.
 * The bridge must forward cancellation to the sender-scoped host, removing
 * queued jobs and aborting running work. An AbortSignal itself cannot cross
 * Electron IPC: a future preload must translate it to host.cancel(requestId).
 * This milestone registers neither channel.
 */
export interface AiHostBridge {
  ask(request: AiAskRequest, signal: AbortSignal): Promise<AiAnswer>;
}

/** Non-secret configuration only. Endpoint and credentials stay host-side. */
export interface LiveProviderConfig {
  readonly providerId: string;
  readonly model: string;
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
    if (request.snapshot.serializedBytes > AI_MAX_SNAPSHOT_BYTES) {
      throw new AiError('invalid-answer', 'The snapshot exceeds the permitted size.');
    }
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new AiError('cancelled', 'The request was cancelled.'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      if (signal.aborted) throw new AiError('cancelled', 'The request was cancelled.');
      return await Promise.race([this.bridge.ask(request, signal), aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
