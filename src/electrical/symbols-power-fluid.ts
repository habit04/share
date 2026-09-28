/**
 * Extended symbol library: one-line / power-distribution symbols, PLC module
 * and communication variants and fluid power (hydraulic / pneumatic)
 * symbols, in the same three domains AutoCAD Electrical ships.
 *
 * Conventions (see symbol-kit.ts): units are inches, an inline symbol is
 * 0.75 wide with wire stubs ending at x = +-HALF on y = 0, multi-port symbols
 * add connection rows at other y values, and a symbol with a single vertical
 * connection (relay, meter, gauge, reservoir) connects at the top of a
 * vertical line through x = 0. All geometry here is original artwork drawn
 * from primitives.
 *
 * Tag-prefix families contributed by this module (registered with
 * `registerTagPrefixes(POWER_FLUID_TAG_PREFIXES)`):
 *
 *   HGEN  -> GEN   generator                HMTRP -> MTR  motor, one-line
 *   HUTIL -> UTIL  utility source           HVFD  -> VFD  variable frequency drive
 *   HATS  -> ATS   automatic transfer sw.   HSST  -> SST  soft starter (overrides /^HSS/)
 *   HMTS  -> MTS   manual transfer switch   HLOAD -> LOAD generic load
 *   HPNL  -> PNL   panelboard               HUPS  -> UPS  uninterruptible supply
 *   HBUS  -> BUS   bus / bus duct           HRECT -> RECT rectifier (overrides /^HRE/)
 *   HCAP  -> CAP   capacitor bank (overrides /^HCA/)   HINV -> INV inverter
 *   HPV   -> PV    photovoltaic array       HCT   -> CT   current transformer
 *   HSA   -> SA    surge arrester           HPT   -> PT   potential transformer
 *   HTVSS -> SPD   surge protective device  HMET  -> MET  power / PF meter
 *   HPR   -> PR    protective relay         HKWH  -> KWH  energy meter
 *   HFPCYL -> CYL  cylinder                 HFPV  -> SV   directional valve (existing family)
 *   HFP   -> FP    all other fluid power
 *
 * Existing rules already cover HXFR (T), HCBP (CB), HDSF / HDSP (DS), HFUP (FU)
 * and HPLC (PLC).
 */
import type { BlockDef, Entity, AttributeDef } from '../core/entities';
import { primitives, symbol, category, tagAttr, descAttr, HALF } from './symbol-kit';
import type { SymbolCategory } from './symbol-kit';

const { L, C, A, P, T, R, stubs } = primitives('pf');

// ---------------------------------------------------------------- helpers

/** Closed, solid-filled polygon. */
const F = (pts: Array<[number, number]>): Entity => ({ ...P(pts, true), filled: true }) as Entity;

/** Line from (x1, y1) to (x2, y2) with an open arrow head of length `h` at the end. */
const arrow = (x1: number, y1: number, x2: number, y2: number, h = 0.04): Entity[] => {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const wing = (a: number): [number, number] => [x2 - h * Math.cos(ang + a), y2 - h * Math.sin(ang + a)];
  return [L(x1, y1, x2, y2), P([wing(-0.5), [x2, y2], wing(0.5)])];
};

/** Dashed line drawn as `n` short dashes (pilot / control lines). */
const dashes = (x1: number, y1: number, x2: number, y2: number, n = 3): Entity[] => {
  const out: Entity[] = [];
  const k = 2 * n - 1;
  for (let i = 0; i < k; i += 2) {
    const t0 = i / k;
    const t1 = (i + 1) / k;
    out.push(L(x1 + (x2 - x1) * t0, y1 + (y2 - y1) * t0, x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1));
  }
  return out;
};

/** Small sine-wave (AC) glyph centred on (cx, cy). */
const tilde = (cx: number, cy: number, r = 0.04): Entity[] => [A(cx - r, cy, r, 0, 180), A(cx + r, cy, r, 180, 360)];
/** Small "=" (DC) glyph centred on (cx, cy). */
const dc = (cx: number, cy: number, w = 0.09): Entity[] => [L(cx - w / 2, cy + 0.025, cx + w / 2, cy + 0.025), L(cx - w / 2, cy - 0.025, cx + w / 2, cy - 0.025)];
/** Zig-zag spring from x0 towards `dir`, `w` wide, centred on cy. */
const spring = (x0: number, dir: 1 | -1, w = 0.09, cy = 0, amp = 0.05): Entity => {
  const s = (dir * w) / 5;
  return P([[x0, cy], [x0 + s, cy + amp], [x0 + 2 * s, cy - amp], [x0 + 3 * s, cy + amp], [x0 + 4 * s, cy - amp], [x0 + 5 * s, cy]]);
};
/** Solenoid actuator: a rectangle with a diagonal, from x0 towards `dir`. */
const solenoid = (x0: number, dir: 1 | -1, w = 0.09, cy = 0, h = 0.12): Entity[] => {
  const x1 = x0 + dir * w;
  return [R((x0 + x1) / 2, cy, w, h), L(x0, cy - h / 2, x1, cy + h / 2)];
};
/** Ground reference (three shortening bars) with its top at (0, y). */
const groundBars = (y: number): Entity[] => [L(-0.12, y, 0.12, y), L(-0.08, y - 0.06, 0.08, y - 0.06), L(-0.04, y - 0.12, 0.04, y - 0.12)];

/** TAG1 placed beside a vertical symbol instead of above it. */
const sideTag = (x: number, y: number): AttributeDef => ({ ...tagAttr(y), position: { x, y }, align: 'left' });
/** Attributes for a circle-bodied inline symbol of radius ~0.2. */
const roundAttrs = (): AttributeDef[] => [tagAttr(0.35), descAttr(-0.5)];

// ======================================================= one-line: sources

