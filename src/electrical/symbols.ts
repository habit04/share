/**
 * Built-in schematic symbol library (JIC/NFPA-style ladder symbols).
 * All geometry is original and drawn from primitives. Units: inches.
 * Each block's base point is the wire-connection centre; horizontal symbols
 * connect at x = ±HALF on y = 0. Every symbol carries the AutoCAD Electrical
 * attribute set (see attributes.ts) so exported DXF holds ACADE-style data.
 */
import type { BlockDef, Entity, AttributeDef } from '../core/entities';
import type { Point } from '../core/geometry';
import { withAcadeAttributes } from './attributes';

const HALF = 0.375; // half width of an inline symbol
const GAP = 0.125; // half of the contact gap

let n = 0;
const id = () => `sym${(n += 1)}`;
const base = { layer: '0', color: 'ByLayer' as const };

const L = (x1: number, y1: number, x2: number, y2: number): Entity => ({
  ...base,
  id: id(),
  type: 'line',
  a: { x: x1, y: y1 },
  b: { x: x2, y: y2 },
});
const C = (cx: number, cy: number, r: number): Entity => ({ ...base, id: id(), type: 'circle', center: { x: cx, y: cy }, radius: r });
const A = (cx: number, cy: number, r: number, s: number, e: number): Entity => ({
  ...base,
  id: id(),
  type: 'arc',
  center: { x: cx, y: cy },
  radius: r,
  startAngle: (s * Math.PI) / 180,
  endAngle: (e * Math.PI) / 180,
});
const P = (pts: Array<[number, number]>, closed = false): Entity => ({
  ...base,
  id: id(),
  type: 'polyline',
  points: pts.map(([x, y]) => ({ x, y })),
  closed,
});
const T = (x: number, y: number, text: string, h = 0.1): Entity => ({
  ...base,
  id: id(),
  type: 'text',
  position: { x, y },
  text,
  height: h,
  rotation: 0,
  align: 'center',
});

const tagAttr = (y = 0.3): AttributeDef => ({ tag: 'TAG1', prompt: 'Component tag', default: '', position: { x: 0, y }, height: 0.125, align: 'center' });
const descAttr = (y = -0.45): AttributeDef => ({ tag: 'DESC1', prompt: 'Description', default: '', position: { x: 0, y }, height: 0.1, align: 'center' });

/** Wire stubs from the connection points to the symbol body. */
const stubs = (bodyHalf: number): Entity[] => [L(-HALF, 0, -bodyHalf, 0), L(bodyHalf, 0, HALF, 0)];

function block(name: string, description: string, entities: Entity[], attributes: AttributeDef[] = [tagAttr(), descAttr()], basePoint: Point = { x: 0, y: 0 }): BlockDef {
  return { name, description, basePoint, entities, attributes };
}

export interface SymbolCategory {
  name: string;
  symbols: BlockDef[];
}

// Contacts ---------------------------------------------------------------
const contactNO = block('HCR1_NO', 'Relay contact, normally open', [
  ...stubs(GAP),
  L(-GAP, -0.125, -GAP, 0.125),
  L(GAP, -0.125, GAP, 0.125),
]);
const contactNC = block('HCR1_NC', 'Relay contact, normally closed', [
  ...stubs(GAP),
  L(-GAP, -0.125, -GAP, 0.125),
  L(GAP, -0.125, GAP, 0.125),
  L(-GAP - 0.05, -0.16, GAP + 0.05, 0.16),
]);
// Timer contacts: a small arrow-head arc above the contact marks the delayed action.
const timedNO = (name: string, desc: string, up: boolean) =>
  block(name, desc, [
    ...stubs(GAP),
    L(-GAP, -0.125, -GAP, 0.125),
    L(GAP, -0.125, GAP, 0.125),
    up ? A(0, 0.3, 0.1, 180, 360) : A(0, 0.2, 0.1, 0, 180),
  ]);
const timedNC = (name: string, desc: string, up: boolean) =>
  block(name, desc, [
    ...stubs(GAP),
    L(-GAP, -0.125, -GAP, 0.125),
    L(GAP, -0.125, GAP, 0.125),
    L(-GAP - 0.05, -0.16, GAP + 0.05, 0.16),
    up ? A(0, 0.3, 0.1, 180, 360) : A(0, 0.2, 0.1, 0, 180),
  ]);
