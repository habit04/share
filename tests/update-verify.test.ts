/**
 * Security review E-8: a downloaded update is verified before it is installed
 * (electron/update-verify.cjs, used by electron/updater.cjs right after the download and again
 * just before quitAndInstall): every file of the release metadata needs a SHA-512, every
 * downloaded file must hash to one of them, and on Windows, when the installation's
 * app-update.yml names a publisher, the installer's signature must match it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const uv = require('../electron/update-verify.cjs') as {
  publisherNamesFrom(text: string): string[];
  updateInfoProblem(info: unknown): string | null;
  sha512File(file: string): Promise<{ base64: string; hex: string }>;
  verifyDownloadedUpdate(opts: { files: string[]; info: unknown; publisherNames?: string[]; verifySignature?: ((names: string[], file: string) => Promise<string | null>) | null }): Promise<string | null>;
};
const root = join(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'jcad-update-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const installer = join(dir, 'jcad-electrical-0.4.2-win-x64.exe');
writeFileSync(installer, Buffer.from('MZ fake installer bytes'));
const sha = (b: Buffer, enc: 'base64' | 'hex') => createHash('sha512').update(b).digest(enc);
const good = sha(readFileSync(installer), 'base64');
const info = (sha512 = good) => ({ version: '0.4.2', files: [{ url: 'jcad-electrical-0.4.2-win-x64.exe', sha512, size: 23 }], path: 'jcad-electrical-0.4.2-win-x64.exe', sha512 });

describe('update verification (electron/update-verify.cjs, E-8)', () => {
  it('reads the publisher names of app-update.yml (none for an unsigned build)', () => {
    expect(uv.publisherNamesFrom('owner: habit04\nrepo: share\nprovider: github\npublisherName:\n  - JCad Electrical Contributors\n  - "Other CN"\nupdaterCacheDirName: jcad-electrical-updater\n')).toEqual(['JCad Electrical Contributors', 'Other CN']);
    expect(uv.publisherNamesFrom('publisherName: ACME LLC\n')).toEqual(['ACME LLC']);
    expect(uv.publisherNamesFrom("publisherName: ['A', B]\n")).toEqual(['A', 'B']);
    expect(uv.publisherNamesFrom('owner: habit04\nrepo: share\nprovider: github\n')).toEqual([]);
    expect(uv.publisherNamesFrom('publisherName:\nrepo: share\n')).toEqual([]);
  });

  it('metadata without a SHA-512 for every file cannot be verified', () => {
    expect(uv.updateInfoProblem(info())).toBeNull();
    expect(uv.updateInfoProblem({ files: [] })).toMatch(/lists no files/);
    expect(uv.updateInfoProblem({ files: [{ url: 'a.exe' }] })).toMatch(/no SHA-512 checksum for a\.exe/);
    expect(uv.updateInfoProblem(null)).toMatch(/lists no files/);
  });

  it('a downloaded file must hash to the release checksum (base64, or hex in old metadata)', async () => {
    expect(await uv.verifyDownloadedUpdate({ files: [installer], info: info() })).toBeNull();
    expect(await uv.verifyDownloadedUpdate({ files: [installer], info: info(sha(readFileSync(installer), 'hex')) })).toBeNull();
    const tampered = join(dir, 'tampered.exe');
    writeFileSync(tampered, Buffer.from('MZ fake installer bytez'));
    expect(await uv.verifyDownloadedUpdate({ files: [tampered], info: info() })).toBe('the downloaded file does not match the SHA-512 checksum of the release');
    expect(await uv.verifyDownloadedUpdate({ files: [join(dir, 'gone.exe')], info: info() })).toMatch(/cannot be read/);
    expect(await uv.verifyDownloadedUpdate({ files: [], info: info() })).toBe('nothing was downloaded');
    expect(await uv.verifyDownloadedUpdate({ files: [installer], info: { files: [{ url: 'x' }] } })).toMatch(/no SHA-512/);
  });

  it('on a signed installation the installer must carry the named publisher signature', async () => {
    const calls: Array<[string[], string]> = [];
    const signedBy = (who: string) => async (names: string[], file: string) => {
      calls.push([names, file]);
      return names.includes(who) ? null : `publisher "${who}" is not one of ${names.join(', ')}`;
    };
    expect(await uv.verifyDownloadedUpdate({ files: [installer], info: info(), publisherNames: ['ACME LLC'], verifySignature: signedBy('ACME LLC') })).toBeNull();
    expect(calls).toEqual([[['ACME LLC'], installer]]);
    expect(await uv.verifyDownloadedUpdate({ files: [installer], info: info(), publisherNames: ['ACME LLC'], verifySignature: signedBy('Mallory') })).toBe('the installer is not signed by ACME LLC: publisher "Mallory" is not one of ACME LLC');
    expect(await uv.verifyDownloadedUpdate({ files: [installer], info: info(), publisherNames: ['ACME LLC'], verifySignature: async () => { throw new Error('PowerShell failed'); } })).toMatch(/not signed by ACME LLC: PowerShell failed/);
    expect(await uv.verifyDownloadedUpdate({ files: [installer], info: info(), publisherNames: ['ACME LLC'], verifySignature: null })).toBe('the installer signature cannot be checked');
    // An unsigned build names no publisher: the hash is all that can be checked (an owner decision, E-8).
    expect(await uv.verifyDownloadedUpdate({ files: [installer], info: info(), publisherNames: [], verifySignature: signedBy('nobody') })).toBeNull();
  });

  it('the updater verifies after the download and again right before quitAndInstall; a failure installs nothing', () => {
    const src = readFileSync(join(root, 'electron', 'updater.cjs'), 'utf8');
    const offer = src.slice(src.indexOf('async function offerRestart('), src.indexOf('async function checkViaUpdater('));
    expect(offer.indexOf('await verifyDownloaded()')).toBeGreaterThan(offer.indexOf('await confirmRestart(win)'));
    expect(offer.indexOf('quitAndInstall(false, true)')).toBeGreaterThan(offer.indexOf('await verifyDownloaded()'));
    expect(offer.indexOf('await beforeRestart(win)')).toBeGreaterThan(offer.indexOf('await verifyDownloaded()'));
    expect(offer.lastIndexOf('await verifyDownloaded()')).toBeGreaterThan(offer.indexOf('await beforeRestart(win)'));
    expect(offer.indexOf('quitAndInstall(false, true)')).toBeGreaterThan(offer.indexOf('await beforeRestart(win)'));
    const check = src.slice(src.indexOf('async function checkViaUpdater('));
    expect(check.indexOf('updateInfoProblem(info)')).toBeLessThan(check.indexOf('u.downloadUpdate()'));
    expect(check.indexOf('await verifyDownloaded()')).toBeGreaterThan(check.indexOf('files = await u.downloadUpdate()'));
    const verify = src.slice(src.indexOf('async function verifyDownloaded('), src.indexOf('async function offerRestart('));
    expect(verify).toMatch(/u\.autoInstallOnAppQuit = false;/);
  });

  it('electron-updater itself checks the SHA-512 of every download and the signature when a publisher is named', () => {
    // Confirms what docs/SECURITY-REVIEW.md E-8 relies on in the installed electron-updater.
    const appUpdater = readFileSync(join(root, 'node_modules', 'electron-updater', 'out', 'AppUpdater.js'), 'utf8');
    expect(appUpdater).toMatch(/sha512: fileInfo\.info\.sha512/);
    const nsis = readFileSync(join(root, 'node_modules', 'electron-updater', 'out', 'NsisUpdater.js'), 'utf8');
    expect(nsis).toMatch(/await this\.verifySignature\(destinationFile\)/);
    expect(nsis).toMatch(/publisherName == null\) \{\s*return null;/);
  });
});

describe('verified explicit update installation (electron/updater.cjs with stand-ins)', () => {
  async function exercise(test: (h: Awaited<ReturnType<typeof makeHarness>>) => Promise<void>) {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const realResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
    Object.defineProperty(process, 'platform', { ...realPlatform, value: 'win32' });
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: dir });
    delete process.env.PORTABLE_EXECUTABLE_DIR;
    writeFileSync(join(dir, 'app-update.yml'), 'publisherName: ACME LLC\n');
    const h = makeHarness();
    try {
      expect(h.updater.canSelfUpdate()).toBe(true);
      await test(h);
    } finally {
      h.restore();
      Object.defineProperty(process, 'platform', realPlatform);
      if (realResourcesPath) Object.defineProperty(process, 'resourcesPath', realResourcesPath);
      else delete (process as unknown as { resourcesPath?: string }).resourcesPath;
      if (portableDir === undefined) delete process.env.PORTABLE_EXECUTABLE_DIR;
      else process.env.PORTABLE_EXECUTABLE_DIR = portableDir;
    }
  }

  function makeHarness() {
    const downloads: string[] = [];
    const order: string[] = [];
    const boxes: Array<{ message: string; detail?: string; buttons?: string[] }> = [];
    const statuses: Array<{ state: string; message?: string }> = [];
    let restart = false;
    let installs = 0;
    const autoUpdater = {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      on: () => {},
      checkForUpdates: async () => ({ updateInfo: info() }),
      downloadUpdate: async () => [downloads.shift()!],
      verifyUpdateCodeSignature: async (names: string[], file: string) => {
        expect(names).toEqual(['ACME LLC']);
        expect(file.endsWith('.exe')).toBe(true);
        order.push('signature');
        return null;
      },
      quitAndInstall: (silent: boolean, forceRun: boolean) => {
        expect([silent, forceRun]).toEqual([false, true]);
        order.push('install');
        installs += 1;
      },
    };
    const electron = {
      app: { isPackaged: true, getVersion: () => '0.4.1' },
      dialog: {
        showMessageBox: async (_w: unknown, o: { message: string; detail?: string; buttons?: string[] }) => {
          boxes.push(o);
          const i = (o.buttons ?? []).findIndex((b) => b === 'Download' || b === (restart ? 'Restart Now' : 'Later') || b === 'Close');
          return { response: Math.max(0, i) };
        },
      },
      shell: { openExternal: async () => {} },
      net: { fetch: async () => new Response('{}', { status: 404 }) },
    };
    const paths = { electron: require.resolve('electron'), updater: require.resolve('electron-updater'), mod: require.resolve('../electron/updater.cjs') };
    const saved = { electron: require.cache[paths.electron], updater: require.cache[paths.updater] };
    const fake = (file: string, exports: unknown) => ({ id: file, filename: file, loaded: true, exports }) as unknown as NodeJS.Module;
    require.cache[paths.electron] = fake(paths.electron, electron);
    require.cache[paths.updater] = fake(paths.updater, { autoUpdater });
    delete require.cache[paths.mod];
    const updater = require(paths.mod) as {
      checkForUpdates(win: unknown, o?: { interactive?: boolean }): Promise<{ state: string; message?: string }>;
      canSelfUpdate(): boolean;
      onConfirmRestart(fn: (win: unknown) => Promise<boolean>): void;
      onBeforeRestart(fn: (win: unknown) => Promise<boolean>): void;
      onStatus(fn: (status: { state: string; message?: string }) => void): void;
    };
    updater.onConfirmRestart(async () => { order.push('unsaved-work'); return true; });
    updater.onBeforeRestart(async () => { order.push('preference-checkpoint'); return true; });
    updater.onStatus((status) => statuses.push(status));
    return {
      updater, autoUpdater, downloads, boxes, order, statuses,
      installs: () => installs,
      restart: () => { restart = true; },
      restore: () => {
        for (const k of ['electron', 'updater'] as const) {
          if (saved[k]) require.cache[paths[k]] = saved[k];
          else delete require.cache[paths[k]];
        }
        delete require.cache[paths.mod];
      },
    };
  }

  it('a successful retry stays nonautomatic and Later explains how to install when ready', async () => {
    await exercise(async (h) => {
      const tampered = join(dir, 'tampered-retry.exe');
      writeFileSync(tampered, Buffer.from('MZ not the release bytes'));
      h.downloads.push(tampered, installer);
      const first = await h.updater.checkForUpdates({}, { interactive: true });
      expect(first.state).toBe('error');
      expect(first.message).toMatch(/failed verification and will not be installed: the downloaded file does not match the SHA-512 checksum/);
      expect(h.autoUpdater.autoInstallOnAppQuit).toBe(false);
      const second = await h.updater.checkForUpdates({}, { interactive: true });
      expect(second.state).toBe('downloaded');
      expect(h.boxes.find((box) => box.message === 'JCad Electrical 0.4.2 has been downloaded.')?.detail).toMatch(/choose Check for Updates when you are ready/);
      expect(h.autoUpdater.autoInstallOnAppQuit).toBe(false);
      expect(h.installs()).toBe(0);
    });
  });

  it('explicit Restart Now handles unsaved work and rechecks the publisher before installing', async () => {
    await exercise(async (h) => {
      h.downloads.push(installer);
      h.restart();
      expect((await h.updater.checkForUpdates({}, { interactive: true })).state).toBe('downloaded');
      expect(h.order).toEqual(['signature', 'unsaved-work', 'signature', 'preference-checkpoint', 'signature', 'install']);
      expect(h.installs()).toBe(1);
      expect(h.autoUpdater.autoInstallOnAppQuit).toBe(false);
    });
  });

  it('keeps the application open when the final settings checkpoint is canceled after verification', async () => {
    await exercise(async (h) => {
      h.downloads.push(installer);
      h.restart();
      h.updater.onBeforeRestart(async () => { h.order.push('preference-checkpoint-canceled'); return false; });
      await h.updater.checkForUpdates({}, { interactive: true });
      expect(h.order).toEqual(['signature', 'unsaved-work', 'signature', 'preference-checkpoint-canceled']);
      expect(h.installs()).toBe(0);
      expect(h.autoUpdater.autoInstallOnAppQuit).toBe(false);
    });
  });

  it('refuses a cached installer changed after download when Restart Now is chosen later', async () => {
    await exercise(async (h) => {
      const cached = join(dir, 'cached-installer.exe');
      writeFileSync(cached, readFileSync(installer));
      h.downloads.push(cached);
      expect((await h.updater.checkForUpdates({}, { interactive: true })).state).toBe('downloaded');
      writeFileSync(cached, 'MZ replaced after download');
      h.restart();
      await h.updater.checkForUpdates({}, { interactive: true });
      expect(h.order).toEqual(['signature', 'unsaved-work']);
      expect(h.statuses.some((status) => status.state === 'error' && /does not match the SHA-512/.test(status.message ?? ''))).toBe(true);
      expect(h.boxes.some((box) => /failed verification and was not installed/.test(box.message))).toBe(true);
      expect(h.installs()).toBe(0);
      expect(h.autoUpdater.autoInstallOnAppQuit).toBe(false);
    });
  });

  it('refuses an installer changed while the settings checkpoint is committing', async () => {
    await exercise(async (h) => {
      const cached = join(dir, 'checkpoint-raced-installer.exe');
      writeFileSync(cached, readFileSync(installer));
      h.downloads.push(cached);
      h.restart();
      h.updater.onBeforeRestart(async () => {
        h.order.push('preference-checkpoint');
        writeFileSync(cached, 'MZ replaced during settings disk commit');
        return true;
      });
      await h.updater.checkForUpdates({}, { interactive: true });
      expect(h.order).toEqual(['signature', 'unsaved-work', 'signature', 'preference-checkpoint']);
      expect(h.statuses.some((status) => status.state === 'error' && /does not match the SHA-512/.test(status.message ?? ''))).toBe(true);
      expect(h.boxes.some((box) => /failed verification and was not installed/.test(box.message))).toBe(true);
      expect(h.installs()).toBe(0);
      expect(h.autoUpdater.autoInstallOnAppQuit).toBe(false);
    });
  });
});
