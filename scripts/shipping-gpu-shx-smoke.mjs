// Fixed genuine SHX acceptance. Source execution cannot certify an installation or AutoCAD licensing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const require = createRequire(import.meta.url);
const { SHX_FIXTURE_SHA256, SHX_FIXTURE_BYTES, SHX_FONTS } = require('../electron/main/shipping-gpu-shx-probe.cjs');
export { SHX_FIXTURE_SHA256, SHX_FIXTURE_BYTES, SHX_FONTS };
const MAX_PIXELS = 4_000_000, MAX_PNG_BYTES = 8 * 1024 * 1024, BACKGROUND = [33, 40, 48];
const rounds = ['initial', 'first-reopen', 'second-reopen'];
export const SHX_COMPARISON_LABELS = Object.freeze([
  ['default-grid-before-load', 'canvas'], ['unbound-before-load', 'either'], ['unbound-warm', 'either'],
  ...SHX_FONTS.map(font => ['initial-load-' + font.name.slice(0, -4), 'canvas']),
  ['loaded-warm', 'canvas'], ['style-edit', 'canvas'], ['style-undo', 'canvas'], ['style-redo', 'canvas'],
  ['text-edit', 'canvas'], ['text-undo', 'canvas'], ['text-redo', 'canvas'], ['first-reopen-unbound', 'either'],
  ...SHX_FONTS.map(font => ['first-reopen-load-' + font.name.slice(0, -4), 'canvas']), ['first-reopen-loaded', 'canvas'],
  ['second-reopen-unbound', 'either'], ...SHX_FONTS.map(font => ['second-reopen-load-' + font.name.slice(0, -4), 'canvas']),
  ['second-reopen-loaded', 'canvas'],
]);

/** Software identity always precedes vendor/model substrings, matching the ordinary fixed gate. */
export function classifyShippingShxAdapter(adapter) {
  if (!adapter) return 'not-created';
  const unmasked = (adapter.unmaskedVendor || '') + ' ' + (adapter.unmaskedRenderer || '');
  const all = unmasked + ' ' + (adapter.vendor || '') + ' ' + (adapter.renderer || '');
  if (/Software|SwiftShader|WARP|Microsoft\s+Basic\s+Render|llvmpipe|softpipe|lavapipe/i.test(all)) return 'software';
  if (/NVIDIA|RTX|Quadro/i.test(unmasked)) return 'nvidia';
  if (/Intel|UHD|Iris/i.test(unmasked)) return 'intel';
  return 'unknown-or-other';
}

