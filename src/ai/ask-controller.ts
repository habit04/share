import { buildSelectionSnapshot } from './snapshot';
import { aiBindingsEqual, AiError, type AiAnswer, type AiAskRequest, type AiProvider, type AiSnapshot, type AiSnapshotSource } from './types';
import { AI_DEFAULT_TIMEOUT_MS, AI_MAX_ANSWER_CHARS, AI_MAX_QUESTION_CHARS, AI_MAX_REFERENCES } from './limits';

/**
 * Request lifecycle for “Ask about selected objects”
 * (docs/AI-ASSISTANT.md). Owns sequencing, cancellation, timeout, staleness
 * and answer validation. It never touches the editor except through the
 * read-only snapshot source, and it never dispatches commands.
 */

export type AiAskStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'asking'; readonly requestId: number }
  | { readonly state: 'answered'; readonly requestId: number; readonly answer: AiAnswer; readonly droppedReferences: number }
  | { readonly state: 'stale'; readonly requestId: number }
  | { readonly state: 'cancelled'; readonly requestId: number }
  | { readonly state: 'error'; readonly requestId: number; readonly error: AiError };

export interface AiAskControllerOptions {
  readonly timeoutMs?: number;
  /** Injectable timer for tests; defaults to the platform timers. */
  readonly setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
}

interface Pending {
  readonly requestId: number;
  readonly abort: AbortController;
  timer: unknown;
  settled: boolean;
}

export class AiAskController {
  private readonly source: AiSnapshotSource;
  private readonly provider: AiProvider;
  private readonly timeoutMs: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly listeners = new Set<(status: AiAskStatus) => void>();
  private lastRequestId = 0;
  private pending: Pending | null = null;
  private disposed = false;
  private currentStatus: AiAskStatus = { state: 'idle' };

  constructor(source: AiSnapshotSource, provider: AiProvider, options: AiAskControllerOptions = {}) {
    this.source = source;
    this.provider = provider;
    this.timeoutMs = options.timeoutMs ?? AI_DEFAULT_TIMEOUT_MS;
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get status(): AiAskStatus {
    return this.currentStatus;
  }

  get providerId(): string {
    return this.provider.id;
  }

  subscribe(listener: (status: AiAskStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(status: AiAskStatus): void {
    this.currentStatus = status;
    for (const listener of [...this.listeners]) listener(status);
  }

  /** The snapshot the panel previews and the next ask will send. Read-only. */
  previewSnapshot(): AiSnapshot {
    return buildSelectionSnapshot(this.source);
  }

  /**
   * Ask a question about the current selection. Resolves with the final
   * status; provider failures, timeouts, staleness and cancellation are
   * reported as statuses, not thrown, so the panel has one rendering path.
   */
  async ask(question: string): Promise<AiAskStatus> {
    if (this.disposed) {
      const status: AiAskStatus = {
        state: 'error', requestId: this.lastRequestId,
        error: new AiError('disposed', 'The AI assistant has been closed.'),
      };
      return status;
    }
    const trimmed = question.trim();
    if (trimmed.length === 0 || trimmed.length > AI_MAX_QUESTION_CHARS) {
      const status: AiAskStatus = {
        state: 'error', requestId: this.lastRequestId,
        error: new AiError('invalid-question', `Questions must be 1–${AI_MAX_QUESTION_CHARS} characters.`),
      };
      this.emit(status);
      return status;
    }

    // A new ask supersedes any in-flight request: abort it so its late
    // answer can never overwrite this one.
    this.abortPending();

    const requestId = ++this.lastRequestId;
    const snapshot = buildSelectionSnapshot(this.source);
    const binding = this.source.binding();
    const request: AiAskRequest = { requestId, question: trimmed, snapshot, binding };
    const abort = new AbortController();
    const pending: Pending = { requestId, abort, timer: null, settled: false };
    this.pending = pending;
    this.emit({ state: 'asking', requestId });

    const finish = (status: AiAskStatus): AiAskStatus => {
      if (pending.settled) return this.currentStatus;
      pending.settled = true;
      if (pending.timer !== null) this.clearTimeoutFn(pending.timer);
      if (this.pending === pending) this.pending = null;
      this.emit(status);
      return status;
    };

    pending.timer = this.setTimeoutFn(() => {
      abort.abort();
      finish({
        state: 'error', requestId,
        error: new AiError('timeout', `The provider did not answer within ${this.timeoutMs} ms.`),
      });
    }, this.timeoutMs);

    let answer: AiAnswer;
    try {
      // Race the provider against the abort signal so timeout / cancel /
      // supersede resolve this ask even if a provider ignores the signal.
      const aborted = new Promise<never>((_resolve, reject) => {
        abort.signal.addEventListener('abort', () => reject(new Error('AI request aborted.')), { once: true });
      });
      answer = await Promise.race([this.provider.ask(request, abort.signal), aborted]);
    } catch (cause) {
      if (pending.settled) return this.currentStatus; // timed out already
      if (abort.signal.aborted) {
        return finish({ state: 'cancelled', requestId });
      }
      if (cause instanceof AiError) {
        return finish({ state: 'error', requestId, error: cause });
      }
      return finish({
        state: 'error', requestId,
        error: new AiError('provider-failure', cause instanceof Error ? cause.message : 'The provider failed.'),
      });
    }

    if (pending.settled) return this.currentStatus; // timed out / superseded while awaiting
    if (abort.signal.aborted) return finish({ state: 'cancelled', requestId });

    // Staleness: re-read the binding now. Any difference — edit, undo, redo,
    // selection change, space change, tab switch, replacement, close —
    // suppresses the answer. docRevision catches edit-then-undo.
    const now = this.source.binding();
    if (!aiBindingsEqual(binding, now)) {
      return finish({ state: 'stale', requestId });
    }

    // Answer validation: bounded text, references only into the snapshot.
    if (typeof answer.text !== 'string' || answer.text.length === 0) {
      return finish({
        state: 'error', requestId,
        error: new AiError('invalid-answer', 'The provider returned an empty answer.'),
      });
    }
    if (answer.text.length > AI_MAX_ANSWER_CHARS) {
      return finish({
        state: 'error', requestId,
        error: new AiError('output-too-large', `The provider answer exceeded ${AI_MAX_ANSWER_CHARS} characters and was not shown.`),
      });
    }
    const validIds = new Set(snapshot.objects.map((o) => o.id));
    const rawRefs = Array.isArray(answer.references) ? answer.references.slice(0, AI_MAX_REFERENCES) : [];
    const references = rawRefs.filter((id) => typeof id === 'string' && validIds.has(id));
    const droppedReferences = rawRefs.length - references.length;

    return finish({
      state: 'answered', requestId,
      answer: { ...answer, references },
      droppedReferences,
    });
  }

  /** Cancel the in-flight request, if any. Late answers are suppressed. */
  cancel(): void {
    if (!this.pending || this.pending.settled) return;
    const pending = this.pending;
    pending.abort.abort();
    pending.settled = true;
    if (pending.timer !== null) this.clearTimeoutFn(pending.timer);
    this.pending = null;
    this.emit({ state: 'cancelled', requestId: pending.requestId });
  }

  private abortPending(): void {
    if (!this.pending) return;
    const pending = this.pending;
    pending.abort.abort();
    pending.settled = true;
    if (pending.timer !== null) this.clearTimeoutFn(pending.timer);
    this.pending = null;
  }

  /** Cancel everything and refuse further asks. */
  dispose(): void {
    this.disposed = true;
    this.abortPending();
    this.listeners.clear();
  }
}
