/**
 * Generator-driven tools. A command is written as a script that yields prompt
 * requests ("Specify first point:", "Enter number of sides <4>:") and gets the
 * user's answer back, which keeps AutoCAD's prompt sequences readable and lets
 * every command share the same Enter / Esc / keyword handling.
 */
import type { Point } from '../core/geometry';
import type { Entity } from '../core/entities';
import { formatLength, parseDistance } from '../core/units';
import type { Tool, ToolContext } from './types';

export interface Request {
  prompt: string;
  /** Rubber-band entities while the cursor moves. */
  preview?: (cursor: Point) => readonly Entity[];
  /** Ghost (dashed) entities while the cursor moves. */
  ghost?: (cursor: Point) => readonly Entity[];
  /** Dynamic-input lines near the cursor. */
  dyn?: (cursor: Point) => string[];
  /** Typed input is passed verbatim (text entry). */
  free?: boolean;
  /** Plain numbers typed while dragging are direct-distance entry from the tracking point. */
  distance?: boolean;
  /** Ask the editor for a selection set ("Select objects:"). */
  select?: boolean;
  /** Tracking base for ortho/polar/relative input (undefined = leave as is). */
  trackFrom?: Point | null;
}

export type Answer = { type: 'point'; p: Point } | { type: 'text'; text: string } | { type: 'enter' } | { type: 'select'; ids: string[] };

export type Script = Generator<Request, void, Answer>;
export type Step<T> = Generator<Request, T, Answer>;

export const fmtPoint = (p: Point): string => `${p.x.toFixed(4)}, ${p.y.toFixed(4)}`;

/**
 * Match typed input to AutoCAD option keywords. Keywords are given in their
 * prompt spelling ("WPolygon"): the capital letters are the abbreviation, and
 * any longer prefix of the word also matches. Returns the keyword's uppercase form.
 */
export function matchKeyword(input: string, keywords: readonly string[]): string | null {
  const t = input.trim().toUpperCase();
  if (!t) return null;
  for (const k of keywords) {
    const abbrev = k.replace(/[^A-Z]/g, '');
    const full = k.toUpperCase();
    if (t === abbrev || t === full) return full;
    if (abbrev.length > 0 && t.length >= abbrev.length && full.startsWith(t)) return full;
  }
  return null;
}

/** Yield one request and return the raw answer. */
export function* ask(req: Request): Step<Answer> {
  return yield req;
}

export type PointOrKey = { point: Point } | { keyword: string } | { text: string } | null;

/**
 * Point prompt with optional keywords. Returns the point, a matched keyword
 * (uppercase), unmatched text, or null on Enter.
 */
export function* pointOrKeyword(prompt: string, keywords: readonly string[] = [], opts: Omit<Request, 'prompt' | 'free' | 'select'> = {}): Step<PointOrKey> {
  const a: Answer = yield { prompt, distance: true, ...opts };
  if (a.type === 'point') return { point: a.p };
  if (a.type === 'enter') return null;
  if (a.type === 'text') {
    const k = matchKeyword(a.text, keywords);
    if (k) return { keyword: k };
    return { text: a.text };
  }
  return null;
}

/** Point prompt; null on Enter. Unknown text is reported and the prompt repeats. */
export function* point(ctx: ToolContext, prompt: string, opts: Omit<Request, 'prompt' | 'free' | 'select'> = {}): Step<Point | null> {
  for (;;) {
    const r = yield* pointOrKeyword(prompt, [], opts);
    if (!r) return null;
    if ('point' in r) return r.point;
    ctx.log(`Invalid point: ${'text' in r ? r.text : r.keyword}`);
  }
}

/** Text prompt; Enter returns `dflt` (or null when no default). */
export function* text(prompt: string, dflt: string | null = null, free = true): Step<string | null> {
  const a: Answer = yield { prompt, free, distance: false };
  if (a.type === 'text') return a.text;
  if (a.type === 'point') return fmtPoint(a.p);
  return dflt;
}

/** Keyword prompt; returns the matched keyword (uppercase) or the default on Enter. */
export function* keyword(ctx: ToolContext, prompt: string, keywords: readonly string[], dflt: string | null = null): Step<string | null> {
  for (;;) {
    const a: Answer = yield { prompt, distance: false };
    if (a.type === 'enter') return dflt ? matchKeyword(dflt, keywords) ?? dflt.toUpperCase() : null;
    if (a.type === 'text') {
      const k = matchKeyword(a.text, keywords);
      if (k) return k;
      ctx.log(`Invalid option keyword: ${a.text}`);
    }
  }
}

export interface NumberOptions {
  min?: number;
  allowZero?: boolean;
  allowNegative?: boolean;
  keywords?: readonly string[];
  /** A picked point is turned into a distance from this base. */
  from?: Point | null;
  integer?: boolean;
  preview?: Request['preview'];
  dyn?: Request['dyn'];
}

export type NumberOrKey = { value: number } | { keyword: string } | null;

