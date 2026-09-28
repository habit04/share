import { describe, it, expect } from 'vitest';
import { JIC_LIBRARY, IEC_LIBRARY, LIBRARY_SYMBOLS, LIBRARY_BLOCKS, findLibrarySymbol, searchLibrary, librarySummary } from '../src/electrical/library';
import { tagPrefix, WIRE_DOT } from '../src/electrical/symbols';
import { isCoilBlock, isChildBlock, toggleVariant } from '../src/electrical/families';
import { connectionPoints } from '../src/electrical/attributes';

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
