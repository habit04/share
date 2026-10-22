/** File handles are resolved once at import and once at export; retained values stay opaque. */
import { DEFAULT_HEADER, type DrawingState } from '../core/document';
import type { Entity, LeaderEntity, TableEntity } from '../core/entities';
import { newId } from '../core/entities';
import { canonicalCadHandle, cadReferences, cadAnchorKey, cadReferenceKind, cadEntityLists, mapCadEntities, CadGraphError, reconcileCadGraph, validateCadState, type CadAnchor, type CadGraph, type CadGroup, type CadNode } from '../core/cad-graph';
import { evaluateFields, FIELD_UNAVAILABLE, type FieldContext } from '../core/fields';
import type { Pair } from './dxf/groups';
import { isIntegerText } from './dxf/groups';
import { isQuietXdataApp } from './dxf/codes';
import { decodeUnicodeEscapes, shapeStylesOf } from './encoding';
import { headerVariableReemittable, retainNativeLayoutPaper } from './dxf-layouts';
import { DIM_VARIABLES } from '../core/dimension';
import { formatScale, isScaleName } from '../core/layouts';
import { solidCarrierGroups } from './dxf/model3d-carriers';
import { mleaderContextBodyGroups, mleaderContextViews, tableCellContentSum, tableRoundtripCells, tableRoundtripCellValueGroups } from './dxf/write-annotations';
import { MODEL3D_APP } from './dxf/codes';
import { payloadText, polyfaceStructureProblem, native3dObject } from './dxf/mesh3d-read';
import { decodeDimensionPayload } from '../model3d/file-format';

interface RecordData { type: string; section: string; groups: CadGroup[]; handle?: string; line?: number }
/**
 * Every DXF group code that carries a handle reference — the ONE source of
 * truth for the merge's reference scans (the roundtrip rehome repoint, the
 * regeneration keep-scan, the post-regeneration validation). Derived from
 * the reader's own cadReferenceKind() table (P22 PR #39 re-review 2, lead
 * ruling: no hand-maintained subset — Codex hit 345, 349, 390 and 480,
 * which the old subsets missed), plus the soft/hard owner codes 330/360
 * (already inside cadReferenceKind's ranges, named for emphasis).
 */
const HANDLE_REFERENCE_CODES: ReadonlySet<number> = (() => {
  const codes = new Set<number>([330, 360]);
  for (let code = 0; code <= 1005; code++) if (cadReferenceKind(code)) codes.add(code);
  return codes;
})();
/** The $ACADVER value inside a header group list (the group after its 9-group). */
function headerVersionOf(groups: readonly CadGroup[]): string | undefined {
  const at = groups.findIndex(([code, raw]) => code === 9 && raw.trim() === '$ACADVER');
  return at >= 0 ? groups[at + 1]?.[1].trim() : undefined;
}

/**
 * P22 COMP-N Series 3 (lead ruling): the retained $ACADMAINTVER is re-emitted only
 * when the written $ACADVER equals the source's AND the variable's own group code
 * is the valid one for that version — 70 at AC1015, 90 at AC1018 and later. The
 * synthetic fixtures' 70/105 at AC1032 is a pair AutoCAD 2027 refuses outright,
 * and a pair recorded against one version must not ride into a file whose version
 * moved. The variable's VALUE is never judged.
 */
function acadMaintVerKept(writtenGroups: readonly CadGroup[], sourceGroups: readonly CadGroup[], pairCode: number | undefined): boolean {
  const written = headerVersionOf(writtenGroups);
  if (written === undefined || pairCode === undefined) return true;
  const source = headerVersionOf(sourceGroups);
  if (source !== undefined && source !== written) return false;
  return pairCode === (written >= 'AC1018' ? 90 : 70);
}

const value = (record: { readonly groups: readonly CadGroup[] }, code: number) => record.groups.find(([c]) => c === code)?.[1].trim() ?? '';
/** Decode a proven CAD identifier for matching only; stored metadata groups remain raw. */
const identifierValue = (record: { readonly groups: readonly CadGroup[] }, code: number) => decodeUnicodeEscapes(value(record, code));
const native3dValue = (record: { readonly type: string; readonly groups: readonly CadGroup[] }, code: number) => native3dObject({ kind: record.type, groups: record.groups.map(([code, value]) => ({ code, value })) }).groups.find(group => group.code === code)?.value.trim() ?? '';
const native3dFlags = (record: { readonly type: string; readonly groups: readonly CadGroup[] }, maximum = 0xffff): number | undefined => {
  const raw = native3dValue(record, 70), flags = Number(raw);
  return isIntegerText(raw) && flags >= 0 && flags <= maximum ? flags : undefined;
};
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
      else if (!['EOF', 'ENDTAB'].includes(type)) { record = { type, section, groups: [], ...(pair.line !== undefined ? { line: pair.line } : {}) }; records.push(record); }
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
/**
 * The ratio a SCALE record carries for a plain 'N:M' annotation scale name, with
 * groups 140/141 (paper units / drawing units) formatted the way AutoCAD writes
 * them in the HANDBUILT specimens — always with a decimal point ('1.0', '4.0',
 * '12.0'; '0.0078125' for a fractional part). Names that are not a plain positive
 * ratio (imperial names like '1/8" = 1'-0"', bare factors) return null: no
 * geometry is invented for them (Q11 F2 round 2, Item 1).
 */
export function annotationScaleRatio(name: string): { numerator: string; denominator: string; unit: boolean } | null {
  const match = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(name.trim());
  if (!match) return null;
  const numerator = Number(match[1]), denominator = Number(match[2]);
  if (!(numerator > 0) || !(denominator > 0)) return null;
  const format = (part: number) => Number.isInteger(part) ? `${part}.0` : String(part);
  return { numerator: format(numerator), denominator: format(denominator), unit: numerator === denominator };
}
/**
 * The retained ACAD_SCALELIST: the root named-objects dictionary, its scale-list
 * dictionary (the root's ACAD_SCALELIST entry) when one exists, the SCALE records
 * that dictionary holds keyed by scale name (group 300), and the entry keys in
 * use. Specimen shape: N1/Q10/Q12 HANDBUILT fixtures — the list is a plain
 * DICTIONARY under the root, its entries keyed 'A0'..'D2' in AutoCAD's sequence.
 */
function scaleListOf(records: readonly RecordData[]): { root: RecordData; dictionary?: RecordData; entries: ReadonlyMap<string, RecordData>; keys: ReadonlySet<string> } | undefined {
  const paths = dictionaryPaths(records);
  const root = records.find(record => record.handle && paths.get(record.handle)?.length === 0);
  if (!root) return undefined;
  const dictionary = records.find(record => record.handle && dictionaries.has(record.type)
    && paths.get(record.handle)?.length === 1 && paths.get(record.handle)?.[0] === 'ACAD_SCALELIST');
  const entries = new Map<string, RecordData>(), keys = new Set<string>();
  if (dictionary) for (const record of records) {
    const path = record.handle ? paths.get(record.handle) : undefined;
    if (path?.length !== 2 || path[0] !== 'ACAD_SCALELIST') continue;
    keys.add(path[1]!);
    if (record.type === 'SCALE') { const name = decodeUnicodeEscapes(value(record, 300)); if (name) entries.set(name, record); }
  }
  return { root, ...(dictionary ? { dictionary } : {}), entries, keys };
}
/**
 * Which annotation settings the attached retained graph already carries (Q11 F2
 * rework): the recognized DICTIONARYVAR names at AcDbVariableDictionary paths, and
 * whether an AcDbVariableDictionary dictionary exists there at all. The model
 * writer consults this before creating anything — it creates a variable only when
 * the graph carries no variable dictionary (a missing variable beside a retained
 * dictionary is inserted by preserveDxfCadGraph instead), so a write never
 * produces a second dictionary. Uses the same path logic as annotationVariables.
 * F2 round 2 (Item 1) adds the scale-list half: whether an ACAD_SCALELIST
 * dictionary exists and which scale names its SCALE entries already carry.
 */
export function graphAnnotationCarrier(state: DrawingState): { variables: ReadonlySet<string>; dictionary: boolean; scaleList: { dictionary: boolean; names: ReadonlySet<string> } } {
  const graph = state.cadGraph;
  if (!graph) return { variables: new Set<string>(), dictionary: false, scaleList: { dictionary: false, names: new Set<string>() } };
  const records: RecordData[] = graph.nodes.map(node => {
    const record: RecordData = { type: node.type, section: node.section, groups: [...node.groups] };
    const raw = node.type === 'HEADER' || node.type === 'CLASS' ? '' : value(record, node.type === 'DIMSTYLE' ? 105 : 5);
    if (raw) record.handle = canonicalCadHandle(raw);
    return record;
  });
  const variables = new Set(annotationVariables(records).keys());
  const paths = dictionaryPaths(records);
  const dictionary = records.some(record => record.handle && dictionaries.has(record.type)
    && paths.get(record.handle)?.length === 1 && paths.get(record.handle)?.[0] === 'AcDbVariableDictionary');
  const scaleList = scaleListOf(records);
  return { variables, dictionary, scaleList: { dictionary: scaleList?.dictionary !== undefined, names: new Set(scaleList?.entries.keys() ?? []) } };
}
/**
 * P18 FIX group 1: the retained ACAD_SCALELIST's SCALE entries as name ->
 * handle (the same record mapping graphAnnotationCarrier consults). The DXF
 * writer resolves a multileader context's source scale NAME through this map
 * so a re-save writes group 340 at the RETAINED SCALE object; the merge pass
 * below creates whatever the writer could not resolve.
 */
export function graphAnnotationScaleEntries(state: DrawingState): ReadonlyMap<string, string> {
  const graph = state.cadGraph;
  if (!graph) return new Map();
  const records: RecordData[] = graph.nodes.map(node => {
    const record: RecordData = { type: node.type, section: node.section, groups: [...node.groups] };
    const raw = node.type === 'HEADER' || node.type === 'CLASS' ? '' : value(record, node.type === 'DIMSTYLE' ? 105 : 5);
    if (raw) record.handle = canonicalCadHandle(raw);
    return record;
  });
  const entries = new Map<string, string>();
  for (const [name, record] of scaleListOf(records)?.entries ?? []) if (record.handle) entries.set(name, record.handle);
  return entries;
}
/**
 * Which modelled tables already carry the AC1015 roundtrip chain in the
 * retained graph (P22 F-2 successor): the table node's extension dictionary
 * holds an ACAD_XREC_ROUNDTRIP entry whose XRECORD carries the
 * ACAD_ROUNDTRIP_PRE2007_TABLE subgroup. The model writer generates the chain
 * only for tables NOT in this set — a carried chain is replayed verbatim by
 * the merge below, the same posture as the annotation variables: generating
 * beside it would emit a second, unreferenced chain and leave the entity
 * pointing at the retained one.
 */