const utility = symbol({
  name: 'HUTIL1',
  description: 'Utility source (one-line)',
  family: 'UTIL',
  entities: [C(-0.1, 0, 0.2), ...tilde(-0.1, 0.03, 0.06), T(-0.1, -0.13, 'UTIL', 0.06), L(0.1, 0, HALF, 0)],
  attributes: [tagAttr(0.35), descAttr(-0.45)],
});
const generator = symbol({
  name: 'HGEN1',
  description: 'Generator, AC (one-line)',
  family: 'GEN',
  entities: [...stubs(0.2), C(0, 0, 0.2), T(0, 0.0, 'G', 0.11), ...tilde(0, -0.08, 0.05)],
  attributes: roundAttrs(),
});
const genset = symbol({
  name: 'HGEN2',
  description: 'Standby generator set, engine driven (one-line)',
  family: 'GEN',
  entities: [R(-0.22, 0, 0.16, 0.2), T(-0.22, -0.03, 'ENG', 0.05), L(-0.14, 0, -0.07, 0), C(0.1, 0, 0.17), T(0.1, -0.05, 'G', 0.11), L(0.27, 0, HALF, 0)],
  attributes: roundAttrs(),
});
const pvArray = symbol({
  name: 'HPV1',
  description: 'Photovoltaic array (one-line)',
  family: 'PV',
  entities: [R(0, 0, 0.26, 0.2), L(-0.13, 0.04, 0.13, 0.04), L(-0.13, -0.04, 0.13, -0.04), ...arrow(-0.32, 0.3, -0.18, 0.14), ...arrow(-0.24, 0.36, -0.1, 0.2), L(0.13, 0, HALF, 0)],
  attributes: [tagAttr(0.45), descAttr(-0.35)],
});
const transferSwitch = (name: string, description: string, family: string, manual: boolean): BlockDef =>
  symbol({
    name,
    description,
    family,
    entities: [
      L(-HALF, 0.25, -0.18, 0.25),
      L(-HALF, -0.25, -0.18, -0.25),
      C(-0.18, 0.25, 0.025),
      C(-0.18, -0.25, 0.025),
      T(-0.3, 0.29, 'N', 0.05),
      T(-0.3, -0.21, 'E', 0.05),
      L(0.1, 0, -0.15, 0.22),
      C(0.1, 0, 0.025),
      L(0.1, 0, HALF, 0),
      ...(manual ? [L(-0.025, 0.11, 0.03, 0.2), L(-0.01, 0.23, 0.07, 0.17)] : [...dashes(-0.02, -0.06, -0.02, -0.16, 2), T(-0.02, -0.24, 'A', 0.05)]),
      T(0.05, -0.4, manual ? 'MTS' : 'ATS', 0.07),
    ],
    attributes: [tagAttr(0.45), descAttr(-0.6)],
  });
const ats = transferSwitch('HATS1', 'Automatic transfer switch (one-line)', 'ATS', false);
const mts = transferSwitch('HMTS1', 'Manual transfer switch (one-line)', 'MTS', true);
const panelboard = symbol({
  name: 'HPNL1',
  description: 'Panelboard / distribution panel (one-line)',
  family: 'PNL',
  entities: [
    L(-HALF, 0, -0.2, 0),
    R(0.05, 0, 0.5, 0.5),
    L(-0.2, 0, -0.1, 0),
    L(-0.1, 0.2, -0.1, -0.2),
    ...[0.15, 0.05, -0.05, -0.15].flatMap((y) => [L(-0.1, y, 0.18, y), C(0.21, y, 0.02)]),
  ],
  attributes: [tagAttr(0.4), descAttr(-0.4)],
});
const bus = symbol({
  name: 'HBUS1',
  description: 'Bus bar segment (one-line)',
  family: 'BUS',
  entities: [...stubs(0.3), F([[-0.3, -0.03], [0.3, -0.03], [0.3, 0.03], [-0.3, 0.03]])],
  attributes: [tagAttr(0.25), descAttr(-0.3)],
});
const busDuct = symbol({
  name: 'HBUS2',
  description: 'Bus duct / busway (one-line)',
  family: 'BUS',
  entities: [...stubs(0.3), R(0, 0, 0.6, 0.16), L(-0.3, 0.04, 0.3, 0.04), L(-0.3, -0.04, 0.3, -0.04), ...[-0.2, -0.1, 0, 0.1, 0.2].map((x) => L(x - 0.03, -0.08, x + 0.03, 0.08))],
  attributes: [tagAttr(0.28), descAttr(-0.33)],
});
const capBank = symbol({
  name: 'HCAP1',
  description: 'Capacitor bank, power factor correction (one-line)',
  family: 'CAP',
  entities: [...stubs(0.03), L(-0.03, -0.14, -0.03, 0.14), L(0.03, -0.14, 0.03, 0.14), L(-0.15, 0.2, 0.15, 0.2), L(-0.15, 0.2, -0.15, 0.15), L(0.15, 0.2, 0.15, 0.15), T(0, -0.3, 'kVAR', 0.06)],
  attributes: [tagAttr(0.3), descAttr(-0.45)],
});

// ================================================ one-line: transformers

const twoCircles = (): Entity[] => [...stubs(0.25), C(-0.09, 0, 0.16), C(0.09, 0, 0.16)];
const xfrAttrs = (): AttributeDef[] => [tagAttr(0.35), descAttr(-0.45)];
const powerXfr = symbol({ name: 'HXFR1', description: 'Power transformer, two winding (one-line)', family: 'T', entities: twoCircles(), attributes: xfrAttrs() });
const deltaWyeXfr = symbol({
  name: 'HXFR2',
  description: 'Power transformer, delta-wye (one-line)',
  family: 'T',
  entities: [...twoCircles(), P([[-0.14, -0.04], [-0.04, -0.04], [-0.09, 0.05]], true), L(0.09, 0, 0.09, 0.06), L(0.09, 0, 0.04, -0.03), L(0.09, 0, 0.14, -0.03)],
  attributes: xfrAttrs(),
});
const ltcXfr = symbol({
  name: 'HXFR3',
  description: 'Power transformer with load tap changer (one-line)',
  family: 'T',
  entities: [...twoCircles(), ...arrow(-0.2, -0.22, 0.2, 0.22)],
  attributes: xfrAttrs(),
});
const threeWindingXfr = symbol({
  name: 'HXFR4',
  description: 'Power transformer, three winding (one-line)',
  family: 'T',
  entities: [L(-HALF, 0, -0.24, 0), C(-0.1, 0, 0.14), C(0.1, 0.13, 0.14), C(0.1, -0.13, 0.14), L(0.24, 0.13, HALF, 0.13), L(0.24, -0.13, HALF, -0.13)],
  attributes: [tagAttr(0.45), descAttr(-0.45)],
});
const ctWindow = symbol({
  name: 'HCTP1',
  description: 'Current transformer, window type (one-line)',
  family: 'CT',
  entities: [L(-HALF, 0, HALF, 0), C(0, 0, 0.13), L(-0.06, -0.115, -0.06, -0.25), L(0.06, -0.115, 0.06, -0.25), T(0, 0.17, 'CT', 0.06)],
  attributes: [tagAttr(0.35), descAttr(-0.45)],
});
const ctBar = symbol({
  name: 'HCTP2',
  description: 'Current transformer, bar type (one-line)',
  family: 'CT',
  entities: [L(-HALF, 0, HALF, 0), R(0, 0, 0.3, 0.18), L(-0.06, -0.09, -0.06, -0.22), L(0.06, -0.09, 0.06, -0.22), T(0, 0.13, 'CT', 0.06)],
  attributes: [tagAttr(0.35), descAttr(-0.45)],
});
const pt = symbol({
  name: 'HPTP1',
  description: 'Potential transformer (one-line)',
  family: 'PT',
  entities: [L(0, 0, 0, -0.12), C(0, -0.22, 0.1), C(0, -0.36, 0.1), L(0, -0.46, 0, -0.56), T(-0.2, -0.32, 'PT', 0.06)],
  attributes: [sideTag(0.16, -0.32), descAttr(-0.7)],
});
const ptFused = symbol({
  name: 'HPTP2',
  description: 'Potential transformer, fused (one-line)',
  family: 'PT',
  entities: [L(0, 0, 0, -0.06), R(0, -0.13, 0.08, 0.14), L(0, -0.06, 0, -0.2), L(0, -0.2, 0, -0.24), C(0, -0.34, 0.1), C(0, -0.48, 0.1), L(0, -0.58, 0, -0.68), T(-0.2, -0.44, 'PT', 0.06)],
  attributes: [sideTag(0.16, -0.44), descAttr(-0.82)],
});
const meter = (name: string, description: string, family: string, label: string, h = 0.08): BlockDef =>
  symbol({
    name,
    description,
    family,
    entities: [L(0, 0, 0, -0.12), C(0, -0.3, 0.18), T(0, -0.34, label, h)],
    attributes: [sideTag(0.24, -0.3), descAttr(-0.6)],
  });
