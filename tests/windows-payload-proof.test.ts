import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { finished } from 'node:stream/promises';
import { createWindowsPayloadVerifier, inventoryWindowsPayload, parseWindowsArchiveListing, parseWindowsInstallerArchiveListing, validateWindowsArchiveEntries, type WindowsPayloadProof } from '../scripts/windows-payload-proof.mjs';

const require = createRequire(import.meta.url), asar = require('@electron/asar');
const roots: string[] = [];
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const temp = () => { const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'jcad-payload-proof-test-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const listing = (entries: Array<{ path: string; bytes: number; directory?: boolean; extra?: string }>, header = 'Path = outer.7z\nType = 7z\nPhysical Size = 4') => '--\n' + header + '\n\n----------\n' + entries.map(entry => `Path = ${entry.path}\nSize = ${entry.bytes}\nAttributes = ${entry.directory ? 'D' : 'A'}\nEncrypted = -\n${entry.extra || ''}`).join('\n') + '\n';
const embeddedHeader = (path: string, bytes: number, offset = 5, tail = 3) => `Path = ${path}\nType = 7z\nWARNINGS:\nThere are data after the end of archive\nOffset = ${offset}\nPhysical Size = ${bytes - offset - tail}\nTail Size = ${tail}\nHeaders Size = 3\nMethod = LZMA2:20 BCJ\nSolid = -\nBlocks = 1`;
const embeddedListing = (path: string, bytes: number, entries: Parameters<typeof listing>[0]) => listing(entries, embeddedHeader(path, bytes)) + '\nWarnings: 1\n';
const entry = (path: string, directory = false, bytes = 1) => ({ path, bytes: directory ? 0 : bytes, directory, link: false });

async function fixture(options: { pkg?: Record<string, unknown>; noApp?: boolean; noHelper?: boolean; mismatchManifest?: boolean; unsigned?: boolean } = {}) {
  const root = temp(), template = join(root, 'template'), resources = join(template, 'resources'), helper = join(resources, 'dwg-writer');
  mkdirSync(helper, { recursive: true });
  if (!options.noApp) writeFileSync(join(template, 'JCad Electrical.exe'), 'mock signed application bytes');
  const names = ['JcadDwgWriter.exe', 'JcadDwgWriter-Source.zip', 'ThirdPartyNotices.json'];
  const files = names.map(name => { const bytes = Buffer.from('helper resource: ' + name); writeFileSync(join(helper, name), bytes); return { name, size: bytes.length, sha256: sha(bytes) }; });
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, helperSigning: options.unsigned ? 'unsigned' : 'authenticode-verified', files }));
  writeFileSync(join(helper, 'integrity.json'), manifest);
  const source = join(root, 'asar-source'); mkdirSync(join(source, 'electron'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'jcad-electrical', version: '0.5.1', main: 'electron/main.cjs', ...options.pkg }));
  writeFileSync(join(source, 'electron', 'dwg-writer-integrity.json'), options.mismatchManifest ? Buffer.concat([manifest, Buffer.from('\n')]) : manifest);
  await finished(await asar.createPackage(source, join(resources, 'app.asar')));
  if (options.noHelper) rmSync(join(helper, 'JcadDwgWriter.exe'));
  const installer = join(root, 'candidate.exe'); writeFileSync(installer, 'mock installer archive; never execute');
  const scratch = join(root, 'scratch'); mkdirSync(scratch);
  const calls: string[][] = [];
  const mock: { outer: string; inner: string; afterOuter?: (output: string) => void; afterInner?: (output: string) => void } = { outer: listing([{ path: '$PLUGINSDIR/app-64.7z', bytes: 4 }], `Path = ${installer}\nType = Nsis\nPhysical Size = ${readFileSync(installer).length}`), inner: '' };
  const tools = createWindowsPayloadVerifier({
    getArchiveTool: async () => 'mock-pinned-7za',
    runArchive: (tool, args) => {
      expect(tool).toBe('mock-pinned-7za'); calls.push(args);
      const output = args.find(arg => arg.startsWith('-o'))?.slice(2);
      if (args[0] === 'l' && args.at(-1) === installer) return mock.outer;
      if (args[0] === 'l') {
        const inventory = inventoryWindowsPayload(template);
        return (mock.inner || listing([...inventory.directories.map(path => ({ path, bytes: 0, directory: true })), ...inventory.files])).replace('Path = outer.7z', 'Path = ' + args.at(-1));
      }
      if (args.at(-1) === '$PLUGINSDIR/app-64.7z') {
        mkdirSync(join(output!, '$PLUGINSDIR')); writeFileSync(join(output!, '$PLUGINSDIR', 'app-64.7z'), '7z!!');
        mock.afterOuter?.(output!);
      } else { cpSync(template, output!, { recursive: true }); mock.afterInner?.(output!); }
      return '';
    },
    verifyUninstaller: () => ({ status: 'Valid', publisher: 'Justin Rodriguez' }),
  });
  const extract = () => tools.extractWindowsInstallerPayload({ installer, expectedVersion: '0.5.1', scratchParent: scratch });
  return { root, template, installer, scratch, calls, mock, tools, extract };
}

