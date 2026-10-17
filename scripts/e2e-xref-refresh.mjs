// Electron/native xref refresh gate (P20.2, NATIVE-REFRESH-PLAN.md as
// approved with amendments 1-2; harness correction round G1/G3/G4).
// Drives the REAL app: the preload bridge (window.jcad beginXrefContext/
// identifyXref/readXref/cancelXref/closeXrefContext) -> main IPC -> broker
// -> the app's own path registry -> real files on disk and the real
// decoder. No registry/grant API is ever called by this harness.
//
// Registry seam (named, per G1): registry.isKnown is EXACT-PATH
// membership - opening one drawing makes only that path known. The app's
// designed route for a set of related drawings is its project file, so
// the generator emits xref-native.jcadproj.json listing every fixture
// drawing and this harness opens it through the genuine Open Project
// dialog flow (main then registers the listed drawings itself), before
// opening the host through the genuine OPEN flow. The harness grants
// nothing; all authority state is produced by the app's own flows.
//
// Loader seam (G1): the accepted loader and adapter sources
// (src/io/xref-loading.ts, src/app/xref-reader.ts) are bundled at run
// time with esbuild (plus a Vite `?raw` text plugin mirroring the app's
// own build semantics) and injected into the renderer, where the REAL
// XrefStore runs with the REAL adapter over window.jcad directly - so
// the adapter sees the genuine Electron invoke envelope, unchanged. The
// host's block table comes from the opened drawing itself
// (window.editor.doc.snapshot.blocks). Source and bundle hashes are
// recorded in the results header (G3).
//
// Runner recipe (bounded, per the lead brief): --work-root is REQUIRED
// and confines the fixture dir, the out dir, every Electron profile and
// TEMP/TMP. The Electron child env is constructed from a whitelist only
// (PATH, SystemRoot, windir, TEMP, TMP, ELECTRON_DISABLE_
// SECURITY_WARNINGS; DISPLAY/XAUTHORITY join the whitelist on non-win32
// only, where a headless X server is the launch mechanism). A 10-minute
// watchdog terminates ONLY this harness's own Electron processes.
// Nothing is deleted: profiles, outputs and fixtures stay as residue
// evidence and are recorded in results.json.
//
// G2 observer: broker-stats assertions and the in-flight quit witness
// evaluate only from samples of the pinned test-only observer
// (scripts/xref-test-observer.cjs, preloaded via the Electron CLI
// --require route under the G2 ruling) when this run is launched with
// --observer. Without a valid observer baseline/witness those criteria
// are BLOCKED (never passed by sleep) and make the exit code nonzero.
// Clean process exit is recorded as exit evidence only - it is NOT a
// completed-drain proof (the IPC dispose ignores the closeAll promise).
// Executing the observer is a separately admitted native step.
//
//   npm run build
//   node scripts/xref-native-fixtures.mjs <work-root>/fixtures
//   node --experimental-strip-types scripts/e2e-xref-refresh.mjs \
//     --work-root <work-root> --fixtures <work-root>/fixtures \
//     --out <work-root>/out [--sections 3.1,3.2] \
//     [--head <candidate-head>] [--tree <candidate-tree>]
//
// Exit codes: 0 = every selected check passed and none blocked;
// 1 = a check failed or a selected criterion is blocked;
// 2 = invalid setup (fail closed, before any launch).
//
// Platform note: the broker validates Windows absolute paths by design
// (absoluteWindowsPath in electron/xref-read.cjs), and the preload
// exposes the xref bridge only on win32. On any other platform this
// harness validates its mechanics (confinement, fixture verification,
// bundle build, project/host open, headers) but the run stops at the
// bridge boundary - the gate itself is Windows-only, as designed.
//
// Architecture note (section 3.5): broker contexts are owned by the
// WebContents (electron/main/ipc-xrefs.cjs ownerOf hooks did-navigate
// and destroyed), not by an editor tab. Section 3.5a applies the
// approved plan's tab-close criterion exactly as written and reports
// the observed outcome truthfully; 3.5a2 is an ADDITIONAL observation
// of retirement on page navigation, not a substitute for 3.5a.
import { _electron as electron } from 'playwright';
import { applicationWindow } from './electron-window.mjs';
import { build as esbuildBuild } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : '';
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const fileSha = (p) => sha256(readFileSync(p));
const MIB = 1024 * 1024;
const G2_REASON = 'awaiting reviewed G2 observation mechanism (no broker-stats entry point exists in the accepted tree)';