const powerMeter = meter('HMET1', 'Power meter, multifunction (one-line)', 'MET', 'PM');
const pfMeter = meter('HMET2', 'Power factor meter (one-line)', 'MET', 'PF');
const kwhMeter = meter('HKWH1', 'Energy meter, kWh (one-line)', 'KWH', 'kWh', 0.07);

// =========================================== one-line: breakers & switches

const drawoutBreaker = symbol({
  name: 'HCBP1',
  description: 'Power circuit breaker, drawout (one-line)',
  family: 'CB',
  entities: [...stubs(0.15), R(0, 0, 0.3, 0.3), P([[-0.27, 0.06], [-0.21, 0], [-0.27, -0.06]]), P([[0.27, 0.06], [0.21, 0], [0.27, -0.06]]), L(-0.08, -0.08, 0.08, 0.08)],
  attributes: [tagAttr(0.35), descAttr(-0.45)],
});
const mccb = symbol({
  name: 'HCBP2',
  description: 'Circuit breaker, molded case (one-line)',
  family: 'CB',
  entities: [...stubs(0.14), R(0, 0, 0.28, 0.28), C(-0.08, 0, 0.02), C(0.08, 0, 0.02), A(0, -0.03, 0.09, 20, 160)],
  attributes: [tagAttr(0.35), descAttr(-0.45)],
});
const vcb = symbol({
  name: 'HCBP3',
  description: 'Circuit breaker, medium voltage vacuum (one-line)',
  family: 'CB',
  entities: [...stubs(0.14), R(0, 0, 0.28, 0.28), C(0, 0, 0.08), L(-0.06, -0.06, 0.06, 0.06), T(0, 0.17, 'VCB', 0.05)],
  attributes: [tagAttr(0.35), descAttr(-0.45)],
});
const fusedDisconnect = symbol({
  name: 'HDSF1',
  description: 'Fused disconnect switch (one-line)',
  family: 'DS',
  entities: [L(-HALF, 0, -0.28, 0), C(-0.28, 0, 0.025), L(-0.26, 0.01, -0.04, 0.15), C(-0.02, 0, 0.025), L(-0.02, 0, 0.06, 0), R(0.17, 0, 0.22, 0.1), L(0.06, 0, 0.28, 0), L(0.28, 0, HALF, 0)],
  attributes: [tagAttr(0.3), descAttr(-0.35)],
});
const disconnectOneLine = symbol({
  name: 'HDSP1',
  description: 'Disconnect switch, non-fused (one-line)',
  family: 'DS',
  entities: [L(-HALF, 0, -0.2, 0), C(-0.2, 0, 0.025), L(-0.18, 0.01, 0.1, 0.17), C(0.12, 0, 0.025), L(0.12, 0, HALF, 0)],
  attributes: [tagAttr(0.3), descAttr(-0.35)],
});
const powerFuse = symbol({
  name: 'HFUP1',
  description: 'Power fuse, current limiting (one-line)',
  family: 'FU',
  entities: [...stubs(0.18), R(0, 0, 0.36, 0.12), L(-0.18, 0, 0.18, 0), L(-0.12, -0.06, -0.12, 0.06), L(0.12, -0.06, 0.12, 0.06), C(0, 0, 0.025, true)],
  attributes: [tagAttr(0.3), descAttr(-0.35)],
});

// ====================================== one-line: protective relays, surge

const relay = (name: string, device: string, description: string): BlockDef =>
  symbol({
    name,
    description,
    family: 'PR',
    entities: [L(0, 0, 0, -0.1), C(0, -0.3, 0.2), T(0, -0.34, device, 0.08)],
    attributes: [sideTag(0.26, -0.3), descAttr(-0.65)],
  });
const relay5051 = relay('HPR50', '50/51', 'Protective relay, overcurrent (ANSI 50/51)');
const relay51G = relay('HPR51G', '51G', 'Protective relay, ground overcurrent (ANSI 51G)');
const relay27 = relay('HPR27', '27', 'Protective relay, undervoltage (ANSI 27)');
const relay59 = relay('HPR59', '59', 'Protective relay, overvoltage (ANSI 59)');
const relay87 = relay('HPR87', '87', 'Protective relay, differential (ANSI 87)');
const relay86 = relay('HPR86', '86', 'Lockout relay (ANSI 86)');
const surgeArrester = symbol({
  name: 'HSA1',
  description: 'Surge arrester (one-line)',
  family: 'SA',
  entities: [L(0, 0, 0, -0.1), R(0, -0.25, 0.14, 0.3), ...arrow(0, -0.14, 0, -0.36, 0.035), L(0, -0.4, 0, -0.5), ...groundBars(-0.5)],
  attributes: [sideTag(0.14, -0.25), descAttr(-0.8)],
});
const spd = symbol({
  name: 'HTVSS1',
  description: 'Surge protective device, inline',
  family: 'SPD',
  entities: [...stubs(0.18), R(0, 0, 0.36, 0.2), P([[-0.06, 0.08], [0.02, 0.01], [-0.02, 0.01], [0.06, -0.06]]), P([[0.0, -0.06], [0.06, -0.06], [0.05, -0.01]]), T(0, -0.2, 'SPD', 0.05)],
  attributes: [tagAttr(0.3), descAttr(-0.45)],
});

