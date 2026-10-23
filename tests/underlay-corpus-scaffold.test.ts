import { describe, it, expect } from 'vitest';

// P28 ACCEPTANCE CORPUS — SCAFFOLD (P28-DEP FINAL ruling, 2026-10-21).
//
// The 8-class CAD corpus defined in reviews/P28-DEP-COMPARISON.md §1.3 is
// P28's ACCEPTANCE TEST BEFORE COMPOSITION: it must exist, be populated
// (≥ 4 files per class, plotted from real CAD sources), and be run
// against the admitted engine's rasters before the P28 slice composes.
// THIS FILE IS THE SCAFFOLD ONLY — no class A–G case is executed here,
// and nothing in this file is evidence of a corpus run. The acceptance
// run itself needs real CAD-plotted PDFs plus reference rasters (Acrobat
// or Chrome print-to-image at matched DPI, disagreements resolved by
// human inspection), which are composition-stage inputs.
//
// The corpus binds to the ENGINE INTERFACE's output (page rasters via
// src/io/underlay-engine.ts), never to pdfjs internals, so it survives an
// engine swap unchanged (§1.3; the FINAL ruling keeps the interface as
// the swap seam even though PDFium is not admitted).
//
// Scoring (§1.3): per file, perceptual pixel-diff vs the reference at
// matched DPI — linework classes A/B/F ≤ 0.1% pixels differing beyond
// antialiasing tolerance; fills C/D/G ≤ 0.5% — PLUS named human-checked
// spot points per file (a dimension string legible, a hatch phase
// correct, a dash phase correct). A file fails on threshold breach or
// any spot-point failure.
//
// Class H (adversarial/malformed) is the fuzz leg and is ALREADY
// EXECUTED for its currently-buildable cases in
// tests/underlay-pdfjs.test.ts — the mapping is pinned in the class-H
// block below. The remaining class-H cases (recursive patterns, font
// bombs, billion-laughs content streams) need crafted fixture files and
// land with the corpus population, before composition.

export interface CorpusClassSpec {
  /** §1.3 class letter. */
  readonly classId: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';
  readonly name: string;
  /** Minimum files when populated (§1.3: each class ≥ 4 files). */
  readonly minFiles: number;
  /** Pixel-diff threshold (% of pixels differing beyond AA tolerance). */
  readonly thresholdPct: number | null; // null = not scored on output (class H: containment only)
  /** Fixture directory (relative to tests/) the populated corpus reads. */
  readonly fixtureDir: string;
  /** Where the class's cases are executed. */
  readonly executedIn: string;
  readonly status: 'scaffold-only' | 'partially-executed';
}

export const CORPUS_CLASSES: readonly CorpusClassSpec[] = [
  { classId: 'A', name: 'Linework precision — dense detail sheets, 0.05–0.5 pt fine parallel lines, far-from-origin geometry (≥ 100,000 units)', minFiles: 4, thresholdPct: 0.1, fixtureDir: 'fixtures/underlay-corpus/A-linework', executedIn: 'this file, once populated', status: 'scaffold-only' },
  { classId: 'B', name: 'Line weights & dashes — linetype zoo (continuous/hidden/center/phantom/dash-dot/custom text-bearing), weights 0.05–2.0 pt, two plot scales', minFiles: 4, thresholdPct: 0.1, fixtureDir: 'fixtures/underlay-corpus/B-linetypes', executedIn: 'this file, once populated', status: 'scaffold-only' },
  { classId: 'C', name: 'Hatches & patterns — ANSI/ISO pattern fills, solid + gradient-adjacent fills, Type3-font text, pattern phase at sheet edges', minFiles: 4, thresholdPct: 0.5, fixtureDir: 'fixtures/underlay-corpus/C-patterns', executedIn: 'this file, once populated', status: 'scaffold-only' },
  { classId: 'D', name: 'Transparency — layered title block, transparency groups, blend-mode revision clouds, soft masks on logos', minFiles: 4, thresholdPct: 0.5, fixtureDir: 'fixtures/underlay-corpus/D-transparency', executedIn: 'this file, once populated', status: 'scaffold-only' },
  { classId: 'E', name: 'Text — embedded subset TrueType (several CAD fonts), text-as-outlines, SHX-substitute output, vertical/rotated text, 1.5 pt text', minFiles: 4, thresholdPct: null, fixtureDir: 'fixtures/underlay-corpus/E-text', executedIn: 'this file, once populated (spot points are the primary score)', status: 'scaffold-only' },
  { classId: 'F', name: 'Large format — ARCH E (36×48") and A0 sheets at fit-to-screen AND 400% zoom on a clipped title-block region via the adapter tile path', minFiles: 4, thresholdPct: 0.1, fixtureDir: 'fixtures/underlay-corpus/F-large-format', executedIn: 'this file, once populated', status: 'scaffold-only' },
  { classId: 'G', name: 'Colour — DeviceRGB linework (exact match), one ICC-tagged sheet, one CMYK sheet (overprint file scored separately; the known pdf.js gap)', minFiles: 4, thresholdPct: 0.5, fixtureDir: 'fixtures/underlay-corpus/G-colour', executedIn: 'this file, once populated', status: 'scaffold-only' },
  { classId: 'H', name: 'Adversarial/malformed — truncated streams, corrupt xref, recursive patterns, font bombs, billion-laughs content streams; pass = containment within the adapter caps, a reported (typed) error, other pages/files unaffected. Output correctness is NOT scored.', minFiles: 4, thresholdPct: null, fixtureDir: 'fixtures/underlay-corpus/H-adversarial', executedIn: 'tests/underlay-pdfjs.test.ts (buildable cases) + this file once populated', status: 'partially-executed' },
];

