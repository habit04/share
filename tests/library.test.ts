import { describe, it, expect, afterEach } from 'vitest';
import { JIC_LIBRARY, IEC_LIBRARY, LIBRARY_SYMBOLS, LIBRARY_BLOCKS, findLibrarySymbol, searchLibrary, librarySummary, libraryCategories, withoutUnusedLibraryBlocks, isLibrarySymbol } from '../src/electrical/library';
import { tagPrefix, WIRE_DOT } from '../src/electrical/symbols';
import { isCoilBlock, isChildBlock, toggleVariant } from '../src/electrical/families';
import { connectionPoints } from '../src/electrical/attributes';
import { userLibrary } from '../src/electrical/userlib';
import { Drawing } from '../src/core/document';
import type { BlockDef, InsertEntity, LineEntity } from '../src/core/entities';

const userBlock = (name: string): BlockDef => {
  const stub: LineEntity = { id: `${name}-l`, layer: '0', color: 'ByLayer', type: 'line', a: { x: -0.375, y: 0 }, b: { x: 0.375, y: 0 } };
  return { name, description: `${name} user symbol`, basePoint: { x: 0, y: 0 }, entities: [stub], attributes: [{ tag: 'TAG1', prompt: 'TAG', default: '', position: { x: 0, y: 0.2 }, height: 0.1, align: 'center' }] };
};
const insertOf = (id: string, block: string): InsertEntity => ({ id, layer: '0', color: 'ByLayer', type: 'insert', block, position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {} });

describe('aggregated symbol library', () => {
  it('holds the core and extended sets with unique block names', () => {
    const names = LIBRARY_SYMBOLS.map((s) => s.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes, `duplicate block names: ${dupes.join(', ')}`).toEqual([]);
    const sum = librarySummary();
    expect(sum.jic).toBeGreaterThanOrEqual(250);
    expect(sum.iec).toBeGreaterThanOrEqual(160);
    expect(sum.total).toBe(LIBRARY_SYMBOLS.length);
    expect(LIBRARY_BLOCKS).toContain(WIRE_DOT);
    for (const c of [...JIC_LIBRARY, ...IEC_LIBRARY]) expect(c.symbols.length, c.name).toBeGreaterThan(0);
  });
  it('resolves a family (tag prefix) for every symbol after the extended rules are registered', () => {
    const orphans = LIBRARY_SYMBOLS.filter((s) => tagPrefix(s.name) === 'DEV').map((s) => s.name);
    expect(orphans, `no tag prefix for: ${orphans.join(', ')}`).toEqual([]);
    expect(tagPrefix('HCAP1')).toBe('CAP');
    expect(tagPrefix('HCA1')).toBe('C');
    expect(tagPrefix('HSS11')).toBe('SS');
    expect(tagPrefix('HSST1')).toBe('SST');
    expect(tagPrefix('HPE11_NO')).toBe('PE');
    expect(tagPrefix('IEC_H_LAMP_RD')).toBe('H');
    expect(tagPrefix('IEC_K_LATCH')).toBe('K');
  });
  it('keeps every symbol insertable: wire connection attributes and finite geometry', () => {
    for (const s of LIBRARY_SYMBOLS) {
      expect(s.attributes.some((a) => /^X[1248]TERM\d\d$/.test(a.tag)), `${s.name} has no wire connection`).toBe(true);
      expect(connectionPoints(s).length, `${s.name} connection points`).toBeGreaterThan(0);
      for (const e of s.entities) {
        const json = JSON.stringify(e);
        expect(json.includes('null') || json.includes('NaN'), `${s.name} has bad coordinates`).toBe(false);
      }
    }
  });
  it('classifies the new coils and child contacts for cross-referencing', () => {
    for (const coil of ['HSR1', 'HLR1', 'HLR1U', 'HAR1', 'HCN1', 'HPM1', 'HTD3', 'IEC_KA_COIL', 'IEC_K_LATCH', 'IEC_K_SAFETY', 'IEC_KT_STAR']) {
      expect(findLibrarySymbol(coil), coil).toBeDefined();
      expect(isCoilBlock(coil), `${coil} is a coil`).toBe(true);
    }
    for (const child of ['HSR1_NO', 'HLR1_NC', 'HCN1_NO', 'HPM1_NC', 'IEC_KA_NO', 'IEC_K_SAFETY_NC', 'IEC_KT_STAR_Y_NC', 'IEC_KT_STAR_D_NO']) {
      expect(findLibrarySymbol(child), child).toBeDefined();
      expect(isChildBlock(child), `${child} is a child contact`).toBe(true);
      expect(isCoilBlock(child)).toBe(false);
    }
  });
  it('toggles NO/NC across the numbered pilot-device pairs', () => {
    const exists = (n: string) => findLibrarySymbol(n) !== undefined;
    expect(toggleVariant('HPE11_NO', exists)).toBe('HPE12_NC');
    expect(toggleVariant('HPE12_NC', exists)).toBe('HPE11_NO');
    expect(toggleVariant('HGS11_NC', exists)).toBe('HGS12_NO');
    expect(toggleVariant('HSR1_NO', exists)).toBe('HSR1_NC');
    expect(toggleVariant('IEC_S_PB_ILL_NO', exists) ?? toggleVariant('IEC_KA_NO', exists)).toBeTruthy();
  });
  it('searches by name, description and category', () => {
    expect(searchLibrary('JIC', 'photo').length).toBeGreaterThanOrEqual(4);
    expect(searchLibrary('IEC', 'lamp').length).toBeGreaterThanOrEqual(5);
    expect(searchLibrary('JIC', 'HFPV52').map((s) => s.name)).toContain('HFPV52');
    expect(searchLibrary('JIC', '')).toEqual([]);
    expect(findLibrarySymbol('hcr1_no')?.name).toBe('HCR1_NO');
  });
});

