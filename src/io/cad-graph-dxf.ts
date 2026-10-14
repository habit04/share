/** File handles are resolved once at import and once at export; retained values stay opaque. */
import { DEFAULT_HEADER, type DrawingState } from '../core/document';
import type { Entity } from '../core/entities';
import { newId } from '../core/entities';
import { canonicalCadHandle, cadReferences, cadAnchorKey, cadReferenceKind, cadEntityLists, mapCadEntities, CadGraphError, reconcileCadGraph, validateCadState, type CadAnchor, type CadGraph, type CadGroup, type CadNode } from '../core/cad-graph';
import { evaluateFields, FIELD_UNAVAILABLE, type FieldContext } from '../core/fields';
import type { Pair } from './dxf/groups';
import { isQuietXdataApp } from './dxf/codes';
import { decodeUnicodeEscapes, shapeStylesOf } from './encoding';
import { retainNativeLayoutPaper } from './dxf-layouts';
import { DIM_VARIABLES } from '../core/dimension';
import { isScaleName } from '../core/layouts';

interface RecordData { type: string; section: string; groups: CadGroup[]; handle?: string }
const value = (record: { readonly groups: readonly CadGroup[] }, code: number) => record.groups.find(([c]) => c === code)?.[1].trim() ?? '';
/** Decode a proven CAD identifier for matching only; stored metadata groups remain raw. */
const identifierValue = (record: { readonly groups: readonly CadGroup[] }, code: number) => decodeUnicodeEscapes(value(record, code));
/** Structural identity must not read a reactor or opaque application field as the common owner. */
function scopedValues(record: { readonly groups: readonly CadGroup[] }, code: number, subclass?: string): string[] {
  const found: string[] = [];
  let depth = 0, current: string | undefined;
  for (const [candidate, raw] of record.groups) {
    if (candidate === 102) {
      if (raw.trim().startsWith('{')) depth++;
      else if (raw.trim() === '}') depth--;
      continue;
    }
    if (depth) continue;
    if (candidate === 1001) break;
    if (candidate === 100) current = raw.trim();
    else if (candidate === code && current === subclass) found.push(raw.trim());
  }
  return found;
}
/** Only the native overall paper viewport has a generated structural counterpart. */
function overallPaperOwner(record: RecordData, byHandle: ReadonlyMap<string, RecordData>): RecordData | undefined {
  if (record.type !== 'VIEWPORT' || !record.handle || !['ENTITIES', 'BLOCKS'].includes(record.section)
    || scopedValues(record, 69, 'AcDbViewport').join(',') !== '1'
    || scopedValues(record, 67, 'AcDbEntity').join(',') !== '1') return undefined;
  const owners = scopedValues(record, 330);
  if (owners.length > 1) throw new CadGraphError('invalid', 'An overall paper viewport has ambiguous common owners.');
  const owner = owners[0] && byHandle.get(canonicalCadHandle(owners[0]));
  return owner && owner.type === 'BLOCK_RECORD' && /^\*PAPER_SPACE(?:\d+)?$/i.test(identifierValue(owner, 2)) ? owner : undefined;
}
const dictionaries = new Set(['DICTIONARY', 'ACDBDICTIONARYWDFLT']);
const dimensionOverrideCodes = new Set([71, 72, 73, 74, 78, 340, ...DIM_VARIABLES.flatMap(variable => variable.code === undefined ? [] : [variable.code])]);
const leaderOverrideCodes = new Set([41]);
const modeledOverrides = (type: string) => type === 'DIMENSION' ? dimensionOverrideCodes : type === 'LEADER' ? leaderOverrideCodes : undefined;
interface DstyleSpan { start: number; end: number; pairs: readonly { code: number; groups: readonly CadGroup[] }[] }
/** A proven native DSTYLE tuple list; arbitrary ACAD strings outside that list remain opaque. */
function dstyleSpan(groups: readonly CadGroup[]): DstyleSpan | null | undefined {
  const starts = groups.flatMap(([code, text], index) => code === 1000 && text.trim() === 'DSTYLE' && groups[index + 1]?.[0] === 1002 && groups[index + 1]?.[1].trim() === '{' ? [index] : []);
  if (!starts.length) return undefined;
  if (starts.length > 1) return null;
  const start = starts[0]!, pairs: { code: number; groups: readonly CadGroup[] }[] = [];
  for (let index = start + 2; index < groups.length; index += 2) {
    const key = groups[index]!, payload = groups[index + 1];
    if (key[0] === 1002 && key[1].trim() === '}') return { start, end: index, pairs };
    const code = Number(key[1]);
    if (key[0] !== 1070 || !Number.isSafeInteger(code) || !payload || ![1000, 1005, 1040, 1070, 1071].includes(payload[0])) return null;
    pairs.push({ code, groups: [key, payload] });
  }
  return null;
}
function acadApplication(groups: readonly CadGroup[]): { start: number; end: number; body: readonly CadGroup[] } | undefined {
  const start = groups.findIndex(([code, app]) => code === 1001 && app.trim().toUpperCase() === 'ACAD');
  if (start < 0) return undefined;
  const next = groups.findIndex(([code], index) => index > start && code === 1001), end = next < 0 ? groups.length : next;
  return { start, end, body: groups.slice(start + 1, end) };
}
function hasRetainedXdata(node: CadNode): boolean {
  const known = modeledOverrides(node.type), acad = known && acadApplication(node.groups), span = acad && dstyleSpan(acad.body);
  for (const [code, raw] of node.groups) if (code === 1001 && !isQuietXdataApp(raw.trim(), node.type)) {
    if (raw.trim().toUpperCase() !== 'ACAD' || !known || !acad || !span || span.start !== 0 || span.end !== acad.body.length - 1 || span.pairs.some(pair => !known.has(pair.code) || pair.groups[1]![0] === 1005)) return true;
  }
  return false;
}
/** Live annotation settings replace known overrides; unmodeled tuples and other ACAD data survive. */
function mergeAcadDstyle(retained: readonly CadGroup[], generated: readonly CadGroup[], type: string): CadGroup[] {
  const known = modeledOverrides(type), source = known && acadApplication(retained);
  if (!known || !source) return [...retained];
  const original = dstyleSpan(source.body), freshApp = acadApplication(generated), fresh = freshApp && dstyleSpan(freshApp.body);
  if (original === null || fresh === null) throw new CadGraphError('dependency', `Cannot save ${type}: its ACAD DSTYLE block is malformed or ambiguous and cannot be regenerated safely.`);
  const freshCodes = new Set(fresh?.pairs.map(pair => pair.code));
  const extras = original?.pairs.filter(pair => !known.has(pair.code) && !freshCodes.has(pair.code)).flatMap(pair => pair.groups) ?? [];
  const replacements = [...fresh?.pairs.flatMap(pair => pair.groups) ?? [], ...extras];
  const block: CadGroup[] = replacements.length ? [[1000, 'DSTYLE'], [1002, '{'], ...replacements, [1002, '}']] : [];
  const body = original ? [...source.body.slice(0, original.start), ...block, ...source.body.slice(original.end + 1)] : [...source.body, ...block];
  return [...retained.slice(0, source.start), ...(body.length ? [retained[source.start]!, ...body] : []), ...retained.slice(source.end)];
}
const layoutName = (record: { readonly groups: readonly CadGroup[] }) => {
  const names = scopedValues(record, 1, 'AcDbLayout');
  if (names.length > 1) throw new CadGraphError('invalid', 'A retained layout has ambiguous native names.');
  return decodeUnicodeEscapes(names[0] ?? scopedValues(record, 1).at(-1) ?? '');
};

