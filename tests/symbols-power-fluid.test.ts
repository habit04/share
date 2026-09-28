import { describe, it, expect } from 'vitest';
import type { BlockDef, Entity } from '../src/core/entities';
import { POWER_FLUID_CATEGORIES, POWER_FLUID_SYMBOLS, POWER_FLUID_TAG_PREFIXES } from '../src/electrical/symbols-power-fluid';
import { ALL_SYMBOLS, registerTagPrefixes, tagPrefix } from '../src/electrical/symbols';
import { IEC_SYMBOLS } from '../src/electrical/iec';
import { connectionPoints } from '../src/electrical/attributes';

const attr = (s: BlockDef, tag: string) => s.attributes.find((a) => a.tag === tag);
const byName = (name: string): BlockDef => {
  const s = POWER_FLUID_SYMBOLS.find((b) => b.name === name);
  if (!s) throw new Error(`missing symbol ${name}`);
  return s;
};

/** Every coordinate an entity touches (arc / circle extents included). */
function coords(e: Entity): number[] {
  switch (e.type) {
    case 'line':
      return [e.a.x, e.a.y, e.b.x, e.b.y];
    case 'circle':
    case 'arc':
      return [e.center.x - e.radius, e.center.x + e.radius, e.center.y - e.radius, e.center.y + e.radius];
    case 'polyline':
      return e.points.flatMap((p) => [p.x, p.y]);
    case 'text':
      return [e.position.x, e.position.y];
    default:
      return [];
  }
}

