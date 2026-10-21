// CI-only broad packaged checks. Never creates/installs an installer or publishes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { verifyExecutableFuses } from './electron-fuse-policy.mjs';

export function assertCiContext(env, platform, arch) {
  assert.equal(platform, 'win32'); assert.equal(arch, 'x64');
  assert.equal(env.CI, 'true'); assert.equal(env.GITHUB_ACTIONS, 'true'); assert.equal(env.RUNNER_OS, 'Windows');
  assert.match(env.JCAD_TEST_ASAR_EXPECTED_SHA ?? '', /^[a-f0-9]{40}$/);
  assert.equal(env.JCAD_TEST_ASAR_EXPECTED_SHA, env.GITHUB_SHA);
  assert.ok(!env.JCAD_TEST_BUILD_WITHOUT_DWG_WRITER, 'CI test ASAR must contain the full DWG writer');
}
export function assertGeneratedInputsOnly(changedPaths) {
  for (const file of changedPaths) assert.equal(file, 'electron/dwg-writer-integrity.json', 'Unexpected source change before packaged checks');
}
/** @param {string} archive @param {string} repo */
export function verifyPackedNotices(archive, repo) {
  const asar = createRequire(import.meta.url)('@electron/asar');
  return ['LICENSE', 'THIRD-PARTY-NOTICES.md'].map(file => {
    const expected = readFileSync(join(repo, file)), actual = asar.extractFile(archive, file);
    assert.deepEqual(actual, expected, `${file} must match the source notice bytes`);
    return { path: file, bytes: actual.length, sha256: createHash('sha256').update(actual).digest('hex') };
  });
}
async function digest(file) {
  const hash = createHash('sha256'); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest('hex');
}
function filesUnder(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(file)); else result.push(file);
  }
  return result;
}
async function main() {
  // No artifact creation on a user's local Windows session, even by accident.
  assert.equal(process.platform,'win32');assert.equal(process.env.CI,'true');assert.equal(process.env.GITHUB_ACTIONS,'true');
  const repo = resolve(import.meta.dirname, '..'), expected = process.env.JCAD_TEST_ASAR_EXPECTED_SHA;
  const reports=join(repo,'test-build-output/ci-test-asar');mkdirSync(reports,{recursive:true});
  assert.ok(!existsSync(join(reports,'receipt.json')),'Refuse to overwrite another packaged receipt');
  // The step has a stricter shared 15-minute envelope, not 15 minutes per
  // driver. Leave a minute for owned cleanup and writing failure evidence.
  const deadline=performance.now()+14*60*1000;
  /** @type {Record<string,any>} */
  const receipt={role:'UNPUBLISHED CI TEST-ONLY UNPACKED ASAR',sourceSha:expected,startedUtc:new Date().toISOString(),
    phase:'preflight',budget:{sharedExecutionMs:14*60*1000,outerStepMs:15*60*1000,cleanupReserveMs:60*1000},
    drivers:[],packaging:null,proof:null,ok:false,installerCreated:false,installed:false,signed:false,published:false};
  const save=()=>writeFileSync(join(reports,'receipt.json'),JSON.stringify(receipt,null,2));save();
  try {
  assertCiContext(process.env, process.platform, process.arch);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding:'utf8', windowsHide:true, maxBuffer:32*1024*1024 });
  assert.equal(git('rev-parse','HEAD').trim(),expected);
  const changed = git('diff','--name-only','-z','HEAD').split('\0').filter(Boolean);
  assertGeneratedInputsOnly(changed);
  const require = createRequire(import.meta.url), read = file => JSON.parse(readFileSync(file,'utf8'));
  const version = read(join(repo,'node_modules/electron/package.json')).version;
  const lock=read(join(repo,'package-lock.json'));
  assert.equal(version,'44.7.2');assert.equal(lock.packages['node_modules/electron'].version,version);
  for(const name of ['electron-builder','app-builder-lib']){assert.equal(read(join(repo,`node_modules/${name}/package.json`)).version,'26.17.0');assert.equal(lock.packages[`node_modules/${name}`].version,'26.17.0');}
  const electronDist = join(repo,'node_modules/electron/dist');
  assert.equal(readFileSync(join(electronDist,'version'),'utf8').trim(),version);
  assert.ok(existsSync(join(electronDist,'electron.exe')),'The preceding CI install step must fetch locked Electron before packaging');
  assert.ok(!existsSync(join(repo,'electron-builder.env')),'Refuse implicit builder environment injection');
  // A present valid ICO uses the local validation/direct-return branch, rather
  // than falling back to an icon-conversion tool acquisition.
  const ico=readFileSync(join(repo,'build/icon.ico'));
  assert.ok(ico.length>=6&&ico.readUInt16LE(0)===0&&ico.readUInt16LE(2)===1,'Existing ICO header required');
  const iconCount=ico.readUInt16LE(4);assert.ok(iconCount>0&&6+iconCount*16<=ico.length);
  assert.ok(Array.from({length:iconCount},(_,i)=>ico[6+i*16]||256).some(width=>width>=256),'Existing 256px ICO required');
  const writer = join(repo,'release/dwg-writer'), manifestPath = join(writer,'integrity.json');
  const manifest = read(manifestPath);
  assert.equal(manifest.schemaVersion,1);assert.ok(Array.isArray(manifest.files));
  assert.equal(await digest(join(repo,'electron/dwg-writer-integrity.json')),await digest(manifestPath),'Generated app/writer manifests must match');
  assert.deepEqual(readdirSync(writer).sort(),['integrity.json',...manifest.files.map(file=>file.name)].sort());
  assert.ok(manifest.files.some(file=>file.name==='JcadDwgWriter.exe'));
  for(const file of manifest.files){assert.match(file.name,/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);assert.equal(lstatSync(join(writer,file.name)).size,file.size);assert.equal(await digest(join(writer,file.name)),file.sha256);}
  const tracked=git('ls-files','-z').split('\0').filter(Boolean);
  async function snapshot(){
    const paths=[...new Set([...tracked.map(file=>join(repo,file)),...filesUnder(join(repo,'dist')),...filesUnder(join(repo,'electron')),...filesUnder(join(repo,'build')),...filesUnder(join(repo,'vendor/libredwg-web-bg')),...filesUnder(join(repo,'node_modules')),...filesUnder(writer)])].sort();
    const result=[];
    for(const file of paths){const stat=lstatSync(file),name=relative(repo,file).split(sep).join('/');if(stat.isSymbolicLink())result.push({path:name,link:readlinkSync(file)});else{assert.ok(stat.isFile());result.push({path:name,bytes:stat.size,sha256:await digest(file)});}}
    return result;
  }
  const before=await snapshot();
  const base=join(repo,'.codex-local/ci-test-asar');mkdirSync(base,{recursive:true});
  const run=mkdtempSync(join(base,'run-')),output=join(run,'output'),temp=join(run,'temp');mkdirSync(temp);
  /** @type {Record<string,string>} */
  const env={...process.env,TEMP:temp,TMP:temp,TMPDIR:temp,NO_UPDATE_NOTIFIER:'1',ELECTRON_BUILDER_OFFLINE:'true',ELECTRON_SKIP_BINARY_DOWNLOAD:'1',
    npm_config_offline:'true',npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false',npm_config_update_notifier:'false'};
  for(const key of Object.keys(env))if(/^(CSC_|WIN_CSC_|APPLE_|AZURE_|AWS_|GH_TOKEN$|GITHUB_TOKEN$)/i.test(key)||/^(NODE_OPTIONS|ELECTRON_RUN_AS_NODE|VITE_DEV_SERVER_URL|PUBLISH_FOR_PULL_REQUEST|npm_lifecycle_event|JCAD_E2E_EXECUTABLE|ELECTRON_ENABLE_LOGGING|ELECTRON_LOG_FILE)$/i.test(key))delete env[key];
  env.CSC_IDENTITY_AUTO_DISCOVERY='false';
  for(const [key,folder] of [['ELECTRON_BUILDER_CACHE','builder-cache'],['ELECTRON_CACHE','electron-cache'],['npm_config_cache','npm-cache'],['XDG_CACHE_HOME','xdg-cache']]){env[key]=join(run,folder);mkdirSync(env[key]);}
  const config=require('./ci-test-asar-config.cjs').ciTestAsarConfig({repo,output,electronDist});
  const configPath=join(run,'config.json');writeFileSync(configPath,JSON.stringify(config,null,2));
  const executable=join(output,'win-unpacked/JCad Electrical.exe'),archive=join(dirname(executable),'resources/app.asar');
  Object.assign(receipt,{generatedTrackedInputs:changed,generatedManifestSha256:await digest(manifestPath),electron:version,run,executable});
  writeFileSync(join(reports,'inputs-before.json'),JSON.stringify(before,null,2));save();
  /** @returns {Promise<Record<string,any>>} */
  async function child(name,args,timeout,extraEnv={}){
    const remaining=deadline-performance.now();assert.ok(remaining>0,'Shared packaged-step budget expired before starting another owned process');
    const limit=Math.min(timeout,remaining);receipt.phase=name;save();
    const log=openSync(join(reports,`${name}.log`),'wx');
    try{return await new Promise(done=>{
      const proc=spawn(process.execPath,args,{cwd:repo,env:{...env,...extraEnv},windowsHide:true,stdio:['ignore',log,log]});let timedOut=false;
      const timer=setTimeout(()=>{timedOut=true;if(proc.pid&&proc.exitCode===null&&proc.signalCode===null)spawnSync('taskkill',['/PID',String(proc.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:5000});},limit);
      proc.once('error',error=>{clearTimeout(timer);done({name,args,pid:proc.pid,error:String(error),code:null,signal:null,timedOut,limitMs:limit});});
      proc.once('close',(code,signal)=>{clearTimeout(timer);done({name,args,pid:proc.pid,code,signal,timedOut,limitMs:limit});});
    });}finally{closeSync(log);}
  }
  const assertChild=result=>{assert.equal(result.error,undefined);assert.equal(result.timedOut,false);assert.equal(result.signal,null);assert.equal(result.code,0,`Read ${result.name}.log`);};
  try{
    receipt.packaging=await child('packaging',[join(repo,'node_modules/electron-builder/cli.js'),'--win','dir','--x64','--publish','never','--config',configPath,'--projectDir',repo],5*60*1000);save();assertChild(receipt.packaging);
    const asar=require('@electron/asar'),packed=JSON.parse(asar.extractFile(archive,'package.json').toString('utf8')),pkg=read(join(repo,'package.json'));
    assert.equal(packed.name,pkg.name);assert.equal(packed.version,pkg.version);assert.equal(packed.main,pkg.main);
    assert.equal(packed.jcadTestBuild,true);assert.ok(!packed.jcadTestBuildWithoutDwgWriter);
    let packedCount=0;
    for(const row of before.filter(item=>item.path.startsWith('electron/')||item.path.startsWith('dist/'))){if(row.link!==undefined)continue;assert.equal(createHash('sha256').update(asar.extractFile(archive,row.path.split('/').join(sep))).digest('hex'),row.sha256,row.path);packedCount++;}
    for(const name of readdirSync(writer))assert.equal(await digest(join(dirname(executable),'resources/dwg-writer',name)),await digest(join(writer,name)),name);
    const fuses=await verifyExecutableFuses(executable,'test');
    receipt.proof={executableSha256:await digest(executable),archiveSha256:await digest(archive),packedCount,notices:verifyPackedNotices(archive,repo),testMetadata:{jcadTestBuild:true,version:packed.version},fuses,dwgFiles:readdirSync(writer)};save();
    for(const [name,args] of [['desktop',['--experimental-strip-types',join(repo,'scripts/e2e-electron.mjs'),'--packaged',executable]],['origin',[join(repo,'scripts/e2e-origin.mjs'),'--packaged',executable]]]){
      const out=join(reports,`${name}-output`);mkdirSync(out);
      const result=await child(name,args,15*60*1000,{JCAD_E2E_OUT:out,JCAD_ORIGIN_E2E_KEEP:'1'});receipt.drivers.push(result);save();assertChild(result);
    }
    assert.equal(await digest(executable),receipt.proof.executableSha256);assert.equal(await digest(archive),receipt.proof.archiveSha256);
    assert.deepEqual(await verifyExecutableFuses(executable,'test'),receipt.proof.fuses);
    receipt.ok=true;
  }catch(error){receipt.error=String(error.stack??error);throw error;}
  finally{
    // Surface the origin driver's recorded CDP target state in the receipt
    // itself (PR23 ASAR diagnosis item C). Best-effort: the driver outputs
    // sit beside this receipt in the uploaded bundle either way.
    try{
      const originOut=join(reports,'origin-output');
      const failureFiles=existsSync(originOut)?readdirSync(originOut).filter(name=>/^origin-failure-launch-\d+\.json$/.test(name)).sort():[];
      if(failureFiles.length){
        const diagnostic=JSON.parse(readFileSync(join(originOut,failureFiles[failureFiles.length-1]),'utf8'));
        if(diagnostic?.cdpTargets)receipt.originCdpTargets=diagnostic.cdpTargets;
      }
    }catch{/* diagnostics never change the recorded driver outcome */}
    // Driver failure must still retain and enforce final package identity.
    if(receipt.proof){
      try{
        const executableSha256=await digest(executable),archiveSha256=await digest(archive);
        receipt.postRunProof={executableSha256,archiveSha256};
        const fuses=await verifyExecutableFuses(executable,'test');receipt.postRunProof.fuses=fuses;
        assert.equal(executableSha256,receipt.proof.executableSha256);
        assert.equal(archiveSha256,receipt.proof.archiveSha256);
        assert.deepEqual(fuses,receipt.proof.fuses);
        receipt.packageIdentityUnchanged=true;
      }catch(error){receipt.ok=false;receipt.packageIdentityUnchanged=false;receipt.postRunProofError=String(error.stack??error);process.exitCode=1;}
      save();
    }
    try{const after=await snapshot();writeFileSync(join(reports,'inputs-after.json'),JSON.stringify(after,null,2));assert.deepEqual(after,before,'Packaging/drivers changed source, dependencies or input resources');assert.equal(git('rev-parse','HEAD').trim(),expected);assert.deepEqual(git('diff','--name-only','-z','HEAD').split('\0').filter(Boolean),changed);receipt.inputsUnchanged=true;}
    catch(error){receipt.ok=false;receipt.inputsUnchanged=false;receipt.error=String(error.stack??error);process.exitCode=1;}
  }
  }catch(error){receipt.ok=false;receipt.error=String(error.stack??error);throw error;}
  finally{receipt.finishedUtc=new Date().toISOString();save();console.log(JSON.stringify({ok:receipt.ok,receipt:join(reports,'receipt.json'),sourceSha:expected,phase:receipt.phase}));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.stack??error);process.exitCode=1;});
