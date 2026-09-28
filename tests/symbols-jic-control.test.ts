import { describe, it, expect } from 'vitest';
import type { Entity } from '../src/core/entities';
import { ALL_SYMBOLS, tagPrefix, registerTagPrefixes } from '../src/electrical/symbols';
import { IEC_SYMBOLS } from '../src/electrical/iec';
import { connectionPoints } from '../src/electrical/attributes';
import { JIC_CONTROL_CATEGORIES, JIC_CONTROL_SYMBOLS, JIC_CONTROL_TAG_PREFIXES, findJicControlSymbol } from '../src/electrical/symbols-jic-control';

registerTagPrefixes(JIC_CONTROL_TAG_PREFIXES);

/** Every coordinate an entity touches (line ends, circle/arc extents, polyline vertices, text insertion). */
function coords(e: Entity): number[] {
  switch (e.type) {
    case 'line':
      return [e.a.x, e.a.y, e.b.x, e.b.y];
    case 'circle':
    case 'arc':
      return [e.center.x - e.radius, e.center.x + e.radius, e.center.y - e.radius, e.center.y + e.radius, e.radius];
    case 'polyline':
      return e.points.flatMap((p) => [p.x, p.y]);
    case 'text':
      return [e.position.x, e.position.y, e.height];
    default:
      return [];
  }
}

