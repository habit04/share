/**
 * The PDF underlay display service (P28 wiring + finish slice): resolves
 * placements to definitions from the DrawingState `underlays` sibling and
 * rasterizes PDF pages through the engine interface
 * (src/io/underlay-engine.ts) — never through an engine directly, so the
 * implementation stays swappable and tests drive this service against a
 * fake engine with zero pdfjs import.
 *
 * Finish-slice cache/session design (design section 3, as amended by
 * addendum A.3): entries are keyed by
 *   [epoch, def.id, def.sourcePath, sourceVersion, pageIndex,
 *    regionBucket, scaleBucket, styleKey, backgroundKey]
 * where sourceVersion is the SHA-256 of the exact captured byte snapshot
 * (Codex disposition 2026-10-25: hash and decode the SAME snapshot; the
 * hash is not access authority). Bytes are memoized per
 * (epoch, definition generation, def.id, def.sourcePath); engine document
 * sessions are keyed identically and closed exactly once at retirement.
 * Every load carries a captured (epoch, generation, key, entry, serial)
 * publication guard: a settle that arrives after retirement is dropped —
 * late success and late refusal alike (no stale resurrection). Loads are
 * cancellable end to end: an AbortSignal threads bytes -> open -> pageSize
 * -> render, and an aborted load never settles `failed`.
 *
 * Failure posture (kept from the original service): frame + label until
 * the raster lands; a settled failure retries only on key change,
 * invalidate(), or clear(). DWF/DGN definitions resolve for frame + label
 * but are NEVER opened (Q7).
 */
import { underlayMonochrome, type UnderlayDefinition } from '../core/underlay';
import { underlayPlacementOf, type UnderlayEntity } from '../core/entities';
import { planUnderlayTiles, type UnderlayCanvasFactory, type UnderlayClipRect, type UnderlayDocument, type UnderlayRasterEngine } from '../io/underlay-engine';
import { DEFAULT_UNDERLAY_CAPS } from '../io/underlay-adapter';
import type { UnderlayDisplayContent } from '../render/underlay-content';
import { adjustUnderlayPixels, underlayBackgroundKey, underlayStyleKey } from './underlay-adjust';

/** Bytes of the referenced file, or null when they cannot be obtained. NO referenced-file I/O happens anywhere else in P28. */
export type UnderlayByteSource = (def: UnderlayDefinition) => Promise<Uint8Array | null>;

/** A canvas that exposes pixel access, for deriving style variants (design 5.3). */
export interface UnderlayVariantCanvasFactory {
  create(width: number, height: number): {
    canvas: unknown;
    context: {
      drawImage(image: unknown, dx: number, dy: number): void;
      getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
      putImageData(image: { data: Uint8ClampedArray }, dx: number, dy: number): void;
    };
    width: number;
    height: number;
  };
}

export interface UnderlayDisplayService {
  /** The DrawStyle/renderSettings source: synchronous, cache-backed. */
  source(e: UnderlayEntity): UnderlayDisplayContent | undefined;
  /** Retire everything (epoch bump): sessions closed, memos dropped. */
  clear(): void;
  /** Retire one definition's entries/sessions/memos (or all, no argument) — the Reload surface. */
  invalidate(defId?: string): void;
  /** The loaded page size for a definition, when any entry holds it. */
  pageSizeOf(defId: string): { width: number; height: number } | undefined;
  /** Async entry point (plot): resolves when the placement's load settles. */
  ensure(e: UnderlayEntity): Promise<UnderlayDisplayContent | undefined>;
  /** Plot load for a definition at a print resolution (design 6.3): the render scale is dpi/72. */
  loadForPlot(def: UnderlayDefinition, dpi: number): Promise<{ page: { width: number; height: number }; image: { bitmap: CanvasImageSource; width: number; height: number } } | undefined>;
  /** Retire everything and refuse further loads (the plot resolver disposes its service). */
  dispose(): void;
}

