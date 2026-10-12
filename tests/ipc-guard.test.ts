import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

// electron/ipc-guard.cjs is plain CommonJS for the main process (type-checked by tsconfig.electron.json).
const require = createRequire(import.meta.url);
const guard = require('../electron/ipc-guard.cjs') as {
  guardIpc: (ipc: unknown, o: unknown) => { handle: (c: string, f: (...a: unknown[]) => unknown) => void; on: (c: string, f: (...a: unknown[]) => void) => unknown; once: (c: string, f: (...a: unknown[]) => void) => unknown; removeListener: (c: string, f: (...a: unknown[]) => void) => unknown };
  appUrlTest: (index: string, dev?: string) => (url: string) => boolean;
  untrustedReason: (ev: unknown, win: unknown, isApp: (u: string) => boolean) => string | null;
  createPathPolicy: (d: unknown) => {
    known: (p: unknown, what: string) => string | null;
    imageProblem: (p: unknown) => string | null;
    imagePath: (p: string) => Promise<string>;
    rememberImages: (drawing: string, names: string[]) => void;
    insideRoot: (root: string, file: string, what: string) => Promise<string>;
  };
  dxfImageNames: (text: string) => string[];
  externalUrl: (u: unknown, o?: { cashApp?: boolean; supportEmail?: boolean }) => string | null;
};

const posix = process.platform !== 'win32';
const abs = (...p: string[]) => (posix ? `/${p.join('/')}` : `C:\\${p.join('\\')}`);

/** Exercise the real policy with Windows paths even when the test host uses another platform. */
function windowsImagePolicy(known: string[], canonical: Record<string, string | Error>) {
  const calls: string[] = [];
  const key = (p: string) => win32.normalize(p).toLowerCase();
  const targets = new Map(Object.entries(canonical).map(([p, actual]) => [key(p), actual]));
  const module = { exports: {} as typeof guard };
  const load = new Function('require', 'module', 'process', readFileSync(new URL('../electron/ipc-guard.cjs', import.meta.url), 'utf8'));
  load((id: string) => {
    if (id === 'node:path') return win32;
    if (id === './path-registry.cjs') return require('../electron/path-registry.cjs');
    if (id === 'node:fs/promises') return { realpath: async (p: string) => {
      calls.push(p);
      const actual = targets.get(key(p));
      if (!actual) throw Object.assign(new Error('No such file'), { code: 'ENOENT' });
      if (actual instanceof Error) throw actual;
      return actual;
    } };
    return require(id);
  }, module, { platform: 'win32' });
  const paths = new Set(known);
  return { calls, policy: module.exports.createPathPolicy({ isKnownPath: (p: string) => paths.has(p), knownPaths: () => paths, log: { reject: () => {} } }) };
}

/** A minimal stand-in for Electron's main window and its main frame. */
function fakeWindow(url: string) {
  const mainFrame = { processId: 1, routingId: 1, parent: null, url };
  const webContents = { mainFrame };
  return { win: { isDestroyed: () => false, webContents }, mainFrame, webContents };
}

