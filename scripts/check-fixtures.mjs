// Required inputs must fail the suite when missing; private external inputs remain optional (ported
// from PR #2, codex/electrical-review-fixes 2f89b0e). The list: tests/fixtures/manifest.json.
import { readFileSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export function checkFixtures(root, manifest = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/manifest.json'), 'utf8'))) {
  const problems = [];
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) return ['invalid or empty fixture manifest'];
  const seen = new Set();
  for (const name of manifest.files) {
    if (typeof name !== 'string' || !/^(?:fixtures|tests\/fixtures)\//.test(name)) {
      problems.push(`invalid fixture path: ${String(name)}`);
      continue;
    }
    if (seen.has(name)) problems.push(`duplicate fixture: ${name}`);
    seen.add(name);
    const path = resolve(root, name);
    const rel = relative(resolve(root), path);
    if (rel.startsWith('..') || isAbsolute(rel)) { problems.push(`fixture escapes repository: ${name}`); continue; }
    try {
      const info = statSync(path);
      if (!info.isFile() || info.size === 0) problems.push(`empty or non-file fixture: ${name}`);
    } catch { problems.push(`missing required fixture: ${name}`); }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(process.argv[2] || resolve(import.meta.dirname, '..'));
  try {
    const problems = checkFixtures(root);
    if (problems.length) { console.error(`check-fixtures: ${problems.join('\n')}`); process.exitCode = 1; }
    else console.log('check-fixtures: all required committed fixtures present');
  } catch (error) { console.error(`check-fixtures: ${error.message}`); process.exitCode = 1; }
}
