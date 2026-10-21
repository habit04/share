import { describe, it, expect } from 'vitest';
import { DEFAULT_UNDERLAY_CAPS, probeUnderlay, type UnderlayCaps } from '../src/io/underlay-adapter';

// P28 slice 1: bounded reader/decoder adapter. The probe is the only part of
// underlay decoding that exists today, and it uses no new dependency: it
// identifies the referenced file and counts PDF pages within hard caps.
// Everything heavier (rasterizing a PDF page, decoding DWF/DGN) stays behind
// this interface until a decoder is admitted (PROPOSAL-P28-DEP). The probe
// NEVER throws and NEVER touches the referenced file itself: callers hand it
// bytes they already hold. Failure is a typed result, not an exception.

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function pdfWithCount(count: number): Uint8Array {
  return enc(
    `%PDF-1.4\n` +
      `1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n` +
      `2 0 obj << /Type /Pages /Count ${count} /Kids [3 0 R] >> endobj\n` +
      `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\n` +
      `trailer << /Root 1 0 R >>\n%%EOF\n`,
  );
}

function pdfPagesOnly(pages: number): Uint8Array {
  let body = '%PDF-1.7\n';
  for (let i = 0; i < pages; i += 1) body += `${i + 1} 0 obj << /Type /Page >> endobj\n`;
  return enc(`${body}%%EOF\n`);
}

describe('PDF probe', () => {
  it('identifies version and the page-tree count of a well-formed PDF', () => {
    const r = probeUnderlay('pdf', pdfWithCount(3));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.kind).toBe('pdf');
    expect(r.info.version).toBe('1.4');
    expect(r.info.pageCount).toBe(3);
    expect(r.info.pageCountExact).toBe(true);
    expect(r.info.needsDecoder).toBe(true); // a probe is not a rasterizer
  });

  it('nested page trees report the largest /Count (the root count)', () => {
    const bytes = enc('%PDF-1.5\n<< /Type /Pages /Count 2 /Kids [<< /Type /Pages /Count 12 >>] >>\n%%EOF\n');
    const r = probeUnderlay('pdf', bytes);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.info.pageCount).toBe(12);
  });

  it('without a page tree it counts page objects and marks the count inexact', () => {
    const r = probeUnderlay('pdf', pdfPagesOnly(4));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.pageCount).toBe(4);
    expect(r.info.pageCountExact).toBe(false);
  });

  it('corrupt input fails safely: bad header, truncated file, wrong kind, random bytes', () => {
    expect(probeUnderlay('pdf', enc('not a pdf at all'))).toMatchObject({ ok: false, code: 'corrupt' });
    expect(probeUnderlay('pdf', enc('%PDF-1.4\n<< /Type /Pages /Count 2 >>\n'))).toMatchObject({ ok: false, code: 'corrupt' }); // no %%EOF
    expect(probeUnderlay('pdf', pdfWithCount(2).subarray(0, 12))).toMatchObject({ ok: false });
    const junk = new Uint8Array(4096).map((_, i) => (i * 37) % 251);
    expect(probeUnderlay('pdf', junk).ok).toBe(false);
    expect(probeUnderlay('dwf', pdfWithCount(1))).toMatchObject({ ok: false, code: 'corrupt' });
  });

  it('caps: oversize input and an over-cap page count are refused, not truncated into a lie', () => {
    const caps: UnderlayCaps = { ...DEFAULT_UNDERLAY_CAPS, maxBytes: 16 };
    expect(probeUnderlay('pdf', pdfWithCount(1), caps)).toMatchObject({ ok: false, code: 'too-large' });
    const pageCaps: UnderlayCaps = { ...DEFAULT_UNDERLAY_CAPS, maxPages: 5 };
    expect(probeUnderlay('pdf', pdfWithCount(500), pageCaps)).toMatchObject({ ok: false, code: 'too-many-pages' });
  });

  it('scan cap: a page tree outside the scanned window is a scan-limit refusal, not a wrong count', () => {
    const filler = 'x'.repeat(4096);
    const bytes = enc(`%PDF-1.4\n${filler}\n<< /Type /Pages /Count 7 >>\n${filler}\n%%EOF\n`);
    const caps: UnderlayCaps = { ...DEFAULT_UNDERLAY_CAPS, maxScanBytes: 1024 };
    expect(probeUnderlay('pdf', bytes, caps)).toMatchObject({ ok: false, code: 'scan-limit' });
  });

  it('cancellation: a pre-aborted signal refuses before any scanning', () => {
    const ctl = new AbortController();
    ctl.abort();
    expect(probeUnderlay('pdf', pdfWithCount(1), DEFAULT_UNDERLAY_CAPS, { signal: ctl.signal })).toMatchObject({ ok: false, code: 'cancelled' });
  });

  it('deadline: an injected clock that runs out mid-scan refuses with deadline', () => {
    let calls = 0;
    const clock = { now: () => (calls++ === 0 ? 0 : 60_000) };
    const caps: UnderlayCaps = { ...DEFAULT_UNDERLAY_CAPS, deadlineMs: 1000 };
    expect(probeUnderlay('pdf', pdfWithCount(2), caps, { clock })).toMatchObject({ ok: false, code: 'deadline' });
  });
});

