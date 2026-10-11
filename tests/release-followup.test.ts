import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
function scratch(run: (root: string) => void) {
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, 'jcad-release-followup-'));
  try { run(root); }
  finally {
    const checked = realpathSync.native(root);
    if (dirname(checked) === parent && basename(checked).startsWith('jcad-release-followup-')) rmSync(checked, { recursive:true, force:true });
  }
}
function childEnv(root: string) {
  const temporary = join(root, 'temporary');
  mkdirSync(temporary);
  return { ...process.env, TEMP:temporary, TMP:temporary, TMPDIR:temporary, JCAD_E2E_OUT:join(root, 'output'), JCAD_SMOKE_KEEP:'' };
}

describe('clean release consumers and failed-smoke cleanup', () => {
  it('loads aggregate verification without installing any npm dependencies', () => scratch((root) => {
    for (const name of ['release-provenance.mjs', 'electron-fuse-evidence.mjs']) copyFileSync(join(repo, 'scripts', name), join(root, name));
    const url = pathToFileURL(join(root, 'release-provenance.mjs')).href;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(url)}); console.log(typeof m.verifyReleaseProvenance);`], { encoding:'utf8', windowsHide:true, timeout:5000 });
    expect(output.trim()).toBe('function');
  }));
  it('removes its extraction directory when no installer is available', () => scratch((root) => {
    const env = childEnv(root);
    const empty = join(root, 'empty'); mkdirSync(empty);
    const result = spawnSync(process.execPath, [join(repo, 'scripts', 'packaged-smoke.mjs'), empty], { env, encoding:'utf8', windowsHide:true, timeout:10000 });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('no installer');
    expect(readdirSync(env.TEMP)).toEqual([]);
  }));
  it('removes a smoke profile when executable fuse validation fails before launch', () => scratch((root) => {
    const env = childEnv(root);
    const invalid = join(root, 'invalid-binary'); writeFileSync(invalid, 'invalid fuse wire');
    const result = spawnSync(process.execPath, [join(repo, 'scripts', 'shipping-runtime-smoke.mjs'), invalid], { env, encoding:'utf8', windowsHide:true, timeout:10000 });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('sentinel');
    expect(readdirSync(env.TEMP)).toEqual([]);
  }));
});