const tdOnNO = timedNO('HTD1_NO', 'On-delay contact, timed closed (NOTC)', true);
const tdOnNC = timedNC('HTD1_NC', 'On-delay contact, timed open (NCTO)', true);
const tdOffNO = timedNO('HTD2_NO', 'Off-delay contact, timed open (NOTO)', false);
const tdOffNC = timedNC('HTD2_NC', 'Off-delay contact, timed closed (NCTC)', false);
const auxNO = block('HKM1_NO', 'Contactor auxiliary contact, normally open', [...stubs(GAP), L(-GAP, -0.125, -GAP, 0.125), L(GAP, -0.125, GAP, 0.125), T(0, 0.17, 'M', 0.07)]);
const auxNC = block('HKM1_NC', 'Contactor auxiliary contact, normally closed', [
  ...stubs(GAP),
  L(-GAP, -0.125, -GAP, 0.125),
  L(GAP, -0.125, GAP, 0.125),
  L(-GAP - 0.05, -0.16, GAP + 0.05, 0.16),
  T(0, 0.19, 'M', 0.07),
]);

// Push buttons -----------------------------------------------------------
const pbNO = block('HPB11_NO', 'Push button, normally open', [
  ...stubs(GAP),
  C(-GAP, 0, 0.03),
  C(GAP, 0, 0.03),
  L(-GAP - 0.06, 0.09, GAP + 0.06, 0.09),
  L(0, 0.09, 0, 0.2),
  L(-0.125, 0.2, 0.125, 0.2),
]);
const pbNC = block('HPB12_NC', 'Push button, normally closed', [
  ...stubs(GAP),
  C(-GAP, 0, 0.03),
  C(GAP, 0, 0.03),
  L(-GAP - 0.06, -0.06, GAP + 0.06, -0.06),
  L(0, -0.06, 0, 0.2),
  L(-0.125, 0.2, 0.125, 0.2),
]);
const mushroom = block('HPB13_NC', 'Mushroom head push button (E-stop), normally closed', [
  ...stubs(GAP),
  C(-GAP, 0, 0.03),
  C(GAP, 0, 0.03),
  L(-GAP - 0.06, -0.06, GAP + 0.06, -0.06),
  L(0, -0.06, 0, 0.16),
  A(0, 0.16, 0.12, 0, 180),
  L(-0.12, 0.16, 0.12, 0.16),
]);
const footNO = block('HFT11_NO', 'Foot switch, normally open', [
  ...stubs(GAP),
  C(-GAP, 0, 0.03),
  C(GAP, 0, 0.03),
  L(-GAP, 0, GAP + 0.05, 0.14),
  P([[0, 0.07], [0, 0.2], [-0.12, 0.2], [-0.18, 0.28]]),
]);
const footNC = block('HFT12_NC', 'Foot switch, normally closed', [
  ...stubs(GAP),
  C(-GAP, 0, 0.03),
  C(GAP, 0, 0.03),
  L(-GAP, 0, GAP + 0.08, -0.08),
  P([[0, -0.04], [0, 0.16], [-0.12, 0.16], [-0.18, 0.24]]),
]);

