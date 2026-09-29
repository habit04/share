/**
 * Circuit Builder (lite): parametric motor-control circuits placed onto a
 * ladder with correct tags, child contacts, junction dots and descriptions.
 * Wire numbers are assigned afterwards by AEWIRENO.
 */
import type { Entity, LineEntity, InsertEntity } from '../core/entities';
import { newId } from '../core/entities';
import type { Drawing } from '../core/document';
import { breakWire, wireDot } from './ladder';
import { nextTag, usedTags } from './tags';
import { tagPrefix } from './symbols';
import { childAttributes } from './xref';
import type { WdSettings } from './wdm';
import { SYMBOL_HALF } from './attributes';

export type CircuitKind = 'start-stop' | 'reversing' | 'jog';

export interface CircuitOptions {
  kind: CircuitKind;
  /** Left / right rail x and the y of the first rung used. */
  left: number;
  right: number;
  top: number;
  spacing: number;
  standard: 'JIC' | 'IEC';
  loadDescription: string;
  /** Draw rails and rung references when inserting onto an empty area. */
  drawLadder: boolean;
  firstReference: number;
  /** Drawing units per library inch (`drawingUnitScale(doc)`: 25.4 in a millimetre drawing); default 1. */
  unitScale?: number;
}

export const CIRCUIT_KINDS: Array<{ kind: CircuitKind; name: string; rungs: number }> = [
  { kind: 'start-stop', name: 'Start / stop with seal-in and run light', rungs: 2 },
  { kind: 'reversing', name: 'Reversing starter (FWD / REV with interlocks)', rungs: 4 },
  { kind: 'jog', name: 'Start / stop with jog relay', rungs: 3 },
];

export const DEFAULT_CIRCUIT: CircuitOptions = { kind: 'start-stop', left: 1, right: 10, top: 8, spacing: 1, standard: 'JIC', loadDescription: 'CONVEYOR MOTOR', drawLadder: false, firstReference: 100 };

/** Block names per standard. */
const BLOCKS: Record<'JIC' | 'IEC', Record<string, string>> = {
  JIC: { stop: 'HPB12_NC', start: 'HPB11_NO', olNC: 'HOL1_NC', coil: 'HKM1', auxNO: 'HKM1_NO', auxNC: 'HKM1_NC', cr: 'HCR1', crNO: 'HCR1_NO', light: 'HLT1G' },
  IEC: { stop: 'IEC_S_PB_NC', start: 'IEC_S_PB_NO', olNC: 'IEC_F_OL_NC', coil: 'IEC_KM_COIL', auxNO: 'IEC_KM_NO', auxNC: 'IEC_KM_NC', cr: 'IEC_K_COIL', crNO: 'IEC_K_NO', light: 'IEC_P_LAMP_GN' },
};

interface Comp {
  block: string;
  x: number;
  desc?: string;
  /** Name of a parent placed earlier whose tag this child copies. */
  parentKey?: string;
  key?: string;
}

/** Tag generator over a drawing: remembers what it handed out. */
export function makeTagger(doc: Drawing, settings: WdSettings, refOf: (y: number) => string | null): (block: string, y: number) => string {
  const used = usedTags(doc);
  return (block, y) => {
    const t = nextTag(used, tagPrefix(block), refOf(y), settings);
    used.add(t);
    return t;
  };
}

