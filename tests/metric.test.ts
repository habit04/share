import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/document';
import { newId, type InsertEntity, type LineEntity, type TextEntity } from '../src/core/entities';
import { readDxf, writeDxf } from '../src/io/dxf';
import {
  readWdSettings,
  writeWdSettings,
  settingsFromAttributes,
  attributesFromSettings,
  drawingUnitScale,
  drawingUnitsOf,
  unitsFromInsunits,
  unitScaleFor,
  setDrawingUnits,
  parseUnitsCommand,
  runUnitsCommand,
  registerUnitCommands,
  findWdM,
  DEFAULT_WD_SETTINGS,
  METRIC_LADDER_DEFAULTS,
  MM_PER_INCH,
} from '../src/electrical/wdm';
import { nearestReference, ladderMetrics, wireDot, wireNumberText, WIRENO_HEIGHT } from '../src/electrical/ladder';
import { ComponentTool, LadderTool, WireTool, ladderDefaultsFor, DEFAULT_LADDER } from '../src/tools/electrical';
import { fakeContext } from './fake-context';
import type { Editor } from '../src/app/editor';

const tick = () => new Promise((r) => setTimeout(r, 0));
const wire = (x1: number, y1: number, x2: number, y2: number): LineEntity => ({ id: newId(), type: 'line', layer: 'WIRES', color: 'ByLayer', a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });
const metricDoc = () => {
  const d = new Drawing();
  d.setHeader({ units: { ...d.header.units, insunits: 4 } });
  return d;
};

describe('drawing units from $INSUNITS and WD_M', () => {
  it('maps $INSUNITS codes to a units choice and a scale', () => {
    expect(unitsFromInsunits(1)).toBe('in');
    expect(unitsFromInsunits(4)).toBe('mm');
    expect(unitsFromInsunits(5)).toBe('mm');
    expect(unitsFromInsunits(6)).toBe('mm');
    expect(unitsFromInsunits(0)).toBe('in');
    expect(unitScaleFor(undefined, 1)).toBe(1);
    expect(unitScaleFor(undefined, 4)).toBe(25.4);
    expect(unitScaleFor(undefined, 5)).toBeCloseTo(2.54);
    expect(unitScaleFor(undefined, 6)).toBeCloseTo(0.0254);
    expect(unitScaleFor('mm', 1)).toBe(25.4); // WD_M says mm, $INSUNITS stale
    expect(unitScaleFor('in', 4)).toBe(1);
  });

  it('derives metric defaults when a DXF says $INSUNITS 4 and has no WD_M block', () => {
    const d = new Drawing();
    const text = writeDxf({ ...d.snapshot, header: { ...d.header, units: { ...d.header.units, insunits: 4 } } });
    d.load(readDxf(text));
    expect(d.header.units.insunits).toBe(4);
    const s = readWdSettings(d);
    expect(s.drawingUnits).toBe('mm');
    expect(s.rungSpacing).toBe(METRIC_LADDER_DEFAULTS.rungSpacing);
    expect(s.ladderWidth).toBe(METRIC_LADDER_DEFAULTS.ladderWidth);
    expect(drawingUnitScale(d)).toBe(MM_PER_INCH);
    expect(ladderDefaultsFor(d)).toMatchObject({ width: 230, spacing: 25 });
  });

  it('the WD_M UNITS attribute wins over $INSUNITS and round-trips', () => {
    const d = new Drawing(); // $INSUNITS 1
    writeWdSettings(d, { ...DEFAULT_WD_SETTINGS, drawingUnits: 'mm' });
    expect(findWdM(d)!.attributes.UNITS).toBe('MM');
    expect(drawingUnitsOf(d)).toBe('mm');
    expect(drawingUnitScale(d)).toBe(25.4);
    expect(settingsFromAttributes({ UNITS: 'INCHES' }, 'mm').drawingUnits).toBe('in');
    expect(settingsFromAttributes({}, 'mm').rungSpacing).toBe(25);
    expect(attributesFromSettings(DEFAULT_WD_SETTINGS).UNITS).toBe('INCHES');
    const back = new Drawing();
    back.load(readDxf(writeDxf(d.snapshot)));
    expect(readWdSettings(back).drawingUnits).toBe('mm');
    // Plain { entities } sources (panel/report helpers) keep scale 1.
    expect(drawingUnitScale({ entities: [] })).toBe(1);
  });
});