// Switches ---------------------------------------------------------------
const limitNO = block('HLS11_NO', 'Limit switch, normally open', [
  ...stubs(GAP),
  C(-GAP, 0, 0.03),
  C(GAP, 0, 0.03),
  L(-GAP, 0, GAP + 0.05, 0.14),
  P([[GAP + 0.05, 0.14], [GAP + 0.12, 0.22]]),
]);
const limitNC = block('HLS12_NC', 'Limit switch, normally closed', [
  ...stubs(GAP),
  C(-GAP, 0, 0.03),
  C(GAP, 0, 0.03),
  L(-GAP, 0, GAP + 0.08, -0.08),
  L(GAP + 0.08, -0.08, GAP + 0.18, 0.04),
]);
const selector = block('HSS11', 'Selector switch, 2 position', [
  ...stubs(GAP),
  C(-GAP, 0, 0.03),
  C(GAP, 0, 0.03),
  L(-GAP, 0, GAP - 0.02, 0.15),
  L(-0.06, 0.24, 0.06, 0.24),
  L(0, 0.24, 0, 0.15),
]);
const selector3 = block('HSS12', 'Selector switch, 3 position (hand-off-auto)', [
  ...stubs(GAP),
  C(-GAP, 0, 0.03),
  C(GAP, 0, 0.03),
  C(0, 0.22, 0.03),
  L(-GAP, 0, 0.1, 0.13),
  L(-0.1, 0.32, 0.1, 0.32),
  L(0, 0.32, 0, 0.13),
  T(-0.28, 0.24, 'H', 0.06),
  T(0, 0.38, 'O', 0.06),
  T(0.28, 0.24, 'A', 0.06),
]);
const disconnect = block('HDS1', 'Disconnect switch, single pole', [
  ...stubs(GAP),
  C(-GAP, 0, 0.03),
  L(-GAP, 0, GAP + 0.04, 0.16),
  C(GAP, 0, 0.03),
]);
const floatSw = block('HFS11_NO', 'Float switch, normally open', [
  ...stubs(GAP),
  C(-GAP, 0, 0.03),
  C(GAP, 0, 0.03),
  L(-GAP, 0, GAP + 0.04, 0.13),
  C(GAP + 0.09, 0.2, 0.06),
]);
const floatNC = block('HFS12_NC', 'Float switch, normally closed', [
  ...stubs(GAP),
  C(-GAP, 0, 0.03),
  C(GAP, 0, 0.03),
  L(-GAP, 0, GAP + 0.08, -0.08),
  C(GAP + 0.12, -0.16, 0.06),
]);
const pressSw = block('HPS11_NO', 'Pressure switch, normally open', [
  ...stubs(GAP),
  C(-GAP, 0, 0.03),
  C(GAP, 0, 0.03),
  L(-GAP, 0, GAP + 0.04, 0.13),
  A(GAP + 0.09, 0.22, 0.06, 180, 360),
  L(GAP + 0.03, 0.22, GAP + 0.15, 0.22),
]);
const pressNC = block('HPS12_NC', 'Pressure switch, normally closed', [
  ...stubs(GAP),
  C(-GAP, 0, 0.03),
  C(GAP, 0, 0.03),
  L(-GAP, 0, GAP + 0.08, -0.08),
  A(GAP + 0.12, -0.18, 0.06, 0, 180),
  L(GAP + 0.06, -0.18, GAP + 0.18, -0.18),
]);
const proxNO = block('HPX11_NO', 'Proximity switch, normally open', [
  ...stubs(GAP),
  C(-GAP, 0, 0.03),
  C(GAP, 0, 0.03),
  L(-GAP, 0, GAP + 0.05, 0.14),
  P([[-0.06, 0.2], [-0.06, 0.32], [0.06, 0.32], [0.06, 0.2]], true),
  L(-0.14, 0.26, -0.06, 0.26),
]);
const proxNC = block('HPX12_NC', 'Proximity switch, normally closed', [
  ...stubs(GAP),
  C(-GAP, 0, 0.03),
  C(GAP, 0, 0.03),
  L(-GAP, 0, GAP + 0.08, -0.08),
  P([[-0.06, 0.12], [-0.06, 0.24], [0.06, 0.24], [0.06, 0.12]], true),
  L(-0.14, 0.18, -0.06, 0.18),
]);
const flowNO = block('HFL11_NO', 'Flow switch, normally open', [
  ...stubs(GAP),
  C(-GAP, 0, 0.03),
  C(GAP, 0, 0.03),
  L(-GAP, 0, GAP + 0.04, 0.13),
  P([[GAP - 0.02, 0.26], [GAP + 0.09, 0.2], [GAP + 0.2, 0.26]]),
  L(GAP + 0.09, 0.2, GAP + 0.09, 0.3),
]);
const flowNC = block('HFL12_NC', 'Flow switch, normally closed', [
  ...stubs(GAP),
  C(-GAP, 0, 0.03),
  C(GAP, 0, 0.03),
  L(-GAP, 0, GAP + 0.08, -0.08),
  P([[GAP + 0.01, -0.2], [GAP + 0.12, -0.26], [GAP + 0.23, -0.2]]),
  L(GAP + 0.12, -0.26, GAP + 0.12, -0.16),
]);
const tempNO = block('HTS11_NO', 'Temperature switch, normally open', [
  ...stubs(GAP),
  C(-GAP, 0, 0.03),
  C(GAP, 0, 0.03),
  L(-GAP, 0, GAP + 0.04, 0.13),
  P([[GAP + 0.02, 0.2], [GAP + 0.07, 0.2], [GAP + 0.07, 0.3], [GAP + 0.12, 0.3], [GAP + 0.12, 0.2], [GAP + 0.17, 0.2]]),
]);
const tempNC = block('HTS12_NC', 'Temperature switch, normally closed', [
  ...stubs(GAP),
  C(-GAP, 0, 0.03),
  C(GAP, 0, 0.03),
  L(-GAP, 0, GAP + 0.08, -0.08),
  P([[GAP + 0.05, -0.18], [GAP + 0.1, -0.18], [GAP + 0.1, -0.28], [GAP + 0.15, -0.28], [GAP + 0.15, -0.18], [GAP + 0.2, -0.18]]),
]);
const toggle = block('HSW1', 'Toggle switch, single pole', [...stubs(GAP), C(-GAP, 0, 0.03), C(GAP, 0, 0.03), L(-GAP, 0, GAP + 0.02, 0.15), C(GAP + 0.04, 0.17, 0.03)]);

