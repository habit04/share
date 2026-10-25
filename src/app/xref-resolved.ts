/**
 * Priority 20, slice 1 — the resolved-snapshot lookup contract (design
 * section 3 + addendum A.2). Pure: a function of (snapshot, stamp, host
 * state) only. Nothing here mutates the snapshot, the host state, or any
 * file; nothing is written into the host's symbol tables.
 *
 * Materialisation: for every loaded file, one scoped def per block def,
 * named with the section 3.2 pattern (a control character, the file key,
 * the block name) and held in a Map — the names are never parsed back.
 * For every loaded root node, one root def keyed by the host block name
 * whose entities are the file's model-space entities rewritten in that
 * file's namespace. A reference whose node did not load gets the
 * containing file's own scoped def with empty entities and its xref
 * record intact, so core expansion draws the existing named placeholder
 * at every depth.
 *
 * Layers are source-local (A.2): there is no merged layer list anywhere
 * in this contract. `fileLayers(fileKey)` returns the file's own layer
 * records verbatim from the sealed snapshot; each synthesised def's
 * source file is recorded so a consumer can resolve an entity's layer
 * against the table of the file it was materialised from.
 */
import type { DrawingState, Layer } from '../core/document';
import type { BlockDef, BlockLookup, Entity } from '../core/entities';
import { sealImmutableData } from '../core/immutable-data';
import type { XrefNode, XrefSnapshot } from '../io/xref-loading';

export interface XrefSessionStamp {
  readonly docId: string;
  readonly contentGeneration: number | string;
}

export interface ResolvedXrefContext {
  readonly snapshot: XrefSnapshot;
  readonly generation: number;
  readonly stamp: XrefSessionStamp;
  /** Wrap a host (or any base) lookup with this snapshot's resolved defs. Memoised per base. */
  lookup(base: BlockLookup): BlockLookup;
  /** The referenced file's own layer records, verbatim from the sealed snapshot. Unknown key: []. */
  fileLayers(fileKey: string): readonly Layer[];
  /** First node with this block name in snapshot traversal order (roots first), else undefined. */
  nodeFor(blockName: string): XrefNode | undefined;
  /** Root def names (snapshot order) followed by scoped def names (materialisation order). */
  resolvedNames(): readonly string[];
  /** The file a synthesised def's content was materialised from; undefined for host defs. */
  sourceFileKeyForDef(defName: string): string | undefined;
  /** Typed unsupported-feature reasons for a node (addendum A.3), e.g. 'xclip-not-applied'. */
  unsupportedFeaturesFor(blockName: string): readonly string[];
}

const SCOPED_PREFIX = '\u0001xref:';
const scopedName = (fileKey: string, blockName: string): string => `${SCOPED_PREFIX}${fileKey}:${blockName}`;
/** The model space of a loaded file, materialised as a def of that file so every parent referencing the file shares the identical def object (the C6 diamond rule). */
const MODEL_SPACE = '*Model_Space';

/**
 * Unsupported-feature detection (XCLIP / fade) — HELD under the Codex 414
 * ruling until the coordinator confirms the detection design note
 * (p20-logs/m56-detection-design.md). The note's channel evidence shows
 * detection reads the retained cad graph; no parser/model field is added.
 * Until the hold lifts this returns an empty map, the withholding branch
 * in materialise() never fires, and M5/M6 stay NOTRUN — they are never
 * silently treated as supported.
 */
function detectUnsupportedFeatures(_snapshot: XrefSnapshot, _hostState: DrawingState): ReadonlyMap<XrefNode, string> {
  return new Map();
}

interface Built {
  readonly rootDefs: ReadonlyMap<string, BlockDef>;
  readonly scopedDefs: ReadonlyMap<string, BlockDef>;
  readonly defSource: ReadonlyMap<string, string>;
  readonly unsupported: ReadonlyMap<XrefNode, string>;
}

