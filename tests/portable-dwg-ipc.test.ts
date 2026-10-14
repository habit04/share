/** DWG IPC/converter protocol; native Windows identities on Windows, scoped host doubles elsewhere. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, type BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const sourceUrl = new URL('../electron/main/ipc-drawings.cjs', import.meta.url);
const sourceRequire = createRequire(sourceUrl);
const source = readFileSync(sourceUrl, 'utf8');
type Handler = (ev: unknown, ...args: unknown[]) => Promise<unknown>;
type Registry = {
  grant(file: string): boolean;
  grantRead(file: string): boolean;
  isKnown(file: string): boolean;
  isWritable(file: string): boolean;
  writeRoot(file: string): string | null;
  registerProject(file: string, project: unknown, opts?: { userChosen?: boolean }): unknown;
  paths(): Iterable<string>;
};
const { createPathRegistry } = require('../electron/path-registry.cjs') as { createPathRegistry(): Registry };
const { createPathPolicy, dxfImageNames } = require('../electron/ipc-guard.cjs') as {
  createPathPolicy(opts: unknown): { rememberImages: (file: string, names: string[]) => void };
  dxfImageNames(text: string): string[];
};
type AtomicWriter = { atomicWriteFile(file: string, bytes: Buffer, options: { backup: boolean; expectedDestination: string; root?: string }): Promise<void> };
const atomic = require('../electron/atomic-write.cjs') as { createAtomicWriter(fileSystem?: typeof fs, options?: { hooks: { beforeRename(): Promise<void> } }): AtomicWriter; createCanonicalWriteQueue(): (file: string, callback: (key: string) => Promise<void>) => Promise<void> };
const roots: string[] = [];
const DXF = '0\r\nSECTION\r\n2\r\nHEADER\r\n0\r\nENDSEC\r\n0\r\nEOF\r\n';
const OUTPUT = Buffer.concat([Buffer.from('AC1032'), Buffer.alloc(130)]);

/**
 * The IPC source advertises Windows to exercise its DWG channels on every CI host.
 * POSIX temporary paths are not native Windows paths. This local adapter supplies
 * host path syntax while retaining real held-FD bytes, versions and confinement;
 * it is protocol coverage, not a simulation/certification of Windows filesystem rules.
 * The real Windows helper/source-proof suites remain the native authority gate.
 */
