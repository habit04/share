/**
 * P31C — Drawing-signature preservation, content verification and tamper
 * detection (pure module). PRESERVATION ONLY in this wave.
 *
 * What this is: when a drawing is imported carrying a native digital
 * signature, the signature payload is preserved byte-for-byte alongside a
 * SHA-256 content digest captured at import time (core/sha256.ts). Later:
 *  - verification compares a freshly computed content digest against the
 *    captured one: equal => 'content-match', different => 'tampered';
 *  - ANY edit after capture explicitly invalidates the record
 *    ('invalidated-by-edit'). Invalidation is sticky and takes precedence:
 *    an invalidated record never silently returns to a good status.
 *
 * What this is NOT: JCad does not create native DWG signatures here, and a
 * 'content-match' result is a digest comparison, not cryptographic
 * verification of the native signature payload. Cryptographic verification —
 * and any signing — requires an admitted host key/certificate service and
 * native reader extraction of the signature section; neither exists yet, so
 * no such claim is made anywhere in this module. An absent or empty payload
 * is 'unsigned', never a fabricated stamp.
 *
 * Two boundaries of the tamper claim, stated plainly (checkpoint-1
 * acceptance d4/f2): verification compares the drawing-content digest ONLY
 * — the preserved payload's own bytes are not integrity-attested, so a
 * corrupted or substituted payload is undetectable by this module; and the
 * serialized record is UNAUTHENTICATED — anyone who can edit the stored
 * JSON can rewrite its status, so invalidation stickiness is an API
 * discipline of this module, not a property of the stored data.
 *
 * Drawing signatures are unrelated to installer signing, which this module
 * never touches.
 */

export type PreservedSignatureStatus = 'unsigned' | 'preserved-unverified' | 'invalidated-by-edit';

export type SignatureVerification = 'unsigned' | 'content-match' | 'tampered' | 'invalidated-by-edit';

export interface PreservedSignatureRecord {
  readonly status: PreservedSignatureStatus;
  /** The native signature payload, preserved byte-for-byte. Empty iff unsigned. */
  readonly payload: Uint8Array;
  /** SHA-256 (lowercase hex) of the canonical drawing content at capture time. */
  readonly contentDigest: string;
  /** Format the signature was captured from, e.g. 'DWG'. Informational only. */
  readonly sourceFormat: string;
}

/**
 * Capture a signature record at import. An empty payload means the drawing
 * was unsigned — the record says so plainly instead of inventing a stamp.
 */
export function capturePreservedSignature(init: {
  payload: Uint8Array;
  contentDigest: string;
  sourceFormat: string;
}): PreservedSignatureRecord {
  if (!/^[0-9a-f]{64}$/.test(init.contentDigest)) {
    throw new Error('contentDigest must be a lowercase SHA-256 hex digest');
  }
  const payload = new Uint8Array(init.payload);
  return {
    status: payload.length === 0 ? 'unsigned' : 'preserved-unverified',
    payload,
    contentDigest: init.contentDigest,
    sourceFormat: init.sourceFormat,
  };
}

/**
 * Record that the drawing was edited after capture. The preserved payload is
 * kept (it is evidence of the original signature), but its status becomes
 * 'invalidated-by-edit' permanently — re-signing requires the future host
 * key/certificate service, not a status reset.
 */
export function noteSignatureEdit(record: PreservedSignatureRecord): PreservedSignatureRecord {
  if (record.status === 'unsigned') return record;
  if (record.status === 'invalidated-by-edit') return record;
  return { ...record, status: 'invalidated-by-edit', payload: new Uint8Array(record.payload) };
}

/**
 * Compare a freshly computed content digest with the captured one.
 * Invalidation takes precedence over any digest comparison.
 */
export function verifyPreservedSignature(
  record: PreservedSignatureRecord,
  currentContentDigest: string,
): SignatureVerification {
  if (record.status === 'invalidated-by-edit') return 'invalidated-by-edit';
  if (record.status === 'unsigned') return 'unsigned';
  return currentContentDigest === record.contentDigest ? 'content-match' : 'tampered';
}

// ------------------------------------------------------------- serialization

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const hasB = i + 1 < bytes.length;
    const hasC = i + 2 < bytes.length;
    const b = hasB ? (bytes[i + 1] ?? 0) : 0;
    const c = hasC ? (bytes[i + 2] ?? 0) : 0;
    out += B64.charAt(a >> 2) + B64.charAt(((a & 3) << 4) | (b >> 4));
    out += hasB ? B64.charAt(((b & 15) << 2) | (c >> 6)) : '=';
    out += hasC ? B64.charAt(c & 63) : '=';
  }
  return out;
}

function base64ToBytes(text: string): Uint8Array {
  // Strict (checkpoint-1 acceptance e2): the load path REFUSES malformed
  // encodings instead of silently stripping non-alphabet characters — the
  // module's parse path never canonicalizes a stored record into acceptance.
  // (The empty string is well-formed and decodes to an empty payload.)
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    throw new Error('signature record payloadBase64 is not well-formed base64');
  }
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 4) {
    const v = (idx: number): number => {
      const ch = text[idx];
      return ch === '=' || ch === undefined ? 0 : B64.indexOf(ch);
    };
    const n = (v(i) << 18) | (v(i + 1) << 12) | (v(i + 2) << 6) | v(i + 3);
    bytes.push((n >> 16) & 0xff);
    if (text[i + 2] !== '=') bytes.push((n >> 8) & 0xff);
    if (text[i + 3] !== '=') bytes.push(n & 0xff);
  }
  return new Uint8Array(bytes);
}

export function signatureRecordToJson(record: PreservedSignatureRecord): string {
  return JSON.stringify({
    status: record.status,
    payloadBase64: bytesToBase64(record.payload),
    contentDigest: record.contentDigest,
    sourceFormat: record.sourceFormat,
  });
}

const STATUSES: readonly PreservedSignatureStatus[] = ['unsigned', 'preserved-unverified', 'invalidated-by-edit'];

/** Parse a serialized record. Throws on unknown statuses or malformed input — never fabricates a status. */
export function parseSignatureRecordJson(text: string): PreservedSignatureRecord {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null) throw new Error('signature record must be an object');
  const r = raw as Record<string, unknown>;
  if (!STATUSES.includes(r.status as PreservedSignatureStatus)) {
    throw new Error(`signature record status "${String(r.status)}" is not a recognized preserved status`);
  }
  if (typeof r.payloadBase64 !== 'string') throw new Error('signature record payloadBase64 must be a string');
  if (typeof r.contentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(r.contentDigest)) {
    throw new Error('signature record contentDigest must be a lowercase SHA-256 hex digest');
  }
  if (typeof r.sourceFormat !== 'string') throw new Error('signature record sourceFormat must be a string');
  const payload = base64ToBytes(r.payloadBase64);
  const status = r.status as PreservedSignatureStatus;
  if (status === 'unsigned' && payload.length !== 0) throw new Error('an unsigned record cannot carry a payload');
  if (status !== 'unsigned' && payload.length === 0) throw new Error('a signed record cannot have an empty payload');
  return { status, payload, contentDigest: r.contentDigest, sourceFormat: r.sourceFormat };
}
