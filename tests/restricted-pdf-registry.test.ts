import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createRestrictedPdfRegistry } = require('../electron/restricted-pdf/registry.cjs') as {
  createRestrictedPdfRegistry(options: { fontHost: { admittedPreviewPrint(value: unknown): boolean }; ttlMs?: number; maxRecords?: number }): {
    register(input: { ticket: unknown; owner: unknown; claim: unknown }): true;
    has(ticket: unknown, owner: unknown): boolean;
    consume(input: { ticket: unknown; owner: unknown; claim: unknown; bytes: Uint8Array }): true;
    cancel(ticket: unknown, owner: unknown): boolean;
    retireOwner(owner: unknown): number;
    retireAll(): number;
    size(): number;
  };
};

const owner = {};
const otherOwner = {};
const admitted = { font: 'preview.ttf', family: 'Preview Face' };
const fontHost = { admittedPreviewPrint: (value: unknown) => !!value && typeof value === 'object' && (value as { font?: string }).font === 'preview.ttf' };
const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const digest = createHash('sha256').update(bytes).digest('hex');
const claim = (overrides: Record<string, unknown> = {}) => ({ sha256: digest, byteLength: bytes.byteLength, faces: [admitted], ...overrides });

describe('restricted PDF registration binding (12.4)', () => {
  it('registers and consumes a matching job exactly once', () => {
    const registry = createRestrictedPdfRegistry({ fontHost });
    expect(registry.register({ ticket: 'ticket-1', owner, claim: claim() })).toBe(true);
    expect(registry.has('ticket-1', owner)).toBe(true);
    expect(registry.consume({ ticket: 'ticket-1', owner, claim: { sha256: digest, byteLength: bytes.byteLength }, bytes })).toBe(true);
    expect(registry.has('ticket-1', owner)).toBe(false);
    expect(() => registry.consume({ ticket: 'ticket-1', owner, claim: { sha256: digest, byteLength: bytes.byteLength }, bytes })).toThrow(/no live restricted registration/);
  });

  it('refuses a face main never admitted as preview/print', () => {
    const registry = createRestrictedPdfRegistry({ fontHost });
    expect(() => registry.register({ ticket: 't', owner, claim: claim({ faces: [{ font: 'other.ttf' }] }) })).toThrow(/not admitted by the font host/);
    expect(registry.size()).toBe(0);
  });

  it('refuses empty, oversized and duplicate face claims', () => {
    const registry = createRestrictedPdfRegistry({ fontHost });
    expect(() => registry.register({ ticket: 't', owner, claim: claim({ faces: [] }) })).toThrow(/between one and eight/);
    expect(() => registry.register({ ticket: 't', owner, claim: claim({ faces: Array(9).fill(admitted) }) })).toThrow(/between one and eight/);
    expect(() => registry.register({ ticket: 't', owner, claim: claim({ faces: [admitted, admitted] }) })).toThrow(/duplicate/);
  });

  it('refuses malformed digests and lengths', () => {
    const registry = createRestrictedPdfRegistry({ fontHost });
    expect(() => registry.register({ ticket: 't', owner, claim: claim({ sha256: 'XYZ' }) })).toThrow(/digest/);
    expect(() => registry.register({ ticket: 't', owner, claim: claim({ sha256: digest.toUpperCase() }) })).toThrow(/digest/);
    expect(() => registry.register({ ticket: 't', owner, claim: claim({ byteLength: 7 }) })).toThrow(/length/);
    expect(() => registry.register({ ticket: 't', owner, claim: claim({ byteLength: 128 * 1024 * 1024 + 1 }) })).toThrow(/length/);
  });

  it('refuses a second registration for the same ticket', () => {
    const registry = createRestrictedPdfRegistry({ fontHost });
    registry.register({ ticket: 't', owner, claim: claim() });
    expect(() => registry.register({ ticket: 't', owner, claim: claim() })).toThrow(/already has a restricted registration/);
  });

  it('consume refuses a different owner and deletes the record either way', () => {
    const registry = createRestrictedPdfRegistry({ fontHost });
    registry.register({ ticket: 't', owner, claim: claim() });
    expect(() => registry.consume({ ticket: 't', owner: otherOwner, claim: { sha256: digest, byteLength: bytes.byteLength }, bytes })).toThrow(/no live restricted registration/);
    expect(registry.has('t', owner)).toBe(false);
  });

  it('consume refuses bytes whose digest or length differ from the registration', () => {
    const registry = createRestrictedPdfRegistry({ fontHost });
    registry.register({ ticket: 't', owner, claim: claim() });
    const other = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]);
    expect(() => registry.consume({ ticket: 't', owner, claim: { sha256: digest, byteLength: bytes.byteLength }, bytes: other })).toThrow(/digest does not match/);
    registry.register({ ticket: 't2', owner, claim: claim() });
    expect(() => registry.consume({ ticket: 't2', owner, claim: { sha256: digest, byteLength: bytes.byteLength }, bytes: new Uint8Array(9) })).toThrow(/length does not match/);
  });

  it('consume refuses a save claim that differs from the registration', () => {
    const registry = createRestrictedPdfRegistry({ fontHost });
    registry.register({ ticket: 't', owner, claim: claim() });
    expect(() => registry.consume({ ticket: 't', owner, claim: { sha256: 'a'.repeat(64), byteLength: bytes.byteLength }, bytes })).toThrow(/does not match the restricted registration/);
  });

  it('registrations expire', async () => {
    const registry = createRestrictedPdfRegistry({ fontHost, ttlMs: 20 });
    registry.register({ ticket: 't', owner, claim: claim() });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(registry.has('t', owner)).toBe(false);
    expect(() => registry.consume({ ticket: 't', owner, claim: { sha256: digest, byteLength: bytes.byteLength }, bytes })).toThrow(/no live restricted registration/);
  });
});

