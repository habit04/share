/** Fixed portable-DWG production probe. It may touch only the dedicated temporary smoke profile. */
const { app, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { verifyPortableWriter } = require('../portable-dwg.cjs');

/** @param {import('./context.cjs').MainContext} ctx */
async function runShippingDwgProbe(ctx, testBuild) {
  if (process.platform !== 'win32') throw new Error('The portable DWG shipping probe requires Windows.');
  const win = ctx.mainWindow;
  if (!win || win.isDestroyed()) throw new Error('No renderer window');
  const profile = fs.realpathSync.native(app.getPath('userData'));
  if (path.dirname(profile) !== fs.realpathSync.native(os.tmpdir()) || !/^jcad-shipping-smoke-[A-Za-z0-9-]+$/.test(path.basename(profile))) throw new Error('DWG probe requires its temporary smoke profile');
  const fixturePath = path.join(profile, 'shipping-startup.dxf');
  const fixture = fs.realpathSync.native(fixturePath);
  if (!fs.lstatSync(fixturePath).isFile() || fs.lstatSync(fixturePath).isSymbolicLink() || path.dirname(fixture) !== profile) throw new Error('DWG probe fixture must be a regular file inside its temporary profile.');
  const target = path.join(profile, 'shipping-export.dwg');
  const original = Buffer.from('previous fixed DWG probe destination'); fs.writeFileSync(target, original, { flag: 'wx' });
  const saveTarget = path.join(profile, 'shipping-normal-save.dwg');
  fs.writeFileSync(saveTarget, 'previous fixed DWG Save As destination', { flag: 'wx' });
  const dxfTarget = path.join(profile, 'shipping-rotated-layout.dxf');
  fs.writeFileSync(dxfTarget, 'previous fixed rotated-layout DXF destination', { flag: 'wx' });
  const rotatedLayout = {
    name: 'DWG_ROTATION_PROBE', paper: { id: 'tabloid', width: 11, height: 17, units: 'in', orientation: 'landscape' },
    margins: { left: 0.25, bottom: 0.25, right: 0.25, top: 0.25 }, plotScale: '1:1', plotStyle: 'monochrome', entities: [],
    viewports: [
      { id: 'probe-vp90', center: { x: 4.5, y: 5.5 }, width: 7, height: 6, layer: '0', on: true, view: { center: { x: 10, y: 20 }, scale: 0.25, twist: Math.PI / 2 } },
      { id: 'probe-vp30', center: { x: 12.5, y: 5.5 }, width: 7, height: 6, layer: '0', on: true, view: { center: { x: -7, y: 13 }, scale: 0.125, twist: Math.PI / 6 } },
    ],
  };
  // Fixed renderer-side checks are shared by both diagnostic phases; no supplied JavaScript.
  const rotationChecks = `
    function assertRotatedViewports(ed, phase) {
      const layout=(ed.doc.snapshot.layouts||[]).find(l=>l.name==='DWG_ROTATION_PROBE');
      if (!layout || layout.viewports.length!==2) throw new Error(phase+': rotated layout viewports are missing');
      const expected=${JSON.stringify(rotatedLayout.viewports)};
      for (const wanted of expected) {
        const actual=layout.viewports.find(v=>Math.abs(v.center.x-wanted.center.x)<1e-6);
        if (!actual || !actual.on || ![actual.center.x,actual.center.y,actual.view.center.x,actual.view.center.y,actual.width,actual.height,actual.view.scale,actual.view.twist].every(Number.isFinite) || ['x','y'].some(k=>Math.abs(actual.center[k]-wanted.center[k])>1e-6 || Math.abs(actual.view.center[k]-wanted.view.center[k])>1e-6) || Math.abs(actual.width-wanted.width)>1e-6 || Math.abs(actual.height-wanted.height)>1e-6 || Math.abs(actual.view.scale-wanted.view.scale)>1e-8 || Math.abs(actual.view.twist-wanted.view.twist)>1e-8) throw new Error(phase+': viewport twist, WCS center, frame or scale changed');
      }
      const lines=ed.doc.snapshot.entities.filter(e=>e.type==='line');
      for (const p of [[10,10,20,20],[0,0,3,4]]) if (!lines.some(e=>e.a.x===p[0] && e.a.y===p[1] && e.b.x===p[2] && e.b.y===p[3])) throw new Error(phase+': viewport rotation changed original model coordinates');
      return layout;
    }
    function assertRotatedCanvas(ed, phase) {
      const layout=assertRotatedViewports(ed,phase), v=layout.viewports.find(v=>Math.abs(v.view.twist-Math.PI/2)<1e-8);
      const model=ed.doc.snapshot.entities;
      ed.doc.setSpace({layout:layout.name});
      ed.doc.setSpace({layout:layout.name,viewport:v.id});
      try {
        const p=v.view.center, q={x:p.x+1,y:p.y}, a=ed.viewport.toScreen(p), b=ed.viewport.toScreen(q), k=ed.viewport.scale;
        const inverse=ed.viewport.toWorld({x:a.x,y:a.y-k});
        if (!(k>0) || ![a.x,a.y,b.x,b.y,inverse.x,inverse.y,k,ed.viewport.twist].every(Number.isFinite) || Math.abs(ed.viewport.twist-Math.PI/2)>1e-8 || Math.abs(b.x-a.x)>1e-6 || Math.abs(b.y-a.y+k)>1e-6 || Math.abs(inverse.x-q.x)>1e-6 || Math.abs(inverse.y-q.y)>1e-6 || ed.doc.snapshot.entities!==model) throw new Error(phase+': positive90 viewport canvas mapping or inverse changed');
      } finally { ed.doc.setSpace(undefined); }
      assertRotatedViewports(ed,phase);
    }
  `;
  const previousDialog = dialog.showSaveDialog;
  let exportPicks = 0, savePicks = 0, dxfPicks = 0;
  // This fixed diagnostic answers only its own copy / drawing pickers, never a path argument.
  /** @param {Electron.BaseWindow | Electron.SaveDialogOptions} _window @param {Electron.SaveDialogOptions} [options] */
  const fixedDialog = async (_window, options) => {
    const picked = /** @type {Electron.SaveDialogOptions} */ (options || _window);
    if (picked?.title === 'Export DWG Copy') {
      exportPicks += 1;
      return { canceled: false, filePath: target };
    }
    if (picked?.title === 'Save Drawing As' && picked.filters?.some((filter) => filter.extensions.includes('dwg')) && picked.filters.some((filter) => filter.extensions.includes('dxf'))) {
      savePicks += 1;
      return { canceled: false, filePath: saveTarget };
    }
    if (picked?.title === 'Save Drawing As' && picked.filters?.length === 1 && picked.filters[0].extensions.length === 1 && picked.filters[0].extensions[0] === 'dxf') {
      dxfPicks += 1;
      return { canceled: false, filePath: dxfTarget };
    }
    throw new Error('Unexpected Save dialog during fixed DWG probe.');
  };
  dialog.showSaveDialog = fixedDialog;
  try {
    const result = await win.webContents.executeJavaScript(`(async () => {
      const fixture = ${JSON.stringify(fixture)}, target = ${JSON.stringify(target)}, saveTarget = ${JSON.stringify(saveTarget)}, dxfTarget = ${JSON.stringify(dxfTarget)};
      ${rotationChecks}
      const until = Date.now() + 30000;
      while (!window.editor || !window.jcad || !window.editor.doc.filePath || !window.editor.doc.entities.length) {
        if (Date.now() >= until) throw new Error('Renderer or handed-over DXF did not become ready');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const ed = window.editor;
      if (ed.doc.filePath.replace(/\\\\/g, '/') !== fixture.replace(/\\\\/g, '/')) throw new Error('DWG probe requires its own temporary DXF');
      const availability = await window.jcad.dwgExportStatus(); if (!availability.available) throw new Error(availability.reason || 'Writer unavailable');
      const block = { name:'DWG_PROBE', basePoint:{x:0,y:0}, entities:[{id:'probe-block-line',type:'line',layer:'0',color:2,a:{x:0,y:0},b:{x:3,y:4}}], attributes:[{tag:'TAG1',prompt:'Tag',default:'DEFAULT',position:{x:0,y:1},height:1,align:'left',layer:'0'}] };
      ed.doc.patchQuiet(state => ({...state, layouts:[...(state.layouts||[]),${JSON.stringify(rotatedLayout)}], blocks:{...state.blocks,DWG_PROBE:block}, entities:[...state.entities,
        {id:'probe-width',type:'polyline',layer:'0',color:3,trueColor:0x2468ac,transparency:96,points:[{x:0,y:0},{x:10,y:0},{x:15,y:5}],closed:false,widths:[{start:0.5,end:2},{start:2,end:0.75},{start:0,end:0}]},
        {id:'probe-array',type:'insert',layer:'0',color:2,block:'DWG_PROBE',position:{x:20,y:5},scale:2,scaleY:3,rotation:Math.PI/2,columns:3,rows:2,columnSpacing:7,rowSpacing:11,attributes:{TAG1:'QF1'}}]}));
      assertRotatedCanvas(ed,'Source');
      const snapshot=ed.doc.snapshot, binding=ed.doc.filePath, history=ed.doc.history(), session=ed.sessions.activeId;
      await ed.commands.get('EXPORTDWG').run(ed);
      const after=ed.doc.history();
      if (ed.doc.snapshot!==snapshot || ed.doc.filePath!==binding || !ed.doc.dirty || ['undo','redo'].some(k=>after[k].length!==history[k].length || after[k].some((state,i)=>state!==history[k][i]))) throw new Error('DWG export changed working binding, snapshot, dirty state or history');
      ed.sessions.add(snapshot,null,true);
      if (!await ed.saveFile(true,'dxf') || ed.doc.filePath!==dxfTarget || ed.doc.dirty) throw new Error('Rotated layout DXF Save As failed');
      const beforeDxfReload=ed.doc.snapshot;
      if (!await ed.openFile(dxfTarget) || ed.doc.snapshot===beforeDxfReload || ed.doc.filePath!==dxfTarget || ed.doc.dirty) throw new Error('Rotated layout DXF did not freshly reopen');
      assertRotatedCanvas(ed,'Reopened DXF');
      ed.sessions.add();
      if (!await ed.openFile(target)) throw new Error('Exported DWG did not reopen through isolated reader');
      assertRotatedCanvas(ed,'Reopened DWG copy');
      const insert=ed.doc.entities.find(e=>e.type==='insert' && e.block==='DWG_PROBE'), width=ed.doc.entities.find(e=>e.type==='polyline' && e.trueColor===0x2468ac);
      if (!insert || insert.columns!==3 || insert.rows!==2 || insert.columnSpacing!==7 || insert.rowSpacing!==11 || insert.attributes.TAG1!=='QF1' || Math.abs(insert.scale-2)>1e-8 || Math.abs(insert.scaleY-3)>1e-8) throw new Error('Native DWG array/attribute data changed');
      if (!width || width.widths?.length!==3 || Math.abs(width.widths[0].start-0.5)>1e-8 || Math.abs(width.widths[0].end-2)>1e-8 || Math.abs(width.widths[1].end-0.75)>1e-8 || width.transparency!==96) throw new Error('Native DWG widths/RGB/transparency changed');
      const exportedCount=ed.doc.entities.length;
      for (const text of ['not DXF','0\\nSECTION\\n2\\nHEADER\\n9\\n$ACADVER\\n1\\nAC1032\\n0\\nENDSEC\\n0\\nSECTION\\n2\\nENTITIES\\n0\\n3DSOLID\\n5\\n101\\n100\\nAcDbEntity\\n8\\n0\\n100\\nAcDbModelerGeometry\\n70\\n1\\n1\\nunsupported ACIS\\n0\\nENDSEC\\n0\\nEOF\\n']) {
        let refused=false; try { await window.jcad.exportDwg(target,text); } catch { refused=true; } if (!refused) throw new Error('Malformed/unsupported DWG export was accepted');
      }
      const originalSession=ed.sessions.all.find(s=>s.id===session); if (!originalSession || originalSession.state!==snapshot || originalSession.filePath!==binding || !originalSession.dirty) throw new Error('Working document was not preserved after reopen');
      const savingState=ed.doc.snapshot, savingSession=ed.sessions.activeId;
      const savedHook=ed.hooks.drawingSaved; if (typeof savedHook!=='function') throw new Error('Drawing recovery save hook is missing');
      let notified=false;
      ed.hooks.drawingSaved=(id,state,file)=>{
        if (id!==savingSession || state!==savingState || file!==saveTarget) throw new Error('DWG Save As recovery hook received another revision');
        notified=true; savedHook(id,state,file);
      };
      try {
        ed.suggestedName='shipping-normal-save.dwg';
        if (!await ed.saveFile(true) || ed.doc.filePath!==saveTarget || ed.doc.dirty || ed.sessions.current.filePath!==saveTarget || ed.sessions.current.dirty || !notified) throw new Error('Normal DWG Save As did not rebind cleanly and notify recovery');
      } finally { ed.hooks.drawingSaved=savedHook; }
      assertRotatedViewports(ed,'DWG Save As');
      const info=await window.jcad.appInfo();
      return {version:info.version,packaged:info.packaged,writer:true,reopened:true,entities:exportedCount,arrays:true,attributes:true,widths:true,appearance:true,workingPreserved:true,rejectedContent:true,saveAsDwg:true};
    })()`);
    if (fs.readFileSync(target).subarray(0, 6).toString('ascii') !== 'AC1032' || !fs.readFileSync(`${target}.bak`).equals(original)) throw new Error('Portable DWG output or exact atomic backup is missing.');
    const beforeSave = fs.readFileSync(saveTarget);
    if (beforeSave.subarray(0, 6).toString('ascii') !== 'AC1032' || exportPicks !== 1 || savePicks !== 1 || dxfPicks !== 1) throw new Error('DWG/DXF Save As did not use their native drawing pickers.');
    const normalSave = await win.webContents.executeJavaScript(`(async () => {
      const ed=window.editor, saveTarget=${JSON.stringify(saveTarget)};
      ${rotationChecks}
      if (ed.doc.filePath!==saveTarget || ed.doc.dirty) throw new Error('Normal DWG Save requires its clean Save As result');
      const savedAsState=ed.doc.snapshot;
      if (!await ed.openFile(saveTarget) || ed.doc.snapshot===savedAsState || ed.doc.filePath!==saveTarget || ed.doc.dirty) throw new Error('DWG Save As did not freshly reopen');
      assertRotatedCanvas(ed,'Reopened DWG Save As');
      ed.doc.addEntities([{id:'normal-save-line',type:'line',layer:'0',color:'ByLayer',a:{x:73,y:29},b:{x:79,y:31}}]);
      const savingState=ed.doc.snapshot, savingSession=ed.sessions.activeId;
      const savedHook=ed.hooks.drawingSaved; if (typeof savedHook!=='function') throw new Error('Drawing recovery save hook is missing');
      const savedConfirm=ed.ui?.confirm, savedSaveError=ed.hooks.saveError;
      if (typeof savedConfirm!=='function') throw new Error('Fixed DWG probe requires the normal loss-confirmation interface');
      const expectedLossWarning=${JSON.stringify('shipping-normal-save.dwg contained 41 object(s) JCad cannot keep (see the import report). Saving over it removes them from the file. Use Save As to keep the original. Save over it anyway?\n\nYes saves over it; No opens Save As.')};
      let notified=false, normalSaveLossConsent=false;
      ed.ui.confirm=async(title,message)=>{
        if (title!=='Save over the original file?' || message!==expectedLossWarning || ed.doc.filePath!==saveTarget || ed.sessions.activeId!==savingSession || ed.doc.snapshot!==savingState || normalSaveLossConsent) throw new Error('Unexpected loss dialog during fixed private-profile DWG Save: '+JSON.stringify({title,message,pathMatches:ed.doc.filePath===saveTarget,sessionMatches:ed.sessions.activeId===savingSession,stateMatches:ed.doc.snapshot===savingState,alreadyConsented:normalSaveLossConsent}));
        normalSaveLossConsent=true;
        return true;
      };
      // A mismatched dialog or actual write failure must fail this probe immediately, not open Retry.
      ed.hooks.saveError=async(info)=>{throw new Error('Fixed private-profile DWG Save failed: '+info.message);};
      ed.hooks.drawingSaved=(id,state,file)=>{
        if (id!==savingSession || state!==savingState || file!==saveTarget) throw new Error('DWG Save recovery hook received another revision');
        notified=true; savedHook(id,state,file);
      };
      try {
        if (!await ed.saveFile(false) || ed.doc.filePath!==saveTarget || ed.doc.dirty || ed.sessions.current.filePath!==saveTarget || ed.sessions.current.dirty || !notified) throw new Error('Normal DWG Save did not finish cleanly and notify recovery');
      } finally { ed.hooks.drawingSaved=savedHook; ed.ui.confirm=savedConfirm; ed.hooks.saveError=savedSaveError; }
      const beforeReload=ed.doc.snapshot;
      if (!await ed.openFile(saveTarget) || ed.doc.snapshot===beforeReload || ed.doc.filePath!==saveTarget || ed.doc.dirty) throw new Error('Normally saved DWG did not freshly reopen through isolated reader');
      assertRotatedCanvas(ed,'Reopened normal DWG Save');
      if (!ed.doc.entities.some(e=>e.type==='line' && e.a.x===73 && e.a.y===29 && e.b.x===79 && e.b.y===31)) throw new Error('Normal DWG Save edit did not persist');
      const insert=ed.doc.entities.find(e=>e.type==='insert' && e.block==='DWG_PROBE'), width=ed.doc.entities.find(e=>e.type==='polyline' && e.trueColor===0x2468ac);
      if (!insert || insert.columns!==3 || insert.rows!==2 || insert.columnSpacing!==7 || insert.rowSpacing!==11 || insert.attributes.TAG1!=='QF1' || Math.abs(insert.scale-2)>1e-8 || Math.abs(insert.scaleY-3)>1e-8) throw new Error('Normal DWG Save changed array/attribute data');
      if (!width || width.widths?.length!==3 || Math.abs(width.widths[0].start-0.5)>1e-8 || Math.abs(width.widths[0].end-2)>1e-8 || Math.abs(width.widths[1].end-0.75)>1e-8 || width.transparency!==96) throw new Error('Normal DWG Save changed widths/RGB/transparency');
      if (ed.doc.entities.length!==5) throw new Error('Normal DWG Save changed the entity count');
      // Finish cleanly after checking dirty state; these are exclusively smoke documents.
      for (const current of ed.sessions.all) current.dirty=false; ed.doc.dirty=false;
      return {saveDwg:true,viewportRotation:true,normalSaveLossConsent};
    })()`);
    if (savePicks !== 1 || !fs.readFileSync(`${saveTarget}.bak`).equals(beforeSave) || fs.readFileSync(saveTarget).equals(beforeSave) || fs.readFileSync(saveTarget).subarray(0, 6).toString('ascii') !== 'AC1032') throw new Error('Normal DWG Save did not keep the exact prior bytes as its backup.');
    const sourceLocations = app.isPackaged
      ? { directory: path.join(process.resourcesPath, 'dwg-writer'), manifest: path.join(app.getAppPath(), 'electron', 'dwg-writer-integrity.json') }
      : { directory: path.join(__dirname, '..', '..', 'release', 'dwg-writer'), manifest: path.join(__dirname, '..', '..', 'release', 'dwg-writer', 'integrity.json') };
    await verifyPortableWriter(sourceLocations);
    const copy = path.join(profile, 'writer-integrity-probe'); fs.mkdirSync(copy);
    const manifest = JSON.parse(fs.readFileSync(sourceLocations.manifest, 'utf8'));
    for (const item of manifest.files) fs.copyFileSync(path.join(sourceLocations.directory, item.name), path.join(copy, item.name));
    const helper = path.join(copy, 'JcadDwgWriter.exe');
    fs.appendFileSync(helper, 'fixed-tamper');
    let tampered = false; try { await verifyPortableWriter({ directory: copy, manifest: sourceLocations.manifest }); } catch { tampered = true; }
    fs.unlinkSync(helper);
    let missing = false; try { await verifyPortableWriter({ directory: copy, manifest: sourceLocations.manifest }); } catch { missing = true; }
    if (!tampered || !missing) throw new Error('Missing or tampered helper passed verification.');
    return { ...result, ...normalSave, phase: 'dwg', testBuild, backup: true, normalSaveBackup: true, integrityRefused: true };
  } finally { dialog.showSaveDialog = previousDialog; }
}

module.exports = { runShippingDwgProbe };
