import { describe, it, expect } from 'vitest';
import type { AttributeDef, BlockDef, LineEntity } from '../src/core/entities';
import { UserLibrary, memoryUserLibraryStore, localUserLibraryStore, parseUserLibrary, parseUserLibraryDocument, parseUserSymbol, validateUserSymbol, normalizeWdtype, serializeUserLibrary, type UserLibraryStore } from '../src/electrical/userlib';
import { isCoilBlock, isChildBlock } from '../src/electrical/families';
import { tagPrefix } from '../src/electrical/symbols';

const line = (x1: number, y1: number, x2: number, y2: number): LineEntity => ({ id: `l${x1}${y1}${x2}${y2}`, layer: '0', color: 'ByLayer', type: 'line', a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });
const attr = (tag: string): AttributeDef => ({ tag, prompt: tag, default: '', position: { x: 0, y: 0.2 }, height: 0.1, align: 'center' });
/** A minimal user block: two stubs and a TAG1 attribute. */
const block = (name: string): BlockDef => ({ name, basePoint: { x: 0, y: 0 }, entities: [line(-0.375, 0, -0.125, 0), line(0.125, 0, 0.375, 0)], attributes: [attr('TAG1')] });
const entry = (name: string, extra: Record<string, unknown> = {}) => ({ block: block(name), standard: 'JIC' as const, category: 'c', family: 'PB', ...extra });
const doc = (symbols: unknown[], version = 1) => JSON.stringify({ format: 'jcad-user-library', version, symbols });

/** A store whose read is held open until `release()` is called. */
function gatedStore(json: string | null) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const mem = memoryUserLibraryStore();
  mem.json = json;
  const store: UserLibraryStore = {
    read: async () => {
      await gate;
      return mem.json;
    },
    write: (j) => mem.write(j),
  };
  return { store, mem, release };
}

describe('user library integrity: a failed load never leads to an overwrite', () => {
  it('corrupt file -> load -> put: the file is left alone and lastError says so', async () => {
    const store = memoryUserLibraryStore();
    const corrupt = doc([entry('OLD1')]).slice(0, -20) + ' TRUNCATED';
    store.json = corrupt;
    const lib = new UserLibrary(store);
    expect(await lib.load()).toBe(0);
    expect(lib.writable).toBe(false);
    expect(lib.lastError).toMatch(/could not parse the user library: Not a JSON file/);
    lib.put(entry('NEW1'));
    // the refusal is reported synchronously so the Symbol Builder's save() can show it
    expect(lib.lastError).toMatch(/library not loaded/);
    expect(lib.lastError).toMatch(/refusing to overwrite/);
    expect(lib.lastError).toMatch(/user-library\.json/);
    await lib.flush();
    expect(store.json).toBe(corrupt);
    // the new symbol is still usable in memory (and exportable) so no work is lost
    expect(lib.has('NEW1')).toBe(true);
    expect(parseUserLibrary(lib.exportJson()).map((s) => s.block.name)).toEqual(['NEW1']);
  });

  it('a read that rejects for a reason other than "no file" refuses every following write', async () => {
    const writes: string[] = [];
    const store: UserLibraryStore = {
      read: async () => {
        throw new Error('EBUSY: resource busy or locked');
      },
      write: async (j) => void writes.push(j),
    };
    const lib = new UserLibrary(store);
    await lib.load();
    expect(lib.lastError).toMatch(/could not read the user library: EBUSY/);
    lib.put(entry('NEW1'));
    await lib.flush();
    lib.remove('NEW1');
    await lib.flush();
    expect(writes).toEqual([]);
    expect(lib.lastError).toMatch(/refusing to overwrite/);
  });

  it('a read that fails while a put is queued: the queued write is refused too', async () => {
    let fail!: (err: Error) => void;
    const pending = new Promise<string | null>((_r, rej) => (fail = rej));
    const store: UserLibraryStore = {
      read: () => pending,
      write: async () => {
        throw new Error('write must not run');
      },
    };
    const lib = new UserLibrary(store);
    const loading = lib.load();
    lib.put(entry('EARLY1'));
    fail(new Error('EPERM: operation not permitted'));
    await loading;
    await lib.flush();
    expect(lib.lastError).toMatch(/refusing to overwrite/);
    expect(lib.lastError).toMatch(/EPERM/);
    expect(lib.has('EARLY1')).toBe(true);
  });

  it('put() while load() is pending: both the on-disk and the new symbol survive on disk and in memory', async () => {
    const { store, mem, release } = gatedStore(doc([entry('DISK1')]));
    const lib = new UserLibrary(store);
    const loading = lib.load();
    lib.put(entry('EARLY1'));
    const flushed = lib.flush();
    // nothing is written while the read is in flight
    expect(mem.json).toContain('DISK1');
    expect(mem.json).not.toContain('EARLY1');
    release();
    await loading;
    await flushed;
    expect(lib.has('EARLY1')).toBe(true);
    expect(lib.has('DISK1')).toBe(true);
    const onDisk = parseUserLibrary(mem.json!).map((s) => s.block.name);
    expect(onDisk).toEqual(['DISK1', 'EARLY1']);
    expect(lib.lastError).toBeNull();
  });

  it('entries this version cannot parse survive load and save unchanged, and are reported', async () => {
    const store = memoryUserLibraryStore();
    const future = { block: { name: 'FUTURE1', basePoint: [0, 0], entities: [], attributes: [] }, standard: 'JIC', flavour: 'v2' };
    store.json = doc([future, entry('OK1')], 2);
    const lib = new UserLibrary(store);
    expect(await lib.load()).toBe(1);
    expect(lib.writable).toBe(true);
    expect(lib.lastError).toMatch(/1 entry could not be read by this version and is kept unchanged: FUTURE1: basePoint is not a point/);
    lib.put(entry('NEW1'));
    await lib.flush();
    expect(lib.lastError).toBeNull();
    const written = JSON.parse(store.json!) as { symbols: unknown[] };
    expect(written.symbols).toHaveLength(3);
    expect(written.symbols).toContainEqual(future);
    // a second load sees the same picture
    const lib2 = new UserLibrary(store);
    expect(await lib2.load()).toBe(2);
    expect(lib2.names()).toEqual(['NEW1', 'OK1']);
    // a readable symbol saved under the unreadable entry's name replaces it instead of duplicating it
    lib2.put(entry('FUTURE1'));
    await lib2.flush();
    const names = (JSON.parse(store.json!) as { symbols: Array<{ block: { name: string } }> }).symbols.map((s) => s.block.name);
    expect(names.filter((n) => n === 'FUTURE1')).toHaveLength(1);
    expect(parseUserLibraryDocument(store.json!).unparsed).toEqual([]);
  });

  it('an empty or whitespace-only file is an empty library, not a failure', async () => {
    const store = memoryUserLibraryStore();
    store.json = '  \n';
    const lib = new UserLibrary(store);
    expect(await lib.load()).toBe(0);
    expect(lib.writable).toBe(true);
    expect(lib.lastError).toBeNull();
    lib.put(entry('NEW1'));
    await lib.flush();
    expect(store.json).toContain('NEW1');
  });
});

