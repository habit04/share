import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sealDwgWriter, verifyNativeHelperSignature } from '../scripts/seal-dwg-writer.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('app-builder-lib'); // Initialize its mutually dependent platform exports first.
const { WinPackager } = require('app-builder-lib/out/winPackager.js');
const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));

async function fixture(test: (directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'jcad-dwg-seal-test-'));
  try { writeFileSync(join(directory, 'JcadDwgWriter.exe'), Buffer.alloc(256, 1)); await test(directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

describe('native DWG helper sealing', () => {
  it.skipIf(process.platform !== 'win32')('verifies a real Windows signature and refuses the wrong publisher under a PowerShell 7 parent', () => {
    const executable = join(process.env.SystemRoot || 'C:/Windows', 'System32/cmd.exe');
    expect(() => verifyNativeHelperSignature(executable, 'Microsoft Windows')).not.toThrow();
    expect(() => verifyNativeHelperSignature(executable, 'wrong publisher')).toThrow(/lacks a valid signature/);
  }, 60_000);
  it('keeps builder signing for the app and installer while preserving already sealed helper bytes', () => {
    const policy = { platformSpecificBuildOptions: pkg.build.win };
    const sign = WinPackager.prototype.shouldSignFile;
    expect(sign.call(policy, 'resources/dwg-writer/JcadDwgWriter.exe')).toBe(false);
    expect(sign.call(policy, 'JCad Electrical.exe')).toBe(true);
    expect(sign.call(policy, 'jcad-electrical-0.4.6-win-x64.exe')).toBe(true);
    expect(sign.call(policy, 'elevate.exe')).toBe(true);
  });
  it('allows unsigned local rehearsals and refuses them when publisher signing is required', async () => fixture(async (directory) => {
    expect(await sealDwgWriter(directory, { platform: 'win32', win: {}, requireSigning: false })).toBe('unsigned');
    await expect(sealDwgWriter(directory, { platform: 'win32', win: {}, requireSigning: true })).rejects.toThrow(/Publisher signing is required/);
  }));
  it('signs and verifies the exact helper in order before the caller records its hashes', async () => fixture(async (directory) => {
    const calls: string[] = [];
    const win = { signExts: ['!JcadDwgWriter.exe'], azureSignOptions: { publisherName: 'Justin Rodriguez' } };
    expect(await sealDwgWriter(directory, {
      platform: 'win32', win, requireSigning: true,
      sign: async (file, options) => { expect(options).toBe(win); calls.push('sign'); writeFileSync(file, Buffer.alloc(300, 2)); },
      verify: (file, publisher) => { expect(publisher).toBe('Justin Rodriguez'); expect(readFileSync(file).length).toBe(300); calls.push('verify'); },
    })).toBe('authenticode-verified');
    expect(calls).toEqual(['sign', 'verify']);
  }));
  it('refuses a missing re-sign exclusion, failed signing, and an unverified signature', async () => fixture(async (directory) => {
    const options = { platform: 'win32', win: { azureSignOptions: { publisherName: 'Justin Rodriguez' } }, requireSigning: true };
    await expect(sealDwgWriter(directory, options)).rejects.toThrow(/preserve the sealed/);
    const win = { ...options.win, signExts: ['!JcadDwgWriter.exe'] };
    await expect(sealDwgWriter(directory, { ...options, win, sign: async () => { throw new Error('signer unavailable'); } })).rejects.toThrow('signer unavailable');
    await expect(sealDwgWriter(directory, { ...options, win, sign: async () => {}, verify: () => { throw new Error('wrong publisher'); } })).rejects.toThrow('wrong publisher');
  }));
});
