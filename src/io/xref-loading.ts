/**
 * DXF external-reference (xref) loading and refresh core — milestone 20.
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
 * file. A future integration supplies a permission-controlled reader (for
 * example an Electron/IPC reader rooted at approved folders) and decides
 * what to do with a committed snapshot.
 *
 * Semantics implemented (see docs/XREF-LOADING-CORE.md for the full note):
 * - The original reference path and the attach/overlay flag are preserved
 *   verbatim on every node; resolution produces a separate `resolvedPath`.
 * - Relative paths resolve against the file that contains the reference
 *   (its immediate host), never against the root drawing — including for
 *   nested references, matching AutoCAD's documented behaviour.
 * - Attach/overlay: a reference is always loaded for its immediate host.
 *   A reference at depth >= 2 (nested) is carried into the root drawing
 *   only when its own edge is an attachment; a nested overlay is recorded
 *   with status `not-carried-overlay` and its file is not read.
 * - Loading is staged: a load/refresh builds a complete new snapshot
 *   without touching the previously committed one. In the default
 *   `strict` mode any failure (missing, denied, parse, cycle, per-file
 *   limit, ...) discards the staged snapshot and the store keeps the last
 *   successful snapshot object, identity included. `partial` mode is an
 *   explicit opt-in that commits the references that did load, with the
 *   failures recorded in the snapshot. Cancellation and the cumulative
 *   (total) limits are fatal in both modes: nothing is committed.
 * - Loaded geometry lives only inside the snapshot, keyed by resolved
 *   file, apart from the host `DrawingState`. Nothing in the snapshot is
 *   ever written back to a drawing or to a referenced file, and the
 *   injected reader interface has no write operation.
 */
import type { DrawingState } from '../core/document';
import type { Entity, Layer } from '../core/entities';
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
// Path handling (lexical only; no filesystem is touched here)
//
// DXF paths are frequently Windows paths (`..\xref\site.dxf`, `C:\...`,
// UNC `\\server\share\...`) whatever OS the loader runs on, so resolution
// is implemented over both separator styles instead of delegating to the
// host OS path library. Resolved paths are canonical `/`-separated;
// Windows APIs and Node accept `/`, and the injected reader owns any
// mapping its platform needs.

export type CadPathKind = 'drive' | 'unc' | 'rooted' | 'relative';

export interface CadPathParts {
  readonly kind: CadPathKind;
  /** `C:` for drive paths, `//server/share` for UNC, `/` for rooted, `` for relative. */
  readonly prefix: string;
  readonly segments: readonly string[];
  /** True when the path is written in Windows style (drive, UNC or backslashes). */
  readonly windowsStyle: boolean;
}

export function splitCadPath(path: string): CadPathParts {
  const windowsStyle = /^[A-Za-z]:/.test(path) || path.includes('\\');
  const unified = path.replace(/\\/g, '/');
  const drive = /^([A-Za-z]:)(?=\/|$)/.exec(unified);
  if (drive) return { kind: 'drive', prefix: drive[1]!, segments: rawSegments(unified.slice(2)), windowsStyle: true };
  if (unified.startsWith('//')) {
    const segs = rawSegments(unified);
    const prefix = `//${segs.slice(0, 2).join('/')}`;
    return { kind: 'unc', prefix, segments: segs.slice(2), windowsStyle };
  }
  if (unified.startsWith('/')) return { kind: 'rooted', prefix: '/', segments: rawSegments(unified), windowsStyle };
  return { kind: 'relative', prefix: '', segments: rawSegments(unified), windowsStyle };
}

function rawSegments(unified: string): string[] {
  return unified.split('/').filter((s) => s.length > 0);
}

/** Resolve `.` / `..` segments lexically. Absolute paths clamp at the root. */
function foldSegments(parts: CadPathParts): string[] {
  const out: string[] = [];
  for (const seg of parts.segments) {
    if (seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (parts.kind === 'relative') out.push('..');
      continue;
    }
    out.push(seg);
  }
  return out;
}

function joinParts(prefix: string, segments: readonly string[]): string {
  if (prefix === '/') return `/${segments.join('/')}`;
  if (prefix) return segments.length ? `${prefix}/${segments.join('/')}` : prefix;
  return segments.join('/');
}

