/**
 * P25 plugin capability isolation — the wire protocol between host and realm.
 *
 * Plain-data envelopes only. Two nonces are minted by the host per session and
 * travel ONLY inside the handshake over the dedicated transport channel:
 * `realmNonce` authenticates every realm->host message, `hostNonce` every
 * host->realm message. Neither nonce is ever placed on a global, in plugin
 * code, or in any value the realm proxy hands to plugin code, so plugin code
 * cannot forge a message (threat T5) — and after dispose the session id +
 * nonce pair is dead, so replayed messages are stale (threat T6). Within a
 * live session each envelope also carries a single-use sequence id (`id`:
 * minted from a monotonic counter by the sender), which the host consumes
 * on first receipt; a replayed envelope is dropped with no effect (X2).
 *
 * AMENDMENT-P25-CSP-HOSTING Part B1 / condition C-J2, stated in words: the
 * handshake's nonce exchange and session binding are UNCHANGED by the
 * module form — the same session id and realm/host nonce pair authenticate
 * every envelope exactly as in the string form; `moduleUrl` only replaces
 * the `code` payload. The realm now loads that URL as an ES module instead
 * of compiling a body string; the bootstrap contains no string evaluation
 * at all, so no transport can select a string path (condition C-J1).
 */

/** Protocol version of the isolated realm API (manifest apiVersion 2). */
export const ISOLATED_API_VERSION = 2;

/** Serialised-envelope ceiling (bytes of JSON) in either direction. */
export const MAX_MESSAGE_BYTES = 1_048_576;
/** Maximum nesting depth of any data value crossing the channel. */
export const MAX_DATA_DEPTH = 12;
/** Maximum string length of any single value crossing the channel. */
export const MAX_STRING_CHARS = 262_144;

export type RpcErrorCode =
  | 'denied' // capability not declared
  | 'forged' // bad nonce / session / shape (recorded host-side; never answered)
  | 'stale-session' // message for a disposed session
  | 'unknown-method'
  | 'unknown-grant'
  | 'grant-used'
  | 'grant-expired'
  | 'bad-request'
  | 'too-large'
  | 'timeout'
  | 'cancelled'
  | 'load-failed'
  | 'internal';

export interface RpcFailure {
  code: RpcErrorCode;
  message: string;
}

export interface HandshakeMessage {
  kind: 'handshake';
  v: 2;
  session: string;
  realmNonce: string;
  hostNonce: string;
  name: string;
  version: string;
  /**
   * The plugin entry's module URL (Part B1): the realm loads it with a
   * dynamic import() and the module's default export becomes the load
   * report. Served from the main-vetted package
   * (jcad://app/plugin-realm/<session>/…) in the packaged runtime,
   * file:// in the Node harness, blob: in the plain browser — chosen by
   * the host (PluginHost), never by the realm or the plugin.
   */
  moduleUrl: string;
}

export interface LoadDoneMessage {
  kind: 'load-done';
  v: 2;
  session: string;
  nonce: string;
  ok: boolean;
  error?: string;
  report?: unknown;
}

export interface RpcRequestMessage {
  kind: 'rpc';
  v: 2;
  session: string;
  nonce: string;
  id: string;
  method: string;
  args: unknown[];
}

export interface RpcResponseMessage {
  kind: 'rpc-res';
  v: 2;
  session: string;
  nonce: string;
  id: string;
  ok: boolean;
  value?: unknown;
  error?: RpcFailure;
}

export interface CallRequestMessage {
  kind: 'call';
  v: 2;
  session: string;
  nonce: string;
  id: string;
  callback: string;
  args: unknown[];
}

export interface CallResponseMessage {
  kind: 'call-res';
  v: 2;
  session: string;
  nonce: string;
  id: string;
  ok: boolean;
  value?: unknown;
  error?: RpcFailure;
}

export type RealmToHostMessage = LoadDoneMessage | RpcRequestMessage | CallResponseMessage;
export type HostToRealmMessage = HandshakeMessage | RpcResponseMessage | CallRequestMessage;

/**
 * Validate that `value` is plain channel data: null / boolean / finite number /
 * string / array / plain object, within depth and string limits, no functions,
 * symbols, bigint, undefined, class instances or cycles. Returns an error
 * message, or null when the value may cross.
 */
export function dataError(value: unknown, depth = 0, seen = new Set<object>()): string | null {
  if (depth > MAX_DATA_DEPTH) return `data is nested deeper than ${MAX_DATA_DEPTH} levels`;
  if (value === null) return null;
  const t = typeof value;
  if (t === 'boolean') return null;
  if (t === 'number') return Number.isFinite(value as number) ? null : 'numbers must be finite';
  if (t === 'string') return (value as string).length <= MAX_STRING_CHARS ? null : `a string is longer than ${MAX_STRING_CHARS} characters`;
  if (Array.isArray(value)) {
    if (seen.has(value)) return 'data must not contain cycles';
    seen.add(value);
    for (const item of value) {
      const err = dataError(item, depth + 1, seen);
      if (err) return err;
    }
    seen.delete(value);
    return null;
  }
  if (t === 'object') {
    const proto = Object.getPrototypeOf(value as object) as unknown;
    if (proto !== Object.prototype && proto !== null) return 'only plain objects may cross the plugin channel';
    if (seen.has(value as object)) return 'data must not contain cycles';
    seen.add(value as object);
    for (const item of Object.values(value as Record<string, unknown>)) {
      const err = dataError(item, depth + 1, seen);
      if (err) return err;
    }
    seen.delete(value as object);
    return null;
  }
  return `values of type ${t} may not cross the plugin channel`;
}

/** JSON size of a value, or Infinity when it cannot be serialised. */
export function dataBytes(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? Number.POSITIVE_INFINITY : text.length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
