// Fixed diagnostics for the exact shipping executable. No supplied JavaScript, remote
// debugging transport or renderer IPC endpoint; only two enumerated startup phases.
const { app, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runShippingDwgProbe } = require('./shipping-dwg-probe.cjs');

function shippingProbePhase(args) {
  const flags = args.filter((arg) => typeof arg === 'string' && arg.startsWith('--probe-startup='));
  if (!flags.length) return null;
  if (flags.length !== 1 || !/^--probe-startup=(first|second|dwg)$/.test(flags[0])) throw new Error('Invalid startup probe phase');
  return flags[0].slice('--probe-startup='.length);
}

/** @param {import('./context.cjs').MainContext} ctx */
async function runShippingProbe(ctx, phase, testBuild) {
  if (!['first', 'second', 'dwg'].includes(phase)) throw new Error('Invalid startup probe phase');
  const timer = setTimeout(() => { process.stdout.write('SHIPPING_PROBE_FAIL timed out\n'); app.exit(1); }, 45_000);
  try {
    if (phase === 'dwg') {
      const record = await runShippingDwgProbe(ctx, testBuild);
      process.stdout.write(`SHIPPING_PROBE_OK ${JSON.stringify(record)}\n`);
      clearTimeout(timer);
      app.quit();
      return;
    }
    const win = ctx.mainWindow;
    if (!win || win.isDestroyed()) throw new Error('No renderer window');
    // These probes may modify only their fresh temporary-profile fixture, never a user's
    // ordinary drawing/profile. Paths still need the normal OS hand-over/IPC grant.
    const profile = fs.realpathSync.native(app.getPath('userData'));
    if (path.dirname(profile) !== fs.realpathSync.native(os.tmpdir()) || !/^jcad-shipping-smoke-[A-Za-z0-9-]+$/.test(path.basename(profile))) throw new Error('Startup probe requires its temporary smoke profile');
    const fixture = fs.realpathSync.native(path.join(profile, 'shipping-startup.dxf'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const phase = ${JSON.stringify(phase)};
      const fixture = ${JSON.stringify(fixture)};
      const until = Date.now() + 30000;
      while (!window.editor || !window.jcad || !window.editor.doc.filePath || window.editor.doc.entities.length === 0 || localStorage.getItem('jcad-origin-migrated') !== '1') {
        if (Date.now() >= until) throw new Error('Renderer or handed-over DXF did not become ready');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const ed = window.editor;
      if (!/\\.dxf$/i.test(ed.doc.filePath)) throw new Error('Startup probe requires a handed-over DXF');
      if (ed.doc.filePath.replace(/\\\\/g, '/') !== fixture.replace(/\\\\/g, '/')) throw new Error('Startup probe may save only its own temporary DXF');
      const info = await window.jcad.appInfo();
      const preference = localStorage.getItem('jcad-origin-test');
      const expected = phase === 'first' ? 'legacy preference Δ 雷' : 'new preference';
      if (preference !== expected) throw new Error('Preference migration or restart persistence failed');
      const before = ed.doc.entities.length;
      let saved = false;
      if (phase === 'first') {
        ed.doc.addEntities([{ id:'shipping-smoke-line', type:'line', layer:'0', color:'ByLayer', a:{x:0,y:0}, b:{x:3,y:4} }]);
        saved = await ed.saveFile(false);
        if (!saved || ed.doc.dirty) throw new Error('Real drawing save did not finish cleanly');
        localStorage.setItem('jcad-origin-test', 'new preference');
      } else {
        if (!ed.doc.entities.some(entity => entity.id === 'shipping-smoke-line' || (entity.type === 'line' && entity.a.x === 0 && entity.a.y === 0 && entity.b.x === 3 && entity.b.y === 4))) throw new Error('Saved drawing did not reopen');
      }
      if (!isSecureContext || !crypto.subtle || location.href !== 'jcad://app/index.html' || localStorage.getItem('jcad-origin-migrated') !== '1') throw new Error('Secure origin, crypto or migration marker failed');
      return { version:info.version, packaged:info.packaged, url:location.href, secure:true, bridge:true, preference, migrated:'1', before, entities:ed.doc.entities.length, saved, dirty:ed.doc.dirty };
    })()`);
    const storagePath = session.defaultSession.storagePath;
    const record = { ...result, phase, testBuild, persistent:session.defaultSession.isPersistent(), privateSessionData:fs.realpathSync.native(app.getPath('sessionData')) === profile, privateStorage:typeof storagePath === 'string' && fs.realpathSync.native(storagePath) === profile, migrationMarker:fs.existsSync(path.join(profile, 'renderer-origin-migrated')) };
    if (!record.persistent || !record.privateSessionData || !record.privateStorage || !record.migrationMarker) throw new Error('Private persistent storage or completed migration marker missing');
    process.stdout.write(`SHIPPING_PROBE_OK ${JSON.stringify(record)}\n`);
    clearTimeout(timer);
    // Normal quit exercises the renderer close workflow and storage flush. The harness
    // also requires a clean process exit before it launches the same profile again.
    app.quit();
  } catch (error) {
    clearTimeout(timer);
    process.stdout.write(`SHIPPING_PROBE_FAIL ${error && error.message}\n`);
    app.exit(1);
  }
}
module.exports = { runShippingProbe, shippingProbePhase };
