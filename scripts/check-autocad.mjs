// Optional independent validation with a locally installed, licensed AutoCAD Core Console.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';

const repo = resolve(import.meta.dirname, '..');
const executable = process.env.JCAD_AUTOCAD_CONSOLE || process.argv[2] || 'C:/Program Files/Autodesk/AutoCAD 2027/accoreconsole.exe';
assert.ok(existsSync(executable), 'Set JCAD_AUTOCAD_CONSOLE to an installed AutoCAD accoreconsole executable.');
const output = process.env.JCAD_AUTOCAD_OUT ? resolve(process.env.JCAD_AUTOCAD_OUT) : mkdtempSync(join(tmpdir(), 'jcad-autocad-'));
mkdirSync(output, { recursive: true });
assert.equal(readdirSync(output).length, 0, 'Use a fresh, empty AutoCAD validation output folder.');
const helper = join(output, 'export-helper.mjs');
await build({ entryPoints: [join(repo, 'tests/helpers/autocad-export.ts')], bundle: true, platform: 'node', format: 'esm', loader: { '.jhf': 'text' }, outfile: helper });
execFileSync(process.execPath, [helper, 'export', repo, output], { cwd: repo, windowsHide: true, stdio: 'inherit', timeout: 30_000 });
const cases = JSON.parse(readFileSync(join(output, 'cases.json'), 'utf8'));
const results = [];
for (const [index, test] of cases.entries()) {
  const normalized = join(output, `autocad-${index}.dxf`);
  assert.ok(!existsSync(normalized), 'Use a fresh output folder so AutoCAD never overwrites an existing validation result.');
  const script = join(output, `audit-${index}.scr`);
  writeFileSync(script, `(setvar "FILEDIA" 0)\n_.AUDIT\n_No\n(command "_.DXFOUT" ${JSON.stringify(normalized.replaceAll('\\', '/'))} "16")\n(princ "\\nJCAD_VALIDATION_COMPLETE\\n")\n_.QUIT\n_Yes\n`);
  const result = await new Promise((done, reject) => {
    const child = spawn(executable, ['/i', test.file, '/s', script, '/l', 'en-US', '/isolate', `jcad-validation-${index}`, join(output, `profile-${index}`)], { cwd: output, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error(`AutoCAD exceeded the 60-second limit for case ${index}.`)); }, 60_000);
    const collect = (chunk) => { size += chunk.length; if (size <= 16 * 1024 * 1024) chunks.push(chunk); else child.kill(); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      const bytes = Buffer.concat(chunks), log = bytes.includes(0) ? bytes.toString('utf16le') : bytes.toString('utf8');
      writeFileSync(join(output, `audit-${index}.log`), log);
      done({ source: test.source, exitCode, complete: log.includes('JCAD_VALIDATION_COMPLETE'), rejected: /Invalid or incomplete DXF|drawing discarded|error in drawing file/i.test(log), auditErrors: Number(/Total errors found\s+(\d+)/i.exec(log)?.[1] ?? -1), normalized: existsSync(normalized) });
    });
  });
  results.push(result); console.log(JSON.stringify(result));
}
writeFileSync(join(output, 'autocad-validation.json'), JSON.stringify({ executable, results }, null, 2));
console.log(`AutoCAD validation evidence: ${output}`);
assert.ok(results.every((test) => test.exitCode === 0 && test.complete && !test.rejected && test.auditErrors === 0 && test.normalized), 'AutoCAD rejected an export or found drawing errors; inspect the validation logs.');
execFileSync(process.execPath, [helper, 'check', repo, output], { cwd: repo, windowsHide: true, stdio: 'inherit', timeout: 30_000 });
console.log('AutoCAD accepted all exports without audit errors; reimported entity types/counts match.');
