/**
 * Parametric PLC I/O module, source/destination signal arrows and terminal
 * strip insertion (AutoCAD Electrical-style helpers built from primitives).
 */
import type { Point } from '../core/geometry';
import type { Entity, TextEntity, InsertEntity, BlockDef } from '../core/entities';
import { newId } from '../core/entities';
import type { Drawing } from '../core/document';
import type { Tool, ToolContext } from './types';
import { nearestReference } from '../electrical/ladder';
import { readWdSettings } from '../electrical/wdm';

const fmt = (p: Point) => `${p.x.toFixed(4)}, ${p.y.toFixed(4)}`;

export interface PlcModuleSettings {
  tag: string;
  kind: 'input' | 'output';
  points: number;
  addressPrefix: string;
  firstAddress: number;
  spacing: number;
  description: string;
}

export const DEFAULT_PLC: PlcModuleSettings = { tag: 'PLC1', kind: 'input', points: 8, addressPrefix: 'I:0/', firstAddress: 0, spacing: 1, description: 'DIGITAL INPUT MODULE' };

/** Build a PLC module: a box with one wire stub and address per I/O point. Base point = top-left of the box. */
export function buildPlcModule(origin: Point, s: PlcModuleSettings): Entity[] {
  const out: Entity[] = [];
  const width = 1.5;
  const height = s.points * s.spacing + 0.5;
  const left = origin.x;
  const top = origin.y;
  const line = (x1: number, y1: number, x2: number, y2: number, layer: string, color: Entity['color'] = 'ByLayer'): Entity => ({ id: newId(), layer, color, type: 'line', a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });
  const text = (x: number, y: number, t: string, h: number, align: 'left' | 'center' | 'right', layer: string): TextEntity => ({ id: newId(), layer, color: 'ByLayer', type: 'text', position: { x, y }, text: t, height: h, rotation: 0, align });
  out.push(
    { id: newId(), layer: 'SYMS', color: 'ByLayer', type: 'polyline', closed: true, points: [{ x: left, y: top }, { x: left + width, y: top }, { x: left + width, y: top - height }, { x: left, y: top - height }] },
    text(left + width / 2, top + 0.12, s.tag, 0.125, 'center', 'TAGS'),
    text(left + width / 2, top - 0.22, s.description, 0.08, 'center', 'DESC'),
  );
  for (let i = 0; i < s.points; i += 1) {
    const y = top - 0.5 - i * s.spacing;
    const addr = `${s.addressPrefix}${s.firstAddress + i}`;
    if (s.kind === 'input') {
      out.push(line(left - 0.75, y, left, y, 'WIRES'));
      out.push(text(left + 0.08, y - 0.04, addr, 0.08, 'left', 'TAGS'));
      out.push(text(left + width - 0.08, y - 0.04, `IN ${i}`, 0.07, 'right', 'DESC'));
    } else {
      out.push(line(left + width, y, left + width + 0.75, y, 'WIRES'));
      out.push(text(left + width - 0.08, y - 0.04, addr, 0.08, 'right', 'TAGS'));
      out.push(text(left + 0.08, y - 0.04, `OUT ${i}`, 0.07, 'left', 'DESC'));
    }
    if (i < s.points - 1) out.push(line(left, y - s.spacing / 2, left + width, y - s.spacing / 2, 'SYMS', 8));
  }
  return out;
}

export class PlcModuleTool implements Tool {
  readonly name = 'AEPLC';
  private settings: PlcModuleSettings = { ...DEFAULT_PLC };
  private ready = false;
  constructor(private ask: (init: PlcModuleSettings) => Promise<PlcModuleSettings | null>) {}
  start(ctx: ToolContext): void {
    this.ready = false;
    void this.ask(this.settings).then((s) => {
      if (!s) {
        ctx.finish();
        return;
      }
      this.settings = s;
      this.ready = true;
      ctx.prompt('Specify top-left corner of PLC module:');
    });
  }
  onPoint(p: Point, ctx: ToolContext): void {
    if (!this.ready) return;
    ctx.doc.addEntities(buildPlcModule(p, this.settings));
    ctx.log(`PLC module ${this.settings.tag} inserted with ${this.settings.points} ${this.settings.kind}s.`);
    ctx.finish();
  }
  onMove(p: Point, ctx: ToolContext): void {
    if (!this.ready) return;
    ctx.setPreview(buildPlcModule(p, this.settings));
    ctx.setDynText([fmt(p)]);
  }
  onText(_t: string, _c: ToolContext): void {}
  onEnter(ctx: ToolContext): void {
    ctx.finish();
  }
  onCancel(ctx: ToolContext): void {
    ctx.finish();
  }
}

