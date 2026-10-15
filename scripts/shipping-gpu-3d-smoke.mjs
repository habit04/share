// Fixed ordinary-entry transition gate. A LINE/ink check is not renderer accuracy proof.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { verifyExecutableFuses } from './electron-fuse-policy.mjs';
import { classifyShippingGpu2dAdapter, shippingGpu2dProbeFailure } from './shipping-gpu-2d-smoke.mjs';

const require = createRequire(import.meta.url);
const { GPU3D_STARTUP_DXF, GPU3D_FIXTURE_SHA256 } = require('../electron/main/shipping-gpu-3d-probe.cjs');
export { GPU3D_STARTUP_DXF, GPU3D_FIXTURE_SHA256 };
export const GPU3D_STATE_LABELS = Object.freeze(['default-canvas', 'explicit-gpu', 'active-3d', 'gpu-during-3d', 'lost-during-3d', 'restored-during-3d', 'gpu-resumed', 'canvas-restored']);
export const GPU3D_IMAGE_LABELS = Object.freeze(['default-canvas', 'explicit-gpu', 'active-3d', 'gpu-resumed', 'canvas-restored']);
const MAX_PNG_BYTES = 6 * 1024 * 1024, MAX_ENCODED = 8388632;

export function decodeShippingGpu3dPng(value) {
  assert.ok(typeof value === 'string' && value.length <= MAX_ENCODED, 'Bounded GPU/3D PNG transfer');
  assert.match(value, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
  const bytes = Buffer.from(value.slice('data:image/png;base64,'.length), 'base64');
  assert.ok(bytes.length > 24 && bytes.length <= MAX_PNG_BYTES, 'GPU/3D PNG byte budget');
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'GPU/3D PNG signature');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert.ok(width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 4000000, 'GPU/3D PNG dimension budget');
  const png = PNG.sync.read(bytes); assert.equal(png.width, width); assert.equal(png.height, height);
  return { bytes, width, height, rgba: png.data };
}

