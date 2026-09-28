import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  canonicalJson,
  signingPayload,
  parsePack,
  verifyPack,
  isExpired,
  PackRegistry,
  memoryPackStore,
  localPackStore,
  bridgePackStore,
  validPackFileName,
  packFileName,
  packStatus,
  PACK_KEYS,
  PACKS_KEY,
  type PackDocument,
  type PacksBridge,
} from '../src/electrical/packs';
import { allCatalogItems, findCatalogItem, setUserCatalog, setPackCatalog, BUILTIN_CATALOG, packCatalogSize, catalogSourceLabel, normaliseCatalog } from '../src/electrical/catalog';

// ------------------------------------------------------------------ helpers: an ephemeral publisher

const rawPublic = (pub: KeyObject): string => pub.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const publisher = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, keys: { 'test-key': rawPublic(publicKey) } };
};
const PUB = publisher();
const OTHER = publisher();

/** Sign a pack body the way scripts/pack-sign.mjs does (Node crypto), using the library's canonical form. */
function signWith(body: Record<string, unknown>, privateKey: KeyObject, keyId = 'test-key'): string {
  const { signature: _s, ...rest } = body;
  const sig = nodeSign(null, Buffer.from(signingPayload(rest)), privateKey).toString('base64');
  return JSON.stringify({ ...rest, signature: { alg: 'ed25519', keyId, value: sig } }, null, 1);
}

const catalog = [
  { family: 'PB', mfg: 'Acme', cat: 'pb-1', desc: 'push button', rating: '10A', type: 'no', footprint: 'wd_fp_pb' },
  { family: 'CR', mfg: 'Acme', cat: 'CR-1', desc: 'relay' },
];
const body = (over: Record<string, unknown> = {}, license: Record<string, unknown> = {}) => ({
  format: 'jcad-pack/1',
  id: 'acme-2026',
  name: 'Acme parts',
  publisher: 'Test Publisher',
  version: '2026.1',
  kind: 'catalog',
  license: { licensee: 'Shop <shop@example.com>', issued: '2026-09-28', expires: '2027-09-28', seats: 1, ...license },
  catalog,
  ...over,
});
const signed = (over: Record<string, unknown> = {}, license: Record<string, unknown> = {}) => signWith(body(over, license), PUB.privateKey);
const NOW = Date.parse('2026-09-28T12:00:00Z');

const fixture = (name: string) => readFileSync(new URL(`../fixtures/packs/${name}`, import.meta.url), 'utf8');

/** A Map-backed bridge, like electron/preload.cjs over the main-process handlers. */
function fakeBridge(): PacksBridge & { files: Map<string, string>; writes: string[] } {
  const files = new Map<string, string>();
  const writes: string[] = [];
  return {
    files,
    writes,
    packsList: async () => [...files.keys()],
    packsRead: async (n) => files.get(n) ?? null,
    packsWrite: async (n, t) => {
      writes.push(n);
      files.set(n, t);
    },
    packsRemove: async (n) => void files.delete(n),
    packsDir: async () => '/home/shop/.config/jcad/packs',
  };
}

function fakeStorage() {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

afterEach(() => {
  setUserCatalog([]);
  setPackCatalog([]);
});

// ------------------------------------------------------------------ canonical JSON

describe('canonicalJson', () => {
  it('is independent of key order and whitespace', () => {
    const a = canonicalJson({ b: 1, a: { d: [1, 2, { z: 1, y: 2 }], c: 'x' } });
    const b = canonicalJson(JSON.parse('{ "a" : {"c":"x", "d":[1,2,{"y":2,"z":1}]}, "b":1 }'));
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":"x","d":[1,2,{"y":2,"z":1}]},"b":1}');
  });
  it('drops undefined members, keeps nulls, escapes like JSON.stringify and preserves array order', () => {
    expect(canonicalJson({ a: undefined, b: null, c: 'q"é\n', d: [3, 1, 2], e: 1.5, f: true })).toBe('{"b":null,"c":"q\\"é\\n","d":[3,1,2],"e":1.5,"f":true}');
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson([undefined, 1])).toBe('[null,1]');
  });
  it('the signing payload leaves the signature member out', () => {
    const p = new TextDecoder().decode(signingPayload({ signature: { alg: 'x' }, id: 'a', format: 'f' }));
    expect(p).toBe('{"format":"f","id":"a"}');
  });
});

