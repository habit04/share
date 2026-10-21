/**
 * Bounded reader/decoder adapter for underlay content — the seam between the
 * retained reference model (core/underlay.ts) and any code that reads the
 * referenced file's bytes.
 *
 * What exists today, with NO new dependency: a probe. It identifies the
 * referenced file and, for PDF, counts pages — within hard caps on input
 * size, scanned bytes, page count and wall-clock deadline, with cooperative
 * cancellation. Everything heavier (rasterizing a PDF page, decoding DWF or
 * DGN content) stays behind this same interface until a decoder dependency
 * is admitted (PROPOSAL-P28-DEP, PENDING-CLAUDE); the probe honestly
 * reports `needsDecoder: true` instead of pretending to be one.
 *
 * Failure model: the probe NEVER throws and never returns partial results.
 * Corrupt or missing content, caps exceeded, cancellation and deadline all
 * come back as one typed refusal, so a caller can refuse atomically and
 * keep the retained reference untouched (it still displays as a frame).
 * The probe only sees bytes the caller already holds — it performs no I/O
 * and never writes to the referenced file.
 */
import type { UnderlayKind } from '../core/underlay';

export interface UnderlayCaps {
  /** Refuse inputs larger than this many bytes. */
  readonly maxBytes: number;
  /** Refuse to scan more than this many bytes hunting for structure. */
  readonly maxScanBytes: number;
  /** Refuse documents claiming more pages/sheets than this. */
  readonly maxPages: number;
  /** Refuse when the (injected) clock runs past this budget. */
  readonly deadlineMs: number;
}

export const DEFAULT_UNDERLAY_CAPS: UnderlayCaps = {
  maxBytes: 64 * 1024 * 1024,
  maxScanBytes: 8 * 1024 * 1024,
  maxPages: 10_000,
  deadlineMs: 5_000,
};

export type UnderlayProbeErrorCode = 'too-large' | 'too-many-pages' | 'scan-limit' | 'cancelled' | 'deadline' | 'corrupt' | 'unsupported';

export interface UnderlayProbeInfo {
  readonly kind: UnderlayKind;
  /** Format version as stored in the file header, when it carries one. */
  readonly version?: string;
  readonly pageCount?: number;
  /** True only when the count came from the document's own page tree. */
  readonly pageCountExact: boolean;
  /** True when rendering content still needs an admitted decoder. */
  readonly needsDecoder: boolean;
}

export type UnderlayProbeResult =
  | { readonly ok: true; readonly info: UnderlayProbeInfo }
  | { readonly ok: false; readonly code: UnderlayProbeErrorCode; readonly message: string };

export interface UnderlayProbeOptions {
  readonly signal?: AbortSignal;
  /** Injectable clock (tests drive deadline behaviour); defaults to Date.now. */
  readonly clock?: { now(): number };
}

const fail = (code: UnderlayProbeErrorCode, message: string): UnderlayProbeResult => ({ ok: false, code, message });

const CHUNK = 32 * 1024;

/** Latin-1 decode of a byte range (PDF/DWF structure keywords are ASCII). */
function latin1(bytes: Uint8Array, from: number, to: number): string {
  let out = '';
  for (let i = from; i < to; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, to));
    out += String.fromCharCode(...slice);
  }
  return out;
}

interface Budget {
  readonly caps: UnderlayCaps;
  readonly signal?: AbortSignal;
  readonly now: () => number;
  readonly started: number;
}

/** The refusal a spent budget produces, or null while budget remains. Checked per scan step. */
function spent(b: Budget): UnderlayProbeResult | null {
  if (b.signal?.aborted) return fail('cancelled', 'underlay probe was cancelled');
  if (b.now() - b.started > b.caps.deadlineMs) return fail('deadline', `underlay probe exceeded its ${b.caps.deadlineMs} ms deadline`);
  return null;
}

/**
 * The byte ranges to scan: the whole input when it fits the scan cap,
 * otherwise a head window and a tail window (PDF trailers/page trees live
 * at the end). `complete` is false when a middle span went unscanned.
 */
function scanWindows(length: number, cap: number): { windows: Array<readonly [number, number]>; complete: boolean } {
  if (length <= cap) return { windows: [[0, length]], complete: true };
  const head = Math.floor(cap / 2);
  return { windows: [[0, head], [length - (cap - head), length]], complete: false };
}

