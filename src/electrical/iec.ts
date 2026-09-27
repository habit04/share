/**
 * IEC 60617-style schematic symbols (original artwork). Same conventions as
 * the JIC set: base point at the wire connection centre, inline symbols are
 * 0.75 wide with stubs to ±0.375 (drawings in inches; scale for metric).
 */
import type { BlockDef, Entity, AttributeDef } from '../core/entities';
import type { SymbolCategory } from './symbols';

const HALF = 0.375;
let n = 0;
const id = () => `iec${(n += 1)}`;
const base = { layer: '0', color: 'ByLayer' as const };
const L = (x1: number, y1: number, x2: number, y2: number): Entity => ({ ...base, id: id(), type: 'line', a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });
const C = (cx: number, cy: number, r: number): Entity => ({ ...base, id: id(), type: 'circle', center: { x: cx, y: cy }, radius: r });
const P = (pts: Array<[number, number]>, closed = false): Entity => ({ ...base, id: id(), type: 'polyline', points: pts.map(([x, y]) => ({ x, y })), closed });
const T = (x: number, y: number, text: string, h = 0.09): Entity => ({ ...base, id: id(), type: 'text', position: { x, y }, text, height: h, rotation: 0, align: 'center' });
const tagAttr = (y = 0.3): AttributeDef => ({ tag: 'TAG1', prompt: 'Component tag', default: '', position: { x: 0, y }, height: 0.125, align: 'center' });
const descAttr = (y = -0.45): AttributeDef => ({ tag: 'DESC1', prompt: 'Description', default: '', position: { x: 0, y }, height: 0.1, align: 'center' });
const stubs = (bodyHalf: number): Entity[] => [L(-HALF, 0, -bodyHalf, 0), L(bodyHalf, 0, HALF, 0)];
const block = (name: string, description: string, entities: Entity[], attributes: AttributeDef[] = [tagAttr(), descAttr()]): BlockDef => ({
  name,
  description,
  basePoint: { x: 0, y: 0 },
  entities,
  attributes,
});