/**
 * The class-H mapping, expressly: which §1.3 class-H cases are executed
 * TODAY, and where. Every entry names a test that exists and runs in
 * tests/underlay-pdfjs.test.ts (plus the C5 cap tests that class H's
 * "no hang past the adapter's caps" pass condition depends on).
 */
export const CLASS_H_EXECUTED: readonly { readonly case: string; readonly executedAs: string }[] = [
  { case: 'truncated streams / truncated file', executedAs: 'underlay-pdfjs.test.ts > malformed-PDF corpus > truncated file' },
  { case: 'corrupt xref', executedAs: 'underlay-pdfjs.test.ts > malformed-PDF corpus > bad xref (offsets zeroed)' },
  { case: 'encrypted without a password (containment: typed refusal)', executedAs: 'underlay-pdfjs.test.ts > malformed-PDF corpus > encrypted without a password' },
  { case: 'non-PDF bytes', executedAs: 'underlay-pdfjs.test.ts > malformed-PDF corpus > non-PDF bytes' },
  { case: 'absurd page-count claim (cap containment)', executedAs: 'underlay-pdfjs.test.ts > malformed-PDF corpus > absurd page-count claim' },
  { case: 'zero-page document', executedAs: 'underlay-pdfjs.test.ts > malformed-PDF corpus > zero-page document' },
  { case: 'no hang / no breach past the caps (64 MiB / 10k pages / 8 MiB per page / 5 s / cancellation)', executedAs: 'underlay-pdfjs.test.ts > C5 caps enforced in the adapter (5 tests)' },
];
export const CLASS_H_PENDING: readonly string[] = [
  'recursive patterns',
  'font bombs',
  'billion-laughs-style content streams',
];

describe('P28 acceptance corpus scaffold (§1.3) — NOT an executed corpus run', () => {
  it('enumerates exactly the 8 classes of the comparison, each with its §1.3 floor and threshold', () => {
    expect(CORPUS_CLASSES.map((c) => c.classId)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    for (const c of CORPUS_CLASSES) expect(c.minFiles).toBeGreaterThanOrEqual(4);
    expect(CORPUS_CLASSES.find((c) => c.classId === 'A')!.thresholdPct).toBe(0.1);
    expect(CORPUS_CLASSES.find((c) => c.classId === 'F')!.thresholdPct).toBe(0.1);
    expect(CORPUS_CLASSES.find((c) => c.classId === 'C')!.thresholdPct).toBe(0.5);
    expect(CORPUS_CLASSES.find((c) => c.classId === 'H')!.thresholdPct).toBeNull(); // containment, not output
  });

  it('class H maps expressly onto the executed fuzz corpus, with the unbuilt cases named as pending', () => {
    const h = CORPUS_CLASSES.find((c) => c.classId === 'H')!;
    expect(h.status).toBe('partially-executed');
    expect(CLASS_H_EXECUTED.length).toBeGreaterThanOrEqual(6);
    for (const entry of CLASS_H_EXECUTED) expect(entry.executedAs).toContain('underlay-pdfjs.test.ts');
    expect(CLASS_H_PENDING).toEqual(['recursive patterns', 'font bombs', 'billion-laughs-style content streams']);
  });

  // Classes A–G: populated with real CAD-plotted files + reference
  // rasters before composition. Each becomes a per-file raster-diff test
  // against the engine interface output when its fixtures land; until
  // then they are recorded as TODO — visibly unexecuted, never skipped
  // silently and never claimed as run.
  it.todo('class A — linework precision (≥4 CAD-plotted files, diff ≤ 0.1%, spot points)');
  it.todo('class B — line weights & dashes (≥4 files, diff ≤ 0.1%, dash-phase spot points)');
  it.todo('class C — hatches & patterns (≥4 files, diff ≤ 0.5%, hatch-phase spot points)');
  it.todo('class D — transparency (≥4 files, diff ≤ 0.5%)');
  it.todo('class E — text (≥4 files, legibility spot points primary)');
  it.todo('class F — large format fit + 400% clipped-region tile leg (≥4 files, diff ≤ 0.1%)');
  it.todo('class G — colour (≥4 files, diff ≤ 0.5%; CMYK overprint scored separately)');
  it.todo('class H pending cases — recursive patterns, font bombs, billion-laughs streams (containment)');
});
