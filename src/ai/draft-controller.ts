import { newId } from '../core/entities';
import { captureDraftContext, draftBindingNow, type AiDraftCapture, type AiDraftSource } from './draft-context';
import { compileAiPlan, type CompiledProposal } from './draft-compiler';
import { applyCompiledProposal } from './draft-apply';
import type { Drawing } from '../core/document';
import {
  aiDraftBindingsEqual,
  AiError,
  mintAiRequestId,
  type AiDraftProvider,
  type AiDraftRequest,
} from './types';
import { AI_DEFAULT_TIMEOUT_MS } from './limits';

/**
 * Owns the Draft/Edit staging lifecycle (docs/AI-ASSISTANT-M3.md). A proposal
 * is compiled once from the captured state and staged; the same compiled
 * artifact feeds the preview and Apply. Anything that changes the bound
 * context — edits, selection, settings, provider, prompt, mode, a newer
 * request, cancellation — invalidates the staged proposal; Apply re-reads
 * the authoritative binding immediately before the synchronous commit and
 * discards (never rebases) a stale proposal.
 */

export type AiDraftStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'generating'; readonly requestId: string }
  | { readonly state: 'staged'; readonly requestId: string; readonly capture: AiDraftCapture; readonly proposal: CompiledProposal }
  | { readonly state: 'message'; readonly requestId: string; readonly kind: 'clarification' | 'unsupported'; readonly message: string }
  | { readonly state: 'invalidated'; readonly message: string }
  | { readonly state: 'error'; readonly requestId: string; readonly error: AiError };

export interface AiDraftControllerOptions {
  readonly timeoutMs?: number;
  readonly setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
  /** Applies a compiled proposal to the live drawing (defaults to the real boundary). */
  readonly applyFn?: (capture: AiDraftCapture, proposal: CompiledProposal) => void;
}

const STALE_MESSAGE = 'The drawing or settings changed — generate again.';

export class AiDraftController {
  private readonly timeoutMs: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly applyFn: (capture: AiDraftCapture, proposal: CompiledProposal) => void;
  private readonly listeners = new Set<(status: AiDraftStatus) => void>();
  private currentStatus: AiDraftStatus = { state: 'idle' };
  private epoch = 0;
  private pending: { requestId: string; abort: AbortController; timer: unknown } | null = null;
  private applying = false;
  private disposed = false;

  constructor(
    private readonly source: AiDraftSource,
    private readonly doc: Drawing | null,
    options: AiDraftControllerOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? AI_DEFAULT_TIMEOUT_MS;
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.applyFn = options.applyFn ?? ((capture, proposal) => {
      if (!this.doc) throw new AiError('host-unavailable', 'No drawing is available to apply to.');
      applyCompiledProposal(this.doc, capture, proposal);
    });
  }

  get status(): AiDraftStatus { return this.currentStatus; }

