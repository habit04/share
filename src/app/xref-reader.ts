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
 * ("ERR_XREF_*"), possibly inside Electron's invoke envelope; the
 * adapter normalizes that one known transport prefix away and
 * restores error codes the core classifies by — DENIED becomes
 * `EACCES` (the core reports `denied`, never `missing`, for ungranted
 * paths), MISSING becomes `ENOENT`, and a broker cancellation becomes
 * an `AbortError`.
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
/**
 * The one transport envelope Electron wraps a main-process handler
 * failure in before it reaches the renderer's rejected invoke
 * promise. Only this exact leading shape is normalized away; message
 * text is never searched for codes anywhere else.
 */
const INVOKE_ENVELOPE = /^Error invoking remote method '[^']*': Error: /;

function abortError(): Error {
  const error = new Error('the xref operation was aborted');
  error.name = 'AbortError';
  return error;
}

/** Restore a classifiable error from a broker IPC failure. */
function mapBrokerError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(INVOKE_ENVELOPE, '');
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

  /**
   * Refuse a completion that belongs to a retired generation. The
   * disposed flag is compared against its captured value, so an
   * operation that STARTS after disposal is not "stale" — it fails
   * with ensureContext's own disposed error instead of an abort.
   */
  function throwIfStale(captured: number, capturedDisposed: boolean): void {
    if (captured !== generation || disposed !== capturedDisposed) throw abortError();
  }

  function ensureContext(): Promise<string> {
    if (disposed) return Promise.reject(Object.assign(new Error('ERR_XREF_CONTEXT: the xref reader is disposed'), { code: 'ERR_XREF_CONTEXT' }));
    if (!tokenPromise) {
      const captured = session;
      const pending = bridge.beginXrefContext({
        docId: captured.docId,
        contentGeneration: captured.contentGeneration,
        hostAnchor: captured.hostPath,
      }).then((begun) => begun.token);
      tokenPromise = pending;
      // A failed begin must not wedge the handle: the next call retries.
      // Clear ONLY the promise that still occupies the slot — a begin
      // retired by a session change must never clear the replacement
      // context's pointer, tickets or close ownership (R3).
      pending.catch(() => { if (tokenPromise === pending) tokenPromise = null; });
    }
    return tokenPromise;
  }

  /**
   * Await the context token for one operation. Retirement dominates a
   * failed begin: a rejection landing after the captured generation
   * was retired (or after the caller's signal aborted) surfaces as an
   * abort, never as the retired session's ordinary error (R5). A
   * non-stale begin failure propagates unchanged.
   */
  async function contextToken(captured: number, capturedDisposed: boolean, signal: AbortSignal | undefined): Promise<string> {
    try {
      return await ensureContext();
    } catch (error) {
      throwIfStale(captured, capturedDisposed);
      if (signal?.aborted) throw abortError();
      throw error;
    }
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

  /**
   * Forward the core's abort to the broker and make sure no late
   * result is accepted. Returns the detach function: the caller
   * removes the listener in a finally when its operation settles, so
   * a completed operation can never cancel a later one that shares
   * the context (R4).
   */
  function wireAbort(signal: AbortSignal | undefined, token: string): () => void {
    if (!signal) return () => { /* nothing was wired */ };
    if (signal.aborted) {
      void bridge.cancelXref(token).catch(() => { /* already gone */ });
      return () => { /* nothing was wired */ };
    }
    const forward = () => {
      void bridge.cancelXref(token).catch(() => { /* already gone */ });
    };
    signal.addEventListener('abort', forward, { once: true });
    return () => { signal.removeEventListener('abort', forward); };
  }

  const reader: XrefFileReader = {
    async identify(resolvedPath, context) {
      const captured = generation;
      const capturedDisposed = disposed;
      const token = await contextToken(captured, capturedDisposed, context.signal);
      throwIfStale(captured, capturedDisposed);
      const unwire = wireAbort(context.signal, token);
      try {
        if (context.signal?.aborted) throw abortError();
        let result: { ticket: string; identity: XrefFileIdentity };
        try {
          result = await bridge.identifyXref(token, resolvedPath);
        } catch (error) {
          // Retirement (or the caller's abort) dominates an ordinary
          // broker error: a retired load is never surfaced as a
          // routine missing/denied continuation (R5).
          throwIfStale(captured, capturedDisposed);
          if (context.signal?.aborted) throw abortError();
          throw mapBrokerError(error);
        }
        if (context.signal?.aborted) throw abortError();
        // A completion from a retired context is refused, and its ticket
        // is never written into the new generation's ticket map.
        throwIfStale(captured, capturedDisposed);
        tickets.set(resolvedPath, { ticket: result.ticket, identity: result.identity });
        return result.identity;
      } finally {
        unwire();
      }
    },

    async readText(resolvedPath, context): Promise<XrefReadResult> {
      const captured = generation;
      const capturedDisposed = disposed;
      const token = await contextToken(captured, capturedDisposed, context.signal);
      throwIfStale(captured, capturedDisposed);
      const unwire = wireAbort(context.signal, token);
      try {
        if (context.signal?.aborted) throw abortError();
        let entry = tickets.get(resolvedPath);
        if (!entry) {
          // The core identifies before reading whenever an identify
          // exists; if a caller reads first, identify through the same
          // context rather than inventing a ticket.
          const identity = await reader.identify!(resolvedPath, context);
          // The nested identify may fulfil just as this generation is
          // retired: re-check BEFORE touching the (now cleared) ticket
          // map or issuing any read under a new session (R5).
          throwIfStale(captured, capturedDisposed);
          if (context.signal?.aborted) throw abortError();
          if (!identity) throw Object.assign(new Error(`ERR_XREF_MISSING: no identification for ${resolvedPath}`), { code: 'ENOENT' });
          entry = tickets.get(resolvedPath)!;
        }
        let result: { text: string; byteLength: number; version: string };
        try {
          result = await bridge.readXref(token, entry.ticket, context.maxBytes);
        } catch (error) {
          // Same dominance as identify: stale/cancel first, ordinary
          // classification only for a still-current failure (R5).
          throwIfStale(captured, capturedDisposed);
          if (context.signal?.aborted) throw abortError();
          throw mapBrokerError(error);
        }
        // A completion that arrives after the abort — or after this
        // adapter generation was retired by a session change or
        // disposal — is never accepted.
        if (context.signal?.aborted) throw abortError();
        throwIfStale(captured, capturedDisposed);
        return { text: result.text, byteLength: result.byteLength, version: result.version };
      } finally {
        unwire();
      }
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