describe('browser store errors are reported', () => {
  it('a throwing setItem (quota exceeded) sets lastError', async () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError: the quota has been exceeded');
      },
    };
    const lib = new UserLibrary(localUserLibraryStore(storage));
    lib.put(entry('Q1'));
    await lib.flush();
    expect(lib.lastError).toMatch(/QuotaExceededError/);
  });

  it('a throwing getItem (storage blocked) fails the load and blocks writes', async () => {
    const written: string[] = [];
    const storage = {
      getItem: (): string | null => {
        throw new Error('SecurityError: access denied');
      },
      setItem: (_k: string, v: string) => void written.push(v),
    };
    const lib = new UserLibrary(localUserLibraryStore(storage));
    await lib.load();
    expect(lib.lastError).toMatch(/SecurityError/);
    lib.put(entry('Q1'));
    await lib.flush();
    expect(written).toEqual([]);
  });
});

describe('symbol names and roles on import', () => {
  it('upper-cases imported names, skips reserved (built-in) names and reports both', async () => {
    const lib = new UserLibrary(memoryUserLibraryStore());
    const json = JSON.stringify({ symbols: [entry('user_pb1'), entry('HPB11_NO'), { ...entry('  spaced_ok  ') }] });
    const r = lib.importJson(json, { isReserved: (n) => n === 'HPB11_NO' });
    expect(r).toEqual({ added: 2, updated: 0, skipped: 0, reserved: 1, rejected: [] });
    expect(lib.has('USER_PB1')).toBe(true);
    expect(lib.get('user_pb1')?.block.name).toBe('USER_PB1');
    expect(lib.has('HPB11_NO')).toBe(false);
    expect(lib.names()).toEqual(['SPACED_OK', 'USER_PB1']);
    // a builder save of the same symbol replaces, never duplicates
    lib.put(entry('USER_PB1'));
    expect(lib.names().filter((n) => n === 'USER_PB1')).toHaveLength(1);
    await lib.flush();
    expect(tagPrefix('USER_PB1')).toBe('PB');
    lib.remove('USER_PB1');
    lib.remove('SPACED_OK');
  });

  it('rejects a name with whitespace or invalid characters with a clear error', () => {
    expect(() => validateUserSymbol(entry('MY SYMBOL'))).toThrow(/"MY SYMBOL" contains whitespace/);
    expect(() => validateUserSymbol(entry('BAD<NAME'))).toThrow(/not a valid block name/);
    expect(() => validateUserSymbol(entry(''))).toThrow(/empty block name/);
    const lib = new UserLibrary(memoryUserLibraryStore());
    expect(() => lib.put(entry('MY SYMBOL'))).toThrow(/contains whitespace/);
    expect(lib.size).toBe(0);
    lib.put(entry('OK1'));
    expect(lib.rename('OK1', 'has space')).toBe(false);
    expect(lib.rename('OK1', ' ok2 ')).toBe(true);
    expect(lib.names()).toEqual(['OK2']);
  });

  it('whitelists WDTYPE (COIL, CONTACT, TERM, PLC or a family code) and upper-cases it', async () => {
    expect(normalizeWdtype('coil')).toBe('COIL');
    expect(normalizeWdtype(' contact ')).toBe('CONTACT');
    expect(normalizeWdtype('PB')).toBe('PB');
    expect(normalizeWdtype('K9A')).toBe('K9A');
    expect(normalizeWdtype('not a wdtype!')).toBeUndefined();
    expect(normalizeWdtype('9PB')).toBeUndefined();
    expect(normalizeWdtype('TOOLONGCODE')).toBeUndefined();
    expect(normalizeWdtype(42)).toBeUndefined();
    const s = parseUserSymbol(entry('X1', { wdtype: 'coil' }));
    expect(s?.wdtype).toBe('COIL');
    expect(parseUserSymbol(entry('X2', { wdtype: '<bogus>' }))?.wdtype).toBeUndefined();
    const lib = new UserLibrary(memoryUserLibraryStore());
    lib.put(entry('WD_TEST_K1', { wdtype: 'coil' }));
    lib.put(entry('WD_TEST_K1_NO', { wdtype: 'contact' }));
    expect(isCoilBlock('WD_TEST_K1')).toBe(true);
    expect(isChildBlock('WD_TEST_K1_NO')).toBe(true);
    lib.remove('WD_TEST_K1');
    lib.remove('WD_TEST_K1_NO');
    expect(isCoilBlock('WD_TEST_K1')).toBe(false);
    await lib.flush();
  });
});

