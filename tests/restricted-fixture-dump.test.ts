/**
 * Fixture generator for the 12.4 independent verifier — NOT a behavioral test.
 * Skipped unless JCAD_DUMP_RESTRICTED_FIXTURES=1. It builds the verifier's
 * exact plaintext/encrypted pair through the production paths:
 *   - plaintext: src writer output for a drawing whose only font is an
 *     authored preview/print fixture face, admitted via the restricted
 *     captured lookup (PDF 1.4, embedded FontFile2 + ToUnicode);
 *   - restricted.enc.pdf: the production one-shot child transform (owner
 *     password generated in the child and discarded, as in the app);
 *   - restricted.enc-known.pdf: the same pinned engine + argv with a known
 *     fixture owner password, so the verifier can assert owner-password
 *     authentication separately. The password below protects a synthetic
 *     fixture document only; it is not a product secret.
 * Regenerate: JCAD_DUMP_RESTRICTED_FIXTURES=1 npx vitest run tests/restricted-fixture-dump.test.ts
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Drawing } from '../src/core/document';
import type { TextEntity } from '../src/core/entities';
import { capturedPdfLookup, type PdfFontReader } from '../src/app/pdf-fonts';
import { vectorPdfCompressed, drawingContext, type PdfPageSpec } from '../src/io/pdf-vector';
import { pdfFontFixture } from './helpers/pdf-font-fixture';

const require = createRequire(import.meta.url);
const { createRestrictedPdfHost } = require('../electron/restricted-pdf/host.cjs') as {
  createRestrictedPdfHost(options?: { timeoutMs?: number }): { transform(input: Uint8Array): Promise<Uint8Array>; dispose(): Promise<void> };
};

const FIXTURE_OWNER_PASSWORD = 'jcad-124-fixture-owner';
const outDir = join(__dirname, '..', 'validation', 'restricted-pdf', 'fixtures');
const run = process.env.JCAD_DUMP_RESTRICTED_FIXTURES === '1' ? describe : describe.skip;

run('restricted verifier fixtures (generator)', () => {
  it('writes the plaintext + encrypted fixture pair', async () => {
    mkdirSync(outDir, { recursive: true });
    const style = { name: 'FACE', font: 'arial.ttf', bigFont: '', flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0 };
    const text = (id: string, value: string, y: number): TextEntity => ({ id, type: 'text', layer: '0', color: 'ByLayer', style: 'FACE', text: value, position: { x: 3, y }, height: 7.3, rotation: 0, align: 'left' });
    // The authored fixture program maps A and B only; both runs must use its
    // glyphs or the writer (correctly) falls back to a core font.
    const doc = new Drawing({ entities: [text('note1', 'AB', 4), text('note2', 'BA', 12)], meta: { textStyles: { FACE: style } } });
    const reader: PdfFontReader = async (request) => ({ font: pdfFontFixture({ family: request.family, bold: request.bold, italic: request.italic, fsType: 4 }) });
    const result = await capturedPdfLookup(doc.snapshot, reader, undefined, undefined, { restricted: true });
    expect(result.restrictedFaces).toHaveLength(1);
    const context = { ...drawingContext(doc.snapshot, result.lookup), embeddedFonts: result.fonts, textGeometry: result.geometry, fontFallbacks: new Set<string>() };
    const page: PdfPageSpec = { width: 300, height: 200, label: 'Sheet', groups: [{ entities: doc.entities, k: 2, e: 20, f: 30, hidden: new Set<string>(), ltUnit: 1, annoFactor: 1 }] };
    const plaintext = await vectorPdfCompressed([page], context, { mode: 'color', lineweights: true, usePlotStyles: false }, 'Restricted Fixture', async (data) => new Uint8Array(deflateSync(data)));
    expect(new TextDecoder('latin1').decode(plaintext.subarray(0, 8))).toBe('%PDF-1.4');
    writeFileSync(join(outDir, 'plaintext.pdf'), plaintext);

    const host = createRestrictedPdfHost({ timeoutMs: 120_000 });
    const encrypted = await host.transform(plaintext);
    await host.dispose();
    writeFileSync(join(outDir, 'restricted.enc.pdf'), encrypted);

    // Same engine + argv as the child, with the known fixture owner password.
    const assets = join(__dirname, '..', 'electron', 'restricted-pdf', 'assets');
    const factory = require(join(assets, 'qpdf.js')) as (options: object) => Promise<{ FS: { writeFile(name: string, data: Uint8Array): void; readFile(name: string): Uint8Array }; callMain(args: string[]): number }>;
    const module = await factory({ wasmBinary: readFileSync(join(assets, 'qpdf.wasm')), print: () => {}, printErr: () => {} });
    module.FS.writeFile('/in.pdf', plaintext);
    const status = module.callMain([
      '--stream-data=preserve', '--encrypt', '--user-password=', `--owner-password=${FIXTURE_OWNER_PASSWORD}`, '--bits=256',
      '--print=full', '--extract=y', '--accessibility=y', '--modify=none', '--annotate=n', '--form=n', '--assemble=n',
      '--', '/in.pdf', '/out.pdf',
    ]);
    expect(status).toBe(0);
    writeFileSync(join(outDir, 'restricted.enc-known.pdf'), module.FS.readFile('/out.pdf'));
  }, 180_000);
});
