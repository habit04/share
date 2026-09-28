import { describe, it, expect, afterEach } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import type { AttributeDef, BlockDef, Entity, InsertEntity, LineEntity, TextEntity } from '../src/core/entities';
import { newId } from '../src/core/entities';
import { findSymbol, tagPrefix } from '../src/electrical/symbols';
import { connectionPoints } from '../src/electrical/attributes';
import { isCoilBlock, isChildBlock, toggleVariant } from '../src/electrical/families';
import { libraryCategories, libraryCategoryNames, findLibrarySymbol, searchLibrary, librarySummary, withoutUnusedLibraryBlocks, isLibrarySymbol, LIBRARY_BLOCKS } from '../src/electrical/library';
import { userLibrary, UserLibrary, memoryUserLibraryStore, localUserLibraryStore, parseUserLibrary, symbolToDxf, USER_LIBRARY_KEY, type UserSymbol } from '../src/electrical/userlib';
import {
  blockToSymbolState,
  symbolStateToBlock,
  harvestBlock,
  fromSelection,
  compilePins,
  checkSymbol,
  blankSymbolState,
  defaultMeta,
  placeholderEntity,
  pinMarkerEntity,
  suggestSymbolName,
  resolveBasePoint,
  boundsOfEntities,
  SYMATTR_LAYER,
  SYMPIN_LAYER,
  wdtypeFor,
  markerTag,
  markerDefault,
  type SymbolMeta,
} from '../src/electrical/symbol-builder-core';
import { validBlockName } from '../src/tools/blocks';
import { ComponentTool } from '../src/tools/electrical';
import { ToggleNcTool } from '../src/tools/electrical-wires';
import { readDxf } from '../src/io/dxf';
import { fakeContext, drive } from './fake-context';

const line = (x1: number, y1: number, x2: number, y2: number, layer = '0'): LineEntity => ({ id: newId(), layer, color: 'ByLayer', type: 'line', a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });
const attr = (tag: string, x: number, y: number, extra: Partial<AttributeDef> = {}): AttributeDef => ({ tag, prompt: tag, default: '', position: { x, y }, height: 0.1, align: 'center', ...extra });
const byTag = (b: BlockDef) => Object.fromEntries(b.attributes.map((a) => [a.tag, a]));
const geometryKey = (e: Entity) => {
  const { id: _id, ...rest } = e as Entity & { id: string };
  return JSON.stringify(rest);
};

/** A user-made push button: stubs to +-0.375 and a body, TAG1 / DESC1 placeholders. */
function makeUserPushButton(name = 'USER_PB1'): { state: DrawingState; meta: SymbolMeta } {
  const base = blankSymbolState();
  const entities: Entity[] = [line(-0.375, 0, -0.125, 0), line(0.125, 0, 0.375, 0), line(-0.125, -0.1, -0.125, 0.1), line(0.125, -0.1, 0.125, 0.1), placeholderEntity('TAG1'), placeholderEntity('DESC1')];
  return { state: { ...base, entities }, meta: defaultMeta({ name, family: 'PB', category: 'Test symbols', description: 'Test push button' }) };
}

// Every test that touches the shared registry starts from an empty library.
afterEach(async () => {
  for (const n of userLibrary.names()) userLibrary.remove(n);
  await userLibrary.flush();
});

