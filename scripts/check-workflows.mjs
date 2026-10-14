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

// The accepted native binary must keep its independent real-file regression gate.
const nativeMetadataJob = parsed['ci.yml']?.jobs?.test;
if (!nativeMetadataJob?.strategy?.matrix?.node?.includes(24) || nativeMetadataJob?.if !== undefined || nativeMetadataJob?.strategy?.matrix?.exclude !== undefined)
  problems.push('ci.yml: native metadata fixtures require an unconditional Node 24 test target');
const nativeMetadataSteps = nativeMetadataJob?.steps ?? [];
const nativeMetadataGates = nativeMetadataSteps.filter(step => /^\s*node scripts\/native-dwg-build\/validate-vendored-metadata\.mjs native-metadata-output\s*$/m.test(String(step.run ?? '')));
if (nativeMetadataGates.length !== 1 || nativeMetadataGates[0].if !== 'matrix.node == 24' || nativeMetadataGates[0]['continue-on-error'] ||
    !/^\s*node --test scripts\/native-dwg-build\/tooling\.test\.mjs scripts\/native-dwg-build\/metadata-tools\.test\.mjs\s*$/m.test(String(nativeMetadataGates[0].run ?? '')))
  problems.push('ci.yml: accepted native metadata fixture and tooling gates must run on Node 24 without bypassing errors');
const nativeMetadataUploads = nativeMetadataSteps.filter(step => String(step.uses ?? '').startsWith('actions/upload-artifact') && step.with?.name === 'native-metadata-fixtures');
if (nativeMetadataUploads.length !== 1 || nativeMetadataUploads[0].if !== 'matrix.node == 24' || nativeMetadataUploads[0].with?.path !== 'native-metadata-output/' || nativeMetadataUploads[0].with?.['if-no-files-found'] !== 'error' || nativeMetadataUploads[0]['continue-on-error'])
  problems.push('ci.yml: native metadata fixtures must retain the actual native proof reports');

