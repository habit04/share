#!/usr/bin/env node
/**
 * pack-sign: build, sign and check JCad Electrical catalog packs (*.jcadpack.json).
 *
 *   node scripts/pack-sign.mjs keygen --out keys/
 *   node scripts/pack-sign.mjs csv2catalog parts.csv parts.json
 *   node scripts/pack-sign.mjs sign --key keys/pack-private.pem --key-id pub-2026 \
 *        --licensee "Acme Controls <shop@acme.example>" --expires 2027-09-28 \
 *        --in parts.json --out acme.jcadpack.json --id acme-rockwell-2026 \
 *        --name "Rockwell control parts" --version 2026.1 [--publisher "..."] [--seats 1]
 *   node scripts/pack-sign.mjs verify acme.jcadpack.json [--keys src/electrical/pack-keys.json]
 *
 * The signature is Ed25519 over the canonical JSON (keys sorted, no whitespace) of
 * the whole pack minus its `signature` member; `canonicalJson` here must stay
 * byte-for-byte identical to the one in src/electrical/packs.ts (tests/packs.test.ts
 * checks the fixtures signed by this script against the library).
 *
 * Node 22, no dependencies. The private key never leaves the publisher's machine:
 * `keys/` is git-ignored, and this script is the only thing that reads the PEM.
 */
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PACK_FORMAT = 'jcad-pack/1';
/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows it. */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const CATALOG_COLUMNS = ['family', 'mfg', 'cat', 'desc', 'rating', 'type', 'assycode', 'footprint'];

// ------------------------------------------------------------------ canonical JSON + signing

/** Deterministic JSON: object keys sorted, no whitespace, `undefined` members dropped (mirror of packs.ts). */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (value === undefined) return 'null';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** The bytes that get signed: the document without its `signature` member. */
export function signingPayload(pack) {
  const { signature: _sig, ...rest } = pack;
  return Buffer.from(canonicalJson(rest), 'utf8');
}

export function rawPublicKey(publicKey) {
  return publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
}

export function publicKeyFromRaw(base64) {
  const raw = Buffer.from(base64, 'base64');
  if (raw.length !== 32) throw new Error('public key must be 32 raw bytes (base64)');
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** Attach a fresh Ed25519 signature to a pack document (returns a new object). */
export function signPack(pack, privateKey, keyId) {
  const { signature: _old, ...body } = pack;
  const sig = sign(null, signingPayload(body), privateKey);
  return { ...body, signature: { alg: 'ed25519', keyId, value: sig.toString('base64') } };
}

/** Verify a pack against a { keyId: base64 } map. Returns { ok, reason?, keyId }. */
export function verifyPackSignature(pack, keys) {
  const sig = pack && pack.signature;
  if (!sig || typeof sig !== 'object') return { ok: false, reason: 'unsigned: the pack has no signature member' };
  if (sig.alg !== 'ed25519') return { ok: false, reason: `unsupported signature algorithm "${sig.alg}"` };
  const pub = keys[sig.keyId];
  if (!pub) return { ok: false, reason: `unknown signing key "${sig.keyId}" (known: ${Object.keys(keys).join(', ') || 'none'})`, keyId: sig.keyId };
  let ok = false;
  try {
    ok = verify(null, signingPayload(pack), publicKeyFromRaw(pub), Buffer.from(String(sig.value), 'base64'));
  } catch {
    ok = false;
  }
  return ok ? { ok: true, keyId: sig.keyId } : { ok: false, reason: 'signature does not match the pack contents (modified or corrupt)', keyId: sig.keyId };
}

// ------------------------------------------------------------------ CSV -> catalog

/** Minimal RFC 4180 CSV parser (quotes, doubled quotes, CRLF). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Rows of a spreadsheet export (header row: family,mfg,cat,desc,rating,type,assycode,footprint) -> catalog items. */
export function csvToCatalog(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error('CSV is empty');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = Object.fromEntries(CATALOG_COLUMNS.map((c) => [c, header.indexOf(c)]));
  for (const required of ['family', 'mfg', 'cat', 'desc']) if (idx[required] < 0) throw new Error(`CSV header is missing the "${required}" column (expected: ${CATALOG_COLUMNS.join(',')})`);
  const items = [];
  for (const r of rows.slice(1)) {
    const get = (c) => (idx[c] >= 0 ? String(r[idx[c]] ?? '').trim() : '');
    if (!get('cat')) continue;
    const item = { family: get('family').toUpperCase(), mfg: get('mfg'), cat: get('cat'), desc: get('desc') };
    for (const opt of ['rating', 'type', 'assycode', 'footprint']) if (get(opt)) item[opt] = get(opt);
    items.push(item);
  }
  return items;
}

// ------------------------------------------------------------------ CLI

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opts[key] = true;
      else {
        opts[key] = next;
        i += 1;
      }
    } else positional.push(a);
  }
  return { opts, positional };
}