describe('switching units', () => {
  it('rescales every object by 25.4 in one undo step and converts the ladder defaults', () => {
    const d = new Drawing();
    const ins: InsertEntity = { id: newId(), type: 'insert', layer: 'SYMS', color: 'ByLayer', block: 'HPB11_NO', position: { x: 2, y: 3 }, rotation: 0, scale: 1, attributes: { TAG1: 'PB1' } };
    const t: TextEntity = { id: newId(), type: 'text', layer: 'MISC', color: 'ByLayer', position: { x: 1, y: 3 }, text: '101', height: 0.125, rotation: 0, align: 'right' };
    d.addEntities([wire(1, 3, 10, 3), ins, t]);
    const r = setDrawingUnits(d, 'mm', { rescale: true });
    expect(r).toMatchObject({ from: 'in', to: 'mm', factor: 25.4, count: 3 });
    expect(d.header.units.insunits).toBe(4);
    const s = readWdSettings(d);
    expect(s).toMatchObject({ drawingUnits: 'mm', rungSpacing: 25, ladderWidth: 230 });
    const i2 = d.entities.find((e): e is InsertEntity => e.id === ins.id)!;
    expect(i2.scale).toBeCloseTo(25.4);
    expect(i2.position.x).toBeCloseTo(50.8);
    expect((d.entities.find((e) => e.id === t.id) as TextEntity).height).toBeCloseTo(3.175);
    expect(findWdM(d)!.position).toEqual({ x: 0, y: 0 });
    expect(d.header.limits.max.x).toBeCloseTo(12 * 25.4);
    d.undo();
    expect(d.header.units.insunits).toBe(1);
    expect(d.entities.find((e): e is InsertEntity => e.id === ins.id)!.scale).toBe(1);
    expect(findWdM(d)).toBeUndefined();
  });

  it('keeps coordinates when not rescaling and converts custom ladder values exactly', () => {
    const d = new Drawing();
    writeWdSettings(d, { ...DEFAULT_WD_SETTINGS, rungSpacing: 0.5 });
    d.addEntities([wire(1, 3, 10, 3)]);
    const r = setDrawingUnits(d, 'mm', { rescale: false });
    expect(r.factor).toBe(1);
    expect((d.entities.find((e) => e.type === 'line') as LineEntity).b.x).toBe(10);
    expect(readWdSettings(d)).toMatchObject({ rungSpacing: 12.7, ladderWidth: 230 });
    setDrawingUnits(d, 'in', { rescale: false });
    expect(readWdSettings(d)).toMatchObject({ drawingUnits: 'in', rungSpacing: 0.5, ladderWidth: 9 });
    expect(d.header.units.insunits).toBe(1);
  });

  it('WDUNITS parses its options and reports / switches', () => {
    expect(parseUnitsCommand('')).toEqual({ rescale: false, query: true });
    expect(parseUnitsCommand('mm rescale')).toEqual({ units: 'mm', rescale: true, query: false });
    expect(parseUnitsCommand('IN keep')).toEqual({ units: 'in', rescale: false, query: false });
    expect(parseUnitsCommand('feet')).toBeNull();
    const d = new Drawing();
    const logs: string[] = [];
    let zoomed = 0;
    const host = { doc: d, log: (s: string) => void logs.push(s), zoomExtents: () => void (zoomed += 1) };
    runUnitsCommand(host, '');
    expect(logs[0]).toMatch(/^Drawing units: inches/);
    d.addEntities([wire(0, 0, 1, 0)]);
    runUnitsCommand(host, 'MM RESCALE');
    expect(logs[1]).toMatch(/inches -> millimetres; 1 object\(s\) scaled by 25\.4/);
    expect(zoomed).toBe(1);
    runUnitsCommand(host, 'mm');
    expect(logs[2]).toBe('Drawing units are already millimetres.');
    runUnitsCommand(host, 'x');
    expect(logs[3]).toMatch(/expected IN or MM/);
    const registered: string[] = [];
    registerUnitCommands({ ...host, register: (def) => void registered.push(def.name, ...def.aliases) });
    expect(registered).toEqual(['WDUNITS', 'AEUNITS', 'DRAWINGUNITS']);
    // The real Editor satisfies the host interface (type-level check for the call site in editor.ts).
    const callSite: (e: Editor) => void = registerUnitCommands;
    expect(typeof callSite).toBe('function');
  });
});