// ------------------------------------------------------------------ parse + verify

describe('parsePack / verifyPack', () => {
  it('signs in Node and verifies with the library (WebCrypto Ed25519)', async () => {
    const doc = parsePack(signed());
    const v = await verifyPack(doc, PUB.keys, NOW);
    expect(v).toMatchObject({ ok: true, keyId: 'test-key', licensee: 'Shop <shop@example.com>', expires: '2027-09-28', expired: false });
  });
  it('a tampered field fails verification', async () => {
    const text = signed();
    const edited = JSON.parse(text) as PackDocument;
    edited.license.licensee = 'Somebody else';
    const v = await verifyPack(parsePack(JSON.stringify(edited)), PUB.keys, NOW);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/does not match the pack contents/);
    // a changed part number fails too
    const edited2 = JSON.parse(text) as PackDocument;
    (edited2.catalog[0] as { cat: string }).cat = 'PB-2';
    expect((await verifyPack(parsePack(JSON.stringify(edited2)), PUB.keys, NOW)).ok).toBe(false);
    // the tampered signature value fails
    const edited3 = JSON.parse(text) as PackDocument;
    edited3.signature!.value = Buffer.from(Buffer.from(edited3.signature!.value, 'base64').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64');
    expect((await verifyPack(parsePack(JSON.stringify(edited3)), PUB.keys, NOW)).ok).toBe(false);
  });
  it('a pack signed by another key fails, and an unknown key id is reported', async () => {
    const wrongKey = await verifyPack(parsePack(signed()), { 'test-key': OTHER.keys['test-key']! }, NOW);
    expect(wrongKey.ok).toBe(false);
    expect(wrongKey.reason).toMatch(/does not match/);
    const unknown = await verifyPack(parsePack(signWith(body(), OTHER.privateKey, 'someone-else')), PUB.keys, NOW);
    expect(unknown.ok).toBe(false);
    expect(unknown.reason).toMatch(/signed with key "someone-else"/);
    expect(unknown.keyId).toBe('someone-else');
  });
  it('refuses unsigned, malformed and non-catalog packs at parse time', () => {
    expect(() => parsePack(JSON.stringify(body()))).toThrow(/Unsigned pack/);
    expect(() => parsePack('not json')).toThrow(/Not a JSON file/);
    expect(() => parsePack(JSON.stringify({ format: 'other' }))).toThrow(/Not a JCad pack/);
    expect(() => parsePack(signed({ kind: 'symbols' }))).toThrow(/only installs catalog packs/);
    expect(() => parsePack(signed({ id: 'bad id!' }))).toThrow(/Pack id/);
    expect(() => parsePack(signed({}, { licensee: '' }))).toThrow(/no licensee/);
    expect(() => parsePack(signed({}, { expires: 'next year' }))).toThrow(/expiry/);
    expect(() => parsePack(signed({ catalog: 'nope' }))).toThrow(/no catalog array/);
    expect(() => parsePack(JSON.stringify({ ...body(), signature: { alg: 'ed25519' } }))).toThrow(/signature block is malformed/);
  });
  it('an unsupported algorithm is refused by verifyPack', async () => {
    const doc = parsePack(signed());
    doc.signature!.alg = 'rsa';
    expect((await verifyPack(doc, PUB.keys, NOW)).reason).toMatch(/Unsupported signature algorithm/);
  });
  it('detects expiry (last valid day inclusive, UTC) but still verifies the pack', async () => {
    expect(isExpired('2027-09-28', NOW)).toBe(false);
    expect(isExpired('2026-09-28', NOW)).toBe(false); // still the last valid day
    expect(isExpired('2026-09-27', NOW)).toBe(true);
    expect(isExpired(null, NOW)).toBe(false);
    expect(isExpired(undefined, NOW)).toBe(false);
    const v = await verifyPack(parsePack(signed({}, { expires: '2025-01-15' })), PUB.keys, NOW);
    expect(v).toMatchObject({ ok: true, expired: true, expires: '2025-01-15' });
    const perpetual = await verifyPack(parsePack(signed({}, { expires: null })), PUB.keys, NOW);
    expect(perpetual).toMatchObject({ ok: true, expired: false, expires: null });
  });
  it('keeps unknown members (they are part of the signed payload)', async () => {
    const doc = parsePack(signed({ description: 'Rockwell control parts', notes: { url: 'https://example.com' } }));
    expect(doc.description).toBe('Rockwell control parts');
    expect(doc.notes).toEqual({ url: 'https://example.com' });
    expect((await verifyPack(doc, PUB.keys, NOW)).ok).toBe(true);
  });
});

