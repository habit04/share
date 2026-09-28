import { describe, it, expect } from 'vitest';
import type { Entity } from '../src/core/entities';
import { ALL_SYMBOLS, registerTagPrefixes, tagPrefix } from '../src/electrical/symbols';
import { IEC_SYMBOLS } from '../src/electrical/iec';
import { IEC_EXTENDED_CATEGORIES, IEC_EXTENDED_SYMBOLS, IEC_EXTENDED_TAG_PREFIXES } from '../src/electrical/iec-extended';
import { connectionPoints } from '../src/electrical/attributes';

registerTagPrefixes(IEC_EXTENDED_TAG_PREFIXES);

const byName = (name: string) => {
  const s = IEC_EXTENDED_SYMBOLS.find((b) => b.name === name);
  if (!s) throw new Error(`missing symbol ${name}`);
  return s;
};
const attr = (name: string, tag: string) => byName(name).attributes.find((a) => a.tag === tag);

/** Every coordinate an entity carries (line ends, centres, polyline vertices, text positions). */
function coordinates(e: Entity): number[] {
  switch (e.type) {
    case 'line':
      return [e.a.x, e.a.y, e.b.x, e.b.y];
    case 'circle':
    case 'arc':
      return [e.center.x, e.center.y, e.radius];
    case 'polyline':
      return e.points.flatMap((p) => [p.x, p.y]);
    case 'text':
      return [e.position.x, e.position.y, e.height];
    default:
      throw new Error(`unexpected entity type ${e.type} in a symbol`);
  }
}

/** Families the IEC letter codes map to; the second segment of every block name is its family. */
const FAMILIES = new Set(['S', 'B', 'K', 'KA', 'KM', 'KT', 'Q', 'F', 'P', 'M', 'X', 'Y', 'G', 'T', 'R', 'C', 'L', 'V', 'E', 'H', 'U', 'W', 'A', 'PE']);