describe('IPC caller validation (electron/ipc-guard.cjs)', () => {
  const index = abs('app', 'resources', 'app.asar', 'dist', 'index.html');
  const isApp = guard.appUrlTest(index);
  const appUrl = pathToFileURL(index).href;

  it('accepts only the application page, by file path (not URL spelling)', () => {
    expect(isApp(appUrl)).toBe(true);
    expect(isApp(`${appUrl}?demo#x`)).toBe(true);
    expect(isApp(pathToFileURL(abs('etc', 'other.html')).href)).toBe(false);
    expect(isApp('https://example.com/')).toBe(false);
    expect(isApp('data:text/html,<p>x')).toBe(false);
    expect(isApp('not a url')).toBe(false);
    const dev = guard.appUrlTest(index, 'http://localhost:5173');
    expect(dev('http://localhost:5173/?demo')).toBe(true);
    expect(dev('http://localhost:5174/')).toBe(false);
  });

  it('refuses other windows, sub-frames and foreign pages', () => {
    const { win, mainFrame, webContents } = fakeWindow(appUrl);
    expect(guard.untrustedReason({ sender: webContents, senderFrame: mainFrame }, win, isApp)).toBeNull();
    expect(guard.untrustedReason({ sender: {}, senderFrame: mainFrame }, win, isApp)).toMatch(/not the application window/);
    expect(guard.untrustedReason({ sender: webContents, senderFrame: { processId: 1, routingId: 7, parent: mainFrame, url: appUrl } }, win, isApp)).toMatch(/sub-frame/);
    expect(guard.untrustedReason({ sender: webContents, senderFrame: null }, win, isApp)).toMatch(/gone/);
    expect(guard.untrustedReason({ sender: webContents, senderFrame: { ...mainFrame, url: 'https://evil.example/' } }, win, isApp)).toMatch(/sender page/);
    expect(guard.untrustedReason({ sender: webContents, senderFrame: mainFrame }, null, isApp)).toMatch(/no application window/);
  });

  it('wraps handle / on / once / removeListener and logs refusals', async () => {
    const listeners = new Map<string, Array<(...a: unknown[]) => unknown>>();
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const raw = {
      handle: (c: string, f: (...a: unknown[]) => unknown) => handlers.set(c, f),
      on: (c: string, f: (...a: unknown[]) => unknown) => listeners.set(c, [...(listeners.get(c) ?? []), f]),
      removeListener: (c: string, f: (...a: unknown[]) => unknown) => listeners.set(c, (listeners.get(c) ?? []).filter((x) => x !== f)),
    };
    const { win, mainFrame, webContents } = fakeWindow(appUrl);
    const log: string[] = [];
    const ipc = guard.guardIpc(raw, { getWindow: () => win, isAppUrl: isApp, log: { reject: (k: string, d: string) => log.push(`${k}: ${d}`) } });
    const good = { sender: webContents, senderFrame: mainFrame };
    const bad = { sender: {}, senderFrame: mainFrame };
    ipc.handle('ping', (_ev, x) => `pong ${String(x)}`);
    expect(await handlers.get('ping')!(good, 1)).toBe('pong 1');
    expect(() => handlers.get('ping')!(bad, 1)).toThrow('Unauthorized IPC caller');
    expect(log).toEqual(['ipc ping: sender is not the application window']);

    const got: unknown[] = [];
    ipc.on('note', (_ev, v) => got.push(v));
    for (const f of listeners.get('note')!) f(bad, 'x');
    for (const f of listeners.get('note')!) f(good, 'y');
    expect(got).toEqual(['y']);

    const onceGot: unknown[] = [];
    const fn = (_ev: unknown, v: unknown) => onceGot.push(v);
    ipc.once('dirty', fn);
    for (const f of [...listeners.get('dirty')!]) f(bad, 'ignored');
    expect(listeners.get('dirty')!.length).toBe(1); // a refused message does not consume the listener
    for (const f of [...listeners.get('dirty')!]) f(good, true);
    expect(onceGot).toEqual([true]);
    expect(listeners.get('dirty')!.length).toBe(0);
    ipc.once('dirty', fn);
    ipc.removeListener('dirty', fn);
    expect(listeners.get('dirty')!.length).toBe(0);
  });
});

