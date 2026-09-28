/**
 * Extended JIC/NFPA-style control symbols: the second tier of a ladder
 * diagram toolbox (illuminated and maintained buttons, per-position
 * selector contacts, sensors, safety devices, latching / alternating /
 * counting relays, stack lights, actuators, instrument transformers and
 * meters, terminals and grounds, solid-state parts, power supplies, HMI
 * and network gear).
 *
 * Conventions match symbols.ts: units are inches, the block base point is
 * the wire-connection centre and inline symbols are 0.75 wide with stubs
 * ending at x = +-HALF on y = 0. Pilot-device contacts keep the existing
 * style (terminal dots, hinged blade, actuator glyph above for NO and below
 * for NC). Every symbol is built with symbol() so it carries the ACADE
 * attribute set. All geometry is original artwork.
 */
import type { BlockDef, Entity, AttributeDef } from '../core/entities';
import { primitives, symbol, category, tagAttr, descAttr, termAttr, HALF, GAP } from './symbol-kit';
import type { SymbolCategory } from './symbol-kit';

const { L, C, A, P, T, R, stubs } = primitives('jc');

// Shared building blocks -------------------------------------------------

/** Relay-style contact bars. */
const bars = (): Entity[] => [L(-GAP, -0.125, -GAP, 0.125), L(GAP, -0.125, GAP, 0.125)];
/** Diagonal slash that turns contact bars into a normally-closed contact. */
const ncSlash = (): Entity => L(-GAP - 0.05, -0.16, GAP + 0.05, 0.16);
/** Relay-style contact with a small identifying label above (like HKM1_NO). */
const labelledContact = (nc: boolean, label: string, h = 0.06): Entity[] => [
  ...stubs(GAP),
  ...bars(),
  ...(nc ? [ncSlash()] : []),
  T(0, nc ? 0.19 : 0.17, label, h),
];
/** Round coil with a label inside (like HTD1). */
const coilBody = (label: string, h = 0.07): Entity[] => [...stubs(0.125), C(0, 0, 0.125), T(0, -0.04, label, h)];

/** Pilot-device terminal dots. */
const dots = (): Entity[] => [C(-GAP, 0, 0.03), C(GAP, 0, 0.03)];
/** Open blade: hinged at the left terminal, rising above the right one. */
const bladeNO = (): Entity => L(-GAP, 0, GAP + 0.05, 0.14);
/** Closed blade: hinged at the left terminal, passing under the right one. */
const bladeNC = (): Entity => L(-GAP, 0, GAP + 0.08, -0.08);
/** Height of the blade at a given x. */
const bladeY = (nc: boolean, x: number): number => (nc ? -((x + GAP) * 0.08) / (2 * GAP + 0.08) : ((x + GAP) * 0.14) / (2 * GAP + 0.05));

/**
 * A pilot-device contact whose actuator glyph sits above the blade (NO) or
 * below it (NC). `glyph(yc, s)` draws the actuator centred on (0, yc); `s`
 * is +1 above / -1 below so a glyph can mirror itself. The stem joins the
 * blade to the glyph at x = stemX.
 */
function pilot(nc: boolean, glyph: (yc: number, s: number) => Entity[], stemX = 0, glyphHalf = 0.06): Entity[] {
  const s = nc ? -1 : 1;
  const yc = 0.25 * s;
  return [...stubs(GAP), ...dots(), nc ? bladeNC() : bladeNO(), L(stemX, bladeY(nc, stemX), stemX, yc - glyphHalf * s), ...glyph(yc, s)];
}

/** Push-button operator: a bar across the blade tips and a stem up to the cap. */
const pbOperator = (nc: boolean, capY: number): Entity[] => {
  const barY = nc ? -0.06 : 0.09;
  return [...stubs(GAP), ...dots(), L(-GAP - 0.06, barY, GAP + 0.06, barY), L(0, barY, 0, capY)];
};
const flatCap = (y: number, half = 0.125): Entity => L(-half, y, half, y);
const mushroomCap = (y: number, r = 0.11): Entity[] => [A(0, y, r, 0, 180), L(-r, y, r, y)];
/** Small arrow head pointing along (dx, dy) with its tip at (x, y). */
const arrowHead = (x: number, y: number, dx: number, dy: number, size = 0.04): Entity => {
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return P([[x - ux * size - uy * size * 0.6, y - uy * size + ux * size * 0.6], [x, y], [x - ux * size + uy * size * 0.6, y - uy * size - ux * size * 0.6]]);
};
/** Lamp glyph: circle with a cross. */
const lamp = (cx: number, cy: number, r: number): Entity[] => {
  const k = r * 0.7;
  return [C(cx, cy, r), L(cx - k, cy - k, cx + k, cy + k), L(cx - k, cy + k, cx + k, cy - k)];
};
/** Sensor housing used by the electronic sensors. */
const housing = (cx: number, cy: number, w = 0.12, h = 0.12): Entity => R(cx, cy, w, h);

// 1. Illuminated / maintained buttons, key switches, joystick, thumbwheel -

const illumPB = (name: string, desc: string, nc: boolean) =>
  symbol({
    name,
    description: desc,
    family: 'PB',
    entities: [...pbOperator(nc, 0.14), flatCap(0.14, 0.1), L(0, 0.14, 0, 0.19), ...lamp(0, 0.26, 0.07)],
    attributes: [tagAttr(0.42), descAttr(-0.45)],
  });
const pbIllumNO = illumPB('HPB14_NO', 'Illuminated push button, normally open', false);
const pbIllumNC = illumPB('HPB15_NC', 'Illuminated push button, normally closed', true);

const maintainedPB = (name: string, desc: string, nc: boolean) =>
  symbol({
    name,
    description: desc,
    family: 'PB',
    entities: [...pbOperator(nc, 0.2), flatCap(0.2), L(0.2, 0.12, 0.2, 0.28), arrowHead(0.2, 0.28, 0, 1, 0.03), arrowHead(0.2, 0.12, 0, -1, 0.03)],
  });
const pbMaintNO = maintainedPB('HPB16_NO', 'Maintained (push-pull) push button, normally open', false);
const pbMaintNC = maintainedPB('HPB17_NC', 'Maintained (push-pull) push button, normally closed', true);

const pbMushroomNO = symbol({
  name: 'HPB19_NO',
  description: 'Mushroom head push button, normally open',
  family: 'PB',
  entities: [...pbOperator(false, 0.16), ...mushroomCap(0.16)],
});