describe('sample fixtures signed by scripts/pack-sign.mjs', () => {
  it('sample-signed verifies with the embedded publisher key', async () => {
    const doc = parsePack(fixture('sample-signed.jcadpack.json'));
    const v = await verifyPack(doc, PACK_KEYS, NOW);
    expect(v).toMatchObject({ ok: true, keyId: 'pub-2026', licensee: 'Sample Panel Shop <shop@example.com>', expires: '2027-09-28', expired: false });
    expect(doc.catalog).toHaveLength(14);
  });
  it('sample-expired verifies but is flagged expired', async () => {
    const v = await verifyPack(parsePack(fixture('sample-expired.jcadpack.json')), PACK_KEYS, NOW);
    expect(v).toMatchObject({ ok: true, expired: true, expires: '2025-01-15' });
  });
  it('sample-tampered (licensee edited after signing) is refused', async () => {
    const v = await verifyPack(parsePack(fixture('sample-tampered.jcadpack.json')), PACK_KEYS, NOW);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/does not match/);
  });
  it('the CSV -> JSON conversion produced the catalog that was signed', () => {
    const json = JSON.parse(fixture('sample-catalog.json')) as unknown[];
    const doc = parsePack(fixture('sample-signed.jcadpack.json'));
    expect(doc.catalog).toEqual(json);
    expect((json[0] as { footprint: string }).footprint).toBe('WD_FP_PB');
  });
});

// ------------------------------------------------------------------ registry

