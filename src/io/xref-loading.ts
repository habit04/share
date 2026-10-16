/**
 * DXF external-reference (xref) loading and refresh core — milestone 20,
 * corrected in 20.1 following the lead review of the first candidate.
 *
 * What exists in the base application (v0.5.2) and is NOT changed here:
 * a DXF/DWG xref is a block definition carrying `xref: { path, overlay? }`
 * (BLOCK flags 4 / 8, path in group 1). The readers keep the record, the
 * writer writes it back, an unloaded reference draws a named dashed frame,
 * and EXPLODE refuses it. No code resolved the path or loaded the file:
 * docs/SUPPORT-MATRIX.md states "external files are not loaded".
 *
 * This module is that missing loader, kept deliberately separate from the
 * application: it has no filesystem access of its own, never mutates the
 * host drawing, never writes anything, and is not imported by any existing
 * file. A future integration supplies a permission-controlled adapter (for
 * example an Electron/IPC reader rooted at approved folders) and decides
 * what to do with a committed snapshot.
 *
 * Identity model (20.1): file identity, cycle detection and sharing come
 * from the injected adapter's `identify` step — a stable canonical file
 * identity, a stable owning location that anchors child resolution, and
 * optional content-version evidence. Lexical path equality is used only
 * as a documented fallback when the adapter supplies no identity, and is
 * never treated as authorization or as proof that two spellings name the
 * same file. Ancestry is seeded with the host identity, so a reference
 * back to the host is cut as a cycle on its first edge.
 *
 * Publication model (20.1): `XrefStore` stamps every attempt with a
 * request token and the store's generation/host epoch at its start, and
 * publishes only if all three are still current at publication time and
 * the attempt was not cancelled. A stale attempt — an older load that
 * finishes after a newer one, or any attempt spanning a host
 * replacement/closure — never overwrites the last good graph, even if
 * its reader ignored the abort signal. Published snapshots are deep
 * copies sealed with the existing immutable-data helper, so neither the
 * staged diagnostics nor retained parser references can mutate them.
 * A partial REFRESH never publishes: it returns the incomplete snapshot
 * as an inspection candidate and keeps the last good graph.
 *
 * Accounting (20.1): limits are checked in a fixed order — cancellation
 * and the declaration-edge budget run before every early return (empty
 * paths, suppressed overlays, cycles, depth and format refusals all
 * count as edges). Bytes are charged as DELIVERED: every byte a reader
 * returns is charged to the cumulative budget, including input that is
 * then rejected, and reads stop once the cumulative budget is spent.
 * The reader is told the remaining allowance for each read and
 * oversized/inconsistent responses are rejected. Entity accounting
 * covers model space, block definitions, paper-space layouts and
 * retained raw records. These limits bound the work this core accepts;
 * they are not process-memory caps, and the synchronous parser is not
 * preemptible once a parse has started.
 */
import type { DrawingState } from '../core/document';
import type { Entity, Layer } from '../core/entities';
import { sealImmutableData } from '../core/immutable-data';
import { isAbsolutePath, normalizePath, pathKey, resolveFromFile } from '../app/paths';
import { readDxf } from './dxf';

// ---------------------------------------------------------------------------
// References

/** One external reference as recorded in a drawing (path and flag verbatim). */
export interface XrefReferenceInput {
  /** Block name the reference is recorded under. */
  readonly blockName: string;
  /** The path exactly as stored in the drawing; never rewritten by the loader. */
  readonly path: string;
  /** True for an overlay reference (DXF BLOCK flag 8), false/absent for an attachment. */
  readonly overlay?: boolean;
}

