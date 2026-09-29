/**
 * IEC 60617-style schematic symbols (original artwork). Same conventions as
 * the JIC set: base point at the wire connection centre, inline symbols are
 * 0.75 wide with stubs to ±0.375 (drawings in inches; scale for metric).
 * Every symbol carries the AutoCAD Electrical attribute set.
 */
import type { BlockDef, Entity, AttributeDef } from '../core/entities';
import type { SymbolCategory } from './symbols';
import { tagPrefix } from './symbols';
import { withAcadeAttributes } from './attributes';
import { verticalSymbol, type VerticalSpec } from './symbol-kit';

const HALF = 0.375;
let n = 0;
const id = () => `iec${(n += 1)}`;
const base = { layer: '0', color: 'ByLayer' as const };
const L = (x1: number, y1: number, x2: number, y2: number): Entity => ({ ...base, id: id(), type: 'line', a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });
const C = (cx: number, cy: number, r: number): Entity => ({ ...base, id: id(), type: 'circle', center: { x: cx, y: cy }, radius: r });
const A = (cx: number, cy: number, r: number, s: number, e: number): Entity => ({ ...base, id: id(), type: 'arc', center: { x: cx, y: cy }, radius: r, startAngle: (s * Math.PI) / 180, endAngle: (e * Math.PI) / 180 });
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
const box = (): Entity => P([[-0.15, -0.1], [0.15, -0.1], [0.15, 0.1], [-0.15, 0.1]], true);
const blade = (): Entity => L(-0.15, 0, 0.12, 0.16);
const stop = (): Entity => L(0.15, 0, 0.15, 0.18);