// ================================================= one-line: loads, drives

const motorOneLine = symbol({
  name: 'HMTRP1',
  description: 'Motor, one-line with HP rating',
  family: 'MTR',
  entities: [L(-HALF, 0, -0.2, 0), C(0, 0, 0.2), T(0, -0.02, 'M', 0.12), T(0, -0.14, 'HP', 0.05)],
  attributes: roundAttrs(),
});
const dcMotorOneLine = symbol({
  name: 'HMTRP2',
  description: 'Motor, DC (one-line)',
  family: 'MTR',
  entities: [L(-HALF, 0, -0.2, 0), C(0, 0, 0.2), T(0, -0.02, 'M', 0.12), ...dc(0, -0.11, 0.1)],
  attributes: roundAttrs(),
});
const driveBox = (): Entity[] => [...stubs(0.25), R(0, 0, 0.5, 0.3)];
const vfd = symbol({
  name: 'HVFD1',
  description: 'Variable frequency drive (one-line)',
  family: 'VFD',
  entities: [...driveBox(), L(-0.25, -0.15, 0.25, 0.15), ...tilde(-0.13, 0.07), T(0.13, -0.12, 'VFD', 0.05)],
  attributes: [tagAttr(0.3), descAttr(-0.45)],
});
const softStarter = symbol({
  name: 'HSST1',
  description: 'Soft starter, reduced voltage (one-line)',
  family: 'SST',
  entities: [...driveBox(), P([[-0.18, -0.1], [0.05, 0.08], [0.18, 0.08]]), L(-0.18, -0.1, 0.18, -0.1)],
  attributes: [tagAttr(0.3), descAttr(-0.45)],
});
const ups = symbol({
  name: 'HUPS1',
  description: 'Uninterruptible power supply (one-line)',
  family: 'UPS',
  entities: [...driveBox(), L(-0.08, 0.15, -0.08, -0.15), L(0.08, 0.15, 0.08, -0.15), ...tilde(-0.16, 0, 0.03), ...dc(0, 0, 0.08), ...tilde(0.16, 0, 0.03), T(0, -0.24, 'UPS', 0.05)],
  attributes: [tagAttr(0.3), descAttr(-0.45)],
});
const rectifier = symbol({
  name: 'HRECT1',
  description: 'Rectifier / battery charger (one-line)',
  family: 'RECT',
  entities: [...driveBox(), L(-0.25, -0.15, 0.25, 0.15), ...tilde(-0.13, 0.07), ...dc(0.13, -0.07)],
  attributes: [tagAttr(0.3), descAttr(-0.45)],
});
const inverter = symbol({
  name: 'HINV1',
  description: 'Inverter, DC to AC (one-line)',
  family: 'INV',
  entities: [...driveBox(), L(-0.25, -0.15, 0.25, 0.15), ...dc(-0.13, 0.07), ...tilde(0.13, -0.07)],
  attributes: [tagAttr(0.3), descAttr(-0.45)],
});
const load = symbol({
  name: 'HLOAD1',
  description: 'Load, generic (one-line)',
  family: 'LOAD',
  entities: [L(0, 0, 0, -0.32), P([[-0.06, -0.22], [0, -0.32], [0.06, -0.22]])],
  attributes: [sideTag(0.12, -0.2), descAttr(-0.5)],
});

// ================================================================== PLC

interface PlcModuleSpec {
  name: string;
  description: string;
  title: string;
  left?: string[];
  right?: string[];
  /** Vertical pitch of the I/O points (0.125 for up to 8, 0.1 for denser modules). */
  pitch?: number;
}

/** PLC module: a box with labelled wire connections on the left and/or right side. */
function plcModule(spec: PlcModuleSpec): BlockDef {
  const left = spec.left ?? [];
  const right = spec.right ?? [];
  const n = Math.max(left.length, right.length);
  const pitch = spec.pitch ?? 0.125;
  const half = (n * pitch) / 2 + 0.05;
  const top = half + 0.12;
  const bw = 0.22;
  const rowY = (i: number) => ((n - 1) / 2 - i) * pitch;
  const ents: Entity[] = [P([[-bw, -half], [bw, -half], [bw, top], [-bw, top]], true), L(-bw, half, bw, half), T(0, half + 0.025, spec.title, 0.065)];
  left.forEach((lbl, i) => {
    const y = rowY(i);
    ents.push(L(-HALF, y, -bw, y), T(-0.11, y - 0.02, lbl, 0.045));
  });
  right.forEach((lbl, i) => {
    const y = rowY(i);
    ents.push(L(bw, y, HALF, y), T(0.11, y - 0.02, lbl, 0.045));
  });
  return symbol({ name: spec.name, description: spec.description, family: 'PLC', wdtype: 'PLC', entities: ents, attributes: [tagAttr(top + 0.08), descAttr(-(half + 0.12))] });
}
const seq = (prefix: string, count: number, suffix = ''): string[] => Array.from({ length: count }, (_, i) => `${prefix}${i}${suffix}`);
const pairs = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, i) => [`${prefix}${i}+`, `${prefix}${i}-`]).flat();

