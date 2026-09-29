// CI wrapper for the visual-review scripts (scripts/screenshot*.mjs): runs each one against the
// built renderer (dist/) or website (site-dist/) and fails when a script exits non-zero or prints
// a page error, a console error, a failed check or an "Unknown command" line. The scripts only
// log those; this makes them gates.
//
//   npm run build && node scripts/build-site.mjs && node e2e/run-screenshots.mjs [name ...]
//
// Screenshots land in screenshots/ (CI uploads that folder as an artifact).
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ALL = [
  { name: 'screenshot', needs: 'dist' },
  { name: 'screenshot-drafting', needs: 'dist' },
  { name: 'screenshot-library', needs: 'dist' },
  { name: 'screenshot-symbol-builder', needs: 'dist' },
  // The offline landing-page capture aborts the GitHub API request on purpose; Chromium logs
  // exactly one "Failed to load resource" console error for it.
  { name: 'screenshot-site', needs: 'site-dist', allow: [{ re: /^CONSOLE Failed to load resource: net::ERR_FAILED$/, max: 1 }] },
];
const BAD = [/^PAGE ERROR\b/, /^CONSOLE\b/, /^FAIL\b/, /Unknown command/, /\bcheck\(s\) failed\b/];

const wanted = process.argv.slice(2);
const scripts = wanted.length ? ALL.filter((s) => wanted.includes(s.name)) : ALL;
mkdirSync('screenshots', { recursive: true });

function run(script) {
  return new Promise((resolve) => {
    const problems = [];
    const allowed = new Map();
    const child = spawn(process.execPath, [join('scripts', `${script.name}.mjs`)], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const scan = (chunk, stream) => {
      stream.write(chunk);
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!BAD.some((re) => re.test(line))) continue;
        const allow = (script.allow ?? []).find((a) => a.re.test(line));
        if (allow) {
          const n = (allowed.get(allow) ?? 0) + 1;
          allowed.set(allow, n);
          if (n <= allow.max) continue;
        }
        problems.push(line);
      }
    };
    child.stdout.on('data', (c) => scan(c, process.stdout));
    child.stderr.on('data', (c) => scan(c, process.stderr));
    const timer = setTimeout(() => {
      problems.push('timed out after 10 minutes');
      child.kill('SIGKILL');
    }, 10 * 60 * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) problems.push(`exit code ${code}`);
      resolve(problems);
    });
  });
}

let failed = 0;
const summary = [];
for (const s of scripts) {
  if (!existsSync(join(s.needs, 'index.html'))) {
    summary.push(`FAIL ${s.name}: ${s.needs}/index.html missing (build first)`);
    failed += 1;
    continue;
  }
  console.log(`\n=== ${s.name}`);
  const t0 = Date.now();
  const problems = await run(s);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (problems.length) {
    failed += 1;
    summary.push(`FAIL ${s.name} (${secs} s):\n${problems.map((p) => `       ${p}`).join('\n')}`);
  } else summary.push(`ok   ${s.name} (${secs} s)`);
}
console.log(`\n${summary.join('\n')}`);
process.exit(failed ? 1 : 0);
