// Fixture generator for the P20.2 Electron/native xref refresh gate
// (NATIVE-REFRESH-PLAN.md, approved with amendments). Deterministic:
// every run produces byte-identical files and a SHA256SUMS.txt manifest.
//
//   node scripts/xref-native-fixtures.mjs <output-dir>
//
// The output directory receives:
//   host.dxf, leaf.dxf, child.dxf, grand.dxf, inner.dxf
//     - copied byte-for-byte from tests/fixtures/xref/ (authored core set)
//   mutable.dxf   - minimal valid DXF; the harness edits it on disk between
//                   reads (+1 byte growth, then a same-size content change)
//   oversized.dxf - exactly 16 MiB + 1 byte (minimal DXF + 999 comments)
//   slow.dxf      - exactly 4 MiB (same construction), for in-flight reads
//   SHA256SUMS.txt- "<sha256>  <name>" for every fixture file
//   fixtures.json - name -> { bytes, sha256 } for harness assertions
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: node scripts/xref-native-fixtures.mjs <output-dir>');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

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

const files = {};
function emit(name, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  writeFileSync(join(outDir, name), buf);
  files[name] = { bytes: buf.length, sha256: sha256(buf) };
}

// Authored core fixtures, byte-for-byte.
for (const name of ['host.dxf', 'leaf.dxf', 'child.dxf', 'grand.dxf', 'inner.dxf']) {
  copyFileSync(join(repo, 'tests', 'fixtures', 'xref', name), join(outDir, name));
  const buf = readFileSync(join(outDir, name));
  files[name] = { bytes: buf.length, sha256: sha256(buf) };
}

emit('mutable.dxf', minimalDxf('mutable native-refresh fixture: the harness rewrites this file between reads'));
emit('oversized.dxf', padToExact(minimalDxf('oversized native-refresh fixture'), 16 * 1024 * 1024 + 1));
emit('slow.dxf', padToExact(minimalDxf('slow native-refresh fixture'), 4 * 1024 * 1024));

writeFileSync(join(outDir, 'fixtures.json'), JSON.stringify(files, null, 2) + '\n');
const manifest = Object.keys(files).sort().map((n) => `${files[n].sha256}  ${n}`).join('\n') + '\n';
writeFileSync(join(outDir, 'SHA256SUMS.txt'), manifest);
console.log(`xref-native-fixtures: wrote ${Object.keys(files).length} fixtures to ${outDir}`);
for (const [name, f] of Object.entries(files)) console.log(`  ${name}: ${f.bytes} bytes sha256 ${f.sha256}`);
console.log(`  manifest sha256: ${sha256(Buffer.from(manifest))}`);