/** Key operator: key bow (ring) on the stem with two teeth. */
const keyGlyph = (yc: number, s: number): Entity[] => [C(0, yc, 0.05), L(0, yc - 0.05 * s, 0.04, yc - 0.05 * s), L(0, yc - 0.09 * s, 0.03, yc - 0.09 * s)];
const keyNO = symbol({ name: 'HKS11_NO', description: 'Key switch, normally open', family: 'KS', entities: pilot(false, keyGlyph, 0, 0.05) });
const keyNC = symbol({ name: 'HKS12_NC', description: 'Key switch, normally closed', family: 'KS', entities: pilot(true, keyGlyph, 0, 0.05) });

/** Joystick operator: ball on the stem with a left/right travel arrow. */
const joyGlyph = (yc: number, s: number): Entity[] => [
  C(0, yc - 0.02 * s, 0.035),
  L(-0.1, yc + 0.05 * s, 0.1, yc + 0.05 * s),
  arrowHead(-0.1, yc + 0.05 * s, -1, 0, 0.03),
  arrowHead(0.1, yc + 0.05 * s, 1, 0, 0.03),
];
const joyNO = symbol({ name: 'HJS11_NO', description: 'Joystick contact, normally open', family: 'JS', entities: pilot(false, joyGlyph, 0, 0.055) });
const joyNC = symbol({ name: 'HJS12_NC', description: 'Joystick contact, normally closed', family: 'JS', entities: pilot(true, joyGlyph, 0, 0.055) });

const thumbwheel = symbol({
  name: 'HTW1',
  description: 'Thumbwheel switch (BCD digit)',
  family: 'TW',
  entities: [
    ...stubs(0.2),
    R(0, 0, 0.4, 0.24),
    R(-0.03, 0, 0.14, 0.14),
    T(-0.03, -0.035, '7', 0.08),
    P([[0.1, 0.03], [0.16, 0.03], [0.13, 0.08]], true),
    P([[0.1, -0.03], [0.16, -0.03], [0.13, -0.08]], true),
  ],
});

// 2. Selector switches with per-position contacts ------------------------

/**
 * Selector contact: pilot blade plus a small position dial above. The dial
 * is a semicircle with one tick per position and a pointer to the position
 * in which this contact is closed.
 */
function selectorDial(positions: number, active: number, labels: string[], extra: Entity[] = []): Entity[] {
  const cx = 0;
  const cy = 0.17;
  const r = 0.07;
  const angles = positions === 2 ? [150, 30] : positions === 3 ? [180, 90, 0] : [180, 120, 60, 0];
  const out: Entity[] = [...stubs(GAP), ...dots(), bladeNO(), A(cx, cy, r, 0, 180), L(cx - r, cy, cx + r, cy)];
  angles.forEach((deg, i) => {
    const a = (deg * Math.PI) / 180;
    const tx = cx + Math.cos(a) * r;
    const ty = cy + Math.sin(a) * r;
    out.push(L(tx, ty, cx + Math.cos(a) * (r + 0.03), cy + Math.sin(a) * (r + 0.03)));
    if (i === active) out.push(L(cx, cy, tx, ty), C(tx, ty, 0.015, true));
    const label = labels[i];
    if (label) out.push(T(cx + Math.cos(a) * (r + 0.1), cy + Math.sin(a) * (r + 0.1) - 0.025, label, 0.055));
  });
  return [...out, ...extra];
}
const selAttrs = [tagAttr(0.38), descAttr(-0.45)];
const sel2p1 = symbol({ name: 'HSS21', description: 'Selector switch, 2 position, closed in position 1', family: 'SS', entities: selectorDial(2, 0, ['1', '2']), attributes: selAttrs });
const sel2p2 = symbol({ name: 'HSS22', description: 'Selector switch, 2 position, closed in position 2', family: 'SS', entities: selectorDial(2, 1, ['1', '2']), attributes: selAttrs });
const sel3hand = symbol({ name: 'HSS31', description: 'Selector switch, 3 position, closed in HAND', family: 'SS', entities: selectorDial(3, 0, ['H', 'O', 'A']), attributes: selAttrs });
const sel3off = symbol({ name: 'HSS32', description: 'Selector switch, 3 position, closed in OFF', family: 'SS', entities: selectorDial(3, 1, ['H', 'O', 'A']), attributes: selAttrs });
const sel3auto = symbol({ name: 'HSS33', description: 'Selector switch, 3 position, closed in AUTO', family: 'SS', entities: selectorDial(3, 2, ['H', 'O', 'A']), attributes: selAttrs });
const sel3spring = symbol({
  name: 'HSS41',
  description: 'Selector switch, 3 position, spring return to centre',
  family: 'SS',
  entities: selectorDial(3, 1, ['', '', ''], [A(0, 0.17, 0.115, 100, 170), arrowHead(0.02, 0.283, 1, 0, 0.03), A(0, 0.17, 0.115, 10, 80), arrowHead(-0.02, 0.283, -1, 0, 0.03)]),
  attributes: selAttrs,
});
const rotary4 = symbol({ name: 'HSS51', description: 'Rotary switch, 4 position, closed in position 1', family: 'SS', entities: selectorDial(4, 0, ['1', '2', '3', '4']), attributes: selAttrs });
const keySelector = symbol({
  name: 'HKS21',
  description: 'Key selector switch, 2 position',
  family: 'KS',
  entities: selectorDial(2, 0, ['1', '2'], [L(0, 0.17, 0, 0.1), C(0, 0.13, 0.025), L(0.025, 0.13, 0.055, 0.13)]),
  attributes: selAttrs,
});

// 3. Photo eyes / proximity / ultrasonic / encoder ------------------------

/** Through-beam: emitter box, beam arrow, receiver box (the receiver drives the contact). */
const throughBeam = (yc: number): Entity[] => [housing(-0.17, yc, 0.08, 0.1), housing(0.17, yc, 0.08, 0.1), L(-0.13, yc, 0.13, yc), arrowHead(0.13, yc, 1, 0)];
/** Retroreflective: sensor box, out-and-back beams, striped reflector. */
const retroReflective = (yc: number): Entity[] => [
  housing(0.17, yc, 0.08, 0.1),
  L(0.13, yc + 0.025, -0.13, yc + 0.025),
  arrowHead(-0.13, yc + 0.025, -1, 0, 0.03),
  L(-0.13, yc - 0.025, 0.13, yc - 0.025),
  arrowHead(0.13, yc - 0.025, 1, 0, 0.03),
  L(-0.16, yc - 0.06, -0.16, yc + 0.06),
  L(-0.19, yc - 0.06, -0.19, yc + 0.06),
  L(-0.19, yc - 0.06, -0.16, yc - 0.02),
  L(-0.19, yc + 0.02, -0.16, yc + 0.06),
];
const peThruNO = symbol({ name: 'HPE11_NO', description: 'Photo eye, through-beam, normally open', family: 'PE', entities: pilot(false, throughBeam, 0.17, 0.05) });
const peThruNC = symbol({ name: 'HPE12_NC', description: 'Photo eye, through-beam, normally closed', family: 'PE', entities: pilot(true, throughBeam, 0.17, 0.05) });
const peRetroNO = symbol({ name: 'HPE13_NO', description: 'Photo eye, retroreflective, normally open', family: 'PE', entities: pilot(false, retroReflective, 0.17, 0.05) });
const peRetroNC = symbol({ name: 'HPE14_NC', description: 'Photo eye, retroreflective, normally closed', family: 'PE', entities: pilot(true, retroReflective, 0.17, 0.05) });

