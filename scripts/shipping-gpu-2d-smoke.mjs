// Fixed ordinary-entry GPU acceptance. Source runs do not certify installed security.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { verifyExecutableFuses } from './electron-fuse-policy.mjs';

export const GPU2D_COMPARISON_LABELS = Object.freeze([
  ['baseline', 'gpu'], ['warm', 'gpu'], ['pan', 'gpu'], ['zoom', 'gpu'],
  ['line-edit', 'gpu'], ['line-undo', 'gpu'], ['line-redo', 'gpu'],
  ['display-change', 'gpu'], ['grid', 'canvas'], ['unsupported-entity', 'canvas'],
  ['preview', 'canvas'], ['layout', 'canvas'], ['viewport-clip', 'canvas'],
  ['native-font-before', 'canvas'], ['native-font-after', 'canvas'],
  ['font-restored', 'gpu'], ['context-lost', 'canvas'], ['context-restored', 'gpu'],
  ['first-dxf-reopen', 'gpu'], ['second-dxf-reopen', 'gpu'],
]);
export const GPU2D_STARTUP_DXF = '0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nTABLE\n5\nA0\n2\nAPPID\n70\n1\n0\nAPPID\n5\nA1\n2\nSHIPPING_GPU\n70\n0\n0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n5\nA2\n8\n0\n10\n10\n20\n10\n11\n20\n21\n20\n1001\nSHIPPING_GPU\n1000\nfixed opaque GPU metadata 9007199254740993\n1070\n7\n0\nENDSEC\n0\nEOF\n';
const MAX_PIXELS = 4_000_000;
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const BACKGROUND = [33, 40, 48];

function decodePng(value) {
  assert.equal(typeof value, 'string', 'A bounded actual PNG is required');
  assert.match(value, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
  assert.ok(value.length <= Math.ceil(MAX_PNG_BYTES * 4 / 3) + 64, 'PNG transfer budget');
  const bytes = Buffer.from(value.slice('data:image/png;base64,'.length), 'base64');
  assert.ok(bytes.length > 24 && bytes.length <= MAX_PNG_BYTES, 'PNG byte budget');
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'PNG signature');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert.ok(width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= MAX_PIXELS, 'PNG dimension budget');
  const png = PNG.sync.read(bytes);
  assert.equal(png.width, width); assert.equal(png.height, height);
  assert.equal(png.data.length, width * height * 4);
  return { ...png, bytes };
}

// Same foreground definition, two-physical-pixel allowance and bidirectional policy
// as the frozen small-scene benchmark; no dense-scene exemption is used here.
function missedForeground(a, b) {
  const foreground = (image, x, y) => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false;
    const i = (y * image.width + x) * 4;
    return Math.hypot(image.data[i] - BACKGROUND[0], image.data[i + 1] - BACKGROUND[1], image.data[i + 2] - BACKGROUND[2]) > 30;
  };
  let count = 0, missing = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    if (!foreground(a, x, y)) continue;
    count++;
    let found = false;
    for (let dy = -2; dy <= 2 && !found; dy++) for (let dx = -2; dx <= 2; dx++) if (foreground(b, x + dx, y + dy)) { found = true; break; }
    if (!found) missing++;
  }
  return { foreground: count, fraction: count ? missing / count : 0 };
}