function protocolHostModules() {
  const native = sourceRequire('../windows-path-identity.cjs');
  type Version = { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string; sha256?: string };
  type Pin = { logicalPath: string; destinationPath: string; canonicalPath: string; canonicalParent: string; parentExists: boolean; parentIdentity: Version; queueKey: string; targetKey: string; exists: boolean; fileVersion: Version | null; root?: string; canonicalRoot?: string; rootIdentity?: Version; hashContent?: boolean; contentLimit?: number };
  type Guard = { signal?: AbortSignal; metadataOnly?: boolean; preserveLeaf?: boolean; preserveVersion?: boolean; maxBytes?: number };
  const fail = (code: string) => Object.assign(new Error(code), { code });
  const absolute = (value: unknown) => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > native.MAX_PATH_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) throw fail('ERR_WINDOWS_PATH');
    return path.resolve(value);
  };
  const version = (stat: BigIntStats): Version => ({ dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) });
  const statKey = (value: Version) => native.fileVersionKey({ ...value, sha256: undefined });
  const sameIdentity = (a: Version, b: Version) => a.dev === b.dev && a.ino === b.ino;
  const inside = (root: string, file: string) => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw fail('ERR_SAVE_CANCELLED'); };
  async function digest(value: string, opts: { signal?: AbortSignal; maxBytes?: number; expectedCanonicalPath?: string; expectedVersion?: Version } = {}) {
    const file = absolute(value), canonicalPath = await fs.realpath(file); abort(opts.signal);
    if (opts.expectedCanonicalPath !== undefined && canonicalPath !== opts.expectedCanonicalPath) throw fail('ERR_WINDOWS_PATH_CHANGED');
    const handle = await fs.open(file, 'r');
    let evidence!: Version, bytes!: Buffer;
    const check = async () => {
      abort(opts.signal);
      if (await fs.realpath(file) !== canonicalPath || statKey(version(await fs.stat(file, { bigint: true }))) !== statKey(evidence)) throw fail('ERR_WINDOWS_PATH_CHANGED');
    };
    try {
      const stat = await handle.stat({ bigint: true }); evidence = version(stat);
      if (!stat.isFile() || stat.size > BigInt(opts.maxBytes ?? native.MAX_CONTENT_BYTES)) throw fail('ERR_WINDOWS_CONTENT_LIMIT');
      if (opts.expectedVersion && statKey(evidence) !== statKey(opts.expectedVersion)) throw fail('ERR_WINDOWS_PATH_CHANGED');
      await check(); bytes = await handle.readFile(); abort(opts.signal);
      if (BigInt(bytes.byteLength) !== stat.size || statKey(version(await handle.stat({ bigint: true }))) !== statKey(evidence)) throw fail('ERR_WINDOWS_PATH_CHANGED');
      await check();
    } finally { await handle.close(); }
    await check();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (opts.expectedVersion?.sha256 !== undefined && sha256 !== opts.expectedVersion.sha256) throw fail('ERR_WINDOWS_PATH_CHANGED');
    return { sha256, bytes: bytes.byteLength, canonicalPath, version: evidence };
  }
  const identity = {
    ...native, absoluteWindowsPath: absolute, coherentFileDigest: digest,
    createWindowsPathIdentity() {
      const pins = new WeakSet<Pin>();
      const seal = (pin: Pin) => { Object.freeze(pin); pins.add(pin); return pin; };
      const captureWriteTarget = async (value: string, rootValue?: string): Promise<Pin> => {
        const logicalPath = absolute(value), canonicalParent = await fs.realpath(path.dirname(logicalPath)), parent = await fs.stat(canonicalParent, { bigint: true });
        const root = rootValue === undefined ? undefined : absolute(rootValue), canonicalRoot = root === undefined ? undefined : await fs.realpath(root);
        if (canonicalRoot && !inside(canonicalRoot, canonicalParent)) throw fail('ELOOP');
        let stat: BigIntStats | null;
        try { stat = await fs.lstat(logicalPath, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; stat = null; }
        if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw fail('ELOOP');
        const canonicalPath = path.join(canonicalParent, path.basename(logicalPath));
        return seal({ logicalPath, destinationPath: canonicalPath, canonicalPath, canonicalParent, parentExists: parent.isDirectory(), parentIdentity: version(parent), queueKey: canonicalParent, targetKey: canonicalPath, exists: stat !== null, fileVersion: stat ? Object.freeze(version(stat)) : null,
          ...(root && canonicalRoot ? { root, canonicalRoot, rootIdentity: version(await fs.stat(canonicalRoot, { bigint: true })) } : {}) });
      };
      const revalidate = async (pin: Pin, opts: Guard = {}): Promise<Pin> => {
        if (!pins.has(pin)) throw fail('ERR_WINDOWS_IDENTITY'); abort(opts.signal);
        let fresh = await captureWriteTarget(pin.logicalPath, pin.root);
        if (fresh.canonicalParent !== pin.canonicalParent || !sameIdentity(fresh.parentIdentity, pin.parentIdentity) || fresh.canonicalRoot !== pin.canonicalRoot || pin.rootIdentity && (!fresh.rootIdentity || !sameIdentity(fresh.rootIdentity, pin.rootIdentity)) || opts.preserveLeaf && fresh.canonicalPath !== pin.canonicalPath) throw fail('ERR_WINDOWS_PATH_CHANGED');
        if (pin.hashContent && !opts.metadataOnly) {
          const contentLimit = pin.contentLimit ?? native.MAX_CONTENT_BYTES;
          const content = fresh.exists ? await digest(fresh.logicalPath, { signal: opts.signal, maxBytes: contentLimit, expectedCanonicalPath: fresh.canonicalPath, expectedVersion: fresh.fileVersion! }) : null;
          fresh = seal({ ...fresh, hashContent: true, contentLimit, fileVersion: content ? Object.freeze({ ...content.version, sha256: content.sha256 }) : null });
        }
        if (opts.preserveVersion && native.fileVersionKey(fresh.fileVersion) !== native.fileVersionKey(pin.fileVersion)) throw fail('ERR_WINDOWS_PATH_CHANGED');
        abort(opts.signal); return fresh;
      };
      const captureContentTarget = async (pin: Pin, opts: Guard = {}) => {
        const contentLimit = opts.maxBytes ?? native.MAX_CONTENT_BYTES;
        if (contentLimit !== native.MAX_CONTENT_BYTES && contentLimit !== native.MAX_PDF_CONTENT_BYTES) throw fail('ERR_WINDOWS_CONTENT_LIMIT');
        const fresh = await revalidate(pin, { ...opts, metadataOnly: true, preserveLeaf: true, preserveVersion: true });
        const content = fresh.exists ? await digest(fresh.logicalPath, { signal: opts.signal, maxBytes: contentLimit, expectedCanonicalPath: fresh.canonicalPath, expectedVersion: fresh.fileVersion! }) : null;
        return seal({ ...fresh, hashContent: true, contentLimit, fileVersion: content ? Object.freeze({ ...content.version, sha256: content.sha256 }) : null });
      };
      return { captureWriteTarget, captureContentTarget, revalidate };
    },
  };
  // Actual order/registry code runs in an isolated loader: no require cache or global
  // process/path mutation can leak this host adapter into any native test or product.
  const scoped = new Set(['save-order.cjs', 'opened-source-proofs.cjs', 'save-admissions.cjs']);
  const cache = new Map<string, { exports: any }>();
  const load = (file: string): any => {
    const existing = cache.get(file); if (existing) return existing.exports;
    const localRequire = createRequire(file), module = { exports: {} }; cache.set(file, module);
    new Function('require', 'module', readFileSync(file, 'utf8'))((name: string) => {
      if (name.endsWith('windows-path-identity.cjs')) return identity;
      const resolved = localRequire.resolve(name);
      return scoped.has(path.basename(resolved)) ? load(resolved) : localRequire(name);
    }, module);
    return module.exports;
  };
  return { identity, saveOrder: load(sourceRequire.resolve('./save-order.cjs')) };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(tmpdir()));
    expect(path.basename(root)).toMatch(/^jcad-portable-dwg-ipc-/);
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function setup(platform: NodeJS.Platform = 'win32', protocolDouble = process.platform !== 'win32') {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'jcad-portable-dwg-ipc-'));
  roots.push(root);
  const target = path.join(root, 'drawing.dwg');
  const registry = createPathRegistry();
  const reject = vi.fn();
  const pathPolicy = createPathPolicy({ isKnownPath: (p: string) => registry.isKnown(p), isWritablePath: (p: string) => registry.isWritable(p), knownPaths: () => registry.paths(), log: { reject } });
  const rememberImages = vi.spyOn(pathPolicy, 'rememberImages');
  const webContents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const win = Object.assign(new EventEmitter(), { webContents });
  const status = vi.fn(async () => ({ available: true, reason: undefined as string | undefined }));
  const exportCall = vi.fn(async (file: string, _text: string, commit: (file: string, bytes: Buffer, check: () => Promise<void>) => Promise<void>, signal: AbortSignal) => {
    const check = async () => { if (signal.aborted) throw new Error('Canceled'); };
    await check();
    await commit(file, OUTPUT, check);
    return file;
  });
  const showSaveDialog = vi.fn(async (_win: unknown, _opts: unknown) => ({ canceled: false, filePath: target }));
  const showOpenDialog = vi.fn(async (_win: unknown, _opts: unknown) => ({ canceled: false, filePaths: [target] }));
  const showMessageBox = vi.fn(async (_win: unknown, _opts: unknown) => ({ response: 0 }));
  const writeUserFile = vi.fn();
  const readDwgWithProgress = vi.fn(async () => ({ payload: { imageDefs: [] }, version: 'AC1032' }));
  const handlers = new Map<string, Handler>();
  const writerFactory = vi.fn((fileSystem?: typeof fs, options?: { hooks: { beforeRename(): Promise<void> } }) => atomic.createAtomicWriter(fileSystem, options));
  const enqueueWrite = atomic.createCanonicalWriteQueue();
  const module = { exports: {} as { registerDrawingIpc(ctx: unknown, opts: unknown): void } };
  const protocol = platform === 'win32' && protocolDouble ? protocolHostModules() : undefined;
  new Function('require', 'module', 'process', source)((name: string) => {
    if (name === 'electron') return { dialog: { showSaveDialog, showOpenDialog, showMessageBox } };
    if (name === '../portable-dwg.cjs') return { createPortableDwgExporter: () => ({ status, export: exportCall }) };
    if (name === '../atomic-write.cjs') return { ...atomic, createAtomicWriter: writerFactory };
    if (name === './app-data.cjs') return { writeUserFile, enqueueWrite };
    if (name === './dwg.cjs') return { decodeDxf: vi.fn(), readDwgWithProgress };
    if (protocol && name === './save-order.cjs') return protocol.saveOrder;
    if (protocol && name === '../windows-path-identity.cjs') return protocol.identity;
    return sourceRequire(name);
  }, module, { platform });
  module.exports.registerDrawingIpc({ ipcMain: { handle: (name: string, fn: Handler) => handlers.set(name, fn) }, rejections: { reject }, registry, pathPolicy, senderWindow: () => win }, { takeHandedOverProject: () => false });
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  return { root, target, registry, invoke, status, exportCall, showSaveDialog, showOpenDialog, showMessageBox, rememberImages, win, writerFactory, writeUserFile };
}

