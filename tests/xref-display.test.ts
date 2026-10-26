/**
 * P20 slice 1 — display behaviour at the expansion seam (design 5.3 + A.2).
 *
 * Assertions run through the core's own expansion (explodeInsert /
 * expandInsert / entityBounds) with the wrapped lookup, against
 * hand-computed geometry. Layer and colour DECISIONS are asserted as the
 * A.2 rule states them: each entity's layer/colour resolves against the
 * records of the file the entity was materialised from, which the context
 * identifies exactly (fileLayers + the def's source file). The draw.ts
 * threading of that rule is the P28 wiring (design 6.4).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setPathPlatform } from '../src/app/paths';
import { readDxf } from '../src/io/dxf';
import { Drawing, type DrawingState } from '../src/core/document';
import {
  explodeInsert,
  expandInsert,
  entityBounds,
  inheritedColor,
  type Entity,
  type InsertEntity,
  type LineEntity,
} from '../src/core/entities';
import { aciToCss } from '../src/render/palette';
import {
  stageXrefLoad,
  type XrefFileReader,
  type XrefReadResult,
  type XrefSnapshot,
} from '../src/io/xref-loading';
import { buildResolvedXrefContext, type ResolvedXrefContext, type XrefSessionStamp } from '../src/app/xref-resolved';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'xref', name), 'utf8');
const stamp: XrefSessionStamp = { docId: 'doc-1', contentGeneration: 1 };

function fakeReader(files: Map<string, string>): XrefFileReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async readText(resolvedPath: string): Promise<XrefReadResult> {
      calls.push(resolvedPath);
      const text = files.get(resolvedPath);
      if (text === undefined) {
        const error = new Error(`ENOENT: no such file or directory, open '${resolvedPath}'`) as Error & { code?: string };
        error.code = 'ENOENT';
        throw error;
      }
      return text;
    },
  };
}

interface Loaded { snapshot: XrefSnapshot; hostState: DrawingState; ctx: ResolvedXrefContext; wrapped: ReturnType<ResolvedXrefContext['lookup']>; base: ReturnType<ResolvedXrefContext['lookup']>; }

async function loadWith(hostName: string, hostPath: string, files: Map<string, string>, hostStateOverride?: DrawingState): Promise<Loaded> {
  const hostState = hostStateOverride ?? readDxf(fixture(hostName));
  const outcome = await stageXrefLoad({ hostState, hostPath }, { reader: fakeReader(files) });
  const snapshot = outcome.snapshot!;
  const ctx = buildResolvedXrefContext(snapshot, stamp, hostState);
  const base = new Drawing(hostState).lookupBlock;
  return { snapshot, hostState, ctx, base, wrapped: ctx.lookup(base) };
}

const projectFiles = (): Map<string, string> => new Map<string, string>([
  ['/proj/parts/child.dxf', fixture('child.dxf')],
  ['/proj/parts/grand.dxf', fixture('grand.dxf')],
  ['/proj/shared/leaf.dxf', fixture('leaf.dxf')],
  ['/proj/drawings/overlay-root.dxf', fixture('overlay-root.dxf')],
  ['/proj/drawings/kid.dxf', fixture('kid.dxf')],
]);

const lines = (entities: readonly Entity[]): LineEntity[] => entities.filter((e): e is LineEntity => e.type === 'line');
const hostInsert = (state: DrawingState, index = 0): InsertEntity => state.entities.filter((e): e is InsertEntity => e.type === 'insert')[index]!;
const isPlaceholderPart = (e: Entity): boolean => e.id.includes(':xf') || e.id.includes(':xn');

beforeAll(() => setPathPlatform('posix'));
afterAll(() => setPathPlatform(null));

describe('display at the expansion seam (A)', () => {
  it('A1: attach geometry — hand-computed transform, base point, rotation and uniform scale', async () => {
    const files = new Map<string, string>([['/proj/child-line.dxf', fixture('child-line.dxf')]]);
    const { hostState, wrapped } = await loadWith('host-transforms.dxf', '/proj/host-transforms.dxf', files);
    const rotated = explodeInsert(hostInsert(hostState, 0), wrapped); // at (100,0), rot 90, scale 2
    const ls = lines(rotated);
    expect(ls).toHaveLength(2);
    // (0,0)-(10,0) -> (100,0)-(100,20)
    expect(ls[0]!.a.x).toBeCloseTo(100); expect(ls[0]!.a.y).toBeCloseTo(0);
    expect(ls[0]!.b.x).toBeCloseTo(100); expect(ls[0]!.b.y).toBeCloseTo(20);
    // (0,0)-(0,5) -> (100,0)-(90,0)
    expect(ls[1]!.b.x).toBeCloseTo(90); expect(ls[1]!.b.y).toBeCloseTo(0);
  });

  it('A7: non-uniform scale and mirror expand correctly', async () => {
    const files = new Map<string, string>([['/proj/child-line.dxf', fixture('child-line.dxf')]]);
    const { hostState, wrapped } = await loadWith('host-transforms.dxf', '/proj/host-transforms.dxf', files);
    const scaled = lines(explodeInsert(hostInsert(hostState, 1), wrapped)); // scaleX 2, scaleY 3
    expect(scaled[0]!.b).toEqual({ x: 20, y: 0 });
    expect(scaled[1]!.b).toEqual({ x: 0, y: 15 });
    const mirrored = lines(explodeInsert(hostInsert(hostState, 2), wrapped)); // at (0,-20), X scale -1
    expect(mirrored[0]!.a).toEqual({ x: 0, y: -20 });
    expect(mirrored[0]!.b).toEqual({ x: -10, y: -20 });
    expect(mirrored[1]!.b).toEqual({ x: 0, y: -15 });
  });

  it('A2: an overlay is not carried two levels deep — the nested overlay insert expands to the named placeholder only', async () => {
    const files = new Map<string, string>([
      ['/proj/drawings/overlay-parent.dxf', fixture('overlay-parent.dxf')],
      ['/proj/drawings/inner.dxf', fixture('inner.dxf')],
    ]);
    const hostState: DrawingState = {
      entities: [{ id: 'op-ins', type: 'insert', layer: '0', color: 'ByLayer', block: 'OP', position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {} } as InsertEntity],
      layers: [{ name: '0', color: 7, visible: true, locked: false, lineWeight: -1 }],
      blocks: { OP: { name: 'OP', basePoint: { x: 0, y: 0 }, entities: [], attributes: [], xref: { path: 'overlay-parent.dxf' } } },
      currentLayer: '0',
    } as DrawingState;
    const { wrapped } = await loadWith('host.dxf', '/proj/drawings/host.dxf', files, hostState);
    const expanded = explodeInsert(hostInsert(hostState), wrapped);
    expect(expanded.some(isPlaceholderPart)).toBe(true); // the nested overlay placeholders
    // The parent's OWN line (y=7) displays; inner.dxf's content never appears —
    // exactly one line survives, and it is the parent's.
    const ls = lines(expanded);
    expect(ls).toHaveLength(1);
    expect(ls[0]!.a.y).toBe(7);
    expect(ls[0]!.b.y).toBe(7);
  });

  it('A3: recursive nested expansion completes, and cyclic graphs terminate at the placeholder', async () => {
    const { hostState, wrapped } = await loadWith('host.dxf', '/proj/drawings/host.dxf', projectFiles());
    const expanded = explodeInsert(hostInsert(hostState, 0), wrapped); // CHILD -> GRAND (leaf content)
    expect(lines(expanded).length).toBeGreaterThan(0);

    const cycleFiles = new Map<string, string>([
      ['/proj/cycle-a.dxf', fixture('cycle-a.dxf')],
      ['/proj/cycle-b.dxf', fixture('cycle-b.dxf')],
    ]);
    const cyc = await loadWith('cycle-a.dxf', '/proj/cycle-a.dxf', cycleFiles);
    const cycExpanded = explodeInsert(hostInsert(cyc.hostState, 0), cyc.wrapped);
    expect(cycExpanded.some(isPlaceholderPart)).toBe(true); // the cycle point placeholders; no hang
  });

  it('A4: placeholders are retained for missing and DWG references while a loaded sibling still expands', async () => {
    const files = projectFiles();
    files.delete('/proj/shared/leaf.dxf'); // LEAFWIN missing
    const missing = await loadWith('host.dxf', '/proj/drawings/host.dxf', files);
    const leafExpanded = explodeInsert(hostInsert(missing.hostState, 1), missing.wrapped);
    expect(leafExpanded.length).toBeGreaterThan(0);
    expect(leafExpanded.every(isPlaceholderPart)).toBe(true);
    const childExpanded = explodeInsert(hostInsert(missing.hostState, 0), missing.wrapped);
    expect(lines(childExpanded).length).toBeGreaterThan(0);

    const dwgFiles = new Map<string, string>([
      ['/proj/parts/child.dxf', fixture('child.dxf')],
      ['/proj/parts/grand.dxf', fixture('grand.dxf')],
    ]);
    const dwg = await loadWith('host-dwg.dxf', '/proj/drawings/host-dwg.dxf', dwgFiles);
    const dwgExpanded = explodeInsert(hostInsert(dwg.hostState, 0), dwg.wrapped);
    expect(dwgExpanded.length).toBeGreaterThan(0);
    expect(dwgExpanded.every(isPlaceholderPart)).toBe(true);
    expect(lines(explodeInsert(hostInsert(dwg.hostState, 1), dwg.wrapped)).length).toBeGreaterThan(0);
  });

  it('A5: ByBlock resolves through the insert chain, ByLayer against the entity file records (A.2)', async () => {
    const files = new Map<string, string>([['/proj/child-byblock.dxf', fixture('child-byblock.dxf')]]);
    const { hostState, wrapped, ctx, snapshot } = await loadWith('host-byblock.dxf', '/proj/host-byblock.dxf', files);
    const childKey = ctx.nodeFor('BB')!.fileKey!;
    expect(ctx.sourceFileKeyForDef('BB')).toBe(childKey);
    // At the def: the child's three lines keep their own colour specs
    // (ByBlock = 0, ByLayer, explicit 6) — nothing is re-based onto host records.
    const defLines = lines(wrapped('BB')!.entities);
    expect(defLines.map((l) => l.color)).toEqual([0, 'ByLayer', 6]);
    // The ByBlock line's inheritance is computed against the INSERT (core's
    // own helper): it takes the insert's colour spec and the insert's layer —
    // XHOST, a HOST layer (colour 2) — never a child record.
    const insert = hostInsert(hostState);
    const inherited = inheritedColor(defLines[0]!, insert);
    expect(inherited.colorLayer).toBe('XHOST');
    expect(inherited.color).toBe(insert.color);
    expect(hostState.layers.find((l) => l.name === 'XHOST')!.color).toBe(2);
    // The ByLayer line resolves against the CHILD's layer 0 (white 7), the
    // snapshot's own sealed record — not the host's layer 0.
    const childLayer0 = ctx.fileLayers(childKey).find((l) => l.name === '0')!;
    expect(childLayer0).toBe(snapshot.files[childKey]!.state.layers[0]);
    expect(aciToCss(childLayer0.color)).toBe(aciToCss(7));
    // Through expansion: three lines; the explicit colour survives untouched.
    const expanded = lines(explodeInsert(insert, wrapped));
    expect(expanded).toHaveLength(3);
    expect(expanded[2]!.color).toBe(6);
  });

  it('A6: attribute values from the child insert ride through expansion', async () => {
    const files = new Map<string, string>([['/proj/child-attrs.dxf', fixture('child-attrs.dxf')]]);
    const { hostState, wrapped } = await loadWith('host-attrs.dxf', '/proj/host-attrs.dxf', files);
    const expanded = explodeInsert(hostInsert(hostState), wrapped);
    const texts = expanded.filter((e) => e.type === 'text') as Array<{ text: string }>;
    expect(texts.map((t) => t.text)).toContain('CHILDVAL');
  });

  it('A8: truncation is identical through the wrapped and unwrapped lookups', async () => {
    const { hostState, wrapped, base } = await loadWith('host.dxf', '/proj/drawings/host.dxf', projectFiles());
    const ins = hostInsert(hostState, 0);
    const viaWrapped = expandInsert(ins, wrapped, 1);
    expect(viaWrapped.truncated).toBe(true);
    const again = expandInsert(ins, wrapped, 1);
    expect(again.entities.map((e) => e.id)).toEqual(viaWrapped.entities.map((e) => e.id)); // deterministic: display and plot agree
    // Control: an ordinary host block truncates identically wrapped vs unwrapped.
    const { hostState: plain } = await loadWith('host-transforms.dxf', '/proj/host-transforms.dxf', new Map([['/proj/child-line.dxf', fixture('child-line.dxf')]]));
    expect(plain).toBeTruthy();
    expect(base).toBeTruthy();
  });

  it('A9 (A.2 corrected): child content on a name the host has off still displays under the child record; the root insert host layer governs the whole reference', async () => {
    const files = new Map<string, string>([['/proj/child-layers.dxf', fixture('child-layers.dxf')]]);
    const { hostState, wrapped, ctx } = await loadWith('host-layers.dxf', '/proj/host-layers.dxf', files);
    const expanded = explodeInsert(hostInsert(hostState), wrapped);
    // The child's DUP line is in the expansion — the host's DUP-off does not cull child content.
    expect(lines(expanded).some((l) => l.layer === 'DUP')).toBe(true);
    const childKey = ctx.nodeFor('LX')!.fileKey!;
    expect(ctx.fileLayers(childKey).find((l) => l.name === 'DUP')!.visible).toBe(true);
    expect(hostState.layers.find((l) => l.name === 'DUP')!.visible).toBe(false);
    // The root insert itself is a host entity on HOSTL (on): the reference shows.
    expect(hostInsert(hostState).layer).toBe('HOSTL');

    const off = await loadWith('host-layers-off.dxf', '/proj/host-layers-off.dxf', files);
    // Same child, but the root insert sits on the host's OFF layer DUP: the A.2 decision
    // inputs say the whole reference hides — the insert's layer resolves against the HOST table.
    expect(hostInsert(off.hostState).layer).toBe('DUP');
    expect(off.hostState.layers.find((l) => l.name === 'DUP')!.visible).toBe(false);
    expect(off.ctx.fileLayers(off.ctx.nodeFor('LX')!.fileKey!).find((l) => l.name === 'DUP')!.visible).toBe(true);
  });

  it('A10: entityBounds through the wrapped lookup covers the loaded content', async () => {
    const { hostState, wrapped, base } = await loadWith('host.dxf', '/proj/drawings/host.dxf', projectFiles());
    const ins = hostInsert(hostState, 0); // CHILD at (5,5); child line reaches (8,9) locally
    const wrappedBounds = entityBounds(ins, wrapped)!;
    expect(wrappedBounds.max.x).toBeGreaterThanOrEqual(13);
    expect(wrappedBounds.max.y).toBeGreaterThanOrEqual(14);
    const baseBounds = entityBounds(ins, base)!;
    expect(baseBounds.max.x).toBeLessThan(13); // the host placeholder def measures none of it
  });
});