// ------------------------------------------------------------ setup (fail closed)
const workRootArg = argOf('--work-root');
const fixtureArg = argOf('--fixtures');
const outArg = argOf('--out');
const sectionsArg = argOf('--sections');
const sections = sectionsArg ? sectionsArg.split(',').map((s) => s.trim()).filter(Boolean) : ['3.1', '3.2', '3.3', '3.4', '3.5'];
function setupFail(message) {
  console.error(`e2e-xref-refresh: invalid setup: ${message}`);
  process.exit(2);
}
// G2 observer (lead ruling, implementation for review): when --observer
// names the pinned test-only observer file, launches preload it through
// the Electron CLI --require route (default_app) and the harness records
// read-only stats samples. Stats criteria evaluate ONLY from valid
// samples; otherwise they stay BLOCKED. Execution of the observer is a
// separately admitted native step - this delivery does not run it.
const observerArg = argOf('--observer');
const observerTargetSha = argOf('--observer-target-sha');
const observerMode = observerArg !== '';
let observerPath = '';
let observerSha256 = '';
if (observerMode) {
  observerPath = resolve(observerArg);
  if (!existsSync(observerPath)) setupFail('--observer file does not exist');
  if (!/^[0-9a-f]{64}$/.test(observerTargetSha)) setupFail('--observer-target-sha must be the pinned 64-hex sha256 of electron/xref-read.cjs from the delivery manifest');
  const actualTarget = fileSha(join(repo, 'electron', 'xref-read.cjs'));
  if (actualTarget !== observerTargetSha) setupFail(`--observer-target-sha (${observerTargetSha}) does not match electron/xref-read.cjs (${actualTarget}) - refusing to launch`);
  observerSha256 = fileSha(observerPath);
}
if (!workRootArg) setupFail('--work-root is required (fixtures, out, profiles and TEMP are confined under it)');
if (!fixtureArg) setupFail('--fixtures is required');
if (!outArg) setupFail('--out is required');
const workRoot = resolve(workRootArg);
mkdirSync(workRoot, { recursive: true });
const insideWork = (p, what) => {
  const rel = relative(workRoot, p);
  if (rel === '' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) setupFail(`${what} (${p}) must be a directory inside --work-root (${workRoot})`);
  return p;
};
const fixtureDir = insideWork(resolve(fixtureArg), '--fixtures');
const outDir = insideWork(resolve(outArg), '--out');
const tempDir = join(workRoot, 'temp');
mkdirSync(tempDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const fx = (rel) => join(fixtureDir, ...rel.split('/'));
if (!existsSync(fx('fixtures.json'))) setupFail(`fixtures.json not found in ${fixtureDir} - run scripts/xref-native-fixtures.mjs first`);
const fixtureMeta = JSON.parse(readFileSync(fx('fixtures.json'), 'utf8'));
if (fixtureMeta.version !== 2 || !fixtureMeta.files || !fixtureMeta.edits) setupFail('fixtures.json is not the v2 layout - regenerate the fixtures');
for (const rel of ['mutable.dxf', 'shared/leaf.dxf']) {
  const e = fixtureMeta.edits[rel];
  if (!e || typeof e.locate !== 'string' || typeof e.replace !== 'string' || typeof e.editedSha256 !== 'string') setupFail(`fixtures.json lacks a pinned edit descriptor for ${rel}`);
}
if (typeof fixtureMeta.edits['mutable.dxf'].grownSha256 !== 'string') setupFail('fixtures.json lacks the pinned grown hash for mutable.dxf');
const manifestText = readFileSync(fx('SHA256SUMS.txt'), 'utf8');
const manifestSha = sha256(Buffer.from(manifestText));
{
  const manifestLines = manifestText.trim().split('\n').map((l) => l.trim()).filter(Boolean).sort();
  const expectLines = Object.entries(fixtureMeta.files).map(([rel, m]) => `${m.sha256}  ${rel}`).sort();
  if (JSON.stringify(manifestLines) !== JSON.stringify(expectLines)) setupFail('SHA256SUMS.txt does not match the fixtures.json file set/hashes');
}
for (const [rel, meta] of Object.entries(fixtureMeta.files)) {
  if (!existsSync(fx(rel))) setupFail(`fixture ${rel} is missing`);
  const buf = readFileSync(fx(rel));
  if (buf.length !== meta.bytes || sha256(buf) !== meta.sha256) setupFail(`fixture ${rel} does not match fixtures.json - regenerate the fixtures`);
}
const projectRel = fixtureMeta.project;
const hostRel = 'drawings/host.dxf';
const leafRel = 'shared/leaf.dxf';
if (!fixtureMeta.files[projectRel] || !fixtureMeta.files[hostRel]) setupFail('fixtures.json lacks the project file or the host drawing');
const projectPath = fx(projectRel);
const hostPath = fx(hostRel);
const hostHashBefore = fixtureMeta.files[hostRel].sha256;

// ------------------------------------------------------------ result records
const logLines = [];
const log = (line) => { logLines.push(line); console.log(line); };
const checks = [];
let currentSection = 'setup';
let halted = false;
let haltReason = '';
function record(status, name, detail = '') {
  checks.push({ section: currentSection, name, status, detail });
  log(`${status === 'pass' ? 'ok  ' : status === 'fail' ? 'FAIL' : status.toUpperCase().padEnd(4)} [${currentSection}] ${name}${detail ? ` - ${detail}` : ''}`);
}
function check(pass, name, detail = '') { record(pass ? 'pass' : 'fail', name, detail); return Boolean(pass); }
function blocked(name, reason = G2_REASON) { record('blocked', name, reason); }
function failHalt(name, detail = '') {
  record('fail', name, detail);
  halted = true;
  haltReason = `stopped at the first failed PASS criterion: [${currentSection}] ${name}`;
}
const results = { header: {}, checks, observer: { mode: observerMode ? 'cli-require via default_app' : 'off', path: observerPath || null, sha256: observerSha256 || null, targetSha256: observerTargetSha || null }, observerSamples: [], observerBaseline: null, residue: { workRoot, fixtureDir, outDir, tempDir, profiles: [], childExits: [], watchdogFired: false, deleted: 'nothing (residue preserved by design)' } };
function writeResults() {
  try {
    writeFileSync(join(outDir, 'harness.log'), logLines.join('\n') + '\n');
    writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  } catch { /* the out dir itself is the evidence; a failed write cannot be helped here */ }
}

// ------------------------------------------------------------ watchdog + owned processes
const children = new Set();
function trackChild(label, child) {
  if (!child) return;
  const entry = { label, child, exitCode: undefined };
  children.add(entry);
  child.once('exit', (code) => { entry.exitCode = code; results.residue.childExits.push({ label, code }); });
}
function killChild(entry) {
  const { child } = entry;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5_000, windowsHide: true });
    } else child.kill('SIGKILL');
  } catch { /* already gone */ }
}
const watchdog = setTimeout(() => {
  results.residue.watchdogFired = true;
  log('FAIL watchdog: 10 minutes elapsed - terminating ONLY this harness\'s own Electron processes');
  for (const entry of children) killChild(entry);
  record('fail', 'global watchdog fired (10 min)');
  writeResults();
  process.exit(1);
}, 10 * 60 * 1000);
watchdog.unref();

function waitForExit(child, ms) {
  return new Promise((done) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return done(child ? child.exitCode : null);
    const onExit = () => { clearTimeout(timer); done(child.exitCode); };
    const timer = setTimeout(() => { child.removeListener('exit', onExit); done(null); }, ms);
    child.once('exit', onExit);
  });
}

// ------------------------------------------------------------ child env (whitelist)
function childEnv() {
  const env = {};
  for (const k of ['PATH', 'SystemRoot', 'windir']) if (process.env[k]) env[k] = process.env[k];
  env.TEMP = tempDir;
  env.TMP = tempDir;
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';
  if (observerMode) {
    // The reviewed runner supplies the observer's fail-closed opt-in and
    // the pinned target identity - and nothing else extra.
    env.JCAD_XREF_TEST_OBSERVER = '1';
    env.JCAD_XREF_OBSERVER_TARGET_SHA256 = observerTargetSha;
  }
  // Non-Windows only: a headless X server is the launch mechanism itself.
  if (process.platform !== 'win32') {
    if (process.env.DISPLAY) env.DISPLAY = process.env.DISPLAY;
    if (process.env.XAUTHORITY) env.XAUTHORITY = process.env.XAUTHORITY;
  }
  return env;
}