/** The definition's page field as a 1-based page index: numeric names only in this slice; anything else is page 1. */
export function underlayPageIndex(def: UnderlayDefinition): number {
  const n = def.page !== undefined && /^\d+$/.test(def.page.trim()) ? Number.parseInt(def.page.trim(), 10) : 1;
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes as BufferSource);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // No SubtleCrypto (non-secure headless shells): a collision-resistant
  // version stamp is unavailable, so fall back to a strong FNV-1a — still a
  // pure function of the captured snapshot, labelled so it can never be
  // confused with a SHA-256 in a key or a report.
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (const b of bytes) { h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0; h2 = Math.imul(h2 + b, 0x85ebca6b) >>> 0; }
  return `fnv1a:${h1.toString(16)}:${h2.toString(16)}:${bytes.length}`;
}

interface ByteMemo {
  readonly promise: Promise<{ readonly bytes: Uint8Array; readonly sourceVersion: string } | null>;
}

interface Session {
  readonly memoKey: string;
  readonly defId: string;
  doc?: UnderlayDocument;
  openPromise?: Promise<UnderlayDocument | undefined>;
  controller: AbortController;
  closed: boolean;
  readonly entries: Set<Entry>;
}

interface Entry {
  readonly key: string;
  readonly defId: string;
  readonly sourcePath: string;
  readonly pageIndex: number;
  readonly regionBucket: string;
  readonly scaleBucket: string;
  readonly region?: UnderlayClipRect;
  readonly target: number;
  /** Print-resolution loads: the render scale is dpi/72 instead of target-driven. */
  readonly dpi?: number;
  readonly epoch: number;
  readonly generation: number;
  state: 'loading' | 'ready' | 'failed';
  page?: { width: number; height: number };
  image?: { bitmap: CanvasImageSource; width: number; height: number };
  sourceVersion?: string;
  session?: Session;
  controller: AbortController;
  serial: number;
  lastUsed: number;
  settled: Promise<void>;
  settleResolve: () => void;
}

const DEFAULT_CACHE_LIMITS = { maxEntries: 32, maxBytes: 256 * 1024 * 1024 };
/** Declared neutral target background when a surface supplies none (headless/tests). */
const NEUTRAL_BACKGROUND: readonly [number, number, number] = [1, 1, 1];