// Coils / loads ----------------------------------------------------------
const coil = block('HCR1', 'Relay coil', [...stubs(0.125), C(0, 0, 0.125)]);
const timerCoil = block('HTD1', 'Timer relay coil (on-delay)', [
  ...stubs(0.125),
  C(0, 0, 0.125),
  T(0, -0.045, 'TR', 0.08),
]);
const timerOff = block('HTD2', 'Timer relay coil (off-delay)', [...stubs(0.125), C(0, 0, 0.125), T(0, -0.045, 'TO', 0.08)]);
const contactorCoil = block('HKM1', 'Contactor / motor starter coil', [...stubs(0.125), C(0, 0, 0.125), T(0, -0.045, 'M', 0.09)]);
const solenoid = block('HSOL1', 'Solenoid coil', [
  ...stubs(0.16),
  A(-0.08, 0, 0.08, 0, 180),
  A(0.08, 0, 0.08, 0, 180),
]);
const solValve = block('HSV1', 'Solenoid valve', [
  ...stubs(0.16),
  A(-0.08, 0, 0.08, 0, 180),
  A(0.08, 0, 0.08, 0, 180),
  L(0, 0, 0, -0.14),
  P([[-0.12, -0.14], [0.12, -0.14], [-0.12, -0.28], [0.12, -0.28]], true),
]);
const light = block(
  'HLT1R',
  'Pilot light, red',
  [...stubs(0.125), C(0, 0, 0.125), L(-0.088, -0.088, 0.088, 0.088), L(-0.088, 0.088, 0.088, -0.088), T(0.22, 0.12, 'R', 0.07)],
  [tagAttr(0.32), descAttr(-0.48)],
);
const lightG = block(
  'HLT1G',
  'Pilot light, green',
  [...stubs(0.125), C(0, 0, 0.125), L(-0.088, -0.088, 0.088, 0.088), L(-0.088, 0.088, 0.088, -0.088), T(0.22, 0.12, 'G', 0.07)],
  [tagAttr(0.32), descAttr(-0.48)],
);
const lightA = block(
  'HLT1A',
  'Pilot light, amber',
  [...stubs(0.125), C(0, 0, 0.125), L(-0.088, -0.088, 0.088, 0.088), L(-0.088, 0.088, 0.088, -0.088), T(0.22, 0.12, 'A', 0.07)],
  [tagAttr(0.32), descAttr(-0.48)],
);
const lightPTT = block(
  'HLT2R',
  'Pilot light, push-to-test',
  [...stubs(0.125), C(0, 0, 0.125), L(-0.088, -0.088, 0.088, 0.088), L(-0.088, 0.088, 0.088, -0.088), L(0, 0.125, 0, 0.22), L(-0.1, 0.22, 0.1, 0.22)],
  [tagAttr(0.36), descAttr(-0.48)],
);
const horn = block('HHN1', 'Horn / alarm', [
  ...stubs(0.1),
  P([[-0.1, -0.08], [-0.1, 0.08], [0.02, 0.08], [0.02, -0.08]], true),
  P([[0.02, 0.08], [0.16, 0.16], [0.16, -0.16], [0.02, -0.08]]),
]);
const buzzer = block('HBZ1', 'Buzzer', [...stubs(0.14), A(0, 0, 0.14, 0, 180), L(-0.14, 0, 0.14, 0), L(-0.06, -0.06, 0.06, -0.06)]);
const bell = block('HBL1', 'Bell', [...stubs(0.14), A(0, -0.02, 0.14, 0, 180), L(-0.14, -0.02, 0.14, -0.02), L(0, -0.02, 0, -0.1), C(0, -0.13, 0.03)]);
const motor = block('HMO1', 'Motor, 3 phase', [...stubs(0.19), C(0, 0, 0.19), T(0, -0.06, 'M', 0.14)], [tagAttr(0.35), descAttr(-0.5)]);
const motor1 = block('HMO2', 'Motor, single phase', [...stubs(0.19), C(0, 0, 0.19), T(0, -0.02, 'M', 0.11), T(0, -0.14, '1~', 0.06)], [tagAttr(0.35), descAttr(-0.5)]);
const heater = block('HHT1', 'Heater element', [
  ...stubs(0.2),
  P([[-0.2, 0], [-0.15, 0.08], [-0.05, -0.08], [0.05, 0.08], [0.15, -0.08], [0.2, 0]]),
]);