describe('library blocks in saved drawings', () => {
  it('drops unreferenced library blocks on write and keeps used and foreign ones', async () => {
    const { Drawing } = await import('../src/core/document');
    const { withoutUnusedLibraryBlocks } = await import('../src/electrical/library');
    const { writeDxf } = await import('../src/io/dxf');
    const d = new Drawing();
    d.ensureBlocks(LIBRARY_BLOCKS);
    d.ensureBlocks([{ name: 'USERBLOCK', description: 'mine', basePoint: { x: 0, y: 0 }, entities: [], attributes: [] }]);
    d.addEntities([{ id: 'i1', layer: '0', color: 'ByLayer', type: 'insert', block: 'HCR1_NO', position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {} }]);
    const slim = withoutUnusedLibraryBlocks(d.snapshot);
    expect(Object.keys(slim.blocks).sort()).toEqual(['HCR1_NO', 'USERBLOCK']);
    expect(writeDxf(slim).length).toBeLessThan(writeDxf(d.snapshot).length / 10);
    expect(withoutUnusedLibraryBlocks(slim)).toBe(slim);
  });
});

describe('user symbols in the aggregated library', () => {
  afterEach(async () => {
    for (const n of userLibrary.names()) userLibrary.remove(n);
    await userLibrary.flush();
  });

  it('lists the User: categories first, then the built-ins in their usual order', () => {
    expect(libraryCategories('JIC')).toEqual(JIC_LIBRARY);
    userLibrary.put({ block: userBlock('LIBT_PB1'), standard: 'JIC', category: 'Mine', family: 'PB' });
    userLibrary.put({ block: userBlock('LIBT_LT1'), standard: 'JIC', category: 'Also mine', family: 'LT' });
    userLibrary.put({ block: userBlock('LIBT_IEC1'), standard: 'IEC', category: 'IEC mine', family: 'S' });
    const jic = libraryCategories('JIC');
    expect(jic.slice(0, 2).map((c) => c.name)).toEqual(['User: Also mine', 'User: Mine']);
    expect(jic.slice(2)).toEqual(JIC_LIBRARY);
    const iec = libraryCategories('IEC');
    expect(iec[0]!.name).toBe('User: IEC mine');
    expect(iec.slice(1)).toEqual(IEC_LIBRARY);
    expect(iec.some((c) => c.name === 'User: Mine')).toBe(false);
    // the summary counts the user symbols with their standard and is otherwise unchanged
    const sum = librarySummary();
    expect(sum.user).toBe(3);
    expect(sum.jic).toBe(JIC_LIBRARY.reduce((n, c) => n + c.symbols.length, 0) + 2);
    expect(sum.iec).toBe(IEC_LIBRARY.reduce((n, c) => n + c.symbols.length, 0) + 1);
    expect(sum.categories).toBe(JIC_LIBRARY.length + IEC_LIBRARY.length + 3);
  });

  it('skips built-in names on import by default (the application-wide library knows the built-ins)', async () => {
    const json = JSON.stringify({ symbols: [{ block: userBlock('HPB11_NO'), standard: 'JIC', category: 'Mine', family: 'PB' }, { block: userBlock('libt_imp1'), standard: 'JIC', category: 'Mine', family: 'PB' }] });
    expect(userLibrary.importJson(json)).toEqual({ added: 1, updated: 0, skipped: 0, reserved: 1, rejected: [] });
    expect(userLibrary.has('HPB11_NO')).toBe(false);
    expect(userLibrary.has('LIBT_IMP1')).toBe(true);
    expect(findLibrarySymbol('HPB11_NO')?.description).not.toBe('HPB11_NO user symbol');
    expect(libraryCategories('JIC').filter((c) => c.symbols.some((s) => s.name === 'HPB11_NO'))).toHaveLength(1);
    await userLibrary.flush();
  });

  it('ignores a user symbol without geometry or attributes instead of breaking the menu, search and lookup', () => {
    userLibrary.put({ block: { name: 'LIBT_EMPTY', basePoint: { x: 0, y: 0 }, entities: [], attributes: [] }, standard: 'JIC', category: 'Mine', family: 'PB' });
    userLibrary.put({ block: userBlock('LIBT_FULL'), standard: 'JIC', category: 'Mine', family: 'PB' });
    expect(findLibrarySymbol('LIBT_EMPTY')).toBeUndefined();
    expect(findLibrarySymbol('LIBT_FULL')?.name).toBe('LIBT_FULL');
    expect(isLibrarySymbol('LIBT_EMPTY')).toBe(true); // it is still a library name (not a private block)
    const mine = libraryCategories('JIC').find((c) => c.name === 'User: Mine');
    expect(mine?.symbols.map((s) => s.name)).toEqual(['LIBT_FULL']);
    expect(searchLibrary('JIC', 'libt_').map((s) => s.name)).toEqual(['LIBT_FULL']);
    userLibrary.remove('LIBT_FULL');
    expect(libraryCategories('JIC').some((c) => c.name.startsWith('User:'))).toBe(false);
  });

  it('keeps a user block that is referenced only from inside another block', () => {
    userLibrary.put({ block: userBlock('LIBT_INNER'), standard: 'JIC', category: 'Mine', family: 'PB' });
    userLibrary.put({ block: userBlock('LIBT_UNUSED'), standard: 'JIC', category: 'Mine', family: 'PB' });
    userLibrary.put({ block: userBlock('LIBT_DEEP'), standard: 'JIC', category: 'Mine', family: 'PB' });
    const d = new Drawing();
    // the drawing's own copy of LIBT_INNER references another user symbol (the drawing's definition wins over the library's)
    d.ensureBlocks([{ ...userLibrary.get('LIBT_INNER')!.block, entities: [insertOf('n3', 'LIBT_DEEP')] }]);
    d.ensureBlocks(LIBRARY_BLOCKS);
    d.ensureBlocks([userLibrary.get('LIBT_INNER')!.block, userLibrary.get('LIBT_UNUSED')!.block, userLibrary.get('LIBT_DEEP')!.block]);
    // a private block of the drawing (kept whatever happens) holds the user symbol and a built-in
    d.ensureBlocks([{ name: 'PRIVATE_OUTER', basePoint: { x: 0, y: 0 }, entities: [insertOf('n1', 'LIBT_INNER'), insertOf('n2', 'HCR1_NO')], attributes: [] }]);
    d.addEntities([insertOf('m1', 'HPB11_NO')]);
    const slim = withoutUnusedLibraryBlocks(d.snapshot);
    expect(Object.keys(slim.blocks).sort()).toEqual(['HCR1_NO', 'HPB11_NO', 'LIBT_DEEP', 'LIBT_INNER', 'PRIVATE_OUTER']);
    expect(slim.blocks.LIBT_UNUSED).toBeUndefined();
  });
});
