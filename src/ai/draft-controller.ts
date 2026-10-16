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
import { validateAiDraftResponse } from './draft-plan';
import { buildRefineEnvelope } from './draft-refine';
import type { AiDraftRefineRequest } from './types';

/** How an in-flight refinement ends (milestone 4). */
type RefineOutcome =
  | { readonly type: 'success'; readonly requestId: string; readonly proposal: CompiledProposal }
  | { readonly type: 'message'; readonly requestId: string; readonly kind: 'clarification' | 'unsupported'; readonly message: string }
  | { readonly type: 'failure'; readonly message: string }
  | { readonly type: 'cancelled' }
  | { readonly type: 'stale' }
  | { readonly type: 'dropped' };

/**
 * Owns the Draft/Edit staging lifecycle (docs/AI-ASSISTANT-M3.md). A proposal
 * is compiled once from the captured state and staged; the same compiled
 * artifact feeds the preview and Apply. Anything that changes the bound
 * context — edits, selection, settings, provider, prompt, mode, a newer
 * request, cancellation — invalidates the staged proposal; Apply re-reads
 * the authoritative binding immediately before the synchronous commit and
 * discards (never rebases) a stale proposal.
 */

/**
 * A follow-up instruction attached to a staged preview (milestone 4). While
 * any follow-up is present and unresolved, Apply is blocked: the user must
 * refine it into a new accepted preview or discard it (which re-validates
 * the staged preview against fresh state before restoring applicability).
 */
export interface AiDraftFollowUp {
  readonly text: string;
  readonly phase: 'entered' | 'refining' | 'clarification' | 'unsupported' | 'failed';
  readonly message?: string;
}

export type AiDraftStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'generating'; readonly requestId: string }
  | { readonly state: 'staged'; readonly requestId: string; readonly capture: AiDraftCapture; readonly proposal: CompiledProposal;
      /** Preview version within the session: 1 for the initial generation, +1 per accepted refinement. */
      readonly version: number; readonly followUp: AiDraftFollowUp | null }
  | { readonly state: 'message'; readonly requestId: string; readonly kind: 'clarification' | 'unsupported'; readonly message: string }
  | { readonly state: 'invalidated'; readonly message: string }
  | { readonly state: 'error'; readonly requestId: string; readonly error: AiError };

