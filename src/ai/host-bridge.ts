import {
  AiError,
  type AiAnswer,
  type AiAskRequest,
  type AiDraftRequest,
  type AiErrorKind,
  type AiUsage,
} from './types';
import type { AiDraftWireResult, AiHostBridge } from './live-provider';

/**
 * Renderer client for the guarded AI host bridge (milestone 2,
 * docs/AI-ASSISTANT-M2.md). The preload exposes `window.jcad.ai` with
 * result-value methods — expected failures resolve as
 * `{ ok: false, error: { kind, message, retryAfterSeconds? } }` because
 * Electron does not preserve custom error properties across IPC. This
 * module reconstructs typed `AiError`s from those payloads explicitly and
 * translates an AbortSignal into the host's cancel channel (signals
 * cannot cross IPC). No key material ever appears in these payloads.
 */

export interface AiConnectionState {
  /** The selected provider; the fields below describe that provider. */
  readonly provider: string;
  /** All providers the host supports (for the selector). */
  readonly providers?: readonly string[];
  readonly model: string;
  readonly enabled: boolean;
  readonly keyPersistence: 'session' | 'encrypted';
  readonly keyPresent: boolean;
  /** Stored ciphertext may exist even when the host cannot decrypt/use it. */
  readonly keyStored?: boolean;
  readonly credentialProblem?: string | null;
  readonly keySource: 'session' | 'stored' | null;
  readonly encryptionAvailable: boolean;
  readonly configProblem: string | null;
  /** Opaque host instance/configuration generation, required for live drafting. */
  readonly configGeneration?: string;
}

export interface AiProbeResult {
  readonly model: string;
  readonly outputLimited?: boolean;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

interface AiIpcErrorPayload {
  readonly kind?: unknown;
  readonly message?: unknown;
  readonly retryAfterSeconds?: unknown;
}

type AiResult<T> = { readonly ok: true } & T | { readonly ok: false; readonly error: AiIpcErrorPayload };

/** The raw preload bridge shape (electron/preload.cjs `ai` group). */
export interface AiPreloadBridge {
  getState(): Promise<AiResult<{ state: AiConnectionState }>>;
  setProvider(provider: string): Promise<AiResult<{ state: AiConnectionState }>>;
  setModel(model: string): Promise<AiResult<{ state: AiConnectionState }>>;
  setKey(key: string, persistence: string): Promise<AiResult<{ state: AiConnectionState }>>;
  forgetKey(): Promise<AiResult<{ state: AiConnectionState }>>;
  setEnabled(enabled: boolean): Promise<AiResult<{ state: AiConnectionState }>>;
  testConnection(): Promise<AiResult<{ probe: AiProbeResult }>>;
  ask(request: AiAskRequest): Promise<AiResult<{ answer: unknown }>>;
  draft(request: AiDraftRequest): Promise<AiResult<{ draft: unknown }>>;
  cancel(requestId: string): Promise<AiResult<{ cancelled: boolean }>>;
  usage(): Promise<AiResult<{ usage: Record<string, number> }>>;
}

const KNOWN_KINDS: ReadonlySet<string> = new Set<AiErrorKind>([
  'provider-not-configured', 'provider-failure', 'host-unavailable', 'timeout',
  'cancelled', 'stale', 'invalid-question', 'invalid-context', 'invalid-answer',
  'output-too-large', 'disposed', 'live-disabled', 'auth-failed', 'model-access',
  'rate-limited', 'network', 'refused', 'credential-unavailable',
  'credential-corrupt', 'credential-delete-failed',
  'invalid-request', 'credential-rollback-failed', 'invalid-plan', 'busy',
]);

/** Rebuild a typed error from a bounded IPC payload; unknown kinds fail closed. */
export function aiErrorFromPayload(payload: AiIpcErrorPayload | undefined): AiError {
  const kind = typeof payload?.kind === 'string' && KNOWN_KINDS.has(payload.kind)
    ? payload.kind as AiErrorKind
    : 'provider-failure';
  let message = typeof payload?.message === 'string' && payload.message.length > 0
    ? payload.message.slice(0, 500)
    : 'The AI host reported a failure.';
  if (kind === 'rate-limited'
    && typeof payload?.retryAfterSeconds === 'number'
    && Number.isFinite(payload.retryAfterSeconds) && payload.retryAfterSeconds > 0) {
    message += ` Try again in about ${Math.ceil(payload.retryAfterSeconds)} seconds.`;
  }
  return new AiError(kind, message);
}

function unwrap<T>(result: AiResult<T>): T {
  if (!result || typeof result !== 'object') {
    throw new AiError('host-unavailable', 'The AI host bridge returned an invalid response.');
  }
  if (result.ok === true) return result;
  throw aiErrorFromPayload((result as { error?: AiIpcErrorPayload }).error);
}

/**
 * Bounded validation of a host draft result (milestone 3). The host has
 * already validated the plan with its mirror validator; the raw provider
 * value crosses so LiveDraftProvider can apply the authoritative
 * parseAiDraftResponse — this layer does NOT plan-validate. It only
 * checks the result envelope is a record carrying a record `value`, and
 * whitelists the usage counters field by field, exactly as untrusted as
 * the ask path's.
 */
function draftWireResult(value: unknown): AiDraftWireResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AiError('invalid-plan', 'The AI host returned an invalid draft.');
  }
  const raw = value as {
    value?: unknown;
    configGeneration?: unknown;
    usage?: Record<string, unknown>; providerUsage?: Record<string, unknown>;
  };
  if (!raw.value || typeof raw.value !== 'object' || Array.isArray(raw.value)) {
    throw new AiError('invalid-plan', 'The AI host returned an invalid draft.');
  }
  const response = raw.value;
  const usage: { inputBytes?: number; outputChars?: number; durationMs?: number; inputTokens?: number; outputTokens?: number } = {};
  const counters = raw.usage && typeof raw.usage === 'object' && !Array.isArray(raw.usage) ? raw.usage : {};
  for (const key of ['inputBytes', 'outputChars', 'durationMs'] as const) {
    const amount = counters[key];
    if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0
      && (key === 'durationMs' || Number.isSafeInteger(amount))) usage[key] = amount;
  }
  const providerUsage = raw.providerUsage && typeof raw.providerUsage === 'object' && !Array.isArray(raw.providerUsage)
    ? raw.providerUsage
    : {};
  for (const key of ['inputTokens', 'outputTokens'] as const) {
    const amount = providerUsage[key];
    if (typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0) usage[key] = amount;
  }
  const clean: AiUsage = usage;
  if (typeof raw.configGeneration !== 'string' || !raw.configGeneration || raw.configGeneration.length > 256) {
    throw new AiError('invalid-plan', 'The AI host did not verify the draft connection settings.');
  }
  return { response, configGeneration: raw.configGeneration, ...(Object.keys(clean).length > 0 ? { usage: clean } : {}) };
}

