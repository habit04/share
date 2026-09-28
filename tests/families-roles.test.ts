import { describe, it, expect, afterEach } from 'vitest';
import type { InsertEntity } from '../src/core/entities';
import { registerSymbolRole, symbolRole, isCoilBlock, isChildBlock, isCoil, isChild, isParentComponent } from '../src/electrical/families';

const insert = (block: string, attributes: Record<string, string>): InsertEntity => ({ id: `i-${block}`, layer: 'SYMS', color: 'ByLayer', type: 'insert', block, position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes });

const registered: string[] = [];
const role = (block: string, r: 'coil' | 'child' | 'none') => {
  registered.push(block);
  registerSymbolRole(block, r);
};
afterEach(() => {
  for (const b of registered.splice(0)) registerSymbolRole(b, undefined);
});

describe('explicit symbol roles veto the name patterns', () => {
  it("a standalone user symbol named after a coil prefix ('none') is not a coil", () => {
    expect(isCoilBlock('HCR1_MINE')).toBe(true); // by name only
    role('HCR1_MINE', 'none');
    expect(isCoilBlock('HCR1_MINE')).toBe(false);
    expect(isChildBlock('HCR1_MINE')).toBe(false);
    role('IEC_Y_VALVE2', 'none');
    expect(isCoilBlock('IEC_Y_VALVE2')).toBe(false);
    role('HTD2X', 'none');
    expect(isCoilBlock('HTD2X')).toBe(false);
  });

  it("an explicit 'child' beats a coil-looking name and 'coil' beats a contact-looking one", () => {
    role('HTD1X_NO', 'child');
    expect(isChildBlock('HTD1X_NO')).toBe(true);
    expect(isCoilBlock('HTD1X_NO')).toBe(false);
    role('HTD1X', 'child');
    expect(isChildBlock('HTD1X')).toBe(true);
    expect(isCoilBlock('HTD1X')).toBe(false);
    role('MY_NC', 'coil');
    expect(isCoilBlock('MY_NC')).toBe(true);
    expect(isChildBlock('MY_NC')).toBe(false);
  });

  it('unregistering (undefined) forgets the role so the name patterns apply again', () => {
    role('HCR1_MINE', 'none');
    expect(symbolRole('HCR1_MINE')).toBe('none');
    registerSymbolRole('HCR1_MINE', undefined);
    expect(symbolRole('HCR1_MINE')).toBeUndefined();
    expect(isCoilBlock('HCR1_MINE')).toBe(true);
    role('USER_K1', 'coil');
    expect(isCoilBlock('USER_K1')).toBe(true);
    registerSymbolRole('USER_K1', undefined);
    expect(isCoilBlock('USER_K1')).toBe(false);
  });

  it('keeps the built-in classification unchanged', () => {
    for (const coil of ['HCR1', 'HTD1', 'HTD4', 'HKM1', 'IEC_K_COIL', 'IEC_KT_STAR', 'IEC_Y_VALVE']) {
      expect(isCoilBlock(coil), coil).toBe(true);
      expect(isChildBlock(coil), coil).toBe(false);
    }
    for (const child of ['HCR1_NO', 'HTD2_NC', 'IEC_K_NO', 'IEC_KM_MAIN3', 'IEC_KT_STAR_Y_NC', 'IEC_KT_STAR_D_NO', 'IEC_KT_ON_NC']) {
      expect(isChildBlock(child), child).toBe(true);
      expect(isCoilBlock(child), child).toBe(false);
    }
    expect(isCoilBlock('HPB11_NO')).toBe(false);
    expect(isChildBlock('HPB11_NO')).toBe(false);
  });
});

describe('WDTYPE fallback for inserts of unknown blocks', () => {
  it('a child contact insert is a child (not a BOM parent) on a seat without the user library', () => {
    const contact = insert('USER_K9_NO', { TAG1: 'K9', WDTYPE: 'CONTACT' });
    expect(isChildBlock('USER_K9_NO')).toBe(false); // the name alone says nothing
    expect(isChild(contact)).toBe(true);
    expect(isCoil(contact)).toBe(false);
    expect(isParentComponent(contact)).toBe(false);
    const coil = insert('USER_K9', { TAG1: 'K9', WDTYPE: 'COIL' });
    expect(isCoil(coil)).toBe(true);
    expect(isChild(coil)).toBe(false);
    expect(isParentComponent(coil)).toBe(true);
  });

  it('other WDTYPE values and missing WDTYPE classify nothing', () => {
    const pb = insert('USER_PB1', { TAG1: 'PB1', WDTYPE: 'PB' });
    expect(isCoil(pb)).toBe(false);
    expect(isChild(pb)).toBe(false);
    expect(isParentComponent(pb)).toBe(true);
    const bare = insert('USER_X1', { TAG1: 'X1' });
    expect(isCoil(bare)).toBe(false);
    expect(isChild(bare)).toBe(false);
  });

  it('a registered role and the built-in patterns both beat the attribute', () => {
    role('USER_K9_NO', 'none');
    expect(isChild(insert('USER_K9_NO', { TAG1: 'K9', WDTYPE: 'CONTACT' }))).toBe(false);
    role('USER_K9', 'child');
    expect(isCoil(insert('USER_K9', { TAG1: 'K9', WDTYPE: 'COIL' }))).toBe(false);
    expect(isChild(insert('USER_K9', { TAG1: 'K9', WDTYPE: 'COIL' }))).toBe(true);
    // a built-in coil with a nonsense WDTYPE value stays a coil; a built-in contact stays a child
    expect(isCoil(insert('HCR1', { TAG1: 'CR1', WDTYPE: 'CONTACT' }))).toBe(true);
    expect(isChild(insert('HCR1_NO', { TAG1: 'CR1', WDTYPE: 'COIL' }))).toBe(true);
    expect(isCoil(insert('HCR1_NO', { TAG1: 'CR1', WDTYPE: 'COIL' }))).toBe(false);
  });
});