function recordsOf(pairs: readonly Pair[]): RecordData[] {
  const records: RecordData[] = [];
  let section = '', record: RecordData | undefined;
  for (let index = 0; index < pairs.length; index++) {
    const pair = pairs[index]!;
    if (pair.code === 0) {
      record = undefined;
      const type = decodeUnicodeEscapes(pair.value.trim()).toUpperCase();
      if (type === 'SECTION') {
        section = pairs[++index]?.value.trim().toUpperCase() ?? '';
        if (section === 'HEADER') { record = { type: 'HEADER', section, groups: [] }; records.push(record); }
      } else if (type === 'ENDSEC') section = '';
      else if (!['EOF', 'ENDTAB'].includes(type)) { record = { type, section, groups: [] }; records.push(record); }
    } else if (record) record.groups.push([pair.code, pair.value]);
  }
  for (const record of records) if (record.type !== 'HEADER') {
    const handle = value(record, record.type === 'DIMSTYLE' ? 105 : 5);
    if (handle) record.handle = canonicalCadHandle(handle);
  }
  return records;
}
const lists = cadEntityLists;
function replaceEntities(state: DrawingState, fn: (entity: Entity) => Entity): DrawingState {
  return mapCadEntities(state, fn);
}
function tableNames(state: DrawingState): ReadonlyMap<string, ReadonlySet<string>> {
  const names = (values: readonly string[]) => new Set(values.map(name => name.toUpperCase()));
  return new Map([
    ['LAYER', names(state.layers.map(layer => layer.name))], ['BLOCK_RECORD', names(Object.keys(state.blocks))],
    ['VIEW', names(state.header?.views.map(view => view.name) ?? [])], ['LTYPE', names(state.header?.linetypes.map(line => line.name) ?? [])],
    ['STYLE', names(Object.keys((state.meta?.textStyles ?? {}) as object))], ['DIMSTYLE', names([state.header?.dimStyle.name ?? '', ...Object.keys((state.meta?.dimStyles ?? {}) as object)])],
  ]);
}
function tableAnchor(record: RecordData, tables: ReadonlyMap<string, ReadonlySet<string>>, shapeIds: ReadonlyMap<string, string>): CadAnchor | undefined {
  if (record.type === 'STYLE' && (Number(value(record, 70)) & 1)) {
    const sourceId = record.handle && shapeIds.get(record.handle);
    return sourceId ? { kind: 'shape-style', sourceId } : undefined;
  }
  const name = identifierValue(record, 2), upper = name.toUpperCase();
  if (!name || record.section !== 'TABLES' || record.type === 'TABLE') return undefined;
  const modeled = tables.get(record.type)?.has(upper);
  return modeled ? { kind: 'table', table: record.type, name } : undefined;
}
function dictionaryPaths(records: readonly RecordData[]): Map<string, string[]> {
  const byHandle = new Map(records.flatMap(r => r.handle ? [[r.handle, r] as const] : []));
  const root = records.find(r => r.section === 'OBJECTS' && dictionaries.has(r.type) && value(r, 330) === '0');
  const paths = new Map<string, string[]>();
  if (!root?.handle) return paths;
  paths.set(root.handle, []); const queue = [root.handle];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const handle = queue[cursor]!, record = byHandle.get(handle)!;
    const path = paths.get(handle)!;
    for (let index = 0; index + 1 < record.groups.length; index++) {
      const [code, name] = record.groups[index]!, next = record.groups[index + 1]!;
      if (code !== 3 || ![350, 360].includes(next[0])) continue;
      const child = canonicalCadHandle(next[1].trim()), target = byHandle.get(child);
      if (target && !paths.has(child) && path.length < 64) { paths.set(child, [...path, name]); if (dictionaries.has(target.type)) queue.push(child); }
    }
  }
  return paths;
}
/** These two semantic settings have a documented dictionary encoding in native DWG. */
function annotationVariables(records: readonly RecordData[]): Map<string, { record: RecordData; valueIndex: number }> {
  // Generated records have already had their group5 remapped; their temporary handle property
  // still belongs to the pre-remapping writer. Build paths from the final emitted identities.
  const indexed = records.map(record => {
    const raw = record.type === 'HEADER' || record.type === 'CLASS' ? '' : value(record, record.type === 'DIMSTYLE' ? 105 : 5);
    return { ...record, ...(raw ? { handle: canonicalCadHandle(raw) } : {}) };
  });
  const paths = dictionaryPaths(indexed), result = new Map<string, { record: RecordData; valueIndex: number }>();
  const owners = new Set(indexed.filter(record => record.handle && dictionaries.has(record.type)
    && paths.get(record.handle)?.length === 1 && paths.get(record.handle)?.[0] === 'AcDbVariableDictionary').map(record => record.handle!));
  indexed.forEach((record, index) => {
    const path = record.handle && paths.get(record.handle);
    if (!path || path.length !== 2 || path[0] !== 'AcDbVariableDictionary' || !['CANNOSCALE', 'ANNOALLVISIBLE'].includes(path[1]!)) return;
    if (record.type !== 'DICTIONARYVAR') throw new CadGraphError('invalid', `Native annotation variable ${path[1]} has an incompatible object class.`);
    let nesting = 0, owner: string | undefined;
    for (const [code, raw] of record.groups) {
      if (code === 102) { nesting += raw.startsWith('{') ? 1 : raw === '}' ? -1 : 0; continue; }
      if (!nesting && code === 100) break;
      if (!nesting && code === 330) owner = canonicalCadHandle(raw);
    }
    if (owners.size !== 1 || owner === undefined || !owners.has(owner)) throw new CadGraphError('invalid', `Native annotation variable ${path[1]} has an incompatible dictionary owner.`);
    const marker = record.groups.findIndex(([code, name]) => code === 100 && ['DictionaryVariables', 'AcDbDictionaryVar'].includes(name.trim()));
    const values = record.groups.flatMap(([code], at) => at > marker && code === 1 ? [at] : []);
    if (marker < 0 || values.length !== 1 || result.has(path[1]!)) throw new CadGraphError('invalid', `Native annotation variable ${path[1]} has ambiguous storage.`);
    result.set(path[1]!, { record: records[index]!, valueIndex: values[0]! });
  });
  return result;
}
function readAnnotationVariables(state: DrawingState, records: readonly RecordData[]): DrawingState {
  const variables = annotationVariables(records), header = records.find(record => record.type === 'HEADER');
  const explicit = new Set(header?.groups.filter(([code]) => code === 9).map(([, name]) => name));
  const canno = variables.get('CANNOSCALE'), all = variables.get('ANNOALLVISIBLE');
  const name = canno && decodeUnicodeEscapes(canno.record.groups[canno.valueIndex]![1]);
  const visible = all?.record.groups[all.valueIndex]?.[1].trim();
  const cannoscale = !explicit.has('$CANNOSCALE') && isScaleName(name) ? name : undefined;
  const annoAllVisible = !explicit.has('$ANNOALLVISIBLE') && ['0', '1'].includes(visible ?? '') ? visible === '1' : undefined;
  if (cannoscale === undefined && annoAllVisible === undefined) return state;
  return { ...state, header: { ...(state.header ?? DEFAULT_HEADER), ...(cannoscale !== undefined ? { cannoscale } : {}), ...(annoAllVisible !== undefined ? { annoAllVisible } : {}) } };
}
interface FieldExpansion {
  work: number;
  memo: Map<string, string | undefined>;
  unavailable?: (handle: string | undefined, reason: string) => void;
}
const MAX_FIELD_EXPRESSION = 1024 * 1024, MAX_FIELD_WORK = 32 * 1024 * 1024;
/** Reconstruct bounded native child slots; object-index vectors remain native graph data. */
function nativeFieldCode(node: CadNode, byId: ReadonlyMap<string, CadNode>, expansion: FieldExpansion, visiting = new Set<string>()): string | undefined {
  if (expansion.memo.has(node.id)) return expansion.memo.get(node.id);
  const unavailable = (reason: string) => { expansion.unavailable?.(node.sourceHandle, `${reason}; native FIELD records and source display value are retained.`); expansion.memo.set(node.id, undefined); return undefined; };
  if (visiting.has(node.id) || visiting.size >= 64) return unavailable('Cyclic or excessively nested FIELD expression');
  visiting.add(node.id);
  try {
    const chunks: string[] = []; let length = 0;
    for (const [code, text] of node.groups) if (code === 2 || code === 3) {
      // FIELD expression chunks have native text semantics; only their interpreted copy is
      // decoded. The source graph keeps the exact encoded expression and all opaque payloads.
      const semantic = decodeUnicodeEscapes(text);
      length += semantic.length; expansion.work += text.length + semantic.length;
      if (length > MAX_FIELD_EXPRESSION || expansion.work > MAX_FIELD_WORK) return unavailable('FIELD expression exceeds the interpretation budget');
      chunks.push(semantic);
    }
    const source = chunks.join(''), children = (node.references ?? []).filter(ref => node.groups[ref.groupIndex]?.[0] === 360 && ref.role !== 'extension').map(ref => ref.target ? byId.get(ref.target) : undefined);
    const slots = /%<\\_FldIdx (\d+)>%/g, parts: string[] = []; let cursor = 0, total = 0;
    const append = (text: string): boolean => { total += text.length; expansion.work += text.length; if (total > MAX_FIELD_EXPRESSION || expansion.work > MAX_FIELD_WORK) return false; parts.push(text); return true; };
    for (let match = slots.exec(source); match; match = slots.exec(source)) {
      const child = children[Number(match[1])], expression = child?.type === 'FIELD' ? nativeFieldCode(child, byId, expansion, visiting) : undefined;
      if (expression === undefined) return unavailable('FIELD child slots could not be interpreted safely');
      if (!append(source.slice(cursor, match.index)) || !append(value(child!, 1).toLowerCase() === '_text' ? expression : `%<${expression}>%`)) return unavailable('Expanded FIELD expression exceeds the interpretation budget');
      cursor = match.index + match[0].length;
    }
    if (!append(source.slice(cursor))) return unavailable('Expanded FIELD expression exceeds the interpretation budget');
    const code = parts.join(''); expansion.memo.set(node.id, code); return code;
  } finally { visiting.delete(node.id); }
}
function interpretFields(state: DrawingState, graph: CadGraph, context: FieldContext, onUnavailable?: FieldExpansion['unavailable']): DrawingState {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const expansion: FieldExpansion = { work: 0, memo: new Map(), unavailable: onUnavailable };
  const findField = (node: CadNode): CadNode | undefined => {
    const extension = node.references?.find(ref => ref.role === 'extension');
    const dict = extension?.target ? byId.get(extension.target) : undefined;
    const fieldDictRef = dict?.references?.find(ref => dict.groups[ref.groupIndex - 1]?.[0] === 3 && dict.groups[ref.groupIndex - 1]![1].toUpperCase() === 'ACAD_FIELD');
    const fieldDict = fieldDictRef?.target ? byId.get(fieldDictRef.target) : undefined;
    const ref = fieldDict?.references?.find(r => fieldDict.groups[r.groupIndex - 1]?.[0] === 3 && fieldDict.groups[r.groupIndex - 1]![1].toUpperCase() === 'TEXT');
    const field = ref?.target ? byId.get(ref.target) : undefined;
    return field?.type === 'FIELD' ? field : undefined;
  };
  const fields = new Map<string, CadNode>();
  for (const node of graph.nodes) if (node.anchor?.kind === 'entity' && !node.anchor.part) { const field = findField(node); if (field) fields.set(node.anchor.id, field); }
  return replaceEntities(state, entity => {
    const field = fields.get(entity.id);
    if (!field || entity.type !== 'text' && entity.type !== 'mtext') return entity;
    const native = nativeFieldCode(field, byId, expansion);
    if (native === undefined) return entity;
    const code = value(field, 1).toLowerCase() === '_text' ? native : `%<${native}>%`;
    const evaluated = evaluateFields(code, context);
    // Unknown evaluator code remains intact and uses the source display value, not a guessed evaluation.
    const text = evaluated.includes(FIELD_UNAVAILABLE) ? entity.text : evaluated;
    return { ...entity, text, field: { code, value: text, native: true } };
  });
}

