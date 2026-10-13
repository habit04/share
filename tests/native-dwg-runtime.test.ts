import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { NATIVE_SOURCE, verifyNativeRuntime, wasmMemoryLimits } from '../scripts/vendor-native-runtime.mjs';
// @ts-expect-error plain JS reader shared with Electron/CLI, like tests/dwg.test.ts
import { readDwgPayload } from '../scripts/dwg-reader.mjs';
import { convertDwg } from '../src/io/dwg';
import { readDxf, writeDxf } from '../src/io/dxf';
import { validateCadState } from '../src/core/cad-graph';

const root = join(__dirname, '..');
const fixture = join(root, 'tests/fixtures/interchange/r2018-mtext-background.dwg');
const expected = join(root, 'tests/fixtures/interchange/r2018-mtext-background.expected.json');
const header = [0, 97, 115, 109, 1, 0, 0, 0];
const memory = { flags: 1, minPages: 16384, maxPages: 65536, minBytes: 1073741824, maxBytes: 4294967296 };

describe('native WASM declaration inspection', () => {
  it('observes distributed baseline memory without instantiating the module', () => {
    const require = createRequire(import.meta.url);
    const baseline = join(dirname(require.resolve('@mlightcad/libredwg-web')), '../wasm/libredwg-web.wasm');
    expect(wasmMemoryLimits(readFileSync(baseline))).toEqual([{ origin: 'defined', ...memory }]);
  });
  it('reads imported memory and rejects truncated or wasm64 declarations', () => {
    const body = [1, 3, 101, 110, 118, 6, 109, 101, 109, 111, 114, 121, 2, 1, 128, 128, 1, 128, 128, 4];
    expect(wasmMemoryLimits(Uint8Array.from([...header, 2, body.length, ...body]))).toEqual([{ origin: 'import', module: 'env', name: 'memory', ...memory }]);
    expect(() => wasmMemoryLimits(Uint8Array.from([...header, 5, 3, 1, 1, 128]))).toThrow(/Truncated/);
    expect(() => wasmMemoryLimits(Uint8Array.from([...header, 5, 4, 1, 4, 1, 1]))).toThrow(/wasm32/);
  });
  it('refuses absent vendor, source fixture or ground truth instead of skipping', async () => {
    await expect(verifyNativeRuntime('', fixture, expected)).rejects.toThrow(/required/);
    await expect(verifyNativeRuntime(join(root, 'vendor/absent-native-runtime'), fixture, expected)).rejects.toThrow();
  });
  it('requires the new exact repair contract when appearance/arrays are requested', async () => {
    const candidate = mkdtempSync(join(tmpdir(), 'jcad-native-policy-'));
    try {
      const provenance = JSON.parse(readFileSync(join(root, 'vendor/libredwg-web-bg/provenance.json'), 'utf8'));
      provenance.assets = provenance.assets.filter((asset: { path: string }) => !['appearance-report.json', 'validate-appearance-fixture.mjs'].includes(asset.path));
      writeFileSync(join(candidate, 'provenance.json'), JSON.stringify(provenance));
      await expect(verifyNativeRuntime(candidate, fixture, expected, { repairPolicy: 'appearance-arrays' })).rejects.toThrow(/asset contract mismatch/);
    } finally { rmSync(candidate, { recursive: true, force: true }); }
  });
  it('cannot accept an incomplete metadata graph artifact', async () => {
    const candidate = mkdtempSync(join(tmpdir(), 'jcad-native-metadata-policy-'));
    try {
      const provenance = JSON.parse(readFileSync(join(root, 'vendor/libredwg-web-bg/provenance.json'), 'utf8'));
      provenance.assets = provenance.assets.filter((asset: { path: string }) => !['metadata-report.json', 'validate-metadata-fixture.mjs'].includes(asset.path));
      writeFileSync(join(candidate, 'provenance.json'), JSON.stringify(provenance));
      await expect(verifyNativeRuntime(candidate, fixture, expected)).rejects.toThrow(/asset contract mismatch/);
    } finally { rmSync(candidate, { recursive: true, force: true }); }
  });
});

type Mask = { type: string; text?: string; background?: { flags: number; scale: number; color: number | string; trueColor?: number; colorName?: string } };
type Wanted = { text: string; flags: number; scale?: number; color?: number; trueColor?: number; colorName?: string };
function compareMasks(entities: Mask[], wanted: Wanted[]) {
  const masks = entities.filter((entity) => entity.type === 'mtext');
  expect(masks).toHaveLength(7);
  for (const entry of wanted) {
    const text = entry.text.replace(/\\[PN]/g, '\n');
    const actual = masks.find((mask) => mask.text === text);
    expect(actual, entry.text).toBeDefined();
    expect(actual!.background?.flags ?? 0, entry.text).toBe(entry.flags);
    if (entry.scale !== undefined) expect(actual!.background?.scale, entry.text).toBeCloseTo(entry.scale, 10);
    if (entry.color !== undefined) {
      expect(actual!.background?.color, entry.text).toBe(entry.color);
      expect(actual!.background?.trueColor, entry.text + ': ACI must remain ACI').toBeUndefined();
    }
    if (entry.trueColor !== undefined) expect(actual!.background?.trueColor, entry.text).toBe(entry.trueColor);
    if (entry.colorName !== undefined) expect(actual!.background?.colorName, entry.text).toBe(entry.colorName);
  }
}

