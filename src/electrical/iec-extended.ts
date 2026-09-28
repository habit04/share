/**
 * Extended IEC 60617-style schematic symbols (original artwork), built with
 * the shared symbol kit. Same conventions as iec.ts: the base point is the
 * wire-connection centre, inline symbols are 0.75 wide with stubs to ±0.375
 * (inches; drawings are scaled for metric), multi-pole symbols place their
 * poles 0.5 apart (the default 3-phase bus spacing) with pole 1 on the base
 * point, and every symbol carries the AutoCAD Electrical attribute set.
 *
 * Block names follow the IEC letter codes: IEC_<family>_<variant>. Families
 * missing from the core tagPrefix table are contributed through
 * IEC_EXTENDED_TAG_PREFIXES (register them with registerTagPrefixes).
 */
import type { BlockDef, Entity, AttributeDef } from '../core/entities';
import { primitives, symbol, category, tagAttr, descAttr, termAttr, HALF, type SymbolCategory } from './symbol-kit';

const { L, C, A, P, T, R, stubs } = primitives('ie');

// ------------------------------------------------------------------ shared glyphs

/** Hinged contact blade of an IEC contact drawn at row `y`. */
const blade = (y = 0): Entity => L(-0.15, y, 0.12, y + 0.16);
/** Stop bar of a normally-closed contact. */
const stop = (y = 0): Entity => L(0.15, y, 0.15, y + 0.18);
/** Coil / relay box centred on row `y`. */
const box = (y = 0): Entity => R(0, y, 0.3, 0.2);
/** Wire stubs of a contact row. */
const rowStubs = (y: number, bodyHalf = 0.15): Entity[] => [L(-HALF, y, -bodyHalf, y), L(bodyHalf, y, HALF, y)];
/** Circuit-breaker cross at the fixed contact of row `y`. */
const cross = (y = 0): Entity[] => [L(-0.2, y - 0.05, -0.1, y + 0.05), L(-0.2, y + 0.05, -0.1, y - 0.05)];
/** Disconnector mark: a short bar at the hinge of row `y`. */
const hinge = (y = 0): Entity => L(-0.15, y - 0.06, -0.15, y + 0.06);
/** Dashed mechanical link between poles, from `top` down to about `bottom`. */
const link = (top: number, bottom: number, x = 0): Entity[] => {
  const out: Entity[] = [];
  for (let y = top; y - 0.06 >= bottom - 1e-9; y -= 0.15) out.push(L(x, y, x, y - 0.06));
  return out;
};
/** Fuse body drawn on the blade of row `y` (rotated rectangle around the blade centre). */
const bladeFuse = (y = 0): Entity => P([[0.0445, y + 0.156], [0.0603, y + 0.0958], [-0.0745, y + 0.004], [-0.1103, y + 0.0642]], true);
/** Push-button actuator (stem and cap) above a contact. */
const pbActuator = (capY = 0.24): Entity[] => [L(-0.02, 0.09, -0.02, capY), L(-0.12, capY, 0.08, capY)];
/** Indicator lamp glyph (circle with a cross) at (cx, cy). */
const lampGlyph = (cx: number, cy: number, r: number): Entity[] => {
  const d = r * Math.SQRT1_2;
  return [C(cx, cy, r), L(cx - d, cy - d, cx + d, cy + d), L(cx - d, cy + d, cx + d, cy - d)];
};
/** Earth (ground) glyph hanging from (x, top). */
const earthGlyph = (x: number, top: number, w = 0.16): Entity[] => [L(x - w / 2, top, x + w / 2, top), L(x - w / 3, top - 0.05, x + w / 3, top - 0.05), L(x - w / 8, top - 0.1, x + w / 8, top - 0.1)];
/** Sensor body: IEC square with the diagonal (measurand top-left, output bottom-right). */
const sensorBody = (): Entity[] => [...stubs(0.18), R(0, 0, 0.36, 0.36), L(-0.18, -0.18, 0.18, 0.18)];
/** Tiny NO / NC output contact in the lower-right triangle of a sensor body. */
const sensorOut = (nc: boolean): Entity[] => [L(0.02, -0.14, 0.13, -0.07), ...(nc ? [L(0.14, -0.14, 0.14, -0.05)] : [])];
/** Converter body: box with diagonal, input glyph top-left and output glyph bottom-right. */
const converterBody = (): Entity[] => [...stubs(0.22), R(0, 0, 0.44, 0.34), L(-0.22, -0.17, 0.22, 0.17)];
const acGlyph = (x: number, y: number): Entity => T(x, y, '~', 0.09);
const dcGlyph = (x: number, y: number): Entity[] => [L(x - 0.05, y + 0.02, x + 0.05, y + 0.02), L(x - 0.05, y - 0.02, x + 0.05, y - 0.02)];
/** Motor / generator circle with the letter and the supply text. */
const machine = (letter: string, supply: string, r = 0.19): Entity[] => [...stubs(r), C(0, 0, r), T(0, 0.01, letter, 0.11), T(0, -0.12, supply, 0.07)];
/** Valve glyph: two triangles meeting at (x, y). */
const valveGlyph = (x: number, y: number): Entity[] => [P([[x - 0.1, y + 0.06], [x - 0.1, y - 0.06], [x, y]], true), P([[x + 0.1, y + 0.06], [x + 0.1, y - 0.06], [x, y]], true)];
/** Battery glyph: two cells side by side at (x, y). */
const batteryGlyph = (x: number, y: number, h = 0.1): Entity[] => [L(x - 0.04, y - h / 2, x - 0.04, y + h / 2), L(x, y - h / 4, x, y + h / 4), L(x + 0.04, y - h / 2, x + 0.04, y + h / 2)];
/** Small PLC I/O box. */
const ioBox = (): Entity => R(0, 0, 0.32, 0.26);
const analogGlyph = (y: number): Entity => P([[-0.1, y], [-0.05, y + 0.07], [0, y - 0.02], [0.05, y + 0.07], [0.1, y]]);

/** Explicit pin (wire connection) attribute: tag must match the derived X?TERMnn tag. */
const pin = (tag: string, x: number, y: number, def: string): AttributeDef => ({ tag, prompt: `Pin ${Number(tag.slice(6))}`, default: def, position: { x, y }, height: 0.06, align: 'center', invisible: true });
/** Address-style TAG1 used by PLC I/O points. */
const addrAttr = (def: string, y = 0.2): AttributeDef => ({ tag: 'TAG1', prompt: 'Address', default: def, position: { x: 0, y }, height: 0.08, align: 'center' });
/** Attributes for an n-pole symbol (poles 0.5 apart, pole 1 on the base point). */
const poleAttrs = (poles: number, tagY = 0.5): AttributeDef[] => [tagAttr(tagY), descAttr(-(poles - 1) * 0.5 - 0.45)];
const POLES3 = [0, -0.5, -1.0];

// ------------------------------------------------------------------ buttons & switches II (S)

