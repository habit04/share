import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDxf, writeDxf } from '../src/io/dxf';
import { Drawing, type DrawingState } from '../src/core/document';
import type { Entity, TextEntity, InsertEntity } from '../src/core/entities';
import { defaultLayout, paperFor, sheetSize, VIEWPORT_LAYER, type Layout } from '../src/core/layouts';
import { TITLE_BLOCK } from '../src/electrical/templates';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'latin1');

/** Group-code pairs of a DXF text. */
function pairs(text: string): Array<[number, string]> {
  const lines = text.split(/\r\n|\n/);
  const out: Array<[number, string]> = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([parseInt(lines[i]!.trim(), 10), lines[i + 1]!.trim()]);
  return out;
}

function sampleState(): DrawingState {
  const d = new Drawing({
    entities: [
      { id: 'm1', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 40, y: 20 } },
      { id: 'm2', layer: 'WIRES', color: 'ByLayer', type: 'text', position: { x: 2, y: 2 }, text: 'ANNO', height: 0.125, rotation: 0, align: 'left', annotative: true } as TextEntity,
    ],
  });
  d.ensureBlocks([TITLE_BLOCK]);
  const tb: InsertEntity = { id: 'p2', layer: '0', color: 'ByLayer', type: 'insert', block: TITLE_BLOCK.name, position: { x: 10.5, y: 0.5 }, rotation: 0, scale: 1, attributes: { TITLE: 'MOTORS', DWGNO: 'E-1' } };
  const sheet1: Layout = {
    ...defaultLayout('Sheet1'),
    pristine: undefined,
    plotStyle: 'grayscale',
    margins: { left: 0.25, bottom: 0.5, right: 0.25, top: 0.375 },
    entities: [{ id: 'p1', layer: '0', color: 1, type: 'text', position: { x: 1, y: 10 }, text: 'PAPER NOTE', height: 0.2, rotation: 0, align: 'left' }, tb],
    viewports: [
      { id: 'a', center: { x: 5, y: 6 }, width: 8, height: 7, view: { center: { x: 20, y: 10 }, scale: 0.25 }, layer: VIEWPORT_LAYER.name, on: true, frozenLayers: ['WIRES'] },
      { id: 'b', center: { x: 13, y: 6 }, width: 6, height: 4, view: { center: { x: 5, y: 5 }, scale: 2, locked: true }, layer: VIEWPORT_LAYER.name, on: false },
    ],
  };
  const sheet2: Layout = {
    ...defaultLayout('Metric', 'mm'),
    pristine: undefined,
    paper: paperFor('a3', 'portrait'),
    plotScale: 'fit',
    plotLineweights: false,
    entities: [{ id: 'p3', layer: '0', color: 'ByLayer', type: 'circle', center: { x: 100, y: 100 }, radius: 20 }],
    viewports: [{ id: 'c', center: { x: 150, y: 250 }, width: 200, height: 150, view: { center: { x: 20, y: 10 }, scale: 5 }, layer: VIEWPORT_LAYER.name, on: true }],
  };
  const s = d.snapshot;
  return { ...s, layers: [...s.layers, VIEWPORT_LAYER], layouts: [sheet1, sheet2], header: { ...d.header, cannoscale: '1:4', annoAllVisible: false } };
}