/** Build the circuit entities. `tagger` returns the tag for a parent block at a rung y. */
export function buildMotorCircuit(o: CircuitOptions, tagger: (block: string, y: number) => string): Entity[] {
  const B = BLOCKS[o.standard];
  const ents: Entity[] = [];
  const parents = new Map<string, InsertEntity>();
  const W = o.right - o.left;
  const k = o.unitScale ?? 1;
  const half = SYMBOL_HALF * k;
  const px = (f: number) => o.left + f * W;
  const wire = (x1: number, y1: number, x2: number, y2: number): LineEntity => ({ id: newId(), type: 'line', layer: 'WIRES', color: 'ByLayer', a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });
  const ins = (block: string, x: number, y: number, attrs: Record<string, string>): InsertEntity => ({ id: newId(), type: 'insert', layer: 'SYMS', color: 'ByLayer', block, position: { x, y }, rotation: 0, scale: k, attributes: attrs });

  const rung = (y: number, comps: Comp[], x0 = o.left, x1 = o.right): void => {
    let pieces: LineEntity[] = [wire(x0, y, x1, y)];
    for (const c of comps) {
      const target = pieces.find((p) => Math.min(p.a.x, p.b.x) <= c.x && Math.max(p.a.x, p.b.x) >= c.x);
      if (target) pieces = pieces.filter((p) => p !== target).concat(breakWire(target, c.x - half, c.x + half));
      let attrs: Record<string, string>;
      if (c.parentKey) {
        const parent = parents.get(c.parentKey);
        attrs = parent ? childAttributes(parent) : { TAG1: '' };
        // child contacts in a generated circuit stay unlabelled (the coil carries the description)
        attrs.DESC1 = c.desc ?? '';
      } else {
        attrs = { TAG1: tagger(c.block, y), DESC1: c.desc ?? '' };
      }
      const e = ins(c.block, c.x, y, attrs);
      if (c.key) parents.set(c.key, e);
      ents.push(e);
    }
    ents.push(...pieces);
  };
  /** Parallel branch below a rung between xa and xb with one component. */
  const branch = (y: number, xa: number, xb: number, comp: Comp): void => {
    const by = y - o.spacing * 0.5;
    ents.push(wire(xa, y, xa, by), wire(xb, by, xb, y));
    rung(by, [comp], xa, xb);
    ents.push(wireDot({ x: xa, y }, k), wireDot({ x: xb, y }, k));
  };

  const y0 = o.top;
  const s = o.spacing;
  if (o.drawLadder) {
    const rungs = CIRCUIT_KINDS.find((k) => k.kind === o.kind)!.rungs;
    ents.push(wire(o.left, y0 + s * 0.5, o.left, y0 - s * (rungs - 1) - s * 0.5), wire(o.right, y0 + s * 0.5, o.right, y0 - s * (rungs - 1) - s * 0.5));
    for (let i = 0; i < rungs; i += 1) {
      ents.push({ id: newId(), type: 'text', layer: 'MISC', color: 'ByLayer', position: { x: o.left - 0.25 * k, y: y0 - i * s - 0.06 * k }, text: String(o.firstReference + i), height: 0.125 * k, rotation: 0, align: 'right' });
    }
  }

  switch (o.kind) {
    case 'start-stop': {
      rung(y0, [
        { block: B.stop!, x: px(0.15), desc: 'STOP' },
        { block: B.start!, x: px(0.33), desc: 'START' },
        { block: B.olNC!, x: px(0.7), desc: '' },
        { block: B.coil!, x: px(0.88), desc: o.loadDescription, key: 'M' },
      ]);
      branch(y0, px(0.24), px(0.42), { block: B.auxNO!, x: px(0.33), parentKey: 'M' });
      rung(y0 - s, [
        { block: B.auxNO!, x: px(0.33), parentKey: 'M', desc: '' },
        { block: B.light!, x: px(0.88), desc: 'RUNNING' },
      ]);
      break;
    }
    case 'reversing': {
      rung(y0, [
        { block: B.stop!, x: px(0.15), desc: 'STOP' },
        { block: B.start!, x: px(0.33), desc: 'FORWARD' },
        { block: B.auxNC!, x: px(0.52), parentKey: 'M2' },
        { block: B.olNC!, x: px(0.7), desc: '' },
        { block: B.coil!, x: px(0.88), desc: `${o.loadDescription} FWD`, key: 'M1' },
      ]);
      branch(y0, px(0.24), px(0.42), { block: B.auxNO!, x: px(0.33), parentKey: 'M1' });
      // The reverse rung is fed after the stop button.
      const feed = px(0.24);
      ents.push(wire(feed, y0 - s * 0.5, feed, y0 - s));
      rung(y0 - s, [
        { block: B.start!, x: px(0.33), desc: 'REVERSE' },
        { block: B.auxNC!, x: px(0.52), parentKey: 'M1' },
        { block: B.olNC!, x: px(0.7), desc: '' },
        { block: B.coil!, x: px(0.88), desc: `${o.loadDescription} REV`, key: 'M2' },
      ], feed, o.right);
      branch(y0 - s, px(0.24), px(0.42), { block: B.auxNO!, x: px(0.33), parentKey: 'M2' });
      rung(y0 - 2 * s, [
        { block: B.auxNO!, x: px(0.33), parentKey: 'M1' },
        { block: B.light!, x: px(0.88), desc: 'FORWARD' },
      ]);
      rung(y0 - 3 * s, [
        { block: B.auxNO!, x: px(0.33), parentKey: 'M2' },
        { block: B.light!, x: px(0.88), desc: 'REVERSE' },
      ]);
      break;
    }
    case 'jog': {
      rung(y0, [
        { block: B.stop!, x: px(0.15), desc: 'STOP' },
        { block: B.start!, x: px(0.33), desc: 'START' },
        { block: B.cr!, x: px(0.88), desc: 'RUN RELAY', key: 'CR' },
      ]);
      branch(y0, px(0.24), px(0.42), { block: B.crNO!, x: px(0.33), parentKey: 'CR' });
      rung(y0 - s, [
        { block: B.crNO!, x: px(0.33), parentKey: 'CR' },
        { block: B.olNC!, x: px(0.7), desc: '' },
        { block: B.coil!, x: px(0.88), desc: o.loadDescription, key: 'M' },
      ]);
      branch(y0 - s, px(0.24), px(0.42), { block: B.start!, x: px(0.33), desc: 'JOG' });
      rung(y0 - 2 * s, [
        { block: B.auxNO!, x: px(0.33), parentKey: 'M' },
        { block: B.light!, x: px(0.88), desc: 'RUNNING' },
      ]);
      break;
    }
  }
  return fixLateParents(ents, parents);
}

/** Children referencing a parent that was placed after them get the parent's tag now. */
function fixLateParents(ents: Entity[], parents: Map<string, InsertEntity>): Entity[] {
  const m2 = parents.get('M2');
  const m1 = parents.get('M1');
  return ents.map((e) => {
    if (e.type !== 'insert' || e.attributes.TAG1 !== '') return e;
    // The only late reference is the M2 interlock on the forward rung.
    const parent = /_NC$/.test(e.block) ? m2 : m1;
    return parent ? { ...e, attributes: { ...e.attributes, ...childAttributes(parent), DESC1: '' } } : e;
  });
}
