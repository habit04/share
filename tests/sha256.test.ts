/**
 * The renderer's synchronous SHA-256 must be the real algorithm:
 * published FIPS vectors, padding-edge lengths, and a cross-check
 * against the platform implementation on shaping-shaped inputs
 * (canonical encodings, Arabic text, long keys).
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256BytesHex, sha256Hex } from '../src/core/sha256';

const platform = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('sha256Hex', () => {
  it('matches the published FIPS 180-4 vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(sha256Hex('The quick brown fox jumps over the lazy dog')).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    );
  });

  it('agrees with the platform implementation across padding edges and scripts', () => {
    const inputs = [
      'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(65), 'x'.repeat(1000),
      'بًب shaping key canonical encoding',
      'face|Noto Naskh Arabic|Regular|2048|sha256',
      'uncovered:12:14:bidi-control',
      'a'.repeat(255) + 'ب'.repeat(300),
    ];
    for (const input of inputs) expect(sha256Hex(input)).toBe(platform(input));
  });
});

describe('sha256BytesHex', () => {
  it('matches the platform digest over raw bytes', () => {
    expect(sha256BytesHex(new Uint8Array([]))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256BytesHex(new Uint8Array([1, 2, 3, 250]))).toBe('bacdef9c76b37eb70caaf81ea41ecddd56d625b72e453de5eabbd59745279847');
  });
});