/** Canonical (`/`-separated, dot-folded) form of a CAD path, without resolving it against anything. */
export function normalizeCadPath(path: string): string {
  const parts = splitCadPath(path);
  return joinParts(parts.prefix, foldSegments(parts));
}

/**
 * Resolve a stored reference path against the file that contains the
 * reference (its immediate host). Absolute reference paths (drive, UNC,
 * rooted) stand alone; relative ones join the containing file's folder.
 * With no containing file, a relative path is returned normalized but
 * unanchored and the injected reader decides where (or whether) it reads.
 */
export function resolveXrefPath(referencePath: string, containingFilePath: string | null): string {
  const ref = splitCadPath(referencePath);
  if (ref.kind !== 'relative') return normalizeCadPath(referencePath);
  if (containingFilePath === null) return normalizeCadPath(referencePath);
  const host = splitCadPath(containingFilePath);
  const dirSegments = foldSegments(host).slice(0, -1);
  const merged: CadPathParts = { kind: host.kind, prefix: host.prefix, segments: [...dirSegments, ...ref.segments], windowsStyle: host.windowsStyle || ref.windowsStyle };
  return joinParts(merged.prefix, foldSegments(merged));
}

/** True when a path is written in Windows style (and so compares case-insensitively). */
export function isWindowsStylePath(path: string): boolean {
  return splitCadPath(path).windowsStyle;
}

/**
 * Comparison key for cycle / identity checks. Windows-style paths compare
 * case-insensitively (the filesystem the path addresses is), POSIX-style
 * paths keep their case.
 */
export function cadPathKey(path: string, windowsStyle = isWindowsStylePath(path)): string {
  const normalized = normalizeCadPath(path);
  return windowsStyle ? normalized.toLowerCase() : normalized;
}

// ---------------------------------------------------------------------------
// Injected access

/** What the reader is told about a read: enough to enforce and to log, nothing more. */
export interface XrefReadContext {
  readonly resolvedPath: string;
  /** The path exactly as stored in the referencing drawing. */
  readonly originalPath: string;
  readonly blockName: string;
  /** 1 for a reference of the root drawing, deeper for nested references. */
  readonly depth: number;
  readonly signal?: AbortSignal;
}

/**
 * The only file access the loader has. Implementations are responsible
 * for permission control (approved roots, user grants, IPC admission in
 * the desktop host); the loader performs no I/O itself and cannot write.
 * Implementations should reject with an error carrying `code: 'ENOENT'`
 * (as Node does) for a file that does not exist, and honour `signal`.
 */
export interface XrefFileReader {
  readText(resolvedPath: string, context: XrefReadContext): Promise<string>;
}

/**
 * Optional second gate, consulted before every read (including nested
 * reads) when supplied. Returning false denies the read: the reader is
 * not called and the node is reported as `denied`.
 */
export type XrefAuthorize = (resolvedPath: string, context: XrefReadContext) => boolean | Promise<boolean>;

/** Parse a referenced file. Defaults to the existing DXF reader; injectable for isolated tests. */
export type XrefParse = (text: string, resolvedPath: string) => DrawingState;

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
  /** Maximum distinct reference nodes staged in one load. Default 64. */
  readonly maxReferences?: number;
  /** Maximum UTF-8 byte length of one referenced file. Default 16 MiB. */
  readonly maxFileBytes?: number;
  /** Maximum cumulative UTF-8 bytes over distinct files in one load. Default 64 MiB. Fatal when exceeded. */
  readonly maxTotalBytes?: number;
  /** Maximum entities (model-space + block content) in one referenced file. Default 200,000. */
  readonly maxEntitiesPerFile?: number;
  /** Maximum cumulative entities over distinct files in one load. Default 500,000. Fatal when exceeded. */
  readonly maxTotalEntities?: number;
}

export const DEFAULT_XREF_LOAD_LIMITS: Required<XrefLoadLimits> = {
  maxDepth: 8,
  maxReferences: 64,
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
  /** For `cycle`: the resolved-path chain from the ancestor down to the repeated file. */
  readonly chain?: readonly string[];
}

/** One reference occurrence in the staged tree. */
export interface XrefNode {
  readonly blockName: string;
  /** Verbatim stored path; never rewritten. */
  readonly originalPath: string;
  readonly resolvedPath: string | null;
  readonly overlay: boolean;
  readonly depth: number;
  readonly status: XrefNodeStatus;
  readonly message?: string;
  /** Key into `XrefSnapshot.files` when this occurrence's file was loaded (shared by duplicates). */
  readonly fileKey?: string;
  readonly children: readonly XrefNode[];
}