export function compareShippingGpu2dPair(pair) {
  const expected = GPU2D_COMPARISON_LABELS.find(([label]) => label === pair?.label);
  assert.ok(expected, 'Only fixed comparison labels are accepted');
  assert.equal(pair.renderer, expected[1], pair.label + ': actual renderer');
  assert.equal(pair.documentUnchanged, true, pair.label + ': renderer did not mutate drawing/history/binding');
  const a = decodePng(pair.referencePng), b = decodePng(pair.actualPng);
  assert.equal(a.width, b.width); assert.equal(a.height, b.height);
  const calls = pair.glCalls;
  for (const key of ['draws', 'uploads', 'clear', 'uploadBytes']) assert.ok(Number.isSafeInteger(calls?.[key]) && calls[key] >= 0, 'Actual bounded GL counters: ' + key);
  const pixels = a.width * a.height;
  const mismatched = pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: 0.15 });
  let raw = 0;
  for (let i = 0; i < a.data.length; i += 4) if ([0, 1, 2, 3].some(k => a.data[i + k] !== b.data[i + k])) raw++;
  const ab = missedForeground(a, b), ba = missedForeground(b, a);
  assert.ok(ab.foreground >= 16 && ba.foreground >= 16, pair.label + ': nonempty actual ink');
  if (pair.renderer === 'canvas') {
    assert.equal(raw, 0, pair.label + ': exact complete Canvas');
    assert.ok(a.data.equals(b.data), pair.label + ': exact RGBA bytes');
    for (const key of ['draws', 'uploads', 'clear', 'uploadBytes']) assert.equal(calls[key], 0, pair.label + ': no partial GPU submission');
  } else {
    assert.ok(calls.draws > 0 && calls.clear > 0, pair.label + ': real WebGL submission');
    assert.ok(mismatched / pixels < 0.001, pair.label + ': unchanged strict small-scene raster limit');
    assert.ok(ab.fraction < 0.005 && ba.fraction < 0.005, pair.label + ': unchanged bidirectional coverage limit');
  }
  if (pair.label === 'warm') assert.equal(calls.uploads, 0, 'Actual warm scene buffer reuse');
  return { label: pair.label, renderer: pair.renderer, width: a.width, height: a.height, rawPixels: raw, rasterFraction: mismatched / pixels, canvasMissed: ab.fraction, gpuMissed: ba.fraction, glCalls: calls, referenceBytes: a.bytes, actualBytes: b.bytes };
}

/** Software signatures take precedence over physical vendor/model substrings. */
export function classifyShippingGpu2dAdapter(adapter) {
  const unmasked = `${adapter?.unmaskedVendor || ''} ${adapter?.unmaskedRenderer || ''}`;
  const allIdentity = `${unmasked} ${adapter?.vendor || ''} ${adapter?.renderer || ''}`;
  if (/Software|SwiftShader|WARP|Microsoft\s+Basic\s+Render|llvmpipe|softpipe|lavapipe/i.test(allIdentity)) return 'software';
  if (/NVIDIA|RTX|Quadro/i.test(unmasked)) return 'nvidia';
  if (/Intel|UHD|Iris/i.test(unmasked)) return 'intel';
  return 'unknown-or-other';
}

/** Complete fixed transport preflight, performed before any PNG decode or image write. */
export function preflightShippingGpu2dRecord(record, options = {}) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  assert.ok(object(record) && record.phase === 'gpu2d' && record.testBuild === false, 'Fixed ordinary shipping GPU2D phase');
  assert.ok(typeof record.version === 'string' && record.version.length > 0 && typeof record.packaged === 'boolean', 'Actual application result shape');
  for (const key of ['defaultCanvas', 'noDefaultGpuAllocation', 'noRendererTestGlobals', 'explicitCommand', 'webgl2', 'visibleInk', 'sourceUnchanged', 'backupExact', 'firstSaveReopened', 'secondSaveReopened', 'metadataPreserved', 'realContextLoss', 'automaticContextRestored', 'fontEpochChanged', 'fontDocumentUnchanged', 'displayInvalidated', 'editUndoRedo']) assert.equal(record[key], true, key);
  assert.equal(record.beforeRenderer, 'Canvas 2D');
  assert.equal(record.activeRenderer, 'WebGL2 drawing base scene + Canvas 2D editing overlays (experimental)');
  assert.equal(record.secure, true); assert.equal(record.url, 'jcad://app/index.html');
  for (const key of ['fixtureSha256', 'firstSaveSha256', 'outputSha256', 'backupSha256']) assert.match(record[key] || '', /^[a-f0-9]{64}$/);
  assert.equal(record.fixtureSha256, createHash('sha256').update(GPU2D_STARTUP_DXF).digest('hex'), 'Exact fixed authored source');
  assert.equal(record.backupSha256, record.firstSaveSha256); assert.notEqual(record.outputSha256, record.firstSaveSha256);
  assert.ok(object(record.adapter) && typeof record.adapter.version === 'string' && /WebGL 2/.test(record.adapter.version)
    && Number.isSafeInteger(record.adapter.maxTextureSize) && record.adapter.maxTextureSize > 0, 'Actual WebGL2 capability evidence');
  for (const key of ['vendor', 'renderer', 'unmaskedVendor', 'unmaskedRenderer']) assert.equal(typeof record.adapter[key], 'string', 'Actual adapter identity shape: ' + key);
  if (options.requireAdapter) {
    assert.ok(options.requireAdapter === 'intel' || options.requireAdapter === 'nvidia', 'Enumerated physical adapter expectation');
    assert.equal(classifyShippingGpu2dAdapter(record.adapter), options.requireAdapter, 'Requested preference is not proof of actual physical adapter; known software is refused');
  }
  assert.ok(Array.isArray(record.comparisons) && record.comparisons.length === GPU2D_COMPARISON_LABELS.length, 'All fixed production comparisons');
  const byLabel = new Map();
  // Establish the entire required label set before even inspecting PNG strings.
  for (const pair of record.comparisons) {
    assert.ok(object(pair) && GPU2D_COMPARISON_LABELS.some(([label]) => label === pair.label), 'Only fixed comparison evidence names');
    assert.ok(!byLabel.has(pair.label), pair.label + ': unique comparison');
    byLabel.set(pair.label, pair);
  }
  for (const [label, renderer] of GPU2D_COMPARISON_LABELS) {
    assert.ok(byLabel.has(label), label + ': mandatory comparison');
    const pair = byLabel.get(label);
    assert.equal(pair.renderer, renderer, label + ': actual renderer');
    assert.equal(pair.documentUnchanged, true, label + ': renderer did not mutate drawing/history/binding');
    if (label === 'native-font-before') assert.equal(pair.metricsPendingAtCapture, true, 'Native font pending prerequisite was captured');
    if (label === 'native-font-after') {
      assert.equal(pair.metricsLoadedAtCapture, true, 'Genuine native font loaded prerequisite was captured');
      assert.equal(pair.firstAutomaticFrame, true, 'First automatic settled Canvas frame was captured before manual paint');
    }
    assert.ok(object(pair.glCalls), label + ': actual GL counter shape');
    for (const key of ['draws', 'uploads', 'clear', 'uploadBytes']) assert.ok(Number.isSafeInteger(pair.glCalls[key]) && pair.glCalls[key] >= 0, 'Actual bounded GL counters: ' + key);
    for (const key of ['referencePng', 'actualPng']) assert.ok(typeof pair[key] === 'string' && pair[key].length <= Math.ceil(MAX_PNG_BYTES * 4 / 3) + 64, label + ': bounded PNG transfer shape');
  }
  return GPU2D_COMPARISON_LABELS.map(([label]) => byLabel.get(label));
}