/** Verify all mandatory bounded transport evidence before PNG decoding/writing. */
export function preflightShippingShxRecord(record, options = {}) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  assert.ok(object(record) && record.phase === 'gpu2d-shx' && record.testBuild === false, 'Fixed ordinary SHX phase');
  assert.ok(typeof record.version === 'string' && record.version.length > 0 && typeof record.packaged === 'boolean', 'Actual SHX application identity');
  for (const flag of ['secure', 'defaultCanvas', 'noDefaultGpuAllocation', 'defaultGridBeforeLoad', 'explicitGpuCommand', 'filenameOnlyPolicyUnchanged',
    'noRendererTestGlobals', 'fontLoadDocumentUnchanged', 'freshRuntimeUnbound', 'finalFreshRuntimeUnbound',
    'styleEditUndoRedo', 'textEditUndoRedo', 'firstSaveReopened', 'secondSaveReopened', 'nativeGlyphMetrics', 'backupExact', 'sourceUnchanged']) {
    assert.equal(record[flag], true, flag);
  }
  assert.equal(record.url, 'jcad://app/index.html'); assert.equal(record.currentNativeOracle, 'unrun');
  assert.equal(record.recordedOracle, 'tests/fixtures/interchange/r2018-shx-text.md');
  assert.equal(record.selectedPrivatePrograms, 4); assert.equal(record.fontSelections, 12);
  for (const key of ['fixtureSha256', 'firstSaveSha256', 'outputSha256', 'backupSha256']) assert.match(record[key] || '', /^[a-f0-9]{64}$/);
  assert.equal(record.fixtureSha256, SHX_FIXTURE_SHA256);
  assert.equal(record.backupSha256, record.firstSaveSha256); assert.notEqual(record.outputSha256, record.firstSaveSha256);
  for (const key of ['firstExport', 'finalExport']) {
    assert.ok(object(record[key])); assert.equal(record[key].textCount, 20);
    assert.ok(Number.isSafeInteger(record[key].blockTextCount) && record[key].blockTextCount >= 0);
    assert.equal(record[key].totalTextCount, 20 + record[key].blockTextCount, 'Every generated block TEXT accounted for separately');
    assert.equal(record[key].explicitDefaults, true); assert.equal(record[key].runtimeProgramsAbsent, true);
  }
  assert.ok(Array.isArray(record.fonts) && record.fonts.length === 4, 'Exactly four genuine private resource provenance records');
  record.fonts.forEach((font, i) => {
    const wanted = SHX_FONTS[i];
    assert.equal(font.name, wanted.name); assert.equal(font.bytes, wanted.bytes); assert.equal(font.sha256, wanted.sha256);
    assert.equal(font.above, wanted.above); assert.equal(font.below, wanted.below);
    assert.equal(font.path, undefined, 'No copied font path authority in renderer report');
    assert.equal(font.resourceId, undefined, 'No copied runtime resource authority in renderer report');
  });
  assert.ok(Array.isArray(record.resources) && record.resources.length === 12, 'All genuine ordinary resource transitions');
  record.resources.forEach((resource, i) => {
    const font = SHX_FONTS[i % 4];
    assert.equal(resource.round, rounds[Math.floor(i / 4)]); assert.equal(resource.name, font.name);
    assert.equal(resource.sha256, font.sha256); assert.equal(resource.bytes, font.bytes);
    for (const flag of ['currentResourceBound', 'epochChanged', 'firstAutomaticFrame', 'documentUnchanged']) assert.equal(resource[flag], true, resource.round + '/' + resource.name + ': ' + flag);
  });
  const metricTags = ['initial', 'style-undo', 'style-redo', 'first-reopen', 'second-reopen'];
  assert.ok(Array.isArray(record.metrics) && record.metrics.length === 20, 'Four native metric runs in each fixed resource/style state');
  record.metrics.forEach((metric, i) => {
    const font = SHX_FONTS[i % 4], wanted = font.oracle;
    assert.equal(metric.tag, metricTags[Math.floor(i / 4)]); assert.equal(metric.name, font.name); assert.equal(metric.tolerance, 1e-8);
    assert.equal(metric.oracle, 'recorded-AutoCAD2027-reference-not-a-new-native-run');
    const close = (value, target) => assert.ok(Number.isFinite(value) && Math.abs(value - target) <= 1e-8, metric.tag + '/' + metric.name + ': recorded metric');
    close(metric.right, wanted.right); close(metric.middleOffset, wanted.middle); close(metric.fittedWidth, wanted.fitted);
    assert.ok(Array.isArray(metric.customBox) && metric.customBox.length === 4);
    metric.customBox.forEach((value, at) => close(value, wanted.box[at]));
  });
  assert.ok(Array.isArray(record.styleMetrics) && record.styleMetrics.length === 3, 'Actual STYLE geometry edit/undo/redo');
  record.styleMetrics.forEach((metric, i) => {
    const font = SHX_FONTS[i === 1 ? 0 : 1], wanted = font.oracle;
    assert.equal(metric.tag, ['style-edit', 'style-undo', 'style-redo'][i]); assert.equal(metric.actualFont, font.name);
    assert.equal(metric.customFont, 'txt.shx'); assert.equal(metric.storedFittedWidth, 5);
    /** @type {Array<[string, number]>} */
    const targets = [['right', wanted.right], ['middleOffset', wanted.middle], ['fittedWidth', wanted.fitted]];
    for (const [key, target] of targets) {
      assert.ok(Number.isFinite(metric[key]) && Math.abs(metric[key] - target) <= 1e-8, 'Actual STYLE geometry: ' + key);
    }
  });
  if (record.adapter !== null) {
    assert.ok(object(record.adapter) && /WebGL 2/.test(record.adapter.version) && Number.isSafeInteger(record.adapter.maxTextureSize) && record.adapter.maxTextureSize > 0, 'Actual owned WebGL identity');
    for (const key of ['vendor', 'renderer', 'unmaskedVendor', 'unmaskedRenderer']) assert.equal(typeof record.adapter[key], 'string', 'Actual adapter shape');
  }
  if (options.requireAdapter) {
    assert.ok(['intel', 'nvidia'].includes(options.requireAdapter), 'Fixed physical adapter expectation');
    assert.equal(classifyShippingShxAdapter(record.adapter), options.requireAdapter, 'Unbound refusal without a context cannot certify the requested physical adapter');
  }
  assert.ok(Array.isArray(record.comparisons) && record.comparisons.length === SHX_COMPARISON_LABELS.length, 'All twenty-six fixed SHX comparisons');
  const byLabel = new Map();
  for (const pair of record.comparisons) {
    assert.ok(object(pair) && SHX_COMPARISON_LABELS.some(([label]) => label === pair.label), 'Only fixed SHX labels');
    assert.ok(!byLabel.has(pair.label), 'Unique SHX comparison'); byLabel.set(pair.label, pair);
  }
  for (const [label, expected] of SHX_COMPARISON_LABELS) {
    const pair = byLabel.get(label); assert.ok(pair, 'Mandatory SHX comparison: ' + label);
    assert.ok(['canvas', 'gpu'].includes(pair.renderer) && (expected === 'either' || pair.renderer === expected), label + ': actual renderer');
    if (pair.renderer === 'gpu') assert.ok(record.adapter, label + ': actual owned adapter required');
    assert.equal(pair.documentUnchanged, true, label + ': source/history/view retained');
    if (label.includes('-load-')) {
      for (const flag of ['firstAutomaticFrame', 'epochChanged', 'currentResourceBound']) assert.equal(pair[flag], true, label + ': ' + flag);
      assert.ok(typeof pair.beforeResourcePng === 'string' && pair.beforeResourcePng.length <= Math.ceil(MAX_PNG_BYTES * 4 / 3) + 64, label + ': independent unbound/prior-resource Canvas image');
    }
    assert.ok(object(pair.glCalls), label + ': actual GL count shape');
    for (const key of ['draws', 'uploads', 'clear', 'uploadBytes']) assert.ok(Number.isSafeInteger(pair.glCalls[key]) && pair.glCalls[key] >= 0, label + ': bounded GL counters');
    for (const key of ['referencePng', 'actualPng']) assert.ok(typeof pair[key] === 'string' && pair[key].length <= Math.ceil(MAX_PNG_BYTES * 4 / 3) + 64, label + ': bounded PNG transfer');
  }
  return SHX_COMPARISON_LABELS.map(([label]) => byLabel.get(label));
}