const plcDI8 = plcModule({ name: 'HPLCDI8', description: 'PLC digital input module, 8 point', title: 'DI-8', left: seq('I', 8) });
const plcDI16 = plcModule({ name: 'HPLCDI16', description: 'PLC digital input module, 16 point', title: 'DI-16', left: seq('I', 16), pitch: 0.1 });
const plcDO8 = plcModule({ name: 'HPLCDO8', description: 'PLC digital output module, 8 point', title: 'DO-8', right: seq('O', 8) });
const plcDO16 = plcModule({ name: 'HPLCDO16', description: 'PLC digital output module, 16 point', title: 'DO-16', right: seq('O', 16), pitch: 0.1 });
const plcDOR8 = plcModule({ name: 'HPLCDOR8', description: 'PLC relay output module, 8 point', title: 'DO-RLY', right: seq('O', 8) });
const plcMix8 = plcModule({ name: 'HPLCMIX8', description: 'PLC combination I/O module, 4 in / 4 out', title: 'DI/DO', left: seq('I', 4), right: seq('O', 4) });
const plcSI4 = plcModule({ name: 'HPLCSI4', description: 'PLC safety input module, 4 dual-channel', title: 'SI-4', left: Array.from({ length: 4 }, (_, i) => [`I${i}A`, `I${i}B`]).flat() });
const plcAI4 = plcModule({ name: 'HPLCAI4', description: 'PLC analog input module, 4 channel differential', title: 'AI-4', left: pairs('AI', 4) });
const plcAO2 = plcModule({ name: 'HPLCAO2', description: 'PLC analog output module, 2 channel', title: 'AO-2', right: pairs('AO', 2) });
const plcTC4 = plcModule({ name: 'HPLCTC4', description: 'PLC thermocouple input module, 4 channel', title: 'TC-4', left: pairs('TC', 4) });
const plcRTD4 = plcModule({
  name: 'HPLCRTD4',
  description: 'PLC RTD input module, 4 channel 3-wire',
  title: 'RTD-4',
  left: Array.from({ length: 4 }, (_, i) => [`R${i}A`, `R${i}B`, `R${i}C`]).flat(),
  pitch: 0.1,
});
const plcHSC = plcModule({ name: 'HPLCHSC1', description: 'PLC high-speed counter module', title: 'HSC', left: ['A', 'B', 'Z', 'GATE'], right: ['OUT0', 'OUT1'] });
const plcCPU = plcModule({ name: 'HPLCCPU1', description: 'PLC processor (CPU) module', title: 'CPU', left: ['L1', 'L2/N', 'GND'], right: ['COM1'] });
const plcPS = plcModule({ name: 'HPLCPS1', description: 'PLC power supply module', title: 'PS', left: ['L1', 'N', 'GND'], right: ['+24V', '0V'] });
const plcEnet = plcModule({ name: 'HPLCCOM1', description: 'PLC communication module, Ethernet', title: 'ENET', right: ['ETH1', 'ETH2'] });
const plcSerial = plcModule({ name: 'HPLCCOM2', description: 'PLC communication module, serial RS-485', title: 'RS-485', right: ['TX/A', 'RX/B', 'SHD'] });
const plcFieldbus = plcModule({ name: 'HPLCCOM3', description: 'PLC communication module, fieldbus', title: 'FBUS', right: ['V+', 'CAN_H', 'CAN_L', 'V-', 'SHD'] });
const plcRIO = plcModule({ name: 'HPLCRIO1', description: 'PLC remote I/O adapter', title: 'RIO', left: ['NET1', 'NET2'], right: ['+24V', '0V'] });

// ============================================ fluid power: directional valves

/** Position box of half-width `hw`, 0.2 tall, centred on (cx, 0). */
const box = (cx: number, hw: number): Entity => R(cx, 0, 2 * hw, 0.2);
const blockedTop = (x: number): Entity[] => [L(x, 0.1, x, 0.06), L(x - 0.02, 0.06, x + 0.02, 0.06)];
const blockedBot = (x: number): Entity[] => [L(x, -0.1, x, -0.06), L(x - 0.02, -0.06, x + 0.02, -0.06)];
const portTop = (x: number): Entity => L(x, 0.1, x, 0.17);
const portBot = (x: number): Entity => L(x, -0.1, x, -0.17);
const flow = (x1: number, y1: number, x2: number, y2: number): Entity[] => arrow(x1, y1, x2, y2, 0.035);
const valveAttrs = (): AttributeDef[] => [tagAttr(0.35), descAttr(-0.4)];
/** Two-position envelope: actuated box at x = -0.1, normal (spring side) box at x = 0.1. */
const twoPosition = (): Entity[] => [box(-0.1, 0.1), box(0.1, 0.1)];
const solSpring = (): Entity[] => [...stubs(0.29), ...solenoid(-0.2, -1), spring(0.2, 1)];
/** Three-position envelope, solenoid / solenoid with spring centring, ports on the centre box. */
const threePosition = (): Entity[] => [
  ...stubs(0.29),
  box(-0.14, 0.07),
  box(0, 0.07),
  box(0.14, 0.07),
  ...solenoid(-0.21, -1, 0.08, -0.03, 0.1),
  ...solenoid(0.21, 1, 0.08, -0.03, 0.1),
  spring(-0.21, -1, 0.08, 0.07, 0.025),
  spring(0.21, 1, 0.08, 0.07, 0.025),
];