describe('per-entity validation', () => {
  const withEntities = (name: string, entities: unknown[], attributes: unknown[] = [attr('TAG1')]) => ({ block: { name, basePoint: { x: 0, y: 0 }, entities, attributes } });

  it('rejects a malformed entity with the symbol name and never persists it', async () => {
    const bad = withEntities('BAD1', [{ id: 'x', type: 'line', layer: '0' }]);
    expect(() => validateUserSymbol(bad)).toThrow(/^BAD1: line entity 1 needs points a and b$/);
    const store = memoryUserLibraryStore();
    const lib = new UserLibrary(store);
    const r = lib.importJson(JSON.stringify({ symbols: [bad, entry('GOOD1')] }));
    expect(r.added).toBe(1);
    expect(r.rejected).toEqual(['BAD1: line entity 1 needs points a and b']);
    await lib.flush();
    expect(store.json).toContain('GOOD1');
    expect(store.json).not.toContain('BAD1');
    // a file holding only malformed symbols is refused as a whole, naming the problem
    expect(() => lib.importJson(JSON.stringify({ symbols: [bad] }))).toThrow(/No valid symbols in the file: BAD1: line entity 1/);
    expect(lib.lastError).toBeNull(); // the throw is the report
    const r2 = lib.importJson(JSON.stringify({ symbols: [bad, entry('GOOD1')] }), { replace: false });
    expect(r2).toEqual({ added: 0, updated: 0, skipped: 1, reserved: 0, rejected: ['BAD1: line entity 1 needs points a and b'] });
    expect(lib.lastError).toMatch(/Import rejected 1 malformed entry: BAD1/);
  });

  it('checks every entity type it knows and rejects the ones it does not', () => {
    const ok = (entities: unknown[]) => expect(() => validateUserSymbol(withEntities('T1', entities))).not.toThrow();
    const no = (entities: unknown[], re: RegExp) => expect(() => validateUserSymbol(withEntities('T1', entities))).toThrow(re);
    ok([{ type: 'line', layer: '0', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }]);
    no([{ type: 'line', layer: '0', a: { x: 0, y: 0 }, b: { x: 'a', y: 0 } }], /line entity 1 needs points a and b/);
    ok([{ type: 'circle', layer: '0', center: { x: 0, y: 0 }, radius: 0.1 }]);
    no([{ type: 'circle', layer: '0', center: { x: 0, y: 0 }, radius: 0 }], /circle entity 1 needs a center and a positive radius/);
    no([{ type: 'circle', layer: '0', center: { x: 0, y: 0 }, radius: NaN }], /circle entity 1/);
    ok([{ type: 'arc', layer: '0', center: { x: 0, y: 0 }, radius: 0.1, startAngle: 0, endAngle: 1 }]);
    no([{ type: 'arc', layer: '0', center: { x: 0, y: 0 }, radius: 0.1, startAngle: 0 }], /arc entity 1 needs a center, a positive radius and start \/ end angles/);
    ok([{ type: 'polyline', layer: '0', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], closed: false }]);
    no([{ type: 'polyline', layer: '0', points: [], closed: false }], /polyline entity 1 needs a non-empty points array/);
    no([{ type: 'polyline', layer: '0', points: 'nope' }], /polyline entity 1 needs a non-empty points array/);
    no([{ type: 'polyline', layer: '0', points: [{ x: 0, y: 0 }], bulges: ['x'] }], /bulges/);
    ok([{ type: 'text', layer: '0', position: { x: 0, y: 0 }, text: 'A', height: 0.1, rotation: 0, align: 'left' }]);
    no([{ type: 'text', layer: '0', position: { x: 0, y: 0 }, text: 'A' }], /text entity 1 needs a position, text and a positive height/);
    ok([{ type: 'insert', layer: '0', block: 'HCR1', position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {} }]);
    no([{ type: 'insert', layer: '0', position: { x: 0, y: 0 } }], /insert entity 1 needs a block name and a position/);
    ok([{ type: 'ellipse', layer: '0', center: { x: 0, y: 0 }, majorAxis: { x: 1, y: 0 }, ratio: 0.5, startParam: 0, endParam: 6.28 }]);
    ok([{ type: 'point', layer: '0', position: { x: 0, y: 0 } }]);
    ok([{ type: 'xline', layer: '0', base: { x: 0, y: 0 }, direction: { x: 1, y: 0 } }]);
    no([{ type: 'ray', layer: '0', base: { x: 0, y: 0 } }], /ray entity 1 needs a base point and a direction/);
    no([{ type: 'hatch', layer: '0' }], /entity 1 has an unknown type "hatch"/);
    no([{ type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }], /line entity 1 has no layer/);
    no(['not an entity'], /entity 1 is not an object/);
    no([{ type: 'line', layer: '0', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }, { type: 'circle', layer: '0' }], /T1: circle entity 2/);
  });

  it('fills presentation defaults but requires the geometry of text, insert and attribute definitions', () => {
    const s = validateUserSymbol(
      withEntities(
        'D1',
        [
          { type: 'text', layer: '0', position: { x: 0, y: 0 }, text: 'A', height: 0.1 },
          { type: 'insert', layer: '0', block: 'HCR1', position: { x: 0, y: 0 } },
          { type: 'polyline', layer: '0', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] },
        ],
        [{ tag: 'TAG1', position: { x: 0, y: 0 }, height: 0.1 }],
      ),
    );
    const [text, insert, poly] = s.block.entities;
    expect(text).toMatchObject({ type: 'text', rotation: 0, align: 'left', color: 'ByLayer' });
    expect(insert).toMatchObject({ type: 'insert', rotation: 0, scale: 1, attributes: {} });
    expect(poly).toMatchObject({ type: 'polyline', closed: false });
    expect(s.block.attributes[0]).toEqual({ tag: 'TAG1', prompt: '', default: '', position: { x: 0, y: 0 }, height: 0.1, align: 'left' });
    expect(() => validateUserSymbol(withEntities('D2', [], [{ tag: 'TAG1', height: 0.1 }]))).toThrow(/D2: attribute TAG1 needs a position and a positive height/);
    expect(() => validateUserSymbol(withEntities('D3', [], [{ position: { x: 0, y: 0 }, height: 0.1 }]))).toThrow(/D3: attribute 1 has no tag/);
    expect(() => validateUserSymbol(withEntities('D4', [], []))).toThrow(/D4: has no geometry and no attributes/);
    expect(() => validateUserSymbol({ block: { name: 'D5', basePoint: { x: 0, y: 0 }, entities: {}, attributes: [] } })).toThrow(/D5: entities is not an array/);
    expect(() => validateUserSymbol({ nope: 1 })).toThrow(/entry has no block/);
    // the DXF export and the writer never see undefined defaults
    expect(serializeUserLibrary([s])).not.toContain('undefined');
  });
});
