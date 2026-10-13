import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Drawing, prepareDrawingTransition, type DrawingState } from '../src/core/document';
import { cadEntityLists, mapCadEntities, validateCadState, type CadNode } from '../src/core/cad-graph';
import { translateEntity, type Entity } from '../src/core/entities';
import { defaultLayout } from '../src/core/layouts';
import { readDxf, writeDxf } from '../src/io/dxf';
import { tokenize } from '../src/io/dxf/groups';
import { mergeDwgCadGraph } from '../src/io/cad-graph-dwg';
import { CopyTool, MoveTool, RotateTool } from '../src/tools/modify';
import { ScaleTool } from '../src/tools/edit';
import { drive, fakeContext } from './fake-context';
import { layoutController } from '../src/tools/layouts';

const native = readFileSync(new URL('./fixtures/interchange/r2018-viewport-polygon.dxf', import.meta.url), 'utf8');
const opened = () => readDxf(native);
const polygon = (state: DrawingState) => state.layouts!.find(layout => layout.name === 'Polygon')!;
const boundary = (state: DrawingState) => polygon(state).viewports[0]!.clipBoundary!;
function clipNode(state: DrawingState): CadNode {
  return state.cadGraph!.nodes.find(node => node.anchor?.kind === 'entity' && node.anchor.id === boundary(state).id)!;
}
function viewportNode(state: DrawingState): CadNode {
  return state.cadGraph!.nodes.find(node => node.anchor?.kind === 'viewport' && node.anchor.id === polygon(state).viewports[0]!.id)!;
}
function withData(): DrawingState {
  const state = opened(), pairs = tokenize(native);
  const append = (handle: string, groups: readonly (readonly [number, string])[]) => {
    const at = pairs.findIndex(pair => pair.code === 5 && pair.value.trim() === handle);
    const end = pairs.findIndex((pair, index) => index > at && pair.code === 0);
    expect(at).toBeGreaterThan(0); expect(end).toBeGreaterThan(at);
    pairs.splice(end, 0, ...groups.map(([code, value]) => ({ code, value })));
  };
  append(clipNode(state).sourceHandle!, [[1001, 'CLIP_APP'], [1000, 'literal 11D must stay exact'], [1011, '2'], [1021, '2'], [1031, '0'], [1041, '2']]);
  // This application hard pointer shares a code with the modeled clipping link;
  // it must survive independently, rather than being suppressed or duplicated.
  append(viewportNode(state).sourceHandle!, [[102, '{PROBE_POINTER'], [340, clipNode(state).sourceHandle!], [102, '}'], [1001, 'VP_APP'], [1011, '5'], [1021, '5'], [1031, '0']]);
  return readDxf(pairs.flatMap(pair => [String(pair.code), pair.value]).join('\r\n') + '\r\n');
}
function worldPoint(node: CadNode): number[] { return [1011, 1021, 1031].map(code => Number(node.groups.find(([group]) => group === code)![1])); }

