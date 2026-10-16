import { buildSelectionSnapshot } from './snapshot';
import { aiBindingsEqual, AiError, type AiAnswer, type AiAskRequest, type AiBinding, type AiProvider, type AiSnapshot, type AiSnapshotSource, type AiUsage } from './types';
import { AI_DEFAULT_TIMEOUT_MS, AI_MAX_ANSWER_CHARS, AI_MAX_QUESTION_CHARS, AI_MAX_REFERENCES } from './limits';

/**
 * Owns the read-only ask lifecycle. Each call resolves its own terminal status;
 * only the current request may publish a status to the panel.
 */
export type AiAskStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'asking'; readonly requestId: number }
  | { readonly state: 'answered'; readonly requestId: number; readonly binding: AiBinding; readonly answer: AiAnswer; readonly droppedReferences: number }
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
  readonly finish: (status: AiAskStatus, publish?: boolean) => AiAskStatus;
}

function providerError(cause: unknown): AiError {
  if (cause instanceof AiError) return cause;
  let message = 'The provider failed.';
  try {
    if (cause instanceof Error && typeof cause.message === 'string') message = cause.message.slice(0, AI_MAX_ANSWER_CHARS);
  } catch { /* A provider can reject with an arbitrary value. */ }
  return new AiError('provider-failure', message);
}

function contextError(cause: unknown): AiError {
  return cause instanceof AiError ? cause : new AiError('invalid-context', 'The selected drawing context could not be read. Select the objects again and retry.');
}

/** Copy only permitted fields; provider results remain untrusted at runtime. */
function validateAnswer(value: unknown, snapshot: AiSnapshot): { answer: AiAnswer; droppedReferences: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AiError('invalid-answer', 'The provider returned an invalid answer.');
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.text !== 'string' || raw.text.trim().length === 0) {
    throw new AiError('invalid-answer', 'The provider returned an empty answer.');
  }
  if (raw.text.length > AI_MAX_ANSWER_CHARS) {
    throw new AiError('output-too-large', 'The provider answer exceeded ' + AI_MAX_ANSWER_CHARS + ' characters and was not shown.');
  }
  const validIds = new Set(snapshot.objects.map((object) => object.id));
  const rawReferences: unknown[] = Array.isArray(raw.references) ? raw.references : [];
  const seen = new Set<string>();
  const references: string[] = [];
  // Inspect at most the cap, but count every removed reference, including the tail.
  for (let i = 0; i < Math.min(rawReferences.length, AI_MAX_REFERENCES); i++) {
    const id = rawReferences[i];
    if (typeof id === 'string' && validIds.has(id) && !seen.has(id)) {
      references.push(id);
      seen.add(id);
    }
  }
  let usage: AiUsage | undefined;
  if (raw.usage && typeof raw.usage === 'object' && !Array.isArray(raw.usage)) {
    const input = raw.usage as Record<string, unknown>;
    const clean: { inputBytes?: number; outputChars?: number; durationMs?: number } = {};
    for (const key of ['inputBytes', 'outputChars', 'durationMs'] as const) {
      const amount = input[key];
      if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0
        && (key === 'durationMs' || Number.isSafeInteger(amount))) clean[key] = amount;
    }
    if (Object.keys(clean).length > 0) usage = clean;
  }
  return {
    answer: { text: raw.text, references, ...(usage ? { usage } : {}) },
    droppedReferences: rawReferences.length - references.length,
  };
}

export class AiAskController {
  private readonly timeoutMs: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly listeners = new Set<(status: AiAskStatus) => void>();
  private lastRequestId = 0;
  private pending: Pending | null = null;
  private disposed = false;
  private currentStatus: AiAskStatus = { state: 'idle' };