function probePdf(bytes: Uint8Array, budget: Budget): UnderlayProbeResult {
  // Header: "%PDF-" must appear within the first 1024 bytes (PDF spec allows
  // leading junk up to that bound); the version follows it.
  const headText = latin1(bytes, 0, Math.min(bytes.length, 1024));
  const at = headText.indexOf('%PDF-');
  if (at < 0) return fail('corrupt', 'not a PDF file (no %PDF- header)');
  const version = headText.slice(at + 5, at + 8).trim() || undefined;

  // A complete PDF ends with %%EOF near the tail; without it the file is truncated.
  const tailText = latin1(bytes, Math.max(0, bytes.length - 2048), bytes.length);
  if (!tailText.includes('%%EOF')) return fail('corrupt', 'truncated PDF file (no %%EOF marker)');

  const { windows, complete } = scanWindows(bytes.length, budget.caps.maxScanBytes);
  let maxCount: number | null = null;
  let pageObjects = 0;
  for (const [from, to] of windows) {
    const refusal = spent(budget);
    if (refusal) return refusal;
    const text = latin1(bytes, from, to);
    for (const m of text.matchAll(/\/Count\s+(\d+)/g)) {
      const n = Number(m[1]);
      if (Number.isSafeInteger(n) && (maxCount === null || n > maxCount)) maxCount = n;
    }
    pageObjects += [...text.matchAll(/\/Type\s*\/Page(?!s)/g)].length;
  }

  if (maxCount !== null) {
    if (maxCount > budget.caps.maxPages) return fail('too-many-pages', `PDF claims ${maxCount} pages, over the ${budget.caps.maxPages}-page cap`);
    return { ok: true, info: { kind: 'pdf', ...(version ? { version } : {}), pageCount: maxCount, pageCountExact: true, needsDecoder: true } };
  }
  if (pageObjects > 0) {
    if (pageObjects > budget.caps.maxPages) return fail('too-many-pages', `PDF has over the ${budget.caps.maxPages}-page cap`);
    // With an unscanned middle this is a floor, not a count — say so.
    return { ok: true, info: { kind: 'pdf', ...(version ? { version } : {}), pageCount: pageObjects, pageCountExact: false, needsDecoder: true } };
  }
  if (!complete) return fail('scan-limit', `no PDF page tree found within the ${budget.caps.maxScanBytes}-byte scan cap`);
  return fail('corrupt', 'no PDF page tree or page objects found');
}

function probeDwf(bytes: Uint8Array): UnderlayProbeResult {
  const head = latin1(bytes, 0, Math.min(bytes.length, 64));
  const m = /^\(DWF V([0-9.]+)\)/.exec(head);
  if (!m) return fail('corrupt', 'not a DWF file (no (DWF V…) header)');
  return { ok: true, info: { kind: 'dwf', version: m[1], pageCountExact: false, needsDecoder: true } };
}

/**
 * Probe referenced underlay bytes. `kind` comes from the drawing's
 * definition, never from sniffing: a mismatch between the declared kind and
 * the bytes is corruption, reported as such.
 */
export function probeUnderlay(kind: UnderlayKind, bytes: Uint8Array, caps: UnderlayCaps = DEFAULT_UNDERLAY_CAPS, opts: UnderlayProbeOptions = {}): UnderlayProbeResult {
  try {
    if (kind === 'dgn') return fail('unsupported', 'no DGN decoder is admitted yet; the reference is retained and displays as a frame');
    if (opts.signal?.aborted) return fail('cancelled', 'underlay probe was cancelled');
    if (bytes.length > caps.maxBytes) return fail('too-large', `underlay file is ${bytes.length} bytes, over the ${caps.maxBytes}-byte cap`);
    if (bytes.length === 0) return fail('corrupt', 'referenced underlay file is empty');
    const budget: Budget = { caps, signal: opts.signal, now: opts.clock ? () => opts.clock!.now() : () => Date.now(), started: opts.clock ? opts.clock.now() : Date.now() };
    return kind === 'pdf' ? probePdf(bytes, budget) : probeDwf(bytes);
  } catch (err) {
    // A probe must fail safely, never throw into an import path.
    return fail('corrupt', `underlay probe failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