describe('PackRegistry', () => {
  it('installs a valid pack, refuses an invalid one, and merges after the user catalog / before built-in', async () => {
    const reg = new PackRegistry({ store: memoryPackStore(), keys: PUB.keys, now: () => NOW });
    const p = await reg.install(signed());
    expect(p.file).toBe('acme-2026.jcadpack.json');
    expect(p.items.map((i) => i.cat)).toEqual(['PB-1', 'CR-1']);
    expect(p.items[0]).toMatchObject({ mfg: 'ACME', type: 'NO', footprint: 'WD_FP_PB', source: 'pack', pack: 'Acme parts' });
    expect(catalogSourceLabel(p.items[0]!)).toBe('Acme parts');
    expect(packStatus(p)).toBe('valid until 2027-09-28');
    expect(packCatalogSize()).toBe(2);

    await expect(reg.install(JSON.stringify(body()))).rejects.toThrow(/Unsigned pack/);
    await expect(reg.install(signWith(body({ id: 'x' }), OTHER.privateKey))).rejects.toThrow(/does not match/);
    expect(reg.size).toBe(1);

    // merge order: user > pack > built-in
    const builtinDup = BUILTIN_CATALOG[0]!;
    setUserCatalog(normaliseCatalog([{ family: 'PB', mfg: 'ACME', cat: 'PB-1', desc: 'user override' }], 'user'));
    const all = allCatalogItems();
    expect(all[0]!.source).toBe('user');
    expect(all[1]!.source).toBe('pack');
    expect(all[3]!.source).toBe('builtin');
    expect(findCatalogItem('ACME', 'PB-1')!.desc).toBe('USER OVERRIDE');
    expect(findCatalogItem(builtinDup.mfg, builtinDup.cat)!.source).toBe('builtin');

    // a pack row shadows a same-numbered built-in row
    const shadow = signWith(body({ id: 'shadow', name: 'Shadow', catalog: [{ family: builtinDup.family, mfg: builtinDup.mfg, cat: builtinDup.cat, desc: 'from pack' }] }), PUB.privateKey);
    await reg.install(shadow);
    expect(findCatalogItem(builtinDup.mfg, builtinDup.cat)!.desc).toBe('FROM PACK');
    // install order is kept
    expect(reg.list().map((p) => p.doc.id)).toEqual(['acme-2026', 'shadow']);
  });

  it('re-installing the same id replaces the pack in place and removes the old file', async () => {
    const store = memoryPackStore();
    const reg = new PackRegistry({ store, keys: PUB.keys, now: () => NOW, publish: () => undefined });
    await reg.install(signed(), 'first.jcadpack.json');
    await reg.install(signed({ version: '2026.2' }));
    expect(reg.size).toBe(1);
    expect(reg.get('acme-2026')!.doc.version).toBe('2026.2');
    expect([...store.files.keys()]).toEqual(['acme-2026.jcadpack.json']);
  });

  it('an expired pack installs (flagged) and check() previews without installing', async () => {
    const reg = new PackRegistry({ store: memoryPackStore(), keys: PUB.keys, now: () => NOW, publish: () => undefined });
    const preview = await reg.check(signed({}, { expires: '2020-01-01' }));
    expect(preview.verified).toMatchObject({ ok: true, expired: true });
    expect(reg.size).toBe(0);
    const p = await reg.install(signed({}, { expires: '2020-01-01' }));
    expect(p.verified.expired).toBe(true);
    expect(packStatus(p)).toBe('expired on 2020-01-01');
    expect(reg.catalogItems()).toHaveLength(2);
  });

  it('persists through the bridge: a new registry loads what another installed; removal deletes the file', async () => {
    const bridge = fakeBridge();
    const a = new PackRegistry({ store: bridgePackStore(bridge), keys: PUB.keys, now: () => NOW, publish: () => undefined });
    await a.install(signed());
    expect(bridge.writes).toEqual(['acme-2026.jcadpack.json']);
    // stored verbatim, so the signature still verifies later
    expect(bridge.files.get('acme-2026.jcadpack.json')).toBe(signed());

    const published: number[] = [];
    const b = new PackRegistry({ store: bridgePackStore(bridge), keys: PUB.keys, now: () => NOW, publish: (items) => published.push(items.length) });
    const r = await b.load();
    expect(r).toEqual({ loaded: 1, errors: [] });
    expect(b.location).toBe('/home/shop/.config/jcad/packs');
    expect(b.get('acme-2026')!.doc.license.licensee).toBe('Shop <shop@example.com>');
    expect(published).toEqual([2]);

    expect(await b.remove('acme-2026')).toBe(true);
    expect(await b.remove('acme-2026')).toBe(false);
    expect(bridge.files.size).toBe(0);
    expect(published).toEqual([2, 0]);
  });

  it('load() skips edited, unreadable, unknown-key and duplicate files but keeps them on disk', async () => {
    const bridge = fakeBridge();
    const text = signed();
    bridge.files.set('good.jcadpack.json', text);
    bridge.files.set('edited.jcadpack.json', text.replace('Shop <shop@example.com>', 'Pirate'));
    bridge.files.set('garbage.jcadpack.json', '{ not json');
    bridge.files.set('foreign.jcadpack.json', signWith(body({ id: 'foreign' }), OTHER.privateKey, 'other-key'));
    bridge.files.set('dupe.jcadpack.json', text);
    bridge.files.set('README.txt', 'ignored: not a pack name');
    const reg = new PackRegistry({ store: bridgePackStore(bridge), keys: PUB.keys, now: () => NOW, publish: () => undefined });
    const r = await reg.load();
    expect(r.loaded).toBe(1);
    expect(reg.list()[0]!.file).toBe('dupe.jcadpack.json'); // sorted: dupe < good, so good is the duplicate
    expect(r.errors.map((e) => e.split(':')[0])).toEqual(['edited.jcadpack.json', 'foreign.jcadpack.json', 'garbage.jcadpack.json', 'good.jcadpack.json']);
    expect(r.errors.find((e) => e.startsWith('edited'))).toMatch(/does not match/);
    expect(r.errors.find((e) => e.startsWith('foreign'))).toMatch(/key "other-key"/);
    expect(r.errors.find((e) => e.startsWith('good'))).toMatch(/duplicate pack id/);
    expect(bridge.files.size).toBe(6);
    expect(reg.errors).toEqual(r.errors);
  });

  it('reports a store that cannot be listed instead of throwing', async () => {
    const bridge = fakeBridge();
    bridge.packsList = async () => {
      throw new Error('EACCES');
    };
    const reg = new PackRegistry({ store: bridgePackStore(bridge), keys: PUB.keys, publish: () => undefined });
    const r = await reg.load();
    expect(r.loaded).toBe(0);
    expect(r.errors[0]).toMatch(/could not list the packs folder: EACCES/);
  });

  it('falls back to localStorage (one entry holding every pack)', async () => {
    const storage = fakeStorage();
    const a = new PackRegistry({ store: localPackStore(storage), keys: PUB.keys, now: () => NOW, publish: () => undefined });
    await a.install(signed());
    await a.install(signed({ id: 'second', name: 'Second' }));
    const stored = JSON.parse(storage.m.get(PACKS_KEY)!) as Record<string, string>;
    expect(Object.keys(stored).sort()).toEqual(['acme-2026.jcadpack.json', 'second.jcadpack.json']);
    expect(await localPackStore(storage).location!()).toMatch(/browser storage/);

    const b = new PackRegistry({ store: localPackStore(storage), keys: PUB.keys, now: () => NOW, publish: () => undefined });
    expect((await b.load()).loaded).toBe(2);
    await b.remove('second');
    expect(Object.keys(JSON.parse(storage.m.get(PACKS_KEY)!) as object)).toEqual(['acme-2026.jcadpack.json']);

    // corrupt storage reads as empty rather than throwing
    storage.m.set(PACKS_KEY, '{oops');
    expect(await localPackStore(storage).list()).toEqual([]);
  });

  it('the default registry publishes into the catalog and uses the compiled-in keys', async () => {
    const reg = new PackRegistry({ store: memoryPackStore(), now: () => NOW });
    await reg.install(fixture('sample-signed.jcadpack.json'));
    expect(packCatalogSize()).toBe(14);
    expect(findCatalogItem('SAMPLE-MFG', '800FP-E4')).toMatchObject({ family: 'PB', type: 'NC', pack: 'Sample manufacturer parts' });
    await expect(reg.install(signed())).rejects.toThrow(/key "test-key"/);
  });
});

