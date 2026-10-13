import type { DrawingState } from '../../core/document';
import type { Entity } from '../../core/entities';
import { isImmutableData } from '../../core/immutable-data';
import { TEXT_STYLES_META_KEY } from '../../io/encoding';
import { lineweightDisplay } from '../draw';
import { GpuDevice } from './device';
import { isSourcePrecisionCertificateError, isSourceTopologyAdmissionError } from './stroke-precision-error';
import { cssRgb, GPU_ZOOM_VERTEX_STRIDE, prepareZoom2D, prepareZoomLine, replacementZoomBounds, validateGpu2DView, zoomPrecisionSafe, type Gpu2DView, type Gpu2DOverlay, type PreparedZoom2D, type PreparedZoomEntity, type PreparedZoomLine } from './geometry2d';

export type { Gpu2DView, Gpu2DOverlay } from './geometry2d';
export type Gpu2DCacheReason = 'not-checked' | 'cold' | 'mutable' | 'document' | 'document-delta' | 'view-style' | 'zoom-range' | 'pan-range' | 'precision' | 'hit' | 'refusal-hit' | 'admission-deferred';
export const GPU_EDIT_HISTORY_BYTES = 1024 * 1024;
export const GPU_EDIT_HISTORY_ENTRIES = 256;
export const GPU_ADMISSION_IDLE_MS = 100;
export const GPU_ADMISSION_SLOW_PREPARATION_MS = 50;
export const GPU_ADMISSION_DEFERRED_REASON = 'GPU admission deferred after a prior slow "Stroke geometry exceeds prototype budget" refusal; retrying the current view after 100 ms idle';
export interface Gpu2DRenderResult {
  rendered: boolean;
  reason?: string;
  /** CPU wall time, including cache checks and all preparation. */
  preparationMs: number;
  /** Total CPU GL phase, including resize, initialization, uploads and draw commands. */
  submissionMs: number;
  /** CPU cache validation/lookup, bounds union and recovery-image patch; excludes line geometry preparation. */
  cacheLookupMs: number;
  /** CPU projection, tessellation, clipping and packing; exactly zero on a cache hit. */
  geometryPreparationMs: number;
  /** Subset of geometryPreparationMs: preparing a candidate replacement line. */
  partialPreparationMs: number;
  preparedEntities: number;
  reusedEntities: number;
  editMemoHit: boolean;
  editHistoryBytes: number;
  editHistoryEntries: number;
  /** CPU shader initialization; excludes GPU completion and is zero on a warm program. */
  initializationMs: number;
  /** CPU buffer allocation/upload issuance and error checking, not transfer/GPU completion. */
  uploadMs: number;
  /** Allocation/upload attempts; a failed allocation may not reach bufferData. */
  uploadCalls: number;
  uploadKind: 'none' | 'subrange' | 'full';
  /** Subsets of total upload telemetry, including failed subrange attempts. */
  subrangeUploadMs: number;
  subrangeUploadCalls: number;
  subrangeUploadBytes: number;
  /** CPU state/uniform/clear/draw commands and error checking, excluding uploads/initialization. */
  drawSubmissionMs: number;
  geometryVertices: number;
  /** Actual certified ratios relative to the stored mesh's copied camera anchor. */
  cacheMinRatio: number | null;
  cacheMaxRatio: number | null;
  cacheHit: boolean;
  cacheReason: Gpu2DCacheReason;
  /** Requested upload bytes (confirmed on success); a warm geometry/buffer cache reports zero. */
  bytes: number;
}

export function emptyGpu2DRenderResult(reason: string): Gpu2DRenderResult {
  return { rendered: false, reason, preparationMs: 0, submissionMs: 0, cacheLookupMs: 0, geometryPreparationMs: 0, partialPreparationMs: 0, preparedEntities: 0, reusedEntities: 0, editMemoHit: false, editHistoryBytes: 0, editHistoryEntries: 0, initializationMs: 0, uploadMs: 0, uploadCalls: 0, uploadKind: 'none', subrangeUploadMs: 0, subrangeUploadCalls: 0, subrangeUploadBytes: 0, drawSubmissionMs: 0, geometryVertices: 0, cacheMinRatio: null, cacheMaxRatio: null, cacheHit: false, cacheReason: 'not-checked', bytes: 0 };
}

