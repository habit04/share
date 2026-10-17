/**
 * Thin renderer adapter for the read-only xref broker (priority 20.2).
 *
 * `createXrefReader` turns the Windows broker bridge (electron/preload.cjs
 * `beginXrefContext` / `identifyXref` / `readXref` / `cancelXref` /
 * `closeXrefContext`, served by electron/main/ipc-xrefs.cjs) into the
 * loading core's `XrefFileReader` (src/io/xref-loading.ts). It is
 * EXPLICITLY callable plumbing for a later UI/session integration:
 * it constructs no `XrefStore`, starts no load, and touches no document,
 * history, selection or layout state — it only holds one broker context
 * for one captured document session and translates between the two
 * contracts.
 *
 * Session binding: the context is begun lazily with the captured
 * `docId` / `contentGeneration` / host anchor. `setSession` with a
 * different docId, generation or anchor (tab replacement, Save As)
 * retires the old context and its tickets before the next operation;
 * an unchanged session is a no-op. `dispose()` retires the context.
 *
 * Cancellation: an `AbortSignal` cannot cross IPC, so when the core's
 * signal aborts, the adapter issues the broker's explicit cancel for
 * the context and — whatever the in-flight IPC call later returns —
 * the result is refused adapter-side as an abort, never accepted.
 *
 * Errors: broker refusals cross IPC as coded messages
 * ("ERR_XREF_*"); the adapter restores error codes the core classifies
 * by — DENIED becomes `EACCES` (the core reports `denied`, never
 * `missing`, for ungranted paths), MISSING becomes `ENOENT`, and a
 * broker cancellation becomes an `AbortError`.
 */
import type { XrefFileIdentity, XrefFileReader, XrefReadResult } from '../io/xref-loading';

/** The broker subset of the preload bridge (structurally the FileBridge xref methods). */
export interface XrefBrokerBridge {
  beginXrefContext(info: { docId: string; contentGeneration: number | string; hostAnchor: string }): Promise<{ token: string }>;
  identifyXref(token: string, path: string): Promise<{ ticket: string; identity: XrefFileIdentity }>;
  readXref(token: string, ticket: string, maxBytes: number): Promise<{ text: string; byteLength: number; version: string }>;
  cancelXref(token: string): Promise<boolean>;
  closeXrefContext(token: string): Promise<boolean>;
}

/** The document session a reader is bound to. Labels only — they grant nothing. */
export interface XrefReaderSession {
  readonly docId: string;
  readonly contentGeneration: number | string;
  /** The host drawing's absolute path: the context's captured anchor. */
  readonly hostPath: string;
}

export interface XrefReaderHandle {
  /** The core-facing reader. Holds capabilities only; using it loads nothing by itself. */
  readonly reader: XrefFileReader;
  /** The session currently captured (a copy). */
  readonly session: XrefReaderSession;
  /** Rebind to a new session; a changed docId/generation/anchor retires the old context first. */
  setSession(session: XrefReaderSession): void;
  /** Retire the broker context and refuse later operations. Idempotent. */
  dispose(): Promise<void>;
}

const CODE_PREFIX = /^([A-Z][A-Z0-9_]*):/;

function abortError(): Error {
  const error = new Error('the xref operation was aborted');
  error.name = 'AbortError';
  return error;
}

/** Restore a classifiable error from a broker IPC failure. */
function mapBrokerError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const code = CODE_PREFIX.exec(message)?.[1];
  if (code === 'ERR_XREF_CANCELLED') return abortError();
  const mapped = new Error(message);
  if (code === 'ERR_XREF_DENIED') (mapped as { code?: string }).code = 'EACCES';
  else if (code === 'ERR_XREF_MISSING') (mapped as { code?: string }).code = 'ENOENT';
  else if (code) (mapped as { code?: string }).code = code;
  return mapped;
}

