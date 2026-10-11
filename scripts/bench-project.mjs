// Actual filesystem reads and first-use DXF preparation for a generated 20-sheet project.
// Files are newly written, so OS disk caches may be warm; this is not a physical cold-disk test.
// Generation/bundling is outside the timings. No user drawings or project files are accessed.
import { build } from 'esbuild';
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { checkProjectBudgets } from './bench-budgets.mjs';

const taskRoot = process.cwd();
const compiled = await build({
  stdin: { contents: `export { Editor } from './src/app/editor'; export { projectDocuments } from './src/app/commands-electrical'; export { bigDrawing } from './tests/helpers/big-drawing'; export { writeDxf } from './src/io/dxf'; export { REPORTS, mergeReports } from './src/electrical/reports';`, resolveDir: taskRoot, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', target: 'node22', loader: { '.jhf': 'text' }, write: false, logLevel: 'silent',
});
// The headless Editor queues no rendering; geometry preparation is measured in bench.mjs.
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
const { Editor, projectDocuments, bigDrawing, writeDxf, REPORTS, mergeReports } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const scratchParent = await realpath(tmpdir());
const scratch = await mkdtemp(join(scratchParent, 'jcad-bench-project-'));
async function cleanScratch() {
  // Verify the resolved scratch target before recursive cleanup on Windows or other platforms.
  const checked = await realpath(scratch);
  if (dirname(checked) !== scratchParent || !basename(checked).startsWith('jcad-bench-project-')) throw new Error('Unexpected project benchmark scratch directory');
  await rm(checked, { recursive: true, force: true });
}
try {
  const paths = [];
  for (let i = 0; i < 20; i += 1) {
    const state = bigDrawing(3000, 600, 300);
    const entities = state.entities.map((entity) => entity.type === 'insert'
      ? { ...entity, attributes: { TAG1: `S${i}-${entity.attributes.TAG1}`, MFG: i % 2 ? 'AB' : 'SIEMENS', CAT: `CAT${i % 5}` } }
      : entity);
    const path = join(scratch, `sheet${String(i + 1).padStart(2, '0')}.dxf`);
    await writeFile(path, writeDxf({ ...state, entities }), 'utf8');
    paths.push(path);
  }
  const canvas = { getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 };
  const editor = new Editor(canvas);
  let diskRead = 0;
  let files = 0;
  let readBytes = 0;
  editor.fileBridge = {
    openDrawing: async (path) => {
      const started = performance.now();
      const bytes = await readFile(path);
      diskRead += performance.now() - started;
      files += 1;
      readBytes += bytes.byteLength;
      return { path, kind: 'dxf', text: bytes.toString('utf8') };
    },
    openDxf: async () => null,
    saveDxf: async () => null,
  };
  editor.project.drawings = paths.map((file) => ({ file }));
  const loadStart = performance.now();
  const drawings = await projectDocuments(editor);
  const prepare = performance.now() - loadStart - diskRead;
  const reportStart = performance.now();
  const reportRows = {};
  for (const definition of REPORTS) {
    const merged = mergeReports(drawings.map((drawing) => ({ drawing: drawing.name, report: definition.build(drawing.doc) })));
    reportRows[definition.key] = merged.rows.length;
  }
  const reports = performance.now() - reportStart;
  const result = { files, drawings: drawings.length, componentRows: reportRows.components, readBytes, diskRead, prepare, reports, total: diskRead + prepare + reports };
  const failures = checkProjectBudgets(result, Number(process.env.JCAD_PERF_FACTOR ?? 1));
  console.log(`project bench: ${files} filesystem reads, ${drawings.length} drawings, ${result.componentRows} components, ${readBytes} bytes`);
  for (const name of ['diskRead', 'prepare', 'reports', 'total']) console.log(`  ${name.padEnd(12)} ${result[name].toFixed(1)} ms`);
  if (process.env.JCAD_BENCH_OUT) {
    const output = resolve(process.env.JCAD_BENCH_OUT);
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'project-bench.json'), JSON.stringify({ ...result, reportRows, filesystemCache: 'newly-written files; OS cache may be warm', node: process.version, platform: `${process.platform} ${process.arch}`, at: new Date().toISOString() }, null, 2));
  }
  // Always fail invalid/incomplete workloads; timing ceilings are enabled in CI explicitly.
  const invalid = failures.filter((failure) => !failure.startsWith('project total:'));
  const enforced = process.env.JCAD_BENCH_ASSERT === '1' ? failures : invalid;
  for (const failure of enforced) console.error(`FAIL project performance: ${failure}`);
  if (enforced.length) process.exitCode = 1;
} finally {
  await cleanScratch();
}