export class WindowAiConnection {
  /** AiHostBridge for LiveProvider: ask + abort→cancel translation. */
  readonly bridge: AiHostBridge;

  constructor(private readonly raw: AiPreloadBridge) {
    this.bridge = {
      ask: async (request: AiAskRequest, signal: AbortSignal): Promise<AiAnswer> => {
        if (signal.aborted) throw new AiError('cancelled', 'The request was cancelled.');
        let rejectAborted: (cause: AiError) => void = () => {};
        const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
        const onAbort = () => {
          rejectAborted(new AiError('cancelled', 'The request was cancelled.'));
          try { void this.raw.cancel(request.requestId).catch(() => {}); } catch { /* IPC may already be gone. */ }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          const { answer } = unwrap(await Promise.race([this.raw.ask(request), aborted]));
          // The host reports provider token usage beside its own byte
          // counters; fold it into AiAnswer.usage where the controller's
          // whitelist carries it to the panel.
          if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
            const raw = answer as { usage?: Record<string, unknown>; providerUsage?: Record<string, unknown> };
            const tokens: Record<string, number> = {};
            for (const key of ['inputTokens', 'outputTokens'] as const) {
              const value = raw.providerUsage?.[key];
              if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) tokens[key] = value;
            }
            if (Object.keys(tokens).length > 0) {
              // This remains untrusted until AiAskController validates it;
              // retain all fields for that validation while copying usage.
              const candidate = answer as AiAnswer;
              return { ...candidate, usage: { ...(candidate.usage ?? {}), ...tokens } };
            }
          }
          return answer as AiAnswer;
        } finally {
          signal.removeEventListener('abort', onAbort);
        }
      },
      draft: async (request: AiDraftRequest, signal: AbortSignal): Promise<AiDraftWireResult> => {
        if (signal.aborted) throw new AiError('cancelled', 'The request was cancelled.');
        let rejectAborted: (cause: AiError) => void = () => {};
        const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
        const onAbort = () => {
          rejectAborted(new AiError('cancelled', 'The request was cancelled.'));
          try { void this.raw.cancel(request.requestId).catch(() => {}); } catch { /* IPC may already be gone. */ }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          const { draft } = unwrap(await Promise.race([this.raw.draft(request), aborted]));
          return draftWireResult(draft);
        } finally {
          signal.removeEventListener('abort', onAbort);
        }
      },
    };
  }

  async state(): Promise<AiConnectionState> { return unwrap(await this.raw.getState()).state; }
  async setProvider(provider: string): Promise<AiConnectionState> { return unwrap(await this.raw.setProvider(provider)).state; }
  async setModel(model: string): Promise<AiConnectionState> { return unwrap(await this.raw.setModel(model)).state; }
  async setKey(key: string, persistence: 'session' | 'encrypted'): Promise<AiConnectionState> {
    return unwrap(await this.raw.setKey(key, persistence)).state;
  }
  async forgetKey(): Promise<AiConnectionState> { return unwrap(await this.raw.forgetKey()).state; }
  async setEnabled(enabled: boolean): Promise<AiConnectionState> { return unwrap(await this.raw.setEnabled(enabled)).state; }
  async testConnection(): Promise<AiProbeResult> { return unwrap(await this.raw.testConnection()).probe; }
}

/** The bridge when the app runs in a plain browser (no Electron preload). */
export function windowAiConnection(): WindowAiConnection | null {
  const raw = (window as { jcad?: { ai?: AiPreloadBridge } }).jcad?.ai;
  return raw ? new WindowAiConnection(raw) : null;
}
