/**
 * Realistic 3D fixtures (milestone 6): an electrical enclosure, a cable tray and the demo schematic
 * with solids beside it, built by tests/helpers/model3d-fixtures.ts with the in-process kernel and
 * committed as DXF under tests/fixtures/3d/.
 *
 * - The original files remain pinned. Fresh builder bytes use the verified current 2D foundation;
 *   their decoded geometry/history/styles must exactly equal the original inputs. Imported native
 *   handles, typed carrier/follower links and opaque records are checked before identity is ignored
 *   when comparing independently built documents.
 * - Reading them back gives the expected solids: counts, ids, closed meshes, analytic volumes.
 * - Pure 3D rewrites remain byte-identical; the mixed fixture permits only the qualified native
 *   text defaults and INSERT-owner corrections, retaining every original handle and other pair.
 *   All three reach an exact second-save byte fixed point. Fixture CRLF stays pinned by -text.
 * - The 2D entities of the mixed fixture come back exactly as they do without the solids.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareDrawingTransition, validateDrawingState, type DrawingState } from '../src/core/document';
import { canonicalCadHandle, cadEntityLists } from '../src/core/cad-graph';
import type { Entity } from '../src/core/entities';
import { createHash } from 'node:crypto';
import { prepareDrawingState } from '../src/core/geometry-budget';
import { withoutUnusedLibraryBlocks } from '../src/electrical/library';
import { readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf } from '../src/io/import-report';
import { ManifoldDirectKernel } from '../src/model3d/kernel/manifold-direct';
import { meshIsClosed, meshTriangleCount, meshVolume, weldVertices } from '../src/model3d/mesh';
import { EMPTY_MODEL3D, withModel3D } from '../src/model3d/model';
import type { Solid3D } from '../src/model3d/types';
import { textStylesOf } from '../src/io/encoding';
import { namedDimStyles } from '../src/core/dimension';
import {
  ENCLOSURE, FIXTURE_LAYERS, MODEL3D_FIXTURES, TRAY, componentHeight, fixturePath, fixtureState, hasPilotLight, ngonArea, stateWithSolids,
  trayArea, type Model3DFixtureName,
} from './helpers/model3d-fixtures';

const WRITE = process.env.JCAD_WRITE_3D_FIXTURES === '1';
const MAX_FIXTURE_BYTES = 2 * 1024 * 1024;
// Original incoming fixtures are unchanged. Builder hashes were qualified against exact
// decoded model/2D data and the pre-integration fccba52 source, not regenerated fixture files.
const FIXTURE_HASHES: Readonly<Record<Model3DFixtureName, readonly [string, string]>> = {
  enclosure: ['29f9ed9142659bf7cb83c570574f0d57877afa6c8de8dc9a2be0ad0c3079bf8f', '52d285982ac82da3793d24613d322815d2f4f6ea3342347c3cb423bf34296787'],
  'cable-tray': ['974b7f75ae0a91774e1ec02505b6c3ca50ef0b50b459f9453c89c7c76353facc', 'f27baf1817acca08ae74fe5d8958b08c5b453ca323df05f0ad241a8edae8164c'],
  'schematic-with-solids': ['563f0b8a2ebd16106b253343f9e30802107c5f3a7bd0af3c48e93e75f91fff41', '4fe636f51a4212cfcb5a75cb0430e44de41cc24be9af99d8ff2fd324709f7024'],
};
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const kernel = new ManifoldDirectKernel();
afterAll(() => kernel.dispose());

/**
 * The demo schematic (src/app/demo.ts) seeded into a headless editor, as Save writes it (unused
 * library blocks left out) and Open reads it back: the 2D drawing a user would add solids to.
 */
async function demoSchematic(): Promise<DrawingState> {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame ??= () => 1;
  g.cancelAnimationFrame ??= () => {};
  const { Editor } = await import('../src/app/editor');
  const { seedDemoDrawing } = await import('../src/app/demo');
  const ed = new Editor({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }) } as unknown as HTMLCanvasElement);
  seedDemoDrawing(ed);
  return readDxf(writeDxf(withoutUnusedLibraryBlocks(ed.doc.snapshot)));
}

const built = new Map<Model3DFixtureName, string>();
let schematic: DrawingState;

