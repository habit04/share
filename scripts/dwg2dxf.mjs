#!/usr/bin/env node
// Convert a DWG (R14 .. 2018) to the DXF this application writes:  node scripts/dwg2dxf.mjs in.dwg [out.dxf]
import { readFile, writeFile } from 'node:fs/promises';
import { readDwgPayload } from './dwg-reader.mjs';

const [, , input, output] = process.argv;
if (!input) {
  console.error('usage: node scripts/dwg2dxf.mjs <input.dwg> [output.dxf]');
  process.exit(1);
}
const { convertDwg } = await import('../dist-node/io/dwg.js').catch(() => import('../src/io/dwg.ts'));
const { writeDxf } = await import('../dist-node/io/dxf.js').catch(() => import('../src/io/dxf.ts'));
const bytes = await readFile(input);
const { payload, version } = await readDwgPayload(bytes, input.toLowerCase().endsWith('.dxf') ? 'dxf' : 'dwg');
const { state, skipped } = convertDwg(payload);
const out = output ?? input.replace(/\.dwg$/i, '') + '.dxf';
await writeFile(out, writeDxf(state), 'utf8');
console.log(`${input} (${version || 'unknown version'}): ${state.entities.length} entities, ${state.layers.length} layers, ${Object.keys(state.blocks).length} blocks -> ${out}`);
if (Object.keys(skipped).length) console.log('skipped entity types:', skipped);
