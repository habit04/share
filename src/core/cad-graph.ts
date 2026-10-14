/** Immutable retained CAD data. IDs are document identities; file handles are opaque hex strings. */
import type { DrawingState } from './document';
import type { Entity } from './entities';
import { newId } from './entities';
import { isImmutableData } from './immutable-data';
import type { Solid3D, Dimension3D } from '../model3d/types';

export type CadGroup = readonly [number, string];
export type CadReferenceKind = 'soft-pointer' | 'hard-pointer' | 'soft-owner' | 'hard-owner' | 'arbitrary';
export type CadAnchor =
  | { readonly kind: 'entity'; readonly id: string; readonly part?: string }
  | { readonly kind: 'solid3d'; readonly id: string; readonly part?: string }
  | { readonly kind: 'dimension3d'; readonly id: string; readonly part?: string }
  | { readonly kind: 'table'; readonly table: string; readonly name: string }
  | { readonly kind: 'shape-style'; readonly sourceId: string }
  | { readonly kind: 'layout'; readonly name: string }
  | { readonly kind: 'viewport'; readonly id: string }
  | { readonly kind: 'dictionary'; readonly path: readonly string[] }
  | { readonly kind: 'raw' };
export interface CadReference {
  readonly groupIndex: number;
  readonly kind: CadReferenceKind;
  readonly target?: string;
  readonly sourceHandle?: string;
  readonly role?: 'owner' | 'reactor' | 'extension' | 'xdata';
}
export interface CadNode {
  readonly id: string;
  readonly sourceHandle?: string;
  readonly type: string;
  readonly section: string;
  readonly groups: readonly CadGroup[];
  readonly anchor?: CadAnchor;
  readonly references?: readonly CadReference[];
  /** Original logical entity, used only to detect manual field overrides and type replacement. */
  readonly baselineEntity?: Entity;
  /** Exact mesh topology at import: follower mappings cannot be inferred after retessellation. */
  readonly baselineSolid?: Solid3D;
  readonly baselineDimension3D?: Dimension3D;
}
export interface CadGraphDiagnostic {
  readonly code: 'external-soft-reference';
  readonly nodeId: string;
  readonly groupIndex: number;
  readonly message: string;
}
export interface CadGraph {
  readonly schema: 1;
  /** Stable across edits/history, fresh for every imported or newly created drawing. */
  readonly documentId?: string;
  readonly sourceFormat: 'DXF' | 'DWG';
  readonly sourceVersion?: string;
  readonly nodes: readonly CadNode[];
  /** Handles of proven regenerated records, never dependencies for arbitrary metadata edges. */
  readonly generatedHandles?: readonly { readonly key: string; readonly handle: string }[];
  readonly diagnostics?: readonly CadGraphDiagnostic[];
}
export interface CadAffineTransform {
  readonly xx: number; readonly xy: number; readonly yx: number; readonly yy: number;
  readonly tx: number; readonly ty: number;
  readonly xz?: number; readonly yz?: number; readonly zx?: number; readonly zy?: number;
  readonly zz?: number; readonly tz?: number;
  /** Positive uniform length scale for XDATA1041/1042 and removal of scale from directions. */
  readonly distanceScale?: number;
}
export interface CadCloneBatch {
  /** One map per copy set / array cell; several copies of one source cannot share a batch. */
  readonly entityIds: Readonly<Record<string, string>>;
  readonly solidIds?: Readonly<Record<string, string>>;
  readonly dimension3dIds?: Readonly<Record<string, string>>;
  /** Required for cross-document copies. The captured immutable source travels with the clipboard. */
  readonly sourceState?: DrawingState;
  readonly transform?: CadAffineTransform;
  /** Explicit structural copies, such as a layout and its viewport identities. */
  readonly anchorRemaps?: readonly { readonly from: CadAnchor; readonly to: CadAnchor }[];
}
export interface CadGraphEditIntent {
  readonly cloneBatches?: readonly CadCloneBatch[];
  readonly transforms?: readonly { readonly entityIds: readonly string[]; readonly solidIds?: readonly string[]; readonly dimension3dIds?: readonly string[]; readonly transform: CadAffineTransform }[];
}
export class CadGraphError extends Error {
  constructor(readonly code: 'invalid' | 'dependency' | 'copy' | 'transform', message: string) {
    super(message); this.name = 'CadGraphError';
  }
}
const MAX_NODES = 250_000, MAX_GROUPS = 2_000_000, MAX_TEXT = 32 * 1024 * 1024, MAX_VALUE = 1024 * 1024;
const checked = new WeakSet<CadGraph>();
const withoutIdentity = new WeakSet<readonly Entity[]>();
const invalid = (message: string): never => { throw new CadGraphError('invalid', message); };
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024;
/** Canonical comparison only. Keep the original spelling in sourceHandle/groups when exporting. */
export function canonicalCadHandle(value: string): string {
  if (!/^[0-9A-Fa-f]{1,16}$/.test(value)) return invalid('CAD object handle must be a hexadecimal string of at most 64 bits.');
  return BigInt(`0x${value}`).toString(16).toUpperCase();
}
export function cadReferenceKind(code: number): CadReferenceKind | undefined {
  if (code >= 320 && code <= 329) return 'arbitrary';
  if (code >= 330 && code <= 339 || code === 1005) return 'soft-pointer';
  if (code >= 340 && code <= 349 || code >= 390 && code <= 399 || code >= 480 && code <= 481) return 'hard-pointer';
  if (code >= 350 && code <= 359) return 'soft-owner';
  if (code >= 360 && code <= 369) return 'hard-owner';
  return undefined;
}
/** Generic handle edges. The codec supplies owner/reactor roles where record context proves them. */
export function cadReferences(groups: readonly CadGroup[], handles: ReadonlyMap<string, string>): CadReference[] {
  return groups.flatMap(([code, value], groupIndex) => {
    const kind = cadReferenceKind(code);
    if (!kind) return [];
    const handle = canonicalCadHandle(value.trim()), target = handles.get(handle);
    return [{ groupIndex, kind, sourceHandle: value.trim(), ...(target ? { target } : {}), ...(code === 1005 ? { role: 'xdata' as const } : {}) }];
  });
}
export function graphOf(state: Pick<DrawingState, 'cadGraph'>): CadGraph | undefined { return state.cadGraph; }
export function withCadGraph(state: DrawingState, graph: CadGraph | undefined): DrawingState {
  if (graph === state.cadGraph) return state;
  if (graph) { validateCadGraph(graph); return { ...state, cadGraph: graph }; }
  const { cadGraph: _drop, ...rest } = state; return rest;
}
export function cadAnchorKey(anchor: CadAnchor | undefined): string | undefined {
  if (!anchor || anchor.kind === 'raw') return undefined;
  switch (anchor.kind) {
    case 'entity': return JSON.stringify(['entity', anchor.id, anchor.part ?? '']);
    case 'solid3d': return JSON.stringify(['solid3d', anchor.id, anchor.part ?? '']);
    case 'dimension3d': return JSON.stringify(['dimension3d', anchor.id, anchor.part ?? '']);
    case 'table': return JSON.stringify(['table', anchor.table.toUpperCase(), anchor.name.toUpperCase()]);
    case 'shape-style': return JSON.stringify(['shape-style', anchor.sourceId]);
    case 'layout': return JSON.stringify(['layout', anchor.name.toUpperCase()]);
    case 'viewport': return JSON.stringify(['viewport', anchor.id]);
    case 'dictionary': return JSON.stringify(['dictionary', ...anchor.path]);
  }
}
export function validateCadGraph(graph: CadGraph): void {
  if (isImmutableData(graph) && checked.has(graph)) return;
  if (!graph || graph.schema !== 1 || !['DXF', 'DWG'].includes(graph.sourceFormat) || !Array.isArray(graph.nodes) || graph.nodes.length > MAX_NODES) invalid('Invalid or oversized retained CAD object graph.');
  if (graph.sourceVersion !== undefined && !identifier(graph.sourceVersion)) invalid('Invalid retained CAD source version.');
  if (graph.documentId !== undefined && !identifier(graph.documentId)) invalid('Invalid retained CAD document identity.');
  const ids = new Set<string>(), handles = new Set<string>(), anchors = new Set<string>();
  let groups = 0, text = (graph.sourceVersion?.length ?? 0) + (graph.documentId?.length ?? 0);
  for (const node of graph.nodes) {
    if (!node || !identifier(node.id) || !identifier(node.type) || !identifier(node.section) || ids.has(node.id) || !Array.isArray(node.groups)) invalid('Invalid or duplicate CAD object identity.');
    ids.add(node.id); text += node.id.length + node.type.length + node.section.length;
    if (text > MAX_TEXT) invalid('Retained CAD metadata exceeds the allocation budget.');
    if (node.sourceHandle !== undefined) {
      const handle = canonicalCadHandle(node.sourceHandle);
      if (handle === '0' || handles.has(handle)) invalid('Duplicate or null source CAD object handle.');
      handles.add(handle);
    }
    if (node.anchor) {
      const anchor = node.anchor;
      if (anchor.kind === 'entity' || anchor.kind === 'solid3d' || anchor.kind === 'dimension3d' ? !identifier(anchor.id) || anchor.part !== undefined && !identifier(anchor.part)
        : anchor.kind === 'table' ? !identifier(anchor.table) || !identifier(anchor.name)
          : anchor.kind === 'shape-style' ? !identifier(anchor.sourceId)
          : anchor.kind === 'layout' ? !identifier(anchor.name)
            : anchor.kind === 'viewport' ? !identifier(anchor.id)
            : anchor.kind === 'dictionary' ? !Array.isArray(anchor.path) || anchor.path.length > 64 || anchor.path.some((part) => !identifier(part)) : anchor.kind !== 'raw') invalid('Invalid CAD object anchor.');
      const key = cadAnchorKey(anchor);
      if (key && anchors.has(key)) invalid('Duplicate retained CAD object anchor.');
      if (key) { anchors.add(key); text += key.length; }
    }
    for (const pair of node.groups) {
      if (!Array.isArray(pair) || pair.length !== 2 || !Number.isInteger(pair[0]) || pair[0] < 0 || pair[0] > 1071 || typeof pair[1] !== 'string' || pair[1].length > MAX_VALUE) invalid('Invalid retained CAD group pair.');
      if (++groups > MAX_GROUPS || (text += pair[1].length) > MAX_TEXT) invalid('Retained CAD metadata exceeds the allocation budget.');
    }
    const positions = new Set<number>();
    for (const ref of node.references ?? []) {
      if (!ref || !Number.isInteger(ref.groupIndex) || ref.groupIndex < 0 || ref.groupIndex >= node.groups.length || positions.has(ref.groupIndex) || cadReferenceKind(node.groups[ref.groupIndex]![0]) !== ref.kind) invalid('Invalid retained CAD reference position or kind.');
      positions.add(ref.groupIndex);
      canonicalCadHandle(node.groups[ref.groupIndex]![1].trim());
      if (ref.sourceHandle !== undefined) canonicalCadHandle(ref.sourceHandle);
      if (ref.target !== undefined && !identifier(ref.target)) invalid('Invalid retained CAD reference target.');
      if ((text += (ref.target?.length ?? 0) + (ref.sourceHandle?.length ?? 0)) > MAX_TEXT) invalid('Retained CAD metadata exceeds the allocation budget.');
      if (ref.role !== undefined && !['owner', 'reactor', 'extension', 'xdata'].includes(ref.role)) invalid('Invalid retained CAD reference role.');
    }
    for (let index = 0; index < node.groups.length; index++) if (cadReferenceKind(node.groups[index]![0]) && !positions.has(index)) invalid('A retained CAD handle group has no typed reference edge.');
  }
  for (const node of graph.nodes) for (const ref of node.references ?? []) if (ref.target && !ids.has(ref.target)) invalid('Retained CAD reference points to a missing object identity.');
  if (graph.generatedHandles && (!Array.isArray(graph.generatedHandles) || graph.generatedHandles.length + graph.nodes.length > MAX_NODES)) invalid('Too many regenerated CAD handle hints.');
  const hintKeys = new Set<string>();
  for (const hint of graph.generatedHandles ?? []) {
    if (!hint || !identifier(hint.key) || hintKeys.has(hint.key)) invalid('Invalid or duplicate regenerated CAD handle key.');
    hintKeys.add(hint.key); const handle = canonicalCadHandle(hint.handle);
    if (handle === '0' || handles.has(handle)) invalid('Regenerated CAD handle hints conflict with retained object handles.');
    handles.add(handle);
    if ((text += hint.key.length + hint.handle.length) > MAX_TEXT) invalid('Retained CAD metadata exceeds the allocation budget.');
  }
  if (graph.diagnostics && (!Array.isArray(graph.diagnostics) || graph.diagnostics.length > 1000)) invalid('Too many CAD metadata diagnostics.');
  for (const diagnostic of graph.diagnostics ?? []) {
    if (!diagnostic || diagnostic.code !== 'external-soft-reference' || !identifier(diagnostic.nodeId) || !Number.isInteger(diagnostic.groupIndex) || typeof diagnostic.message !== 'string' || diagnostic.message.length > MAX_VALUE) invalid('Invalid CAD metadata diagnostic.');
    if ((text += diagnostic.message.length) > MAX_TEXT) invalid('Retained CAD metadata exceeds the allocation budget.');
  }
  if (isImmutableData(graph)) checked.add(graph);
}
/** Retained native clip polylines are real entities even while clipping is disabled. */
export function cadEntityLists(state: DrawingState): readonly (readonly Entity[])[] {
  const lists = [state.entities, ...Object.values(state.blocks).map(block => block.entities), ...(state.layouts ?? []).map(layout => layout.entities)];
  const boundaries = new Set<Entity>((state.layouts ?? []).flatMap(layout => layout.viewports.flatMap(viewport => viewport.clipBoundary ? [viewport.clipBoundary] : [])));
  if (!boundaries.size) return lists;
  const clips = new Set<Entity>(), identities = new Map<string, Entity>();
  const include = (entity: Entity): boolean => {
    const previous = identities.get(entity.id);
    if (previous && previous !== entity && (boundaries.has(previous) || boundaries.has(entity))) throw new CadGraphError('invalid', 'Distinct viewport clip entities cannot share one entity ID.');
    identities.set(entity.id, entity);
    if (!boundaries.has(entity)) return true;
    if (clips.has(entity)) return false;
    clips.add(entity); return true;
  };
  return [...lists.map(list => list.filter(include)), ...(state.layouts ?? []).map(layout => layout.viewports.flatMap(viewport => viewport.clipBoundary && include(viewport.clipBoundary) ? [viewport.clipBoundary] : []))];
}
/** Apply identities and native supplements to every modeled entity in the same inventory. */
export function mapCadEntities(state: DrawingState, fn: (entity: Entity) => Entity): DrawingState {
  cadEntityLists(state); // Reject ambiguous clip identities before invoking a mapping callback.
  const clips = new Map<Entity, Entity>(), boundaries = new Set<Entity>((state.layouts ?? []).flatMap(layout => layout.viewports.flatMap(viewport => viewport.clipBoundary ? [viewport.clipBoundary] : [])));
  const map = (entity: Entity) => {
    if (!boundaries.has(entity)) return fn(entity);
    let mapped = clips.get(entity); if (!mapped) { mapped = fn(entity); clips.set(entity, mapped); } return mapped;
  };
  return { ...state, entities: state.entities.map(map), blocks: Object.fromEntries(Object.entries(state.blocks).map(([name, block]) => [name, { ...block, entities: block.entities.map(map) }])),
    ...(state.layouts ? { layouts: state.layouts.map(layout => ({ ...layout, entities: layout.entities.map(map), viewports: layout.viewports.map(viewport => {
      const original = viewport.clipBoundary; if (!original) return viewport;
      const boundary = map(original);
      if (boundary.type !== 'polyline') throw new CadGraphError('invalid', 'A retained viewport clip must remain a polyline entity.');
      return boundary === original ? viewport : { ...viewport, clipBoundary: boundary };
    }) })) } : {}) };
}
const entityLists = cadEntityLists;
const allEntities = (state: DrawingState): Entity[] => entityLists(state).flat();
/** Typed model carriers remain outside Entity and all 2D renderer/geometry APIs. */
export type CadModelCarrier = { readonly kind: 'solid3d'; readonly object: Solid3D } | { readonly kind: 'dimension3d'; readonly object: Dimension3D };
export function cadModelCarriers(state: DrawingState): readonly CadModelCarrier[] {
  return [...(state.model3d?.solids ?? []).map(object => ({ kind: 'solid3d' as const, object })), ...(state.model3d?.dimensions ?? []).map(object => ({ kind: 'dimension3d' as const, object }))];
}
export function mapCadModelCarriers(state: DrawingState, mappers: { readonly solid?: (solid: Solid3D) => Solid3D; readonly dimension3d?: (dimension: Dimension3D) => Dimension3D }): DrawingState {
  const model = state.model3d;
  if (!model) return state;
  const solids = mappers.solid ? model.solids.map(mappers.solid) : model.solids;
  const dimensions = mappers.dimension3d ? model.dimensions?.map(mappers.dimension3d) : model.dimensions;
  if (solids.every((solid, index) => solid === model.solids[index]) && dimensions?.every((dimension, index) => dimension === model.dimensions?.[index]) !== false) return state;
  return { ...state, model3d: { ...model, solids, ...(dimensions ? { dimensions } : {}) } };
}
/** One ID namespace for selections and typed references, including inactive clip boundaries. */
function modelCarriers(state: DrawingState): Map<string, CadModelCarrier> {
  const result = new Map<string, CadModelCarrier>();
  if (!state.model3d) return result;
  const occupied = new Set<string>();
  const add = (id: string) => {
    if (occupied.has(id)) invalid('3D drawings need unique IDs across their 2D entities and viewport carriers.');
    occupied.add(id);
  };
  for (const entity of allEntities(state)) add(entity.id);
  for (const layout of state.layouts ?? []) for (const viewport of layout.viewports) add(viewport.id);
  for (const carrier of cadModelCarriers(state)) {
    if (occupied.has(carrier.object.id) || result.has(carrier.object.id)) invalid('3D objects need unique IDs across solids, dimensions, 2D entities, blocks, layouts and viewports.');
    result.set(carrier.object.id, carrier);
  }
  return result;
}
function replaceModelIdentities(state: DrawingState, identities: ReadonlyMap<string, string>): DrawingState {
  return mapCadModelCarriers(state, {
    solid: solid => identities.has(solid.id) ? { ...solid, cadIdentity: identities.get(solid.id)! } : solid,
    dimension3d: dimension => identities.has(dimension.id) ? { ...dimension, cadIdentity: identities.get(dimension.id)! } : dimension,
  });
}
const isOwner = (ref: CadReference): boolean => ref.kind === 'hard-owner' || ref.kind === 'soft-owner' || ref.role === 'extension';
function owned(graph: CadGraph, roots: ReadonlySet<string>): Set<string> {
  const children = new Map<string, string[]>();
  const owners = new Map<string, string>();
  const add = (parent: string, child: string) => { const list = children.get(parent) ?? []; list.push(child); children.set(parent, list); };
  const mainEntities = new Map(graph.nodes.flatMap((node) => (node.anchor?.kind === 'entity' || node.anchor?.kind === 'solid3d' || node.anchor?.kind === 'dimension3d') && !node.anchor.part ? [[cadAnchorKey(node.anchor)!, node.id] as const] : []));
  // INSERT followers and consumed LEADER annotations have logical ownership even if their
  // source common-owner handle names a block record rather than the modeled parent entity.
  for (const node of graph.nodes) if ((node.anchor?.kind === 'entity' || node.anchor?.kind === 'solid3d' || node.anchor?.kind === 'dimension3d') && node.anchor.part) {
    const parent = mainEntities.get(cadAnchorKey({ ...node.anchor, part: undefined })!); if (parent) add(parent, node.id);
  }
  for (const node of graph.nodes) for (const ref of node.references ?? []) if (ref.target && ref.role === 'owner') owners.set(node.id, ref.target);
  for (const node of graph.nodes) for (const ref of node.references ?? []) if (ref.target) {
    if (isOwner(ref)) {
      const owner = owners.get(ref.target);
      if (owner && owner !== node.id) {
        if (ref.kind === 'soft-owner') continue; // A soft dictionary alias does not own another parent's object.
        throw new CadGraphError('dependency', `Cannot edit ${node.type}: a retained hard-owned object has a conflicting canonical owner.`);
      }
      add(node.id, ref.target);
    } else if (ref.role === 'owner') add(ref.target, node.id);
  }
  const result = new Set(roots), pending = [...roots];
  while (pending.length) for (const child of children.get(pending.pop()!) ?? []) if (!result.has(child)) { result.add(child); pending.push(child); }
  return result;
}
function replaceEntityIdentities(state: DrawingState, identities: ReadonlyMap<string, string>): DrawingState {
  return mapCadEntities(state, entity => identities.has(entity.id) ? { ...entity, cadIdentity: identities.get(entity.id)! } : entity);
}
function matrix(transform: CadAffineTransform): number[][] {
  const m = [[transform.xx, transform.xy, transform.xz ?? 0], [transform.yx, transform.yy, transform.yz ?? 0], [transform.zx ?? 0, transform.zy ?? 0, transform.zz ?? 1]];
  if (![...m.flat(), transform.tx, transform.ty, transform.tz ?? 0, transform.distanceScale ?? 1].every(Number.isFinite) || transform.distanceScale !== undefined && transform.distanceScale <= 0) throw new CadGraphError('transform', 'Retained CAD metadata requires a finite affine transform and positive distance scale.');
  return m;
}
/** Apply only documented XDATA geometry. XRECORD values, binary blobs and ordinary strings are opaque. */
export function transformCadGroups(groups: readonly CadGroup[], transform: CadAffineTransform): readonly CadGroup[] {
  const m = matrix(transform), translation = [transform.tx, transform.ty, transform.tz ?? 0];
  const lengths = [0, 1, 2].map((column) => Math.hypot(...m.map((row) => row[column]!)));
  const scale = transform.distanceScale ?? (Math.max(...lengths) - Math.min(...lengths) < 1e-9 ? lengths[0]! : undefined);
  let changed = false, xdata = false; const out: CadGroup[] = [...groups];
  for (let index = 0; index < groups.length; index++) {
    const [code, value] = groups[index]!;
    if (code === 1001) { xdata = true; continue; }
    if (!xdata) continue;
    if (code === 1011 || code === 1012 || code === 1013) {
      if (groups[index + 1]?.[0] !== code + 10 || groups[index + 2]?.[0] !== code + 20) throw new CadGraphError('transform', 'A retained XDATA point has incomplete XYZ coordinates.');
      const point = [value, groups[index + 1]![1], groups[index + 2]![1]].map(Number);
      if (!point.every(Number.isFinite)) throw new CadGraphError('transform', 'A retained XDATA point contains an invalid coordinate.');
      let linear = m;
      if (code === 1013) {
        if (!scale || lengths.some((length) => Math.abs(length - scale) > 1e-9 * Math.max(1, scale))) throw new CadGraphError('transform', 'World-direction XDATA cannot be transformed with an unmodeled nonuniform scale.');
        linear = m.map((row) => row.map((value) => value / scale));
        for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) if (Math.abs(linear.reduce((sum, row) => sum + row[a]! * row[b]!, 0)) > 1e-9) throw new CadGraphError('transform', 'World-direction XDATA cannot be transformed with an unmodeled shear.');
      }
      for (let row = 0; row < 3; row++) {
        const result = linear[row]!.reduce((sum, value, column) => sum + value * point[column]!, 0) + (code === 1011 ? translation[row]! : 0);
        if (!Number.isFinite(result)) throw new CadGraphError('transform', 'Retained XDATA transform exceeds finite coordinate limits.');
        out[index + row] = [code + row * 10, String(result === 0 ? 0 : result)];
      }
      changed = true; index += 2;
    } else if (code === 1041 || code === 1042) {
      if (scale === undefined) throw new CadGraphError('transform', 'Retained XDATA distances need an explicit uniform distance scale.');
      const result = Number(value) * scale;
      if (!Number.isFinite(result)) throw new CadGraphError('transform', 'Retained XDATA distance transform exceeds finite limits.');
      out[index] = [code, String(result === 0 ? 0 : result)]; changed = true;
    }
  }
  return changed ? out : groups;
}
let cloneSerial = 0;
/** Copies declared sets, their owned metadata and proven internal links; never infers copy pairing. */
export function cloneCadEntitySets(targetState: DrawingState, batches: readonly CadCloneBatch[]): DrawingState {
  let state = targetState;
  for (const batch of batches) {
    const sourceState = batch.sourceState ?? targetState, source = graphOf(sourceState);
    if (!source) continue;
    validateCadGraph(source);
    const graph = graphOf(state), targetGraph = graphOf(targetState);
    const targetIds = new Set(targetGraph?.nodes.map(node => node.id));
    const sameDocument = source === targetGraph || !!targetGraph && (source.documentId && targetGraph.documentId ? source.documentId === targetGraph.documentId : source.nodes.some(node => targetIds.has(node.id)));
    const crossDocument = !sameDocument, nodes = [...(graph?.nodes ?? [])];
    const sourceEntities = new Map(allEntities(sourceState).map((entity) => [entity.id, entity])), destinations = new Map(allEntities(state).map((entity) => [entity.id, entity]));
    const sourceModels = modelCarriers(sourceState), destinationModels = modelCarriers(state);
    const sourceNodes = new Map(source.nodes.map((node) => [node.id, node]));
    const selected = new Set(Object.keys(batch.entityIds));
    const selectedSolids = new Set(Object.keys(batch.solidIds ?? {})), selectedDimensions = new Set(Object.keys(batch.dimension3dIds ?? {}));
    const anchorRemaps = new Map((batch.anchorRemaps ?? []).map(remap => [cadAnchorKey(remap.from), remap.to]));
    if (anchorRemaps.has(undefined)) throw new CadGraphError('copy', 'Structural CAD copies require a specific source anchor.');
    const roots = new Set(source.nodes.filter((node) => node.anchor?.kind === 'entity' && selected.has(node.anchor.id) || node.anchor?.kind === 'solid3d' && selectedSolids.has(node.anchor.id) || node.anchor?.kind === 'dimension3d' && selectedDimensions.has(node.anchor.id) || anchorRemaps.has(cadAnchorKey(node.anchor))).map((node) => node.id));
    const closure = owned(source, roots), remap = new Map<string, string>(), identities = new Map<string, string>(), modelIdentities = new Map<string, string>();
    if (crossDocument) {
      const className = (node: CadNode) => node.section === 'CLASSES' && node.type === 'CLASS' ? node.groups.find(([code]) => code === 1)?.[1].toUpperCase() : undefined;
      const targetClasses = new Map(nodes.flatMap((node) => { const name = className(node); return name ? [[name, node] as const] : []; }));
      const types = new Set(source.nodes.filter((node) => closure.has(node.id)).map((node) => node.type.toUpperCase()));
      // CLASS91 counts instances and is regenerated on output; other definition data must agree.
      const definition = (node: CadNode) => JSON.stringify(node.groups.filter(([code]) => code !== 91));
      for (const sourceClass of source.nodes) {
        const name = className(sourceClass);
        if (!name || !types.has(name)) continue;
        const existing = targetClasses.get(name);
        if (existing && definition(existing) !== definition(sourceClass)) throw new CadGraphError('dependency', `Cannot copy ${name}: the destination drawing has a conflicting CAD class definition.`);
        if (!existing) closure.add(sourceClass.id);
      }
    }
    if (nodes.length + closure.size > MAX_NODES) invalid('CAD copy exceeds the retained object allocation budget.');
    const occupied = new Set(nodes.map((node) => node.id));
    const targetAnchors = new Map(nodes.flatMap((node) => { const key = cadAnchorKey(node.anchor); return key ? [[key, node.id] as const] : []; }));
    const diagnostics = [...(graph?.diagnostics ?? [])];
    for (const [oldId, newId] of Object.entries(batch.entityIds)) {
      if (!sourceEntities.has(oldId) || !destinations.has(newId) || oldId === newId && !crossDocument) throw new CadGraphError('copy', 'CAD copy intent does not name an existing source and distinct destination entity.');
    }
    for (const kind of ['solid3d', 'dimension3d'] as const) {
      const mapping = kind === 'solid3d' ? batch.solidIds : batch.dimension3dIds;
      for (const [oldId, newId] of Object.entries(mapping ?? {})) {
        if (sourceModels.get(oldId)?.kind !== kind || destinationModels.get(newId)?.kind !== kind || oldId === newId && !crossDocument) throw new CadGraphError('copy', 'CAD 3D copy intent needs an existing source and distinct destination of the same carrier kind.');
      }
    }
    for (const node of source.nodes) if (closure.has(node.id)) {
      let id: string;
      do { id = `${node.id}:clone:${++cloneSerial}`; } while (occupied.has(id));
      occupied.add(id);
      remap.set(node.id, id);
    }
    for (const node of source.nodes) if (closure.has(node.id)) {
      const id = remap.get(node.id)!, groups: CadGroup[] = [...node.groups], removedGroups = new Set<number>();
      const references = (node.references ?? []).flatMap((ref): CadReference[] => {
        if (ref.kind === 'arbitrary') {
          if (!crossDocument && (!ref.target || occupied.has(ref.target))) return [ref];
          const { target: _drop, ...rest } = ref; return [rest];
        }
        const mapped = ref.target && remap.get(ref.target);
        if (mapped) return [{ ...ref, target: mapped }];
        if (!ref.target && (ref.kind === 'hard-pointer' || ref.kind === 'hard-owner') && canonicalCadHandle(groups[ref.groupIndex]![1].trim()) !== '0') throw new CadGraphError('dependency', `Cannot copy ${node.type}: unresolved hard reference in group ${groups[ref.groupIndex]![0]} has no retained dependency.`);
        if (!crossDocument && (!ref.target || occupied.has(ref.target))) return [ref];
        const sourceTarget = ref.target ? sourceNodes.get(ref.target) : undefined, key = cadAnchorKey(sourceTarget?.anchor), matching = key && targetAnchors.get(key);
        if (matching) return [{ ...ref, target: matching }];
        const handle = canonicalCadHandle(groups[ref.groupIndex]![1].trim());
        if (handle === '0') { const { target: _drop, ...rest } = ref; return [rest]; }
        if (ref.kind === 'hard-pointer' || ref.kind === 'hard-owner') throw new CadGraphError('dependency', `Cannot copy ${node.type}: its hard reference in group ${groups[ref.groupIndex]![0]} depends on an object outside the copied set.`);
        if (/^(DICTIONARY|ACDBDICTIONARYWDFLT)$/i.test(node.type) && ref.kind === 'soft-owner' && groups[ref.groupIndex - 1]?.[0] === 3) {
          removedGroups.add(ref.groupIndex - 1); removedGroups.add(ref.groupIndex);
          diagnostics.push({ code: 'external-soft-reference', nodeId: id, groupIndex: ref.groupIndex, message: `Copied ${node.type}: dictionary entry "${groups[ref.groupIndex - 1]![1]}" was removed because its soft-owned alias refers outside the copied set.` });
          return [];
        }
        groups[ref.groupIndex] = [groups[ref.groupIndex]![0], '0'];
        diagnostics.push({ code: 'external-soft-reference', nodeId: id, groupIndex: ref.groupIndex, message: `Copied ${node.type} group ${groups[ref.groupIndex]![0]}: external source reference ${ref.sourceHandle ?? handle} was set to 0 in the destination drawing.` });
        const { target: _drop, ...rest } = ref; return [{ ...rest, sourceHandle: '0' }];
      });
      let anchor = node.anchor;
      if (anchor?.kind === 'entity') {
        const sourceEntity = sourceEntities.get(anchor.id);
        const destination = batch.entityIds[anchor.id];
        if (!destination) throw new CadGraphError('dependency', 'An owned CAD object refers to an entity outside its declared copy batch.');
        anchor = { ...anchor, id: destination };
        // The importer marks metadata-bearing owners and retained-reference targets explicitly.
        // Plain geometry stays usable in previews/derived primitives without carrying a graph.
        if (!anchor.part && sourceEntity?.cadIdentity) identities.set(destination, id);
      } else if (anchor?.kind === 'solid3d' || anchor?.kind === 'dimension3d') {
        const destination = (anchor.kind === 'solid3d' ? batch.solidIds : batch.dimension3dIds)?.[anchor.id];
        if (!destination) throw new CadGraphError('dependency', 'An owned CAD object refers to a 3D carrier outside its declared copy batch.');
        anchor = { ...anchor, id: destination };
        if (!anchor.part) modelIdentities.set(destination, id);
      } else if (anchorRemaps.has(cadAnchorKey(anchor))) anchor = anchorRemaps.get(cadAnchorKey(anchor))!;
      else if (anchor?.kind === 'dictionary') anchor = { kind: 'raw' };
      const { sourceHandle: _source, baselineEntity: _baseline, baselineSolid: _solid, baselineDimension3D: _dimension, ...rest } = node;
      const keptGroups = groups.filter((_, index) => !removedGroups.has(index));
      // Imported follower identities describe the source topology, including copy transforms.
      // Preserve that proof instead of making a retessellated destination its own new baseline.
      const sourceCarrier = node.anchor?.kind === 'solid3d' ? sourceModels.get(node.anchor.id) : undefined;
      const destinationCarrier = anchor?.kind === 'dimension3d' ? destinationModels.get(anchor.id) : undefined;
      const baseline = anchor?.kind === 'solid3d' && !anchor.part ? { baselineSolid: node.baselineSolid ?? (sourceCarrier?.kind === 'solid3d' ? sourceCarrier.object : undefined) }
        : anchor?.kind === 'dimension3d' && !anchor.part ? { baselineDimension3D: destinationCarrier?.kind === 'dimension3d' ? destinationCarrier.object : undefined }
          : anchor?.kind === 'entity' && !anchor.part ? { baselineEntity: destinations.get(anchor.id)! } : {};
      nodes.push({ ...rest, id, anchor, groups: batch.transform ? transformCadGroups(keptGroups, batch.transform) : keptGroups, references: references.map(ref => ({ ...ref, groupIndex: ref.groupIndex - [...removedGroups].filter(index => index < ref.groupIndex).length })), ...baseline });
    }
    if (closure.size) {
      state = replaceEntityIdentities(state, identities);
      state = replaceModelIdentities(state, modelIdentities);
      state = withCadGraph(state, { schema: 1, documentId: graph?.documentId ?? (sameDocument ? source.documentId : undefined) ?? newId(), sourceFormat: graph?.sourceFormat ?? source.sourceFormat, ...(graph?.sourceVersion ?? source.sourceVersion ? { sourceVersion: graph?.sourceVersion ?? source.sourceVersion } : {}), nodes, ...(graph?.generatedHandles ? { generatedHandles: graph.generatedHandles } : {}), ...(diagnostics.length ? { diagnostics } : {}) });
    }
  }
  const graph = graphOf(state);
  return graph ? withCadGraph(state, ensureFieldRegistry(graph)) : state;
}
const FIELDLIST_CLASS: readonly CadGroup[] = [[1, 'FIELDLIST'], [2, 'AcDbFieldList'], [3, 'ObjectDBX Classes'], [90, '1152'], [91, '1'], [280, '0'], [281, '0']];
/** Canonical R2018 document infrastructure, proven by the independent AutoCAD FIELD fixture. */
function ensureFieldRegistry(graph: CadGraph): CadGraph {
  if (!graph.nodes.some(node => node.type === 'FIELD')) return refreshFieldLists(graph);
  const nodes = [...graph.nodes], occupied = new Set(nodes.map(node => node.id));
  const fresh = (kind: string) => { let id: string; do { id = `cad:${kind}:${newId()}`; } while (occupied.has(id)); occupied.add(id); return id; };
  const classDefinition = nodes.find(node => node.section === 'CLASSES' && node.type === 'CLASS' && node.groups.find(([code]) => code === 1)?.[1].trim().toUpperCase() === 'FIELDLIST');
  const definition = (groups: readonly CadGroup[]) => JSON.stringify(groups.filter(([code]) => code !== 91).map(([code, value]) => [code, value.trim()]));
  if (classDefinition && definition(classDefinition.groups) !== definition(FIELDLIST_CLASS)) throw new CadGraphError('dependency', 'Cannot create the native FIELD registry: the destination has a conflicting FIELDLIST class definition.');
  if (!classDefinition) nodes.push({ id: fresh('fieldlist-class'), type: 'CLASS', section: 'CLASSES', anchor: { kind: 'raw' }, groups: FIELDLIST_CLASS });
  if (!nodes.some(node => node.type === 'FIELDLIST')) {
    let rootIndex = nodes.findIndex(node => node.anchor?.kind === 'dictionary' && node.anchor.path.length === 0);
    if (rootIndex < 0) {
      rootIndex = nodes.length;
      nodes.push({ id: fresh('nod'), type: 'DICTIONARY', section: 'OBJECTS', anchor: { kind: 'dictionary', path: [] }, groups: [[5, '0'], [330, '0'], [100, 'AcDbDictionary'], [281, '1']], references: [{ groupIndex: 1, kind: 'soft-pointer', role: 'owner' }] });
    }
    const root = nodes[rootIndex]!;
    if (root.groups.some(([code, name]) => code === 3 && name === 'ACAD_FIELDLIST')) throw new CadGraphError('dependency', 'Cannot create the native FIELD registry: the ACAD_FIELDLIST dictionary entry has an unresolved or incompatible target.');
    const listId = fresh('fieldlist');
    nodes[rootIndex] = { ...root, groups: [...root.groups, [3, 'ACAD_FIELDLIST'], [350, '0']], references: [...(root.references ?? []), { groupIndex: root.groups.length + 1, kind: 'soft-owner', target: listId }] };
    nodes.push({ id: listId, type: 'FIELDLIST', section: 'OBJECTS', anchor: { kind: 'raw' }, groups: [[5, '0'], [102, '{ACAD_REACTORS'], [330, '0'], [102, '}'], [330, '0'], [100, 'AcDbIdSet'], [90, '0'], [100, 'AcDbFieldList']], references: [{ groupIndex: 2, kind: 'soft-pointer', role: 'reactor', target: root.id }, { groupIndex: 4, kind: 'soft-pointer', role: 'owner', target: root.id }] });
  }
  return refreshFieldLists({ ...graph, nodes });
}
/** FIELDLIST is a native document registry, not a generic soft-pointer payload. */
function refreshFieldLists(graph: CadGraph): CadGraph {
  const fields = graph.nodes.filter(node => node.type === 'FIELD');
  let changed = false;
  const nodes = graph.nodes.map(node => {
    if (node.type !== 'FIELDLIST') return node;
    const members = new Set((node.references ?? []).filter(ref => !ref.role && node.groups[ref.groupIndex]?.[0] === 330).flatMap(ref => ref.target ? [ref.target] : []));
    const additions = fields.filter(field => !members.has(field.id)), count = members.size + additions.length;
    if (!additions.length && node.groups.filter(([code]) => code === 90).every(([, raw]) => Number(raw) === count)) return node;
    changed = true;
    const groups: CadGroup[] = node.groups.map(pair => pair[0] === 90 ? [90, String(count)] : pair);
    const end = groups.findIndex(([code, value]) => code === 100 && value === 'AcDbFieldList'), at = end < 0 ? groups.length : end;
    const references: CadReference[] = (node.references ?? []).map(ref => ({ ...ref, groupIndex: ref.groupIndex >= at ? ref.groupIndex + additions.length : ref.groupIndex }));
    const memberGroups: CadGroup[] = [];
    for (const field of additions) { references.push({ groupIndex: at + memberGroups.length, kind: 'soft-pointer', target: field.id }); memberGroups.push([330, field.sourceHandle ?? '0']); }
    groups.splice(at, 0, ...memberGroups);
    return { ...node, groups, references };
  });
  return changed ? { ...graph, nodes } : graph;
}
function graphEntities(state: DrawingState): Map<string, Entity> {
  const result = new Map<string, Entity>();
  for (const entity of allEntities(state)) {
    if (result.has(entity.id)) throw new CadGraphError('invalid', 'CAD metadata needs unique entity IDs across model space, layouts and block definitions.');
    result.set(entity.id, entity);
  }
  return result;
}
function removeNodes(graph: CadGraph, removed: ReadonlySet<string>): CadGraph {
  const nodes = graph.nodes.filter((node) => !removed.has(node.id)).map((node) => {
    let changed = false; const groups: CadGroup[] = [...node.groups], deletedGroups = new Set<number>();
    const references = (node.references ?? []).flatMap((ref): CadReference[] => {
      if (!ref.target || !removed.has(ref.target)) return [ref];
      if (ref.kind === 'arbitrary') { changed = true; const { target: _drop, ...rest } = ref; return [rest]; }
      // Dictionary ownership is detachable; GROUP membership and reactor lists explicitly allow erase.
      const dictionaryEntry = /^(DICTIONARY|ACDBDICTIONARYWDFLT)$/i.test(node.type) && isOwner(ref) && groups[ref.groupIndex - 1]?.[0] === 3;
      if (dictionaryEntry || node.type.toUpperCase() === 'GROUP' && groups[ref.groupIndex]![0] === 340 || node.type === 'FIELDLIST' && !ref.role && groups[ref.groupIndex]![0] === 330 || ref.role === 'reactor') {
        deletedGroups.add(ref.groupIndex); if (dictionaryEntry) deletedGroups.add(ref.groupIndex - 1); changed = true; return [];
      }
      if (ref.kind === 'hard-pointer' || ref.kind === 'hard-owner') throw new CadGraphError('dependency', `Cannot remove referenced CAD data: ${node.type} group ${groups[ref.groupIndex]![0]} has a hard dependency on the removed object.`);
      groups[ref.groupIndex] = [groups[ref.groupIndex]![0], '0']; changed = true;
      const { target: _drop, ...rest } = ref; return [{ ...rest, sourceHandle: '0' }];
    });
    if (!changed) return node;
    const shift = (index: number) => index - [...deletedGroups].filter((position) => position < index).length;
    return { ...node, groups: groups.filter((_, index) => !deletedGroups.has(index)), references: references.map((ref) => ({ ...ref, groupIndex: shift(ref.groupIndex) })) };
  });
  return refreshFieldLists({ ...graph, nodes });
}
/** Build semantic presence once per state; opaque retained tables do not participate in erase. */
function anchorPresence(state: DrawingState): ReadonlySet<string> {
  const result = new Set<string>();
  const table = (kind: string, names: readonly string[]) => names.forEach(name => result.add(cadAnchorKey({ kind: 'table', table: kind, name })!));
  table('LAYER', state.layers.map(layer => layer.name)); table('BLOCK_RECORD', Object.keys(state.blocks));
  table('VIEW', (state.header?.views ?? []).map(view => view.name)); table('LTYPE', (state.header?.linetypes ?? []).map(line => line.name));
  table('STYLE', Object.keys((state.meta?.textStyles ?? {}) as object));
  for (const sourceId of Object.keys((state.meta?.shapeStyles ?? {}) as object)) result.add(cadAnchorKey({ kind: 'shape-style', sourceId })!);
  table('DIMSTYLE', [...(state.header?.dimStyle.name ? [state.header.dimStyle.name] : []), ...Object.keys((state.meta?.dimStyles ?? {}) as object)]);
  for (const layout of state.layouts ?? []) {
    result.add(cadAnchorKey({ kind: 'layout', name: layout.name })!);
    for (const viewport of layout.viewports) result.add(cadAnchorKey({ kind: 'viewport', id: viewport.id })!);
  }
  return result;
}
function fieldBranchRoots(graph: CadGraph, owner: string): Set<string> {
  const branch = owned(graph, new Set([owner])), roots = new Set<string>();
  for (const node of graph.nodes) if (branch.has(node.id)) {
    if (node.anchor?.kind === 'dictionary' && node.anchor.path.at(-1)?.toUpperCase() === 'ACAD_FIELD') roots.add(node.id);
    if (/^(DICTIONARY|ACDBDICTIONARYWDFLT)$/i.test(node.type)) for (const ref of node.references ?? []) {
      if (ref.target && isOwner(ref) && node.groups[ref.groupIndex - 1]?.[0] === 3 && node.groups[ref.groupIndex - 1]![1].toUpperCase() === 'ACAD_FIELD') roots.add(ref.target);
    }
  }
  return roots;
}
function manualFieldTextChanged(node: CadNode, current: Entity, before: Entity | undefined): boolean {
  const part = node.anchor?.kind === 'entity' ? node.anchor.part : undefined;
  if (part?.startsWith('attribute:') && current.type === 'insert' && before?.type === 'insert') return current.attributes[part.slice('attribute:'.length)] !== before.attributes[part.slice('attribute:'.length)];
  if (part === 'annotation' && current.type === 'leader' && before?.type === 'leader') return current.text !== before.text;
  if (part) return false;
  return !!before && (before.type === 'text' || before.type === 'mtext') && (current.type === 'text' || current.type === 'mtext') && current.text !== before.text && (!current.field || current.field.value !== current.text);
}
/** State-level identity guard also applies to load and restored undo/redo snapshots. */
export function validateCadState(state: DrawingState): void {
  const carriers = modelCarriers(state);
  const graph = graphOf(state);
  if (!graph) {
    for (const entities of entityLists(state)) {
      if (isImmutableData(entities) && withoutIdentity.has(entities)) continue;
      if (entities.some((entity) => entity.cadIdentity)) throw new CadGraphError('copy', 'Entity CAD identities require their retained object graph; copy with a captured source state.');
      if (isImmutableData(entities)) withoutIdentity.add(entities);
    }
    if ([...carriers.values()].some(carrier => carrier.object.cadIdentity !== undefined)) throw new CadGraphError('copy', '3D CAD identities require their retained object graph.');
    return;
  }
  validateCadGraph(graph);
  const main = new Map(graph.nodes.flatMap((node) => node.anchor?.kind === 'entity' && !node.anchor.part ? [[node.id, node.anchor.id] as const] : [])), identities = new Set<string>();
  for (const entity of allEntities(state)) if (entity.cadIdentity) {
    if (identities.has(entity.cadIdentity) || main.get(entity.cadIdentity) !== entity.id) throw new CadGraphError('copy', 'An entity CAD identity is shared or missing its retained object anchor.');
    identities.add(entity.cadIdentity);
  }
  const modelMain = new Map(graph.nodes.flatMap(node => (node.anchor?.kind === 'solid3d' || node.anchor?.kind === 'dimension3d') && !node.anchor.part ? [[cadAnchorKey(node.anchor)!, node.id] as const] : []));
  for (const node of graph.nodes) if (node.anchor?.kind === 'solid3d' || node.anchor?.kind === 'dimension3d') {
    const carrier = carriers.get(node.anchor.id), primary = modelMain.get(cadAnchorKey({ ...node.anchor, part: undefined })!);
    if (!carrier || carrier.kind !== node.anchor.kind || !primary || carrier.object.cadIdentity !== primary) invalid('A retained 3D carrier or follower is missing its live typed object identity.');
  }
  for (const carrier of carriers.values()) if (carrier.object.cadIdentity !== undefined) {
    const identity = carrier.object.cadIdentity;
    if (identities.has(identity) || modelMain.get(cadAnchorKey({ kind: carrier.kind, id: carrier.object.id })!) !== identity) throw new CadGraphError('copy', 'A 3D CAD identity is shared or missing its retained typed object anchor.');
    identities.add(identity);
  }
}
/**
 * Reconcile a complete edit atomically. Same-ID edits retain identity. Copies require declared
 * batches. Owned subgraphs disappear with their owner; unresolved hard dependents protect data.
 * A manual TEXT/MTEXT override removes only its ACAD_FIELD-owned branch, leaving other apps intact.
 */