// Protection / misc ------------------------------------------------------
const fuse = block('HFU1', 'Fuse', [
  ...stubs(0.15),
  P([[-0.15, -0.06], [0.15, -0.06], [0.15, 0.06], [-0.15, 0.06]], true),
  L(-0.15, 0, 0.15, 0),
]);
const breaker = block('HCB1', 'Circuit breaker, single pole', [
  ...stubs(GAP),
  C(-GAP, 0, 0.03),
  C(GAP, 0, 0.03),
  A(0, -0.05, 0.135, 20, 160),
]);
/** Three-pole breaker: poles 0.5 apart (the default 3-phase bus spacing) joined by a dashed link. */
const breaker3 = block(
  'HCB3',
  'Circuit breaker, 3 pole',
  [
    ...[0, -0.5, -1.0].flatMap((y) => [L(-HALF, y, -GAP, y), L(GAP, y, HALF, y), C(-GAP, y, 0.03), C(GAP, y, 0.03), A(0, y - 0.05, 0.135, 20, 160)]),
    ...[0.05, -0.1, -0.25, -0.4, -0.55, -0.7, -0.85].map((y) => L(0, y, 0, y - 0.06)),
  ],
  [tagAttr(0.35), descAttr(-1.45)],
);
const disconnect3 = block(
  'HDS3',
  'Disconnect switch, 3 pole',
  [
    ...[0, -0.5, -1.0].flatMap((y) => [L(-HALF, y, -GAP, y), L(GAP, y, HALF, y), C(-GAP, y, 0.03), C(GAP, y, 0.03), L(-GAP, y, GAP + 0.04, y + 0.16)]),
    ...[0.1, -0.05, -0.2, -0.35, -0.5, -0.65, -0.8].map((y) => L(0.02, y, 0.02, y - 0.06)),
  ],
  [tagAttr(0.35), descAttr(-1.45)],
);
const overload = block('HOL1', 'Overload relay (thermal)', [
  ...stubs(0.12),
  P([[-0.12, 0], [-0.12, 0.1], [-0.04, 0.1], [-0.04, -0.1], [0.04, -0.1], [0.04, 0.1], [0.12, 0.1], [0.12, 0]]),
]);
const overloadNC = block('HOL1_NC', 'Overload relay contact, normally closed', [
  ...stubs(GAP),
  L(-GAP, -0.125, -GAP, 0.125),
  L(GAP, -0.125, GAP, 0.125),
  L(-GAP - 0.05, -0.16, GAP + 0.05, 0.16),
  T(0, 0.19, 'OL', 0.06),
]);
const terminal = block('HT0001', 'Terminal', [...stubs(0.05), C(0, 0, 0.05)], [
  { tag: 'TERM01', prompt: 'Terminal number', default: '', position: { x: 0, y: 0.1 }, height: 0.1, align: 'center' },
]);
const ground = block(
  'HGND',
  'Ground',
  [L(0, 0, 0, -0.15), L(-0.15, -0.15, 0.15, -0.15), L(-0.1, -0.21, 0.1, -0.21), L(-0.05, -0.27, 0.05, -0.27)],
  [],
);
const resistor = block('HRE1', 'Resistor', [
  ...stubs(0.2),
  P([[-0.2, 0], [-0.16, 0.07], [-0.08, -0.07], [0, 0.07], [0.08, -0.07], [0.16, 0.07], [0.2, 0]]),
]);
const capacitor = block('HCA1', 'Capacitor', [...stubs(0.03), L(-0.03, -0.12, -0.03, 0.12), L(0.03, -0.12, 0.03, 0.12)]);
const diode = block('HDI1', 'Diode', [...stubs(0.1), P([[-0.1, -0.1], [-0.1, 0.1], [0.1, 0]], true), L(0.1, -0.1, 0.1, 0.1)]);
const varistor = block('HVR1', 'Surge suppressor (varistor)', [
  ...stubs(0.2),
  P([[-0.2, -0.07], [0.2, -0.07], [0.2, 0.07], [-0.2, 0.07]], true),
  L(-0.22, -0.12, 0.22, 0.12),
]);
const battery = block('HBT1', 'Battery', [...stubs(0.09), L(-0.09, -0.14, -0.09, 0.14), L(-0.03, -0.07, -0.03, 0.07), L(0.03, -0.14, 0.03, 0.14), L(0.09, -0.07, 0.09, 0.07), T(-0.14, 0.18, '+', 0.07)]);
const receptacle = block('HRC1', 'Receptacle', [
  ...stubs(0.15),
  A(0, 0, 0.15, 90, 270),
  L(0, -0.15, 0, 0.15),
  L(-0.06, 0.05, -0.06, -0.05),
  L(-0.11, 0.05, -0.11, -0.05),
]);
const voltmeter = block('HVM1', 'Voltmeter', [...stubs(0.15), C(0, 0, 0.15), T(0, -0.05, 'V', 0.11)]);
const ammeter = block('HAM1', 'Ammeter', [...stubs(0.15), C(0, 0, 0.15), T(0, -0.05, 'A', 0.11)]);
const transformer = block(
  'HXF1',
  'Control transformer',
  [
    L(-0.375, 0.25, -0.2, 0.25),
    A(-0.15, 0.25, 0.05, 0, 180),
    A(-0.05, 0.25, 0.05, 0, 180),
    A(0.05, 0.25, 0.05, 0, 180),
    A(0.15, 0.25, 0.05, 0, 180),
    L(0.2, 0.25, 0.375, 0.25),
    L(-0.2, 0.17, 0.2, 0.17),
    L(-0.2, 0.13, 0.2, 0.13),
    L(-0.375, 0.05, -0.2, 0.05),
    A(-0.15, 0.05, 0.05, 180, 360),
    A(-0.05, 0.05, 0.05, 180, 360),
    A(0.05, 0.05, 0.05, 180, 360),
    A(0.15, 0.05, 0.05, 180, 360),
    L(0.2, 0.05, 0.375, 0.05),
  ],
  [tagAttr(0.4), descAttr(-0.15)],
  { x: 0, y: 0 },
);
const transformerTap = block(
  'HXF2',
  'Control transformer with tapped primary',
  [
    L(-0.375, 0.25, -0.2, 0.25),
    A(-0.15, 0.25, 0.05, 0, 180),
    A(-0.05, 0.25, 0.05, 0, 180),
    A(0.05, 0.25, 0.05, 0, 180),
    A(0.15, 0.25, 0.05, 0, 180),
    L(0.2, 0.25, 0.375, 0.25),
    L(-0.1, 0.3, -0.1, 0.42),
    L(0.1, 0.3, 0.1, 0.42),
    T(-0.1, 0.46, 'H2', 0.05),
    T(0.1, 0.46, 'H3', 0.05),
    L(-0.2, 0.17, 0.2, 0.17),
    L(-0.2, 0.13, 0.2, 0.13),
    L(-0.375, 0.05, -0.2, 0.05),
    A(-0.15, 0.05, 0.05, 180, 360),
    A(-0.05, 0.05, 0.05, 180, 360),
    A(0.05, 0.05, 0.05, 180, 360),
    A(0.15, 0.05, 0.05, 180, 360),
    L(0.2, 0.05, 0.375, 0.05),
  ],
  [tagAttr(0.58), descAttr(-0.15)],
  { x: 0, y: 0 },
);
const plcInput = block(
  'HPLCI',
  'PLC input point',
  [L(-HALF, 0, -0.15, 0), P([[-0.15, -0.12], [0.15, -0.12], [0.15, 0.12], [-0.15, 0.12]], true), T(0, -0.04, 'I', 0.1)],
  [
    { tag: 'TAG1', prompt: 'Address', default: 'I:0/0', position: { x: 0, y: 0.2 }, height: 0.08, align: 'center' },
    descAttr(-0.3),
  ],
);
const plcOutput = block(
  'HPLCO',
  'PLC output point',
  [P([[-0.15, -0.12], [0.15, -0.12], [0.15, 0.12], [-0.15, 0.12]], true), L(0.15, 0, HALF, 0), T(0, -0.04, 'O', 0.1)],
  [
    { tag: 'TAG1', prompt: 'Address', default: 'O:0/0', position: { x: 0, y: 0.2 }, height: 0.08, align: 'center' },
    descAttr(-0.3),
  ],
);
const plcOutputRelay = block(
  'HPLCOR',
  'PLC relay output point',
  [P([[-0.15, -0.12], [0.15, -0.12], [0.15, 0.12], [-0.15, 0.12]], true), L(0.15, 0, HALF, 0), L(-0.08, -0.05, 0.06, 0.05), L(-0.08, -0.05, -0.08, 0.05)],
  [
    { tag: 'TAG1', prompt: 'Address', default: 'O:0/0', position: { x: 0, y: 0.2 }, height: 0.08, align: 'center' },
    descAttr(-0.3),
  ],
);
const plcAnalogIn = block(
  'HPLCAI',
  'PLC analog input point',
  [L(-HALF, 0, -0.15, 0), P([[-0.15, -0.12], [0.15, -0.12], [0.15, 0.12], [-0.15, 0.12]], true), P([[-0.1, -0.04], [-0.05, 0.05], [0, -0.05], [0.05, 0.05], [0.1, -0.04]])],
  [
    { tag: 'TAG1', prompt: 'Address', default: 'I:1.0', position: { x: 0, y: 0.2 }, height: 0.08, align: 'center' },
    descAttr(-0.3),
  ],
);

