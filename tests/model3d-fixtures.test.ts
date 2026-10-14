/**
 * Realistic 3D fixtures (milestone 6): an electrical enclosure, a cable tray and the demo schematic
 * with solids beside it, built by tests/helpers/model3d-fixtures.ts with the in-process kernel and
 * committed as DXF under tests/fixtures/3d/.
 *
 * - The committed files are exactly what the builders produce (so the fixtures stay reproducible);
 *   `npm run make:3d-fixtures` rewrites them (JCAD_WRITE_3D_FIXTURES=1 runs this file in write mode).
 * - Reading them back gives the expected solids: counts, ids, closed meshes, analytic volumes.
 * - Rewriting what was read is byte-identical to the file (tests/fixtures/3d/.gitattributes keeps
 *   Git from converting the CRLF line endings the writer produces).
 * - The 2D entities of the mixed fixture come back exactly as they do without the solids.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DrawingState } from '../src/core/document';
import { prepareDrawingState } from '../src/core/geometry-budget';
import { withoutUnusedLibraryBlocks } from '../src/electrical/library';
import { readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf } from '../src/io/import-report';
import { ManifoldDirectKernel } from '../src/model3d/kernel/manifold-direct';
import { meshIsClosed, meshTriangleCount, meshVolume, weldVertices } from '../src/model3d/mesh';
import { EMPTY_MODEL3D, withModel3D } from '../src/model3d/model';
import type { Solid3D } from '../src/model3d/types';
import {
  ENCLOSURE, FIXTURE_LAYERS, MODEL3D_FIXTURES, TRAY, componentHeight, fixturePath, fixtureState, hasPilotLight, ngonArea, stateWithSolids,
  trayArea, type Model3DFixtureName,
} from './helpers/model3d-fixtures';

const WRITE = process.env.JCAD_WRITE_3D_FIXTURES === '1';
const MAX_FIXTURE_BYTES = 2 * 1024 * 1024;
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

describe('committed 3D fixtures', () => {
  for (const name of MODEL3D_FIXTURES) {
    it(`${name}: the file is what the builder produces, under 2 MB, registered in the manifest`, () => {
      expect(existsSync(fixturePath(name))).toBe(true);
      expect(readFileSync(fixturePath(name), 'utf8')).toBe(built.get(name));
      expect(statSync(fixturePath(name)).size).toBeLessThan(MAX_FIXTURE_BYTES);
      const manifest = JSON.parse(readFileSync('tests/fixtures/manifest.json', 'utf8')) as { files: string[] };
      expect(manifest.files).toContain(fixturePath(name));
    });

    it(`${name}: reads back without report items, sealed and within budget, and rewrites byte-identically`, () => {
      const { text, state } = read(name);
      expect(importReportOf(state)).toBeUndefined();
      expect(() => prepareDrawingState(state)).not.toThrow();
      expect(Object.isFrozen(state.model3d!.solids[0]!.mesh.positions)).toBe(true);
      expect(writeDxf(state)).toBe(text);
      for (const s of solidsOf(state)) {
        expect(meshIsClosed(s.mesh), s.id).toBe(true);
        expect(meshVolume(s.mesh), s.id).toBeGreaterThan(0);
        // Booleans come back welded: welding again changes nothing.
        expect(meshTriangleCount(weldVertices(s.mesh, 0)), s.id).toBe(meshTriangleCount(s.mesh));
      }
    });
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
    const { state } = read('schematic-with-solids');
    expect(solidsOf(state)).toHaveLength(45);
    // The same drawing with the same layers but no solids, saved and reopened.
    const alone = readDxf(writeDxf(stateWithSolids(schematic, [], FIXTURE_LAYERS)), { model3d: true });
    expect(alone.model3d).toBeUndefined();
    expect(state.entities.length).toBeGreaterThan(50);
    // Entity ids are session ids (newId), not file data: compare everything else.
    const strip = (s: DrawingState) => JSON.parse(JSON.stringify({ entities: s.entities, blocks: s.blocks, header: s.header }, (k, v: unknown) => (k === 'id' ? undefined : v))) as unknown;
    expect(strip(state)).toEqual(strip(alone));
    // Without its solids, the mixed drawing writes exactly the DXF of the schematic alone.
    expect(writeDxf(withModel3D(state, EMPTY_MODEL3D))).toBe(writeDxf(alone));
  });
});