function materialise(snapshot: XrefSnapshot, hostState: DrawingState): Built {
  const unsupported = detectUnsupportedFeatures(snapshot, hostState);
  const rootDefs = new Map<string, BlockDef>();
  const scopedDefs = new Map<string, BlockDef>();
  const defSource = new Map<string, string>();

  // References of each containing scope: the host's roots, and each loaded
  // file's outgoing references (its snapshot children), by block name.
  const refsOf = new Map<string, ReadonlyMap<string, XrefNode>>();
  const rootByName = new Map<string, XrefNode>();
  for (const node of snapshot.nodes) if (!rootByName.has(node.blockName)) rootByName.set(node.blockName, node);
  refsOf.set('', rootByName);
  const fileOrder: string[] = [];
  const seenFiles = new Set<string>();
  const walk = (node: XrefNode): void => {
    if (node.status === 'loaded' && node.fileKey) {
      if (!seenFiles.has(node.fileKey)) { seenFiles.add(node.fileKey); fileOrder.push(node.fileKey); }
      const children = new Map<string, XrefNode>();
      for (const child of node.children) if (!children.has(child.blockName)) children.set(child.blockName, child);
      refsOf.set(node.fileKey, children);
    }
    for (const child of node.children) walk(child);
  };
  for (const node of snapshot.nodes) walk(node);

  const fileState = (fileKey: string): DrawingState | undefined => snapshot.files[fileKey]?.state;

  // Shallow-copy insert entities only; every other entity is shared by
  // reference. An insert naming a reference of the containing file is
  // rewritten per its snapshot node (design 3.2 step 4): loaded -> the
  // nested file's model-space def (keyed by the NESTED file, so every
  // parent shares it); any other status -> the containing file's own
  // scoped def for that block (the placeholder def below). An insert
  // naming an ordinary block of the file is rewritten to that block's
  // scoped def. A name the file does not define is left verbatim (it
  // expands to nothing).
  const rewrite = (entities: readonly Entity[], fileKey: string): Entity[] => {
    const state = fileState(fileKey);
    if (!state) return [...entities];
    const refs = refsOf.get(fileKey) ?? new Map<string, XrefNode>();
    return entities.map((entity) => {
      if (entity.type !== 'insert') return entity;
      const node = refs.get(entity.block);
      if (node) {
        return node.status === 'loaded' && node.fileKey && !unsupported.has(node)
          ? { ...entity, block: scopedName(node.fileKey, MODEL_SPACE) }
          : { ...entity, block: scopedName(fileKey, entity.block) };
      }
      if (state.blocks[entity.block] !== undefined) {
        return { ...entity, block: scopedName(fileKey, entity.block) };
      }
      return entity;
    });
  };

  // Scoped defs: per loaded file (node-encounter order) — first the
  // file's model space as a def of that file, then per block def
  // (block-record order). A block that is itself a reference gets the
  // placeholder form here (empty entities, its xref record intact): it
  // is the expansion target exactly when its node did not load; a loaded
  // node's content is reached through the model-space def above.
  for (const fileKey of fileOrder) {
    const state = fileState(fileKey)!;
    const refs = refsOf.get(fileKey) ?? new Map<string, XrefNode>();
    const modelDef: BlockDef = {
      name: scopedName(fileKey, MODEL_SPACE),
      basePoint: { x: 0, y: 0 },
      entities: rewrite(state.entities, fileKey),
      attributes: [],
    };
    scopedDefs.set(modelDef.name, sealImmutableData(modelDef));
    defSource.set(modelDef.name, fileKey);
    for (const block of Object.values(state.blocks)) {
      const name = scopedName(fileKey, block.name);
      const def: BlockDef = refs.has(block.name)
        ? { ...block, name, entities: [] }
        : { ...block, name, entities: rewrite(block.entities, fileKey) };
      scopedDefs.set(name, sealImmutableData(def));
      defSource.set(name, fileKey);
    }
  }

  // Root defs: per loaded root node (snapshot order), keyed by the host
  // block name; the host block supplies basePoint and its other fields,
  // the file supplies the content. Host-owned containers are copied
  // before sealing so the host state is never frozen or touched.
  for (const node of snapshot.nodes) {
    if (node.status !== 'loaded' || !node.fileKey) continue;
    const hostBlock = hostState.blocks[node.blockName];
    const file = fileState(node.fileKey);
    if (!hostBlock || !file) continue;
    const def: BlockDef = {
      ...hostBlock,
      basePoint: { ...hostBlock.basePoint },
      entities: unsupported.has(node) ? [] : rewrite(file.entities, node.fileKey),
      attributes: hostBlock.attributes.map((attribute) => ({
        ...attribute,
        ...(attribute.position ? { position: { ...attribute.position } } : {}),
      })),
      ...(hostBlock.xref ? { xref: { ...hostBlock.xref } } : {}),
    };
    rootDefs.set(node.blockName, sealImmutableData(def, hostBlock.dynamic ? new Set(['dynamic']) : undefined));
    defSource.set(node.blockName, node.fileKey);
  }

  return { rootDefs, scopedDefs, defSource, unsupported };
}