function decodePng(value) {
  assert.match(value, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
  assert.ok(value.length <= Math.ceil(MAX_PNG_BYTES * 4 / 3) + 64);
  const bytes = Buffer.from(value.slice('data:image/png;base64,'.length), 'base64');
  assert.ok(bytes.length > 24 && bytes.length <= MAX_PNG_BYTES && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'SHX PNG byte signature/budget');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert.ok(width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= MAX_PIXELS, 'SHX PNG dimension budget');
  const image = PNG.sync.read(bytes);
  assert.equal(image.width, width); assert.equal(image.height, height); assert.equal(image.data.length, width * height * 4);
  return { ...image, bytes };
}
function missedForeground(a, b) {
  const foreground = (image, x, y) => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false;
    const i = (y * image.width + x) * 4;
    return Math.hypot(image.data[i] - BACKGROUND[0], image.data[i + 1] - BACKGROUND[1], image.data[i + 2] - BACKGROUND[2]) > 30;
  };
  let count = 0, missing = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    if (!foreground(a, x, y)) continue;
    count++; let found = false;
    for (let dy = -2; dy <= 2 && !found; dy++) for (let dx = -2; dx <= 2; dx++) if (foreground(b, x + dx, y + dy)) { found = true; break; }
    if (!found) missing++;
  }
  return { foreground: count, fraction: count ? missing / count : 0 };
}

