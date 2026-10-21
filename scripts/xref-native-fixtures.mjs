// Fixture generator for the P20.2 Electron/native xref refresh gate
// (NATIVE-REFRESH-PLAN.md as approved, harness correction round G1/G3/G4).
// Deterministic: every run produces byte-identical files, a fixtures.json
// (v2) with pinned content hashes and pinned edit descriptors, and a
// SHA256SUMS.txt manifest over every emitted file.
//
//   node scripts/xref-native-fixtures.mjs <output-dir>
//
// Layout emitted (mirrors the authored fixtures' virtual layout, so the
// host's stored relative references resolve exactly as authored):
//   drawings/host.dxf          authored host: -> ../parts/child.dxf,
//                              ..\shared\leaf.dxf, overlay-root.dxf
//   drawings/overlay-root.dxf  root overlay: -> kid.dxf (attach, loads)
//   drawings/kid.dxf           attached child of overlay-root
//   drawings/inner.dxf         negative witness: on disk and project-listed
//                              but NOT referenced by the host graph; the
//                              loader must never load it for this graph
//   parts/child.dxf            -> grand.dxf
//   parts/grand.dxf
//   shared/leaf.dxf            pinned same-length coordinate edit target
//   mutable.dxf                minimal DXF; pinned growth + coordinate edit
//   oversized.dxf              exactly 16 MiB + 1 byte
//   slow.dxf                   exactly 16 MiB (in-flight witness file:
//                              the largest size the 16 MiB per-read
//                              allowance admits, so the read stays active
//                              long enough to witness the 3.3 overlap)
//   xref-native.jcadproj.json  project listing every fixture DXF; opening
//                              it through the app's genuine Open Project
//                              flow is what makes the fixture paths
//                              readable by name in the path registry
//                              (registry.isKnown is exact-path membership;
//                              the harness itself grants nothing)
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: node scripts/xref-native-fixtures.mjs <output-dir>');
  process.exit(2);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const at = (rel) => join(outDir, ...rel.split('/'));

/** A minimal valid DXF (one LINE), LF line endings, no trailing spaces. */
function minimalDxf(comment) {
  return [
    '999', comment,
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', '0',
    '10', '0', '20', '0', '11', '10', '21', '10',
    '0', 'ENDSEC', '0', 'EOF', '',
  ].join('\n');
}

/** Pad a DXF text with 999 comment records (before EOF) to an exact byte size. */
function padToExact(text, targetBytes) {
  const base = Buffer.byteLength(text);
  if (base > targetBytes) throw new Error(`base DXF ${base} B exceeds target ${targetBytes} B`);
  // One pad record is "999\n" + payload + "\n"; payload repeats a fixed token.
  const unit = 'xref-native-padding\n'; // 20 bytes payload
  const recordBytes = 4 + unit.length; // "999\n" + payload
  let pad = targetBytes - base;
  if (pad % recordBytes !== 0) {
    // Absorb the remainder by lengthening the header comment line.
    const rem = pad % recordBytes;
    text = text.replace('999\n', `999\n${'x'.repeat(rem)}`);
    pad -= rem;
    if (Buffer.byteLength(text) + pad !== targetBytes) throw new Error('padding arithmetic failed');
  }
  const padText = ('999\n' + unit).repeat(pad / recordBytes);
  const eofAt = text.lastIndexOf('0\nEOF\n');
  if (eofAt < 0) throw new Error('base DXF has no EOF marker');
  const out = text.slice(0, eofAt) + padText + text.slice(eofAt);
  if (Buffer.byteLength(out) !== targetBytes) throw new Error(`padded size ${Buffer.byteLength(out)} != ${targetBytes}`);
  return out;
}

/**
 * Derive a pinned same-byte-length edit descriptor for one file: the
 * locate substring must occur EXACTLY once, the replacement must have the
 * identical byte length, and the edited content hash is computed here so
 * the harness can assert content, not just metadata.
 */
function pinEdit(rel, buf, locate, replace, note) {
  const text = buf.toString('utf8');
  const first = text.indexOf(locate);
  if (first < 0 || text.indexOf(locate, first + 1) >= 0) throw new Error(`${rel}: edit locate string is not unique exactly once`);
  if (Buffer.byteLength(locate) !== Buffer.byteLength(replace)) throw new Error(`${rel}: edit pair changes the byte length`);
  const edited = Buffer.from(text.slice(0, first) + replace + text.slice(first + locate.length), 'utf8');
  if (edited.length !== buf.length) throw new Error(`${rel}: edited length drifted`);
  return { locate, replace, editedSha256: sha256(edited), note };
}