beforeAll(async () => {
  schematic = await demoSchematic();
  for (const name of MODEL3D_FIXTURES) built.set(name, writeDxf(await fixtureState(name, kernel, schematic)));
  if (WRITE) {
    mkdirSync('tests/fixtures/3d', { recursive: true });
    for (const [name, text] of built) writeFileSync(fixturePath(name), text);
  }
}, 60_000);

const read = (name: Model3DFixtureName): { text: string; state: DrawingState } => {
  const text = readFileSync(fixturePath(name), 'utf8');
  return { text, state: readDxf(text, { model3d: true }) };
};
const solidsOf = (s: DrawingState): readonly Solid3D[] => s.model3d?.solids ?? [];
const byId = (s: DrawingState, id: string): Solid3D => {
  const found = solidsOf(s).find((x) => x.id === id);
  if (!found) throw new Error(`no solid ${id}`);
  return found;
};
const closeTo = (actual: number, expected: number, rel: number) => expect(Math.abs(actual - expected) / expected).toBeLessThan(rel);

/** Independent raw record inventory: no modeled Entity projection can hide a missing source. */
function nativeRecords(text: string): Map<string, { type: string; groups: [number, string][] }> {
  const lines = text.replace(/\r/g, '').split('\n'), records: { type: string; groups: [number, string][]; section: string }[] = [];
  let section = '';
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]!.trim()), value = lines[i + 1]!;
    if (code === 0) { records.push({ type: value, groups: [], section }); continue; }
    const record = records.at(-1)!; record.groups.push([code, value]);
    if (record.type === 'SECTION' && code === 2 && record.groups.length === 1) { section = value; record.section = value; }
  }
  const result = new Map<string, { type: string; groups: [number, string][] }>();
  for (const record of records) if (record.section !== 'HEADER') {
    const handle = record.groups.find(([code]) => code === 5 || code === 105)?.[1];
    if (!handle) continue;
    const key = canonicalCadHandle(handle);
    expect(result.has(key), `duplicate native handle ${key}`).toBe(false); result.set(key, record);
  }
  return result;
}

function verifiedState(text: string): DrawingState {
  const state = readDxf(text, { model3d: true, recordInventory: () => {} }), graph = state.cadGraph!, native = nativeRecords(text);
  validateDrawingState(state);
  expect(graph).toBeDefined();
  const nodes = new Map(graph.nodes.map(node => [node.id, node])), handles = graph.nodes.flatMap(node => node.sourceHandle ? [canonicalCadHandle(node.sourceHandle)] : []);
  handles.push(...(graph.generatedHandles ?? []).map(hint => canonicalCadHandle(hint.handle)));
  expect(handles.sort()).toEqual([...native.keys()].sort());
  for (const node of graph.nodes) {
    if (node.sourceHandle) expect(native.get(canonicalCadHandle(node.sourceHandle))?.type).toBe(node.type);
    for (const reference of node.references ?? []) if (reference.target) {
      const target = nodes.get(reference.target)!; expect(target).toBeDefined();
      if (target.sourceHandle) expect(canonicalCadHandle(node.groups[reference.groupIndex]![1].trim())).toBe(canonicalCadHandle(target.sourceHandle));
    }
  }
  const used = new Set<string>();
  for (const kind of ['solid3d', 'dimension3d'] as const) for (const object of kind === 'solid3d' ? state.model3d?.solids ?? [] : state.model3d?.dimensions ?? []) {
    expect(object.cadIdentity).toBeDefined(); expect(used.has(object.cadIdentity!)).toBe(false); used.add(object.cadIdentity!);
    const primary = nodes.get(object.cadIdentity!)!;
    expect(primary.anchor).toEqual({ kind, id: object.id }); expect(primary.sourceHandle).toBeDefined();
    expect(kind === 'solid3d' ? primary.baselineSolid : primary.baselineDimension3D).toEqual(object);
    const followers = graph.nodes.filter(node => node.anchor?.kind === kind && node.anchor.id === object.id && node.anchor.part);
    expect(followers.length).toBeGreaterThan(0);
    for (const follower of followers) {
      expect(follower.sourceHandle).toBeDefined();
      expect(native.get(canonicalCadHandle(follower.sourceHandle!))?.type).toBe(follower.type);
      if (kind === 'solid3d' && follower.type === 'VERTEX') expect(follower.references?.find(ref => ref.role === 'owner')?.target).toBe(primary.id);
    }
  }
  for (const entity of cadEntityLists(state).flat()) if (entity.type === 'insert') for (const [tag, placement] of Object.entries(entity.attributePlacements ?? {})) {
    const identity: unknown = Reflect.get(placement, 'cadIdentity');
    if (identity === undefined) continue;
    if (typeof identity !== 'string') throw new Error('Invalid native ATTRIB identity');
    const attribute = graph.nodes.find(node => node.sourceHandle && canonicalCadHandle(node.sourceHandle) === canonicalCadHandle(identity));
    expect(attribute?.type).toBe('ATTRIB'); expect(attribute?.anchor).toEqual({ kind: 'entity', id: entity.id, part: `attribute:${tag}` });
  }
  for (const block of Object.values(state.blocks)) for (const placement of block.attributes) {
    const identity: unknown = Reflect.get(placement, 'cadIdentity');
    expect(typeof identity).toBe('string');
    if (typeof identity !== 'string') throw new Error('Missing native ATTDEF identity');
    const attribute = native.get(canonicalCadHandle(identity))!;
    expect(attribute.type).toBe('ATTDEF'); expect(attribute.groups.find(([code]) => code === 2)?.[1]).toBe(placement.tag);
    const owner = native.get(canonicalCadHandle(attribute.groups[commonOwner(attribute.groups)]![1]))!;
    expect(owner.type).toBe('BLOCK_RECORD'); expect(owner.groups.find(([code]) => code === 2)?.[1]).toBe(block.name);
  }
  return state;
}

