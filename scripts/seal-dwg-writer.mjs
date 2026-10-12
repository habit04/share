// Sign the native helper BEFORE its byte hashes enter the ASAR. The builder's helper-specific
// signExts exclusion prevents an extraResources copy from changing those already sealed bytes.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, lstatSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { WindowsSignAzureManager } = require('app-builder-lib/out/codeSign/windowsSignAzureManager.js');
const { VmManager } = require('app-builder-lib/out/vm/vm.js');

export async function signNativeHelper(file, win) {
  // The installed builder's Azure manager only needs these two services for signing;
  // application packing and its metadata are handled by the subsequent builder invocation.
  const manager = new WindowsSignAzureManager(/** @type {any} */ ({ platformSpecificBuildOptions: win, vm: { value: Promise.resolve(new VmManager()) } }));
  await manager.initialize();
  if (await manager.signFile({ path: file, options: win }) !== true) throw new Error('Native DWG writer signing did not complete.');
}

export function verifyNativeHelperSignature(file, publisher) {
  const root = tmpdir();
  const directory = mkdtempSync(join(root, 'jcad-dwg-signature-'));
  try {
    const script = join(directory, 'verify.ps1');
    writeFileSync(script, `param([string]$File, [string]$Publisher)\n$ErrorActionPreference='Stop'\n$signature=Get-AuthenticodeSignature -LiteralPath $File\n$actual=if($signature.SignerCertificate){$signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)}else{''}\nif($signature.Status -ne 'Valid' -or -not [string]::Equals($actual,$Publisher,[System.StringComparison]::Ordinal)){throw 'DWG helper lacks a valid signature from the configured publisher'}\nWrite-Output 'DWG_HELPER_SIGNATURE_OK'\n`);
    // A parent PowerShell 7 can export its module path to Windows PowerShell 5.1. Let the
    // native verifier resolve its own built-in modules rather than loading incompatible DLLs.
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.toLowerCase() === 'psmodulepath') delete env[name];
    const powershell = join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-File', script, file, publisher], { env, encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 60_000 });
    if (!output.includes('DWG_HELPER_SIGNATURE_OK')) throw new Error('Native DWG writer signature could not be verified.');
  } finally {
    const child = relative(root, directory);
    if (child && !child.startsWith('..') && !isAbsolute(child) && resolve(directory).startsWith(resolve(root) + '\\')) rmSync(directory, { recursive: true, force: true });
  }
}

/** @param {string} directory @param {{ win?: any, requireSigning?: boolean, platform?: string, sign?: typeof signNativeHelper, verify?: typeof verifyNativeHelperSignature }} [options] */
export async function sealDwgWriter(directory, options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('Native DWG helper signing is Windows only.');
  const file = join(resolve(directory), 'JcadDwgWriter.exe');
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 128) throw new Error('The native DWG helper is missing or invalid.');
  const win = options.win ?? JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).build.win;
  const signing = win?.azureSignOptions;
  if (!signing) {
    if (options.requireSigning ?? process.env.REQUIRE_PUBLISHER_SIGNING === 'true') throw new Error('Publisher signing is required for the native DWG helper.');
    return 'unsigned';
  }
  if (typeof signing.publisherName !== 'string' || !signing.publisherName.trim()) throw new Error('Native DWG signing requires the configured publisher.');
  if (!win.signExts?.includes('!JcadDwgWriter.exe')) throw new Error('The builder must preserve the sealed native DWG helper bytes.');
  await (options.sign ?? signNativeHelper)(file, win);
  (options.verify ?? verifyNativeHelperSignature)(file, signing.publisherName);
  return 'authenticode-verified';
}
