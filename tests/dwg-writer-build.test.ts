import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { crateEntries, exactSourcePatch, sourceHash, readSourceArchive, verifySourceArchive, verifyPreparedSource, prepareDwgWriter, type SourcePatch } from '../scripts/prepare-dwg-writer.mjs';
import { bundleIntegrity, writeDependencyNotices } from '../scripts/build-dwg-writer.mjs';

const directories: string[] = [];
async function scratch() { const dir = await mkdtemp(join(tmpdir(), 'jcad-writer-build-')); directories.push(dir); return dir; }
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
function archive(files: { name: string; bytes: string; kind?: string }[]) {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const header = Buffer.alloc(512), bytes = Buffer.from(file.bytes);
    header.write(file.name, 0); header.write('0000644\0', 100); header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124);
    header.fill(32, 148, 156); header.write(file.kind ?? '0', 156); header.write('ustar\0', 257);
    const sum = header.reduce((n, byte) => n + byte, 0); header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
describe('portable DWG writer supply chain', () => {
  it('rejects oversized local archives before reading their contents', async () => {
    const dir = await scratch(), file = join(dir, 'huge.crate'), handle = await open(file, 'w');
    try { await handle.truncate(32 * 1024 * 1024 + 1); } finally { await handle.close(); }
    await expect(readSourceArchive(file)).rejects.toThrow(/bounded regular file/);
  });
  it('verifies compressed bytes before trusting any source entry', () => {
    const bytes = archive([{ name:'acadrust-0.6.4/Cargo.toml', bytes:'source' }]);
    expect(() => verifySourceArchive(bytes, sourceHash(bytes))).not.toThrow();
    const changed = Buffer.from(bytes); changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    expect(() => verifySourceArchive(changed, sourceHash(bytes))).toThrow(/checksum mismatch/);
  });
  it.each([
    { name:'acadrust-0.6.4/../outside.rs', kind:'0' },
    { name:'acadrust-0.6.4/CON.rs', kind:'0' },
    { name:'acadrust-0.6.4/src/link.rs', kind:'2' },
    { name:'wrong-crate/src/file.rs', kind:'0' },
    { name:'acadrust-0.6.4/src\\outside.rs', kind:'0' },
  ])('rejects unsafe archive entry $name ($kind)', (file) => {
    expect(() => crateEntries(archive([{ ...file, bytes:'payload' }]))).toThrow();
  });
  it('rejects duplicate paths even when Windows treats their case as identical', () => {
    expect(() => crateEntries(archive([{ name:'acadrust-0.6.4/src/one.rs', bytes:'one' }, { name:'acadrust-0.6.4/src/ONE.rs', bytes:'two' }]))).toThrow(/Duplicate/);
  });
  it('extracts only regular source entries and verifies tar headers', () => {
    const zipped = archive([{ name:'acadrust-0.6.4/src/one.rs', bytes:'hello' }]);
    expect(crateEntries(zipped).get('src/one.rs')?.toString()).toBe('hello');
    const damaged = archive([{ name:'acadrust-0.6.4/src/two.rs', bytes:'hello', kind:'L' }]);
    expect(() => crateEntries(damaged)).toThrow(/Unexpected/);
  });
  it('applies exact source patches and refuses preimage, replacement or postimage drift', () => {
    const original = Buffer.from('prefix\nold body\nsuffix\n');
    const patch: SourcePatch = { path:'src/writer.rs', beforeSha256:sourceHash(original), afterSha256:sourceHash('prefix\nnew body\nsuffix\n'), replacements:[{ before:'old body', after:'new body', count:1 }] };
    expect(exactSourcePatch(original, patch).toString()).toBe('prefix\nnew body\nsuffix\n');
    expect(() => exactSourcePatch(Buffer.from('tampered'), patch)).toThrow(/preimage/);
    expect(() => exactSourcePatch(original, { ...patch, replacements:[{ before:'absent', after:'new', count:1 }] })).toThrow(/occurrence/);
    expect(() => exactSourcePatch(original, { ...patch, afterSha256:'0'.repeat(64) })).toThrow(/postimage/);
  });
  it('rejects changed or extra prepared files even if generated metadata claims they are trusted', async () => {
    const dir = await scratch();
    const expected = new Map([['source.rs', Buffer.from('trusted source')]]);
    await writeFile(join(dir, 'source.rs'), expected.get('source.rs')!);
    await verifyPreparedSource(dir, expected);
    await writeFile(join(dir, '.jcad-source.json'), JSON.stringify({ files:{ 'source.rs':sourceHash('tampered') } }));
    await writeFile(join(dir, 'source.rs'), 'tampered');
    await expect(verifyPreparedSource(dir, expected)).rejects.toThrow(/checksum mismatch/);
    await writeFile(join(dir, 'source.rs'), expected.get('source.rs')!);
    await writeFile(join(dir, 'extra.rs'), 'injected source');
    await expect(verifyPreparedSource(dir, expected)).rejects.toThrow(/file set mismatch/);
  });
  it('rejects a linked build directory before creating files outside the checkout', async () => {
    const dir = await scratch(), outside = await scratch();
    await mkdir(join(dir, 'native'));
    await symlink(outside, join(dir, 'native/dwg-writer'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(prepareDwgWriter({ root:dir, archivePath:join(dir, 'missing.crate') })).rejects.toThrow(/Linked/);
  });
  it('rejects an unverified cached crate without producing prepared source', async () => {
    const dir = await scratch(), bad = join(dir, 'bad.crate');
    await writeFile(bad, archive([{ name:'acadrust-0.6.4/source.rs', bytes:'untrusted' }]));
    await expect(prepareDwgWriter({ root:dir, archivePath:bad })).rejects.toThrow(/checksum mismatch/);
  });
  it('seals executable, source and notices as a complete bundle and detects their changed hashes', async () => {
    const dir = await scratch();
    await writeFile(join(dir, 'JcadDwgWriter.exe'), 'native helper');
    await writeFile(join(dir, 'JcadDwgWriter-Source.zip'), 'corresponding source');
    await writeFile(join(dir, 'ThirdPartyNotices.json'), 'license notices');
    const before = await bundleIntegrity(dir);
    expect(before.files).toHaveLength(3);
    await writeFile(join(dir, 'ThirdPartyNotices.json'), 'changed license notices');
    const after = await bundleIntegrity(dir);
    expect(after.files.find((f) => f.name === 'ThirdPartyNotices.json')?.sha256).not.toBe(before.files.find((f) => f.name === 'ThirdPartyNotices.json')?.sha256);
    await mkdir(join(dir, 'unverified-directory'));
    await expect(bundleIntegrity(dir)).rejects.toThrow(/non-file/);
  });
  it('requires the helper and caps bundle entries', async () => {
    const dir = await scratch(); await writeFile(join(dir, 'source.zip'), 'source');
    await expect(bundleIntegrity(dir)).rejects.toThrow(/Invalid/);
    await writeFile(join(dir, 'JcadDwgWriter.exe'), 'helper');
    for (let i = 0; i < 64; i++) await writeFile(join(dir, `source-${i}.txt`), 'source');
    await expect(bundleIntegrity(dir)).rejects.toThrow(/Invalid/);
  });
  it('includes full dependency and runtime license texts and fails on absent notices', async () => {
    const dir = await scratch(), dep = join(dir, 'dep'), runtime = join(dir, 'runtime');
    await mkdir(dep); await mkdir(join(runtime, 'share/doc/rust/licenses'), { recursive:true });
    await writeFile(join(dep, 'LICENSE-MIT'), 'Permission text');
    await writeFile(join(runtime, 'share/doc/rust/licenses/GCC-exception.txt'), 'Runtime exception text');
    const pkg = { name:'a-crate', version:'1.0.0', source:'registry+https://github.com/rust-lang/crates.io-index', manifest_path:join(dep, 'Cargo.toml'), license:'MIT' };
    const out = join(dir, 'notices.json');
    await writeDependencyNotices([pkg], out, runtime);
    const text = await readFile(out, 'utf8'); expect(text).toContain('Permission text'); expect(text).toContain('Runtime exception text');
    await rm(join(dep, 'LICENSE-MIT'));
    await expect(writeDependencyNotices([pkg], out, runtime)).rejects.toThrow(/Missing/);
  });
  it('rejects unreviewed local dependency code even when it includes license notices', async () => {
    const dir = await scratch();
    await writeFile(join(dir, 'LICENSE'), 'Local injected crate license');
    const pkg = { name:'unexpected-local-crate', version:'1.0.0', source:null, manifest_path:join(dir, 'Cargo.toml'), license:'MIT' };
    await expect(writeDependencyNotices([pkg], join(dir, 'notices.json'), dir)).rejects.toThrow(/Unexpected local/);
  });
});
