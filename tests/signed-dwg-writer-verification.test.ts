import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifySignedDwgWriter } from '../scripts/check-signed-dwg-writer.mjs';

const sourceSha = 'a'.repeat(40);
const publisher = 'Justin Rodriguez';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture(run: (root: string, executable: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'jcad-signed-dwg-proof-'));
  try {
    const directory = join(root, 'release', 'dwg-writer');
    mkdirSync(directory, { recursive: true });
    mkdirSync(join(root, 'electron'));
    const executable = join(directory, 'JcadDwgWriter.exe');
    const bytes = Buffer.alloc(256, 1);
    writeFileSync(executable, bytes);
    const manifest = JSON.stringify({
      schemaVersion: 1,
      engine: { name: 'acadrust', version: '0.6.4' },
      helperSigning: 'authenticode-verified',
      files: [{ name: 'JcadDwgWriter.exe', size: bytes.length, sha256: digest(bytes) }],
    });
    writeFileSync(join(directory, 'integrity.json'), manifest);
    writeFileSync(join(root, 'electron', 'dwg-writer-integrity.json'), manifest);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.4.6' }));
    await run(root, executable);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const options = (root: string) => ({ root, sourceSha, publisher, head: () => sourceSha, verifySignature: () => {} });

describe('signed DWG helper artifact verification', () => {
  it('binds a verified publisher signature and exact final bundle hashes to the dispatched source', async () => fixture(async (root, executable) => {
    const signatureCalls: string[] = [];
    const report = await verifySignedDwgWriter({ ...options(root), verifySignature: (file, signer) => {
      expect(file).toBe(executable);
      expect(signer).toBe(publisher);
      signatureCalls.push(file);
    } });
    expect(signatureCalls).toEqual([executable]);
    expect(report).toMatchObject({ sourceSha, version: '0.4.6', publisher, signing: 'authenticode-verified' });
    expect(report.integrityManifestSha256).toBe(digest(readFileSync(join(root, 'electron', 'dwg-writer-integrity.json'))));
    expect(report.files[0]?.sha256).toBe(digest(readFileSync(executable)));
  }));

  it('refuses an unrelated source commit or invalid dispatched SHA before trusting the bundle', async () => fixture(async (root) => {
    await expect(verifySignedDwgWriter({ ...options(root), head: () => 'b'.repeat(40) })).rejects.toThrow(/dispatched source commit/);
    await expect(verifySignedDwgWriter({ ...options(root), sourceSha: 'refs/heads/main' })).rejects.toThrow(/requires the dispatched SHA/);
  }));

  it('refuses any difference between the staged and exact ASAR manifests', async () => fixture(async (root) => {
    appendFileSync(join(root, 'electron', 'dwg-writer-integrity.json'), '\n');
    await expect(verifySignedDwgWriter(options(root))).rejects.toThrow(/differs from the exact embedded ASAR manifest/);
  }));

  it('requires a signed manifest and an independently verified matching publisher', async () => fixture(async (root) => {
    await expect(verifySignedDwgWriter({ ...options(root), verifySignature: () => { throw new Error('wrong publisher'); } })).rejects.toThrow('wrong publisher');
    const manifestFile = join(root, 'release', 'dwg-writer', 'integrity.json');
    const unsigned = readFileSync(manifestFile, 'utf8').replace('authenticode-verified', 'unsigned');
    writeFileSync(manifestFile, unsigned);
    writeFileSync(join(root, 'electron', 'dwg-writer-integrity.json'), unsigned);
    await expect(verifySignedDwgWriter(options(root))).rejects.toThrow(/not publisher signed/);
  }));

  it('refuses helper bytes changed by or during the signature verification step', async () => fixture(async (root, executable) => {
    await expect(verifySignedDwgWriter({ ...options(root), verifySignature: () => appendFileSync(executable, 'changed') })).rejects.toThrow(/changed after its integrity check/);
  }));

  it('refuses manifests replaced during signature verification even if both copies still agree', async () => fixture(async (root) => {
    await expect(verifySignedDwgWriter({ ...options(root), verifySignature: () => {
      appendFileSync(join(root, 'release', 'dwg-writer', 'integrity.json'), '\n');
      appendFileSync(join(root, 'electron', 'dwg-writer-integrity.json'), '\n');
    } })).rejects.toThrow(/manifests changed during verification/);
  }));
});