describe('mandatory repaired native runtime acceptance', () => {
  it('binds the complete vendor artifact to its source, fixture and original memory limits', async () => {
    const verified = await verifyNativeRuntime(join(root, 'vendor/libredwg-web-bg'), fixture, expected);
    expect(verified.source).toEqual(NATIVE_SOURCE);
    expect(verified.repairPolicy).toBe('metadata-graph');
    expect(verified.metadata).toMatchObject({ nativeError: 0, writeError: 0, complete: true, limitedOutputRejected: true });
    expect(verified.appearance).toMatchObject({ cases: [{ kind: 'appearance' }, { kind: 'shipping' }] });
    expect(verified.memory).toEqual({ origin: 'defined', ...memory });
    expect(verified.masks).toHaveLength(7);
    expect(verified.masks.find((mask) => mask.text === 'ACI MASK')?.color).toMatchObject({ index: 256, method: 0xc3, rgb: 0xc3000001 });
    expect(verified.masks.find((mask) => mask.text === 'FILL + FRAME')?.color).toMatchObject({ index: 256, method: 0xc3, rgb: 0xc3000004 });
    expect(verified.masks.find((mask) => mask.text === 'RGB\\PMULTILINE')?.color).toMatchObject({ index: 256, method: 0xc2, rgb: 0xc2123456, name: 'Slate', book_name: 'Example Book' });
  });
  it('imports native masks through the actual Node loader and retains them on DXF roundtrip', async () => {
    const wanted = JSON.parse(readFileSync(expected, 'utf8')).masks as Wanted[];
    const { payload } = await readDwgPayload(readFileSync(fixture));
    const { state } = convertDwg(payload);
    compareMasks(state.entities as unknown as Mask[], wanted);
    compareMasks(readDxf(writeDxf(state)).entities as unknown as Mask[], wanted);
  }, 60_000);
  it.each(['r2018-views-fields', 'r2018-field-object-reference', 'r2018-unicode-metadata'])('joins the real %s DWG metadata by exact source identity', async (name) => {
    const base = join(root, 'tests/fixtures/interchange', name);
    const oracle = JSON.parse(readFileSync(base + '.expected.json', 'utf8')) as {
      records: Array<{ type: string; handle: string }>;
      opaqueStrings?: Array<{ handle: string; code: number; value: string }>;
    };
    const { payload } = await readDwgPayload(readFileSync(base + '.dwg'));
    const { state, report } = convertDwg(payload, 'C:/Drawings/metadata-site.dwg');
    expect(state.cadGraph?.sourceFormat).toBe('DWG');
    expect(report?.counts.CAD_METADATA).toBeUndefined();
    validateCadState(state);
    for (const record of oracle.records) expect(state.cadGraph!.nodes.find(node => node.sourceHandle === record.handle), record.handle).toMatchObject({ type: record.type });
    expect(state.header!.views).toHaveLength(3);
    expect(state.header!.views[2]?.camera).toMatchObject({ direction: { x: 1, y: 2, z: 3 }, target: { z: 12 } });
    expect(state.entities.find(entity => entity.type === 'mtext')?.field).toMatchObject({ native: true, value: expect.stringContaining('metadata-site') });
    const written = writeDxf(state), reopened = readDxf(written);
    validateCadState(reopened);
    expect(writeDxf(readDxf(writeDxf(reopened)))).toBe(writeDxf(reopened));
    for (const literal of oracle.opaqueStrings ?? []) {
      const source = state.cadGraph!.nodes.find(node => node.sourceHandle === literal.handle)!;
      const back = reopened.cadGraph!.nodes.find(node => node.sourceHandle === literal.handle)!;
      expect(source.groups).toContainEqual([literal.code, literal.value]);
      expect(back.groups).toContainEqual([literal.code, literal.value]);
    }
    if (name !== 'r2018-views-fields') {
      const field = state.cadGraph!.nodes.find(node => node.type === 'FIELD' && node.groups.some(([code, value]) => code === 1 && value === 'AcObjProp'))!;
      const objectReferences = field.references!.filter(ref => [330, 331].includes(field.groups[ref.groupIndex]![0]) && ref.role !== 'owner');
      expect(objectReferences).toHaveLength(2);
      for (const reference of objectReferences) expect(state.cadGraph!.nodes.find(node => node.id === reference.target)).toMatchObject({ type: 'LINE', sourceHandle: '18D' });
    }
  }, 60_000);
});