/** Original small-scene limits and exact complete Canvas; no native-accuracy claim from raster parity. */
export function compareShippingShxPair(pair) {
  const expected = SHX_COMPARISON_LABELS.find(([label]) => label === pair.label);
  assert.ok(expected && (expected[1] === 'either' || pair.renderer === expected[1]), 'Fixed SHX renderer/label');
  assert.equal(pair.documentUnchanged, true);
  const a = decodePng(pair.referencePng), b = decodePng(pair.actualPng);
  assert.equal(a.width, b.width); assert.equal(a.height, b.height);
  for (const key of ['draws', 'uploads', 'clear', 'uploadBytes']) assert.ok(Number.isSafeInteger(pair.glCalls?.[key]) && pair.glCalls[key] >= 0);
  const pixels = a.width * a.height, mismatch = pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: 0.15 });
  let raw = 0;
  for (let i = 0; i < a.data.length; i += 4) if ([0, 1, 2, 3].some(key => a.data[i + key] !== b.data[i + key])) raw++;
  const ab = missedForeground(a, b), ba = missedForeground(b, a);
  assert.ok(ab.foreground >= 16 && ba.foreground >= 16, pair.label + ': meaningful actual native/substitute ink');
  if (pair.renderer === 'canvas') {
    assert.equal(raw, 0); assert.ok(a.data.equals(b.data), pair.label + ': exact complete Canvas RGBA');
    for (const key of ['draws', 'uploads', 'clear', 'uploadBytes']) assert.equal(pair.glCalls[key], 0, pair.label + ': zero GPU submission');
  } else {
    assert.ok(pair.glCalls.draws > 0 && pair.glCalls.clear > 0, pair.label + ': actual GPU');
    assert.ok(mismatch / pixels < 0.001 && ab.fraction < 0.005 && ba.fraction < 0.005, pair.label + ': unchanged raster/coverage bounds');
  }
  if (pair.label === 'unbound-warm' && pair.renderer === 'gpu') assert.equal(pair.glCalls.uploads, 0, 'SHX actual warm GPU reuse');
  let fontChangedPixels = null, beforeResourceBytes;
  if (pair.label.includes('-load-')) {
    const before = decodePng(pair.beforeResourcePng);
    assert.equal(before.width, b.width); assert.equal(before.height, b.height);
    fontChangedPixels = 0;
    for (let i = 0; i < before.data.length; i += 4) if ([0, 1, 2, 3].some(key => before.data[i + key] !== b.data[i + key])) fontChangedPixels++;
    assert.ok(fontChangedPixels >= 16, pair.label + ': genuine font load must visibly replace prior/substitute ink');
    beforeResourceBytes = before.bytes;
  }
  return { label: pair.label, renderer: pair.renderer, width: a.width, height: a.height, rawPixels: raw, fontChangedPixels,
    rasterFraction: mismatch / pixels, canvasMissed: ab.fraction, gpuMissed: ba.fraction, glCalls: pair.glCalls,
    referenceBytes: a.bytes, actualBytes: b.bytes, beforeResourceBytes };
}
export function validateShippingShxRecord(record, options = {}) { return preflightShippingShxRecord(record, options).map(compareShippingShxPair); }