/** The xref references recorded in a drawing state, in block-record order. */
export function collectXrefReferences(state: Pick<DrawingState, 'blocks'>): XrefReferenceInput[] {
  const out: XrefReferenceInput[] = [];
  for (const block of Object.values(state.blocks)) {
    if (!block.xref) continue;
    out.push({ blockName: block.name, path: block.xref.path, ...(block.xref.overlay ? { overlay: true } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Path handling — the renderer's existing lexical helpers (app/paths.ts).
// Lexical results locate a candidate file for the adapter; they are not
// identity and not authorization (see the module header).

/** Canonical lexical form of a CAD path (app/paths `normalizePath`). */
export const normalizeCadPath = normalizePath;

/** Lexical comparison key (app/paths `pathKey`). NOT a file identity. */
export const cadPathKey = pathKey;

/** A drive-relative path (`C:leaf.dxf`): relative to a per-drive working directory this core cannot know. */
export function isDriveRelativePath(path: string): boolean {
  return /^[A-Za-z]:(?![\\/])/.test(path);
}

/**
 * Resolve a stored reference path against the file that contains the
 * reference (its immediate host), using app/paths lexical rules.
 * Returns null when the reference cannot be anchored unambiguously:
 * a relative path with no containing location, or a drive-relative
 * path in either the reference or the containing location.
 */
export function resolveXrefPath(referencePath: string, containingFilePath: string | null): string | null {
  if (isDriveRelativePath(referencePath)) return null;
  if (isAbsolutePath(referencePath) || referencePath.startsWith('/') || referencePath.startsWith('\\')) return normalizePath(referencePath);
  if (containingFilePath === null || isDriveRelativePath(containingFilePath)) return null;
  return resolveFromFile(containingFilePath, referencePath);
}

// ---------------------------------------------------------------------------
// Injected access

/**
 * Adapter-supplied evidence about one file, obtained before any read.
 * `id` is the stable canonical identity used for sharing and cycles;
 * `owningLocation` is the stable absolute location child references
 * resolve against (which may differ from the requested spelling, e.g.
 * when the request came through a link or an alias); `version` is
 * optional content evidence — the same identity reporting two versions
 * inside one load is an inconsistent snapshot and is refused.
 */
export interface XrefFileIdentity {
  readonly id: string;
  readonly owningLocation: string;
  readonly version?: string;
}

/** What the adapter is told about an operation: enough to enforce and to log, nothing more. */
export interface XrefAdapterContext {
  readonly resolvedPath: string;
  /** The path exactly as stored in the referencing drawing. */
  readonly originalPath: string;
  readonly blockName: string;
  /** 1 for a reference of the root drawing, deeper for nested references. */
  readonly depth: number;
  readonly signal?: AbortSignal;
}

export interface XrefReadContext extends XrefAdapterContext {
  /**
   * Remaining allowance for this read, in bytes: the smaller of the
   * per-file limit and the unspent cumulative budget. Adapters should
   * refuse or truncate beyond it; the core verifies and charges whatever
   * is actually delivered.
   */
  readonly maxBytes: number;
}

/** A read result: bare text, or text with the adapter's byte/version evidence. */
export type XrefReadResult = string | { readonly text: string; readonly byteLength?: number; readonly version?: string };

/**
 * The only file access the loader has. Implementations are responsible
 * for permission control (approved roots, user grants, IPC admission in
 * the desktop host); the loader performs no I/O itself and cannot write.
 * Implementations should reject with an error carrying a Node-style
 * `code` (`ENOENT`, `EACCES`, `EPERM`, ...) and honour `signal`.
 *
 * `identify` is consulted before authorization and before any read of a
 * file. Returning null diagnoses the location as unavailable/ambiguous:
 * the file is not read. When `identify` is absent, identity falls back
 * to the lexical path key (see the module header for its limits).
 */
export interface XrefFileReader {
  identify?(resolvedPath: string, context: XrefAdapterContext): Promise<XrefFileIdentity | null>;
  readText(resolvedPath: string, context: XrefReadContext): Promise<XrefReadResult>;
}

/**
 * Optional second gate, consulted before every read (including nested
 * reads) when supplied. Returning false denies the read: the reader is
 * not called and the node is reported as `denied`. (The reader itself
 * may also refuse authoritatively — EACCES/EPERM rejections are likewise
 * reported as `denied`.)
 */
export type XrefAuthorize = (resolvedPath: string, context: XrefAdapterContext) => boolean | Promise<boolean>;

/** Bounds handed to the parser for one file, lowered from the caller's budgets. */
export interface XrefParseBounds {
  /** Source text length cap for the parser (the per-file byte budget: characters never exceed UTF-8 bytes). */
  readonly maxSourceLength: number;
}

/** Parse a referenced file. Defaults to the existing DXF reader; injectable for isolated tests. */
export type XrefParse = (text: string, resolvedPath: string, bounds: XrefParseBounds) => DrawingState;

export interface XrefLoaderDeps {
  readonly reader: XrefFileReader;
  readonly authorize?: XrefAuthorize;
  readonly parse?: XrefParse;
}

// ---------------------------------------------------------------------------
// Limits

export interface XrefLoadLimits {
  /** Deepest reference depth loaded (root references are depth 1). Default 8. */
  readonly maxDepth?: number;
  /**
   * Maximum declaration edges staged in one load: every reference node —
   * loaded, failed, suppressed, duplicate or cyclic — counts, checked
   * before any other per-edge outcome. Default 64. Fatal when exceeded.
   */
  readonly maxReferences?: number;
  /** Maximum distinct files (by adapter identity) staged in one load. Default 64. Fatal when exceeded. */
  readonly maxFiles?: number;
  /** Maximum UTF-8 byte length of one referenced file. Default 16 MiB. */
  readonly maxFileBytes?: number;
  /** Maximum cumulative delivered UTF-8 bytes in one load, rejected input included. Default 64 MiB. Fatal when spent. */
  readonly maxTotalBytes?: number;
  /** Maximum counted entities (model + blocks + layouts + retained raw records) in one file. Default 200,000. */
  readonly maxEntitiesPerFile?: number;
  /** Maximum cumulative counted entities over distinct loaded files. Default 500,000. Fatal when exceeded. */
  readonly maxTotalEntities?: number;
}

export const DEFAULT_XREF_LOAD_LIMITS: Required<XrefLoadLimits> = {
  maxDepth: 8,
  maxReferences: 64,
  maxFiles: 64,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntitiesPerFile: 200_000,
  maxTotalEntities: 500_000,
};

function resolveLimits(limits: XrefLoadLimits | undefined): Required<XrefLoadLimits> {
  const out = { ...DEFAULT_XREF_LOAD_LIMITS, ...(limits ?? {}) };
  for (const [name, value] of Object.entries(out)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`xref limit ${name} must be a positive integer, got ${String(value)}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Results

export type XrefNodeStatus =
  | 'loaded'
  | 'missing'
  | 'denied'
  | 'read-error'
  | 'parse-error'
  | 'unsupported-format'
  | 'unresolved-path'
  | 'unresolved-location'
  | 'inconsistent-version'
  | 'inconsistent-location'
  | 'inconsistent-response'
  | 'cycle'
  | 'depth-limit'
  | 'file-limit'
  | 'not-carried-overlay';

export type XrefFailureKind = XrefNodeStatus | 'cancelled' | 'total-limit';

export interface XrefFailure {
  readonly kind: XrefFailureKind;
  readonly blockName: string;
  /** The path exactly as stored in the referencing drawing. */
  readonly originalPath: string;
  readonly resolvedPath: string | null;
  readonly depth: number;
  readonly message: string;
  /** For `cycle`: the location chain from the ancestor (or host) down to the repeated file. */
  readonly chain?: readonly string[];
}

/** One reference occurrence in the staged tree. Occurrence context lives here, never on the shared file record. */
export interface XrefNode {
  readonly blockName: string;
  /** Verbatim stored path; never rewritten. */
  readonly originalPath: string;
  readonly resolvedPath: string | null;
  readonly overlay: boolean;
  readonly depth: number;
  readonly status: XrefNodeStatus;
  readonly message?: string;
  /** Key into `XrefSnapshot.files` (an adapter identity key) when this occurrence's file was loaded. */
  readonly fileKey?: string;
  readonly children: readonly XrefNode[];
}

/** One place a shared file was referenced from. */
export interface XrefOccurrence {
  readonly blockName: string;
  readonly originalPath: string;
  readonly resolvedPath: string;
  readonly depth: number;
}

/** A distinct referenced file that was read and parsed, held apart from the host drawing. */
export interface XrefLoadedFile {
  /** Identity key: `id:<adapter identity>` or, without an adapter identity, `path:<lexical key>`. */
  readonly key: string;
  /** The adapter-supplied stable owning location (the requested resolved path when no identity was supplied). */
  readonly owningLocation: string;
  /** Adapter content-version evidence, when supplied. */
  readonly version?: string;
  readonly byteLength: number;
  /** Model-space + block-definition + paper-space layout entities. */
  readonly entityCount: number;
  /** Retained unsupported raw records (`meta.dxfRawEntities`), counted toward the entity budget. */
  readonly retainedRecords: number;
  /** Every occurrence that referenced this file, in encounter order. */
  readonly occurrences: readonly XrefOccurrence[];
  /**
   * The parsed drawing of the referenced file. This is external content:
   * it is not part of the host drawing's state, is never merged into it,
   * and must not be written back to the host or the referenced file.
   */
  readonly state: DrawingState;
  /** The references this file itself records (its nested references), verbatim. */
  readonly references: readonly XrefReferenceInput[];
}

export interface XrefSnapshotStats {
  /** Declaration edges staged (every node, including failed/suppressed/duplicate ones). */
  readonly referencesSeen: number;
  readonly filesLoaded: number;
  /** UTF-8 bytes delivered by the reader and charged, rejected input included. */
  readonly bytesDelivered: number;
  /** UTF-8 bytes of the distinct files that loaded. */
  readonly loadedBytes: number;
  /** Counted entities over distinct loaded files. */
  readonly totalEntities: number;
}

/** A complete staging result. Snapshots returned by this module are sealed (runtime-immutable). */
export interface XrefSnapshot {
  /** Store generation that committed this snapshot (0 for a bare staged load). */
  readonly generation: number;
  readonly hostPath: string | null;
  /** Adapter identity of the host, when known. */
  readonly hostIdentity?: string;
  readonly nodes: readonly XrefNode[];
  readonly files: Readonly<Record<string, XrefLoadedFile>>;
  readonly failures: readonly XrefFailure[];
  readonly stats: XrefSnapshotStats;
}

/** External entities with their provenance, for a consumer that renders or inspects them. */
export interface XrefExternalContent {
  readonly node: XrefNode;
  readonly file: XrefLoadedFile;
  readonly entities: readonly Entity[];
  readonly layers: readonly Layer[];
}

/**
 * Flatten a snapshot to the loaded external content, one entry per
 * reference occurrence (a file referenced twice appears twice, sharing
 * the same parsed state). INSERT placement (position / scale / rotation /
 * the block base point) is the consuming application's job and is
 * deliberately not applied here.
 */
export function externalContent(snapshot: XrefSnapshot): XrefExternalContent[] {
  const out: XrefExternalContent[] = [];
  const walk = (nodes: readonly XrefNode[]): void => {
    for (const node of nodes) {
      if (node.status === 'loaded' && node.fileKey) {
        const file = snapshot.files[node.fileKey];
        if (file) out.push({ node, file, entities: file.state.entities, layers: file.state.layers });
      }
      walk(node.children);
    }
  };
  walk(snapshot.nodes);
  return out;
}

// ---------------------------------------------------------------------------
// Loading

export interface XrefLoadInput {
  /** The host drawing's state (its recorded references are the load roots). Mutually exclusive with `references`. */
  readonly hostState?: Pick<DrawingState, 'blocks'>;
  /** Explicit reference list, for callers that already extracted them. */
  readonly references?: readonly XrefReferenceInput[];
  /** Path of the host file the references were recorded in; anchors relative resolution. */
  readonly hostPath?: string | null;
  /** Adapter identity of the host, when the caller already holds it (skips re-identifying the host). */
  readonly hostIdentity?: XrefFileIdentity;
}

export interface XrefLoadOptions {
  readonly limits?: XrefLoadLimits;
  readonly signal?: AbortSignal;
  /** Caller-supplied identity of the host session this attempt belongs to (see XrefStore). */
  readonly hostKey?: string;
}

export interface XrefLoadOutcome {
  /** The staged (sealed) snapshot, or null when staging was aborted (cancellation / a fatal limit). */
  readonly snapshot: XrefSnapshot | null;
  readonly failures: readonly XrefFailure[];
  readonly cancelled: boolean;
  /** True when staging aborted early (cancelled, or a cumulative budget was spent). */
  readonly fatal: boolean;
}

class StagingFatal extends Error {
  readonly failure: XrefFailure;
  constructor(failure: XrefFailure) {
    super(failure.message);
    this.failure = failure;
  }
}

interface ParsedFile {
  readonly state: DrawingState;
  readonly byteLength: number;
  readonly entityCount: number;
  readonly retainedRecords: number;
  readonly references: readonly XrefReferenceInput[];
  readonly owningLocation: string;
  readonly version?: string;
  readonly occurrences: XrefOccurrence[];
}

interface Ancestor {
  readonly key: string;
  readonly location: string;
}

interface StageContext {
  readonly deps: XrefLoaderDeps;
  readonly limits: Required<XrefLoadLimits>;
  readonly signal?: AbortSignal;
  readonly failures: XrefFailure[];
  readonly files: Map<string, XrefLoadedFile>;
  readonly parsed: Map<string, ParsedFile>;
  /** Identity keys of unique sources admitted for reading in this load (parse success or not). */
  readonly admitted: Set<string>;
  referencesSeen: number;
  bytesDelivered: number;
  loadedBytes: number;
  totalEntities: number;
}

function entityCountsOf(state: DrawingState): { entities: number; retainedRecords: number } {
  let entities = state.entities.length;
  for (const block of Object.values(state.blocks)) entities += block.entities.length;
  for (const layout of state.layouts ?? []) entities += layout.entities.length;
  const raw = (state.meta as Record<string, unknown> | undefined)?.['dxfRawEntities'];
  const retainedRecords = Array.isArray(raw) ? raw.length : 0;
  return { entities, retainedRecords };
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}

function cancelledFatal(ref: XrefReferenceInput, resolvedPath: string | null, depth: number): StagingFatal {
  return new StagingFatal({ kind: 'cancelled', blockName: ref.blockName, originalPath: ref.path, resolvedPath, depth, message: 'xref load cancelled' });
}

function throwIfAborted(ctx: StageContext, ref: XrefReferenceInput, resolvedPath: string | null, depth: number): void {
  if (ctx.signal?.aborted) throw cancelledFatal(ref, resolvedPath, depth);
}

/**
 * Canonical identity evidence is usable only with a nonempty string id
 * and an absolute owning location. One validator serves dependency
 * identities AND host identity evidence (adapter-returned or
 * caller-supplied): invalid evidence is never anchored on, seeded into
 * ancestry, or silently replaced (20.1 round 3).
 */
function isValidFileIdentity(identity: XrefFileIdentity | null | undefined): identity is XrefFileIdentity {
  return !!identity
    && typeof identity.id === 'string' && identity.id.trim().length > 0
    && typeof identity.owningLocation === 'string' && isAbsolutePath(identity.owningLocation);
}

/** Deep-copy a snapshot and seal the copy; caller/parser-owned objects are never frozen. */
function sealSnapshot(snapshot: XrefSnapshot): XrefSnapshot {
  return sealImmutableData(structuredClone(snapshot));
}

/**
 * Stage a complete snapshot for a host's references. Performs no commit
 * and touches no shared state; see `XrefStore` for atomic publication.
 * The returned snapshot is a sealed copy owned by the caller.
 */
export async function stageXrefLoad(input: XrefLoadInput, deps: XrefLoaderDeps, options: XrefLoadOptions = {}): Promise<XrefLoadOutcome> {
  if (!deps?.reader || typeof deps.reader.readText !== 'function') throw new TypeError('stageXrefLoad requires deps.reader.readText');
  const roots = input.references ?? (input.hostState ? collectXrefReferences(input.hostState) : null);
  if (!roots) throw new TypeError('stageXrefLoad requires input.hostState or input.references');
  const ctx: StageContext = {
    deps,
    limits: resolveLimits(options.limits),
    ...(options.signal ? { signal: options.signal } : {}),
    failures: [],
    files: new Map(),
    parsed: new Map(),
    admitted: new Set(),
    referencesSeen: 0,
    bytesDelivered: 0,
    loadedBytes: 0,
    totalEntities: 0,
  };
  const hostPath = input.hostPath ?? null;
  try {
    if (ctx.signal?.aborted) {
      throw new StagingFatal({ kind: 'cancelled', blockName: '', originalPath: '', resolvedPath: null, depth: 0, message: 'xref load cancelled before it started' });
    }
    // Seed ancestry (and the resolution anchor) with the host identity, so
    // host -> host is cut on the first edge and root-relative paths anchor
    // at the host's owning location. When the adapter offers canonical
    // identity, a host that cannot be identified FAILS CLOSED (20.1
    // review): canonical mode is never silently downgraded to lexical
    // identity, because without the seed a SELF edge could identify and
    // reload the host as external geometry. Every root is then reported
    // unresolved-location and nothing is read; the result is an explicit
    // incomplete candidate, not a successful lexical load.
    let hostIdentity = input.hostIdentity;
    let hostIdentityFailed = false;
    if (hostIdentity !== undefined) {
      // Caller-supplied host evidence is validated with the same rule
      // as adapter evidence, BEFORE it anchors resolution or seeds
      // ancestry — and it is never silently replaced by adapter
      // evidence: invalid caller evidence fails closed.
      if (!isValidFileIdentity(hostIdentity)) hostIdentityFailed = true;
    } else if (deps.reader.identify && hostPath !== null) {
      if (!isAbsolutePath(hostPath)) {
        hostIdentityFailed = true;
      } else {
        let identified: XrefFileIdentity | null = null;
        try {
          identified = await deps.reader.identify(hostPath, { resolvedPath: hostPath, originalPath: hostPath, blockName: '', depth: 0, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        } catch (error) {
          if (isAbort(error, ctx.signal)) throw new StagingFatal({ kind: 'cancelled', blockName: '', originalPath: '', resolvedPath: hostPath, depth: 0, message: 'xref load cancelled' });
          hostIdentityFailed = true;
        }
        throwIfAborted(ctx, { blockName: '', path: '' }, hostPath, 0);
        if (!hostIdentityFailed) {
          // Adapter-returned host evidence is validated BEFORE the
          // anchor and ancestry are derived from it: an empty id would
          // seed ancestry as `id:` and let a SELF edge identifying as
          // `id:HOST` reload the host as external geometry.
          if (isValidFileIdentity(identified)) hostIdentity = identified;
          else hostIdentityFailed = true;
        }
      }
    }
    if (hostIdentityFailed) hostIdentity = undefined;
    const hostAnchor = hostIdentity?.owningLocation ?? hostPath;
    const ancestors: Ancestor[] = hostIdentity ? [{ key: `id:${hostIdentity.id}`, location: hostIdentity.owningLocation }] : [];
    const nodes: XrefNode[] = [];
    if (hostIdentityFailed) {
      const message = 'the host identity evidence is missing or invalid; canonical mode fails closed and no reference is read';
      ctx.failures.push({ kind: 'unresolved-location', blockName: '', originalPath: hostPath ?? '', resolvedPath: hostPath, depth: 0, message });
      for (const ref of roots) {
        ctx.referencesSeen += 1;
        throwIfAborted(ctx, ref, null, 1);
        if (ctx.referencesSeen > ctx.limits.maxReferences) {
          throw new StagingFatal({ kind: 'total-limit', blockName: ref.blockName, originalPath: ref.path, resolvedPath: null, depth: 1, message: `declaration-edge count exceeds the limit of ${ctx.limits.maxReferences}` });
        }
        ctx.failures.push({ kind: 'unresolved-location', blockName: ref.blockName, originalPath: ref.path, resolvedPath: null, depth: 1, message });
        nodes.push({ blockName: ref.blockName, originalPath: ref.path, overlay: ref.overlay === true, depth: 1, resolvedPath: null, status: 'unresolved-location', message, children: [] });
      }
    } else {
      for (const ref of roots) nodes.push(await buildNode(ctx, ref, hostAnchor, 1, ancestors));
    }
    throwIfAborted(ctx, { blockName: '', path: '' }, null, 0);
    const snapshot: XrefSnapshot = {
      generation: 0,
      hostPath,
      ...(hostIdentity ? { hostIdentity: hostIdentity.id } : {}),
      nodes,
      files: Object.fromEntries(ctx.files),
      failures: [...ctx.failures],
      stats: { referencesSeen: ctx.referencesSeen, filesLoaded: ctx.files.size, bytesDelivered: ctx.bytesDelivered, loadedBytes: ctx.loadedBytes, totalEntities: ctx.totalEntities },
    };
    const sealed = sealSnapshot(snapshot);
    return { snapshot: sealed, failures: sealed.failures, cancelled: false, fatal: false };
  } catch (error) {
    if (error instanceof StagingFatal) {
      return { snapshot: null, failures: [error.failure], cancelled: error.failure.kind === 'cancelled', fatal: true };
    }
    throw error;
  }
}

async function buildNode(ctx: StageContext, ref: XrefReferenceInput, containingLocation: string | null, depth: number, ancestors: readonly Ancestor[]): Promise<XrefNode> {
  // (1) Edge accounting, cancellation and the edge budget run before EVERY
  // early return: empty paths, suppressed overlays, cycles, depth and
  // format refusals are all declaration edges and all count.
  ctx.referencesSeen += 1;
  throwIfAborted(ctx, ref, null, depth);
  if (ctx.referencesSeen > ctx.limits.maxReferences) {
    throw new StagingFatal({ kind: 'total-limit', blockName: ref.blockName, originalPath: ref.path, resolvedPath: null, depth, message: `declaration-edge count exceeds the limit of ${ctx.limits.maxReferences}` });
  }
  const base = { blockName: ref.blockName, originalPath: ref.path, overlay: ref.overlay === true, depth };
  const fail = (kind: XrefFailureKind & XrefNodeStatus, resolvedPath: string | null, message: string, extra?: Partial<XrefFailure>): XrefNode => {
    ctx.failures.push({ kind, blockName: ref.blockName, originalPath: ref.path, resolvedPath, depth, message, ...(extra ?? {}) });
    return { ...base, resolvedPath, status: kind, message, children: [] };
  };

  if (!ref.path || !ref.path.trim()) return fail('unresolved-path', null, 'the reference has an empty stored path');
  const resolvedPath = resolveXrefPath(ref.path, containingLocation);
  if (resolvedPath === null) {
    return fail('unresolved-path', null, isDriveRelativePath(ref.path)
      ? 'drive-relative reference paths are ambiguous (per-drive working directory) and cannot be anchored'
      : 'a relative reference with no anchored containing location cannot be resolved');
  }
  // A nested overlay is visible in its immediate host but is not carried
  // into drawings that reference that host, so for this (root) load it is
  // recorded without reading its file or traversing deeper.
  if (depth >= 2 && ref.overlay) {
    return { ...base, resolvedPath, status: 'not-carried-overlay', message: 'nested overlay: loaded for its immediate host only, not carried into the root drawing', children: [] };
  }
  if (depth > ctx.limits.maxDepth) return fail('depth-limit', resolvedPath, `reference depth ${depth} exceeds the limit of ${ctx.limits.maxDepth}`);
  if (/\.dwg$/i.test(resolvedPath)) {
    return fail('unsupported-format', resolvedPath, 'DWG references are recorded but this DXF loading core does not parse DWG files');
  }

  const adapterContext: XrefAdapterContext = { resolvedPath, originalPath: ref.path, blockName: ref.blockName, depth, ...(ctx.signal ? { signal: ctx.signal } : {}) };

  // (2) Adapter identity before authorization or reading. Without it the
  // identity key is the lexical path key (documented fallback, never an
  // authorization). An unavailable/ambiguous location is diagnosed here
  // and the file is not read.
  let identity: XrefFileIdentity | undefined;
  if (ctx.deps.reader.identify) {
    let identified: XrefFileIdentity | null;
    try {
      identified = await ctx.deps.reader.identify(resolvedPath, adapterContext);
    } catch (error) {
      if (isAbort(error, ctx.signal)) throw cancelledFatal(ref, resolvedPath, depth);
      // Identification is part of the adapter's authoritative answer:
      // its missing/denied refusals keep their classification (20.1).
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return fail('missing', resolvedPath, `referenced file not found at ${resolvedPath} (reported during identification)`);
      if (code === 'EACCES' || code === 'EPERM') return fail('denied', resolvedPath, `the adapter refused access to ${resolvedPath} during identification (${code})`);
      return fail('unresolved-location', resolvedPath, `the adapter could not identify this location: ${errorMessage(error)}`);
    }
    throwIfAborted(ctx, ref, resolvedPath, depth);
    if (!isValidFileIdentity(identified)) {
      return fail('unresolved-location', resolvedPath, 'the adapter reported this location as unavailable or ambiguous');
    }
    identity = identified;
  }
  const fileKey = identity ? `id:${identity.id}` : `path:${pathKey(resolvedPath)}`;
  const owningLocation = identity?.owningLocation ?? resolvedPath;

  // (3) Cycles by identity (ancestry is seeded with the host identity).
  const cycleAt = ancestors.findIndex((a) => a.key === fileKey);
  if (cycleAt >= 0) {
    const chain = [...ancestors.slice(cycleAt).map((a) => a.location), owningLocation];
    return fail('cycle', resolvedPath, `circular reference: ${chain.join(' -> ')}`, { chain });
  }

  // (4) A cached file is shared by identity. Its evidence must agree
  // within the load — version AND the single stable owning location —
  // or the snapshot would mix two contents, or resolve one file's
  // children under two different anchors, without any diagnostic.
  let parsed = ctx.parsed.get(fileKey);
  if (parsed && identity?.version && parsed.version && identity.version !== parsed.version) {
    return fail('inconsistent-version', resolvedPath, `identity ${identity.id} reported version ${identity.version} after ${parsed.version} in the same load`);
  }
  if (parsed && owningLocation !== parsed.owningLocation) {
    return fail('inconsistent-location', resolvedPath, `identity for ${fileKey} reported owning location ${owningLocation}, but this load already anchored it at ${parsed.owningLocation}; one identity has one stable anchor per load`);
  }
  if (!parsed) {
    // (5) Authorization gate (the reader itself may still refuse: below).
    if (ctx.deps.authorize) {
      let allowed = false;
      try {
        allowed = await ctx.deps.authorize(resolvedPath, adapterContext);
      } catch (error) {
        if (isAbort(error, ctx.signal)) throw cancelledFatal(ref, resolvedPath, depth);
        return fail('denied', resolvedPath, `permission check failed: ${errorMessage(error)}`);
      }
      throwIfAborted(ctx, ref, resolvedPath, depth);
      if (!allowed) return fail('denied', resolvedPath, 'the permission gate denied this read');
    }
    // (6) Unique-source budget over ADMITTED sources (20.1): a source is
    // admitted when the loader commits to reading it, and it keeps its
    // budget slot even if the read or the parse then fails — otherwise
    // failed parses would let unbounded distinct sources be sampled
    // under a small maxFiles. Enforced before the read is scheduled.
    if (!ctx.admitted.has(fileKey)) {
      if (ctx.admitted.size >= ctx.limits.maxFiles) {
        throw new StagingFatal({ kind: 'total-limit', blockName: ref.blockName, originalPath: ref.path, resolvedPath, depth, message: `distinct admitted source count exceeds the limit of ${ctx.limits.maxFiles}` });
      }
      ctx.admitted.add(fileKey);
    }
    // (7) Read, with the remaining allowance. Delivered bytes are charged
    // whether or not the content is then accepted, and once the
    // cumulative budget is spent no further read is scheduled.
    const remainingTotal = ctx.limits.maxTotalBytes - ctx.bytesDelivered;
    if (remainingTotal <= 0) {
      throw new StagingFatal({ kind: 'total-limit', blockName: ref.blockName, originalPath: ref.path, resolvedPath, depth, message: `cumulative delivered-byte budget of ${ctx.limits.maxTotalBytes} is spent` });
    }
    const maxBytes = Math.min(ctx.limits.maxFileBytes, remainingTotal);
    let result: XrefReadResult;
    try {
      result = await ctx.deps.reader.readText(resolvedPath, { ...adapterContext, maxBytes });
    } catch (error) {
      if (isAbort(error, ctx.signal)) throw cancelledFatal(ref, resolvedPath, depth);
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return fail('missing', resolvedPath, `referenced file not found at ${resolvedPath}`);
      if (code === 'EACCES' || code === 'EPERM') return fail('denied', resolvedPath, `the reader refused access to ${resolvedPath} (${code})`);
      return fail('read-error', resolvedPath, `could not read the referenced file: ${errorMessage(error)}`);
    }
    throwIfAborted(ctx, ref, resolvedPath, depth);
    const text = typeof result === 'string' ? result : result?.text;
    if (typeof text !== 'string') return fail('inconsistent-response', resolvedPath, 'the reader returned a non-string result');
    const deliveredBytes = new TextEncoder().encode(text).length;
    ctx.bytesDelivered += deliveredBytes;
    // The cumulative budget is enforced on ACTUAL delivered bytes before
    // any per-node response diagnostic (20.1): a response that breaks
    // the total budget aborts staging fatally even when it is also
    // inconsistent or oversize per-file, so no publication mode can
    // commit a graph staged past the budget.
    if (ctx.bytesDelivered > ctx.limits.maxTotalBytes) {
      throw new StagingFatal({ kind: 'total-limit', blockName: ref.blockName, originalPath: ref.path, resolvedPath, depth, message: `cumulative delivered bytes exceed the limit of ${ctx.limits.maxTotalBytes}` });
    }
    const declaredBytes = typeof result === 'string' ? undefined : result.byteLength;
    if (declaredBytes !== undefined && declaredBytes !== deliveredBytes) {
      return fail('inconsistent-response', resolvedPath, `the reader declared ${declaredBytes} bytes but delivered ${deliveredBytes}`);
    }
    // The read must be bound to the identified snapshot (20.1): if both
    // the identification and the read carry version evidence, a
    // disagreement means the content is not the identified snapshot and
    // it is rejected — never silently tagged with the identified version.
    const resultVersion = typeof result === 'string' ? undefined : result.version;
    if (identity?.version && resultVersion && identity.version !== resultVersion) {
      return fail('inconsistent-version', resolvedPath, `read of ${resolvedPath} returned version ${resultVersion}, but identification bound this source to version ${identity.version}`);
    }
    if (deliveredBytes > ctx.limits.maxFileBytes) {
      return fail('file-limit', resolvedPath, `referenced file delivered ${deliveredBytes} bytes, over the per-file limit of ${ctx.limits.maxFileBytes}`);
    }
    const version = identity?.version ?? resultVersion;
    // (8) Parse, with the parser's own allocation bounds lowered from the
    // caller's budgets (source length) and never raised (string/pair/
    // record defaults stay in force). Parsing is synchronous: the signal
    // is rechecked immediately after, but a running parse is not
    // preemptible.
    const parse = ctx.deps.parse ?? ((t: string, p: string, bounds: XrefParseBounds) => readDxf(t, { filePath: p, maxSourceLength: bounds.maxSourceLength }));
    let state: DrawingState;
    try {
      state = parse(text, resolvedPath, { maxSourceLength: ctx.limits.maxFileBytes });
    } catch (error) {
      if (isAbort(error, ctx.signal)) throw cancelledFatal(ref, resolvedPath, depth);
      return fail('parse-error', resolvedPath, `could not parse the referenced file as DXF: ${errorMessage(error)}`);
    }
    throwIfAborted(ctx, ref, resolvedPath, depth);
    if (!state || !Array.isArray(state.entities) || !state.blocks || typeof state.blocks !== 'object') {
      return fail('parse-error', resolvedPath, 'the parser returned an invalid drawing state');
    }
    const { entities, retainedRecords } = entityCountsOf(state);
    const counted = entities + retainedRecords;
    if (counted > ctx.limits.maxEntitiesPerFile) {
      return fail('file-limit', resolvedPath, `referenced file has ${counted} counted entities (${entities} model/block/layout + ${retainedRecords} retained raw records), over the per-file limit of ${ctx.limits.maxEntitiesPerFile}`);
    }
    ctx.totalEntities += counted;
    if (ctx.totalEntities > ctx.limits.maxTotalEntities) {
      throw new StagingFatal({ kind: 'total-limit', blockName: ref.blockName, originalPath: ref.path, resolvedPath, depth, message: `cumulative counted entities exceed the limit of ${ctx.limits.maxTotalEntities}` });
    }
    ctx.loadedBytes += deliveredBytes;
    parsed = { state, byteLength: deliveredBytes, entityCount: entities, retainedRecords, references: collectXrefReferences(state), owningLocation, ...(version ? { version } : {}), occurrences: [] };
    ctx.parsed.set(fileKey, parsed);
    ctx.files.set(fileKey, {
      key: fileKey,
      owningLocation,
      ...(version ? { version } : {}),
      byteLength: deliveredBytes,
      entityCount: entities,
      retainedRecords,
      occurrences: parsed.occurrences,
      state,
      references: parsed.references,
    });
  }
  parsed.occurrences.push({ blockName: ref.blockName, originalPath: ref.path, resolvedPath, depth });

  const children: XrefNode[] = [];
  const childAncestors = [...ancestors, { key: fileKey, location: owningLocation }];
  for (const child of parsed.references) {
    children.push(await buildNode(ctx, child, owningLocation, depth + 1, childAncestors));
  }
  return { ...base, resolvedPath, status: 'loaded', fileKey, children };
}

// ---------------------------------------------------------------------------
// Atomic store

export type XrefCommitMode = 'strict' | 'partial';

export interface XrefCommitResult {
  readonly committed: boolean;
  /** True when the previously committed snapshot was left untouched (identity preserved). */
  readonly preserved: boolean;
  /** True when the attempt was superseded (newer attempt, generation or host change) before publication. */
  readonly stale: boolean;
  /** The store's current snapshot after the operation (the preserved one on failure). */
  readonly current: XrefSnapshot | null;
  /**
   * The staged snapshot, for diagnostics/inspection. On a failed strict
   * commit and on EVERY partial refresh this is an uncommitted candidate:
   * it is not, and must not be treated as, the store's current graph.
   */
  readonly staged: XrefSnapshot | null;
  readonly failures: readonly XrefFailure[];
  readonly cancelled: boolean;
}

/**
 * Holds the last successful snapshot and refreshes it atomically.
 *
 * Publication guard (20.1): every attempt captures a request token, the
 * store generation and the host epoch when it STARTS. At publication all
 * three must still be current, the attempt's host must still be the
 * store's bound host, and the signal must not be aborted. Otherwise the
 * attempt is stale: nothing is published and the last good graph is
 * preserved, even if the attempt's reader ignored cancellation. Starting
 * a newer attempt — successful, failed or cancelled — supersedes every
 * older in-flight attempt.
 *
 * Host lifecycle: the first successful commit binds the store to that
 * attempt's host key (`options.hostKey`, else the host identity id, else
 * the host path). `bindHost` / `close` model host replacement/closure:
 * they advance the host epoch, drop the old host's graph, and invalidate
 * every in-flight attempt.
 *
 * Refresh semantics (20.1): `refresh` never publishes an incomplete
 * snapshot, in any mode — an incomplete refresh returns its staged
 * snapshot as an inspection candidate with `committed: false`. Partial
 * publication under the explicit `partial` mode is a state condition,
 * not a method-name condition: it is allowed only while the store holds
 * no committed graph (the initial load). Once a last-good graph exists,
 * ANY incomplete attempt — refresh or load — is candidate-only.
 */
export class XrefStore {
  #current: XrefSnapshot | null = null;
  #generation = 0;
  #lastRequest = 0;
  #hostEpoch = 0;
  #boundHost: string | null = null;

  get current(): XrefSnapshot | null {
    return this.#current;
  }

  get generation(): number {
    return this.#generation;
  }

  get boundHost(): string | null {
    return this.#boundHost;
  }

  /** The host was replaced or closed: drop its graph and invalidate in-flight attempts. */
  bindHost(hostKey: string | null): void {
    if (hostKey === this.#boundHost && this.#current !== null) return;
    this.#boundHost = hostKey;
    this.#hostEpoch += 1;
    this.#current = null;
  }

  close(): void {
    this.bindHost(null);
    this.#hostEpoch += 1;
    this.#current = null;
  }

  async load(input: XrefLoadInput, deps: XrefLoaderDeps, options: XrefLoadOptions & { readonly mode?: XrefCommitMode } = {}): Promise<XrefCommitResult> {
    return this.#attempt(input, deps, options, false);
  }

  async refresh(input: XrefLoadInput, deps: XrefLoaderDeps, options: XrefLoadOptions & { readonly mode?: XrefCommitMode } = {}): Promise<XrefCommitResult> {
    return this.#attempt(input, deps, options, true);
  }

  async #attempt(input: XrefLoadInput, deps: XrefLoaderDeps, options: XrefLoadOptions & { readonly mode?: XrefCommitMode }, isRefresh: boolean): Promise<XrefCommitResult> {
    const request = ++this.#lastRequest;
    const generationAtStart = this.#generation;
    const epochAtStart = this.#hostEpoch;
    const hostAtStart = this.#boundHost;
    // The store binds to the same validated host evidence the loader
    // accepts: an invalid caller-supplied identity contributes no id,
    // so the attempt keys on the host path instead (20.1 round 3).
    const attemptHost = options.hostKey ?? (isValidFileIdentity(input.hostIdentity) ? input.hostIdentity.id : undefined) ?? input.hostPath ?? null;
    const outcome = await stageXrefLoad(input, deps, options);
    const superseded = request !== this.#lastRequest || generationAtStart !== this.#generation || epochAtStart !== this.#hostEpoch;
    const hostChanged = this.#boundHost !== hostAtStart || (hostAtStart !== null && attemptHost !== hostAtStart);
    const cancelled = outcome.cancelled || options.signal?.aborted === true;
    if (superseded || hostChanged) {
      return { committed: false, preserved: true, stale: true, current: this.#current, staged: outcome.snapshot, failures: outcome.failures, cancelled };
    }
    if (cancelled || outcome.fatal || !outcome.snapshot) {
      return { committed: false, preserved: true, stale: false, current: this.#current, staged: outcome.snapshot, failures: outcome.failures, cancelled };
    }
    const incomplete = outcome.failures.length > 0;
    const mode = options.mode ?? 'strict';
    // Partial publication is a STATE condition, not just a mode (20.1):
    // it is allowed only for an initial load — when the store holds no
    // committed graph. Any incomplete attempt while a last-good graph
    // exists (any refresh, and any later load in partial mode alike)
    // returns its snapshot as an inspection candidate only.
    const partialAllowed = mode === 'partial' && !isRefresh && this.#current === null;
    if (incomplete && !partialAllowed) {
      return { committed: false, preserved: true, stale: false, current: this.#current, staged: outcome.snapshot, failures: outcome.failures, cancelled: false };
    }
    this.#generation += 1;
    const published = sealSnapshot({ ...outcome.snapshot, generation: this.#generation });
    this.#current = published;
    if (this.#boundHost === null) this.#boundHost = attemptHost;
    return { committed: true, preserved: false, stale: false, current: published, staged: outcome.snapshot, failures: outcome.failures, cancelled: false };
  }
}