describe('symbol builder conversion', () => {
  it('round-trips a library symbol: block -> editing state -> block keeps geometry, attributes and pins', () => {
    for (const name of ['HPB11_NO', 'HCR1', 'HCR1_NC', 'HT0001', 'HGND', 'HXF1', 'HPLCI']) {
      const src = findSymbol(name)!;
      const sym = blockToSymbolState(src);
      // geometry keeps every primitive, placeholders / markers live on their own layers
      expect(sym.state.entities.filter((e) => e.layer === '0').map(geometryKey).sort()).toEqual([...src.entities].map(geometryKey).sort());
      const visible = src.attributes.filter((a) => !a.invisible).map((a) => a.tag).sort();
      expect(sym.state.entities.filter((e): e is TextEntity => e.type === 'text' && e.layer === SYMATTR_LAYER).map((t) => t.text).sort()).toEqual(visible);
      const pinTags = src.attributes.filter((a) => /^X[1248]TERM/.test(a.tag)).map((a) => a.tag).sort();
      expect(sym.state.entities.filter((e): e is TextEntity => e.type === 'text' && e.layer === SYMPIN_LAYER).map((t) => markerTag(t.text)).sort()).toEqual(pinTags);

      const back = symbolStateToBlock(sym.state, sym.meta);
      expect(back.name).toBe(name);
      expect(back.description).toBe(src.description);
      expect(back.entities.map(geometryKey).sort()).toEqual([...src.entities].map(geometryKey).sort());
      const a = byTag(src);
      const b = byTag(back);
      expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
      for (const tag of Object.keys(a)) {
        expect(b[tag]!.position.x, `${name} ${tag} x`).toBeCloseTo(a[tag]!.position.x, 6);
        expect(b[tag]!.position.y, `${name} ${tag} y`).toBeCloseTo(a[tag]!.position.y, 6);
        expect(!!b[tag]!.invisible, `${name} ${tag} invisible`).toBe(!!a[tag]!.invisible);
        if (/^X[1248]TERM|^WDTYPE$/.test(tag)) expect(b[tag]!.default, `${name} ${tag} default`).toBe(a[tag]!.default);
        if (!a[tag]!.invisible) {
          expect(b[tag]!.height).toBeCloseTo(a[tag]!.height, 6);
          expect(b[tag]!.align).toBe(a[tag]!.align);
        }
      }
    }
  });

  it('recognises the symbol kind of library blocks and compiles the matching WDTYPE', () => {
    expect(blockToSymbolState(findSymbol('HCR1')!).meta.kind).toBe('parent');
    expect(blockToSymbolState(findSymbol('HCR1_NC')!).meta).toMatchObject({ kind: 'child', contact: 'NC' });
    expect(blockToSymbolState(findSymbol('HT0001')!).meta.kind).toBe('terminal');
    expect(blockToSymbolState(findSymbol('HPLCI')!).meta.kind).toBe('plc');
    expect(wdtypeFor('parent', 'CR')).toBe('COIL');
    expect(wdtypeFor('standalone', 'pb')).toBe('PB');
    const { state, meta } = makeUserPushButton();
    const coil = symbolStateToBlock(state, { ...meta, kind: 'parent' });
    expect(byTag(coil).WDTYPE!.default).toBe('COIL');
    const term = symbolStateToBlock({ ...state, entities: [...state.entities.filter((e) => e.layer !== SYMATTR_LAYER), placeholderEntity('TERM01')] }, { ...meta, kind: 'terminal' });
    expect(byTag(term).TERM01).toBeDefined();
    expect(byTag(term).TAGSTRIP).toBeDefined();
    expect(byTag(term).WDTYPE!.default).toBe('TERM');
  });

  it('compiles a user symbol: geometry on layer 0, placeholders -> visible attributes, geometry connections -> pins with family defaults', () => {
    const { state, meta } = makeUserPushButton();
    const block = symbolStateToBlock(state, meta);
    expect(block.entities).toHaveLength(4);
    expect(block.entities.every((e) => e.layer === '0' && e.color === 'ByLayer')).toBe(true);
    const t = byTag(block);
    expect(t.TAG1).toMatchObject({ prompt: 'Component tag', position: { x: 0, y: 0.3 } });
    expect(t.TAG1!.invisible).toBeFalsy();
    expect(t.DESC1!.prompt).toBe('Description');
    expect(t.X1TERM01).toMatchObject({ default: '3', invisible: true, position: { x: -0.375, y: 0 } });
    expect(t.X4TERM02).toMatchObject({ default: '4', invisible: true, position: { x: 0.375, y: 0 } });
    for (const tag of ['INST', 'LOC', 'MFG', 'CAT', 'ASSYCODE', 'RATING1', 'RATING2', 'WDTYPE', 'DESC2', 'DESC3']) expect(t[tag], tag).toBeDefined();
    expect(t.WDTYPE!.default).toBe('PB');
    // the same connection points the library derives
    expect(connectionPoints(block).map((c) => c.tag)).toEqual(['X1TERM01', 'X4TERM02']);
    // an explicitly coloured entity keeps its colour
    const red = symbolStateToBlock({ ...state, entities: [{ ...state.entities[0]!, color: 1 }, ...state.entities.slice(1)] }, meta);
    expect(red.entities[0]!.color).toBe(1);
  });

  it('numbers explicit pins with the geometry connections top-to-bottom, left before right, and keeps their default numbers', () => {
    const { state, meta } = makeUserPushButton('USER_CR1');
    const top = pinMarkerEntity(2, { x: 0, y: 0.2 }, 9, 'A1');
    const bottom = pinMarkerEntity(8, { x: 0, y: -0.2 }, 9, 'A2');
    const st = { ...state, entities: [...state.entities, top, bottom] };
    const m: SymbolMeta = { ...meta, family: 'CR' };
    const pins = compilePins(st, m);
    expect(pins.map((p) => [p.tag, p.default])).toEqual([
      ['X2TERM01', 'A1'],
      ['X1TERM02', 'A1'],
      ['X4TERM03', 'A2'],
      ['X8TERM04', 'A2'],
    ]);
    const block = symbolStateToBlock(st, m);
    expect(block.attributes.filter((a) => /^X[1248]TERM/.test(a.tag))).toHaveLength(4);
    // an explicit marker on a geometry connection replaces the auto pin (no duplicate) and wins the number
    const left = pinMarkerEntity(1, { x: -0.375, y: 0 }, 1, '21');
    const st2 = { ...state, entities: [...state.entities, left] };
    const pins2 = compilePins(st2, meta);
    expect(pins2.map((p) => [p.tag, p.default, p.markerId !== undefined])).toEqual([
      ['X1TERM01', '21', true],
      ['X4TERM02', '4', false],
    ]);
  });

  it('harvests a drawing block: nested insert exploded, known attributes -> placeholders / pins, base point and scale applied', () => {
    const inner: BlockDef = { name: 'MFR_CONTACT', basePoint: { x: 0, y: 0 }, entities: [line(0, -0.5, 0, 0.5), line(1, -0.5, 1, 0.5)], attributes: [] };
    const nested: InsertEntity = { id: 'n1', layer: '0', color: 'ByLayer', type: 'insert', block: 'MFR_CONTACT', position: { x: 2, y: 1 }, rotation: 0, scale: 2, attributes: {} };
    const outer: BlockDef = {
      name: 'MFR_PB',
      description: 'Vendor push button',
      basePoint: { x: 1, y: 1 },
      entities: [line(0, 1, 2, 1), nested, line(4, 1, 6, 1)],
      attributes: [attr('TAG1', 3, 3, { height: 0.5 }), attr('X1TERM01', 0, 1, { invisible: true, default: '13' }), attr('PARTNO', 3, -1, { default: 'PB-100' }), attr('SECRET', 3, -2, { invisible: true, default: 'x' })],
    };
    const state: DrawingState = { entities: [], layers: [], blocks: { MFR_CONTACT: inner, MFR_PB: outer }, currentLayer: '0' };
    // Without options the block base point becomes the origin and nothing is scaled.
    const plain = harvestBlock(state, 'MFR_PB')!;
    expect(plain.meta).toMatchObject({ name: 'MFR_PB', description: 'Vendor push button' });
    const lines = plain.state.entities.filter((e): e is LineEntity => e.type === 'line');
    expect(lines).toHaveLength(4); // 2 outer lines + 2 from the exploded nested block
    expect(plain.state.entities.some((e) => e.type === 'insert')).toBe(false);
    expect(lines.map((l) => l.a.x).sort((a, b) => a - b)[0]).toBeCloseTo(-1);
    // nested block scaled x2 at (2,1): its lines are at x = 2 and 4 -> shifted by the base point (1,1) -> 1 and 3, spanning y -1..1
    const nestedLines = lines.filter((l) => Math.abs(l.a.x - l.b.x) < 1e-9);
    expect(nestedLines.map((l) => l.a.x).sort((a, b) => a - b)).toEqual([1, 3]);
    expect(Math.abs(nestedLines[0]!.a.y - nestedLines[0]!.b.y)).toBeCloseTo(2);
    const tag = plain.state.entities.find((e): e is TextEntity => e.type === 'text' && e.layer === SYMATTR_LAYER);
    expect(tag).toMatchObject({ text: 'TAG1', position: { x: 2, y: 2 } });
    const pin = plain.state.entities.find((e): e is TextEntity => e.type === 'text' && e.layer === SYMPIN_LAYER)!;
    expect(pin).toMatchObject({ text: 'X1TERM01=13', position: { x: -1, y: 0 } });
    expect(markerDefault(pin.text)).toBe('13');
    expect(plain.meta.attrDefaults.SECRET).toBe('x'); // invisible vendor attribute default is kept
    const partno = plain.state.entities.find((e): e is TextEntity => e.type === 'text' && e.layer === '0');
    expect(partno?.text).toBe('PB-100'); // unknown visible attribute keeps its text
    expect(plain.state.entities.some((e) => e.type === 'text' && e.text === 'x')).toBe(false);

    // Scaled to the inline width about the centre of the geometry.
    const center = resolveBasePoint('center', outer.entities, (n) => state.blocks[n], outer.basePoint);
    expect(center).toEqual({ x: 3, y: 1 });
    const scaled = harvestBlock(state, 'MFR_PB', { basePoint: center, scaleToWidth: 0.75 })!;
    const sb = boundsOfEntities(scaled.state.entities.filter((e) => e.layer === '0'), () => undefined)!;
    expect(sb.max.x - sb.min.x).toBeCloseTo(0.75, 6);
    expect(sb.min.x).toBeCloseTo(-0.375, 6);
    expect(sb.max.x).toBeCloseTo(0.375, 6);
    const scaledTag = scaled.state.entities.find((e): e is TextEntity => e.type === 'text' && e.layer === SYMATTR_LAYER)!;
    expect(scaledTag.position.x).toBeCloseTo(0, 6); // (3,3) -> centre (3,1) -> (0, 2) * 0.125
    expect(scaledTag.position.y).toBeCloseTo(0.25, 6);
    expect(scaledTag.height).toBeCloseTo(0.0625, 6); // 0.5 * 0.125 stays within the readable clamp
    // The harvested symbol compiles to a block with its wire connections.
    const block = symbolStateToBlock(scaled.state, { ...scaled.meta, family: 'PB' });
    expect(block.attributes.some((a) => a.tag === 'X1TERM01' && a.default === '13')).toBe(true);
    expect(harvestBlock(state, 'NOPE')).toBeNull();
  });

  it('builds a symbol from selected objects relative to a base point', () => {
    const doc = new Drawing();
    doc.ensureBlocks(LIBRARY_BLOCKS);
    const ins: InsertEntity = { id: 'i', layer: 'SYMS', color: 'ByLayer', type: 'insert', block: 'HCR1_NO', position: { x: 5, y: 3 }, rotation: 0, scale: 1, attributes: { TAG1: 'CR1' } };
    const ents: Entity[] = [line(4, 3.5, 6, 3.5), ins];
    const sym = fromSelection(ents, { x: 5, y: 3 }, doc.lookupBlock);
    const ln = sym.state.entities.find((e): e is LineEntity => e.type === 'line' && Math.abs(e.a.y - e.b.y) < 1e-9 && Math.abs(e.a.x - e.b.x) > 1.5)!;
    expect(ln.a).toEqual({ x: -1, y: 0.5 });
    expect(sym.state.entities.some((e) => e.type === 'insert')).toBe(false);
    expect(sym.state.entities.some((e) => e.type === 'text' && e.text === 'CR1')).toBe(true);
    const scaled = fromSelection(ents, { x: 5, y: 3 }, doc.lookupBlock, { scaleToWidth: 0.75 });
    const b = boundsOfEntities(scaled.state.entities, () => undefined)!;
    expect(b.max.x - b.min.x).toBeCloseTo(0.75, 6);
  });

  it('validates a symbol (name, connections, attributes, extents)', () => {
    const opts = { isBuiltin: (n: string) => !!findSymbol(n), isUser: () => false, validName: validBlockName };
    const { state, meta } = makeUserPushButton();
    expect(checkSymbol(state, meta, opts).map((m) => m.level)).toEqual(['ok']);
    const collide = checkSymbol(state, { ...meta, name: 'HPB11_NO' }, opts);
    expect(collide.some((m) => m.level === 'error' && /built-in/.test(m.text))).toBe(true);
    const bad = checkSymbol(state, { ...meta, name: 'A/B' }, opts);
    expect(bad.some((m) => m.level === 'error' && /valid block name/.test(m.text))).toBe(true);
    const empty = checkSymbol(blankSymbolState(), meta, opts);
    expect(empty.filter((m) => m.level === 'error').length).toBeGreaterThanOrEqual(3);
    const noTag = checkSymbol({ ...state, entities: state.entities.filter((e) => !(e.type === 'text' && e.text === 'TAG1')) }, meta, opts);
    expect(noTag.some((m) => m.level === 'error' && /TAG1/.test(m.text))).toBe(true);
    const far = checkSymbol({ ...state, entities: [...state.entities, line(0, 0, 3, 0)] }, meta, opts);
    expect(far.some((m) => m.level === 'error' && /2 in/.test(m.text))).toBe(true);
    const offInline = checkSymbol({ ...state, entities: [line(-0.2, 0, 0.2, 0), pinMarkerEntity(2, { x: 0, y: 0.2 }, 1), placeholderEntity('TAG1')] }, meta, opts);
    expect(offInline.some((m) => m.level === 'warning' && /0\.375/.test(m.text))).toBe(true);
    const child = checkSymbol(state, { ...meta, kind: 'child', name: 'USER_CONTACT' }, opts);
    expect(child.some((m) => m.level === 'warning' && /_NO or _NC/.test(m.text))).toBe(true);
    expect(suggestSymbolName('PB', (n) => n === 'USER_PB1')).toBe('USER_PB2');
  });
});

