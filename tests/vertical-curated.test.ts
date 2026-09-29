/**
 * Curated vertical symbols (VPB11_NO next to HPB11_NO ...): shape, data parity
 * with the horizontal twin, icon-menu resolution with the generated fallback,
 * wire breaking and NO / NC toggling.
 */
import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/document';
import type { BlockDef, InsertEntity, LineEntity } from '../src/core/entities';
import { newId, entityBounds } from '../src/core/entities';
import { VERTICAL_SYMBOLS, LIBRARY_SYMBOLS, LIBRARY_BLOCKS, findLibrarySymbol, libraryCategories, curatedVerticalOf, withoutUnusedLibraryBlocks, isBuiltinSymbol } from '../src/electrical/library';
import { tagPrefix } from '../src/electrical/symbols';
import { isCoilBlock, isChildBlock, toggleVariant, horizontalTwinName } from '../src/electrical/families';
import { isVerticalBlock, pinAttributes, verticalVariantName } from '../src/electrical/attributes';
import { geometryMaxX } from '../src/electrical/symbol-kit';
import { breakForInsert, connectsVertically, staleDots } from '../src/electrical/wires';
import { resolveSymbolPick } from '../src/tools/electrical';

const wire = (x1: number, y1: number, x2: number, y2: number): LineEntity => ({ id: newId(), layer: 'WIRES', color: 'ByLayer', type: 'line', a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });
const twinOf = (v: BlockDef): BlockDef => findLibrarySymbol(horizontalTwinName(v.name)!)!;
const wd = (b: BlockDef) => b.attributes.find((a) => a.tag === 'WDTYPE')?.default;
const pinDefaults = (b: BlockDef) => pinAttributes(b).map((a) => a.default).sort();

