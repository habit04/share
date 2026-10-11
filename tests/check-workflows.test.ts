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
  const before = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
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

  it('notices a release that runs on always(), and a checks step that continues on error', () => {
    const r = check(withRelease((t) => t.replace(/ {4}if: startsWith\(github\.ref, 'refs\/tags\/v'\).*\n/, '    if: always()\n').replace('      - run: npm test\n', '      - run: npm test\n        continue-on-error: true\n')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/job release runs even when a job it needs failed/);
    expect(r.out).toMatch(/job checks step \d+ continues on error/);
  });

  it('notices a release published without its CHANGELOG.md notes', () => {
    const r = check(withRelease((t) => t.replace('          body_path: release-notes.md\n', '')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/release notes must come from CHANGELOG\.md/);
  });

  it('notices a dropped signing step and a needs on an unknown job', () => {
    const r = check(withRelease((t) => t.replace('run: node scripts/azure-signing.mjs', 'run: echo skipped').replace('needs: [checks, build]\n    strategy', 'needs: [checks, bild]\n    strategy')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/lost its signing step \(scripts\/azure-signing\.mjs\)/);
    expect(r.out).toMatch(/needs unknown job bild/);
  });
  // Performance gates, ported from PR #2 (codex/electrical-review-fixes 2f89b0e).
  it('rejects missing performance budgets', () => {
    const r = check(withRelease((t) => t.replace('JCAD_BENCH_ASSERT: 1', 'JCAD_BENCH_ASSERT: 0').replace('run: npm run bench:node', 'run: echo skipped')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/performance budgets must be asserted/);
    expect(r.out).toMatch(/does not run "npm run bench:node"/);
  });
  // Release provenance, ported from PR #2 (codex/electrical-review-fixes 2f89b0e).
  it('rejects publication without source-bound artifact validation or signed provenance', () => {
    const r = check(withRelease((t) => t.replace('run: node scripts/release-provenance.mjs verify artifacts', 'run: echo skipped').replace('uses: actions/attest@v4', 'uses: actions/download-artifact@v4')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/verify all artifacts and sign provenance before publishing/);
  });
  it('rejects missing platform provenance and build steps that continue on error', () => {
    const r = check(withRelease((t) => t.replace('platform: macOS', 'platform: missing').replace('run: node scripts/azure-signing.mjs', 'run: node scripts/azure-signing.mjs\n        continue-on-error: true')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/missing macOS artifacts\/provenance/);
    expect(r.out).toMatch(/job build step \d+ continues on error/);
  });
  it('rejects Windows signature checks that omit the trusted publisher comparison', () => {
    const r = check(withRelease((t) => t.replace('GetNameInfo', 'IgnoredPublisherName')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Windows signature verification must match the configured updater publisher/);
  });
  it('rejects tag verification that can retain a remotely deleted tag', () => {
    const r = check(withRelease((t) => t.replace('--prune --prune-tags ', '')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/must prune remotely deleted tags/);
  });
});