describe('JIC control symbol library', () => {
  it('provides at least 70 symbols in 8-12 categories of 5-12 symbols each', () => {
    expect(JIC_CONTROL_SYMBOLS.length).toBeGreaterThanOrEqual(70);
    expect(JIC_CONTROL_CATEGORIES.length).toBeGreaterThanOrEqual(8);
    expect(JIC_CONTROL_CATEGORIES.length).toBeLessThanOrEqual(12);
    for (const c of JIC_CONTROL_CATEGORIES) {
      expect(c.name.length, 'category has a name').toBeGreaterThan(0);
      expect(c.symbols.length, `${c.name} size`).toBeGreaterThanOrEqual(5);
      expect(c.symbols.length, `${c.name} size`).toBeLessThanOrEqual(12);
    }
    expect(JIC_CONTROL_CATEGORIES.flatMap((c) => c.symbols)).toEqual(JIC_CONTROL_SYMBOLS);
  });

  it('uses unique uppercase H-prefixed names that do not collide with the JIC or IEC libraries', () => {
    const names = JIC_CONTROL_SYMBOLS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    const taken = new Set([...ALL_SYMBOLS, ...IEC_SYMBOLS].map((s) => s.name));
    for (const n of names) {
      expect(n, `${n} should be uppercase and start with H`).toMatch(/^H[A-Z0-9_]+$/);
      expect(taken.has(n), `${n} already exists in another library`).toBe(false);
    }
    expect(findJicControlSymbol('HPE11_NO')?.description).toBe('Photo eye, through-beam, normally open');
    expect(findJicControlSymbol('NOPE')).toBeUndefined();
  });

  it('every symbol has a description, geometry and the ACADE attribute set', () => {
    for (const s of JIC_CONTROL_SYMBOLS) {
      expect((s.description ?? '').length, `${s.name} description`).toBeGreaterThan(3);
      expect(s.entities.length, `${s.name} has geometry`).toBeGreaterThan(0);
      expect(s.basePoint).toEqual({ x: 0, y: 0 });
      const tags = s.attributes.map((a) => a.tag);
      expect(new Set(tags).size, `${s.name} has duplicate attribute tags`).toBe(tags.length);
      expect(tags.some((t) => /^X[1248]TERM\d\d$/.test(t)), `${s.name} has no wire connection attribute`).toBe(true);
      expect(connectionPoints(s).length, `${s.name} connection points`).toBeGreaterThanOrEqual(1);
      if (tags.includes('TAG1')) for (const t of ['INST', 'LOC', 'MFG', 'CAT', 'ASSYCODE', 'RATING1', 'WDTYPE', 'DESC2', 'DESC3']) expect(tags, `${s.name} lacks ${t}`).toContain(t);
      for (const a of s.attributes) if (/^(INST|LOC|MFG|CAT|X\dTERM)/.test(a.tag)) expect(a.invisible, `${a.tag} on ${s.name} should be invisible`).toBe(true);
    }
  });

  it('inline symbols connect at x = +-0.375 and the wire stubs are on the symbol edge', () => {
    for (const s of JIC_CONTROL_SYMBOLS) {
      for (const c of connectionPoints(s)) {
        if (c.dir === 1) expect(c.point.x, `${s.name} ${c.tag}`).toBeCloseTo(-0.375, 6);
        if (c.dir === 4) expect(c.point.x, `${s.name} ${c.tag}`).toBeCloseTo(0.375, 6);
        if (c.dir === 2) expect(c.point.x, `${s.name} ${c.tag}`).toBeCloseTo(0, 6);
      }
    }
    // Two-terminal inline devices connect once on each side.
    for (const n of ['HPB14_NO', 'HKS11_NO', 'HPE11_NO', 'HSR1', 'HLR1_NC', 'HBK1', 'HCT3', 'HLED1', 'HPW1']) {
      expect(connectionPoints(findJicControlSymbol(n)!).map((c) => c.dir), n).toEqual([1, 4]);
    }
    // Multi-wire devices.
    expect(connectionPoints(findJicControlSymbol('HXT1')!)).toHaveLength(4);
    expect(connectionPoints(findJicControlSymbol('HPT3')!)).toHaveLength(4);
    expect(connectionPoints(findJicControlSymbol('HT0002')!)).toHaveLength(4);
    // Vertical-only grounds connect at the base point from above.
    expect(connectionPoints(findJicControlSymbol('HGND3')!).map((c) => c.tag)).toEqual(['X2TERM01']);
    expect(connectionPoints(findJicControlSymbol('HGND4')!).map((c) => c.tag)).toEqual(['X2TERM01']);
  });

  it('every block name resolves to a real tag prefix (never DEV)', () => {
    for (const s of JIC_CONTROL_SYMBOLS) expect(tagPrefix(s.name), `${s.name} has no tag prefix`).not.toBe('DEV');
    // New families resolve through the registered table.
    expect(tagPrefix('HPE11_NO')).toBe('PE');
    expect(tagPrefix('HSR1_NC')).toBe('SR');
    expect(tagPrefix('HHMI1')).toBe('HMI');
    // Reused families resolve through the built-in table.
    expect(tagPrefix('HPB14_NO')).toBe('PB');
    expect(tagPrefix('HTD3')).toBe('TD');
    expect(tagPrefix('HT0002')).toBe('TB');
  });

  it('new tag-prefix patterns are unambiguous and never shadow existing library names', () => {
    const existing = [...ALL_SYMBOLS, ...IEC_SYMBOLS].map((s) => s.name);
    for (const [re, family] of JIC_CONTROL_TAG_PREFIXES) {
      expect(family).toMatch(/^[A-Z]+$/);
      for (const n of existing) expect(re.test(n), `${re} matches existing symbol ${n}`).toBe(false);
      // Each pattern matches at least one symbol of this library.
      expect(JIC_CONTROL_SYMBOLS.some((s) => re.test(s.name)), `${re} matches no symbol`).toBe(true);
    }
    // No symbol name matches two different families.
    for (const s of JIC_CONTROL_SYMBOLS) {
      const hits = JIC_CONTROL_TAG_PREFIXES.filter(([re]) => re.test(s.name));
      expect(hits.length, `${s.name} matches ${hits.map(([re]) => String(re)).join(', ')}`).toBeLessThanOrEqual(1);
    }
    const families = new Set(JIC_CONTROL_TAG_PREFIXES.map(([, f]) => f));
    expect(families.size).toBe(JIC_CONTROL_TAG_PREFIXES.length);
  });

  it('keeps all geometry finite and within the symbol envelope', () => {
    for (const s of JIC_CONTROL_SYMBOLS) {
      for (const e of s.entities) {
        const cs = coords(e);
        expect(cs.length, `${s.name} has an unexpected entity type ${e.type}`).toBeGreaterThan(0);
        for (const v of cs) {
          expect(Number.isFinite(v), `${s.name} ${e.type} ${e.id} has a non-finite coordinate`).toBe(true);
          expect(Math.abs(v), `${s.name} ${e.type} ${e.id} out of range`).toBeLessThanOrEqual(1.2);
        }
        if (e.type === 'arc') {
          expect(e.startAngle).toBeLessThan(e.endAngle);
          expect(e.radius).toBeGreaterThan(0);
        }
        if (e.type === 'circle') expect(e.radius).toBeGreaterThan(0);
        if (e.type === 'text') expect(e.text.length).toBeGreaterThan(0);
      }
      for (const a of s.attributes) {
        expect(Math.abs(a.position.x), `${s.name} ${a.tag}`).toBeLessThanOrEqual(1.2);
        expect(Math.abs(a.position.y), `${s.name} ${a.tag}`).toBeLessThanOrEqual(1.2);
      }
    }
  });

  it('gives contacts their NO/NC pin defaults and pairs every _NC with a _NO where one exists', () => {
    const names = new Set(JIC_CONTROL_SYMBOLS.map((s) => s.name));
    for (const s of JIC_CONTROL_SYMBOLS) {
      const pin1 = s.attributes.find((a) => a.tag === 'X1TERM01');
      if (s.name.endsWith('_NC')) {
        expect(pin1?.default, `${s.name} pin 1`).toBe('11');
        expect(s.attributes.find((a) => a.tag === 'X4TERM02')?.default, `${s.name} pin 2`).toBe('12');
      }
      if (s.name.endsWith('_NO')) expect(pin1?.default, `${s.name} pin 1`).toBe('13');
    }
    // Relay-style devices: coils and contacts carry the ACADE WDTYPE codes.
    const wd = (n: string) => findJicControlSymbol(n)!.attributes.find((a) => a.tag === 'WDTYPE')!.default;
    for (const n of ['HSR1', 'HLR1', 'HLR1U', 'HAR1', 'HCN1', 'HPM1', 'HTD3', 'HTD4']) expect(wd(n), n).toBe('COIL');
    for (const n of ['HSR1_NO', 'HSR1_NC', 'HLR1_NO', 'HLR1_NC', 'HAR1_NO', 'HCN1_NO', 'HCN1_NC', 'HPM1_NO', 'HPM1_NC']) expect(wd(n), n).toBe('CONTACT');
    for (const n of ['HT0002', 'HT0003', 'HT0004', 'HT0005']) {
      expect(wd(n), n).toBe('TERM');
      expect(findJicControlSymbol(n)!.attributes.some((a) => a.tag === 'TERM01'), n).toBe(true);
      expect(findJicControlSymbol(n)!.attributes.some((a) => a.tag === 'TAGSTRIP'), n).toBe(true);
    }
    for (const n of ['HPLCR', 'HPLCAO', 'HPLCPS']) expect(wd(n), n).toBe('PLC');
    // Every NC pilot device / contact in this library has an NO partner (AETOGGLENC), and vice versa.
    for (const n of names) {
      if (n.endsWith('_NC') || n.endsWith('_NO')) {
        const partner = n.endsWith('_NC') ? n.replace(/_NC$/, '_NO') : n.replace(/_NO$/, '_NC');
        // Numbered pilot devices use adjacent numbers for the pair (HPE11_NO / HPE12_NC).
        const shifted = (d: number) => partner.replace(/(\d)(_N[OC])$/, (_m, k: string, sfx: string) => `${Number(k) + d}${sfx}`);
        const single = ['HPB19_NO', 'HPB21_NC', 'HPB22_NO', 'HSM11_NC', 'HAR1_NO'];
        if (!single.includes(n)) expect([partner, shifted(1), shifted(-1)].some((c) => names.has(c)), `${n} has no NO/NC partner`).toBe(true);
      }
    }
  });
});
