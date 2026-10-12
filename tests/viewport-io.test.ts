import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDxf, writeDxf } from '../src/io/dxf';
import { convertDwg, type DwgImportPayload } from '../src/io/dwg';
import { importReportOf } from '../src/io/import-report';
import { modelToPaper } from '../src/core/layouts';

const reference = readFileSync(join(__dirname, 'fixtures/acad-layouts.dxf'), 'utf8');

/** Change literal VIEWPORT fields in the independently authored AutoCAD reference, without JCad's writer. */
function detailViewport(fields: Record<number, number | string>): string {
  const lines = reference.trimEnd().split(/\r?\n/);
  const pairs: Array<[number, string]> = [];
  for (let i = 0; i < lines.length; i += 2) pairs.push([Number(lines[i]!.trim()), lines[i + 1]!]);
  for (let start = 0; start < pairs.length; start += 1) {
    if (pairs[start]![0] !== 0 || pairs[start]![1].trim() !== 'VIEWPORT') continue;
    let end = start + 1;
    while (end < pairs.length && pairs[end]![0] !== 0) end += 1;
    if (!pairs.slice(start, end).some(([code, value]) => code === 69 && Number(value) === 2)
      || !pairs.slice(start, end).some(([code, value]) => code === 40 && Number(value) === 15)) continue;
    const entries = pairs.slice(start, end);
    for (const [code, value] of Object.entries(fields)) {
      const at = entries.findIndex(([c]) => c === Number(code));
      if (at >= 0) entries[at] = [Number(code), String(value)];
      else entries.push([Number(code), String(value)]);
    }
    pairs.splice(start, end - start, ...entries);
    return pairs.flat().join('\n') + '\n';
  }
  throw new Error('Reference detail viewport is absent.');
}

function dwgViewport(fields: Record<string, unknown> = {}): DwgImportPayload {
  return {
    header: { INSUNITS: 1 },
    entities: [],
    layers: [{ name: '0', colorIndex: 7, off: false, frozen: false, locked: false, lineweight: -3 }],
    blocks: [{ name: '*Paper_Space', handle: '50', basePoint: { x: 0, y: 0, z: 0 }, description: '', entities: [
      { type: 'VIEWPORT', handle: '200', layer: '0', viewportId: 1 },
      { type: 'VIEWPORT', handle: '201', layer: '0', viewportId: 2, viewportCenter: { x: 8, y: 5, z: 0 }, width: 15, height: 9, viewHeight: 18, displayCenter: { x: 10, y: 20 }, targetPoint: { x: 100, y: 200, z: 0 }, viewDirection: { x: 0, y: 0, z: 1 }, viewTwistAngle: Math.PI / 2, frozenLayers: [], statusBitFlags: 32768 | 16384, ...fields },
    ] }],
    layouts: [{ name: 'Twisted', blockHandle: '50', tabOrder: 1, minLimit: { x: 0, y: 0 }, maxLimit: { x: 17, y: 11 } }],
  } as unknown as DwgImportPayload;
}

