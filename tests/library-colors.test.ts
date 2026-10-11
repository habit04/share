/**
 * Colours of library symbols under the AutoCAD block colour rule (core/entities.ts
 * inheritedColor): the built-in libraries and the Symbol Builder draw symbol geometry ByBlock on
 * layer 0, so an insert's explicit colour recolours the symbol, while a block from another program
 * whose layer-0 content is ByLayer follows the insert's layer only. Symbols saved before the
 * libraries used ByBlock (user library records, blocks in saved drawings) are converted on load.
 */
import { describe, it, expect } from 'vitest';
import { readDxf, writeDxf } from '../src/io/dxf';
import { Drawing } from '../src/core/document';
import type { DrawingState } from '../src/core/document';
import { explodeInsert, BYBLOCK, type BlockDef, type Entity, type InsertEntity, type LineEntity } from '../src/core/entities';
import { resolveColor } from '../src/render/draw';
import { aciToCss } from '../src/render/palette';
import { LIBRARY_BLOCKS, findLibrarySymbol, withByBlockLibrarySymbols } from '../src/electrical/library';
import { WIRE_DOT } from '../src/electrical/symbols';
import { UserLibrary, memoryUserLibraryStore, parseUserLibraryDocument, serializeUserLibrary, validateUserSymbol } from '../src/electrical/userlib';
import { symbolGeometry, createTwin, blockToSymbolState } from '../src/electrical/symbol-builder-core';

const RED = aciToCss(1);
const GREEN = aciToCss(3);
const BLUE = aciToCss(5);
const layers = [
  { name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 },
  { name: 'SYMS', color: 3, visible: true, locked: false, lineWeight: 0.25 },
  { name: 'OTHER', color: 5, visible: true, locked: false, lineWeight: 0.25 },
];
const insert = (block: string, color: 'ByLayer' | number, layer = 'SYMS'): InsertEntity => ({ id: `i-${block}-${color}`, layer, color, type: 'insert', block, position: { x: 1, y: 2 }, rotation: 0, scale: 1, attributes: {} });
/** Distinct display colours of the geometry (text and attribute texts included) an insert shows. */
const shown = (ins: InsertEntity, s: DrawingState): string[] => [...new Set(explodeInsert(ins, (n) => s.blocks[n]).map((e) => resolveColor(e, s.layers)))];
const roundTrip = (s: DrawingState): DrawingState => readDxf(writeDxf(s));

describe('built-in symbols are ByBlock on layer 0', () => {
  it('every library block draws its geometry ByBlock or in an explicit colour', () => {
    const offenders = LIBRARY_BLOCKS.flatMap((b) => b.entities.filter((e) => e.color === 'ByLayer').map((e) => `${b.name}:${e.type}`));
    expect(offenders).toEqual([]);
    expect(WIRE_DOT.entities.every((e) => e.color === BYBLOCK)).toBe(true);
  });

  for (const name of ['HPB11_NO', 'IEC_K_NO', 'VPB11_NO']) {
    it(`${name}: an explicit insert colour recolours it, a ByLayer insert shows its layer colour, also after a round trip`, () => {
      const block = findLibrarySymbol(name)!;
      const state: DrawingState = { entities: [insert(name, 1), insert(name, 'ByLayer'), insert(name, 'ByLayer', 'OTHER')], layers, blocks: { [name]: block }, currentLayer: '0' };
      for (const s of [state, roundTrip(state)]) {
        const [red, green, blue] = s.entities as InsertEntity[];
        expect(shown(red!, s)).toEqual([RED]);
        expect(shown(green!, s)).toEqual([GREEN]);
        expect(shown(blue!, s)).toEqual([BLUE]);
      }
    });
  }
});

describe('a block from another CAD program with layer-0 ByLayer content', () => {
  // As AutoCAD writes a plain block: LINE on layer 0, colour 256 (ByLayer).
  const dxf = ['0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '8', '0', '2', 'CADSYM', '70', '0', '10', '0', '20', '0', '30', '0', '3', 'CADSYM', '0', 'LINE', '8', '0', '62', '256', '10', '0', '20', '0', '30', '0', '11', '1', '21', '0', '31', '0', '0', 'ENDBLK', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', '0', 'ENDSEC', '0', 'EOF'].join('\n');
  const base = readDxf(dxf);
  const state: DrawingState = { ...base, layers, entities: [insert('CADSYM', 1), insert('CADSYM', 'ByLayer', 'OTHER')] };

  it('follows the insert layer, not the insert colour (AutoCAD behaviour), also after a round trip', () => {
    for (const s of [state, roundTrip(state)]) {
      expect(s.blocks.CADSYM!.entities[0]!.color).toBe('ByLayer');
      const [red, other] = s.entities as InsertEntity[];
      expect(shown(red!, s)).toEqual([GREEN]); // on SYMS: the layer's green, the explicit red is ignored
      expect(shown(other!, s)).toEqual([BLUE]);
    }
  });

  it('is not converted by the library migration (only library symbol names are)', () => {
    expect(withByBlockLibrarySymbols(state)).toBe(state);
  });
});

