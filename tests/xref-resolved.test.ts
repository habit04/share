/**
 * P20 slice 1 — resolved-snapshot lookup contract (design section 3 + A.2).
 *
 * The contract is a pure function of (snapshot, stamp, host state): it
 * materialises scoped defs per loaded file, root defs per loaded root
 * node, and never touches the host's tables. Layer resolution is
 * source-local (A.2): fileLayers(fileKey) returns the file's own records;
 * there is no merged table anywhere in the contract.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setPathPlatform } from '../src/app/paths';
import { readDxf } from '../src/io/dxf';
import { Drawing, type DrawingState } from '../src/core/document';
import { explodeInsert, type BlockDef, type Entity, type InsertEntity, type Layer, type LineEntity } from '../src/core/entities';
import {
  stageXrefLoad,
  type XrefFileReader,
  type XrefReadResult,
  type XrefSnapshot,
} from '../src/io/xref-loading';
import { buildResolvedXrefContext, type XrefSessionStamp } from '../src/app/xref-resolved';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'xref', name), 'utf8');

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

const stamp: XrefSessionStamp = { docId: 'doc-1', contentGeneration: 1 };

async function load(hostName: string, hostPath: string, files: Map<string, string>): Promise<{ snapshot: XrefSnapshot; hostState: DrawingState }> {
  const hostState = readDxf(fixture(hostName));
  const outcome = await stageXrefLoad({ hostState, hostPath }, { reader: fakeReader(files) });
  expect(outcome.snapshot).toBeTruthy();
  return { snapshot: outcome.snapshot!, hostState };
}

function projectFiles(): Map<string, string> {
  return new Map<string, string>([
    ['/proj/parts/child.dxf', fixture('child.dxf')],
    ['/proj/parts/grand.dxf', fixture('grand.dxf')],
    ['/proj/shared/leaf.dxf', fixture('leaf.dxf')],
    ['/proj/drawings/overlay-root.dxf', fixture('overlay-root.dxf')],
    ['/proj/drawings/kid.dxf', fixture('kid.dxf')],
  ]);
}

const lines = (entities: readonly unknown[]): LineEntity[] => entities.filter((e) => (e as LineEntity).type === 'line') as LineEntity[];
const inserts = (entities: readonly unknown[]): InsertEntity[] => entities.filter((e) => (e as InsertEntity).type === 'insert') as InsertEntity[];

beforeAll(() => setPathPlatform('posix'));
afterAll(() => setPathPlatform(null));

describe('resolved xref contract', () => {
  it('C1: a loaded root resolves to the file model-space content with the host base point and record preserved; inputs unmutated', async () => {
    const { snapshot, hostState } = await load('host.dxf', '/proj/drawings/host.dxf', projectFiles());
    const snapshotJson = JSON.stringify(snapshot);
    const hostBlock = hostState.blocks['CHILD']!;
    const ctx = buildResolvedXrefContext(snapshot, stamp, hostState);
    const base = new Drawing(hostState).lookupBlock;
    const def = ctx.lookup(base)('CHILD')!;
    expect(def).not.toBe(hostBlock);
    expect(def.basePoint).toEqual(hostBlock.basePoint);
    expect(def.xref).toEqual({ path: '../parts/child.dxf' });
    const childFile = snapshot.files[snapshot.nodes[0]!.fileKey!]!;
    // The child's own line rides through by reference; its nested insert is rewritten to the scoped name.
    expect(def.entities).toHaveLength(childFile.state.entities.length);
    expect(lines(def.entities)[0]).toBe(lines(childFile.state.entities)[0]);
    const nested = inserts(def.entities)[0]!;
    expect(nested.block).not.toBe('GRAND');
    // The nested insert resolves to the GRAND file's own model-space def.
    const grandKey = snapshot.nodes[0]!.children[0]!.fileKey!;
    expect(ctx.sourceFileKeyForDef(nested.block)).toBe(grandKey);
    expect(ctx.lookup(base)(nested.block)).toBeTruthy();
    expect(JSON.stringify(snapshot)).toBe(snapshotJson);
  });

  it('C2: an unloaded root yields no table entry and the lookup returns the host def itself', async () => {
    const files = projectFiles();
    files.delete('/proj/parts/child.dxf'); // CHILD goes missing
    const { snapshot, hostState } = await load('host.dxf', '/proj/drawings/host.dxf', files);
    expect(snapshot.nodes[0]!.status).toBe('missing');
    const ctx = buildResolvedXrefContext(snapshot, stamp, hostState);
    const base = new Drawing(hostState).lookupBlock;
    expect(ctx.lookup(base)('CHILD')).toBe(base('CHILD'));
    expect(ctx.nodeFor('CHILD')!.status).toBe('missing');
  });

  it('C3: nested loaded references get scoped defs; a not-carried overlay becomes a placeholder def with its record intact', async () => {
    const files = new Map<string, string>([
      ['/proj/drawings/overlay-parent.dxf', fixture('overlay-parent.dxf')],
      ['/proj/drawings/inner.dxf', fixture('inner.dxf')],
    ]);
    const hostState: DrawingState = {
      entities: [],
      layers: [{ name: '0', color: 7, visible: true, locked: false, lineWeight: -1 }],
      blocks: { OP: { name: 'OP', basePoint: { x: 0, y: 0 }, entities: [], attributes: [], xref: { path: 'overlay-parent.dxf' } } },
      currentLayer: '0',
    };
    const outcome = await stageXrefLoad({ references: [{ blockName: 'OP', path: 'overlay-parent.dxf' }], hostPath: '/proj/drawings/host.dxf' }, { reader: fakeReader(files) });
    const snapshot = outcome.snapshot!;
    expect(snapshot.nodes[0]!.children[0]).toMatchObject({ blockName: 'INNER', status: 'not-carried-overlay' });
    const ctx = buildResolvedXrefContext(snapshot, stamp, hostState);
    const base = new Drawing(hostState).lookupBlock;
    const rootDef = ctx.lookup(base)('OP')!;
    const nested = inserts(rootDef.entities)[0]!;
    expect(nested.block).not.toBe('INNER');
    const placeholder = ctx.lookup(base)(nested.block)!;
    expect(placeholder.entities).toHaveLength(0);
    expect(placeholder.xref).toEqual({ path: 'inner.dxf', overlay: true });
  });

  it('C4: a child block name colliding with a host block name stays isolated in the child namespace', async () => {
    const files = new Map<string, string>([['/proj/child-collision.dxf', fixture('child-collision.dxf')]]);
    const { snapshot, hostState } = await load('host-collision.dxf', '/proj/host-collision.dxf', files);
    const ctx = buildResolvedXrefContext(snapshot, stamp, hostState);
    const base = new Drawing(hostState).lookupBlock;
    const wrapped = ctx.lookup(base);
    // The host's own SHARED is the host def, untouched.
    expect(wrapped('SHARED')).toBe(base('SHARED'));
    // The child's SHARED lives under a scoped name and holds the child's vertical line.
    const rootDef = wrapped('CHILDX')!;
    const scopedInsert = inserts(rootDef.entities)[0]!;
    expect(scopedInsert.block).not.toBe('SHARED');
    const scopedDef = wrapped(scopedInsert.block)!;
    const childLine = lines(scopedDef.entities)[0]!;
    expect(childLine.a).toEqual({ x: 0, y: 0 });
    expect(childLine.b).toEqual({ x: 0, y: 50 });
    // The child's marker line rides in the root def by reference.
    expect(lines(rootDef.entities).some((l) => l.a.x === 200 && l.b.x === 210)).toBe(true);
  });

  it('C5: two children defining the same block name resolve independently', async () => {
    const files = new Map<string, string>([
      ['/proj/child-shared-name-a.dxf', fixture('child-shared-name-a.dxf')],
      ['/proj/child-shared-name-b.dxf', fixture('child-shared-name-b.dxf')],
    ]);
    const { snapshot, hostState } = await load('host-two-children.dxf', '/proj/host-two-children.dxf', files);
    const ctx = buildResolvedXrefContext(snapshot, stamp, hostState);
    const wrapped = ctx.lookup(new Drawing(hostState).lookupBlock);
    const scopedA = inserts(wrapped('XA')!.entities)[0]!.block;
    const scopedB = inserts(wrapped('XB')!.entities)[0]!.block;
    expect(scopedA).not.toBe(scopedB);
    expect(lines(wrapped(scopedA)!.entities)[0]!.b).toEqual({ x: 10, y: 0 }); // A: horizontal
    expect(lines(wrapped(scopedB)!.entities)[0]!.b).toEqual({ x: 0, y: 10 }); // B: vertical
  });

  it('C6: a diamond shares one scoped def set for the shared file, by identity', async () => {
    const files = new Map<string, string>([
      ['/proj/child.dxf', fixture('child.dxf')],
      ['/proj/child-b.dxf', fixture('child-b.dxf')],
      ['/proj/grand.dxf', fixture('grand.dxf')],
    ]);
    const { snapshot, hostState } = await load('host-diamond.dxf', '/proj/host-diamond.dxf', files);
    expect(Object.keys(snapshot.files)).toHaveLength(3); // grand parsed once
    const ctx = buildResolvedXrefContext(snapshot, stamp, hostState);
    const wrapped = ctx.lookup(new Drawing(hostState).lookupBlock);
    const grandViaA = inserts(wrapped('CA')!.entities)[0]!.block;
    const grandViaB = inserts(wrapped('CB')!.entities)[0]!.block;
    expect(grandViaA).toBe(grandViaB);
    expect(wrapped(grandViaA)).toBe(wrapped(grandViaB));
  });

  it('C7: memoisation — same snapshot and stamp values give the identical context and lookup; a new stamp or snapshot does not', async () => {
    const { snapshot, hostState } = await load('host.dxf', '/proj/drawings/host.dxf', projectFiles());
    const a = buildResolvedXrefContext(snapshot, stamp, hostState);
    const b = buildResolvedXrefContext(snapshot, { docId: 'doc-1', contentGeneration: 1 }, hostState);
    expect(b).toBe(a);
    const base = new Drawing(hostState).lookupBlock;
    expect(a.lookup(base)).toBe(a.lookup(base));
    const c = buildResolvedXrefContext(snapshot, { docId: 'doc-1', contentGeneration: 2 }, hostState);
    expect(c).not.toBe(a);
    const again = await load('host.dxf', '/proj/drawings/host.dxf', projectFiles());
    expect(buildResolvedXrefContext(again.snapshot, stamp, again.hostState)).not.toBe(a);
  });

  it('C8 (A.2 corrected): layers are source-local — fileLayers returns the file records verbatim; no merged table exists', async () => {
    const files = new Map<string, string>([['/proj/child-layers.dxf', fixture('child-layers.dxf')]]);
    const { snapshot, hostState } = await load('host-layers.dxf', '/proj/host-layers.dxf', files);
    const hostDup = hostState.layers.find((l) => l.name === 'DUP')!;
    expect(hostDup.visible).toBe(false); // the host's DUP is OFF
    const ctx = buildResolvedXrefContext(snapshot, stamp, hostState);
    const fileKey = ctx.nodeFor('LX')!.fileKey!;
    const childLayers = ctx.fileLayers(fileKey);
    const childDup = childLayers.find((l) => l.name === 'DUP')!;
    expect(childDup.visible).toBe(true); // the child's DUP is ON — no winner, no merge
    expect(childDup.color).toBe(3);
    // Verbatim: the returned records are the snapshot's own sealed objects.
    const snapshotDup = snapshot.files[fileKey]!.state.layers.find((l) => l.name === 'DUP')!;
    expect(childDup).toBe(snapshotDup);
    expect(childLayers.map((l) => l.name)).toEqual(['0', 'DUP', 'CHILDONLY']);
    expect(ctx.fileLayers('path:/no/such/file.dxf')).toEqual([]);
    // Nothing was written into the host table.
    expect(hostState.layers.map((l) => l.name)).toEqual(['0', 'DUP', 'HOSTL']);
  });

  it('C9: a dangling insert inside a child is left verbatim and expands to nothing', async () => {
    const files = new Map<string, string>([['/proj/child-dangling.dxf', fixture('child-dangling.dxf')]]);
    const { snapshot, hostState } = await load('host-dangling.dxf', '/proj/host-dangling.dxf', files);
    const ctx = buildResolvedXrefContext(snapshot, stamp, hostState);
    const wrapped = ctx.lookup(new Drawing(hostState).lookupBlock);
    const rootDef = wrapped('DX')!;
    const dangling = inserts(rootDef.entities)[0]!;
    expect(dangling.block).toBe('NOSUCH');
    expect(wrapped('NOSUCH')).toBeUndefined();
    const hostInsert = hostState.entities[0] as InsertEntity;
    const expanded = explodeInsert(hostInsert, wrapped);
    expect(lines(expanded)).toHaveLength(1); // only the child's real line
  });

  it('C9 (host-name collision): a dangling insert inside a child is NOT satisfied by an unrelated host block of the same name (#56 P2)', async () => {
    const files = new Map<string, string>([['/proj/child-dangling.dxf', fixture('child-dangling.dxf')]]);
    const { snapshot, hostState } = await load('host-dangling.dxf', '/proj/host-dangling.dxf', files);
    // The host happens to define an unrelated block with the very name the
    // child dangles (the HOST_ONLY situation): a marker line that must
    // never be picked up as the child's geometry.
    const marker: BlockDef = {
      name: 'NOSUCH', basePoint: { x: 0, y: 0 }, attributes: [],
      entities: [{ id: 'marker', type: 'line', layer: '0', color: 'ByLayer', a: { x: 1, y: 1 }, b: { x: 2, y: 2 } } as LineEntity],
    };
    const hostState2: DrawingState = { ...hostState, blocks: { ...hostState.blocks, NOSUCH: marker } };
    const ctx = buildResolvedXrefContext(snapshot, stamp, hostState2);
    const base = new Drawing(hostState2).lookupBlock;
    const wrapped = ctx.lookup(base);
    expect(base('NOSUCH')).toBe(marker); // the collision is real: the host table holds the name
    // The unresolved child reference is preserved verbatim (C9's premise)...
    const rootDef = wrapped('DX')!;
    const dangling = inserts(rootDef.entities)[0]!;
    expect(dangling.block).toBe('NOSUCH');
    // ...but no host lookup may satisfy it: it resolves to no definition,
    // never to the host-marker object.
    expect(wrapped('NOSUCH')).toBeUndefined();
    const hostInsert = hostState2.entities[0] as InsertEntity;
    const expanded = explodeInsert(hostInsert, wrapped);
    expect(lines(expanded)).toHaveLength(1); // only the child's real line
    expect(lines(expanded)[0]).toMatchObject({ a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });
  });

  it('C12 (#58 review P2): a valid host insert of a name a child dangles still expands through the expansion lookup; the child reference still refuses', async () => {
    const files = new Map<string, string>([['/proj/child-dangling.dxf', fixture('child-dangling.dxf')]]);
    const { snapshot, hostState } = await load('host-dangling.dxf', '/proj/host-dangling.dxf', files);
    // The #56 collision setup (host defines an unrelated NOSUCH), plus the
    // host ALSO inserting NOSUCH itself — a valid host reference that the
    // global dangling refusal used to eat (one line became zero).
    const marker: BlockDef = {
      name: 'NOSUCH', basePoint: { x: 0, y: 0 }, attributes: [],
      entities: [{ id: 'marker', type: 'line', layer: '0', color: 'ByLayer', a: { x: 1, y: 1 }, b: { x: 2, y: 2 } } as LineEntity],
    };
    const hostInsertNosuch: InsertEntity = { id: 'host-nosuch', type: 'insert', layer: '0', color: 'ByLayer', block: 'NOSUCH', position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {} };
    const hostState2: DrawingState = {
      ...hostState,
      blocks: { ...hostState.blocks, NOSUCH: marker },
      entities: [...hostState.entities, hostInsertNosuch],
    };
    const ctx = buildResolvedXrefContext(snapshot, stamp, hostState2);
    const base = new Drawing(hostState2).lookupBlock;
    const expansion = ctx.expansionLookup(base);
    // Asked by the host (the painter / plotter ask exactly this), the name
    // is the host's own block: provenance scopes the refusal to the child.
    expect(expansion('NOSUCH')).toBe(marker);
    const expandedHost = explodeInsert(hostInsertNosuch, expansion);
    expect(lines(expandedHost)).toHaveLength(1);
    expect(lines(expandedHost)[0]).toMatchObject({ a: { x: 1, y: 1 }, b: { x: 2, y: 2 } });
    // Asked from inside the child's def, the same name still refuses: the
    // root expansion keeps only the child's real line.
    const expandedRoot = explodeInsert(hostState2.entities[0] as InsertEntity, expansion);
    expect(lines(expandedRoot)).toHaveLength(1);
    expect(lines(expandedRoot)[0]).toMatchObject({ a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });
  });

  it('C13 (#58 review P2): a dangling child reference is NOT satisfied by a same-named host ROOT xref; the root still expands when the host asks', async () => {
    const files = new Map<string, string>([
      ['/proj/child-dangling.dxf', fixture('child-dangling.dxf')],
      ['/proj/leaf.dxf', fixture('leaf.dxf')],
    ]);
    const layer0: Layer = { name: '0', color: 7, visible: true, locked: false, lineWeight: -1 };
    const ins = (id: string, block: string): InsertEntity => ({ id, type: 'insert', layer: '0', color: 'ByLayer', block, position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {} });
    const hostState: DrawingState = {
      entities: [ins('h-dx', 'DX'), ins('h-nosuch', 'NOSUCH')],
      layers: [layer0],
      blocks: {
        DX: { name: 'DX', basePoint: { x: 0, y: 0 }, entities: [], attributes: [], xref: { path: 'child-dangling.dxf' } },
        NOSUCH: { name: 'NOSUCH', basePoint: { x: 0, y: 0 }, entities: [], attributes: [], xref: { path: 'leaf.dxf' } },
      },
      currentLayer: '0',
    };
    const outcome = await stageXrefLoad(
      { references: [{ blockName: 'DX', path: 'child-dangling.dxf' }, { blockName: 'NOSUCH', path: 'leaf.dxf' }], hostPath: '/proj/host-root-collision.dxf' },
      { reader: fakeReader(files) },
    );
    const snapshot = outcome.snapshot!;
    expect(snapshot.nodes.find((n) => n.blockName === 'DX')!.status).toBe('loaded');
    expect(snapshot.nodes.find((n) => n.blockName === 'NOSUCH')!.status).toBe('loaded');
    const ctx = buildResolvedXrefContext(snapshot, stamp, hostState);
    const base = new Drawing(hostState).lookupBlock;
    const circles = (entities: readonly Entity[]): Entity[] => entities.filter((e) => e.type === 'circle');
    // The leaf's circle is the tell: if the child's dangling insert is
    // satisfied by the same-named root, the leaf content (line + circle)
    // appears inside the DX expansion. It must not — through either the
    // plain contract lookup or the expansion lookup.
    const viaPlain = explodeInsert(hostState.entities[0]!, ctx.lookup(base));
    expect(lines(viaPlain)).toHaveLength(1);
    expect(circles(viaPlain)).toHaveLength(0);
    const viaExpansion = explodeInsert(hostState.entities[0]!, ctx.expansionLookup(base));
    expect(lines(viaExpansion)).toHaveLength(1);
    expect(circles(viaExpansion)).toHaveLength(0);
    // The host's own insert of that root expands the leaf content normally.
    const rootExpanded = explodeInsert(hostState.entities[1]!, ctx.expansionLookup(base));
    expect(lines(rootExpanded)).toHaveLength(1);
    expect(circles(rootExpanded)).toHaveLength(1);
  });

  it('C10: a host block literally named like a scoped name still resolves as host', async () => {
    const { snapshot, hostState } = await load('host.dxf', '/proj/drawings/host.dxf', projectFiles());
    const childKey = snapshot.nodes[0]!.fileKey!;
    const literal = `\u0001xref:${childKey}:GRAND`;
    const marker: BlockDef = {
      name: literal, basePoint: { x: 0, y: 0 }, attributes: [],
      entities: [{ id: 'marker', type: 'line', layer: '0', color: 'ByLayer', a: { x: 1, y: 1 }, b: { x: 2, y: 2 } } as LineEntity],
    };
    const hostState2: DrawingState = { ...hostState, blocks: { ...hostState.blocks, [literal]: marker } };
    const ctx = buildResolvedXrefContext(snapshot, stamp, hostState2);
    const base = new Drawing(hostState2).lookupBlock;
    expect(ctx.lookup(base)(literal)).toBe(base(literal));
    expect(ctx.lookup(base)(literal)).toBe(marker);
  });

  it('C11: attributes ride through scoped defs — per-insert values win, defaults stay on the def', async () => {
    const files = new Map<string, string>([['/proj/child-attrs.dxf', fixture('child-attrs.dxf')]]);
    const { snapshot, hostState } = await load('host-attrs.dxf', '/proj/host-attrs.dxf', files);
    const ctx = buildResolvedXrefContext(snapshot, stamp, hostState);
    const wrapped = ctx.lookup(new Drawing(hostState).lookupBlock);
    const scopedWidget = inserts(wrapped('AX')!.entities)[0]!.block;
    const widgetDef = wrapped(scopedWidget)!;
    expect(widgetDef.attributes.map((a) => [a.tag, a.default])).toEqual([['TAG1', 'DFLT']]);
    const hostInsert = hostState.entities[0] as InsertEntity;
    const expanded = explodeInsert(hostInsert, wrapped);
    const texts = expanded.filter((e) => e.type === 'text') as Array<{ text: string }>;
    expect(texts.some((t) => t.text === 'CHILDVAL')).toBe(true);
    expect(texts.some((t) => t.text === 'DFLT')).toBe(false);
  });

  it('D7: an IMAGE inside a referenced file rides through verbatim with its stored path', async () => {
    const files = new Map<string, string>([['/proj/child-image.dxf', fixture('child-image.dxf')]]);
    const { snapshot, hostState } = await load('host-image.dxf', '/proj/host-image.dxf', files);
    const ctx = buildResolvedXrefContext(snapshot, stamp, hostState);
    const wrapped = ctx.lookup(new Drawing(hostState).lookupBlock);
    const images = wrapped('IX')!.entities.filter((e) => e.type === 'image') as Array<{ path: string }>;
    expect(images).toHaveLength(1);
    expect(images[0]!.path).toBe('missing.png');
  });

  it('contract surface: nodeFor, resolvedNames, and textGeometry delegation', async () => {
    const { snapshot, hostState } = await load('host.dxf', '/proj/drawings/host.dxf', projectFiles());
    const ctx = buildResolvedXrefContext(snapshot, stamp, hostState);
    expect(ctx.nodeFor('CHILD')!.status).toBe('loaded');
    expect(ctx.nodeFor('NOPE')).toBeUndefined();
    const names = ctx.resolvedNames();
    expect(names.slice(0, 3)).toEqual(['CHILD', 'LEAFWIN', 'OVLROOT']); // roots in snapshot order
    expect(names.some((n) => n.includes('GRAND'))).toBe(true); // scoped defs follow
    const base = new Drawing(hostState).lookupBlock;
    const wrapped = ctx.lookup(base);
    expect((wrapped as { textGeometry?: unknown }).textGeometry).toBe((base as { textGeometry?: unknown }).textGeometry);
    expect(ctx.snapshot).toBe(snapshot);
    expect(ctx.generation).toBe(snapshot.generation);
    expect(ctx.stamp).toEqual(stamp);
  });
});
