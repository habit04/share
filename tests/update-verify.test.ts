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