describe('PDF probe page-count exactness (acceptance F-C)', () => {
  /** A /Count in a bare dictionary — no /Kids, so not a page-tree node. */
  function pdfBareCount(count: number, pageObjs: number): Uint8Array {
    let body = `%PDF-1.4\n2 0 obj << /Type /Pages /Count ${count} >> endobj\n`;
    for (let i = 0; i < pageObjs; i += 1) body += `${i + 3} 0 obj << /Type /Page >> endobj\n`;
    return enc(`${body}%%EOF\n`);
  }

  /** A real page-tree node (carries /Kids) plus its page objects. */
  function pdfTreeCount(count: number, pageObjs: number): Uint8Array {
    const kids = Array.from({ length: pageObjs }, (_, i) => `${i + 3} 0 R`).join(' ');
    let body = `%PDF-1.4\n2 0 obj << /Type /Pages /Count ${count} /Kids [${kids}] >> endobj\n`;
    for (let i = 0; i < pageObjs; i += 1) body += `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj\n`;
    return enc(`${body}%%EOF\n`);
  }

  it('a lying bare /Count in a complete scan is a claim, not an exact count (acceptance C4.4)', () => {
    const r = probeUnderlay('pdf', pdfBareCount(5, 1)); // claims 5, exactly 1 page object
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.pageCount).toBe(5); // still reported — as the claim it is
    expect(r.info.pageCountExact).toBe(false);
  });

  it('a /Count from an incomplete scan is never exact (acceptance C4.5)', () => {
    const filler = 'x'.repeat(6000);
    const bytes = enc(`%PDF-1.4\n<< /Type /Pages /Count 3 >>\n${filler}\n%%EOF\n`);
    const caps: UnderlayCaps = { ...DEFAULT_UNDERLAY_CAPS, maxScanBytes: 1024 };
    const r = probeUnderlay('pdf', bytes, caps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.pageCount).toBe(3);
    expect(r.info.pageCountExact).toBe(false);
  });

  it('a bare-dictionary /Count is inexact even when numerically consistent (not verifiable as the tree count)', () => {
    const r = probeUnderlay('pdf', pdfBareCount(1, 1));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.pageCount).toBe(1);
    expect(r.info.pageCountExact).toBe(false);
  });

  it('a tree count contradicted by more page objects than it claims is inexact', () => {
    const r = probeUnderlay('pdf', pdfTreeCount(2, 3)); // tree claims 2, scan finds 3 page objects
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.pageCount).toBe(2);
    expect(r.info.pageCountExact).toBe(false);
  });

  it('a consistent page-tree count stays exact (complete scan, tree node, not contradicted)', () => {
    const r = probeUnderlay('pdf', pdfTreeCount(2, 2));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.pageCount).toBe(2);
    expect(r.info.pageCountExact).toBe(true);
  });

  it('when the largest /Count is not a page-tree node count, the count stands but exactness does not', () => {
    const bytes = enc('%PDF-1.5\n<< /Type /Pages /Count 2 /Kids [<< /Type /Pages /Count 12 >>] >>\n%%EOF\n');
    const r = probeUnderlay('pdf', bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.pageCount).toBe(12); // largest-count heuristic unchanged
    expect(r.info.pageCountExact).toBe(false);
  });
});

describe('DWF / DGN probes', () => {
  it('a DWF signature is identified; decoding stays behind the admitted-decoder gate', () => {
    const r = probeUnderlay('dwf', enc('(DWF V06.00)rest of file'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.version).toBe('06.00');
    expect(r.info.needsDecoder).toBe(true);
    expect(r.info.pageCount).toBeUndefined();
  });

  it('DGN refuses as unsupported until a decoder is admitted — for any bytes', () => {
    expect(probeUnderlay('dgn', enc('anything'))).toMatchObject({ ok: false, code: 'unsupported' });
    expect(probeUnderlay('dgn', new Uint8Array(0))).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('an empty input is corrupt for pdf/dwf, never a crash', () => {
    expect(probeUnderlay('pdf', new Uint8Array(0))).toMatchObject({ ok: false, code: 'corrupt' });
    expect(probeUnderlay('dwf', new Uint8Array(0))).toMatchObject({ ok: false, code: 'corrupt' });
  });
});