describe('curated vertical symbols', () => {
  it('ships about forty curated JIC and IEC twins, all resolvable and outside the icon-menu categories', () => {
    expect(VERTICAL_SYMBOLS.length).toBeGreaterThanOrEqual(40);
    expect(VERTICAL_SYMBOLS.some((s) => s.name.startsWith('IEC_'))).toBe(true);
    const names = VERTICAL_SYMBOLS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    const listed = new Set([...libraryCategories('JIC'), ...libraryCategories('IEC')].flatMap((c) => c.symbols.map((s) => s.name)));
    for (const v of VERTICAL_SYMBOLS) {
      expect(findLibrarySymbol(v.name), v.name).toBe(v);
      expect(isBuiltinSymbol(v.name)).toBe(true);
      expect(listed.has(v.name), `${v.name} is not an icon-menu entry`).toBe(false);
      expect(LIBRARY_SYMBOLS.includes(v)).toBe(false);
      expect(LIBRARY_BLOCKS.includes(v)).toBe(true);
    }
  });

  it('keeps the family, WDTYPE, role and pin numbers of the horizontal twin', () => {
    for (const v of VERTICAL_SYMBOLS) {
      const h = twinOf(v);
      expect(h, `${v.name} has a horizontal twin`).toBeDefined();
      expect(verticalVariantName(h.name)).toBe(v.name);
      expect(curatedVerticalOf(h.name)).toBe(v);
      expect(tagPrefix(v.name), v.name).toBe(tagPrefix(h.name));
      expect(wd(v), v.name).toBe(wd(h));
      expect(isCoilBlock(v.name), v.name).toBe(isCoilBlock(h.name));
      expect(isChildBlock(v.name), v.name).toBe(isChildBlock(h.name));
      expect(pinDefaults(v), v.name).toEqual(pinDefaults(h));
      expect(pinAttributes(v).length).toBe(pinAttributes(h).length);
      // the visible attribute set is the same (TAG1 + DESC1, or TERM01 for terminals)
      const vis = (b: BlockDef) => b.attributes.filter((a) => !a.invisible).map((a) => a.tag).sort();
      expect(vis(v), v.name).toEqual(vis(h));
    }
  });

  it('connects only at the top and bottom with the stubs ending exactly on the pins', () => {
    for (const v of VERTICAL_SYMBOLS) {
      expect(isVerticalBlock(v), v.name).toBe(true);
      const pins = pinAttributes(v);
      pins.forEach((p, i) => {
        expect(Math.abs(p.position.y), `${v.name} ${p.tag}`).toBeCloseTo(0.375, 9);
        expect(p.tag.startsWith(p.position.y > 0 ? 'X2' : 'X8')).toBe(true);
        expect(p.tag.endsWith(String(i + 1).padStart(2, '0'))).toBe(true);
        const stub = v.entities.some((e) => e.type === 'line' && [e.a, e.b].some((q) => Math.abs(q.x - p.position.x) < 1e-9 && Math.abs(q.y - p.position.y) < 1e-9));
        expect(stub, `${v.name}: a line ends on ${p.tag}`).toBe(true);
      });
      // pins numbered top to bottom
      const ys = pins.map((p) => p.position.y);
      expect([...ys].sort((a, b) => b - a)).toEqual(ys);
      // nothing sticks out above / below the pins (the wire break would leave a gap or an overlap)
      for (const e of v.entities) {
        const b = entityBounds(e, () => undefined);
        if (!b || e.type === 'text') continue;
        expect(b.max.y, `${v.name} ${e.type}`).toBeLessThanOrEqual(0.375 + 1e-9);
        expect(b.min.y, `${v.name} ${e.type}`).toBeGreaterThanOrEqual(-0.375 - 1e-9);
      }
      // the base point sits on a connection column
      expect(pins.some((p) => Math.abs(p.position.x) < 1e-9)).toBe(true);
    }
  });

  it('puts TAG1 / DESC1-3 (TERM01) left-justified to the right of the geometry', () => {
    for (const v of VERTICAL_SYMBOLS) {
      const right = geometryMaxX(v.entities);
      const vis = v.attributes.filter((a) => ['TAG1', 'DESC1', 'DESC2', 'DESC3', 'TERM01'].includes(a.tag));
      expect(vis.length).toBeGreaterThan(0);
      for (const a of vis) {
        expect(a.align, `${v.name} ${a.tag}`).toBe('left');
        expect(a.rotation ?? 0).toBe(0);
        expect(a.position.x, `${v.name} ${a.tag} clears the geometry`).toBeGreaterThanOrEqual(right + 0.05 - 1e-9);
      }
      const tag = v.attributes.find((a) => a.tag === 'TAG1');
      const desc = v.attributes.find((a) => a.tag === 'DESC1');
      if (tag && desc) expect(tag.position.y - (desc.position.y + desc.height)).toBeGreaterThan(0.02);
      // DESC2 / DESC3 stack under DESC1 in the same column
      const d2 = v.attributes.find((a) => a.tag === 'DESC2');
      if (desc && d2) {
        expect(d2.position.x).toBe(desc.position.x);
        expect(d2.position.y).toBeLessThan(desc.position.y);
      }
    }
  });

  it('is what the Vertical orientation inserts, with the generated twin as the fallback', () => {
    const d = new Drawing();
    for (const v of VERTICAL_SYMBOLS) {
      const h = twinOf(v);
      const r = resolveSymbolPick(d, { name: h.name, orientation: 'V' })!;
      expect(r.def, h.name).toBe(v);
      expect(r.note).toBe(`Vertical: ${v.name} inserted for ${h.name}.`);
    }
    const gen = resolveSymbolPick(d, { name: 'HPX11_NO', orientation: 'V' })!;
    expect(gen.def.name).toBe('VPX11_NO');
    expect(gen.note).toMatch(/rotated -90/);
    // a curated twin picked by its own name is inserted as is
    expect(resolveSymbolPick(d, { name: 'VCR1_NO', orientation: 'V' })!.note).toBeNull();
  });

  it('breaks a vertical wire exactly at its pins', () => {
    for (const v of VERTICAL_SYMBOLS) {
      const d = new Drawing();
      d.ensureBlocks(LIBRARY_BLOCKS);
      const cols = [...new Set(pinAttributes(v).map((p) => p.position.x))];
      const wires = cols.map((x) => wire(4 + x, 9, 4 + x, 5));
      d.addEntities(wires);
      const ins: InsertEntity = { id: newId(), layer: 'SYMS', color: 'ByLayer', type: 'insert', block: v.name, position: { x: 4, y: 7 }, rotation: 0, scale: 1, attributes: {} };
      expect(connectsVertically(ins, d.lookupBlock), v.name).toBe(true);
      const after = breakForInsert([...d.entities, ins], ins, d.lookupBlock);
      for (const x of cols) {
        const pieces = after.filter((e): e is LineEntity => e.type === 'line' && e.layer === 'WIRES' && Math.abs(e.a.x - (4 + x)) < 1e-9);
        expect(pieces.length, `${v.name} column ${x}`).toBe(2);
        const ends = pieces.map((w) => [Math.max(w.a.y, w.b.y), Math.min(w.a.y, w.b.y)]).sort((a, b) => b[0]! - a[0]!);
        expect(ends[0]![1]).toBeCloseTo(7.375, 9);
        expect(ends[1]![0]).toBeCloseTo(6.625, 9);
      }
      expect(staleDots(after)).toEqual([]);
    }
  });

  it('toggles NO / NC between vertical twins', () => {
    const exists = (n: string) => findLibrarySymbol(n) !== undefined;
    expect(toggleVariant('VPB11_NO', exists)).toBe('VPB12_NC');
    expect(toggleVariant('VPB12_NC', exists)).toBe('VPB11_NO');
    expect(toggleVariant('VCR1_NO', exists)).toBe('VCR1_NC');
    expect(toggleVariant('VLS11_NO', exists)).toBe('VLS12_NC');
    expect(toggleVariant('IEC_K_NO_V', exists)).toBe('IEC_K_NC_V');
    expect(toggleVariant('IEC_K_NC_V', exists)).toBe('IEC_K_NO_V');
    expect(toggleVariant('VCR1', exists)).toBeNull();
  });

  it('is dropped from saved drawings when unused, like every library block', () => {
    const d = new Drawing();
    d.ensureBlocks(LIBRARY_BLOCKS);
    d.addEntities([{ id: 'i1', layer: '0', color: 'ByLayer', type: 'insert', block: 'VPB11_NO', position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {} }]);
    expect(Object.keys(withoutUnusedLibraryBlocks(d.snapshot).blocks)).toEqual(['VPB11_NO']);
  });
});