export function createUnderlayDisplayService(deps: {
  engine: UnderlayRasterEngine;
  bytesFor: UnderlayByteSource;
  definitions: () => Readonly<Record<string, UnderlayDefinition>> | undefined;
  requestRedraw?: () => void;
  /** Long-edge pixel target for rasters (the engine's per-page cap still rules). */
  targetPixels?: number;
  /** The page region currently visible for a definition (engine clip space). */
  visibleRegion?: (def: UnderlayDefinition) => UnderlayClipRect | undefined;
  /** Canvas factory for the tile composite. Default: DOM canvases. */
  tileCanvasFactory?: UnderlayCanvasFactory;
  /** Declared target background of the consuming surface (design A.2.1). */
  targetBackground?: () => readonly [number, number, number];
  /** Pixel-access canvas factory for style variants; absent = raw serves (headless). */
  variantCanvasFactory?: UnderlayVariantCanvasFactory;
  /** Cache budgets (design 3.5); injectable for eviction tests. */
  cacheLimits?: { maxEntries?: number; maxBytes?: number };
}): UnderlayDisplayService {
  const target = deps.targetPixels ?? 1024;
  const limits = { ...DEFAULT_CACHE_LIMITS, ...(deps.cacheLimits ?? {}) };
  let epoch = 0;
  let disposed = false;
  let clock = 0;
  const generations = new Map<string, number>();
  const entries = new Map<string, Entry>();
  const memos = new Map<string, ByteMemo>();
  const sessions = new Map<string, Session>();
  const variants = new Map<string, { bitmap: CanvasImageSource; width: number; height: number }>();
  const memoBytes = new Map<string, number>();

  const generationOf = (defId: string): number => generations.get(defId) ?? 0;
  const memoKeyFor = (def: UnderlayDefinition): string =>
    [epoch, generationOf(def.id), def.id, def.sourcePath].join('|');
  const scaleBucketOf = (t: number): string => {
    // 1.5x ladder anchored at 1024 (design 4.3); the bucket names the step
    // at or above the service's target. Renders use the exact target.
    let step = 1024;
    while (step < t) step = Math.round(step * 1.5);
    return `s${step}`;
  };
  const regionBucketOf = (hint: UnderlayClipRect | undefined, page: { width: number; height: number } | undefined): { bucket: string; region?: UnderlayClipRect } => {
    if (!hint) return { bucket: 'full' };
    if (!page) return { bucket: `raw:${hint.x},${hint.y},${hint.width},${hint.height}`, region: hint };
    // Quantize outward to a 1/16-page grid per axis, then clamp (design 4.3).
    const cx = page.width / 16;
    const cy = page.height / 16;
    const x = Math.max(0, Math.floor(hint.x / cx) * cx);
    const y = Math.max(0, Math.floor(hint.y / cy) * cy);
    const x1 = Math.min(page.width, Math.ceil((hint.x + hint.width) / cx) * cx);
    const y1 = Math.min(page.height, Math.ceil((hint.y + hint.height) / cy) * cy);
    const region = { x, y, width: x1 - x, height: y1 - y };
    return { bucket: `r:${x},${y},${region.width},${region.height}`, region };
  };

  const memoFor = (def: UnderlayDefinition): { key: string; memo: ByteMemo } => {
    const key = memoKeyFor(def);
    let memo = memos.get(key);
    if (!memo) {
      const promise = (async () => {
        const bytes = await deps.bytesFor(def);
        if (!bytes) return null;
        const sourceVersion = await sha256Hex(bytes);
        memoBytes.set(key, bytes.length);
        return { bytes, sourceVersion };
      })();
      memo = { promise };
      memos.set(key, memo);
    }
    return { key, memo };
  };

  const closeSessionDoc = (session: Session): void => {
    if (session.doc) {
      const doc = session.doc;
      session.doc = undefined;
      try { doc.close(); } catch { /* a close never throws into the cache */ }
    }
  };

  const retireSession = (session: Session): void => {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(session.memoKey);
    if (!session.controller.signal.aborted) session.controller.abort();
    closeSessionDoc(session);
    // If the open is still in flight, the arriving document is closed by
    // openSession's late-arrival path (test 3 of the R-5 gate).
  };

  const retireEntry = (entry: Entry): void => {
    entries.delete(entry.key);
    if (!entry.controller.signal.aborted) entry.controller.abort();
    entry.settleResolve();
    const session = entry.session;
    if (session) {
      session.entries.delete(entry);
      entry.session = undefined;
      if (session.entries.size === 0) retireSession(session);
    }
  };

  const accountedBytes = (): number => {
    let total = 0;
    for (const e of entries.values()) if (e.image) total += e.image.width * e.image.height * 4;
    for (const n of memoBytes.values()) total += n;
    return total;
  };

  const evictIfNeeded = (protect?: Entry): void => {
    // Evict-abort first, LRU among the unprotected; the entry touched in
    // this call stack (protect) is never evicted by its own call.
    while (entries.size > limits.maxEntries || accountedBytes() > limits.maxBytes) {
      let victim: Entry | undefined;
      for (const e of entries.values()) {
        if (e === protect) continue;
        if (!victim || e.lastUsed < victim.lastUsed) victim = e;
      }
      if (!victim) return;
      retireEntry(victim);
    }
  };

  const openSession = (session: Session, bytes: Uint8Array): Promise<UnderlayDocument | undefined> => {
    if (session.doc) return Promise.resolve(session.doc);
    if (!session.openPromise) {
      session.openPromise = (async () => {
        const opened = await deps.engine.open(bytes, { signal: session.controller.signal });
        if (!opened.ok) return undefined;
        if (session.closed) {
          // Late arrival after retirement: close immediately, never serve.
          try { opened.value.close(); } catch { /* ignore */ }
          return undefined;
        }
        session.doc = opened.value;
        return session.doc;
      })();
    }
    return session.openPromise;
  };

  const guardLive = (entry: Entry, serial: number): boolean => {
    if (disposed
      || entries.get(entry.key) !== entry
      || entry.serial !== serial
      || entry.epoch !== epoch
      || entry.generation !== generationOf(entry.defId)
      || entry.controller.signal.aborted) return false;
    // A definition edited mid-flight (Save-As class: same id, new path)
    // retires the load even when no epoch/generation moved (R-5 test 4).
    const defsNow = deps.definitions();
    const current = defsNow ? Object.values(defsNow).find((d) => d.id === entry.defId) : undefined;
    return !!current && current.sourcePath === entry.sourcePath;
  };

  const startLoad = (def: UnderlayDefinition, opts: { region?: UnderlayClipRect; regionBucket: string; target: number; scaleBucket: string; dpi?: number }): Entry => {
    const pageIndex = underlayPageIndex(def);
    const key = [epoch, def.id, def.sourcePath, 'v?', pageIndex, opts.regionBucket, opts.scaleBucket].join('|');
    const existing = entries.get(key);
    if (existing) return existing;
    let settleResolve!: () => void;
    const settled = new Promise<void>((r) => { settleResolve = r; });
    const entry: Entry = {
      key, defId: def.id, sourcePath: def.sourcePath, pageIndex,
      regionBucket: opts.regionBucket, scaleBucket: opts.scaleBucket,
      region: opts.region, target: opts.target, dpi: opts.dpi,
      epoch, generation: generationOf(def.id),
      state: 'loading', controller: new AbortController(), serial: 0,
      lastUsed: ++clock, settled, settleResolve,
    };
    entries.set(key, entry);
    const serial = ++entry.serial;
    const { key: memoKey, memo } = memoFor(def);
    let session = sessions.get(memoKey);
    if (!session || session.closed) {
      session = { memoKey, defId: def.id, controller: new AbortController(), closed: false, entries: new Set() };
      sessions.set(memoKey, session);
    }
    entry.session = session;
    session.entries.add(entry);
    evictIfNeeded(entry);
    void (async () => {
      const fail = (): void => {
        if (!guardLive(entry, serial)) return;
        if (entry.controller.signal.aborted) return; // aborted loads never settle failed
        entry.state = 'failed';
        entry.settleResolve();
      };
      try {
        const got = await memo.promise;
        if (!guardLive(entry, serial)) return;
        if (!got) { fail(); return; }
        entry.sourceVersion = got.sourceVersion;
        const doc = await openSession(session!, got.bytes);
        if (!guardLive(entry, serial)) return;
        if (!doc) { fail(); return; }
        const signal = entry.controller.signal;
        if (entry.pageIndex > doc.pageCount) { fail(); return; }
        const sized = await doc.pageSize(entry.pageIndex, { signal });
        if (!guardLive(entry, serial)) return;
        if (!sized.ok) { fail(); return; }
        const size = sized.value;
        entry.page = size;
        const scale = entry.dpi ? entry.dpi / 72 : entry.target / Math.max(size.width, size.height);
        const hint = entry.region;
        const region: UnderlayClipRect | undefined = hint
          ? {
              x: Math.max(0, hint.x),
              y: Math.max(0, hint.y),
              width: Math.min(size.width, hint.x + hint.width) - Math.max(0, hint.x),
              height: Math.min(size.height, hint.y + hint.height) - Math.max(0, hint.y),
            }
          : undefined;
        if (region && region.width > 0 && region.height > 0) {
          const tiles = planUnderlayTiles(region, scale, DEFAULT_UNDERLAY_CAPS.maxScanBytes);
          if (tiles.length === 0) { fail(); return; }
          const factory = deps.tileCanvasFactory ?? domTileCanvasFactory;
          const width = Math.max(1, Math.ceil(size.width * scale));
          const height = Math.max(1, Math.ceil(size.height * scale));
          const composite = factory.create(width, height);
          const ctx = composite.context as { drawImage(image: unknown, dx: number, dy: number): void };
          for (const tile of tiles) {
            const r = await doc.renderRegion(entry.pageIndex, tile, scale, { signal });
            if (!guardLive(entry, serial)) return;
            if (!r.ok) { fail(); return; }
            ctx.drawImage(r.value.image, Math.round(tile.x * scale), Math.round(tile.y * scale));
          }
          entry.image = { bitmap: composite.canvas as CanvasImageSource, width: composite.width, height: composite.height };
        } else {
          const raster = await doc.renderPage(entry.pageIndex, scale, { signal });
          if (!guardLive(entry, serial)) return;
          if (!raster.ok) { fail(); return; }
          entry.image = { bitmap: raster.value.image as CanvasImageSource, width: raster.value.width, height: raster.value.height };
        }
        entry.state = 'ready';
        entry.settleResolve();
        evictIfNeeded(entry);
        deps.requestRedraw?.();
      } catch {
        fail(); // the seam promises refusals, but a display cache never throws
      }
    })();
    return entry;
  };

  const keyFor = (def: UnderlayDefinition, regionBucket: string, scaleBucket: string): string =>
    [epoch, def.id, def.sourcePath, 'v?', underlayPageIndex(def), regionBucket, scaleBucket].join('|');

  const styleOf = (e: UnderlayEntity): { contrast?: number; mono: boolean; background: readonly [number, number, number] } => ({
    contrast: e.contrast,
    mono: underlayMonochrome(underlayPlacementOf(e)),
    background: deps.targetBackground?.() ?? NEUTRAL_BACKGROUND,
  });

  const contentFor = (def: UnderlayDefinition, entry: Entry, e: UnderlayEntity): UnderlayDisplayContent => {
    const view = def.extent ? def : (entry.page ? { ...def, extent: entry.page } : def);
    if (!entry.image || !entry.page) return { definition: view };
    const style = styleOf(e);
    const identity = (style.contrast === undefined || style.contrast === 100) && !style.mono;
    if (identity || !deps.variantCanvasFactory) {
      return { definition: view, page: entry.page, image: entry.image };
    }
    const vKey = [entry.key, entry.sourceVersion ?? '', underlayStyleKey(style), underlayBackgroundKey(style.background)].join('|');
    let variant = variants.get(vKey);
    if (!variant) {
      const raw = entry.image;
      const slot = deps.variantCanvasFactory.create(raw.width, raw.height);
      slot.context.drawImage(raw.bitmap, 0, 0);
      const pixels = slot.context.getImageData(0, 0, raw.width, raw.height);
      const adjusted = adjustUnderlayPixels(pixels.data, raw.width, raw.height, style);
      slot.context.putImageData({ data: adjusted }, 0, 0);
      variant = { bitmap: slot.canvas as CanvasImageSource, width: raw.width, height: raw.height };
      variants.set(vKey, variant);
    }
    return { definition: view, page: entry.page, image: variant };
  };

  const resolveDef = (e: UnderlayEntity): UnderlayDefinition | undefined => {
    const defs = deps.definitions();
    if (!defs) return undefined;
    return Object.values(defs).find((d) => (d.handle ?? '').toUpperCase() === e.definitionHandle);
  };

  /** The entry source() would use for this placement right now, starting loads as needed. */
  const entryFor = (e: UnderlayEntity, def: UnderlayDefinition): { entry: Entry; fallback?: Entry } => {
    const hint = deps.visibleRegion?.(def);
    const knownPage = def.extent ?? [...entries.values()].find((x) => x.defId === def.id && x.page)?.page;
    const { bucket, region } = regionBucketOf(hint, knownPage);
    const scaleBucket = scaleBucketOf(target);
    const bestReady = (): Entry | undefined => {
      let best: Entry | undefined;
      for (const x of entries.values()) {
        if (x.defId !== def.id || x.pageIndex !== underlayPageIndex(def) || x.state !== 'ready') continue;
        if (!best) best = x;
      }
      return best;
    };
    const exact = entries.get(keyFor(def, bucket, scaleBucket));
    if (exact) {
      exact.lastUsed = ++clock;
      // A failed or still-loading exact entry does not hide a ready raster
      // for the same definition + page (refinement posture, design 4.3).
      return exact.state === 'ready' ? { entry: exact } : { entry: exact, fallback: bestReady() };
    }
    const fallback = bestReady();
    if (disposed) return { entry: undefined as unknown as Entry, fallback };
    const entry = startLoad(def, { region, regionBucket: bucket, target, scaleBucket });
    return { entry, fallback };
  };

  const service: UnderlayDisplayService = {
    source(e: UnderlayEntity): UnderlayDisplayContent | undefined {
      const def = resolveDef(e);
      if (!def) return undefined; // dangling: frame + cross, no label (C2)
      if (def.kind !== 'pdf') return { definition: def }; // DWF/DGN: no admitted decoder
      const { entry, fallback } = entryFor(e, def);
      const use = entry && entry.state === 'ready' ? entry : (fallback ?? (entry && entry.state === 'ready' ? entry : undefined));
      if (entry) entry.lastUsed = ++clock;
      if (!use) return { definition: def };
      return contentFor(def, use, e);
    },
    clear(): void {
      epoch += 1;
      for (const entry of [...entries.values()]) retireEntry(entry);
      entries.clear();
      for (const session of [...sessions.values()]) retireSession(session);
      sessions.clear();
      memos.clear();
      memoBytes.clear();
      variants.clear();
    },
    invalidate(defId?: string): void {
      if (defId === undefined) {
        service.clear();
        deps.requestRedraw?.();
        return;
      }
      generations.set(defId, generationOf(defId) + 1);
      for (const entry of [...entries.values()]) if (entry.defId === defId) retireEntry(entry);
      for (const session of [...sessions.values()]) if (session.defId === defId) retireSession(session);
      for (const key of [...memos.keys()]) if (key.split('|')[2] === defId) { memos.delete(key); memoBytes.delete(key); }
      for (const key of [...variants.keys()]) if (key.split('|')[1] === defId) variants.delete(key);
      deps.requestRedraw?.();
    },
    pageSizeOf(defId: string): { width: number; height: number } | undefined {
      for (const entry of entries.values()) if (entry.defId === defId && entry.page) return entry.page;
      return undefined;
    },
    async ensure(e: UnderlayEntity): Promise<UnderlayDisplayContent | undefined> {
      const def = resolveDef(e);
      if (!def) return undefined;
      if (def.kind !== 'pdf') return { definition: def };
      const { entry } = entryFor(e, def);
      if (entry) await entry.settled;
      return service.source(e);
    },
    async loadForPlot(def: UnderlayDefinition, dpi: number): Promise<{ page: { width: number; height: number }; image: { bitmap: CanvasImageSource; width: number; height: number } } | undefined> {
      if (def.kind !== 'pdf' || disposed) return undefined;
      const entry = startLoad(def, { regionBucket: 'full', target: 0, scaleBucket: `plot:${dpi}`, dpi });
      await entry.settled;
      if (entry.state !== 'ready' || !entry.page || !entry.image) return undefined;
      return { page: entry.page, image: entry.image };
    },
    dispose(): void {
      service.clear();
      disposed = true;
    },
  };
  return service;
}

const domTileCanvasFactory: UnderlayCanvasFactory = {
  create(width: number, height: number) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('a 2d canvas context is unavailable for the tile composite');
    return { canvas, context, width, height };
  },
};
