/**
 * PR #65 review P2 — PDF font preparation must preserve the captured
 * lookup's xref channels (tests-first pins).
 *
 * `capturedPdfLookup` (src/app/pdf-fonts.ts) returns the lookup the
 * vector plot expands with. When a font `reader` is present (Windows
 * `capturePlot` supplies `bridge.pdfFont`), it built that lookup as a
 * fresh callable carrying ONLY the prepared textGeometry — dropping
 * the captured lookup's `sources` (per-file provenance) and `forDef`
 * (def-scope hook) channels. `plotLayoutsOrVector` then wraps the
 * result with `withUnderlaySizeChannel`, which forwards the channels
 * of whatever it is given — it cannot recover channels an earlier
 * rebuild already dropped. Expansion through the prepared lookup fell
 * back to unsourced, host-table resolution. Drawings with no text at
 * all regress the same way: the reader's presence selects the branch
 * before any font is requested.
 *
 * Pins (all RED at 29bf72b):
 *  F1  unit: with a present reader returning { font: null }, the
 *      prepared lookup still carries the captured lookup's sources,
 *      forDef and underlaySizeOf (by identity), resolves names
 *      through it, and replaces only the text geometry.
 *  F2  unit: a forDef-scoped lookup derived from the prepared lookup
 *      keeps its channels and carries the prepared text geometry
 *      recursively.
 *  F3  vector entry (plotLayoutsOrVector, explicit colour output,
 *      shipped host-layers/child-layers fixtures): the reader-present
 *      plot is the no-reader control — three paths, the child's DUP
 *      line green and its CHILDONLY line red. At base the child's ON
 *      green line is culled by the host's OFF layer and the CHILDONLY
 *      line falls back to black: two paths (yellow/black).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { setPathPlatform } from '../src/app/paths';
import { readDxf } from '../src/io/dxf';
import { Drawing } from '../src/core/document';
import { withUnderlaySizeChannel, underlaySizeResolver } from '../src/core/entities';
import {
  stageXrefLoad,
  type XrefFileReader,
  type XrefReadResult,
} from '../src/io/xref-loading';
import { buildResolvedXrefContext, type XrefSessionStamp } from '../src/app/xref-resolved';
import { capturedPdfLookup, type PdfFontReader } from '../src/app/pdf-fonts';
import { plotLayoutsOrVector } from '../src/app/plot-vector';
import { ExportAdmission, type CapturedPlot } from '../src/app/export-admission';
import type { Editor, FileBridge } from '../src/app/editor';
import { parsePdfBasics, pageContents } from './helpers/pdf';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'xref', name), 'utf8');
const stamp: XrefSessionStamp = { docId: 'doc-1', contentGeneration: 1 };

function fakeReader(files: Map<string, string>): XrefFileReader {
  return {
    async readText(resolvedPath: string): Promise<XrefReadResult> {
      const text = files.get(resolvedPath);
      if (text === undefined) {
        const error = new Error(`ENOENT: no such file or directory, open '${resolvedPath}'`) as Error & { code?: string };
        error.code = 'ENOENT';
        throw error;
      }
      return text;
    },
  };
}

async function loadWith(hostName: string, hostPath: string, files: Map<string, string>) {
  const hostState = readDxf(fixture(hostName));
  const outcome = await stageXrefLoad({ hostState, hostPath }, { reader: fakeReader(files) });
  const snapshot = outcome.snapshot!;
  const ctx = buildResolvedXrefContext(snapshot, stamp, hostState);
  const base = new Drawing(hostState).lookupBlock;
  return { hostState, snapshot, ctx, expansion: ctx.expansionLookup(base) };
}

const nullReader: PdfFontReader = async () => ({ font: null });

beforeAll(() => setPathPlatform('posix'));
afterAll(() => setPathPlatform(null));

describe('PR #65 P2: PDF font preparation preserves the captured lookup channels', () => {
  it('F1: the prepared lookup keeps sources/forDef/underlaySizeOf and replaces only textGeometry', async () => {
    const { hostState, expansion } = await loadWith('host-layers.dxf', '/proj/host-layers.dxf',
      new Map([['/proj/child-layers.dxf', fixture('child-layers.dxf')]]));
    // The captured lookup as the vector composition holds it: the xref
    // expansion lookup wrapped with the page-size channel (all four
    // channels present).
    const sized = withUnderlaySizeChannel(expansion, underlaySizeResolver(hostState.underlays));
    const prepared = await capturedPdfLookup(hostState, nullReader, undefined, sized);
    expect(prepared.lookup.sources).toBe(sized.sources);
    expect(prepared.lookup.forDef).toBeTypeOf('function');
    expect(prepared.lookup.underlaySizeOf).toBe(sized.underlaySizeOf);
    // Name resolution still delegates to the captured lookup.
    expect(prepared.lookup('LX')).toBe(sized('LX'));
    // Only the text geometry is replaced — by the prepared one (here
    // undefined: the reader returned no font and nothing was plotted).
    expect(prepared.lookup.textGeometry).toBe(prepared.geometry);
  });

  it('F2: a forDef-scoped lookup derived from the prepared lookup keeps its channels recursively', async () => {
    const { hostState, expansion } = await loadWith('host-layers.dxf', '/proj/host-layers.dxf',
      new Map([['/proj/child-layers.dxf', fixture('child-layers.dxf')]]));
    const sized = withUnderlaySizeChannel(expansion, underlaySizeResolver(hostState.underlays));
    const prepared = await capturedPdfLookup(hostState, nullReader, undefined, sized);
    const rootDef = sized('LX');
    expect(rootDef).toBeTruthy();
    const rawScoped = sized.forDef!('LX', rootDef!);
    const scoped = prepared.lookup.forDef!('LX', rootDef!);
    expect(scoped).toBeTruthy();
    expect(typeof scoped!.forDef).toBe(typeof rawScoped!.forDef);
    expect(scoped!.sources).toBe(rawScoped!.sources);
    expect(scoped!.underlaySizeOf).toBe(sized.underlaySizeOf);
    // The scoped lookup carries the PREPARED text geometry, not the
    // captured one — the writer meets the same geometry at every depth.
    expect(scoped!.textGeometry).toBe(prepared.geometry);
  });

  it('F3 (vector entry): a present font reader does not change the sourced plot — three green/red paths', async () => {
    const { hostState, ctx } = await loadWith('host-layers.dxf', '/proj/host-layers.dxf',
      new Map([['/proj/child-layers.dxf', fixture('child-layers.dxf')]]));
    const plotWith = async (withReader: boolean): Promise<string> => {
      const saved: { bytes: Uint8Array; name: string }[] = [];
      const bridge = {
        platform: 'win32',
        savePdf: async (bytes: Uint8Array, name: string) => { saved.push({ bytes, name }); return 'out.pdf'; },
      } as unknown as FileBridge;
      const captured: CapturedPlot = {
        state: hostState, base: 'host-layers', bridge, security: 'none',
        underlayBytes: async () => new Uint8Array(), xref: ctx,
        ...(withReader ? { pdfFont: nullReader } : {}),
      };
      const ed = { log: () => { /* captured */ }, fileBridge: bridge } as unknown as Editor;
      const done = await plotLayoutsOrVector(ed,
        { action: 'pdf', options: { paper: 'letter', orientation: 'landscape', scale: 'fit', margin: 0.25, output: 'vector', style: 'color' } },
        { captured, admission: new ExportAdmission(bridge, false) });
      expect(done).toBe(true);
      expect(saved).toHaveLength(1);
      const pdf = parsePdfBasics(saved[0]!.bytes);
      return pageContents(pdf, (data) => new Uint8Array(inflateSync(data))).join('\n');
    };
    const control = await plotWith(false);
    // The control (no reader): the child's DUP line in the child's
    // green, the CHILDONLY line in the child's red, three paths total.
    expect(control).toContain('0 1 0 RG');
    expect(control).toContain('1 0 0 RG');
    expect(control.match(/ l S/g)).toHaveLength(3);
    const reader = await plotWith(true);
    // With the reader present the plot must be the same plot: at base
    // the green line is culled (host DUP is OFF) and CHILDONLY falls
    // back to black — two paths, one of them '0 0 0 RG'.
    expect(reader).toContain('0 1 0 RG');
    expect(reader).toContain('1 0 0 RG');
    expect(reader).not.toContain('0 0 0 RG');
    expect(reader.match(/ l S/g)).toHaveLength(3);
    expect(reader).toBe(control);
  });
});