// ---------------------------------------------------------------- signal arrows

const arrowBase = { layer: '0', color: 'ByLayer' as const };
let n = 0;
const aid = () => `arrow${(n += 1)}`;
export const SOURCE_ARROW: BlockDef = {
  name: 'WD_SRC_ARROW',
  description: 'Source signal arrow',
  basePoint: { x: 0, y: 0 },
  entities: [
    { ...arrowBase, id: aid(), type: 'polyline', closed: true, points: [{ x: 0, y: 0 }, { x: 0.3, y: 0.12 }, { x: 0.9, y: 0.12 }, { x: 0.9, y: -0.12 }, { x: 0.3, y: -0.12 }] },
  ],
  attributes: [
    { tag: 'SIGCODE', prompt: 'Signal code', default: '', position: { x: 0.6, y: -0.04 }, height: 0.08, align: 'center' },
    { tag: 'XREF', prompt: 'Destination reference', default: '', position: { x: 0.6, y: 0.2 }, height: 0.07, align: 'center' },
  ],
};
export const DEST_ARROW: BlockDef = {
  name: 'WD_DST_ARROW',
  description: 'Destination signal arrow',
  basePoint: { x: 0, y: 0 },
  entities: [
    { ...arrowBase, id: aid(), type: 'polyline', closed: true, points: [{ x: 0, y: 0 }, { x: -0.3, y: 0.12 }, { x: -0.9, y: 0.12 }, { x: -0.9, y: -0.12 }, { x: -0.3, y: -0.12 }] },
  ],
  attributes: [
    { tag: 'SIGCODE', prompt: 'Signal code', default: '', position: { x: -0.6, y: -0.04 }, height: 0.08, align: 'center' },
    { tag: 'XREF', prompt: 'Source reference', default: '', position: { x: -0.6, y: 0.2 }, height: 0.07, align: 'center' },
  ],
};

/** "sheet/rung" reference for a point, e.g. "2/103", or coordinates when the drawing has no ladder references. */
export function signalReference(doc: Drawing, q: Point): string {
  const ref = nearestReference(doc, q);
  const sheet = readWdSettings(doc).sheet;
  if (ref) return sheet ? `${sheet}/${ref}` : ref;
  return `${q.x.toFixed(1)},${q.y.toFixed(1)}`;
}

/** Insert a source or destination arrow at a wire end and link matching signal codes. */
export class SignalArrowTool implements Tool {
  readonly name: string;
  constructor(
    private kind: 'source' | 'destination',
    private ask: (title: string, label: string, init: string) => Promise<string | null>,
  ) {
    this.name = kind === 'source' ? 'AESOURCE' : 'AEDEST';
  }
  start(ctx: ToolContext): void {
    ctx.doc.ensureBlocks([SOURCE_ARROW, DEST_ARROW]);
    ctx.prompt(`Specify wire end for ${this.kind} arrow:`);
  }
  private make(p: Point, code = ''): InsertEntity {
    return { id: newId(), layer: 'MISC', color: 'ByLayer', type: 'insert', block: this.kind === 'source' ? SOURCE_ARROW.name : DEST_ARROW.name, position: p, rotation: 0, scale: 1, attributes: { SIGCODE: code, XREF: '' } };
  }
  onPoint(p: Point, ctx: ToolContext): void {
    ctx.setPreview([]);
    void this.ask('Signal Arrow', 'Signal code (e.g. 24VDC-1)', '').then((code) => {
      if (code === null) {
        ctx.finish();
        return;
      }
      const c = code.trim().toUpperCase();
      const mine = this.make(p, c);
      // Link with the matching arrow of the other kind: write each other's location as XREF.
      const other = ctx.doc.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === (this.kind === 'source' ? DEST_ARROW.name : SOURCE_ARROW.name) && e.attributes.SIGCODE === c);
      // Cross-reference text like ACADE: sheet / rung reference of the other end (coordinates when no ladder).
      const where = (q: Point) => signalReference(ctx.doc, q);
      ctx.doc.transact((s) => {
        let entities = s.entities;
        let ins = mine;
        if (other) {
          ins = { ...mine, attributes: { ...mine.attributes, XREF: where(other.position) } };
          entities = entities.map((e) => (e.id === other.id ? { ...other, attributes: { ...other.attributes, XREF: where(p) } } : e));
        }
        return { ...s, entities: [...entities, ins] };
      });
      ctx.log(other ? `${this.kind} arrow ${c} linked to its ${this.kind === 'source' ? 'destination' : 'source'}.` : `${this.kind} arrow ${c} inserted (no matching ${this.kind === 'source' ? 'destination' : 'source'} yet).`);
      ctx.finish();
    });
  }
  onMove(p: Point, ctx: ToolContext): void {
    ctx.setPreview([this.make(p)]);
    ctx.setDynText([fmt(p)]);
  }
  onText(_t: string, _c: ToolContext): void {}
  onEnter(ctx: ToolContext): void {
    ctx.finish();
  }
  onCancel(ctx: ToolContext): void {
    ctx.finish();
  }
}