const pbIlNO = symbol({
  name: 'IEC_S_PB_IL_NO',
  description: 'Illuminated push button, NO (IEC)',
  family: 'S',
  entities: [...stubs(0.15), blade(), ...pbActuator(), ...lampGlyph(-0.02, 0.36, 0.08)],
  attributes: [tagAttr(0.55), descAttr(-0.45)],
});
const pbIlNC = symbol({
  name: 'IEC_S_PB_IL_NC',
  description: 'Illuminated push button, NC (IEC)',
  family: 'S',
  entities: [...stubs(0.15), blade(), stop(), ...pbActuator(), ...lampGlyph(-0.02, 0.36, 0.08)],
  attributes: [tagAttr(0.55), descAttr(-0.45)],
});
const pbNoNc = symbol({
  name: 'IEC_S_PB_NONC',
  description: 'Push button, 1 NO + 1 NC (IEC)',
  family: 'S',
  entities: [...rowStubs(0), blade(0), ...rowStubs(-0.5), blade(-0.5), stop(-0.5), ...pbActuator(), ...link(-0.05, -0.45, -0.02)],
  attributes: [tagAttr(0.4), descAttr(-0.95), pin('X1TERM01', -HALF, 0, '13'), pin('X4TERM02', HALF, 0, '14'), pin('X1TERM03', -HALF, -0.5, '21'), pin('X4TERM04', HALF, -0.5, '22')],
});
const estopTwist = symbol({
  name: 'IEC_S_ESTOP_TW',
  description: 'Emergency stop, mushroom head, twist release, NC (IEC)',
  family: 'S',
  entities: [
    ...stubs(0.15),
    blade(),
    stop(),
    L(-0.02, 0.09, -0.02, 0.24),
    L(-0.12, 0.24, 0.08, 0.24),
    A(-0.02, 0.24, 0.1, 0, 180),
    // twist-release arrow over the mushroom head
    A(-0.02, 0.3, 0.15, 25, 155),
    L(0.116, 0.363, 0.06, 0.37),
    L(0.116, 0.363, 0.11, 0.42),
  ],
  attributes: [tagAttr(0.58), descAttr(-0.45)],
});
const keySwitch = symbol({
  name: 'IEC_S_KEY',
  description: 'Key-operated switch, NO (IEC)',
  family: 'S',
  entities: [...stubs(0.15), blade(), L(-0.02, 0.09, -0.02, 0.22), C(-0.02, 0.29, 0.07), L(0.05, 0.29, 0.22, 0.29), L(0.13, 0.29, 0.13, 0.24), L(0.19, 0.29, 0.19, 0.24)],
  attributes: [tagAttr(0.5), descAttr(-0.45)],
});
const selectorHandle = (): Entity[] => [L(-0.02, 0.09, -0.02, 0.24), L(-0.1, 0.24, 0.06, 0.24), L(-0.1, 0.24, -0.1, 0.3), L(0.06, 0.24, 0.06, 0.3)];
const sel2Rows = symbol({
  name: 'IEC_S_SEL2_2R',
  description: 'Selector switch, 2 position, 2 contact rows (IEC)',
  family: 'S',
  entities: [...rowStubs(0), blade(0), ...rowStubs(-0.5), blade(-0.5), ...selectorHandle(), ...link(-0.05, -0.45, -0.02), T(-0.28, 0.16, 'I', 0.06), T(0.26, 0.16, 'II', 0.06)],
  attributes: [tagAttr(0.42), descAttr(-0.95), pin('X1TERM01', -HALF, 0, '13'), pin('X4TERM02', HALF, 0, '14'), pin('X1TERM03', -HALF, -0.5, '23'), pin('X4TERM04', HALF, -0.5, '24')],
});
const sel3Rows = symbol({
  name: 'IEC_S_SEL3_2R',
  description: 'Selector switch, 3 position, 2 contact rows (IEC)',
  family: 'S',
  entities: [
    ...rowStubs(0),
    blade(0),
    ...rowStubs(-0.5),
    blade(-0.5),
    ...selectorHandle(),
    ...link(-0.05, -0.45, -0.02),
    T(-0.28, 0.16, 'I', 0.06),
    T(-0.02, 0.34, '0', 0.06),
    T(0.26, 0.16, 'II', 0.06),
  ],
  attributes: [tagAttr(0.48), descAttr(-0.95), pin('X1TERM01', -HALF, 0, '13'), pin('X4TERM02', HALF, 0, '14'), pin('X1TERM03', -HALF, -0.5, '23'), pin('X4TERM04', HALF, -0.5, '24')],
});
const footNC = symbol({
  name: 'IEC_S_FOOT_NC',
  description: 'Foot switch, NC (IEC)',
  family: 'S',
  entities: [...stubs(0.15), blade(), stop(), L(-0.02, 0.09, -0.02, 0.2), P([[-0.02, 0.2], [-0.14, 0.2], [-0.2, 0.28], [-0.08, 0.28]])],
});
const pullCord = symbol({
  name: 'IEC_S_PULL',
  description: 'Pull-cord switch, NO (IEC)',
  family: 'S',
  entities: [...stubs(0.15), blade(), L(-0.02, 0.09, -0.02, 0.22), L(-0.1, 0.22, 0.06, 0.22), L(-0.02, 0.22, -0.02, 0.32), C(-0.02, 0.36, 0.04)],
  attributes: [tagAttr(0.5), descAttr(-0.45)],
});
const rollerLever = (): Entity[] => [L(-0.15, 0, -0.22, 0.14), C(-0.25, 0.19, 0.05)];
const limRollNO = symbol({ name: 'IEC_S_LIM_ROLL_NO', description: 'Position switch, roller, NO (IEC)', family: 'S', entities: [...stubs(0.15), blade(), ...rollerLever()] });
const limRollNC = symbol({ name: 'IEC_S_LIM_ROLL_NC', description: 'Position switch, roller, NC (IEC)', family: 'S', entities: [...stubs(0.15), blade(), stop(), ...rollerLever()] });

// ------------------------------------------------------------------ sensors (B)

const inductiveGlyph = (): Entity[] => [A(-0.14, 0.09, 0.02, 0, 180), A(-0.1, 0.09, 0.02, 0, 180), A(-0.06, 0.09, 0.02, 0, 180), L(-0.16, 0.09, -0.04, 0.09)];
const capacitiveGlyph = (): Entity[] => [L(-0.12, 0.05, -0.12, 0.14), L(-0.08, 0.05, -0.08, 0.14), L(-0.16, 0.095, -0.12, 0.095), L(-0.08, 0.095, -0.04, 0.095)];
const sensor = (name: string, description: string, glyph: Entity[], out: Entity[] = []): BlockDef => symbol({ name, description, family: 'B', entities: [...sensorBody(), ...glyph, ...out] });

const proxIndNO = sensor('IEC_B_PROX_IND_NO', 'Proximity sensor, inductive, NO (IEC)', inductiveGlyph(), sensorOut(false));
const proxIndNC = sensor('IEC_B_PROX_IND_NC', 'Proximity sensor, inductive, NC (IEC)', inductiveGlyph(), sensorOut(true));
const proxCapNO = sensor('IEC_B_PROX_CAP_NO', 'Proximity sensor, capacitive, NO (IEC)', capacitiveGlyph(), sensorOut(false));
const proxCapNC = sensor('IEC_B_PROX_CAP_NC', 'Proximity sensor, capacitive, NC (IEC)', capacitiveGlyph(), sensorOut(true));
const photo = sensor('IEC_B_PHOTO', 'Photoelectric sensor (IEC)', [L(-0.17, 0.16, -0.09, 0.08), L(-0.09, 0.08, -0.14, 0.09), L(-0.09, 0.08, -0.1, 0.13), L(-0.12, 0.17, -0.04, 0.09), L(-0.04, 0.09, -0.09, 0.1), L(-0.04, 0.09, -0.05, 0.14)], sensorOut(false));
const ultra = sensor('IEC_B_ULTRA', 'Ultrasonic sensor (IEC)', [A(-0.16, 0.1, 0.03, -60, 60), A(-0.16, 0.1, 0.06, -60, 60), A(-0.16, 0.1, 0.09, -60, 60)], sensorOut(false));
const level = sensor('IEC_B_LEVEL', 'Level sensor, float (IEC)', [P([[-0.16, 0.07], [-0.13, 0.1], [-0.1, 0.07], [-0.07, 0.1], [-0.04, 0.07]]), L(-0.1, 0.07, -0.1, 0.12), C(-0.1, 0.15, 0.03)], sensorOut(false));
const pressure = sensor('IEC_B_PRESS', 'Pressure sensor (IEC)', [T(-0.09, 0.05, 'p', 0.08)]);
const pt100 = sensor('IEC_B_TEMP_PT100', 'Temperature sensor, Pt100 (IEC)', [R(-0.1, 0.1, 0.12, 0.05), L(-0.16, 0.04, -0.06, 0.15), T(-0.09, -0.16, 'Pt', 0.05)]);
const thermocouple = sensor('IEC_B_TEMP_TC', 'Temperature sensor, thermocouple (IEC)', [P([[-0.16, 0.15], [-0.09, 0.05], [-0.02, 0.15]]), T(-0.15, 0.03, '+', 0.045), T(-0.03, 0.03, '-', 0.045)]);
const flowSensor = sensor('IEC_B_FLOW', 'Flow sensor (IEC)', [L(-0.16, 0.1, -0.05, 0.1), L(-0.05, 0.1, -0.09, 0.13), L(-0.05, 0.1, -0.09, 0.07), T(0.08, -0.14, 'F', 0.06)]);

