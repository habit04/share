// Validates the GitHub Actions workflows (.github/workflows/*.yml) before they reach GitHub:
// every file parses as YAML (js-yaml), has `on` and `jobs`, every job has `runs-on` and steps that
// `uses` or `run` something, every `needs` names a job of the same workflow, and the release
// pipeline keeps its gates (docs/RELEASE.md): installers are built only after the checks passed,
// from the checked commit, smoke-tested as packaged applications, and published last, with the
// tag's CHANGELOG.md section as the release notes.
//
//   npm run check:workflows        exit 1 with a list of problems
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, matchesGlob } from 'node:path';
import yaml from 'js-yaml';

const dir = resolve(process.argv[2] || join(import.meta.dirname, '..', '.github', 'workflows'));
const problems = [];
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
/** @type {Record<string, any>} */
const parsed = {};

for (const f of files) {
  /** @type {any} */
  let doc;
  try {
    doc = yaml.load(readFileSync(join(dir, f), 'utf8'));
  } catch (err) {
    problems.push(`${f}: not valid YAML: ${err.message.split('\n')[0]}`);
    continue;
  }
  parsed[f] = doc;
  if (!doc || typeof doc !== 'object') {
    problems.push(`${f}: empty`);
    continue;
  }
  if (!doc.name) problems.push(`${f}: no name`);
  // js-yaml (YAML 1.2) keeps the key `on` as a string; YAML 1.1 parsers would read it as true.
  if (!('on' in doc) && !('true' in doc)) problems.push(`${f}: no "on" trigger`);
  const jobs = doc.jobs;
  if (!jobs || typeof jobs !== 'object' || Object.keys(jobs).length === 0) {
    problems.push(`${f}: no jobs`);
    continue;
  }
  for (const [id, job] of Object.entries(jobs)) {
    if (!job || typeof job !== 'object') {
      problems.push(`${f}: job ${id} is empty`);
      continue;
    }
    if (job.uses) continue; // reusable workflow call
    if (!job['runs-on']) problems.push(`${f}: job ${id} has no runs-on`);
    if (!Array.isArray(job.steps) || job.steps.length === 0) problems.push(`${f}: job ${id} has no steps`);
    else
      job.steps.forEach((s, i) => {
        if (!s || (typeof s.uses !== 'string' && typeof s.run !== 'string')) problems.push(`${f}: job ${id} step ${i + 1} has neither uses nor run`);
        if (s && typeof s.uses === 'string' && !/@[\w.-]+$/.test(s.uses) && !s.uses.startsWith('./')) problems.push(`${f}: job ${id} step ${i + 1} uses ${s.uses} without a version`);
      });
    const needs = job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];
    for (const n of needs) if (!(n in jobs)) problems.push(`${f}: job ${id} needs unknown job ${n}`);
  }
}

