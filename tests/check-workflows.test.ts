import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

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

type SmokeRow = { os: string; arch: string; artifact: string };
type SmokeJob = {
  if?: string | boolean;
  'runs-on': string;
  'timeout-minutes': number;
  needs: string[];
  strategy: { matrix: { include: SmokeRow[]; exclude?: SmokeRow[] } };
  steps: { if?: string | boolean; run?: string; uses?: string; shell?: string; env?: Record<string, string | number>; with?: Record<string, string> }[];
};

function withSmoke(edit: (job: SmokeJob) => void): string {
  return withRelease((text) => {
    const workflow = yaml.load(text) as { jobs: { 'packaged-smoke': SmokeJob } };
    edit(workflow.jobs['packaged-smoke']);
    return yaml.dump(workflow);
  });
}

function withHelper(edit: (workflow: any, job: any) => void): string {
  return withRelease(text => {
    const workflow = yaml.load(text) as any;
    edit(workflow, workflow.jobs['native-helper']);
    return yaml.dump(workflow);
  });
}

function withCi(edit: (workflow: any) => void): string {
  const dir = mkdtempSync(join(scratch, 'ci-'));
  cpSync(join(root, '.github', 'workflows'), dir, { recursive: true });
  const file = join(dir, 'ci.yml');
  const workflow = yaml.load(readFileSync(file, 'utf8')) as any;
  edit(workflow);
  writeFileSync(file, yaml.dump(workflow));
  return dir;
}

describe('accepted native metadata fixture workflow', () => {
  it.each(['missing gate', 'skip condition', 'continue on error', 'no Node 24', 'excluded Node 24', 'missing reports'])('rejects %s', change => {
    const result = check(withCi(workflow => {
      const job = workflow.jobs.test;
      const gate = job.steps.find((step: any) => step.run?.includes('validate-vendored-metadata.mjs'));
      if (change === 'missing gate') gate.run = 'echo skipped';
      else if (change === 'skip condition') gate.if = false;
      else if (change === 'continue on error') gate['continue-on-error'] = true;
      else if (change === 'no Node 24') job.strategy.matrix.node = [22];
      else if (change === 'excluded Node 24') job.strategy.matrix.exclude = [{ node: 24 }];
      else job.steps.find((step: any) => step.with?.name === 'native-metadata-fixtures').with.path = 'absent/';
    }));
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/native metadata/);
  });
});

describe('unpublished Windows CI test-ASAR workflow', () => {
  it.each(['missing', 'skip', 'continue', 'SHA', 'deadline', 'order', 'reports'])('rejects weakening the %s packaged boundary', change => {
    const result = check(withCi(workflow => {
      const steps = workflow.jobs['e2e-electron'].steps;
      const gate = steps.find((step: any) => step.run === 'node scripts/check-ci-test-asar.mjs');
      if (change === 'missing') gate.run = 'echo skipped';
      else if (change === 'skip') gate.if = false;
      else if (change === 'continue') gate['continue-on-error'] = true;
      else if (change === 'SHA') gate.env.JCAD_TEST_ASAR_EXPECTED_SHA = '${{ github.ref }}';
      else if (change === 'deadline') gate['timeout-minutes'] = 60;
      else if (change === 'order') { steps.splice(steps.indexOf(gate), 1); steps.unshift(gate); }
      else steps.find((step: any) => step.with?.name === 'ci-test-asar-${{ matrix.os }}').with.path = 'absent/';
    }));
    expect(result.code).toBe(1); expect(result.out).toMatch(/test-ASAR/);
  });
});