/** Wire junction dot, inserted wherever a wire tees into another. */
export const WIRE_DOT: BlockDef = {
  name: 'WDDOT',
  description: 'Wire junction dot',
  basePoint: { x: 0, y: 0 },
  entities: [{ ...base, id: id(), type: 'circle', center: { x: 0, y: 0 }, radius: 0.035, filled: true }],
  attributes: [],
};

/** Tag-prefix rules contributed by the extended libraries (see library.ts). */
const extraPrefixes: Array<[RegExp, string]> = [];
/** Register block-name patterns -> tag prefix for symbols outside this module. */
export function registerTagPrefixes(entries: Array<[RegExp, string]>): void {
  for (const e of entries) extraPrefixes.push(e);
}

/** Default component tag prefix by family (AutoCAD Electrical style e.g. PB, CR, LT). */
export function tagPrefix(blockName: string): string {
  for (const [re, p] of extraPrefixes) if (re.test(blockName)) return p;
  const map: Array<[RegExp, string]> = [
    [/^HPB/, 'PB'],
    [/^HFT/, 'FTS'],
    [/^HSS/, 'SS'],
    [/^HSW/, 'SW'],
    [/^HDS/, 'DS'],
    [/^HLS/, 'LS'],
    [/^HFS/, 'FS'],
    [/^HPS/, 'PS'],
    [/^HPX/, 'PRS'],
    [/^HFL/, 'FLS'],
    [/^HTS/, 'TS'],
    [/^HCR/, 'CR'],
    [/^HTD/, 'TD'],
    [/^HKM/, 'M'],
    [/^HSOL/, 'SOL'],
    [/^HSV/, 'SV'],
    [/^HLT/, 'LT'],
    [/^HHN/, 'HN'],
    [/^HBZ/, 'BZ'],
    [/^HBL/, 'BL'],
    [/^HMO/, 'MTR'],
    [/^HOL/, 'OL'],
    [/^HHT/, 'HTR'],
    [/^HFU/, 'FU'],
    [/^HCB/, 'CB'],
    [/^HT0/, 'TB'],
    [/^HRE/, 'R'],
    [/^HCA/, 'C'],
    [/^HDI/, 'D'],
    [/^HVR/, 'MOV'],
    [/^HBT/, 'BT'],
    [/^HRC/, 'RCPT'],
    [/^HVM/, 'VM'],
    [/^HAM/, 'AM'],
    [/^HXF/, 'T'],
    [/^HPLC/, 'PLC'],
    [/^HGND/, 'GND'],
    [/^IEC_K_COIL|^IEC_K_N/, 'K'],
    [/^IEC_KM/, 'KM'],
    [/^IEC_KT/, 'KT'],
    [/^IEC_S_/, 'S'],
    [/^IEC_Q_/, 'Q'],
    [/^IEC_F_/, 'F'],
    [/^IEC_P_/, 'P'],
    [/^IEC_M_/, 'M'],
    [/^IEC_X_/, 'X'],
    [/^IEC_Y_/, 'Y'],
    [/^IEC_G_/, 'G'],
    [/^IEC_V_/, 'V'],
    [/^IEC_E_/, 'E'],
    [/^IEC_RCPT/, 'X'],
    [/^IEC_R/, 'R'],
    [/^IEC_C/, 'C'],
    [/^IEC_L/, 'L'],
    [/^IEC_T/, 'T'],
    [/^IEC_PLC/, 'PLC'],
    [/^IEC_PE/, 'PE'],
  ];
  for (const [re, p] of map) if (re.test(blockName)) return p;
  return 'DEV';
}