// IEC contacts: a hinged blade drawn at an angle; NC has a stop bar.
const contactNO = block('IEC_K_NO', 'Contact, normally open (IEC)', [...stubs(0.15), blade()]);
const contactNC = block('IEC_K_NC', 'Contact, normally closed (IEC)', [...stubs(0.15), blade(), stop()]);
const kmNO = block('IEC_KM_NO', 'Contactor auxiliary contact, NO (IEC)', [...stubs(0.15), blade(), T(0, 0.22, 'KM', 0.06)]);
const kmNC = block('IEC_KM_NC', 'Contactor auxiliary contact, NC (IEC)', [...stubs(0.15), blade(), stop(), T(0, 0.24, 'KM', 0.06)]);
// Timer contacts: a small parachute arc shows the delayed direction.
const ktOnNO = block('IEC_KT_ON_NO', 'On-delay contact, NO (IEC)', [...stubs(0.15), blade(), A(-0.02, 0.32, 0.08, 180, 360)]);
const ktOnNC = block('IEC_KT_ON_NC', 'On-delay contact, NC (IEC)', [...stubs(0.15), blade(), stop(), A(-0.02, 0.34, 0.08, 180, 360)]);
const ktOffNO = block('IEC_KT_OFF_NO', 'Off-delay contact, NO (IEC)', [...stubs(0.15), blade(), A(-0.02, 0.24, 0.08, 0, 180)]);
const ktOffNC = block('IEC_KT_OFF_NC', 'Off-delay contact, NC (IEC)', [...stubs(0.15), blade(), stop(), A(-0.02, 0.26, 0.08, 0, 180)]);
const pbNO = block('IEC_S_PB_NO', 'Push button, NO (IEC)', [...stubs(0.15), blade(), L(-0.02, 0.09, -0.02, 0.3), L(-0.12, 0.3, 0.08, 0.3)]);
const pbNC = block('IEC_S_PB_NC', 'Push button, NC (IEC)', [...stubs(0.15), blade(), stop(), L(-0.02, 0.09, -0.02, 0.3), L(-0.12, 0.3, 0.08, 0.3)]);
const estop = block('IEC_S_ESTOP', 'Emergency stop, NC (IEC)', [...stubs(0.15), blade(), stop(), L(-0.02, 0.09, -0.02, 0.26), A(-0.02, 0.28, 0.1, 0, 180), L(-0.12, 0.28, 0.08, 0.28)]);
const selector = block('IEC_S_SEL', 'Selector switch (IEC)', [...stubs(0.15), blade(), L(-0.02, 0.09, -0.02, 0.26), L(-0.1, 0.26, 0.06, 0.26), L(-0.1, 0.26, -0.1, 0.32), L(0.06, 0.26, 0.06, 0.32)]);
const selector3 = block('IEC_S_SEL3', 'Selector switch, 3 position (IEC)', [
  ...stubs(0.15),
  blade(),
  L(-0.02, 0.09, -0.02, 0.26),
  L(-0.1, 0.26, 0.06, 0.26),
  L(-0.1, 0.26, -0.1, 0.32),
  L(0.06, 0.26, 0.06, 0.32),
  T(-0.28, 0.2, 'I', 0.06),
  T(-0.02, 0.36, '0', 0.06),
  T(0.26, 0.2, 'II', 0.06),
]);
const limitNO = block('IEC_S_LIM_NO', 'Limit switch, NO (IEC)', [...stubs(0.15), blade(), L(-0.15, 0, -0.2, 0.12), L(-0.2, 0.12, -0.26, 0.06)]);
const limitNC = block('IEC_S_LIM_NC', 'Limit switch, NC (IEC)', [...stubs(0.15), blade(), stop(), L(-0.15, 0, -0.2, 0.12), L(-0.2, 0.12, -0.26, 0.06)]);
const foot = block('IEC_S_FOOT', 'Foot switch (IEC)', [...stubs(0.15), blade(), L(-0.02, 0.09, -0.02, 0.22), L(-0.02, 0.22, -0.14, 0.22), L(-0.14, 0.22, -0.2, 0.3)]);
const prox = block('IEC_S_PROX', 'Proximity switch (IEC)', [...stubs(0.15), blade(), P([[-0.16, 0.2], [-0.16, 0.34], [-0.02, 0.34], [-0.02, 0.2]], true), L(-0.16, 0.2, -0.02, 0.34)]);
const flow = block('IEC_S_FLOW', 'Flow switch (IEC)', [...stubs(0.15), blade(), P([[-0.14, 0.32], [-0.06, 0.24], [0.02, 0.32]]), L(-0.06, 0.24, -0.06, 0.36)]);
const temp = block('IEC_S_TEMP', 'Temperature switch (IEC)', [...stubs(0.15), blade(), T(-0.06, 0.24, 't', 0.09)]);
const press = block('IEC_S_PRESS', 'Pressure switch (IEC)', [...stubs(0.15), blade(), T(-0.06, 0.24, 'p', 0.09)]);
const disconnect = block('IEC_Q_DISC', 'Disconnector (IEC)', [...stubs(0.15), blade(), L(-0.15, -0.06, -0.15, 0.06)]);
const breaker = block('IEC_Q_CB', 'Circuit breaker (IEC)', [...stubs(0.15), blade(), L(-0.2, -0.05, -0.1, 0.05), L(-0.2, 0.05, -0.1, -0.05)]);
const breaker3 = block(
  'IEC_Q_CB3',
  'Circuit breaker, 3 pole (IEC)',
  [
    ...[0, -0.5, -1.0].flatMap((y) => [L(-HALF, y, -0.15, y), L(0.15, y, HALF, y), L(-0.15, y, 0.12, y + 0.16), L(-0.2, y - 0.05, -0.1, y + 0.05), L(-0.2, y + 0.05, -0.1, y - 0.05)]),
    ...[0.1, -0.05, -0.2, -0.35, -0.5, -0.65, -0.8].map((y) => L(0, y, 0, y - 0.06)),
  ],
  [tagAttr(0.35), descAttr(-1.45)],
);
const fuse = block('IEC_F_FUSE', 'Fuse (IEC)', [...stubs(0.2), P([[-0.2, -0.06], [0.2, -0.06], [0.2, 0.06], [-0.2, 0.06]], true), L(-0.25, 0, 0.25, 0)]);
const coil = block('IEC_K_COIL', 'Relay coil (IEC)', [...stubs(0.15), box()]);
const contactor = block('IEC_KM_COIL', 'Contactor coil (IEC)', [...stubs(0.15), box()]);
const timerOn = block('IEC_KT_ON', 'Timer, on-delay (IEC)', [...stubs(0.15), box(), L(-0.1, 0.16, 0.1, 0.16), L(-0.1, 0.16, 0, 0.24), L(0.1, 0.16, 0, 0.24)]);
const timerOff = block('IEC_KT_OFF', 'Timer, off-delay (IEC)', [...stubs(0.15), box(), L(-0.1, 0.24, 0.1, 0.24), L(-0.1, 0.24, 0, 0.16), L(0.1, 0.24, 0, 0.16)]);
const valve = block('IEC_Y_VALVE', 'Solenoid valve (IEC)', [...stubs(0.15), box(), L(0, -0.1, 0, -0.2), P([[-0.1, -0.2], [0.1, -0.2], [-0.1, -0.32], [0.1, -0.32]], true)]);
const lamp = block('IEC_P_LAMP', 'Indicator lamp (IEC)', [...stubs(0.125), C(0, 0, 0.125), L(-0.088, -0.088, 0.088, 0.088), L(-0.088, 0.088, 0.088, -0.088)], [tagAttr(0.32), descAttr(-0.48)]);
const lampG = block('IEC_P_LAMP_GN', 'Indicator lamp, green (IEC)', [...stubs(0.125), C(0, 0, 0.125), L(-0.088, -0.088, 0.088, 0.088), L(-0.088, 0.088, 0.088, -0.088), T(0.24, 0.12, 'GN', 0.06)], [tagAttr(0.32), descAttr(-0.48)]);
const lampR = block('IEC_P_LAMP_RD', 'Indicator lamp, red (IEC)', [...stubs(0.125), C(0, 0, 0.125), L(-0.088, -0.088, 0.088, 0.088), L(-0.088, 0.088, 0.088, -0.088), T(0.24, 0.12, 'RD', 0.06)], [tagAttr(0.32), descAttr(-0.48)]);
const horn = block('IEC_P_HORN', 'Horn (IEC)', [...stubs(0.12), A(-0.12, 0, 0.16, -90, 90), L(-0.12, -0.16, -0.12, 0.16), L(-0.12, 0, 0.12, 0)]);
const buzzer = block('IEC_P_BUZZ', 'Buzzer (IEC)', [...stubs(0.14), A(0, 0, 0.14, 0, 180), L(-0.14, 0, 0.14, 0)]);
const meterV = block('IEC_P_V', 'Voltmeter (IEC)', [...stubs(0.15), C(0, 0, 0.15), T(0, -0.05, 'V', 0.11)]);
const meterA = block('IEC_P_A', 'Ammeter (IEC)', [...stubs(0.15), C(0, 0, 0.15), T(0, -0.05, 'A', 0.11)]);
const motor = block('IEC_M_3', 'Motor, 3~ (IEC)', [...stubs(0.19), C(0, 0, 0.19), T(0, 0.01, 'M', 0.11), T(0, -0.12, '3~', 0.07)], [tagAttr(0.35), descAttr(-0.5)]);
const motor1 = block('IEC_M_1', 'Motor, 1~ (IEC)', [...stubs(0.19), C(0, 0, 0.19), T(0, 0.01, 'M', 0.11), T(0, -0.12, '1~', 0.07)], [tagAttr(0.35), descAttr(-0.5)]);
const overload = block('IEC_F_OL', 'Thermal overload (IEC)', [...stubs(0.15), box(), P([[-0.06, -0.04], [0.02, -0.04], [0.02, 0.04], [0.1, 0.04]])]);
const overloadNC = block('IEC_F_OL_NC', 'Thermal overload contact, NC (IEC)', [...stubs(0.15), blade(), stop(), P([[-0.12, 0.22], [-0.04, 0.22], [-0.04, 0.3], [0.04, 0.3]])]);
const terminal = block('IEC_X_TERM', 'Terminal (IEC)', [...stubs(0.05), C(0, 0, 0.05)], [{ tag: 'TERM01', prompt: 'Terminal number', default: '', position: { x: 0, y: 0.1 }, height: 0.1, align: 'center' }]);
const socket = block('IEC_X_SOCKET', 'Socket outlet (IEC)', [...stubs(0.15), A(0, 0, 0.15, 90, 270), L(0, -0.15, 0, 0.15)]);
const earth = block('IEC_PE', 'Protective earth (IEC)', [L(0, 0, 0, -0.15), L(-0.15, -0.15, 0.15, -0.15), L(-0.1, -0.21, 0.1, -0.21), L(-0.05, -0.27, 0.05, -0.27)], []);
const resistor = block('IEC_R', 'Resistor (IEC)', [...stubs(0.2), P([[-0.2, -0.06], [0.2, -0.06], [0.2, 0.06], [-0.2, 0.06]], true)]);
const capacitor = block('IEC_C', 'Capacitor (IEC)', [...stubs(0.03), L(-0.03, -0.12, -0.03, 0.12), L(0.03, -0.12, 0.03, 0.12)]);
const inductor = block('IEC_L', 'Inductor (IEC)', [...stubs(0.2), A(-0.15, 0, 0.05, 0, 180), A(-0.05, 0, 0.05, 0, 180), A(0.05, 0, 0.05, 0, 180), A(0.15, 0, 0.05, 0, 180)]);
const diode = block('IEC_V_DIODE', 'Diode (IEC)', [...stubs(0.1), P([[-0.1, -0.1], [-0.1, 0.1], [0.1, 0]], true), L(0.1, -0.1, 0.1, 0.1)]);
const battery = block('IEC_G_BATT', 'Battery (IEC)', [...stubs(0.09), L(-0.09, -0.14, -0.09, 0.14), L(-0.03, -0.07, -0.03, 0.07), L(0.03, -0.14, 0.03, 0.14), L(0.09, -0.07, 0.09, 0.07)]);
const transformer = block(
  'IEC_T',
  'Transformer (IEC)',
  [L(-HALF, 0.2, -0.2, 0.2), C(-0.08, 0.2, 0.12), C(0.08, 0.2, 0.12), L(0.2, 0.2, HALF, 0.2)],
  [tagAttr(0.45), descAttr(-0.1)],
);
const transformerTap = block(
  'IEC_T_TAP',
  'Transformer with taps (IEC)',
  [L(-HALF, 0.2, -0.2, 0.2), C(-0.08, 0.2, 0.12), C(0.08, 0.2, 0.12), L(0.2, 0.2, HALF, 0.2), L(-0.08, 0.32, -0.08, 0.42), L(0.08, 0.32, 0.08, 0.42)],
  [tagAttr(0.5), descAttr(-0.1)],
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
const plcOutRelay = block(
  'IEC_PLC_QR',
  'PLC relay output (IEC)',
  [P([[-0.15, -0.12], [0.15, -0.12], [0.15, 0.12], [-0.15, 0.12]], true), L(0.15, 0, HALF, 0), L(-0.08, -0.05, 0.06, 0.05)],
  [{ tag: 'TAG1', prompt: 'Address', default: 'Q0.0', position: { x: 0, y: 0.2 }, height: 0.08, align: 'center' }, descAttr(-0.3)],
);
const plcAnalog = block(
  'IEC_PLC_AI',
  'PLC analog input (IEC)',
  [L(-HALF, 0, -0.15, 0), P([[-0.15, -0.12], [0.15, -0.12], [0.15, 0.12], [-0.15, 0.12]], true), P([[-0.1, -0.04], [-0.05, 0.05], [0, -0.05], [0.05, 0.05], [0.1, -0.04]])],
  [{ tag: 'TAG1', prompt: 'Address', default: 'IW0', position: { x: 0, y: 0.2 }, height: 0.08, align: 'center' }, descAttr(-0.3)],
);

const acade = (b: BlockDef): BlockDef => withAcadeAttributes(b, tagPrefix(b.name));
const cat = (name: string, symbols: BlockDef[]): SymbolCategory => ({ name, symbols: symbols.map(acade) });

export const IEC_CATEGORIES: SymbolCategory[] = [
  cat('IEC: Contacts & Coils', [contactNO, contactNC, coil, contactor, kmNO, kmNC, timerOn, timerOff, ktOnNO, ktOnNC, ktOffNO, ktOffNC]),
  cat('IEC: Push Buttons & Switches', [pbNO, pbNC, estop, selector, selector3, limitNO, limitNC, foot, prox, flow, temp, press, disconnect, breaker, breaker3]),
  cat('IEC: Protection', [fuse, overload, overloadNC]),
  cat('IEC: Loads', [motor, motor1, lamp, lampG, lampR, horn, buzzer, valve, meterV, meterA]),
  cat('IEC: Passive', [resistor, capacitor, inductor, diode, battery, transformer, transformerTap]),
  cat('IEC: Terminals / PLC', [terminal, socket, earth, plcIn, plcOut, plcOutRelay, plcAnalog]),
];

export const IEC_SYMBOLS: BlockDef[] = IEC_CATEGORIES.flatMap((c) => c.symbols);

// Curated vertical variants (NAME_V) ---------------------------------------
// Hand-drawn twins of the most used IEC symbols for vertical wires: connections
// at (0, +-0.375), actuators to the left, TAG1 / DESC1-3 to the right; family,
// WDTYPE and pin defaults come from the horizontal symbol.
const vst = (b: number): Entity[] => [L(0, HALF, 0, b), L(0, -b, 0, -HALF)];
/** The hinged blade of the horizontal set, turned onto the vertical wire (actuator side on the left). */
const vblade = (): Entity => L(0, 0.15, -0.16, -0.12);
const vstop = (): Entity => L(0, -0.15, -0.18, -0.15);
const vbox = (): Entity => P([[-0.1, 0.15], [0.1, 0.15], [0.1, -0.15], [-0.1, -0.15]], true);
const vpush = (): Entity[] => [L(-0.09, 0.02, -0.3, 0.02), L(-0.3, 0.12, -0.3, -0.08)];

const IEC_VERTICAL_SPECS: Array<[string, VerticalSpec]> = [
  ['IEC_S_PB_NO', { name: 'IEC_S_PB_NO_V', entities: [...vst(0.15), vblade(), ...vpush()] }],
  ['IEC_S_PB_NC', { name: 'IEC_S_PB_NC_V', entities: [...vst(0.15), vblade(), vstop(), ...vpush()] }],
  ['IEC_S_LIM_NO', { name: 'IEC_S_LIM_NO_V', entities: [...vst(0.15), vblade(), L(0, 0.15, -0.12, 0.2), L(-0.12, 0.2, -0.06, 0.26)] }],
  ['IEC_K_COIL', { name: 'IEC_K_COIL_V', entities: [...vst(0.15), vbox()] }],
  ['IEC_KM_COIL', { name: 'IEC_KM_COIL_V', entities: [...vst(0.15), vbox()] }],
  ['IEC_K_NO', { name: 'IEC_K_NO_V', entities: [...vst(0.15), vblade()] }],
  ['IEC_K_NC', { name: 'IEC_K_NC_V', entities: [...vst(0.15), vblade(), vstop()] }],
  ['IEC_F_FUSE', { name: 'IEC_F_FUSE_V', entities: [...vst(0.2), P([[-0.06, 0.2], [0.06, 0.2], [0.06, -0.2], [-0.06, -0.2]], true), L(0, 0.25, 0, -0.25)] }],
  ['IEC_Q_CB', { name: 'IEC_Q_CB_V', entities: [...vst(0.15), vblade(), L(0.05, 0.2, -0.05, 0.1), L(-0.05, 0.2, 0.05, 0.1)] }],
  ['IEC_P_LAMP', { name: 'IEC_P_LAMP_V', entities: [...vst(0.125), C(0, 0, 0.125), L(-0.088, -0.088, 0.088, 0.088), L(-0.088, 0.088, 0.088, -0.088)] }],
  ['IEC_X_TERM', { name: 'IEC_X_TERM_V', entities: [...vst(0.05), C(0, 0, 0.05)], attrX: 0.1 }],
  ['IEC_M_3', { name: 'IEC_M_3_V', entities: [...vst(0.19), C(0, 0, 0.19), T(0, 0.01, 'M', 0.11), T(0, -0.12, '3~', 0.07)] }],
];

/** Curated vertical IEC symbols (IEC_S_PB_NO_V ...), resolved by the icon menu's Vertical orientation. */
export const IEC_VERTICAL_SYMBOLS: BlockDef[] = IEC_VERTICAL_SPECS.map(([h, spec]) => {
  const twin = IEC_SYMBOLS.find((s) => s.name === h);
  if (!twin) throw new Error(`vertical twin ${spec.name}: no ${h}`);
  return verticalSymbol(twin, tagPrefix(h), spec);
});