describe('metric symbol insertion and ladders', () => {
  it('inserts library symbols x 25.4 and breaks the wire around the scaled symbol', async () => {
    const d = metricDoc();
    d.addEntities([wire(25, 200, 230, 200)]);
    const ctx = fakeContext(d);
    ctx.ui.editComponent = async (init) => ({ tag: init.tag || 'PB1', desc: '', mfg: '', cat: '' });
    const tool = new ComponentTool('HPB11_NO');
    tool.start(ctx);
    await tick();
    tool.onPoint({ x: 100, y: 200 }, ctx);
    await tick();
    const placed = d.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === 'HPB11_NO')!;
    expect(placed.scale).toBe(25.4);
    const pieces = d.entities.filter((e): e is LineEntity => e.type === 'line' && e.layer === 'WIRES');
    expect(pieces).toHaveLength(2);
    const leftEnd = Math.max(...pieces.filter((p) => p.a.x < 100).map((p) => Math.max(p.a.x, p.b.x)));
    const rightStart = Math.min(...pieces.filter((p) => Math.max(p.a.x, p.b.x) > 100).map((p) => Math.min(p.a.x, p.b.x)));
    expect(rightStart - leftEnd).toBeGreaterThan(10); // an inch-sized gap would be < 1
  });

  it('lays out ladders in millimetres with scaled text and offsets', async () => {
    const d = metricDoc();
    const ctx = fakeContext(d);
    const tool = new LadderTool();
    tool.start(ctx);
    await tick();
    tool.onPoint({ x: 50, y: 250 }, ctx);
    const rails = d.entities.filter((e): e is LineEntity => e.type === 'line');
    expect(rails.map((r) => r.a.x).sort((a, b) => a - b)).toEqual([50, 280]);
    const refs = d.entities.filter((e): e is TextEntity => e.type === 'text');
    expect(refs).toHaveLength(DEFAULT_LADDER.rungs);
    expect(refs[0]!.height).toBeCloseTo(3.175);
    expect(refs[0]!.position.x).toBeCloseTo(50 - 6.35);
    expect(refs[1]!.position.y).toBeCloseTo(250 - 25 - 0.06 * 25.4);
    // Rung references are found with a metric tolerance (15.24 mm).
    expect(nearestReference(d, { x: 120, y: 250 - 10 })).toBe('100');
    expect(nearestReference({ entities: d.entities }, { x: 120, y: 250 - 10 })).toBeNull();
  });

  it('scales junction dots, wire-number text and the layout metrics', () => {
    const d = metricDoc();
    d.addEntities([wire(0, 0, 100, 0)]);
    const ctx = fakeContext(d);
    const tool = new WireTool();
    tool.start(ctx);
    tool.onPoint({ x: 50, y: 0 }, ctx);
    tool.onPoint({ x: 50, y: -40 }, ctx);
    const dot = d.entities.find((e): e is InsertEntity => e.type === 'insert');
    expect(dot?.scale).toBe(25.4);
    expect(wireDot({ x: 0, y: 0 }).scale).toBe(1);
    expect(ladderMetrics(25.4).wireNumberHeight).toBeCloseTo(3.175);
    expect(ladderMetrics(1).wireNumberGap).toBe(0.05);
    expect(wireNumberText({ x: 0, y: 0 }, '101', 'WIRENO', 'left', ladderMetrics(25.4).wireNumberHeight).height).toBeCloseTo(3.175);
    expect(wireNumberText({ x: 0, y: 0 }, '101').height).toBe(WIRENO_HEIGHT);
  });
});