describe('Windows archive admission before extraction', () => {
  it('parses only technical member records with normalized portable paths', () => {
    expect(parseWindowsArchiveListing(listing([{ path: 'resources', directory: true, bytes: 0 }, { path: 'resources\\app.asar', bytes: 123 }]))).toEqual([{ path: 'resources', directory: true, bytes: 0 }, { path: 'resources/app.asar', directory: false, bytes: 123 }]);
  });
  it.each(['../outside', 'a/../../outside', '/root/file', 'C:\\outside', '\\\\server\\file', 'resources/file:stream', './file', 'a//file', 'a/./file', 'a/../file', 'x.', 'x ', 'NUL.txt', 'aux', 'a\nPath = escaped', 'a\u0000b', 'a?b'])('rejects unsafe Windows member %j', path => {
    expect(() => validateWindowsArchiveEntries([entry(path)])).toThrow();
  });
  it('refuses duplicate/case-colliding members, ancestor aliases and file parents', () => {
    for (const entries of [[entry('a'), entry('a')], [entry('A'), entry('a')], [entry('A/one'), entry('a/two')], [entry('file'), entry('file/child')]]) expect(() => validateWindowsArchiveEntries(entries)).toThrow();
  });
  it('refuses links, encrypted data, oversized entries and missing or duplicate listing fields', () => {
    expect(() => validateWindowsArchiveEntries([{ ...entry('link'), link: true }])).toThrow(/links/);
    expect(() => validateWindowsArchiveEntries([entry('huge', false, 1024 ** 3 + 1)])).toThrow(/budget/);
    expect(() => validateWindowsArchiveEntries(Array.from({ length: 5 }, (_, i) => entry('large-' + i, false, 1024 ** 3)))).toThrow(/expanded size/);
    expect(() => validateWindowsArchiveEntries(Array.from({ length: 20_001 }, (_, i) => entry('file-' + i)))).toThrow(/count/);
    expect(() => validateWindowsArchiveEntries([entry('bad', false, -1)])).toThrow(/budget/);
    expect(() => parseWindowsArchiveListing(listing([{ path: 'link', bytes: 1, extra: 'Symbolic Link = ../out\n' }]))).toThrow(/links/);
    expect(() => parseWindowsArchiveListing(listing([{ path: 'link', bytes: 1, extra: 'Hard Link = sibling\n' }]))).toThrow(/links/);
    expect(() => parseWindowsArchiveListing(listing([{ path: 'link', bytes: 1 }]).replace('Attributes = A', 'Attributes = A_ lrwxrwxrwx'))).toThrow(/links/);
    expect(() => parseWindowsArchiveListing(listing([{ path: 'a', bytes: 1 }]).replace('Encrypted = -', 'Encrypted = +'))).toThrow(/Encrypted/);
    expect(() => parseWindowsArchiveListing(listing([{ path: 'a', bytes: 1, extra: 'Anti = +\n' }]))).toThrow(/deletion/);
    for (const invalid of ['Path = file\nSize = 1', '----------\nPath = file\n', '----------\nPath = file\nPath = another\nSize = 1\n', '----------\nPath = file\nSize = 1e3\n']) expect(() => parseWindowsArchiveListing(invalid)).toThrow();
  });
});

