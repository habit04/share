// P28 finish slice — section 2.5 byte-channel tests (renderer side:
// items 10-14) plus the main-handler list (items 1-9) exercised through
// the real registerDrawingIpc with a stubbed module surface, following
// tests/portable-dwg-ipc.test.ts. Written before the handler exists.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bridgeUnderlayBytes, nullUnderlayBytes } from '../src/app/underlay-bytes';

const require = createRequire(import.meta.url);
const guard = require('../electron/ipc-guard.cjs') as {
  createPathPolicy: (d: unknown) => {
    rememberUnderlays: (drawing: string, names: string[]) => void;
    [k: string]: unknown;
  };
  dxfUnderlayNames: (text: string) => string[];
};

type Handler = (ev: unknown, ...args: unknown[]) => Promise<unknown>;

function loadHandler() {
  const root = mkdtempSync(join(tmpdir(), 'jcad-underlay-ipc-'));
  const dir = join(root, 'plans');
  mkdirSync(dir);
  const drawing = join(root, 'sheet.dxf');
  writeFileSync(drawing, '0\nSECTION\n');
  const known = new Set<string>([drawing]);
  const rejections: Array<{ kind: string; detail: string }> = [];
  const log = { reject: (kind: string, detail: string) => { rejections.push({ kind, detail }); } };
  const pathPolicy = guard.createPathPolicy({
    isKnownPath: (p: string) => known.has(p),
    knownPaths: () => known,
    log,
  });
  const source = readFileSync(new URL('../electron/main/ipc-drawings.cjs', import.meta.url), 'utf8');
  const handlers = new Map<string, Handler>();
  const module = { exports: {} as { registerDrawingIpc(ctx: unknown, opts: unknown): void } };
  const sourceRequire = createRequire(new URL('../electron/main/ipc-drawings.cjs', import.meta.url));
  new Function('require', 'module', 'process', source)((name: string) => {
    if (name === 'electron') return { dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }), showMessageBox: async () => ({ response: 0 }) } };
    if (name === '../portable-dwg.cjs') return { createPortableDwgExporter: () => ({ status: async () => ({ available: false }), export: async () => { throw new Error('n/a'); } }) };
    if (name === '../atomic-write.cjs') return { backupFile: async () => {}, copyFileAtomic: async () => {}, createAtomicWriter: () => ({ write: async () => {} }) };
    if (name === './app-data.cjs') return { writeUserFile: async () => {}, enqueueWrite: async (_k: string, fn: () => unknown) => fn() };
    if (name === './dwg.cjs') return { decodeDxf: async () => ({ text: '', encoding: 'utf8' }), readDwgWithProgress: async () => ({ payload: {}, version: 'AC1032' }) };
    if (name === './save-order.cjs') return { registerSaveOrder: () => undefined };
    if (name === '../windows-path-identity.cjs') return { coherentFileDigest: async () => null, identityPath: async (f: string) => f };
    return sourceRequire(name);
  }, module, process);
  const registry = {
    paths: () => known, grant: (p: string) => known.add(p), isKnown: (p: string) => known.has(p),
    writeRoot: () => undefined,
  };
  module.exports.registerDrawingIpc(
    { ipcMain: { handle: (n: string, fn: Handler) => handlers.set(n, fn) }, rejections: log, registry, pathPolicy, senderWindow: () => null },
    { takeHandedOverProject: () => false },
  );
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  return { root, dir, drawing, known, rejections, pathPolicy, invoke, handlers };
}

const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 7)]);

