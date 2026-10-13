/** Join checked native metadata to the established DWG DTO model by exact source handles. */
import { DEFAULT_HEADER, type DrawingState } from '../core/document';
import type { Entity } from '../core/entities';
import type { CadAnchor, CadGroup, CadNode } from '../core/cad-graph';
import { canonicalCadHandle, CadGraphError, reconcileCadGraph, validateCadState } from '../core/cad-graph';
import { ACVAR_FIELDS } from '../core/fields';
import { LAYER_TRANSPARENCY_APP } from '../core/appearance';
import { dstylePairs, readDimStyleFromEntity } from './dxf/read-annotations';
import { decodeUnicodeEscapes } from './encoding';

export interface DwgCadGraphJoin {
  readonly entityTypes?: ReadonlyMap<string, string>;
  readonly viewportHandles?: ReadonlyMap<string, string>;
  readonly tableHandles?: ReadonlyMap<string, { readonly table: string; readonly name: string }>;
  /** The repaired native DTO exposes off separately; the raw DXF projection's color sign is unreliable. */
  readonly layerOff?: ReadonlyMap<string, boolean>;
  readonly layoutHandles?: ReadonlyMap<string, string>;
}
function sameEntityClass(dto: string, node: CadNode): boolean {
  const kind = dto.toUpperCase();
  if (kind === node.type.toUpperCase()) return true;
  if (kind === 'MINSERT' && node.type === 'INSERT') return true;
  if (kind === 'POLYLINE2D' && node.type === 'POLYLINE') return !(Number(node.groups.find(([code]) => code === 70)?.[1] ?? '0') & 8);
  if (kind === 'POLYLINE3D' && node.type === 'POLYLINE') return !!(Number(node.groups.find(([code]) => code === 70)?.[1] ?? '0') & 8);
  return false;
}
const entitiesOf = (state: DrawingState): readonly Entity[] => [state.entities, ...Object.values(state.blocks).map(block => block.entities), ...(state.layouts ?? []).map(layout => layout.entities)].flat();
const normalizeMap = <T>(map: ReadonlyMap<string, T> | undefined) => new Map([...map ?? []].map(([handle, data]) => [canonicalCadHandle(handle), data]));
function hasSupportedEvaluators(code: string): boolean {
  const kinds = [...code.matchAll(/%<\\([A-Za-z_]+)(?:\.[0-9.]+)?\s/g)];
  if (!kinds.length) return false;
  return kinds.every(match => match[1] === 'AcSm' || match[1] === 'AcVar' && ACVAR_FIELDS.some(name => name.toUpperCase() === code.slice(match.index! + match[0].length).match(/^[A-Za-z]+/)?.[0]?.toUpperCase()));
}

/** Source common appearance is regenerated from the repaired DTO; application payloads stay exact. */
function trustworthyGroups(node: CadNode, anchor: CadAnchor | undefined): { groups: readonly CadGroup[]; positions: Map<number, number> } {
  const groups: CadGroup[] = [], positions = new Map<number, number>();
  let nesting = 0, xdata = false;
  for (let index = 0; index < node.groups.length; index++) {
    const [code, value] = node.groups[index]!;
    if (code === 102) nesting += value.startsWith('{') ? 1 : value === '}' ? -1 : 0;
    if (code === 1001) xdata = true;
    const modeled = anchor?.kind === 'entity' || anchor?.kind === 'viewport' || anchor?.kind === 'table' && anchor.table === 'LAYER';
    if (modeled && !nesting && !xdata && [62, 420, 421, 430, 440].includes(code)) continue;
    positions.set(index, groups.length);
    const tableName = anchor?.kind === 'table' && code === 2 ? anchor.name : undefined;
    groups.push([code, tableName ?? value]);
  }
  return { groups, positions };
}