describe('DXF layouts: round trip', () => {
  const state = sampleState();
  const text = writeDxf(state);
  const back = readDxf(text);

  it('keeps model space free of paper-space entities', () => {
    expect(back.entities.map((e) => e.type)).toEqual(['line', 'text']);
  });
  it('writes AutoCAD structures: BLOCK_RECORD -> LAYOUT links, ACAD_LAYOUT dictionary, VIEWPORT ids, group 67', () => {
    const p = pairs(text);
    const kinds = p.filter(([c]) => c === 0).map(([, v]) => v);
    expect(kinds.filter((k) => k === 'LAYOUT')).toHaveLength(3); // Sheet1, Metric, Model
    expect(kinds.filter((k) => k === 'VIEWPORT')).toHaveLength(2 + 3); // an overall paper viewport per layout + 3 floating
    expect(p.some(([c, v]) => c === 3 && v === 'ACAD_LAYOUT')).toBe(true);
    expect(p.some(([c, v]) => c === 2 && v === '*Paper_Space0')).toBe(true);
    // Every BLOCK_RECORD 340 names a LAYOUT handle.
    const layoutHandles = new Set<string>();
    for (let i = 0; i < p.length; i += 1) if (p[i]![0] === 0 && p[i]![1] === 'LAYOUT') layoutHandles.add(p[i + 1]![1]);
    const links = p.filter(([c]) => c === 340).map(([, v]) => v).filter((h) => layoutHandles.has(h));
    expect(links).toHaveLength(3);
    expect(p.filter(([c, v]) => c === 67 && v === '1').length).toBeGreaterThan(5);
    expect(p.some(([c, v]) => c === 9 && v === '$CANNOSCALE')).toBe(true);
    expect(p.some(([c, v]) => c === 1001 && v === 'AcadAnnotative')).toBe(true);
  });
  it('reads layouts back: names, order, paper, margins, plot settings', () => {
    expect(back.layouts!.map((l) => l.name)).toEqual(['Sheet1', 'Metric']);
    const [s1, s2] = back.layouts!;
    expect(s1!.paper).toMatchObject({ id: 'tabloid', units: 'in', orientation: 'landscape' });
    expect(sheetSize(s1!)).toEqual({ width: 17, height: 11 });
    expect(s1!.margins.left).toBeCloseTo(0.25, 9);
    expect(s1!.margins.bottom).toBeCloseTo(0.5, 9);
    expect(s1!.margins.top).toBeCloseTo(0.375, 9);
    expect(s1!.plotStyle).toBe('grayscale');
    expect(s1!.plotScale).toBe('1:1');
    expect(s2!.paper).toMatchObject({ id: 'a3', units: 'mm', orientation: 'portrait' });
    expect(sheetSize(s2!)).toEqual({ width: 297, height: 420 });
    expect(s2!.plotScale).toBe('fit');
    expect(s2!.plotLineweights).toBe(false);
  });
  it('reads viewports back with their view, scale, lock, on/off and frozen layers', () => {
    const [s1, s2] = back.layouts!;
    expect(s1!.viewports).toHaveLength(2);
    const [a, b] = s1!.viewports;
    expect(a!.center.x).toBeCloseTo(5, 9);
    expect(a!.center.y).toBeCloseTo(6, 9);
    expect(a!.width).toBeCloseTo(8, 9);
    expect(a!.height).toBeCloseTo(7, 9);
    expect(a!.view.center).toEqual({ x: 20, y: 10 });
    expect(a!.view.scale).toBeCloseTo(0.25, 12);
    expect(a!.frozenLayers).toEqual(['WIRES']);
    expect(a!.on).toBe(true);
    expect(a!.layer).toBe('VIEWPORTS');
    expect(b!.view.locked).toBe(true);
    expect(b!.on).toBe(false);
    expect(b!.view.scale).toBeCloseTo(2, 12);
    expect(s2!.viewports[0]!.center.x).toBeCloseTo(150, 9);
    expect(s2!.viewports[0]!.view.scale).toBeCloseTo(5, 12);
  });
  it('reads paper-space entities back at the same paper coordinates', () => {
    const [s1, s2] = back.layouts!;
    const note = s1!.entities.find((e) => e.type === 'text') as TextEntity;
    expect(note.text).toBe('PAPER NOTE');
    expect(note.position.x).toBeCloseTo(1, 9);
    expect(note.position.y).toBeCloseTo(10, 9);
    const tb = s1!.entities.find((e) => e.type === 'insert') as InsertEntity;
    expect(tb.block).toBe('WD_TITLEBLOCK');
    expect(tb.position.x).toBeCloseTo(10.5, 9);
    expect(tb.attributes.TITLE).toBe('MOTORS');
    const c = s2!.entities[0] as Extract<Entity, { type: 'circle' }>;
    expect(c.center.x).toBeCloseTo(100, 9);
  });
  it('keeps CANNOSCALE, ANNOALLVISIBLE, annotative flags and no-plot layers', () => {
    expect(back.header?.cannoscale).toBe('1:4');
    expect(back.header?.annoAllVisible).toBe(false);
    expect(back.entities.find((e) => e.type === 'text')?.annotative).toBe(true);
    expect(back.layers.find((l) => l.name === 'VIEWPORTS')?.plot).toBe(false);
  });
  it('a second round trip is stable', () => {
    const again = readDxf(writeDxf(back));
    const strip = (l: Layout) => ({ ...l, entities: l.entities.map((e) => ({ ...e, id: '' })), viewports: l.viewports.map((v) => ({ ...v, id: '' })) });
    expect(again.layouts!.map(strip)).toEqual(back.layouts!.map(strip));
  });
  it('a drawing that never used layouts writes Layout1 and reads back without layouts', () => {
    const plain = new Drawing({ entities: [{ id: 'x', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }] }).snapshot;
    const t = writeDxf(plain);
    expect(t).toContain('Layout1');
    const r = readDxf(t);
    expect(r.layouts).toBeUndefined();
    expect(r.entities).toHaveLength(1);
  });
});