/** Complete logical data only after verifiedState has checked native identities and relations. */
function withoutCadIdentity<T extends object>(value: T): Omit<T, 'cadIdentity'> {
  const data = { ...value };
  Reflect.deleteProperty(data, 'cadIdentity');
  return data;
}
function logicalEntity(entity: Entity): unknown {
  const { id: _id, cadIdentity: _cadIdentity, ...data } = entity;
  if (entity.type !== 'insert' || !entity.attributePlacements) return data;
  return { ...data, attributePlacements: Object.fromEntries(Object.entries(entity.attributePlacements).map(([tag, placement]) => [tag, withoutCadIdentity(placement)])) };
}
const logical2d = (state: DrawingState) => ({
  entities: state.entities.map(logicalEntity),
  blocks: Object.fromEntries(Object.entries(state.blocks).map(([name, block]) => [name, { ...block, entities: block.entities.map(logicalEntity), attributes: block.attributes.map(withoutCadIdentity) }])),
  header: state.header,
});
const logical3d = (state: DrawingState) => state.model3d && ({
  ...state.model3d,
  solids: state.model3d.solids.map(withoutCadIdentity),
  ...(state.model3d.dimensions ? { dimensions: state.model3d.dimensions.map(withoutCadIdentity) } : {}),
});
function sameLogicalData(actual: DrawingState, expected: DrawingState): void {
  expect(logical2d(actual)).toEqual(logical2d(expected)); expect(logical3d(actual)).toEqual(logical3d(expected));
  expect(actual.layers).toEqual(expected.layers); expect(textStylesOf(actual)).toEqual(textStylesOf(expected)); expect(namedDimStyles(actual)).toEqual(namedDimStyles(expected));
}