  subscribe(listener: (status: AiDraftStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(status: AiDraftStatus): void {
    this.currentStatus = status;
    for (const listener of [...this.listeners]) {
      if (this.disposed || this.currentStatus !== status) break;
      try { listener(status); } catch { /* A subscriber must not strand the lifecycle. */ }
    }
  }

  /** Drop any staged proposal and cancel in-flight generation. */
  invalidate(message: string = STALE_MESSAGE): void {
    this.epoch += 1;
    if (this.pending) {
      this.clearTimeoutFn(this.pending.timer);
      this.pending.abort.abort();
      this.pending = null;
    }
    if (this.currentStatus.state === 'staged' || this.currentStatus.state === 'generating') {
      this.emit({ state: 'invalidated', message });
    } else if (this.currentStatus.state !== 'idle') {
      this.emit({ state: 'idle' });
    }
  }

  /** Discard a staged proposal at the user's request (no message). */
  discard(): void {
    this.invalidate();
    if (this.currentStatus.state === 'invalidated') this.emit({ state: 'idle' });
  }

  cancel(): void {
    if (this.currentStatus.state === 'generating') {
      this.invalidate();
      this.emit({ state: 'idle' });
    }
  }

  async generate(prompt: string, provider: AiDraftProvider, configKey: string): Promise<AiDraftStatus> {
    if (this.disposed) return this.currentStatus;
    if (this.source.interactionBusy()) {
      const error = new AiError('busy', 'Finish the current command or selection first, then generate a preview.');
      this.emit({ state: 'error', requestId: '', error });
      return this.currentStatus;
    }
    this.invalidate();
    const myEpoch = ++this.epoch;
    let capture: AiDraftCapture;
    try {
      capture = captureDraftContext(this.source, prompt, configKey);
    } catch (cause) {
      const error = cause instanceof AiError ? cause : new AiError('invalid-context', 'The draft context could not be captured.');
      this.emit({ state: 'error', requestId: '', error });
      return this.currentStatus;
    }
    const requestId = mintAiRequestId();
    const abort = new AbortController();
    const timer = this.setTimeoutFn(() => abort.abort(), this.timeoutMs);
    this.pending = { requestId, abort, timer };
    this.emit({ state: 'generating', requestId });
    const request: AiDraftRequest = {
      requestId,
      prompt: capture.prompt,
      contextJson: capture.contextJson,
      binding: capture.binding,
    };
    try {
      const response = await provider.draft(request, abort.signal);
      if (this.disposed || this.epoch !== myEpoch) return this.currentStatus;
      // The drawing may have changed while the provider worked: re-check the
      // binding before staging anything.
      const now = draftBindingNow(this.source, configKey);
      if (!aiDraftBindingsEqual(now, capture.binding)) {
        this.emit({ state: 'invalidated', message: STALE_MESSAGE });
        return this.currentStatus;
      }
      if (response.kind !== 'plan') {
        this.emit({ state: 'message', requestId, kind: response.kind, message: response.message });
        return this.currentStatus;
      }
      const compiled = compileAiPlan(response.plan, capture, () => newId(), (e) => this.source.boundsFor(e));
      if (!compiled.ok) {
        this.emit({ state: 'error', requestId, error: new AiError('invalid-plan', compiled.error) });
        return this.currentStatus;
      }
      this.emit({ state: 'staged', requestId, capture, proposal: compiled.proposal });
      return this.currentStatus;
    } catch (cause) {
      if (this.disposed || this.epoch !== myEpoch) return this.currentStatus;
      if (abort.signal.aborted) {
        this.emit({ state: 'idle' });
        return this.currentStatus;
      }
      const error = cause instanceof AiError ? cause : new AiError('provider-failure', 'The draft provider failed.');
      this.emit({ state: 'error', requestId, error });
      return this.currentStatus;
    } finally {
      this.clearTimeoutFn(timer);
      if (this.pending?.requestId === requestId) this.pending = null;
    }
  }

  /**
   * Commit the staged proposal as one atomic edit. Re-reads the binding
   * immediately before the synchronous commit; a stale proposal is
   * discarded with an explanation, never rebased.
   */
  apply(): AiDraftStatus {
    if (this.disposed) return this.currentStatus;
    if (this.applying) return this.currentStatus; // reentrant / double-click guard
    const staged = this.currentStatus;
    if (staged.state !== 'staged') return this.currentStatus;
    if (this.source.interactionBusy()) {
      // Refuse silently: the staged proposal survives and the panel shows
      // its own busy hint (it also disables Apply while busy).
      return this.currentStatus;
    }
    const now = draftBindingNow(this.source, staged.capture.binding.configKey);
    if (!aiDraftBindingsEqual(now, staged.capture.binding)) {
      this.epoch += 1;
      this.emit({ state: 'invalidated', message: STALE_MESSAGE });
      return this.currentStatus;
    }
    this.applying = true;
    try {
      this.applyFn(staged.capture, staged.proposal);
    } catch (cause) {
      const error = cause instanceof AiError ? cause : new AiError('invalid-plan', cause instanceof Error ? cause.message : 'The proposal could not be applied.');
      this.emit({ state: 'error', requestId: staged.requestId, error });
      return this.currentStatus;
    } finally {
      this.applying = false;
    }
    // Consume the proposal: it can never be applied twice.
    this.epoch += 1;
    this.emit({ state: 'idle' });
    return this.currentStatus;
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
    this.listeners.clear();
  }
}
