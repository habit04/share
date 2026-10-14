/**
 * Generator-driven 3D tools: the script model of src/tools/script.ts (a command yields prompt
 * requests and receives the user's answers) with what 3D commands need on top:
 * - `preview3d`: solids drawn as a translucent ghost in the 3D view while the cursor moves;
 * - `wait`: an asynchronous step (a kernel Boolean). While it runs the prompt shows what is being
 *   computed and every input except Esc is refused with a message; Esc (or starting another
 *   command) abandons the step and its result is discarded, so the drawing stays unchanged.
 * - prompt helpers that read points as 3D points (`point3`, typed "x,y,z"), numbers and AutoCAD
 *   option keywords in one answer.
 *
 * Every error thrown by a script ends the command with `<NAME>: <message>` on the command line.
 */
import type { Point } from '../core/geometry';
import { parseDistance } from '../core/units';
import type { Vec3 } from '../model3d/math';
import type { Dimension3D, Solid3D } from '../model3d/types';
import type { Answer, Request } from '../tools/script';
import { matchKeyword } from '../tools/script';
import type { Tool, ToolContext } from '../tools/types';
import { constructionPlaneOf, parsePoint3, point3Of, worldToPlane } from './context';

/** A prompt request of a 3D script. */
export interface Request3D extends Request {
  /** Ghost solids for the cursor (null before the cursor has moved). */
  preview3d?: (cursor: Point | null) => readonly Solid3D[];
  /** Rubber-band 3D dimensions for the cursor (DIM3D; null before the cursor has moved). */
  previewDimensions?: (cursor: Point | null) => readonly Dimension3D[];
  /** An asynchronous step: the script resumes (with Enter) when it settles. Must not reject. */
  wait?: Promise<void>;
}

export type Step3<T> = Generator<Request3D, T, Answer>;

/** The message of an error as shown on the command line. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A Tool that runs a 3D script. */
export class Script3DTool implements Tool {
  readonly acceptsDistance = false;
  private gen: Step3<void> | null = null;
  private current: Request3D | null = null;
  private cursor: Point | null = null;
  private finished = false;
  private busy: Promise<void> | null = null;
  /** True while 2D rubber-band entities (`Request.preview`) are shown. */
  private preview2d = false;
  /** True while rubber-band 3D dimensions (`Request3D.previewDimensions`) are shown. */
  private previewDims = false;

  constructor(
    readonly name: string,
    private readonly script: (ctx: ToolContext) => Step3<void>,
  ) {}

  /** True while an asynchronous step (a Boolean) runs. */
  get computing(): boolean {
    return this.busy !== null;
  }

  /** True once the script ended or was cancelled. */
  get done(): boolean {
    return this.finished;
  }

  /** Resolves when no asynchronous step is running (tests and scripted replays). */
  async idle(): Promise<void> {
    while (this.busy) await this.busy;
  }

  /** Free text (Space as a character) only for a request that asks for it; none of the 3D commands do. */
  acceptsFreeText(): boolean {
    return this.current?.free ?? false;
  }

  /**
   * Always true: typed points reach the script as text, so `ask3` parses them itself ("x,y,z",
   * "@dx,dy" relative to the last 3D point, keeping its height) instead of the command line
   * turning "x,y" into a 2D point first. Space still submits, as at every prompt.
   */
  acceptsRawPoints(): boolean {
    return true;
  }

  start(ctx: ToolContext): void {
    this.finished = false;
    this.busy = null;
    this.cursor = null;
    this.gen = this.script(ctx);
    this.advance(ctx, undefined);
  }

  private end(ctx: ToolContext): void {
    this.finished = true;
    this.current = null;
    ctx.setPreview3d?.([]);
    this.clearPreview2d(ctx);
    this.clearPreviewDims(ctx);
    ctx.finish();
  }

  private advance(ctx: ToolContext, answer: Answer | undefined): void {
    if (!this.gen || this.finished) return;
    let r: IteratorResult<Request3D, void>;
    try {
      r = answer === undefined ? this.gen.next() : this.gen.next(answer);
    } catch (err) {
      ctx.log(`${this.name}: ${errorText(err)}`);
      this.end(ctx);
      return;
    }
    if (r.done) {
      this.end(ctx);
      return;
    }
    const req = r.value;
    this.current = req;
    if (req.trackFrom !== undefined) ctx.setTrackFrom(req.trackFrom);
    if (req.wait) {
      ctx.prompt(req.prompt);
      this.busy = req.wait.then(() => {
        this.busy = null;
        if (!this.finished) this.advance(ctx, { type: 'enter' });
      });
      return;
    }
    if (req.select) {
      ctx.setPreview3d?.([]);
      this.clearPreviewDims(ctx);
      ctx.requestSelection(req.prompt, (ids) => this.advance(ctx, { type: 'select', ids }));
      return;
    }
    ctx.prompt(req.prompt);
    this.showPreview(ctx);
  }

