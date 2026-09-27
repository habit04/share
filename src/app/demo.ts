import type { Editor } from './editor';
import type { Entity } from '../core/entities';
import { newId } from '../core/entities';
import { breakWire, assignWireNumbers } from '../tools/electrical';
import type { LineEntity } from '../core/entities';

/** Seed a small motor-control ladder so screenshots and manual testing have content. */
export function seedDemoDrawing(editor: Editor): void {
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

  const left = 1;
  const right = 10;
  const top = 8;
  const rungs = 6;
  ents.push(wire(left, top + 0.5, left, top - (rungs - 1) - 0.5), wire(right, top + 0.5, right, top - (rungs - 1) - 0.5));
  for (let i = 0; i < rungs; i += 1) ents.push(text(left - 0.25, top - i - 0.06, String(100 + i)));
  ents.push(text(left, top + 0.9, 'L1', 'MISC', 0.15, 'center'), text(right, top + 0.9, 'L2', 'MISC', 0.15, 'center'));

  // Rung 100: fuse + stop PB + start PB + coil
  let r = wire(left, top, right, top);
  const comps: Array<[string, number, number, string, string]> = [
    ['HFU1', 2.2, top, 'FU100', 'CONTROL FUSE'],
    ['HPB12_NC', 3.8, top, 'PB100', 'STOP'],
    ['HPB11_NO', 5.4, top, 'PB101', 'START'],
    ['HCR1', 8.6, top, 'CR100', 'MOTOR RUN'],
  ];
  let pieces: LineEntity[] = [r];
  for (const [b, x, y, tag, desc] of comps) {
    const target = pieces.find((p) => Math.min(p.a.x, p.b.x) <= x && Math.max(p.a.x, p.b.x) >= x)!;
    pieces = pieces.filter((p) => p !== target).concat(breakWire(target, x - 0.375, x + 0.375));
    ents.push(ins(b, x, y, tag, desc));
  }
  ents.push(...pieces);
  // Seal-in contact around start PB
  ents.push(wire(4.6, top, 4.6, top - 0.5), wire(4.6, top - 0.5, 6.2, top - 0.5), wire(6.2, top - 0.5, 6.2, top));
  ents.push(ins('HCR1_NO', 5.4, top - 0.5, 'CR100', ''));

  // Rung 101: run light
  r = wire(left, top - 1, right, top - 1);
  pieces = breakWire(r, 5.4 - 0.375, 5.4 + 0.375);
  const p2 = pieces[1]!;
  pieces = [pieces[0]!, ...breakWire(p2, 8.6 - 0.375, 8.6 + 0.375)];
  ents.push(...pieces, ins('HCR1_NO', 5.4, top - 1, 'CR100', ''), ins('HLT1R', 8.6, top - 1, 'LT101', 'MOTOR RUNNING'));

  // Rung 102: overload + motor starter
  r = wire(left, top - 2, right, top - 2);
  pieces = breakWire(r, 3.0 - 0.375, 3.0 + 0.375);
  pieces = [pieces[0]!, ...breakWire(pieces[1]!, 5.4 - 0.375, 5.4 + 0.375)];
  pieces = [pieces[0]!, pieces[1]!, ...breakWire(pieces[2]!, 8.6 - 0.375, 8.6 + 0.375)];
  ents.push(...pieces, ins('HOL1', 3.0, top - 2, 'OL102', ''), ins('HCR1_NO', 5.4, top - 2, 'CR100', ''), ins('HMO1', 8.6, top - 2, 'M102', 'CONVEYOR MOTOR'));

  // Rung 103: limit switch + solenoid
  r = wire(left, top - 3, right, top - 3);
  pieces = breakWire(r, 4.0 - 0.375, 4.0 + 0.375);
  pieces = [pieces[0]!, ...breakWire(pieces[1]!, 8.6 - 0.375, 8.6 + 0.375)];
  ents.push(...pieces, ins('HLS11_NO', 4.0, top - 3, 'LS103', 'GATE CLOSED'), ins('HSOL1', 8.6, top - 3, 'SOL103', 'CLAMP'));

  // Rung 104: E-stop + horn
  r = wire(left, top - 4, right, top - 4);
  pieces = breakWire(r, 3.4 - 0.375, 3.4 + 0.375);
  pieces = [pieces[0]!, ...breakWire(pieces[1]!, 8.6 - 0.375, 8.6 + 0.375)];
  ents.push(...pieces, ins('HPB13_NC', 3.4, top - 4, 'PB104', 'E-STOP'), ins('HHN1', 8.6, top - 4, 'HN104', 'ALARM HORN'));

  // Ground and terminals on rung 105
  ents.push(ins('HT0001', 2.0, top - 5, '1', ''), wire(left, top - 5, 1.625, top - 5), wire(2.375, top - 5, 3.5, top - 5), ins('HGND', 3.5, top - 5, '', ''));

  // Title block
  const tb: Entity = {
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
  };
  ents.push(tb);
  ents.push(text(0, top - 6.5, 'CONVEYOR 1 — MOTOR CONTROL', 'MISC', 0.2, 'left'), text(11.2, top - 6.5, 'SHEET 002', 'MISC', 0.15, 'right'));

  editor.doc.addEntities(ents);
  assignWireNumbers(editor.doc, 100);
  editor.doc.dirty = false;
  editor.zoomExtents();
}
