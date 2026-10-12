// Optional independent validation with a locally installed, licensed AutoCAD Core Console.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** Independent native DXF reader for the controlled oracle fixtures, not JCad's importer. */
export function nativeDxfRecords(text) {
  assert.ok(Buffer.byteLength(text, 'utf8') <= 8 * 1024 * 1024, 'Native oracle DXF exceeds 8 MiB.');
  const lines = text.replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
  assert.equal(lines.length % 2, 0, 'Native oracle DXF has incomplete code/value pairs.');
  assert.ok(lines.length <= 1_000_000, 'Native oracle DXF exceeds the pair budget.');
  const records = []; let record, section = '', block = '';
  for (let i = 0; i < lines.length; i += 2) {
    assert.match(lines[i].trim(), /^\d+$/, 'Native oracle DXF group code is not an integer.');
    const code = Number(lines[i]), value = lines[i + 1].trim();
    assert.ok(code <= 1071, 'Native oracle DXF group code is out of range.');
    if (code === 0) {
      if (record) {
        if (record.kind === 'SECTION') section = field(record, 2);
        if (record.kind === 'BLOCK') block = field(record, 2);
        if (record.kind === 'ENDBLK') block = '';
        if (record.kind === 'ENDSEC') { section = ''; block = ''; }
        records.push(record);
      }
      assert.ok(records.length < 100_000, 'Native oracle DXF exceeds the record budget.');
      record = { kind: value, section, block, groups: [] };
    } else if (record) record.groups.push([code, value]);
  }
  if (record) records.push(record);
  return records;
}