describe('user symbol library', () => {
  it('adds, updates, removes and persists through the store', async () => {
    const store = memoryUserLibraryStore();
    const lib = new UserLibrary(store);
    const { state, meta } = makeUserPushButton('TEST_PB1');
    const block = symbolStateToBlock(state, meta);
    const entry = lib.put({ block, standard: 'JIC', category: 'Test symbols', family: 'pb', wdtype: 'PB' });
    expect(entry.family).toBe('PB');
    expect(lib.size).toBe(1);
    expect(lib.get('test_pb1')?.block.name).toBe('TEST_PB1');
    expect(lib.categories('JIC')).toEqual(['Test symbols']);
    expect(lib.categoriesOf('JIC')[0]!.name).toBe('User: Test symbols');
    expect(lib.categoriesOf('IEC')).toEqual([]);
    await lib.flush();
    expect(store.json).toContain('"TEST_PB1"');
    // update keeps the creation time
    const later = lib.put({ block: { ...block, description: 'changed' }, standard: 'JIC', category: 'Other', family: 'PB', created: entry.created });
    expect(later.created).toBe(entry.created);
    expect(lib.get('TEST_PB1')?.block.description).toBe('changed');
    expect(lib.categories('JIC')).toEqual(['Other']);
    // reload from the store
    const lib2 = new UserLibrary(store);
    await lib.flush();
    expect(await lib2.load()).toBe(1);
    expect(lib2.get('TEST_PB1')?.category).toBe('Other');
    expect(lib.rename('TEST_PB1', 'TEST_PB2')).toBe(true);
    expect(lib.has('TEST_PB1')).toBe(false);
    expect(lib.get('TEST_PB2')?.block.name).toBe('TEST_PB2');
    expect(lib.remove('TEST_PB2')).toBe(true);
    expect(lib.remove('TEST_PB2')).toBe(false);
    await lib.flush();
    expect(JSON.parse(store.json!).symbols).toEqual([]);
  });

  it('falls back to a localStorage-style store and imports / exports JSON', async () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    const lib = new UserLibrary(localUserLibraryStore(storage));
    const { state, meta } = makeUserPushButton('TEST_LS1');
    lib.put({ block: symbolStateToBlock(state, meta), standard: 'IEC', category: 'Local', family: 'S' });
    await lib.flush();
    expect(map.has(USER_LIBRARY_KEY)).toBe(true);
    const json = lib.exportJson();
    expect(parseUserLibrary(json)).toHaveLength(1);
    expect(parseUserLibrary(json)[0]!.standard).toBe('IEC');
    const other = new UserLibrary(memoryUserLibraryStore());
    expect(other.importJson(json)).toEqual({ added: 1, updated: 0, skipped: 0, reserved: 0, rejected: [] });
    expect(other.importJson(json, { replace: false })).toEqual({ added: 0, updated: 0, skipped: 1, reserved: 0, rejected: [] });
    expect(other.importJson(json)).toEqual({ added: 0, updated: 1, skipped: 0, reserved: 0, rejected: [] });
    expect(() => parseUserLibrary('not json')).toThrow();
    expect(() => parseUserLibrary('[{"bogus":1}]')).toThrow();
    expect(parseUserLibrary('[]')).toEqual([]);
    // a fresh library on the same storage sees the symbol
    const again = new UserLibrary(localUserLibraryStore(storage));
    expect(await again.load()).toBe(1);
  });

  it('exports a symbol as a DXF block file (definition plus one insert at the origin)', () => {
    const { state, meta } = makeUserPushButton('TEST_DXF1');
    const block = symbolStateToBlock(state, meta);
    const dxf = symbolToDxf(block);
    const back = readDxf(dxf);
    expect(back.blocks.TEST_DXF1).toBeDefined();
    expect(back.blocks.TEST_DXF1!.entities).toHaveLength(4);
    expect(back.blocks.TEST_DXF1!.attributes.some((a) => a.tag === 'X1TERM01' && a.invisible)).toBe(true);
    const ins = back.entities.find((e): e is InsertEntity => e.type === 'insert');
    expect(ins?.block).toBe('TEST_DXF1');
    expect(ins?.position).toEqual({ x: 0, y: 0 });
  });
});