/** Capacitive prox: housing with two sensing plates on the target side. */
const capProx = (yc: number): Entity[] => [housing(0, yc), L(-0.1, yc - 0.045, -0.1, yc + 0.045), L(-0.14, yc - 0.045, -0.14, yc + 0.045)];
const capNO = symbol({ name: 'HPX13_NO', description: 'Capacitive proximity switch, normally open', family: 'PRS', entities: pilot(false, capProx) });
const capNC = symbol({ name: 'HPX14_NC', description: 'Capacitive proximity switch, normally closed', family: 'PRS', entities: pilot(true, capProx) });

/** Ultrasonic: housing with three sound-wave arcs. */
const ultrasonic = (yc: number): Entity[] => [housing(0, yc), A(-0.06, yc, 0.05, 125, 235), A(-0.06, yc, 0.09, 135, 225), A(-0.06, yc, 0.13, 145, 215)];
const usNO = symbol({ name: 'HUS11_NO', description: 'Ultrasonic sensor, normally open', family: 'US', entities: pilot(false, ultrasonic) });
const usNC = symbol({ name: 'HUS12_NC', description: 'Ultrasonic sensor, normally closed', family: 'US', entities: pilot(true, ultrasonic) });

const encoder = symbol({
  name: 'HENC1',
  description: 'Encoder, incremental (shaft)',
  family: 'ENC',
  entities: [
    ...stubs(0.18),
    C(0, 0, 0.18),
    C(0, 0.08, 0.03),
    P([[-0.11, -0.1], [-0.11, -0.03], [-0.07, -0.03], [-0.07, -0.1], [-0.03, -0.1], [-0.03, -0.03], [0.01, -0.03], [0.01, -0.1], [0.05, -0.1], [0.05, -0.03], [0.09, -0.03], [0.09, -0.1]]),
  ],
  attributes: [tagAttr(0.33), descAttr(-0.48)],
});

// 4. Speed / vibration / level / position switches ------------------------

/** Speed: a rotor with a curved arrow around it. */
const speedGlyph = (yc: number): Entity[] => [C(0, yc, 0.045), A(0, yc, 0.09, 30, 300), arrowHead(0.078, yc + 0.045, 0.5, -1, 0.035)];
const speedNO = symbol({ name: 'HSPS11_NO', description: 'Speed switch, normally open', family: 'SPS', entities: pilot(false, speedGlyph, 0, 0.09) });
const speedNC = symbol({ name: 'HSPS12_NC', description: 'Speed switch, normally closed', family: 'SPS', entities: pilot(true, speedGlyph, 0, 0.09) });

/** Vibration: housing with a shaking waveform. */
const vibGlyph = (yc: number): Entity[] => [housing(0, yc, 0.22, 0.12), P([[-0.09, yc], [-0.06, yc + 0.04], [-0.02, yc - 0.04], [0.02, yc + 0.04], [0.06, yc - 0.04], [0.09, yc]])];
const vibNO = symbol({ name: 'HVS11_NO', description: 'Vibration switch, normally open', family: 'VS', entities: pilot(false, vibGlyph) });
const vibNC = symbol({ name: 'HVS12_NC', description: 'Vibration switch, normally closed', family: 'VS', entities: pilot(true, vibGlyph) });

/** Level: open vessel (open side away from the stem) with a rippled liquid line. */
const levelGlyph = (yc: number, s: number): Entity[] => [
  P([[-0.1, yc + 0.07 * s], [-0.1, yc - 0.07 * s], [0.1, yc - 0.07 * s], [0.1, yc + 0.07 * s]]),
  P([[-0.1, yc], [-0.05, yc + 0.02], [0, yc], [0.05, yc + 0.02], [0.1, yc]]),
];
const levelNO = symbol({ name: 'HLV11_NO', description: 'Level switch, normally open', family: 'LVL', entities: pilot(false, levelGlyph, 0, 0.07) });
const levelNC = symbol({ name: 'HLV12_NC', description: 'Level switch, normally closed', family: 'LVL', entities: pilot(true, levelGlyph, 0, 0.07) });

/** Position / zone: a travel line with end stops and a position marker. */
const zoneGlyph = (yc: number): Entity[] => [L(-0.15, yc, 0.15, yc), L(-0.15, yc - 0.04, -0.15, yc + 0.04), L(0.15, yc - 0.04, 0.15, yc + 0.04), C(0.05, yc, 0.025, true)];
const zoneNO = symbol({ name: 'HZS11_NO', description: 'Position / zone switch, normally open', family: 'ZS', entities: pilot(false, zoneGlyph, 0, 0) });
const zoneNC = symbol({ name: 'HZS12_NC', description: 'Position / zone switch, normally closed', family: 'ZS', entities: pilot(true, zoneGlyph, 0, 0) });

// 5. Safety devices ------------------------------------------------------

const estopTwist = symbol({
  name: 'HPB21_NC',
  description: 'Emergency stop, maintained mushroom head, twist release, normally closed',
  family: 'PB',
  entities: [...pbOperator(true, 0.14), ...mushroomCap(0.14), A(0, 0.14, 0.15, 0, 60), arrowHead(0.075, 0.27, -0.6, 0.35, 0.035)],
  attributes: [tagAttr(0.34), descAttr(-0.45)],
});
const estopNO = symbol({
  name: 'HPB22_NO',
  description: 'Emergency stop, monitoring contact, normally open',
  family: 'PB',
  entities: [...pbOperator(false, 0.16), ...mushroomCap(0.16)],
});