const field = (record, code, fallback = '') => record.groups.find(([key]) => key === code)?.[1] ?? fallback;
const number = (record, code, fallback = 0) => {
  const value = Number(field(record, code, String(fallback)));
  assert.ok(Number.isFinite(value), `Native ${record.kind} group ${code} is not finite.`);
  return value;
};
const point = (record, code) => [number(record, code), number(record, code + 10), number(record, code + 20)];
const textValue = (value) => value.replace(/\\U\+([a-f\d]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
function appearance(record) {
  const rgb = field(record, 420), name = field(record, 430);
  const alpha = number(record, 440);
  assert.ok(Number.isInteger(alpha) && (alpha === 0 || alpha === 0x01000000 || alpha >= 0x02000000 && alpha <= 0x020000ff), 'Native entity alpha has an invalid method.');
  return {
    layer: field(record, 8, '0'),
    // AutoCAD may recompute the fallback ACI for an explicit RGB. It cannot change RGB.
    ...(rgb ? { rgb: number(record, 420).toString(16).padStart(6, '0') } : { aci: number(record, 62, 256) }),
    ...(name ? { name: textValue(name) } : {}), alpha: alpha.toString(16),
  };
}
function layerAlpha(record) {
  let app = '';
  for (const [code, value] of record.groups) {
    if (code === 1001) app = value;
    if (app === 'AcCmTransparency' && code === 1071) {
      const alpha = Number(value);
      assert.ok(Number.isSafeInteger(alpha) && (alpha === 0 || alpha === 0x01000000 || alpha >= 0x02000000 && alpha <= 0x020000ff), 'Native layer alpha XDATA has an invalid method.');
      return alpha.toString(16);
    }
  }
  return '0';
}
function nativePolyline(record, followers) {
  const vertices = [];
  const defaults = { start: number(record, 40), end: number(record, 41) };
  if (record.kind === 'POLYLINE') {
    for (const vertex of followers) vertices.push({ point: point(vertex, 10), bulge: number(vertex, 42), start: number(vertex, 40, defaults.start), end: number(vertex, 41, defaults.end) });
  } else {
    let vertex;
    for (const [code, raw] of record.groups) {
      const value = Number(raw);
      if (code === 10) { vertex = { point: [value, 0, number(record, 38)], bulge: 0, start: number(record, 43), end: number(record, 43) }; vertices.push(vertex); }
      else if (vertex && [20, 40, 41, 42].includes(code)) {
        assert.ok(Number.isFinite(value), 'Native polyline vertex is not finite.');
        if (code === 20) vertex.point[1] = value;
        if (code === 40) vertex.start = value;
        if (code === 41) vertex.end = value;
        if (code === 42) vertex.bulge = value;
      }
    }
    assert.equal(vertices.length, number(record, 90), 'Native lightweight vertex count does not match.');
  }
  assert.ok(vertices.length >= 2 && vertices.every((v) => v.point.every(Number.isFinite) && v.start >= 0 && v.end >= 0), 'Native polyline geometry/width is invalid.');
  const closed = Boolean(number(record, 70) & 1);
  return { scope: record.block || 'model', kind: 'polyline', ...appearance(record), closed, points: vertices.map((v) => v.point),
    // The final vertex of an open polyline has no segment. AutoCAD may normalize those
    // unused widths; compare the native widths of every actual straight/bulged segment.
    segments: vertices.slice(0, closed ? vertices.length : -1).map((v) => ({ start: v.start, end: v.end, bulge: v.bulge })) };
}
function nativeText(record) {
  const horizontal = number(record, 72), vertical = number(record, record.kind === 'TEXT' ? 73 : 74);
  const dualAnchor = horizontal === 3 || horizontal === 5;
  const height = number(record, 40), widthFactor = number(record, 41, 1);
  assert.ok(height > 0 && widthFactor > 0, 'Native text height/width factor must be positive.');
  const anchor = point(record, horizontal || vertical ? 11 : 10), firstAnchor = point(record, 10);
  const span = dualAnchor ? Math.hypot(anchor[0] - firstAnchor[0], anchor[1] - firstAnchor[1]) : 0;
  const fittedHeightPerFontAdvance = span / widthFactor;
  if (dualAnchor) assert.ok(span > 0 && Number.isFinite(span) && Number.isFinite(fittedHeightPerFontAdvance), 'Native fitted text has a degenerate or overflowing baseline.');
  const degrees = dualAnchor ? Math.atan2(anchor[1] - firstAnchor[1], anchor[0] - firstAnchor[0]) * 180 / Math.PI : number(record, 50);
  const rotation = (degrees % 360 + 360) % 360;
  return { scope: record.block || 'model', kind: record.kind, ...appearance(record), text: textValue(field(record, 1)), tag: field(record, 2), flags: number(record, 70),
    horizontal, vertical, rotation, style: field(record, 7, 'Standard').toLowerCase(), generation: number(record, 71), oblique: number(record, 51), anchor,
    ...(dualAnchor ? { firstAnchor, fittedWidth: span } : {}),
    // ALIGNED uniformly scales h and h*w*A to the anchor span, so the effective height
    // is span/(w*A), independent of stored h. A is the native font's unit advance;
    // retain its STYLE identity below and compare span/w rather than an inert raw40.
    ...(horizontal === 3 ? { fittedHeightPerFontAdvance } : { height }),
    // FIT adjusts the x factor to the span while retaining its y height. Other
    // justifications use the stored x factor directly and must preserve it.
    ...(!dualAnchor ? { widthFactor } : {}) };
}

/** Native fields that establish fidelity for the newly supported format features. */
export function nativeFeatureSignature(text, source) {
  const records = nativeDxfRecords(text), signature = [];
  const widths = source.endsWith('polyline-widths.dxf');
  const colors = source.endsWith('r2010-appearance.dxf');
  const arrays = source.endsWith('r2018-minsert.dxf') || source === 'generated:minsert-attribute-overrides';
  const placements = source.endsWith('r2000-text-justification.dxf');
  const attributes = source === 'generated:minsert-attribute-overrides' || placements;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (widths && (record.kind === 'LWPOLYLINE' || record.kind === 'POLYLINE')) {
      const followers = [];
      if (record.kind === 'POLYLINE') while (records[i + 1]?.kind === 'VERTEX') followers.push(records[++i]);
      signature.push(nativePolyline(record, followers));
    }
    if ((widths || colors || arrays || placements) && record.kind === 'INSERT') signature.push({ scope: record.block || 'model', kind: 'INSERT', ...appearance(record), block: field(record, 2), position: point(record, 10), scale: [number(record, 41, 1), number(record, 42, 1), number(record, 43, 1)], rotation: number(record, 50), columns: number(record, 70, 1), rows: number(record, 71, 1), columnSpacing: number(record, 44), rowSpacing: number(record, 45) });
    if ((widths || colors || arrays || placements) && record.kind === 'BLOCK' && !field(record, 2).startsWith('*')) signature.push({ kind: 'BLOCK', block: field(record, 2), basePoint: point(record, 10) });
    if ((colors || arrays) && record.kind === 'LINE') signature.push({ scope: record.block || 'model', kind: 'LINE', ...appearance(record), a: point(record, 10), b: point(record, 11) });
    if (colors && record.kind === 'LAYER') signature.push({ kind: 'LAYER', layerName: textValue(field(record, 2)), ...appearance(record), alpha: layerAlpha(record) });
    if (attributes && record.kind === 'STYLE') signature.push({ kind: 'STYLE', style: field(record, 2).toLowerCase(), font: field(record, 3).toLowerCase(), bigFont: field(record, 4).toLowerCase(), height: number(record, 40), widthFactor: number(record, 41, 1), oblique: number(record, 50), generation: number(record, 71) });
    if (attributes && (record.kind === 'ATTDEF' || record.kind === 'ATTRIB') || placements && record.kind === 'TEXT') signature.push(nativeText(record));
  }
  return signature.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function compareNativeFeatures(before, after, source) {
  const expected = nativeFeatureSignature(before, source), actual = nativeFeatureSignature(after, source);
  function check(a, b, path) {
    if (typeof a === 'number' && typeof b === 'number') assert.ok(Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(a)), `${source} ${path}: ${b} differs from ${a}`);
    else if (Array.isArray(a)) { assert.ok(Array.isArray(b), `${source} ${path}: missing array`); assert.equal(b.length, a.length, `${source} ${path}: array length`); a.forEach((value, index) => check(value, b[index], `${path}[${index}]`)); }
    else if (a && typeof a === 'object') { assert.deepEqual(Object.keys(b ?? {}).sort(), Object.keys(a).sort(), `${source} ${path}: keys`); for (const key of Object.keys(a)) check(a[key], b[key], `${path}.${key}`); }
    else assert.equal(b, a, `${source} ${path}`);
  }
  check(expected, actual, 'native');
  return { source, nativeRecords: expected.length, expected, actual, matched: true };
}

async function main() {
const repo = resolve(import.meta.dirname, '..');
const executable = process.env.JCAD_AUTOCAD_CONSOLE || process.argv[2] || 'C:/Program Files/Autodesk/AutoCAD 2027/accoreconsole.exe';
assert.ok(existsSync(executable), 'Set JCAD_AUTOCAD_CONSOLE to an installed AutoCAD accoreconsole executable.');
const output = process.env.JCAD_AUTOCAD_OUT ? resolve(process.env.JCAD_AUTOCAD_OUT) : mkdtempSync(join(tmpdir(), 'jcad-autocad-'));
mkdirSync(output, { recursive: true });
assert.equal(readdirSync(output).length, 0, 'Use a fresh, empty AutoCAD validation output folder.');
const helper = join(output, 'export-helper.mjs');
await build({ entryPoints: [join(repo, 'tests/helpers/autocad-export.ts')], bundle: true, platform: 'node', format: 'esm', loader: { '.jhf': 'text' }, outfile: helper });
execFileSync(process.execPath, [helper, 'export', repo, output], { cwd: repo, windowsHide: true, stdio: 'inherit', timeout: 30_000 });
const cases = JSON.parse(readFileSync(join(output, 'cases.json'), 'utf8'));
const results = [];
for (const [index, test] of cases.entries()) {
  const normalized = join(output, `autocad-${index}.dxf`);
  assert.ok(!existsSync(normalized), 'Use a fresh output folder so AutoCAD never overwrites an existing validation result.');
  const script = join(output, `audit-${index}.scr`);
  writeFileSync(script, `(setvar "FILEDIA" 0)\n_.AUDIT\n_No\n(command "_.DXFOUT" ${JSON.stringify(normalized.replaceAll('\\', '/'))} "16")\n(princ "\\nJCAD_VALIDATION_COMPLETE\\n")\n_.QUIT\n_Yes\n`);
  const result = await new Promise((done, reject) => {
    const child = spawn(executable, ['/i', test.file, '/s', script, '/l', 'en-US', '/isolate', `jcad-validation-${index}`, join(output, `profile-${index}`)], { cwd: output, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error(`AutoCAD exceeded the 60-second limit for case ${index}.`)); }, 60_000);
    const collect = (chunk) => { size += chunk.length; if (size <= 16 * 1024 * 1024) chunks.push(chunk); else child.kill(); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      const bytes = Buffer.concat(chunks), log = bytes.includes(0) ? bytes.toString('utf16le') : bytes.toString('utf8');
      writeFileSync(join(output, `audit-${index}.log`), log);
      done({ source: test.source, exitCode, complete: log.includes('JCAD_VALIDATION_COMPLETE'), rejected: /Invalid or incomplete DXF|drawing discarded|error in drawing file/i.test(log), auditErrors: Number(/Total errors found\s+(\d+)/i.exec(log)?.[1] ?? -1), normalized: existsSync(normalized) });
    });
  });
  results.push(result); console.log(JSON.stringify(result));
}
writeFileSync(join(output, 'autocad-validation.json'), JSON.stringify({ executable, results }, null, 2));
console.log(`AutoCAD validation evidence: ${output}`);
assert.ok(results.every((test) => test.exitCode === 0 && test.complete && !test.rejected && test.auditErrors === 0 && test.normalized), 'AutoCAD rejected an export or found drawing errors; inspect the validation logs.');
const nativeResults = [];
for (const [index, test] of cases.entries()) {
  // Save raw native evidence before comparing it. A legitimate external normalization
  // must be assessed from this record instead of silently loosening the oracle.
  const before = readFileSync(test.file, 'utf8'), after = readFileSync(join(output, `autocad-${index}.dxf`), 'utf8');
  const expected = nativeFeatureSignature(before, test.source), actual = nativeFeatureSignature(after, test.source);
  if (!expected.length) continue;
  const evidence = { source: test.source, nativeRecords: expected.length, expected, actual };
  writeFileSync(join(output, `native-${index}.json`), JSON.stringify(evidence, null, 2));
  try { nativeResults.push(compareNativeFeatures(before, after, test.source)); }
  catch (error) { nativeResults.push({ ...evidence, matched: false, error: error.message }); }
}
writeFileSync(join(output, 'native-features.json'), JSON.stringify(nativeResults, null, 2));
execFileSync(process.execPath, [helper, 'check', repo, output], { cwd: repo, windowsHide: true, stdio: 'inherit', timeout: 30_000 });
assert.ok(nativeResults.every((result) => result.matched), `AutoCAD changed native feature fields: ${nativeResults.filter((result) => !result.matched).map((result) => `${result.source}: ${result.error}`).join('; ')}. Inspect native-*.json and native-features.json.`);
console.log('AutoCAD accepted all exports without audit errors; entity counts, native widths/colors/arrays and attribute overrides match.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