describe('viewport clips participate in the retained native graph', () => {
  it.each([true, false])('preserves clip identity, pointer and owner at a byte-stable repeated-save fixed point (enabled=%s)', (enabled) => {
    const source = opened(), layout = polygon(source);
    let state: DrawingState = { ...source, layouts: source.layouts!.map(item => item === layout ? { ...item, viewports: item.viewports.map(viewport => ({ ...viewport, clipOn: enabled })) } : item) };
    const original = clipNode(state), owner = original.references!.find(ref => ref.role === 'owner')!;
    const ownerHandle = state.cadGraph!.nodes.find(node => node.id === owner.target)!.sourceHandle;
    expect(original.anchor).toEqual({ kind: 'entity', id: boundary(state).id });
    let output: string | undefined;
    for (let pass = 0; pass < 3; pass++) {
      const next = writeDxf(state); if (output !== undefined) expect(next).toBe(output);
      output = next; state = readDxf(next);
      const clip = clipNode(state), viewport = viewportNode(state);
      expect(clip.sourceHandle).toBe(original.sourceHandle);
      const nextOwner = clip.references!.find(ref => ref.role === 'owner')!.target;
      expect(state.cadGraph!.nodes.find(node => node.id === nextOwner)!.sourceHandle).toBe(ownerHandle);
      expect(viewport.groups.filter(([code]) => code === 340)).toHaveLength(1);
      expect(viewport.references!.find(ref => viewport.groups[ref.groupIndex]![0] === 340)?.target).toBe(clip.id);
      expect(polygon(state).viewports[0]!.clipOn !== false).toBe(enabled);
      expect(cadEntityLists(state).flat().filter(entity => entity.id === boundary(state).id)).toHaveLength(1);
    }
  });
  it.each([true, false])('attaches and retains actual boundary XDATA identity even while clipping is disabled (enabled=%s)', (enabled) => {
    const pairs = tokenize(native), handle = clipNode(opened()).sourceHandle;
    const at = pairs.findIndex(pair => pair.code === 5 && pair.value.trim() === handle);
    const end = pairs.findIndex((pair, index) => index > at && pair.code === 0);
    expect(at).toBeGreaterThan(0); expect(end).toBeGreaterThan(at);
    pairs.splice(end, 0, { code: 1001, value: 'CLIP_APP' }, { code: 1000, value: 'literal 11D must stay exact' });
    const source = readDxf(pairs.flatMap(pair => [String(pair.code), pair.value]).join('\r\n') + '\r\n'), layout = polygon(source);
    const state = { ...source, layouts: [{ ...layout, viewports: layout.viewports.map(viewport => ({ ...viewport, clipOn: enabled })) }] };
    expect(boundary(state).cadIdentity).toBe(clipNode(state).id);
    const back = readDxf(writeDxf(state));
    expect(boundary(back).cadIdentity).toBe(clipNode(back).id);
    expect(clipNode(back).groups).toContainEqual([1000, 'literal 11D must stay exact']);
    expect(polygon(back).viewports[0]!.clipOn !== false).toBe(enabled);
  });
  it('edits the retained boundary through a paper frame without losing its graph, with exact undo/redo', () => {
    const doc = new Drawing({ ...opened(), space: { layout: 'Polygon' } }), before = doc.snapshot;
    const frame = doc.entities.find(entity => entity.id === polygon(before).viewports[0]!.id)!;
    doc.replaceEntities([translateEntity(frame, { x: 3, y: -2 })]);
    const edited = doc.snapshot, back = readDxf(writeDxf(edited));
    expect(boundary(back).points).toEqual(boundary(before).points.map(point => ({ x: point.x + 3, y: point.y - 2 })));
    expect(clipNode(back).sourceHandle).toBe(clipNode(before).sourceHandle);
    expect(viewportNode(back).references!.find(ref => viewportNode(back).groups[ref.groupIndex]![0] === 340)?.target).toBe(clipNode(back).id);
    expect(doc.undo()).toBe(true); expect(doc.snapshot).toBe(before);
    expect(doc.redo()).toBe(true); expect(doc.snapshot).toBe(edited);
  });
  it('inventories a shared clip object once and maps it once, including its paper-entity alias', () => {
    const source = opened(), layout = polygon(source), clip = boundary(source);
    const state = { ...source, layouts: [{ ...layout, entities: [clip], viewports: [layout.viewports[0]!, { ...layout.viewports[0]!, id: 'second' }] }] };
    expect(cadEntityLists(state).flat().filter(entity => entity === clip)).toHaveLength(1);
    expect(() => validateCadState(state)).not.toThrow();
    const callback = vi.fn((entity: Entity) => ({ ...entity, color: 3 as const }));
    const mapped = mapCadEntities(state, callback), mappedClip = polygon(mapped).viewports[0]!.clipBoundary;
    expect(callback.mock.calls.filter(([entity]) => entity === clip)).toHaveLength(1);
    expect(polygon(mapped).entities[0]).toBe(mappedClip);
    expect(polygon(mapped).viewports[1]!.clipBoundary).toBe(mappedClip);
    expect(mappedClip!.cadIdentity).toBe(clip.cadIdentity);
    const text = writeDxf(state), reopened = readDxf(text), next = polygon(reopened);
    expect(next.viewports[0]!.clipBoundary).toBe(next.viewports[1]!.clipBoundary);
    expect(next.entities).toHaveLength(0);
    expect(reopened.cadGraph!.nodes.filter(node => node.type === 'LWPOLYLINE' && node.sourceHandle === clipNode(source).sourceHandle)).toHaveLength(1);
    expect(writeDxf(reopened)).toBe(text);
  });
  it.each([false, true])('rejects distinct clip objects with the same ID before inventory/mapping callbacks (paper alias=%s)', (paper) => {
    const source = opened(), layout = polygon(source), clip = boundary(source), other = { ...clip, color: 3 as const };
    const state = { ...source, layouts: [{ ...layout, entities: paper ? [other] : [], viewports: [layout.viewports[0]!, { ...layout.viewports[0]!, id: 'second', clipBoundary: other }] }] };
    const callback = vi.fn((entity: Entity) => entity);
    expect(() => cadEntityLists(state)).toThrow(/Distinct viewport clip/);
    expect(() => mapCadEntities(state, callback)).toThrow(/Distinct viewport clip/);
    expect(callback).not.toHaveBeenCalled();
    expect(() => new Drawing(state)).toThrow();
  });
  it('refuses removal of a boundary still referenced by the viewport before changing history or dirty state', () => {
    const doc = new Drawing(opened()), before = doc.snapshot, layout = polygon(before);
    const changed = { ...before, layouts: before.layouts!.map(item => item === layout ? { ...item, viewports: item.viewports.map(({ clipBoundary: _boundary, ...viewport }) => viewport) } : item) };
    expect(() => prepareDrawingTransition(before, changed)).toThrow(/VIEWPORT group 340 has a hard dependency/);
    expect(doc.snapshot).toBe(before); expect(doc.dirty).toBe(false); expect(doc.canUndo()).toBe(false);
  });
  it('refuses raw replacement of graph-bearing native layouts rather than silently dropping their anchored records', () => {
    const source = opened();
    expect(() => writeDxf({ ...source, layouts: [defaultLayout('Replacement')] })).toThrow(/hard dependency|no generated record/);
  });
  it('refuses reusing one retained boundary identity in two separate native paper owners', () => {
    const source = withData(), layout = polygon(source), clip = boundary(source);
    const unsafe = { ...source, layouts: [layout, { ...layout, name: 'Unsafe', viewports: [{ ...layout.viewports[0]!, id: 'other-owner', clipBoundary: clip }] }] };
    expect(cadEntityLists(unsafe).flat().filter(entity => entity === clip)).toHaveLength(1);
    expect(() => writeDxf(unsafe)).toThrow(/cannot be emitted twice with one identity/);
    expect(boundary(source).cadIdentity).toBe(clipNode(source).id);
  });
  it.each([
    { name: 'MOVE', tool: () => new MoveTool(), steps: [{ x: 0, y: 0 }, { x: 3, y: -2 }], clip: [5, 0, 0], viewport: [8, 3, 0], distance: 2 },
    { name: 'ROTATE', tool: () => new RotateTool(), steps: [{ x: 0, y: 0 }, '90'], clip: [-2, 2, 0], viewport: [-5, 5, 0], distance: 2 },
    { name: 'SCALE', tool: () => new ScaleTool(), steps: [{ x: 0, y: 0 }, '2'], clip: [4, 4, 0], viewport: [10, 10, 0], distance: 4 },
  ])('$name updates clip and viewport XDATA in the actual tool transaction, with exact undo/redo and native reopen', ({ tool, steps, clip, viewport, distance }) => {
    const doc = new Drawing({ ...withData(), space: { layout: 'Polygon' } }), before = doc.snapshot;
    const ctx = fakeContext(doc); ctx.selection = new Set([polygon(before).viewports[0]!.id]);
    drive(tool(), ctx, steps);
    const edited = doc.snapshot;
    for (const state of [edited, readDxf(writeDxf(edited))]) {
      worldPoint(clipNode(state)).forEach((value, index) => expect(value).toBeCloseTo(clip[index]!, 10));
      worldPoint(viewportNode(state)).forEach((value, index) => expect(value).toBeCloseTo(viewport[index]!, 10));
      expect(Number(clipNode(state).groups.find(([code]) => code === 1041)![1])).toBe(distance);
      expect(clipNode(state).groups).toContainEqual([1000, 'literal 11D must stay exact']);
      expect(viewportNode(state).groups.filter(([code]) => code === 340)).toHaveLength(2);
      expect(viewportNode(state).references!.filter(ref => viewportNode(state).groups[ref.groupIndex]![0] === 340).every(ref => ref.target === clipNode(state).id)).toBe(true);
    }
    expect(doc.undo()).toBe(true); expect(doc.snapshot).toBe(before);
    expect(doc.redo()).toBe(true); expect(doc.snapshot).toBe(edited);
  });
  it.each([true, false])('COPY clones native viewport/boundary metadata and remaps both pointers without sharing identities (enabled=%s)', (enabled) => {
    const original = withData(), layout = polygon(original);
    const doc = new Drawing({ ...original, layouts: [{ ...layout, viewports: layout.viewports.map(viewport => ({ ...viewport, clipOn: enabled })) }], space: { layout: 'Polygon' } }), before = doc.snapshot;
    const ctx = fakeContext(doc); ctx.selection = new Set([polygon(before).viewports[0]!.id]);
    drive(new CopyTool(), ctx, [{ x: 0, y: 0 }, { x: 10, y: 0 }, '']);
    const edited = doc.snapshot, copied = polygon(edited).viewports[1]!;
    expect(polygon(edited).viewports).toHaveLength(2);
    expect(copied.clipBoundary!.id).not.toBe(boundary(before).id);
    expect(copied.clipBoundary!.cadIdentity).not.toBe(boundary(before).cadIdentity);
    const copiedClip = edited.cadGraph!.nodes.find(node => node.id === copied.clipBoundary!.cadIdentity)!;
    expect(worldPoint(copiedClip)).toEqual([12, 2, 0]);
    const copiedViewport = edited.cadGraph!.nodes.find(node => node.anchor?.kind === 'viewport' && node.anchor.id === copied.id)!;
    expect(copiedViewport.references!.filter(ref => copiedViewport.groups[ref.groupIndex]![0] === 340).every(ref => ref.target === copiedClip.id)).toBe(true);
    const back = readDxf(writeDxf(edited)), copies = polygon(back).viewports;
    expect(copies).toHaveLength(2); expect(copies[1]!.clipOn !== false).toBe(enabled);
    expect(copies[1]!.clipBoundary!.points).toEqual(boundary(before).points.map(point => ({ x: point.x + 10, y: point.y })));
    expect(copies[0]!.clipBoundary!.cadIdentity).not.toBe(copies[1]!.clipBoundary!.cadIdentity);
    const once = writeDxf(back); expect(writeDxf(readDxf(once))).toBe(once);
    expect(doc.undo()).toBe(true); expect(doc.snapshot).toBe(before);
    expect(doc.redo()).toBe(true); expect(doc.snapshot).toBe(edited);
  });
  it('COPY remains functional for ordinary clips without object metadata', () => {
    const doc = new Drawing({ ...opened(), space: { layout: 'Polygon' } }), ctx = fakeContext(doc);
    ctx.selection = new Set([polygon(doc.snapshot).viewports[0]!.id]);
    drive(new CopyTool(), ctx, [{ x: 0, y: 0 }, { x: 10, y: 0 }, '']);
    const back = readDxf(writeDxf(doc.snapshot)), viewports = polygon(back).viewports;
    expect(viewports).toHaveLength(2);
    expect(viewports[1]!.clipBoundary!.points).toEqual(viewports[0]!.clipBoundary!.points.map(point => ({ x: point.x + 10, y: point.y })));
    expect(viewports[1]!.clipBoundary!.id).not.toBe(viewports[0]!.clipBoundary!.id);
  });
  it.each([false, true])('copies an actual native layout with independent boundary and viewport metadata, owners and undo/redo (shared alias=%s)', async (shared) => {
    Object.assign(globalThis, { requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} });
    const { Editor } = await import('../src/app/editor');
    const canvas = { getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement;
    const ed = new Editor(canvas), source = withData(), layout = polygon(source), clipSource = boundary(source);
    ed.doc.load(shared ? { ...source, layouts: [{ ...layout, entities: [clipSource], viewports: [layout.viewports[0]!, { ...layout.viewports[0]!, id: 'shared' }] }] } : source);
    const before = ed.doc.snapshot;
    expect(layoutController(ed).copyLayout('Polygon', 'Copied')).toBe('Copied');
    const edited = ed.doc.snapshot, copy = edited.layouts!.find(layout => layout.name === 'Copied')!;
    if (shared) {
      expect(copy.viewports[1]!.clipBoundary).toBe(copy.viewports[0]!.clipBoundary);
      expect(copy.entities[0]).toBe(copy.viewports[0]!.clipBoundary);
    }
    expect(copy.viewports[0]!.clipBoundary!.id).not.toBe(boundary(before).id);
    expect(copy.viewports[0]!.clipBoundary!.cadIdentity).not.toBe(boundary(before).cadIdentity);
    const clip = edited.cadGraph!.nodes.find(node => node.id === copy.viewports[0]!.clipBoundary!.cadIdentity)!;
    const viewport = edited.cadGraph!.nodes.find(node => node.anchor?.kind === 'viewport' && node.anchor.id === copy.viewports[0]!.id)!;
    expect(viewport.references!.filter(ref => viewport.groups[ref.groupIndex]![0] === 340).every(ref => ref.target === clip.id)).toBe(true);
    const back = readDxf(writeDxf(edited)), backCopy = back.layouts!.find(layout => layout.name === 'Copied')!, backBoundary = backCopy.viewports[0]!.clipBoundary!;
    if (shared) expect(backCopy.viewports[1]!.clipBoundary).toBe(backBoundary);
    expect(backBoundary.points).toEqual(boundary(before).points);
    const copyNode = back.cadGraph!.nodes.find(node => node.id === backBoundary.cadIdentity)!;
    expect(copyNode.groups).toContainEqual([1000, 'literal 11D must stay exact']);
    const copyOwner = copyNode.references!.find(ref => ref.role === 'owner')!.target;
    expect(copyOwner).not.toBe(clipNode(back).references!.find(ref => ref.role === 'owner')!.target);
    const once = writeDxf(back); expect(writeDxf(readDxf(once))).toBe(once);
    expect(ed.doc.undo()).toBe(true); expect(ed.doc.snapshot).toBe(before);
    expect(ed.doc.redo()).toBe(true); expect(ed.doc.snapshot).toBe(edited);
  });
  it('joins a retained clip to trusted DWG DTO geometry by exact handle and refuses a missing native owner', () => {
    const projected = withData();
    const sourceNodes = new Map(projected.cadGraph!.nodes.flatMap(node => node.anchor?.kind === 'entity' && !node.anchor.part ? [[node.anchor.id, node] as const] : []));
    const converted = mapCadEntities(projected, (entity: Entity) => ({ ...entity, id: `dto:${entity.id}`, cadIdentity: sourceNodes.get(entity.id)!.sourceHandle! }));
    const layout = polygon(converted), vp = layout.viewports[0]!;
    const base: DrawingState = { ...converted, cadGraph: undefined, layouts: [{ ...layout, viewports: [{ ...vp, id: 'dto:viewport', clipBoundary: { ...vp.clipBoundary!, color: 3, points: vp.clipBoundary!.points.map(point => ({ x: point.x + 7, y: point.y })) } }] }] };
    const join = { viewportHandles: new Map([[viewportNode(projected).sourceHandle!, 'dto:viewport']]) };
    const merged = mergeDwgCadGraph(base, projected, join);
    expect(boundary(merged).points).toEqual(boundary(base).points); expect(boundary(merged).color).toBe(3);
    expect(boundary(merged).cadIdentity).toBe(clipNode(merged).id);
    expect(clipNode(merged).groups).toContainEqual([1000, 'literal 11D must stay exact']);
    const back = readDxf(writeDxf(merged)); expect(viewportNode(back).references!.filter(ref => viewportNode(back).groups[ref.groupIndex]![0] === 340).every(ref => ref.target === clipNode(back).id)).toBe(true);
    const missing = { ...base, layouts: [{ ...polygon(base), viewports: [{ ...polygon(base).viewports[0]!, clipBoundary: undefined }] }] };
    expect(() => mergeDwgCadGraph(missing, projected, join)).toThrow(/cannot be joined to a trusted DWG entity/);
  });
});