// ------------------------------------------------------------------ relays & timers II (K, KA, KT)

const kaCoil = symbol({ name: 'IEC_KA_COIL', description: 'Auxiliary relay coil (IEC)', family: 'KA', wdtype: 'COIL', entities: [...stubs(0.15), box(), T(0, 0.14, 'KA', 0.06)], attributes: [tagAttr(0.35), descAttr(-0.45)] });
const kaNO = symbol({ name: 'IEC_KA_NO', description: 'Auxiliary relay contact, NO (IEC)', family: 'KA', wdtype: 'CONTACT', entities: [...stubs(0.15), blade(), T(0, 0.22, 'KA', 0.06)] });
const kaNC = symbol({ name: 'IEC_KA_NC', description: 'Auxiliary relay contact, NC (IEC)', family: 'KA', wdtype: 'CONTACT', entities: [...stubs(0.15), blade(), stop(), T(0, 0.24, 'KA', 0.06)] });
const latchRelay = symbol({
  name: 'IEC_K_LATCH',
  description: 'Latching relay coil (IEC)',
  family: 'K',
  wdtype: 'COIL',
  entities: [...stubs(0.15), box(), L(-0.08, 0.1, -0.08, 0.2), L(-0.08, 0.2, 0.08, 0.2), L(0.08, 0.2, 0.08, 0.14), L(0.08, 0.14, 0.03, 0.17)],
  attributes: [tagAttr(0.38), descAttr(-0.45)],
});
const counter = symbol({ name: 'IEC_K_CNT', description: 'Counter (IEC)', family: 'K', wdtype: 'COIL', entities: [...stubs(0.15), box(), T(0, -0.04, 'n', 0.09), L(-0.1, 0.14, -0.1, 0.2), L(-0.04, 0.14, -0.04, 0.2), L(0.02, 0.14, 0.02, 0.2)], attributes: [tagAttr(0.35), descAttr(-0.45)] });
const safetyRelay = symbol({ name: 'IEC_K_SAFETY', description: 'Safety relay (IEC)', family: 'K', wdtype: 'COIL', entities: [...stubs(0.18), box(), R(0, 0, 0.36, 0.26), T(0, -0.03, 'SR', 0.07)], attributes: [tagAttr(0.35), descAttr(-0.45)] });
const safetyMark = (): Entity[] => [C(-0.02, 0.3, 0.06), T(-0.02, 0.27, 'S', 0.05)];
const safetyNO = symbol({ name: 'IEC_K_SAFETY_NO', description: 'Safety relay contact, NO (IEC)', family: 'K', wdtype: 'CONTACT', entities: [...stubs(0.15), blade(), ...safetyMark()], attributes: [tagAttr(0.45), descAttr(-0.45)] });
const safetyNC = symbol({ name: 'IEC_K_SAFETY_NC', description: 'Safety relay contact, NC (IEC)', family: 'K', wdtype: 'CONTACT', entities: [...stubs(0.15), blade(), stop(), ...safetyMark()], attributes: [tagAttr(0.45), descAttr(-0.45)] });
const starGlyph = (x: number, y: number): Entity[] => [L(x, y, x, y + 0.06), L(x, y + 0.06, x - 0.04, y + 0.11), L(x, y + 0.06, x + 0.04, y + 0.11)];
const deltaGlyph = (x: number, y: number): Entity => P([[x - 0.05, y], [x + 0.05, y], [x, y + 0.1]], true);
const starDelta = symbol({
  name: 'IEC_KT_STAR',
  description: 'Star-delta timer (IEC)',
  family: 'KT',
  wdtype: 'COIL',
  entities: [...stubs(0.15), box(), ...starGlyph(-0.08, 0.15), deltaGlyph(0.08, 0.15), L(0, 0.14, 0, 0.27)],
  attributes: [tagAttr(0.4), descAttr(-0.45)],
});
const starContactNC = symbol({
  name: 'IEC_KT_STAR_Y_NC',
  description: 'Star-delta timer contact, star, NC (IEC)',
  family: 'KT',
  wdtype: 'CONTACT',
  entities: [...stubs(0.15), blade(), stop(), ...starGlyph(-0.02, 0.24)],
  attributes: [tagAttr(0.45), descAttr(-0.45)],
});
const deltaContactNO = symbol({
  name: 'IEC_KT_STAR_D_NO',
  description: 'Star-delta timer contact, delta, NO (IEC)',
  family: 'KT',
  wdtype: 'CONTACT',
  entities: [...stubs(0.15), blade(), deltaGlyph(-0.02, 0.24)],
  attributes: [tagAttr(0.45), descAttr(-0.45)],
});
const cyclicTimer = symbol({
  name: 'IEC_KT_CYC',
  description: 'Timer, cyclic / flasher (IEC)',
  family: 'KT',
  wdtype: 'COIL',
  entities: [...stubs(0.15), box(), P([[-0.14, 0.15], [-0.14, 0.23], [-0.06, 0.23], [-0.06, 0.15], [0.02, 0.15], [0.02, 0.23], [0.1, 0.23], [0.1, 0.15], [0.14, 0.15]])],
  attributes: [tagAttr(0.38), descAttr(-0.45)],
});

// ------------------------------------------------------------------ power switching (Q, KM)