  private clearPreview2d(ctx: ToolContext): void {
    if (!this.preview2d) return;
    this.preview2d = false;
    ctx.setPreview([]);
  }

  private clearPreviewDims(ctx: ToolContext): void {
    if (!this.previewDims) return;
    this.previewDims = false;
    ctx.setPreviewDimensions3d?.([]);
  }

  /** Rubber-band 3D dimensions (DIM3D) for the cursor, drawn by the 3D view. */
  private showPreviewDims(ctx: ToolContext): void {
    const fn = this.current?.previewDimensions;
    if (!fn || !ctx.setPreviewDimensions3d || ctx.wantsPreview3d?.() === false) {
      this.clearPreviewDims(ctx);
      return;
    }
    let dims: readonly Dimension3D[] = [];
    try {
      dims = fn(this.cursor);
    } catch {
      dims = [];
    }
    if (dims.length === 0) {
      this.clearPreviewDims(ctx);
      return;
    }
    ctx.setPreviewDimensions3d(dims);
    this.previewDims = true;
  }

  private showPreview(ctx: ToolContext): void {
    // 2D rubber band (3DDIM's dimension): drawn by the 2D view's overlay (the 3D view does not show it).
    const fn2 = this.current?.preview;
    if (fn2 && this.cursor) {
      try {
        ctx.setPreview(fn2(this.cursor));
        this.preview2d = true;
      } catch {
        this.clearPreview2d(ctx);
      }
    } else this.clearPreview2d(ctx);
    this.showPreviewDims(ctx);
    const fn = this.current?.preview3d;
    if (!ctx.setPreview3d) return;
    if (!fn || ctx.wantsPreview3d?.() === false) {
      ctx.setPreview3d([]);
      return;
    }
    let solids: readonly Solid3D[] = [];
    try {
      solids = fn(this.cursor);
    } catch {
      solids = [];
    }
    ctx.setPreview3d(solids);
  }

  private accepting(ctx: ToolContext): boolean {
    if (!this.current || this.current.select || this.finished) return false;
    if (this.busy) {
      ctx.log(`${this.name}: still computing; wait for the result or press Esc to abandon it.`);
      return false;
    }
    return true;
  }

  onPoint(p: Point, ctx: ToolContext): void {
    if (this.accepting(ctx)) this.advance(ctx, { type: 'point', p });
  }

  onMove(p: Point, ctx: ToolContext): void {
    this.cursor = p;
    if (!this.current || this.busy || this.finished) return;
    this.showPreview(ctx);
  }

  onText(t: string, ctx: ToolContext): void {
    if (this.accepting(ctx)) this.advance(ctx, { type: 'text', text: t });
  }

  onEnter(ctx: ToolContext): void {
    if (this.accepting(ctx)) this.advance(ctx, { type: 'enter' });
  }

  onCancel(ctx: ToolContext): void {
    if (this.finished) return;
    this.finished = true;
    if (this.busy) ctx.log(`${this.name}: abandoned; the result will be discarded and the drawing stays unchanged.`);
    try {
      this.gen?.return();
    } catch {
      /* cleanup errors are not interesting */
    }
    ctx.setPreview3d?.([]);
    this.clearPreview2d(ctx);
    this.clearPreviewDims(ctx);
  }
}

/** Convenience: a 3D Tool from a script function. */
export const script3d = (name: string, script: (ctx: ToolContext) => Step3<void>): Script3DTool => new Script3DTool(name, script);

/** Per-command input state: the last 3D point (base of "@" relative input). */
export interface InputState {
  last: Vec3 | null;
}

/** One parsed answer. */
export type Ans3 =
  /** `typed3`: typed with a third coordinate ("x,y,z" / "@dx,dy,dz"), so its height is meant. */
  | { readonly kind: 'point'; readonly point: Vec3; readonly p2: Point; readonly typed3: boolean }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'keyword'; readonly keyword: string }
  | { readonly kind: 'enter' };