describe('portable DWG IPC', () => {
  it('does not authorize an unchosen Unicode-equivalent Windows export destination', async () => {
    const f = await setup('win32');
    const chosen = path.join(f.root, 'Jos\u00e9.dwg');
    const unchosen = path.join(f.root, 'Jose\u0301.dwg');
    f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: chosen });
    await f.invoke('choose-dwg-path');
    // Existing working-file authority is independent of the Export Copy picker.
    f.registry.grant(unchosen);
    await expect(f.invoke('export-dwg', unchosen, DXF)).rejects.toThrow(/Save dialog first/);
    expect(f.exportCall).not.toHaveBeenCalled();
    expect(await f.invoke('export-dwg', chosen, DXF)).toBe(chosen);
  });
  it('uses a dedicated native picker and publishes portable availability', async () => {
    const f = await setup();
    expect(await f.invoke('dwg-export-status')).toEqual({ available: true, reason: undefined });
    expect(await f.invoke('choose-dwg-path', 'Panel.dwg')).toBe(f.target);
    expect(f.showSaveDialog).toHaveBeenCalledWith(f.win, expect.objectContaining({ title: 'Export DWG Copy', defaultPath: 'Panel.dwg', filters: [{ name: 'DWG Drawing (AutoCAD 2018)', extensions: ['dwg'] }] }));
    expect(f.registry.isWritable(f.target)).toBe(true);
  });

  it('normal native drawing authority never grants export-copy permission', async () => {
    const f = await setup();
    f.registry.grant(f.target);
    await expect(f.invoke('export-dwg', f.target, DXF)).rejects.toThrow(/Save dialog first/);
    expect(f.exportCall).not.toHaveBeenCalled();
  });

  it('commits through a canonical reservation with backups and a pre-rename guard, then records image references', async () => {
    const f = await setup();
    await fs.writeFile(f.target, 'original DWG bytes');
    await f.invoke('choose-dwg-path', 'drawing.dwg');
    expect(await f.invoke('export-dwg', f.target, DXF)).toBe(f.target);
    expect(await fs.readFile(f.target)).toEqual(OUTPUT);
    expect(await fs.readFile(`${f.target}.bak`, 'utf8')).toBe('original DWG bytes');
    expect(f.writerFactory).toHaveBeenCalledWith(undefined, expect.objectContaining({ hooks: { beforeAttempt: expect.any(Function) } }));
    expect(f.rememberImages).toHaveBeenCalledWith(f.target, dxfImageNames(DXF));
    // One owner-lifetime watcher remains; individual saves do not accumulate listeners.
    expect(f.win.listenerCount('closed')).toBe(1);
    expect(f.win.webContents.listenerCount('destroyed')).toBe(1);
    expect(f.win.webContents.listenerCount('render-process-gone')).toBe(1);
  });

  it.each(['export-dwg', 'save-dwg'])('%s cancels when the caller closes, keeping the original and clearing listeners', async (channel) => {
    const f = await setup();
    await fs.writeFile(f.target, 'original');
    await f.invoke('choose-dwg-path');
    f.exportCall.mockImplementation(async (_file, _text, _commit, signal) => {
      f.win.emit('closed');
      expect(signal.aborted).toBe(true);
      throw new Error('Canceled');
    });
    await expect(f.invoke(channel, f.target, DXF)).rejects.toThrow(/Canceled/);
    expect(await fs.readFile(f.target, 'utf8')).toBe('original');
    expect(f.rememberImages).not.toHaveBeenCalled();
    expect(f.win.listenerCount('closed')).toBe(0);
  });

  it.each(['destroyed', 'render-process-gone'].flatMap((event) => ['export-dwg', 'save-dwg'].map((channel) => [event, channel])))('%s cancels the originating renderer\'s %s', async (event, channel) => {
    const f = await setup();
    await f.invoke('choose-dwg-path');
    f.exportCall.mockImplementation(async (_file, _text, _commit, signal) => {
      f.win.webContents.emit(event);
      expect(signal.aborted).toBe(true);
      throw new Error('Canceled');
    });
    await expect(f.invoke(channel, f.target, DXF)).rejects.toThrow(/Canceled/);
  });

  it('rejects invalid payloads and destinations without launching a writer', async () => {
    const f = await setup();
    await f.invoke('choose-dwg-path');
    for (const text of [null, { text: DXF }]) await expect(f.invoke('export-dwg', f.target, text)).rejects.toThrow(/Invalid DXF payload/);
    for (const target of ['relative.dwg', `${f.target}\0`, path.join(f.root, 'other.dxf')]) await expect(f.invoke('export-dwg', target, DXF)).rejects.toThrow(/Save dialog first/);
    expect(f.exportCall).not.toHaveBeenCalled();
  });

  it('refuses unavailable writers and canceled or malformed native picker results', async () => {
    const f = await setup();
    f.status.mockResolvedValue({ available: false, reason: 'Broken writer' });
    await expect(f.invoke('choose-dwg-path')).rejects.toThrow('Broken writer');
    expect(f.showSaveDialog).not.toHaveBeenCalled();
    f.status.mockResolvedValue({ available: true, reason: undefined });
    f.showSaveDialog.mockResolvedValue({ canceled: true, filePath: f.target });
    expect(await f.invoke('choose-dwg-path')).toBe(null);
    expect(f.registry.isKnown(f.target)).toBe(false);
    f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: 'relative.dwg' });
    expect(await f.invoke('choose-dwg-path')).toBe(null);
    await expect(f.invoke('choose-dwg-path', 'bad\0name')).rejects.toThrow(/Invalid DWG filename/);
  });

  it('confirms replacement after completing an extension instead of overwriting an unconfirmed DWG', async () => {
    const f = await setup();
    await fs.writeFile(f.target, 'original');
    f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: f.target.slice(0, -4) });
    f.showMessageBox.mockResolvedValue({ response: 1 });
    expect(await f.invoke('choose-dwg-path')).toBe(null);
    expect(f.registry.isKnown(f.target)).toBe(false);
    expect(await fs.readFile(f.target, 'utf8')).toBe('original');
    f.showMessageBox.mockResolvedValue({ response: 0 });
    expect(await f.invoke('choose-dwg-path')).toBe(f.target);
    expect(f.registry.isWritable(f.target)).toBe(true);
  });

  it.each(['dxf', 'dwg'])('offers both Windows Save As formats with the suggested %s first, writing nothing in the dialog', async (format) => {
    const f = await setup();
    const target = path.join(f.root, `Panel.${format}`);
    f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });
    expect(await f.invoke('choose-drawing-path', `Panel.${format}`)).toBe(target);
    expect(f.showSaveDialog).toHaveBeenCalledWith(f.win, expect.objectContaining({
      title: 'Save Drawing As', defaultPath: `Panel.${format}`,
      filters: format === 'dwg'
        ? [{ name: 'DWG Drawing (AutoCAD 2018)', extensions: ['dwg'] }, { name: 'DXF Drawing (AutoCAD 2000)', extensions: ['dxf'] }]
        : [{ name: 'DXF Drawing (AutoCAD 2000)', extensions: ['dxf'] }, { name: 'DWG Drawing (AutoCAD 2018)', extensions: ['dwg'] }],
    }));
    expect(f.registry.isWritable(target)).toBe(true);
    expect(f.exportCall).not.toHaveBeenCalled();
    expect(f.writeUserFile).not.toHaveBeenCalled();
  });

  it.each([['Panel.dxf', 'drawing.DWG'], ['Panel.dwg', 'drawing.DXF']])('honors the typed extension when %s suggests another format', async (suggestName, chosenName) => {
    const f = await setup();
    const target = path.join(f.root, chosenName);
    f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });
    expect(await f.invoke('choose-drawing-path', suggestName)).toBe(target);
    expect(f.registry.isWritable(target)).toBe(true);
  });

  it('keeps explicit DXF exports DXF-only on Windows and validates the format option', async () => {
    const f = await setup();
    const target = path.join(f.root, 'drawing.dxf');
    f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target.slice(0, -4) });
    expect(await f.invoke('choose-drawing-path', 'Panel.dwg', 'dxf')).toBe(target);
    expect(f.showSaveDialog).toHaveBeenCalledWith(f.win, expect.objectContaining({ defaultPath: 'Panel.dxf', filters: [{ name: 'DXF Drawing (AutoCAD 2000)', extensions: ['dxf'] }] }));
    f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: f.target });
    await expect(f.invoke('choose-drawing-path', 'Panel.dwg', 'dxf')).rejects.toThrow(/supported drawing extension/);
    expect(f.registry.isKnown(f.target)).toBe(false);
    f.showSaveDialog.mockClear();
    for (const format of [null, 'dwg', {}, true]) await expect(f.invoke('choose-drawing-path', 'Panel.dxf', format)).rejects.toThrow(/Invalid drawing format/);
    expect(f.showSaveDialog).not.toHaveBeenCalled();
  });

  it('confirms extensionless Save As replacement using the suggested format', async () => {
    const f = await setup();
    await fs.writeFile(f.target, 'original');
    f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: f.target.slice(0, -4) });
    f.showMessageBox.mockResolvedValue({ response: 1 });
    expect(await f.invoke('choose-drawing-path', 'drawing.dwg')).toBe(null);
    expect(f.registry.isKnown(f.target)).toBe(false);
    expect(await fs.readFile(f.target, 'utf8')).toBe('original');
    f.showMessageBox.mockResolvedValue({ response: 0 });
    expect(await f.invoke('choose-drawing-path', 'drawing.dwg')).toBe(f.target);
    expect(await f.invoke('save-dwg', f.target, DXF)).toBe(f.target);
    expect(await fs.readFile(f.target)).toEqual(OUTPUT);
    expect(await fs.readFile(`${f.target}.bak`, 'utf8')).toBe('original');
    await expect(f.invoke('export-dwg', f.target, DXF)).rejects.toThrow(/Save dialog first/);
  });

  it('refuses malformed and unsupported Save As destinations and cancellation without granting paths', async () => {
    const f = await setup();
    for (const target of ['relative.dwg', `${f.target}\0`]) {
      f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });
      expect(await f.invoke('choose-drawing-path')).toBe(null);
    }
    const unsupported = path.join(f.root, 'drawing.pdf');
    f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: unsupported });
    await expect(f.invoke('choose-drawing-path')).rejects.toThrow(/supported drawing extension/);
    expect(f.registry.isKnown(unsupported)).toBe(false);
    f.showSaveDialog.mockResolvedValue({ canceled: true, filePath: f.target });
    expect(await f.invoke('choose-drawing-path')).toBe(null);
    expect(f.registry.isKnown(f.target)).toBe(false);
    await expect(f.invoke('choose-drawing-path', 'bad\0name')).rejects.toThrow(/Invalid drawing filename/);
  });

  it.each(['darwin', 'linux'] as const)('keeps %s Save As DXF-only and refuses native DWG Save', async (platform) => {
    const f = await setup(platform);
    const target = path.join(f.root, 'drawing.dxf');
    f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });
    expect(await f.invoke('choose-drawing-path', 'Panel.dxf')).toBe(target);
    expect(f.showSaveDialog).toHaveBeenCalledWith(f.win, expect.objectContaining({ filters: [{ name: 'DXF Drawing (AutoCAD 2000)', extensions: ['dxf'] }] }));
    f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: f.target });
    await expect(f.invoke('choose-drawing-path', 'Panel.dwg')).rejects.toThrow(/supported drawing extension/);
    f.registry.grant(f.target);
    await expect(f.invoke('save-dwg', f.target, DXF)).rejects.toThrow(/Windows only/);
    expect(f.exportCall).not.toHaveBeenCalled();
  });

  const openedProofHosts: [string, boolean][] = process.platform === 'win32' ? [['native Windows host', false], ['scoped protocol host double', true]] : [['scoped POSIX protocol host double', true]];
  it.each(openedProofHosts)('saves a chosen DWG through its completed-open proof, mock conversion and an atomic backup (%s)', async (_host, protocolDouble) => {
    const f = await setup('win32', protocolDouble);
    await fs.writeFile(f.target, 'original');
    const opened = await f.invoke('open-drawing') as { openedSourceProof: string };
    expect(opened).toEqual({ path: f.target, identityPath: await fs.realpath(f.target), openedSourceProof: expect.stringMatching(/^[a-f0-9]{48}$/), kind: 'dwg', payload: { imageDefs: [] }, version: 'AC1032' });
    const ticket = await f.invoke('issue-save-admission', 'drawing');
    await f.invoke('bind-save-admission', ticket, 'drawing', f.target, { proof: opened.openedSourceProof, path: f.target, mode: 'in-place' });
    expect(await f.invoke('save-dwg', f.target, DXF, ticket)).toBe(f.target);
    const receipt = await f.invoke('save-admission-result', ticket) as { openedSourceProof: string };
    expect(receipt).toEqual({ path: f.target, identityPath: await fs.realpath(f.target), openedSourceProof: expect.stringMatching(/^[a-f0-9]{48}$/) });
    expect(receipt.openedSourceProof).not.toBe(opened.openedSourceProof);
    expect(await fs.readFile(f.target)).toEqual(OUTPUT);
    expect(await fs.readFile(`${f.target}.bak`, 'utf8')).toBe('original');
    await expect(f.invoke('export-dwg', f.target, DXF)).rejects.toThrow(/Save dialog first/);
    expect(f.exportCall).toHaveBeenCalledTimes(1);
  });

  it.each(openedProofHosts)('refuses a changed opened DWG before conversion or backup without inferring a fresh baseline (%s)', async (_host, protocolDouble) => {
    const f = await setup('win32', protocolDouble); await fs.writeFile(f.target, 'original'); await fs.writeFile(`${f.target}.bak`, 'KEEP');
    const opened = await f.invoke('open-drawing') as { openedSourceProof: string }; await fs.writeFile(f.target, 'outside');
    const ticket = await f.invoke('issue-save-admission', 'drawing');
    await expect(f.invoke('bind-save-admission', ticket, 'drawing', f.target, { proof: opened.openedSourceProof, path: f.target, mode: 'in-place' })).rejects.toThrow(/ERR_OPENED_SOURCE_CHANGED/);
    await expect(f.invoke('save-dwg', f.target, DXF)).rejects.toThrow(/ERR_OPENED_SOURCE_PROOF/);
    expect(f.exportCall).not.toHaveBeenCalled(); expect(await fs.readFile(f.target, 'utf8')).toBe('outside'); expect(await fs.readFile(`${f.target}.bak`, 'utf8')).toBe('KEEP');
  });

  it('refuses unknown, read-only, wrong-format and invalid DWG Save requests without launching a writer', async () => {
    const f = await setup();
    await expect(f.invoke('save-dwg', f.target, DXF)).rejects.toThrow(/Save As first/);
    f.registry.grantRead(f.target);
    await expect(f.invoke('save-dwg', f.target, DXF)).rejects.toThrow(/Save As first/);
    f.registry.grant(f.target);
    for (const target of [null, 'relative.dwg', `${f.target}\0`, path.join(f.root, 'drawing.dxf')]) await expect(f.invoke('save-dwg', target, DXF)).rejects.toThrow(/Save As first/);
    for (const text of [null, { text: DXF }]) await expect(f.invoke('save-dwg', f.target, text)).rejects.toThrow(/Invalid DXF payload/);
    await expect(f.invoke('save-dxf', f.target, DXF)).rejects.toThrow(/Invalid path/);
    expect(f.exportCall).not.toHaveBeenCalled();
    expect(f.writeUserFile).not.toHaveBeenCalled();
  });

  it('retains a by-name project\'s confinement when a linked DWG folder points outside it', async () => {
    const f = await setup();
    const project = path.join(f.root, 'project');
    const outside = path.join(f.root, 'outside');
    await fs.mkdir(project);
    await fs.mkdir(outside);
    const link = path.join(project, 'linked');
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const target = path.join(link, 'drawing.dwg');
    const original = path.join(outside, 'drawing.dwg');
    await fs.writeFile(original, 'original');
    f.registry.registerProject(path.join(project, 'Project.jcadproj.json'), { drawings: [{ file: target }] });
    expect(f.registry.isWritable(target)).toBe(true);
    expect(f.registry.writeRoot(target)).toBe(project);
    await expect(f.invoke('save-dwg', target, DXF)).rejects.toThrow(/ELOOP/);
    expect(await fs.readFile(original, 'utf8')).toBe('original');
    await expect(fs.access(`${original}.bak`)).rejects.toThrow();
    expect(f.rememberImages).not.toHaveBeenCalled();
  });
});