describe('static installer extraction and shipping identity', () => {
  it('extracts only the single named NSIS member and binds every payload byte without executing it', async () => {
    const f = await fixture(), proof = await f.extract();
    expect(proof).toMatchObject({ schemaVersion: 1, kind: 'windows-installer-payload', expectedVersion: '0.5.1', extractionMode: 'nsis-member', installer: { sha256: sha(readFileSync(f.installer)) }, criticalFiles: { helperSigning: 'authenticode-verified' } });
    expect(dirname(proof.extractionRoot)).toBe(f.scratch); expect(basename(proof.extractionRoot)).toMatch(/^jcad-windows-payload-/);
    expect(proof.payloadRoot).toBe(join(proof.extractionRoot, 'payload'));
    expect(f.calls.map(call => call[0])).toEqual(['l', 'x', 'l', 'x']);
    expect(f.calls[1]?.slice(-2)).toEqual([f.installer, '$PLUGINSDIR/app-64.7z']);
    expect(proof.files).toHaveLength(6);
    expect(JSON.parse(JSON.stringify(proof))).toEqual(proof);
    const installed = join(f.root, 'installed'); cpSync(proof.payloadRoot, installed, { recursive: true });
    const report = await f.tools.verifyInstalledWindowsPayload({ executable: join(installed, 'JCad Electrical.exe'), payloadProof: proof });
    expect(report).toMatchObject({ exactPayloadMatch: true, payloadFilesMatched: 6, inventorySha256: proof.inventorySha256, uninstaller: [] });
  });
  it('refuses output outside its canonical scratch parent or any existing output', async () => {
    const f = await fixture();
    await expect(f.tools.extractWindowsInstallerPayload({ installer: f.installer, expectedVersion: '0.5.1', scratchParent: f.scratch, outDir: join(f.root, 'escape') })).rejects.toThrow(/direct child/);
    const existing = join(f.scratch, 'existing'); mkdirSync(existing); writeFileSync(join(existing, 'keep'), 'user bytes');
    await expect(f.tools.extractWindowsInstallerPayload({ installer: f.installer, expectedVersion: '0.5.1', scratchParent: f.scratch, outDir: existing })).rejects.toThrow();
    expect(readFileSync(join(existing, 'keep'), 'utf8')).toBe('user bytes'); expect(f.calls).toHaveLength(0);
  });
  it('refuses unsafe inner paths before inner extraction and missing/ambiguous outer members', async () => {
    const f = await fixture(); f.mock.inner = listing([{ path: '../outside', bytes: 1 }]);
    await expect(f.extract()).rejects.toThrow(/Unsafe/); expect(f.calls.map(call => call[0])).toEqual(['l', 'x', 'l']);
    for (const outer of [listing([{ path: 'wrong.7z', bytes: 4 }]), listing([{ path: '$PLUGINSDIR/app-64.7z', bytes: 4 }, { path: '$PLUGINSDIR/app-64.7z', bytes: 4 }])]) {
      f.mock.outer = outer; f.calls.length = 0; await expect(f.extract()).rejects.toThrow(); expect(f.calls.map(call => call[0])).toEqual(['l']);
    }
  });
  it.each([
    [{ pkg: { version: '0.5.0' } }, /version differs/], [{ pkg: { name: 'another' } }, /identity differs/],
    [{ pkg: { main: 'custom.cjs' } }, /entry differs/], [{ pkg: { jcadTestBuild: true } }, /test ASAR/],
    [{ pkg: { jcadTestBuild: false } }, /test ASAR/], [{ noApp: true }, /Required Windows payload/],
    [{ noHelper: true }, /Required Windows payload/], [{ mismatchManifest: true }, /manifests differ/], [{ unsigned: true }, /signed helper/],
  ] as const)('refuses incomplete or nonshipping payload %j', async (options, message) => {
    const f = await fixture(options); await expect(f.extract()).rejects.toThrow(message);
  });
  it('rejects member size mismatches and unlisted extracted files', async () => {
    const f = await fixture(); f.mock.inner = listing([{ path: 'JCad Electrical.exe', bytes: 1 }]);
    await expect(f.extract()).rejects.toThrow(/differs from its validated member listing/);
  });
  it('rejects changed helper resource bytes and unverified resources', async () => {
    const f = await fixture(); appendFileSync(join(f.template, 'resources', 'dwg-writer', 'JcadDwgWriter.exe'), 'changed');
    await expect(f.extract()).rejects.toThrow(/member size differs/);
    const other = await fixture(); writeFileSync(join(other.template, 'resources', 'dwg-writer', 'unexpected.dll'), 'unverified');
    await expect(other.extract()).rejects.toThrow(/Unverified native helper/);
  });
  it('refuses an oversized external native manifest before reading its JSON bytes', async () => {
    const f = await fixture(); writeFileSync(join(f.template, 'resources', 'dwg-writer', 'integrity.json'), Buffer.alloc(4 * 1024 * 1024 + 1));
    await expect(f.extract()).rejects.toThrow(/manifest exceeds metadata byte budget/);
  });
  it('rejects missing/truncated application ASAR and oversized metadata headers', async () => {
    const missing = await fixture(); rmSync(join(missing.template, 'resources', 'app.asar'));
    await expect(missing.extract()).rejects.toThrow(/Required Windows payload/);
    for (const bytes of [Buffer.from('bad'), Buffer.from([4, 0, 0, 0, 255, 255, 255, 127])]) {
      const f = await fixture(); writeFileSync(join(f.template, 'resources', 'app.asar'), bytes);
      await expect(f.extract()).rejects.toThrow(/ASAR header/);
    }
  });
  it('detects installer mutation, directory replacement and extra extraction output', async () => {
    const changed = await fixture(); changed.mock.afterInner = () => appendFileSync(changed.installer, 'modified');
    await expect(changed.extract()).rejects.toThrow(/Installer changed/);
    const redirected = await fixture(); redirected.mock.afterInner = output => { renameSync(output, output + '-prior'); mkdirSync(output); cpSync(redirected.template, output, { recursive: true }); };
    await expect(redirected.extract()).rejects.toThrow(/directory changed/);
    const outerExtra = await fixture(); outerExtra.mock.afterOuter = output => writeFileSync(join(output, 'unexpected'), 'extra');
    await expect(outerExtra.extract()).rejects.toThrow(/unexpected bytes/);
    const innerExtra = await fixture(); innerExtra.mock.afterInner = output => mkdirSync(join(output, 'unexpected-directory'));
    await expect(innerExtra.extract()).rejects.toThrow(/directories differ/);
  });
});