const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_center;
layout(location = 1) in vec3 a_color;
layout(location = 2) in vec2 a_offset;
uniform vec2 u_view;
uniform vec2 u_backing;
uniform float u_nativeDPR;
uniform vec2 u_pan;
uniform float u_zoom;
out vec3 v_color;
void main() {
  vec2 position = a_center * u_zoom + u_pan + u_view * 0.5 + a_offset;
  // Canvas uses a Float32 scale coefficient, while the backing size is rounded
  // independently. Keep the logical origin and fixed CSS extrusion unchanged.
  vec2 physical = position * u_nativeDPR;
  gl_Position = vec4(physical.x / u_backing.x * 2.0 - 1.0,
                     1.0 - physical.y / u_backing.y * 2.0, 0.0, 1.0);
  v_color = a_color;
}`;
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 v_color;
uniform float u_alpha;
out vec4 out_color;
void main() { out_color = vec4(v_color, u_alpha); }`;

interface PreparationCache {
  entities: DrawingState['entities'];
  layers: DrawingState['layers'];
  linetypes: NonNullable<DrawingState['header']>['linetypes'] | undefined;
  view: Gpu2DView;
  selection: ReadonlySet<string>;
  hover: string | null;
  solidSelection: boolean;
  geometry: PreparedZoom2D;
  generation: number;
  immutableState: boolean;
}

interface SubrangeUpload { baseGeneration: number; byteOffset: number; vertices: Float32Array<ArrayBuffer> }
interface PreparedFrame { geometry: PreparedZoom2D; pan: Gpu2DView['center']; ratio: number; generation: number; delta?: SubrangeUpload }

interface GeometryRefusalCache {
  /** A sealed whole snapshot conservatively certifies every current/future scene dependency. */
  state: DrawingState;
  view: Gpu2DView;
  selection: ReadonlySet<string>;
  hover: string | null;
  solidSelection: boolean;
  reason: string;
}

class GeometryRefusalMemoError extends Error {}
class AdmissionDeferredError extends Error {}

interface SlowBudgetAdmission {
  /** Evidence for a prior admission only, never a certificate for the present view. */
  state: DrawingState;
  preparationMs: number;
}

/** Only deliberate admission errors from pure geometry preparation qualify. Unknown
 * failures keep retrying; native allocation/programming exceptions are never memoized. */
function geometryAdmissionRefusal(error: unknown): error is Error {
  if (!(error instanceof Error) || error.message.length > 4096 ||
    !/^(?:Unsupported (?:entity:|annotative|dashed linetype:|transparency|filled circle|polyline|display color|Canvas (?:font|ARC|stroke construction:)|block (?:transform|array)|external reference:|bold stroke text|stroke-scene display color)|Dashed selection |Nonfinite |Projected coordinates |Invalid (?:curve|arc|ARC|polyline|TEXT|placed TEXT|lineweight)|Curve |Stroke (?:geometry|length)|Polyline |GPU zoom geometry|Float32 stroke geometry|Stroke-scene (?:expansion|geometry|text preflight|block nesting)|Cyclic block reference:|Missing block definition:|Incomplete block expansion|Canvas (?:world|text preflight|ARC)|TEXT is too close)/.test(error.message)) return false;
  // The compound lowerer wraps its original failure. Reject non-admission native
  // exceptions rather than allowing the wrapper to erase their provenance.
  const needsPrecisionCertificate = error.message.startsWith('Canvas world-coordinate quantization ');
  const needsSourceCertificate = needsPrecisionCertificate ||
    error.message.startsWith('Unsupported Canvas stroke construction: ');
  let certifiedSource = false;
  let source: unknown = error;
  for (let depth = 0; depth < 4; depth++) {
    if (!(source instanceof Error) || Object.getPrototypeOf(source) !== Error.prototype) return false;
    certifiedSource ||= source.message === error.message && (isSourcePrecisionCertificateError(source) || (!needsPrecisionCertificate && isSourceTopologyAdmissionError(source)));
    const descriptor = Object.getOwnPropertyDescriptor(source, 'cause');
    if (descriptor && !('value' in descriptor)) return false;
    if (!descriptor || descriptor.value === undefined) return !needsSourceCertificate || certifiedSource;
    source = descriptor.value;
  }
  return false;
}