/** Door / guard interlock: door frame with a swung leaf. */
const doorGlyph = (yc: number, s: number): Entity[] => [
  P([[-0.12, yc - 0.07 * s], [-0.12, yc + 0.07 * s], [0.12, yc + 0.07 * s], [0.12, yc - 0.07 * s]]),
  L(-0.12, yc - 0.07 * s, 0.05, yc + 0.01 * s),
  C(-0.12, yc + 0.03 * s, 0.012, true),
];
const doorNC = symbol({ name: 'HGS11_NC', description: 'Door interlock (guard) switch, normally closed', family: 'GS', entities: pilot(true, doorGlyph, 0, 0.07) });
const doorNO = symbol({ name: 'HGS12_NO', description: 'Door interlock (guard) switch, normally open', family: 'GS', entities: pilot(false, doorGlyph, 0, 0.07) });

/** Safety mat: flat mat with a foot-force arrow. */
const matGlyph = (yc: number, s: number): Entity[] => [R(0, yc, 0.28, 0.05), L(0, yc + 0.13 * s, 0, yc + 0.04 * s), arrowHead(0, yc + 0.04 * s, 0, -s, 0.035)];
const safetyMat = symbol({ name: 'HSM11_NC', description: 'Safety mat, normally closed', family: 'SM', entities: pilot(true, matGlyph, 0, 0.025) });

const lightCurtain = symbol({
  name: 'HLC11',
  description: 'Light curtain (sender / receiver pair)',
  family: 'LC',
  entities: [...stubs(0.2), R(-0.17, 0, 0.06, 0.5), R(0.17, 0, 0.06, 0.5), ...[0.16, 0.055, -0.055, -0.16].map((y) => L(-0.14, y, 0.14, y)), ...[0.16, 0.055, -0.055, -0.16].map((y) => arrowHead(0.14, y, 1, 0, 0.025))],
  attributes: [tagAttr(0.34), descAttr(-0.45)],
});

const safetyCoil = symbol({ name: 'HSR1', description: 'Safety relay', family: 'SR', wdtype: 'COIL', entities: coilBody('SR') });
const safetyNO = symbol({ name: 'HSR1_NO', description: 'Safety relay contact, normally open', family: 'SR', wdtype: 'CONTACT', entities: labelledContact(false, 'SR') });
const safetyNC = symbol({ name: 'HSR1_NC', description: 'Safety relay contact, normally closed', family: 'SR', wdtype: 'CONTACT', entities: labelledContact(true, 'SR') });

// 6. Latching / alternating relays, timers, counters ----------------------

const latchCoil = symbol({ name: 'HLR1', description: 'Latching relay, latch coil', family: 'LR', wdtype: 'COIL', entities: coilBody('L', 0.09) });
const unlatchCoil = symbol({ name: 'HLR1U', description: 'Latching relay, unlatch coil', family: 'LR', wdtype: 'COIL', entities: coilBody('U', 0.09) });
const latchNO = symbol({ name: 'HLR1_NO', description: 'Latching relay contact, normally open', family: 'LR', wdtype: 'CONTACT', entities: labelledContact(false, 'LR') });
const latchNC = symbol({ name: 'HLR1_NC', description: 'Latching relay contact, normally closed', family: 'LR', wdtype: 'CONTACT', entities: labelledContact(true, 'LR') });
const altCoil = symbol({ name: 'HAR1', description: 'Alternating relay', family: 'ALR', wdtype: 'COIL', entities: coilBody('ALT', 0.055) });
const altNO = symbol({ name: 'HAR1_NO', description: 'Alternating relay contact, normally open', family: 'ALR', wdtype: 'CONTACT', entities: labelledContact(false, 'ALT', 0.055) });
const timerRepeat = symbol({ name: 'HTD3', description: 'Timer relay coil (repeat cycle)', family: 'TD', wdtype: 'COIL', entities: coilBody('RC') });
const timerOneShot = symbol({ name: 'HTD4', description: 'Timer relay coil (one-shot)', family: 'TD', wdtype: 'COIL', entities: coilBody('OS') });
const counterCoil = symbol({ name: 'HCN1', description: 'Counter', family: 'CTR', wdtype: 'COIL', entities: coilBody('CTR', 0.055) });
const counterNO = symbol({ name: 'HCN1_NO', description: 'Counter contact, normally open', family: 'CTR', wdtype: 'CONTACT', entities: labelledContact(false, 'CTR', 0.055) });
const counterNC = symbol({ name: 'HCN1_NC', description: 'Counter contact, normally closed', family: 'CTR', wdtype: 'CONTACT', entities: labelledContact(true, 'CTR', 0.055) });

// 7. Stack lights / beacons / sirens -------------------------------------

/** One tier of a stack light: a box with the colour letter. */
const tier = (y: number, letter: string): Entity[] => [R(0, y, 0.2, 0.16), T(0, y - 0.03, letter, 0.06)];
const stack3 = symbol({
  name: 'HXT1',
  description: 'Stack light, 3 tier (green / amber / red)',
  family: 'XT',
  entities: [L(-HALF, 0, -0.1, 0), ...tier(0.2, 'G'), ...tier(0, 'A'), ...tier(-0.2, 'R'), ...[0.2, 0, -0.2].map((y) => L(0.1, y, HALF, y))],
  attributes: [tagAttr(0.42), descAttr(-0.6)],
});
const stack2 = symbol({
  name: 'HXT2',
  description: 'Stack light, 2 tier (green / red)',
  family: 'XT',
  entities: [L(-HALF, 0, -0.1, 0), ...tier(0.1, 'G'), ...tier(-0.1, 'R'), L(0.1, 0.1, HALF, 0.1), L(0.1, -0.1, HALF, -0.1)],
  attributes: [tagAttr(0.34), descAttr(-0.45)],
});
const stackElement = (name: string, desc: string, letter: string) =>
  symbol({ name, description: desc, family: 'XT', entities: [...stubs(0.12), R(0, 0, 0.24, 0.18), T(0, -0.035, letter, 0.08)] });
const stackG = stackElement('HXT1G', 'Stack light element, green', 'G');
const stackA = stackElement('HXT1A', 'Stack light element, amber', 'A');
const stackR = stackElement('HXT1R', 'Stack light element, red', 'R');
const beacon = symbol({
  name: 'HBK1',
  description: 'Beacon (flashing / rotating)',
  family: 'BKN',
  entities: [...stubs(0.14), A(0, -0.06, 0.14, 0, 180), L(-0.14, -0.06, 0.14, -0.06), R(0, -0.1, 0.2, 0.08), L(0, 0.1, 0, 0.18), L(0.1, 0.06, 0.16, 0.14), L(-0.1, 0.06, -0.16, 0.14)],
});
const siren = symbol({
  name: 'HSI1',
  description: 'Siren',
  family: 'SIR',
  entities: [...stubs(0.14), P([[-0.14, -0.06], [-0.14, 0.06], [0.02, 0.14], [0.02, -0.14]], true), A(0.02, 0, 0.08, 300, 360), A(0.02, 0, 0.08, 0, 60), A(0.02, 0, 0.13, 310, 360), A(0.02, 0, 0.13, 0, 50)],
});
const strobe = symbol({
  name: 'HLT3',
  description: 'Strobe light',
  family: 'LT',
  entities: [...stubs(0.125), C(0, 0, 0.125), P([[0.03, 0.09], [-0.03, 0.01], [0.03, 0.01], [-0.03, -0.09]]), L(0.1, 0.1, 0.16, 0.16), L(-0.1, 0.1, -0.16, 0.16)],
});