const files = {};
function emit(rel, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  mkdirSync(join(outDir, ...rel.split('/').slice(0, -1)), { recursive: true });
  writeFileSync(at(rel), buf);
  files[rel] = { bytes: buf.length, sha256: sha256(buf) };
  return buf;
}
function copyAuthored(rel, sourceName) {
  mkdirSync(join(outDir, ...rel.split('/').slice(0, -1)), { recursive: true });
  copyFileSync(join(repo, 'tests', 'fixtures', 'xref', sourceName), at(rel));
  const buf = readFileSync(at(rel));
  files[rel] = { bytes: buf.length, sha256: sha256(buf) };
  return buf;
}

// Authored graph, byte-for-byte, in the nested layout the references name.
copyAuthored('drawings/host.dxf', 'host.dxf');
copyAuthored('drawings/overlay-root.dxf', 'overlay-root.dxf');
copyAuthored('drawings/kid.dxf', 'kid.dxf');
copyAuthored('drawings/inner.dxf', 'inner.dxf');
copyAuthored('parts/child.dxf', 'child.dxf');
copyAuthored('parts/grand.dxf', 'grand.dxf');
const leafBuf = copyAuthored('shared/leaf.dxf', 'leaf.dxf');

// Gate-only files at the fixture root.
const mutableBuf = emit('mutable.dxf', minimalDxf('mutable native-refresh fixture: the harness rewrites this file between reads'));
emit('oversized.dxf', padToExact(minimalDxf('oversized native-refresh fixture'), 16 * 1024 * 1024 + 1));
emit('slow.dxf', padToExact(minimalDxf('slow native-refresh fixture'), 16 * 1024 * 1024));

// The project the harness opens through the app's genuine Open Project
// dialog flow: its listed drawings become the registry-known fixture set.
const projectRel = 'xref-native.jcadproj.json';
const project = {
  name: 'xref-native',
  drawings: Object.keys(files).filter((rel) => rel.endsWith('.dxf')).sort().map((file) => ({ file })),
};
emit(projectRel, JSON.stringify(project, null, 2) + '\n');

// Pinned edits: a same-length change to a LINE endpoint coordinate VALUE
// (group 21), unique in each file. For these ASCII fixtures the broker's
// decoded text is byte-identical to the file, so the edited content hash
// below is also the expected decoded-text hash of a fresh read.
const edits = {
  // LINE: 10/0, 20/0, 11/10, 21/10 -> endpoint Y 10 -> 90.
  'mutable.dxf': {
    ...pinEdit('mutable.dxf', mutableBuf, '11\n10\n21\n10\n', '11\n10\n21\n90\n',
      'LINE endpoint group 21 value 10 -> 90 (same byte length)'),
    grownSha256: sha256(Buffer.concat([mutableBuf, Buffer.from(' ')])),
    grownNote: 'original bytes plus one trailing space (+1 byte, the R3 growth shape)',
  },
  // LINE: 10/0.0, 20/0.0, 11/10.0, 21/0.0 -> endpoint Y 0.0 -> 9.0.
  'shared/leaf.dxf': pinEdit('shared/leaf.dxf', leafBuf, '11\n10.0\n21\n0.0\n', '11\n10.0\n21\n9.0\n',
    'LINE endpoint group 21 value 0.0 -> 9.0 (same byte length)'),
};

writeFileSync(join(outDir, 'fixtures.json'), JSON.stringify({ version: 2, project: projectRel, files, edits }, null, 2) + '\n');
const manifest = Object.keys(files).sort().map((rel) => `${files[rel].sha256}  ${rel}`).join('\n') + '\n';
writeFileSync(join(outDir, 'SHA256SUMS.txt'), manifest);
console.log(`xref-native-fixtures: wrote ${Object.keys(files).length} files to ${outDir}`);
for (const [rel, f] of Object.entries(files)) console.log(`  ${rel}: ${f.bytes} bytes sha256 ${f.sha256}`);
console.log(`  manifest sha256: ${sha256(Buffer.from(manifest))}`);