function sameRefusalView(a: Gpu2DView, b: Gpu2DView): boolean {
  return Object.is(a.width, b.width) && Object.is(a.height, b.height) && Object.is(a.dpr, b.dpr) && Object.is(a.scale, b.scale) && Object.is(a.center.x, b.center.x) && Object.is(a.center.y, b.center.y) && Object.is(a.twist, b.twist) && a.background === b.background && a.lineweights === (b.lineweights ?? lineweightDisplay.enabled);
}

function sameStrokeStyle(a: Pick<PreparedZoomEntity, 'color' | 'width' | 'alpha'>, b: Pick<PreparedZoomLine, 'color' | 'width' | 'alpha'>): boolean {
  return a.width === b.width && a.alpha === b.alpha && a.color.every((value, index) => value === b.color[index]);
}

function sameSelection(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function sameCompoundDependencies(geometry: PreparedZoom2D, state: DrawingState): boolean {
  const compound = geometry.compound;
  if (!compound) return true;
  if (compound.textStylesDependency !== state.meta?.[TEXT_STYLES_META_KEY]) return false;
  for (const [name, definition] of compound.blockDependencies) if (state.blocks[name] !== definition) return false;
  return true;
}

/** Prototype model-space painter. Refusals leave full Canvas rendering to the caller. */
export class Gpu2DRenderer {
  readonly device: GpuDevice;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private viewUniform: WebGLUniformLocation | null = null;
  private backingUniform: WebGLUniformLocation | null = null;
  private nativeDPRUniform: WebGLUniformLocation | null = null;
  private panUniform: WebGLUniformLocation | null = null;
  private zoomUniform: WebGLUniformLocation | null = null;
  private alphaUniform: WebGLUniformLocation | null = null;
  private uploadedGeneration: number | null = null;
  private generation = 0;
  private cache: PreparationCache | null = null;
  private refusalCache: GeometryRefusalCache | null = null;
  private slowBudgetAdmission: SlowBudgetAdmission | null = null;
  private admissionIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleAdmissionAllowed = false;
  private readonly editHistory = new Map<Entity, PreparedZoomLine>();
  private editHistoryBytes = 0;
  private initializationError: string | null = null;
  private viewportLimits: readonly number[] | null = null;
  private stencilAvailable: boolean | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly onStateChange?: () => void) {
    this.device = new GpuDevice(canvas, () => {
      // Handles from a lost context must never be reused, even when GL's object identity stays.
      this.program = null;
      this.buffer = null;
      this.viewUniform = null;
      this.backingUniform = null;
      this.nativeDPRUniform = null;
      this.panUniform = null;
      this.zoomUniform = null;
      this.alphaUniform = null;
      this.uploadedGeneration = null;
      this.cache = null;
      this.clearRefusalCache();
      this.clearEditHistory();
      this.initializationError = null;
      this.viewportLimits = null;
      this.stencilAvailable = null;
      onStateChange?.();
    });
  }

  /** Mode changes clear refused admission/policy; healthy CPU/upload caches remain reusable. */
  clearRefusalCache(): void { this.refusalCache = null; this.clearAdmissionDeferral(); }

  private clearAdmissionDeferral(): void {
    if (this.admissionIdleTimer !== null) clearTimeout(this.admissionIdleTimer);
    this.admissionIdleTimer = null;
    this.slowBudgetAdmission = null;
    this.idleAdmissionAllowed = false;
  }

  private scheduleAdmissionRetry(): void {
    if (this.admissionIdleTimer !== null) clearTimeout(this.admissionIdleTimer);
    const prior = this.slowBudgetAdmission;
    const timer = setTimeout(() => {
      if (this.admissionIdleTimer !== timer || this.slowBudgetAdmission !== prior) return;
      this.admissionIdleTimer = null;
      try {
        if (this.device.state !== 'ready' || this.device.gl.isContextLost()) { this.clearAdmissionDeferral(); return; }
        this.idleAdmissionAllowed = true;
        // The owner fetches its current drawing/view/overlay, never a captured old pose.
        this.onStateChange?.();
      } catch { this.clearAdmissionDeferral(); }
    }, GPU_ADMISSION_IDLE_MS);
    this.admissionIdleTimer = timer;
  }

  private clearEditHistory(): void {
    this.editHistory.clear();
    this.editHistoryBytes = 0;
  }

  private forgetEdit(entity: Entity): void {
    const old = this.editHistory.get(entity);
    if (old) { this.editHistoryBytes -= old.vertices.byteLength; this.editHistory.delete(entity); }
  }

  private rememberEdit(entity: PreparedZoomEntity, vertices: Float32Array<ArrayBuffer>): void {
    this.forgetEdit(entity.entity);
    this.editHistory.set(entity.entity, { vertices, color: entity.color, width: entity.width, alpha: entity.alpha, sourceBounds: entity.sourceBounds });
    this.editHistoryBytes += vertices.byteLength;
    while (this.editHistoryBytes > GPU_EDIT_HISTORY_BYTES || this.editHistory.size > GPU_EDIT_HISTORY_ENTRIES) {
      const oldest = this.editHistory.keys().next().value;
      if (!oldest) break;
      this.forgetEdit(oldest);
    }
  }

  private prepareEdit(cache: PreparationCache, state: DrawingState, view: Gpu2DView, overlay: Gpu2DOverlay, pan: Gpu2DView['center'], ratio: number, metrics: Gpu2DRenderResult): PreparedFrame | null {
    const entries = cache.geometry.entities;
    // A mutable outer snapshot or a dirty/unknown GPU buffer cannot certify a delta base.
    if (!entries || !cache.immutableState || !isImmutableData(state) || this.uploadedGeneration !== cache.generation || cache.entities.length !== state.entities.length) return null;
    let index = -1;
    for (let i = 0; i < state.entities.length; i++) {
      if (state.entities[i] === cache.entities[i]) continue;
      if (index !== -1 || state.entities[i]!.id !== cache.entities[i]!.id) return null;
      index = i;
    }
    if (index < 0) return null;
    const previous = entries[index], entity = state.entities[index]!;
    if (!previous || previous.editableLine === false || previous.entity !== cache.entities[index] || previous.entity.type !== 'line' || entity.type !== 'line' || entity.layer !== previous.entity.layer) return null;
    let replacement = this.editHistory.get(entity);
    const memoHit = !!replacement;
    if (!replacement) {
      const partialStart = performance.now();
      metrics.preparedEntities++;
      try { replacement = prepareZoomLine(entity, state, cache.view, overlay, cache.geometry.extent, cache.geometry.maxRatio); }
      catch { return null; } // Normal full-scene preparation decides the complete-view refusal.
      finally {
        const elapsed = Math.max(0, performance.now() - partialStart);
        metrics.partialPreparationMs += elapsed;
        metrics.geometryPreparationMs += elapsed;
      }
    }
    if (!sameStrokeStyle(previous, replacement) || replacement.vertices.length / GPU_ZOOM_VERTEX_STRIDE !== previous.count) return null;
    const floatOffset = previous.first * GPU_ZOOM_VERTEX_STRIDE;
    if (!Number.isSafeInteger(floatOffset) || floatOffset < 0 || floatOffset + replacement.vertices.length > cache.geometry.vertices.length) return null;
    const sourceBounds = replacementZoomBounds(entries, index, replacement.sourceBounds);
    if (!zoomPrecisionSafe({ ...cache.geometry, sourceBounds }, view, ratio, pan)) return null;
    // Allocate and validate all candidate data before mutating the private CPU recovery image.
    const nextEntries = entries.slice();
    nextEntries[index] = { ...previous, entity, sourceBounds: replacement.sourceBounds };
    const oldVertices = cache.geometry.vertices.slice(floatOffset, floatOffset + replacement.vertices.length);
    const baseGeneration = cache.generation;
    cache.geometry.vertices.set(replacement.vertices, floatOffset);
    cache.geometry.entities = nextEntries;
    cache.geometry.sourceBounds = sourceBounds;
    cache.entities = state.entities;
    cache.generation = ++this.generation;
    this.forgetEdit(entity); // The current slot is held by the CPU image, not duplicated in history.
    this.rememberEdit(previous, oldVertices);
    metrics.editMemoHit = memoHit;
    metrics.reusedEntities = cache.geometry.entityCount - (memoHit ? 0 : 1);
    metrics.cacheReason = 'document-delta';
    return { geometry: cache.geometry, pan, ratio, generation: cache.generation, delta: { baseGeneration, byteOffset: floatOffset * Float32Array.BYTES_PER_ELEMENT, vertices: replacement.vertices } };
  }

  private prepare(state: DrawingState, view: Gpu2DView, overlay: Gpu2DOverlay, metrics: Gpu2DRenderResult): PreparedFrame {
    const lookupStart = performance.now();
    const refused = this.refusalCache;
    this.refusalCache = null; // Only the immediately preceding exact pose can qualify.
    validateGpu2DView(view);
    const immutable = isImmutableData(state);
    if (!immutable) this.clearAdmissionDeferral();
    if (refused && immutable && refused.state === state && sameRefusalView(refused.view, view) && sameSelection(refused.selection, overlay.selection) && refused.hover === (overlay.hover ?? null) && refused.solidSelection === !!overlay.solidSelection) {
      this.refusalCache = refused;
      metrics.cacheReason = 'refusal-hit';
      metrics.cacheLookupMs = Math.max(0, performance.now() - lookupStart);
      throw new GeometryRefusalMemoError(refused.reason);
    }
    const linetypes = state.header?.linetypes;
    // Identity is safe only for snapshots certified immutable by the drawing core.
    const cache = this.cache;
    const unchangedScene = cache?.entities === state.entities && cache.layers === state.layers;
    const compiled = unchangedScene ? !!cache.geometry.compound : state.entities.some((entity) =>
      (entity.type === 'insert' || entity.type === 'text' || entity.type === 'hatch') && !state.layers.some((layer) => layer.name === entity.layer && !layer.visible));
    const textStyles = compiled ? state.meta?.[TEXT_STYLES_META_KEY] : undefined;
    const compiledImmutable = !compiled || (isImmutableData(state.blocks) && (!textStyles || typeof textStyles !== 'object' || isImmutableData(textStyles)));
    const cacheable = isImmutableData(state.entities) && isImmutableData(state.layers) && (!linetypes || isImmutableData(linetypes)) && compiledImmutable;
    metrics.cacheReason = !cacheable ? 'mutable' : !cache ? 'cold' : 'document';
    if (cacheable && cache && cache.layers === state.layers && cache.linetypes === linetypes && sameCompoundDependencies(cache.geometry, state)) {
      const lineweights = view.lineweights ?? lineweightDisplay.enabled;
      const sameStyle = cache.view.width === view.width && cache.view.height === view.height && cache.view.dpr === view.dpr && cache.view.twist === view.twist && cache.view.lineweights === lineweights && sameSelection(cache.selection, overlay.selection) && cache.hover === (overlay.hover ?? null) && cache.solidSelection === !!overlay.solidSelection;
      metrics.cacheReason = 'view-style';
      if (sameStyle) {
        // Subtract world centers in JS doubles before packing only the small screen translation.
        const dx = cache.view.center.x - view.center.x, dy = cache.view.center.y - view.center.y;
        const c = Math.cos(view.twist), s = Math.sin(view.twist);
        const pan = { x: (dx * c - dy * s) * view.scale, y: -(dx * s + dy * c) * view.scale };
        const ratio = view.scale / cache.view.scale;
        metrics.cacheReason = 'zoom-range';
        if (Number.isFinite(ratio) && ratio >= cache.geometry.minRatio && ratio <= cache.geometry.maxRatio) {
          metrics.cacheReason = 'pan-range';
          if (Number.isFinite(pan.x) && Number.isFinite(pan.y) && Math.abs(pan.x) <= cache.geometry.padding && Math.abs(pan.y) <= cache.geometry.padding) {
            metrics.cacheReason = 'precision';
            if (cache.entities === state.entities && zoomPrecisionSafe(cache.geometry, view, ratio, pan)) {
              this.clearAdmissionDeferral();
              metrics.cacheHit = true;
              metrics.cacheReason = 'hit';
              metrics.reusedEntities = cache.geometry.entityCount;
              metrics.cacheLookupMs = Math.max(0, performance.now() - lookupStart);
              return { geometry: cache.geometry, pan, ratio, generation: cache.generation };
            }
            if (cache.entities !== state.entities) {
              const edited = this.prepareEdit(cache, state, view, overlay, pan, ratio, metrics);
              if (edited) {
                this.clearAdmissionDeferral();
                metrics.cacheLookupMs = Math.max(0, performance.now() - lookupStart - metrics.partialPreparationMs);
                return edited;
              }
              metrics.cacheReason = 'document';
            }
          }
        }
      }
    }
    // A failed candidate has already done real geometry work. Keep that measured
    // work and complete normal admission rather than misreporting a zero-work deferral.
    if (immutable && this.slowBudgetAdmission && !this.idleAdmissionAllowed && metrics.preparedEntities === 0 && metrics.geometryPreparationMs === 0) {
      metrics.cacheReason = 'admission-deferred';
      metrics.cacheLookupMs = Math.max(0, performance.now() - lookupStart);
      this.scheduleAdmissionRetry();
      throw new AdmissionDeferredError(GPU_ADMISSION_DEFERRED_REASON);
    }
    this.idleAdmissionAllowed = false; // Exactly one fresh admission after an idle callback.
    metrics.cacheLookupMs = Math.max(0, performance.now() - lookupStart - metrics.partialPreparationMs);
    this.clearEditHistory();
    const geometryStart = performance.now();
    let geometry: PreparedZoom2D;
    try {
      geometry = !cacheable ? prepareZoom2D(state, view, overlay, 1, 1, 0)
        : immutable ? prepareZoom2D(state, view, overlay, undefined, undefined, undefined, { certifyStraightZoomIn: true })
          : prepareZoom2D(state, view, overlay);
    }
    catch (error) {
      const elapsed = Math.max(0, performance.now() - geometryStart);
      this.clearAdmissionDeferral();
      if (immutable && geometryAdmissionRefusal(error) && error.message === 'Stroke geometry exceeds prototype budget' && elapsed > GPU_ADMISSION_SLOW_PREPARATION_MS) {
        this.slowBudgetAdmission = { state, preparationMs: elapsed };
      }
      if (immutable && geometryAdmissionRefusal(error)) {
        this.refusalCache = { state, view: { ...view, center: { ...view.center }, lineweights: view.lineweights ?? lineweightDisplay.enabled }, selection: new Set(overlay.selection), hover: overlay.hover ?? null, solidSelection: !!overlay.solidSelection, reason: error.message };
        throw new GeometryRefusalMemoError(error.message);
      }
      throw error;
    }
    finally { metrics.geometryPreparationMs += Math.max(0, performance.now() - geometryStart); }
    this.clearAdmissionDeferral();
    metrics.preparedEntities += geometry.entityCount;
    const generation = ++this.generation;
    this.cache = cacheable ? { entities: state.entities, layers: state.layers, linetypes, view: { ...view, center: { ...view.center }, lineweights: view.lineweights ?? lineweightDisplay.enabled }, selection: new Set(overlay.selection), hover: overlay.hover ?? null, solidSelection: !!overlay.solidSelection, geometry, generation, immutableState: isImmutableData(state) } : null;
    return { geometry, pan: { x: 0, y: 0 }, ratio: 1, generation };
  }

  private initialize(): void {
    if (this.initializationError) throw new Error(this.initializationError);
    if (this.program) return;
    try {
      const gl = this.device.gl;
      this.program = this.device.createProgram(VERTEX_SHADER, FRAGMENT_SHADER);
      this.viewUniform = gl.getUniformLocation(this.program, 'u_view');
      this.backingUniform = gl.getUniformLocation(this.program, 'u_backing');
      this.nativeDPRUniform = gl.getUniformLocation(this.program, 'u_nativeDPR');
      this.panUniform = gl.getUniformLocation(this.program, 'u_pan');
      this.zoomUniform = gl.getUniformLocation(this.program, 'u_zoom');
      this.alphaUniform = gl.getUniformLocation(this.program, 'u_alpha');
      if (this.viewUniform === null || this.backingUniform === null || this.nativeDPRUniform === null || this.panUniform === null || this.zoomUniform === null || this.alphaUniform === null) throw new Error('WebGL2 stroke shader uniforms unavailable');
    } catch (error) {
      this.initializationError = error instanceof Error ? error.message : 'WebGL2 stroke initialization failed';
      throw error;
    }
  }

  render(state: DrawingState, view: Gpu2DView, overlay: Gpu2DOverlay): Gpu2DRenderResult {
    const start = performance.now();
    const metrics = emptyGpu2DRenderResult('');
    let submissionStart: number | null = null;
    const finish = (rendered: boolean, reason?: string): Gpu2DRenderResult => ({ ...metrics, rendered, reason, editHistoryBytes: this.editHistoryBytes, editHistoryEntries: this.editHistory.size, preparationMs: submissionStart === null ? Math.max(0, performance.now() - start) : metrics.preparationMs, submissionMs: submissionStart === null ? 0 : Math.max(0, performance.now() - submissionStart) });
    const refusal = (reason: string, admissionState = false): Gpu2DRenderResult => {
      if (!admissionState) this.clearRefusalCache();
      return finish(false, reason);
    };
    if (this.device.state !== 'ready') return refusal(`WebGL2 device is ${this.device.state}`);
    try {
      const background = cssRgb(view.background);
      if (!background) return refusal('Unsupported GPU background color');
      const gl = this.device.gl;
      if (gl.isContextLost()) {
        this.uploadedGeneration = null;
        return refusal('WebGL2 context is lost');
      }
      const width = Math.round(view.width * view.dpr), height = Math.round(view.height * view.dpr);
      const nativeDPR = Math.fround(view.dpr);
      // Outside the representable positive coefficient range no shared Canvas
      // transform can be certified; ordinary fractional Windows DPRs stay valid.
      if (!Number.isFinite(nativeDPR) || nativeDPR <= 0) return refusal('GPU DPR cannot match the Canvas Float32 coefficient');
      // Limits belong to this live context and cannot change until its handles are invalidated.
      if (!this.viewportLimits) {
        const reported = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | null;
        if (!reported || reported.length < 2 || !Number.isSafeInteger(reported[0]) || !Number.isSafeInteger(reported[1]) || reported[0]! < 1 || reported[1]! < 1) return refusal('GPU viewport limits unavailable');
        this.viewportLimits = [reported[0]!, reported[1]!];
      }
      const limits = this.viewportLimits;
      if (width < 1 || height < 1 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width > limits[0]! || height > limits[1]!) return refusal('GPU viewport exceeds device limits');
      const { geometry, pan, ratio, generation, delta } = this.prepare(state, view, overlay, metrics);
      metrics.geometryVertices = geometry.vertices.length / GPU_ZOOM_VERTEX_STRIDE;
      metrics.cacheMinRatio = geometry.minRatio;
      metrics.cacheMaxRatio = geometry.maxRatio;
      if (geometry.batches.some((batch) => batch.alpha < 1)) {
        this.stencilAvailable ??= gl.getContextAttributes()?.stencil ?? false;
        if (!this.stencilAvailable) return refusal('Solid selection/hover requires a stencil buffer');
      }
      metrics.preparationMs = Math.max(0, performance.now() - start);
      submissionStart = performance.now();
      if (this.canvas.width !== width) this.canvas.width = width;
      if (this.canvas.height !== height) this.canvas.height = height;
      if (gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height) return refusal('GPU drawing buffer could not match the requested viewport');
      if (!this.program || this.initializationError) {
        const initializationStart = performance.now();
        try { this.initialize(); }
        finally { metrics.initializationMs = Math.max(0, performance.now() - initializationStart); }
      }
      // An empty retained line changes source bounds/history but not any GPU bytes.
      if (this.buffer && delta && delta.vertices.byteLength === 0 && this.uploadedGeneration === delta.baseGeneration) this.uploadedGeneration = generation;
      if (!this.buffer || this.uploadedGeneration !== generation) {
        const uploadStart = performance.now();
        const subrange = !!this.buffer && !!delta && this.uploadedGeneration === delta.baseGeneration;
        metrics.uploadKind = subrange ? 'subrange' : 'full';
        metrics.bytes = subrange ? delta!.vertices.byteLength : geometry.vertices.byteLength;
        metrics.uploadCalls++;
        this.uploadedGeneration = null; // A rejected subupload can leave only part of the buffer updated.
        try {
          if (subrange) {
            metrics.subrangeUploadCalls++;
            metrics.subrangeUploadBytes += delta!.vertices.byteLength;
            gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
            gl.bufferSubData(gl.ARRAY_BUFFER, delta!.byteOffset, delta!.vertices);
            const error = gl.getError();
            if (error !== gl.NO_ERROR) throw new Error(`WebGL2 stroke subrange upload failed (${error})`);
          } else if (!this.buffer) this.buffer = this.device.createBuffer(geometry.vertices, gl.DYNAMIC_DRAW);
          else {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
            gl.bufferData(gl.ARRAY_BUFFER, geometry.vertices, gl.DYNAMIC_DRAW);
            const error = gl.getError();
            if (error !== gl.NO_ERROR) throw new Error(`WebGL2 stroke upload failed (${error})`);
          }
          if (gl.isContextLost()) throw new Error('WebGL2 context lost during stroke upload');
          this.uploadedGeneration = generation;
        } finally {
          metrics.uploadMs = Math.max(0, performance.now() - uploadStart);
          if (subrange) metrics.subrangeUploadMs = metrics.uploadMs;
        }
      }
      const drawStart = performance.now();
      let error: number;
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindVertexArray(null);
        gl.useProgram(this.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.enableVertexAttribArray(0);
        gl.enableVertexAttribArray(1);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 28, 0);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 16);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 28, 8);
        gl.uniform2f(this.viewUniform, view.width, view.height);
        gl.uniform2f(this.backingUniform, width, height);
        gl.uniform1f(this.nativeDPRUniform, nativeDPR);
        gl.uniform2f(this.panUniform, pan.x, pan.y);
        gl.uniform1f(this.zoomUniform, ratio);
        gl.viewport(0, 0, width, height);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.RASTERIZER_DISCARD);
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.BLEND);
        gl.colorMask(true, true, true, true);
        gl.depthMask(false);
        gl.stencilMask(0xff);
        gl.clearColor(...background, 1);
        gl.clearStencil(0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

        for (let i = 0; i < geometry.batches.length; i++) {
          const batch = geometry.batches[i]!;
          gl.uniform1f(this.alphaUniform, batch.alpha);
          if (batch.alpha < 1) {
            // Canvas composites an entity's entire stroke once. Stencil prevents overlapping
            // strips/joins/self-crossings from applying selection opacity more than once.
            gl.enable(gl.BLEND);
            gl.blendEquation(gl.FUNC_ADD);
            gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.enable(gl.STENCIL_TEST);
            gl.clear(gl.STENCIL_BUFFER_BIT);
            gl.stencilFunc(gl.EQUAL, 0, 0xff);
            gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
            gl.drawArrays(gl.TRIANGLES, batch.first, batch.count);
            gl.disable(gl.STENCIL_TEST);
            gl.disable(gl.BLEND);
          } else {
            let count = batch.count;
            // Opaque strokes retain entity order while sharing one submission.
            while (i + 1 < geometry.batches.length && geometry.batches[i + 1]!.alpha === 1) count += geometry.batches[++i]!.count;
            gl.drawArrays(gl.TRIANGLES, batch.first, count);
          }
        }
        error = gl.getError();
      } finally { metrics.drawSubmissionMs = Math.max(0, performance.now() - drawStart); }
      if (error !== gl.NO_ERROR || gl.isContextLost()) {
        // Do not certify a delta after a rejected draw. The caller paints the complete
        // Canvas view; the next GPU attempt repairs the entire current CPU recovery image.
        this.uploadedGeneration = null;
        return refusal(`WebGL2 stroke submission failed (${error})`);
      }
      return finish(true);
    } catch (error) {
      if (submissionStart !== null) this.uploadedGeneration = null;
      return refusal(error instanceof Error ? error.message : 'GPU rendering failed', error instanceof GeometryRefusalMemoError || error instanceof AdmissionDeferredError);
    }
  }

  dispose(): void {
    this.cache = null;
    this.clearRefusalCache();
    this.uploadedGeneration = null;
    this.clearEditHistory();
    this.device.dispose();
  }
}