// 8. Motors / actuators --------------------------------------------------

const brake = symbol({ name: 'HBRK1', description: 'Brake coil', family: 'BRK', entities: [...stubs(0.16), R(0, 0, 0.32, 0.2), T(0, -0.035, 'BRK', 0.07)] });
const clutch = symbol({ name: 'HCL1', description: 'Clutch coil', family: 'CL', entities: [...stubs(0.16), R(0, 0, 0.32, 0.2), T(0, -0.035, 'CL', 0.07)] });
const fan = symbol({
  name: 'HFAN1',
  description: 'Fan motor',
  family: 'FAN',
  entities: [...stubs(0.19), C(0, 0, 0.19), C(0, 0, 0.03), L(0, -0.13, 0, 0.13), L(-0.113, -0.065, 0.113, 0.065), L(-0.113, 0.065, 0.113, -0.065)],
  attributes: [tagAttr(0.35), descAttr(-0.5)],
});
const pump = symbol({
  name: 'HPU1',
  description: 'Pump motor',
  family: 'PMP',
  entities: [...stubs(0.19), C(0, 0, 0.19), P([[-0.09, -0.1], [0.11, 0], [-0.09, 0.1]], true)],
  attributes: [tagAttr(0.35), descAttr(-0.5)],
});
const blower = symbol({
  name: 'HMO4',
  description: 'Blower motor',
  family: 'MTR',
  entities: [...stubs(0.19), C(0, 0, 0.19), T(0, 0, 'M', 0.1), T(0, -0.13, 'BLWR', 0.05)],
  attributes: [tagAttr(0.35), descAttr(-0.5)],
});
const controlValve = symbol({
  name: 'HCV1',
  description: 'Control valve, motorised',
  family: 'CV',
  entities: [...stubs(0.12), R(0, 0, 0.24, 0.16), T(0, -0.03, 'M', 0.07), L(0, -0.08, 0, -0.14), P([[-0.12, -0.3], [-0.12, -0.14], [0, -0.22]], true), P([[0.12, -0.3], [0.12, -0.14], [0, -0.22]], true)],
});
const solValveSpring = symbol({
  name: 'HSV2',
  description: 'Solenoid valve, spring return',
  family: 'SV',
  entities: [
    ...stubs(0.16),
    A(-0.08, 0, 0.08, 0, 180),
    A(0.08, 0, 0.08, 0, 180),
    L(0, 0, 0, -0.14),
    P([[-0.12, -0.14], [0.12, -0.14], [-0.12, -0.28], [0.12, -0.28]], true),
    P([[0.12, -0.21], [0.16, -0.17], [0.2, -0.25], [0.24, -0.17], [0.28, -0.25], [0.32, -0.21]]),
  ],
});

// 9. Instrument transformers / metering / phase monitor -------------------

const currentXfmr = symbol({
  name: 'HCT3',
  description: 'Current transformer (window type)',
  family: 'CT',
  entities: [L(-HALF, 0, HALF, 0), C(0, 0, 0.12), C(-0.09, 0.06, 0.015, true), L(-0.05, -0.11, -0.05, -0.25), L(0.05, -0.11, 0.05, -0.25)],
});
const potentialXfmr = symbol({
  name: 'HPT3',
  description: 'Potential transformer',
  family: 'PT',
  entities: [
    L(-HALF, 0.12, -0.2, 0.12),
    ...[-0.15, -0.05, 0.05, 0.15].map((x) => A(x, 0.12, 0.05, 0, 180)),
    L(0.2, 0.12, HALF, 0.12),
    L(-0.2, 0.02, 0.2, 0.02),
    L(-0.2, -0.02, 0.2, -0.02),
    L(-HALF, -0.12, -0.2, -0.12),
    ...[-0.15, -0.05, 0.05, 0.15].map((x) => A(x, -0.12, 0.05, 180, 360)),
    L(0.2, -0.12, HALF, -0.12),
  ],
});
const shunt = symbol({
  name: 'HSH1',
  description: 'Shunt (current measuring)',
  family: 'SH',
  entities: [...stubs(0.2), R(0, 0, 0.4, 0.1), L(-0.12, 0.05, -0.12, 0.15), L(0.12, 0.05, 0.12, 0.15), C(-0.12, 0.17, 0.02), C(0.12, 0.17, 0.02)],
});
const meter = (name: string, desc: string, family: string, label: string, h = 0.1) =>
  symbol({ name, description: desc, family, entities: [...stubs(0.15), C(0, 0, 0.15), T(0, -0.045, label, h)] });
const hourMeter = meter('HHR1', 'Hour meter', 'HM', 'h');
const wattmeter = meter('HWM1', 'Wattmeter', 'WM', 'W');
const freqMeter = meter('HFM1', 'Frequency meter', 'FM', 'Hz', 0.08);
const energyMeter = symbol({ name: 'HEM1', description: 'Energy meter (kWh)', family: 'EM', entities: [...stubs(0.17), R(0, 0, 0.34, 0.24), T(0, -0.035, 'kWh', 0.07)] });
const phaseMonitor = symbol({
  name: 'HPM1',
  description: 'Phase monitor relay',
  family: 'PM',
  wdtype: 'COIL',
  entities: [...stubs(0.18), R(0, 0, 0.36, 0.24), T(0, -0.035, 'PM', 0.08), L(-0.1, 0.12, -0.1, 0.2), L(0, 0.12, 0, 0.2), L(0.1, 0.12, 0.1, 0.2)],
});
const phaseNO = symbol({ name: 'HPM1_NO', description: 'Phase monitor contact, normally open', family: 'PM', wdtype: 'CONTACT', entities: labelledContact(false, 'PM') });
const phaseNC = symbol({ name: 'HPM1_NC', description: 'Phase monitor contact, normally closed', family: 'PM', wdtype: 'CONTACT', entities: labelledContact(true, 'PM') });

