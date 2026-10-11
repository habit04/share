/**
 * Damaged DXF files (handcrafted fixtures in tests/fixtures/broken): invalid structure is rejected
 * with a clear error naming the line; a file that ends early can be opened partially on request
 * (marked as recovered, with a report of what was recovered); invalid geometry is rejected per
 * object and listed in the import report.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDxf, writeDxf, DxfReadError } from '../src/io/dxf';
import { importReportOf, saveOverwriteWarning, geometryProblem } from '../src/io/import-report';
import { readDxfForOpen, confirmSaveOver } from '../src/app/import-open';
import type { Entity } from '../src/core/entities';

const broken = (name: string) => readFileSync(join(__dirname, 'fixtures', 'broken', name), 'latin1');
function readError(text: string, opts = {}): DxfReadError {
  try {
    readDxf(text, opts);
  } catch (err) {
    expect(err).toBeInstanceOf(DxfReadError);
    return err as DxfReadError;
  }
  throw new Error('expected a DxfReadError');
}

describe('invalid DXF structure', () => {
  it('rejects non-finite/unsafe integers and out-of-range display precision with value lines', () => {
    const header = (name: string, value: string) => ['0', 'SECTION', '2', 'HEADER', '9', name, '70', value, '0', 'ENDSEC', '0', 'EOF'].join('\n');
    for (const name of ['$DIMDEC', '$DIMADEC', '$DIMALTD', '$DIMTDEC', '$LUPREC', '$AUPREC']) expect(readError(header(name, '9999'))).toMatchObject({ line: 8, message: expect.stringContaining(`${name} precision`) });
    expect(readError(header('$DIMDEC', '9'.repeat(400)))).toMatchObject({ line: 8, message: expect.stringContaining('invalid number') });
    expect(readError(header('$DIMDEC', '9007199254740992')).line).toBe(8);
    for (const code of ['9'.repeat(400), '9999', '-1']) expect(readError(`${code}\nSECTION\n0\nEOF\n`)).toMatchObject({ line: 1, message: expect.stringContaining('not a DXF group code') });
    expect(readDxf(header('$DIMADEC', '-1')).header!.dimStyle.angularDecimals).toBe(-1);
  });
  it('rejects garbage numeric suffixes instead of accepting a numeric prefix', () => {
    const text = ['0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '5', 'ABC', '8', 'TEST', '10', '12oops', '20', '0', '11', '1', '21', '0', '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const state = readDxf(text);
    expect(state.entities).toHaveLength(0);
    expect(importReportOf(state)?.items).toEqual([expect.objectContaining({ type: 'LINE', handle: 'ABC', layer: 'TEST', line: 5, where: 'model space', reason: expect.stringMatching(/group 10, value line 12: "12oops"/) })]);
    const header = ['0', 'SECTION', '2', 'HEADER', '9', '$LTSCALE', '40', '2junk', '0', 'ENDSEC', '0', 'EOF'].join('\n');
    expect(readError(header)).toMatchObject({ line: 8, message: expect.stringMatching(/\$LTSCALE group 40.*2junk/) });
  });

  it('checks string, pair, record and source budgets before allocating the import', () => {
    const minimal = '0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n';
    expect(() => readDxf(minimal, { maxSourceLength: 8 })).toThrow(/source text size limit/);
    expect(() => readDxf(minimal, { maxStringLength: 3 })).toThrow(/string length limit/);
    expect(() => readDxf(minimal, { maxPairs: 2 })).toThrow(/group pair limit/);
    expect(() => readDxf(minimal, { maxRecords: 2 })).toThrow(/record limit/);
    expect(readDxf(minimal, { maxPairs: 4, maxRecords: 3 }).entities).toEqual([]);
  });

  it('rejects out-of-range DIMSTYLE record precision without accepting a dangerous style', () => {
    const text = ['0', 'SECTION', '2', 'TABLES', '0', 'DIMSTYLE', '105', 'A1', '2', 'BAD', '271', '9999', '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const state = readDxf(text);
    expect(importReportOf(state)?.items).toContainEqual(expect.objectContaining({ type: 'DIMSTYLE', action: 'dropped', reason: expect.stringMatching(/DIMDEC precision at line 12/) }));
  });

  it('reports malformed legacy VERTEX numbers at their value line', () => {
    const text = ['0', 'SECTION', '2', 'ENTITIES', '0', 'POLYLINE', '5', 'AA', '8', 'VERTS', '0', 'VERTEX', '10', '2oops', '20', '0', '0', 'VERTEX', '10', '3', '20', '0', '0', 'SEQEND', '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const state = readDxf(text);
    expect(state.entities).toHaveLength(0);
    expect(importReportOf(state)?.items).toContainEqual(expect.objectContaining({ type: 'POLYLINE', handle: 'AA', layer: 'VERTS', reason: expect.stringMatching(/group 10, value line 14: "2oops"/) }));
  });

  it('drops unsafe inline MTEXT numeric factors with source context', () => {
    const text = ['0', 'SECTION', '2', 'ENTITIES', '0', 'MTEXT', '5', 'F1', '8', 'NOTES', '10', '0', '20', '0', '40', '1', '41', '10', '71', '1', '1', '\\H1e308x;\\H1e308x;BAD', '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const state = readDxf(text);
    expect(state.entities).toHaveLength(0);
    expect(importReportOf(state)?.items).toContainEqual(expect.objectContaining({ type: 'MTEXT', handle: 'F1', layer: 'NOTES', line: 5, where: 'model space', action: 'dropped', reason: expect.stringContaining('MTEXT formatting') }));
  });

  it('rejects a non-numeric group code with its line number', () => {
    const e = readError(broken('bad-groupcode.dxf'));
    expect(e.line).toBe(9);
    expect(e.truncated).toBe(false);
    expect(e.message).toMatch(/Line 9: "1O" is not a DXF group code/);
  });

  it('rejects a SECTION that starts before the previous one is closed', () => {
    const e = readError(broken('unbalanced.dxf'));
    expect(e.message).toMatch(/Line 9: a new SECTION starts before section HEADER \(line 1\) is closed with ENDSEC/);
    expect(e.truncated).toBe(false);
  });

  it('rejects an ENDSEC without SECTION', () => {
    const e = readError(broken('stray-endsec.dxf'));
    expect(e.message).toMatch(/ENDSEC without a matching SECTION/);
    expect(e.line).toBe(19);
  });

  it('rejects content outside sections, empty files and binary DXF', () => {
    expect(readError('0\nLINE\n8\n0\n0\nEOF\n').message).toMatch(/"LINE" appears outside any SECTION/);
    expect(readError('').message).toMatch(/empty or is not a DXF file/);
    expect(readError('\n\n').message).toMatch(/empty or is not a DXF file/);
    expect(readError('AutoCAD Binary DXF\r\n\x1a\x00').message).toMatch(/binary DXF/);
    expect(readError('Hello, I am a text file\nnot a drawing\n').message).toMatch(/Line 1: "Hello, I am a text file" is not a DXF group code/);
  });

  it('structural errors are not recoverable', () => {
    expect(readError(broken('unbalanced.dxf'), { recover: true }).truncated).toBe(false);
  });

  it('accepts comments (999) and trailing blank lines', () => {
    const s = readDxf('999\nwritten by hand\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n0\n20\n0\n11\n1\n21\n0\n0\nENDSEC\n0\nEOF\n\n\n');
    expect(s.entities).toHaveLength(1);
    expect(importReportOf(s)).toBeUndefined();
  });
});

describe('truncated DXF files and partial recovery', () => {
  it('a file that ends inside a group pair is reported as truncated with its last line', () => {
    const e = readError(broken('truncated.dxf'));
    expect(e.truncated).toBe(true);
    expect(e.line).toBe(83);
    expect(e.message).toMatch(/ends early at line 83: section ENTITIES \(line \d+\) is not closed and the end-of-file marker is missing/);
  });

  it('a missing EOF after a closed section is truncation too', () => {
    const e = readError(broken('missing-eof.dxf'));
    expect(e.truncated).toBe(true);
    expect(e.message).toMatch(/end-of-file marker is missing/);
  });

  it('recovery opens what was readable, leaves out the incomplete object and marks the drawing', () => {
    const s = readDxf(broken('truncated.dxf'), { recover: true, filePath: '/x/plant.dxf' });
    expect(s.entities.map((x) => x.type)).toEqual(['line', 'circle']);
    expect(s.layers.find((l) => l.name === 'WIRES')?.color).toBe(1);
    const r = importReportOf(s)!;
    expect(r.recovered).toEqual({ line: 83, message: expect.stringMatching(/ends early at line 83/) });
    expect(r.items).toContainEqual(expect.objectContaining({ type: 'LINE', handle: '102', action: 'dropped', reason: expect.stringMatching(/incomplete/) }));
    // Save over the damaged file warns and suggests Save As; the result is a valid DXF again.
    expect(saveOverwriteWarning(s, '/x/plant.dxf')).toMatch(/recovered from a damaged file .*Save As/);
    const again = readDxf(writeDxf(s));
    expect(again.entities).toHaveLength(2);
    expect(importReportOf(again)).toBeUndefined();
  });

  it('recovery of a file whose last section has no ENDSEC', () => {
    const s = readDxf(broken('open-section.dxf'), { recover: true });
    // The last object before the end may be incomplete and is left out (reported).
    expect(s.entities.map((x) => x.type)).toEqual(['line']);
    expect(importReportOf(s)!.items[0]).toMatchObject({ type: 'CIRCLE', handle: '101', action: 'dropped' });
  });

  it('recovery of a file that only lacks EOF keeps everything', () => {
    const s = readDxf(broken('missing-eof.dxf'), { recover: true });
    expect(s.entities).toHaveLength(1);
    expect(importReportOf(s)!.recovered?.message).toMatch(/no EOF marker/);
    expect(importReportOf(s)!.items).toEqual([]);
  });

  it('a file cut exactly where the next object would start keeps every complete object', () => {
    const dxf = (tail: string) => `0\nSECTION\n2\nENTITIES\n0\nLINE\n5\n10\n8\n0\n10\n0\n20\n0\n30\n0\n11\n1\n21\n1\n31\n0\n0\nCIRCLE\n5\n11\n8\n0\n10\n5\n20\n5\n30\n0\n40\n2${tail}`;
    // A lone "0" group code (with or without its line break) is a new object that never got its type: the circle is complete.
    for (const tail of ['\n0', '\n0\n', '\n0\n\n']) {
      const s = readDxf(dxf(tail), { recover: true });
      expect(s.entities.map((x) => x.type)).toEqual(['line', 'circle']);
      expect(importReportOf(s)!.items).toEqual([]);
      expect(importReportOf(s)!.recovered).toBeDefined();
    }
    // Any other lone group code belongs to the circle, which is then incomplete and left out.
    const cut = readDxf(dxf('\n62'), { recover: true });
    expect(cut.entities.map((x) => x.type)).toEqual(['line']);
    expect(importReportOf(cut)!.items[0]).toMatchObject({ type: 'CIRCLE', handle: '11', action: 'dropped' });
    // Without a lone code the last object may be incomplete and is left out (not knowable).
    expect(readDxf(dxf(''), { recover: true }).entities.map((x) => x.type)).toEqual(['line']);
    // Content after EOF is ignored, not truncation.
    expect(readDxf(dxf('\n0\nENDSEC\n0\nEOF\n0'), {}).entities).toHaveLength(2);
  });

  it('OPEN asks "open what was readable?" and honours the answer', async () => {
    const asked: string[] = [];
    const no = await readDxfForOpen(broken('truncated.dxf'), '/x/plant.dxf', async (_t, m) => (asked.push(m), false));
    expect(no).toBeNull();
    expect(asked[0]).toMatch(/ends early at line 83.*Open what was readable\?/s);
    const yes = await readDxfForOpen(broken('truncated.dxf'), '/x/plant.dxf', async () => true);
    expect(importReportOf(yes!)?.recovered?.line).toBe(83);
    expect(await confirmSaveOver(yes!, '/x/plant.dxf', async () => false)).toBe('save-as');
    // Structural damage is not offered for recovery: the error propagates.
    await expect(readDxfForOpen(broken('unbalanced.dxf'), null, async () => true)).rejects.toBeInstanceOf(DxfReadError);
  });
});

describe('invalid geometry', () => {
  const s = readDxf(broken('bad-geometry.dxf'));
  const r = importReportOf(s)!;
  const reason = (handle: string) => r.items.find((i) => i.handle === handle)?.reason;

  it('keeps the valid objects only', () => {
    expect(s.entities.map((e) => e.type)).toEqual(['line', 'text']);
    expect(s.entities.every((e) => e.layer === 'GOOD')).toBe(true);
    expect(s.blocks.BADBLK!.entities.map((e) => e.type)).toEqual(['line']);
  });

  it('lists every rejected object with a clear reason', () => {
    expect(reason('101')).toMatch(/invalid geometry: a\.x is not a finite number/);
    expect(reason('102')).toMatch(/radius is not a finite number/);
    expect(reason('103')).toMatch(/negative radius -2\.5/);
    expect(reason('104')).toMatch(/center\.x is not a finite number/);
    expect(reason('105')).toMatch(/at least 2 vertices \(it has 1\)/);
    expect(reason('106')).toMatch(/at least 2 vertices \(it has 0\)/);
    expect(reason('108')).toMatch(/position\.x is not a finite number/);
    expect(reason('50')).toMatch(/negative radius/);
    expect(r.items.find((i) => i.handle === '50')?.where).toBe('block "BADBLK"');
    expect(r.items.every((i) => i.action === 'dropped')).toBe(true);
    // The rejected insert's ATTRIB / SEQEND are skipped with it, not reported as strays.
    expect(r.items.some((i) => i.type === 'ATTRIB')).toBe(false);
  });

  it('geometryProblem checks nested numbers and sizes', () => {
    const base = { id: 'x', layer: '0', color: 'ByLayer' as const };
    expect(geometryProblem({ ...base, type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } })).toBeNull();
    expect(geometryProblem({ ...base, type: 'line', a: { x: 0, y: Infinity }, b: { x: 1, y: 1 } })).toMatch(/a\.y/);
    expect(geometryProblem({ ...base, type: 'polyline', points: [{ x: 0, y: 0 }, { x: 1, y: NaN }], closed: false } as Entity)).toMatch(/points\[1\]\.y/);
    expect(geometryProblem({ ...base, type: 'text', position: { x: 0, y: 0 }, text: 't', height: -1, rotation: 0, align: 'left' })).toMatch(/negative text height/);
  });
});