export function graphTableRoundtripCarriers(state: DrawingState): ReadonlySet<string> {
  const carried = new Set<string>();
  const graph = state.cadGraph;
  if (!graph) return carried;
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  for (const node of graph.nodes) {
    if (node.type !== 'ACAD_TABLE' || node.anchor?.kind !== 'entity') continue;
    const extension = node.references?.find(ref => ref.role === 'extension');
    const dictionary = extension?.target ? byId.get(extension.target) : undefined;
    if (!dictionary || !dictionaries.has(dictionary.type)) continue;
    for (let index = 0; index + 1 < dictionary.groups.length; index++) {
      const [code, name] = dictionary.groups[index]!;
      if (code !== 3 || name.trim().toUpperCase() !== 'ACAD_XREC_ROUNDTRIP') continue;
      const target = dictionary.references?.find(ref => ref.groupIndex === index + 1)?.target;
      const record = target ? byId.get(target) : undefined;
      if (record?.type === 'XRECORD' && record.groups.some(([c, v]) => c === 102 && v.trim().toUpperCase() === 'ACAD_ROUNDTRIP_PRE2007_TABLE')) carried.add(node.anchor.id);
    }
  }
  return carried;
}
/**
 * P18 FIX group 2: the retained annotative context chain of each modelled
 * multileader, resolved on the retained graph exactly as RULING-P18-S3-D
 * (1)(ii) pins it (entity extension subgroup -> DICTIONARY ->
 * 'AcDbContextDataManager' entry -> DICTIONARY -> 'ACDB_ANNOTATIONSCALES'
 * entry -> DICTIONARY -> its 350 entries -> the context objects), keyed by
 * entity id. All-or-nothing per entity and type-checked at every link: a
 * chain whose shape does not resolve exactly has no carrier, and the
 * writer's fresh-chain posture applies to it unchanged. A carried chain is
 * REGENERATED IN PLACE by preserveDxfCadGraph (the P22 surgical rule) —
 * its nodes are never dropped, so references into the chain from anywhere
 * else in the graph stay valid.
 */