  constructor(private readonly source: AiSnapshotSource, private readonly provider: AiProvider, options: AiAskControllerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? AI_DEFAULT_TIMEOUT_MS;
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get status(): AiAskStatus { return this.currentStatus; }
  get providerId(): string { return this.provider.id; }

  subscribe(listener: (status: AiAskStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(status: AiAskStatus): void {
    this.currentStatus = status;
    for (const listener of [...this.listeners]) {
      if (this.disposed || this.currentStatus !== status) break;
      try { listener(status); } catch { /* A subscriber must not strand a request or block other subscribers. */ }
    }
  }

  /** Safe binding check for answers already displayed by the panel. */
  isCurrentBinding(binding: AiBinding): boolean {
    if (this.disposed) return false;
    try { return aiBindingsEqual(binding, this.source.binding()); } catch { return false; }
  }

  /** The snapshot the panel previews and the next ask will send. Read-only. */
  previewSnapshot(): AiSnapshot { return buildSelectionSnapshot(this.source); }

  /** Resolves to this call's terminal status, including on cancellation or supersession. */
  async ask(question: string): Promise<AiAskStatus> {
    if (this.disposed) {
      return { state: 'error', requestId: this.lastRequestId, error: new AiError('disposed', 'The AI assistant has been closed.') };
    }
    this.abortPending();
    const requestId = ++this.lastRequestId;
    const trimmed = typeof question === 'string' ? question.trim() : '';
    if (trimmed.length === 0 || trimmed.length > AI_MAX_QUESTION_CHARS) {
      const status: AiAskStatus = {
        state: 'error', requestId,
        error: new AiError('invalid-question', 'Questions must be 1–' + AI_MAX_QUESTION_CHARS + ' characters.'),
      };
      this.emit(status);
      return status;
    }

    let snapshot: AiSnapshot;
    let binding: AiBinding;
    try {
      snapshot = buildSelectionSnapshot(this.source);
      binding = this.source.binding();
    } catch (cause) {
      const status: AiAskStatus = { state: 'error', requestId, error: contextError(cause) };
      this.emit(status);
      return status;
    }
    const request: AiAskRequest = { requestId, question: trimmed, snapshot, binding };

    return new Promise<AiAskStatus>((resolve) => {
      const abort = new AbortController();
      const pending: Pending = {
        requestId, abort, timer: null, settled: false,
        finish: (status, publish = true) => {
          if (pending.settled) return status;
          pending.settled = true;
          if (pending.timer !== null) {
            try { this.clearTimeoutFn(pending.timer); } catch { /* Settlement must still complete. */ }
            pending.timer = null;
          }
          const current = this.pending === pending;
          if (current) this.pending = null;
          resolve(status);
          if (publish && current && !this.disposed) this.emit(status);
          return status;
        },
      };
      this.pending = pending;
      try {
        pending.timer = this.setTimeoutFn(() => {
          pending.finish({
            state: 'error', requestId,
            error: new AiError('timeout', 'The provider did not answer within ' + this.timeoutMs + ' ms.'),
          });
          abort.abort();
        }, this.timeoutMs);
        if (pending.settled) {
          try { this.clearTimeoutFn(pending.timer); } catch { /* Synchronously fired test timer. */ }
          return;
        }
        this.emit({ state: 'asking', requestId });
        if (pending.settled) return; // A subscriber may have cancelled or disposed synchronously.
        Promise.resolve(this.provider.ask(request, abort.signal)).then((value: unknown) => {
          if (pending.settled) return;
          let current: AiBinding;
          try {
            current = this.source.binding();
            if (!aiBindingsEqual(binding, current)) {
              pending.finish({ state: 'stale', requestId });
              return;
            }
          } catch (cause) {
            pending.finish({ state: 'error', requestId, error: contextError(cause) });
            return;
          }
          try {
            const validated = validateAnswer(value, snapshot);
            pending.finish({ state: 'answered', requestId, binding, ...validated });
          } catch (cause) {
            const error = cause instanceof AiError ? cause : new AiError('invalid-answer', 'The provider returned an invalid answer.');
            pending.finish({ state: 'error', requestId, error });
          }
        }, (cause: unknown) => {
          if (!pending.settled) pending.finish({ state: 'error', requestId, error: providerError(cause) });
        });
      } catch (cause) {
        pending.finish({ state: 'error', requestId, error: providerError(cause) });
        abort.abort();
      }
    });
  }

  /** Cancel the in-flight request, if any. Late answers are suppressed. */
  cancel(): void { this.abortPending(true); }

  private abortPending(publish = false): void {
    const pending = this.pending;
    if (!pending) return;
    pending.finish({ state: 'cancelled', requestId: pending.requestId }, publish);
    pending.abort.abort();
  }

  dispose(): void {
    this.disposed = true;
    this.abortPending();
    this.listeners.clear();
  }
}
