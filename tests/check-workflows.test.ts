import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// scripts/check-workflows.mjs: the real workflows pass, and the release gates it guards are
// noticed when someone removes them.

const root = join(import.meta.dirname, '..');
const script = join(root, 'scripts', 'check-workflows.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'jcad-wf-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function check(dir?: string) {
  const r = spawnSync(process.execPath, [script, ...(dir ? [dir] : [])], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** A copy of the workflows with release.yml edited. */
function withRelease(edit: (text: string) => string): string {
  const dir = mkdtempSync(join(scratch, 'w-'));
  cpSync(join(root, '.github', 'workflows'), dir, { recursive: true });
  const file = join(dir, 'release.yml');
  const before = readFileSync(file, 'utf8');
  const after = edit(before);
  expect(after).not.toBe(before);
  writeFileSync(file, after);
  return dir;
}

describe('workflow validation', () => {
  it('accepts the repository workflows', () => {
    const r = check();
    expect(r.out).toMatch(/workflow\(s\) OK/);
    expect(r.code).toBe(0);
  });

  it('rejects invalid YAML', () => {
    const dir = withRelease((t) => `${t}\n  broken: [\n`);
    const r = check(dir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/release\.yml: not valid YAML/);
  });

  it('notices a build that no longer waits for the checks', () => {
    const r = check(withRelease((t) => t.replace('  build:\n    needs: checks\n', '  build:\n')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/build must need checks/);
  });

  it('notices a release that no longer waits for the packaged smoke test or checks the tag', () => {
    const r = check(withRelease((t) => t.replace('needs: [checks, build, packaged-smoke]', 'needs: [checks, build]').replace('target_commitish: ${{ needs.checks.outputs.sha }}', 'target_commitish: ${{ github.sha }}')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/release must need packaged-smoke/);
    expect(r.out).toMatch(/must target the tested commit/);
  });

  it('notices a dropped signing step and a needs on an unknown job', () => {
    const r = check(withRelease((t) => t.replace('run: node scripts/azure-signing.mjs', 'run: echo skipped').replace('needs: [checks, build]\n    strategy', 'needs: [checks, bild]\n    strategy')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/lost its signing step \(scripts\/azure-signing\.mjs\)/);
    expect(r.out).toMatch(/needs unknown job bild/);
  });
});