describe('file path allow lists (electron/ipc-guard.cjs)', () => {
  const known = new Set([abs('work', 'job', 'sheet1.dxf')]);
  const log: string[] = [];
  const policy = guard.createPathPolicy({ isKnownPath: (p: string) => known.has(p), knownPaths: () => known, log: { reject: (k: string, d: string) => log.push(`${k}: ${d}`) } });

  it('known(): only paths the user chose, absolute, no NUL, not too long', () => {
    expect(policy.known(abs('work', 'job', 'sheet1.dxf'), 'save-dxf')).toBe(abs('work', 'job', 'sheet1.dxf'));
    expect(policy.known(abs('work', 'job', 'other.dxf'), 'save-dxf')).toBeNull();
    expect(policy.known('sheet1.dxf', 'backup-file')).toBeNull();
    expect(policy.known(`${abs('work', 'job', 'sheet1.dxf')}\0`, 'backup-file')).toBeNull();
    expect(policy.known(42, 'backup-file')).toBeNull();
    expect(policy.known(abs('x'.repeat(5000)), 'backup-file')).toBeNull();
    expect(log.length).toBe(5);
    expect(log[0]).toMatch(/^save-dxf: not a file chosen by the user/);
  });

  it('imageProblem(): images next to a chosen file, or named by an opened drawing', () => {
    expect(policy.imageProblem(abs('work', 'job', 'logo.png'))).toBeNull();
    expect(policy.imageProblem(abs('work', 'job', 'img', 'photo.JPG'))).toBeNull();
    expect(policy.imageProblem(abs('work', 'other', 'logo.png'))).toMatch(/not next to a drawing/);
    expect(policy.imageProblem(abs('work', 'job', 'notes.txt'))).toMatch(/not an image/);
    expect(policy.imageProblem('logo.png')).toMatch(/relative/);
    policy.rememberImages(abs('work', 'job', 'sheet1.dxf'), [abs('company', 'logos', 'mark.png'), '..\\shared\\stamp.bmp', 'notes.txt']);
    expect(policy.imageProblem(abs('company', 'logos', 'mark.png'))).toBeNull();
    expect(policy.imageProblem(abs('company', 'logos', 'other.png'))).toMatch(/not next to a drawing/);
  });

  it('imageProblem(): never a network share named by a drawing elsewhere (no automatic connection)', () => {
    // (On POSIX the backslash forms are not even absolute; on Windows they are UNC paths.)
    for (const p of ['\\\\fileserver\\share\\logo.png', '//fileserver/share/logo.png', '\\\\?\\UNC\\fileserver\\share\\logo.png']) expect(policy.imageProblem(p)).not.toBeNull();
    expect(policy.imageProblem('\\\\?\\C:\\logo.png')).not.toBeNull();
    // A local drawing whose IMAGEDEF names a share: still refused.
    policy.rememberImages(abs('work', 'job', 'sheet1.dxf'), ['\\\\fileserver\\share\\stamp.png', '//fileserver/share/mark.png']);
    expect(policy.imageProblem('//fileserver/share/mark.png')).toMatch(/network path/);
    if (!posix) expect(policy.imageProblem('\\\\fileserver\\share\\stamp.png')).toMatch(/network path/);
    // A drawing on that server may use images next to it and those it names on the same server.
    const onShare = new Set(['//fileserver/projects/job/sheet.dxf']);
    const shared = guard.createPathPolicy({ isKnownPath: (p: string) => onShare.has(p), knownPaths: () => onShare, log: { reject: () => {} } });
    expect(shared.imageProblem('//fileserver/projects/job/img/logo.png')).toBeNull();
    expect(shared.imageProblem('//otherserver/projects/job/img/logo.png')).toMatch(/network path/);
    shared.rememberImages('//fileserver/projects/job/sheet.dxf', ['//fileserver/logos/mark.png', '//elsewhere/logos/mark.png']);
    expect(shared.imageProblem('//fileserver/logos/mark.png')).toBeNull();
    expect(shared.imageProblem('//elsewhere/logos/mark.png')).toMatch(/network path/);
    // Nor does a known file on a share open a local path that happens to resolve alike (POSIX reads "//x/y" as "/x/y").
    expect(shared.imageProblem(abs('fileserver', 'projects', 'job', 'logo.png'))).toMatch(/not next to a drawing/);
  });

  it('insideRoot(): refuses a link that leads out of a folder the main process owns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jcad-guard-'));
    try {
      const plugins = join(root, 'plugins');
      mkdirSync(join(plugins, 'ok'), { recursive: true });
      writeFileSync(join(plugins, 'ok', 'plugin.json'), '{}');
      writeFileSync(join(root, 'secret.txt'), 'x');
      await expect(policy.insideRoot(plugins, join(plugins, 'ok', 'plugin.json'), 'plugins-read')).resolves.toBe(join(plugins, 'ok', 'plugin.json'));
      await expect(policy.insideRoot(plugins, join(plugins, 'missing', 'plugin.json'), 'plugins-read')).resolves.toBeTruthy();
      let linked = true;
      try {
        symlinkSync(root, join(plugins, 'evil'), 'junction');
      } catch {
        linked = false; // no permission to create links (some Windows set-ups)
      }
      if (linked) await expect(policy.insideRoot(plugins, join(plugins, 'evil', 'secret.txt'), 'plugins-read')).rejects.toThrow('Invalid path');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not authorize neighboring images from a project or catalog path', () => {
    const known = new Set([abs('project', 'job.jcadproj.json'), abs('catalog', 'parts.json')]);
    const restricted = guard.createPathPolicy({ isKnownPath: (p: string) => known.has(p), knownPaths: () => known, log: { reject: () => {} } });
    expect(restricted.imageProblem(abs('project', 'secret.png'))).toMatch(/not next to a drawing/);
    expect(restricted.imageProblem(abs('catalog', 'secret.png'))).toMatch(/not next to a drawing/);
  });

  it('rechecks the actual image location after following a junction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jcad-image-guard-'));
    if (!root.startsWith(join(tmpdir(), 'jcad-image-guard-'))) throw new Error('Unexpected test folder');
    try {
      const drawings = join(root, 'drawings'), privateDir = join(root, 'private');
      mkdirSync(drawings); mkdirSync(privateDir);
      writeFileSync(join(drawings, 'safe.png'), 'safe'); writeFileSync(join(privateDir, 'secret.png'), 'secret');
      symlinkSync(privateDir, join(drawings, 'linked'), 'junction');
      const known = new Set([join(drawings, 'sheet.dxf')]);
      const restricted = guard.createPathPolicy({ isKnownPath: (p: string) => known.has(p), knownPaths: () => known, log: { reject: () => {} } });
      await expect(restricted.imagePath(join(drawings, 'safe.png'))).resolves.toBe(join(drawings, 'safe.png'));
      await expect(restricted.imagePath(join(drawings, 'linked', 'secret.png'))).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('authorizes equivalent short and long Windows drawing folders', async () => {
    const short = 'C:\\Users\\RUNNER~1\\job', long = 'C:\\Users\\runneradmin\\job';
    const shortImage = win32.join(short, 'safe.png'), longImage = win32.join(long, 'safe.png');
    const canonical = { [short]: long, [long]: long, [shortImage]: longImage, [longImage]: longImage };
    for (const dir of [short, long]) {
      const { policy } = windowsImagePolicy([win32.join(dir, 'sheet.dxf')], canonical);
      await expect(policy.imagePath(shortImage)).resolves.toBe(longImage);
      await expect(policy.imagePath(longImage)).resolves.toBe(longImage);
    }
  });

  it('keeps a chosen lexical drawing root when its directory is a junction', async () => {
    const chosen = 'C:\\Drawings Link', actual = 'D:\\Drawings';
    const image = win32.join(chosen, 'img', 'safe.png'), actualImage = win32.join(actual, 'img', 'safe.png');
    const { policy } = windowsImagePolicy(['C:\\Missing\\old.dxf', win32.join(chosen, 'sheet.dwg')], { [chosen]: actual, [image]: actualImage });
    await expect(policy.imagePath(image)).resolves.toBe(actualImage);
    expect(policy.known(win32.join(chosen, 'sheet.dwg'), 'open-dwg')).toBe(win32.join(chosen, 'sheet.dwg'));
    expect(policy.known(win32.join(actual, 'sheet.dwg'), 'open-dwg')).toBeNull();
  });

  it('rejects image links and sibling prefixes outside a canonical drawing root', async () => {
    const short = 'C:\\Users\\RUNNER~1\\job', long = 'C:\\Users\\runneradmin\\job';
    const linked = win32.join(short, 'linked', 'secret.png'), neighbor = win32.join(short, 'neighbor.png');
    const { policy } = windowsImagePolicy([win32.join(short, 'sheet.dxf')], {
      [short]: long,
      [linked]: 'C:\\Private\\secret.png',
      [neighbor]: `${long}-private\\secret.png`,
    });
    for (const image of [linked, neighbor]) await expect(policy.imagePath(image)).rejects.toMatchObject({ code: 'ERR_IMAGE_PATH', message: 'Image resolves outside the permitted drawing folders' });
  });

  it('canonicalizes UNC folder aliases only on an already authorized server', async () => {
    const short = '\\\\fileserver\\share\\RUNNER~1\\job', long = '\\\\fileserver\\share\\runneradmin\\job';
    const shortImage = win32.join(short, 'safe.png'), longImage = win32.join(long, 'safe.png');
    const { policy, calls } = windowsImagePolicy([win32.join(short, 'sheet.dxf')], { [short]: long, [shortImage]: longImage, [longImage]: longImage });
    await expect(policy.imagePath(shortImage)).resolves.toBe(longImage);
    await expect(policy.imagePath(longImage)).resolves.toBe(longImage);
    calls.length = 0;
    await expect(policy.imagePath('\\\\otherserver\\share\\runneradmin\\job\\safe.png')).rejects.toMatchObject({ code: 'ERR_IMAGE_PATH', message: expect.stringContaining('network path') });
    await expect(policy.imagePath('\\\\?\\C:\\safe.png')).rejects.toMatchObject({ code: 'ERR_IMAGE_PATH', message: 'device path' });
    expect(calls).toEqual([]);
  });

  it('rejects links that move images between network hosts or from local paths to UNC', async () => {
    for (const dir of ['C:\\Drawings', '\\\\fileserver\\share\\Drawings']) {
      const image = win32.join(dir, 'linked.png');
      const { policy } = windowsImagePolicy([win32.join(dir, 'sheet.dxf')], { [dir]: dir, [image]: '\\\\otherserver\\share\\secret.png' });
      await expect(policy.imagePath(image)).rejects.toMatchObject({ code: 'ERR_IMAGE_PATH', message: 'Image link changes the network location' });
    }
  });

  it('tags image shape and authorization denials without filesystem access', async () => {
    const { policy, calls } = windowsImagePolicy([], {});
    for (const image of ['relative.png', 'C:\\Private\\notes.txt', 'C:\\Private\\bad\0.png', 'C:\\Private\\secret.png']) {
      await expect(policy.imagePath(image)).rejects.toMatchObject({ code: 'ERR_IMAGE_PATH' });
    }
    expect(calls).toEqual([]);
  });

  it('preserves image realpath missing-file and I/O failures unchanged', async () => {
    const dir = 'C:\\Drawings', image = win32.join(dir, 'safe.png');
    for (const code of ['ENOENT', 'EIO']) {
      const failure = Object.assign(new Error(`Image realpath failed: ${code}`), { code });
      const { policy } = windowsImagePolicy([win32.join(dir, 'sheet.dxf')], { [dir]: dir, [image]: failure });
      await expect(policy.imagePath(image)).rejects.toBe(failure);
      expect(failure.code).toBe(code);
    }
    const directoryFailure = Object.assign(new Error('Directory realpath failed'), { code: 'EIO' });
    const { policy } = windowsImagePolicy([win32.join(dir, 'sheet.dxf')], { [dir]: directoryFailure, [image]: image });
    await expect(policy.imagePath(image)).rejects.toBe(directoryFailure);
  });

  it('dxfImageNames(): IMAGEDEF file names from DXF text', () => {
    const dxf = ['0', 'SECTION', '2', 'OBJECTS', '0', 'IMAGEDEF', '5', '1A', '1', 'C:\\logos\\a.png', '10', '640', '0', 'IMAGEDEF', '1', 'b.jpg', '0', 'ENDSEC', '0', 'EOF'].join('\r\n');
    expect(guard.dxfImageNames(dxf)).toEqual(['C:\\logos\\a.png', 'b.jpg']);
    expect(guard.dxfImageNames('0\nEOF\n')).toEqual([]);
  });
});

