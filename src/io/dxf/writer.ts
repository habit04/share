/**
 * writeDxf: an AC1015 (AutoCAD 2000) DXF file from a drawing. Handles are allocated in file
 * order, so the sections are written in sequence: HEADER, CLASSES, TABLES, BLOCKS, ENTITIES and
 * OBJECTS (paper space comes from io/dxf-layouts.ts). Experimental 3D solids are polyface meshes at
 * the end of ENTITIES (io/dxf/mesh3d-write.ts), followed by true 3D dimensions as DIMENSIONs in
 * their planes (io/dxf/dim3d-write.ts, each with a *D picture block after the 2D dimensions'); a
 * drawing without them writes none of this.
 */
import type { DrawingState } from '../../core/document';
import type { Linetype } from '../../core/linetypes';
import type { Entity, DimensionEntity, Layer, AttributeAppearance } from '../../core/entities';
import { rawEntitiesOf, type ImportReportItem } from '../import-report';
import { findLinetype, patternLength, STANDARD_LINETYPES, complexLinetypeProblem, linetypeShapeStyleProblem } from '../../core/linetypes';
import { Writer, setPaperOwners, emptyExtras, writeTextLike, writeTextStyle, writeEntityCommon } from './write-core';
import { DEFAULT_HEADER } from '../../core/document';
import { planLayouts, extraBlockRecords, layoutHandleOf, writeLayoutContent, writeLayoutObjects } from '../dxf-layouts';
import { cannoscaleValue, formatScale, isScaleName } from '../../core/layouts';
import type { WriteExtras } from './write-core';
import * as g from '../../core/geometry';
import { dimHeaderVars, dimStylesToWrite, dimStyleXdata } from './dimstyles';
import { mleaderStyleData, STANDARD_MLEADER_STYLE, type MLeaderStyleData } from '../../core/multileader';
import { textStylesForWrite, textStyleOf, STANDARD_TEXT_STYLE, textStyleGroups, encodeDxfText, shapeStylesOf, shapeStyleGroups } from '../encoding';
import { writeComplexLinetypeElements } from './complex-linetypes';
import { DIMSTYLE_APP, TABLE_APP, DYNAMIC_APP, CONSTRAINTS_APP, ANNO_APP, MTEXT_COLUMNS_APP, MTEXT_BACKGROUND_APP, MODEL3D_APP } from './codes';
import { chunkDynamicPayload, encodeDynamicDefinition } from './dynamic-data';
import { encodeConstraints } from './constraints-data';
import { writeSolid } from './mesh3d-write';
import { writeDimension3D, writeDimension3DPicture } from './dim3d-write';
import { dimension3dTo2d } from '../../model3d/dimension3d';
import { writeRetainedSolid } from './model3d-carriers';
import type { CadNode } from '../../core/cad-graph';
import { dimStyleRecordPairs } from '../../core/dimension';
import { writeEntityAnno, writeEntity } from './write-entities';
import { tableStyleKey, tablePictureForm, tableRoundtripCells, writeTableRoundtrip, emitMLeaderContext, mleaderContextViews } from './write-annotations';
import { writeUnderlayDefinition, underlayDxfType, underlayDefinitionDxfType, underlayEntityClassName, underlayDefinitionClassName } from './underlay-codec';
import type { UnderlayDefinition, UnderlayKind } from '../../core/underlay';
import { attdefFlags } from '../../electrical/symbol-builder-core';
import { tableParts, dimensionParts } from '../../core/entities';
import { entityMTextBackground } from '../../core/mtext-background';
import { materializePolylineWidthFrames } from './polyline-width-blocks';
import { LAYER_TRANSPARENCY_APP, transparencyToDxf, validColorName } from '../../core/appearance';
import { namedCameraDisplayCenter, planarNamedCamera } from '../../core/named-view';
import { annotationScaleRatio, ensureAssociativeHatchReactors, graphAnnotationCarrier, graphAnnotationScaleEntries, graphMLeaderContextChainCarriers, graphTableRoundtripCarriers, preserveDxfCadGraph, type MLeaderContextChainCarrier } from '../cad-graph-dxf';
import { canonicalCadHandle } from '../../core/cad-graph';

/** Linetype names referenced anywhere in the drawing (layers, entities, block entities). */
function usedLinetypes(state: DrawingState): Linetype[] {
  const names = new Set<string>();
  for (const l of state.layers) if (l.linetype) names.add(l.linetype.toUpperCase());
  const scan = (list: readonly Entity[]) => {
    for (const e of list) if (e.linetype) names.add(e.linetype.toUpperCase());
  };
  scan(state.entities);
  for (const b of Object.values(state.blocks)) scan(b.entities);
  for (const l of state.layouts ?? []) {
    scan(l.entities);
    for (const v of l.viewports) if (v.clipBoundary) scan([v.clipBoundary]);
  }
  // Retained raw records name their linetype in group 6: it must exist in the LTYPE table.
  for (const r of rawEntitiesOf(state)) for (const [code, value] of r.groups) if (code === 6 && value.trim()) names.add(value.trim().toUpperCase());
  const extra = state.header?.linetypes ?? [];
  const out: Linetype[] = [];
  for (const lt of extra) out.push(lt);
  for (const n of names) {
    if (n === 'BYLAYER' || n === 'BYBLOCK' || n === 'CONTINUOUS') continue;
    if (out.some((l) => l.name.toUpperCase() === n)) continue;
    const std = findLinetype(n);
    out.push(std ?? { name: n, description: '', pattern: [] });
  }
  return out;
}

/**
 * Content key for a dimension's generated picture (Q11 F1): the canonical serialization of
 * the parts exactly as the *D block writer emits them (including its ByLayer -> 0 color
 * mapping), with identity fields removed (part ids embed the owning dimension's id) and
 * numbers at write precision (write-core fmt rounds to 10 decimals). Equal keys therefore
 * mean byte-identical picture bodies; unequal keys can still render alike only through
 * fields the writer never emits, never the reverse.
 */