function commonOwner(groups: readonly (readonly [number, string])[]): number {
  let depth = 0, index = -1;
  for (let i = 0; i < groups.length; i++) {
    const [code, value] = groups[i]!;
    if (code === 102) { depth += value.startsWith('{') ? 1 : value === '}' ? -1 : 0; continue; }
    if (depth) continue;
    if (code === 100 || code === 1001) break;
    if (code === 330) { expect(index).toBe(-1); index = i; }
  }
  return index;
}
/** Only the proven native 1/0 text defaults and old INSERT-owner repair may change source pairs. */
function retainedPairs(text: string, rewritten: string, state: DrawingState): void {
  const source = nativeRecords(text), target = nativeRecords(rewritten);
  for (const [handle, record] of source) {
    const saved = target.get(handle)!; expect(saved, `missing original handle ${handle}`).toBeDefined(); expect(saved.type).toBe(record.type);
    let groups = saved.groups;
    if (['TEXT', 'ATTDEF', 'ATTRIB'].includes(record.type)) for (const code of [41, 51]) if (!record.groups.some(pair => pair[0] === code)) {
      const defaults = groups.filter(pair => pair[0] === code);
      expect(defaults).toEqual([[code, code === 41 ? '1' : '0']]); groups = groups.filter(pair => pair[0] !== code);
    }
    if (record.type === 'ATTRIB' || record.type === 'SEQEND') {
      const node = state.cadGraph!.nodes.find(value => value.sourceHandle && canonicalCadHandle(value.sourceHandle) === handle), anchor = node?.anchor;
      if (anchor?.kind === 'entity' && anchor.part) {
        const parent = state.cadGraph!.nodes.find(value => value.anchor?.kind === 'entity' && value.anchor.id === anchor.id && !value.anchor.part)!;
        expect(parent.type).toBe('INSERT');
        const index = commonOwner(groups); expect(index).toBeGreaterThanOrEqual(0);
        expect(groups[index]).toEqual([330, parent.sourceHandle]);
        const sourceIndex = commonOwner(record.groups);
        groups = groups.map((pair, position) => position === index ? record.groups[sourceIndex]! : pair);
      }
    }
    expect(groups, `${record.type} ${handle}: unmodeled or native source pairs changed`).toEqual(record.groups);
  }
}

describe('committed 3D fixtures', () => {
  for (const name of MODEL3D_FIXTURES) {
    it(`${name}: pinned original and verified builder bytes have identical model/style data, under 2 MB, registered`, () => {
      expect(existsSync(fixturePath(name))).toBe(true);
      const source = readFileSync(fixturePath(name), 'utf8'), generated = built.get(name)!;
      expect(sha(source)).toBe(FIXTURE_HASHES[name][0]); expect(sha(generated)).toBe(FIXTURE_HASHES[name][1]);
      sameLogicalData(verifiedState(source), verifiedState(generated));
      expect(statSync(fixturePath(name)).size).toBeLessThan(MAX_FIXTURE_BYTES);
      const manifest = JSON.parse(readFileSync('tests/fixtures/manifest.json', 'utf8')) as { files: string[] };
      expect(manifest.files).toContain(fixturePath(name));
    });

    // T-FLAKE: schematic-with-solids measured loaded p99 4.3 s (n=10 family runs; solo p50 2.4 s on this base,
    // solo up to 6.2 s recorded under load on the P30 tree) and timed out at the 5 s default in full-suite runs;
    // its budget = p99 x 2 rounded up, applied to that fixture only (the others stay on the default).
    it(`${name}: reads with complete identities, without losses, within budget and reaches a byte fixed point`, () => {
      const { text, state } = read(name);
      expect(importReportOf(state)).toBeUndefined();
      expect(() => prepareDrawingState(state)).not.toThrow();
      expect(Object.isFrozen(state.model3d!.solids[0]!.mesh.positions)).toBe(true);
      verifiedState(text);
      const rewritten = writeDxf(state); retainedPairs(text, rewritten, state);
      if (name !== 'schematic-with-solids') expect(rewritten).toBe(text);
      expect(writeDxf(verifiedState(rewritten))).toBe(rewritten);
      for (const s of solidsOf(state)) {
        expect(meshIsClosed(s.mesh), s.id).toBe(true);
        expect(meshVolume(s.mesh), s.id).toBeGreaterThan(0);
        // Booleans come back welded: welding again changes nothing.
        expect(meshTriangleCount(weldVertices(s.mesh, 0)), s.id).toBe(meshTriangleCount(s.mesh));
      }
    }, name === 'schematic-with-solids' ? 9000 : undefined);
  }
});

