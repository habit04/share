#!/usr/bin/env node
/** Private shore-switch acceptance check. Writes diagnostics only to the explicit --out folder. */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath, stat } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readDwgPayload } from './dwg-reader.mjs';

const DWG_HASH = 'b20e3ec369e01a554ea4591ba75c9256712f5c8ff8f3e83978b73479f46cd919';
const PAYLOAD_HASH = 'ad2df98d6492b638a14a03e7acd6205f66b293d71f95d4a77597f7de17aff17d';
const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const options = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!['--dwg', '--payload', '--out'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options.has(args[i])) {
    throw new Error('Usage: node scripts/verify-dwg-import.mjs --dwg <original.dwg> [--payload <captured.json>] --out <diagnostic-directory>');
  }
  options.set(args[i], resolve(args[i + 1]));
}
if (!options.has('--dwg') || !options.has('--out')) throw new Error('Both --dwg and --out are required.');
const dwg = options.get('--dwg'), captured = options.get('--payload'), out = options.get('--out');
const inputs = [dwg, captured].filter(Boolean);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const key = (path) => process.platform === 'win32' ? path.toLowerCase() : path;
const inputIdentities = new Set();
const inputFiles = new Set();
const fileKey = (info) => `${info.dev}:${info.ino}`;
for (const input of inputs) {
  const info = await stat(input, { bigint: true });
  if (!info.isFile()) throw new Error('Each input must be a regular file.');
  inputFiles.add(fileKey(info));
  inputIdentities.add(key(await realpath(input)));
}
await mkdir(out, { recursive: true });
const realOut = await realpath(out);
for (const name of ['import-check.mjs', 'decoder-log.txt', 'summary.json', 'report.txt']) {
  const dest = resolve(realOut, name);
  let existing;
  try { existing = await realpath(dest); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (inputIdentities.has(key(existing ?? dest)) || existing && inputFiles.has(fileKey(await stat(existing, { bigint: true })))) throw new Error(`Diagnostic output would overwrite an input: ${name}`);
}
const summary = { tool: 'verify-dwg-import', platform: process.platform, node: process.version, startedAt: new Date().toISOString(), inputs: [], checks: [], drawings: [] };
for (const input of inputs) {
  const bytes = await readFile(input);
  summary.inputs.push({ name: basename(input), bytes: bytes.length, sha256Before: hash(bytes) });
}
function check(name, value, detail) {
  summary.checks.push({ name, passed: !!value, ...(detail !== undefined ? { detail } : {}) });
}
let decoderLog = '', omittedLogChars = 0;
const log = (...values) => {
  const text = values.map((x) => String(x)).join(' ') + '\n';
  const remaining = Math.max(0, 1024 * 1024 - decoderLog.length);
  decoderLog += text.slice(0, remaining);
  omittedLogChars += Math.max(0, text.length - remaining);
};
try {
  if (summary.inputs[0].sha256Before !== DWG_HASH) throw new Error('The DWG is not the unchanged private shore-switch fixture.');
  if (captured && summary.inputs[1].sha256Before !== PAYLOAD_HASH) throw new Error('The captured payload does not match the supplied Windows fixture.');
  const importer = resolve(realOut, 'import-check.mjs');
  const entry = [
    "export { convertDwg } from './src/io/dwg.ts';",
    "export { validateGeometryBudget } from './src/core/geometry-budget.ts';",
    "export { entityGeometryWork } from './src/core/entities.ts';",
    "export { countOf, isPartialImport } from './src/io/import-report.ts';",
  ].join('\n');
  await build({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, outfile: importer, bundle: true, platform: 'node', format: 'esm', loader: { '.jhf': 'text' }, logLevel: 'silent' });
  const api = await import(pathToFileURL(importer).href);
  const evaluate = (payload, source) => {
    const start = performance.now();
    const { state, report, skipped } = api.convertDwg(payload, basename(dwg));
    api.validateGeometryBudget(state);
    const signature = state.entities.find((e) => e.type === 'insert' && e.block === '杨荐钦 - 签名');
    const block = state.blocks['杨荐钦'];
    const hatches = block?.entities.filter((e) => e.type === 'hatch') ?? [];
    const texts = state.entities.filter((e) => e.type === 'text');
    const labels = ['出口美国项目', '江苏亚威变压器有限公司', '2026.10.15', '系统图'];
    check(`${source}: signature retained`, !!signature && hatches.length === 2);
    check(`${source}: no dropped TEXT`, (report?.counts.TEXT?.dropped ?? 0) === 0);
    check(`${source}: standalone attribute-definition limits disclosed`, report?.counts.ATTDEF?.dropped === 4);
    check(`${source}: restored labels and alignment`, labels.every((text) => texts.some((e) => e.text === text && e.justification?.horizontal === 4 && e.justification?.vertical === 2)));
    check(`${source}: no excluded block references`, (report?.counts.INSERT?.dropped ?? 0) === 0);
    summary.drawings.push({ source, elapsedMs: Math.round(performance.now() - start), modelEntities: state.entities.length, blockDefinitions: Object.keys(state.blocks).length, signaturePresent: !!signature, signatureHatches: hatches.length, signatureHatchWork: hatches.reduce((n, e) => n + api.entityGeometryWork(e), 0), skipped, partialImport: api.isPartialImport(state), reportCounts: report?.counts ?? {}, reportNotes: report?.notes ?? [], nativeMetadata: payload.nativeMetadata ? { schemaVersion: payload.nativeMetadata.schemaVersion, complete: payload.nativeMetadata.complete, readError: payload.nativeMetadata.readError, writeError: payload.nativeMetadata.writeError, notes: payload.nativeMetadata.notes } : null });
  };
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  let decoded;
  try {
    console.log = log; console.warn = log; console.error = log;
    decoded = await readDwgPayload(await readFile(dwg));
  } finally { Object.assign(console, originalConsole); }
  evaluate(decoded.payload, `fresh ${process.platform} reader`);
  if (captured) evaluate(JSON.parse(await readFile(captured, 'utf8')).payload, 'captured Windows payload');
} catch (error) {
  check('verification completed', false, error instanceof Error ? error.message : String(error));
} finally {
  for (let i = 0; i < inputs.length; i += 1) {
    summary.inputs[i].sha256After = hash(await readFile(inputs[i]));
    check(`${summary.inputs[i].name}: unchanged`, summary.inputs[i].sha256After === summary.inputs[i].sha256Before);
  }
  summary.finishedAt = new Date().toISOString();
  summary.passed = summary.checks.length > 0 && summary.checks.every((c) => c.passed);
  summary.limits = ['Standalone production reader/converter only; installed IPC/UI, font rendering, AutoCAD and DWG round-trip require separate checks.', 'A partial-import report may remain for genuinely unsupported metadata or substituted appearance.'];
  await writeFile(resolve(realOut, 'decoder-log.txt'), decoderLog + (omittedLogChars ? `\n[${omittedLogChars} decoder-log characters omitted after 1 MiB; native status and notes are in summary.json.]\n` : ''));
  await writeFile(resolve(realOut, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  const lines = [`JCad private DWG acceptance — ${summary.platform}, Node ${summary.node}`, ...summary.checks.map((c) => `${c.passed ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? `: ${c.detail}` : ''}`), '', ...summary.limits];
  await writeFile(resolve(realOut, 'report.txt'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}
process.exitCode = summary.passed ? 0 : 1;