// 10. Terminals / grounds / connectors -----------------------------------

const termLevel = (y: number): Entity[] => [L(-HALF, y, -0.05, y), C(0, y, 0.05), L(0.05, y, HALF, y)];
const multiLevelTerm = symbol({
  name: 'HT0002',
  description: 'Terminal, multi-level (2 level)',
  family: 'TB',
  wdtype: 'TERM',
  entities: [...termLevel(0.1), ...termLevel(-0.1), L(-0.1, 0.17, -0.1, -0.17)],
  attributes: [termAttr(0.22)],
});
const fusedTerm = symbol({
  name: 'HT0003',
  description: 'Terminal, fused',
  family: 'TB',
  wdtype: 'TERM',
  entities: [...stubs(0.05), C(0, 0, 0.05), R(0.2, 0, 0.14, 0.07)],
  attributes: [termAttr()],
});
const discTerm = symbol({
  name: 'HT0004',
  description: 'Terminal, disconnect (knife)',
  family: 'TB',
  wdtype: 'TERM',
  entities: [L(-HALF, 0, -0.05, 0), C(0, 0, 0.05), L(0.05, 0, 0.16, 0.1), C(0.2, 0, 0.02), L(0.22, 0, HALF, 0)],
  attributes: [termAttr()],
});
const groundTerm = symbol({
  name: 'HT0005',
  description: 'Terminal, ground (PE)',
  family: 'TB',
  wdtype: 'TERM',
  entities: [...stubs(0.05), C(0, 0, 0.05), L(0, -0.05, 0, -0.12), L(-0.08, -0.12, 0.08, -0.12), L(-0.05, -0.16, 0.05, -0.16), L(-0.02, -0.2, 0.02, -0.2)],
  attributes: [termAttr()],
});
const groundBar = symbol({
  name: 'HGND2',
  description: 'Ground bar',
  family: 'GND',
  entities: [...stubs(0.3), R(0, 0, 0.6, 0.08), ...[-0.2, -0.1, 0, 0.1, 0.2].map((x) => C(x, 0, 0.02))],
});
const chassisGround = symbol({
  name: 'HGND3',
  description: 'Chassis ground',
  family: 'GND',
  entities: [L(0, 0, 0, -0.15), L(-0.15, -0.15, 0.15, -0.15), L(-0.15, -0.15, -0.2, -0.23), L(-0.05, -0.15, -0.1, -0.23), L(0.05, -0.15, 0, -0.23), L(0.15, -0.15, 0.1, -0.23)],
  attributes: [],
});
const shieldGround = symbol({
  name: 'HGND4',
  description: 'Shield (drain) ground',
  family: 'GND',
  entities: [L(0, 0, 0, -0.18), A(0, -0.08, 0.1, 200, 340), L(-0.1, -0.22, 0.1, -0.22), L(-0.06, -0.26, 0.06, -0.26), L(-0.02, -0.3, 0.02, -0.3)],
  attributes: [],
});
const splice = symbol({ name: 'HSPL1', description: 'Splice (crimp)', family: 'SPL', entities: [...stubs(0.1), R(0, 0, 0.2, 0.08), L(-0.1, 0, 0.1, 0)] });
const plugJack = symbol({
  name: 'HPJ1',
  description: 'Connector, plug and jack pair',
  family: 'PJ',
  entities: [L(-HALF, 0, -0.1, 0), P([[-0.1, -0.06], [-0.1, 0.06], [-0.02, 0]], true), A(0.1, 0, 0.08, 90, 270), L(0.1, 0, HALF, 0)],
});
const multiPin = symbol({
  name: 'HPJ2',
  description: 'Connector, multi-pin',
  family: 'PJ',
  entities: [...stubs(0.2), R(0, 0, 0.4, 0.2), ...[-0.12, -0.04, 0.04, 0.12].map((x) => C(x, 0, 0.02))],
});

// 11. Solid state / passive / temperature elements -----------------------

const diodeBody = (): Entity[] => [P([[-0.1, -0.1], [-0.1, 0.1], [0.1, 0]], true), L(0.1, -0.1, 0.1, 0.1)];
const led = symbol({
  name: 'HLED1',
  description: 'Light emitting diode',
  family: 'LED',
  entities: [...stubs(0.1), ...diodeBody(), L(0, 0.11, 0.08, 0.21), arrowHead(0.08, 0.21, 1, 1, 0.03), L(0.08, 0.11, 0.16, 0.21), arrowHead(0.16, 0.21, 1, 1, 0.03)],
});
const zener = symbol({ name: 'HDI2', description: 'Zener diode', family: 'D', entities: [...stubs(0.1), ...diodeBody(), L(0.1, 0.1, 0.14, 0.1), L(0.1, -0.1, 0.06, -0.1)] });
/** Bipolar transistor drawn as an inline switch: collector left, emitter right, base lead down. */
const transistor = (name: string, desc: string, pnp: boolean) =>
  symbol({
    name,
    description: desc,
    family: 'Q',
    entities: [
      L(-HALF, 0, -0.14, 0),
      L(0.14, 0, HALF, 0),
      C(0, -0.04, 0.16),
      L(-0.08, -0.08, 0.08, -0.08),
      L(0, -0.08, 0, -0.26),
      L(-0.14, 0, -0.05, -0.08),
      L(0.05, -0.08, 0.14, 0),
      pnp ? arrowHead(0.05, -0.08, -1, -0.9, 0.035) : arrowHead(0.14, 0, 1, 0.9, 0.035),
    ],
  });
