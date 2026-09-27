import type { Editor } from './editor';
import type { Entity, LineEntity } from '../core/entities';
import { newId } from '../core/entities';
import { breakWire, assignWireNumbers, wireDot } from '../tools/electrical';
import { WIRE_DOT } from '../electrical/symbols';

/** Seed a small motor-control ladder so screenshots and manual testing have content. */
export function seedDemoDrawing(editor: Editor): void {
  editor.doc.ensureBlocks([WIRE_DOT]);
  const ents: Entity[] = [];
  const wire = (x1: number, y1: number, x2: number, y2: number): LineEntity => ({
    id: newId(),
    type: 'line',
    layer: 'WIRES',
    color: 'ByLayer',
    a: { x: x1, y: y1 },
    b: { x: x2, y: y2 },
  });
  const text = (x: number, y: number, t: string, layer = 'MISC', h = 0.125, align: 'left' | 'center' | 'right' = 'right'): Entity => ({
    id: newId(),
    type: 'text',
    layer,
    color: 'ByLayer',
    position: { x, y },
    text: t,
    height: h,
    rotation: 0,
    align,
  });
  const ins = (block: string, x: number, y: number, tag: string, desc: string): Entity => ({
    id: newId(),
    type: 'insert',
    layer: 'SYMS',
    color: 'ByLayer',
    block,
    position: { x, y },
    rotation: 0,
    scale: 1,
    attributes: { TAG1: tag, DESC1: desc },
  });
  /** Place components on a rung wire, breaking it around each symbol (±0.375). */
  const rung = (y: number, comps: Array<[string, number, string, string]>, x0 = left, x1 = right): void => {
    let pieces: LineEntity[] = [wire(x0, y, x1, y)];
    for (const [b, x, tag, desc] of comps) {
      const target = pieces.find((p) => Math.min(p.a.x, p.b.x) <= x && Math.max(p.a.x, p.b.x) >= x);
      if (target) pieces = pieces.filter((p) => p !== target).concat(breakWire(target, x - 0.375, x + 0.375));
      ents.push(ins(b, x, y, tag, desc));
    }
    ents.push(...pieces);
  };

  const left = 1;
  const right = 10;
  const top = 8;
  const rungs = 6;
  ents.push(wire(left, top + 0.5, left, top - (rungs - 1) - 0.5), wire(right, top + 0.5, right, top - (rungs - 1) - 0.5));
  for (let i = 0; i < rungs; i += 1) ents.push(text(left - 0.25, top - i - 0.06, String(100 + i)));
  ents.push(text(left, top + 0.9, 'L1', 'MISC', 0.15, 'center'), text(right, top + 0.9, 'L2', 'MISC', 0.15, 'center'));

  // Rung 100: fuse, stop PB, start PB, coil. Seal-in contact on a parallel branch below the start button.
  rung(top, [
    ['HFU1', 2.2, 'FU100', 'CONTROL FUSE'],
    ['HPB12_NC', 3.8, 'PB100', 'STOP'],
    ['HPB11_NO', 5.4, 'PB101', 'START'],
    ['HCR1', 8.6, 'CR100', 'MOTOR RUN'],
  ]);
  const branchY = top - 0.5;
  ents.push(wire(4.4, top, 4.4, branchY), wire(6.8, branchY, 6.8, top));
  rung(branchY, [['HCR1_NO', 6.1, 'CR100', '']], 4.4, 6.8);
  ents.push(wireDot({ x: 4.4, y: top }), wireDot({ x: 6.8, y: top }));

  // Rung 101: run light
  rung(top - 1, [
    ['HCR1_NO', 5.4, 'CR100', ''],
    ['HLT1R', 8.6, 'LT101', 'MOTOR RUNNING'],
  ]);
  // Rung 102: overload + motor starter
  rung(top - 2, [
    ['HOL1', 3.0, 'OL102', ''],
    ['HCR1_NO', 5.4, 'CR100', ''],
    ['HMO1', 8.6, 'M102', 'CONVEYOR MOTOR'],
  ]);
  // Rung 103: limit switch + solenoid
  rung(top - 3, [
    ['HLS11_NO', 4.0, 'LS103', 'GATE CLOSED'],
    ['HSOL1', 8.6, 'SOL103', 'CLAMP'],
  ]);
  // Rung 104: E-stop + horn
  rung(top - 4, [
    ['HPB13_NC', 3.4, 'PB104', 'E-STOP'],
    ['HHN1', 8.6, 'HN104', 'ALARM HORN'],
  ]);
  // Rung 105: terminal and ground stub
  ents.push(ins('HT0001', 2.0, top - 5, '1', ''), wire(left, top - 5, 1.625, top - 5), wire(2.375, top - 5, 3.5, top - 5), ins('HGND', 3.5, top - 5, '', ''));

  // Title block
  ents.push({
    id: newId(),
    type: 'polyline',
    layer: 'MISC',
    color: 'ByLayer',
    closed: true,
    points: [
      { x: -0.5, y: top - 6.8 },
      { x: 11.5, y: top - 6.8 },
      { x: 11.5, y: top + 1.5 },
      { x: -0.5, y: top + 1.5 },
    ],
  });
  ents.push(text(0, top - 6.5, 'CONVEYOR 1 - MOTOR CONTROL', 'MISC', 0.2, 'left'), text(11.2, top - 6.5, 'SHEET 002', 'MISC', 0.15, 'right'));

  editor.doc.addEntities(ents);
  assignWireNumbers(editor.doc, 100);
  editor.doc.dirty = false;
  editor.zoomExtents();
}