/** MCB pole: breaker cross plus a thermal (rectangle) and magnetic (arc) release. */
const mcbPole = (y: number): Entity[] => [...rowStubs(y), blade(y), ...cross(y), R(-0.02, y + 0.25, 0.1, 0.06), L(-0.02, y + 0.28, -0.02, y + 0.31), A(-0.02, y + 0.34, 0.03, 0, 180)];
const mcbPoles = (n: number): Entity[] => {
  const ys = Array.from({ length: n }, (_, i) => -0.5 * i);
  return [...ys.flatMap(mcbPole), ...(n > 1 ? link(0.1, ys[n - 1]! + 0.05) : [])];
};
const mcb1 = symbol({ name: 'IEC_Q_MCB1', description: 'Miniature circuit breaker, 1 pole (IEC)', family: 'Q', entities: mcbPoles(1), attributes: poleAttrs(1) });
const mcb2 = symbol({ name: 'IEC_Q_MCB2', description: 'Miniature circuit breaker, 2 pole (IEC)', family: 'Q', entities: mcbPoles(2), attributes: poleAttrs(2) });
const mcb3 = symbol({ name: 'IEC_Q_MCB3', description: 'Miniature circuit breaker, 3 pole (IEC)', family: 'Q', entities: mcbPoles(3), attributes: poleAttrs(3) });
const mcb4 = symbol({ name: 'IEC_Q_MCB4', description: 'Miniature circuit breaker, 4 pole (IEC)', family: 'Q', entities: mcbPoles(4), attributes: poleAttrs(4) });
const mpcb3 = symbol({
  name: 'IEC_Q_MPCB3',
  description: 'Motor protection circuit breaker, 3 pole (IEC)',
  family: 'Q',
  entities: [...POLES3.flatMap((y) => [...rowStubs(y), blade(y), ...cross(y), P([[-0.1, y + 0.22], [-0.04, y + 0.22], [-0.04, y + 0.3], [0.02, y + 0.3]])]), ...link(0.1, -0.95)],
  attributes: poleAttrs(3, 0.45),
});
const rcdPoles = (withCross: boolean): Entity[] => [
  ...[0, -0.5].flatMap((y) => [...rowStubs(y), blade(y), hinge(y), ...(withCross ? cross(y) : [])]),
  ...link(0.1, -0.05),
  C(0, -0.25, 0.1),
  ...link(-0.36, -0.45),
  L(0.1, -0.25, 0.2, -0.25),
  T(0.27, -0.28, 'I', 0.06),
  P([[0.3, -0.28], [0.36, -0.28], [0.33, -0.22]], true),
];
const rcd = symbol({ name: 'IEC_Q_RCD', description: 'Residual current device, 2 pole (IEC)', family: 'Q', entities: rcdPoles(false), attributes: poleAttrs(2, 0.4) });
const rcbo = symbol({ name: 'IEC_Q_RCBO', description: 'RCBO, residual current breaker with overcurrent, 2 pole (IEC)', family: 'Q', entities: rcdPoles(true), attributes: poleAttrs(2, 0.4) });
const fsd3 = symbol({
  name: 'IEC_Q_FSD3',
  description: 'Fuse switch disconnector, 3 pole (IEC)',
  family: 'Q',
  entities: [...POLES3.flatMap((y) => [...rowStubs(y), blade(y), hinge(y), bladeFuse(y)]), ...link(0.1, -0.95)],
  attributes: poleAttrs(3, 0.4),
});
const lbs3 = symbol({
  name: 'IEC_Q_LBS3',
  description: 'Load break switch, 3 pole (IEC)',
  family: 'Q',
  entities: [...POLES3.flatMap((y) => [...rowStubs(y), blade(y), hinge(y), C(0.13, y + 0.17, 0.03)]), ...link(0.1, -0.95)],
  attributes: poleAttrs(3, 0.4),
});
const changeover = symbol({
  name: 'IEC_Q_CO',
  description: 'Changeover switch (IEC)',
  family: 'Q',
  entities: [L(-HALF, 0, -0.15, 0), L(-0.15, 0, 0.12, 0.16), L(0.15, 0.15, HALF, 0.15), L(0.15, -0.15, HALF, -0.15), C(0.16, 0.15, 0.015), C(0.16, -0.15, 0.015)],
  attributes: [tagAttr(0.35), descAttr(-0.45)],
});
const isolator3 = symbol({
  name: 'IEC_Q_ISO3',
  description: 'Isolator, 3 pole (IEC)',
  family: 'Q',
  entities: [...POLES3.flatMap((y) => [...rowStubs(y), blade(y), hinge(y)]), ...link(0.1, -0.95)],
  attributes: poleAttrs(3, 0.4),
});
const kmMain3 = symbol({
  name: 'IEC_KM_MAIN3',
  description: 'Contactor main contacts, 3 pole (IEC)',
  family: 'KM',
  wdtype: 'CONTACT',
  entities: [...POLES3.flatMap((y) => [...rowStubs(y), blade(y), A(0.15, y + 0.14, 0.04, 90, 270)]), ...link(0.1, -0.95)],
  attributes: [
    ...poleAttrs(3, 0.4),
    pin('X1TERM01', -HALF, 0, '1'),
    pin('X4TERM02', HALF, 0, '2'),
    pin('X1TERM03', -HALF, -0.5, '3'),
    pin('X4TERM04', HALF, -0.5, '4'),
    pin('X1TERM05', -HALF, -1.0, '5'),
    pin('X4TERM06', HALF, -1.0, '6'),
  ],
});

// ------------------------------------------------------------------ protection II (F)

const thermalGlyph = (y: number): Entity => P([[-0.08, y - 0.04], [-0.02, y - 0.04], [-0.02, y + 0.04], [0.08, y + 0.04]]);
const overload3 = symbol({
  name: 'IEC_F_OL3',
  description: 'Thermal overload relay, 3 pole (IEC)',
  family: 'F',
  entities: [...POLES3.flatMap((y) => [...rowStubs(y), box(y), thermalGlyph(y)]), ...link(-0.15, -0.35), ...link(-0.65, -0.85)],
  attributes: poleAttrs(3, 0.35),
});
const surge = symbol({
  name: 'IEC_F_SPD',
  description: 'Surge protective device (IEC)',
  family: 'F',
  entities: [...stubs(0.15), box(), L(-0.1, 0, 0.1, 0), L(0.1, 0, 0.03, 0.05), L(0.1, 0, 0.03, -0.05), L(0, -0.1, 0, -0.18), ...earthGlyph(0, -0.18, 0.14)],
  attributes: [tagAttr(0.3), descAttr(-0.45)],
});
const varistor = symbol({
  name: 'IEC_F_MOV',
  description: 'Varistor (IEC)',
  family: 'F',
  entities: [...stubs(0.2), R(0, 0, 0.4, 0.12), L(-0.22, -0.12, 0.22, 0.12), L(0.22, 0.12, 0.26, 0.12), T(0.26, 0.16, 'U', 0.06)],
  attributes: [tagAttr(0.32), descAttr(-0.45)],
});
const fuse3 = symbol({
  name: 'IEC_F_FUSE3',
  description: 'Fuse, 3 pole (IEC)',
  family: 'F',
  entities: POLES3.flatMap((y) => [L(-HALF, y, -0.2, y), R(0, y, 0.4, 0.12), L(-0.25, y, 0.25, y), L(0.2, y, HALF, y)]),
  attributes: poleAttrs(3, 0.3),
});
const fuseSwitch = symbol({ name: 'IEC_F_FUSE_SW', description: 'Fuse switch disconnector, 1 pole (IEC)', family: 'F', entities: [...stubs(0.15), blade(), hinge(), bladeFuse()] });
const ptcRelay = symbol({ name: 'IEC_F_PTC', description: 'Thermistor protection relay (IEC)', family: 'F', entities: [...stubs(0.15), box(), T(0, -0.03, 'PTC', 0.06), L(-0.1, 0.14, 0.1, 0.14), L(0.1, 0.14, 0.14, 0.2)], attributes: [tagAttr(0.35), descAttr(-0.45)] });
const overcurrent = symbol({ name: 'IEC_F_OC', description: 'Overcurrent relay (IEC)', family: 'F', entities: [...stubs(0.15), box(), T(0, -0.04, 'I>', 0.08)] });
const earthFault = symbol({
  name: 'IEC_F_EF',
  description: 'Earth fault relay (IEC)',
  family: 'F',
  entities: [...stubs(0.15), box(), T(-0.07, -0.04, 'I', 0.08), P([[-0.02, -0.04], [0.04, -0.04], [0.01, 0.03]], true), T(0.09, -0.04, '>', 0.08)],
});

// ------------------------------------------------------------------ motors, drives & actuators (M, Y, G, U)

