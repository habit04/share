/** Build-only helper provenance: publisher signature and final hashes, bound to the dispatched commit. */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyNativeHelperSignature } from './seal-dwg-writer.mjs';

const require = createRequire(import.meta.url);
const { verifyPortableWriter } = require('../electron/portable-dwg.cjs');
const ROOT = resolve(import.meta.dirname, '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** @param {{ root?: string, sourceSha?: string, publisher?: string, head?: () => string, verifySignature?: typeof verifyNativeHelperSignature }} [opts] */
export async function verifySignedDwgWriter(opts = {}) {
  const root = opts.root || ROOT;
  const sourceSha = opts.sourceSha || process.env.SOURCE_SHA;
  const publisher = opts.publisher || process.env.AZURE_PUBLISHER_NAME?.trim();
  if (!/^[a-f0-9]{40}$/.test(sourceSha || '') || !publisher) throw new Error('Signed DWG helper verification requires the dispatched SHA and publisher.');
  const head = (opts.head || (() => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()))();
  if (head !== sourceSha) throw new Error('Signed DWG helper does not match the dispatched source commit.');
  const directory = join(root, 'release', 'dwg-writer');
  const manifestFile = join(directory, 'integrity.json');
  const embeddedFile = join(root, 'electron', 'dwg-writer-integrity.json');
  const bytes = readFileSync(manifestFile), embedded = readFileSync(embeddedFile);
  if (!bytes.equals(embedded)) throw new Error('Signed helper manifest differs from the exact embedded ASAR manifest.');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.helperSigning !== 'authenticode-verified') throw new Error('The native DWG helper is not publisher signed.');
  const verified = await verifyPortableWriter({ directory, manifest: embeddedFile });
  (opts.verifySignature || verifyNativeHelperSignature)(verified.executable, publisher);
  await verified.check();
  if (!bytes.equals(readFileSync(manifestFile)) || !bytes.equals(readFileSync(embeddedFile))) throw new Error('Signed helper manifests changed during verification.');
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  return { schemaVersion: 1, sourceSha, version, signing: 'authenticode-verified', publisher, integrityManifestSha256: digest(bytes), engine: manifest.engine, files: manifest.files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await verifySignedDwgWriter();
    writeFileSync(join(ROOT, 'native-helper-provenance.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`Signed native DWG helper verified for source ${report.sourceSha}. No release was published.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