describe('exact embedded 7z header and warning admission', () => {
  const path = join(realpathSync.native(tmpdir()), 'signed-candidate.exe'), bytes = 154080840;
  const members = [{ path: 'JCad Electrical.exe', bytes: 1024 }, { path: 'resources', bytes: 0, directory: true }, { path: 'resources\\app.asar', bytes: 2048 }];
  const actualShape = () => listing(members, embeddedHeader(path, bytes, 150574, 391191)) + '\nWarnings: 1\n';
  it('accepts the observed pinned installer header shape and exactly one tail warning footer', () => {
    const text = actualShape(), result = parseWindowsInstallerArchiveListing(text, { archivePath: path, archiveBytes: bytes });
    expect(result).toMatchObject({ extractionMode: 'embedded-7z', evidence: { type: '7z', offset: 150574, physicalSize: 153539075, tailSize: 391191, warningCount: 1, listingSha256: sha(text) } });
    expect(result.entries).toEqual([{ path: 'JCad Electrical.exe', bytes: 1024, directory: false }, { path: 'resources', bytes: 0, directory: true }, { path: 'resources/app.asar', bytes: 2048, directory: false }]);
    expect(() => parseWindowsArchiveListing(text)).toThrow(/warning footer/);
  });
  it.each([
    ['Offset = 150574', 'Offset = 0'], ['Offset = 150574', 'Offset = -1'], ['Offset = 150574', 'Offset = 9007199254740992'],
    ['Physical Size = 153539075', 'Physical Size = 153539074'], ['Tail Size = 391191', 'Tail Size = 0'],
    ['Type = 7z', 'Type = zip'], ['Type = 7z', 'Type = Nsis'], ['WARNINGS:', 'ERRORS:'],
    ['There are data after the end of archive', 'Unexpected end of archive'], ['Warnings: 1', 'Warnings: 2'],
    ['Headers Size = 3', 'Headers Size = 999999999'], ['Solid = -', 'Solid = unknown'],
  ])('rejects header/footer modification %s', (from, to) => {
    expect(() => parseWindowsInstallerArchiveListing(actualShape().replace(from, to), { archivePath: path, archiveBytes: bytes })).toThrow();
  });
  it('refuses missing, duplicated, misplaced or trailing warning/footer/headers and mismatched input paths', () => {
    for (const text of [actualShape().replace('Warnings: 1\n', ''), actualShape() + 'Warnings: 1\n', actualShape() + 'Path = another\n', actualShape().replace('Tail Size = 391191', 'Tail Size = 391191\nOffset = 150574'), actualShape().replace('WARNINGS:\n', ''), actualShape().replace('There are data after the end of archive', 'There are data after the end of archive\nThere are data after the end of archive'), actualShape() + '--\nPath = another\nType = 7z\n']) {
      expect(() => parseWindowsInstallerArchiveListing(text, { archivePath: path, archiveBytes: bytes })).toThrow();
    }
    expect(() => parseWindowsInstallerArchiveListing(actualShape(), { archivePath: path + '-other', archiveBytes: bytes })).toThrow(/path differs/);
    expect(() => parseWindowsInstallerArchiveListing(actualShape(), { archivePath: path, archiveBytes: bytes + 1 })).toThrow(/byte length/);
  });
  it('rejects unsafe or ambiguous direct application members and wrapped inner archives', () => {
    for (const entries of [[...members, { path: '../escaped', bytes: 1 }], [...members, { path: 'JCAD ELECTRICAL.EXE', bytes: 1 }], [...members, { path: '$PLUGINSDIR/app-64.7z', bytes: 1 }], members.filter(member => member.path !== 'JCad Electrical.exe')]) {
      const text = listing(entries, embeddedHeader(path, bytes, 150574, 391191)) + '\nWarnings: 1\n';
      expect(() => parseWindowsInstallerArchiveListing(text, { archivePath: path, archiveBytes: bytes })).toThrow();
    }
    expect(() => parseWindowsInstallerArchiveListing(actualShape(), { archivePath: path, archiveBytes: bytes, role: 'payload' })).toThrow(/unwrapped 7z/);
  });
  it('extracts the directly listed application only after full header and member admission', async () => {
    const f = await fixture(), inventory = inventoryWindowsPayload(f.template);
    f.mock.outer = embeddedListing(f.installer, readFileSync(f.installer).length, [...inventory.directories.map(path => ({ path, bytes: 0, directory: true })), ...inventory.files]);
    const proof = await f.extract(); expect(proof.extractionMode).toBe('embedded-7z'); expect(proof.archiveEvidence.warningCount).toBe(1);
    expect(f.calls.map(call => call[0])).toEqual(['l', 'x']); expect(f.calls[1]?.at(-1)).toBe(f.installer);
    const installed = join(f.root, 'installed-direct'); cpSync(proof.payloadRoot, installed, { recursive: true });
    expect((await f.tools.verifyInstalledWindowsPayload({ executable: join(installed, 'JCad Electrical.exe'), payloadProof: proof })).exactPayloadMatch).toBe(true);
  });
  it('refuses malformed direct listings before any extraction', async () => {
    const f = await fixture(), inventory = inventoryWindowsPayload(f.template);
    f.mock.outer = embeddedListing(f.installer, readFileSync(f.installer).length, inventory.files).replace('Warnings: 1', 'Warnings: 2');
    await expect(f.extract()).rejects.toThrow(/warning footer/); expect(f.calls.map(call => call[0])).toEqual(['l']);
  });
});