describe('enclosure fixture', () => {
  it('holds the shell, door, 3 DIN rails and 40 components with their histories', () => {
    const { state } = read('enclosure');
    const solids = solidsOf(state);
    expect(solids).toHaveLength(2 + 3 + 40);
    expect(solids.map((s) => s.layer).filter((l) => l === 'COMPONENTS')).toHaveLength(40);
    const shell = byId(state, 'enc-shell');
    expect(shell.feature.kind).toBe('boolean');
    // Five subtractions deep: outer - inner, then four mounting holes.
    let depth = 0;
    for (let f = shell.feature; f.kind === 'boolean'; f = f.operands[0]!) depth += 1;
    expect(depth).toBe(5);
    expect(byId(state, 'enc-rail-1').feature.kind).toBe('extrude');
    expect(byId(state, 'enc-k1').name).toBe('K1');
    const tris = solids.reduce((n, s) => n + meshTriangleCount(s.mesh), 0);
    expect(tris).toBeGreaterThan(1500);
    expect(tris).toBeLessThan(10_000);
  });

  it('has the analytic volumes (shell with holes, door, rails, components)', () => {
    const { state } = read('enclosure');
    const E = ENCLOSURE;
    const backWallHoles = E.holes.length * ngonArea(E.holeRadius, 32) * E.wall;
    const shell = E.width * E.height * E.depth - (E.width - 2 * E.wall) * (E.height - 2 * E.wall) * (E.depth - E.wall) - backWallHoles;
    closeTo(meshVolume(byId(state, 'enc-shell').mesh), shell, 1e-9);
    closeTo(meshVolume(byId(state, 'enc-door').mesh), E.width * E.height * E.wall, 1e-12);
    for (const k of [1, 2, 3]) closeTo(meshVolume(byId(state, `enc-rail-${k}`).mesh), E.railArea * E.railLength, 1e-12);
    const C = E.components;
    for (let i = 0; i < C.columns * C.rows; i++) {
      const light = hasPilotLight(i) ? ngonArea(8, 24) * 5 : 0; // 6 mm cylinder, 1 mm sunk into the box
      closeTo(meshVolume(byId(state, `enc-k${i + 1}`).mesh), C.width * C.depth * componentHeight(i) + light, 1e-6);
    }
  });
});

describe('cable tray fixture', () => {
  it('unites two extruded runs and a revolved bend into one closed solid', () => {
    const { state } = read('cable-tray');
    expect(solidsOf(state)).toHaveLength(4);
    const run = byId(state, 'tray-run');
    const pieces = [1, 2, 3].map((k) => byId(state, `tray-piece-${k}`));
    expect(pieces.map((p) => p.feature.kind)).toEqual(['extrude', 'revolve', 'extrude']);
    const A = trayArea();
    closeTo(meshVolume(pieces[0]!.mesh), A * TRAY.run1, 1e-12);
    closeTo(meshVolume(pieces[2]!.mesh), A * TRAY.run2, 1e-12);
    // The bend is the inscribed polygonal sweep: a little under area x centroid path (Pappus).
    const centroidRadius = TRAY.bendRadius + TRAY.width / 2;
    const bend = meshVolume(pieces[1]!.mesh);
    expect(bend).toBeLessThan(A * centroidRadius * (Math.PI / 2));
    closeTo(bend, A * centroidRadius * (Math.PI / 2), 2e-3);
    // The union of pieces that only touch is their sum.
    closeTo(meshVolume(run.mesh), pieces.reduce((v, p) => v + meshVolume(p.mesh), 0), 1e-6);
  });
});

describe('2D schematic with solids beside it', () => {
  it('keeps every 2D entity, block and layer exactly as without the solids', () => {
    const { text, state } = read('schematic-with-solids');
    expect(solidsOf(state)).toHaveLength(45);
    // The same drawing with the same layers but no solids, saved and reopened.
    const alone = verifiedState(writeDxf(stateWithSolids(schematic, [], FIXTURE_LAYERS)));
    verifiedState(text);
    expect(alone.model3d).toBeUndefined();
    expect(state.entities.length).toBeGreaterThan(50);
    expect(logical2d(state)).toEqual(logical2d(alone)); expect(state.layers).toEqual(alone.layers);
    expect(textStylesOf(state)).toEqual(textStylesOf(alone)); expect(namedDimStyles(state)).toEqual(namedDimStyles(alone));
    // Intentional omission reconciles only the removed carriers. The independently built 2D
    // document has different native handles; it cannot be a byte baseline for this imported graph.
    const reduced = prepareDrawingTransition(state, withModel3D(state, EMPTY_MODEL3D));
    expect(reduced.cadGraph!.nodes.some(node => node.anchor?.kind === 'solid3d' || node.anchor?.kind === 'dimension3d')).toBe(false);
    expect(logical2d(reduced)).toEqual(logical2d(alone));
    const output = writeDxf(reduced); expect(writeDxf(verifiedState(output))).toBe(output);
  });
});