export interface AskOptions {
  /** Option keywords in prompt spelling ("Diameter"); matched like AutoCAD (capitals = abbreviation). */
  readonly keywords?: readonly string[];
  /** Accept plain numbers (sizes). Numbers are tried before keywords. */
  readonly numbers?: boolean;
  /** Accept points (default true). */
  readonly points?: boolean;
  readonly preview3d?: Request3D['preview3d'];
  /** 2D rubber-band entities for the cursor (plane-local tool point). */
  readonly preview?: Request3D['preview'];
  /** Rubber-band 3D dimensions for the cursor (DIM3D). */
  readonly previewDimensions?: Request3D['previewDimensions'];
}

/**
 * Ask until the answer is usable: a point (picked, or typed "x,y" / "x,y,z" / "@..." in
 * construction-plane coordinates), a number, an option keyword or Enter. Anything else is
 * reported ("Invalid ...") and the prompt repeats. Points update `st.last`.
 */
export function* ask3(ctx: ToolContext, st: InputState, prompt: string, opts: AskOptions = {}): Step3<Ans3> {
  const points = opts.points ?? true;
  for (;;) {
    const a: Answer = yield { prompt, distance: false, preview3d: opts.preview3d, preview: opts.preview, ...(opts.previewDimensions ? { previewDimensions: opts.previewDimensions } : {}) };
    if (a.type === 'enter') return { kind: 'enter' };
    if (a.type === 'select') continue;
    if (a.type === 'point') {
      if (!points) {
        ctx.log(opts.numbers ? 'Requires a numeric value.' : 'Invalid option keyword.');
        continue;
      }
      const point = point3Of(ctx, a.p);
      st.last = point;
      return { kind: 'point', point, p2: a.p, typed3: false };
    }
    const text = a.text.trim();
    if (opts.numbers) {
      const v = parseDistance(text);
      if (v !== null && Number.isFinite(v)) return { kind: 'number', value: v };
    }
    const k = opts.keywords ? matchKeyword(text, opts.keywords) : null;
    if (k) return { kind: 'keyword', keyword: k };
    if (points) {
      const frame = constructionPlaneOf(ctx);
      const point = parsePoint3(text, frame, st.last);
      if (point) {
        st.last = point;
        const local = worldToPlane(frame, point);
        return { kind: 'point', point, p2: { x: local.x, y: local.y }, typed3: text.split(',').length === 3 };
      }
    }
    const wants = [points ? 'a point' : null, opts.numbers ? 'a number' : null, opts.keywords?.length ? 'an option keyword' : null].filter(Boolean).join(' or ');
    ctx.log(`Invalid input "${text}": requires ${wants || 'Enter'}.`);
  }
}

/** Ask for a point only (Enter returns null). */
export function* point3(ctx: ToolContext, st: InputState, prompt: string, preview3d?: Request3D['preview3d']): Step3<{ point: Vec3; p2: Point } | null> {
  for (;;) {
    const a = yield* ask3(ctx, st, prompt, { preview3d });
    if (a.kind === 'enter') return null;
    if (a.kind === 'point') return { point: a.point, p2: a.p2 };
  }
}

/**
 * Wait for `promise` without blocking the editor: the prompt shows `prompt` ("Computing the
 * union…") until it settles. Returns the value or the error; never throws for a rejection.
 */
export function* compute<T>(prompt: string, promise: Promise<T>): Step3<{ ok: true; value: T } | { ok: false; error: unknown }> {
  type Outcome = { ok: true; value: T } | { ok: false; error: unknown };
  const box: { outcome?: Outcome } = {};
  const wait = promise.then(
    (value) => void (box.outcome = { ok: true, value }),
    (error: unknown) => void (box.outcome = { ok: false, error }),
  );
  yield { prompt, distance: false, wait };
  // `wait` resolves only after one of the callbacks above has run.
  return box.outcome!;
}

/**
 * Run `script` and clear the selection when it ends (finished, failed or cancelled), as AutoCAD
 * does after a command that used a selection set: the next command then asks again instead of
 * silently reusing it as its pick-first set.
 */
export function* clearingSelection(ctx: ToolContext, script: Step3<void>): Step3<void> {
  try {
    yield* script;
  } finally {
    if (ctx.selection.size) ctx.selection = new Set();
  }
}