const motor3Uvw = symbol({
  name: 'IEC_M_3_UVW',
  description: 'Motor, 3~, U/V/W terminals (IEC)',
  family: 'M',
  entities: [
    C(0.1, 0, 0.28),
    T(0.1, 0.02, 'M', 0.12),
    T(0.1, -0.12, '3~', 0.07),
    L(-HALF, 0.15, -0.136, 0.15),
    L(-HALF, 0, -0.18, 0),
    L(-HALF, -0.15, -0.136, -0.15),
    T(-0.3, 0.17, 'U', 0.05),
    T(-0.3, 0.02, 'V', 0.05),
    T(-0.3, -0.13, 'W', 0.05),
  ],
  attributes: [tagAttr(0.45), descAttr(-0.5), pin('X1TERM01', -HALF, 0.15, 'U'), pin('X1TERM02', -HALF, 0, 'V'), pin('X1TERM03', -HALF, -0.15, 'W')],
});
const motor1U = symbol({
  name: 'IEC_M_1_U',
  description: 'Motor, 1~, U1/U2 terminals (IEC)',
  family: 'M',
  entities: [...machine('M', '1~'), T(-0.29, 0.03, 'U1', 0.05), T(0.29, 0.03, 'U2', 0.05)],
  attributes: [tagAttr(0.35), descAttr(-0.5), pin('X1TERM01', -HALF, 0, 'U1'), pin('X4TERM02', HALF, 0, 'U2')],
});
const motorDC = symbol({ name: 'IEC_M_DC', description: 'Motor, DC (IEC)', family: 'M', entities: [...stubs(0.19), C(0, 0, 0.19), T(0, 0.02, 'M', 0.11), ...dcGlyph(0, -0.1)], attributes: [tagAttr(0.35), descAttr(-0.5)] });
const servo = symbol({
  name: 'IEC_M_SERVO',
  description: 'Servo motor with encoder (IEC)',
  family: 'M',
  entities: [L(-HALF, 0, -0.24, 0), C(-0.05, 0, 0.19), T(-0.05, 0.02, 'M', 0.1), T(-0.05, -0.11, '3~', 0.06), R(0.22, 0, 0.14, 0.14), T(0.22, -0.03, 'E', 0.06), L(0.29, 0, HALF, 0)],
  attributes: [tagAttr(0.35), descAttr(-0.5)],
});
const brake = symbol({
  name: 'IEC_Y_BRAKE',
  description: 'Electromagnetic brake (IEC)',
  family: 'Y',
  entities: [...stubs(0.15), box(), L(0, -0.1, 0, -0.18), C(0, -0.26, 0.05), A(0, -0.26, 0.09, 120, 240), A(0, -0.26, 0.09, -60, 60)],
  attributes: [tagAttr(0.3), descAttr(-0.5)],
});
const generator = symbol({ name: 'IEC_G_GEN', description: 'Generator, 3~ (IEC)', family: 'G', entities: machine('G', '3~'), attributes: [tagAttr(0.35), descAttr(-0.5)] });
const vfd = symbol({
  name: 'IEC_U_VFD',
  description: 'Frequency converter (IEC)',
  family: 'U',
  entities: [...converterBody(), acGlyph(-0.11, 0.03), acGlyph(0.09, -0.15), T(0.16, -0.05, 'f', 0.05)],
  attributes: [tagAttr(0.35), descAttr(-0.45)],
});
const softStarter = symbol({
  name: 'IEC_U_SS',
  description: 'Soft starter (IEC)',
  family: 'U',
  entities: [...converterBody(), acGlyph(-0.11, 0.03), P([[0.02, -0.14], [0.12, -0.14], [0.19, -0.04]])],
  attributes: [tagAttr(0.35), descAttr(-0.45)],
});
const solSpring = symbol({
  name: 'IEC_Y_SOL_SPRING',
  description: 'Solenoid valve, spring return (IEC)',
  family: 'Y',
  entities: [...stubs(0.15), box(), L(0, -0.1, 0, -0.18), ...valveGlyph(0, -0.24), P([[0.12, -0.24], [0.16, -0.19], [0.2, -0.29], [0.24, -0.19], [0.28, -0.29], [0.32, -0.24]])],
  attributes: [tagAttr(0.3), descAttr(-0.5)],
});
const sol2 = symbol({
  name: 'IEC_Y_SOL2',
  description: 'Solenoid valve, 2 coils (IEC)',
  family: 'Y',
  entities: [L(-HALF, 0, -0.29, 0), R(-0.22, 0, 0.14, 0.14), L(-0.15, 0, 0.15, 0), R(0.22, 0, 0.14, 0.14), L(0.29, 0, HALF, 0), L(0, 0, 0, -0.18), ...valveGlyph(0, -0.24)],
  attributes: [tagAttr(0.3), descAttr(-0.5)],
});
const pneumatic = symbol({
  name: 'IEC_Y_PNEU',
  description: 'Pneumatic actuator with solenoid (IEC)',
  family: 'Y',
  entities: [...stubs(0.15), box(), L(0, -0.1, 0, -0.19), R(0, -0.26, 0.3, 0.14), L(-0.06, -0.33, -0.06, -0.19), L(-0.06, -0.26, 0.24, -0.26)],
  attributes: [tagAttr(0.3), descAttr(-0.5)],
});

// ------------------------------------------------------------------ power supplies & transformers (G, U, T)

const charger = symbol({
  name: 'IEC_G_CHG',
  description: 'Battery charger (IEC)',
  family: 'G',
  entities: [...converterBody(), acGlyph(-0.11, 0.03), ...batteryGlyph(0.11, -0.1)],
  attributes: [tagAttr(0.35), descAttr(-0.45)],
});
const psu = symbol({
  name: 'IEC_G_PSU',
  description: 'Power supply, AC/DC (IEC)',
  family: 'G',
  entities: [...converterBody(), acGlyph(-0.11, 0.03), ...dcGlyph(0.11, -0.11), T(0.3, 0.05, '+', 0.06), T(0.3, -0.13, '-', 0.06)],
  attributes: [tagAttr(0.35), descAttr(-0.45)],
});
const ups = symbol({
  name: 'IEC_G_UPS',
  description: 'Uninterruptible power supply (IEC)',
  family: 'G',
  entities: [...converterBody(), acGlyph(-0.11, 0.03), acGlyph(0.09, -0.15), ...batteryGlyph(0, 0.25, 0.08), T(0, -0.3, 'UPS', 0.06)],
  attributes: [tagAttr(0.4), descAttr(-0.48)],
});
const rectifier = symbol({
  name: 'IEC_U_RECT',
  description: 'Rectifier (IEC)',
  family: 'U',
  entities: [...converterBody(), acGlyph(-0.11, 0.03), P([[0.04, -0.15], [0.04, -0.07], [0.13, -0.11]], true), L(0.13, -0.15, 0.13, -0.07)],
  attributes: [tagAttr(0.35), descAttr(-0.45)],
});
const inverter = symbol({
  name: 'IEC_U_INV',
  description: 'Inverter, DC/AC (IEC)',
  family: 'U',
  entities: [...converterBody(), ...dcGlyph(-0.11, 0.07), acGlyph(0.09, -0.15)],
  attributes: [tagAttr(0.35), descAttr(-0.45)],
});
const winding = (y: number, up: boolean): Entity[] => [-0.15, -0.05, 0.05, 0.15].map((x) => A(x, y, 0.05, up ? 0 : 180, up ? 180 : 360));
const controlTransformer = symbol({
  name: 'IEC_T_CTRL',
  description: 'Control transformer (IEC)',
  family: 'T',
  entities: [L(-HALF, 0.13, -0.2, 0.13), ...winding(0.13, true), L(0.2, 0.13, HALF, 0.13), L(-0.2, 0.02, 0.2, 0.02), L(-0.2, -0.02, 0.2, -0.02), L(-HALF, -0.13, -0.2, -0.13), ...winding(-0.13, false), L(0.2, -0.13, HALF, -0.13)],
  attributes: [tagAttr(0.35), descAttr(-0.4)],
});
const autoTransformer = symbol({
  name: 'IEC_T_AUTO',
  description: 'Autotransformer (IEC)',
  family: 'T',
  entities: [...stubs(0.2), ...winding(0, true), L(0, 0, 0, 0.2), L(0, 0.2, HALF, 0.2), L(-0.2, -0.06, 0.2, -0.06)],
  attributes: [tagAttr(0.38), descAttr(-0.45)],
});
const transformerDy = symbol({
  name: 'IEC_T_DY',
  description: 'Transformer, 3 phase, Dy (IEC)',
  family: 'T',
  entities: [...stubs(0.22), C(-0.09, 0, 0.13), C(0.09, 0, 0.13), P([[-0.13, -0.04], [-0.05, -0.04], [-0.09, 0.04]], true), L(0.09, 0, 0.09, -0.05), L(0.09, 0, 0.05, 0.04), L(0.09, 0, 0.13, 0.04)],
  attributes: [tagAttr(0.32), descAttr(-0.45)],
});