describe('power / PLC / fluid-power symbol library', () => {
  it('ships at least 60 symbols in sensibly sized categories', () => {
    expect(POWER_FLUID_SYMBOLS.length).toBeGreaterThanOrEqual(60);
    expect(POWER_FLUID_CATEGORIES.length).toBeGreaterThanOrEqual(6);
    for (const c of POWER_FLUID_CATEGORIES) {
      expect(c.symbols.length, c.name).toBeGreaterThanOrEqual(5);
      expect(c.symbols.length, c.name).toBeLessThanOrEqual(12);
    }
    const domains = ['One-Line', 'PLC', 'Fluid Power'];
    for (const d of domains) expect(POWER_FLUID_CATEGORIES.some((c) => c.name.startsWith(d)), d).toBe(true);
  });

  it('uses unique block names that do not collide with the JIC or IEC libraries', () => {
    const names = POWER_FLUID_SYMBOLS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    const existing = new Set([...ALL_SYMBOLS, ...IEC_SYMBOLS].map((s) => s.name));
    for (const n of names) {
      expect(existing.has(n), `${n} collides with an existing symbol`).toBe(false);
      expect(n, `${n} should be an uppercase H-prefixed block name`).toMatch(/^H[A-Z0-9_]+$/);
      expect(n.toUpperCase()).toBe(n);
    }
    for (const s of POWER_FLUID_SYMBOLS) expect(s.description?.length ?? 0, s.name).toBeGreaterThan(3);
  });

  it('carries the ACADE attribute set and at least one wire connection per symbol', () => {
    for (const s of POWER_FLUID_SYMBOLS) {
      const tags = s.attributes.map((a) => a.tag);
      expect(tags.some((t) => /^X[1248]TERM\d\d$/.test(t)), `${s.name} has no wire connection attribute`).toBe(true);
      expect(tags).toContain('TAG1');
      expect(tags).toContain('DESC1');
      for (const t of ['INST', 'LOC', 'MFG', 'CAT', 'ASSYCODE', 'RATING1', 'WDTYPE', 'DESC2', 'DESC3']) expect(tags, `${s.name} lacks ${t}`).toContain(t);
      for (const a of s.attributes) if (/^(INST|LOC|MFG|CAT|X\dTERM)/.test(a.tag)) expect(a.invisible, `${a.tag} on ${s.name} should be invisible`).toBe(true);
      expect(new Set(tags).size, `${s.name} has duplicate attribute tags`).toBe(tags.length);
      expect(connectionPoints(s).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('derives the intended connection points from the geometry', () => {
    expect(connectionPoints(byName('HATS1')).map((p) => p.tag)).toEqual(['X1TERM01', 'X4TERM02', 'X1TERM03']);
    expect(connectionPoints(byName('HPLCDI8')).map((p) => p.dir)).toEqual(Array(8).fill(1));
    expect(connectionPoints(byName('HPLCDO16')).map((p) => p.dir)).toEqual(Array(16).fill(4));
    expect(connectionPoints(byName('HPLCMIX8'))).toHaveLength(8);
    expect(connectionPoints(byName('HPLCRTD4'))).toHaveLength(12);
    expect(connectionPoints(byName('HFPCYL1'))).toHaveLength(1);
    expect(connectionPoints(byName('HFPCYL2'))).toHaveLength(2);
    expect(connectionPoints(byName('HXFR4'))).toHaveLength(3);
    expect(connectionPoints(byName('HCTP1'))).toHaveLength(2);
    for (const n of ['HPTP1', 'HPR50', 'HSA1', 'HMET1', 'HFPTANK1', 'HFPGAUGE1', 'HLOAD1']) {
      const pts = connectionPoints(byName(n));
      expect(pts.map((p) => p.tag), n).toEqual(['X2TERM01']);
      expect(pts[0]!.point, n).toEqual({ x: 0, y: 0 });
    }
    // Inline symbols connect exactly on the symbol edge.
    for (const s of POWER_FLUID_SYMBOLS) for (const p of connectionPoints(s)) if (p.dir !== 2) expect(Math.abs(p.point.x), s.name).toBeCloseTo(0.375, 6);
  });

  it('resolves every block name to its intended family once the prefixes are registered', () => {
    registerTagPrefixes(POWER_FLUID_TAG_PREFIXES);
    // Specific overrides of the built-in prefix table.
    expect(tagPrefix('HCAP1')).toBe('CAP');
    expect(tagPrefix('HSST1')).toBe('SST');
    expect(tagPrefix('HRECT1')).toBe('RECT');
    expect(tagPrefix('HTVSS1')).toBe('SPD');
    expect(tagPrefix('HPTP1')).toBe('PT');
    expect(tagPrefix('HCTP1')).toBe('CT');
    expect(tagPrefix('HMTRP1')).toBe('MTR');
    expect(tagPrefix('HXFR1')).toBe('T');
    expect(tagPrefix('HCBP1')).toBe('CB');
    expect(tagPrefix('HDSF1')).toBe('DS');
    expect(tagPrefix('HFUP1')).toBe('FU');
    expect(tagPrefix('HPR50')).toBe('PR');
    expect(tagPrefix('HFPCYL2')).toBe('CYL');
    expect(tagPrefix('HFPV52')).toBe('SV');
    expect(tagPrefix('HFPPMP1')).toBe('FP');
    for (const s of POWER_FLUID_SYMBOLS) {
      expect(tagPrefix(s.name), s.name).not.toBe('DEV');
      if (s.name.startsWith('HPLC')) expect(tagPrefix(s.name), s.name).toBe('PLC');
      else if (s.name.startsWith('HFPV')) expect(tagPrefix(s.name), s.name).toBe('SV');
      else if (s.name.startsWith('HFPCYL')) expect(tagPrefix(s.name), s.name).toBe('CYL');
      else if (s.name.startsWith('HFP')) expect(tagPrefix(s.name), s.name).toBe('FP');
      // WDTYPE defaults to the family a symbol was built with, so it must agree with the prefix table.
      if (!s.name.startsWith('HPLC')) expect(attr(s, 'WDTYPE')!.default, `${s.name} family mismatch`).toBe(tagPrefix(s.name));
    }
    // The built-in table is unaffected for existing symbols.
    expect(tagPrefix('HCA1')).toBe('C');
    expect(tagPrefix('HSS11')).toBe('SS');
    expect(tagPrefix('HRE1')).toBe('R');
  });

  it('marks PLC symbols with WDTYPE PLC and everything else with its family', () => {
    for (const s of POWER_FLUID_SYMBOLS) {
      const wd = attr(s, 'WDTYPE')!.default;
      if (s.name.startsWith('HPLC')) expect(wd, s.name).toBe('PLC');
      else expect(wd, s.name).not.toBe('PLC');
    }
    expect(attr(byName('HFPV22'), 'X1TERM01')!.default).toBe('A1');
    expect(attr(byName('HXFR1'), 'X1TERM01')!.default).toBe('H1');
  });

  it('keeps all geometry compact and finite', () => {
    for (const s of POWER_FLUID_SYMBOLS) {
      expect(s.entities.length, s.name).toBeGreaterThan(0);
      const all = [...s.entities.flatMap(coords), ...s.attributes.flatMap((a) => [a.position.x, a.position.y])];
      for (const v of all) {
        expect(Number.isFinite(v), `${s.name} has a non-finite coordinate`).toBe(true);
        expect(Math.abs(v), `${s.name} exceeds the 1.5 in envelope`).toBeLessThanOrEqual(1.5);
      }
      const ids = s.entities.map((e) => e.id);
      expect(new Set(ids).size, `${s.name} has duplicate entity ids`).toBe(ids.length);
      for (const e of s.entities) if (e.type === 'text') expect(e.text.trim().length, s.name).toBeGreaterThan(0);
    }
    const allIds = POWER_FLUID_SYMBOLS.flatMap((s) => s.entities.map((e) => e.id));
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});