describe('symbols saved before the libraries used ByBlock', () => {
  const oldLine = (id: string): LineEntity => ({ id, layer: '0', color: 'ByLayer', type: 'line', a: { x: -0.375, y: 0 }, b: { x: 0.375, y: 0 } });
  const oldDef = (name: string, extra: Entity[] = []): BlockDef => ({ name, basePoint: { x: 0, y: 0 }, entities: [oldLine(`${name}-1`), ...extra], attributes: [] });

  it('a drawing with an old copy of a built-in symbol is converted when loaded, other blocks untouched', () => {
    const red: LineEntity = { ...oldLine('x'), color: 1 };
    const onLayer: LineEntity = { ...oldLine('y'), layer: 'OTHER' };
    const state: DrawingState = {
      entities: [insert('HPB11_NO', 1)],
      layers,
      blocks: { HPB11_NO: oldDef('HPB11_NO', [red, onLayer]), TITLEBOX: oldDef('TITLEBOX') },
      currentLayer: '0',
    };
    const out = withByBlockLibrarySymbols(state);
    expect(out.blocks.HPB11_NO!.entities.map((e) => e.color)).toEqual([BYBLOCK, 1, 'ByLayer']);
    expect(out.blocks.TITLEBOX).toBe(state.blocks.TITLEBOX);
    expect(shown(out.entities[0] as InsertEntity, out)).toEqual([RED, BLUE]);
    // Nothing to convert: the same state object comes back (no spurious change).
    expect(withByBlockLibrarySymbols(out)).toBe(out);
    // Through the editor's load path as well.
    const d = new Drawing();
    d.load(withByBlockLibrarySymbols(state), '/x/old.dxf');
    expect(d.lookupBlock('HPB11_NO')!.entities[0]!.color).toBe(BYBLOCK);
  });

  it('user library records without the flag are read as ByBlock and flagged; flagged records are taken as they are', () => {
    const entry = (name: string, extra: Record<string, unknown> = {}) => ({ block: oldDef(name), standard: 'JIC', category: 'c', family: 'PB', ...extra });
    const old = validateUserSymbol(entry('OLD1'));
    expect(old.block.entities[0]!.color).toBe(BYBLOCK);
    expect(old.byBlockColors).toBe(true);
    const flagged = validateUserSymbol(entry('NEW1', { byBlockColors: true }));
    expect(flagged.block.entities[0]!.color).toBe('ByLayer');
    // Explicit colours and other layers are never touched.
    const mixed = validateUserSymbol({ ...entry('MIX1'), block: oldDef('MIX1', [{ ...oldLine('m2'), color: 4 }, { ...oldLine('m3'), layer: 'A' }]) });
    expect(mixed.block.entities.map((e) => e.color)).toEqual([BYBLOCK, 4, 'ByLayer']);
    // The flag is written with the record, so the next load keeps the geometry as stored.
    const again = parseUserLibraryDocument(serializeUserLibrary([old])).symbols[0]!;
    expect(again.byBlockColors).toBe(true);
    expect(again.block.entities[0]!.color).toBe(BYBLOCK);
  });

  it('loading an old library does not rewrite the file; the next change writes the flag', async () => {
    const store = memoryUserLibraryStore();
    const text = JSON.stringify({ format: 'jcad-user-library', version: 1, symbols: [{ block: oldDef('OLD2'), standard: 'JIC', category: 'c', family: 'PB' }] });
    store.json = text;
    const lib = new UserLibrary(store);
    expect(await lib.load()).toBe(1);
    expect(lib.get('OLD2')!.block.entities[0]!.color).toBe(BYBLOCK);
    expect(store.json).toBe(text);
    lib.put({ block: oldDef('NEW2'), standard: 'JIC', category: 'c', family: 'PB' });
    await lib.flush();
    const saved = JSON.parse(store.json!) as { symbols: Array<{ block: { name: string; entities: Array<{ color: unknown }> }; byBlockColors?: boolean }> };
    expect(saved.symbols.map((s) => [s.block.name, s.byBlockColors, s.block.entities[0]!.color]).sort()).toEqual([
      ['NEW2', true, 'ByLayer'],
      ['OLD2', true, 0],
    ]);
  });
});

describe('Symbol Builder output', () => {
  it('normalises symbol geometry to ByBlock on layer 0, keeping explicit colours', () => {
    const state = blockToSymbolState(findLibrarySymbol('HPB11_NO')!).state;
    const drawn: Entity[] = [
      { id: 'a', layer: 'OTHER', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
      { id: 'b', layer: '0', color: 4, type: 'line', a: { x: 0, y: 0 }, b: { x: 0, y: 1 } },
    ];
    const geometry = symbolGeometry({ ...state, entities: [...state.entities, ...drawn] });
    expect(geometry.every((e) => e.layer === '0')).toBe(true);
    expect(geometry.map((e) => e.color)).toContain(BYBLOCK);
    expect(geometry.map((e) => e.color)).toContain(4);
    expect(geometry.map((e) => e.color)).not.toContain('ByLayer');
  });

  it('the generated NC twin draws its blade ByBlock', () => {
    const sym = blockToSymbolState(findLibrarySymbol('HPB11_NO')!);
    const twin = createTwin(sym);
    expect(twin.state.entities.filter((e) => e.layer === '0').every((e) => e.color === BYBLOCK || typeof e.color === 'number')).toBe(true);
  });
});