describe('links handed to the system browser (externalUrl)', () => {
  it('allows composing email only to support and only when opted in', () => {
    const url = 'mailto:Justinrod04@gmail.com';
    expect(guard.externalUrl(url)).toBeNull();
    expect(guard.externalUrl(url, { supportEmail: true })).toBe(url);
    for (const bad of ['mailto:other@example.com', `${url},other@example.com`, `${url}?bcc=other@example.com`, `${url}?body=private`, 'mailto:Justinrod04%40gmail.com']) expect(guard.externalUrl(bad, { supportEmail: true })).toBeNull();
  });
  it('allows this repository and the donation page, compared after the URL is parsed', () => {
    expect(guard.externalUrl('https://github.com/habit04/share')).toBe('https://github.com/habit04/share');
    expect(guard.externalUrl('https://github.com/habit04/share/releases')).toBe('https://github.com/habit04/share/releases');
    expect(guard.externalUrl('https://github.com/habit04/share/issues/new?template=bug.yml&title=x%20y')).toMatch(/^https:\/\/github\.com\/habit04\/share\/issues\/new\?/);
    expect(guard.externalUrl('https://cash.app/$jr0481')).toBe('https://cash.app/$jr0481');
  });

  it('refuses ".." escapes, user info, look-alike hosts and other schemes', () => {
    for (const u of [
      'https://github.com/habit04/share/../../login/oauth/authorize?client_id=1&redirect_uri=https://evil.example',
      'https://github.com/habit04/share/%2e%2e/%2e%2e/login/oauth/authorize',
      'https://github.com/habit04/share/..%2f..%2flogin',
      'https://github.com/habit04/share/..\\..\\login',
      'https://github.com/habit04/shareX',
      'https://github.com/habit04/share%2f..%2f..%2flogin',
      'https://github.com@evil.example/habit04/share/',
      'https://user:pass@github.com/habit04/share/',
      'https://github.com.evil.example/habit04/share/',
      'https://github.com:8443/habit04/share/',
      'http://github.com/habit04/share/',
      'javascript:alert(1)//https://github.com/habit04/share/',
      'https://cash.app/$jr0481/../../login',
      'https://cash.app/$jr0481?x=1',
      `https://github.com/habit04/share/${'a'.repeat(16001)}`,
      42,
      '',
    ]) expect(guard.externalUrl(u), String(u).slice(0, 80)).toBeNull();
    expect(guard.externalUrl('https://cash.app/$jr0481', { cashApp: false })).toBeNull();
  });
});