describe('restricted PDF registration retirement (12.4 corrections)', () => {
  it('cancel retires a live registration and it can never authorize a later write', () => {
    const registry = createRestrictedPdfRegistry({ fontHost });
    registry.register({ ticket: 't', owner, claim: claim() });
    expect(registry.cancel('t', owner)).toBe(true);
    expect(registry.has('t', owner)).toBe(false);
    expect(registry.cancel('t', owner)).toBe(false); // already gone
    expect(() => registry.consume({ ticket: 't', owner, claim: { sha256: digest, byteLength: bytes.byteLength }, bytes })).toThrow(/no live restricted registration/);
  });

  it('cancel is owner-bound: a different owner removes nothing', () => {
    const registry = createRestrictedPdfRegistry({ fontHost });
    registry.register({ ticket: 't', owner, claim: claim() });
    expect(registry.cancel('t', otherOwner)).toBe(false);
    expect(registry.has('t', owner)).toBe(true);
    expect(registry.size()).toBe(1);
  });

  it('retireOwner removes only that owner\'s records and reports the count', () => {
    const registry = createRestrictedPdfRegistry({ fontHost });
    registry.register({ ticket: 'a', owner, claim: claim() });
    registry.register({ ticket: 'b', owner, claim: claim() });
    registry.register({ ticket: 'c', owner: otherOwner, claim: claim() });
    expect(registry.retireOwner(owner)).toBe(2);
    expect(registry.size()).toBe(1);
    expect(registry.has('c', otherOwner)).toBe(true);
    expect(registry.retireOwner(owner)).toBe(0);
  });

  it('retireAll empties the registry (host disposal / shutdown)', () => {
    const registry = createRestrictedPdfRegistry({ fontHost });
    registry.register({ ticket: 'a', owner, claim: claim() });
    registry.register({ ticket: 'b', owner: otherOwner, claim: claim() });
    expect(registry.retireAll()).toBe(2);
    expect(registry.size()).toBe(0);
    expect(() => registry.consume({ ticket: 'a', owner, claim: { sha256: digest, byteLength: bytes.byteLength }, bytes })).toThrow(/no live restricted registration/);
  });

  it('more than maxRecords register-then-cancel cycles never exhaust the service', () => {
    const registry = createRestrictedPdfRegistry({ fontHost }); // default cap 64
    for (let i = 0; i < 200; i += 1) {
      const ticket = `cycle-${i}`;
      expect(registry.register({ ticket, owner, claim: claim() })).toBe(true);
      expect(registry.cancel(ticket, owner)).toBe(true);
      expect(registry.size()).toBe(0);
    }
    // And the service still accepts and consumes a fresh registration.
    registry.register({ ticket: 'final', owner, claim: claim() });
    expect(registry.consume({ ticket: 'final', owner, claim: { sha256: digest, byteLength: bytes.byteLength }, bytes })).toBe(true);
  });
});

const { verifyAssets, declaredMaximumMemory } = require('../electron/restricted-pdf/host.cjs') as {
  verifyAssets(assetsDir?: string): { qpdfWasmSha256: string; maximumMemoryBytes: number };
  declaredMaximumMemory(bytes: Uint8Array): number | null;
};

describe('shipped engine artifact verification (12.4)', () => {
  it('the shipped artifact matches its build receipt and declares the 768 MiB cap', () => {
    const receipt = verifyAssets();
    expect(receipt.maximumMemoryBytes).toBe(805306368);
    const wasm = readFileSync(join(__dirname, '..', 'electron', 'restricted-pdf', 'assets', 'qpdf.wasm'));
    expect(declaredMaximumMemory(wasm)).toBe(805306368);
  });

  it('a tampered receipt is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jcad-qpdf-assets-'));
    for (const name of ['qpdf.wasm', 'qpdf.js', 'build-receipt.json', 'package.json']) {
      copyFileSync(join(__dirname, '..', 'electron', 'restricted-pdf', 'assets', name), join(dir, name));
    }
    const receipt = JSON.parse(readFileSync(join(dir, 'build-receipt.json'), 'utf8')) as { qpdfWasmSha256: string };
    receipt.qpdfWasmSha256 = '0'.repeat(64);
    writeFileSync(join(dir, 'build-receipt.json'), JSON.stringify(receipt));
    expect(() => verifyAssets(dir)).toThrow(/does not match its build receipt/);
  });
});