const need = (opts, k) => {
  if (!opts[k] || opts[k] === true) throw new Error(`--${k} is required`);
  return String(opts[k]);
};
const isoDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new Error(`"${s}" is not a YYYY-MM-DD date`);
  return s;
};
const today = () => new Date().toISOString().slice(0, 10);

function cmdKeygen(opts) {
  const out = String(opts.out || 'keys');
  mkdirSync(out, { recursive: true });
  const pemFile = join(out, 'pack-private.pem');
  if (existsSync(pemFile) && !opts.force) throw new Error(`${pemFile} exists; pass --force to overwrite (this would invalidate nothing already sold, but keep the old key to re-sign)`);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(pemFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const pub = rawPublicKey(publicKey).toString('base64');
  writeFileSync(join(out, 'pack-public.txt'), pub + '\n');
  const keyId = String(opts['key-id'] || `pub-${new Date().getUTCFullYear()}`);
  process.stdout.write(`Private key: ${pemFile}  (keep it secret, never commit it)\n`);
  process.stdout.write(`Public key (raw Ed25519, base64): ${pub}\n\n`);
  process.stdout.write(`Add to src/electrical/pack-keys.json and rebuild the app:\n  "${keyId}": "${pub}"\n`);
}

function readCatalogInput(file) {
  const text = readFileSync(file, 'utf8');
  if (/\.csv$/i.test(file)) return { items: csvToCatalog(text) };
  const raw = JSON.parse(text);
  if (Array.isArray(raw)) return { items: raw };
  if (raw && typeof raw === 'object') {
    if (raw.format === PACK_FORMAT && Array.isArray(raw.catalog)) return { pack: raw, items: raw.catalog };
    if (Array.isArray(raw.items)) return { items: raw.items };
  }
  throw new Error(`${file}: expected a JSON array of parts, {"items":[...]}, an existing pack or a CSV`);
}

function cmdSign(opts) {
  const privateKey = createPrivateKey(readFileSync(need(opts, 'key'), 'utf8'));
  const keyId = need(opts, 'key-id');
  const input = readCatalogInput(need(opts, 'in'));
  const prev = input.pack || {};
  const licensee = String(opts.licensee || (prev.license && prev.license.licensee) || '');
  if (!licensee) throw new Error('--licensee is required (buyer name or e-mail)');
  const expiresOpt = opts.expires === undefined ? (prev.license ? prev.license.expires : null) : opts.expires === 'never' || opts.expires === 'null' ? null : isoDate(String(opts.expires));
  const id = String(opts.id || prev.id || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error('--id is required: letters, digits, . _ - (up to 64 characters), e.g. acme-rockwell-2026');
  const pack = {
    format: PACK_FORMAT,
    id,
    name: String(opts.name || prev.name || id),
    publisher: String(opts.publisher || prev.publisher || 'JCad Electrical'),
    version: String(opts.version || prev.version || `${new Date().getUTCFullYear()}.1`),
    kind: String(opts.kind || prev.kind || 'catalog'),
    license: {
      licensee,
      issued: opts.issued ? isoDate(String(opts.issued)) : today(),
      expires: expiresOpt,
      seats: Number(opts.seats || (prev.license && prev.license.seats) || 1),
    },
    catalog: input.items,
  };
  if (prev.description || opts.description) pack.description = String(opts.description || prev.description);
  const signed = signPack(pack, privateKey, keyId);
  const out = String(opts.out || `${id}.jcadpack.json`);
  if (!/\.jcadpack\.json$/.test(out)) throw new Error('--out must end with .jcadpack.json (the app only installs files with that suffix)');
  writeFileSync(out, JSON.stringify(signed, null, 1) + '\n');
  process.stdout.write(`Signed ${out}: ${signed.catalog.length} part(s), licensee "${licensee}", expires ${expiresOpt ?? 'never'}, key ${keyId}\n`);
}

function loadKeys(opts) {
  if (opts.pubkey) return { [String(opts['key-id'] || '*')]: String(opts.pubkey) };
  const here = dirname(fileURLToPath(import.meta.url));
  const file = String(opts.keys || join(here, '..', 'src', 'electrical', 'pack-keys.json'));
  return JSON.parse(readFileSync(file, 'utf8'));
}

function cmdVerify(opts, positional) {
  const file = positional[0];
  if (!file) throw new Error('usage: verify <file.jcadpack.json> [--keys pack-keys.json]');
  const pack = JSON.parse(readFileSync(file, 'utf8'));
  const keys = loadKeys(opts);
  if (keys['*'] && pack.signature) keys[pack.signature.keyId] = keys['*'];
  const problems = [];
  if (pack.format !== PACK_FORMAT) problems.push(`format is "${pack.format}", expected "${PACK_FORMAT}"`);
  if (!Array.isArray(pack.catalog)) problems.push('catalog is not an array');
  if (!pack.license || typeof pack.license.licensee !== 'string') problems.push('license.licensee is missing');
  const sig = verifyPackSignature(pack, keys);
  const expires = pack.license && pack.license.expires;
  const expired = typeof expires === 'string' && Date.parse(`${expires}T00:00:00Z`) + 86400000 <= Date.now();
  process.stdout.write(`File:      ${resolve(file)}\n`);
  process.stdout.write(`Pack:      ${pack.name} (${pack.id}) v${pack.version} by ${pack.publisher}\n`);
  process.stdout.write(`Parts:     ${Array.isArray(pack.catalog) ? pack.catalog.length : '?'}\n`);
  process.stdout.write(`Licensee:  ${pack.license ? pack.license.licensee : '?'}\n`);
  process.stdout.write(`Issued:    ${pack.license ? pack.license.issued : '?'}\n`);
  process.stdout.write(`Expires:   ${expires ?? 'never'}${expired ? '  (EXPIRED)' : ''}\n`);
  process.stdout.write(`Key:       ${sig.keyId ?? '-'}\n`);
  process.stdout.write(`Signature: ${sig.ok ? 'valid' : `INVALID - ${sig.reason}`}\n`);
  for (const p of problems) process.stdout.write(`Problem:   ${p}\n`);
  const valid = sig.ok && problems.length === 0;
  process.stdout.write(valid ? (expired ? 'RESULT: valid signature, licence expired (the app still loads it and shows the date)\n' : 'RESULT: valid\n') : 'RESULT: invalid\n');
  process.exitCode = valid ? 0 : 1;
}

function cmdCsv2Catalog(positional) {
  const [inFile, outFile] = positional;
  if (!inFile || !outFile) throw new Error('usage: csv2catalog in.csv out.json');
  const items = csvToCatalog(readFileSync(inFile, 'utf8'));
  writeFileSync(outFile, JSON.stringify(items, null, 1) + '\n');
  process.stdout.write(`${outFile}: ${items.length} part(s)\n`);
}

function usage() {
  process.stdout.write(
    [
      'pack-sign: build, sign and verify JCad Electrical catalog packs',
      '',
      '  keygen  --out keys/ [--key-id pub-2026] [--force]',
      '  csv2catalog in.csv out.json',
      '  sign    --key keys/pack-private.pem --key-id pub-2026 --licensee "Name <mail>" [--expires YYYY-MM-DD|never]',
      '          --in parts.json|parts.csv|old.jcadpack.json --out shop.jcadpack.json --id acme-2026 --name "..." --version 2026.1',
      '          [--publisher "..."] [--seats 1] [--issued YYYY-MM-DD] [--description "..."]',
      '  verify  file.jcadpack.json [--keys src/electrical/pack-keys.json | --pubkey <base64>]',
      '',
    ].join('\n'),
  );
}

export function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  const { opts, positional } = parseArgs(rest);
  switch (cmd) {
    case 'keygen':
      return cmdKeygen(opts);
    case 'sign':
      return cmdSign(opts);
    case 'verify':
      return cmdVerify(opts, positional);
    case 'csv2catalog':
      return cmdCsv2Catalog(positional);
    default:
      usage();
      if (cmd && cmd !== '--help' && cmd !== '-h') process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`pack-sign: ${err && err.message ? err.message : err}\n`);
    process.exitCode = 1;
  }
}