const v22 = symbol({
  name: 'HFPV22',
  description: 'Directional valve 2/2, solenoid / spring return, normally closed',
  family: 'SV',
  entities: [...solSpring(), ...twoPosition(), portTop(0.1), portBot(0.1), ...blockedTop(0.1), ...blockedBot(0.1), ...flow(-0.1, -0.1, -0.1, 0.1)],
  attributes: valveAttrs(),
});
const v32Body = (): Entity[] => [
  ...twoPosition(),
  portTop(0.1),
  portBot(0.06),
  portBot(0.14),
  ...flow(0.1, 0.1, 0.14, -0.1),
  ...blockedBot(0.06),
  ...flow(-0.14, -0.1, -0.1, 0.1),
  ...blockedBot(-0.06),
];
const v32 = symbol({
  name: 'HFPV32',
  description: 'Directional valve 3/2, solenoid / spring return, normally closed',
  family: 'SV',
  entities: [...solSpring(), ...v32Body()],
  attributes: valveAttrs(),
});
const v32Manual = symbol({
  name: 'HFPV32M',
  description: 'Directional valve 3/2, manual lever / spring return',
  family: 'SV',
  entities: [L(-HALF, 0, -0.2, 0), L(0.29, 0, HALF, 0), L(-0.26, -0.06, -0.26, 0.06), L(-0.26, 0.06, -0.32, 0.14), spring(0.2, 1), ...v32Body()],
  attributes: valveAttrs(),
});
const v32Pilot = symbol({
  name: 'HFPV32P',
  description: 'Directional valve 3/2, pilot operated / spring return',
  family: 'SV',
  entities: [...stubs(0.29), P([[-0.2, 0.05], [-0.2, -0.05], [-0.29, 0]], true), ...dashes(-0.29, 0, -0.29, -0.2, 3), spring(0.2, 1), ...v32Body()],
  attributes: valveAttrs(),
});
const v42 = symbol({
  name: 'HFPV42',
  description: 'Directional valve 4/2, solenoid / spring return',
  family: 'SV',
  entities: [
    ...solSpring(),
    ...twoPosition(),
    portTop(0.06),
    portTop(0.14),
    portBot(0.06),
    portBot(0.14),
    ...flow(0.06, -0.1, 0.14, 0.1),
    ...flow(0.06, 0.1, 0.14, -0.1),
    ...flow(-0.14, -0.1, -0.14, 0.1),
    ...flow(-0.06, 0.1, -0.06, -0.1),
  ],
  attributes: valveAttrs(),
});
const v52 = symbol({
  name: 'HFPV52',
  description: 'Directional valve 5/2, solenoid / spring return',
  family: 'SV',
  entities: [
    ...solSpring(),
    ...twoPosition(),
    portTop(0.06),
    portTop(0.14),
    portBot(0.03),
    portBot(0.1),
    portBot(0.17),
    ...flow(0.1, -0.1, 0.14, 0.1),
    ...flow(0.06, 0.1, 0.03, -0.1),
    ...blockedBot(0.17),
    ...flow(-0.1, -0.1, -0.14, 0.1),
    ...flow(-0.06, 0.1, -0.03, -0.1),
    ...blockedBot(-0.17),
  ],
  attributes: valveAttrs(),
});
const v53 = symbol({
  name: 'HFPV53',
  description: 'Directional valve 5/3, solenoid / solenoid, spring centred, closed centre',
  family: 'SV',
  entities: [
    ...threePosition(),
    portTop(-0.035),
    portTop(0.035),
    portBot(-0.05),
    portBot(0),
    portBot(0.05),
    ...blockedTop(-0.035),
    ...blockedTop(0.035),
    ...blockedBot(-0.05),
    ...blockedBot(0),
    ...blockedBot(0.05),
    ...flow(0.14, -0.1, 0.175, 0.1),
    ...flow(0.105, 0.1, 0.09, -0.1),
    ...blockedBot(0.19),
    ...flow(-0.14, -0.1, -0.175, 0.1),
    ...flow(-0.105, 0.1, -0.09, -0.1),
    ...blockedBot(-0.19),
  ],
  attributes: valveAttrs(),
});
const v43 = symbol({
  name: 'HFPV43',
  description: 'Directional valve 4/3, solenoid / solenoid, spring centred, closed centre',
  family: 'SV',
  entities: [
    ...threePosition(),
    portTop(-0.035),
    portTop(0.035),
    portBot(-0.035),
    portBot(0.035),
    ...blockedTop(-0.035),
    ...blockedTop(0.035),
    ...blockedBot(-0.035),
    ...blockedBot(0.035),
    ...flow(0.105, -0.1, 0.175, 0.1),
    ...flow(0.105, 0.1, 0.175, -0.1),
    ...flow(-0.175, -0.1, -0.175, 0.1),
    ...flow(-0.105, 0.1, -0.105, -0.1),
  ],
  attributes: valveAttrs(),
});

// ====================================== fluid power: pressure & flow control

const reliefValve = symbol({
  name: 'HFPRV1',
  description: 'Pressure relief valve, direct acting',
  family: 'FP',
  entities: [...stubs(0.1), R(0, 0, 0.2, 0.2), ...flow(-0.08, 0.05, 0.08, 0.05), spring(0, 1, 0.12, 0.1, 0.04), ...dashes(-0.2, 0, -0.2, -0.16, 2), ...dashes(-0.2, -0.16, 0, -0.16, 2), ...dashes(0, -0.16, 0, -0.1, 1)],
  attributes: [tagAttr(0.35), descAttr(-0.4)],
});
const regulator = symbol({
  name: 'HFPREG1',
  description: 'Pressure regulator (reducing valve), relieving',
  family: 'FP',
  entities: [
    ...stubs(0.1),
    R(0, 0, 0.2, 0.2),
    ...flow(-0.08, 0, 0.08, 0),
    spring(0, 1, 0.12, 0.1, 0.04),
    ...arrow(-0.08, 0.06, 0.1, 0.16, 0.03),
    ...dashes(0.2, 0, 0.2, -0.16, 2),
    ...dashes(0.2, -0.16, 0, -0.16, 2),
    ...dashes(0, -0.16, 0, -0.1, 1),
    L(0.05, -0.1, 0.05, -0.2),
  ],
  attributes: [tagAttr(0.35), descAttr(-0.4)],
});
const checkValve = symbol({
  name: 'HFPCV1',
  description: 'Check valve',
  family: 'FP',
  entities: [...stubs(0.12), P([[0.12, 0.09], [0.0, 0], [0.12, -0.09]]), C(-0.05, 0, 0.05)],
  attributes: [tagAttr(0.3), descAttr(-0.35)],
});
const springCheck = symbol({
  name: 'HFPCV2',
  description: 'Check valve, spring loaded',
  family: 'FP',
  entities: [...stubs(0.2), P([[0.12, 0.09], [0.0, 0], [0.12, -0.09]]), C(-0.05, 0, 0.05), spring(-0.2, 1, 0.1, 0, 0.03)],
  attributes: [tagAttr(0.3), descAttr(-0.35)],
});
const orifice = (): Entity[] => [A(0, 0.13, 0.1, 225, 315), A(0, -0.13, 0.1, 45, 135)];
const flowControl = symbol({
  name: 'HFPFLOW1',
  description: 'Flow control valve, adjustable',
  family: 'FP',
  entities: [...stubs(0.12), ...orifice(), ...arrow(-0.12, -0.14, 0.12, 0.14, 0.035)],
  attributes: [tagAttr(0.3), descAttr(-0.35)],
});
const flowControlBypass = symbol({
  name: 'HFPFLOW2',
  description: 'Flow control valve with bypass check',
  family: 'FP',
  entities: [
    ...stubs(0.12),
    ...orifice(),
    ...arrow(-0.12, -0.14, 0.12, 0.14, 0.035),
    L(-0.2, 0, -0.2, -0.24),
    L(-0.2, -0.24, 0.2, -0.24),
    L(0.2, -0.24, 0.2, 0),
    P([[0.07, -0.18], [-0.01, -0.24], [0.07, -0.3]]),
    C(-0.05, -0.24, 0.035),
  ],
  attributes: [tagAttr(0.3), descAttr(-0.45)],
});
const shutoff = symbol({
  name: 'HFPSHUT1',
  description: 'Shut-off valve, manual',
  family: 'FP',
  entities: [...stubs(0.12), P([[-0.12, 0.08], [-0.12, -0.08], [0, 0]], true), P([[0.12, 0.08], [0.12, -0.08], [0, 0]], true), L(0, 0, 0, 0.12), L(-0.05, 0.12, 0.05, 0.12)],
  attributes: [tagAttr(0.3), descAttr(-0.35)],
});

// ========================================= fluid power: actuators & pumps