const acade = (b: BlockDef): BlockDef => withAcadeAttributes(b, tagPrefix(b.name));
const cat = (name: string, symbols: BlockDef[]): SymbolCategory => ({ name, symbols: symbols.map(acade) });

export const SYMBOL_CATEGORIES: SymbolCategory[] = [
  cat('Push Buttons', [pbNO, pbNC, mushroom, lightPTT, footNO, footNC]),
  cat('Selector Switches', [selector, selector3, toggle, disconnect, disconnect3]),
  cat('Limit / Proximity Switches', [limitNO, limitNC, proxNO, proxNC]),
  cat('Pressure / Flow / Temp / Float', [pressSw, pressNC, flowNO, flowNC, tempNO, tempNC, floatSw, floatNC]),
  cat('Relays / Contacts', [coil, contactNO, contactNC, timerCoil, timerOff, tdOnNO, tdOnNC, tdOffNO, tdOffNC]),
  cat('Pilot Lights / Alarms', [light, lightG, lightA, horn, buzzer, bell]),
  cat('Motor Control', [contactorCoil, auxNO, auxNC, motor, motor1, overload, overloadNC, heater, solenoid, solValve]),
  cat('Fuses / Breakers / Transformers', [fuse, breaker, breaker3, transformer, transformerTap, varistor]),
  cat('Terminals / Misc', [terminal, ground, resistor, capacitor, diode, battery, receptacle, voltmeter, ammeter]),
  cat('PLC I/O', [plcInput, plcOutput, plcOutputRelay, plcAnalogIn]),
];

export const ALL_SYMBOLS: BlockDef[] = [...SYMBOL_CATEGORIES.flatMap((c) => c.symbols), WIRE_DOT];

export function findSymbol(name: string): BlockDef | undefined {
  return ALL_SYMBOLS.find((s) => s.name === name);
}