describe('installed tree versus exact installer payload', () => {
  async function installedFixture() {
    const f = await fixture(), proof = await f.extract(), installed = join(f.root, 'installed'); cpSync(proof.payloadRoot, installed, { recursive: true });
    const verify = (payloadProof: WindowsPayloadProof = proof, executable = join(installed, 'JCad Electrical.exe')) => f.tools.verifyInstalledWindowsPayload({ executable, payloadProof });
    return { ...f, proof, installed, verify };
  }
  it.each(['modified', 'missing', 'extra', 'directory'] as const)('rejects %s installed payload', async change => {
    const f = await installedFixture();
    if (change === 'modified') appendFileSync(join(f.installed, 'resources', 'app.asar'), 'tampered');
    if (change === 'missing') rmSync(join(f.installed, 'JCad Electrical.exe'));
    if (change === 'extra') writeFileSync(join(f.installed, 'extra.exe'), 'untrusted');
    if (change === 'directory') mkdirSync(join(f.installed, 'extra-directory'));
    await expect(f.verify()).rejects.toThrow();
  });
  it('allows only the exact root NSIS uninstaller after actual signature validation', async () => {
    const f = await installedFixture(); writeFileSync(join(f.installed, 'Uninstall JCad Electrical.exe'), 'mock signed uninstaller');
    const report = await f.verify(); expect(report.uninstaller).toHaveLength(1); expect(report.uninstaller[0]?.signature.publisher).toBe('Justin Rodriguez');
    for (const result of [{ status: 'NotSigned', publisher: 'Justin Rodriguez' }, { status: 'Valid', publisher: 'wrong' }]) {
      const verifier = createWindowsPayloadVerifier({ verifyUninstaller: () => result });
      await expect(verifier.verifyInstalledWindowsPayload({ executable: join(f.installed, 'JCad Electrical.exe'), payloadProof: f.proof })).rejects.toThrow();
    }
  });
  it('refuses forged traversal/digest proofs and alternative executable names', async () => {
    const f = await installedFixture();
    const malformed = JSON.parse(JSON.stringify(f.proof)) as WindowsPayloadProof; malformed.files[0]!.path = '../escape';
    await expect(f.verify(malformed)).rejects.toThrow(/Unsafe/);
    await expect(f.verify({ ...f.proof, inventorySha256: '0'.repeat(64) })).rejects.toThrow(/digest differs/);
    await expect(f.verify(f.proof, join(f.installed, 'other.exe'))).rejects.toThrow(/exact installed application/);
  });
  it('rejects redirected roots and linked files instead of following a source fallback', async () => {
    const f = await installedFixture(), alias = join(f.root, 'alias'); symlinkSync(f.installed, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.verify(f.proof, join(alias, 'JCad Electrical.exe'))).rejects.toThrow(/linked or redirected/);
    const nestedAlias = join(f.installed, 'redirected'); symlinkSync(f.template, nestedAlias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.verify()).rejects.toThrow(/links/);
    const scratchAlias = join(f.root, 'scratch-alias'); symlinkSync(f.scratch, scratchAlias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.tools.extractWindowsInstallerPayload({ installer: f.installer, expectedVersion: '0.5.1', scratchParent: scratchAlias })).rejects.toThrow(/linked or redirected/);
  });
  it('requires expected payload files without depending on the temporary extraction directory', async () => {
    const f = await installedFixture(); rmSync(f.proof.extractionRoot, { recursive: true });
    expect((await f.verify()).exactPayloadMatch).toBe(true);
    expect(readdirSync(f.installed)).toContain('JCad Electrical.exe');
  });
  it('rejects hard-linked payload files even when their bytes match', async () => {
    const f = await installedFixture(), app = join(f.installed, 'JCad Electrical.exe');
    linkSync(app, join(f.root, 'outside-hardlink.exe'));
    await expect(f.verify()).rejects.toThrow(/linked/);
  });
});