const cylinderBody = (cx: number): Entity[] => [R(cx, 0, 0.4, 0.2)];
const piston = (x: number): Entity[] => [L(x, -0.1, x, 0.1), L(x + 0.03, -0.1, x + 0.03, 0.1)];
const cylAttrs = (): AttributeDef[] => [tagAttr(0.3), descAttr(-0.45)];
const cylSingle = symbol({
  name: 'HFPCYL1',
  description: 'Cylinder, single acting, spring return',
  family: 'CYL',
  entities: [L(-HALF, 0, -0.25, 0), ...cylinderBody(-0.05), ...piston(-0.15), L(-0.12, 0, 0.3, 0), P([[-0.09, 0.06], [-0.05, -0.06], [-0.01, 0.06], [0.03, -0.06], [0.07, 0.06], [0.11, -0.06], [0.14, 0.06]])],
  attributes: cylAttrs(),
});
const cylDouble = symbol({
  name: 'HFPCYL2',
  description: 'Cylinder, double acting',
  family: 'CYL',
  entities: [L(-HALF, 0, -0.25, 0), ...cylinderBody(-0.05), ...piston(-0.15), L(-0.12, 0, 0.3, 0), L(0.1, -0.1, 0.1, -0.25), L(0.1, -0.25, HALF, -0.25)],
  attributes: cylAttrs(),
});
const cylDoubleRod = symbol({
  name: 'HFPCYL3',
  description: 'Cylinder, double acting, double rod',
  family: 'CYL',
  entities: [
    ...cylinderBody(0),
    ...piston(-0.015),
    L(-0.3, 0, -0.015, 0),
    L(0.015, 0, 0.3, 0),
    L(-0.15, -0.1, -0.15, -0.25),
    L(-HALF, -0.25, -0.15, -0.25),
    L(0.15, -0.1, 0.15, -0.25),
    L(0.15, -0.25, HALF, -0.25),
  ],
  attributes: cylAttrs(),
});
const rotaryActuator = symbol({
  name: 'HFPROT1',
  description: 'Rotary actuator, limited rotation',
  family: 'FP',
  entities: [
    R(0, 0, 0.36, 0.18),
    A(0, -0.02, 0.09, 30, 150),
    P([[0.05, 0.03], [0.078, 0.025], [0.07, 0.055]]),
    L(-0.12, -0.09, -0.12, -0.22),
    L(-HALF, -0.22, -0.12, -0.22),
    L(0.12, -0.09, 0.12, -0.22),
    L(0.12, -0.22, HALF, -0.22),
  ],
  attributes: [tagAttr(0.28), descAttr(-0.42)],
});
const pumpAttrs = (): AttributeDef[] => [tagAttr(0.3), descAttr(-0.4)];
const pumpFixed = symbol({
  name: 'HFPPMP1',
  description: 'Hydraulic pump, fixed displacement',
  family: 'FP',
  entities: [...stubs(0.16), C(0, 0, 0.16), F([[-0.05, 0.02], [0.05, 0.02], [0, 0.14]])],
  attributes: pumpAttrs(),
});
const pumpVariable = symbol({
  name: 'HFPPMP2',
  description: 'Hydraulic pump, variable displacement',
  family: 'FP',
  entities: [...stubs(0.16), C(0, 0, 0.16), F([[-0.05, 0.02], [0.05, 0.02], [0, 0.14]]), ...arrow(-0.2, -0.2, 0.2, 0.2, 0.04)],
  attributes: pumpAttrs(),
});
const hydMotor = symbol({
  name: 'HFPMOT1',
  description: 'Hydraulic motor, unidirectional',
  family: 'FP',
  entities: [...stubs(0.16), C(0, 0, 0.16), F([[-0.05, 0.14], [0.05, 0.14], [0, 0.02]])],
  attributes: pumpAttrs(),
});
const airMotor = symbol({
  name: 'HFPMOT2',
  description: 'Air motor, bidirectional',
  family: 'FP',
  entities: [...stubs(0.16), C(0, 0, 0.16), P([[-0.14, 0.05], [-0.14, -0.05], [-0.03, 0]], true), P([[0.14, 0.05], [0.14, -0.05], [0.03, 0]], true)],
  attributes: pumpAttrs(),
});
const compressor = symbol({
  name: 'HFPCOMP1',
  description: 'Air compressor',
  family: 'FP',
  entities: [...stubs(0.16), C(0, 0, 0.16), P([[-0.05, 0.02], [0.05, 0.02], [0, 0.14]], true), T(0, -0.12, 'C', 0.07)],
  attributes: pumpAttrs(),
});

// ============================================ fluid power: conditioning