export function reconcileCadGraph(previous: DrawingState, next: DrawingState, intent: CadGraphEditIntent = {}): DrawingState {
  const original = graphOf(previous), supplied = graphOf(next);
  if (!original && !supplied && !intent.cloneBatches?.some((batch) => batch.sourceState?.cadGraph)) { validateCadState(next); return next; }
  let state = supplied || !original ? next : withCadGraph(next, original);
  if (intent.cloneBatches?.length) state = cloneCadEntitySets(state, intent.cloneBatches.map((batch) => ({ ...batch, sourceState: batch.sourceState ?? previous })));
  let graph = graphOf(state);
  if (!graph) return state;
  validateCadGraph(graph);
  const before = graphEntities(previous), after = graphEntities(state), identities = new Map<string, string>();
  const beforeModels = modelCarriers(previous), afterModels = modelCarriers(state), modelIdentities = new Map<string, string>();
  const beforeAnchors = anchorPresence(previous), afterAnchors = anchorPresence(state);
  const removed = new Set<string>(), mainNodes = graph.nodes.filter((node) => node.anchor?.kind === 'entity' && !node.anchor.part);
  for (const node of graph.nodes) if (node.anchor && node.anchor.kind !== 'entity') { const key = cadAnchorKey(node.anchor); if (key && beforeAnchors.has(key) && !afterAnchors.has(key)) removed.add(node.id); }
  for (const node of mainNodes) {
    const anchor = node.anchor! as Extract<CadAnchor, { kind: 'entity' }>, entity = after.get(anchor.id), old = before.get(anchor.id) ?? node.baselineEntity;
    if (!entity) { removed.add(node.id); continue; }
    if (entity.cadIdentity && entity.cadIdentity !== node.id) throw new CadGraphError('copy', 'An entity CAD identity does not match its retained object anchor. Declare the copy batch.');
    if (entity.cadIdentity || old?.cadIdentity) identities.set(entity.id, node.id);
    if (old && old.type !== entity.type) {
      const extras = owned(graph, new Set([node.id])); extras.delete(node.id);
      if (extras.size) throw new CadGraphError('dependency', `Cannot replace ${old.type} with ${entity.type} while it owns retained CAD metadata; use an explicit supported conversion.`);
    }
    if (manualFieldTextChanged(node, entity, old)) for (const field of owned(graph, fieldBranchRoots(graph, node.id))) removed.add(field);
  }
  for (const node of graph.nodes) if (node.anchor?.kind === 'entity' && node.anchor.part) {
    const current = after.get(node.anchor.id), old = before.get(node.anchor.id);
    if (current && manualFieldTextChanged(node, current, old)) for (const field of owned(graph, fieldBranchRoots(graph, node.id))) removed.add(field);
  }
  const modelMain = graph.nodes.filter(node => (node.anchor?.kind === 'solid3d' || node.anchor?.kind === 'dimension3d') && !node.anchor.part);
  const solidFollowers = new Set(graph.nodes.flatMap(node => node.anchor?.kind === 'solid3d' && node.anchor.part ? [node.anchor.id] : []));
  for (const node of modelMain) {
    const anchor = node.anchor;
    if (anchor?.kind !== 'solid3d' && anchor?.kind !== 'dimension3d') continue;
    const carrier = afterModels.get(anchor.id), old = beforeModels.get(anchor.id);
    if (!carrier) { removed.add(node.id); continue; }
    if (carrier.kind !== anchor.kind || old && old.kind !== carrier.kind) throw new CadGraphError('dependency', 'Cannot change the kind of a retained 3D carrier without a supported conversion.');
    if (carrier.object.cadIdentity && carrier.object.cadIdentity !== node.id) throw new CadGraphError('copy', 'A 3D CAD identity does not match its retained anchor. Declare its copy batch.');
    modelIdentities.set(anchor.id, node.id);
    if (carrier.kind === 'solid3d' && solidFollowers.has(anchor.id)) {
      const baseline = node.baselineSolid ?? (old?.kind === 'solid3d' ? old.object : undefined);
      const mesh = carrier.object.mesh;
      if (!baseline || baseline.mesh.positions.length !== mesh.positions.length || baseline.mesh.indices.length !== mesh.indices.length || baseline.mesh.indices.some((value, index) => value !== mesh.indices[index])) throw new CadGraphError('dependency', 'Cannot change imported 3D topology: retained polyface follower correspondence is not proven.');
    }
    if (carrier.kind === 'dimension3d') {
      const baseline = old?.kind === 'dimension3d' ? old.object : node.baselineDimension3D;
      if (baseline && baseline.kind !== carrier.object.kind) throw new CadGraphError('dependency', 'Cannot change the kind of a retained 3D dimension without an explicit conversion.');
    }
  }
  // Missing carrier roots also erase every structural follower through the owned closure.
  for (const node of graph.nodes) if ((node.anchor?.kind === 'solid3d' || node.anchor?.kind === 'dimension3d') && !afterModels.has(node.anchor.id)) removed.add(node.id);
  const used = new Set<string>();
  const anchored = new Map(mainNodes.map((node) => [node.id, node.anchor!.kind === 'entity' ? node.anchor!.id : '']));
  for (const entity of after.values()) if (entity.cadIdentity) {
    if (used.has(entity.cadIdentity) || anchored.get(entity.cadIdentity) !== entity.id) throw new CadGraphError('copy', 'Copied entities with retained CAD data require an explicit clone batch; original identities cannot be shared.');
    used.add(entity.cadIdentity);
  }
  const anchoredModels = new Map(modelMain.map(node => [node.id, cadAnchorKey(node.anchor)]));
  for (const carrier of afterModels.values()) if (carrier.object.cadIdentity) {
    const identity = carrier.object.cadIdentity;
    if (used.has(identity) || anchoredModels.get(identity) !== cadAnchorKey({ kind: carrier.kind, id: carrier.object.id })) throw new CadGraphError('copy', 'Copied 3D objects with retained CAD data require an explicit clone batch.');
    used.add(identity);
  }
  if (removed.size) graph = removeNodes(graph, owned(graph, removed));
  for (const edit of intent.transforms ?? []) {
    const selected = new Set(edit.entityIds), solids = new Set(edit.solidIds), dimensions = new Set(edit.dimension3dIds);
    const roots = new Set(graph.nodes.filter(node => (node.anchor?.kind === 'entity' || node.anchor?.kind === 'viewport') && selected.has(node.anchor.id) || node.anchor?.kind === 'solid3d' && solids.has(node.anchor.id) || node.anchor?.kind === 'dimension3d' && dimensions.has(node.anchor.id)).map(node => node.id)), closure = owned(graph, roots);
    graph = { ...graph, nodes: graph.nodes.map((node) => closure.has(node.id) ? { ...node, groups: transformCadGroups(node.groups, edit.transform) } : node) };
  }
  if ([...identities].some(([id, identity]) => after.get(id)!.cadIdentity !== identity)) state = replaceEntityIdentities(state, identities);
  if ([...modelIdentities].some(([id, identity]) => afterModels.get(id)!.object.cadIdentity !== identity)) state = replaceModelIdentities(state, modelIdentities);
  if (graph !== graphOf(state)) state = withCadGraph(state, graph);
  validateCadState(state);
  return state;
}