export function createXrefReader(bridge: XrefBrokerBridge, initialSession: XrefReaderSession): XrefReaderHandle {
  let session: XrefReaderSession = { ...initialSession };
  let tokenPromise: Promise<string> | null = null;
  let disposed = false;
  /**
   * Bumped by every context retirement (session replacement, disposal).
   * Operations capture it before awaiting and refuse any completion
   * that lands after it moves: a late result from a retired generation
   * is never accepted, even when the core's own signal never aborted
   * (session replacement is an adapter-side event the core cannot see).
   */
  let generation = 0;
  /** Tickets by exact resolved path, from this context's identifications. */
  const tickets = new Map<string, { ticket: string; identity: XrefFileIdentity }>();

  /** Refuse a completion that belongs to a retired generation. */
  function throwIfStale(captured: number): void {
    if (disposed || captured !== generation) throw abortError();
  }

  function ensureContext(): Promise<string> {
    if (disposed) return Promise.reject(Object.assign(new Error('ERR_XREF_CONTEXT: the xref reader is disposed'), { code: 'ERR_XREF_CONTEXT' }));
    if (!tokenPromise) {
      const captured = session;
      tokenPromise = bridge.beginXrefContext({
        docId: captured.docId,
        contentGeneration: captured.contentGeneration,
        hostAnchor: captured.hostPath,
      }).then((begun) => begun.token);
      // A failed begin must not wedge the handle: the next call retries.
      tokenPromise.catch(() => { tokenPromise = null; });
    }
    return tokenPromise;
  }

  /** Retire the live context (if any) without touching the session labels. */
  function retireContext(): void {
    generation += 1;
    const pending = tokenPromise;
    tokenPromise = null;
    tickets.clear();
    if (pending) {
      void pending.then((token) => bridge.closeXrefContext(token)).catch(() => { /* already gone */ });
    }
  }

  /** Forward the core's abort to the broker and make sure no late result is accepted. */
  function wireAbort(signal: AbortSignal | undefined, token: string): void {
    if (!signal) return;
    if (signal.aborted) {
      void bridge.cancelXref(token).catch(() => { /* already gone */ });
      return;
    }
    signal.addEventListener('abort', () => {
      void bridge.cancelXref(token).catch(() => { /* already gone */ });
    }, { once: true });
  }

  const reader: XrefFileReader = {
    async identify(resolvedPath, context) {
      const captured = generation;
      const token = await ensureContext();
      throwIfStale(captured);
      wireAbort(context.signal, token);
      if (context.signal?.aborted) throw abortError();
      let result: { ticket: string; identity: XrefFileIdentity };
      try {
        result = await bridge.identifyXref(token, resolvedPath);
      } catch (error) {
        throw mapBrokerError(error);
      }
      if (context.signal?.aborted) throw abortError();
      // A completion from a retired context is refused, and its ticket
      // is never written into the new generation's ticket map.
      throwIfStale(captured);
      tickets.set(resolvedPath, { ticket: result.ticket, identity: result.identity });
      return result.identity;
    },

    async readText(resolvedPath, context): Promise<XrefReadResult> {
      const captured = generation;
      const token = await ensureContext();
      throwIfStale(captured);
      wireAbort(context.signal, token);
      if (context.signal?.aborted) throw abortError();
      let entry = tickets.get(resolvedPath);
      if (!entry) {
        // The core identifies before reading whenever an identify
        // exists; if a caller reads first, identify through the same
        // context rather than inventing a ticket.
        const identity = await reader.identify!(resolvedPath, context);
        if (!identity) throw Object.assign(new Error(`ERR_XREF_MISSING: no identification for ${resolvedPath}`), { code: 'ENOENT' });
        entry = tickets.get(resolvedPath)!;
      }
      let result: { text: string; byteLength: number; version: string };
      try {
        result = await bridge.readXref(token, entry.ticket, context.maxBytes);
      } catch (error) {
        throw mapBrokerError(error);
      }
      // A completion that arrives after the abort — or after this
      // adapter generation was retired by a session change or
      // disposal — is never accepted.
      if (context.signal?.aborted) throw abortError();
      throwIfStale(captured);
      return { text: result.text, byteLength: result.byteLength, version: result.version };
    },
  };

  return {
    reader,
    get session() {
      return { ...session };
    },
    setSession(next: XrefReaderSession) {
      if (next.docId === session.docId && next.contentGeneration === session.contentGeneration && next.hostPath === session.hostPath) return;
      session = { ...next };
      retireContext();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      const pending = tokenPromise;
      tokenPromise = null;
      tickets.clear();
      if (pending) {
        const token = await pending.catch(() => null);
        if (token) await bridge.closeXrefContext(token).catch(() => { /* already gone */ });
      }
    },
  };
}