export function validateShippingGpu2dRecord(record, options = {}) {
  return preflightShippingGpu2dRecord(record, options).map(compareShippingGpu2dPair);
}

/** Bounded fixed main-process failure reason; raw stdout/stderr remain preserved. */
export function shippingGpu2dProbeFailure(stdout) {
  if (typeof stdout !== 'string') return null;
  const prefix = 'SHIPPING_PROBE_FAIL ';
  const failures = stdout.split(/\r?\n/).filter(line => line.startsWith(prefix));
  if (failures.length !== 1) return null;
  const reason = failures[0].slice(prefix.length).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!reason) return null;
  return reason.length > 1000 ? reason.slice(0, 1000) + ' [truncated]' : reason;
}

export async function runShippingGpu2dSmoke(args = process.argv.slice(2)) {
  assert.equal(process.platform, 'win32', 'This acceptance runner targets Windows');
  const source = args.includes('--source'), highPerformance = args.includes('--high-performance');
  const requireAdapterArg = args.find(arg => arg.startsWith('--require-adapter='));
  const requireAdapter = requireAdapterArg?.slice('--require-adapter='.length);
  const positionals = args.filter(arg => !arg.startsWith('--'));
  assert.ok(args.every(arg => ['--source', '--high-performance'].includes(arg) || arg === requireAdapterArg || positionals.includes(arg)), 'Only fixed acceptance options');
  assert.ok(source ? positionals.length === 0 : positionals.length === 1, 'Provide --source or one exact shipping executable');
  if (requireAdapterArg) assert.ok(['intel', 'nvidia'].includes(requireAdapter), 'Physical adapter must be intel or nvidia');
  const repo = resolve(import.meta.dirname, '..');
  const executable = source ? createRequire(import.meta.url)('electron') : resolve(positionals[0]);
  assert.ok(existsSync(executable), 'Acceptance executable exists');
  const expectedVersion = process.env.JCAD_E2E_EXPECT_VERSION || JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
  const runId = 'run-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const out = join(resolve(process.env.JCAD_E2E_OUT || join(repo, 'e2e-output')), 'gpu-production', runId); mkdirSync(out, { recursive: true });
  const scratch = realpathSync.native(tmpdir()), profile = mkdtempSync(join(scratch, 'jcad-shipping-smoke-'));
  const fixture = join(profile, 'shipping-startup.dxf');
  writeFileSync(fixture, GPU2D_STARTUP_DXF, { flag: 'wx' });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  const switches = highPerformance ? ['--force_high_performance_gpu'] : [];
  const argumentsList = [...(source ? ['.'] : []), '--probe-startup=gpu2d', `--user-data-dir=${profile}`, ...switches, realpathSync.native(fixture)];
  let result, probeFailure = null;
  try {
    const fuses = source ? null : await verifyExecutableFuses(executable, 'shipping');
    const child = spawnSync(executable, argumentsList, { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 90_000, maxBuffer: 48 * 1024 * 1024 });
    writeFileSync(join(out, 'stdout.txt'), child.stdout || ''); writeFileSync(join(out, 'stderr.txt'), child.stderr || '');
    probeFailure = shippingGpu2dProbeFailure(child.stdout);
    assert.equal(child.error, undefined, 'Acceptance process did not time out');
    assert.equal(child.signal, null, 'Acceptance process was not killed'); assert.equal(child.status, 0, 'Acceptance process exited cleanly' + (probeFailure ? ': ' + probeFailure : ' (see preserved stdout/stderr)'));
    const markers = (child.stdout || '').split(/\r?\n/).filter(line => line.startsWith('SHIPPING_PROBE_OK '));
    assert.equal(markers.length, 1, 'One fixed main-authored result');
    result = JSON.parse(markers[0].slice('SHIPPING_PROBE_OK '.length));
    writeFileSync(join(out, 'raw-result.json'), JSON.stringify(result, null, 2) + '\n');
    const orderedPairs = preflightShippingGpu2dRecord(result, { requireAdapter });
    assert.equal(result.version, expectedVersion); assert.equal(result.packaged, !source);
    // After complete transport preflight, preserve images even if strict raster policy refuses.
    for (const pair of orderedPairs) {
      writeFileSync(join(out, pair.label + '-canvas.png'), decodePng(pair.referencePng).bytes);
      writeFileSync(join(out, pair.label + '-actual.png'), decodePng(pair.actualPng).bytes);
    }
    const comparisons = orderedPairs.map(compareShippingGpu2dPair);
    for (const comparison of comparisons) {
      writeFileSync(join(out, comparison.label + '-canvas.png'), comparison.referenceBytes);
      writeFileSync(join(out, comparison.label + '-actual.png'), comparison.actualBytes);
    }
    const hardwareClass = classifyShippingGpu2dAdapter(result.adapter);
    const report = { mode: source ? 'source-development-only' : 'shipping-no-inspection', requestedPreference: highPerformance ? 'high-performance' : 'default', actualHardwareClass: hardwareClass, requireAdapter: requireAdapter || null, expectedVersion, executable, fuses, noInstalledSecurityClaim: true, packagedExecutableVerified: !source, fixtureSha256: createHash('sha256').update(GPU2D_STARTUP_DXF).digest('hex'), ...result, comparisons: comparisons.map(({ referenceBytes, actualBytes, ...comparison }) => comparison), shxResourceOnlyCase: 'not-covered-by-this-fixed-phase' };
    writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`Fixed ordinary GPU2D acceptance passed: ${out}; actual ${hardwareClass}; ${source ? 'source execution is not installed security evidence' : 'exact shipping executable'}.`);
    return report;
  } catch (error) {
    writeFileSync(join(out, 'failure.json'), JSON.stringify({ message: error instanceof Error ? error.message : String(error), resultCaptured: !!result, probeFailure, source, requestedPreference: highPerformance ? 'high-performance' : 'default' }, null, 2) + '\n');
    throw error;
  } finally {
    for (const name of ['shipping-startup.dxf', 'shipping-gpu2d-output.dxf', 'shipping-gpu2d-output.dxf.bak']) {
      const file = join(profile, name);
      if (!existsSync(file)) continue;
      const stat = lstatSync(file);
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && dirname(realpathSync.native(file)) === realpathSync.native(profile), 'Only own regular acceptance artifacts');
      writeFileSync(join(out, name), readFileSync(file));
    }
    assert.ok(!lstatSync(profile).isSymbolicLink() && dirname(realpathSync.native(profile)) === scratch && /^jcad-shipping-smoke-[A-Za-z0-9-]+$/.test(basename(profile)), 'Only own private temporary profile may be removed');
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runShippingGpu2dSmoke();