/** Numeric prompt (distance / angle / count) with optional keywords. Enter returns the default. */
export function* number(ctx: ToolContext, prompt: string, dflt: number | null, opts: NumberOptions = {}): Step<NumberOrKey> {
  for (;;) {
    const a: Answer = yield { prompt, distance: opts.from !== undefined && opts.from !== null, trackFrom: opts.from, preview: opts.preview, dyn: opts.dyn };
    if (a.type === 'enter') return dflt === null ? null : { value: dflt };
    let v: number | null = null;
    if (a.type === 'point') {
      if (opts.from) v = Math.hypot(a.p.x - opts.from.x, a.p.y - opts.from.y);
      else {
        ctx.log('Requires a numeric value.');
        continue;
      }
    } else if (a.type === 'text') {
      const k = opts.keywords ? matchKeyword(a.text, opts.keywords) : null;
      if (k) return { keyword: k };
      v = parseDistance(a.text);
      if (v === null) {
        ctx.log(`Requires a numeric value${opts.keywords?.length ? ' or option keyword' : ''}.`);
        continue;
      }
    }
    if (v === null) continue;
    if (opts.integer) v = Math.round(v);
    if (!opts.allowNegative && v < 0) {
      ctx.log('Value must be positive.');
      continue;
    }
    if (!opts.allowZero && v === 0 && !opts.allowNegative) {
      ctx.log('Value must be nonzero.');
      continue;
    }
    if (opts.min !== undefined && v < opts.min) {
      ctx.log(`Value must be at least ${opts.min}.`);
      continue;
    }
    return { value: v };
  }
}

/** "Select objects:" request handled by the editor's selection machinery. Uses the pick-first set when present. */
export function* select(ctx: ToolContext, prompt = 'Select objects:', usePickFirst = true): Step<string[]> {
  if (usePickFirst && ctx.selection.size > 0) {
    const ids = [...ctx.selection];
    ctx.log(`${ids.length} found`);
    return ids;
  }
  const a: Answer = yield { prompt, select: true, distance: false };
  if (a.type === 'select') return a.ids;
  return [];
}

/** Format a default value the way AutoCAD shows it: <2.5000>. */
export function dflt(v: number | string, ctx?: ToolContext): string {
  if (typeof v === 'string') return `<${v}>`;
  return `<${ctx ? formatLength(v, ctx.doc.header.units) : v.toFixed(4)}>`;
}

/** A Tool that runs a script. */
export class ScriptTool implements Tool {
  private gen: Script | null = null;
  private current: Request | null = null;
  private cursor: Point | null = null;
  private finished = false;

  constructor(
    readonly name: string,
    private readonly script: (ctx: ToolContext) => Script,
  ) {}

  get acceptsDistance(): boolean {
    return this.current?.distance ?? false;
  }

  acceptsFreeText(): boolean {
    return this.current?.free ?? false;
  }

  start(ctx: ToolContext): void {
    this.finished = false;
    this.gen = this.script(ctx);
    this.advance(ctx, undefined);
  }

  private advance(ctx: ToolContext, answer: Answer | undefined): void {
    if (!this.gen || this.finished) return;
    let r: IteratorResult<Request, void>;
    try {
      r = answer === undefined ? this.gen.next() : this.gen.next(answer);
    } catch (err) {
      ctx.log(`Command failed: ${(err as Error).message}`);
      this.finished = true;
      ctx.finish();
      return;
    }
    if (r.done) {
      this.finished = true;
      ctx.finish();
      return;
    }
    this.current = r.value;
    if (r.value.trackFrom !== undefined) ctx.setTrackFrom(r.value.trackFrom);
    if (r.value.select) {
      ctx.setPreview([]);
      ctx.requestSelection(r.value.prompt, (ids) => this.advance(ctx, { type: 'select', ids }));
      return;
    }
    ctx.prompt(r.value.prompt);
    if (this.cursor) this.onMove(this.cursor, ctx);
    else ctx.setPreview(r.value.preview ? [] : []);
  }

  onPoint(p: Point, ctx: ToolContext): void {
    if (!this.current || this.current.select) return;
    this.advance(ctx, { type: 'point', p });
  }

  onMove(p: Point, ctx: ToolContext): void {
    this.cursor = p;
    const cur = this.current;
    if (!cur) return;
    if (cur.preview) ctx.setPreview(cur.preview(p));
    if (cur.ghost) ctx.setGhost(cur.ghost(p));
    ctx.setDynText(cur.dyn ? cur.dyn(p) : [fmtPoint(p)]);
  }

  onText(t: string, ctx: ToolContext): void {
    if (!this.current || this.current.select) return;
    this.advance(ctx, { type: 'text', text: t });
  }

  onEnter(ctx: ToolContext): void {
    if (!this.current || this.current.select) return;
    this.advance(ctx, { type: 'enter' });
  }

  onCancel(ctx: ToolContext): void {
    if (this.finished) return;
    this.finished = true;
    try {
      this.gen?.return();
    } catch {
      /* cleanup errors are not interesting */
    }
    ctx.setPreview([]);
    ctx.setGhost([]);
  }
}

/** Convenience: a Tool from a script function. */
export const scriptTool = (name: string, script: (ctx: ToolContext) => Script): Tool => new ScriptTool(name, script);