// IEC contacts: a hinged blade drawn at an angle; NC has a stop bar.
const contactNO = block('IEC_K_NO', 'Contact, normally open (IEC)', [...stubs(0.15), L(-0.15, 0, 0.12, 0.16)]);
const contactNC = block('IEC_K_NC', 'Contact, normally closed (IEC)', [...stubs(0.15), L(-0.15, 0, 0.12, 0.16), L(0.15, 0, 0.15, 0.18)]);
const pbNO = block('IEC_S_PB_NO', 'Push button, NO (IEC)', [...stubs(0.15), L(-0.15, 0, 0.12, 0.16), L(-0.02, 0.09, -0.02, 0.3), L(-0.12, 0.3, 0.08, 0.3), L(-0.06, 0.13, -0.06, 0.18), L(0.02, 0.13, 0.02, 0.18)]);
const pbNC = block('IEC_S_PB_NC', 'Push button, NC (IEC)', [...stubs(0.15), L(-0.15, 0, 0.12, 0.16), L(0.15, 0, 0.15, 0.18), L(-0.02, 0.09, -0.02, 0.3), L(-0.12, 0.3, 0.08, 0.3)]);
const estop = block('IEC_S_ESTOP', 'Emergency stop, NC (IEC)', [...stubs(0.15), L(-0.15, 0, 0.12, 0.16), L(0.15, 0, 0.15, 0.18), L(-0.02, 0.09, -0.02, 0.26), { ...base, id: id(), type: 'arc', center: { x: -0.02, y: 0.28 }, radius: 0.1, startAngle: 0, endAngle: Math.PI }, L(-0.12, 0.28, 0.08, 0.28)]);
const selector = block('IEC_S_SEL', 'Selector switch (IEC)', [...stubs(0.15), L(-0.15, 0, 0.12, 0.16), L(-0.02, 0.09, -0.02, 0.26), L(-0.1, 0.26, 0.06, 0.26), L(-0.1, 0.26, -0.1, 0.32), L(0.06, 0.26, 0.06, 0.32)]);
const limitNO = block('IEC_S_LIM_NO', 'Limit switch, NO (IEC)', [...stubs(0.15), L(-0.15, 0, 0.12, 0.16), L(-0.15, 0, -0.2, 0.12), L(-0.2, 0.12, -0.26, 0.06)]);
const disconnect = block('IEC_Q_DISC', 'Disconnector (IEC)', [...stubs(0.15), L(-0.15, 0, 0.12, 0.16), L(-0.15, -0.06, -0.15, 0.06)]);
const breaker = block('IEC_Q_CB', 'Circuit breaker (IEC)', [...stubs(0.15), L(-0.15, 0, 0.12, 0.16), L(-0.2, -0.05, -0.1, 0.05), L(-0.2, 0.05, -0.1, -0.05)]);
const fuse = block('IEC_F_FUSE', 'Fuse (IEC)', [...stubs(0.2), P([[-0.2, -0.06], [0.2, -0.06], [0.2, 0.06], [-0.2, 0.06]], true), L(-0.25, 0, 0.25, 0)]);
const coil = block('IEC_K_COIL', 'Relay coil (IEC)', [...stubs(0.15), P([[-0.15, -0.1], [0.15, -0.1], [0.15, 0.1], [-0.15, 0.1]], true)]);
const contactor = block('IEC_KM_COIL', 'Contactor coil (IEC)', [...stubs(0.15), P([[-0.15, -0.1], [0.15, -0.1], [0.15, 0.1], [-0.15, 0.1]], true), T(0, -0.04, 'KM', 0.08)]);
const timerOn = block('IEC_KT_ON', 'Timer, on-delay (IEC)', [...stubs(0.15), P([[-0.15, -0.1], [0.15, -0.1], [0.15, 0.1], [-0.15, 0.1]], true), L(-0.1, 0.16, 0.1, 0.16), L(-0.1, 0.16, 0, 0.24), L(0.1, 0.16, 0, 0.24)]);
const lamp = block('IEC_P_LAMP', 'Indicator lamp (IEC)', [...stubs(0.125), C(0, 0, 0.125), L(-0.088, -0.088, 0.088, 0.088), L(-0.088, 0.088, 0.088, -0.088)], [tagAttr(0.32), descAttr(-0.48)]);
const horn = block('IEC_P_HORN', 'Horn (IEC)', [...stubs(0.12), { ...base, id: id(), type: 'arc', center: { x: -0.12, y: 0 }, radius: 0.16, startAngle: -Math.PI / 2, endAngle: Math.PI / 2 }, L(-0.12, -0.16, -0.12, 0.16), L(-0.12, 0, 0.12, 0)]);
const motor = block('IEC_M_3', 'Motor, 3~ (IEC)', [...stubs(0.19), C(0, 0, 0.19), T(0, 0.01, 'M', 0.11), T(0, -0.12, '3~', 0.07)], [tagAttr(0.35), descAttr(-0.5)]);
const overload = block('IEC_F_OL', 'Thermal overload (IEC)', [...stubs(0.15), P([[-0.15, -0.1], [0.15, -0.1], [0.15, 0.1], [-0.15, 0.1]], true), P([[-0.06, -0.04], [0.02, -0.04], [0.02, 0.04], [0.1, 0.04]])]);
const terminal = block('IEC_X_TERM', 'Terminal (IEC)', [...stubs(0.05), C(0, 0, 0.05)], [{ tag: 'TERM01', prompt: 'Terminal number', default: '', position: { x: 0, y: 0.1 }, height: 0.1, align: 'center' }]);
const earth = block('IEC_PE', 'Protective earth (IEC)', [L(0, 0, 0, -0.15), L(-0.15, -0.15, 0.15, -0.15), L(-0.1, -0.21, 0.1, -0.21), L(-0.05, -0.27, 0.05, -0.27)], []);
const resistor = block('IEC_R', 'Resistor (IEC)', [...stubs(0.2), P([[-0.2, -0.06], [0.2, -0.06], [0.2, 0.06], [-0.2, 0.06]], true)]);
const capacitor = block('IEC_C', 'Capacitor (IEC)', [...stubs(0.03), L(-0.03, -0.12, -0.03, 0.12), L(0.03, -0.12, 0.03, 0.12)]);
const inductor = block('IEC_L', 'Inductor (IEC)', [
  ...stubs(0.2),
  { ...base, id: id(), type: 'arc', center: { x: -0.15, y: 0 }, radius: 0.05, startAngle: 0, endAngle: Math.PI },
  { ...base, id: id(), type: 'arc', center: { x: -0.05, y: 0 }, radius: 0.05, startAngle: 0, endAngle: Math.PI },
  { ...base, id: id(), type: 'arc', center: { x: 0.05, y: 0 }, radius: 0.05, startAngle: 0, endAngle: Math.PI },
  { ...base, id: id(), type: 'arc', center: { x: 0.15, y: 0 }, radius: 0.05, startAngle: 0, endAngle: Math.PI },
]);
const transformer = block(
  'IEC_T',
  'Transformer (IEC)',
  [L(-HALF, 0.2, -0.2, 0.2), C(-0.08, 0.2, 0.12), C(0.08, 0.2, 0.12), L(0.2, 0.2, HALF, 0.2)],
  [tagAttr(0.45), descAttr(-0.1)],
);
const plcIn = block(
  'IEC_PLC_I',
  'PLC input (IEC)',
  [L(-HALF, 0, -0.15, 0), P([[-0.15, -0.12], [0.15, -0.12], [0.15, 0.12], [-0.15, 0.12]], true), T(0, -0.04, 'I', 0.1)],
  [{ tag: 'TAG1', prompt: 'Address', default: 'I0.0', position: { x: 0, y: 0.2 }, height: 0.08, align: 'center' }, descAttr(-0.3)],
);
const plcOut = block(
  'IEC_PLC_Q',
  'PLC output (IEC)',
  [P([[-0.15, -0.12], [0.15, -0.12], [0.15, 0.12], [-0.15, 0.12]], true), L(0.15, 0, HALF, 0), T(0, -0.04, 'Q', 0.1)],
  [{ tag: 'TAG1', prompt: 'Address', default: 'Q0.0', position: { x: 0, y: 0.2 }, height: 0.08, align: 'center' }, descAttr(-0.3)],
);

export const IEC_CATEGORIES: SymbolCategory[] = [
  { name: 'IEC: Contacts & Coils', symbols: [contactNO, contactNC, coil, contactor, timerOn] },
  { name: 'IEC: Push Buttons & Switches', symbols: [pbNO, pbNC, estop, selector, limitNO, disconnect, breaker] },
  { name: 'IEC: Protection', symbols: [fuse, overload] },
  { name: 'IEC: Loads', symbols: [motor, lamp, horn] },
  { name: 'IEC: Passive', symbols: [resistor, capacitor, inductor, transformer] },
  { name: 'IEC: Terminals / PLC', symbols: [terminal, earth, plcIn, plcOut] },
];

export const IEC_SYMBOLS: BlockDef[] = IEC_CATEGORIES.flatMap((c) => c.symbols);