describe('IEC extended symbol library', () => {
  it('provides at least 70 symbols in 8-12 categories of 5-12 symbols', () => {
    expect(IEC_EXTENDED_SYMBOLS.length).toBeGreaterThanOrEqual(70);
    expect(IEC_EXTENDED_CATEGORIES.length).toBeGreaterThanOrEqual(8);
    expect(IEC_EXTENDED_CATEGORIES.length).toBeLessThanOrEqual(12);
    for (const c of IEC_EXTENDED_CATEGORIES) {
      expect(c.name.startsWith('IEC: '), `${c.name} is not prefixed 'IEC: '`).toBe(true);
      expect(c.symbols.length, `${c.name} has ${c.symbols.length} symbols`).toBeGreaterThanOrEqual(5);
      expect(c.symbols.length, `${c.name} has ${c.symbols.length} symbols`).toBeLessThanOrEqual(12);
    }
    expect(IEC_EXTENDED_SYMBOLS).toEqual(IEC_EXTENDED_CATEGORIES.flatMap((c) => c.symbols));
  });

  it('uses unique uppercase IEC_ names that do not collide with the core or IEC libraries', () => {
    const names = IEC_EXTENDED_SYMBOLS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    const taken = new Set([...ALL_SYMBOLS, ...IEC_SYMBOLS].map((s) => s.name));
    for (const n of names) {
      expect(n, `${n} is not an uppercase IEC_ block name`).toMatch(/^IEC_[A-Z0-9_]+$/);
      expect(taken.has(n), `${n} already exists in another library`).toBe(false);
    }
    for (const s of IEC_EXTENDED_SYMBOLS) {
      expect(s.description, `${s.name} description`).toMatch(/\(IEC\)$/);
      expect(s.basePoint).toEqual({ x: 0, y: 0 });
      expect(s.entities.length).toBeGreaterThan(0);
    }
  });

  it('carries the ACADE attribute set and wire-connection attributes on every symbol', () => {
    for (const s of IEC_EXTENDED_SYMBOLS) {
      const tags = s.attributes.map((a) => a.tag);
      expect(new Set(tags).size, `${s.name} has duplicate attribute tags`).toBe(tags.length);
      expect(tags.some((t) => /^X[1248]TERM\d\d$/.test(t)), `${s.name} has no wire connection attribute`).toBe(true);
      if (tags.includes('TAG1')) for (const t of ['INST', 'LOC', 'MFG', 'CAT', 'ASSYCODE', 'RATING1', 'WDTYPE', 'DESC2', 'DESC3']) expect(tags, `${s.name} lacks ${t}`).toContain(t);
      for (const a of s.attributes) if (/^(INST|LOC|MFG|CAT|X\dTERM)/.test(a.tag)) expect(a.invisible, `${a.tag} on ${s.name} should be invisible`).toBe(true);
      // One pin attribute per derived connection point, and no stray pin attributes.
      const pins = connectionPoints(s).map((c) => c.tag).sort();
      expect(tags.filter((t) => /^X[1248]TERM\d\d$/.test(t)).sort(), `${s.name} pin attributes do not match its connection points`).toEqual(pins);
      // Inline symbols connect exactly on the symbol edge.
      for (const c of connectionPoints(s)) if (c.dir === 1 || c.dir === 4) expect(Math.abs(c.point.x)).toBeCloseTo(0.375, 6);
    }
  });

  it('keeps every coordinate finite and inside the symbol envelope', () => {
    for (const s of IEC_EXTENDED_SYMBOLS) {
      // Pole 1 sits on the base point and poles are 0.5 apart, so the 4-pole breaker reaches y = -1.5.
      const bound = s.name === 'IEC_Q_MCB4' ? 1.6 : 1.2;
      for (const e of s.entities) {
        expect(e.layer).toBe('0');
        for (const v of coordinates(e)) {
          expect(Number.isFinite(v), `${s.name} has a non-finite coordinate`).toBe(true);
          expect(Math.abs(v), `${s.name} coordinate ${v} outside the envelope`).toBeLessThanOrEqual(bound);
        }
        if (e.type === 'line') expect(Math.hypot(e.a.x - e.b.x, e.a.y - e.b.y), `${s.name} has a zero-length line`).toBeGreaterThan(1e-6);
      }
      for (const a of s.attributes) {
        expect(Number.isFinite(a.position.x) && Number.isFinite(a.position.y), `${s.name}.${a.tag} position`).toBe(true);
        expect(Math.abs(a.position.x)).toBeLessThanOrEqual(1.2);
        expect(Math.abs(a.position.y), `${s.name}.${a.tag} y`).toBeLessThanOrEqual(2.1);
      }
    }
    const ids = IEC_EXTENDED_SYMBOLS.flatMap((s) => s.entities.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves every block name to its intended family once the extra prefixes are registered', () => {
    for (const s of IEC_EXTENDED_SYMBOLS) {
      const family = s.name.split('_')[1]!;
      expect(FAMILIES.has(family), `${s.name} uses an unknown family segment ${family}`).toBe(true);
      expect(tagPrefix(s.name), `${s.name} tag prefix`).not.toBe('DEV');
      expect(tagPrefix(s.name), `${s.name} tag prefix`).toBe(family);
    }
    expect(tagPrefix('IEC_H_LAMP_YE')).toBe('H');
    expect(tagPrefix('IEC_U_VFD')).toBe('U');
    expect(tagPrefix('IEC_W_PE_BAR')).toBe('W');
    expect(tagPrefix('IEC_A_HMI')).toBe('A');
    expect(tagPrefix('IEC_B_PROX_IND_NO')).toBe('B');
    expect(tagPrefix('IEC_KA_COIL')).toBe('KA');
    expect(tagPrefix('IEC_K_LATCH')).toBe('K');
    expect(tagPrefix('IEC_KM_MAIN3')).toBe('KM');
    expect(tagPrefix('IEC_KT_STAR')).toBe('KT');
    expect(tagPrefix('IEC_PE_FRAME')).toBe('PE');
    expect(tagPrefix('IEC_E_LAMP')).toBe('E');
    expect(tagPrefix('IEC_C_POL')).toBe('C');
    // The existing core rules still apply to the original IEC library.
    expect(tagPrefix('IEC_K_NO')).toBe('K');
    expect(tagPrefix('IEC_P_LAMP')).toBe('P');
  });

  it('gives contacts, coils, terminals and PLC points their WDTYPE and pin defaults', () => {
    for (const s of IEC_EXTENDED_SYMBOLS) {
      const wd = attr(s.name, 'WDTYPE')?.default;
      if (/_NC$/.test(s.name)) {
        expect(attr(s.name, 'X1TERM01')?.default, `${s.name} NC pin 1`).toBe('11');
        expect(attr(s.name, 'X4TERM02')?.default, `${s.name} NC pin 2`).toBe('12');
      }
      if (/^IEC_(K|KA|KT|KM)_/.test(s.name) && /_N[OC]$/.test(s.name)) expect(wd, `${s.name} WDTYPE`).toBe('CONTACT');
      if (/^IEC_X_TERM/.test(s.name)) {
        expect(wd, `${s.name} WDTYPE`).toBe('TERM');
        expect(s.attributes.some((a) => a.tag === 'TERM01')).toBe(true);
        expect(s.attributes.some((a) => a.tag === 'TAGSTRIP')).toBe(true);
      }
      if (/^IEC_A_PLC_/.test(s.name)) expect(wd, `${s.name} WDTYPE`).toBe('PLC');
    }
    expect(attr('IEC_S_PB_IL_NO', 'X1TERM01')?.default).toBe('13');
    expect(attr('IEC_S_PB_IL_NO', 'X4TERM02')?.default).toBe('14');
    for (const coil of ['IEC_KA_COIL', 'IEC_K_LATCH', 'IEC_K_CNT', 'IEC_K_SAFETY', 'IEC_KT_STAR', 'IEC_KT_CYC']) {
      expect(attr(coil, 'WDTYPE')?.default, `${coil} WDTYPE`).toBe('COIL');
    }
    expect(attr('IEC_KA_COIL', 'X1TERM01')?.default).toBe('A1');
    expect(attr('IEC_KA_COIL', 'X4TERM02')?.default).toBe('A2');
    expect(attr('IEC_KM_MAIN3', 'WDTYPE')?.default).toBe('CONTACT');
    expect(connectionPoints(byName('IEC_KM_MAIN3')).map((c) => c.tag)).toEqual(['X1TERM01', 'X4TERM02', 'X1TERM03', 'X4TERM04', 'X1TERM05', 'X4TERM06']);
    expect(['X1TERM01', 'X4TERM02', 'X1TERM03', 'X4TERM04', 'X1TERM05', 'X4TERM06'].map((t) => attr('IEC_KM_MAIN3', t)?.default)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(connectionPoints(byName('IEC_Q_MCB4'))).toHaveLength(8);
    expect(connectionPoints(byName('IEC_M_3_UVW')).map((c) => attr('IEC_M_3_UVW', c.tag)?.default)).toEqual(['U', 'V', 'W']);
    expect(connectionPoints(byName('IEC_T_CTRL')).map((c) => attr('IEC_T_CTRL', c.tag)?.default)).toEqual(['H1', 'H2', 'X1', 'X2']);
    expect(connectionPoints(byName('IEC_V_NPN')).map((c) => attr('IEC_V_NPN', c.tag)?.default)).toEqual(['C', 'B', 'E']);
    expect(connectionPoints(byName('IEC_PE_FRAME')).map((c) => c.tag)).toEqual(['X2TERM01']);
    expect(connectionPoints(byName('IEC_A_PLC_DI')).map((c) => c.tag)).toEqual(['X1TERM01']);
    expect(connectionPoints(byName('IEC_A_PLC_DO')).map((c) => c.tag)).toEqual(['X4TERM01']);
    expect(connectionPoints(byName('IEC_Q_CO'))).toHaveLength(3);
  });
});
