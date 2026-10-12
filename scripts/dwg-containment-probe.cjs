/** Unpackaged integration probe: real utility processes, real OS metrics, bounded allocations. */
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createDwgHost, OpenCancelledError } = require('../electron/dwg-host.cjs');
const { createProcessMemoryGuard, DwgMemoryLimitError } = require('../electron/dwg-process-limits.cjs');
const { PROTOCOL_VERSION, WORKER_RESOURCE_LIMITS, validateResourceLimits } = require('../electron/dwg-protocol.cjs');
const utilityPort = /** @type {any} */ (process).parentPort;

if (utilityPort) runProbeUtility();
else void runMain();

/** Synthetic parsing only for the native-allocation failure case; transport still uses Electron. */
function runProbeUtility() {
  utilityPort.on('close', () => process.exit(0));
  const mode = process.argv.find((arg) => arg.startsWith('--containment-mode='))?.split('=')[1];
  if (mode === 'native-host') {
    let requestId = 0;
    let offset = 0;
    utilityPort.on('message', (event) => {
      const message = event.data;
      if (message.type === 'input-start') {
        requestId = message.id;
        utilityPort.postMessage({ type: 'input-ack', id: requestId, offset: 0 });
      } else if (message.type === 'input-chunk') {
        offset += message.bytes.byteLength;
        utilityPort.postMessage({ type: 'input-ack', id: requestId, offset });
      } else if (message.type === 'input-end') {
        const buffers = [];
        for (let i = 0; i < 8; i++) buffers.push(Buffer.alloc(8 * 1024 * 1024, 1));
        const until = Date.now() + 5_000;
        while (Date.now() < until) {
          if (buffers[0][0] !== 1) throw new Error('Probe native allocation was lost');
        }
        utilityPort.postMessage({ type: 'error', id: requestId, message: 'Native allocation watchdog did not stop the blocked reader.' });
      }
    });
    utilityPort.postMessage({ type: 'ready', protocol: PROTOCOL_VERSION, pid: process.pid });
  } else if (mode === 'heap') {
    const limits = validateResourceLimits({ maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 1, stackSizeMb: WORKER_RESOURCE_LIMITS.stackSizeMb });
    const worker = new Worker(`
      const { parentPort } = require('node:worker_threads');
      const kept = [];
      for (let i = 0; i < 64; i++) kept.push(new Array(256 * 1024).fill(i));
      parentPort.postMessage({ survived: true, count: kept.length });
    `, { eval: true, resourceLimits: limits, execArgv: [] });
    worker.once('message', () => utilityPort.postMessage({ type: 'heap-survived' }));
    worker.once('error', (error) => utilityPort.postMessage({ type: 'heap-failure', code: /** @type {any} */ (error).code, limits, utilityAlive: true }));
  } else {
    utilityPort.postMessage({ type: 'unsupported-probe-mode' });
    process.exit(1);
  }
}