// ------------------------------------------------------------------ signalling, lighting & heating (H, E)

const lamp = (name: string, colour: string, code: string): BlockDef =>
  symbol({ name, description: `Indicator lamp, ${colour} (IEC)`, family: 'H', entities: [...stubs(0.14), ...lampGlyph(0, 0, 0.14), T(0.27, -0.22, code, 0.06)], attributes: [tagAttr(0.32), descAttr(-0.48)] });
const lampRD = lamp('IEC_H_LAMP_RD', 'red', 'RD');
const lampGN = lamp('IEC_H_LAMP_GN', 'green', 'GN');
const lampYE = lamp('IEC_H_LAMP_YE', 'yellow', 'YE');
const lampBU = lamp('IEC_H_LAMP_BU', 'blue', 'BU');
const lampWH = lamp('IEC_H_LAMP_WH', 'white', 'WH');
const horn = symbol({ name: 'IEC_H_HORN', description: 'Horn (IEC)', family: 'H', entities: [L(-HALF, 0, -0.12, 0), P([[-0.12, -0.08], [-0.12, 0.08], [0.14, 0.18], [0.14, -0.18]], true), L(0.14, 0, HALF, 0)] });
const buzzer = symbol({ name: 'IEC_H_BUZZ', description: 'Buzzer (IEC)', family: 'H', entities: [...stubs(0.16), A(0, 0, 0.16, 0, 180), L(-0.16, 0, 0.16, 0), A(0.24, 0.08, 0.05, -50, 50), A(0.24, 0.08, 0.09, -50, 50)] });
const bell = symbol({ name: 'IEC_H_BELL', description: 'Bell (IEC)', family: 'H', entities: [...stubs(0.16), A(0, 0, 0.16, 0, 180), L(-0.16, 0, 0.16, 0), L(0, 0, 0, -0.06), C(0, -0.09, 0.03)] });
const beacon = symbol({
  name: 'IEC_H_BEACON',
  description: 'Beacon / stack light (IEC)',
  family: 'H',
  entities: [...stubs(0.13), ...lampGlyph(0, 0, 0.13), L(0, 0.15, 0, 0.25), L(-0.11, 0.11, -0.18, 0.18), L(0.11, 0.11, 0.18, 0.18)],
  attributes: [tagAttr(0.4), descAttr(-0.45)],
});
const luminaire = symbol({ name: 'IEC_E_LAMP', description: 'Lamp, lighting (IEC)', family: 'E', entities: [...stubs(0.14), C(0, 0, 0.14), A(0, -0.03, 0.08, 20, 160), L(-0.06, -0.05, -0.075, -0.003), L(0.06, -0.05, 0.075, -0.003)] });
const heater = symbol({ name: 'IEC_E_HEAT', description: 'Heating element (IEC)', family: 'E', entities: [...stubs(0.2), R(0, 0, 0.4, 0.16), L(-0.15, -0.08, -0.05, 0.08), L(-0.05, -0.08, 0.05, 0.08), L(0.05, -0.08, 0.15, 0.08)] });
const fan = symbol({ name: 'IEC_E_FAN', description: 'Fan (IEC)', family: 'E', entities: [...stubs(0.16), C(0, 0, 0.16), P([[-0.11, 0.035], [-0.03, 0], [-0.11, -0.035]], true), P([[0.11, 0.035], [0.03, 0], [0.11, -0.035]], true), C(0, 0, 0.025)] });

// ------------------------------------------------------------------ measuring (P, T, B)

const wattmeter = symbol({ name: 'IEC_P_W', description: 'Wattmeter (IEC)', family: 'P', entities: [...stubs(0.15), C(0, 0, 0.15), T(0, -0.05, 'W', 0.11)] });
const kwhMeter = symbol({ name: 'IEC_P_KWH', description: 'Energy meter, kWh (IEC)', family: 'P', entities: [...stubs(0.18), R(0, 0, 0.36, 0.24), T(0, -0.04, 'kWh', 0.08)] });
const freqMeter = symbol({ name: 'IEC_P_HZ', description: 'Frequency meter (IEC)', family: 'P', entities: [...stubs(0.15), C(0, 0, 0.15), T(0, -0.04, 'Hz', 0.09)] });
const hourCounter = symbol({ name: 'IEC_P_HR', description: 'Hour counter (IEC)', family: 'P', entities: [...stubs(0.15), R(0, 0, 0.3, 0.2), T(0, -0.04, 'h', 0.09)] });
const pfMeter = symbol({ name: 'IEC_P_COS', description: 'Power factor meter (IEC)', family: 'P', entities: [...stubs(0.15), C(0, 0, 0.15), T(0, -0.03, 'cos', 0.07)] });
const currentTransformer = symbol({
  name: 'IEC_T_CT',
  description: 'Current transformer (IEC)',
  family: 'T',
  entities: [L(-HALF, 0, HALF, 0), C(0, 0, 0.12), L(-0.05, -0.12, -0.05, -0.26), L(0.05, -0.12, 0.05, -0.26), T(-0.1, -0.33, 'S1', 0.05), T(0.1, -0.33, 'S2', 0.05)],
  attributes: [tagAttr(0.3), descAttr(-0.5)],
});
const voltageTransformer = symbol({
  name: 'IEC_T_VT',
  description: 'Voltage transformer (IEC)',
  family: 'T',
  entities: [L(-HALF, 0.09, -0.11, 0.09), C(0, 0.09, 0.11), L(0.11, 0.09, HALF, 0.09), L(-HALF, -0.09, -0.11, -0.09), C(0, -0.09, 0.11), L(0.11, -0.09, HALF, -0.09)],
  attributes: [tagAttr(0.35), descAttr(-0.4)],
});
const encoder = sensor('IEC_B_ENC', 'Rotary encoder (IEC)', [C(-0.1, 0.1, 0.05), L(-0.1, 0.1, -0.1, 0.16), P([[0.02, -0.13], [0.02, -0.07], [0.06, -0.07], [0.06, -0.13], [0.1, -0.13], [0.1, -0.07], [0.14, -0.07], [0.14, -0.13]])]);
const speedSensor = sensor('IEC_B_SPEED', 'Speed sensor (IEC)', [T(-0.09, 0.05, 'n', 0.08)], sensorOut(false));

// ------------------------------------------------------------------ terminals & connectors (X, W, PE)