export interface AiDraftControllerOptions {
  readonly timeoutMs?: number;
  readonly setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
  /** Applies a compiled proposal to the live drawing (defaults to the real boundary). */
  readonly applyFn?: (capture: AiDraftCapture, proposal: CompiledProposal) => void;
  /** Fresh provider/model/configuration generation, read at admission, settlement and Apply. */
  readonly configKeyNow?: () => string;
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
  private pending: {
    requestId: string; abort: AbortController; timer: unknown; settled: boolean;
    finish: (status: AiDraftStatus, publish?: boolean) => void;
    /** Milestone 4: set on refinement jobs so their settlement can be driven directly. */
    refineSettle?: (outcome: RefineOutcome) => void;
  } | null = null;
  private applying = false;
  private disposed = false;
  private readonly configKeyNow?: () => string;

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
    this.configKeyNow = options.configKeyNow;
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
      const pending = this.pending;
      pending.finish({ state: 'idle' }, false);
      pending.abort.abort();
    }
    if (this.currentStatus.state === 'staged' || this.currentStatus.state === 'generating') {
      this.emit({ state: 'invalidated', message });
    } else if (this.currentStatus.state !== 'idle') {
      this.emit({ state: 'idle' });
    }
  }

  /** Discard a staged proposal at the user's request (no message). */
  discard(): void {
    const nextEpoch = this.epoch + 1;
    this.invalidate();
    if (this.epoch === nextEpoch && this.currentStatus.state === 'invalidated') this.emit({ state: 'idle' });
  }

  cancel(): void {
    if (this.currentStatus.state === 'generating') {
      const nextEpoch = this.epoch + 1;
      this.invalidate();
      if (this.epoch === nextEpoch) this.emit({ state: 'idle' });
    }
  }

  async generate(prompt: string, provider: AiDraftProvider, configKey: string): Promise<AiDraftStatus> {
    if (this.disposed) return { state: 'error', requestId: '', error: new AiError('disposed', 'The AI assistant has been closed.') };
    if (this.applying) return { state: 'idle' };
    const myEpoch = this.epoch + 1;
    this.invalidate();
    if (this.epoch !== myEpoch || this.disposed) return { state: 'idle' };
    let capture: AiDraftCapture;
    try {
      if (this.source.interactionBusy()) throw new AiError('busy', 'Finish the current command or selection first, then generate a preview.');
      if (this.configKeyNow && this.configKeyNow() !== configKey) throw new AiError('stale', STALE_MESSAGE);
      capture = captureDraftContext(this.source, prompt, configKey);
    } catch (cause) {
      const error = cause instanceof AiError ? cause : new AiError('invalid-context', 'The draft context could not be captured.');
      this.emit({ state: 'error', requestId: '', error });
      return this.currentStatus;
    }
    if (this.epoch !== myEpoch || this.disposed) return { state: 'idle' };
    const requestId = mintAiRequestId();
    return new Promise<AiDraftStatus>((resolve) => {
      const abort = new AbortController();
      const pending: NonNullable<AiDraftController['pending']> = {
        requestId, abort, timer: null, settled: false,
        finish: (status, publish = true) => {
          if (pending.settled) return;
          pending.settled = true;
          if (pending.timer !== null) {
            try { this.clearTimeoutFn(pending.timer); } catch { /* Cleanup must not strand settlement. */ }
            pending.timer = null;
          }
          const current = this.pending === pending;
          if (current) this.pending = null;
          resolve(status);
          if (publish && current && !this.disposed && this.epoch === myEpoch) this.emit(status);
        },
      };
      this.pending = pending;
      const contextCurrent = (): boolean => this.source.modelState() === capture.state
        && !this.source.interactionBusy()
        && aiDraftBindingsEqual(draftBindingNow(this.source, this.configKeyNow?.() ?? configKey), capture.binding);
      const contextFailure = (cause: unknown): void => pending.finish({ state: 'error', requestId,
        error: cause instanceof AiError ? cause : new AiError('invalid-context', 'The draft context could not be checked.') });
      try {
        pending.timer = this.setTimeoutFn(() => {
          pending.finish({ state: 'error', requestId, error: new AiError('timeout', 'The draft provider did not answer in time.') });
          abort.abort();
        }, this.timeoutMs);
        if (pending.settled) {
          try { this.clearTimeoutFn(pending.timer); } catch { /* Synchronously fired test timer. */ }
          return;
        }
        this.emit({ state: 'generating', requestId });
        if (pending.settled || this.disposed || this.epoch !== myEpoch) return;
        if (!contextCurrent()) {
          pending.finish({ state: 'invalidated', message: STALE_MESSAGE });
          return;
        }
        if (pending.settled || this.disposed || this.epoch !== myEpoch) return;
        const request: AiDraftRequest = { requestId, prompt: capture.prompt, contextJson: capture.contextJson, binding: capture.binding };
        let work: ReturnType<AiDraftProvider['draft']>;
        try { work = provider.draft(request, abort.signal); } catch (cause) {
          pending.finish({ state: 'error', requestId, error: cause instanceof AiError ? cause : new AiError('provider-failure', 'The draft provider failed.') });
          return;
        }
        Promise.resolve(work).then((value: unknown) => {
          if (pending.settled) return;
          try {
            if (!contextCurrent()) {
              pending.finish({ state: 'invalidated', message: STALE_MESSAGE });
              return;
            }
          } catch (cause) { contextFailure(cause); return; }
          const parsed = validateAiDraftResponse(value);
          if (!parsed.ok) {
            pending.finish({ state: 'error', requestId, error: new AiError('invalid-plan', parsed.error) });
            return;
          }
          const response = parsed.response;
          if (response.kind !== 'plan') {
            pending.finish({ state: 'message', requestId, kind: response.kind, message: response.message });
            return;
          }
          const compiled = compileAiPlan(response.plan, capture, () => newId(), (e) => this.source.boundsFor(e));
          if (!compiled.ok) {
            pending.finish({ state: 'error', requestId, error: new AiError('invalid-plan', compiled.error) });
            return;
          }
          // Compilation/bounds callbacks are local, but may synchronously change
          // the editor. Never stage their result against a different context.
          try {
            if (!contextCurrent()) { pending.finish({ state: 'invalidated', message: STALE_MESSAGE }); return; }
          } catch (cause) { contextFailure(cause); return; }
          pending.finish({ state: 'staged', requestId, capture, proposal: compiled.proposal, version: 1, followUp: null });
        }, (cause: unknown) => pending.finish({ state: 'error', requestId,
          error: cause instanceof AiError ? cause : new AiError('provider-failure', 'The draft provider failed.') }));
      } catch (cause) {
        contextFailure(cause);
        abort.abort();
      }
    });
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
    // An unresolved follow-up blocks Apply: the user is looking at a
    // preview that does not include what they just asked for.
    if (staged.followUp) return this.currentStatus;
    this.applying = true;
    try {
      if (this.source.interactionBusy()) return this.currentStatus;
      const now = draftBindingNow(this.source, this.configKeyNow?.() ?? staged.capture.binding.configKey);
      if (this.source.modelState() !== staged.capture.state || !aiDraftBindingsEqual(now, staged.capture.binding)) {
        this.epoch += 1;
        this.emit({ state: 'invalidated', message: STALE_MESSAGE });
        return this.currentStatus;
      }
      // Consume before entering document listeners. They may invalidate or
      // re-enter the controller while the synchronous transaction emits.
      this.epoch += 1;
      this.currentStatus = { state: 'idle' };
      this.applyFn(staged.capture, staged.proposal);
    } catch (cause) {
      const error = cause instanceof AiError ? cause : new AiError('invalid-plan', 'The proposal could not be applied.');
      this.emit({ state: 'error', requestId: staged.requestId, error });
      return this.currentStatus;
    } finally {
      this.applying = false;
    }
    // Consume the proposal: it can never be applied twice.
    if (!this.disposed) this.emit({ state: 'idle' });
    return this.currentStatus;
  }

  // ---- Milestone 4: follow-up refinement of the staged preview ----

  /**
   * Record follow-up text typed against the staged preview. Any unresolved
   * follow-up blocks Apply. Editing the text while a refinement is in
   * flight supersedes (cancels) that refinement; the previous preview and
   * the new text are kept.
   */
  followUpEdited(text: string): void {
    let staged = this.currentStatus;
    if (staged.state !== 'staged') return;
    if (staged.followUp?.phase === 'refining') {
      this.cancelRefine();
      staged = this.currentStatus;
      if (staged.state !== 'staged') return;
    }
    const trimmed = typeof text === 'string' ? text.trim() : '';
    const previous = staged.followUp;
    if (!trimmed && (!previous || previous.phase === 'entered')) {
      if (previous) this.emit({ ...staged, followUp: null });
      return;
    }
    const keepPhase = previous && previous.phase !== 'entered' ? previous.phase : 'entered';
    this.emit({
      ...staged,
      followUp: {
        text: trimmed || previous?.text || '',
        phase: keepPhase,
        ...(keepPhase !== 'entered' && previous?.message ? { message: previous.message } : {}),
      },
    });
  }

  /** Cancel an in-flight refinement; the previous preview and follow-up text stay. */
  cancelRefine(): void {
    if (this.pending?.refineSettle) this.pending.refineSettle({ type: 'cancelled' });
  }

  /**
   * Abandon the follow-up and return to the staged preview. Applicability
   * is restored only after fresh document/configuration checks confirm the
   * preview is still valid; if they fail, the whole session is stale and
   * is invalidated instead of silently restored.
   */
  discardFollowUp(): AiDraftStatus {
    const staged = this.currentStatus;
    if (staged.state !== 'staged' || !staged.followUp) return this.currentStatus;
    if (this.pending?.refineSettle) this.pending.refineSettle({ type: 'dropped' });
    let stillValid = false;
    try {
      const now = draftBindingNow(this.source, this.configKeyNow?.() ?? staged.capture.binding.configKey);
      stillValid = this.source.modelState() === staged.capture.state
        && !this.source.interactionBusy()
        && aiDraftBindingsEqual(now, staged.capture.binding);
    } catch { stillValid = false; }
    if (!stillValid) {
      this.epoch += 1;
      this.emit({ state: 'invalidated', message: STALE_MESSAGE });
      return this.currentStatus;
    }
    const current = this.currentStatus;
    if (current.state === 'staged') this.emit({ ...current, followUp: null });
    return this.currentStatus;
  }

  /**
   * Run ONE refinement request for the staged preview: the provider returns
   * a complete replacement plan, which is compiled against the ORIGINAL
   * capture (never the previous preview, never a newer drawing). Success
   * replaces the staged proposal atomically and bumps the preview version;
   * clarification, failure or cancellation preserve the previous preview
   * with the follow-up left unresolved (Apply stays blocked).
   */
  async refine(followUpText: string, provider: AiDraftProvider, configKey: string): Promise<AiDraftStatus> {
    if (this.disposed) return { state: 'error', requestId: '', error: new AiError('disposed', 'The AI assistant has been closed.') };
    if (this.applying) return this.currentStatus;
    const staged = this.currentStatus;
    if (staged.state !== 'staged') return this.currentStatus;
    if (this.pending?.refineSettle) {
      // A newer refinement supersedes the pending one.
      const superseded = this.pending;
      superseded.refineSettle?.({ type: 'dropped' });
      superseded.abort.abort();
    }
    if (this.source.interactionBusy()) return this.currentStatus;
    if (!provider.refine) {
      this.emit({ ...staged, followUp: { text: typeof followUpText === 'string' ? followUpText.trim() : '', phase: 'failed', message: 'The selected provider cannot refine previews.' } });
      return this.currentStatus;
    }
    if (this.configKeyNow && this.configKeyNow() !== configKey) {
      this.invalidate(STALE_MESSAGE);
      return this.currentStatus;
    }
    let envelopeJson: string;
    let followUp: string;
    try {
      const built = buildRefineEnvelope(staged.capture, staged.proposal, followUpText);
      envelopeJson = built.envelopeJson;
      followUp = built.followUp;
    } catch (cause) {
      const error = cause instanceof AiError ? cause : new AiError('invalid-context', 'The refinement context could not be built.');
      this.emit({ ...staged, followUp: { text: typeof followUpText === 'string' ? followUpText.trim() : '', phase: 'failed', message: error.message } });
      return this.currentStatus;
    }
    const capture = staged.capture;
    const myEpoch = this.epoch + 1;
    this.epoch = myEpoch;
    const requestId = mintAiRequestId();
    this.emit({ ...staged, followUp: { text: followUp, phase: 'refining' } });
    return new Promise<AiDraftStatus>((resolve) => {
      const abort = new AbortController();
      const pending: NonNullable<AiDraftController['pending']> = {
        requestId, abort, timer: null, settled: false,
        finish: () => { settleRefine({ type: 'dropped' }); },
      };
      const settleRefine = (outcome: RefineOutcome): void => {
        if (pending.settled) return;
        pending.settled = true;
        if (pending.timer !== null) {
          try { this.clearTimeoutFn(pending.timer); } catch { /* Cleanup must not strand settlement. */ }
          pending.timer = null;
        }
        if (this.pending === pending) this.pending = null;
        if (outcome.type === 'dropped') { resolve(this.currentStatus); return; }
        if (outcome.type === 'stale' || this.disposed) {
          if (!this.disposed) this.emit({ state: 'invalidated', message: STALE_MESSAGE });
          resolve(this.currentStatus);
          return;
        }
        const current = this.currentStatus;
        if (current.state !== 'staged' || current.capture !== capture) { resolve(this.currentStatus); return; }
        if (outcome.type === 'success') {
          this.emit({ state: 'staged', requestId: outcome.requestId, capture, proposal: outcome.proposal, version: current.version + 1, followUp: null });
        } else if (outcome.type === 'message') {
          this.emit({ ...current, followUp: { text: followUp, phase: outcome.kind, message: outcome.message } });
        } else if (outcome.type === 'failure') {
          this.emit({ ...current, followUp: { text: followUp, phase: 'failed', message: outcome.message } });
        } else {
          this.emit({ ...current, followUp: { text: followUp, phase: 'entered', message: 'Refinement cancelled.' } });
        }
        resolve(this.currentStatus);
      };
      pending.refineSettle = settleRefine;
      this.pending = pending;
      const contextCurrent = (): boolean => this.source.modelState() === capture.state
        && !this.source.interactionBusy()
        && aiDraftBindingsEqual(draftBindingNow(this.source, this.configKeyNow?.() ?? configKey), capture.binding);
      try {
        pending.timer = this.setTimeoutFn(() => {
          settleRefine({ type: 'failure', message: 'The draft provider did not answer in time.' });
          abort.abort();
        }, this.timeoutMs);
        if (pending.settled) {
          try { this.clearTimeoutFn(pending.timer); } catch { /* Synchronously fired test timer. */ }
          return;
        }
        if (this.epoch !== myEpoch || this.disposed) { settleRefine({ type: 'dropped' }); return; }
        if (!contextCurrent()) { settleRefine({ type: 'stale' }); return; }
        const request: AiDraftRefineRequest = { requestId, followUp, envelopeJson, binding: capture.binding };
        const refineFn = provider.refine;
        if (!refineFn) { settleRefine({ type: 'failure', message: 'The selected provider cannot refine previews.' }); return; }
        let work: ReturnType<NonNullable<AiDraftProvider['refine']>>;
        try { work = refineFn(request, abort.signal); } catch (cause) {
          settleRefine({ type: 'failure', message: cause instanceof AiError ? cause.message : 'The draft provider failed.' });
          return;
        }
        Promise.resolve(work).then((value: unknown) => {
          if (pending.settled) return;
          if (this.epoch !== myEpoch) { settleRefine({ type: 'dropped' }); return; }
          let current: boolean;
          try { current = contextCurrent(); } catch { settleRefine({ type: 'stale' }); return; }
          if (!current) { settleRefine({ type: 'stale' }); return; }
          const parsed = validateAiDraftResponse(value);
          if (!parsed.ok) { settleRefine({ type: 'failure', message: parsed.error }); return; }
          const response = parsed.response;
          if (response.kind !== 'plan') {
            settleRefine({ type: 'message', requestId, kind: response.kind, message: response.message });
            return;
          }
          const compiled = compileAiPlan(response.plan, capture, () => newId(), (e) => this.source.boundsFor(e));
          if (!compiled.ok) { settleRefine({ type: 'failure', message: compiled.error }); return; }
          try { if (!contextCurrent()) { settleRefine({ type: 'stale' }); return; } }
          catch { settleRefine({ type: 'stale' }); return; }
          settleRefine({ type: 'success', requestId, proposal: compiled.proposal });
        }, (cause: unknown) => {
          if (cause instanceof AiError && cause.kind === 'cancelled') settleRefine({ type: 'cancelled' });
          else settleRefine({ type: 'failure', message: cause instanceof AiError ? cause.message : 'The draft provider failed.' });
        });
      } catch {
        settleRefine({ type: 'failure', message: 'The refinement could not be started.' });
        abort.abort();
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
    this.listeners.clear();
  }
}