const npn = transistor('HQ1', 'Transistor, NPN', false);
const pnp = transistor('HQ2', 'Transistor, PNP', true);
const triac = symbol({
  name: 'HQ3',
  description: 'Triac',
  family: 'Q',
  entities: [
    L(-HALF, 0, -0.1, 0),
    L(-0.1, 0, -0.1, 0.06),
    P([[-0.1, 0], [-0.1, 0.12], [0, 0.06]], true),
    L(0, -0.12, 0, 0.12),
    P([[0.1, -0.12], [0.1, 0], [0, -0.06]], true),
    L(0.1, -0.06, 0.1, 0),
    L(0.1, 0, HALF, 0),
    L(0, -0.12, -0.08, -0.2),
    L(-0.08, -0.2, -0.16, -0.2),
  ],
});
const scr = symbol({
  name: 'HSCR1',
  description: 'SCR (thyristor)',
  family: 'SCR',
  entities: [...stubs(0.1), ...diodeBody(), L(0.1, -0.05, 0.19, -0.14), L(0.19, -0.14, 0.19, -0.24)],
});
const bridge = symbol({
  name: 'HBD1',
  description: 'Bridge rectifier',
  family: 'BR',
  entities: [
    ...stubs(0.2),
    P([[-0.2, 0], [0, 0.2], [0.2, 0], [0, -0.2]], true),
    P([[-0.05, 0.04], [-0.05, 0.12], [0.03, 0.08]], true),
    L(0.03, 0.04, 0.03, 0.12),
    L(0, 0.2, 0, 0.28),
    L(0, -0.2, 0, -0.28),
    T(0.07, 0.22, '+', 0.06),
    T(0.07, -0.28, '-', 0.06),
  ],
});
const inductor = symbol({ name: 'HIND1', description: 'Inductor / choke', family: 'IND', entities: [...stubs(0.2), ...[-0.15, -0.05, 0.05, 0.15].map((x) => A(x, 0, 0.05, 0, 180))] });
const zigzag = (): Entity => P([[-0.2, 0], [-0.16, 0.07], [-0.08, -0.07], [0, 0.07], [0.08, -0.07], [0.16, 0.07], [0.2, 0]]);
const potentiometer = symbol({
  name: 'HPOT1',
  description: 'Potentiometer',
  family: 'POT',
  entities: [...stubs(0.2), zigzag(), L(0, -0.24, 0, -0.1), arrowHead(0, -0.1, 0, 1, 0.035)],
});
const thermistor = symbol({
  name: 'HTH1',
  description: 'Thermistor (NTC / PTC)',
  family: 'RT',
  entities: [...stubs(0.2), zigzag(), L(-0.2, -0.13, 0.14, 0.11), L(0.14, 0.11, 0.22, 0.11), T(0.24, 0.16, 't', 0.05)],
});
const rtd = symbol({ name: 'HRTD1', description: 'RTD (resistance temperature detector)', family: 'RTD', entities: [...stubs(0.18), R(0, 0, 0.36, 0.14), T(0, -0.03, 'RTD', 0.06)] });
const thermocouple = symbol({
  name: 'HTC1',
  description: 'Thermocouple',
  family: 'TC',
  entities: [L(-HALF, 0.06, 0.15, 0), L(-HALF, -0.06, 0.15, 0), C(0.15, 0, 0.02, true), T(-0.05, 0.12, 'TC', 0.06)],
});

// 12. Power supplies / HMI / network / PLC -------------------------------

const box = (label: string, h = 0.08): Entity[] => [...stubs(0.24), R(0, 0, 0.48, 0.3), T(0, -0.035, label, h)];
const psuAcDc = symbol({
  name: 'HPW1',
  description: 'Power supply, AC/DC',
  family: 'PSU',
  entities: [...stubs(0.24), R(0, 0, 0.48, 0.3), L(-0.24, -0.15, 0.24, 0.15), T(-0.12, 0.02, '~', 0.08), L(0.06, -0.06, 0.18, -0.06), L(0.06, -0.1, 0.18, -0.1)],
});
const psuDcDc = symbol({
  name: 'HPW2',
  description: 'Power supply, DC/DC converter',
  family: 'PSU',
  entities: [...stubs(0.24), R(0, 0, 0.48, 0.3), L(-0.24, -0.15, 0.24, 0.15), L(-0.18, 0.08, -0.06, 0.08), L(-0.18, 0.04, -0.06, 0.04), L(0.06, -0.06, 0.18, -0.06), L(0.06, -0.1, 0.18, -0.1)],
});
const ups = symbol({ name: 'HUPS2', description: 'Uninterruptible power supply', family: 'UPS', entities: box('UPS') });
const charger = symbol({
  name: 'HBC1',
  description: 'Battery charger',
  family: 'BC',
  entities: [...box('CHG', 0.07), L(-0.2, 0.1, -0.2, 0.05), L(-0.17, 0.09, -0.17, 0.06), L(-0.14, 0.1, -0.14, 0.05), L(-0.11, 0.09, -0.11, 0.06)],
});
const batteryBank = symbol({
  name: 'HBT2',
  description: 'Battery bank, 24 V',
  family: 'BT',
  entities: [...stubs(0.15), ...[-0.15, -0.03, 0.09].flatMap((x) => [L(x, -0.14, x, 0.14), L(x + 0.06, -0.07, x + 0.06, 0.07)]), T(-0.2, 0.18, '+', 0.07)],
});
const isolationXfmr = symbol({
  name: 'HXF3',
  description: 'Isolation transformer (shielded)',
  family: 'T',
  entities: [
    L(-HALF, 0.25, -0.2, 0.25),
    ...[-0.15, -0.05, 0.05, 0.15].map((x) => A(x, 0.25, 0.05, 0, 180)),
    L(0.2, 0.25, HALF, 0.25),
    L(-0.2, 0.18, 0.2, 0.18),
    ...[-0.18, -0.1, -0.02, 0.06, 0.14].map((x) => L(x, 0.15, x + 0.04, 0.15)),
    L(0.22, 0.15, 0.3, 0.15),
    L(0.3, 0.15, 0.3, 0.09),
    L(0.27, 0.09, 0.33, 0.09),
    L(-0.2, 0.12, 0.2, 0.12),
    L(-HALF, 0.05, -0.2, 0.05),
    ...[-0.15, -0.05, 0.05, 0.15].map((x) => A(x, 0.05, 0.05, 180, 360)),
    L(0.2, 0.05, HALF, 0.05),
  ],
  attributes: [tagAttr(0.4), descAttr(-0.15)],
});
const hmi = symbol({
  name: 'HHMI1',
  description: 'HMI touch panel',
  family: 'HMI',
  entities: [...stubs(0.24), R(0, 0, 0.48, 0.3), R(0, 0.02, 0.38, 0.18), T(0, -0.01, 'HMI', 0.06), C(-0.14, -0.11, 0.015), C(0, -0.11, 0.015), C(0.14, -0.11, 0.015)],
});
const ethSwitch = symbol({
  name: 'HETH1',
  description: 'Ethernet switch',
  family: 'ETH',
  entities: [...stubs(0.24), R(0, 0, 0.48, 0.3), T(0, 0.04, 'ETH', 0.06), ...[-0.18, -0.09, 0, 0.09, 0.18].map((x) => R(x, -0.07, 0.06, 0.06))],
});
const plcAttrs = (def: string): AttributeDef[] => [{ tag: 'TAG1', prompt: 'Address', default: def, position: { x: 0, y: 0.2 }, height: 0.08, align: 'center' }, descAttr(-0.3)];
const plcRack = symbol({
  name: 'HPLCR',
  description: 'PLC rack outline',
  family: 'PLC',
  wdtype: 'PLC',
  entities: [
    L(-HALF, 0, -0.3, 0),
    L(0.3, 0, HALF, 0),
    R(0, 0, 0.6, 0.4),
    ...[-0.2, -0.1, 0, 0.1, 0.2].map((x) => L(x, -0.2, x, 0.2)),
    T(-0.25, 0.1, 'PS', 0.04),
    T(-0.15, 0.1, 'CPU', 0.035),
    ...[-0.05, 0.05, 0.15, 0.25].map((x) => T(x, 0.1, 'I/O', 0.035)),
  ],
  attributes: [{ tag: 'TAG1', prompt: 'Rack', default: 'RACK0', position: { x: 0, y: 0.28 }, height: 0.08, align: 'center' }, descAttr(-0.35)],
});
const plcAnalogOut = symbol({
  name: 'HPLCAO',
  description: 'PLC analog output point',
  family: 'PLC',
  wdtype: 'PLC',
  entities: [R(0, 0, 0.3, 0.24), L(0.15, 0, HALF, 0), P([[-0.1, -0.04], [-0.05, 0.05], [0, -0.05], [0.05, 0.05], [0.1, -0.04]])],
  attributes: plcAttrs('O:1.0'),
});
const plcPowerSupply = symbol({
  name: 'HPLCPS',
  description: 'PLC power supply module',
  family: 'PLC',
  wdtype: 'PLC',
  entities: [L(-HALF, 0, -0.15, 0), R(0, 0, 0.3, 0.24), T(0, -0.035, 'PS', 0.08), L(0.15, 0, HALF, 0)],
  attributes: plcAttrs(''),
});