// ------------------------------------------------------------ loader bundle (G1)
let bundleText = null;
let bundleError = null;
let bundleInfo = null;
async function buildBundle() {
  const entryPath = join(outDir, 'xref-core-entry.ts');
  const toImport = (p) => p.replace(/\\/g, '/');
  writeFileSync(entryPath, [
    `export { XrefStore, collectXrefReferences, externalContent } from '${toImport(join(repo, 'src/io/xref-loading.ts'))}';`,
    `export { createXrefReader } from '${toImport(join(repo, 'src/app/xref-reader.ts'))}';`,
    '',
  ].join('\n'));
  // Emulate Vite's `?raw` suffix (the app build's own semantics): the
  // module default export is the referenced file's text content.
  const rawPlugin = {
    name: 'vite-raw',
    setup(b) {
      b.onResolve({ filter: /\?raw$/ }, (args) => ({ path: resolve(dirname(args.importer), args.path.replace(/\?raw$/, '')), namespace: 'raw' }));
      b.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({ contents: `export default ${JSON.stringify(readFileSync(args.path, 'utf8'))};`, loader: 'js' }));
    },
  };
  const outfile = join(outDir, 'xref-core.bundle.js');
  await esbuildBuild({
    entryPoints: [entryPath], bundle: true, format: 'iife', globalName: '__xrefCore',
    platform: 'browser', target: 'es2022', plugins: [rawPlugin], outfile, logLevel: 'silent',
  });
  const buf = readFileSync(outfile);
  bundleText = buf.toString('utf8');
  bundleInfo = { bytes: buf.length, sha256: sha256(buf) };
}

// ------------------------------------------------------------ app driving
async function launchApp(label) {
  const profile = join(workRoot, `profile-${label}`);
  mkdirSync(profile, { recursive: true });
  results.residue.profiles.push(profile);
  const args = observerMode
    ? ['--require', observerPath, '.', `--user-data-dir=${profile}`]
    : ['.', `--user-data-dir=${profile}`];
  if (process.platform === 'linux') args.push('--no-sandbox');
  const app = await electron.launch({ args, cwd: repo, env: childEnv(), timeout: 60_000 });
  trackChild(label, app.process());
  const win = await applicationWindow(app);
  const pageErrors = [];
  win.on('pageerror', (e) => pageErrors.push(String(e.message)));
  await win.waitForFunction(() => !!window.editor, null, { timeout: 30_000 });
  await app.evaluate(({ dialog }) => {
    const g = globalThis;
    g.__xrefOpenPaths = [];
    dialog.showOpenDialog = async () => {
      const p = g.__xrefOpenPaths.shift();
      return p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] };
    };
  });
  return { app, win, pageErrors, profile };
}

// ------------------------------------------------------------ G2 observer sampling
let observerBaseline = null;
let observerBaselineUsable = false;
async function sampleObserver(appInstance, tag) {
  if (!observerMode) return null;
  try {
    const s = await appInstance.evaluate(() => {
      const f = globalThis.__xrefTestObserver;
      return f ? f.sample() : null;
    });
    results.observerSamples.push({ tag, sample: s });
    return s;
  } catch {
    return null;
  }
}
function observerUsable(s) {
  return Boolean(observerBaselineUsable && s && s.captured && s.factoryCalls === 1 && !s.invalidated && s.stats);
}
function observerBlockReason(s) {
  if (!observerMode) return 'observer not enabled for this run (no --observer): stats criteria stay BLOCKED under the G2 ruling';
  if (!observerBaselineUsable) return 'observer baseline was not a clean zero capture: stats coverage invalid for this run';
  if (!s) return 'observer facade absent or sampling failed: stats coverage invalid for this run';
  if (s.invalidated) return `observer coverage invalidated: ${s.invalidated}`;
  if (!s.captured || s.factoryCalls !== 1) return `observer one-instance proof failed (captured=${s.captured}, factoryCalls=${s.factoryCalls})`;
  return 'observer sample unusable';
}
async function statsZeroCheck(appInstance, name) {
  const s = await sampleObserver(appInstance, name);
  if (!observerUsable(s)) { blocked(name, observerBlockReason(s)); return; }
  const st = s.stats;
  const b = observerBaseline.stats;
  check(st.activeOps === 0 && st.reservedRawBytes === 0 && st.contexts === b.contexts && st.tickets === b.tickets,
    name, `sample=${JSON.stringify(st)} baseline=${JSON.stringify(b)}`);
}

async function openProjectAndHost(app, win) {
  // Genuine Open Project first: main registers every listed fixture
  // drawing as readable by name (the designed project mechanism).
  await app.evaluate((_e, p) => globalThis.__xrefOpenPaths.push(p), projectPath);
  const projOk = await win.evaluate(() => window.editor.openProject());
  if (!projOk) throw new Error('the genuine Open Project flow did not open the fixture project');
  const listed = await win.evaluate(() => window.editor.project.drawings.length);
  const expected = Object.keys(fixtureMeta.files).filter((rel) => rel.endsWith('.dxf')).length;
  if (listed !== expected) throw new Error(`project listed ${listed} drawings, expected ${expected}`);
  // Then the genuine OPEN of the host drawing.
  await app.evaluate((_e, p) => globalThis.__xrefOpenPaths.push(p), hostPath);
  await win.evaluate(() => void window.editor.runCommand('OPEN'));
  await win.waitForFunction((p) => window.editor.doc.filePath === p, hostPath, { timeout: 30_000 });
  for (let i = 0; i < 5 && (await win.locator('.import-report-dialog').count()) > 0; i += 1) {
    await win.locator('.import-report-dialog .modal button', { hasText: 'Close' }).last().click();
    await win.waitForTimeout(200);
  }
  return listed;
}

/** Page-side raw bridge helpers: { ok, ... } or { ok:false, code }; text only for small reads. */
async function installBridge(win) {
  await win.evaluate(() => {
    const code = (e) => {
      const m = /ERR_XREF_[A-Z_]+/.exec(String(e));
      return m ? m[0] : String(e);
    };
    window.__xref = {
      async begin(docId) {
        try {
          const r = await window.jcad.beginXrefContext({ docId, contentGeneration: 1, hostAnchor: window.__xrefHost });
          return { ok: true, token: r.token };
        } catch (e) { return { ok: false, code: code(e) }; }
      },
      async identify(token, path) {
        try {
          const r = await window.jcad.identifyXref(token, path);
          return { ok: true, ticket: r.ticket, identity: r.identity };
        } catch (e) { return { ok: false, code: code(e) }; }
      },
      async read(token, ticket, maxBytes) {
        try {
          const r = await window.jcad.readXref(token, ticket, maxBytes);
          return { ok: true, byteLength: r.byteLength, rawBytes: r.rawBytes, rawSha256: r.rawSha256, version: r.version, text: r.rawBytes <= 65536 ? r.text : undefined };
        } catch (e) { return { ok: false, code: code(e) }; }
      },
      async close(token) {
        try { return { ok: true, value: await window.jcad.closeXrefContext(token) }; }
        catch (e) { return { ok: false, code: code(e) }; }
      },
    };
    window.__xrefHost = window.__xrefHostPath;
  });
}