const diamond = (): Entity[] => [P([[0, 0.16], [0.16, 0], [0, -0.16], [-0.16, 0]], true)];
const condAttrs = (): AttributeDef[] => [tagAttr(0.3), descAttr(-0.4)];
const filterElement = (): Entity[] => [L(0, 0.12, 0, 0.07), L(0, 0.03, 0, -0.03), L(0, -0.07, 0, -0.12)];
const filter = symbol({ name: 'HFPFLT1', description: 'Filter / strainer', family: 'FP', entities: [...stubs(0.16), ...diamond(), ...filterElement()], attributes: condAttrs() });
const filterDrain = symbol({
  name: 'HFPFLT2',
  description: 'Filter with water separator and auto drain',
  family: 'FP',
  entities: [...stubs(0.16), ...diamond(), ...filterElement(), L(0, -0.16, 0, -0.26), P([[-0.04, -0.26], [0.04, -0.26], [0, -0.33]], true)],
  attributes: [tagAttr(0.3), descAttr(-0.5)],
});
const lubricator = symbol({
  name: 'HFPLUB1',
  description: 'Lubricator',
  family: 'FP',
  entities: [...stubs(0.16), ...diamond(), P([[0, 0.1], [0.045, 0.0], [0, -0.05], [-0.045, 0.0]], true)],
  attributes: condAttrs(),
});
const dryer = symbol({
  name: 'HFPDRY1',
  description: 'Air dryer',
  family: 'FP',
  entities: [...stubs(0.16), ...diamond(), C(-0.045, 0.045, 0.012, true), C(0.045, 0.045, 0.012, true), C(-0.045, -0.045, 0.012, true), C(0.045, -0.045, 0.012, true)],
  attributes: condAttrs(),
});
const cooler = symbol({
  name: 'HFPCOOL1',
  description: 'Cooler / heat exchanger',
  family: 'FP',
  entities: [...stubs(0.16), ...diamond(), ...arrow(0, 0.02, 0, 0.13, 0.03), ...arrow(0, -0.02, 0, -0.13, 0.03)],
  attributes: condAttrs(),
});
const accumulator = symbol({
  name: 'HFPACC1',
  description: 'Accumulator, gas charged',
  family: 'FP',
  entities: [L(0, 0, 0, -0.1), A(0, -0.2, 0.1, 0, 180), L(-0.1, -0.2, -0.1, -0.45), L(0.1, -0.2, 0.1, -0.45), A(0, -0.45, 0.1, 180, 360), L(-0.1, -0.3, 0.1, -0.3), P([[-0.045, -0.35], [0.045, -0.35], [0, -0.43]], true)],
  attributes: [sideTag(0.16, -0.3), descAttr(-0.7)],
});
const reservoir = symbol({
  name: 'HFPTANK1',
  description: 'Reservoir / tank, vented',
  family: 'FP',
  entities: [L(0, 0, 0, -0.22), P([[-0.14, -0.14], [-0.14, -0.3], [0.14, -0.3], [0.14, -0.14]])],
  attributes: [sideTag(0.2, -0.16), descAttr(-0.5)],
});
const gauge = symbol({
  name: 'HFPGAUGE1',
  description: 'Pressure gauge',
  family: 'FP',
  entities: [L(0, 0, 0, -0.12), C(0, -0.28, 0.16), L(0, -0.28, 0.09, -0.18), C(0, -0.28, 0.015, true)],
  attributes: [sideTag(0.22, -0.28), descAttr(-0.6)],
});
const muffler = symbol({
  name: 'HFPMUF1',
  description: 'Muffler / silencer (exhaust)',
  family: 'FP',
  entities: [L(0, 0, 0, -0.1), R(0, -0.25, 0.2, 0.3), L(-0.1, -0.16, 0.1, -0.34), L(-0.1, -0.34, 0.1, -0.16)],
  attributes: [sideTag(0.16, -0.25), descAttr(-0.55)],
});
const quickDisconnect = symbol({
  name: 'HFPQD1',
  description: 'Quick disconnect coupling, with check valves',
  family: 'FP',
  entities: [
    ...stubs(0.14),
    P([[-0.14, 0.08], [-0.03, 0.08], [-0.03, -0.08], [-0.14, -0.08]]),
    P([[0.14, 0.08], [0.03, 0.08], [0.03, -0.08], [0.14, -0.08]]),
    P([[-0.13, 0.05], [-0.06, 0], [-0.13, -0.05]]),
    P([[0.13, 0.05], [0.06, 0], [0.13, -0.05]]),
  ],
  attributes: [tagAttr(0.28), descAttr(-0.35)],
});
const pressureSource = symbol({
  name: 'HFPSRC1',
  description: 'Pressure source (supply)',
  family: 'FP',
  entities: [L(0, 0, 0, -0.1), C(0, -0.2, 0.1), C(0, -0.2, 0.02, true)],
  attributes: [sideTag(0.16, -0.2), descAttr(-0.45)],
});

// ============================================================ exports

export const POWER_FLUID_CATEGORIES: SymbolCategory[] = [
  category('One-Line: Sources & Switching', [utility, generator, genset, pvArray, ats, mts, panelboard, bus, busDuct, capBank]),
  category('One-Line: Transformers & Metering', [powerXfr, deltaWyeXfr, ltcXfr, threeWindingXfr, ctWindow, ctBar, pt, ptFused, powerMeter, pfMeter, kwhMeter]),
  category('One-Line: Breakers & Switches', [drawoutBreaker, mccb, vcb, fusedDisconnect, disconnectOneLine, powerFuse]),
  category('One-Line: Protective Relays & Surge', [relay5051, relay51G, relay27, relay59, relay87, relay86, surgeArrester, spd]),
  category('One-Line: Loads & Drives', [motorOneLine, dcMotorOneLine, vfd, softStarter, ups, rectifier, inverter, load]),
  category('PLC I/O Modules: Discrete', [plcDI8, plcDI16, plcDO8, plcDO16, plcDOR8, plcMix8, plcSI4]),
  category('PLC I/O Modules: Analog & Specialty', [plcAI4, plcAO2, plcTC4, plcRTD4, plcHSC]),
  category('PLC Processor & Comms', [plcCPU, plcPS, plcEnet, plcSerial, plcFieldbus, plcRIO]),
  category('Fluid Power: Directional Valves', [v22, v32, v32Manual, v32Pilot, v42, v52, v53, v43]),
  category('Fluid Power: Pressure & Flow Control', [reliefValve, regulator, checkValve, springCheck, flowControl, flowControlBypass, shutoff]),
  category('Fluid Power: Actuators & Pumps', [cylSingle, cylDouble, cylDoubleRod, rotaryActuator, pumpFixed, pumpVariable, hydMotor, airMotor, compressor]),
  category('Fluid Power: Conditioning', [filter, filterDrain, lubricator, dryer, cooler, accumulator, reservoir, gauge, muffler, quickDisconnect, pressureSource]),
];

export const POWER_FLUID_SYMBOLS: BlockDef[] = POWER_FLUID_CATEGORIES.flatMap((c) => c.symbols);

/**
 * Block-name pattern -> tag prefix for the families this module adds.
 * Pass to `registerTagPrefixes()` (symbols.ts); registered rules are checked
 * before the built-in table, so the more specific patterns here (HCAP, HSST,
 * HRECT) override the built-in HCA / HSS / HRE matches. Specific fluid-power
 * patterns precede the catch-all /^HFP/.
 */
export const POWER_FLUID_TAG_PREFIXES: Array<[RegExp, string]> = [
  [/^HGEN/, 'GEN'],
  [/^HUTIL/, 'UTIL'],
  [/^HATS/, 'ATS'],
  [/^HMTS/, 'MTS'],
  [/^HPNL/, 'PNL'],
  [/^HBUS/, 'BUS'],
  [/^HCAP/, 'CAP'],
  [/^HPV/, 'PV'],
  [/^HCT/, 'CT'],
  [/^HPT/, 'PT'],
  [/^HMET/, 'MET'],
  [/^HKWH/, 'KWH'],
  [/^HSA/, 'SA'],
  [/^HTVSS/, 'SPD'],
  [/^HPR/, 'PR'],
  [/^HMTRP/, 'MTR'],
  [/^HVFD/, 'VFD'],
  [/^HSST/, 'SST'],
  [/^HLOAD/, 'LOAD'],
  [/^HUPS/, 'UPS'],
  [/^HRECT/, 'RECT'],
  [/^HINV/, 'INV'],
  [/^HFPCYL/, 'CYL'],
  [/^HFPV/, 'SV'],
  [/^HFP/, 'FP'],
];