describe('DXF layouts: AutoCAD file', () => {
  const state = readDxf(fixture('acad-layouts.dxf'));
  it('keeps the paper-space VIEWPORTs and TEXT out of model space', () => {
    expect(state.entities.map((e) => e.type)).toEqual(['line', 'circle']);
  });
  it('imports Layout1 with its viewport (paper origin at the printable corner) and Layout2 from *Paper_Space0', () => {
    expect(state.layouts!.map((l) => l.name)).toEqual(['Layout1', 'Layout2']);
    const [l1, l2] = state.layouts!;
    expect(l1!.paper).toMatchObject({ id: 'tabloid', units: 'in', orientation: 'landscape' });
    expect(l1!.plotStyle).toBe('monochrome');
    expect(l1!.viewports).toHaveLength(1);
    const v = l1!.viewports[0]!;
    // AutoCAD's 8,5 is 8.25,5.25 from the sheet corner with a 6.35 mm (0.25 in) margin.
    expect(v.center.x).toBeCloseTo(8.25, 9);
    expect(v.center.y).toBeCloseTo(5.25, 9);
    expect(v.width).toBe(15);
    expect(v.height).toBe(9);
    expect(v.view.center).toEqual({ x: 10, y: 5 });
    expect(v.view.scale).toBeCloseTo(0.5, 12);
    expect(v.frozenLayers).toEqual(['HIDDENVP']);
    expect(v.layer).toBe('VPORTS');
    const note = l1!.entities[0] as TextEntity;
    expect(note.text).toBe('GENERAL NOTES');
    expect(note.position.x).toBeCloseTo(1.25, 9);
    expect(l2!.paper).toMatchObject({ id: 'a3', units: 'mm', orientation: 'landscape' });
    expect(l2!.plotStyle).toBe('color');
    const v2 = l2!.viewports[0]!;
    expect(v2.center.x).toBeCloseTo(207.5, 9);
    expect(v2.center.y).toBeCloseTo(160, 9);
    expect(v2.view.scale).toBeCloseTo(25, 9);
    expect(v2.view.locked).toBe(true);
    expect(state.layers.find((l) => l.name === 'VPORTS')?.plot).toBe(false);
  });
  it('the AutoCAD example drawing keeps its two (empty) layouts', () => {
    const ex = readDxf(readFileSync(join(__dirname, '..', 'fixtures', 'example_2000.dxf'), 'latin1'));
    expect(ex.layouts!.map((l) => l.name)).toEqual(['Layout1', 'Layout2']);
    expect(ex.layouts![0]!.paper).toMatchObject({ id: 'letter', units: 'mm', orientation: 'landscape' });
    expect(ex.layouts![0]!.pristine).toBe(true);
  });
});
