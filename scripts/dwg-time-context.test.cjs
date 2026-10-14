const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const temporaryParent = fs.realpathSync(os.tmpdir());
const privateRoot = fs.mkdtempSync(path.join(temporaryParent, 'jcad-dwg-time-context-'));
if (path.dirname(path.resolve(privateRoot)) !== temporaryParent || fs.realpathSync(privateRoot) !== privateRoot)
  throw new Error('Invalid time-context test temporary root');
const contextApi = require('../electron/dwg-time-context.cjs');
const { deriveSourceTimeContext, sourceCreationOffsetMinutes } = contextApi;
/** @typedef {{type:string, id?:number, byteLength?:number, offset?:number, bytes?:Uint8Array, resourceLimits?:Record<string, number>}} ReaderMessage */
/** @typedef {EventEmitter & {sent:ReaderMessage[], messages:unknown[], readonly pid:number|undefined, postMessage(message:ReaderMessage):void, kill():boolean, closed:Promise<void>}} TestReaderProcess */
/** @typedef {{events:TestReaderProcess, env:NodeJS.ProcessEnv}} LaunchedReader */
/** @type {Set<TestReaderProcess>} */
const live = new Set();
const hosts = new Set();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const empty = new Uint8Array([20]);
const number = (milliseconds) => {
  const day = milliseconds / 86400000n, remainder = milliseconds % 86400000n;
  return `${day}.${((remainder * 1000000000000n + 43200000n) / 86400000n).toString().padStart(12, '0')}`;
};
function drawing(local = '2461325.815949074', utc = '2461326.024282408') {
  return `0\nSECTION\n2\nHEADER\n9\n$TDCREATE\n40\n${local}\n9\n$TDUCREATE\n40\n${utc}\n0\nENDSEC\n0\nEOF\n`;
}
function offsetDrawing(minutes) {
  const utc = 2461326n * 86400000n + 7200000n;
  return drawing(number(utc + BigInt(minutes) * 60000n), number(utc));
}
const candidateHost = require('../electron/dwg-host.cjs');
const portable = require('../electron/portable-dwg.cjs');
const probeScripts = path.join(privateRoot, 'scripts');
fs.mkdirSync(probeScripts);
fs.mkdirSync(path.join(privateRoot, 'electron'));
fs.copyFileSync(path.join(root, 'scripts/dwg-process.mjs'), path.join(probeScripts, 'dwg-process.mjs'));
fs.copyFileSync(path.join(root, 'electron/dwg-protocol.cjs'), path.join(privateRoot, 'electron/dwg-protocol.cjs'));
// Actual Node controller and Worker with production CJS/controller copies; only parser workload is authored, no native/WASM claims.
fs.writeFileSync(path.join(probeScripts, 'dwg-worker.mjs'), `
import { parentPort } from 'node:worker_threads';
import { getHeapStatistics, serialize } from 'node:v8';
parentPort.postMessage({ready:true,heapLimitBytes:getHeapStatistics().heap_size_limit});
parentPort.on('message', async ({id,bytes}) => {
 const delay=new Uint8Array(bytes)[0]||0; await new Promise(r=>setTimeout(r,delay));
 const date=new Date(Date.UTC(2026,9,12,2));
 const localMidnight=Date.UTC(date.getFullYear(),date.getMonth(),date.getDate());
 const day=2461326+(localMidnight-Date.UTC(2026,9,12))/86400000;
 const ms=((date.getHours()*60+date.getMinutes())*60+date.getSeconds())*1000;
 const payload={header:{workerOffsetMinutes:date.getTimezoneOffset(),localDay:day,localMs:ms},entities:[],layers:[],blocks:[]};
 const data=serialize({version:'test',payload});
 const copy=data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength);
 parentPort.postMessage({id,ok:true,serialized:copy},[copy]);
});
`);
/** @param {string} entry @param {{env:NodeJS.ProcessEnv}} options @param {LaunchedReader[]} [launched] @returns {TestReaderProcess} */
function launch(entry, options, launched) {
  const child = fork(entry, [], { env: options.env, execArgv: [], serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  const events = /** @type {TestReaderProcess} */ (new EventEmitter());
  events.sent = []; events.messages = [];
  Object.defineProperty(events, 'pid', { get: () => child.pid });
  events.postMessage = message => { events.sent.push(message); child.send(message, error => { if(error)events.emit('error',error); }); };
  events.kill = () => child.kill('SIGKILL');
  /** @type {Promise<void>} */
  const closed = new Promise(resolve => child.once('exit', () => {live.delete(events);resolve();}));
  events.closed = closed;
  for (const name of ['spawn','message','error','exit']) child.on(name, (...args) => {
    if(name==='message')events.messages.push(args[0]); events.emit(name,...args);
  });
  live.add(events); launched?.push({events,env:options.env});
  return events;
}
/** @param {LaunchedReader[]} [launched] @param {string} [scriptsDir] */
function host(launched = [], scriptsDir = probeScripts) {
  const value = candidateHost.createDwgHost({ scriptsDir, timeoutMs: 5000,
    launchProcess: (entry, options) => launch(entry, options, launched),
    memoryGuardFactory: () => ({ready:Promise.resolve(),checkNow:()=>true,stop:()=>{}}) });
  hosts.add(value); return value;
}
after(async () => {
  for(const h of hosts)h.dispose();
  const pending=[...live]; for(const child of pending)child.kill();
  await Promise.all(pending.map(child=>child.closed));
  assert.equal(live.size,0);
  if (path.dirname(path.resolve(privateRoot)) !== temporaryParent ||
      !path.basename(privateRoot).startsWith('jcad-dwg-time-context-') ||
      fs.realpathSync(privateRoot) !== privateRoot) throw new Error('Refused unsafe temporary cleanup');
  fs.rmSync(privateRoot,{recursive:true,force:true});
  console.log('JCAD_TIME_CONTEXT_OWNED_CHILDREN_CLOSED=0');
});

test('source parser derives signed fixed-hour context, rollover, exact source pair and immutable brand', () => {
  assert.equal(sourceCreationOffsetMinutes(drawing()),-300);
  assert.equal(sourceCreationOffsetMinutes('\r\n  \r\n'+drawing().replace(/\n/g,'\r\n')+' \r\n'),-300);
  for(const minutes of [-840,-300,0,330,600,840])assert.equal(sourceCreationOffsetMinutes(offsetDrawing(minutes)),minutes);
  const west=deriveSourceTimeContext(drawing());
  assert.deepEqual(west,{schemaVersion:1,offsetMinutes:-300,timezone:'Etc/GMT+5'});
  assert.deepEqual(deriveSourceTimeContext(offsetDrawing(600)),{schemaVersion:1,offsetMinutes:600,timezone:'Etc/GMT-10'});
  assert(Object.isFrozen(west));
  assert.throws(()=>contextApi.assertInternalTimeContext({...west}),/untrusted/);
});
test('absent or missing UTC uses original strict path; fractional matching host preserves legacy path', () => {
  assert.equal(deriveSourceTimeContext('0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n'),null);
  assert.equal(deriveSourceTimeContext(drawing().replace('9\n$TDUCREATE\n40\n2461326.024282408\n','')),null);
  assert.equal(deriveSourceTimeContext(offsetDrawing(330),330),null);
  assert.throws(()=>deriveSourceTimeContext(offsetDrawing(330),-300),/fractional/);
});
test('malformed, duplicate, mixed group and nonintegral offsets never establish a context', () => {
  for(const number of ['NaN','Infinity','-1','2147483648','1e99','1e-99','0x12','1.2junk'])
    assert.throws(()=>deriveSourceTimeContext(drawing(number)),/creation|offset/);
  for(const text of [drawing().replace('0\nENDSEC','9\n$TDCREATE\n40\n2461325.815949074\n0\nENDSEC'),
    drawing().replace('40\n2461325','70\n2461325'),drawing().replace('0\nENDSEC','40\n1\n0\nENDSEC'),
    drawing()+drawing(),drawing().replace('0\nENDSEC\n',''),drawing().replace('2\nHEADER','3\nHEADER')])
    assert.throws(()=>deriveSourceTimeContext(text),/framing|HEADER|section|structure|EOF/);
  const utc=2461326n*86400000n+7200000n;
  assert.throws(()=>deriveSourceTimeContext(drawing(number(utc+1n),number(utc))),/offset/);
  assert.throws(()=>deriveSourceTimeContext(offsetDrawing(900)),/offset/);
});
test('ignored raw-inventory i32 groups keep extractor grammar and do not add a lower group-count budget', () => {
  const ignored='999\nopaque\n'.repeat(32000);
  const source=drawing().replace('9\n$TDCREATE',ignored+'-1\ntransient\n+000999\ncomment\n2147483647\nunknown\n-2147483648\nunknown\n9\n$TDCREATE');
  assert.equal(sourceCreationOffsetMinutes(source),-300);
  for(const code of ['2147483648','-2147483649','1.5','1e2'])
    assert.throws(()=>sourceCreationOffsetMinutes(drawing().replace('9\n$TDCREATE',`${code}\nignored\n9\n$TDCREATE`)),/group/);
});
test('original strict verifier still rejects altered/missing creation and universal dates', async () => {
  const { verifyDwgMetadataEquivalence: verify }=await import(pathToFileURL(path.join(root,'scripts/dwg-metadata-equivalence.mjs')).href);
  const source=drawing();assert.equal(verify(source,source).headerVariables,2);
  for(const variable of ['$TDCREATE','$TDUCREATE']) {
    const expression=new RegExp(`9\\n\\${variable}\\n40\\n([^\\n]+)\\n`);
    assert.throws(()=>verify(source,source.replace(expression,(_whole,value)=>`9\n${variable}\n40\n${Number(value)+1}\n`)),/changed/);
    assert.throws(()=>verify(source,source.replace(expression,'')),/missing/);
  }
});
test('real candidate child/controller/Worker report ±offset and day rollover without parent changes', async () => {
  const parentEnv={...process.env},parentOffset=new Date().getTimezoneOffset();
  const launched=[],h=host(launched);
  for(const minutes of [-300,600,0]) {
    const result=await h.read(empty,h.newId(),deriveSourceTimeContext(offsetDrawing(minutes)));
    assert.equal(result.payload.header.workerOffsetMinutes,minutes === 0 ? 0 : -minutes);
    const total=7200000+minutes*60000;
    assert.equal(result.payload.header.localDay,2461326+Math.floor(total/86400000));
    assert.equal(result.payload.header.localMs,((total%86400000)+86400000)%86400000);
  }
  const changedEnvKeys=[...new Set([...Object.keys(parentEnv),...Object.keys(process.env)])]
    .filter(key=>process.env[key]!==parentEnv[key]);
  assert.deepEqual(changedEnvKeys,[]);assert.equal(new Date().getTimezoneOffset(),parentOffset);
  assert.deepEqual(launched.map(x=>x.env.TZ),['Etc/GMT+5','Etc/GMT-10','Etc/GMT']);
});
test('queued concurrent requests retain their own contexts and normal reads preserve inherited environment', async () => {
  const parentTZ=process.env.TZ,launched=[],h=host(launched);
  const offsets=[-300,600,-300,0];
  const results=await Promise.all(offsets.map(minutes=>h.read(new Uint8Array([35]),h.newId(),deriveSourceTimeContext(offsetDrawing(minutes)))));
  assert.deepEqual(results.map(x=>x.payload.header.workerOffsetMinutes),offsets.map(x=>x === 0 ? 0 : -x));
  const ordinary=await h.read(empty);
  assert.equal(ordinary.payload.header.workerOffsetMinutes,new Date().getTimezoneOffset());
  assert.equal(launched.at(-1).env.TZ,parentTZ);assert.equal(process.env.TZ,parentTZ);
});
test('wrong/ignored timezone handshake refuses before input allocation', async () => {
  const dir=path.join(privateRoot,'tests/wrong');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'dwg-process.mjs'),`process.send({type:'ready',protocol:1,pid:process.pid,timezone:process.env.TZ,timezoneOffsetMinutes:0});process.on('message',()=>{});`);
  const launched=[],h=host(launched,dir);
  await assert.rejects(h.read(empty,h.newId(),deriveSourceTimeContext(drawing())),/invalid|oversized/);
  assert.equal(launched[0].events.sent.length,0);
  await launched[0].events.closed;
});
test('foreign context rejects before launching; cancel one owned context then fresh request works', async () => {
  const launched=[],h=host(launched);
  await assert.rejects(h.read(empty,h.newId(),{schemaVersion:1,offsetMinutes:-300,timezone:'Etc/GMT+5'}),/untrusted/);
  assert.equal(launched.length,0);
  const id=h.newId(),pending=h.read(new Uint8Array([200]),id,deriveSourceTimeContext(drawing()));
  h.cancel(id);await assert.rejects(pending,/cancelled/);
  assert.equal((await h.read(empty,h.newId(),deriveSourceTimeContext(offsetDrawing(600)))).payload.header.workerOffsetMinutes,-600);
});
test('two real isolated hosts can run different contexts concurrently and join delayed cancellation', async () => {
  const firstLaunch=[],secondLaunch=[],first=host(firstLaunch),second=host(secondLaunch);
  const id=first.newId();
  const older=first.read(new Uint8Array([200]),id,deriveSourceTimeContext(drawing()));
  const outcome=older.then(()=>null,error=>error);
  const newer=second.read(empty,second.newId(),deriveSourceTimeContext(offsetDrawing(600)));
  for(let tries=0;tries<100&&!firstLaunch[0]?.events.sent.some(message=>message.type==='input-end');tries++)
    await new Promise(resolve=>setTimeout(resolve,10));
  assert(firstLaunch[0].events.sent.some(message=>message.type==='input-end'));
  first.cancel(id);assert.match((await outcome).message,/cancelled/);
  assert.equal((await newer).payload.header.workerOffsetMinutes,-600);
  await firstLaunch[0].events.closed;
  assert.equal((await first.read(empty,first.newId(),deriveSourceTimeContext(offsetDrawing(0)))).payload.header.workerOffsetMinutes,0);
});
test('real portable conversion forwards captured context and preserves malformed/cancellation refusal (mock writer/native payload)', async () => {
  const directory=path.join(privateRoot,'helper');fs.mkdirSync(directory);
  const executable=Buffer.from('authored unused writer integrity fixture');
  fs.writeFileSync(path.join(directory,'JcadDwgWriter.exe'),executable);
  const manifest=path.join(directory,'integrity.json');
  fs.writeFileSync(manifest,JSON.stringify({schemaVersion:1,files:[{name:'JcadDwgWriter.exe',size:executable.length,sha256:sha(executable)}]}));
  const output=Buffer.concat([Buffer.from('AC1032'),Buffer.alloc(130,1)]);
  const calls=[];
  const source=drawing();
  const metadata={schemaVersion:1,dxf:source,objects:[],readError:0,writeError:0,complete:true,notes:[]};
  const options={locations:()=>({directory,manifest}),temporaryRoot:privateRoot,
    run:async(_exe,_args,opts)=>{
      calls.push('writer');
      fs.writeFileSync(path.join(opts.cwd,'output.dwg'),output);
      fs.writeFileSync(path.join(opts.cwd,'report.json'),JSON.stringify({schemaVersion:1,success:true,outputFormat:'AC1032',outputSha256:sha(output),warnings:[],errors:[],processMemoryLimitBytes:1073741824,inputEntityCount:0,outputEntityCount:0}));
      return 'mock native writer result';
    },readMetadata:async(bytes,signal,context)=>{
      assert.deepEqual(bytes,output);calls.push('reader');
      assert.equal(contextApi.assertInternalTimeContext(context),context);
      assert.equal(context.timezone,'Etc/GMT+5');return metadata;
    }};
  assert.deepEqual(await portable.convertDxfToDwg(source,options),output);
  assert.deepEqual(calls,['writer','reader']);
  await assert.rejects(portable.convertDxfToDwg(drawing('NaN'),options),/creation/);
  assert.deepEqual(calls,['writer','reader'],'invalid source refuses before producer');
  const abort=new AbortController();
  await assert.rejects(portable.convertDxfToDwg(source,{...options,signal:abort.signal,
    readMetadata:async(bytes,signal,context)=>{assert.equal(signal,abort.signal);assert.equal(context.timezone,'Etc/GMT+5');abort.abort();return metadata;}}),/canceled/);
  // Scoped transport double only: execute the real, unexported default postflight
  // through its normal main-service import without initializing Electron/native.
  const servicePath=require.resolve('../electron/main/dwg.cjs');
  const previous=require.cache[servicePath];const cancelled=[],reads=[];let nextId=70;
  const service={newId:()=>++nextId,cancel:id=>cancelled.push(id),read:async(...args)=>{
    reads.push(args);return {payload:{nativeMetadata:metadata}};
  }};
  const serviceModule = new Module(servicePath);
  serviceModule.filename = servicePath;
  serviceModule.loaded = true;
  serviceModule.exports = {dwgHost:service};
  require.cache[servicePath]=serviceModule;
  try {
    const completed=new AbortController();
    assert.deepEqual(await portable.convertDxfToDwg(source,{...options,readMetadata:undefined,signal:completed.signal}),output);
    assert.equal(reads[0][1],71);assert.equal(reads[0][2].timezone,'Etc/GMT+5');
    assert.equal(contextApi.assertInternalTimeContext(reads[0][2]),reads[0][2]);
    completed.abort();assert.deepEqual(cancelled,[],'completed default postflight detaches abort listener');
    /** @type {{entered?:()=>void, release?:()=>void}} */
    const callbacks = {};
    /** @type {Promise<void>} */
    const entry=new Promise(resolve=>{callbacks.entered=resolve;});
    /** @type {Promise<void>} */
    const gate=new Promise(resolve=>{callbacks.release=resolve;});
    service.read=async(...args)=>{reads.push(args);assert(callbacks.entered);callbacks.entered();await gate;return {payload:{nativeMetadata:metadata}};};
    const active=new AbortController();
    const pending=portable.convertDxfToDwg(source,{...options,readMetadata:undefined,signal:active.signal});
    const rejected=pending.then(()=>null,error=>error);
    await entry;active.abort();assert.deepEqual(cancelled,[72]);assert(callbacks.release);callbacks.release();
    assert.match((await rejected).message,/canceled/);
  } finally {
    if(previous===undefined)delete require.cache[servicePath];else require.cache[servicePath]=previous;
  }
});
test('ordinary absent-context behavior and strict creation comparisons remain unchanged', async () => {
  const {verifyDwgMetadataEquivalence:verify}=await import(pathToFileURL(path.join(root,'scripts/dwg-metadata-equivalence.mjs')).href);
  const source=drawing();assert.equal(verify(source,source).headerVariables,2);
  for(const variable of ['$TDCREATE','$TDUCREATE']) {
    const marker='9\n'+variable+'\n40\n';const at=source.indexOf(marker)+marker.length;
    const end=source.indexOf('\n',at);
    const changed=source.slice(0,at)+String(Number(source.slice(at,end))+1)+source.slice(end);
    assert.throws(()=>verify(source,changed),/changed/);
  }
});