/** Validate all fixed evidence before decoding or writing any renderer image. */
export function preflightShippingGpu3dRecord(record, options = {}) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  assert.ok(object(record) && record.phase === 'gpu2d-3d' && record.testBuild === false, 'Fixed ordinary GPU/3D phase');
  assert.ok(typeof record.version === 'string' && record.version.length > 0 && typeof record.packaged === 'boolean', 'Actual GPU/3D application identity');
  assert.equal(record.url, 'jcad://app/index.html');
  for (const flag of ['secure', 'defaultCanvas', 'noDefaultGpuAllocation', 'default3dToolsReady', 'foreignImportDisabled',
    'noRendererTestGlobals', 'explicitGpuCommand', 'realContextLoss', 'automaticContextRestored', 'same2dDevice',
    'noHiddenExposure', 'kernelUnstarted', 'documentUnchanged', 'metadataPreserved', 'sourceUnchanged', 'noDrawingOutputs', 'same2dView', 'canvasExactRestored']) assert.equal(record[flag], true, flag);
  assert.equal(record.fixtureSha256, GPU3D_FIXTURE_SHA256, 'Exact authored GPU/3D fixture');
  assert.deepEqual(record.events, ['lost', 'restored']); assert.deepEqual(record.violations, []);
  assert.ok(Number.isSafeInteger(record.canvasInk) && record.canvasInk >= 16, 'Restored complete Canvas ink');
  for (const key of ['draws', 'clear']) assert.ok(Number.isSafeInteger(record.glCalls?.[key]) && record.glCalls[key] > 0, 'Real GPU/3D drawing submission: ' + key);
  for (const key of ['draws', 'clear']) assert.ok(Number.isSafeInteger(record.resumedGlCalls?.[key]) && record.resumedGlCalls[key] > 0, 'Fresh resumed GPU/3D drawing submission: ' + key);
  for (const name of ['adapter2d', 'adapter3d', 'adapter2dResumed']) {
    const adapter = record[name];
    assert.ok(object(adapter) && /WebGL 2/.test(adapter.version) && Number.isSafeInteger(adapter.maxTextureSize) && adapter.maxTextureSize > 0, name + ': actual WebGL2 capabilities');
    for (const key of ['vendor', 'renderer', 'unmaskedVendor', 'unmaskedRenderer']) assert.equal(typeof adapter[key], 'string', name + ': adapter identity');
    if (options.requireAdapter) {
      assert.ok(['intel', 'nvidia'].includes(options.requireAdapter), 'Enumerated physical adapter expectation');
      assert.equal(classifyShippingGpu2dAdapter(adapter), options.requireAdapter, name + ': requested preference does not prove physical execution');
    }
  }
  assert.deepEqual(record.adapter2dResumed, record.adapter2d, 'Resumed drawing adapter identity must match its pre-loss identity');
  assert.ok(Array.isArray(record.states) && record.states.length === GPU3D_STATE_LABELS.length, 'All GPU/3D states');
  const initialView = record.states[0]?.view;
  assert.ok(object(initialView) && object(initialView.center) && Number.isFinite(initialView.center.x) && Number.isFinite(initialView.center.y)
    && Number.isFinite(initialView.scale) && initialView.scale > 0 && Number.isFinite(initialView.twist), 'Actual initial 2D camera');
  for (const key of ['width', 'height', 'dpr']) assert.ok(Number.isFinite(initialView[key]) && initialView[key] > 0, 'Actual 2D viewport extent: ' + key);
  for (const key of ['backingWidth', 'backingHeight']) assert.ok(Number.isSafeInteger(initialView[key]) && initialView[key] > 0 && initialView[key] <= 4096, 'Actual Canvas backing extent: ' + key);
  assert.ok(initialView.backingWidth * initialView.backingHeight <= 4000000, 'Actual Canvas backing pixel budget');
  for (const [i, label] of GPU3D_STATE_LABELS.entries()) {
    const state = record.states[i], active = i >= 2 && i <= 5;
    assert.ok(object(state) && state.label === label, 'Exact ordered GPU/3D state: ' + label);
    assert.equal(state.documentUnchanged, true, label + ': document/history identity');
    assert.equal(state.viewUnchanged, true, label + ': 2D camera and backing preservation');
    assert.deepEqual(state.view, initialView, label + ': exact 2D camera and backing values');
    assert.equal(state.kernelStarted, false, label + ': empty-model kernel unstarted');
    assert.equal(state.active3d, active, label + ': active 3D');
    assert.equal(state.canvases3d, active ? 1 : 0, label + ': owned 3D viewport lifecycle');
    assert.equal(state.canvasVisibility, active ? 'hidden' : 'visible', label + ': Canvas visibility');
    assert.equal(state.candidateCount, i === 0 ? 0 : 1, label + ': same single 2D backing');
    assert.equal(state.owned2dDevices, i === 0 ? 0 : 1, label + ': same single 2D device');
    assert.equal(state.candidateDisplay, i === 0 ? null : i === 1 || i === 6 ? 'block' : 'none', label + ': drawing GPU visibility');
  }
  assert.ok(Array.isArray(record.images) && record.images.length === GPU3D_IMAGE_LABELS.length, 'All fixed GPU/3D images');
  for (const [i, label] of GPU3D_IMAGE_LABELS.entries()) {
    const image = record.images[i];
    assert.ok(object(image) && image.label === label && typeof image.png === 'string' && image.png.length <= MAX_ENCODED, 'Bounded fixed GPU/3D image: ' + label);
    if (label === 'default-canvas' || label === 'canvas-restored') assert.equal(image.rawGpuInk, null, label + ': complete Canvas image');
    else assert.ok(Number.isSafeInteger(image.rawGpuInk) && image.rawGpuInk >= 16, label + ': raw GPU ink before Canvas overlay');
  }
  return record.images;
}

export function validateShippingGpu3dRecord(record, options = {}) {
  const decodedImages = preflightShippingGpu3dRecord(record, options).map(image => {
    const decoded = decodeShippingGpu3dPng(image.png);
    if (image.label === 'default-canvas' || image.label === 'canvas-restored') {
      assert.equal(decoded.width, record.states[0].view.backingWidth, image.label + ': actual Canvas image width');
      assert.equal(decoded.height, record.states[0].view.backingHeight, image.label + ': actual Canvas image height');
    }
    return { label: image.label, rawGpuInk: image.rawGpuInk, ...decoded };
  });
  assert.ok(decodedImages[0].rgba.equals(decodedImages[decodedImages.length - 1].rgba), 'Initial/restored complete Canvas PNG receipts must contain exact RGBA bytes');
  return decodedImages.map(({ rgba: _rgba, ...image }) => image);
}

