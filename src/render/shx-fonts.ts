import { evaluateShxGlyph, parseShx, shxTextCodes, MAX_SHX_BYTES, MAX_SHX_SEGMENTS, type ShxFont, type ShxGlyphResult, type ShxPoint, type ShxSegment } from '../io/shx';
import { supportsNativeTextRun } from '../core/text-metrics';

export interface ShxResource {
  readonly bytes: Uint8Array;
  readonly resolvedPath: string;
  readonly sha256: string;
  readonly resourceId: string;
}
export type ShxTextRun =
  | { readonly ok: true; readonly segments: readonly ShxSegment[]; readonly advance: number; readonly left: number; readonly right: number; readonly ascent: number; readonly descent: number; readonly terminalSpace: boolean }
  | { readonly ok: false; readonly problem: string };
const MAX_FACES = 32;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
export const MAX_SHX_PENDING_REQUESTS = 4;
export const MAX_SHX_PENDING_BYTES = MAX_CACHE_BYTES;
export const MAX_SHX_RUN_WORK = 65536;
const MAX_RUN_CHARACTERS = 4096;
const MAX_RUN_SEGMENTS = MAX_SHX_SEGMENTS * 4;
const MAX_GLYPH_CACHE = 1024;
const MAX_CACHED_SEGMENTS = 32768;
const MAX_CACHED_INSTRUCTIONS = 131072;
const boundedGeometry = (...values: number[]): boolean => values.every((value) => Number.isFinite(value) && Math.abs(value) <= 1e12);

const freezePoint = (x: number, y: number): ShxPoint => Object.freeze([x, y]);
const failed = (problem: string): Extract<ShxTextRun, { ok: false }> => Object.freeze({ ok: false, problem });
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
interface RetainedResource { readonly font: ShxFont; readonly snapshot: Uint8Array }
interface PendingResource { readonly snapshot: Uint8Array; readonly generation: object; promise: Promise<string> }

/**
 * Display-only resources. Callers retain per-drawing filename -> resourceId
 * associations; identical basenames in separate drawing folders never alias.
 * No runtime program or source path enters the document/undo/export model.
 */
export class ShxFontRegistry {
  private readonly resources = new Map<string, RetainedResource>();
  private readonly pending = new Map<string, PendingResource>();
  private readonly glyphs = new Map<string, ShxGlyphResult>();
  private readonly listeners = new Set<() => void>();
  private byteLength = 0;
  private pendingByteLength = 0;
  private instructionCount = 0;
  private segmentCount = 0;
  private epoch: object = {};
  private generation: object = {};
  private readOnlySnapshot = false;
  get cacheKey(): object { return this.epoch; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(): void { this.epoch = {}; for (const listener of this.listeners) listener(); }
  clear(): void { if (this.readOnlySnapshot) throw new Error('A captured SHX registry is read-only.'); this.resources.clear(); this.glyphs.clear(); this.byteLength = 0; this.instructionCount = 0; this.segmentCount = 0; this.generation = {}; this.changed(); }

  /** Captured plots own a stable loaded-resource scope and independent glyph cache. */
  capture(): ShxFontRegistry {
    const captured = new ShxFontRegistry();
    for (const [id, retained] of this.resources) captured.resources.set(id, retained);
    captured.byteLength = this.byteLength; captured.instructionCount = this.instructionCount;
    captured.readOnlySnapshot = true;
    return captured;
  }

  /** Verify bridge identity from a private byte snapshot before retaining a face. */
  async register(resource: ShxResource): Promise<string> {
    if (this.readOnlySnapshot) throw new Error('A captured SHX registry is read-only.');
    if (!resource) throw new Error('Invalid SHX resource identity.');
    const { bytes, resolvedPath, sha256: expectedHash, resourceId } = resource;
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_SHX_BYTES || typeof resolvedPath !== 'string' || !resolvedPath || resolvedPath.length > 4096 || !/^(?:[A-Za-z]:[\\/]|\/(?!\/))/.test(resolvedPath) || /[\u0000-\u001f]/.test(resolvedPath) || !/^[a-f0-9]{64}$/.test(expectedHash) || resourceId !== JSON.stringify([resolvedPath, expectedHash])) throw new Error('Invalid SHX resource identity.');
    const retained = this.resources.get(resourceId);
    if (retained) { if (!sameBytes(bytes, retained.snapshot)) throw new Error('SHX program does not match its resource identity.'); return resourceId; }
    const existing = this.pending.get(resourceId);
    if (existing) {
      if (existing.generation !== this.generation) throw new Error('SHX registry was cleared; the prior digest is still settling.');
      if (!sameBytes(bytes, existing.snapshot)) throw new Error('SHX program does not match its pending resource identity.');
      return existing.promise;
    }
    // Reserve before copies/hash jobs. Clearing loaded resources never revokes
    // accounting for a digest that still owns its private byte snapshot.
    if (this.pending.size >= MAX_SHX_PENDING_REQUESTS || this.resources.size + this.pending.size >= MAX_FACES || this.pendingByteLength + bytes.length > MAX_SHX_PENDING_BYTES || this.byteLength + this.pendingByteLength + bytes.length > MAX_CACHE_BYTES) throw new Error('SHX pending resource cache budget exceeded.');
    const generation = this.generation;
    this.pendingByteLength += bytes.length;
    let snapshot: Uint8Array<ArrayBuffer>;
    try { snapshot = new Uint8Array(bytes); } catch (error) { this.pendingByteLength -= bytes.length; throw error; }
    const entry: PendingResource = { snapshot, generation, promise: Promise.resolve('') };
    const job = Promise.resolve().then(async () => {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', snapshot));
      const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
      if (hash !== expectedHash) throw new Error('SHX program does not match its resource identity.');
      if (generation !== this.generation) throw new Error('SHX registry was cleared during resource loading.');
      const font = parseShx(snapshot);
      if (this.instructionCount + font.instructionCount > MAX_CACHED_INSTRUCTIONS) throw new Error('SHX decoded instruction cache budget exceeded.');
      this.resources.set(resourceId, Object.freeze({ font, snapshot })); this.byteLength += snapshot.length; this.instructionCount += font.instructionCount; this.changed();
      return resourceId;
    });
    entry.promise = job.finally(() => { this.pending.delete(resourceId); this.pendingByteLength -= snapshot.length; });
    this.pending.set(resourceId, entry);
    return entry.promise;
  }
  font(id: string): ShxFont | undefined { return this.resources.get(id)?.font; }
  glyph(id: string, code: number, options: { vertical?: boolean } = {}): ShxGlyphResult {
    const font = this.resources.get(id)?.font;
    if (!font) return failed('SHX resource is not loaded.');
    const key = JSON.stringify([id, code, !!options.vertical]);
    let glyph = this.glyphs.get(key);
    if (!glyph) {
      glyph = evaluateShxGlyph(font, code, options);
      const count = glyph.ok ? glyph.segments.length : 0;
      while (this.glyphs.size >= MAX_GLYPH_CACHE || this.segmentCount + count > MAX_CACHED_SEGMENTS) {
        const oldestKey = this.glyphs.keys().next().value;
        if (oldestKey === undefined) break;
        const oldest = this.glyphs.get(oldestKey)!; if (oldest.ok) this.segmentCount -= oldest.segments.length;
        this.glyphs.delete(oldestKey);
      }
      this.glyphs.set(key, glyph); this.segmentCount += count;
    }
    return glyph;
  }

