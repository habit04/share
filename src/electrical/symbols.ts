/**
 * Built-in schematic symbol library (JIC/NFPA-style ladder symbols).
 * All geometry is original and drawn from primitives. Units: inches.
 * Each block's base point is the wire-connection centre; horizontal symbols
 * connect at x = ±HALF on y = 0.
 */
import type { BlockDef, Entity, AttributeDef } from '../core/entities';
import type { Point } from '../core/geometry';

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
const pressSw = block('HPS11_NO', 'Pressure switch, normally open', [
  ...stubs(GAP),
  C(-GAP, 0, 0.03),
  C(GAP, 0, 0.03),
  L(-GAP, 0, GAP + 0.04, 0.13),
  A(GAP + 0.09, 0.22, 0.06, 180, 360),
  L(GAP + 0.03, 0.22, GAP + 0.15, 0.22),
]);

// Coils / loads ----------------------------------------------------------
const coil = block('HCR1', 'Relay coil', [...stubs(0.125), C(0, 0, 0.125)]);
const timerCoil = block('HTD1', 'Timer relay coil (on-delay)', [
  ...stubs(0.125),
  C(0, 0, 0.125),
  T(0, -0.045, 'TR', 0.08),
]);
const solenoid = block('HSOL1', 'Solenoid coil', [
  ...stubs(0.16),
  A(-0.08, 0, 0.08, 0, 180),
  A(0.08, 0, 0.08, 0, 180),
]);
const light = block(
  'HLT1R',
  'Pilot light',
  [...stubs(0.125), C(0, 0, 0.125), L(-0.088, -0.088, 0.088, 0.088), L(-0.088, 0.088, 0.088, -0.088)],
  [tagAttr(0.32), descAttr(-0.48)],
);
const horn = block('HHN1', 'Horn / alarm', [
  ...stubs(0.1),
  P([[-0.1, -0.08], [-0.1, 0.08], [0.02, 0.08], [0.02, -0.08]], true),
  P([[0.02, 0.08], [0.16, 0.16], [0.16, -0.16], [0.02, -0.08]]),
]);
const motor = block('HMO1', 'Motor, 3 phase', [...stubs(0.19), C(0, 0, 0.19), T(0, -0.06, 'M', 0.14)], [tagAttr(0.35), descAttr(-0.5)]);
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
const overload = block('HOL1', 'Overload relay (thermal)', [
  ...stubs(0.12),
  P([[-0.12, 0], [-0.12, 0.1], [-0.04, 0.1], [-0.04, -0.1], [0.04, -0.1], [0.04, 0.1], [0.12, 0.1], [0.12, 0]]),
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
const plcInput = block(
  'HPLCI',
  'PLC input point',
  [L(-HALF, 0, -0.15, 0), P([[-0.15, -0.12], [0.15, -0.12], [0.15, 0.12], [-0.15, 0.12]], true), T(0, -0.04, 'I', 0.1)],
  [
    { tag: 'TAG1', prompt: 'Address', default: 'I:0/0', position: { x: 0, y: 0.2 }, height: 0.08, align: 'center' },
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

export const SYMBOL_CATEGORIES: SymbolCategory[] = [
  { name: 'Push Buttons', symbols: [pbNO, pbNC, mushroom] },
  { name: 'Selector Switches', symbols: [selector, disconnect] },
  { name: 'Limit Switches', symbols: [limitNO, limitNC] },
  { name: 'Pressure / Float Switches', symbols: [pressSw, floatSw] },
  { name: 'Relays / Contacts', symbols: [coil, timerCoil, contactNO, contactNC] },
  { name: 'Pilot Lights', symbols: [light, horn] },
  { name: 'Motor Control', symbols: [motor, overload, heater, solenoid] },
  { name: 'Fuses / Breakers', symbols: [fuse, breaker, transformer] },
  { name: 'Terminals / Misc', symbols: [terminal, ground, resistor, capacitor, plcInput] },
];

export const ALL_SYMBOLS: BlockDef[] = [...SYMBOL_CATEGORIES.flatMap((c) => c.symbols), WIRE_DOT];

export function findSymbol(name: string): BlockDef | undefined {
  return ALL_SYMBOLS.find((s) => s.name === name);
}

/** Default component tag prefix by family (AutoCAD Electrical style e.g. PB, CR, LT). */
export function tagPrefix(blockName: string): string {
  const map: Array<[RegExp, string]> = [
    [/^HPB/, 'PB'],
    [/^HSS/, 'SS'],
    [/^HDS/, 'DS'],
    [/^HLS/, 'LS'],
    [/^HFS/, 'FS'],
    [/^HPS/, 'PS'],
    [/^HCR/, 'CR'],
    [/^HTD/, 'TD'],
    [/^HSOL/, 'SOL'],
    [/^HLT/, 'LT'],
    [/^HHN/, 'HN'],
    [/^HMO/, 'M'],
    [/^HOL/, 'OL'],
    [/^HHT/, 'HTR'],
    [/^HFU/, 'FU'],
    [/^HCB/, 'CB'],
    [/^HT0/, 'TB'],
    [/^HRE/, 'R'],
    [/^HCA/, 'C'],
    [/^HXF/, 'T'],
    [/^HPLC/, 'PLC'],
  ];
  for (const [re, p] of map) if (re.test(blockName)) return p;
  return 'DEV';
}