export async function runShippingShxSmoke(args = process.argv.slice(2)) {
  assert.equal(process.platform, 'win32', 'SHX resource acceptance targets Windows');
  const source = args.includes('--source'), highPerformance = args.includes('--high-performance');
  const adapterFlag = args.find(arg => arg.startsWith('--require-adapter=')), requireAdapter = adapterFlag?.slice('--require-adapter='.length);
  const positionals = args.filter(arg => !arg.startsWith('--'));
  assert.ok(args.every(arg => ['--source', '--high-performance'].includes(arg) || arg === adapterFlag || positionals.includes(arg)), 'Only fixed SHX acceptance options');
  assert.ok(source ? positionals.length === 0 : positionals.length === 1, 'One exact executable or --source');
  if (adapterFlag) assert.ok(['intel', 'nvidia'].includes(requireAdapter));
  const repo = resolve(import.meta.dirname, '..'), executable = source ? require('electron') : resolve(positionals[0]);
  assert.ok(existsSync(executable)); const expectedVersion = process.env.JCAD_E2E_EXPECT_VERSION || JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
  const out = join(repo, 'e2e-output', 'gpu-production-shx', 'run-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
  mkdirSync(out, { recursive: true });
  const scratch = realpathSync.native(tmpdir()), profile = mkdtempSync(join(scratch, 'jcad-shipping-smoke-'));
  const input = join(repo, 'tests', 'fixtures', 'interchange', 'r2018-shx-text.dxf'), fixture = join(profile, 'shipping-shx-startup.dxf');
  let result, report, nativeFonts;
  try {
    const sourceBytes = readFileSync(input), hash = bytes => createHash('sha256').update(bytes).digest('hex');
    assert.equal(sourceBytes.length, SHX_FIXTURE_BYTES); assert.equal(hash(sourceBytes), SHX_FIXTURE_SHA256);
    writeFileSync(fixture, sourceBytes, { flag: 'wx' }); mkdirSync(join(profile, 'shx-resources'));
    const installed = 'C:\\Program Files\\Autodesk\\AutoCAD 2027\\Fonts';
    nativeFonts = SHX_FONTS.map(font => {
      const file = join(installed, font.name), stat = lstatSync(file);
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && realpathSync.native(file) === file && realpathSync.native(dirname(file)) === installed, 'Only genuine named regular installed resources');
      assert.equal(stat.size, font.bytes); assert.ok(stat.size <= 8 * 1024 * 1024);
      assert.equal(hash(readFileSync(file)), font.sha256, 'Current private font source pin');
      const copied = join(profile, 'shx-resources', font.name); copyFileSync(file, copied, constants.COPYFILE_EXCL);
      assert.equal(hash(readFileSync(copied)), font.sha256, 'Private copy pin');
      return { name: font.name, bytes: font.bytes, sha256: font.sha256, installedPath: file,
        scope: 'private-local-reference-only; font programs excluded from artifacts/packages' };
    });
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
    const switches = highPerformance ? ['--force_high_performance_gpu'] : [];
    const argv = [...(source ? ['.'] : []), '--probe-startup=gpu2d-shx', '--user-data-dir=' + profile, ...switches, realpathSync.native(fixture)];
    const { verifyExecutableFuses } = await import('./electron-fuse-policy.mjs');
    const fuses = source ? null : await verifyExecutableFuses(executable, 'shipping');
    const child = spawnSync(executable, argv, { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 90_000, maxBuffer: 48 * 1024 * 1024 });
    writeFileSync(join(out, 'stdout.txt'), child.stdout || ''); writeFileSync(join(out, 'stderr.txt'), child.stderr || '');
    assert.equal(child.error, undefined, 'SHX exact application did not time out');
    assert.equal(child.signal, null); assert.equal(child.status, 0, 'SHX exact application exited cleanly; see raw stdout/stderr');
    const markers = (child.stdout || '').split(/\r?\n/).filter(line => line.startsWith('SHIPPING_PROBE_OK '));
    assert.equal(markers.length, 1); result = JSON.parse(markers[0].slice('SHIPPING_PROBE_OK '.length));
    writeFileSync(join(out, 'raw-result.json'), JSON.stringify(result, null, 2) + '\n');
    const ordered = preflightShippingShxRecord(result, { requireAdapter });
    assert.equal(result.version, expectedVersion); assert.equal(result.packaged, !source);
    for (const pair of ordered) {
      writeFileSync(join(out, pair.label + '-canvas.png'), decodePng(pair.referencePng).bytes);
      writeFileSync(join(out, pair.label + '-actual.png'), decodePng(pair.actualPng).bytes);
      if (pair.beforeResourcePng) writeFileSync(join(out, pair.label + '-before-resource.png'), decodePng(pair.beforeResourcePng).bytes);
    }
    const comparisons = ordered.map(compareShippingShxPair);
    report = { ...result, comparisons: comparisons.map(({ referenceBytes, actualBytes, beforeResourceBytes, ...comparison }) => comparison),
      mode: source ? 'source-development-only' : 'packaged-executable-fuses-only', noInstalledSecurityClaim: true,
      noInstallationClaim: true, noPublisherTrustClaim: true, noWindowsTrustClaim: true, executable, fuses, expectedVersion,
      requestedPreference: highPerformance ? 'high-performance' : 'default', actualHardwareClass: classifyShippingShxAdapter(result.adapter),
      requireAdapter: requireAdapter || null, nativeFontProvenance: nativeFonts,
      independentOrdinary20CaseGate: 'required-separately; this SHX phase does not replace it',
      currentAutoCADAndPdfOracle: 'unrun; documented numeric baseline only; no current-font-hash native certification',
      privateProgramsRemoved: false };
    writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
  } catch (error) {
    writeFileSync(join(out, 'failure.json'), JSON.stringify({ message: error instanceof Error ? error.message : String(error), resultCaptured: !!result,
      source, requestedPreference: highPerformance ? 'high-performance' : 'default', nativeFontProvenance: nativeFonts || null,
      currentAutoCADAndPdfOracle: 'unrun' }, null, 2) + '\n'); throw error;
  } finally {
    // Only drawing bytes and metadata are exported. No SHX resource/profile subtree is copied.
    for (const name of ['shipping-shx-startup.dxf', 'shipping-shx-output.dxf', 'shipping-shx-output.dxf.bak']) {
      const file = join(profile, name); if (!existsSync(file)) continue;
      const stat = lstatSync(file);
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && dirname(realpathSync.native(file)) === realpathSync.native(profile), 'Only own regular private drawings may be preserved');
      writeFileSync(join(out, name), readFileSync(file));
    }
    assert.ok(!lstatSync(profile).isSymbolicLink() && dirname(realpathSync.native(profile)) === scratch
      && /^jcad-shipping-smoke-[A-Za-z0-9-]+$/.test(basename(profile)), 'Only own fresh private profile may be removed');
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    if (report) { report.privateProgramsRemoved = true; writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runShippingShxSmoke();