describe('planar viewport interchange', () => {
  it('reads degree-valued DXF twist and converts a nonzero-target DCS centre to WCS', () => {
    const source = readDxf(detailViewport({ 12: 10, 22: 20, 17: 100, 27: 200, 37: 0, 16: 0, 26: 0, 36: 1, 51: 90 }));
    const view = source.layouts![0]!.viewports[0]!;
    expect(view.view.twist).toBeCloseTo(Math.PI / 2, 12);
    expect(view.view.center.x).toBeCloseTo(120, 12);
    expect(view.view.center.y).toBeCloseTo(190, 12);
    const paper = modelToPaper(view, { x: 122, y: 190 });
    expect(paper.x).toBeCloseTo(view.center.x, 12);
    expect(paper.y).toBeCloseTo(view.center.y + 2 * view.view.scale, 12);
    expect(importReportOf(source)?.items.some((item) => item.type === 'VIEWPORT' && /twist/.test(item.reason))).toBeFalsy();
    const model = source.entities.map((e) => ({ ...e, id: '' }));
    const back = readDxf(writeDxf(source));
    expect(back.layouts![0]!.viewports[0]!.view.center.x).toBeCloseTo(120, 9);
    expect(back.layouts![0]!.viewports[0]!.view.center.y).toBeCloseTo(190, 9);
    expect(back.layouts![0]!.viewports[0]!.view.twist).toBeCloseTo(Math.PI / 2, 12);
    expect(back.entities.map((e) => ({ ...e, id: '' }))).toEqual(model);
  });

  it('keeps small and negative DXF angles with explicit degree units', () => {
    for (const degrees of [0.5, -30, 450]) {
      const source = readDxf(detailViewport({ 12: 0, 22: 0, 17: 0, 27: 0, 51: degrees }));
      const angle = (degrees % 360) * Math.PI / 180;
      expect(source.layouts![0]!.viewports[0]!.view.twist).toBeCloseTo(angle, 12);
      expect(readDxf(writeDxf(source)).layouts![0]!.viewports[0]!.view.twist).toBeCloseTo(angle, 12);
    }
  });

  it('exports DCS centre rotated independently of the viewport paper rectangle', () => {
    const source = readDxf(detailViewport({ 12: 10, 22: 20, 17: 100, 27: 200, 51: 90 }));
    const output = writeDxf(source);
    const viewports = output.split(/\r?\n0\r?\nVIEWPORT\r?\n/).slice(1);
    const detail = viewports.find((text) => /(?:^|\n)51\r?\n90(?:\r?\n)/.test(text))!;
    const number = (code: number) => Number(new RegExp(`(?:^|\\n)${code}\\r?\\n([^\\r\\n]+)`).exec(detail)?.[1]);
    expect(number(51)).toBeCloseTo(90, 12);
    expect(number(12)).toBeCloseTo(-190, 9);
    expect(number(22)).toBeCloseTo(120, 9);
    expect(number(17)).toBe(0);
    expect(number(27)).toBe(0);
    expect(number(40)).toBe(15);
    expect(number(41)).toBe(9);
  });

  it('reads DWG radians directly and round-trips the WCS centre through DXF', () => {
    for (const angle of [Math.PI / 2, 0.5, -Math.PI / 6, 7]) {
      const source = convertDwg(dwgViewport({ viewTwistAngle: angle }), 'rotated.dwg').state;
      const view = source.layouts![0]!.viewports[0]!.view;
      expect(view.twist).toBeCloseTo(angle % (2 * Math.PI), 12);
      expect(view.center.x).toBeCloseTo(100 + 10 * Math.cos(angle) + 20 * Math.sin(angle), 12);
      expect(view.center.y).toBeCloseTo(200 - 10 * Math.sin(angle) + 20 * Math.cos(angle), 12);
      expect(view.locked).toBe(true);
      const back = readDxf(writeDxf(source)).layouts![0]!.viewports[0]!.view;
      expect(back.twist).toBeCloseTo(view.twist!, 11);
      expect(back.center.x).toBeCloseTo(view.center.x, 9);
      expect(back.center.y).toBeCloseTo(view.center.y, 9);
    }
  });

  it('keeps clipping warnings without discarding a supported planar rotation', () => {
    const source = convertDwg(dwgViewport({ statusBitFlags: 32768 | 65536 }), 'clipped.dwg');
    expect(source.state.layouts![0]!.viewports[0]!.view.twist).toBeCloseTo(Math.PI / 2, 12);
    expect(source.report?.items).toContainEqual(expect.objectContaining({ type: 'VIEWPORT', action: 'simplified', reason: expect.stringMatching(/clipping boundary/) }));
    expect(source.report?.items.some((item) => item.type === 'VIEWPORT' && /untwisted/.test(item.reason))).toBeFalsy();
  });

  it('continues reporting perspective, tilted and reversed views as approximations', () => {
    for (const [fields, warning] of [
      [{ statusBitFlags: 32768 | 1 }, /perspective view/],
      [{ viewDirection: { x: 1, y: 0, z: 1 } }, /3D or reversed/],
      [{ viewDirection: { x: 0, y: 0, z: -1 } }, /3D or reversed/],
    ] as const) {
      const source = convertDwg(dwgViewport(fields), '3d-view.dwg');
      expect(source.state.layouts![0]!.viewports[0]!.view.twist).toBeUndefined();
      expect(source.report?.items).toContainEqual(expect.objectContaining({ type: 'VIEWPORT', action: 'simplified', reason: expect.stringMatching(warning) }));
    }
    const source = readDxf(detailViewport({ 51: 30, 90: 32768 | 1, 16: 1, 26: 0, 36: 1 }));
    expect(source.layouts![0]!.viewports[0]!.view.twist).toBeUndefined();
    expect(importReportOf(source)?.items.filter((item) => item.type === 'VIEWPORT').map((item) => item.reason)).toEqual(expect.arrayContaining([expect.stringMatching(/perspective view/), expect.stringMatching(/3D or reversed/), expect.stringMatching(/untwisted/)]));
  });

  it('reports invalid twist and refuses nonfinite view coordinates or scales', () => {
    const badAngle = convertDwg(dwgViewport({ viewTwistAngle: NaN }), 'invalid.dwg');
    expect(badAngle.state.layouts![0]!.viewports[0]!.view.twist).toBeUndefined();
    expect(badAngle.report?.items).toContainEqual(expect.objectContaining({ type: 'VIEWPORT', reason: expect.stringMatching(/invalid view twist/) }));
    for (const fields of [{ targetPoint: { x: Infinity, y: 0 } }, { width: Infinity }, { viewHeight: 1e-320 }]) {
      const source = convertDwg(dwgViewport(fields), 'invalid.dwg');
      expect(source.state.layouts![0]!.viewports).toHaveLength(0);
      expect(source.report?.items).toContainEqual(expect.objectContaining({ type: 'VIEWPORT', action: 'dropped', reason: expect.stringMatching(/invalid viewport/) }));
    }
    const source = readDxf(detailViewport({ 51: 'NaN' }));
    expect(source.layouts![0]!.viewports[0]!.view.twist).toBeUndefined();
    expect(importReportOf(source)?.items).toContainEqual(expect.objectContaining({ type: 'VIEWPORT', reason: expect.stringMatching(/invalid view twist/) }));
  });
});