/** A distinct referenced file that was read and parsed, held apart from the host drawing. */
export interface XrefLoadedFile {
  readonly key: string;
  readonly resolvedPath: string;
  /** Every verbatim stored path that resolved to this file, in encounter order. */
  readonly originalPaths: readonly string[];
  readonly byteLength: number;
  /** Model-space entities plus the entities of the file's own block definitions. */
  readonly entityCount: number;
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
  /** Distinct reference nodes staged (including failed and not-carried ones). */
  readonly referencesSeen: number;
  readonly filesLoaded: number;
  /** UTF-8 bytes over distinct loaded files. */
  readonly totalBytes: number;
  /** Entities over distinct loaded files. */
  readonly totalEntities: number;
}

/** A complete, self-contained staging result. Immutable by convention (all fields readonly). */
export interface XrefSnapshot {
  /** Store generation that committed this snapshot (0 for a bare staged load). */
  readonly generation: number;
  readonly hostPath: string | null;
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
}

export interface XrefLoadOptions {
  readonly limits?: XrefLoadLimits;
  readonly signal?: AbortSignal;
}

export interface XrefLoadOutcome {
  /** The staged snapshot, or null when staging was aborted (cancellation / a total limit). */
  readonly snapshot: XrefSnapshot | null;
  readonly failures: readonly XrefFailure[];
  readonly cancelled: boolean;
  /** True when staging aborted early (cancelled, or a cumulative total limit was exceeded). */
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
  readonly references: readonly XrefReferenceInput[];
  readonly originalPaths: string[];
}

interface StageContext {
  readonly deps: XrefLoaderDeps;
  readonly limits: Required<XrefLoadLimits>;
  readonly signal?: AbortSignal;
  readonly failures: XrefFailure[];
  readonly files: Map<string, XrefLoadedFile>;
  readonly parsed: Map<string, ParsedFile>;
  referencesSeen: number;
  totalBytes: number;
  totalEntities: number;
}

function entityCountOf(state: DrawingState): number {
  let n = state.entities.length;
  for (const block of Object.values(state.blocks)) n += block.entities.length;
  return n;
}