async function closeBounded(app) {
  if (!app) return;
  const child = app.process();
  await Promise.race([app.close().catch(() => {}), new Promise((done) => setTimeout(done, 15_000))]);
  if (child && child.exitCode === null && child.signalCode === null) {
    for (const entry of children) if (entry.child === child) killChild(entry);
    await waitForExit(child, 5_000);
  }
}

// ------------------------------------------------------------ G1 in-page (real loader + adapter)
async function g1LoadInPage(win, docId) {
  return win.evaluate(async (cfg) => {
    const core = window.__xrefCore;
    const ed = window.editor;
    const snapJson = () => { try { return JSON.stringify(ed.doc.snapshot); } catch { return null; } };
    const docState = () => ({ json: snapJson(), dirty: ed.doc.dirty, revision: ed.doc.revision });
    const before = docState();
    const blocks = ed.doc.snapshot.blocks;
    const references = core.collectXrefReferences({ blocks });
    const bridge = {
      beginXrefContext: (info) => window.jcad.beginXrefContext(info),
      identifyXref: (t, p) => window.jcad.identifyXref(t, p),
      readXref: (t, k, m) => window.jcad.readXref(t, k, m),
      cancelXref: (t) => window.jcad.cancelXref(t),
      closeXrefContext: (t) => window.jcad.closeXrefContext(t),
    };
    const handle = core.createXrefReader(bridge, { docId: cfg.docId, contentGeneration: ed.doc.revision, hostPath: cfg.hostPath });
    const store = new core.XrefStore();
    const input = { hostState: { blocks }, hostPath: cfg.hostPath };
    const flatten = (nodes, acc = []) => {
      for (const n of nodes) {
        acc.push({ block: n.blockName, status: n.status, path: n.resolvedPath, overlay: n.overlay, depth: n.depth });
        flatten(n.children, acc);
      }
      return acc;
    };
    const sig = (snap) => core.externalContent(snap).map((e) => ({
      block: e.node.blockName, path: e.node.resolvedPath, version: e.file.version ?? null,
      byteLength: e.file.byteLength, entities: e.entities.map((x) => JSON.stringify(x)),
    }));
    try {
      const r = await store.load(input, { reader: handle.reader });
      window.__xrefG1 = { store, handle, input, sig };
      return {
        references, before, after: docState(),
        load: {
          committed: r.committed, preserved: r.preserved,
          failures: r.failures.map((f) => ({ kind: f.kind, block: f.blockName, message: f.message })),
          nodes: r.current ? flatten(r.current.nodes) : [],
          sig: r.current ? sig(r.current) : null,
          stats: r.current ? r.current.stats : null,
        },
      };
    } catch (e) {
      return { references, before, after: docState(), error: String(e && e.message || e) };
    }
  }, { docId, hostPath });
}

async function g1RefreshInPage(win) {
  return win.evaluate(async () => {
    const g = window.__xrefG1;
    if (!g) return { error: 'no G1 loader session in this page' };
    try {
      const r = await g.store.refresh(g.input, { reader: g.handle.reader });
      return {
        committed: r.committed,
        failures: r.failures.map((f) => ({ kind: f.kind, block: f.blockName, message: f.message })),
        sig: r.current ? g.sig(r.current) : null,
      };
    } catch (e) {
      return { error: String(e && e.message || e) };
    }
  });
}

async function g1DisposeInPage(win) {
  await win.evaluate(async () => {
    const g = window.__xrefG1;
    if (g) { try { await g.handle.dispose(); } catch { /* recorded by the run, not fatal here */ } window.__xrefG1 = null; }
  }).catch(() => {});
}

/** Compute the pinned edited bytes for a fixture from its current bytes. Throws on any mismatch. */
function pinnedEditedBytes(original, rel) {
  const desc = fixtureMeta.edits[rel];
  if (sha256(original) !== fixtureMeta.files[rel].sha256) throw new Error(`${rel} is not at its pinned bytes before the edit`);
  const text = original.toString('utf8');
  const at = text.indexOf(desc.locate);
  if (at < 0 || text.indexOf(desc.locate, at + 1) >= 0) throw new Error(`${rel}: pinned locate string not found exactly once`);
  const edited = Buffer.from(text.slice(0, at) + desc.replace + text.slice(at + desc.locate.length), 'utf8');
  if (sha256(edited) !== desc.editedSha256) throw new Error(`${rel}: edited bytes do not match the pinned edited hash`);
  return edited;
}

/** Apply a fixtures.json pinned edit to a fixture file; returns the original bytes. Throws on any mismatch. */
function applyPinnedEdit(rel) {
  const original = readFileSync(fx(rel));
  writeFileSync(fx(rel), pinnedEditedBytes(original, rel));
  return original;
}

/** Restore a fixture file in a finally; a failed restore is a failed check and halts the run (G4). */
function restoreFixture(rel, original) {
  writeFileSync(fx(rel), original);
  const restored = sha256(readFileSync(fx(rel))) === fixtureMeta.files[rel].sha256;
  check(restored, `${rel} restored to its pinned bytes (finally)`);
  if (!restored) { halted = true; haltReason = `${rel} could not be restored to its pinned bytes - fixture evidence preserved as failed`; }
  return restored;
}

const normPath = (p) => (typeof p === 'string' ? p.replace(/\\/g, '/') : p);
const sigEntry = (sig, suffix) => (sig ?? []).find((e) => normPath(e.path).endsWith(suffix));
const leafLine = (entry) => {
  for (const s of entry?.entities ?? []) {
    try { const e = JSON.parse(s); if (e && e.type === 'line') return e; } catch { /* not JSON */ }
  }
  return null;
};

