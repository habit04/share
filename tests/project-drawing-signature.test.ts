/**
 * P31C acceptance tests — drawing-signature PRESERVATION / VERIFICATION /
 * TAMPER DETECTION with explicit invalidation on edits.
 *
 * Scope honesty: JCad does not create native DWG signatures in this wave and
 * does not claim cryptographic verification of a native signature payload
 * (that needs an admitted host key/certificate service and native reader
 * extraction — neither exists yet). What is implemented and tested here:
 *  - a preserved signature record (payload bytes carried untouched),
 *  - content-digest binding captured at import (SHA-256, core/sha256.ts),
 *  - tamper detection: current digest != captured digest => 'tampered',
 *  - explicit invalidation: ANY edit after capture => 'invalidated-by-edit',
 *    which takes precedence and can never silently revert to a good status,
 *  - an absent/empty payload is 'unsigned', never a fake stamp.
 */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/core/sha256';
import {
  capturePreservedSignature,
  noteSignatureEdit,
  parseSignatureRecordJson,
  signatureRecordToJson,
  verifyPreservedSignature,
  type PreservedSignatureRecord,
} from '../src/project/drawing-signature';

const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
const digestOf = (canonical: string) => sha256Hex(canonical);

describe('P31C preserved drawing signature', () => {
  it('captures a record whose status is preserved-unverified (no crypto claim)', () => {
    const rec = capturePreservedSignature({ payload, contentDigest: digestOf('state-v1'), sourceFormat: 'DWG' });
    expect(rec.status).toBe('preserved-unverified');
    expect(Array.from(rec.payload)).toEqual(Array.from(payload));
    expect(rec.contentDigest).toBe(digestOf('state-v1'));
  });

  it('verification confirms content match when the digest is unchanged', () => {
    const rec = capturePreservedSignature({ payload, contentDigest: digestOf('state-v1'), sourceFormat: 'DWG' });
    expect(verifyPreservedSignature(rec, digestOf('state-v1'))).toBe('content-match');
  });

  it('verification reports tampered when content changed without an edit note', () => {
    const rec = capturePreservedSignature({ payload, contentDigest: digestOf('state-v1'), sourceFormat: 'DWG' });
    expect(verifyPreservedSignature(rec, digestOf('state-v2-tampered'))).toBe('tampered');
  });

  it('any edit explicitly invalidates, and invalidation wins over a later digest match', () => {
    const rec = capturePreservedSignature({ payload, contentDigest: digestOf('state-v1'), sourceFormat: 'DWG' });
    const edited = noteSignatureEdit(rec);
    expect(edited.status).toBe('invalidated-by-edit');
    // Even if content coincidentally hashes back, an invalidated record never
    // silently returns to a trustworthy status.
    expect(verifyPreservedSignature(edited, digestOf('state-v1'))).toBe('invalidated-by-edit');
    // original record untouched
    expect(rec.status).toBe('preserved-unverified');
  });

  it('an empty payload is unsigned — never captured as a signature', () => {
    const rec = capturePreservedSignature({ payload: new Uint8Array(0), contentDigest: digestOf('x'), sourceFormat: 'DWG' });
    expect(rec.status).toBe('unsigned');
    expect(verifyPreservedSignature(rec, digestOf('x'))).toBe('unsigned');
  });

  it('round-trips through JSON with payload bytes preserved exactly', () => {
    const rec: PreservedSignatureRecord = capturePreservedSignature({ payload, contentDigest: digestOf('state-v1'), sourceFormat: 'DWG' });
    const back = parseSignatureRecordJson(signatureRecordToJson(rec));
    expect(back.status).toBe(rec.status);
    expect(back.contentDigest).toBe(rec.contentDigest);
    expect(Array.from(back.payload)).toEqual(Array.from(payload));
  });

  it('rejects malformed record JSON instead of fabricating a status', () => {
    expect(() => parseSignatureRecordJson('{"status":"verified-by-autocad"}')).toThrow();
    expect(() => parseSignatureRecordJson('{}')).toThrow();
  });
});