const contextCache = new WeakMap<XrefSnapshot, Map<string, ResolvedXrefContext>>();

/**
 * Build (or return the memoised) resolved context for one snapshot under
 * one session stamp. Pure and memoised on snapshot identity + stamp
 * values: the same inputs yield the identical context object, so def
 * identity is stable for the expansion cache's depsCurrent validation.
 */
export function buildResolvedXrefContext(snapshot: XrefSnapshot, stamp: XrefSessionStamp, hostState: DrawingState): ResolvedXrefContext {
  const stampKey = `${stamp.docId}\n${String(stamp.contentGeneration)}`;
  let byStamp = contextCache.get(snapshot);
  if (!byStamp) { byStamp = new Map(); contextCache.set(snapshot, byStamp); }
  const existing = byStamp.get(stampKey);
  if (existing) return existing;

  const built = materialise(snapshot, hostState);
  const lookupCache = new WeakMap<BlockLookup, BlockLookup>();
  const nodesByName = new Map<string, XrefNode>();
  const collect = (node: XrefNode): void => {
    if (!nodesByName.has(node.blockName)) nodesByName.set(node.blockName, node);
    for (const child of node.children) collect(child);
  };
  for (const node of snapshot.nodes) collect(node);
  const names: readonly string[] = [...built.rootDefs.keys(), ...built.scopedDefs.keys()];

  const context: ResolvedXrefContext = {
    snapshot,
    generation: snapshot.generation,
    stamp,
    lookup(base: BlockLookup): BlockLookup {
      const cached = lookupCache.get(base);
      if (cached) return cached;
      const wrapped = ((name: string) => {
        const root = built.rootDefs.get(name);
        if (root) return root;
        if (hostState.blocks[name] !== undefined) return base(name);
        const scoped = built.scopedDefs.get(name);
        if (scoped) return scoped;
        return base(name);
      }) as BlockLookup;
      Object.defineProperty(wrapped, 'textGeometry', { value: base.textGeometry, enumerable: true });
      lookupCache.set(base, wrapped);
      return wrapped;
    },
    fileLayers(fileKey: string): readonly Layer[] {
      return snapshot.files[fileKey]?.state.layers ?? [];
    },
    nodeFor(blockName: string): XrefNode | undefined {
      return nodesByName.get(blockName);
    },
    resolvedNames(): readonly string[] {
      return names;
    },
    sourceFileKeyForDef(defName: string): string | undefined {
      return built.defSource.get(defName);
    },
    unsupportedFeaturesFor(blockName: string): readonly string[] {
      const node = nodesByName.get(blockName);
      const reason = node ? built.unsupported.get(node) : undefined;
      return reason ? [reason] : [];
    },
  };
  byStamp.set(stampKey, context);
  return context;
}