function dimensionPictureKey(d: DimensionEntity): string {
  const canonical = (value: unknown): unknown => {
    if (typeof value === 'number') return Number.isFinite(value) ? Number(value.toFixed(10)) : 0;
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        if (key === 'id' || key === 'cadIdentity') continue;
        out[key] = canonical((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(dimensionParts(d).map((part) => canonical({ ...part, color: part.color === 'ByLayer' ? 0 : part.color })));
}

/**
 * P18 S3-D: the graph copy handed to the cad-graph merge for MODELLED
 * multi-context multileaders.
 *
 * Why this exists: the merge retains every source OBJECTS record the writer
 * does not regenerate through an anchor or a root-dictionary path key — and
 * an entity's extension-dictionary chain is reachable by neither (it hangs
 * off the entity record, not the named-objects root). P18 FIX group 2 split
 * the custody: a chain the graph carries (graphMLeaderContextChainCarriers)
 * stays IN the graph and preserveDxfCadGraph regenerates its records in
 * place — the writer emits only the entity (whose extension subgroup this
 * function strips from the source node, Amendment 2 (v)) and any growth
 * objects — while a WITHHELD chain (P18 FIX group 1: no SCALE can be
 * referenced for one of its scales) is dropped whole, so nothing of it can
 * be resurrected by retention. A chain whose shape does not resolve exactly
 * as RULING-P18-S3-D (1)(ii) pins it has no carrier and is left fully
 * retained beside the writer's fresh chain, as before. The state's graph
 * is COPIED, never mutated; with no modelled chain the input state is
 * returned as-is.
 */
function graphWithoutModelledContextChains(state: DrawingState, w: Writer, entities: readonly Entity[]): DrawingState {
  const graph = state.cadGraph;
  if (!graph) return state;
  const chained = new Set(entities.filter((e) => w.mleaderContextChains.has(e) || w.mleaderChainsWithheld.has(e)).map((e) => e.id));
  // P18 FIX group 2: the chain resolution is the ONE walk in cad-graph-dxf
  // (graphMLeaderContextChainCarriers). A CARRIED chain's nodes are NOT
  // dropped — preserveDxfCadGraph regenerates them in place, so XDATA,
  // unrecognized groups and unrelated dictionary keys survive and references
  // into the chain stay valid. Only a WITHHELD chain (group 1) still drops
  // its nodes wholesale: nothing of it may reach the output.
  const carriers = graphMLeaderContextChainCarriers(state);
  const entityById = new Map(entities.map((e) => [e.id, e] as const));
  const drop = new Set<string>();
  const stripped = new Map<string, CadNode>();
  for (const node of graph.nodes) {
    // Only entities the writer itself emits a chain for (W-ALLOC-18 WeakMap).
    if (node.anchor?.kind !== 'entity' || !chained.has(node.anchor.id)) continue;
    const carrier = carriers.get(node.anchor.id);
    if (!carrier) continue;
    let at = -1;
    for (let i = 0; i + 1 < node.groups.length; i += 1) {
      if (node.groups[i]![0] === 102 && node.groups[i]![1].includes('ACAD_XDICTIONARY') && node.groups[i + 1]![0] === 360) {
        at = i;
        break;
      }
    }
    if (at < 0) continue;
    const entity = entityById.get(node.anchor.id);
    const carried = entity ? w.mleaderContextChains.get(entity)?.carried === true : false;
    if (!carried) {
      for (const n of [carrier.extension, carrier.manager, carrier.scales, ...carrier.objects]) drop.add(n.id);
    }
    // The entity node's own extension subgroup is writer-generated now too
    // (Amendment 2 (v)); strip the source copy (and reindex its references)
    // so the merge has no stale subgroup metadata to splice back in.
    const groups = node.groups.filter((_, i) => i < at || i > at + 2);
    const references = (node.references ?? []).flatMap((ref) =>
      ref.groupIndex >= at && ref.groupIndex <= at + 2 ? [] : [{ ...ref, groupIndex: ref.groupIndex > at + 2 ? ref.groupIndex - 3 : ref.groupIndex }],
    );
    stripped.set(node.id, { ...node, groups, ...(node.references ? { references } : {}) });
  }
  if (!drop.size && !stripped.size) return state;
  return { ...state, cadGraph: { ...graph, nodes: graph.nodes.filter((n) => !drop.has(n.id)).map((n) => stripped.get(n.id) ?? n) } };
}

/**
 * The handles the generated stream carries as FIXED structural records on
 * every write, independent of the drawing — never handed out by the
 * allocator (which starts at 101): the symbol-table records from the
 * `table(...)` calls in writeDxf (BLOCK_RECORD 1, LAYER 2, STYLE 3,
 * LTYPE 5, VIEW 6, UCS 7, VPORT 8, APPID 9, DIMSTYLE A), the
 * *Model_Space / *Paper_Space BLOCK_RECORDs (1F / 1B) and the OBJECTS
 * root + ACAD_GROUP dictionaries (C / D). A new fixed structural record
 * added to the skeleton must be added here too (P17 round 3).
 */
const FIXED_STRUCTURAL_HANDLES: ReadonlySet<string> = new Set([
  '1', '2', '3', '5', '6', '7', '8', '9', 'A', 'C', 'D', '1B', '1F',
]);

/**
 * P17 round 3: the merge-side half of the anchor handle remap — the
 * retained records of remapped anchors carry the fresh handle as their
 * sourceHandle in the state preserveDxfCadGraph sees, so the merge
 * emits them under it (its nodeHandles value) and every graph-internal
 * reference, which resolves by node id through nodeHandles, follows.
 */
function withAnchorHandleRemap(state: DrawingState, remap: ReadonlyMap<string, string>): DrawingState {
  if (!state.cadGraph) return state;
  return {
    ...state,
    cadGraph: {
      ...state.cadGraph,
      nodes: state.cadGraph.nodes.map((node) => {
        const handle = remap.get(node.id);
        return handle ? { ...node, sourceHandle: handle } : node;
      }),
    },
  };
}

/**
 * Write the drawing as DXF text. The optional export-report sink receives
 * the losses a save itself decides (P18 FIX group 1: an annotative context
 * chain withheld because no SCALE object can be referenced for one of its
 * source scales) in the import report's item shape; no caller is required
 * to pass one, and the write is identical either way.
 */
export function writeDxf(state: DrawingState, exportReport?: { add(item: ImportReportItem): void }): string {
  state = materializePolylineWidthFrames(state);
  const w = new Writer();
  // P17 round 2: a hatch loop's retained handle that names a retained
  // graph anchor (REGION / BODY / …) is written as the anchor's canonical
  // source handle — a RAW retained handle inside the generated stream,
  // the same cross-space reference shape as P18's group-340 scale
  // handles: preserveDxfCadGraph's generated-record rewrite would
  // mistake it for a writer handle if the writer allocated the same
  // value, so every anchor handle a hatch actually names is withheld
  // from the writer's allocator before the first allocation.
  const anchorAvoid = new Set<string>();
  const named = new Set<string>();
  if (state.cadGraph) {
    const scanHatches = (list: readonly Entity[]): void => {
      for (const e of list) {
        if (e.type !== 'hatch') continue;
        for (const l of e.loops) {
          for (const raw of l.boundaryHandles ?? []) {
            try { named.add(canonicalCadHandle(raw)); } catch { /* not a handle spelling: never a key */ }
          }
        }
      }
    };
    scanHatches(state.entities);
    for (const b of Object.values(state.blocks)) scanHatches(b.entities);
    for (const l of state.layouts ?? []) scanHatches(l.entities);
    if (named.size > 0) {
      for (const node of state.cadGraph.nodes) {
        if (!node.sourceHandle || node.section !== 'ENTITIES' || node.anchor?.kind === 'entity') continue;
        try {
          const canon = canonicalCadHandle(node.sourceHandle);
          if (named.has(canon)) anchorAvoid.add(canon);
        } catch { /* not a handle spelling: never a key */ }
      }
    }
  }
  // P18 FIX group 1: when any multileader carries annotative contexts, the
  // writer's allocator must never hand out a retained SCALE handle — the
  // context objects' group 340 names those scales by their source handles,
  // and preserveDxfCadGraph's rewrite of generated records would remap the
  // value if a generated record carried the same handle. P18 FIX group 2
  // adds the carried chains' own retained handles (P18 FIX group 2): a
  // carried chain is referenced by retained handle from the entity's
  // extension subgroup and from its growth objects alike.
  let mleaderCarriers: ReadonlyMap<string, MLeaderContextChainCarrier> = new Map();
  if (state.cadGraph
    && [...state.entities, ...Object.values(state.blocks).flatMap((b) => b.entities)]
      .some((e) => e.type === 'leader' && e.kind === 'mleader' && e.mleader?.contexts?.length)) {
    mleaderCarriers = graphMLeaderContextChainCarriers(state);
    const avoid = new Set(graphAnnotationScaleEntries(state).values());
    for (const carrier of mleaderCarriers.values()) {
      for (const node of [carrier.extension, carrier.manager, carrier.scales, ...carrier.objects]) {
        if (node.sourceHandle) avoid.add(canonicalCadHandle(node.sourceHandle));
      }
    }
    w.avoidHandles = avoid;
  }
  if (anchorAvoid.size > 0) w.avoidHandles = new Set([...w.avoidHandles, ...anchorAvoid]);
  // P17 round 3 (Codex PR #48 P1): a hatch-named anchor whose canonical
  // source handle collides with a FIXED structural handle
  // (FIXED_STRUCTURAL_HANDLES) cannot be protected by anchorAvoid: the
  // structural record is emitted under that handle regardless of the
  // allocator, so it enters preserveDxfCadGraph's generated-reference
  // rewrite map and the hatch's raw 330 would resolve to the dictionary
  // / block record instead of the boundary — and the retained record
  // itself would duplicate the structural handle in the output. Remap
  // such anchors BEFORE the rewrite map exists: each takes a fresh
  // writer handle here (allocated after both avoid sets are installed,
  // and skipped against every graph source handle and generated-handle
  // hint, so the merge's own allocator can never hand it out either —
  // the merge-side state carries the remap as the node's sourceHandle,
  // which puts it in the merge's reserved set). anchorBySourceHandle
  // below names the fresh handle for the hatch; the retained record is
  // emitted under it. First node wins per handle, matching the anchor
  // map's own first-wins posture.
  const anchorRemapByNode = new Map<string, string>();
  const anchorRemapByHandle = new Map<string, string>();
  if (state.cadGraph && named.size > 0) {
    const taken = new Set<string>(FIXED_STRUCTURAL_HANDLES);
    for (const node of state.cadGraph.nodes) {
      if (!node.sourceHandle) continue;
      try { taken.add(canonicalCadHandle(node.sourceHandle)); } catch { /* not a handle spelling: never a key */ }
    }
    for (const hint of state.cadGraph.generatedHandles ?? []) {
      try { taken.add(canonicalCadHandle(hint.handle)); } catch { /* not a handle spelling: never a key */ }
    }
    for (const node of state.cadGraph.nodes) {
      if (!node.sourceHandle || node.section !== 'ENTITIES' || node.anchor?.kind === 'entity') continue;
      let canon: string;
      try { canon = canonicalCadHandle(node.sourceHandle); } catch { continue; }
      if (!named.has(canon) || !FIXED_STRUCTURAL_HANDLES.has(canon)) continue;
      let fresh = w.nextHandle();
      while (taken.has(fresh)) fresh = w.nextHandle();
      taken.add(fresh);
      anchorRemapByNode.set(node.id, fresh);
      if (!anchorRemapByHandle.has(canon)) anchorRemapByHandle.set(canon, fresh);
    }
  }
  // ACAD_PLOTSTYLENAME: the dictionary layers point at (390) and its "Normal" entry (AutoCAD's
  // AUDIT reports layers whose plot style handle names no object).
  const plotStyleDictionary = w.nextHandle();
  const normalPlotStyle = w.nextHandle();
  // Q11 F2 rework: the annotation settings (cannoscale / annoAllVisible) are not HEADER
  // variables in AutoCAD — they live as DICTIONARYVARs in the AcDbVariableDictionary, at
  // every DXF version. Emit only what is set (CANNOSCALE when a valid scale name is set;
  // ANNOALLVISIBLE only when false, as '0' — at the default AutoCAD omits both
  // everywhere), and create the dictionary only when the retained graph carries none:
  // when it carries one, the graph path refreshes/inserts the values and a second
  // dictionary must never appear. (A carried variable implies a carried dictionary —
  // the dictionary path is how annotationVariables finds it.)
  // With neither setting present, creation is impossible whatever the graph carries,
  // so the carrier consult (a full graph pass) is skipped entirely.
  const annotationSettingPresent = state.header?.cannoscale !== undefined || state.header?.annoAllVisible !== undefined;
  const annotationCarrier = annotationSettingPresent ? graphAnnotationCarrier(state) : { variables: new Set<string>(), dictionary: false, scaleList: { dictionary: false, names: new Set<string>() } };
  const createCannoVariable = !annotationCarrier.dictionary && state.header?.cannoscale !== undefined && isScaleName(state.header.cannoscale);
  const createAnnoVariable = !annotationCarrier.dictionary && state.header?.annoAllVisible === false;
  // F2 round 2 (Item 1): AutoCAD resolves CANNOSCALE to 1:1 when the drawing has no
  // ACAD_SCALELIST entry for the named scale (the F2 gate verified AutoCAD reads
  // 1:4 where the entry exists — N1 AC1032, Q10 AC1015), so a write that creates
  // the variable dictionary for a drawing whose graph carries no scale list at
  // all also creates the list, holding ONLY the entry for the current scale. When
  // the graph carries a scale list (or the variable dictionary) but lacks the
  // entry, preserveDxfCadGraph adds it there instead. Only plain 'N:M' scale
  // names produce an entry — the ratio is parsed from the name; other names
  // invent no geometry and get no entry (the dictionary variable still writes).
  const scaleRatio = state.header?.cannoscale !== undefined ? annotationScaleRatio(state.header.cannoscale) : null;
  const createScaleList = createCannoVariable && scaleRatio !== null && !annotationCarrier.scaleList.dictionary;
  // The handles are allocated in the OBJECTS section, NOT here (deviation from the
  // design's plan-time allocation, found in validation): allocating them here shifts
  // every later handle in the file, and on drawings with retained 3D carriers a
  // shifted temporary handle can coincide with a retained SOURCE handle that
  // preserveDxfCadGraph's structuralKeys reads as an owner — the false owner edge
  // chains through the face records and the embedded slot keys grow exponentially
  // (heap OOM on tests/fixtures/3d/enclosure.dxf). Allocating last keeps every
  // other handle at its pre-rework value.
  let variableDictionary: string | null = null;
  let cannoVariable: string | null = null;
  let annoVariable: string | null = null;
  let scaleListDictionary: string | null = null;
  let scaleObject: string | null = null;
  const MODEL_SPACE = '1F';
  const PAPER_SPACE = '1B';
  const header = state.header ?? DEFAULT_HEADER;
  const ds = header.dimStyle;
  const blockList = Object.values(state.blocks);
  // Pre-assign a BLOCK_RECORD handle per block; block entities use it as their owner (330).
  const blockRecordHandles = new Map<string, string>();
  for (const b of blockList) blockRecordHandles.set(b.name, w.nextHandle());
  // Anonymous *D blocks that carry each dimension's picture. Dimensions whose generated
  // pictures are identical share one block, named in first-appearance order (Q11 F1):
  // AutoCAD shares *D graphics across a drawing's records, and one block per distinct
  // content is the reproducible part of that behavior (AutoCAD's own count also depends
  // on its evaluation history, so it is not the target).
  const dimBlocks = new Map<string, string>();
  const dimPictures: Array<{ name: string; dimension: DimensionEntity }> = [];
  const layoutPlan = planLayouts(state, w, PAPER_SPACE);
  setPaperOwners(layoutPlan.paperOwners);
  // Dimensions inside block definitions get their picture block too (a DIMENSION naming no block
  // is invalid).
  const dimEntities = [...state.entities, ...layoutPlan.entities, ...blockList.flatMap((b) => b.entities)].filter((e): e is DimensionEntity => e.type === 'dimension');
  const pictureByKey = new Map<string, string>();
  for (const d of dimEntities) {
    const key = dimensionPictureKey(d);
    let name = pictureByKey.get(key);
    if (name === undefined) {
      name = `*D${dimPictures.length + 1}`;
      pictureByKey.set(key, name);
      dimPictures.push({ name, dimension: d });
      blockRecordHandles.set(name, w.nextHandle());
    }
    dimBlocks.set(d.id, name);
  }
  // Experimental true 3D dimensions: a picture block each, numbered after the 2D dimensions'.
  const dims3d = state.model3d?.dimensions ?? [];
  const dim3dBlocks = new Map<string, string>();
  dims3d.forEach((d, i) => {
    const name = `*D${dimPictures.length + i + 1}`;
    dim3dBlocks.set(d.id, name);
    const handle = w.nextHandle();
    blockRecordHandles.set(name, handle);
    w.anchor(handle, { kind: 'dimension3d', id: d.id, part: 'picture-block' });
  });
  // Their 2D equivalents (plane coordinates) for the style tables (DIMSTYLE, STYLE).
  const dims3dAs2d = dims3d.map(dimension3dTo2d);
  const linetypes = usedLinetypes(state);
  // Images (IMAGEDEF + reactor per image) and tables (an anonymous block each) anywhere in the drawing.
  const extras: WriteExtras = { ...emptyExtras(), arrowSize: ds.arrowSize * (ds.scale || 1), ...(header.measurement !== undefined ? { measurement: header.measurement } : {}) };
  const allEntities: Entity[] = [...state.entities, ...layoutPlan.entities];
  for (const b of blockList) allEntities.push(...b.entities);
  // P17: hatch boundary refs resolve against everything this writer emits.
  extras.entityById = new Map(allEntities.map((e) => [e.id, e]));
  // P17 (Codex PR #44 P1-d): the same universe by canonical source handle,
  // so a hatch loop's retained raw handles (boundaryHandles) that name an
  // emitted entity resolve to it. cadIdentity is the bare source handle
  // or "<session>:<handle>"; both spellings are indexed. Duplicate source
  // handles resolve last-wins, the accepted O4 posture.
  const entityBySourceHandle = new Map<string, Entity>();
  for (const e of allEntities) {
    if (!e.cadIdentity) continue;
    const full = e.cadIdentity.trim().toUpperCase();
    const suffix = full.slice(full.lastIndexOf(':') + 1);
    for (const key of new Set([full, suffix])) {
      try {
        entityBySourceHandle.set(canonicalCadHandle(key), e);
      } catch {
        // Not a handle spelling (a session id, a node id): not a key.
      }
    }
  }
  // After a real import the entities carry no cadIdentity — their source
  // identity lives in the cad graph (node sourceHandle + entity anchor).
  // The graph is the authoritative spelling of the same source file the
  // retained handles came from, so its entries overwrite the ones above.
  // Round 7: the handles this join supplies (or overwrites) are recorded
  // apart — a retained hatch handle resolving only through the graph
  // names a link the reader already adjudicated non-live, and writeHatch
  // must not let it carry 71 = 1 on its own (the CANP5 divergence).
  const graphEntityHandles = new Set<string>();
  for (const node of state.cadGraph?.nodes ?? []) {
    if (node.anchor?.kind !== 'entity' || !node.sourceHandle) continue;
    const e = extras.entityById.get(node.anchor.id);
    if (!e) continue;
    try {
      const canon = canonicalCadHandle(node.sourceHandle);
      entityBySourceHandle.set(canon, e);
      graphEntityHandles.add(canon);
    } catch {
      // A node id, not a handle: not a key.
    }
  }
  extras.entityBySourceHandle = entityBySourceHandle;
  extras.graphEntityHandles = graphEntityHandles;
  // P17 round 2 (Codex P1): retained graph anchors — ENTITIES records
  // the merge still emits that are not entities (REGION / BODY / other
  // raw carriers) — resolve by canonical source handle, the handle
  // preserveDxfCadGraph emits the record under (its nodeHandles value);
  // round 3: that handle is the anchor's FRESH remap when its source
  // handle collides with a fixed structural handle (see the remap
  // above) — the merge-side state carries the same remap, so the value
  // named here is the handle the record is actually emitted under.
  // A hatch's retained handle naming one is a link like any other: it is
  // written with the anchor's handle and classified by the anchor's
  // owner, proven from the node's owner reference: no proven owner on an
  // ENTITIES record means model geometry (the merge emits it under the
  // model-space owner); the model-space BLOCK_RECORD is model space; a
  // named block definition's record is that block's writer record
  // handle; anything else (a layout's record, a non-record owner) is
  // unproven and carries no owner, classifying the link foreign-owned.
  // graphSourceHandles collects EVERY graph node's canonical source
  // handle: a retained hatch handle naming one that resolves to no
  // emitted entity or anchor refuses the save (see writeHatch).
  const graphSourceHandles = new Set<string>();
  const anchorBySourceHandle = new Map<string, { handle: string; owner?: string }>();
  // P17 round 5: retained raw HATCH records (never modelled as entities)
  // are collected apart: a hatch boundary handle naming one is a hatch
  // boundary and demotes the naming hatch; such records are NOT offered
  // as ordinary anchors. Modelled hatches resolve through
  // entityBySourceHandle first, so listing their handles here is inert.
  const hatchAnchorHandles = new Set<string>();
  if (state.cadGraph) {
    const nodeById = new Map(state.cadGraph.nodes.map((n) => [n.id, n]));
    const recordHandleByName = new Map(blockList.map((b) => [b.name.toUpperCase(), blockRecordHandles.get(b.name)!]));
    for (const node of state.cadGraph.nodes) {
      if (!node.sourceHandle) continue;
      let canon: string;
      try { canon = canonicalCadHandle(node.sourceHandle); } catch { continue; }
      graphSourceHandles.add(canon);
      if (node.type === 'HATCH') hatchAnchorHandles.add(canon);
      if (node.section !== 'ENTITIES' || node.anchor?.kind === 'entity' || anchorBySourceHandle.has(canon)) continue;
      let owner: string | undefined;
      const ownerTarget = node.references?.find((r) => r.role === 'owner')?.target;
      const ownerNode = ownerTarget !== undefined ? nodeById.get(ownerTarget) : undefined;
      if (ownerTarget === undefined) owner = MODEL_SPACE;
      else if (ownerNode && (ownerNode.type === 'BLOCK_RECORD' || ownerNode.type === 'BLOCK')) {
        const g2 = ownerNode.groups.find(([c]) => c === 2);
        const name = g2 ? g2[1].trim().toUpperCase() : undefined;
        if (name === '*MODEL_SPACE') owner = MODEL_SPACE;
        else if (name !== undefined) owner = recordHandleByName.get(name);
      }
      anchorBySourceHandle.set(canon, { handle: anchorRemapByHandle.get(canon) ?? canon, ...(owner !== undefined ? { owner } : {}) });
    }
  }
  extras.anchorBySourceHandle = anchorBySourceHandle;
  extras.hatchAnchorHandles = hatchAnchorHandles;
  extras.graphSourceHandles = graphSourceHandles;
  // P17 R1 (O5): the owner handle each entity is written under — model
  // space, a layout's block record, or a block definition's record — with
  // the same strings the write loops pass as `owner`, so writeHatch can
  // tell a same-owner (associative) link from a cross-owner one.
  const entityOwner = new Map<string, string>();
  for (const e of state.entities) entityOwner.set(e.id, MODEL_SPACE);
  for (const r of layoutPlan.records) {
    for (const e of r.layout.entities) entityOwner.set(e.id, r.blockRecord);
    for (const v of r.layout.viewports) if (v.clipBoundary) entityOwner.set(v.clipBoundary.id, r.blockRecord);
  }
  for (const b of blockList) {
    const record = blockRecordHandles.get(b.name);
    if (record !== undefined) for (const e of b.entities) entityOwner.set(e.id, record);
  }
  extras.entityOwner = entityOwner;
  // LTYPE340 points forward to STYLE. Reserve real target handles before writing LTYPE.
  const textStyles = textStylesForWrite(state), shapeStyles = Object.entries(shapeStylesOf(state));
  for (const lt of linetypes) {
    const problem = complexLinetypeProblem(lt);
    if (problem) throw new Error(`Cannot preserve complex linetype "${lt.name}": ${problem}.`);
    for (const element of lt.complex?.elements ?? []) {
      const reference = element.style;
      if (reference?.kind === 'text' && !textStyles.some((style) => style.name.toUpperCase() === reference.name.toUpperCase())) {
        throw new Error(`Cannot preserve complex linetype "${lt.name}": text STYLE "${reference.name}" is missing.`);
      }
    }
  }
  const requiredTextStyles = new Set([header.textStyle, ds.textStyle, ...allEntities.map((e) => e.type === 'dimension' ? e.style.textStyle : textStyleOf(e)), ...dims3dAs2d.map(d => d.style.textStyle)].filter((n): n is string => !!n));
  for (const name of requiredTextStyles) if (!textStyles.some((style) => style.name.toUpperCase() === name.toUpperCase())) textStyles.push({ ...STANDARD_TEXT_STYLE, name });
  for (const style of textStyles) w.textStyleHandles.set(style.name.toUpperCase(), w.nextHandle());
  const shapeHandles = new Map<string, string>();
  for (const [sourceId, shape] of shapeStyles) {
    const problem = linetypeShapeStyleProblem(shape);
    if (!sourceId || sourceId.length > 255 || /[\u0000\r\n]/.test(sourceId) || problem) throw new Error(`Cannot preserve shape STYLE resource "${sourceId}": ${problem || 'invalid identity'}.`);
    shapeHandles.set(sourceId, w.nextHandle());
  }
  // P18: MLEADERSTYLE objects for the native multileaders in the drawing, one per
  // style name (first entity with the name supplies the effective values).
  // Handles are pre-allocated like text-style handles because entities name
  // their style (group 340) before OBJECTS is written. No native mleader =>
  // no allocation, no output: every other drawing is byte-identical to base.
  const mleaderStyles = new Map<string, MLeaderStyleData>();
  for (const e of allEntities) {
    if (e.type !== 'leader' || e.kind !== 'mleader' || !e.mleader) continue;
    const key = e.mleader.styleName.toUpperCase();
    if (!mleaderStyles.has(key)) {
      mleaderStyles.set(key, mleaderStyleData(e.mleader, {
        arrowSize: e.arrowSize,
        textHeight: e.textHeight,
        doglegLength: e.dogleg ? g.len(e.dogleg) : STANDARD_MLEADER_STYLE.doglegLength,
        textStyleName: e.mleader.textStyleName ?? textStyleOf(e) ?? undefined,
      }));
    }
  }
  let mleaderDict: string | null = null;
  if (mleaderStyles.size) {
    mleaderDict = w.nextHandle();
    for (const key of mleaderStyles.keys()) w.mleaderStyleHandles.set(key, w.nextHandle());
  }
  // P18 slice 2 (PROPOSAL-P18-S2 item (5)): when a native block-content mleader
  // exists, the Writer also needs the block-record allocation — a written
  // mleader names its content block by this file's record handle (341/344),
  // and its style names it too (343). Copied keyed upper-case; no block-content
  // mleader => the map stays empty and nothing changes.
  if ([...mleaderStyles.values()].some((d) => d.contentType === 1)) {
    for (const [name, handle] of blockRecordHandles) w.blockRecordHandles.set(name.toUpperCase(), handle);
  }
  // P18 S3-D (Amendment 2 (i), W-ALLOC-18 extended): for each native mleader
  // carrying annotative contexts, in allEntities order, pre-allocate its
  // extension-dictionary chain handles — THREE dictionary handles (extension,
  // manager, scales; the filing asked for one, the lead's fixtures decide
  // three) plus one context-object handle per context INCLUDING the primary's.
  // The entity's own handle is reserved here too, so the OBJECTS block can
  // name it as the extension dictionary's owner (330) after ENTITIES is
  // written. No contexts => no allocation, no output: byte-identical.
  let mleaderContextObjectCount = 0;
  // P18 FIX group 1 (native gate 340): every context object must carry group
  // 340 -> a SCALE object, so each view's scale is resolved ONCE here. A view
  // resolves to (i) a RETAINED scale-list entry by its source scale name (or
  // the canonical name of its factor), (ii) the writer-created cannoscale
  // SCALE object, or (iii) a CREATION: a SCALE to be added under a name — in
  // this write's own scale list when this write creates one (or when the
  // drawing has no retained graph at all), otherwise by
  // preserveDxfCadGraph's completion pass beside the retained list. A view
  // whose SOURCE scale name resolves nowhere and is not a plain ratio name
  // cannot be recreated without falsifying it: its entity's whole chain is
  // WITHHELD (never written without the 340 AutoCAD requires) and reported
  // through the export-report sink. Creations are recorded by NAME only —
  // their handles are allocated in the OBJECTS pass like every scale-list
  // handle (the allocation-order invariant at scaleListDictionary above).
  interface MLeaderScalePlan { handle?: string; cannoObject?: boolean; createName?: string }
  const mleaderScalePlans = new Map<Entity, MLeaderScalePlan[]>();
  const mleaderScaleCreations = new Map<string, { numerator: string; denominator: string; unit: boolean }>();
  let mleaderChainsWithheldCount = 0;
  const retainedScales = allEntities.some((e) => e.type === 'leader' && e.kind === 'mleader' && e.mleader?.contexts?.length)
    ? graphAnnotationScaleEntries(state)
    : new Map<string, string>();
  for (const e of allEntities) {
    if (e.type !== 'leader' || e.kind !== 'mleader' || !e.mleader?.contexts?.length) continue;
    const views = mleaderContextViews(e);
    const plans: MLeaderScalePlan[] = [];
    let withhold: string | undefined;
    for (const v of views) {
      const canonical = formatScale(1 / v.scaleFactor);
      if (v.scaleName) {
        const retained = retainedScales.get(v.scaleName) ?? retainedScales.get(canonical);
        if (retained) { plans.push({ handle: retained }); continue; }
        if (createScaleList && state.header?.cannoscale === v.scaleName) { plans.push({ cannoObject: true }); continue; }
        const ratio = annotationScaleRatio(v.scaleName);
        if (!ratio) { withhold = v.scaleName; break; }
        if (!mleaderScaleCreations.has(v.scaleName)) mleaderScaleCreations.set(v.scaleName, ratio);
        plans.push({ createName: v.scaleName });
        continue;
      }
      if (createScaleList && state.header?.cannoscale !== undefined && canonical === formatScale(cannoscaleValue(state.header.cannoscale))) { plans.push({ cannoObject: true }); continue; }
      const retained = retainedScales.get(canonical);
      if (retained) { plans.push({ handle: retained }); continue; }
      const ratio = annotationScaleRatio(canonical);
      if (!ratio) { withhold = canonical; break; }
      if (!mleaderScaleCreations.has(canonical)) mleaderScaleCreations.set(canonical, ratio);
      plans.push({ createName: canonical });
    }
    if (withhold !== undefined) {
      w.mleaderChainsWithheld.add(e);
      mleaderChainsWithheldCount += 1;
      exportReport?.add({
        type: 'MULTILEADER',
        action: 'simplified',
        reason: `Annotative contexts are not written: no SCALE object can be referenced for the source scale "${withhold}" (its name is not a plain scale ratio and no retained SCALE carries it), so the context chain is withheld instead of being written without the group 340 AutoCAD requires.`,
        layer: e.layer,
      });
      continue;
    }
    mleaderScalePlans.set(e, plans);
    w.reserveEntityHandle(e);
    // P18 FIX group 2: a chain the retained graph carries is registered
    // with its RETAINED handles and regenerated in place by
    // preserveDxfCadGraph; only the model's growth beyond the retained
    // object count allocates fresh handles (the writer emits those).
    const carrier = mleaderCarriers.get(e.id);
    if (carrier) {
      const retainedHandles = (node: CadNode): string => canonicalCadHandle(node.sourceHandle!);
      const objects = carrier.objects.map(retainedHandles);
      while (objects.length <= e.mleader.contexts.length) objects.push(w.nextHandle());
      w.mleaderContextChains.set(e, {
        extension: retainedHandles(carrier.extension),
        manager: retainedHandles(carrier.manager),
        scales: retainedHandles(carrier.scales),
        objects,
        carried: true,
      });
    } else {
      const extension = w.nextHandle();
      const manager = w.nextHandle();
      const scales = w.nextHandle();
      const objects: string[] = [];
      for (let i = 0; i <= e.mleader.contexts.length; i += 1) objects.push(w.nextHandle());
      w.mleaderContextChains.set(e, { extension, manager, scales, objects });
    }
    mleaderContextObjectCount += e.mleader.contexts.length + 1;
  }
  // Creations are written by THIS write when it creates the scale list, or
  // when no retained graph exists for the merge to complete them beside;
  // beside a retained list the merge pass creates them (under the canonical
  // name of each object's group 40 — the same ratio).
  const mleaderCreationsHere = createScaleList || !state.cadGraph;
  const mleaderForceScaleList = !createScaleList && !state.cadGraph && mleaderScaleCreations.size > 0;
  // Choose the highest native format required anywhere, including associated text/attributes.
  const appearances = [...allEntities, ...state.layers, ...blockList.flatMap((b) => b.attributes),
    ...allEntities.flatMap<AttributeAppearance>((e) => e.type === 'insert' ? Object.values(e.attributePlacements ?? {}) : e.type === 'leader' && e.textAppearance ? [e.textAppearance] : [])];
  const appearanceVersion = allEntities.some((e) => (entityMTextBackground(e)?.flags ?? 0) & 16) ? 'AC1032'
    : appearances.some((e) => e.transparency !== undefined) ? 'AC1024'
      : allEntities.some((e) => entityMTextBackground(e)) ? 'AC1021'
        : allEntities.some((e) => e.type === 'hatch' && e.gradient) || appearances.some((e) => e.colorName !== undefined || e.trueColor !== undefined) ? 'AC1018' : 'AC1015';
  const sourceVersion = state.cadGraph?.sourceVersion;
  const acadVersion = sourceVersion && /^AC10(?:15|18|21|24|27|32)$/.test(sourceVersion) && sourceVersion > appearanceVersion ? sourceVersion : appearanceVersion;
  w.acadVersion = acadVersion;
  let imageDict: string | null = null;
  let anon = 0;
  // P22: native tables. Each table gets a generated *T picture block; tables sharing a
  // style signature (margins + data/title text heights) share one synthesized TABLESTYLE
  // in a single ACAD_TABLESTYLE dictionary. Nothing is allocated for a table-free drawing.
  // P22 F-2 successor: at AC1015 a table also gets its roundtrip chain (extension
  // dictionary + XRECORD + ACDBDATATABLE + one CELL_VALUE XRECORD per cell) — the
  // load-time cell source AutoCAD reads at that version — unless the retained graph
  // already carries a chain for it, which the graph merge replays verbatim instead.
  const roundtripCarried = acadVersion === 'AC1015' ? graphTableRoundtripCarriers(state) : new Set<string>();
  let tableStyleDict: string | null = null;
  const tableStylesToWrite: Array<{ handle: string; name: string; margin: number; dataHeight: number; titleHeight: number }> = [];
  const tableStyleByKey = new Map<string, (typeof tableStylesToWrite)[number]>();
  for (const e of allEntities) {
    if (e.type === 'image') {
      if (!imageDict) imageDict = w.nextHandle();
      let def = extras.imageDefs.get(e.path);
      if (!def) {
        def = w.nextHandle();
        extras.imageDefs.set(e.path, def);
      }
      extras.imageReactors.set(e, { reactor: w.nextHandle(), def });
    } else if (e.type === 'table') {
      let name = '';
      do {
        anon += 1;
        name = `*T${anon}`;
      } while (state.blocks[name] || blockRecordHandles.has(name));
      const recordHandle = w.nextHandle();
      blockRecordHandles.set(name, recordHandle);
      const key = tableStyleKey(e);
      const signature = `${key.margin}|${key.dataHeight}|${key.titleHeight}`;
      let style = tableStyleByKey.get(signature);
      if (!style) {
        if (!tableStyleDict) tableStyleDict = w.nextHandle();
        style = { handle: w.nextHandle(), name: tableStylesToWrite.length === 0 ? 'Standard' : `Standard_${tableStylesToWrite.length + 1}`, ...key };
        tableStyleByKey.set(signature, style);
        tableStylesToWrite.push(style);
      }
      extras.tableBlocks.set(e, {
        name, recordHandle, styleHandle: style.handle,
        ...(acadVersion === 'AC1015' && !roundtripCarried.has(e.id)
          ? {
            roundtrip: {
              dict: w.nextHandle(),
              record: w.nextHandle(),
              data: w.nextHandle(),
              cellHandles: Array.from({ length: e.rowHeights.length * e.columnWidths.length }, () => w.nextHandle()),
              cells: tableRoundtripCells(e),
            },
          }
          : {}),
      });
    }
  }
  const tableList = [...extras.tableBlocks.entries()];
  // RULING-P28 C8: underlay definition handles are allocated for EVERY
  // definition in the sibling — referenced or not, unreferenced definitions
  // are written back (C2) — in this pre-pass, before any section (and so
  // before ENTITIES) is emitted, so a placement's group 340 always names a
  // handle this file defines.
  const underlayDefs = Object.values(state.underlays ?? {});
  for (const def of underlayDefs) {
    const handle = w.nextHandle();
    extras.underlayDefHandles.set(def.id, handle);
    if (def.handle) extras.underlayHandlesByDef.set(def.handle.toUpperCase(), handle);
  }
  const underlayEntityKinds = new Set(allEntities.flatMap((e) => (e.type === 'underlay' ? [e.kind] : [])));
  const underlayDefKinds = new Set(underlayDefs.map((d) => d.kind));
  // v0.6.4 native gate B-2: a definition must be REACHABLE from the
  // named-objects dictionary or AutoCAD drops it on its first save (and the
  // placement's 340 dies, AUDIT 2). AutoCAD keeps them in ACAD_PDFDEFINITIONS
  // / ACAD_DWFDEFINITIONS / ACAD_DGNDEFINITIONS under the root, one entry
  // per definition named "<file stem> - <page>" ("real - 1"), the definition
  // owned by (330) and reacting to that dictionary. One dictionary per kind
  // in use, allocated here. A retained definition keeps the entry name its
  // source dictionary gave it (looked up in the cad graph), so the graph
  // merge — which matches the dictionary by its path and adds only missing
  // keys — never ends up with two entries for one definition.
  const underlayDefDicts = new Map<UnderlayKind, string>();
  for (const kind of underlayDefKinds) underlayDefDicts.set(kind, w.nextHandle());
  const underlayDefEntryNames = new Map<string, string>();
  {
    const sourceEntryName = (def: UnderlayDefinition): string | undefined => {
      if (!def.handle || !state.cadGraph) return undefined;
      const target = canonicalCadHandle(def.handle);
      for (const node of state.cadGraph.nodes) {
        if (node.type !== 'DICTIONARY') continue;
        for (let i = 0; i + 1 < node.groups.length; i += 1) {
          const [code, name] = node.groups[i]!, [refCode, raw] = node.groups[i + 1]!;
          if (code !== 3 || (refCode !== 350 && refCode !== 360)) continue;
          try { if (canonicalCadHandle(raw.trim()) === target) return name; } catch { /* not a handle: no match */ }
        }
      }
      return undefined;
    };
    const used = new Map<UnderlayKind, Set<string>>();
    for (const def of underlayDefs) {
      const taken = used.get(def.kind) ?? new Set<string>();
      used.set(def.kind, taken);
      const stem = (def.sourcePath.split(/[\\/]/).pop() || def.sourcePath).replace(/\.[^.]*$/, '') || def.sourcePath;
      const base = sourceEntryName(def) ?? (def.page !== undefined && def.page !== '' ? `${stem} - ${def.page}` : stem);
      let name = base;
      for (let n = 2; taken.has(name.toUpperCase()); n += 1) name = `${base} (${n})`;
      taken.add(name.toUpperCase());
      underlayDefEntryNames.set(def.id, name);
    }
  }

  // HEADER
  w.pair(0, 'SECTION');
  w.pair(2, 'HEADER');
  const hv = (name: string, code: number, value: string | number) => {
    w.pair(9, name);
    w.pair(code, value);
  };
  // 2D points: $LIMMIN / $LIMMAX have no Z (group 30) in AC1015.
  const hpt = (name: string, p: g.Point) => {
    w.pair(9, name);
    w.pair(10, p.x);
    w.pair(20, p.y);
  };
  hv('$ACADVER', 1, acadVersion);
  hv('$DWGCODEPAGE', 3, 'ANSI_1252');
  hv('$HANDSEED', 5, 'HANDSEED_PLACEHOLDER');
  hv('$INSUNITS', 70, header.units.insunits);
  if (header.measurement !== undefined) hv('$MEASUREMENT', 70, header.measurement);
  hv('$LUNITS', 70, header.units.lunits);
  hv('$LUPREC', 70, header.units.luprec);
  hv('$AUNITS', 70, header.units.aunits ?? 0);
  hv('$AUPREC', 70, header.units.auprec);
  hv('$CLAYER', 8, state.currentLayer);
  hv('$CELTYPE', 6, header.celtype || 'ByLayer');
  hv('$CELWEIGHT', 370, header.celweight === undefined ? -1 : Math.round(header.celweight * 100));
  hv('$LTSCALE', 40, header.ltscale);
  hv('$CELTSCALE', 40, header.celtscale ?? 1);
  hpt('$LIMMIN', header.limits.min);
  hpt('$LIMMAX', header.limits.max);
  hv('$PDMODE', 70, header.pdmode);
  hv('$PDSIZE', 40, header.pdsize);
  hv('$TEXTSTYLE', 7, encodeDxfText(header.textStyle || 'Standard'));
  hv('$DIMSTYLE', 2, ds.name);
  for (const [name, code, value] of dimHeaderVars(ds)) if (name !== 'DIMLUNIT') hv(`$${name}`, code, value);
  hv('$DIMLUNIT', 70, ds.lunit);
  // No $CANNOSCALE / $ANNOALLVISIBLE here: not HEADER variables (Q11 F2 rework) —
  // they are written as DICTIONARYVARs in OBJECTS below.
  w.pair(0, 'ENDSEC');

  // CLASSES: the plot style dictionary's object types, and raster images' when there are images.
  w.pair(0, 'SECTION');
  w.pair(2, 'CLASSES');
  {
    const cls = (name: string, cpp: string, flags: number, isEntity: boolean, instances = 1, app = 'ISM') => {
      w.pair(0, 'CLASS');
      w.pair(1, name);
      w.pair(2, cpp);
      w.pair(3, app);
      w.pair(90, flags);
      if (acadVersion !== 'AC1015') w.pair(91, instances);
      w.pair(280, 0);
      w.pair(281, isEntity ? 1 : 0);
    };
    cls('ACDBDICTIONARYWDFLT', 'AcDbDictionaryWithDefault', 0, false);
    cls('ACDBPLACEHOLDER', 'AcDbPlaceHolder', 0, false);
    if (imageDict) {
      cls('IMAGE', 'AcDbRasterImage', 127, true, extras.imageReactors.size);
      cls('IMAGEDEF', 'AcDbRasterImageDef', 0, false, extras.imageDefs.size);
      cls('IMAGEDEF_REACTOR', 'AcDbRasterImageDefReactor', 1, false, extras.imageReactors.size);
    }
    if (tableList.length) {
      // AutoCAD's own registrations for tables (specimen: tests/fixtures/interchange/
      // r2018-table.dxf): app name 'ObjectDBX Classes', proxy flags 4095 / 1025.
      const tcls = (name: string, cpp: string, flags: number, isEntity: boolean, instances: number) => {
        w.pair(0, 'CLASS');
        w.pair(1, name);
        w.pair(2, cpp);
        w.pair(3, 'ObjectDBX Classes');
        w.pair(90, flags);
        if (acadVersion !== 'AC1015') w.pair(91, instances);
        w.pair(280, 0);
        w.pair(281, isEntity ? 1 : 0);
      };
      tcls('TABLESTYLE', 'AcDbTableStyle', 4095, false, tableStylesToWrite.length);
      tcls('ACAD_TABLE', 'AcDbTable', 1025, true, tableList.length);
      // The roundtrip chain's one non-core class, registered as the genuine
      // AC1015 control registers it, only when a chain is generated.
      const roundtripCount = tableList.filter(([, picture]) => picture.roundtrip).length;
      if (roundtripCount) tcls('ACDBDATATABLE', 'AcDbDataTable', 0, false, roundtripCount);
    }
    if (mleaderDict) {
      // P18: registered like the other OBJECTS-resident classes above.
      cls('MLEADERSTYLE', 'AcDbMLeaderStyle', 0, false, mleaderStyles.size);
      if (mleaderContextObjectCount) {
        // P18 S3-D (Amendment 2 (iii)): registered immediately after
        // MLEADERSTYLE, with the fixture-verified values (Recipe #4 fixtures,
        // fact F1): app name 'ObjectDBX Classes', group 90 = 1153; group 91
        // (instance count) omitted at AC1015, exactly as the SCALE
        // registration below omits it. Written manually because `cls`
        // hardcodes the 'ISM' application name.
        w.pair(0, 'CLASS');
        w.pair(1, 'ACDB_MLEADEROBJECTCONTEXTDATA_CLASS');
        w.pair(2, 'AcDbMLeaderObjectContextData');
        w.pair(3, 'ObjectDBX Classes');
        w.pair(90, 1153);
        if (acadVersion !== 'AC1015') w.pair(91, mleaderContextObjectCount);
        w.pair(280, 0);
        w.pair(281, 0);
      }
    }
    // Underlay CLASS registrations are presence-gated per kind (RULING-P28 C8).
    // Registered exactly as AutoCAD 2027 writes them (v0.6.4 review F-F,
    // confirmed by the gate's DXFOUT and ezdxf's class table): PDFUNDERLAY ->
    // AcDbPdfReference, app "ObjectDBX Classes", proxy flags 4095, entity;
    // PDFDEFINITION -> AcDbPdfDefinition, "ObjectDBX Classes", 1153, object;
    // DWF / DGN likewise.
    for (const kind of ['pdf', 'dwf', 'dgn'] as const) {
      if (underlayEntityKinds.has(kind)) cls(underlayDxfType(kind), underlayEntityClassName(kind), 4095, true, allEntities.filter((e) => e.type === 'underlay' && e.kind === kind).length, 'ObjectDBX Classes');
      if (underlayDefKinds.has(kind)) cls(underlayDefinitionDxfType(kind), underlayDefinitionClassName(kind), 1153, false, underlayDefs.filter((d) => d.kind === kind).length, 'ObjectDBX Classes');
    }
    if (createCannoVariable || createAnnoVariable) {
      // AutoCAD's specimen registration (the HANDBUILT fixtures): app name
      // 'ObjectDBX Classes', instance count = the DICTIONARYVARs created below.
      // Keyed on the creation booleans (known at plan time): the dictionary
      // handle is only allocated in OBJECTS, after CLASSES is emitted, so
      // keying on it made this block unreachable on fresh writes (Q11 F2
      // rework C1).
      w.pair(0, 'CLASS');
      w.pair(1, 'DICTIONARYVAR');
      w.pair(2, 'AcDbDictionaryVar');
      w.pair(3, 'ObjectDBX Classes');
      w.pair(90, 0);
      if (acadVersion !== 'AC1015') w.pair(91, (createCannoVariable ? 1 : 0) + (createAnnoVariable ? 1 : 0));
      w.pair(280, 0);
      w.pair(281, 0);
    }
    if (createScaleList || mleaderForceScaleList) {
      // Specimen registration (N1/Q10/Q12 HANDBUILT fixtures): SCALE / AcDbScale,
      // app name 'ObjectDBX Classes', class version 1153, one created instance;
      // group 91 omitted at AC1015, exactly like the registration above. The
      // instance count covers every SCALE this write creates (the cannoscale
      // object plus the P18 FIX group-1 mleader creations written here; with
      // a retained graph the merge recounts class instances anyway).
      w.pair(0, 'CLASS');
      w.pair(1, 'SCALE');
      w.pair(2, 'AcDbScale');
      w.pair(3, 'ObjectDBX Classes');
      w.pair(90, 1153);
      if (acadVersion !== 'AC1015') w.pair(91, (createScaleList ? 1 : 0) + (mleaderCreationsHere ? mleaderScaleCreations.size : 0));
      w.pair(280, 0);
      w.pair(281, 0);
    }
  }
  w.pair(0, 'ENDSEC');

  // TABLES
  w.pair(0, 'SECTION');
  w.pair(2, 'TABLES');

  const table = (name: string, handle: string, count: number, body: () => void) => {
    w.pair(0, 'TABLE');
    w.pair(2, name);
    w.pair(5, handle);
    w.pair(330, '0');
    w.pair(100, 'AcDbSymbolTable');
    w.pair(70, count);
    body();
    w.pair(0, 'ENDTAB');
  };
  const record = (kind: string, owner: string, subclass: string, name: string, flags = 0, reservedHandle?: string) => {
    w.pair(0, kind);
    w.pair(5, reservedHandle ?? w.nextHandle());
    w.pair(330, owner);
    w.pair(100, 'AcDbSymbolTableRecord');
    w.pair(100, subclass);
    w.pair(2, name);
    w.pair(70, flags);
  };

  table('VPORT', '8', 1, () => {
    record('VPORT', '8', 'AcDbViewportTableRecord', '*Active');
    w.pair(10, 0);
    w.pair(20, 0);
    w.pair(11, 1);
    w.pair(21, 1);
    w.pair(12, (header.limits.min.x + header.limits.max.x) / 2);
    w.pair(22, (header.limits.min.y + header.limits.max.y) / 2);
    w.pair(40, header.limits.max.y - header.limits.min.y);
    w.pair(41, 1.6);
    w.pair(72, 1000);
  });
  table('LTYPE', '5', 3 + linetypes.length, () => {
    const ltRecord = (lt: Linetype) => {
      record('LTYPE', '5', 'AcDbLinetypeTableRecord', lt.name, lt.complex?.flags ?? 0);
      w.pair(3, lt.description);
      w.pair(72, lt.complex?.alignment ?? 65);
      w.pair(73, lt.pattern.length);
      w.pair(40, lt.complex?.totalPatternLength ?? patternLength(lt.pattern));
      writeComplexLinetypeElements(w, lt, shapeHandles);
    };
    ltRecord({ name: 'ByBlock', description: '', pattern: [] });
    ltRecord({ name: 'ByLayer', description: '', pattern: [] });
    ltRecord(STANDARD_LINETYPES[0]!);
    for (const lt of linetypes) ltRecord(lt);
  });
  const layerHandles = new Map<string, string>();
  // Layers of retained raw records that were deleted since: written so the records stay valid.
  const graphHandles = new Set(state.cadGraph?.nodes.flatMap(node => node.sourceHandle ? [node.sourceHandle.toUpperCase()] : []) ?? []);
  const rawRecords = rawEntitiesOf(state).filter(record => !record.handle || !graphHandles.has(record.handle.toUpperCase()));
  const layerList: Layer[] = [...state.layers];
  for (const r of rawRecords) if (!layerList.some((l) => l.name === r.layer)) layerList.push({ name: r.layer, color: 7, visible: true, locked: false, lineWeight: 0.25 });
  // Likewise the layers of 3D solids and dimensions (the model3d helpers do not keep the layer table in step).
  for (const s of [...(state.model3d?.solids ?? []), ...dims3d]) if (!layerList.some((l) => l.name === s.layer)) layerList.push({ name: s.layer, color: 7, visible: true, locked: false, lineWeight: 0.25 });
  table('LAYER', '2', layerList.length, () => {
    for (const l of layerList) {
      // Flags 16 / 32 (xref-dependent, resolved) are kept from the source file.
      record('LAYER', '2', 'AcDbLayerTableRecord', l.name, (l.locked ? 4 : 0) | (l.frozen ? 1 : 0) | ((l.xrefFlags ?? 0) & 48));
      layerHandles.set(l.name, w.lastHandle().toString(16).toUpperCase());
      w.pair(62, l.visible || l.frozen ? l.color : -l.color);
      if (l.trueColor !== undefined) w.pair(420, l.trueColor & 0xffffff);
      if (l.colorName !== undefined) {
        if (!validColorName(l.colorName)) throw new Error('Invalid layer named/color-book identity.');
        w.pair(430, l.colorName);
      }
      w.pair(6, l.linetype && l.linetype.toUpperCase() !== 'BYLAYER' ? l.linetype : 'Continuous');
      w.pair(370, Math.round(l.lineWeight * 100));
      if (l.plot === false) w.pair(290, 0);
      w.pair(390, normalPlotStyle);
      if (l.transparency !== undefined) {
        w.pair(1001, LAYER_TRANSPARENCY_APP);
        w.pair(1071, transparencyToDxf(l.transparency));
      }
    }
  });
  table('STYLE', '3', textStyles.length + shapeStyles.length, () => {
    for (const ts of textStyles) {
      record('STYLE', '3', 'AcDbTextStyleTableRecord', encodeDxfText(ts.name), ts.flags, w.textStyleHandles.get(ts.name.toUpperCase()));
      for (const [code, value] of textStyleGroups(ts)) w.pair(code, value);
    }
    for (const [sourceId, shape] of shapeStyles) {
      record('STYLE', '3', 'AcDbTextStyleTableRecord', encodeDxfText(shape.name), shape.flags, shapeHandles.get(sourceId));
      w.anchor(shapeHandles.get(sourceId)!, { kind: 'shape-style', sourceId });
      for (const [code, value] of shapeStyleGroups(shape)) w.pair(code, value);
    }
  });
  table('VIEW', '6', header.views.length, () => {
    for (const v of header.views) {
      record('VIEW', '6', 'AcDbViewTableRecord', v.name, v.camera?.flags ?? 0);
      const camera = v.camera;
      const center = camera ? planarNamedCamera(camera) ? namedCameraDisplayCenter({ ...camera, twist: v.twist ?? camera.twist }, v.center) : camera.displayCenter : v.center;
      w.pair(40, v.height);
      w.pair(10, center.x);
      w.pair(20, center.y);
      w.pair(41, v.width ?? camera?.width ?? v.height * 1.5);
      w.pair(11, camera?.direction.x ?? 0);
      w.pair(21, camera?.direction.y ?? 0);
      w.pair(31, camera?.direction.z ?? 1);
      w.pair(12, camera?.target.x ?? 0);
      w.pair(22, camera?.target.y ?? 0);
      w.pair(32, camera?.target.z ?? 0);
      w.pair(42, camera?.lensLength ?? 50);
      w.pair(43, camera?.frontClip ?? 0);
      w.pair(44, camera?.backClip ?? 0);
      w.pair(50, g.deg(v.twist ?? camera?.twist ?? 0));
      w.pair(71, camera?.mode ?? 0);
    }
  });
  table('UCS', '7', 0, () => {});
  const annotative = allEntities.some((e) => e.annotative);
  // Priority 30: JCAD_DYNAMIC is registered only when a definition or instance payload exists.
  const dynamicApp = blockList.some((b) => b.dynamic || b.dynamicRetained) || allEntities.some((e) => e.type === 'insert' && (e.dynamic || e.dynamicRetained));
  // Priority 30.4: JCAD_CONSTRAINTS likewise, only when a set (or its retained payload) exists.
  const constraintsApp = state.constraints !== undefined || state.constraintsRetained !== undefined;
  const columnMtext = allEntities.some((e) => e.type === 'mtext' ? e.columns : e.type === 'leader' && e.textColumns);
  const layerTransparency = state.layers.some((l) => l.transparency !== undefined);
  const inactiveMtext = allEntities.some((e) => entityMTextBackground(e)?.flags === 0);
  // Experimental 3D solids (polyface meshes with JCAD_3D data); a 2D drawing writes none of this.
  const solids = state.model3d?.solids ?? [];
  const model3dApp = solids.length > 0 || dims3d.length > 0;
  table('APPID', '9', (tableList.length ? 3 : 2) + (annotative ? 1 : 0) + (columnMtext ? 1 : 0) + (layerTransparency ? 1 : 0) + (inactiveMtext ? 1 : 0) + (model3dApp ? 1 : 0) + (dynamicApp ? 1 : 0) + (constraintsApp ? 1 : 0), () => {
    record('APPID', '9', 'AcDbRegAppTableRecord', 'ACAD');
    record('APPID', '9', 'AcDbRegAppTableRecord', DIMSTYLE_APP);
    if (tableList.length) record('APPID', '9', 'AcDbRegAppTableRecord', TABLE_APP);
    if (dynamicApp) record('APPID', '9', 'AcDbRegAppTableRecord', DYNAMIC_APP);
    if (constraintsApp) record('APPID', '9', 'AcDbRegAppTableRecord', CONSTRAINTS_APP);
    if (annotative) record('APPID', '9', 'AcDbRegAppTableRecord', ANNO_APP);
    if (columnMtext) record('APPID', '9', 'AcDbRegAppTableRecord', MTEXT_COLUMNS_APP);
    if (layerTransparency) record('APPID', '9', 'AcDbRegAppTableRecord', LAYER_TRANSPARENCY_APP);
    if (inactiveMtext) record('APPID', '9', 'AcDbRegAppTableRecord', MTEXT_BACKGROUND_APP);
    if (model3dApp) record('APPID', '9', 'AcDbRegAppTableRecord', MODEL3D_APP);
  });
  // Dimensions on layouts count too, so their (unnamed) styles get a record.
  const dimStyleList = dimStylesToWrite(state, dims3dAs2d.length ? [...allEntities, ...dims3dAs2d] : allEntities);
  for (const style of dimStyleList) w.dimensionStyles.set(style.name.toUpperCase(), style);
  table('DIMSTYLE', 'A', dimStyleList.length, () => {
    w.pair(100, 'AcDbDimStyleTable');
    for (const style of dimStyleList) {
      w.pair(0, 'DIMSTYLE');
      w.pair(105, w.nextHandle());
      w.pair(330, 'A');
      w.pair(100, 'AcDbSymbolTableRecord');
      w.pair(100, 'AcDbDimStyleTableRecord');
      w.pair(2, style.name);
      w.pair(70, 0);
      for (const [code, value] of dimStyleRecordPairs(style)) w.pair(code, value);
      w.pair(340, w.textStyleHandles.get((style.textStyle ?? 'Standard').toUpperCase()) ?? w.textStyleHandles.get('STANDARD')!);
      w.pair(1001, DIMSTYLE_APP);
      for (const [k, v] of dimStyleXdata(style)) {
        w.pair(1000, k);
        w.pair(1000, v);
      }
    }
  });
  const layoutRecords = extraBlockRecords(layoutPlan);
  table('BLOCK_RECORD', '1', 2 + blockRecordHandles.size + layoutRecords.length, () => {
    const brec = (handle: string, name: string) => {
      w.pair(0, 'BLOCK_RECORD');
      w.pair(5, handle);
      w.pair(330, '1');
      w.pair(100, 'AcDbSymbolTableRecord');
      w.pair(100, 'AcDbBlockTableRecord');
      w.pair(2, name);
      const layoutHandle = layoutHandleOf(layoutPlan, handle, MODEL_SPACE);
      if (layoutHandle) w.pair(340, layoutHandle);
      w.pair(70, 0);
      w.pair(280, 1);
      w.pair(281, 0);
    };
    brec(MODEL_SPACE, '*Model_Space');
    brec(PAPER_SPACE, '*Paper_Space');
    for (const r of layoutRecords) brec(r.handle, r.name);
    for (const [name, handle] of blockRecordHandles) brec(handle, name);
  });
  w.pair(0, 'ENDSEC');

  // BLOCKS
  w.pair(0, 'SECTION');
  w.pair(2, 'BLOCKS');
  const blockShell = (owner: string, name: string, base: { x: number; y: number }, flags: number, description: string | undefined, body: () => void, path = '', xdataBody?: () => void) => {
    w.pair(0, 'BLOCK');
    w.pair(5, w.nextHandle());
    w.pair(330, owner);
    w.pair(100, 'AcDbEntity');
    w.pair(8, '0');
    w.pair(100, 'AcDbBlockBegin');
    w.pair(2, name);
    w.pair(70, flags);
    w.pair(10, base.x);
    w.pair(20, base.y);
    w.pair(30, 0);
    w.pair(3, name);
    w.pair(1, path);
    if (description) w.pair(4, description);
    // XDATA on the BLOCK record itself (priority 30 definition carrier): after the
    // AcDbBlockBegin groups, before the first block entity — the only position that
    // attaches the payload to the BLOCK object.
    if (xdataBody) xdataBody();
    body();
    w.pair(0, 'ENDBLK');
    w.pair(5, w.nextHandle());
    w.pair(330, owner);
    w.pair(100, 'AcDbEntity');
    w.pair(8, '0');
    w.pair(100, 'AcDbBlockEnd');
  };
  blockShell(MODEL_SPACE, '*Model_Space', { x: 0, y: 0 }, 0, undefined, () => {}, '', () => {
    // Priority 30.4 drawing-level carrier: the constraint set rides the
    // *Model_Space BLOCK record (the drawing's one always-present record),
    // the same attachment JCAD_DYNAMIC uses on named BLOCK records. A
    // modeled set is re-encoded canonically against the entities being
    // written; a retained payload is re-emitted verbatim (chunked only),
    // never re-escaped or re-shaped. A constraints-free drawing emits
    // nothing here (and registers no APPID above): the fixed point holds.
    const payload = state.constraints ? encodeConstraints(state.constraints, state.entities.map((e) => e.id)) : state.constraintsRetained;
    if (payload === undefined) return;
    w.pair(1001, CONSTRAINTS_APP);
    for (const chunk of chunkDynamicPayload(payload)) w.pair(1000, chunk);
  });
  blockShell(PAPER_SPACE, '*Paper_Space', { x: 0, y: 0 }, 0, undefined, () => {});
  // Layouts after the first keep their paper space in *Paper_Space0, *Paper_Space1 ...
  const writePaperEntity = (e: Entity, owner: string) => writeEntityAnno(w, e, owner, state.blocks, dimBlocks, extras);
  for (const r of layoutPlan.records.slice(1)) blockShell(r.blockRecord, r.blockName, { x: 0, y: 0 }, 0, undefined, () => writeLayoutContent(w, r, writePaperEntity, layerHandles));
  for (const b of blockList) {
    const owner = blockRecordHandles.get(b.name)!;
    // Anonymous blocks (*T tables, *U dynamic blocks) must carry flag 1 or AutoCAD rejects the name.
    const xrefFlags = b.xref ? 4 | (b.xref.overlay ? 8 : 0) : 0;
    blockShell(owner, b.name, b.basePoint, (b.attributes.length > 0 ? 2 : 0) | (b.name.startsWith('*') ? 1 : 0) | xrefFlags, b.description, () => {
      for (const e of b.entities) writeEntityAnno(w, e, owner, state.blocks, dimBlocks, extras);
      for (const [attdefIndex, a] of b.attributes.entries()) {
        // P18 slice 2 (PROPOSAL-P18-S2 item (6)): record the handle just written,
        // by tag and by definition index, so a block-content mleader's attribute
        // entries (group 330) can name THIS file's ATTDEFs. No output change.
        const attdefHandle = writeEntityCommon(w, { ...a, id: a.tag, type: 'text', text: a.default, rotation: a.rotation ?? 0, color: a.color ?? 'ByLayer', layer: a.layer ?? '0' }, owner, 'ATTDEF', 'AcDbText');
        w.blockAttdefHandles.set(`${b.name.toUpperCase()} ${a.tag}`, attdefHandle);
        w.blockAttdefHandles.set(`${b.name.toUpperCase()} #${attdefIndex}`, attdefHandle);
        writeTextLike(w, a.position, a.height, a.default, a.rotation ?? 0, a.align, a);
        writeTextStyle(w, a);
        w.pair(100, 'AcDbAttributeDefinition');
        w.pair(3, a.prompt);
        w.pair(2, a.tag);
        w.pair(70, attdefFlags(a));
        if (a.justification?.vertical) w.pair(74, a.justification.vertical);
      }
    }, b.xref?.path ?? '', () => {
      // A modeled definition is re-encoded canonically; a retained payload is
      // re-emitted verbatim (chunked only), never re-escaped or re-shaped.
      const payload = b.dynamic ? encodeDynamicDefinition(b.dynamic, b.entities.map((e) => e.id)) : b.dynamicRetained;
      if (payload === undefined) return;
      w.pair(1001, DYNAMIC_APP);
      for (const chunk of chunkDynamicPayload(payload)) w.pair(1000, chunk);
    });
  }
  for (const [t, picture] of tableList) {
    const owner = blockRecordHandles.get(picture.name)!;
    blockShell(owner, picture.name, { x: 0, y: 0 }, 1, undefined, () => {
      // The picture is generated in the block's local frame (tablePictureForm,
      // P22 COMP-N N-2) so a re-read table regenerates it byte-exact (P22 fix F2c)
      // and the block reference lands it on the table's cell grid.
      for (const part of tableParts(tablePictureForm(t))) writeEntity(w, part, owner, state.blocks, undefined, extras);
    });
  }
  for (const { name, dimension } of dimPictures) {
    const owner = blockRecordHandles.get(name)!;
    blockShell(owner, name, { x: 0, y: 0 }, 1, undefined, () => {
      for (const part of dimensionParts(dimension)) writeEntity(w, { ...part, color: part.color === 'ByLayer' ? 0 : part.color } as Entity, owner, state.blocks);
    });
  }
  for (const d of dims3d) {
    const name = dim3dBlocks.get(d.id)!;
    const owner = blockRecordHandles.get(name)!;
    blockShell(owner, name, { x: 0, y: 0 }, 1, undefined, () => writeDimension3DPicture(w, d, owner));
  }
  w.pair(0, 'ENDSEC');

  // ENTITIES
  w.pair(0, 'SECTION');
  w.pair(2, 'ENTITIES');
  for (const e of state.entities) writeEntityAnno(w, e, MODEL_SPACE, state.blocks, dimBlocks, extras);
  // The first layout's paper space (VIEWPORTs + entities, group 67 = 1).
  if (layoutPlan.records[0]) writeLayoutContent(w, layoutPlan.records[0], writePaperEntity, layerHandles);
  // Unknown model-space records kept from the source file, verbatim apart from a new handle and owner.
  for (const r of rawRecords) {
    w.pair(0, r.type);
    w.pair(5, w.nextHandle());
    w.pair(330, MODEL_SPACE);
    for (const [code, value] of r.groups) w.pair(code, value);
  }
  // Experimental 3D solids: one polyface mesh (or several for a very large mesh) each, in model space.
  const solidNodes = new Map<string, CadNode[]>();
  for (const node of state.cadGraph?.nodes ?? []) if (node.anchor?.kind === 'solid3d') {
    const list = solidNodes.get(node.anchor.id);
    if (list) list.push(node); else solidNodes.set(node.anchor.id, [node]);
  }
  for (const s of solids) if (!writeRetainedSolid(w, state, s, MODEL_SPACE, solidNodes.get(s.id) ?? [])) writeSolid(w, s, MODEL_SPACE);
  // Experimental true 3D dimensions: DIMENSIONs in their planes (OCS), with JCAD_3D data.
  for (const d of dims3d) writeDimension3D(w, d, MODEL_SPACE, dim3dBlocks.get(d.id)!);
  w.pair(0, 'ENDSEC');

  // OBJECTS: root dictionary with the mandatory ACAD_GROUP entry
  if (createCannoVariable || createAnnoVariable) {
    variableDictionary = w.nextHandle();
    if (createCannoVariable) cannoVariable = w.nextHandle();
    if (createAnnoVariable) annoVariable = w.nextHandle();
  }
  // Allocated here too — never at plan time (the structuralKeys invariant above).
  if (createScaleList) {
    scaleListDictionary = w.nextHandle();
    scaleObject = w.nextHandle();
  }
  // P18 FIX group 1: the mleader scale creations this write owns get their
  // handles here as well (and the dictionary handle when the write must
  // force a scale list for them — no cannoscale list, no retained graph).
  const mleaderScaleHandles = new Map<string, string>();
  if (mleaderCreationsHere && mleaderScaleCreations.size) {
    if (!scaleListDictionary) scaleListDictionary = w.nextHandle();
    for (const name of mleaderScaleCreations.keys()) mleaderScaleHandles.set(name, w.nextHandle());
  }
  w.pair(0, 'SECTION');
  w.pair(2, 'OBJECTS');
  w.pair(0, 'DICTIONARY');
  w.pair(5, 'C');
  w.pair(330, '0');
  w.pair(100, 'AcDbDictionary');
  w.pair(281, 1);
  w.pair(3, 'ACAD_GROUP');
  w.pair(350, 'D');
  w.pair(3, 'ACAD_LAYOUT');
  w.pair(350, layoutPlan.dictionary);
  w.pair(3, 'ACAD_PLOTSTYLENAME');
  w.pair(350, plotStyleDictionary);
  if (tableStyleDict) {
    w.pair(3, 'ACAD_TABLESTYLE');
    w.pair(350, tableStyleDict);
  }
  if (scaleListDictionary) {
    w.pair(3, 'ACAD_SCALELIST');
    w.pair(350, scaleListDictionary);
  }
  if (imageDict) {
    w.pair(3, 'ACAD_IMAGE_DICT');
    w.pair(350, imageDict);
  }
  for (const kind of ['pdf', 'dwf', 'dgn'] as const) {
    const dict = underlayDefDicts.get(kind);
    if (!dict) continue;
    w.pair(3, kind === 'pdf' ? 'ACAD_PDFDEFINITIONS' : kind === 'dwf' ? 'ACAD_DWFDEFINITIONS' : 'ACAD_DGNDEFINITIONS');
    w.pair(350, dict);
  }
  if (mleaderDict) {
    w.pair(3, 'ACAD_MLEADERSTYLE');
    w.pair(350, mleaderDict);
  }
  if (variableDictionary) {
    // AutoCAD keeps the variable dictionary as the root dictionary's last entry.
    w.pair(3, 'AcDbVariableDictionary');
    w.pair(350, variableDictionary);
  }
  w.pair(0, 'DICTIONARY');
  w.pair(5, 'D');
  w.pair(330, 'C');
  w.pair(100, 'AcDbDictionary');
  w.pair(281, 1);
  writeLayoutObjects(w, layoutPlan, MODEL_SPACE, 'C');
  w.pair(0, 'ACDBDICTIONARYWDFLT');
  w.pair(5, plotStyleDictionary);
  w.pair(330, 'C');
  w.pair(100, 'AcDbDictionary');
  w.pair(281, 1);
  w.pair(3, 'Normal');
  w.pair(350, normalPlotStyle);
  w.pair(100, 'AcDbDictionaryWithDefault');
  w.pair(340, normalPlotStyle);
  w.pair(0, 'ACDBPLACEHOLDER');
  w.pair(5, normalPlotStyle);
  w.pair(330, plotStyleDictionary);
  if (variableDictionary) {
    // The variable dictionary and its DICTIONARYVARs, in AutoCAD's exact shape.
    w.pair(0, 'DICTIONARY');
    w.pair(5, variableDictionary);
    w.pair(330, 'C');
    w.pair(100, 'AcDbDictionary');
    w.pair(281, 1);
    if (cannoVariable) { w.pair(3, 'CANNOSCALE'); w.pair(350, cannoVariable); }
    if (annoVariable) { w.pair(3, 'ANNOALLVISIBLE'); w.pair(350, annoVariable); }
    const dictionaryVariable = (handle: string, val: string) => {
      w.pair(0, 'DICTIONARYVAR');
      w.pair(5, handle);
      w.pair(102, '{ACAD_REACTORS');
      w.pair(330, variableDictionary);
      w.pair(102, '}');
      w.pair(330, variableDictionary);
      w.pair(100, 'DictionaryVariables');
      w.pair(280, 0);
      w.pair(1, val);
    };
    if (cannoVariable) dictionaryVariable(cannoVariable, state.header!.cannoscale!);
    if (annoVariable) dictionaryVariable(annoVariable, '0');
  }
  if (scaleListDictionary && (scaleObject || mleaderScaleHandles.size)) {
    // Specimen shape (N1 AC1032 / Q10 AC1015 / Q12 AC1032 HANDBUILT fixtures): a
    // plain DICTIONARY owned by the root named-objects dictionary, its entries
    // keyed from 'A0' — the first key of AutoCAD's A0..D2 sequence. The first
    // entry is the SCALE object for the current annotation scale when this
    // write creates one; P18 FIX group 1's mleader creations follow in plan
    // order. Groups 140/141 carry the ratio parsed from the scale name (paper
    // units / drawing units, formatted as AutoCAD writes them); group 290
    // marks the unit scale 1:1.
    w.pair(0, 'DICTIONARY');
    w.pair(5, scaleListDictionary);
    w.pair(330, 'C');
    w.pair(100, 'AcDbDictionary');
    w.pair(281, 1);
    let keyIndex = 0;
    const nextKey = (): string => {
      const key = keyIndex < 260 ? `${String.fromCharCode(65 + Math.floor(keyIndex / 10))}${keyIndex % 10}` : `S${keyIndex}`;
      keyIndex += 1;
      return key;
    };
    if (scaleObject) {
      w.pair(3, nextKey());
      w.pair(350, scaleObject);
    }
    for (const handle of mleaderScaleHandles.values()) {
      w.pair(3, nextKey());
      w.pair(350, handle);
    }
    const scaleRecord = (handle: string, name: string, ratio: { numerator: string; denominator: string; unit: boolean }) => {
      w.pair(0, 'SCALE');
      w.pair(5, handle);
      w.pair(102, '{ACAD_REACTORS');
      w.pair(330, scaleListDictionary);
      w.pair(102, '}');
      w.pair(330, scaleListDictionary);
      w.pair(100, 'AcDbScale');
      w.pair(70, 0);
      w.pair(300, name);
      w.pair(140, ratio.numerator);
      w.pair(141, ratio.denominator);
      w.pair(290, ratio.unit ? 1 : 0);
    };
    if (scaleObject && scaleRatio) scaleRecord(scaleObject, state.header!.cannoscale!, scaleRatio);
    for (const [name, handle] of mleaderScaleHandles) scaleRecord(handle, name, mleaderScaleCreations.get(name)!);
  }
  if (imageDict) {
    w.pair(0, 'DICTIONARY');
    w.pair(5, imageDict);
    w.pair(330, 'C');
    w.pair(100, 'AcDbDictionary');
    w.pair(281, 1);
    const used = new Set<string>();
    for (const [path, def] of extras.imageDefs) {
      const stem = (path.split(/[\\/]/).pop() || 'IMAGE').replace(/\.[^.]*$/, '') || 'IMAGE';
      let key = stem;
      for (let n = 2; used.has(key.toUpperCase()); n += 1) key = `${stem}_${n}`;
      used.add(key.toUpperCase());
      w.pair(3, key);
      w.pair(350, def);
    }
    for (const [path, def] of extras.imageDefs) {
      const users = [...extras.imageReactors.entries()].filter(([img]) => img.path === path);
      const first = users[0]?.[0];
      w.pair(0, 'IMAGEDEF');
      w.pair(5, def);
      w.pair(102, '{ACAD_REACTORS');
      w.pair(330, imageDict);
      for (const [, r] of users) w.pair(330, r.reactor);
      w.pair(102, '}');
      w.pair(330, imageDict);
      w.pair(100, 'AcDbRasterImageDef');
      w.pair(90, 0);
      w.pair(1, path);
      w.pair(10, first?.size.x ?? 1);
      w.pair(20, first?.size.y ?? 1);
      w.pair(11, 1);
      w.pair(21, 1);
      w.pair(280, 1);
      w.pair(281, 0);
    }
    for (const [, r] of extras.imageReactors) {
      w.pair(0, 'IMAGEDEF_REACTOR');
      w.pair(5, r.reactor);
      w.pair(330, r.image ?? '0');
      w.pair(100, 'AcDbRasterImageDefReactor');
      w.pair(90, 2);
      w.pair(330, r.image ?? '0');
    }
  }
  if (tableStyleDict) {
    // The ACAD_TABLESTYLE dictionary and its synthesized TABLESTYLE objects (P22 slice 1).
    // Cell styles in AutoCAD order: data, title, header; border/fill groups carry the
    // Standard defaults (visible borders, lineweight -2, no fill) — the model's cells do
    // not carry border/fill data in this slice, and each cell's height/attachment is
    // written on the ACAD_TABLE itself, so the style only supplies margins and defaults.
    w.pair(0, 'DICTIONARY');
    w.pair(5, tableStyleDict);
    w.pair(330, 'C');
    w.pair(100, 'AcDbDictionary');
    w.pair(281, 1);
    for (const style of tableStylesToWrite) {
      w.pair(3, style.name);
      w.pair(350, style.handle);
    }
    const cellStyle = (height: number, attachment: number) => {
      w.pair(7, 'Standard');
      w.pair(140, height);
      w.pair(170, attachment);
      w.pair(62, 0);
      w.pair(63, 7);
      w.pair(283, 0);
      // AutoCAD normalises this row-type group from 512 to 4 when it resaves a
      // table (the lead's Recipe A resave at the P22 gate); write the normalised
      // value directly (P22 COMP-N Series 2).
      w.pair(90, 4);
      w.pair(91, 0);
      w.pair(1, '');
      for (let i = 0; i < 6; i += 1) w.pair(274 + i, -2);
      for (let i = 0; i < 6; i += 1) w.pair(284 + i, 1);
      for (let i = 0; i < 6; i += 1) w.pair(64 + i, 0);
    };
    for (const style of tableStylesToWrite) {
      w.pair(0, 'TABLESTYLE');
      w.pair(5, style.handle);
      w.pair(102, '{ACAD_REACTORS');
      w.pair(330, tableStyleDict);
      w.pair(102, '}');
      w.pair(330, tableStyleDict);
      w.pair(100, 'AcDbTableStyle');
      w.pair(280, 0);
      w.pair(3, style.name);
      w.pair(70, 0);
      w.pair(71, 0);
      w.pair(40, style.margin);
      w.pair(41, style.margin);
      w.pair(280, 0);
      w.pair(281, 0);
      cellStyle(style.dataHeight, 2);
      cellStyle(style.titleHeight, 5);
      cellStyle(style.dataHeight, 5);
    }
  }
  // The generated AC1015 roundtrip chains (P22 F-2 successor), one per table
  // whose plan carries one. The extension dictionary's owner is the table
  // entity's handle as written — recovered from the writer's anchor map,
  // which every entity written through writeEntityCommon populates.
  {
    const roundtrips = tableList.filter(([, picture]) => picture.roundtrip);
    if (roundtrips.length) {
      const entityHandleById = new Map<string, string>();
      for (const [handle, anchor] of w.cadAnchors) if (anchor.kind === 'entity') entityHandleById.set(anchor.id, handle);
      for (const [t, picture] of roundtrips) {
        const entityHandle = entityHandleById.get(t.id);
        if (!entityHandle) throw new Error(`Cannot write the roundtrip chain of table ${t.id}: its written entity handle is unknown.`);
        writeTableRoundtrip(w, t, picture.roundtrip!, entityHandle);
      }
    }
  }
  if (mleaderDict) {
    // P18: the ACAD_MLEADERSTYLE dictionary and its MLEADERSTYLE objects. The
    // style body mirrors the real AutoCAD R2018 specimen (tests/fixtures/
    // interchange/r2018-minsert.dxf, MLEADERSTYLE handle 16F) in group order,
    // with the style's effective values substituted at their documented
    // groups (Autodesk's MLEADERSTYLE reference): 170 content type, 42
    // landing gap, 43 dogleg length, 44 arrowhead size, 45 text height, 142
    // scale factor, 342 the text-style handle. Group 3 is the style
    // description (the specimen's reads 'Standard'); JCad writes it empty.
    // Groups 46 (align space), 47/49/140 (block-content scale), 141 (block
    // rotation), 271/272/273 (attachment directions) and 298 come from the
    // style data: retained source values win (V-1, AMENDMENT-P18-S2-A), the
    // specimen constants otherwise — byte-identical output whenever nothing
    // was retained. The remaining groups (91/92/93/94 colour words, 143
    // break gap) are carried over unchanged from the specimen and are not
    // claimed as modeled. The specimen's group 340 (leader linetype, a
    // TABLES handle JCad does not pre-allocate) is omitted; the default is
    // ByLayer.
    w.pair(0, 'DICTIONARY');
    w.pair(5, mleaderDict);
    w.pair(330, 'C');
    w.pair(100, 'AcDbDictionary');
    w.pair(281, 1);
    for (const [, data] of mleaderStyles) {
      w.pair(3, data.name);
      w.pair(350, w.mleaderStyleHandles.get(data.name.toUpperCase())!);
    }
    for (const [, data] of mleaderStyles) {
      const handle = w.mleaderStyleHandles.get(data.name.toUpperCase())!;
      const textStyleName = data.textStyleName;
      const textStyleHandle = w.textStyleHandles.get(textStyleName.toUpperCase());
      w.pair(0, 'MLEADERSTYLE');
      w.pair(5, handle);
      w.pair(102, '{ACAD_REACTORS');
      w.pair(330, mleaderDict);
      w.pair(102, '}');
      w.pair(330, mleaderDict);
      w.pair(100, 'AcDbMLeaderStyle');
      w.pair(179, 2);
      w.pair(170, data.contentType);
      w.pair(171, 1);
      w.pair(172, 0);
      w.pair(90, 2);
      w.pair(40, 0);
      w.pair(41, 0);
      w.pair(173, 1);
      w.pair(91, -1056964608);
      w.pair(92, -2);
      w.pair(290, 1);
      w.pair(42, data.landingGap);
      w.pair(291, 1);
      w.pair(43, data.doglegLength);
      w.pair(3, '');
      w.pair(44, data.arrowSize);
      w.pair(300, '');
      if (textStyleHandle) w.pair(342, textStyleHandle);
      w.pair(174, 1);
      w.pair(178, 6);
      w.pair(175, 1);
      w.pair(176, 0);
      w.pair(93, -1056964608);
      w.pair(45, data.textHeight);
      w.pair(292, 0);
      w.pair(297, 0);
      w.pair(46, data.alignSpace);
      w.pair(94, -1056964608);
      w.pair(47, data.blockScale.x);
      w.pair(49, data.blockScale.y);
      w.pair(140, data.blockScale.z);
      w.pair(293, 1);
      w.pair(141, data.blockRotation);
      w.pair(294, 1);
      w.pair(177, 0);
      w.pair(142, data.scaleFactor);
      w.pair(295, 0);
      w.pair(296, 0);
      w.pair(143, 0.125);
      w.pair(271, data.textAttachmentDirection);
      w.pair(272, data.bottomTextAttachmentDirection);
      w.pair(273, data.topTextAttachmentDirection);
      w.pair(298, data.flag298);
      // Slice 2: a block style names its content block record (343, last in the
      // reference's group listing). writeMLeader has already refused any block
      // whose record does not resolve in this file, so the handle exists.
      if (data.contentType === 1) {
        const blockHandle = data.blockName ? w.blockRecordHandles.get(data.blockName.toUpperCase()) : undefined;
        if (!blockHandle) throw new Error(`Cannot write MLEADERSTYLE "${data.name}": its content block "${data.blockName ?? ''}" has no block record in this file.`);
        w.pair(343, blockHandle);
      }
    }
  }
  if (mleaderContextObjectCount) {
    // P18 S3-D (Amendment 2 (ii)): the context-object chains, one per
    // multi-context native mleader, in allEntities order, immediately after
    // the MLEADERSTYLE block: extension dictionary -> manager dictionary ->
    // scales dictionary -> the context objects (the primary's first, then
    // the additionals in model order). Group order mirrors the lead's
    // AutoCAD 2027 fixtures group-for-group (facts F1/F3): the manager entry
    // is a 360 SOFT pointer, the scales entry and the scales dictionary's
    // '*A<n>' entries are 350 pointers, each object carries 70 = 4 and the
    // 290 default flag on the primary's object only. EVERY object's group
    // 340 (its SCALE reference) is written from the plan (P18 FIX group 1 —
    // the lead's native gate DISCARDED drawings whose objects lacked it,
    // superseding RULING-P18-S3-D (5)(vi)(beta)): the retained source SCALE
    // on re-save, the writer-created cannoscale SCALE, or a SCALE created
    // for an authored scale; a creation the merge pass owns is the only
    // case emitted without a 340 here, and preserveDxfCadGraph inserts it.
    for (const e of allEntities) {
      const chain = w.mleaderContextChains.get(e);
      if (!chain || e.type !== 'leader' || !e.mleader) continue;
      const entityHandle = w.reservedEntityHandles.get(e)!;
      const views = mleaderContextViews(e);
      let blockRecordHandle: string | undefined;
      if (e.mleader.contentType === 'block') {
        blockRecordHandle = w.blockRecordHandles.get(e.mleader.block!.name.toUpperCase());
        if (!blockRecordHandle) throw new Error(`Cannot write native MULTILEADER contexts: content block "${e.mleader.block!.name}" has no block record in this file.`);
      }
      // P18 FIX group 1: the group 340 for each object comes from the plan
      // (retained entry / cannoscale object / a creation this write owns);
      // a creation owned by the merge pass resolves to no handle here and
      // preserveDxfCadGraph inserts the 340 after creating the SCALE.
      const plans = mleaderScalePlans.get(e);
      const scaleHandleFor = (viewIndex: number): string | undefined => {
        const plan = plans?.[viewIndex];
        if (!plan) return undefined;
        if (plan.handle) return plan.handle;
        if (plan.cannoObject) return scaleObject ?? undefined;
        if (plan.createName) return mleaderScaleHandles.get(plan.createName);
        return undefined;
      };
      const emitObject = (v: (typeof views)[number], i: number): void => {
        w.pair(0, 'ACDB_MLEADEROBJECTCONTEXTDATA_CLASS');
        w.pair(5, chain.objects[i]!);
        w.pair(102, '{ACAD_REACTORS');
        w.pair(330, chain.scales);
        w.pair(102, '}');
        w.pair(330, chain.scales);
        w.pair(100, 'AcDbObjectContextData');
        w.pair(70, 4);
        w.pair(290, i === 0 ? 1 : 0);
        w.pair(100, 'AcDbAnnotScaleObjectContextData');
        const scaleRef = scaleHandleFor(i);
        if (scaleRef) w.pair(340, scaleRef);
        // Group 40 is written ONCE, as the first group of the context body
        // emitMLeaderContext produces (P18 FIX group 1(c) — the annotative
        // header's 40; a second one here is what AutoCAD rejected).
        emitMLeaderContext(w, v, blockRecordHandle, false);
      };
      if (chain.carried) {
        // P18 FIX group 2: the retained dictionaries and the retained
        // objects are regenerated in place by preserveDxfCadGraph — the
        // writer emits only the model's growth objects beyond the retained
        // count, owned by the retained scales dictionary (chain.scales is
        // its retained handle; the merge lists them in it).
        const retainedCount = mleaderCarriers.get(e.id)?.objects.length ?? 0;
        views.forEach((v, i) => {
          if (i >= retainedCount) emitObject(v, i);
        });
        continue;
      }
      // Extension dictionary (owner: the entity itself).
      w.pair(0, 'DICTIONARY');
      w.pair(5, chain.extension);
      w.pair(330, entityHandle);
      w.pair(100, 'AcDbDictionary');
      w.pair(280, 1);
      w.pair(281, 1);
      w.pair(3, 'AcDbContextDataManager');
      w.pair(360, chain.manager);
      // Manager dictionary (owner/reactor: the extension dictionary).
      w.pair(0, 'DICTIONARY');
      w.pair(5, chain.manager);
      w.pair(102, '{ACAD_REACTORS');
      w.pair(330, chain.extension);
      w.pair(102, '}');
      w.pair(330, chain.extension);
      w.pair(100, 'AcDbDictionary');
      w.pair(281, 1);
      w.pair(3, 'ACDB_ANNOTATIONSCALES');
      w.pair(350, chain.scales);
      // Scales dictionary (owner/reactor: the manager dictionary).
      w.pair(0, 'DICTIONARY');
      w.pair(5, chain.scales);
      w.pair(102, '{ACAD_REACTORS');
      w.pair(330, chain.manager);
      w.pair(102, '}');
      w.pair(330, chain.manager);
      w.pair(100, 'AcDbDictionary');
      w.pair(281, 1);
      views.forEach((v, i) => {
        w.pair(3, `*A${i + 1}`);
        w.pair(350, chain.objects[i]!);
      });
      // The context objects themselves, in the same (dictionary) order.
      views.forEach((v, i) => emitObject(v, i));
    }
  }
  // Underlay definitions in OBJECTS, through the codec (RULING-P28 C8): the
  // stored path is emitted verbatim, never normalised or resolved. The
  // writer owns the record handle (5) and the owner (330: the named-objects
  // dictionary, handle 'C' as elsewhere in this writer) — codec copies of
  // those are skipped; the codec's 100 AcDbUnderlayDefinition marker IS
  // written (v0.6.4 review F-F: a definition without it made AutoCAD
  // discard the drawing, "Class separator for class AcDbUnderlayDefinition
  // expected").
  // B-2: the per-kind definitions dictionary (AutoCAD's layout: owner the
  // root, no reactors block, one "<stem> - <page>" entry per definition),
  // then each definition owned by and reacting to it. B-3: a definition
  // record carries ONLY the spec groups (5, reactors, 330, 100, 1, 2) —
  // AutoCAD's sequential reader discards the drawing on an unknown group
  // after 1 / 2, and the only realistic source of one is a pre-fix JCad
  // save ("90 7").
  for (const kind of ['pdf', 'dwf', 'dgn'] as const) {
    const dict = underlayDefDicts.get(kind);
    if (!dict) continue;
    w.pair(0, 'DICTIONARY');
    w.pair(5, dict);
    w.pair(330, 'C');
    w.pair(100, 'AcDbDictionary');
    w.pair(281, 1);
    for (const def of underlayDefs) {
      if (def.kind !== kind) continue;
      w.pair(3, underlayDefEntryNames.get(def.id)!);
      w.pair(350, extras.underlayDefHandles.get(def.id)!);
    }
  }
  for (const def of underlayDefs) {
    const dict = underlayDefDicts.get(def.kind)!;
    w.pair(0, underlayDefinitionDxfType(def.kind));
    w.pair(5, extras.underlayDefHandles.get(def.id)!);
    w.pair(102, '{ACAD_REACTORS');
    w.pair(330, dict);
    w.pair(102, '}');
    w.pair(330, dict);
    for (const [code, value] of writeUnderlayDefinition({ ...def, retainedGroups: [] })) {
      if (code === 5 || code === 330) continue;
      w.pair(code, value);
    }
  }
  w.pair(0, 'ENDSEC');
  w.pair(0, 'EOF');
  // The handle seed must exceed every handle used in the file.
  // AC1015 is read in the $DWGCODEPAGE page: non-ASCII goes out as \U+XXXX escapes (see io/encoding.ts).
  // P17 R1: with every record's handle final, complete the boundary-side
  // back-pointers ({ACAD_REACTORS -> hatch}) for associative hatches.
  const graphState = mleaderContextObjectCount || mleaderChainsWithheldCount ? graphWithoutModelledContextChains(state, w, allEntities) : state;
  const plain = ensureAssociativeHatchReactors(preserveDxfCadGraph(w.toString(), anchorRemapByNode.size > 0 ? withAnchorHandleRemap(graphState, anchorRemapByNode) : graphState, w.cadAnchors));
  return encodeDxfText(plain.replace('HANDSEED_PLACEHOLDER', (w.lastHandle() + 1).toString(16).toUpperCase()), acadVersion);
}