/** Entity cadIdentity is temporarily its source handle until this complete graph is attached. */
export function attachDxfCadGraph(state: DrawingState, pairs: readonly Pair[], options: { sourceFormat?: 'DXF' | 'DWG'; fields?: FieldContext; viewportHandles?: ReadonlyMap<string, string>; rawEntityHandles?: ReadonlySet<string>; onFieldUnavailable?: FieldExpansion['unavailable']; onGraphUnavailable?: (reason: string) => void } = {}): DrawingState {
  let sourceRecords: RecordData[];
  // Only malformed file identities may fall back to bounded semantic import with an explicit loss
  // report. Allocation limits and missing hard dependencies remain strict throughout the codec.
  try {
    sourceRecords = recordsOf(pairs);
    const sourceHandles = new Set<string>();
    for (const record of sourceRecords) {
      if (record.handle) {
        if (sourceHandles.has(record.handle)) throw new CadGraphError('invalid', `Duplicate CAD object handle ${record.handle}.`);
        sourceHandles.add(record.handle);
      }
      for (const [code, raw] of record.groups) if (cadReferenceKind(code)) canonicalCadHandle(raw.trim());
    }
  } catch (error) {
    if (!(error instanceof CadGraphError) || error.code !== 'invalid' || !options.onGraphUnavailable || options.sourceFormat === 'DWG') throw error;
    options.onGraphUnavailable(`${error.message} Retained metadata and object-reference identities could not be imported safely; readable drawing geometry is kept.`);
    const { cadGraph: _graph, ...bare } = state;
    return replaceEntities(bare, entity => { const { cadIdentity: _drop, ...rest } = entity; return rest as Entity; });
  }
  const prefix = newId(), byHandle = new Map<string, string>(), modeledTables = tableNames(state);
  const shapeIds = new Map<string, string>();
  for (const sourceId of Object.keys(shapeStylesOf(state))) if (/^[0-9A-Fa-f]{1,16}$/.test(sourceId)) {
    const handle = canonicalCadHandle(sourceId);
    if (shapeIds.has(handle)) throw new CadGraphError('invalid', 'Shape STYLE resources share a native source identity.');
    shapeIds.set(handle, sourceId);
  }
  const entities = lists(state).flat(), entityHandles = new Map<string, Entity>();
  for (const entity of entities) if (entity.cadIdentity) entityHandles.set(canonicalCadHandle(entity.cadIdentity), entity);
  const followerHandles = new Set<string>(); let sourceInsert = false;
  for (const record of sourceRecords) if (record.type === 'LEADER' && record.handle && entityHandles.has(record.handle)) {
    const annotation = value(record, 340); if (annotation) followerHandles.add(canonicalCadHandle(annotation));
  }
  for (const record of sourceRecords) {
    if (record.type === 'INSERT') sourceInsert = !!record.handle && entityHandles.has(record.handle);
    else if (sourceInsert && ['ATTRIB', 'SEQEND'].includes(record.type)) { if (record.handle) followerHandles.add(record.handle); if (record.type === 'SEQEND') sourceInsert = false; }
    else sourceInsert = false;
  }
  // Preserve exposed object metadata; unsupported geometry remains in the existing loss report.
  const sourceByHandle = new Map(sourceRecords.flatMap(record => record.handle ? [[record.handle, record] as const] : []));
  const overallViewports = new Set(sourceRecords.filter(record => overallPaperOwner(record, sourceByHandle)));
  const tablePictures = new Set(sourceRecords.filter(record => record.type === 'INSERT' && record.groups.some(([code, app]) => code === 1001 && app.trim() === 'JCAD_TABLE')).map(record => identifierValue(record, 2)));
  const synthetic = (record: RecordData): boolean => {
    const owner = sourceByHandle.get(value(record, 330)), block = record.type === 'BLOCK_RECORD' || record.type === 'BLOCK' ? identifierValue(record, 2) : owner?.type === 'BLOCK_RECORD' ? identifierValue(owner, 2) : '';
    return record.type === 'VIEWPORT' && value(record, 69) === '1' && !overallViewports.has(record) || (/^\*[DT]\d+$/i.test(block) || tablePictures.has(block)) && !state.blocks[block];
  };
  const records = sourceRecords.filter(record => !synthetic(record) && (!['ENTITIES', 'BLOCKS'].includes(record.section) || ['BLOCK', 'ENDBLK', 'ATTDEF'].includes(record.type) || overallViewports.has(record)
    || !!record.handle && (entityHandles.has(record.handle) || followerHandles.has(record.handle) || options.viewportHandles?.has(record.handle))
    || record.section === 'ENTITIES' && Number(value(record, 67)) !== 1 && ['3DFACE', '3DSOLID', 'REGION', 'BODY'].includes(record.type)
      && (record.type === '3DFACE' || record.groups.some(([code]) => code === 1 || code === 3))
      && (!options.rawEntityHandles || !!record.handle && options.rawEntityHandles.has(record.handle))));
  for (const record of records) if (record.handle) {
    if (byHandle.has(record.handle)) throw new CadGraphError('invalid', `Duplicate CAD object handle ${record.handle}.`);
    byHandle.set(record.handle, `${prefix}:${record.handle}`);
  }
  const paths = dictionaryPaths(records), parts = new Map<string, CadAnchor>();
  let insert: Entity | undefined;
  for (const record of records) {
    if (record.type === 'INSERT') insert = record.handle ? entityHandles.get(record.handle) : undefined;
    else if (record.type === 'ATTRIB' && insert && record.handle) parts.set(record.handle, { kind: 'entity', id: insert.id, part: `attribute:${identifierValue(record, 2)}` });
    else if (record.type === 'SEQEND' && insert && record.handle) { parts.set(record.handle, { kind: 'entity', id: insert.id, part: 'sequence-end' }); insert = undefined; }
    else insert = undefined;
    if (record.type === 'LEADER' && record.handle) {
      const entity = entityHandles.get(record.handle), target = value(record, 340);
      if (entity && target) parts.set(canonicalCadHandle(target), { kind: 'entity', id: entity.id, part: 'annotation' });
    }
  }
  const nodes: CadNode[] = records.filter(r => r.handle || r.type === 'CLASS' || r.type === 'HEADER').map((record, index) => {
    const entity = record.handle ? entityHandles.get(record.handle) : undefined;
    const viewportId = record.handle ? options.viewportHandles?.get(record.handle) : undefined;
    const path = record.handle && dictionaries.has(record.type) ? paths.get(record.handle) : undefined;
    const anchor: CadAnchor = entity ? { kind: 'entity', id: entity.id } : record.handle && parts.get(record.handle) ? parts.get(record.handle)!
      : viewportId ? { kind: 'viewport', id: viewportId } : path ? { kind: 'dictionary', path }
        : record.type === 'LAYOUT' && (state.layouts ?? []).some(l => l.name.toUpperCase() === layoutName(record).toUpperCase()) ? { kind: 'layout', name: layoutName(record) }
          : tableAnchor(record, modeledTables, shapeIds) ?? { kind: 'raw' };
    const contexts: string[] = []; let currentContext = '';
    const commonAt = record.groups.findIndex(([code]) => code === 100);
    for (const [code, text] of record.groups) { if (code === 102) currentContext = text === '}' ? '' : text; contexts.push(currentContext); }
    const references = cadReferences(record.groups, byHandle).map(ref => {
      const context = contexts[ref.groupIndex];
      return { ...ref, ...(context === '{ACAD_XDICTIONARY' ? { role: 'extension' as const } : context === '{ACAD_REACTORS' ? { role: 'reactor' as const } : record.groups[ref.groupIndex]![0] === 330 && !context && ref.groupIndex < commonAt ? { role: 'owner' as const } : {}) };
    });
    return { id: record.handle ? byHandle.get(record.handle)! : `${prefix}:${record.type}:${index}`, ...(record.handle ? { sourceHandle: record.handle } : {}), type: record.type, section: record.section, groups: record.groups, anchor, references, ...(entity ? { baselineEntity: entity } : {}) };
  });
  const header = records.find(r => r.type === 'HEADER'), versionAt = header?.groups.findIndex(([code, val]) => code === 9 && val === '$ACADVER') ?? -1;
  const structural = structuralKeys(sourceRecords), generatedHandles = sourceRecords.flatMap(record => synthetic(record) && record.handle && structural.has(record) ? [{ key: structural.get(record)!, handle: record.handle }] : []);
  const graph: CadGraph = { schema: 1, documentId: prefix, sourceFormat: options.sourceFormat ?? 'DXF', sourceVersion: versionAt >= 0 ? header!.groups[versionAt + 1]?.[1] : undefined, nodes, ...(generatedHandles.length ? { generatedHandles } : {}) };
  const metadataIds = new Set<string>();
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const node of nodes) {
    if (node.anchor?.kind === 'entity' && (node.groups.some(([code]) => code === 102) || hasRetainedXdata(node) || node.references?.some(ref => ref.role !== 'owner' && ref.kind !== 'arbitrary' && (node.groups[ref.groupIndex]![0] === 1005 || !['DIMENSION', 'LEADER', 'MULTILEADER', 'MLEADER', 'ACAD_TABLE', 'IMAGE'].includes(node.type))))) metadataIds.add(node.anchor.id);
    if (node.section === 'OBJECTS') for (const ref of node.references ?? []) if (ref.target && ref.role !== 'owner') {
      const target = byId.get(ref.target);
      if (target?.anchor?.kind === 'entity') metadataIds.add(target.anchor.id);
    }
  }
  state = replaceEntities(state, entity => {
    if (!entity.cadIdentity) return entity;
    const id = byHandle.get(canonicalCadHandle(entity.cadIdentity));
    if (id && metadataIds.has(entity.id)) return { ...entity, cadIdentity: id };
    const { cadIdentity: _drop, ...rest } = entity; return rest as Entity;
  });
  state = readAnnotationVariables(state, sourceRecords);
  state = interpretFields(state, graph, options.fields ?? {}, options.onFieldUnavailable);
  const live = new Map(lists(state).flat().map(e => [e.id, e]));
  const finalGraph = { ...graph, nodes: graph.nodes.map(node => node.anchor?.kind === 'entity' && !node.anchor.part ? { ...node, baselineEntity: live.get(node.anchor.id) } : node) };
  const result = { ...state, cadGraph: finalGraph }; validateCadState(result); return result;
}