// ------------------------------------------------------------------ release pipeline gates
const release = parsed['release.yml'];
if (!release) problems.push('release.yml: missing');
else {
  const jobs = release.jobs ?? {};
  const normalChecksCondition = "github.event_name != 'workflow_dispatch' || github.event.inputs.native_helper_only != 'true'";
  const normalReleaseCondition = "github.event.inputs.native_helper_only != 'true' && (startsWith(github.ref, 'refs/tags/v') || (github.event_name == 'workflow_dispatch' && github.event.inputs.tag != ''))";
  if (jobs.checks?.if !== normalChecksCondition) problems.push('release.yml: ordinary checks must be skipped only for explicit helper-only dispatches');
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
  for (const id of ['checks', 'test-build', 'packaged-smoke']) {
    const steps = jobs[id]?.steps ?? [];
    const fetchElectron = steps.findIndex((s) => /node node_modules\/electron\/install\.js/.test(String(s.run ?? '')));
    const launches = steps.findIndex((s) => /npm run e2e\b|scripts\/packaged-smoke\.mjs/.test(String(s.run ?? '')));
    if (fetchElectron < 0 || launches < 0 || fetchElectron >= launches) problems.push(`release.yml: job ${id} must fetch the Electron binary before test launches`);
  }
  for (const id of Object.keys(jobs)) {
    if (id === 'checks' || id === 'native-helper') continue;
    if (!needsOf(id).includes('checks') && !needsOf(id).some((n) => needsOf(n).includes('checks'))) problems.push(`release.yml: job ${id} does not depend on the checks job`);
  }
  if (!needsOf('build').includes('checks')) problems.push('release.yml: build must need checks');
  const checkoutRef = (id) => (jobs[id]?.steps ?? []).find((s) => String(s.uses ?? '').startsWith('actions/checkout'))?.with?.ref;
  for (const id of ['test-build', 'build', 'verify-artifacts', 'packaged-smoke', 'release'])
    if (jobs[id] && checkoutRef(id) !== '${{ needs.checks.outputs.sha }}') problems.push(`release.yml: job ${id} must check out the tested commit (needs.checks.outputs.sha)`);
  if (!jobs['packaged-smoke']) problems.push('release.yml: no "packaged-smoke" job');
  else if (!runs('packaged-smoke').includes('scripts/packaged-smoke.mjs')) problems.push('release.yml: packaged-smoke does not run scripts/packaged-smoke.mjs');
  const smoke = jobs['packaged-smoke'];
  const smokeRows = smoke?.strategy?.matrix?.include;
  for (const [os, arch, artifact] of [
    ['windows-latest', 'x64', 'JCad-Electrical-Windows'],
  ]) {
    if (!Array.isArray(smokeRows) || smokeRows.filter((row) => row.os === os && row.arch === arch && row.artifact === artifact).length !== 1)
      problems.push(`release.yml: packaged-smoke must test ${os}/${arch} with ${artifact} exactly once`);
  }
  if (smokeRows?.length !== 1) problems.push('release.yml: Windows-only packaged smoke must contain exactly one Windows entry');
  if (smoke?.['runs-on'] !== '${{ matrix.os }}' || smoke?.if !== undefined || smoke?.strategy?.matrix?.exclude !== undefined)
    problems.push('release.yml: all native packaged smoke matrix entries must run unconditionally on their specified runner');
  for (const n of ['checks', 'build']) if (!needsOf('packaged-smoke').includes(n)) problems.push(`release.yml: packaged-smoke must need ${n}`);
  const smokeDownload = (smoke?.steps ?? []).find((s) => String(s.uses ?? '').startsWith('actions/download-artifact'));
  if (smokeDownload?.with?.name !== '${{ matrix.artifact }}' || smokeDownload?.with?.path !== 'installers' || smokeDownload?.if !== undefined)
    problems.push('release.yml: packaged smoke must download its matrix artifact unconditionally into installers');
  const smokeInstall = (jobs['packaged-smoke']?.steps ?? []).find((s) => String(s.run ?? '').trim() === 'npm ci');
  if (String(smokeInstall?.env?.ELECTRON_SKIP_BINARY_DOWNLOAD) === '1') problems.push('release.yml: packaged origin migration needs the stock Electron binary for legacy seeding');
  const smokeSteps = (smoke?.steps ?? []).filter((s) => String(s.run ?? '').includes('scripts/packaged-smoke.mjs'));
  if (smokeSteps.length !== 1 || smokeSteps[0].if !== undefined || String(smokeSteps[0].run ?? '').trim() !== 'node scripts/packaged-smoke.mjs installers')
    problems.push('release.yml: packaged smoke must run unconditionally on Windows');
  const absenceCommand = './scripts/check-no-autocad.ps1 -EvidencePath packaged-smoke-output/no-autocad-inventory.json';
  const smokeAllSteps = smoke?.steps ?? [];
  const absenceSteps = smokeAllSteps.filter((step) => String(step.run ?? '').includes('scripts/check-no-autocad.ps1'));
  if (absenceSteps.length !== 1 || absenceSteps[0].if !== undefined || absenceSteps[0].shell !== 'pwsh' ||
      String(absenceSteps[0].run ?? '').trim() !== absenceCommand || absenceSteps[0].env?.SOURCE_SHA !== '${{ needs.checks.outputs.sha }}' ||
      smokeAllSteps.indexOf(absenceSteps[0]) !== smokeAllSteps.indexOf(smokeSteps[0]) - 1)
    problems.push('release.yml: an unconditional source-bound AutoCAD absence inventory must run immediately before installed Windows smoke and retain its evidence');
  for (const step of smokeSteps) {
    if (String(step.env?.JCAD_SMOKE_REQUIRE_SHIPPING) !== '1') problems.push('release.yml: shipping smoke must require disabled inspection fuses and fixed runtime probes');
    if (String(step.env?.JCAD_SMOKE_NATIVE_ONLY) !== '1' || step.env?.JCAD_SMOKE_EXPECT_ARCH !== '${{ matrix.arch }}')
      problems.push('release.yml: packaged smoke must require native installers and assert the matrix architecture');
  }
  if (!jobs['test-build'] || !runs('test-build').includes('npm run dist:test') || !runs('test-build').includes('npm run e2e:test-build') || !needsOf('test-build').includes('checks') || !needsOf('build').includes('test-build')) problems.push('release.yml: shipping builds must wait for the dedicated inspection-enabled test-build suite');
  const requiredSigning = jobs.build?.env?.REQUIRE_PUBLISHER_SIGNING;
  if (requiredSigning !== "${{ startsWith(github.ref, 'refs/tags/v') || github.event.inputs.tag != '' || github.event.inputs.require_signing == 'true' }}" || !runs('build').includes('scripts/azure-signing.mjs')) problems.push('release.yml: publication and required-signing rehearsals must fail closed on missing publisher credentials');
  if (!jobs['verify-artifacts']) problems.push('release.yml: no "verify-artifacts" job');
  else {
    const gate = jobs['verify-artifacts'];
    for (const n of ['checks', 'build']) if (!needsOf('verify-artifacts').includes(n)) problems.push(`release.yml: verify-artifacts must need ${n}`);
    if (gate.if) problems.push('release.yml: verify-artifacts must also run for empty-tag build-only dispatches');
    const steps = gate.steps ?? [];
    const download = steps.findIndex((s) => String(s.uses ?? '').startsWith('actions/download-artifact') && s.with?.path === 'artifacts' && s.with?.pattern === 'JCad-Electrical-*');
    const verify = steps.findIndex((s) => /scripts\/release-provenance\.mjs verify artifacts --policy windows-only(?: --require-signing)?\s*$/.test(String(s.run ?? '')) && s.env?.SOURCE_SHA === '${{ needs.checks.outputs.sha }}');
    if (download < 0 || verify <= download) problems.push('release.yml: verify-artifacts must download all platform assets and verify them against the tested source SHA');
    for (const s of [steps[download], steps[verify]]) if (s?.if) problems.push('release.yml: aggregate artifact download and verification must not be conditionally skipped');
  }
  if (!jobs.release) problems.push('release.yml: no "release" job');
  else {
    for (const n of ['checks', 'test-build', 'build', 'packaged-smoke', 'verify-artifacts']) if (!needsOf('release').includes(n)) problems.push(`release.yml: release must need ${n}`);
    if (jobs.release.if !== normalReleaseCondition) problems.push('release.yml: publication must remain disabled for empty-tag build-only and helper-only dispatches');
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
      const download = steps.findIndex((s) => String(s.uses ?? '').startsWith('actions/download-artifact') && s.with?.path === 'artifacts' && s.with?.pattern === 'JCad-Electrical-*');
      const verify = steps.findIndex((s) => /scripts\/release-provenance\.mjs verify artifacts --policy windows-only --require-signing\s*$/.test(String(s.run ?? '')) && s.env?.SOURCE_SHA === '${{ needs.checks.outputs.sha }}');
      const attest = steps.findIndex((s) => String(s.uses ?? '').startsWith('actions/attest@') && s.with?.['subject-path'] === 'artifacts/**/*');
      if (verify < 0 || attest <= verify || attest >= steps.indexOf(publish)) problems.push('release.yml: verify all artifacts and sign provenance before publishing');
      if (download < 0 || verify <= download || notes <= verify || !/--provenance artifacts\/release-provenance\.json\b/.test(String(steps[notes]?.run ?? '')) || !/--strict\b/.test(String(steps[notes]?.run ?? '')))
        problems.push('release.yml: release notes must consume the verified aggregate after source-bound artifact verification');
      if (steps.some((step) => /scripts\/release-provenance\.mjs verify artifacts\b/.test(String(step.run ?? '')) && /--notes\b/.test(String(step.run ?? '')))) problems.push('release.yml: render the verified signing summary once, from the aggregate');
      for (const permission of ['id-token', 'attestations', 'artifact-metadata']) if (jobs.release.permissions?.[permission] !== 'write') problems.push(`release.yml: missing ${permission} permission for signed provenance`);
      if (!steps.some((s) => String(s.run ?? '').includes('artifacts/release-provenance.sigstore.json'))) problems.push('release.yml: publish the signed provenance bundle');
      if (publish.with?.fail_on_unmatched_files !== true) problems.push('release.yml: publishing must fail on unmatched artifact files');
      for (const s of [steps[download], steps[verify], steps[notes], steps[attest], publish]) if (s && s.if !== undefined) problems.push('release.yml: artifact download, verification, release notes, attestation and publication must not be conditionally skipped');
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
  // Windows publisher verification is mandatory for every public release.
  const buildRuns = JSON.stringify(jobs.build ?? {});
  for (const marker of ['scripts/azure-signing.mjs', 'Get-AuthenticodeSignature'])
    if (!buildRuns.includes(marker)) problems.push(`release.yml: the build job lost its signing step (${marker})`);
  const signingStep = (jobs.build?.steps ?? []).find((s) => String(s.run ?? '').trim() === 'node scripts/azure-signing.mjs');
  if (signingStep?.id !== 'signing' || signingStep?.if !== undefined) problems.push('release.yml: Windows signing setup must run unconditionally before the installer build');
  const windowsSignature = (jobs.build?.steps ?? []).find((s) => String(s.run ?? '').includes('Get-AuthenticodeSignature'));
  const buildSteps = jobs.build?.steps ?? [];
  const packageIndex = buildSteps.findIndex((s) => String(s.run ?? '').trim() === 'npx electron-builder ${{ matrix.target }} --publish never' && s.if === undefined);
  const writerIndex = buildSteps.findIndex((s) => String(s.run ?? '').trim() === 'npm run build:dwg-writer' && s.if === undefined);
  const rustIndex = buildSteps.findIndex((s) => String(s.run ?? '').includes('rustup toolchain install 1.99.0-x86_64-pc-windows-gnu --profile minimal') && s.if === undefined);
  if (rustIndex < 0 || writerIndex <= rustIndex || writerIndex <= buildSteps.indexOf(signingStep) || writerIndex >= packageIndex)
    problems.push('release.yml: build and seal the pinned portable DWG writer after signing setup and before ASAR packing');
  if (packageIndex < 0 || buildSteps.indexOf(signingStep) >= packageIndex || buildSteps.indexOf(windowsSignature) <= packageIndex || windowsSignature?.if !== "steps.signing.outputs.enabled == 'true'")
    problems.push('release.yml: Windows publisher setup, installer build and signature verification must run in order without bypass conditions');
  if (windowsSignature?.env?.AZURE_PUBLISHER_NAME !== '${{ secrets.AZURE_PUBLISHER_NAME }}' || !String(windowsSignature?.run ?? '').includes('GetNameInfo') || !String(windowsSignature?.run ?? '').includes('[System.StringComparison]::Ordinal'))
    problems.push('release.yml: Windows signature verification must match the configured updater publisher');
  if (!String(windowsSignature?.run ?? '').includes('resources/dwg-writer/JcadDwgWriter.exe') || !String(windowsSignature?.run ?? '').includes('$installers + $applications + $helpers'))
    problems.push('release.yml: verify the native DWG helper signature together with the app and installer');
  const platforms = jobs.build?.strategy?.matrix?.include ?? [];
  if (platforms.length !== 1 || platforms[0]?.os !== 'windows-latest' || platforms[0]?.platform !== 'Windows' || platforms[0]?.target !== '--win nsis' || platforms[0]?.artifact !== 'JCad-Electrical-Windows' || jobs.build?.['runs-on'] !== '${{ matrix.os }}' || jobs.build?.strategy?.matrix?.exclude !== undefined || jobs.build?.if !== undefined) problems.push('release.yml: Windows-only build must contain exactly one unconditional Windows NSIS target');
  for (const platform of ['Windows']) if (!platforms.some((entry) => entry.platform === platform && String(entry.glob ?? '').includes('provenance.json'))) problems.push(`release.yml: missing ${platform} artifacts/provenance`);
  for (const platform of ['Windows']) {
    const globs = String(platforms.find((entry) => entry.platform === platform)?.glob ?? '').trim().split(/\r?\n/).map((pattern) => pattern.trim());
    const wanted = { Windows: ['latest.yml', 'installer.exe', 'installer.exe.blockmap'], macOS: ['latest-mac.yml', 'installer.dmg', 'installer.dmg.blockmap'], Linux: ['latest-linux.yml', 'installer.AppImage', 'installer.deb'] }[platform];
    if (!wanted.every((name) => globs.some((pattern) => matchesGlob(`release/${name}`, pattern)))) problems.push(`release.yml: ${platform} upload must include its installers, updater metadata and blockmaps`);
  }
  const record = (jobs.build?.steps ?? []).findIndex((s) => /scripts\/release-provenance\.mjs build release\b/.test(String(s.run ?? '')) && s.env?.SOURCE_SHA === '${{ needs.checks.outputs.sha }}');
  const upload = (jobs.build?.steps ?? []).findIndex((s) => String(s.uses ?? '').startsWith('actions/upload-artifact'));
  if (record < 0 || upload <= record) problems.push('release.yml: record built SHA and checksums before uploading artifacts');

  // A signed helper rehearsal uses the existing workflow identity, but cannot enter publication.
  const helperInput = release.on?.workflow_dispatch?.inputs?.native_helper_only;
  if (helperInput?.type !== 'boolean' || helperInput?.required !== false || helperInput?.default !== false)
    problems.push('release.yml: helper-only dispatch must be an optional boolean defaulting to false');
  if (release.on?.pull_request !== undefined || release.on?.pull_request_target !== undefined)
    problems.push('release.yml: signed helper credentials must never be exposed through PR triggers');
  const helper = jobs['native-helper'];
  const helperSteps = helper?.steps ?? [];
  if (helper?.if !== "github.event_name == 'workflow_dispatch' && github.event.inputs.native_helper_only == 'true'" || helper?.['runs-on'] !== 'windows-latest' || helper?.needs !== undefined)
    problems.push('release.yml: signed native helper must run independently only for explicit manual helper-only dispatches on Windows');
  if (JSON.stringify(helper?.permissions) !== JSON.stringify({ contents: 'read' }) || helper?.env?.REQUIRE_PUBLISHER_SIGNING !== 'true' || helper?.env?.SOURCE_SHA !== '${{ github.sha }}' || helper?.env?.TAG !== '${{ github.event.inputs.tag }}')
    problems.push('release.yml: signed helper must require publisher signing, read-only GitHub permissions and dispatched SHA/tag binding');
  const helperCheckout = helperSteps.find(step => String(step.uses ?? '').startsWith('actions/checkout'));
  if (helperCheckout?.with?.ref !== '${{ github.sha }}' || helperCheckout?.with?.['persist-credentials'] !== false)
    problems.push('release.yml: signed helper must check out the exact dispatched SHA without persisted credentials');
  const requestIndex = helperSteps.findIndex(step => String(step.run ?? '').includes("if ($env:TAG) { throw 'native_helper_only requires an empty tag") && String(step.run ?? '').includes('git rev-parse HEAD') && String(step.run ?? '').includes('$actual -ne $env:SOURCE_SHA'));
  const sourceTests = helperSteps.findIndex(step => String(step.run ?? '').includes('node_modules/vitest/vitest.mjs run tests/dwg-writer-build.test.ts tests/dwg-writer-signing.test.ts tests/portable-dwg-host.test.ts tests/check-workflows.test.ts tests/signed-dwg-writer-verification.test.ts'));
  const helperRust = helperSteps.findIndex(step => String(step.run ?? '').includes('rustup toolchain install 1.99.0-x86_64-pc-windows-gnu --profile minimal'));
  const helperSigning = helperSteps.findIndex(step => String(step.run ?? '').trim() === 'node scripts/azure-signing.mjs' && step.id === 'signing');
  const helperBuild = helperSteps.findIndex(step => String(step.run ?? '').trim() === 'npm run build:dwg-writer');
  const helperVerify = helperSteps.findIndex(step => String(step.run ?? '').trim() === 'node scripts/check-signed-dwg-writer.mjs' && step.env?.AZURE_PUBLISHER_NAME === '${{ secrets.AZURE_PUBLISHER_NAME }}');
  const helperUpload = helperSteps.findIndex(step => String(step.uses ?? '').startsWith('actions/upload-artifact'));
  if (requestIndex < 0 || sourceTests <= requestIndex || helperRust <= sourceTests || helperSigning <= helperRust || helperBuild <= helperSigning || helperVerify <= helperBuild || helperUpload <= helperVerify)
    problems.push('release.yml: validate helper-only empty tag/SHA, test source, pin toolchain, configure publisher, seal, verify and upload in order');
  const bundleUpload = helperSteps[helperUpload];
  if (bundleUpload?.with?.name !== 'signed-native-dwg-writer-${{ github.sha }}' || bundleUpload?.with?.['if-no-files-found'] !== 'error' || String(bundleUpload?.with?.path ?? '').trim() !== 'release/dwg-writer/\nelectron/dwg-writer-integrity.json\nnative-helper-provenance.json')
    problems.push('release.yml: helper upload must include the signed bundle, exact embedded integrity manifest and source provenance');
  for (const [index, step] of helperSteps.entries()) {
    if (step.if !== undefined || step['continue-on-error']) problems.push(`release.yml: signed helper step ${index + 1} must not bypass failure propagation`);
    if (/action-gh-release|actions\/attest/.test(String(step.uses ?? '')) || /(?:\bgh\s+release\b|\bgit\s+(?:push|tag)\b|\belectron-builder\b|release-provenance\.mjs|release-notes\.mjs)/.test(String(step.run ?? '')))
      problems.push('release.yml: helper-only job cannot package installers, tag or publish a release');
  }

}

// Native Windows gates and generic Linux source validation remain required.
const containmentTargets = /** @type {Array<[string, string, boolean]>} */ ([
  ['ci.yml', 'e2e-electron', false],
  ['release.yml', 'checks', true],
  ['release.yml', 'test-build', false],
  ['release.yml', 'packaged-smoke', false],
]);
for (const [file, job, linuxOnly] of containmentTargets) {
  const steps = parsed[file]?.jobs?.[job]?.steps ?? [];
  const matching = steps.filter((step) => /\bnpm run check:dwg-containment\s*$/.test(String(step.run ?? '')));
  const expected = linuxOnly ? [[undefined, 'xvfb-run -a npm run check:dwg-containment']] : [[undefined, 'npm run check:dwg-containment']];
  for (const [condition, command] of expected) {
    if (matching.filter((step) => step.if === condition && String(step.run ?? '').trim() === command && !step['continue-on-error']).length !== 1)
      problems.push(`${file}: ${job} must run the DWG containment gate on every target platform`);
  }
}

for (const [file, id] of [['ci.yml', 'e2e-electron'], ['release.yml', 'test-build']]) {
  const job = parsed[file]?.jobs?.[id];
  if (JSON.stringify(job?.strategy?.matrix) !== JSON.stringify({ os: ['windows-latest'] }) || job?.['runs-on'] !== '${{ matrix.os }}' || job?.if !== undefined)
    problems.push(`${file}: ${id} must run exactly the Windows desktop target unconditionally`);
}
const manualSmoke = parsed['packaged-smoke.yml']?.jobs?.smoke;
if (JSON.stringify(manualSmoke?.strategy?.matrix?.include) !== JSON.stringify([{ os:'windows-latest', patterns:'*.exe' }])) problems.push('packaged-smoke.yml: existing-release checks must target only Windows installers');

if (problems.length) {
  console.error(`check-workflows: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`check-workflows: ${files.length} workflow(s) OK (${files.join(', ')})`);