// ------------------------------------------------------------------ release pipeline gates
const release = parsed['release.yml'];
if (!release) problems.push('release.yml: missing');
else {
  const jobs = release.jobs ?? {};
  const needsOf = (id) => {
    const n = jobs[id]?.needs;
    return n === undefined ? [] : Array.isArray(n) ? n : [n];
  };
  const runs = (id) => (jobs[id]?.steps ?? []).map((s) => String(s.run ?? '')).join('\n');
  const matrixNodes = jobs.checks?.strategy?.matrix?.node;
  if (!Array.isArray(matrixNodes) || ![22, 24].every((node) => matrixNodes.includes(node))) problems.push('release.yml: checks must test both Node 22 and 24');
  if (!jobs.checks) problems.push('release.yml: no "checks" job');
  else {
    for (const cmd of ['npm run lint', 'npm run typecheck:all', 'npm test', 'npm run build', 'npm run ui-check', 'npm run screenshot:compare', 'npm run e2e', 'npm run e2e:origin', 'npm run bench:node', 'npm run bench:project'])
      if (!runs('checks').includes(cmd)) problems.push(`release.yml: the checks job does not run "${cmd}"`);
    if (!jobs.checks.outputs?.sha) problems.push('release.yml: the checks job does not output the tested commit (sha)');
    const browserBench = (jobs.checks.steps ?? []).find((s) => /\bnpm run bench\s*$/.test(String(s.run ?? '')));
    if (!browserBench || String(browserBench.env?.JCAD_BENCH_ASSERT) !== '1') problems.push('release.yml: browser performance budgets must be asserted');
    const projectBench = (jobs.checks.steps ?? []).find((s) => String(s.run ?? '').trim() === 'npm run bench:project');
    if (!projectBench || String(projectBench.env?.JCAD_BENCH_ASSERT) !== '1') problems.push('release.yml: filesystem project performance budgets must be asserted');
  }
  for (const id of Object.keys(jobs)) {
    if (id === 'checks') continue;
    if (!needsOf(id).includes('checks') && !needsOf(id).some((n) => needsOf(n).includes('checks'))) problems.push(`release.yml: job ${id} does not depend on the checks job`);
  }
  if (!needsOf('build').includes('checks')) problems.push('release.yml: build must need checks');
  const checkoutRef = (id) => (jobs[id]?.steps ?? []).find((s) => String(s.uses ?? '').startsWith('actions/checkout'))?.with?.ref;
  for (const id of ['test-build', 'build', 'verify-artifacts', 'packaged-smoke', 'release'])
    if (jobs[id] && checkoutRef(id) !== '${{ needs.checks.outputs.sha }}') problems.push(`release.yml: job ${id} must check out the tested commit (needs.checks.outputs.sha)`);
  if (!jobs['packaged-smoke']) problems.push('release.yml: no "packaged-smoke" job');
  else if (!runs('packaged-smoke').includes('scripts/packaged-smoke.mjs')) problems.push('release.yml: packaged-smoke does not run scripts/packaged-smoke.mjs');
  const smokeInstall = (jobs['packaged-smoke']?.steps ?? []).find((s) => String(s.run ?? '').trim() === 'npm ci');
  if (String(smokeInstall?.env?.ELECTRON_SKIP_BINARY_DOWNLOAD) === '1') problems.push('release.yml: packaged origin migration needs the stock Electron binary for legacy seeding');
  for (const step of (jobs['packaged-smoke']?.steps ?? []).filter((s) => String(s.run ?? '').includes('scripts/packaged-smoke.mjs'))) {
    if (String(step.env?.JCAD_SMOKE_REQUIRE_SHIPPING) !== '1') problems.push('release.yml: shipping smoke must require disabled inspection fuses and fixed runtime probes');
  }
  if (!jobs['test-build'] || !runs('test-build').includes('npm run dist:test') || !runs('test-build').includes('npm run e2e:test-build') || !needsOf('test-build').includes('checks') || !needsOf('build').includes('test-build')) problems.push('release.yml: shipping builds must wait for the dedicated inspection-enabled test-build suite');
  const requiredSigning = jobs.build?.env?.REQUIRE_PUBLISHER_SIGNING;
  if (requiredSigning !== "${{ startsWith(github.ref, 'refs/tags/v') || github.event.inputs.tag != '' || github.event.inputs.require_signing == 'true' }}" || !runs('build').includes('scripts/check-apple-signing.mjs')) problems.push('release.yml: publication and required-signing rehearsals must fail closed on missing publisher credentials');
  if (!jobs['verify-artifacts']) problems.push('release.yml: no "verify-artifacts" job');
  else {
    const gate = jobs['verify-artifacts'];
    for (const n of ['checks', 'build']) if (!needsOf('verify-artifacts').includes(n)) problems.push(`release.yml: verify-artifacts must need ${n}`);
    if (gate.if) problems.push('release.yml: verify-artifacts must also run for empty-tag build-only dispatches');
    const steps = gate.steps ?? [];
    const download = steps.findIndex((s) => String(s.uses ?? '').startsWith('actions/download-artifact') && s.with?.path === 'artifacts' && s.with?.pattern === 'JCad-Electrical-*');
    const verify = steps.findIndex((s) => /scripts\/release-provenance\.mjs verify artifacts\b/.test(String(s.run ?? '')) && s.env?.SOURCE_SHA === '${{ needs.checks.outputs.sha }}');
    if (download < 0 || verify <= download) problems.push('release.yml: verify-artifacts must download all platform assets and verify them against the tested source SHA');
    for (const s of [steps[download], steps[verify]]) if (s?.if) problems.push('release.yml: aggregate artifact download and verification must not be conditionally skipped');
  }
  if (!jobs.release) problems.push('release.yml: no "release" job');
  else {
    for (const n of ['checks', 'test-build', 'build', 'packaged-smoke', 'verify-artifacts']) if (!needsOf('release').includes(n)) problems.push(`release.yml: release must need ${n}`);
    if (!runs('release').includes('needs.checks.outputs.sha') && !(jobs.release.steps ?? []).some((s) => JSON.stringify(s.env ?? {}).includes('needs.checks.outputs.sha')))
      problems.push('release.yml: release does not verify the tag against the tested commit');
    if (!/git fetch\b[^\n]*--prune-tags\b/.test(runs('release'))) problems.push('release.yml: release must prune remotely deleted tags before verifying the tested commit');
    const publish = (jobs.release.steps ?? []).find((s) => String(s.uses ?? '').startsWith('softprops/action-gh-release'));
    if (!publish) problems.push('release.yml: release does not publish with action-gh-release');
    else {
      if (publish.with?.target_commitish !== '${{ needs.checks.outputs.sha }}') problems.push('release.yml: the release must target the tested commit');
      // The release body comes from CHANGELOG.md (an empty release page is what 0.4.0 got).
      const notes = (jobs.release.steps ?? []).findIndex((s) => /scripts\/release-notes\.mjs\b.*--out release-notes\.md/.test(String(s.run ?? '')));
      if (notes < 0 || publish.with?.body_path !== 'release-notes.md') problems.push('release.yml: the release notes must come from CHANGELOG.md (scripts/release-notes.mjs --out release-notes.md, body_path: release-notes.md)');
      else if (notes > (jobs.release.steps ?? []).indexOf(publish)) problems.push('release.yml: the release notes are written after the release is published');
      const steps = jobs.release.steps ?? [];
      const verify = steps.findIndex((s) => /scripts\/release-provenance\.mjs verify artifacts\b/.test(String(s.run ?? '')) && s.env?.SOURCE_SHA === '${{ needs.checks.outputs.sha }}');
      const attest = steps.findIndex((s) => String(s.uses ?? '').startsWith('actions/attest@') && s.with?.['subject-path'] === 'artifacts/**/*');
      if (verify < 0 || attest <= verify || attest >= steps.indexOf(publish)) problems.push('release.yml: verify all artifacts and sign provenance before publishing');
      if (!String(steps[verify]?.run ?? '').includes('--notes release-notes.md')) problems.push('release.yml: release notes must state verified artifact signing status');
      for (const permission of ['id-token', 'attestations', 'artifact-metadata']) if (jobs.release.permissions?.[permission] !== 'write') problems.push(`release.yml: missing ${permission} permission for signed provenance`);
      if (!steps.some((s) => String(s.run ?? '').includes('artifacts/release-provenance.sigstore.json'))) problems.push('release.yml: publish the signed provenance bundle');
      if (publish.with?.fail_on_unmatched_files !== true) problems.push('release.yml: publishing must fail on unmatched artifact files');
      for (const s of [steps[verify], steps[attest], publish]) if (s?.if) problems.push('release.yml: artifact verification, attestation and publication must not be conditionally skipped');
    }
  }
  // A gate is only a gate when a failed dependency stops the dependants: no job may run on
  // `always()` / `!cancelled()` / `failure()`, and no step of the checks job may continue on error.
  for (const [id, job] of Object.entries(jobs)) {
    if (/\b(always|cancelled|failure)\s*\(/.test(String(job?.if ?? ''))) problems.push(`release.yml: job ${id} runs even when a job it needs failed (if: ${job.if})`);
    if (job && job['continue-on-error']) problems.push(`release.yml: job ${id} continues on error`);
  }
  for (const id of ['checks', 'test-build', 'build', 'verify-artifacts', 'packaged-smoke', 'release'])
    (jobs[id]?.steps ?? []).forEach((s, i) => {
      if (s && s['continue-on-error']) problems.push(`release.yml: job ${id} step ${i + 1} continues on error`);
      if (s && /\b(always|failure)\s*\(/.test(String(s.if ?? '')) && typeof s.run === 'string') problems.push(`release.yml: job ${id} step ${i + 1} runs a command on always() / failure()`);
    });
  // The signing steps stay in place (docs/CODE-SIGNING.md).
  const buildRuns = JSON.stringify(jobs.build ?? {});
  for (const marker of ['scripts/azure-signing.mjs', 'Get-AuthenticodeSignature', 'HAS_APPLE', 'xcrun stapler validate'])
    if (!buildRuns.includes(marker)) problems.push(`release.yml: the build job lost its signing step (${marker})`);
  const windowsSignature = (jobs.build?.steps ?? []).find((s) => String(s.run ?? '').includes('Get-AuthenticodeSignature'));
  if (windowsSignature?.env?.AZURE_PUBLISHER_NAME !== '${{ secrets.AZURE_PUBLISHER_NAME }}' || !String(windowsSignature?.run ?? '').includes('GetNameInfo') || !String(windowsSignature?.run ?? '').includes('[System.StringComparison]::Ordinal'))
    problems.push('release.yml: Windows signature verification must match the configured updater publisher');
  const platforms = jobs.build?.strategy?.matrix?.include ?? [];
  for (const platform of ['Windows', 'macOS', 'Linux']) if (!platforms.some((entry) => entry.platform === platform && String(entry.glob ?? '').includes('provenance.json'))) problems.push(`release.yml: missing ${platform} artifacts/provenance`);
  for (const platform of ['Windows', 'macOS', 'Linux']) {
    const globs = String(platforms.find((entry) => entry.platform === platform)?.glob ?? '').trim().split(/\r?\n/).map((pattern) => pattern.trim());
    const updates = { Windows: ['latest.yml', 'installer.exe.blockmap'], macOS: ['latest-mac.yml', 'installer.dmg.blockmap'], Linux: ['latest-linux.yml', 'installer.AppImage.blockmap'] }[platform];
    if (!updates.every((name) => globs.some((pattern) => matchesGlob(`release/${name}`, pattern)))) problems.push(`release.yml: ${platform} upload must include updater metadata and blockmaps`);
  }
  const record = (jobs.build?.steps ?? []).findIndex((s) => /scripts\/release-provenance\.mjs build release\b/.test(String(s.run ?? '')) && s.env?.SOURCE_SHA === '${{ needs.checks.outputs.sha }}');
  const upload = (jobs.build?.steps ?? []).findIndex((s) => String(s.uses ?? '').startsWith('actions/upload-artifact'));
  if (record < 0 || upload <= record) problems.push('release.yml: record built SHA and checksums before uploading artifacts');
}

if (problems.length) {
  console.error(`check-workflows: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`check-workflows: ${files.length} workflow(s) OK (${files.join(', ')})`);
