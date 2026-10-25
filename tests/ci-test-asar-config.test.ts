import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { assertCiContext, assertGeneratedInputsOnly } from '../scripts/check-ci-test-asar.mjs';
const require=createRequire(import.meta.url);
const {ciTestAsarConfig}=require('../scripts/ci-test-asar-config.cjs');
const repo=resolve(import.meta.dirname,'..'),pkg=JSON.parse(readFileSync(join(repo,'package.json'),'utf8'));
const paths={repo,output:join(repo,'.codex-local/ci-test-asar/run-control/output'),electronDist:join(repo,'node_modules/electron/dist')};

describe('unpublished CI test ASAR boundary',()=>{
  it('keeps the full DWG payload and inspection-only test role, without mutating shipping configuration',async()=>{
    const before=JSON.stringify(pkg.build),config=ciTestAsarConfig(paths);
    expect(config.win.extraResources).toEqual(pkg.build.win.extraResources);expect(config.files).toEqual(pkg.build.files);expect(config.asarUnpack).toEqual(pkg.build.asarUnpack);
    expect(config.electronFuses).toEqual({...pkg.build.electronFuses,enableNodeCliInspectArguments:true});
    expect(config.extraMetadata).toEqual({jcadTestBuild:true});expect(config.publish).toBeNull();expect(config.win.target).toEqual(['dir']);
    expect(config.win.signExecutable).toBe(false);expect(config.win.forceCodeSigning).toBe(false);expect(config.win.signAndEditExecutable).toBe(true);
    expect([config.npmRebuild,config.nodeGypRebuild,config.buildDependenciesFromSource,config.downloadAlternateFFmpeg]).toEqual([false,false,false,false]);
    expect(config.electronVersion).toBe('44.9.1');expect(config.electronDist).toBe(paths.electronDist);expect(config.asar).toBe(true);
    expect(JSON.stringify(pkg.build)).toBe(before);
    const {validateConfiguration}=require('app-builder-lib/out/util/config/config.js');
    await expect(validateConfiguration(config,{isEnabled:false})).resolves.toBeUndefined();
  });
  it('refuses sibling output roots and alternate Electron inputs before any build',()=>{
    expect(()=>ciTestAsarConfig({...paths,output:join(repo,'release/output')})).toThrow();
    expect(()=>ciTestAsarConfig({...paths,output:join(repo,'.codex-local/ci-test-asar/run-control/../output')})).toThrow();
    expect(()=>ciTestAsarConfig({...paths,electronDist:join(repo,'other/runtime')})).toThrow();
  });
  it('refuses local/non-Windows/no-writer execution and mismatched checked SHA',()=>{
    const env={CI:'true',GITHUB_ACTIONS:'true',RUNNER_OS:'Windows',GITHUB_SHA:'a'.repeat(40),JCAD_TEST_ASAR_EXPECTED_SHA:'a'.repeat(40)};
    expect(()=>assertCiContext(env,'win32','x64')).not.toThrow();
    for(const patch of [{CI:undefined},{GITHUB_ACTIONS:undefined},{RUNNER_OS:'Linux'},{JCAD_TEST_ASAR_EXPECTED_SHA:'b'.repeat(40)},{JCAD_TEST_BUILD_WITHOUT_DWG_WRITER:'1'}])expect(()=>assertCiContext({...env,...patch},'win32','x64')).toThrow();
    expect(()=>assertCiContext(env,'linux','x64')).toThrow();expect(()=>assertCiContext(env,'win32','arm64')).toThrow();
  });
  it('permits only the explicitly checked generated writer manifest at entry',()=>{
    expect(()=>assertGeneratedInputsOnly([])).not.toThrow();expect(()=>assertGeneratedInputsOnly(['electron/dwg-writer-integrity.json'])).not.toThrow();
    for(const file of ['electron/main.cjs','package-lock.json','electron/../electron/main.cjs','electron/dwg-writer-integrity.json/extra'])expect(()=>assertGeneratedInputsOnly([file])).toThrow();
  });
});