// ------------------------------------------------------------ main flow
let app; let win; let pageErrors = [];
let g1 = null; // { sig } after a successful in-page load
const sourceIdentity = {
  xrefLoadingSha256: fileSha(join(repo, 'src/io/xref-loading.ts')),
  xrefReaderSha256: fileSha(join(repo, 'src/app/xref-reader.ts')),
  distIndexHtmlSha256: fileSha(join(repo, 'dist/index.html')),
  harnessScriptSha256: fileSha(join(repo, 'scripts/e2e-xref-refresh.mjs')),
  fixtureGeneratorSha256: fileSha(join(repo, 'scripts/xref-native-fixtures.mjs')),
};
try {
  if (!existsSync(join(repo, 'dist', 'index.html'))) throw new Error('dist/index.html not found: run `npm run build` first');
  try {
    await buildBundle();
  } catch (error) {
    bundleError = String(error && error.message || error);
  }
  ({ app, win, pageErrors } = await launchApp('main'));
  const versions = await app.evaluate(() => process.versions);
  const appInfo = await win.evaluate(() => window.jcad.appInfo());
  results.header = {
    electron: versions.electron, chromium: versions.chrome, node: versions.node,
    app: appInfo, platform: process.platform,
    suppliedHead: argOf('--head') || '(not supplied)', suppliedTree: argOf('--tree') || '(not supplied)',
    suppliedLabelsNote: '--head/--tree are caller-supplied labels; the computed source identity below is what this run actually used',
    sourceIdentity: { ...sourceIdentity, bundle: bundleInfo ?? { error: bundleError } },
    fixtureManifestSha256: manifestSha, fixtureDir, workRoot,
    observer: results.observer,
    evidenceClass: process.platform === 'win32' ? 'windows-stage1' : 'mechanics-only-non-win32',
  };
  log(`header: electron ${versions.electron} / chromium ${versions.chrome} / node ${versions.node}`);
  log(`header: app ${JSON.stringify(appInfo)} on ${process.platform}`);
  log(`header: supplied head ${results.header.suppliedHead} tree ${results.header.suppliedTree} (labels)`);
  log(`header: source identity: xref-loading ${sourceIdentity.xrefLoadingSha256.slice(0, 12)}.., xref-reader ${sourceIdentity.xrefReaderSha256.slice(0, 12)}.., bundle ${bundleInfo ? `${bundleInfo.sha256.slice(0, 12)}.. (${bundleInfo.bytes} B)` : `FAILED: ${bundleError}`}, dist/index.html ${sourceIdentity.distIndexHtmlSha256.slice(0, 12)}..`);
  log(`header: fixture manifest sha256 ${manifestSha}`);
  if (process.platform !== 'win32') log('header: WARNING - not win32: the bridge is win32-gated and the broker refuses non-Windows paths by design; this run validates harness mechanics only.');
  const listed = await openProjectAndHost(app, win);
  check(listed > 0, 'fixture project opened through the genuine Open Project flow (its drawings are registry-known)', `${listed} drawings listed`);
  await win.evaluate((p) => { window.__xrefHostPath = p; }, hostPath);
  await installBridge(win);
  await win.screenshot({ path: join(outDir, 'host-open.png') });
  check(true, 'host drawing opened through the app OPEN flow', hostPath);
  check(pageErrors.length === 0, 'no page errors during launch/open', pageErrors.join(' | '));
  const bridgeOk = await win.evaluate(() => ['beginXrefContext', 'identifyXref', 'readXref', 'cancelXref', 'closeXrefContext'].every((k) => typeof window.jcad[k] === 'function'));
  check(bridgeOk, 'window.jcad exposes the five xref bridge methods (Windows-only in the preload by design)');
  if (!bridgeOk) failHalt('xref bridge unavailable on this platform/build - this gate requires the Windows app');
  if (observerMode) {
    observerBaseline = await sampleObserver(app, 'baseline');
    results.observerBaseline = observerBaseline;
    const bs = observerBaseline?.stats;
    observerBaselineUsable = Boolean(observerBaseline && observerBaseline.captured && observerBaseline.factoryCalls === 1 && !observerBaseline.invalidated && bs
      && bs.contexts === 0 && bs.tickets === 0 && bs.activeOps === 0 && bs.retiredActiveOps === 0 && bs.reservedRawBytes === 0 && bs.disposed === false);
    log(`observer: baseline ${JSON.stringify(observerBaseline)} usable=${observerBaselineUsable}`);
    if (!observerBaselineUsable) log('observer: WARNING - baseline not a clean zero capture; stats-derived criteria will be BLOCKED for this run');
  }

  const begin = (docId) => win.evaluate((d) => window.__xref.begin(d), docId);
  const identify = (token, p) => win.evaluate(([t, q]) => window.__xref.identify(t, q), [token, p]);
  const read = (token, ticket, max) => win.evaluate(([t, k, m]) => window.__xref.read(t, k, m), [token, ticket, max]);
  const closeCtx = (token) => win.evaluate((t) => window.__xref.close(t), token);
  const sectionWanted = (s) => sections.includes(s);
  const sectionFailed = (mark) => checks.slice(mark).some((c) => c.status === 'fail');

  // -------------------------------------------------------------- 3.1
  if (sectionWanted('3.1')) {
    currentSection = '3.1';
    const mark = checks.length;
    if (halted) record('skipped', 'section 3.1 (raw CHANGED controls)', haltReason);
    else {
      const ctx = await begin('native-3.1');
      check(ctx.ok, 'begin context', JSON.stringify(ctx));
      const idn = await identify(ctx.token, fx('mutable.dxf'));
      check(idn.ok, 'identify mutable.dxf', JSON.stringify(idn));
      const first = await read(ctx.token, idn.ticket, MIB);
      check(first.ok, 'first read of mutable.dxf succeeds', JSON.stringify(first));
      // Content, not metadata: for these ASCII fixtures the decoded text
      // is byte-identical to the file, so its hash must equal the pin.
      check(first.ok && typeof first.text === 'string' && sha256(Buffer.from(first.text, 'utf8')) === fixtureMeta.files['mutable.dxf'].sha256 && first.rawSha256 === fixtureMeta.files['mutable.dxf'].sha256,
        'first read returns the pinned CONTENT (decoded-text hash and raw hash)', JSON.stringify({ rawSha256: first.rawSha256 }));
      const original = readFileSync(fx('mutable.dxf'));
      const desc = fixtureMeta.edits['mutable.dxf'];
      try {
        writeFileSync(fx('mutable.dxf'), Buffer.concat([original, Buffer.from(' ')]));
        check(sha256(readFileSync(fx('mutable.dxf'))) === desc.grownSha256, 'growth applied at exactly the pinned grown bytes (+1 B)');
        const grown = await read(ctx.token, idn.ticket, MIB);
        check(!grown.ok && grown.code === 'ERR_XREF_CHANGED', 'grown file (+1 B) refuses CHANGED, never LIMIT', JSON.stringify(grown));
        writeFileSync(fx('mutable.dxf'), pinnedEditedBytes(original, 'mutable.dxf'));
        const changed = await read(ctx.token, idn.ticket, MIB);
        check(!changed.ok && changed.code === 'ERR_XREF_CHANGED', 'same-size coordinate edit (group 21 value) refuses CHANGED', JSON.stringify(changed));
        const idn2 = await identify(ctx.token, fx('mutable.dxf'));
        const reread = idn2.ok ? await read(ctx.token, idn2.ticket, MIB) : { ok: false };
        check(reread.ok && typeof reread.text === 'string' && sha256(Buffer.from(reread.text, 'utf8')) === desc.editedSha256,
          'fresh identify+read returns the edited CONTENT (pinned edited hash)', JSON.stringify({ rawSha256: reread.rawSha256 }));
      } finally {
        restoreFixture('mutable.dxf', original);
      }
      await closeCtx(ctx.token);
      if (sectionFailed(mark)) { halted = true; haltReason = 'stopped at the first failed PASS criterion in section 3.1'; }
    }
  }

  // -------------------------------------------------------------- 3.2
  if (sectionWanted('3.2')) {
    currentSection = '3.2';
    const mark = checks.length;
    if (halted) record('skipped', 'section 3.2 (raw LIMIT controls)', haltReason);
    else {
      const ctx = await begin('native-3.2');
      const big = await identify(ctx.token, fx('oversized.dxf'));
      check(big.ok, 'identify oversized.dxf', JSON.stringify(big));
      const refused = await read(ctx.token, big.ticket, 16 * MIB);
      check(!refused.ok && refused.code === 'ERR_XREF_LIMIT', 'oversized (16 MiB + 1) refuses LIMIT live', JSON.stringify(refused));
      const leaf = await identify(ctx.token, fx(leafRel));
      const leafSize = fixtureMeta.files[leafRel].bytes;
      const under = await read(ctx.token, leaf.ticket, leafSize - 1);
      check(!under.ok && under.code === 'ERR_XREF_LIMIT', 'allowance one below identified size refuses LIMIT', JSON.stringify(under));
      const fine = await read(ctx.token, leaf.ticket, MIB);
      check(fine.ok && typeof fine.text === 'string' && sha256(Buffer.from(fine.text, 'utf8')) === fixtureMeta.files[leafRel].sha256,
        'a normal read still succeeds after the refusals and returns the pinned leaf content', JSON.stringify(fine.ok ? { byteLength: fine.byteLength } : fine));
      await closeCtx(ctx.token);
      await statsZeroCheck(app, 'broker stats return to baseline after the LIMIT refusals and the explicit context close (activeOps / reservedRawBytes zero; contexts / tickets back to baseline)');
      if (sectionFailed(mark)) { halted = true; haltReason = 'stopped at the first failed PASS criterion in section 3.2'; }
    }
  }

  // -------------------------------------------------------------- 3.3
  if (sectionWanted('3.3')) {
    currentSection = '3.3';
    const mark = checks.length;
    if (halted) record('skipped', 'section 3.3 (caps burst + real loader load)', haltReason);
    else {
      const ctxA = await begin('native-3.3-a');
      const slow = await identify(ctxA.token, fx('slow.dxf'));
      const leafA = await identify(ctxA.token, fx(leafRel));
      check(slow.ok && leafA.ok, 'context A identifies slow.dxf and leaf.dxf');
      let burstSettled = false;
      const burstPromise = win.evaluate(async ([tokA, slowTicket, leafTicketA, leafPath]) => {
        const x = window.__xref;
        const held = x.read(tokA, slowTicket, 16 * 1024 * 1024);
        const competing = x.read(tokA, leafTicketA, 1024 * 1024);
        const beginB = await x.begin('native-3.3-b');
        const idB = beginB.ok ? await x.identify(beginB.token, leafPath) : { ok: false };
        const readB = idB.ok ? await x.read(beginB.token, idB.ticket, 1024 * 1024) : { ok: false };
        const heldResult = await held;
        const competingResult = await competing;
        if (beginB.ok) await x.close(beginB.token);
        return { held: heldResult, competing: competingResult, readB };
      }, [ctxA.token, slow.ticket, leafA.ticket, fx(leafRel)]).then((r) => { burstSettled = true; return r; });
      // Main-side observer samples taken WHILE the burst is in flight:
      // the witness is the samples' content (same main clock/sequence as
      // the broker), never a sleep. Sampling cadence only paces evaluate.
      const windowSamples = [];
      while (!burstSettled && windowSamples.length < 60) {
        const s = await sampleObserver(app, 'burst-window');
        if (s) windowSamples.push(s);
        if (!burstSettled) await new Promise((r) => setTimeout(r, 10));
      }
      const burst = await burstPromise;
      check(burst.competing && !burst.competing.ok && burst.competing.code === 'ERR_XREF_RESOURCE_BUSY', 'second read in the same context refuses BUSY - the refusal itself witnesses an active operation (zero queue)', JSON.stringify(burst.competing));
      check(burst.readB && burst.readB.ok, 'a read in a second context proceeds meanwhile', JSON.stringify(burst.readB));
      check(burst.held && burst.held.ok && burst.held.rawBytes === fixtureMeta.files['slow.dxf'].bytes, 'the held read completes with the full file', JSON.stringify(burst.held));
      {
        const slowBytes = fixtureMeta.files['slow.dxf'].bytes;
        const witnessName = 'observer witnessed the held read genuinely active during the burst (activeOps >= 1 with reservedRawBytes = slow size + sentinel, main-clock samples)';
        if (!observerMode) blocked(witnessName);
        else if (!windowSamples.length || !observerUsable(windowSamples[windowSamples.length - 1])) blocked(witnessName, observerBlockReason(windowSamples[windowSamples.length - 1] ?? null));
        else {
          const witnessing = windowSamples.filter((s) => s.stats.activeOps >= 1 && s.stats.reservedRawBytes === slowBytes + 1);
          if (witnessing.length >= 1) check(true, witnessName, `${witnessing.length} witnessing sample(s), seq ${witnessing[0].seq}..${witnessing[witnessing.length - 1].seq}`);
          else blocked(witnessName, 'insufficient witness: no in-window sample caught the held read active (never passed by default)');
        }
      }
      await closeCtx(ctxA.token);
      await statsZeroCheck(app, 'broker stats return to baseline after the burst drains and context A closes (activeOps / reservedRawBytes zero; contexts / tickets back to baseline)');
      // G1: the REAL loader + adapter, in the renderer, over this bridge.
      if (!bundleText) {
        blocked('real loader+adapter load (G1): the esbuild bundle of the accepted sources failed to build', bundleError ?? 'unknown bundle error');
      } else {
        await win.evaluate(bundleText);
        const injected = await win.evaluate(() => ['XrefStore', 'createXrefReader', 'collectXrefReferences', 'externalContent'].every((k) => typeof window.__xrefCore?.[k] === 'function'));
        check(injected, 'accepted loader/adapter bundle injected into the renderer (window.__xrefCore)');
        const out = await g1LoadInPage(win, 'native-g1');
        if (out.error) failHalt('real loader load threw in the renderer', out.error);
        else {
          const expectedRefs = [
            { blockName: 'CHILD', path: '../parts/child.dxf' },
            { blockName: 'LEAFWIN', path: '..\\shared\\leaf.dxf' },
            { blockName: 'OVLROOT', path: 'overlay-root.dxf', overlay: true },
          ];
          check(JSON.stringify(out.references) === JSON.stringify(expectedRefs), 'host references extracted from the LIVE opened drawing match the authored graph', JSON.stringify(out.references));
          check(out.load.committed && out.load.failures.length === 0, 'real XrefStore load commits with no failures', JSON.stringify(out.load.failures));
          const loadedPaths = (out.load.sig ?? []).map((e) => normPath(e.path));
          const wantLoaded = ['parts/child.dxf', 'shared/leaf.dxf', 'drawings/overlay-root.dxf', 'parts/grand.dxf', 'drawings/kid.dxf'];
          check(wantLoaded.every((w) => loadedPaths.some((p) => p.endsWith(w))), 'external content includes the nested graph (child, grand, leaf, overlay-root, kid)', loadedPaths.join(' | '));
          check(!loadedPaths.some((p) => p.endsWith('inner.dxf')), 'inner.dxf is NOT loaded (not referenced by this graph; nested-overlay witness stays unloaded)', loadedPaths.join(' | '));
          check((out.load.nodes ?? []).every((n) => n.status === 'loaded'), 'every graph node reports status loaded', JSON.stringify(out.load.nodes));
          check(out.before.json !== null && out.after.json === out.before.json && out.after.dirty === out.before.dirty && out.after.revision === out.before.revision,
            'the load changed no app document state (snapshot bytes, dirty flag, revision identical)');
          check(sha256(readFileSync(hostPath)) === hostHashBefore, 'host file on disk unchanged by the load');
          if (out.load.committed) g1 = { sig: out.load.sig };
        }
      }
      if (sectionFailed(mark)) { halted = true; haltReason = 'stopped at the first failed PASS criterion in section 3.3'; }
    }
  }

  // -------------------------------------------------------------- 3.4
  if (sectionWanted('3.4')) {
    currentSection = '3.4';
    const mark = checks.length;
    if (halted) record('skipped', 'section 3.4 (refresh changed / no-op)', haltReason);
    else {
      const ctx = await begin('native-3.4');
      const leaf = await identify(ctx.token, fx(leafRel));
      const r1 = await read(ctx.token, leaf.ticket, MIB);
      const r2 = await read(ctx.token, leaf.ticket, MIB);
      check(r1.ok && r2.ok && r1.version === r2.version && typeof r1.text === 'string' && sha256(Buffer.from(r1.text, 'utf8')) === fixtureMeta.files[leafRel].sha256 && r1.text === r2.text,
        'unchanged xref reads back identically twice (same version, pinned content hash)', JSON.stringify({ v: r1.version }));
      await closeCtx(ctx.token);
      if (!g1) {
        blocked('real loader refresh after a valid edit (G1): no committed loader load exists in this run (section 3.3 did not produce one)');
      } else {
        const leafBefore = sigEntry(g1.sig, 'shared/leaf.dxf');
        const lineBefore = leafLine(leafBefore);
        check(Boolean(lineBefore) && lineBefore.b?.y === 0, 'leaf LINE endpoint starts at the authored value (b.y = 0)', JSON.stringify(lineBefore));
        let original = null;
        try {
          original = applyPinnedEdit(leafRel);
          const refreshed = await g1RefreshInPage(win);
          if (refreshed.error) failHalt('real loader refresh threw in the renderer', refreshed.error);
          else {
            check(refreshed.committed && refreshed.failures.length === 0, 'refresh after the pinned leaf edit commits with no failures', JSON.stringify(refreshed.failures));
            const leafAfter = sigEntry(refreshed.sig, 'shared/leaf.dxf');
            const lineAfter = leafLine(leafAfter);
            check(Boolean(lineAfter) && lineAfter.b?.y === 9 && lineAfter.b?.x === 10, 'the leaf node refreshed to the NEW content (LINE endpoint b.y = 9, the pinned edit)', JSON.stringify(lineAfter));
            check(Boolean(leafBefore) && Boolean(leafAfter) && leafAfter.version !== leafBefore.version, 'the leaf file version evidence changed on refresh', `${leafBefore?.version} -> ${leafAfter?.version}`);
            const others = (names) => (names ?? []).filter((e) => !normPath(e.path).endsWith('shared/leaf.dxf')).map((e) => JSON.stringify(e.entities)).join('~');
            check(others(refreshed.sig) === others(g1.sig), 'no other node changed on the leaf refresh');
            const again = await g1RefreshInPage(win);
            check(!again.error && again.committed && JSON.stringify(again.sig) === JSON.stringify(refreshed.sig),
              'a second refresh of the unchanged graph is a no-op (identical external content)');
            if (!again.error && again.sig) g1 = { sig: again.sig };
          }
        } finally {
          if (original) restoreFixture(leafRel, original);
        }
        await g1DisposeInPage(win);
      }
      if (sectionFailed(mark)) { halted = true; haltReason = 'stopped at the first failed PASS criterion in section 3.4'; }
    }
  }

  // -------------------------------------------------------------- 3.5
  if (sectionWanted('3.5')) {
    currentSection = '3.5';
    if (halted) record('skipped', 'section 3.5 (lifecycle)', haltReason);
    else {
      const ctx = await begin('native-3.5');
      const leaf = await identify(ctx.token, fx(leafRel));
      check(leaf.ok, 'context for the lifecycle checks');
      // 3.5a: close the host tab, then try the old ticket (criterion as approved, unmodified).
      await win.evaluate((p) => {
        const s = window.editor.sessions;
        const i = s.indexOfPath(p);
        if (i >= 0) s.close(i);
      }, hostPath);
      await win.waitForTimeout(300);
      const afterTab = await read(ctx.token, leaf.ticket, MIB);
      check(ctx.ok && leaf.ok && !afterTab.ok, 'read on a context whose host tab closed refuses', JSON.stringify(afterTab));
      // 3.5a2: ADDITIONAL observation (not a substitute for 3.5a):
      // navigation retires the owner - the trigger the shipped wiring implements.
      await win.reload();
      await win.waitForFunction(() => !!window.editor, null, { timeout: 30_000 });
      await win.evaluate((p) => { window.__xrefHostPath = p; }, hostPath);
      await installBridge(win);
      const afterNav = await win.evaluate(([t, k, m]) => window.__xref.read(t, k, m), [ctx.token, leaf.ticket, MIB]);
      check(ctx.ok && leaf.ok && !afterNav.ok && afterNav.code === 'ERR_XREF_CONTEXT', 'additional observation: read after page navigation refuses CONTEXT (owner retired)', JSON.stringify(afterNav));
    }
  }
} catch (error) {
  if (!halted) failHalt(`harness error in section ${currentSection}`, String(error && error.message || error));
  else record('fail', `harness error in section ${currentSection}`, String(error && error.message || error));
} finally {
  try { await g1DisposeInPage(win); } catch { /* page may be gone */ }
  try { await closeBounded(app); } catch { /* bounded already */ }
}