const term2 = symbol({
  name: 'IEC_X_TERM2',
  description: 'Terminal, double level (IEC)',
  family: 'X',
  wdtype: 'TERM',
  entities: [...stubs(0.05), C(0, 0, 0.05), ...stubs(0.05, -0.25), C(0, -0.25, 0.05), R(0, -0.125, 0.16, 0.42)],
  attributes: [termAttr(0.12), { ...termAttr(-0.13), tag: 'TERM02' }],
});
const termFused = symbol({
  name: 'IEC_X_TERM_F',
  description: 'Terminal, fused (IEC)',
  family: 'X',
  wdtype: 'TERM',
  entities: [...stubs(0.1), R(0, 0, 0.2, 0.1), L(-0.1, 0, 0.1, 0), C(-0.1, 0, 0.02), C(0.1, 0, 0.02)],
  attributes: [termAttr(0.12)],
});
const termPE = symbol({
  name: 'IEC_X_TERM_PE',
  description: 'Terminal, PE (IEC)',
  family: 'X',
  wdtype: 'TERM',
  entities: [...stubs(0.05), C(0, 0, 0.05), L(0, -0.05, 0, -0.12), ...earthGlyph(0, -0.12, 0.16)],
  attributes: [termAttr(0.12)],
});
const plug = symbol({ name: 'IEC_X_PLUG', description: 'Plug (IEC)', family: 'X', entities: [L(-HALF, 0, -0.02, 0), L(-0.02, -0.1, -0.02, 0.1), A(-0.02, 0, 0.1, -90, 90), L(0.08, 0, HALF, 0)] });
const plugSocket = symbol({
  name: 'IEC_X_PLUG_SKT',
  description: 'Plug and socket (IEC)',
  family: 'X',
  entities: [L(-HALF, 0, -0.06, 0), L(-0.06, -0.09, -0.06, 0.09), A(-0.06, 0, 0.09, -90, 90), A(0, 0, 0.14, -90, 90), L(0.14, 0, HALF, 0)],
});
const peBar = symbol({
  name: 'IEC_W_PE_BAR',
  description: 'PE bar (IEC)',
  family: 'W',
  entities: [L(-HALF, 0, HALF, 0), R(0, 0, 0.6, 0.08), ...[-0.28, -0.16, -0.04, 0.08, 0.2].map((x) => L(x, -0.04, x + 0.08, 0.04)), T(0, 0.08, 'PE', 0.07), L(0, -0.04, 0, -0.12), ...earthGlyph(0, -0.12)],
  attributes: [tagAttr(0.3), descAttr(-0.45)],
});
const nBar = symbol({ name: 'IEC_W_N_BAR', description: 'N bar (IEC)', family: 'W', entities: [L(-HALF, 0, HALF, 0), R(0, 0, 0.6, 0.08), T(0, 0.08, 'N', 0.07)], attributes: [tagAttr(0.3), descAttr(-0.35)] });
const shield = symbol({
  name: 'IEC_W_SHIELD',
  description: 'Shielded conductor (IEC)',
  family: 'W',
  entities: [L(-HALF, 0, HALF, 0), A(0, 0, 0.14, 10, 80), A(0, 0, 0.14, 100, 170), A(0, 0, 0.14, 190, 260), A(0, 0, 0.14, 280, 350), L(0, -0.14, 0, -0.26), L(-0.05, -0.26, 0.05, -0.26)],
  attributes: [tagAttr(0.3), descAttr(-0.45)],
});
const frameEarth = symbol({
  name: 'IEC_PE_FRAME',
  description: 'Frame / chassis earth (IEC)',
  family: 'PE',
  entities: [L(0, 0, 0, -0.12), L(-0.12, -0.12, 0.12, -0.12), L(-0.12, -0.12, -0.18, -0.2), L(0, -0.12, -0.06, -0.2), L(0.12, -0.12, 0.06, -0.2)],
  attributes: [],
});
const functionalEarth = symbol({
  name: 'IEC_PE_FE',
  description: 'Functional earth (IEC)',
  family: 'PE',
  entities: [L(0, 0, 0, -0.12), ...earthGlyph(0, -0.12, 0.2), C(0, -0.17, 0.15)],
  attributes: [],
});

// ------------------------------------------------------------------ semiconductors & passive (V, R, C, L)

const diodeGlyph = (): Entity[] => [P([[-0.1, -0.1], [-0.1, 0.1], [0.1, 0]], true), L(0.1, -0.1, 0.1, 0.1)];
const zener = symbol({ name: 'IEC_V_ZENER', description: 'Zener diode (IEC)', family: 'V', entities: [...stubs(0.1), ...diodeGlyph(), L(0.1, 0.1, 0.15, 0.1), L(0.1, -0.1, 0.05, -0.1)] });
const led = symbol({
  name: 'IEC_V_LED',
  description: 'Light emitting diode (IEC)',
  family: 'V',
  entities: [...stubs(0.1), ...diodeGlyph(), L(-0.02, 0.12, 0.08, 0.22), L(0.08, 0.22, 0.02, 0.21), L(0.08, 0.22, 0.07, 0.16), L(0.07, 0.09, 0.17, 0.19), L(0.17, 0.19, 0.11, 0.18), L(0.17, 0.19, 0.16, 0.13)],
  attributes: [tagAttr(0.38), descAttr(-0.45)],
});
const transistorBody = (): Entity[] => [L(-HALF, 0, -0.05, 0), L(-0.05, -0.14, -0.05, 0.14), L(-0.05, 0.06, 0.12, 0.2), L(0.12, 0.2, HALF, 0.2), L(-0.05, -0.06, 0.12, -0.2), L(0.12, -0.2, HALF, -0.2), C(0.02, 0, 0.21)];
const transistorPins = (): AttributeDef[] => [pin('X4TERM01', HALF, 0.2, 'C'), pin('X1TERM02', -HALF, 0, 'B'), pin('X4TERM03', HALF, -0.2, 'E')];
const npn = symbol({
  name: 'IEC_V_NPN',
  description: 'Transistor, NPN (IEC)',
  family: 'V',
  entities: [...transistorBody(), L(0.12, -0.2, 0.0928, -0.1386), L(0.12, -0.2, 0.0546, -0.185)],
  attributes: [tagAttr(0.4), descAttr(-0.5), ...transistorPins()],
});
const pnp = symbol({
  name: 'IEC_V_PNP',
  description: 'Transistor, PNP (IEC)',
  family: 'V',
  entities: [...transistorBody(), L(-0.0191, -0.0854, 0.0463, -0.1004), L(-0.0191, -0.0854, 0.0081, -0.1468)],
  attributes: [tagAttr(0.4), descAttr(-0.5), ...transistorPins()],
});
const thyristor = symbol({
  name: 'IEC_V_SCR',
  description: 'Thyristor (IEC)',
  family: 'V',
  entities: [...stubs(0.1), ...diodeGlyph(), L(0.1, 0, 0.22, -0.18), L(0.22, -0.18, HALF, -0.18)],
  attributes: [tagAttr(0.3), descAttr(-0.45), pin('X1TERM01', -HALF, 0, 'A'), pin('X4TERM02', HALF, 0, 'K'), pin('X4TERM03', HALF, -0.18, 'G')],
});
const triac = symbol({
  name: 'IEC_V_TRIAC',
  description: 'Triac (IEC)',
  family: 'V',
  entities: [
    L(-HALF, 0, -0.08, 0),
    L(-0.08, -0.18, -0.08, 0.18),
    L(0.08, -0.18, 0.08, 0.18),
    L(0.08, 0, HALF, 0),
    P([[-0.08, 0.02], [-0.08, 0.18], [0.08, 0.1]], true),
    P([[0.08, -0.02], [0.08, -0.18], [-0.08, -0.1]], true),
    L(0.08, -0.12, 0.2, -0.24),
    L(0.2, -0.24, HALF, -0.24),
  ],
  attributes: [tagAttr(0.35), descAttr(-0.5), pin('X1TERM01', -HALF, 0, 'MT1'), pin('X4TERM02', HALF, 0, 'MT2'), pin('X4TERM03', HALF, -0.24, 'G')],
});
const bridge = symbol({
  name: 'IEC_V_BRIDGE',
  description: 'Bridge rectifier (IEC)',
  family: 'V',
  entities: [...stubs(0.2), P([[-0.2, 0], [0, 0.2], [0.2, 0], [0, -0.2]], true), P([[-0.05, -0.05], [-0.05, 0.05], [0.05, 0]], true), L(0.05, -0.05, 0.05, 0.05), L(0, 0.2, 0, 0.3), T(0.08, 0.26, '+', 0.06), L(0, -0.2, 0, -0.3), T(0.08, -0.34, '-', 0.06)],
  attributes: [tagAttr(0.42), descAttr(-0.52)],
});
const potentiometer = symbol({
  name: 'IEC_R_POT',
  description: 'Potentiometer (IEC)',
  family: 'R',
  entities: [...stubs(0.2), R(0, 0, 0.4, 0.12), L(0, 0.3, 0, 0.1), L(0, 0.06, -0.03, 0.12), L(0, 0.06, 0.03, 0.12), L(0, 0.1, 0, 0.06), L(0, 0.3, HALF, 0.3)],
  attributes: [tagAttr(0.45), descAttr(-0.45)],
});
const thermistorNTC = symbol({ name: 'IEC_R_NTC', description: 'Thermistor, NTC (IEC)', family: 'R', entities: [...stubs(0.2), R(0, 0, 0.4, 0.12), L(-0.24, -0.14, -0.14, -0.14), L(-0.14, -0.14, 0.2, 0.15), T(0.16, -0.22, '-t', 0.06)] });
const thermistorPTC = symbol({ name: 'IEC_R_PTC', description: 'Thermistor, PTC (IEC)', family: 'R', entities: [...stubs(0.2), R(0, 0, 0.4, 0.12), L(-0.24, -0.14, -0.14, -0.14), L(-0.14, -0.14, 0.2, 0.15), T(0.16, -0.22, '+t', 0.06)] });
const capacitorPol = symbol({
  name: 'IEC_C_POL',
  description: 'Capacitor, polarised (IEC)',
  family: 'C',
  entities: [L(-HALF, 0, -0.03, 0), L(-0.03, -0.12, -0.03, 0.12), R(0.05, 0, 0.04, 0.24), L(0.07, 0, HALF, 0), T(-0.12, 0.12, '+', 0.07)],
});
const inductorCore = symbol({ name: 'IEC_L_CORE', description: 'Inductor with core (IEC)', family: 'L', entities: [...stubs(0.2), ...winding(0, true), L(-0.2, 0.09, 0.2, 0.09)] });