describe('user symbols in the library and the insert tools', () => {
  function addUserSymbol(name = 'USER_PB9', extra: Partial<UserSymbol> = {}): UserSymbol {
    const { state, meta } = makeUserPushButton(name);
    return userLibrary.put({ block: symbolStateToBlock(state, meta), standard: 'JIC', category: 'My symbols', family: 'PB', ...extra });
  }

  it('shows the User: category before the built-ins and finds / searches / tags user symbols', () => {
    const before = libraryCategories('JIC').length;
    addUserSymbol();
    const cats = libraryCategories('JIC');
    expect(cats).toHaveLength(before + 1);
    expect(cats[0]!.name).toBe('User: My symbols');
    expect(cats[0]!.symbols.map((s) => s.name)).toEqual(['USER_PB9']);
    expect(libraryCategories('IEC').some((c) => c.name.startsWith('User:'))).toBe(false);
    expect(libraryCategoryNames('JIC')).toContain('My symbols');
    expect(libraryCategoryNames('JIC')).toContain('Push Buttons');
    expect(findLibrarySymbol('USER_PB9')?.description).toBe('Test push button');
    expect(findLibrarySymbol('user_pb9')?.name).toBe('USER_PB9');
    expect(isLibrarySymbol('USER_PB9')).toBe(true);
    expect(searchLibrary('JIC', 'test push').map((s) => s.name)).toContain('USER_PB9');
    expect(searchLibrary('JIC', 'my symbols').map((s) => s.name)).toContain('USER_PB9');
    expect(librarySummary().user).toBe(1);
    expect(tagPrefix('USER_PB9')).toBe('PB');
    // a family change re-registers the prefix
    addUserSymbol('USER_PB9', { family: 'SS' });
    expect(tagPrefix('USER_PB9')).toBe('SS');
    userLibrary.remove('USER_PB9');
    expect(tagPrefix('USER_PB9')).toBe('DEV');
    expect(findLibrarySymbol('USER_PB9')).toBeUndefined();
    expect(libraryCategories('JIC')).toHaveLength(before);
  });

  it('registers coil / contact roles so cross-referencing and Toggle NO/NC treat user symbols like built-ins', () => {
    addUserSymbol('USER_K1', { family: 'K', wdtype: 'COIL' });
    addUserSymbol('USER_K1_NO', { family: 'K', wdtype: 'CONTACT' });
    addUserSymbol('USER_K1_NC', { family: 'K', wdtype: 'CONTACT' });
    expect(isCoilBlock('USER_K1')).toBe(true);
    expect(isChildBlock('USER_K1_NO')).toBe(true);
    expect(isCoilBlock('USER_K1_NO')).toBe(false);
    expect(toggleVariant('USER_K1_NO', (n) => !!findLibrarySymbol(n))).toBe('USER_K1_NC');
    userLibrary.remove('USER_K1');
    expect(isCoilBlock('USER_K1')).toBe(false);
  });

  it('inserts a user symbol with the component tool, defining its block in the drawing', () => {
    addUserSymbol('USER_PB7');
    const doc = new Drawing();
    const ctx = fakeContext(doc);
    ctx.ui.pickSymbol = async () => 'USER_PB7';
    ctx.ui.editComponent = async (init) => ({ tag: init.tag || 'PB1', desc: 'USER MADE', mfg: '', cat: '' });
    const tool = new ComponentTool();
    tool.start(ctx);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(doc.blocks.USER_PB7).toBeDefined();
        tool.onPoint({ x: 4, y: 2 }, ctx);
        setTimeout(() => {
          const ins = doc.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === 'USER_PB7');
          expect(ins).toBeDefined();
          expect(ins!.attributes.TAG1).toBe('PB1');
          expect(ins!.attributes.DESC1).toBe('USER MADE');
          expect(ctx.finished).toBe(true);
          // the saved drawing keeps the user block it references and drops an unused one
          doc.ensureBlocks([addUserSymbol('USER_UNUSED').block]);
          const slim = withoutUnusedLibraryBlocks(doc.snapshot);
          expect(Object.keys(slim.blocks)).toContain('USER_PB7');
          expect(Object.keys(slim.blocks)).not.toContain('USER_UNUSED');
          resolve();
        }, 0);
      }, 0);
    });
  });

  it('toggles NO/NC between user contact variants and defines the counterpart block', () => {
    addUserSymbol('USER_LS1_NO', { family: 'LS' });
    addUserSymbol('USER_LS1_NC', { family: 'LS' });
    const doc = new Drawing();
    doc.ensureBlocks([userLibrary.get('USER_LS1_NO')!.block]);
    const ins: InsertEntity = { id: 'c1', layer: 'SYMS', color: 'ByLayer', type: 'insert', block: 'USER_LS1_NO', position: { x: 1, y: 1 }, rotation: 0, scale: 1, attributes: { TAG1: 'LS1', X1TERM01: '13', X4TERM02: '14' } };
    doc.addEntities([ins]);
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['c1']);
    drive(new ToggleNcTool(), ctx, []);
    const after = doc.entity('c1') as InsertEntity;
    expect(after.block).toBe('USER_LS1_NC');
    expect(after.attributes.X1TERM01).toBe('11');
    expect(doc.blocks.USER_LS1_NC).toBeDefined();
  });
});