export interface MLeaderContextChainCarrier {
  readonly extension: CadNode;
  readonly manager: CadNode;
  readonly scales: CadNode;
  readonly objects: readonly CadNode[];
}
export function graphMLeaderContextChainCarriers(state: DrawingState): ReadonlyMap<string, MLeaderContextChainCarrier> {
  const carriers = new Map<string, MLeaderContextChainCarrier>();
  const graph = state.cadGraph;
  if (!graph) return carriers;
  const byHandle = new Map(graph.nodes.flatMap((n) => (n.sourceHandle ? [[canonicalCadHandle(n.sourceHandle), n] as const] : [])));
  const entryTarget = (node: CadNode, keyUpper: string): CadNode | undefined => {
    for (let i = 0; i + 1 < node.groups.length; i += 1) {
      const [code, name] = node.groups[i]!;
      if (code === 3 && name.trim().toUpperCase() === keyUpper && [350, 360].includes(node.groups[i + 1]![0])) {
        return byHandle.get(canonicalCadHandle(node.groups[i + 1]![1].trim()));
      }
    }
    return undefined;
  };
  for (const node of graph.nodes) {
    if (node.anchor?.kind !== 'entity') continue;
    let at = -1;
    for (let i = 0; i + 1 < node.groups.length; i += 1) {
      if (node.groups[i]![0] === 102 && node.groups[i]![1].includes('ACAD_XDICTIONARY') && node.groups[i + 1]![0] === 360) {
        at = i;
        break;
      }
    }
    let extension = at >= 0 ? byHandle.get(canonicalCadHandle(node.groups[at + 1]![1].trim())) : undefined;
    if (!extension && node.sourceHandle) {
      // The writer strips the entity's extension subgroup from the graph
      // copy handed to the merge, so inside preserveDxfCadGraph the chain
      // is found from the extension dictionary's side: it owns a
      // 'AcDbContextDataManager' entry and its 330 names this entity.
      const entityHandle = canonicalCadHandle(node.sourceHandle);
      extension = graph.nodes.find((candidate) => candidate.type === 'DICTIONARY'
        && entryTarget(candidate, 'ACDBCONTEXTDATAMANAGER') !== undefined
        && candidate.groups.some(([code, raw]) => code === 330 && canonicalCadHandle(raw.trim()) === entityHandle));
    }
    if (!extension || extension.type !== 'DICTIONARY') continue;
    const manager = entryTarget(extension, 'ACDBCONTEXTDATAMANAGER');
    if (!manager || manager.type !== 'DICTIONARY') continue;
    const scales = entryTarget(manager, 'ACDB_ANNOTATIONSCALES');
    if (!scales || scales.type !== 'DICTIONARY') continue;
    const objects: CadNode[] = [];
    let resolves = true;
    for (let i = 0; i + 1 < scales.groups.length; i += 1) {
      if (scales.groups[i]![0] !== 3 || scales.groups[i + 1]![0] !== 350) continue;
      const target = byHandle.get(canonicalCadHandle(scales.groups[i + 1]![1].trim()));
      if (!target || target.type !== 'ACDB_MLEADEROBJECTCONTEXTDATA_CLASS') {
        resolves = false;
        break;
      }
      objects.push(target);
    }
    if (resolves) carriers.set(node.anchor.id, { extension, manager, scales, objects });
  }
  return carriers;
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
export function attachDxfCadGraph(state: DrawingState, pairs: readonly Pair[], options: { sourceFormat?: 'DXF' | 'DWG'; fields?: FieldContext; viewportHandles?: ReadonlyMap<string, string>; model3dHandles?: ReadonlyMap<string, CadAnchor>; model3dLines?: ReadonlyMap<number, CadAnchor>; rawEntityHandles?: ReadonlySet<string>; onFieldUnavailable?: FieldExpansion['unavailable']; onGraphUnavailable?: (reason: string) => void } = {}): DrawingState {
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
    if (!(error instanceof CadGraphError) || error.code !== 'invalid' || !options.onGraphUnavailable || options.sourceFormat === 'DWG'
      || options.model3dHandles?.size || pairs.some(pair => pair.code === 1001 && pair.value.trim() === MODEL3D_APP)) throw error;
    options.onGraphUnavailable(`${error.message} Retained metadata and object-reference identities could not be imported safely; readable drawing geometry is kept.`);
    const { cadGraph: _graph, ...bare } = state;
    return replaceEntities(bare, entity => { const { cadIdentity: _drop, ...rest } = entity; return rest as Entity; });
  }
  const prefix = newId(), byHandle = new Map<string, string>(), modeledTables = tableNames(state);
  const viewportHandles = new Map<string, string>();
  for (const [handle, id] of options.viewportHandles ?? []) {
    const key = canonicalCadHandle(handle.trim());
    if (viewportHandles.has(key) && viewportHandles.get(key) !== id) throw new CadGraphError('invalid', 'Ambiguous normalized viewport handle association.');
    viewportHandles.set(key, id);
  }
  const shapeIds = new Map<string, string>();
  for (const sourceId of Object.keys(shapeStylesOf(state))) if (/^[0-9A-Fa-f]{1,16}$/.test(sourceId)) {
    const handle = canonicalCadHandle(sourceId);
    if (shapeIds.has(handle)) throw new CadGraphError('invalid', 'Shape STYLE resources share a native source identity.');
    shapeIds.set(handle, sourceId);
  }
  const entities = lists(state).flat(), entityHandles = new Map<string, Entity>();
  const solids = new Map(state.model3d?.solids.map(solid => [solid.id, solid]));
  const dimensions3d = new Map(state.model3d?.dimensions?.map(dimension => [dimension.id, dimension]));
  for (const entity of entities) if (entity.cadIdentity) entityHandles.set(canonicalCadHandle(entity.cadIdentity), entity);
  const viewportRecords = new Map<string, RecordData>();
  for (const record of sourceRecords) {
    const id = record.type === 'VIEWPORT' && record.handle ? viewportHandles.get(record.handle) : undefined;
    if (!id) continue;
    if (viewportRecords.has(id)) throw new CadGraphError('invalid', 'Ambiguous source viewport association.');
    viewportRecords.set(id, record);
  }
  for (const layout of state.layouts ?? []) for (const viewport of layout.viewports) {
    const boundary = viewport.clipBoundary;
    if (!boundary?.cadIdentity) continue;
    const source = viewportRecords.get(viewport.id);
    if (!source) throw new CadGraphError('dependency', 'A consumed viewport clip has no exact sourceVIEWPORT association.');
    const pointers = scopedValues(source, 340, 'AcDbViewport');
    if (pointers.length !== 1 || canonicalCadHandle(pointers[0]!) !== canonicalCadHandle(boundary.cadIdentity)) throw new CadGraphError('dependency', 'A consumed viewport clip has no exact source340 association.');
  }
  const followerHandles = new Set<string>(); let sourceInsert = false;
  const raw3d = new Set<RecordData>();
  let polyface = false;
  for (const record of sourceRecords) {
    if (record.type === 'POLYLINE') {
      const flags = native3dFlags(record);
      polyface = flags !== undefined && (flags & 64) !== 0
        || payloadText({ kind: record.type, groups: record.groups.map(([code, value]) => ({ code, value })) }) !== null;
    } else if (!['VERTEX', 'SEQEND'].includes(record.type)) polyface = false;
    if (polyface || record.type === 'DIMENSION' && record.groups.some(([code, app]) => code === 1001 && app.trim() === MODEL3D_APP)) {
      raw3d.add(record);
    }
    if (record.type === 'SEQEND') polyface = false;
  }
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
  const dimensionPictures3d = new Map<string, CadAnchor>();
  const pictureRecordsByName = new Map<string, RecordData[]>();
  for (const record of sourceRecords) if (record.type === 'BLOCK_RECORD') {
    const name = identifierValue(record, 2), list = pictureRecordsByName.get(name);
    if (list) list.push(record); else pictureRecordsByName.set(name, [record]);
  }
  for (const record of sourceRecords) if (record.type === 'DIMENSION') {
    const anchor = record.handle ? options.model3dHandles?.get(record.handle) : record.line !== undefined ? options.model3dLines?.get(record.line) : undefined;
    if (anchor?.kind !== 'dimension3d') continue;
    const name = identifierValue(record, 2);
    const matches = pictureRecordsByName.get(name) ?? [];
    if (!matches.length) continue; // Legacy/minimal dimensions may have no picture; generate a new one.
    if (matches.length !== 1 || !matches[0]!.handle) throw new CadGraphError('dependency', 'A 3D dimension picture has no unique source BLOCK_RECORD.');
    const handle = matches[0]!.handle!;
    if (dimensionPictures3d.has(handle)) throw new CadGraphError('dependency', '3D dimensions share a source picture block; independent regeneration is unsafe.');
    dimensionPictures3d.set(handle, { kind: 'dimension3d', id: anchor.id, part: 'picture-block' });
  }
  const synthetic = (record: RecordData): boolean => {
    const owner = sourceByHandle.get(value(record, 330)), block = record.type === 'BLOCK_RECORD' || record.type === 'BLOCK' ? identifierValue(record, 2) : owner?.type === 'BLOCK_RECORD' ? identifierValue(owner, 2) : '';
    return record.type === 'VIEWPORT' && value(record, 69) === '1' && !overallViewports.has(record) || (/^\*[DT]\d+$/i.test(block) || tablePictures.has(block)) && !state.blocks[block];
  };
  const records = sourceRecords.filter(record => (!synthetic(record) || raw3d.has(record) || !!record.handle && dimensionPictures3d.has(record.handle)) && (!['ENTITIES', 'BLOCKS'].includes(record.section) || ['BLOCK', 'ENDBLK', 'ATTDEF'].includes(record.type) || overallViewports.has(record)
    || raw3d.has(record) || record.line !== undefined && options.model3dLines?.has(record.line) || !!record.handle && (entityHandles.has(record.handle) || followerHandles.has(record.handle) || viewportHandles.has(record.handle) || options.model3dHandles?.has(record.handle))
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
  const nodes: CadNode[] = records.filter(r => r.handle || raw3d.has(r) || r.line !== undefined && options.model3dLines?.has(r.line) || r.type === 'CLASS' || r.type === 'HEADER').map((record, index) => {
    const entity = record.handle ? entityHandles.get(record.handle) : undefined;
    const viewportId = record.handle ? viewportHandles.get(record.handle) : undefined;
    const path = record.handle && dictionaries.has(record.type) ? paths.get(record.handle) : undefined;
    const carrier = record.handle ? options.model3dHandles?.get(record.handle) ?? dimensionPictures3d.get(record.handle) : record.line !== undefined ? options.model3dLines?.get(record.line) : undefined;
    const anchor: CadAnchor = carrier || (entity ? { kind: 'entity', id: entity.id } : record.handle && parts.get(record.handle) ? parts.get(record.handle)!
      : viewportId ? { kind: 'viewport', id: viewportId } : path ? { kind: 'dictionary', path }
        : record.type === 'LAYOUT' && (state.layouts ?? []).some(l => l.name.toUpperCase() === layoutName(record).toUpperCase()) ? { kind: 'layout', name: layoutName(record) }
          : tableAnchor(record, modeledTables, shapeIds) ?? { kind: 'raw' });
    const contexts: string[] = []; let currentContext = '';
    const commonAt = record.groups.findIndex(([code]) => code === 100);
    for (const [code, text] of record.groups) { if (code === 102) currentContext = text === '}' ? '' : text; contexts.push(currentContext); }
    const references = cadReferences(record.groups, byHandle).map(ref => {
      const context = contexts[ref.groupIndex];
      return { ...ref, ...(context === '{ACAD_XDICTIONARY' ? { role: 'extension' as const } : context === '{ACAD_REACTORS' ? { role: 'reactor' as const } : record.groups[ref.groupIndex]![0] === 330 && !context && ref.groupIndex < commonAt ? { role: 'owner' as const } : {}) };
    });
    return { id: record.handle ? byHandle.get(record.handle)! : `${prefix}:${record.type}:${index}`, ...(record.handle ? { sourceHandle: record.handle } : {}), type: record.type, section: record.section, groups: record.groups, anchor, references, ...(entity ? { baselineEntity: entity } : {}),
      ...(anchor.kind === 'solid3d' && !anchor.part ? { baselineSolid: solids.get(anchor.id) } : {}),
      ...(anchor.kind === 'dimension3d' && !anchor.part ? { baselineDimension3D: dimensions3d.get(anchor.id) } : {}),
    };
  });
  const header = records.find(r => r.type === 'HEADER'), versionAt = header?.groups.findIndex(([code, val]) => code === 9 && val === '$ACADVER') ?? -1;
  const structural = structuralKeys(sourceRecords), generatedHandles = sourceRecords.flatMap(record => synthetic(record) && record.handle && !dimensionPictures3d.has(record.handle) && structural.has(record) ? [{ key: structural.get(record)!, handle: record.handle }] : []);
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
  const solidNodeIds = new Map(nodes.flatMap(node => node.anchor?.kind === 'solid3d' && !node.anchor.part ? [[node.anchor.id, node.id] as const] : []));
  const dimensionNodeIds = new Map(nodes.flatMap(node => node.anchor?.kind === 'dimension3d' && !node.anchor.part ? [[node.anchor.id, node.id] as const] : []));
  if (state.model3d) state = { ...state, model3d: { ...state.model3d,
    solids: state.model3d.solids.map(solid => solidNodeIds.has(solid.id) ? { ...solid, cadIdentity: solidNodeIds.get(solid.id)! } : solid),
    ...(state.model3d.dimensions ? { dimensions: state.model3d.dimensions.map(dimension => dimensionNodeIds.has(dimension.id) ? { ...dimension, cadIdentity: dimensionNodeIds.get(dimension.id)! } : dimension) } : {}),
  } };
  state = interpretFields(state, graph, options.fields ?? {}, options.onFieldUnavailable);
  const live = new Map(lists(state).flat().map(e => [e.id, e]));
  const liveSolids = new Map(state.model3d?.solids.map(solid => [solid.id, solid]));
  const liveDimensions3d = new Map(state.model3d?.dimensions?.map(dimension => [dimension.id, dimension]));
  const finalGraph = { ...graph, nodes: graph.nodes.map(node => node.anchor?.kind === 'entity' && !node.anchor.part ? { ...node, baselineEntity: live.get(node.anchor.id) }
    : node.anchor?.kind === 'solid3d' && !node.anchor.part ? { ...node, baselineSolid: liveSolids.get(node.anchor.id) }
      : node.anchor?.kind === 'dimension3d' && !node.anchor.part ? { ...node, baselineDimension3D: liveDimensions3d.get(node.anchor.id) } : node) };
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
  const liveSolids = new Map(state.model3d?.solids.map(solid => [solid.id, solid]));
  const liveDimensions3d = new Map(state.model3d?.dimensions?.map(dimension => [dimension.id, dimension]));
  const primarySolids = new Map(graph.nodes.flatMap(node => node.anchor?.kind === 'solid3d' && !node.anchor.part && node.baselineSolid ? [[node.anchor.id, node.baselineSolid] as const] : []));
  const solidParts = new Map<string, number>();
  const solidParents = new Map<string, CadNode>();
  for (const node of graph.nodes) if (node.anchor?.kind === 'solid3d' && node.type === 'POLYLINE') solidParts.set(node.anchor.id, (solidParts.get(node.anchor.id) ?? 0) + 1);
  for (const node of graph.nodes) if (node.anchor?.kind === 'solid3d' && node.type === 'POLYLINE') solidParents.set(JSON.stringify([node.anchor.id, node.anchor.part ?? 'polyface:0']), node);
  const generated = recordsOf(pairsOf(text)), sources = graph.nodes.map(node => ({ type: node.type, section: node.section, groups: [...node.groups], ...(node.sourceHandle ? { handle: canonicalCadHandle(node.sourceHandle) } : {}) }));
  // P18 FIX group 1: the records the model writer itself emitted (retained
  // records are pushed into `generated` later, as different objects) — the
  // context-object 340 pass below completes only the writer's own objects.
  const writerGenerated = new Set(generated);
  const sourceKeys = logicalKeys(sources), generatedKeys = logicalKeys(generated), byAnchor = new Map<string, CadNode>(), byKey = new Map<string, CadNode>();
  const viewportBoundaries = new Map((state.layouts ?? []).flatMap(layout => layout.viewports.flatMap(viewport => viewport.clipBoundary ? [[viewport.id, viewport.clipBoundary.id] as const] : [])));
  const overallSourceIds = new Set(graph.nodes.flatMap((node, index) => sourceKeys.get(sources[index]!)?.startsWith('["mainviewport",') ? [node.id] : []));
  graph.nodes.forEach((node, index) => {
    const anchor = cadAnchorKey(node.anchor); if (anchor) byAnchor.set(anchor, node);
    // Synthesized document registries have no source file handle. Their proven dictionary path
    // still identifies the canonical generated NOD, so no disconnected second root is emitted.
    const key = node.anchor?.kind === 'dictionary' ? anchor : node.anchor?.kind === 'solid3d' || node.anchor?.kind === 'dimension3d' ? undefined : sourceKeys.get(sources[index]!);
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
  const rawPolyfaceOwners = new Map<string, string | null>();
  const rawPolyfaceParents = new Map<string, CadNode>();
  let rawSequence: { parent: CadNode; vertices: CadNode[] } | undefined;
  const objectOf = (node: CadNode) => ({ kind: node.type, groups: node.groups.map(([code, value]) => ({ code, value })) });
  for (const node of graph.nodes) {
    if (node.anchor?.kind === 'raw' && node.type === 'POLYLINE') {
      const flags = native3dFlags(node);
      if (flags !== undefined && (flags & 64)) {
        if (rawSequence) throw new CadGraphError('dependency', 'A retained polyface sequence is incomplete.');
        rawSequence = { parent: node, vertices: [] }; rawPolyfaceParents.set(node.id, node); rawPolyfaceOwners.set(node.id, null); continue;
      }
    }
    if (!rawSequence) continue;
    if (node.type === 'VERTEX' && node.anchor?.kind === 'raw') { rawSequence.vertices.push(node); rawPolyfaceOwners.set(node.id, rawSequence.parent.id); continue; }
    if (node.type === 'SEQEND' && node.anchor?.kind === 'raw') {
      rawPolyfaceOwners.set(node.id, rawSequence.parent.id);
      const problem = polyfaceStructureProblem(objectOf(rawSequence.parent), rawSequence.vertices.map(objectOf), true);
      if (problem) throw new CadGraphError('dependency', `Cannot save malformed retained polyface: ${problem}. Its original records are retained.`);
      rawSequence = undefined; continue;
    }
    throw new CadGraphError('dependency', 'A retained polyface sequence is incomplete or interleaved.');
  }
  if (rawSequence) throw new CadGraphError('dependency', 'A retained polyface sequence is missing its SEQEND.');
  const polyfaceOwners = new Map(rawPolyfaceOwners), polyfaceParents = new Map(rawPolyfaceParents);
  for (const node of graph.nodes) if (node.anchor?.kind === 'solid3d') {
    if (node.type === 'POLYLINE') { polyfaceOwners.set(node.id, null); polyfaceParents.set(node.id, node); }
    else if (node.type === 'VERTEX' || node.type === 'SEQEND') {
      const part = node.anchor.part?.match(/^polyface:(\d+):/)?.[1];
      const parent = part !== undefined && solidParents.get(JSON.stringify([node.anchor.id, `polyface:${part}`]));
      if (!parent) throw new CadGraphError('dependency', 'Imported 3D carrier has no proven source parent.');
      polyfaceOwners.set(node.id, parent.id);
    }
  }
  const polyfaceOwnerIndices = new Map<string, number>();
  const sourceModelOwners = new Set(graph.nodes.filter(node => node.section === 'TABLES' && node.type === 'BLOCK_RECORD'
    && decodeUnicodeEscapes(native3dValue(node, 2)).toUpperCase() === '*MODEL_SPACE').map(node => node.id));
  for (const node of graph.nodes) if (polyfaceOwners.has(node.id)) {
    const native = native3dObject(objectOf(node));
    const paper = native.groups.filter(group => group.code === 67), layout = native.groups.filter(group => group.code === 410);
    if (node.section !== 'ENTITIES' || paper.length > 1 || layout.length > 1
      || paper.some(group => !isIntegerText(group.value.trim()) || Number(group.value) !== 0)
      || layout.some(group => decodeUnicodeEscapes(group.value.trim()).toUpperCase() !== 'MODEL')) {
      throw new CadGraphError('dependency', 'Cannot save an unconsumed polyface outside model space: its block/layout carrier placement is not modeled. The original records are retained.');
    }
    // Only the top-level common owner is structural. Reactor, subclass and application
    // pointers (including a fake subclass inside 102) cannot identify its container.
    let depth = 0;
    const owners: number[] = [];
    for (let index = 0; index < node.groups.length; index++) {
      const [code, raw] = node.groups[index]!;
      if (code === 102) { depth += raw.trim().startsWith('{') ? 1 : raw.trim() === '}' ? -1 : 0; continue; }
      if (depth) continue;
      if (code === 100 || code === 1001) break;
      if (code === 330) owners.push(index);
    }
    if (owners.length > 1) throw new CadGraphError('dependency', 'Cannot save a retained polyface with ambiguous common ownership. Its original records are retained.');
    if (!owners.length) continue;
    const index = owners[0]!, sourceOwner = canonicalCadHandle(node.groups[index]![1].trim());
    const sourceReference = node.references?.find(ref => ref.groupIndex === index);
    const parentId = polyfaceOwners.get(node.id);
    if (parentId) {
      const parent = polyfaceParents.get(parentId)!;
      // Explicit clone maps can rekey a proven target before file handles are allocated.
      if (sourceReference?.target ? sourceReference.target !== parent.id : !parent.sourceHandle || sourceOwner !== canonicalCadHandle(parent.sourceHandle)) {
        throw new CadGraphError('dependency', 'Cannot save a retained polyface follower with unproven parent ownership. Its original records are retained.');
      }
    } else {
      const target = sourceReference?.target;
      if (target && !sourceModelOwners.has(target)) throw new CadGraphError('dependency', 'Cannot save a retained polyface with a non-model source owner. Its original records are retained.');
    }
    polyfaceOwnerIndices.set(node.id, index);
  }
  const retainedModelGeometry = (node: CadNode) => node.section === 'ENTITIES' && (!node.anchor || node.anchor.kind === 'raw') && Number(value(node, 67)) !== 1 && ['3DFACE', '3DSOLID', 'REGION', 'BODY'].includes(node.type);
  const sourceGroups = (node: CadNode, selected?: ReadonlySet<number>): CadGroup[] => {
    const references = new Map((node.references ?? []).map(ref => [ref.groupIndex, ref]));
    return node.groups.flatMap(([code, raw], index): CadGroup[] => {
      if (selected && !selected.has(index)) return [];
      if (node.type !== 'HEADER' && (code === 5 || code === 105)) return [[code, nodeHandles.get(node.id)!]];
      if (polyfaceOwnerIndices.get(node.id) === index) {
        const parent = polyfaceOwners.get(node.id), owner = parent ? nodeHandles.get(parent) : modelOwner;
        if (!owner) throw new CadGraphError('dependency', 'Retained polyface has no exported owner.');
        return [[code, owner]];
      }
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
    if (node.anchor?.kind === 'solid3d') {
      const solid = liveSolids.get(node.anchor.id), baseline = primarySolids.get(node.anchor.id);
      if (!solid || !baseline) throw new CadGraphError('dependency', 'Retained 3D carrier has no current solid or proven source baseline.');
      record.groups = solidCarrierGroups(sourceGroups(node), node, solid, baseline, solidParts.get(solid.id)!);
      if (!node.sourceHandle) record.groups.unshift([5, nodeHandles.get(node.id)!]);
      if (!polyfaceOwnerIndices.has(node.id)) {
        const part = node.anchor.part?.match(/^polyface:(\d+)/)?.[1] ?? '0';
        const parent = solidParents.get(JSON.stringify([solid.id, `polyface:${part}`]));
        const owner = node.type === 'POLYLINE' ? modelOwner : parent && nodeHandles.get(parent.id);
        if (!owner) throw new CadGraphError('dependency', 'Imported 3D carrier has no exported owner.');
        record.groups.splice(1, 0, [330, owner]);
      }
      continue;
    }
    let retainOwn3d = false;
    if (node.anchor?.kind === 'dimension3d' && !node.anchor.part) {
      const dimension = liveDimensions3d.get(node.anchor.id), baseline = node.baselineDimension3D;
      if (!dimension || !baseline) throw new CadGraphError('dependency', 'Retained 3D dimension has no current dimension or source baseline.');
      const flags = native3dFlags(node, 255);
      if (flags === undefined) throw new CadGraphError('dependency', 'Cannot regenerate retained 3D dimension with malformed native flags.');
      if (flags & 128 || Number(native3dValue(node, 52)) !== 0 || Number(native3dValue(node, 53)) !== 0) throw new CadGraphError('dependency', 'Cannot regenerate a 3D dimension with retained moved/rotated text or oblique extension lines. Its source fields remain retained.');
      const payload = payloadText({ kind: node.type, groups: node.groups.map(([code, value]) => ({ code, value })) });
      const decoded = payload && 'text' in payload ? decodeDimensionPayload(payload.text) : undefined;
      retainOwn3d = !!payload && decoded?.status !== 'ok';
      if (retainOwn3d) {
        throw new CadGraphError('dependency', 'Cannot regenerate a 3D dimension with unknown, newer or invalid JCAD_3D payload. Its original data is retained; use the original drawing until that payload is supported.');
      }
      // ACI/layer are modeled; the unexposed truecolor/book/transparency fields remain exact
      // while their corresponding modeled color is unchanged.
      if (dimension.color === baseline.color) {
        const appearance = native3dObject({ kind: node.type, groups: sourceGroups(node).map(([code, value]) => ({ code, value })) }).groups.filter(({ code }) => [420, 430, 440].includes(code)).map(({ code, value }) => [code, value] as const);
        appendBeforeXdata(record.groups, ...appearance);
      }
    }
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
    // Regenerate only a proven live clip link. An unexposed source340 remains a
    // retained hard reference and must refuse export rather than disappear.
    const viewportId = node.anchor?.kind === 'viewport' ? node.anchor.id : undefined;
    const boundaryId = viewportId && viewportBoundaries.get(viewportId);
    const sourceClip = boundaryId && byAnchor.get(cadAnchorKey({ kind: 'entity', id: boundaryId })!);
    const clipPointers = node.type === 'VIEWPORT' ? scopedValues(node, 340, 'AcDbViewport') : [];
    const provenClip = sourceClip && clipPointers.length === 1
      && node.references?.some(ref => ref.target === sourceClip.id && node.groups[ref.groupIndex]?.[0] === 340
        && node.groups[ref.groupIndex]![1].trim() === clipPointers[0]);
    const rebuilt = liveComplex ? complexCodes : node.type === 'LAYER' ? new Set([390]) : node.type === 'DIMSTYLE' ? new Set([340, 342, 343, 344]) : node.type === 'LEADER' ? new Set([340]) : node.type === 'VIEWPORT' ? new Set(provenClip ? [331, 340] : [331]) : ['MULTILEADER', 'MLEADER', 'ACAD_TABLE', 'IMAGE'].includes(node.type) ? new Set([340, 341, 342, 343, 344, 360]) : new Set<number>();
    let nesting = 0, selectedApp: string | undefined, keepHeader = false, layoutSubclass = false, retainedLayoutBlock = false;
    const existingVariables = new Set(record.groups.filter(([code]) => code === 9).map(([, name]) => name));
    node.groups.forEach(([code, raw], index) => {
      if (node.type === 'HEADER') {
        if (code === 9) {
          keepHeader = !existingVariables.has(raw) && headerVariableReemittable(raw.trim());
          if (keepHeader && raw.trim() === '$ACADMAINTVER') keepHeader = acadMaintVerKept(record.groups, node.groups, node.groups[index + 1]?.[0]);
        }
        if (keepHeader) selected.add(index);
        return;
      }
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
      if (selectedApp) { if (!(selectedApp === MODEL3D_APP && node.anchor?.kind === 'dimension3d' && !retainOwn3d) && !isQuietXdataApp(selectedApp, node.type) && !(selectedApp === 'AcCmTransparency' && node.type === 'LAYER')) selected.add(index); return; }
      if (rebuilt.has(code)) return;
      if (node.anchor?.kind === 'entity' || node.anchor?.kind === 'viewport' || node.anchor?.kind === 'dimension3d') {
        if (cadReferenceKind(code) && code !== 330) selected.add(index);
      } else if (![5, 105, 100, 330].includes(code) && !generatedCodes.has(code)) selected.add(index);
    });
    const retained = mergeAcadDstyle(sourceGroups(node, selected), record.groups, node.type);
    if (record.type === 'HEADER') {
      const existing = new Set(record.groups.filter(([code]) => code === 9).map(([, val]) => val));
      let keep = false;
      for (let index = 0; index < retained.length; index++) {
        const group = retained[index]!;
        if (group[0] === 9) {
          keep = !existing.has(group[1]) && headerVariableReemittable(group[1].trim());
          if (keep && group[1].trim() === '$ACADMAINTVER') keep = acadMaintVerKept(record.groups, node.groups, retained[index + 1]?.[0]);
        }
        if (keep) record.groups.push(group);
      }
      continue;
    }
    const metadata: CadGroup[] = [], apps = new Set<string>(); let brace = 0, app: string | undefined;
    for (const group of retained) {
      const [code, raw] = group;
      if (code === 102) { metadata.push(group); brace += raw.startsWith('{') ? 1 : raw === '}' ? -1 : 0; continue; }
      if (brace) { metadata.push(group); continue; }
      if (code === 1001) { app = raw; apps.add(raw.trim().toUpperCase()); }
      if (app) { metadata.push(group); continue; }
      if (node.anchor?.kind !== 'entity' && node.anchor?.kind !== 'viewport' && node.anchor?.kind !== 'dimension3d' && ![5, 105, 100, 330].includes(code) && !generatedCodes.has(code)) appendBeforeXdata(record.groups, group);
      else if ((node.anchor?.kind === 'entity' || node.anchor?.kind === 'viewport' || node.anchor?.kind === 'dimension3d') && cadReferenceKind(code)) appendBeforeXdata(record.groups, group);
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
  const plainRecords = new Set(generated);
  for (let index = 0; index < graph.nodes.length; index++) {
    const node = graph.nodes[index]!;
    if (matched.has(node.id)) continue;
    if (node.anchor?.kind === 'raw' && node.type === 'POLYLINE') {
      const flags = native3dFlags(node);
      if (payloadText({ kind: node.type, groups: node.groups.map(([code, value]) => ({ code, value })) })) throw new CadGraphError('dependency', 'Cannot regenerate an unconsumed JCAD_3D polyface carrier. Its original source records are retained.');
      if (flags !== undefined && flags & 64 && (node.section !== 'ENTITIES' || Number(native3dValue(node, 67)) === 1)) throw new CadGraphError('dependency', 'Cannot save an unconsumed polyface outside model space: its block/layout carrier placement is not modeled. The original records are retained.');
    }
    if (node.anchor?.kind === 'raw' && node.type === 'DIMENSION' && node.groups.some(([code, app]) => code === 1001 && app.trim() === MODEL3D_APP)) throw new CadGraphError('dependency', 'Cannot regenerate an unsupported JCAD_3D dimension carrier. Its original data is retained.');
    if (node.anchor && node.anchor.kind !== 'raw' && node.anchor.kind !== 'dictionary') throw new CadGraphError('dependency', `Cannot save retained ${node.type}: its edited object has no generated record.`);
    const groups = sourceGroups(node);
    if (rawPolyfaceOwners.has(node.id)) {
      if (!node.sourceHandle) groups.unshift([5, nodeHandles.get(node.id)!]);
      if (!polyfaceOwnerIndices.has(node.id)) {
        const parent = rawPolyfaceOwners.get(node.id), owner = parent ? nodeHandles.get(parent) : modelOwner;
        if (!owner) throw new CadGraphError('dependency', 'Retained polyface has no exported owner.');
        groups.splice(1, 0, [330, owner]);
      }
    }
    if (retainedModelGeometry(node) && !node.references?.some(ref => ref.role === 'owner' && node.groups[ref.groupIndex]?.[0] === 330)) {
      if (!modelOwner) throw new CadGraphError('dependency', `Cannot save retained ${node.type}: the generated model-space owner is missing.`);
      groups.splice(referenceBlockPosition(groups), 0, [330, modelOwner]);
    }
    generated.push({ type: node.type, section: node.section, groups, ...(nodeHandles.has(node.id) ? { handle: nodeHandles.get(node.id) } : {}) });
  }
  // P22 F-2 final fix: a generated roundtrip chain belongs in the table's
  // EXISTING extension dictionary when the retained graph carries one without
  // the ACAD_XREC_ROUNDTRIP key. The merge above keeps the source 102 block,
  // so the entity points at the retained dictionary while the model writer's
  // chain hangs off a fresh one — orphaned, and AutoCAD loads the cells
  // empty. Move the entry, in the Q11 insertion posture: append
  // ACAD_XREC_ROUNDTRIP -> the generated chain's XRECORD to the retained
  // dictionary record (its other keys untouched), re-own the XRECORD to that
  // dictionary, drop the generated dictionary record, and repoint any
  // lingering reference to it. A dictionary already carrying the key is a
  // chain carrier — generation never ran for it — and is left as retained.
  {
    const byId = new Map(graph.nodes.map(node => [node.id, node]));
    const canon = (raw: string): string | undefined => /^[0-9A-Fa-f]{1,16}$/.test(raw.trim()) ? canonicalCadHandle(raw.trim()) : undefined;
    const finalByHandle = new Map<string, RecordData>();
    for (const record of generated) {
      const handle = canon(value(record, 5));
      if (handle && !finalByHandle.has(handle)) finalByHandle.set(handle, record);
    }
    const referenceCodes = HANDLE_REFERENCE_CODES;
    const rehomed = new Set<string>();
    for (const node of graph.nodes) {
      if (node.type !== 'ACAD_TABLE' || node.anchor?.kind !== 'entity') continue;
      const extension = node.references?.find(ref => ref.role === 'extension');
      const dictionary = extension?.target ? byId.get(extension.target) : undefined;
      if (!dictionary || !dictionaries.has(dictionary.type) || rehomed.has(dictionary.id)) continue;
      if (dictionary.groups.some(([code, name]) => code === 3 && name.trim().toUpperCase() === 'ACAD_XREC_ROUNDTRIP')) continue;
      const retainedHandle = canon(nodeHandles.get(dictionary.id) ?? '');
      const retainedRecord = retainedHandle ? finalByHandle.get(retainedHandle) : undefined;
      if (!retainedRecord || !dictionaries.has(retainedRecord.type)) continue;
      if (retainedRecord.groups.some(([code, name]) => code === 3 && name.trim().toUpperCase() === 'ACAD_XREC_ROUNDTRIP')) continue;
      const entityHandle = canon(nodeHandles.get(node.id) ?? '');
      if (!entityHandle) continue;
      const generatedDict = generated.find(record => plainRecords.has(record) && !match.has(record) && record.type === 'DICTIONARY'
        && record.groups.some(([code, raw]) => code === 330 && canon(raw) === entityHandle)
        && record.groups.some(([code, name]) => code === 3 && name.trim().toUpperCase() === 'ACAD_XREC_ROUNDTRIP'));
      if (!generatedDict) continue;
      const entryAt = generatedDict.groups.findIndex(([code, name]) => code === 3 && name.trim().toUpperCase() === 'ACAD_XREC_ROUNDTRIP');
      const chainHandle = canon(generatedDict.groups[entryAt + 1]?.[1] ?? '');
      const generatedHandle = canon(value(generatedDict, 5));
      const chainRecord = chainHandle ? finalByHandle.get(chainHandle) : undefined;
      if (!chainHandle || !generatedHandle || !chainRecord || chainRecord.type !== 'XRECORD') continue;
      retainedRecord.groups.push([3, 'ACAD_XREC_ROUNDTRIP'], [360, chainHandle]);
      chainRecord.groups = chainRecord.groups.map(([code, raw]) => (code === 330 && canon(raw) === generatedHandle ? [code, retainedHandle!] as CadGroup : [code, raw] as CadGroup));
      generated.splice(generated.indexOf(generatedDict), 1);
      for (const record of generated) {
        record.groups = record.groups.map(([code, raw]) => (referenceCodes.has(code) && canon(raw) === generatedHandle ? [code, retainedHandle!] as CadGroup : [code, raw] as CadGroup));
      }
      rehomed.add(dictionary.id);
    }
  }
  // P22 PR #39 fix (Codex P1; lead ruling): the AC1015 roundtrip chain is
  // DERIVED data, so a retained chain is never replayed verbatim — on every
  // AC1015 write its contents (the CELL_VALUE xrecords and the
  // ACDBDATATABLE rows/cols/cells) are regenerated from the CURRENT model,
  // in place: the dictionary record is untouched (its ACAD_XREC_ROUNDTRIP
  // key and every unrelated key stay), and the XRECORD, datatable and cell
  // records keep their handles (cells positionally; a longer grid allocates
  // fresh handles for the new cells, a shorter one drops the surplus
  // records). Regenerating an unchanged table reproduces the retained
  // groups exactly, so the round trip stays a byte fixed point.
  // P22 PR #39 re-review (Codex P1 pair; lead ruling): the regeneration is
  // SURGICAL — it touches only the recognized derived fields. A CELL_VALUE
  // rewrite replaces only the derived value groups (the run of
  // 93/90/1/2/3/94/300/302/303/304 after the identity head) and preserves
  // everything else byte-verbatim in position (XDATA 1001..., any
  // unrecognized group); the ACDBDATATABLE rewrite updates only the
  // 70/90/91 counts and the four known column segments' value runs and
  // likewise preserves every other group. A surplus cell record that is
  // still referenced by a surviving record is KEPT, detached from the
  // chain, never deleted into a dangling pointer; after regeneration the
  // final reference set is validated before assembly (below).
  // P18 FIX group 2 (Codex PR #40 P1): carried annotative context chains
  // are regenerated IN PLACE from the current model — the P22 surgical
  // rule applied to the context chain. The extension and manager
  // dictionaries are not regenerated at all (their modelled content never
  // changes, so unrelated keys and XDATA ride through byte-verbatim); the
  // scales dictionary keeps every non-entry group and gains the current
  // entry list; each retained context object keeps its identity head
  // (reactors, owner, type markers — the 290 default flag follows its
  // position) and its XDATA tail byte-verbatim, while the annotative
  // header's group 340 and the CONTEXT_DATA body (which begins with the
  // single group 40) are rewritten from the model. Surplus objects the
  // model no longer carries are deleted only when no surviving record
  // references them; a referenced surplus is kept, detached from the
  // chain. The final reference set is validated below whenever a chain
  // was regenerated, so a save that would dangle fails atomically.
  let contextChainsRegenerated = false;
  const contextRegenerated = new Set<RecordData>();
  {
    const carriers = graphMLeaderContextChainCarriers(state);
    if (carriers.size) {
      const leaders = new Map<string, LeaderEntity>();
      for (const list of lists(state)) for (const entity of list) if (entity.type === 'leader') leaders.set(entity.id, entity);
      const canon = (raw: string): string | undefined => /^[0-9A-Fa-f]{1,16}$/.test(raw.trim()) ? canonicalCadHandle(raw.trim()) : undefined;
      const byHandle = new Map<string, RecordData>();
      for (const record of generated) {
        const handle = canon(value(record, 5));
        if (handle && !byHandle.has(handle)) byHandle.set(handle, record);
      }
      const recordOf = (node: CadNode): RecordData | undefined => {
        const handle = canon(nodeHandles.get(node.id) ?? '');
        return handle ? byHandle.get(handle) : undefined;
      };
      const indexedAll = generated.map((record) => {
        const handle = value(record, 5);
        return handle && record.type !== 'HEADER' ? { ...record, handle: canonicalCadHandle(handle) } : record;
      });
      const listEntries = scaleListOf(indexedAll)?.entries ?? new Map<string, RecordData>();
      const surplus = new Set<RecordData>();
      for (const [id, carrier] of carriers) {
        const leader = leaders.get(id);
        if (!leader?.mleader?.contexts?.length) continue;
        const views = mleaderContextViews(leader);
        const scalesRecord = recordOf(carrier.scales);
        if (!scalesRecord) continue;
        const scalesHandle = canon(nodeHandles.get(carrier.scales.id) ?? '')!;
        // The current object handles: retained positionally, then the
        // writer-emitted growth objects (their 330 names this scales
        // dictionary by its retained handle).
        const growth = generated.filter((record) => writerGenerated.has(record)
          && record.type === 'ACDB_MLEADEROBJECTCONTEXTDATA_CLASS'
          && record.groups.some(([code, raw]) => code === 330 && canon(raw) === scalesHandle));
        const objectHandles: string[] = [];
        views.forEach((view, i) => {
          if (i < carrier.objects.length) objectHandles.push(canon(nodeHandles.get(carrier.objects[i]!.id) ?? '')!);
          else objectHandles.push(growth[i - carrier.objects.length] ? canon(value(growth[i - carrier.objects.length]!, 5))! : '');
        });
        // Scales dictionary: the entry pairs are replaced in place (at the
        // first entry's position); every other group is verbatim.
        {
          const sourceKeys: string[] = [];
          for (let i = 0; i + 1 < carrier.scales.groups.length; i += 1) if (carrier.scales.groups[i]![0] === 3) sourceKeys.push(carrier.scales.groups[i]![1]);
          const entries: CadGroup[] = [];
          objectHandles.forEach((handle, i) => entries.push([3, sourceKeys[i] ?? `*A${i + 1}`], [350, handle]));
          const kept: CadGroup[] = [];
          let insertAt = -1;
          const groups = scalesRecord.groups;
          for (let i = 0; i < groups.length; i += 1) {
            if (groups[i]![0] === 3 && i + 1 < groups.length && (groups[i + 1]![0] === 350 || groups[i + 1]![0] === 360)) {
              if (insertAt < 0) insertAt = kept.length;
              i += 1;
              continue;
            }
            kept.push(groups[i]!);
          }
          if (insertAt < 0) insertAt = kept.length;
          kept.splice(insertAt, 0, ...entries);
          scalesRecord.groups = kept;
        }
        // The retained context objects, regenerated positionally.
        views.forEach((view, i) => {
          if (i >= carrier.objects.length) return;
          const record = recordOf(carrier.objects[i]!);
          if (!record) return;
          const groups = record.groups;
          const annotAt = groups.findIndex(([code, raw]) => code === 100 && raw.trim() === 'AcDbAnnotScaleObjectContextData');
          if (annotAt < 0) return;
          let tailAt = groups.length;
          for (let j = annotAt + 1; j < groups.length; j += 1) {
            const [code, raw] = groups[j]!;
            if (code === 1001 || (code === 102 && raw.includes('ACAD_XDATA'))) {
              tailAt = j;
              break;
            }
          }
          const head = groups.slice(0, annotAt + 1).map((group, j): CadGroup => {
            if (group[0] === 290 && j > 0 && groups[j - 1]![0] === 100 && groups[j - 1]![1].trim() === 'AcDbObjectContextData') {
              const flag = i === 0 ? 1 : 0;
              return Number(group[1]) === flag ? group : [290, String(flag)];
            }
            return group;
          });
          // The retained body's own text-style handle (the 340 after the
          // first 304) primes the body builder — the merge cannot recompute
          // the writer's name -> handle map.
          let styleHandle: string | undefined;
          const textAt = groups.findIndex(([code]) => code === 304);
          if (textAt >= 0) {
            for (let j = textAt + 1; j < tailAt; j += 1) {
              if (groups[j]![0] === 340) {
                styleHandle = canon(groups[j]![1]);
                break;
              }
            }
          }
          let blockRecordHandle: string | undefined;
          if (leader.mleader?.contentType === 'block' && leader.mleader.block) {
            const name = leader.mleader.block.name.toUpperCase();
            for (const candidate of generated) {
              if (candidate.type === 'BLOCK_RECORD' && value(candidate, 2).toUpperCase() === name) {
                blockRecordHandle = canon(value(candidate, 5));
                break;
              }
            }
            if (!blockRecordHandle) {
              for (let j = annotAt + 1; j < tailAt; j += 1) {
                if (groups[j]![0] === 341) {
                  blockRecordHandle = canon(groups[j]![1]);
                  break;
                }
              }
            }
          }
          const body = mleaderContextBodyGroups(view, blockRecordHandle, styleHandle);
          // Group 340: the view's scale name (the retained source name, or
          // the canonical name of the factor) resolved against the final
          // scale list; when it cannot resolve here, the group-1
          // completion pass below creates the SCALE and inserts the 340.
          const name = view.scaleName ?? formatScale(1 / view.scaleFactor);
          const target = listEntries.get(name)?.handle;
          record.groups = [...head, ...(target ? [[340, target] as CadGroup] : []), ...body, ...groups.slice(tailAt)];
          contextRegenerated.add(record);
          contextChainsRegenerated = true;
        });
        for (let i = views.length; i < carrier.objects.length; i += 1) {
          const record = recordOf(carrier.objects[i]!);
          if (record) surplus.add(record);
        }
      }
      if (surplus.size) {
        // A surplus object still referenced by a surviving record is kept,
        // detached; an unreferenced one is dropped. Fixpoint, because a
        // kept surplus may itself reference another surplus.
        const referenceCodes = new Set([330, 340, 341, 342, 343, 344, 350, 360]);
        const surplusHandles = new Set([...surplus].map((record) => canon(value(record, 5))!));
        const kept = new Set<RecordData>();
        let changed = true;
        while (changed) {
          changed = false;
          for (const record of generated) {
            if (surplus.has(record) && !kept.has(record)) continue;
            for (const [code, raw] of record.groups) {
              if (!referenceCodes.has(code)) continue;
              const handle = canon(raw);
              if (!handle || !surplusHandles.has(handle)) continue;
              const target = byHandle.get(handle);
              if (target && !kept.has(target)) {
                kept.add(target);
                changed = true;
              }
            }
          }
        }
        for (const record of surplus) {
          if (!kept.has(record)) generated.splice(generated.indexOf(record), 1);
        }
      }
    }
  }
  // P22 PR #39 re-review 2 (Codex residual P1 variants; lead ruling): the
  // reference scans (rehome, keep-scan, validation) share the ONE
  // cadReferenceKind-derived code set HANDLE_REFERENCE_CODES, and an
  // unrecognized layout is parsed tolerantly (999 comments and unknown
  // groups skipped in place) — never rebuilt wholesale; derived values
  // that cannot be located at all refuse the save atomically.
  let roundtripRegenerated = false;
  {
    const header = generated.find(record => record.type === 'HEADER');
    if (header && headerVersionOf(header.groups) === 'AC1015') {
      const carriedIds = graphTableRoundtripCarriers(state);
      if (carriedIds.size) {
        roundtripRegenerated = true;
        const tables = new Map<string, TableEntity>();
        for (const list of lists(state)) for (const entity of list) if (entity.type === 'table') tables.set(entity.id, entity);
        const canon = (raw: string): string | undefined => /^[0-9A-Fa-f]{1,16}$/.test(raw.trim()) ? canonicalCadHandle(raw.trim()) : undefined;
        const byHandle = new Map<string, RecordData>();
        for (const record of generated) {
          const handle = canon(value(record, 5));
          if (handle && !byHandle.has(handle)) byHandle.set(handle, record);
        }
        const surplus = new Set<RecordData>();
        for (const id of carriedIds) {
          const table = tables.get(id);
          if (!table) continue;
          const node = graph.nodes.find(candidate => candidate.type === 'ACAD_TABLE' && candidate.anchor?.kind === 'entity' && candidate.anchor.id === id);
          if (!node) continue;
          const entityHandle = canon(nodeHandles.get(node.id) ?? '');
          const entityRecord = entityHandle ? byHandle.get(entityHandle) : undefined;
          if (!entityRecord) continue;
          const xAt = entityRecord.groups.findIndex(([code, raw]) => code === 102 && raw.trim().toUpperCase() === '{ACAD_XDICTIONARY');
          if (xAt < 0) continue;
          const dictHandle = canon(entityRecord.groups[xAt + 1]?.[1] ?? '');
          const dictRecord = dictHandle ? byHandle.get(dictHandle) : undefined;
          if (!dictRecord || !dictionaries.has(dictRecord.type)) continue;
          let entryAt = -1;
          for (let index = 0; index + 1 < dictRecord.groups.length; index++) {
            const [code, name] = dictRecord.groups[index]!;
            if (code === 3 && name.trim().toUpperCase() === 'ACAD_XREC_ROUNDTRIP' && dictRecord.groups[index + 1]![0] === 360) { entryAt = index; break; }
          }
          if (entryAt < 0) continue;
          const recordHandle = canon(dictRecord.groups[entryAt + 1]![1]);
          const chainRecord = recordHandle ? byHandle.get(recordHandle) : undefined;
          if (!chainRecord || chainRecord.type !== 'XRECORD') continue;
          const cells = tableRoundtripCells(table);
          // The chain XRECORD: rows/cols inside the PRE2007_TABLE subgroup
          // follow the model; the TABLECELL subgroup names the datatable.
          let dataHandle: string | undefined;
          let inTable = false, inCells = false;
          for (let index = 0; index < chainRecord.groups.length; index++) {
            const [code, raw] = chainRecord.groups[index]!;
            if (code === 102) {
              const marker = raw.trim().toUpperCase();
              inTable = marker === 'ACAD_ROUNDTRIP_PRE2007_TABLE';
              inCells = marker === 'ACAD_ROUNDTRIP_PRE2007_TABLECELL';
              continue;
            }
            if (inTable && code === 90) chainRecord.groups[index] = [90, String(table.rowHeights.length)];
            else if (inTable && code === 91) chainRecord.groups[index] = [91, String(table.columnWidths.length)];
            else if (inCells && code === 360) dataHandle = canon(raw);
          }
          if (!dataHandle) continue;
          const dataRecord = byHandle.get(dataHandle);
          if (!dataRecord || dataRecord.type !== 'ACDBDATATABLE') continue;
          // The retained cell handles, in datatable order (the 92 = 6 column).
          const retainedHandles: string[] = [];
          let segment: number | undefined;
          for (const [code, raw] of dataRecord.groups) {
            if (code === 92) segment = Number(raw);
            else if (segment === 6 && code === 360) { const handle = canon(raw); if (handle) retainedHandles.push(handle); }
          }
          const cellHandles = cells.map((_, index) => retainedHandles[index] ?? allocate());
          // The datatable rewrite is surgical (re-review rule 1) AND
          // tolerant (re-review 2 rule 2): only the 70/90/91 counts and
          // the value runs of the four known column segments (92 = 2 ->
          // 40 content sums, the first 92 = 1 -> 93 alignment flags, the
          // second 92 = 1 -> 93 zeros, 92 = 6 -> 360 cell handles) are
          // regenerated. Everything else — the identity head, segment
          // name groups, unrecognized segments, planted groups such as
          // XDATA, and 999 comments or unknown groups sitting between the
          // counts or inside a segment's preamble — is preserved
          // byte-verbatim in its original position: the parse skips them
          // in place and still locates the derived values around them.
          // There is NO wholesale-rebuild fallback: if the derived
          // counts or any known segment's value run cannot be located at
          // all, the save refuses atomically with an 'unsupported table
          // data layout' error rather than replacing the whole body.
          // Re-review 3 (Codex P1; lead ruling) adds the run-boundary
          // rule: a non-derived group INSIDE a known segment's value run
          // (between its first and last value) splits the run — the tail
          // behind it would replay as stale values — so it too refuses
          // atomically, and an invariant pass over the rewritten body
          // requires every regenerated column's value count to equal the
          // declared cell count before the body is committed.
          {
            const unsupportedLayout = (): CadGraphError => new CadGraphError('dependency',
              `Cannot save: unsupported table data layout — the retained ACDBDATATABLE ${dataHandle} does not carry its derived counts and column segments in a recognizable shape, so its contents cannot be regenerated in place.`);
            const headEnd = dataRecord.groups.findIndex(([code]) => code === 70);
            if (headEnd < 0) throw unsupportedLayout();
            const body = dataRecord.groups.slice(headEnd);
            const out: CadGroup[] = [...dataRecord.groups.slice(0, headEnd), [70, '2']];
            let counts90 = false, counts91 = false, segmentsBegun = false, sawSegment = false, oneSegments = 0;
            let index = 1; // body[0] is the 70, already emitted (regenerated)
            while (index < body.length) {
              const group = body[index]!;
              if (group[0] === 92) {
                if (!counts90 || !counts91) throw unsupportedLayout();
                segmentsBegun = true;
                const type = Number(group[1]);
                const valueCode = type === 2 ? 40 : type === 1 ? 93 : type === 6 ? 360 : undefined;
                const slot = type === 2 ? 'sums' : type === 6 ? 'handles' : type === 1 && oneSegments === 0 ? 'flags' : type === 1 && oneSegments === 1 ? 'zeros' : undefined;
                if (type === 1) oneSegments += 1;
                out.push(group);
                index += 1;
                if (slot === undefined || valueCode === undefined) continue; // unrecognized segment: its groups pass through verbatim below
                sawSegment = true;
                // Segment preamble (the name group and any tolerated
                // unknowns, e.g. a 999 between the header and its name or
                // run) is preserved verbatim in place; then the old value
                // run is located and replaced by the regenerated one.
                while (index < body.length && body[index]![0] !== valueCode && body[index]![0] !== 92) { out.push(body[index]!); index += 1; }
                while (index < body.length && body[index]![0] === valueCode) index += 1;
                // Re-review 3 rule 1 (Codex P1; lead ruling): the run just
                // consumed must be the column's WHOLE run. If another value
                // of this column appears later in the same segment (before
                // the next 92), a non-derived group (a 999 comment, an
                // unknown group) sits INSIDE the run — between its first and
                // last value — and the tail behind it would be replayed as
                // stale values behind the regenerated ones (23 values
                // against a declared 91 of 12). No clever parsing: refuse
                // the save atomically. Groups outside the runs — before the
                // first value (the preamble above), after the last value,
                // between whole columns — are not caught here and stay
                // preserved by the main loop.
                for (let scan = index; scan < body.length && body[scan]![0] !== 92; scan += 1) {
                  if (body[scan]![0] === valueCode) throw unsupportedLayout();
                }
                if (slot === 'sums') for (const cell of cells) out.push([40, String(tableCellContentSum(cell.content))]);
                else if (slot === 'handles') for (const handle of cellHandles) out.push([360, handle]);
                else if (slot === 'flags') for (const cell of cells) out.push([93, cell.alignmentOverride ? '1' : '0']);
                else for (let at = 0; at < cells.length; at += 1) out.push([93, '0']);
                continue;
              }
              if (!segmentsBegun && !counts90 && group[0] === 90) { out.push([90, '4']); counts90 = true; index += 1; continue; }
              if (!segmentsBegun && !counts91 && group[0] === 91) { out.push([91, String(cells.length)]); counts91 = true; index += 1; continue; }
              out.push(group);
              index += 1;
            }
            if (!counts90 || !counts91 || !sawSegment) throw unsupportedLayout();
            // Re-review 3 rule 2 (lead ruling): belt-and-braces invariant
            // on the rewritten body, checked before it is committed — every
            // regenerated column carries exactly the declared cell count
            // (the 91 emitted above, derived from the model). The walk
            // mirrors the segment/slot logic of the rewrite itself; any
            // mismatch refuses the save atomically with the same error
            // rather than writing a column whose value count disagrees
            // with its own declared counts.
            {
              let expected: number | undefined;
              let seen = 0, oneCount = 0;
              const checkColumn = () => { if (expected !== undefined && seen !== cells.length) throw unsupportedLayout(); };
              for (const group of out.slice(headEnd)) {
                const code = group[0];
                if (code === 92) {
                  checkColumn();
                  const type = Number(group[1]);
                  expected = type === 2 ? 40 : type === 6 ? 360 : type === 1 && oneCount < 2 ? 93 : undefined;
                  if (type === 1) oneCount += 1;
                  seen = 0;
                  continue;
                }
                if (expected !== undefined && code === expected) seen += 1;
              }
              checkColumn();
            }
            dataRecord.groups = out;
          }
          // Each CELL_VALUE record keeps its identity head (through its 280
          // group) and gains regenerated value groups (re-review rule 1),
          // parsed tolerantly (re-review 2 rule 2): the tail is walked
          // once — the regenerated value groups are emitted as one block
          // at the first derived group, old derived groups are dropped
          // wherever they occur before the suffix (never replayed),
          // unknown groups inside the derived region (a 999 comment, an
          // unrecognized code) are kept byte-verbatim in their relative
          // order, and everything from the first XDATA group (1001...) on
          // is the preserved suffix, byte-verbatim. New cells get a new
          // record on an allocated handle; surplus records are resolved
          // after the loop (re-review rule 2).
          const DERIVED_VALUE_CODES = new Set([93, 90, 1, 2, 3, 94, 300, 302, 303, 304]);
          cells.forEach((cell, index) => {
            const valueGroups = tableRoundtripCellValueGroups(cell) as CadGroup[];
            const existing = byHandle.get(cellHandles[index]!);
            if (existing && existing.type === 'XRECORD') {
              const cut = existing.groups.findIndex(([code]) => code === 280);
              const head = cut >= 0 ? existing.groups.slice(0, cut + 1) : existing.groups.slice();
              const tail = cut >= 0 ? existing.groups.slice(cut + 1) : [];
              const out: CadGroup[] = [...head];
              let emitted = false, at = 0;
              while (at < tail.length && tail[at]![0] < 1000) {
                const group = tail[at]!;
                if (DERIVED_VALUE_CODES.has(group[0])) {
                  if (!emitted) { out.push(...valueGroups); emitted = true; }
                } else out.push(group);
                at += 1;
              }
              if (!emitted) out.push(...valueGroups);
              for (; at < tail.length; at += 1) out.push(tail[at]!);
              existing.groups = out;
            } else {
              const record: RecordData = {
                type: 'XRECORD', section: 'OBJECTS', handle: cellHandles[index]!,
                groups: [[5, cellHandles[index]!], [330, dataHandle!], [100, 'AcDbXrecord'], [280, '1'], ...valueGroups],
              };
              generated.push(record);
              byHandle.set(cellHandles[index]!, record);
            }
          });
          for (let index = cells.length; index < retainedHandles.length; index++) {
            const record = byHandle.get(retainedHandles[index]!);
            if (record && record.type === 'XRECORD') surplus.add(record);
          }
        }
        console.error('DBG surplus size', surplus.size);
      if (surplus.size) {
          // Re-review rule 2: a surplus record still referenced by any
          // surviving record is KEPT as-is — detached from the chain (the
          // regenerated datatable no longer lists its handle) so no
          // pointer dangles; only proven-unreferenced records are
          // deleted. The scan covers every record in the merged set at
          // this point (retained records as replayed + model-writer
          // records + the regenerated chains; the bounded dictionary /
          // scale insertions below never reference table chains), reading
          // every group whose code HANDLE_REFERENCE_CODES carries — the
          // cadReferenceKind-derived set (re-review 2 rule 1) — with
          // values canonicalized as handles. References from other
          // surplus candidates count only once the candidate is itself
          // kept (fixpoint), so a surplus-to-surplus reference cannot
          // resurrect a record no survivor points at.
          const REFERENCE_SCAN_CODES = HANDLE_REFERENCE_CODES;
          const kept = new Set<RecordData>();
          let progressed = true;
          while (progressed) {
            progressed = false;
            const referenced = new Set<string>();
            for (const record of generated) {
              if (surplus.has(record) && !kept.has(record)) continue;
              for (const [code, raw] of record.groups) if (REFERENCE_SCAN_CODES.has(code)) { const handle = canon(raw); if (handle) referenced.add(handle); }
            }
            for (const candidate of surplus) {
              if (kept.has(candidate)) continue;
              const handle = canon(value(candidate, 5));
              if (handle && referenced.has(handle)) { kept.add(candidate); progressed = true; }
            }
          }
          for (let index = generated.length - 1; index >= 0; index--) if (surplus.has(generated[index]!) && !kept.has(generated[index]!)) generated.splice(index, 1);
        }
      }
    }
  }
  // Q11 F2 rework (design U4, insertion branch): a recognized variable the editor
  // set but the retained variable dictionary does not carry is inserted into that
  // dictionary — entry appended to the retained dictionary record plus a
  // specimen-shaped DICTIONARYVAR record on a handle from the same allocator — so
  // the value is never silently dropped on a re-save. When the graph carries no
  // variable dictionary at all, the model writer has already created one; when it
  // carries the variable, only the refresh below applies.
  // The pass over the generated records only runs when a setting exists at all:
  // with neither header field set, `wanted` below is empty by construction.
  if (state.header?.cannoscale !== undefined || state.header?.annoAllVisible !== undefined) {
    const carried = annotationVariables(generated);
    const wanted: Array<readonly [string, string]> = [];
    if (state.header?.cannoscale !== undefined && isScaleName(state.header.cannoscale) && !carried.has('CANNOSCALE')) wanted.push(['CANNOSCALE', state.header.cannoscale]);
    if (state.header?.annoAllVisible !== undefined && !carried.has('ANNOALLVISIBLE')) wanted.push(['ANNOALLVISIBLE', state.header.annoAllVisible ? '1' : '0']);
    if (wanted.length) {
      const indexed = generated.map(record => {
        const raw = record.type === 'HEADER' || record.type === 'CLASS' ? '' : value(record, record.type === 'DIMSTYLE' ? 105 : 5);
        return { ...record, ...(raw ? { handle: canonicalCadHandle(raw) } : {}) };
      });
      const paths = dictionaryPaths(indexed);
      const at = indexed.findIndex(record => record.handle && dictionaries.has(record.type)
        && paths.get(record.handle)?.length === 1 && paths.get(record.handle)?.[0] === 'AcDbVariableDictionary');
      if (at >= 0) {
        const dictionary = generated[at]!, dictionaryHandle = indexed[at]!.handle!;
        for (const [name, current] of wanted) {
          const handle = allocate();
          dictionary.groups.push([3, name], [350, handle]);
          generated.push({ type: 'DICTIONARYVAR', section: 'OBJECTS', handle, groups: [[5, handle], [102, '{ACAD_REACTORS'], [330, dictionaryHandle], [102, '}'], [330, dictionaryHandle], [100, 'DictionaryVariables'], [280, '0'], [1, current]] });
        }
      }
    }
  }
  // Q11 F2 round 2 (Item 1): AutoCAD resolves CANNOSCALE to 1:1 when the drawing
  // carries no ACAD_SCALELIST entry for the named scale (the F2 gate verified
  // AutoCAD reads 1:4 where the entry exists — N1 AC1032, Q10 AC1015), so a merged
  // write whose graph lacks the entry for the current annotation scale gains it
  // here — the graph-side counterpart of the model writer's creation, which runs
  // only when the graph carries neither a variable dictionary nor a scale list.
  // Handles come from the merge-time allocator (after ENTITIES), exactly like the
  // variable insertion above. An existing entry is left untouched, so a second
  // write changes nothing. Plain 'N:M' names only: other names invent no ratio.
  if (state.header?.cannoscale !== undefined && isScaleName(state.header.cannoscale)) {
    const ratio = annotationScaleRatio(state.header.cannoscale);
    if (ratio) {
      const indexed = generated.map(record => {
        const handle = value(record, 5);
        return handle && record.type !== 'HEADER' ? { ...record, handle: canonicalCadHandle(handle) } : record;
      });
      const list = scaleListOf(indexed);
      if (list && !list.entries.has(state.header.cannoscale)) {
        const scaleRecord = (handle: string, dictionaryHandle: string): RecordData => ({
          type: 'SCALE', section: 'OBJECTS', handle,
          groups: [[5, handle], [102, '{ACAD_REACTORS'], [330, dictionaryHandle], [102, '}'], [330, dictionaryHandle], [100, 'AcDbScale'], [70, '0'], [300, state.header!.cannoscale!], [140, ratio.numerator], [141, ratio.denominator], [290, ratio.unit ? '1' : '0']],
        });
        if (list.dictionary) {
          const scaleHandle = allocate(), dictionaryHandle = list.dictionary.handle!;
          const used = new Set([...list.keys].map(key => key.toUpperCase()));
          let key = '';
          for (let index = 0; ; index++) {
            const candidate = index < 260 ? `${String.fromCharCode(65 + Math.floor(index / 10))}${index % 10}` : `S${index}`;
            if (!used.has(candidate.toUpperCase())) { key = candidate; break; }
          }
          generated[indexed.indexOf(list.dictionary)]!.groups.push([3, key], [350, scaleHandle]);
          generated.push(scaleRecord(scaleHandle, dictionaryHandle));
        } else {
          const dictionaryHandle = allocate(), scaleHandle = allocate();
          generated[indexed.indexOf(list.root)]!.groups.push([3, 'ACAD_SCALELIST'], [350, dictionaryHandle]);
          generated.push({ type: 'DICTIONARY', section: 'OBJECTS', handle: dictionaryHandle, groups: [[5, dictionaryHandle], [330, list.root.handle!], [100, 'AcDbDictionary'], [281, '1'], [3, 'A0'], [350, scaleHandle]] });
          generated.push(scaleRecord(scaleHandle, dictionaryHandle));
        }
        if (!generated.some(record => record.type === 'CLASS' && identifierValue(record, 1).toUpperCase() === 'SCALE')) {
          const header = generated.find(record => record.type === 'HEADER');
          const versionAt = header?.groups.findIndex(([code, name]) => code === 9 && name.trim() === '$ACADVER') ?? -1;
          const version = versionAt >= 0 ? header!.groups[versionAt + 1]?.[1].trim() : undefined;
          generated.push({ type: 'CLASS', section: 'CLASSES', groups: [[1, 'SCALE'], [2, 'AcDbScale'], [3, 'ObjectDBX Classes'], [90, '1153'], ...(version !== 'AC1015' ? [[91, '1'] as CadGroup] : []), [280, '0'], [281, '0']] });
        }
      }
    }
  }
  // Current semantic values replace only the corresponding recognized dictionary value.
  // Ownership, reactors, unknown variables and every other raw group remain intact.
  // P18 FIX group 1 (native gate 340): every context object the model writer
  // emitted must carry group 340 -> a SCALE object, or AutoCAD discards the
  // drawing. The writer resolves retained scales and its own scale list
  // itself; what remains unresolved here is an authored scale beside a
  // RETAINED scale list (or no list at all): create the SCALE in the final
  // list — the cannoscale pass's shapes and allocator — and insert the 340
  // ahead of the object's header group 40. Retained context objects of
  // chains the writer does not model are kept verbatim and never touched;
  // objects a carried chain regenerated (group 2) join the same completion.
  let contextScaleEnsured = false;
  {
    const pending = generated.filter(record => record.type === 'ACDB_MLEADEROBJECTCONTEXTDATA_CLASS' && (writerGenerated.has(record) || contextRegenerated.has(record)));
    const targets = pending.flatMap(record => {
      const annotAt = record.groups.findIndex(([code, raw]) => code === 100 && raw.trim() === 'AcDbAnnotScaleObjectContextData');
      if (annotAt < 0 || record.groups[annotAt + 1]?.[0] === 340) return [];
      const at40 = record.groups.findIndex((group, index) => index > annotAt && group[0] === 40);
      if (at40 < 0) return [];
      const factor = Number(record.groups[at40]![1]);
      if (!Number.isFinite(factor) || factor <= 0) return [];
      return [{ record, at40, name: formatScale(1 / factor) }];
    });
    if (targets.length) {
      const indexed = generated.map(record => {
        const handle = value(record, 5);
        return handle && record.type !== 'HEADER' ? { ...record, handle: canonicalCadHandle(handle) } : record;
      });
      const list = scaleListOf(indexed);
      if (list) {
        const created = new Map<string, string>();
        const createdKeys: string[] = [];
        // The generated-array element of the scale-list dictionary: the
        // retained one when a list exists, the one created below otherwise
        // (a created dictionary is not in `indexed`, so it is tracked by
        // identity from here on).
        let dictionaryRecord: RecordData | undefined = list.dictionary ? generated[indexed.indexOf(list.dictionary)] : undefined;
        let dictionaryHandle: string | undefined = list.dictionary?.handle;
        const handleFor = (name: string): string | undefined => {
          const existing = list.entries.get(name)?.handle ?? created.get(name);
          if (existing) return existing;
          const ratio = annotationScaleRatio(name);
          if (!ratio) return undefined;
          const scaleRecord = (handle: string, ownerHandle: string): RecordData => ({
            type: 'SCALE', section: 'OBJECTS', handle,
            groups: [[5, handle], [102, '{ACAD_REACTORS'], [330, ownerHandle], [102, '}'], [330, ownerHandle], [100, 'AcDbScale'], [70, '0'], [300, name], [140, ratio.numerator], [141, ratio.denominator], [290, ratio.unit ? '1' : '0']],
          });
          let scaleHandle: string;
          if (dictionaryRecord && dictionaryHandle) {
            scaleHandle = allocate();
            const used = new Set([...list.keys, ...createdKeys].map(key => key.toUpperCase()));
            let key = '';
            for (let index = 0; ; index++) {
              const candidate = index < 260 ? `${String.fromCharCode(65 + Math.floor(index / 10))}${index % 10}` : `S${index}`;
              if (!used.has(candidate.toUpperCase())) { key = candidate; break; }
            }
            createdKeys.push(key);
            dictionaryRecord.groups.push([3, key], [350, scaleHandle]);
            generated.push(scaleRecord(scaleHandle, dictionaryHandle));
          } else {
            dictionaryHandle = allocate();
            scaleHandle = allocate();
            generated[indexed.indexOf(list.root)]!.groups.push([3, 'ACAD_SCALELIST'], [350, dictionaryHandle]);
            dictionaryRecord = { type: 'DICTIONARY', section: 'OBJECTS', handle: dictionaryHandle, groups: [[5, dictionaryHandle], [330, list.root.handle!], [100, 'AcDbDictionary'], [281, '1'], [3, 'A0'], [350, scaleHandle]] };
            createdKeys.push('A0');
            generated.push(dictionaryRecord);
            generated.push(scaleRecord(scaleHandle, dictionaryHandle));
          }
          if (!generated.some(record => record.type === 'CLASS' && identifierValue(record, 1).toUpperCase() === 'SCALE')) {
            const header = generated.find(record => record.type === 'HEADER');
            const versionAt = header?.groups.findIndex(([code, varName]) => code === 9 && varName.trim() === '$ACADVER') ?? -1;
            const version = versionAt >= 0 ? header!.groups[versionAt + 1]?.[1].trim() : undefined;
            generated.push({ type: 'CLASS', section: 'CLASSES', groups: [[1, 'SCALE'], [2, 'AcDbScale'], [3, 'ObjectDBX Classes'], [90, '1153'], ...(version !== 'AC1015' ? [[91, '1'] as CadGroup] : []), [280, '0'], [281, '0']] });
          }
          created.set(name, scaleHandle);
          return scaleHandle;
        };
        for (const target of targets) {
          const handle = handleFor(target.name);
          if (!handle) continue;
          target.record.groups.splice(target.at40, 0, [340, handle]);
          contextScaleEnsured = true;
        }
      }
    }
  }
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
  // P22 PR #39 re-review rule 3: when a roundtrip chain was regenerated,
  // the FINAL reference set must be closed before anything is emitted —
  // every target of every reference code in HANDLE_REFERENCE_CODES (the
  // cadReferenceKind-derived set, re-review 2 rule 1 — the same source of
  // truth as the keep-scan above) in the merged output is defined by
  // some record's group 5 (or 105), the DXF null handle '0' excepted. A
  // dangle fails the save here, atomically: no output is produced.
  if (roundtripRegenerated || contextScaleEnsured || contextChainsRegenerated) {
    const canonHandle = (raw: string): string | undefined => /^[0-9A-Fa-f]{1,16}$/.test(raw.trim()) ? canonicalCadHandle(raw.trim()) : undefined;
    const defined = new Set<string>();
    for (const record of generated) for (const [code, raw] of record.groups) if (code === 5 || code === 105) { const handle = canonHandle(raw); if (handle) defined.add(handle); }
    const dangling = new Map<string, string>();
    for (const record of generated) for (const [code, raw] of record.groups) {
      if (!HANDLE_REFERENCE_CODES.has(code)) continue;
      const handle = canonHandle(raw);
      if (handle && handle !== '0' && !defined.has(handle)) dangling.set(handle, record.type);
    }
    if (dangling.size) throw new CadGraphError('dependency', `Cannot save: a regenerated chain leaves dangling handle reference(s) ${[...dangling].map(([handle, type]) => `${handle} (referenced from a ${type} record)`).join(', ')}.`);
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