// ---------------------------------------------------------------- terminal strip (panel)

export interface TerminalStripSettings {
  tag: string;
  count: number;
  firstNumber: number;
  pitch: number;
}
export const DEFAULT_STRIP: TerminalStripSettings = { tag: 'TB1', count: 12, firstNumber: 1, pitch: 0.25 };

export function buildTerminalStrip(origin: Point, s: TerminalStripSettings): Entity[] {
  const out: Entity[] = [];
  const h = 0.6;
  const w = s.count * s.pitch;
  out.push({ id: newId(), layer: 'SYMS', color: 'ByLayer', type: 'polyline', closed: true, points: [{ x: origin.x, y: origin.y }, { x: origin.x + w, y: origin.y }, { x: origin.x + w, y: origin.y - h }, { x: origin.x, y: origin.y - h }] });
  out.push({ id: newId(), layer: 'TAGS', color: 'ByLayer', type: 'text', position: { x: origin.x, y: origin.y + 0.08 }, text: s.tag, height: 0.125, rotation: 0, align: 'left' });
  for (let i = 0; i < s.count; i += 1) {
    const x = origin.x + i * s.pitch;
    if (i > 0) out.push({ id: newId(), layer: 'SYMS', color: 'ByLayer', type: 'line', a: { x, y: origin.y }, b: { x, y: origin.y - h } });
    out.push({ id: newId(), layer: 'SYMS', color: 'ByLayer', type: 'circle', center: { x: x + s.pitch / 2, y: origin.y - 0.15 }, radius: 0.05 });
    out.push({ id: newId(), layer: 'SYMS', color: 'ByLayer', type: 'circle', center: { x: x + s.pitch / 2, y: origin.y - h + 0.15 }, radius: 0.05 });
    out.push({ id: newId(), layer: 'TERMS', color: 'ByLayer', type: 'text', position: { x: x + s.pitch / 2, y: origin.y - h / 2 - 0.035 }, text: String(s.firstNumber + i), height: 0.07, rotation: 0, align: 'center' });
  }
  return out;
}

export class TerminalStripTool implements Tool {
  readonly name = 'AETERMSTRIP';
  private settings: TerminalStripSettings = { ...DEFAULT_STRIP };
  private ready = false;
  constructor(private ask: (init: TerminalStripSettings) => Promise<TerminalStripSettings | null>) {}
  start(ctx: ToolContext): void {
    this.ready = false;
    void this.ask(this.settings).then((s) => {
      if (!s) {
        ctx.finish();
        return;
      }
      this.settings = s;
      this.ready = true;
      ctx.prompt('Specify top-left corner of terminal strip:');
    });
  }
  onPoint(p: Point, ctx: ToolContext): void {
    if (!this.ready) return;
    ctx.doc.addEntities(buildTerminalStrip(p, this.settings));
    ctx.finish();
  }
  onMove(p: Point, ctx: ToolContext): void {
    if (!this.ready) return;
    ctx.setPreview(buildTerminalStrip(p, this.settings));
    ctx.setDynText([fmt(p)]);
  }
  onText(_t: string, _c: ToolContext): void {}
  onEnter(ctx: ToolContext): void {
    ctx.finish();
  }
  onCancel(ctx: ToolContext): void {
    ctx.finish();
  }
}

/** Wire types: layer name, colour and description, like ACADE's wire layer table. */
export interface WireType {
  layer: string;
  color: number;
  description: string;
}
export const WIRE_TYPES: WireType[] = [
  { layer: 'WIRES', color: 1, description: 'Control, 16 AWG RED' },
  { layer: 'WIRES_BLK_12AWG', color: 7, description: 'Power, 12 AWG BLK' },
  { layer: 'WIRES_BLU_18AWG', color: 5, description: 'DC control, 18 AWG BLU' },
  { layer: 'WIRES_WHT_16AWG', color: 9, description: 'Neutral, 16 AWG WHT' },
  { layer: 'WIRES_GRN_12AWG', color: 3, description: 'Ground, 12 AWG GRN' },
  { layer: 'WIRES_YEL_18AWG', color: 2, description: 'Foreign voltage, 18 AWG YEL' },
];
