import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(dirname(root)).toBe(resolve(tmpdir()));
    expect(root).toMatch(/jcad-installer-entry-/);
    rmSync(root, { recursive:true, force:true });
  }
});

describe.skipIf(process.platform !== 'win32')('actual installer entry refuses incomplete or non-CI acceptance without executing apps', () => {
  function run(kind: 'folder' | 'wrong-name' | 'host') {
    const root = mkdtempSync(join(tmpdir(), 'jcad-installer-entry-')); roots.push(root);
    const installers = join(root, 'installers'), output = join(root, 'evidence');
    mkdirSync(installers);
    if (kind === 'folder') {
      mkdirSync(join(installers, 'win-unpacked'));
      writeFileSync(join(installers, 'win-unpacked', 'JCad Electrical.exe'), 'A non-executable test sentinel; it must never run.');
    } else writeFileSync(join(installers, kind === 'host' ? 'jcad-electrical-0.5.1-win-x64.exe' : 'wrong.exe'), 'A non-executable test sentinel; it must never run.');
    const child = spawnSync(process.execPath, [resolve('scripts/packaged-smoke.mjs'), installers], {
      cwd:resolve('.'), encoding:'utf8', windowsHide:true, timeout:15000,
      env:{ ...process.env, GITHUB_ACTIONS:'false', JCAD_E2E_EXPECT_VERSION:'0.5.1', JCAD_SMOKE_OUT:output },
    });
    expect(child.error).toBeUndefined(); expect(child.signal).toBeNull(); expect(child.status).not.toBe(0);
    expect(child.stdout).not.toContain('--probe-dwg');
    expect(existsSync(join(output, 'packaged-smoke-results.json'))).toBe(false);
    return child.stderr;
  }
  it('cannot certify an unpacked folder as an installer upgrade', () => {
    expect(run('folder')).toMatch(/exactly one versioned Windows x64 NSIS installer/);
  });
  it('refuses an unexpected installer identity before host inventory or native work', () => {
    expect(run('wrong-name')).toMatch(/exactly one versioned Windows x64 NSIS installer/);
  });
  it('refuses a normally named candidate on a developer computer before signature checks or execution', () => {
    expect(run('host')).toMatch(/hosted release CI: GITHUB_ACTIONS/);
  });
});