// ------------------------------------------------------------------ names

describe('pack file names', () => {
  it('validates store names', () => {
    expect(validPackFileName('acme-2026.jcadpack.json')).toBe(true);
    expect(validPackFileName('Acme.Rockwell_v2.jcadpack.json')).toBe(true);
    expect(validPackFileName('acme.json')).toBe(false);
    expect(validPackFileName('../x.jcadpack.json')).toBe(false);
    expect(validPackFileName('a/b.jcadpack.json')).toBe(false);
    expect(validPackFileName('.jcadpack.json')).toBe(false);
    expect(validPackFileName('space here.jcadpack.json')).toBe(false);
    expect(validPackFileName(`${'a'.repeat(200)}.jcadpack.json`)).toBe(false);
    expect(validPackFileName('' as string)).toBe(false);
    expect(validPackFileName(42 as unknown as string)).toBe(false);
  });
  it('derives a safe file name from the pack id', () => {
    expect(packFileName('acme-rockwell-2026')).toBe('acme-rockwell-2026.jcadpack.json');
    expect(packFileName('weird id/../x')).toBe('weird_id_._x.jcadpack.json');
    expect(validPackFileName(packFileName('weird id/../x'))).toBe(true);
    expect(packFileName('...')).toBe('pack.jcadpack.json');
  });
});
