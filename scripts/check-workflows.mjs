// Validates the GitHub Actions workflows (.github/workflows/*.yml) before they reach GitHub:
// every file parses as YAML (js-yaml), has `on` and `jobs`, every job has `runs-on` and steps that
// `uses` or `run` something, every `needs` names a job of the same workflow, and the release
// pipeline keeps its gates (docs/RELEASE.md): installers are built only after the checks passed,
// from the checked commit, smoke-tested as packaged applications, and published last, with the
// tag's CHANGELOG.md section as the release notes.
//
//   npm run check:workflows        exit 1 with a list of problems
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  if (!jobs.checks) problems.push('release.yml: no "checks" job');
  else {
    for (const cmd of ['npm run lint', 'npm run typecheck:all', 'npm test', 'npm run build', 'npm run ui-check', 'npm run screenshot:compare', 'npm run e2e'])
      if (!runs('checks').includes(cmd)) problems.push(`release.yml: the checks job does not run "${cmd}"`);
    if (!jobs.checks.outputs?.sha) problems.push('release.yml: the checks job does not output the tested commit (sha)');
  }
  for (const id of Object.keys(jobs)) {
    if (id === 'checks') continue;
    if (!needsOf(id).includes('checks') && !needsOf(id).some((n) => needsOf(n).includes('checks'))) problems.push(`release.yml: job ${id} does not depend on the checks job`);
  }
  if (!needsOf('build').includes('checks')) problems.push('release.yml: build must need checks');
  const checkoutRef = (id) => (jobs[id]?.steps ?? []).find((s) => String(s.uses ?? '').startsWith('actions/checkout'))?.with?.ref;
  for (const id of ['build', 'packaged-smoke', 'release'])
    if (jobs[id] && checkoutRef(id) !== '${{ needs.checks.outputs.sha }}') problems.push(`release.yml: job ${id} must check out the tested commit (needs.checks.outputs.sha)`);
  if (!jobs['packaged-smoke']) problems.push('release.yml: no "packaged-smoke" job');
  else if (!runs('packaged-smoke').includes('scripts/packaged-smoke.mjs')) problems.push('release.yml: packaged-smoke does not run scripts/packaged-smoke.mjs');
  if (!jobs.release) problems.push('release.yml: no "release" job');
  else {
    for (const n of ['checks', 'build', 'packaged-smoke']) if (!needsOf('release').includes(n)) problems.push(`release.yml: release must need ${n}`);
    if (!runs('release').includes('needs.checks.outputs.sha') && !(jobs.release.steps ?? []).some((s) => JSON.stringify(s.env ?? {}).includes('needs.checks.outputs.sha')))
      problems.push('release.yml: release does not verify the tag against the tested commit');
    const publish = (jobs.release.steps ?? []).find((s) => String(s.uses ?? '').startsWith('softprops/action-gh-release'));
    if (!publish) problems.push('release.yml: release does not publish with action-gh-release');
    else {
      if (publish.with?.target_commitish !== '${{ needs.checks.outputs.sha }}') problems.push('release.yml: the release must target the tested commit');
      // The release body comes from CHANGELOG.md (an empty release page is what 0.4.0 got).
      const notes = (jobs.release.steps ?? []).findIndex((s) => /scripts\/release-notes\.mjs\b.*--out release-notes\.md/.test(String(s.run ?? '')));
      if (notes < 0 || publish.with?.body_path !== 'release-notes.md') problems.push('release.yml: the release notes must come from CHANGELOG.md (scripts/release-notes.mjs --out release-notes.md, body_path: release-notes.md)');
      else if (notes > (jobs.release.steps ?? []).indexOf(publish)) problems.push('release.yml: the release notes are written after the release is published');
    }
  }
  // A gate is only a gate when a failed dependency stops the dependants: no job may run on
  // `always()` / `!cancelled()` / `failure()`, and no step of the checks job may continue on error.
  for (const [id, job] of Object.entries(jobs)) {
    if (/\b(always|cancelled|failure)\s*\(/.test(String(job?.if ?? ''))) problems.push(`release.yml: job ${id} runs even when a job it needs failed (if: ${job.if})`);
    if (job && job['continue-on-error']) problems.push(`release.yml: job ${id} continues on error`);
  }
  for (const id of ['checks', 'packaged-smoke'])
    (jobs[id]?.steps ?? []).forEach((s, i) => {
      if (s && s['continue-on-error']) problems.push(`release.yml: job ${id} step ${i + 1} continues on error`);
      if (s && /\b(always|failure)\s*\(/.test(String(s.if ?? '')) && typeof s.run === 'string') problems.push(`release.yml: job ${id} step ${i + 1} runs a command on always() / failure()`);
    });
  // The signing steps stay in place (docs/CODE-SIGNING.md).
  const buildRuns = JSON.stringify(jobs.build ?? {});
  for (const marker of ['scripts/azure-signing.mjs', 'Get-AuthenticodeSignature', 'HAS_APPLE', 'xcrun stapler validate'])
    if (!buildRuns.includes(marker)) problems.push(`release.yml: the build job lost its signing step (${marker})`);
}

if (problems.length) {
  console.error(`check-workflows: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`check-workflows: ${files.length} workflow(s) OK (${files.join(', ')})`);