function pairsOf(text: string): Pair[] {
  const lines = text.trimEnd().split(/\r\n|\r|\n/), pairs: Pair[] = [];
  for (let index = 0; index + 1 < lines.length; index += 2) pairs.push({ code: Number(lines[index]), value: lines[index + 1]! });
  return pairs;
}
function logicalKeys(records: readonly RecordData[]): Map<RecordData, string> {
  const keys = new Map<RecordData, string>(), byHandle = new Map(records.flatMap(r => r.handle ? [[r.handle, r] as const] : [])), paths = dictionaryPaths(records);
  for (const record of records) {
    const name = identifierValue(record, 2);
    if (record.section === 'TABLES' && !(record.type === 'STYLE' && (!name || (Number(value(record, 70)) & 1)))) keys.set(record, JSON.stringify(['table', record.type, name.toUpperCase()]));
    else if (record.type === 'CLASS') keys.set(record, JSON.stringify(['class', identifierValue(record, 1).toUpperCase()]));
    else if (record.type === 'HEADER') keys.set(record, 'header');
    else if (record.type === 'BLOCK') keys.set(record, JSON.stringify(['block', name.toUpperCase()]));
    else if (record.type === 'LAYOUT') keys.set(record, JSON.stringify(['layout', layoutName(record).toUpperCase()]));
    else if (record.handle && paths.has(record.handle)) keys.set(record, JSON.stringify(['dictionary', ...paths.get(record.handle)!]));
    else if (record.type === 'IMAGEDEF') keys.set(record, JSON.stringify(['image', identifierValue(record, 1)]));
  }
  for (const record of records) if (record.type === 'ENDBLK') {
    const owner = byHandle.get(value(record, 330));
    if (owner?.type === 'BLOCK_RECORD') keys.set(record, JSON.stringify(['endblock', identifierValue(owner, 2).toUpperCase()]));
  }
  for (const record of records) if (record.type === 'ATTDEF') {
    const owner = byHandle.get(value(record, 330));
    if (owner?.type === 'BLOCK_RECORD') keys.set(record, JSON.stringify(['attribute-definition', identifierValue(owner, 2).toUpperCase(), identifierValue(record, 2).toUpperCase()]));
  }
  const overallSlots = new Set<string>();
  for (const record of records) {
    const owner = overallPaperOwner(record, byHandle);
    if (!owner) continue;
    const key = JSON.stringify(['mainviewport', identifierValue(owner, 2).toUpperCase()]);
    if (overallSlots.has(key)) throw new CadGraphError('invalid', 'A paper-space owner has duplicate overall viewports.');
    overallSlots.add(key); keys.set(record, key);
  }
  return keys;
}
/** Proven symbol/dictionary identity, or a common-owner geometry slot; values are never searched for handles. */
function structuralKeys(records: readonly RecordData[]): Map<RecordData, string> {
  const keys = logicalKeys(records), byHandle = new Map(records.flatMap(record => record.handle ? [[record.handle, record] as const] : [])), slots = new Map<string, number>();
  for (const record of records) {
    if (keys.has(record) || !['ENTITIES', 'BLOCKS'].includes(record.section)) continue;
    const ownerHandle = value(record, 330), owner = byHandle.get(ownerHandle);
    if (!owner) continue;
    const ownerKey = keys.get(owner) ?? (owner.handle ? JSON.stringify(['owner-handle', owner.handle]) : undefined);
    if (!ownerKey) continue;
    const slot = JSON.stringify([record.section, record.type, ownerKey]), index = slots.get(slot) ?? 0;
    slots.set(slot, index + 1); keys.set(record, JSON.stringify(['generated', slot, index]));
  }
  return keys;
}
function withoutReplacedReferenceBlocks(groups: readonly CadGroup[], replacement: readonly CadGroup[], commonOnly = false): CadGroup[] {
  const labels = new Set(replacement.filter(([code, text]) => code === 102 && text.startsWith('{')).map(([, text]) => text));
  let depth = 0, skip = false, subclass = false;
  return groups.filter(([code, text]) => {
    if (!depth && code === 100) subclass = true;
    if (code === 102 && text.startsWith('{')) { if (!depth) skip = (!commonOnly || !subclass) && labels.has(text); depth++; return !skip; }
    if (code === 102 && text === '}') { const keep = !skip; if (depth) depth--; if (!depth) skip = false; return keep; }
    return !skip;
  });
}
const referenceBlockPosition = (groups: readonly CadGroup[]) => { const index = groups.findIndex(([code]) => code === 5 || code === 105); return index < 0 ? 0 : index + 1; };
const appendBeforeXdata = (groups: CadGroup[], ...extra: CadGroup[]) => {
  let depth = 0;
  const index = groups.findIndex(([code, raw]) => {
    if (code === 102) depth += raw.startsWith('{') ? 1 : raw === '}' ? -1 : 0;
    return code === 1001 && depth === 0;
  });
  groups.splice(index < 0 ? groups.length : index, 0, ...extra);
};
/** Retained dictionaries own their schema and existing entries; generated records only add missing keys. */
function mergeDictionaryGroups(source: readonly CadGroup[], generated: readonly CadGroup[]): CadGroup[] {
  const groups = [...source], keys = new Set(source.filter(([code]) => code === 3).map(([, name]) => name));
  const additions: CadGroup[] = [];
  for (let index = 0; index + 1 < generated.length; index++) {
    const entry = generated[index]!, reference = generated[index + 1]!;
    if (entry[0] === 3 && [350, 360].includes(reference[0]) && !keys.has(entry[1])) {
      additions.push(entry, reference); keys.add(entry[1]);
    }
  }
  if (additions.length) {
    const subclass = groups.findIndex(([code, name]) => code === 100 && name.trim() === 'AcDbDictionary');
    const end = groups.findIndex(([code], index) => index > subclass && (code === 100 || code === 1001));
    groups.splice(end < 0 ? groups.length : end, 0, ...additions);
  }
  return groups;
}
/** Repeated codes in PlotSettings and Layout belong to distinct native subclasses. */
function retainLayoutSubclassProperties(source: readonly CadGroup[], generated: readonly CadGroup[], copiedOverall?: string): CadGroup[] {
  const groups = [...generated];
  const subclasses = (pairs: readonly CadGroup[]) => {
    const spans: { start: number; end: number }[] = [];
    let depth = 0, start = -1;
    for (let index = 0; index < pairs.length; index++) {
      const [code, raw] = pairs[index]!;
      if (code === 102) {
        if (raw.trim().startsWith('{')) depth++;
        else if (raw.trim() === '}') depth--;
        if (depth < 0) throw new CadGraphError('dependency', 'Cannot save a layout with malformed application blocks.');
      } else if (!depth && (code === 100 || code === 1001)) {
        if (start >= 0) spans.push({ start, end: index });
        start = code === 100 ? index : -1;
        if (code === 1001) break;
      }
    }
    if (depth) throw new CadGraphError('dependency', 'Cannot save a layout with malformed application blocks.');
    if (start >= 0) spans.push({ start, end: pairs.length });
    return spans;
  };
  for (const { start, end } of subclasses(source)) {
    const marker = source[start]!;
    const targets = subclasses(groups).filter(span => groups[span.start]![1].trim() === marker[1].trim());
    if (targets.length > 1) throw new CadGraphError('dependency', 'Cannot save a layout with ambiguous subclasses.');
    if (!targets.length) { appendBeforeXdata(groups, ...source.slice(start, end)); continue; }
    const { start: target, end: targetEnd } = targets[0]!;
    if (marker[1].trim() === 'AcDbLayout') {
      // Physical paper dimensions do not define native drawing limits, extents,
      // elevation or UCS. Only the name, tab order and paper owner are modeled.
      const modeled = new Set([1, 71, 330, ...(copiedOverall ? [331] : [])]);
      const direct = (body: readonly CadGroup[]) => {
        let depth = 0;
        return body.map(pair => {
          const scoped = depth === 0 && pair[0] !== 102;
          if (pair[0] === 102 && pair[1].trim().startsWith('{')) depth++;
          else if (pair[0] === 102 && pair[1].trim() === '}') depth--;
          return { pair, scoped };
        });
      };
      const replacements = new Map(direct(groups.slice(target + 1, targetEnd))
        .filter(({ pair, scoped }) => scoped && modeled.has(pair[0])).map(({ pair }) => [pair[0], pair]));
      if (copiedOverall) replacements.set(331, [331, copiedOverall]);
      const used = new Set<number>();
      const body = direct(source.slice(start + 1, end)).map(({ pair, scoped }) => {
        if (!scoped || !modeled.has(pair[0]) || !replacements.has(pair[0])) return pair;
        used.add(pair[0]); return replacements.get(pair[0])!;
      });
      body.push(...[...replacements].filter(([code]) => !used.has(code)).map(([, pair]) => pair));
      groups.splice(target + 1, targetEnd - target - 1, ...body);
      continue;
    }
    const existing = new Set(groups.slice(target + 1, targetEnd).map(([code]) => code));
    let depth = 0;
    const retained = source.slice(start + 1, end).filter(([code, raw]) => {
      if (code === 102) { depth += raw.trim().startsWith('{') ? 1 : raw.trim() === '}' ? -1 : 0; return true; }
      return depth > 0 || !existing.has(code);
    });
    groups.splice(targetEnd, 0, ...retained);
  }
  return groups;
}
/** Bind generated geometry to the same retained identities, then remap every typed reference. */
export function preserveDxfCadGraph(text: string, state: DrawingState, anchors: ReadonlyMap<string, CadAnchor>): string {
  let graph = state.cadGraph;
  if (!graph) return text;
  const entityIds = new Set(lists(state).flat().map(entity => entity.id));
  const orphaned = graph.nodes.flatMap(node => node.anchor?.kind === 'entity' && !node.anchor.part && !entityIds.has(node.anchor.id) && node.baselineEntity ? [node.baselineEntity] : []);
  if (orphaned.length) { state = reconcileCadGraph({ ...state, entities: [...state.entities, ...orphaned] }, state); graph = state.cadGraph!; }
  validateCadState(state);
  const generated = recordsOf(pairsOf(text)), sources = graph.nodes.map(node => ({ type: node.type, section: node.section, groups: [...node.groups], ...(node.sourceHandle ? { handle: canonicalCadHandle(node.sourceHandle) } : {}) }));
  const sourceKeys = logicalKeys(sources), generatedKeys = logicalKeys(generated), byAnchor = new Map<string, CadNode>(), byKey = new Map<string, CadNode>();
  const overallSourceIds = new Set(graph.nodes.flatMap((node, index) => sourceKeys.get(sources[index]!)?.startsWith('["mainviewport",') ? [node.id] : []));
  graph.nodes.forEach((node, index) => {
    const anchor = cadAnchorKey(node.anchor); if (anchor) byAnchor.set(anchor, node);
    // Synthesized document registries have no source file handle. Their proven dictionary path
    // still identifies the canonical generated NOD, so no disconnected second root is emitted.
    const key = node.anchor?.kind === 'dictionary' ? anchor : sourceKeys.get(sources[index]!);
    if (key) byKey.set(key, node);
  });
  const match = new Map<RecordData, CadNode>(), matched = new Set<string>();
  for (const record of generated) {
    const anchor = record.handle ? anchors.get(record.handle) : undefined;
    const key = generatedKeys.get(record), node = (anchor ? byAnchor.get(cadAnchorKey(anchor)!) : undefined) ?? (key ? byKey.get(key) : undefined);
    if (node && matched.has(node.id) && anchor && byAnchor.get(cadAnchorKey(anchor)!) === node) throw new CadGraphError('copy', 'A retained CAD object cannot be emitted twice with one identity. Copy it with an explicit CAD clone batch.');
    if (node && !matched.has(node.id)) { match.set(record, node); matched.add(node.id); }
  }
  const generatedByHandle = new Map(generated.flatMap(record => record.handle ? [[record.handle, record] as const] : []));
  const imageReactors = new Map(graph.nodes.flatMap(node => {
    if (node.type !== 'IMAGEDEF_REACTOR') return [];
    const owner = node.references?.find(ref => ref.role === 'owner')?.target;
    return owner ? [[owner, node] as const] : [];
  }));
  for (const record of generated) if (record.type === 'IMAGEDEF_REACTOR') {
    const owner = generatedByHandle.get(value(record, 330)), sourceOwner = owner && match.get(owner), node = sourceOwner && imageReactors.get(sourceOwner.id);
    if (node && !matched.has(node.id)) { match.set(record, node); matched.add(node.id); }
  }
  const hintHandles = new Map(graph.generatedHandles?.map(hint => [hint.key, canonicalCadHandle(hint.handle)]));
  const generatedSlots = structuralKeys(generated);
  const reserved = new Set([...graph.nodes.flatMap(n => n.sourceHandle ? [canonicalCadHandle(n.sourceHandle)] : []), ...hintHandles.values()]);
  let seed = [...reserved].reduce((maximum, handle) => BigInt(`0x${handle}`) > maximum ? BigInt(`0x${handle}`) : maximum, 0x100n);
  const allocate = () => { if (++seed >= 1n << 64n) throw new CadGraphError('invalid', 'The CAD handle space is exhausted.'); return seed.toString(16).toUpperCase(); };
  const nodeHandles = new Map<string, string>(), generatedHandles = new Map<string, string>();
  for (const node of graph.nodes) if (node.type !== 'CLASS' && node.type !== 'HEADER') nodeHandles.set(node.id, node.sourceHandle ? canonicalCadHandle(node.sourceHandle) : allocate());
  for (const record of generated) if (record.handle) generatedHandles.set(record.handle, match.has(record) ? nodeHandles.get(match.get(record)!.id)! : hintHandles.get(generatedSlots.get(record) ?? '') ?? allocate());
  const overallOwners = new Map(generated.flatMap(record => {
    const owner = overallPaperOwner(record, generatedByHandle);
    return owner?.handle && record.handle ? [[generatedHandles.get(record.handle)!, generatedHandles.get(owner.handle)!] as const] : [];
  }));
  const overallByOwner = new Map([...overallOwners].map(([viewport, owner]) => [owner, viewport]));
  const modelRecord = generated.find(record => record.type === 'BLOCK_RECORD' && identifierValue(record, 2).toUpperCase() === '*MODEL_SPACE');
  const modelOwner = modelRecord?.handle && generatedHandles.get(modelRecord.handle);
  const retainedModelGeometry = (node: CadNode) => node.section === 'ENTITIES' && (!node.anchor || node.anchor.kind === 'raw') && Number(value(node, 67)) !== 1 && ['3DFACE', '3DSOLID', 'REGION', 'BODY'].includes(node.type);
  const sourceGroups = (node: CadNode, selected?: ReadonlySet<number>): CadGroup[] => {
    const references = new Map((node.references ?? []).map(ref => [ref.groupIndex, ref]));
    return node.groups.flatMap(([code, raw], index): CadGroup[] => {
      if (selected && !selected.has(index)) return [];
      if (node.type !== 'HEADER' && (code === 5 || code === 105)) return [[code, nodeHandles.get(node.id)!]];
      const ref = references.get(index);
      if (!ref || ref.kind === 'arbitrary') return [[code, raw]];
      if (retainedModelGeometry(node) && ref.role === 'owner' && code === 330) {
        if (!modelOwner) throw new CadGraphError('dependency', `Cannot save retained ${node.type}: the generated model-space owner is missing.`);
        return [[code, modelOwner]];
      }
      if (ref.target) { const handle = nodeHandles.get(ref.target); if (!handle) throw new CadGraphError('dependency', `A retained ${node.type} reference has no exported target.`); return [[code, handle]]; }
      if (canonicalCadHandle(raw.trim()) === '0') return [[code, '0']];
      // An unresolved source reference cannot be redirected to a coincident new object.
      if (ref.kind === 'hard-pointer' || ref.kind === 'hard-owner') throw new CadGraphError('dependency', `Cannot save ${node.type}: hard reference ${raw} was not exposed by the reader.`);
      return [[code, '0']];
    });
  };
  for (const record of generated) {
    record.groups = record.groups.map(([code, raw]) => {
      if (record.type === 'HEADER' && code === 5) return [code, 'HANDSEED_PLACEHOLDER'];
      if (code === 5 || code === 105 || cadReferenceKind(code) && cadReferenceKind(code) !== 'arbitrary') return [code, generatedHandles.get(raw.trim().toUpperCase()) ?? raw];
      return [code, raw];
    });
    const node = match.get(record);
    if (!node) continue;
    if (dictionaries.has(node.type)) {
      // The fallback writer does not model dictionary ownership flags, default340 or arbitrary
      // native properties. Keep their complete source record and every typed target, including
      // the original 350/360 entry kind; newly generated layouts/images can add missing keys.
      record.type = node.type;
      record.groups = mergeDictionaryGroups(sourceGroups(node), record.groups);
      continue;
    }
    if (node.type === 'VPORT' && node.section === 'TABLES'
      || node.type === 'VIEWPORT' && node.anchor?.kind === 'raw' && overallSourceIds.has(node.id)) {
      // The editor's viewport/session view is not a modeled VPORT symbol-table
      // edit. The default writer's limits-based *Active record is a new-drawing
      // fallback; replacing imported native cameras with it loses retained data.
      // Overall paper viewports likewise have no editable UI camera; retain their
      // actual record so LAYOUT references and native properties stay connected.
      record.groups = sourceGroups(node);
      continue;
    }
    if (node.type === 'LAYOUT') {
      const source = sourceGroups(node), name = node.anchor?.kind === 'layout' ? node.anchor.name : layoutName(node);
      const original = { ...record, groups: source };
      const sourceOwner = scopedValues(original, 330, 'AcDbLayout'), sourceViewport = scopedValues(original, 331, 'AcDbLayout');
      const targetOwner = scopedValues(record, 330, 'AcDbLayout'), targetViewport = scopedValues(record, 331, 'AcDbLayout');
      // A copied sheet gets a new paper owner and overall viewport. Rebind only
      // this proven structural pair; a retained active floating viewport or an
      // arbitrary/unresolved pointer must not be redirected to a generated slot.
      const copiedOverall = [sourceOwner, sourceViewport, targetOwner].every(values => values.length === 1)
        && sourceOwner[0] !== targetOwner[0] && overallOwners.get(sourceViewport[0]!) === sourceOwner[0]
        && (targetViewport.length === 0 || targetViewport.length === 1 && overallOwners.get(targetViewport[0]!) === targetOwner[0])
        ? overallByOwner.get(targetOwner[0]!) : undefined;
      record.groups = retainLayoutSubclassProperties(source, record.groups, copiedOverall);
      const layout = state.layouts?.find(item => item.name.toUpperCase() === name.toUpperCase());
      if (layout || name.toUpperCase() === 'MODEL') record.groups = retainNativeLayoutPaper(source, record.groups, layout ?? 'model');
    }
    const liveComplex = node.type === 'LTYPE' ? state.header?.linetypes.find(line => line.name.toUpperCase() === identifierValue(node, 2).toUpperCase())?.complex : undefined;
    const unmodeledTableCodes = node.type === 'APPID' || node.type === 'LTYPE' && !liveComplex || node.type === 'DIMSTYLE' ? new Set([70])
      : node.type === 'BLOCK_RECORD' ? new Set([70, 280, 281])
        : node.type === 'STYLE' && node.anchor?.kind !== 'shape-style' ? new Set([42]) : new Set<number>();
    if (node.section === 'TABLES' && unmodeledTableCodes.size) {
      // DIMSTYLE repeats70 for the unmodeled text-fill color. Only the first70 is
      // the symbol-table flag, so its later color must never overwrite that flag.
      const source = new Map<number, string>();
      for (const [code, raw] of node.groups) if (unmodeledTableCodes.has(code) && !source.has(code)) source.set(code, raw);
      record.groups = record.groups.map(group => source.has(group[0]) ? [group[0], source.get(group[0])!] : group);
      if (node.type === 'DIMSTYLE') {
        const colors = node.groups.filter(([code]) => code === 70).slice(1);
        if (colors.length > 1) throw new CadGraphError('invalid', 'The retained DIMSTYLE has ambiguous text-fill color fields.');
        if (colors.length) appendBeforeXdata(record.groups, ...node.groups.filter(([code]) => code === 69), ...colors);
      }
    }
    if (node.type === 'LAYER' && node.section === 'TABLES') {
      const original = node.groups.find(([code]) => code === 70)?.[1];
      // Frozen1, locked4, and the explicitly modeled xref dependency/resolution
      // bits16/32 come from the live layer. New-viewport freeze and other flags
      // have no editor control and remain retained native properties.
      if (original !== undefined) record.groups = record.groups.map(([code, raw]) => [code, code === 70 ? String((Number(original) & ~53) | (Number(raw) & 53)) : raw]);
    }
    if (node.type === 'CLASS') {
      // A class definition identifies the application/schema of native records. The generated
      // stock definition is not authority for an imported class; only its instance count is derived.
      record.groups = sourceGroups(node);
      continue;
    }
    if (node.type === 'LTYPE' && !liveComplex && node.groups.some(([code, raw]) => code === 9 || code === 340 || code === 74 && Number(raw) !== 0)) {
      const sourcePattern = node.groups.filter(([code]) => code === 49).map(([, raw]) => Number(raw));
      const writtenPattern = record.groups.filter(([code]) => code === 49).map(([, raw]) => Number(raw));
      if (sourcePattern.length !== writtenPattern.length || sourcePattern.some((length, index) => !Number.isFinite(length) || Number(length.toFixed(10)) !== writtenPattern[index])) {
        throw new CadGraphError('dependency', `Cannot save edited complex linetype ${identifierValue(node, 2)}: its embedded text/shape elements require native regeneration. Restore its original dash pattern or use a different linetype.`);
      }
      const name = record.groups.find(([code]) => code === 2)?.[1], description = record.groups.find(([code]) => code === 3)?.[1];
      // Complex elements are positional records. Appending isolated group9/style handles to a
      // flattened 74=0 dash list corrupts that structure, so preserve the complete native record.
      record.groups = sourceGroups(node).map(([code, raw]) => [code, code === 2 && name !== undefined ? name : code === 3 && description !== undefined ? description : raw]);
      continue;
    }
    const complexCodes = new Set([2, 70, 3, 72, 73, 40, 49, 74, 75, 340, 46, 50, 44, 45, 9]);
    if (liveComplex) {
      let nesting = 0, application = false;
      for (const [code, raw] of node.groups) {
        if (code === 1001) application = true;
        if (application) continue;
        if (code === 102) { nesting += raw.startsWith('{') ? 1 : raw === '}' ? -1 : 0; continue; }
        if (!nesting && ![5, 105, 100, 330].includes(code) && !complexCodes.has(code)) throw new CadGraphError('dependency', 'Cannot safely regenerate a complex linetype with unmodeled positional native fields. Its source record is retained; restore the original definition or use a separate linetype.');
      }
    }
    const selected = new Set<number>(), generatedCodes = new Set(record.groups.map(([code]) => code));
    // The live viewport regenerates its clipping-boundary pointer. Application
    // reference blocks and XDATA are selected above independently of these codes.
    const rebuilt = liveComplex ? complexCodes : node.type === 'LAYER' ? new Set([390]) : node.type === 'DIMSTYLE' ? new Set([340, 342, 343, 344]) : node.type === 'LEADER' ? new Set([340]) : node.type === 'VIEWPORT' ? new Set([331, 340]) : ['MULTILEADER', 'MLEADER', 'ACAD_TABLE', 'IMAGE'].includes(node.type) ? new Set([340, 341, 342, 343, 344, 360]) : new Set<number>();
    let nesting = 0, selectedApp: string | undefined, keepHeader = false, layoutSubclass = false, retainedLayoutBlock = false;
    const existingVariables = new Set(record.groups.filter(([code]) => code === 9).map(([, name]) => name));
    node.groups.forEach(([code, raw], index) => {
      if (node.type === 'HEADER') { if (code === 9) keepHeader = !existingVariables.has(raw); if (keepHeader) selected.add(index); return; }
      if (code === 102) {
        if (!nesting) retainedLayoutBlock = node.type === 'LAYOUT' && layoutSubclass && !selectedApp;
        nesting += raw.startsWith('{') ? 1 : raw === '}' ? -1 : 0;
        if (!retainedLayoutBlock) selected.add(index);
        if (!nesting) retainedLayoutBlock = false;
        return;
      }
      if (nesting) { if (!retainedLayoutBlock) selected.add(index); return; }
      if (code === 100) layoutSubclass = true;
      if (code === 1001) selectedApp = raw.trim();
      if (selectedApp) { if (!isQuietXdataApp(selectedApp, node.type) && !(selectedApp === 'AcCmTransparency' && node.type === 'LAYER')) selected.add(index); return; }
      if (rebuilt.has(code)) return;
      if (node.anchor?.kind === 'entity' || node.anchor?.kind === 'viewport') {
        if (cadReferenceKind(code) && code !== 330) selected.add(index);
      } else if (![5, 105, 100, 330].includes(code) && !generatedCodes.has(code)) selected.add(index);
    });
    const retained = mergeAcadDstyle(sourceGroups(node, selected), record.groups, node.type);
    if (record.type === 'HEADER') {
      const existing = new Set(record.groups.filter(([code]) => code === 9).map(([, val]) => val));
      let keep = false;
      for (const group of retained) { if (group[0] === 9) keep = !existing.has(group[1]); if (keep) record.groups.push(group); }
      continue;
    }
    const metadata: CadGroup[] = [], apps = new Set<string>(); let brace = 0, app: string | undefined;
    for (const group of retained) {
      const [code, raw] = group;
      if (code === 102) { metadata.push(group); brace += raw.startsWith('{') ? 1 : raw === '}' ? -1 : 0; continue; }
      if (brace) { metadata.push(group); continue; }
      if (code === 1001) { app = raw; apps.add(raw.trim().toUpperCase()); }
      if (app) { metadata.push(group); continue; }
      if (node.anchor?.kind !== 'entity' && node.anchor?.kind !== 'viewport' && ![5, 105, 100, 330].includes(code) && !generatedCodes.has(code)) appendBeforeXdata(record.groups, group);
      else if ((node.anchor?.kind === 'entity' || node.anchor?.kind === 'viewport') && cadReferenceKind(code)) appendBeforeXdata(record.groups, group);
    }
    // Source extension/reactor blocks precede the common subclass; each XDATA application occurs once.
    let active: string | undefined, activeDepth = 0;
    record.groups = record.groups.filter(([code, raw]) => {
      if (code === 102) activeDepth += raw.startsWith('{') ? 1 : raw === '}' ? -1 : 0;
      if (!activeDepth && code === 1001) active = raw.trim().toUpperCase();
      return !active || !apps.has(active);
    });
    record.groups = withoutReplacedReferenceBlocks(record.groups, metadata, node.type === 'LAYOUT');
    let applicationDepth = 0;
    const application = metadata.findIndex(([code, raw]) => {
      if (code === 102) applicationDepth += raw.startsWith('{') ? 1 : raw === '}' ? -1 : 0;
      return code === 1001 && applicationDepth === 0;
    });
    record.groups.splice(referenceBlockPosition(record.groups), 0, ...metadata.slice(0, application < 0 ? undefined : application));
    if (application >= 0) record.groups.push(...metadata.slice(application));
  }
  for (let index = 0; index < graph.nodes.length; index++) {
    const node = graph.nodes[index]!;
    if (matched.has(node.id)) continue;
    if (node.anchor && node.anchor.kind !== 'raw' && node.anchor.kind !== 'dictionary') throw new CadGraphError('dependency', `Cannot save retained ${node.type}: its edited object has no generated record.`);
    const groups = sourceGroups(node);
    if (retainedModelGeometry(node) && !node.references?.some(ref => ref.role === 'owner' && node.groups[ref.groupIndex]?.[0] === 330)) {
      if (!modelOwner) throw new CadGraphError('dependency', `Cannot save retained ${node.type}: the generated model-space owner is missing.`);
      groups.splice(referenceBlockPosition(groups), 0, [330, modelOwner]);
    }
    generated.push({ type: node.type, section: node.section, groups, ...(nodeHandles.has(node.id) ? { handle: nodeHandles.get(node.id) } : {}) });
  }
  // Current semantic values replace only the corresponding recognized dictionary value.
  // Ownership, reactors, unknown variables and every other raw group remain intact.
  for (const [name, variable] of annotationVariables(generated)) {
    const current = name === 'CANNOSCALE' ? state.header?.cannoscale
      : state.header?.annoAllVisible !== undefined ? state.header.annoAllVisible ? '1' : '0' : undefined;
    if (current !== undefined) variable.record.groups = variable.record.groups.map((group, index) => index === variable.valueIndex ? [group[0], current] : group);
  }
  const instances = new Map<string, number>();
  for (const record of generated) if (record.type !== 'CLASS') instances.set(record.type, (instances.get(record.type) ?? 0) + 1);
  for (const record of generated) if (record.type === 'CLASS') {
    const count = instances.get(identifierValue(record, 1).toUpperCase()) ?? 0;
    record.groups = record.groups.map(([code, raw]) => [code, code === 91 ? String(count) : raw]);
  }
  const out: string[] = [];
  for (const section of ['HEADER', 'CLASSES', 'TABLES', 'BLOCKS', 'ENTITIES', 'OBJECTS', ...new Set(generated.map(r => r.section).filter(s => !['HEADER', 'CLASSES', 'TABLES', 'BLOCKS', 'ENTITIES', 'OBJECTS'].includes(s)))]) {
    let sectionRecords = generated.filter(r => r.section === section);
    if (section === 'TABLES') {
      const tables = sectionRecords.filter(r => r.type === 'TABLE');
      sectionRecords = tables.flatMap(table => {
        const entries = sectionRecords.filter(r => r.type === value(table, 2).toUpperCase());
        table.groups = table.groups.map(([code, raw]) => code === 70 ? [code, String(entries.length)] : [code, raw]);
        return [table, ...entries];
      });
    }
    if (!sectionRecords.length && !['CLASSES', 'OBJECTS'].includes(section)) continue;
    out.push('0', 'SECTION', '2', section);
    for (let at = 0; at < sectionRecords.length; at++) {
      const record = sectionRecords[at]!;
      if (record.type !== 'HEADER') out.push('0', record.type);
      for (const [code, raw] of record.groups) out.push(String(code), raw);
      // ENDTAB was a delimiter during parsing; restore it between symbol tables.
      if (section === 'TABLES') {
        const next = sectionRecords[at + 1];
        if (!next || next.type === 'TABLE') out.push('0', 'ENDTAB');
      }
    }
    out.push('0', 'ENDSEC');
  }
  out.push('0', 'EOF');
  return (out.join('\r\n') + '\r\n').replace('HANDSEED_PLACEHOLDER', (seed + 1n).toString(16).toUpperCase());
}