  /** Horizontal text geometry in drawing-height units; unsupported runs fall back together. */
  run(id: string, text: string, height: number): ShxTextRun {
    const font = this.resources.get(id)?.font;
    if (!font || !font.isFont || font.renderProblem) return failed(font?.renderProblem ?? 'A supported SHX text font is not loaded.');
    if (typeof text !== 'string' || text.length > MAX_RUN_CHARACTERS || !Number.isFinite(height) || height <= 0 || height > 1e9) return failed('SHX text run exceeds its input budget.');
    if (!supportsNativeTextRun(text)) return failed('SHX contextual or combining text layout needs native validation.');
    const codes = shxTextCodes(font, text);
    if (!codes) return failed('SHX text encoding or control codes do not cover this run.');
    const scale = height / font.above;
    let advance = 0, left = Infinity, right = -Infinity, ascent = -Infinity, descent = -Infinity, work = 0;
    const segments: ShxSegment[] = [];
    for (const code of codes) {
      const glyph = this.glyph(id, code);
      if (glyph.ok === false) return failed(glyph.problem);
      work += glyph.work;
      if (work > MAX_SHX_RUN_WORK) return failed('SHX cumulative text evaluation work budget exceeded.');
      if (glyph.scaleDrift || Math.abs(glyph.advance[1] * scale) > 1e-8) return failed('SHX glyph changes persistent scale or vertical advance; run-state layout is not yet verified.');
      if (segments.length + glyph.segments.length > MAX_RUN_SEGMENTS) return failed('SHX text geometry budget exceeded.');
      if (glyph.bounds) {
        left = Math.min(left, advance + glyph.bounds[0] * scale); right = Math.max(right, advance + glyph.bounds[2] * scale);
        ascent = Math.max(ascent, glyph.bounds[3] * scale); descent = Math.max(descent, -glyph.bounds[1] * scale);
        if (!boundedGeometry(left, right, ascent, descent)) return failed('SHX scaled text geometry budget exceeded.');
      }
      for (const segment of glyph.segments) {
        if (segment.kind === 'arc' && !boundedGeometry(advance + segment.center[0] * scale, segment.center[1] * scale, segment.radius * scale)) return failed('SHX scaled arc geometry budget exceeded.');
        segments.push(Object.freeze(segment.kind === 'line'
          ? { kind: 'line' as const, from: freezePoint(advance + segment.from[0] * scale, segment.from[1] * scale), to: freezePoint(advance + segment.to[0] * scale, segment.to[1] * scale) }
          : { kind: 'arc' as const, center: freezePoint(advance + segment.center[0] * scale, segment.center[1] * scale), radius: segment.radius * scale, startAngle: segment.startAngle, sweep: segment.sweep }));
      }
      advance += glyph.advance[0] * scale;
      if (!boundedGeometry(advance)) return failed('SHX text advance budget exceeded.');
    }
    return Object.freeze({ ok: true, segments: Object.freeze(segments), advance, left: left === Infinity ? 0 : left, right: right === -Infinity ? 0 : right, ascent: ascent === -Infinity ? 0 : ascent, descent: descent === -Infinity || descent === 0 ? 0 : descent, terminalSpace: codes.at(-1) === 32 });
  }
}