export async function runShippingGpu3dSmoke(args = process.argv.slice(2)) {
  assert.equal(process.platform, 'win32', 'GPU/3D acceptance targets Windows');
  const source = args.includes('--source'), highPerformance = args.includes('--high-performance');
  const adapters = args.filter(arg => arg.startsWith('--require-adapter=')), positionals = args.filter(arg => !arg.startsWith('--'));
  assert.ok(adapters.length <= 1 && args.length === new Set(args).size && args.every(arg => ['--source', '--high-performance'].includes(arg) || adapters.includes(arg) || positionals.includes(arg)), 'Only fixed GPU/3D options');
  const requireAdapter = adapters[0]?.slice('--require-adapter='.length);
  if (adapters.length) assert.ok(['intel', 'nvidia'].includes(requireAdapter), 'Physical adapter must be intel or nvidia');
  assert.ok(source ? positionals.length === 0 : positionals.length === 1, 'Provide --source or one exact shipping executable');
  const repo = resolve(import.meta.dirname, '..'), executable = source ? require('electron') : resolve(positionals[0]);
  assert.ok(existsSync(executable) && lstatSync(executable).isFile() && !lstatSync(executable).isSymbolicLink(), 'Exact regular acceptance executable');
  const expectedVersion = process.env.JCAD_E2E_EXPECT_VERSION || JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
  const out = join(resolve(process.env.JCAD_E2E_OUT || join(repo, 'e2e-output')), 'gpu-3d-production', 'run-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
  mkdirSync(out, { recursive: true });
  const scratch = realpathSync.native(tmpdir()), profile = mkdtempSync(join(scratch, 'jcad-shipping-smoke-'));
  const fixture = join(profile, 'shipping-gpu3d-startup.dxf'); writeFileSync(fixture, GPU3D_STARTUP_DXF, { flag: 'wx' });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  const switches = highPerformance ? ['--force_high_performance_gpu'] : [];
  const childArgs = [...(source ? ['.'] : []), '--probe-startup=gpu2d-3d', '--user-data-dir=' + profile, ...switches, realpathSync.native(fixture)];
  let result, probeFailure = null;
  try {
    const fuses = source ? null : await verifyExecutableFuses(executable, 'shipping');
    const child = spawnSync(executable, childArgs, { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 48 * 1024 * 1024 });
    writeFileSync(join(out, 'stdout.txt'), child.stdout || ''); writeFileSync(join(out, 'stderr.txt'), child.stderr || '');
    probeFailure = shippingGpu2dProbeFailure(child.stdout);
    assert.equal(child.error, undefined, 'GPU/3D process did not time out'); assert.equal(child.signal, null, 'GPU/3D process was not killed');
    assert.equal(child.status, 0, 'GPU/3D process clean exit' + (probeFailure ? ': ' + probeFailure : ' (see preserved stdout/stderr)'));
    const markers = (child.stdout || '').split(/\r?\n/).filter(line => line.startsWith('SHIPPING_PROBE_OK '));
    assert.equal(markers.length, 1, 'One fixed main-authored GPU/3D result');
    result = JSON.parse(markers[0].slice('SHIPPING_PROBE_OK '.length));
    writeFileSync(join(out, 'raw-result.json'), JSON.stringify(result, null, 2) + '\n');
    preflightShippingGpu3dRecord(result, { requireAdapter });
    assert.equal(result.version, expectedVersion); assert.equal(result.packaged, !source);
    assert.ok(readFileSync(fixture).equals(Buffer.from(GPU3D_STARTUP_DXF)), 'Private original DXF unchanged');
    const images = validateShippingGpu3dRecord(result, { requireAdapter });
    for (const image of images) writeFileSync(join(out, image.label + '.png'), image.bytes);
    const { images: _images, ...evidence } = result;
    const report = { mode: source ? 'source-development-only' : 'shipping-no-inspection', executable, expectedVersion, fuses,
      requestedPreference: highPerformance ? 'high-performance' : 'default', requireAdapter: requireAdapter || null,
      actual2dHardwareClass: classifyShippingGpu2dAdapter(result.adapter2d), actual3dHardwareClass: classifyShippingGpu2dAdapter(result.adapter3d),
      actualResumed2dHardwareClass: classifyShippingGpu2dAdapter(result.adapter2dResumed),
      ...evidence, images: images.map(({ bytes: _bytes, ...image }) => image),
      limitations: ['Fixed single LINE/ink transition controls; existing GPU20 and SHX26 accuracy gates are separate.', 'No installer identity, signature or upgrade acceptance is implied by this phase.'] };
    writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('Fixed ordinary GPU/3D transition acceptance passed: ' + out); return report;
  } catch (error) {
    writeFileSync(join(out, 'failure.json'), JSON.stringify({ message: error instanceof Error ? error.message : String(error), source, probeFailure, resultCaptured: !!result }, null, 2) + '\n'); throw error;
  } finally {
    if (existsSync(fixture)) {
      assert.ok(lstatSync(fixture).isFile() && !lstatSync(fixture).isSymbolicLink() && dirname(realpathSync.native(fixture)) === realpathSync.native(profile), 'Only own regular transition fixture');
      writeFileSync(join(out, 'shipping-gpu3d-startup.dxf'), readFileSync(fixture));
    }
    assert.ok(!lstatSync(profile).isSymbolicLink() && dirname(realpathSync.native(profile)) === scratch && /^jcad-shipping-smoke-[A-Za-z0-9-]+$/.test(basename(profile)), 'Only own private temporary profile may be removed');
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runShippingGpu3dSmoke();