function isMissing(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (!e) return false;
  if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return true;
  return typeof e.message === 'string' && /ENOENT|not found|no such file/i.test(e.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(ctx: StageContext, ref: XrefReferenceInput, resolvedPath: string | null, depth: number): void {
  if (ctx.signal?.aborted) {
    throw new StagingFatal({ kind: 'cancelled', blockName: ref.blockName, originalPath: ref.path, resolvedPath, depth, message: 'xref load cancelled' });
  }
}

/**
 * Stage a complete snapshot for a host's references. Performs no commit
 * and touches no shared state; see `XrefStore` for atomic commit/refresh.
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
    referencesSeen: 0,
    totalBytes: 0,
    totalEntities: 0,
  };
  const hostPath = input.hostPath ?? null;
  try {
    if (ctx.signal?.aborted) {
      throw new StagingFatal({ kind: 'cancelled', blockName: '', originalPath: '', resolvedPath: null, depth: 0, message: 'xref load cancelled before it started' });
    }
    const nodes: XrefNode[] = [];
    for (const ref of roots) nodes.push(await buildNode(ctx, ref, hostPath, 1, []));
    const snapshot: XrefSnapshot = {
      generation: 0,
      hostPath,
      nodes,
      files: Object.fromEntries(ctx.files),
      failures: [...ctx.failures],
      stats: { referencesSeen: ctx.referencesSeen, filesLoaded: ctx.files.size, totalBytes: ctx.totalBytes, totalEntities: ctx.totalEntities },
    };
    return { snapshot, failures: snapshot.failures, cancelled: false, fatal: false };
  } catch (error) {
    if (error instanceof StagingFatal) {
      return { snapshot: null, failures: [error.failure], cancelled: error.failure.kind === 'cancelled', fatal: true };
    }
    throw error;
  }
}

interface Ancestor {
  readonly key: string;
  readonly resolvedPath: string;
}

async function buildNode(ctx: StageContext, ref: XrefReferenceInput, containingPath: string | null, depth: number, ancestors: readonly Ancestor[]): Promise<XrefNode> {
  ctx.referencesSeen += 1;
  const base = { blockName: ref.blockName, originalPath: ref.path, overlay: ref.overlay === true, depth };
  const fail = (kind: XrefFailureKind & XrefNodeStatus, resolvedPath: string | null, message: string, extra?: Partial<XrefFailure>): XrefNode => {
    ctx.failures.push({ kind, blockName: ref.blockName, originalPath: ref.path, resolvedPath, depth, message, ...(extra ?? {}) });
    return { ...base, resolvedPath, status: kind, message, children: [] };
  };

  if (!ref.path || !ref.path.trim()) return fail('unresolved-path', null, 'the reference has an empty stored path');
  const resolvedPath = resolveXrefPath(ref.path, containingPath);
  const windowsStyle = isWindowsStylePath(resolvedPath) || (containingPath !== null && isWindowsStylePath(containingPath));
  const key = cadPathKey(resolvedPath, windowsStyle);

  // A nested overlay is visible in its immediate host but is not carried
  // into drawings that reference that host, so for this (root) load it is
  // recorded without reading its file or traversing deeper.
  if (depth >= 2 && ref.overlay) {
    return { ...base, resolvedPath, status: 'not-carried-overlay', message: 'nested overlay: loaded for its immediate host only, not carried into the root drawing', children: [] };
  }
  const cycleAt = ancestors.findIndex((a) => a.key === key);
  if (cycleAt >= 0) {
    const chain = [...ancestors.slice(cycleAt).map((a) => a.resolvedPath), resolvedPath];
    return fail('cycle', resolvedPath, `circular reference: ${chain.join(' -> ')}`, { chain });
  }
  if (depth > ctx.limits.maxDepth) return fail('depth-limit', resolvedPath, `reference depth ${depth} exceeds the limit of ${ctx.limits.maxDepth}`);
  if (ctx.referencesSeen > ctx.limits.maxReferences) {
    throw new StagingFatal({ kind: 'total-limit', blockName: ref.blockName, originalPath: ref.path, resolvedPath, depth, message: `reference count exceeds the limit of ${ctx.limits.maxReferences}` });
  }
  if (/\.dwg$/i.test(resolvedPath)) {
    return fail('unsupported-format', resolvedPath, 'DWG references are recorded but this DXF loading core does not parse DWG files');
  }

  throwIfAborted(ctx, ref, resolvedPath, depth);

  let parsed = ctx.parsed.get(key);
  if (!parsed) {
    const readContext: XrefReadContext = { resolvedPath, originalPath: ref.path, blockName: ref.blockName, depth, ...(ctx.signal ? { signal: ctx.signal } : {}) };
    if (ctx.deps.authorize) {
      let allowed = false;
      try {
        allowed = await ctx.deps.authorize(resolvedPath, readContext);
      } catch (error) {
        return fail('denied', resolvedPath, `permission check failed: ${errorMessage(error)}`);
      }
      throwIfAborted(ctx, ref, resolvedPath, depth);
      if (!allowed) return fail('denied', resolvedPath, 'the permission gate denied this read');
    }
    let text: string;
    try {
      text = await ctx.deps.reader.readText(resolvedPath, readContext);
    } catch (error) {
      if (ctx.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new StagingFatal({ kind: 'cancelled', blockName: ref.blockName, originalPath: ref.path, resolvedPath, depth, message: 'xref load cancelled' });
      }
      if (isMissing(error)) return fail('missing', resolvedPath, `referenced file not found at ${resolvedPath}`);
      return fail('read-error', resolvedPath, `could not read the referenced file: ${errorMessage(error)}`);
    }
    throwIfAborted(ctx, ref, resolvedPath, depth);
    if (typeof text !== 'string') return fail('read-error', resolvedPath, 'the reader returned a non-string result');
    const byteLength = new TextEncoder().encode(text).length;
    if (byteLength > ctx.limits.maxFileBytes) return fail('file-limit', resolvedPath, `referenced file is ${byteLength} bytes, over the per-file limit of ${ctx.limits.maxFileBytes}`);
    ctx.totalBytes += byteLength;
    if (ctx.totalBytes > ctx.limits.maxTotalBytes) {
      throw new StagingFatal({ kind: 'total-limit', blockName: ref.blockName, originalPath: ref.path, resolvedPath, depth, message: `cumulative referenced bytes exceed the limit of ${ctx.limits.maxTotalBytes}` });
    }
    const parse = ctx.deps.parse ?? ((t: string, p: string) => readDxf(t, { filePath: p }));
    let state: DrawingState;
    try {
      state = parse(text, resolvedPath);
    } catch (error) {
      return fail('parse-error', resolvedPath, `could not parse the referenced file as DXF: ${errorMessage(error)}`);
    }
    const entityCount = entityCountOf(state);
    if (entityCount > ctx.limits.maxEntitiesPerFile) return fail('file-limit', resolvedPath, `referenced file has ${entityCount} entities, over the per-file limit of ${ctx.limits.maxEntitiesPerFile}`);
    ctx.totalEntities += entityCount;
    if (ctx.totalEntities > ctx.limits.maxTotalEntities) {
      throw new StagingFatal({ kind: 'total-limit', blockName: ref.blockName, originalPath: ref.path, resolvedPath, depth, message: `cumulative referenced entities exceed the limit of ${ctx.limits.maxTotalEntities}` });
    }
    parsed = { state, byteLength, entityCount, references: collectXrefReferences(state), originalPaths: [] };
    ctx.parsed.set(key, parsed);
    ctx.files.set(key, { key, resolvedPath, originalPaths: parsed.originalPaths, byteLength, entityCount, state, references: parsed.references });
  }
  if (!parsed.originalPaths.includes(ref.path)) parsed.originalPaths.push(ref.path);

  const children: XrefNode[] = [];
  const childAncestors = [...ancestors, { key, resolvedPath }];
  for (const child of parsed.references) {
    throwIfAborted(ctx, child, null, depth + 1);
    children.push(await buildNode(ctx, child, resolvedPath, depth + 1, childAncestors));
  }
  return { ...base, resolvedPath, status: 'loaded', fileKey: key, children };
}

// ---------------------------------------------------------------------------
// Atomic store

export type XrefCommitMode = 'strict' | 'partial';

export interface XrefCommitResult {
  readonly committed: boolean;
  /** True when the previously committed snapshot was left untouched (identity preserved). */
  readonly preserved: boolean;
  /** The store's current snapshot after the operation (the preserved one on failure). */
  readonly current: XrefSnapshot | null;
  /** The staged snapshot, for diagnostics; on a failed strict commit it is NOT the current snapshot. */
  readonly staged: XrefSnapshot | null;
  readonly failures: readonly XrefFailure[];
  readonly cancelled: boolean;
}

/**
 * Holds the last successful snapshot and refreshes it atomically.
 *
 * `load` and `refresh` are the same operation — stage a whole new
 * snapshot, then swap — differing only in what "last successful" means
 * to the caller. The swap is a single assignment after staging has fully
 * completed, so a reader of `current` never sees a half-built tree.
 */
export class XrefStore {
  #current: XrefSnapshot | null = null;
  #generation = 0;

  get current(): XrefSnapshot | null {
    return this.#current;
  }

  get generation(): number {
    return this.#generation;
  }

  async load(input: XrefLoadInput, deps: XrefLoaderDeps, options: XrefLoadOptions & { readonly mode?: XrefCommitMode } = {}): Promise<XrefCommitResult> {
    return this.#stage(input, deps, options);
  }

  async refresh(input: XrefLoadInput, deps: XrefLoaderDeps, options: XrefLoadOptions & { readonly mode?: XrefCommitMode } = {}): Promise<XrefCommitResult> {
    return this.#stage(input, deps, options);
  }

  async #stage(input: XrefLoadInput, deps: XrefLoaderDeps, options: XrefLoadOptions & { readonly mode?: XrefCommitMode }): Promise<XrefCommitResult> {
    const outcome = await stageXrefLoad(input, deps, options);
    const mode = options.mode ?? 'strict';
    if (outcome.fatal || !outcome.snapshot || (mode === 'strict' && outcome.failures.length > 0)) {
      return { committed: false, preserved: true, current: this.#current, staged: outcome.snapshot, failures: outcome.failures, cancelled: outcome.cancelled };
    }
    this.#generation += 1;
    const committed: XrefSnapshot = { ...outcome.snapshot, generation: this.#generation };
    this.#current = committed;
    return { committed: true, preserved: false, current: committed, staged: outcome.snapshot, failures: outcome.failures, cancelled: false };
  }
}