describe('read-underlay main handler (design 2.5, items 1-9)', () => {
  it('1. happy path: an in-limit PDF named by an opened drawing returns its raw bytes', async () => {
    const f = loadHandler();
    const file = join(f.dir, 'a.pdf');
    writeFileSync(file, PDF_BYTES);
    f.pathPolicy.rememberUnderlays(f.drawing, ['plans\\a.pdf']);
    const out = await f.invoke('read-underlay', file);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(out as Uint8Array).equals(PDF_BYTES)).toBe(true);
    rmSync(f.root, { recursive: true, force: true });
  });

  it('1b. happy path by confinement: a PDF next to a known drawing needs no explicit naming', async () => {
    const f = loadHandler();
    const file = join(f.root, 'beside.pdf');
    writeFileSync(file, PDF_BYTES);
    const out = await f.invoke('read-underlay', file);
    expect(Buffer.from(out as Uint8Array).equals(PDF_BYTES)).toBe(true);
    rmSync(f.root, { recursive: true, force: true });
  });

  it('2/3. missing file, directory, and ENOTDIR paths resolve null', async () => {
    const f = loadHandler();
    expect(await f.invoke('read-underlay', join(f.dir, 'nope.pdf'))).toBeNull();
    expect(await f.invoke('read-underlay', f.dir)).toBeNull(); // not .pdf -> null before fs anyway
    mkdirSync(join(f.root, 'dir.pdf'));
    expect(await f.invoke('read-underlay', join(f.root, 'dir.pdf'))).toBeNull();
    const plain = join(f.root, 'plain.pdf');
    writeFileSync(plain, PDF_BYTES);
    expect(await f.invoke('read-underlay', join(plain, 'inner.pdf'))).toBeNull(); // ENOTDIR
    rmSync(f.root, { recursive: true, force: true });
  });

  it('4/5. oversize by stat resolves null; the read is size-checked before and bounded during', async () => {
    const f = loadHandler();
    const big = join(f.dir, 'big.pdf');
    writeFileSync(big, Buffer.from('%PDF-'));
    truncateSync(big, 64 * 1024 * 1024 + 1);
    expect(await f.invoke('read-underlay', big)).toBeNull();
    const section = readFileSync('electron/main/ipc-drawings.cjs', 'utf8')
      .slice(readFileSync('electron/main/ipc-drawings.cjs', 'utf8').indexOf("ipcMain.handle('read-underlay'"));
    expect(section.indexOf('stat.size > MAX_UNDERLAY_BYTES')).toBeGreaterThan(-1);
    expect(section.indexOf('stat.size > MAX_UNDERLAY_BYTES')).toBeLessThan(section.indexOf('readLimitedFile'));
    rmSync(f.root, { recursive: true, force: true });
  });

  it('6. a non-.pdf name resolves null without any read (even with PDF content)', async () => {
    const f = loadHandler();
    const file = join(f.dir, 'a.png');
    writeFileSync(file, PDF_BYTES);
    expect(await f.invoke('read-underlay', file)).toBeNull();
    rmSync(f.root, { recursive: true, force: true });
  });

  it('7. a .pdf name whose content lacks %PDF- magic resolves null', async () => {
    const f = loadHandler();
    const file = join(f.dir, 'fake.pdf');
    writeFileSync(file, Buffer.alloc(128, 65));
    expect(await f.invoke('read-underlay', file)).toBeNull();
    rmSync(f.root, { recursive: true, force: true });
  });

  it('8. malformed and unconfined paths throw Invalid path and are logged, truncated', async () => {
    const f = loadHandler();
    await expect(f.invoke('read-underlay', 'relative.pdf')).rejects.toThrow('Invalid path');
    // An EXISTING pdf outside every permitted folder: the canonicalizer refuses.
    const elsewhere = mkdtempSync(join(tmpdir(), 'jcad-underlay-elsewhere-'));
    const outside = join(elsewhere, 'x.pdf');
    writeFileSync(outside, PDF_BYTES);
    await expect(f.invoke('read-underlay', outside)).rejects.toThrow('Invalid path');
    const logged = f.rejections.filter((r) => r.kind === 'read-underlay');
    expect(logged.length).toBeGreaterThan(0);
    for (const r of logged) expect(r.detail.length).toBeLessThanOrEqual(320);
    rmSync(f.root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('9. the handler performs no directory listing or globbing (source census)', () => {
    const src = readFileSync('electron/main/ipc-drawings.cjs', 'utf8');
    const section = src.slice(src.indexOf("ipcMain.handle('read-underlay'"), src.indexOf('end of read-underlay'));
    expect(section.length).toBeGreaterThan(0);
    expect(section).not.toContain('readdir');
    expect(section).not.toContain('glob');
  });
});

describe('underlay path policy sibling (ipc-guard.cjs)', () => {
  it('underlayPath refuses a .pdf through the image canonicalizer premise (D-3): pdf ext required, own error code', async () => {
    const f = loadHandler();
    const file = join(f.dir, 'a.pdf');
    writeFileSync(file, PDF_BYTES);
    f.pathPolicy.rememberUnderlays(f.drawing, ['plans\\a.pdf']);
    const policy = f.pathPolicy as unknown as { underlayPath: (p: string) => Promise<string>; underlayProblem: (p: unknown) => string | null };
    await expect(policy.underlayPath(file)).resolves.toBe(file);
    await expect(policy.underlayPath(join(f.dir, 'a.png'))).rejects.toMatchObject({ code: 'ERR_UNDERLAY_PATH' });
    expect(policy.underlayProblem(join(f.dir, 'a.png'))).not.toBeNull();
    rmSync(f.root, { recursive: true, force: true });
  });

  it('dxfUnderlayNames extracts group-1 names from underlay definition records only', () => {
    const text = ['0', 'SECTION', '2', 'OBJECTS', '0', 'PDFDEFINITION', '5', '41', '1', 'plans\\a.pdf', '0', 'IMAGEDEF', '1', 'img.png', '0', 'ENDSEC'].join('\n');
    expect(guard.dxfUnderlayNames(text)).toEqual(['plans\\a.pdf']);
  });
});

describe('bridge byte source (design 2.5, items 10-12)', () => {
  it('10. a relative path with a never-saved drawing resolves null with zero bridge calls', async () => {
    let calls = 0;
    const bytesFor = bridgeUnderlayBytes({ readUnderlay: async () => { calls += 1; return new Uint8Array(1); }, drawingPath: () => null });
    expect(await bytesFor(def('plans\\floor.pdf'))).toBeNull();
    expect(calls).toBe(0);
  });

  it('11. candidates are tried in imageCandidates order; the first non-null wins and stops', async () => {
    const tried: string[] = [];
    const bytesFor = bridgeUnderlayBytes({
      readUnderlay: async (file: string) => { tried.push(file); return file.endsWith('floor.pdf') && file.includes('/drawings/') ? new Uint8Array([5]) : null; },
      drawingPath: () => '/proj/drawings/sheet.dxf',
    });
    const out = await bytesFor(def('C:\\old-place\\floor.pdf'));
    expect(out).toEqual(new Uint8Array([5]));
    // Absolute stored path first (as-is), then the bare name beside the drawing.
    expect(tried[0]).toBe('C:\\old-place\\floor.pdf');
    expect(tried[tried.length - 1]).toContain('/proj/drawings/');
  });

  it('12. a bridge throw resolves null without throwing; nullUnderlayBytes is inert', async () => {
    const bytesFor = bridgeUnderlayBytes({ readUnderlay: async () => { throw new Error('Invalid path'); }, drawingPath: () => '/p/x.dxf' });
    expect(await bytesFor(def('/p/a.pdf'))).toBeNull();
    expect(await nullUnderlayBytes(def())).toBeNull();
  });
});

describe('preload + confinement census (design 2.5, items 13-14)', () => {
  it('13. the preload surface gains exactly readUnderlay, mirroring readImage', () => {
    const preload = readFileSync('electron/preload.cjs', 'utf8');
    expect(preload).toContain("readUnderlay: (file) => ipcRenderer.invoke('read-underlay', file)");
    expect(preload.split('readUnderlay').length - 1).toBe(1);
  });

  it('14. readUnderlay is referenced from exactly the bridge type and the byte module', () => {
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
    const hits: string[] = [];
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const p = `${d}/${name}`;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && readFileSync(p, 'utf8').includes('readUnderlay')) hits.push(p);
      }
    };
    walk('src');
    expect(hits.sort()).toEqual(['src/app/underlay-bytes.ts', 'src/main.ts']);
  });
});

function def(sourcePath = 'plans\\floor.pdf'): UnderlayDefinition {
  return { id: 'underlaydef:41', handle: '41', kind: 'pdf', sourcePath, retainedGroups: [] };
}
import type { UnderlayDefinition } from '../src/core/underlay';