// ------------------------------------------------------------ quit scenarios (Amendment 1)
// Lifecycle records: they run on fresh launches even when a behaviour
// section halted, provided the app itself launched. Clean exit is exit
// evidence only - NOT a completed-drain proof.
if (sections.includes('3.5')) {
  currentSection = '3.5-quit';
  for (const scenario of ['idle', 'after-limit']) {
    let qapp; let qwin;
    try {
      ({ app: qapp, win: qwin } = await launchApp(`quit-${scenario}`));
      await openProjectAndHost(qapp, qwin);
      await qwin.evaluate((p) => { window.__xrefHostPath = p; }, hostPath);
      await installBridge(qwin);
      const ctx = await qwin.evaluate(async () => {
        const b = await window.__xref.begin('native-quit');
        if (b.ok) window.__xrefToken = b.token;
        return b;
      });
      if (!ctx.ok) throw new Error(`begin failed: ${JSON.stringify(ctx)}`);
      if (scenario === 'after-limit') {
        const res = await qwin.evaluate(async (p) => {
          const idn = await window.__xref.identify(window.__xrefToken, p);
          if (!idn.ok) return idn;
          return window.__xref.read(window.__xrefToken, idn.ticket, 16 * 1024 * 1024);
        }, fx('oversized.dxf'));
        if (!(!res.ok && res.code === 'ERR_XREF_LIMIT')) throw new Error(`expected a LIMIT refusal before quitting, got ${JSON.stringify(res)}`);
      }
      const child = qapp.process();
      await qapp.evaluate(({ app: a }) => a.quit());
      const code = await waitForExit(child, 30_000);
      check(code === 0, `app quits cleanly from the ${scenario} state (process exit evidence only, not a drain proof)`, `exit code ${code}`);
    } catch (error) {
      check(false, `quit scenario ${scenario}`, String(error && error.message || error));
      try { await closeBounded(qapp); } catch { /* bounded already */ }
    }
  }
  // Inflight quit (Amendment 1): the witness is a main-side observer
  // sample taken in the SAME main callback that invokes the genuine
  // app.quit() - no intervening await, never a sleep. Without a valid
  // witness the criterion is BLOCKED (insufficient witness), not passed.
  const inflightName = 'app quits cleanly from the inflight state with a proven active read (sample+quit in one main callback; exit is exit evidence, not drain proof)';
  if (!observerMode) {
    blocked(inflightName);
  } else {
    let qapp; let qwin;
    try {
      ({ app: qapp, win: qwin } = await launchApp('quit-inflight'));
      await openProjectAndHost(qapp, qwin);
      await qwin.evaluate((p) => { window.__xrefHostPath = p; }, hostPath);
      await installBridge(qwin);
      const started = await qwin.evaluate(async (p) => {
        const b = await window.__xref.begin('native-quit-inflight');
        if (!b.ok) return b;
        window.__xrefToken = b.token;
        const idn = await window.__xref.identify(b.token, p);
        if (!idn.ok) return idn;
        window.__xrefHeldRead = window.__xref.read(b.token, idn.ticket, 16 * 1024 * 1024);
        return { ok: true };
      }, fx('slow.dxf'));
      if (!started.ok) throw new Error(`inflight setup failed: ${JSON.stringify(started)}`);
      const child = qapp.process();
      const sample = await qapp.evaluate(({ app: a }) => {
        const f = globalThis.__xrefTestObserver;
        const s = f ? f.sample() : null;
        a.quit();
        return s;
      });
      results.observerSamples.push({ tag: 'quit-inflight', sample });
      const code = await waitForExit(child, 30_000);
      const slowBytes = fixtureMeta.files['slow.dxf'].bytes;
      const witnessed = Boolean(sample && sample.captured && sample.factoryCalls === 1 && !sample.invalidated && sample.stats
        && sample.stats.activeOps >= 1 && sample.stats.reservedRawBytes === slowBytes + 1);
      if (!witnessed) blocked(inflightName, `insufficient witness at quit initiation: ${JSON.stringify(sample)}`);
      else check(code === 0, inflightName, `exit code ${code}, sample=${JSON.stringify(sample.stats)} seq=${sample.seq}`);
    } catch (error) {
      check(false, 'quit scenario inflight', String(error && error.message || error));
      try { await closeBounded(qapp); } catch { /* bounded already */ }
    }
  }
}

clearTimeout(watchdog);
const failed = checks.filter((c) => c.status === 'fail');
const blockedCount = checks.filter((c) => c.status === 'blocked').length;
const passed = checks.filter((c) => c.status === 'pass').length;
log(`\nxref-refresh: ${passed} passed, ${failed.length} failed, ${blockedCount} blocked, ${checks.filter((c) => c.status === 'skipped').length} skipped (${checks.length} records)${failed.length ? ` - FAILURES: ${failed.map((f) => `[${f.section}] ${f.name}`).join('; ')}` : ''}`);
writeResults();
process.exit(failed.length || blockedCount ? 1 : 0);