// ------------------------------------------------------------------ PLC, HMI & network (A)

const plcDI = symbol({ name: 'IEC_A_PLC_DI', description: 'PLC digital input (IEC)', family: 'A', wdtype: 'PLC', entities: [L(-HALF, 0, -0.16, 0), ioBox(), T(0, -0.04, 'DI', 0.09)], attributes: [addrAttr('I0.0'), descAttr(-0.32)] });
const plcDO = symbol({ name: 'IEC_A_PLC_DO', description: 'PLC digital output (IEC)', family: 'A', wdtype: 'PLC', entities: [ioBox(), L(0.16, 0, HALF, 0), T(0, -0.04, 'DO', 0.09)], attributes: [addrAttr('Q0.0'), descAttr(-0.32)] });
const plcAI = symbol({ name: 'IEC_A_PLC_AI', description: 'PLC analog input (IEC)', family: 'A', wdtype: 'PLC', entities: [L(-HALF, 0, -0.16, 0), ioBox(), analogGlyph(0.02), T(0, -0.1, 'AI', 0.05)], attributes: [addrAttr('IW0'), descAttr(-0.32)] });
const plcAO = symbol({ name: 'IEC_A_PLC_AO', description: 'PLC analog output (IEC)', family: 'A', wdtype: 'PLC', entities: [ioBox(), L(0.16, 0, HALF, 0), analogGlyph(0.02), T(0, -0.1, 'AO', 0.05)], attributes: [addrAttr('QW0'), descAttr(-0.32)] });
const plcDORelay = symbol({
  name: 'IEC_A_PLC_DO_RLY',
  description: 'PLC relay output (IEC)',
  family: 'A',
  wdtype: 'PLC',
  entities: [ioBox(), L(0.16, 0, HALF, 0), L(-0.11, -0.04, -0.04, -0.04), L(-0.04, -0.04, 0.06, 0.04), L(0.06, -0.04, 0.11, -0.04), T(0, 0.05, 'DO', 0.05)],
  attributes: [addrAttr('Q0.0'), descAttr(-0.32)],
});
const plcCPU = symbol({ name: 'IEC_A_PLC_CPU', description: 'PLC central unit (IEC)', family: 'A', wdtype: 'PLC', entities: [...stubs(0.2), R(0, 0, 0.4, 0.3), T(0, -0.03, 'CPU', 0.08)], attributes: [tagAttr(0.3), descAttr(-0.45)] });
const hmi = symbol({
  name: 'IEC_A_HMI',
  description: 'HMI panel (IEC)',
  family: 'A',
  entities: [L(-HALF, 0, -0.28, 0), R(0.04, 0, 0.64, 0.44), R(0.04, 0.03, 0.5, 0.28), T(0.04, -0.01, 'HMI', 0.08), C(-0.14, -0.16, 0.02), C(-0.04, -0.16, 0.02), C(0.06, -0.16, 0.02)],
  attributes: [tagAttr(0.4), descAttr(-0.45)],
});
const ethernetSwitch = symbol({
  name: 'IEC_A_ETH',
  description: 'Ethernet switch (IEC)',
  family: 'A',
  entities: [...stubs(0.3), R(0, 0, 0.6, 0.3), T(0, 0.02, 'ETH', 0.08), ...[-0.2, -0.1, 0, 0.1, 0.2].map((x) => R(x, -0.08, 0.07, 0.06))],
  attributes: [tagAttr(0.35), descAttr(-0.45)],
});

// ------------------------------------------------------------------ exports

/** Tag-prefix rules for the families this module introduces (register with registerTagPrefixes). */
export const IEC_EXTENDED_TAG_PREFIXES: Array<[RegExp, string]> = [
  [/^IEC_H_/, 'H'],
  [/^IEC_U_/, 'U'],
  [/^IEC_W_/, 'W'],
  [/^IEC_A_/, 'A'],
  [/^IEC_B_/, 'B'],
  [/^IEC_KA_/, 'KA'],
  [/^IEC_K_/, 'K'],
];

export const IEC_EXTENDED_CATEGORIES: SymbolCategory[] = [
  category('IEC: Buttons & Switches II', [pbIlNO, pbIlNC, pbNoNc, estopTwist, keySwitch, sel2Rows, sel3Rows, footNC, pullCord, limRollNO, limRollNC]),
  category('IEC: Sensors', [proxIndNO, proxIndNC, proxCapNO, proxCapNC, photo, ultra, level, pressure, pt100, thermocouple, flowSensor]),
  category('IEC: Relays & Timers II', [kaCoil, kaNO, kaNC, latchRelay, counter, safetyRelay, safetyNO, safetyNC, starDelta, starContactNC, deltaContactNO, cyclicTimer]),
  category('IEC: Power Switching', [mcb1, mcb2, mcb3, mcb4, mpcb3, rcd, rcbo, fsd3, lbs3, changeover, isolator3, kmMain3]),
  category('IEC: Protection II', [overload3, surge, varistor, fuse3, fuseSwitch, ptcRelay, overcurrent, earthFault]),
  category('IEC: Motors, Drives & Actuators', [motor3Uvw, motor1U, motorDC, servo, brake, generator, vfd, softStarter, solSpring, sol2, pneumatic]),
  category('IEC: Power Supplies & Transformers', [charger, psu, ups, rectifier, inverter, controlTransformer, autoTransformer, transformerDy]),
  category('IEC: Signalling, Lighting & Heating', [lampRD, lampGN, lampYE, lampBU, lampWH, horn, buzzer, bell, beacon, luminaire, heater, fan]),
  category('IEC: Measuring', [wattmeter, kwhMeter, freqMeter, hourCounter, pfMeter, currentTransformer, voltageTransformer, encoder, speedSensor]),
  category('IEC: Terminals & Connectors', [term2, termFused, termPE, plug, plugSocket, peBar, nBar, shield, frameEarth, functionalEarth]),
  category('IEC: Semiconductors & Passive', [zener, led, npn, pnp, thyristor, triac, bridge, potentiometer, thermistorNTC, thermistorPTC, capacitorPol, inductorCore]),
  category('IEC: PLC, HMI & Network', [plcDI, plcDO, plcAI, plcAO, plcDORelay, plcCPU, hmi, ethernetSwitch]),
];

export const IEC_EXTENDED_SYMBOLS: BlockDef[] = IEC_EXTENDED_CATEGORIES.flatMap((c) => c.symbols);