async function runMain() {
  const { app, utilityProcess } = require('electron');
  const temporaryArg = process.argv.find((arg) => arg.startsWith('--containment-dir='));
  const nonceArg = process.argv.find((arg) => arg.startsWith('--containment-nonce='));
  assert.ok(temporaryArg && nonceArg, 'Containment launcher arguments are required.');
  const temporary = temporaryArg.slice('--containment-dir='.length);
  const nonce = nonceArg.slice('--containment-nonce='.length);
  assert.ok(path.isAbsolute(temporary), 'Containment paths must be absolute.');
  const config = JSON.parse(readFileSync(path.join(temporary, 'config.json'), 'utf8'));
  assert.equal(config.nonce, nonce);
  // Isolate both Electron's userData path and Chromium's command-line profile before readiness.
  // Utility children run their Node transport directly and do not initialize a separate app profile.
  app.setPath('userData', path.join(temporary, 'profile'));
  const bytes = new Uint8Array(readFileSync(path.join(temporary, 'fixture.dwg')));
  assert.equal(bytes.byteLength, config.fixtureBytes);
  assert.ok(bytes.byteLength > 0 && bytes.byteLength <= 128 * 1024 * 1024);
  const cases = [];
  const children = new Set();
  const hosts = [];
  const processIds = [];
  let maxLiveChildren = 0;
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 20);
  const startedAt = Date.now();
  let complete = false;
  const deadline = setTimeout(() => finish(false, new Error('Electron containment probe timed out.')), 100_000);

  function finish(ok, error) {
    if (complete) return;
    complete = true;
    clearInterval(heartbeat);
    clearTimeout(deadline);
    for (const host of hosts) host.dispose();
    for (const child of children) { try { child.kill(); } catch { /* launcher deadline owns final cleanup */ } }
    const report = { schemaVersion: 1, nonce, ok, platform: process.platform, arch: process.arch, electronVersion: process.versions.electron, userDataPath: app.getPath('userData'),
      mainPid: process.pid, processIds, maxLiveChildren, heartbeatTicks: ticks, elapsedMs: Date.now() - startedAt, cases,
      ...(error ? { error: String(error.message ?? error).slice(0, 2_048) } : {}) };
    writeFileSync(path.join(temporary, 'result.json'), JSON.stringify(report));
    app.exit(ok ? 0 : 1);
  }

  function track(child) {
    children.add(child);
    maxLiveChildren = Math.max(maxLiveChildren, children.size);
    child.once('spawn', () => {
      if (!Number.isSafeInteger(child.pid) || child.pid === process.pid) return finish(false, new Error('Parser did not use a separate OS process.'));
      processIds.push(child.pid);
    });
    child.once('exit', () => children.delete(child));
    return child;
  }
  function launch(modulePath, options, args = []) {
    return track(utilityProcess.fork(modulePath, args, { ...options, serviceName: 'JCad DWG Containment Check', stdio: 'ignore', allowLoadingUnsignedLibraries: false }));
  }
  function makeHost(options = {}) {
    const host = createDwgHost({ scriptsDir: __dirname, launchProcess: launch, ...options });
    hosts.push(host);
    return host;
  }
  async function waitUntil(predicate, milliseconds = 5_000) {
    const stopAt = Date.now() + milliseconds;
    while (!predicate()) {
      assert.ok(Date.now() < stopAt, 'Containment condition did not arrive before its deadline.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  function validRead(result) {
    assert.ok(result.payload.entities.length > 10, 'Real DWG fixture did not return drawing entities.');
    assert.match(result.version, /2000/);
  }
  async function realRead(host) {
    const before = ticks;
    const result = await host.read(bytes);
    validRead(result);
    await waitUntil(() => children.size === 0);
    assert.ok(ticks > before, 'Main-process heartbeat stopped while the drawing was read.');
    return result;
  }

  try {
    await app.whenReady();
    const host = makeHost();
    await realRead(host);
    cases.push({ name: 'real-dwg-isolated-read', ok: true, processCount: processIds.length, heartbeatTicks: ticks });

    const cancelId = host.newId();
    const cancelled = host.read(bytes, cancelId);
    assert.equal(host.cancel(cancelId), true, 'Startup cancellation did not find the read.');
    await assert.rejects(cancelled, OpenCancelledError);
    await waitUntil(() => children.size === 0);
    await realRead(host);
    cases.push({ name: 'startup-cancel-and-recovery', ok: true });

    const badResult = await host.read(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])).then(
      (result) => { assert.equal(result.version, 'invalid'); assert.equal(result.payload.entities.length, 0); return 'invalid'; },
      (error) => { assert.ok(error instanceof Error && error.message.length > 0); return 'rejected'; },
    );
    await waitUntil(() => children.size === 0);
    await realRead(host);
    cases.push({ name: 'damaged-dwg-and-recovery', ok: true, outcome: badResult });

    let pressureLaunch = true;
    let pressureMonitoring = true;
    /** @type {any} */
    let observedMemoryError;
    const pressureBefore = ticks;
    const pressureHost = makeHost({
      launchProcess: (modulePath, options) => {
        if (!pressureLaunch) return launch(modulePath, options);
        pressureLaunch = false;
        return launch(__filename, options, ['--containment-mode=native-host']);
      },
      memoryGuardFactory: ({ pid, onFailure }) => {
        if (!pressureMonitoring) return createProcessMemoryGuard({ pid, getMetrics: () => app.getAppMetrics(), onFailure });
        pressureMonitoring = false;
        const initial = createProcessMemoryGuard({ pid, getMetrics: () => app.getAppMetrics(), onFailure });
        let pressureGuard;
        const ready = initial.ready.then((sample) => {
          initial.stop();
          pressureGuard = createProcessMemoryGuard({ pid, getMetrics: () => app.getAppMetrics(), maxBytes: sample.bytes + 16 * 1024 * 1024,
            onFailure: (error) => { observedMemoryError = error; onFailure(error); } });
          return pressureGuard.ready;
        });
        return { ready, stop() { initial.stop(); pressureGuard?.stop(); }, checkNow() { return pressureGuard ? pressureGuard.checkNow() : initial.checkNow(); } };
      },
    });
    await assert.rejects(pressureHost.read(bytes), DwgMemoryLimitError);
    await waitUntil(() => children.size === 0);
    assert.ok(ticks > pressureBefore, 'Main heartbeat stopped during blocked native allocation.');
    await realRead(pressureHost);
    assert.ok(observedMemoryError instanceof DwgMemoryLimitError, 'OS memory guard did not report its threshold failure.');
    cases.push({ name: 'native-pressure-while-blocked-and-recovery', ok: true, observedBytes: observedMemoryError.observedBytes,
      thresholdBytes: observedMemoryError.limitBytes, heartbeatTicks: ticks - pressureBefore });

    const heapChild = launch(__filename, {}, ['--containment-mode=heap']);
    const heapResult = await new Promise((resolve, reject) => {
      heapChild.once('error', () => reject(new Error('Utility process failed during inner-worker heap probe.')));
      heapChild.once('exit', () => reject(new Error('Utility process exited before reporting its inner-worker heap failure.')));
      heapChild.once('message', resolve);
    });
    assert.equal(heapResult.type, 'heap-failure', 'Worker heap limits did not stop bounded probe allocation.');
    assert.equal(heapResult.code, 'ERR_WORKER_OUT_OF_MEMORY');
    assert.equal(heapResult.limits.maxOldGenerationSizeMb, 16);
    assert.equal(heapResult.limits.maxYoungGenerationSizeMb, 1);
    assert.equal(heapResult.limits.stackSizeMb, 8);
    assert.equal(heapResult.utilityAlive, true);
    const heapMetric = app.getAppMetrics().find((metric) => metric.pid === heapChild.pid);
    assert.ok(heapMetric && heapMetric.type === 'Utility', 'Utility was not alive after inner-worker heap failure.');
    heapChild.kill();
    await waitUntil(() => children.size === 0);
    await realRead(host);
    cases.push({ name: 'inner-worker-v8-limit-and-recovery', ok: true, errorCode: heapResult.code, limits: heapResult.limits });
    assert.equal(maxLiveChildren, 1, 'Containment probe accumulated parser processes.');
    finish(true);
  } catch (error) { finish(false, error); }
}