describe('signed native-helper build-only workflow', () => {
  it('requires an explicit manual input, read-only permissions and exact SHA metadata without entering publication', () => {
    const workflow = yaml.load(readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')) as any;
    expect(workflow.on.workflow_dispatch.inputs.native_helper_only).toMatchObject({ type: 'boolean', required: false, default: false });
    const helper = workflow.jobs['native-helper'];
    expect(helper.if).toBe("github.event_name == 'workflow_dispatch' && github.event.inputs.native_helper_only == 'true'");
    expect(helper.permissions).toEqual({ contents: 'read' });
    expect(helper.env).toMatchObject({ REQUIRE_PUBLISHER_SIGNING: 'true', SOURCE_SHA: '${{ github.sha }}', TAG: '${{ github.event.inputs.tag }}' });
    expect(workflow.jobs.checks.if).toBe("github.event_name != 'workflow_dispatch' || github.event.inputs.native_helper_only != 'true'");
    expect(workflow.jobs.release.if).toContain("github.event.inputs.native_helper_only != 'true'");
    expect(workflow.jobs.release.needs).toContain('checks');
    expect(helper.steps.find((step: any) => step.uses?.startsWith('actions/upload-artifact')).with.path).toBe('release/dwg-writer/\nelectron/dwg-writer-integrity.json\nnative-helper-provenance.json\n');
  });
  it.each(['default', 'trigger', 'PR trigger', 'permissions', 'signing', 'SHA'])('rejects weakening the helper-only %s boundary', change => {
    const result = check(withHelper((workflow, job) => {
      if (change === 'default') workflow.on.workflow_dispatch.inputs.native_helper_only.default = true;
      else if (change === 'trigger') job.if = 'always()';
      else if (change === 'PR trigger') workflow.on.pull_request_target = {};
      else if (change === 'permissions') job.permissions.contents = 'write';
      else if (change === 'signing') job.env.REQUIRE_PUBLISHER_SIGNING = 'false';
      else job.env.SOURCE_SHA = '${{ github.ref }}';
    }));
    expect(result.code).toBe(1); expect(result.out).toMatch(/helper/);
  });
  it.each(['ref', 'credentials', 'empty tag', 'commit check'])('rejects losing the helper %s binding before signing', change => {
    const result = check(withHelper((_workflow, job) => {
      const checkout = job.steps.find((step: any) => step.uses?.startsWith('actions/checkout'));
      const validate = job.steps.find((step: any) => step.run?.includes('native_helper_only requires an empty tag'));
      if (change === 'ref') checkout.with.ref = '${{ github.ref }}';
      else if (change === 'credentials') checkout.with['persist-credentials'] = true;
      else if (change === 'empty tag') validate.run = validate.run.replace('if ($env:TAG)', 'if ($false)');
      else validate.run = validate.run.replace('$actual -ne $env:SOURCE_SHA', '$false');
    }));
    expect(result.code).toBe(1); expect(result.out).toMatch(/helper/);
  });
  it('rejects compiling/sealing before tests, pinned toolchain or signing configuration', () => {
    const result = check(withHelper((_workflow, job) => {
      const steps = job.steps, build = steps.findIndex((step: any) => step.run === 'npm run build:dwg-writer'), signing = steps.findIndex((step: any) => step.run === 'node scripts/azure-signing.mjs');
      [steps[build], steps[signing]] = [steps[signing], steps[build]];
    }));
    expect(result.code).toBe(1); expect(result.out).toMatch(/seal, verify and upload in order/);
  });
  it.each(['tests', 'toolchain', 'verify', 'conditional build', 'continue on error', 'embedded manifest', 'publication'])('rejects bypassing the helper %s gate', change => {
    const result = check(withHelper((_workflow, job) => {
      if (change === 'tests') job.steps.find((step: any) => step.run?.includes('vitest.mjs run')).run = 'echo skipped';
      else if (change === 'toolchain') job.steps.find((step: any) => step.run?.includes('rustup toolchain')).run = 'rustup toolchain install stable';
      else if (change === 'verify') job.steps.find((step: any) => step.run === 'node scripts/check-signed-dwg-writer.mjs').run = 'echo skipped';
      else if (change === 'conditional build') job.steps.find((step: any) => step.run === 'npm run build:dwg-writer').if = false;
      else if (change === 'continue on error') job.steps.find((step: any) => step.run === 'npm run build:dwg-writer')['continue-on-error'] = true;
      else if (change === 'embedded manifest') job.steps.find((step: any) => step.uses?.startsWith('actions/upload-artifact')).with.path = 'release/dwg-writer/';
      else job.steps.push({ uses: 'softprops/action-gh-release@v2' });
    }));
    expect(result.code).toBe(1); expect(result.out).toMatch(/helper/);
  });
  it.each(['checks', 'release'])('rejects removing the helper-only separation from %s', job => {
    const result = check(withHelper((workflow, _helper) => {
      workflow.jobs[job].if = job === 'checks' ? undefined : "startsWith(github.ref, 'refs/tags/v') || (github.event_name == 'workflow_dispatch' && github.event.inputs.tag != '')";
    }));
    expect(result.code).toBe(1); expect(result.out).toMatch(/helper-only/);
  });
});

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

  it('rejects removing the native DWG memory containment gate', () => {
    const r = check(withRelease((text) => text.replaceAll('npm run check:dwg-containment', 'node -e "process.exit(0)"')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/must run the DWG containment gate on every target platform/);
  });

  it('notices a build that no longer waits for the checks', () => {
    const r = check(withRelease((t) => t.replace('  build:\n    needs: [checks, test-build]\n', '  build:\n')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/build must need checks/);
  });

  it('notices a release that no longer waits for the packaged smoke test or checks the tag', () => {
    const r = check(withRelease((t) => t.replace('needs: [checks, test-build, build, packaged-smoke, verify-artifacts]', 'needs: [checks, build]').replace('target_commitish: ${{ needs.checks.outputs.sha }}', 'target_commitish: ${{ github.sha }}')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/release must need packaged-smoke/);
    expect(r.out).toMatch(/must target the tested commit/);
  });

  it('notices a release that runs on always(), and a checks step that continues on error', () => {
    const r = check(withRelease((t) => t.replace(/ {4}if: github.event.inputs.native_helper_only != 'true' && .*\n/, '    if: always()\n').replace('      - run: npm test\n', '      - run: npm test\n        continue-on-error: true\n')));
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
    const r = check(withRelease((t) => t.replaceAll('run: node scripts/azure-signing.mjs', 'run: echo skipped').replace('needs: [checks, test-build]\n    strategy', 'needs: [checks, bild]\n    strategy')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/lost its signing step \(scripts\/azure-signing\.mjs\)/);
    expect(r.out).toMatch(/needs unknown job bild/);
  });
  it('rejects missing performance budgets and a lost supported Node version', () => {
    const r = check(withRelease((t) => t.replace('node: [22, 24]', 'node: [22]').replaceAll('JCAD_BENCH_ASSERT: 1', 'JCAD_BENCH_ASSERT: 0').replace('run: npm run bench:node', 'run: echo skipped')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/both Node 22 and 24/);
    expect(r.out).toMatch(/performance budgets must be asserted/);
    expect(r.out).toMatch(/does not run "npm run bench:node"/);
  });
  it('rejects publication without source-bound artifact validation or signed provenance', () => {
    const r = check(withRelease((t) => t.replace('run: node scripts/release-provenance.mjs verify artifacts', 'run: echo skipped').replace('uses: actions/attest@v4', 'uses: actions/download-artifact@v4')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/verify all artifacts and sign provenance before publishing/);
  });
  it('rejects omitting the portable writer build or moving it after ASAR packing', () => {
    const missing = check(withRelease((text) => text.replaceAll('run: npm run build:dwg-writer', 'run: echo skipped')));
    expect(missing.code).toBe(1);
    expect(missing.out).toMatch(/build and seal the pinned portable DWG writer/);
    const reordered = check(withRelease((text) => {
      const workflow = yaml.load(text) as { jobs: { build: { steps: { run?: string }[] } } };
      const steps = workflow.jobs.build.steps;
      const helper = steps.findIndex((step) => step.run === 'npm run build:dwg-writer');
      const pack = steps.findIndex((step) => step.run?.startsWith('npx electron-builder'));
      [steps[helper], steps[pack]] = [steps[pack]!, steps[helper]!];
      return yaml.dump(workflow);
    }));
    expect(reordered.code).toBe(1);
    expect(reordered.out).toMatch(/build and seal the pinned portable DWG writer/);
  });
  it('rejects dropping the helper from the publisher signature gate', () => {
    const r = check(withRelease((text) => text.replace('$installers + $applications + $helpers', '$installers + $applications')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/native DWG helper signature/);
  });
  it('rejects generating release notes before artifact verification', () => {
    const r = check(withRelease((text) => {
      const workflow = yaml.load(text) as { jobs: { release: { steps: { run?: string }[] } } };
      const steps = workflow.jobs.release.steps;
      const verify = steps.findIndex((step) => step.run?.includes('scripts/release-provenance.mjs verify artifacts'));
      const notes = steps.findIndex((step) => step.run?.includes('scripts/release-notes.mjs'));
      [steps[verify], steps[notes]] = [steps[notes]!, steps[verify]!];
      return yaml.dump(workflow);
    }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/release notes must consume the verified aggregate after source-bound artifact verification/);
  });
  it.each([
    ['a raw macOS record', '--provenance artifacts/release-provenance.json', '--provenance artifacts/JCad-Electrical-macOS/JCad-Electrical-macOS-provenance.json'],
    ['an unverified artifact folder', '--provenance artifacts/release-provenance.json', '--provenance artifacts'],
    ['a missing changelog section', '"$TAG" --strict --provenance artifacts/release-provenance.json', '"$TAG" --provenance artifacts/release-provenance.json'],
  ])('rejects release notes rendered from %s', (_label, before, after) => {
    const r = check(withRelease((text) => text.replace(before, after)));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/release notes must consume the verified aggregate after source-bound artifact verification/);
  });
  it('rejects appending a second signing summary during artifact verification', () => {
    const r = check(withRelease((text) => text.replace('run: node scripts/release-provenance.mjs verify artifacts --policy windows-only --require-signing\n      # A tag', 'run: node scripts/release-provenance.mjs verify artifacts --policy windows-only --require-signing --notes release-notes.md\n      # A tag')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/render the verified signing summary once, from the aggregate/);
  });
  it('rejects conditionally skipping status-aware release notes', () => {
    const r = check(withRelease((text) => text.replace('      - name: Release notes from CHANGELOG.md and verified provenance\n', '      - name: Release notes from CHANGELOG.md and verified provenance\n        if: false\n')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/release notes.*must not be conditionally skipped/);
  });
  it('rejects missing platform provenance and build steps that continue on error', () => {
    const r = check(withRelease((t) => t.replace('platform: Windows', 'platform: missing').replaceAll('run: node scripts/azure-signing.mjs', 'run: node scripts/azure-signing.mjs\n        continue-on-error: true')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/missing Windows artifacts\/provenance/);
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

  it('rejects packaged migration without its stock Electron seeding runtime', () => {
    const r = check(withRelease((t) => t.replace('# The application comes from the installer; stock Electron seeds the legacy origin test profile.\n      - run: npm ci\n        env:\n', '# The application comes from the installer; stock Electron seeds the legacy origin test profile.\n      - run: npm ci\n        env:\n          ELECTRON_SKIP_BINARY_DOWNLOAD: 1\n')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/needs the stock Electron binary for legacy seeding/);
  });

  it('requires the native Windows installer with unchanged shipping gates and deadlines', () => {
    const workflow = yaml.load(readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')) as { jobs: { 'packaged-smoke': SmokeJob; release: { needs: string[] } } };
    const smoke = workflow.jobs['packaged-smoke'];
    expect(smoke.strategy.matrix.include).toEqual([
      { os: 'windows-latest', arch: 'x64', artifact: 'JCad-Electrical-Windows' },
    ]);
    expect(smoke['runs-on']).toBe('${{ matrix.os }}');
    expect(smoke['timeout-minutes']).toBe(30);
    expect(smoke.if).toBeUndefined();
    expect(smoke.steps.find((step) => step.uses?.startsWith('actions/download-artifact'))?.with?.name).toBe('${{ matrix.artifact }}');
    for (const step of smoke.steps.filter((entry) => entry.run?.includes('scripts/packaged-smoke.mjs'))) {
      expect(String(step.env?.JCAD_SMOKE_REQUIRE_SHIPPING)).toBe('1');
      expect(String(step.env?.JCAD_SMOKE_NATIVE_ONLY)).toBe('1');
      expect(step.env?.JCAD_SMOKE_EXPECT_ARCH).toBe('${{ matrix.arch }}');
    }
    expect(workflow.jobs.release.needs).toContain('packaged-smoke');
  });

  it.each(['windows-latest'])('rejects removing the mandatory %s packaged smoke entry', (os) => {
    const r = check(withSmoke((job) => { job.strategy.matrix.include = job.strategy.matrix.include.filter((row) => row.os !== os); }));
    expect(r.code).toBe(1);
    expect(r.out).toContain(`packaged-smoke must test ${os}/`);
  });

  it.each(['runner', 'architecture', 'artifact'])('rejects substituting the native Windows smoke %s', (field) => {
    const r = check(withSmoke((job) => {
      const intel = job.strategy.matrix.include.find((row) => row.os === 'windows-latest')!;
      if (field === 'runner') intel.os = 'macos-15';
      else if (field === 'architecture') intel.arch = 'arm64';
      else intel.artifact = 'JCad-Electrical-macOS';
    }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('packaged-smoke must test windows-latest/x64 with JCad-Electrical-Windows exactly once');
  });

  it.each(['job condition', 'matrix exclusion', 'runner override'])('rejects bypassing the native smoke matrix through a %s', (change) => {
    const r = check(withSmoke((job) => {
      if (change === 'job condition') job.if = false;
      else if (change === 'matrix exclusion') job.strategy.matrix.exclude = [{ ...job.strategy.matrix.include[0]! }];
      else job['runs-on'] = 'macos-15';
    }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/all native packaged smoke matrix entries must run unconditionally on their specified runner/);
  });

  it.each(['native only', 'expected architecture'])('rejects removing the runtime %s assertion', (change) => {
    const r = check(withSmoke((job) => {
      const step = job.steps.find((entry) => entry.run === 'node scripts/packaged-smoke.mjs installers')!;
      if (change === 'native only') delete step.env!.JCAD_SMOKE_NATIVE_ONLY;
      else step.env!.JCAD_SMOKE_EXPECT_ARCH = 'x64';
    }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/packaged smoke must require native installers and assert the matrix architecture/);
  });

  it('rejects skipping the Windows runtime smoke step', () => {
    const r = check(withSmoke((job) => { job.steps.find((entry) => entry.run === 'node scripts/packaged-smoke.mjs installers')!.if = false; }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/packaged smoke must run unconditionally on Windows/);
  });

  it.each(['missing', 'conditional', 'wrong shell', 'wrong source', 'after smoke'])('rejects an AutoCAD absence inventory that is %s', (change) => {
    const r = check(withSmoke((job) => {
      const index = job.steps.findIndex((entry) => entry.run?.includes('scripts/check-no-autocad.ps1'));
      const step = job.steps[index]!;
      if (change === 'missing') job.steps.splice(index, 1);
      else if (change === 'conditional') step.if = false;
      else if (change === 'wrong shell') step.shell = 'bash';
      else if (change === 'wrong source') step.env!.SOURCE_SHA = '${{ github.sha }}';
      else { job.steps.splice(index, 1); job.steps.push(step); }
    }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/unconditional source-bound AutoCAD absence inventory must run immediately before installed Windows smoke/);
  });

  it.each(['wrong artifact', 'conditional download'])('rejects a %s for packaged smoke', (change) => {
    const r = check(withSmoke((job) => {
      const step = job.steps.find((entry) => entry.uses?.startsWith('actions/download-artifact'))!;
      if (change === 'wrong artifact') step.with!.name = 'JCad-Electrical-macOS';
      else step.if = false;
    }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/packaged smoke must download its matrix artifact unconditionally into installers/);
  });

  it('keeps publication disabled for empty-tag dispatches while aggregate verification is unconditional', () => {
    const workflow = yaml.load(readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')) as {
      on: { workflow_dispatch: { inputs: { tag: { default: string } } } };
      jobs: Record<string, { if?: string; needs?: string[]; steps: { if?: string; run?: string }[] }>;
    };
    expect(workflow.on.workflow_dispatch.inputs.tag.default).toBe('');
    expect(workflow.jobs.release?.if).toBe("github.event.inputs.native_helper_only != 'true' && (startsWith(github.ref, 'refs/tags/v') || (github.event_name == 'workflow_dispatch' && github.event.inputs.tag != ''))");
    expect(workflow.jobs['verify-artifacts']?.if).toBeUndefined();
    expect(workflow.jobs['verify-artifacts']?.steps.every((step) => step.if === undefined)).toBe(true);
    expect(workflow.jobs.release?.needs).toContain('verify-artifacts');
  });

  it('rejects aggregate verification hidden behind the publication tag guard', () => {
    const r = check(withRelease((t) => t.replace('  verify-artifacts:\n', "  verify-artifacts:\n    if: github.event.inputs.tag != ''\n")));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/verify-artifacts must also run for empty-tag build-only dispatches/);
  });

  it('rejects publication that no longer depends on aggregate verification', () => {
    const r = check(withRelease((t) => t.replace('needs: [checks, test-build, build, packaged-smoke, verify-artifacts]', 'needs: [checks, test-build, build, packaged-smoke]')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/release must need verify-artifacts/);
  });

  it('rejects aggregate verification without downloaded assets, tested source binding or failure propagation', () => {
    const r = check(withRelease((t) => t.replace('  verify-artifacts:\n    needs: [checks, build]', '  verify-artifacts:\n    needs: [checks]').replace('      - name: Verify all uploaded assets against the tested source SHA\n        env:\n          SOURCE_SHA: ${{ needs.checks.outputs.sha }}\n        run: node scripts/release-provenance.mjs verify artifacts', '      - name: Verify all uploaded assets against the tested source SHA\n        continue-on-error: true\n        env:\n          SOURCE_SHA: ${{ github.sha }}\n        run: node scripts/release-provenance.mjs verify artifacts').replace('pattern: JCad-Electrical-*', 'pattern: JCad-Electrical-Windows')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/verify-artifacts must need build/);
    expect(r.out).toMatch(/verify-artifacts must download all platform assets and verify them against the tested source SHA/);
    expect(r.out).toMatch(/job verify-artifacts step \d+ continues on error/);
  });

  it('rejects dropping Windows installer blockmaps or updater metadata from the upload', () => {
    const r = check(withRelease((t) => t.replace('release/*.exe\n              release/*.blockmap\n              release/latest*.yml', 'release/*.exe')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Windows upload must include its installers, updater metadata and blockmaps/);
  });
  it('rejects bypassing the dedicated test-build gate or allowing legacy inspection smoke for shipping', () => {
    const r = check(withRelease((t) => t.replace('needs: [checks, test-build]\n    strategy', 'needs: [checks]\n    strategy').replace('JCAD_SMOKE_REQUIRE_SHIPPING: 1', 'JCAD_SMOKE_REQUIRE_SHIPPING: 0')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/shipping builds must wait for the dedicated inspection-enabled test-build suite/);
    expect(r.out).toMatch(/shipping smoke must require disabled inspection fuses/);
  });
  it('rejects losing the fail-closed publication signing requirement', () => {
    const r = check(withRelease((t) => t.replace("REQUIRE_PUBLISHER_SIGNING: ${{ startsWith(github.ref, 'refs/tags/v') || github.event.inputs.tag != '' || github.event.inputs.require_signing == 'true' }}", 'REQUIRE_PUBLISHER_SIGNING: false')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/publication and required-signing rehearsals must fail closed/);
  });
  it.each(['verify-artifacts', 'release'])('rejects missing explicit Windows-only provenance policy in %s', (job) => {
    const r = check(withRelease((source) => {
      const workflow = yaml.load(source) as { jobs: Record<string, { steps: { run?: string }[] }> };
      const verify = workflow.jobs[job]!.steps.find((step) => step.run?.includes('release-provenance.mjs verify'))!;
      verify.run = verify.run!.replace(' --policy windows-only', '');
      return yaml.dump(workflow);
    }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/verify.*artifacts/);
  });
  it.each(['checks', 'test-build', 'packaged-smoke'])('fetches stock Electron outside %s launch deadlines', (job) => {
    const r = check(withRelease((text) => {
      const workflow = yaml.load(text) as { jobs: Record<string, { steps: { run?: string }[] }> };
      workflow.jobs[job]!.steps = workflow.jobs[job]!.steps.filter((step) => step.run !== 'node node_modules/electron/install.js');
      return yaml.dump(workflow);
    }));
    expect(r.code).toBe(1);
    expect(r.out).toContain(`job ${job} must fetch the Electron binary before test launches`);
  });
  it('rejects publication provenance that allows unsigned Windows evidence', () => {
    const r = check(withRelease((source) => source.replace(' --require-signing', '')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/verify all artifacts and sign provenance before publishing/);
  });
  it('rejects a conditional Windows signing setup', () => {
    const r = check(withRelease((source) => source.replaceAll('        id: signing\n', '        id: signing\n        if: false\n')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Windows signing setup must run unconditionally/);
  });
  it('rejects skipping the actual Windows signature verification', () => {
    const r = check(withRelease((source) => source.replace("if: steps.signing.outputs.enabled == 'true'", 'if: false')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/signature verification must run in order without bypass conditions/);
  });
  it('rejects accidentally restoring additional platform release builds', () => {
    const r = check(withRelease((source) => {
      const workflow = yaml.load(source) as { jobs: { build: { strategy: { matrix: { include: Record<string, string>[] } } } } };
      workflow.jobs.build.strategy.matrix.include.push({ os:'macos-latest', platform:'macOS', target:'--mac dmg' });
      return yaml.dump(workflow);
    }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Windows-only build must contain exactly one unconditional Windows NSIS target/);
  });
});

describe('local test build without the DWG writer', () => {
  it('fails when a workflow builds the test app with dist:test:no-dwg', () => {
    const r = check(withRelease((text) => text.replace('      - run: npm run dist:test\n', '      - run: npm run dist:test:no-dwg\n')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/release\.yml: must not use the local test build without the DWG writer/);
  });

  it('fails when a workflow sets JCAD_TEST_BUILD_WITHOUT_DWG_WRITER', () => {
    const r = check(withRelease((text) => text.replace('      - run: npm run dist:test\n', '      - run: npm run dist:test\n        env:\n          JCAD_TEST_BUILD_WITHOUT_DWG_WRITER: "1"\n')));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/release\.yml: must not use the local test build without the DWG writer/);
  });
});
