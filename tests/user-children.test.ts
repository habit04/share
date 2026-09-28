/**
 * AECHILD with user child symbols: the parent's own _NO / _NC twin comes first,
 * then user CONTACT symbols of the same family, then the built-in contact.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Drawing } from '../src/core/document';
import type { AttributeDef, BlockDef, Entity, LineEntity } from '../src/core/entities';
import { newId } from '../src/core/entities';
import { withAcadeAttributes } from '../src/electrical/attributes';
import { childBlockFor, childBlockChoices, builtinChildBlockFor } from '../src/electrical/xref';
import { userLibrary } from '../src/electrical/userlib';
import { findLibrarySymbol } from '../src/electrical/library';
import { tagPrefix } from '../src/electrical/symbols';
import { isChildBlock, isCoilBlock } from '../src/electrical/families';
import { childBlockOptions } from '../src/app/commands-electrical';

const line = (x1: number, y1: number, x2: number, y2: number): LineEntity => ({ id: newId(), layer: '0', color: 'ByLayer', type: 'line', a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });

function userBlock(name: string, family: string, wdtype: string, description = name): BlockDef {
  const tag: AttributeDef = { tag: 'TAG1', prompt: 'Component tag', default: '', position: { x: 0, y: 0.3 }, height: 0.125, align: 'center' };
  const geometry: Entity[] = [line(-0.375, 0, -0.125, 0), line(0.125, 0, 0.375, 0), line(-0.125, -0.1, -0.125, 0.1), line(0.125, -0.1, 0.125, 0.1)];
  return withAcadeAttributes({ name, description, basePoint: { x: 0, y: 0 }, entities: geometry, attributes: [tag] }, family, wdtype);
}

function addUser(name: string, family: string, wdtype: 'COIL' | 'CONTACT' | undefined): void {
  userLibrary.put({ block: userBlock(name, family, wdtype ?? family), standard: 'JIC', category: 'Relays (user)', family, ...(wdtype ? { wdtype } : {}) });
}

afterEach(async () => {
  for (const n of userLibrary.names()) userLibrary.remove(n);
  await userLibrary.flush();
});

describe('childBlockFor', () => {
  it('keeps the built-in mapping when no callbacks are given', () => {
    expect(childBlockFor('HCR1', 'NO')).toBe('HCR1_NO');
    expect(childBlockFor('HKM1', 'NC')).toBe('HKM1_NC');
    expect(childBlockFor('IEC_KM_COIL', 'NO')).toBe('IEC_KM_NO');
    expect(childBlockFor('HTD2', 'NO')).toBe('HTD2_NO');
    expect(childBlockFor('USER_K1', 'NC')).toBe('HCR1_NC');
    expect(builtinChildBlockFor('USER_K1', 'NC')).toBe('HCR1_NC');
  });
  it('prefers the parent\'s own _NO / _NC twin when it exists, then user candidates, then the built-in', () => {
    const lib = new Set(['USER_K1_NO', 'USER_K9_NC']);
    const exists = (n: string) => lib.has(n);
    expect(childBlockFor('USER_K1', 'NO', { exists })).toBe('USER_K1_NO');
    expect(childBlockFor('USER_K1', 'NC', { exists })).toBe('HCR1_NC');
    // a contact picked as "parent" still resolves to its family twin
    expect(childBlockFor('USER_K1_NC', 'NO', { exists })).toBe('USER_K1_NO');
    const candidates = (_parent: string, kind: 'NO' | 'NC') => (kind === 'NC' ? ['USER_K9_NC'] : []);
    expect(childBlockChoices('USER_K1', 'NC', { exists, candidates })).toEqual(['USER_K9_NC', 'HCR1_NC']);
    expect(childBlockChoices('USER_K1', 'NO', { exists, candidates })).toEqual(['USER_K1_NO', 'HCR1_NO']);
    // duplicates collapse: the twin listed again as a candidate is shown once
    expect(childBlockChoices('USER_K1', 'NO', { exists, candidates: () => ['USER_K1_NO', 'HCR1_NO'] })).toEqual(['USER_K1_NO', 'HCR1_NO']);
  });
});

describe('AECHILD candidates from the user library', () => {
  it('lists the twin first, then same-family user contacts, then the built-in contact', () => {
    addUser('USER_K1', 'K', 'COIL');
    addUser('USER_K1_NO', 'K', 'CONTACT');
    addUser('USER_K1_NC', 'K', 'CONTACT');
    addUser('USER_K2_NO', 'K', 'CONTACT');
    addUser('USER_KM_NO', 'KM', 'CONTACT'); // other family: not offered
    addUser('USER_LS_NO', 'LS', undefined); // standalone device with a _NO name: not a contact
    expect(isCoilBlock('USER_K1')).toBe(true);
    expect(isChildBlock('USER_K1_NO')).toBe(true);
    expect(tagPrefix('USER_K1')).toBe('K');
    const doc = new Drawing();
    const opts = childBlockOptions({ doc });
    expect(childBlockChoices('USER_K1', 'NO', opts)).toEqual(['USER_K1_NO', 'USER_K2_NO', 'HCR1_NO']);
    expect(childBlockChoices('USER_K1', 'NC', opts)).toEqual(['USER_K1_NC', 'HCR1_NC']);
    expect(childBlockFor('USER_K1', 'NO', opts)).toBe('USER_K1_NO');
    // a built-in coil with the same family K gets the user contacts offered after its own HCR1 twin? No:
    // HCR1's twin HCR1_NO exists in the library, so it leads; the user contacts of family CR are none.
    expect(childBlockChoices('HCR1', 'NO', opts)).toEqual(['HCR1_NO']);
    expect(findLibrarySymbol('USER_K1_NO')).toBeDefined();
  });
  it('falls back to the drawing\'s blocks for the twin lookup', () => {
    const doc = new Drawing();
    doc.ensureBlocks([userBlock('MY_K7_NC', 'K', 'CONTACT')]);
    expect(childBlockFor('MY_K7', 'NC', childBlockOptions({ doc }))).toBe('MY_K7_NC');
    expect(childBlockFor('MY_K7', 'NO', childBlockOptions({ doc }))).toBe('HCR1_NO');
  });
});