export function mergeDwgCadGraph(base: DrawingState, projected: DrawingState, join: DwgCadGraphJoin = {}): DrawingState {
  const source = projected.cadGraph;
  if (!source) throw new CadGraphError('invalid', 'The native DWG projection has no checked metadata graph.');
  const byHandle = new Map<string, Entity>(), sourceEntities = new Map(entitiesOf(projected).map(entity => [entity.id, entity]));
  const entityTypes = normalizeMap(join.entityTypes), viewports = normalizeMap(join.viewportHandles), tables = normalizeMap(join.tableHandles), layouts = normalizeMap(join.layoutHandles), layerOff = normalizeMap(join.layerOff);
  for (const node of source.nodes) if (node.sourceHandle) {
    const handle = canonicalCadHandle(node.sourceHandle), dto = entityTypes.get(handle), table = tables.get(handle);
    if (dto && !sameEntityClass(dto, node)) throw new CadGraphError('invalid', `DWG entity source handle ${handle} has DTO type ${dto} but native metadata type ${node.type}.`);
    if (table && table.table.toUpperCase() !== node.type.toUpperCase()) throw new CadGraphError('invalid', `DWG table source handle ${handle} has DTO table ${table.table} but native metadata type ${node.type}.`);
    if (viewports.has(handle) && node.type !== 'VIEWPORT' || layouts.has(handle) && node.type !== 'LAYOUT') throw new CadGraphError('invalid', `DWG structural source handle ${handle} has incompatible native metadata type ${node.type}.`);
  }
  for (const entity of entitiesOf(base)) if (entity.cadIdentity) {
    const handle = canonicalCadHandle(entity.cadIdentity);
    if (byHandle.has(handle)) throw new CadGraphError('invalid', `Trusted DWG entities share source handle ${handle}.`);
    byHandle.set(handle, entity);
  }
  const entityIds = new Map<string, string>(), supplements = new Map<string, { source: Entity; node: CadNode; identity?: string }>();
  for (const node of source.nodes) if (node.anchor?.kind === 'entity' && !node.anchor.part && node.sourceHandle) {
    const entity = byHandle.get(canonicalCadHandle(node.sourceHandle)), original = sourceEntities.get(node.anchor.id);
    if (!entity) {
      if (original?.cadIdentity) throw new CadGraphError('dependency', `Native ${node.type} metadata at source handle ${node.sourceHandle} cannot be joined to a trusted DWG entity.`);
      continue;
    }
    entityIds.set(node.anchor.id, entity.id);
    if (original) supplements.set(entity.id, { source: original, node, ...(original.cadIdentity ? { identity: node.id } : {}) });
  }
  const layerTransparency = new Map<string, NonNullable<DrawingState['layers'][number]['transparency']>>();
  const layerFlags = new Map<string, { frozen: boolean; locked: boolean; xrefFlags: number; off?: boolean }>();
  for (const node of source.nodes) if (node.type === 'LAYER' && node.sourceHandle) {
    const handle = canonicalCadHandle(node.sourceHandle), target = tables.get(handle);
    if (target?.table !== 'LAYER') continue;
    const flags = Number(node.groups.find(([code]) => code === 70)?.[1] ?? '0');
    if (!Number.isSafeInteger(flags) || flags < 0 || flags > 0xffff) throw new CadGraphError('invalid', 'Native LAYER structural flags are invalid.');
    layerFlags.set(target.name, { frozen: !!(flags & 1), locked: !!(flags & 4), xrefFlags: flags & 48, ...(layerOff.has(handle) ? { off: layerOff.get(handle)! } : {}) });
  }
  for (const node of source.nodes) if (node.anchor?.kind === 'table' && node.anchor.table === 'LAYER' && node.sourceHandle
    && node.groups.some(([code, value]) => code === 1001 && value.toUpperCase() === LAYER_TRANSPARENCY_APP.toUpperCase())) {
    const target = tables.get(canonicalCadHandle(node.sourceHandle));
    const sourceName = node.anchor.name;
    const original = projected.layers.find(layer => layer.name.toUpperCase() === sourceName.toUpperCase());
    if (target?.table === 'LAYER' && original?.transparency !== undefined) layerTransparency.set(target.name, original.transparency);
  }
  const textStyleHandles = new Map([...tables].flatMap(([handle, table]) => table.table === 'STYLE' ? [[handle, table.name] as const] : []));
  const liveViewportIds = new Set((base.layouts ?? []).flatMap(layout => layout.viewports.map(viewport => viewport.id)));
  const liveEntities = new Map<string, Entity>();
  const entity = (input: Entity): Entity => {
    const { cadIdentity: _temporary, ...ordinary } = input;
    const supplemental = supplements.get(input.id);
    let output: Entity = ordinary as Entity;
    if (supplemental?.identity) output = { ...output, cadIdentity: supplemental.identity };
    if (supplemental?.source.annotative !== undefined) output = { ...output, annotative: supplemental.source.annotative };
    if (supplemental) {
      const original = supplemental.source;
      if (output.type === 'mtext' && original.type === 'mtext' && original.columns) output = { ...output, columns: original.columns };
      if (output.type === 'leader' && original.type === 'leader' && original.textColumns) output = { ...output, textColumns: original.textColumns };
      const object = { kind: supplemental.node.type, groups: supplemental.node.groups.map(([code, value]) => ({ code, value: decodeUnicodeEscapes(value) })) };
      if (output.type === 'dimension') output = { ...output, style: readDimStyleFromEntity(object, new Map(), output.style, textStyleHandles) };
      if (output.type === 'leader') {
        const override = dstylePairs(object).find(([code]) => code === 41)?.[1];
        if (override !== undefined) {
          const size = Number(override);
          if (!Number.isFinite(size) || size < 0) throw new CadGraphError('invalid', 'Native LEADER DSTYLE arrow size is invalid.');
          output = { ...output, arrowSize: size };
        }
      }
    }
    if (supplemental && (output.type === 'text' || output.type === 'mtext') && (supplemental.source.type === 'text' || supplemental.source.type === 'mtext') && supplemental.source.field?.native) {
      const display = hasSupportedEvaluators(supplemental.source.field.code) ? supplemental.source.text : output.text;
      output = { ...output, text: display, field: { ...supplemental.source.field, value: display } };
    }
    liveEntities.set(output.id, output); return output;
  };
  let state: DrawingState = {
    ...base,
    layers: layerFlags.size || layerTransparency.size ? base.layers.map(layer => {
      const flags = layerFlags.get(layer.name);
      const transparency = layerTransparency.has(layer.name) ? { transparency: layerTransparency.get(layer.name)! } : {};
      if (!flags) return layerTransparency.has(layer.name) ? { ...layer, ...transparency } : layer;
      // The legacy facade's standardFlag includes internal DWG plot bits. Only native DXF70
      // supplies modeled structural flags; appearance and the independently exposed off bit
      // remain authoritative DTO values, rather than borrowing the projection's color sign.
      const { frozen: _frozen, xrefFlags: _xref, ...ordinary } = layer;
      return { ...ordinary, locked: flags.locked, visible: (flags.off === undefined ? layer.visible : !flags.off) && !flags.frozen,
        ...(flags.frozen ? { frozen: true } : {}), ...(flags.xrefFlags ? { xrefFlags: flags.xrefFlags } : {}), ...transparency };
    }) : base.layers,
    entities: base.entities.map(entity),
    blocks: Object.fromEntries(Object.entries(base.blocks).map(([name, block]) => [name, { ...block, entities: block.entities.map(entity) }])),
    ...(base.layouts ? { layouts: base.layouts.map(layout => ({ ...layout, entities: layout.entities.map(entity) })) } : {}),
    ...(projected.header ? { header: { ...(base.header ?? DEFAULT_HEADER), views: projected.header.views,
      ...(projected.header.cannoscale !== undefined ? { cannoscale: projected.header.cannoscale } : {}),
      ...(projected.header.annoAllVisible !== undefined ? { annoAllVisible: projected.header.annoAllVisible } : {}),
    } } : {}),
  };
  const nodes: CadNode[] = source.nodes.map(node => {
    let anchor = node.anchor;
    const handle = node.sourceHandle && canonicalCadHandle(node.sourceHandle);
    if (anchor?.kind === 'entity' && entityIds.has(anchor.id)) anchor = { ...anchor, id: entityIds.get(anchor.id)! };
    else if (anchor?.kind === 'viewport') {
      const id = handle && viewports.get(handle);
      if (id) anchor = { kind: 'viewport', id };
      else if (!liveViewportIds.has(anchor.id)) throw new CadGraphError('dependency', `Native viewport metadata at source handle ${node.sourceHandle ?? '(missing)'} has no exact trusted viewport join.`);
    } else if (anchor?.kind === 'table' && handle && tables.has(handle)) anchor = { kind: 'table', ...tables.get(handle)! };
    else if (anchor?.kind === 'layout' && handle && layouts.has(handle)) anchor = { kind: 'layout', name: layouts.get(handle)! };
    const { groups, positions } = trustworthyGroups(node, anchor);
    const references = node.references?.flatMap(ref => positions.has(ref.groupIndex) ? [{ ...ref, groupIndex: positions.get(ref.groupIndex)! }] : []);
    const baselineEntity = anchor?.kind === 'entity' && !anchor.part ? liveEntities.get(anchor.id) ?? node.baselineEntity : undefined;
    return { ...node, anchor, groups, references, ...(baselineEntity ? { baselineEntity } : {}) };
  });
  state = { ...state, cadGraph: { ...source, sourceFormat: 'DWG', nodes } };
  // Plain projection geometry omitted by the DTO must disappear, with any hard metadata
  // dependency reported, rather than being appended as an uneditable hidden entity on save.
  const previousEntities = source.nodes.flatMap(node => node.anchor?.kind === 'entity' && !node.anchor.part && !entityIds.has(node.anchor.id) && node.baselineEntity ? [node.baselineEntity] : []);
  if (previousEntities.length) state = reconcileCadGraph({ ...state, entities: [...state.entities, ...previousEntities] }, state);
  validateCadState(state); return state;
}