// Exports ----------------------------------------------------------------

/**
 * Block-name patterns -> tag prefix for the families introduced here.
 * Register with symbols.registerTagPrefixes() so tagPrefix() resolves them.
 * Every prefix is unique and never matches a name from symbols.ts or iec.ts.
 */
export const JIC_CONTROL_TAG_PREFIXES: Array<[RegExp, string]> = [
  [/^HKS/, 'KS'],
  [/^HJS/, 'JS'],
  [/^HTW/, 'TW'],
  [/^HPE/, 'PE'],
  [/^HUS/, 'US'],
  [/^HENC/, 'ENC'],
  [/^HSPS/, 'SPS'],
  [/^HVS/, 'VS'],
  [/^HLV/, 'LVL'],
  [/^HZS/, 'ZS'],
  [/^HGS/, 'GS'],
  [/^HSM/, 'SM'],
  [/^HLC/, 'LC'],
  [/^HSR/, 'SR'],
  [/^HLR/, 'LR'],
  [/^HAR/, 'ALR'],
  [/^HCN/, 'CTR'],
  [/^HXT/, 'XT'],
  [/^HBK/, 'BKN'],
  [/^HSI/, 'SIR'],
  [/^HBRK/, 'BRK'],
  [/^HCL/, 'CL'],
  [/^HFAN/, 'FAN'],
  [/^HPU/, 'PMP'],
  [/^HCV/, 'CV'],
  [/^HCT/, 'CT'],
  [/^HPT/, 'PT'],
  [/^HSH/, 'SH'],
  [/^HHR/, 'HM'],
  [/^HWM/, 'WM'],
  [/^HFM/, 'FM'],
  [/^HEM/, 'EM'],
  [/^HPM/, 'PM'],
  [/^HSPL/, 'SPL'],
  [/^HPJ/, 'PJ'],
  [/^HLED/, 'LED'],
  [/^HQ/, 'Q'],
  [/^HSCR/, 'SCR'],
  [/^HBD/, 'BR'],
  [/^HIND/, 'IND'],
  [/^HPOT/, 'POT'],
  [/^HTH/, 'RT'],
  [/^HRTD/, 'RTD'],
  [/^HTC/, 'TC'],
  [/^HPW/, 'PSU'],
  [/^HUPS/, 'UPS'],
  [/^HBC/, 'BC'],
  [/^HHMI/, 'HMI'],
  [/^HETH/, 'ETH'],
];

export const JIC_CONTROL_CATEGORIES: SymbolCategory[] = [
  category('Illuminated / Maintained Buttons', [pbIllumNO, pbIllumNC, pbMaintNO, pbMaintNC, pbMushroomNO, keyNO, keyNC, joyNO, joyNC, thumbwheel]),
  category('Selector Switch Positions', [sel2p1, sel2p2, sel3hand, sel3off, sel3auto, sel3spring, rotary4, keySelector]),
  category('Photo Eyes / Proximity / Encoders', [peThruNO, peThruNC, peRetroNO, peRetroNC, capNO, capNC, usNO, usNC, encoder]),
  category('Speed / Vibration / Level / Position', [speedNO, speedNC, vibNO, vibNC, levelNO, levelNC, zoneNO, zoneNC]),
  category('Safety Devices', [estopTwist, estopNO, doorNC, doorNO, safetyMat, lightCurtain, safetyCoil, safetyNO, safetyNC]),
  category('Latching / Alternating Relays, Timers, Counters', [latchCoil, unlatchCoil, latchNO, latchNC, altCoil, altNO, timerRepeat, timerOneShot, counterCoil, counterNO, counterNC]),
  category('Stack Lights / Beacons / Sirens', [stack3, stack2, stackG, stackA, stackR, beacon, siren, strobe]),
  category('Motors / Actuators', [brake, clutch, fan, pump, blower, controlValve, solValveSpring]),
  category('Instrument Transformers / Metering', [currentXfmr, potentialXfmr, shunt, hourMeter, wattmeter, freqMeter, energyMeter, phaseMonitor, phaseNO, phaseNC]),
  category('Terminals / Grounds / Connectors', [multiLevelTerm, fusedTerm, discTerm, groundTerm, groundBar, chassisGround, shieldGround, splice, plugJack, multiPin]),
  category('Solid State / Passive / Temperature', [led, zener, npn, pnp, triac, scr, bridge, inductor, potentiometer, thermistor, rtd, thermocouple]),
  category('Power Supplies / HMI / Network / PLC', [psuAcDc, psuDcDc, ups, charger, batteryBank, isolationXfmr, hmi, ethSwitch, plcRack, plcAnalogOut, plcPowerSupply]),
];

export const JIC_CONTROL_SYMBOLS: BlockDef[] = JIC_CONTROL_CATEGORIES.flatMap((c) => c.symbols);

export function findJicControlSymbol(name: string): BlockDef | undefined {
  return JIC_CONTROL_SYMBOLS.find((s) => s.name === name);
}
