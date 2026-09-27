/**
 * A ToolContext for unit tests: records prompts / log lines and lets a test
 * feed points, text, Enter and selection sets to a Tool the way the Editor does.
 */
import type { Point } from '../src/core/geometry';
import type { Entity } from '../src/core/entities';
import { Drawing } from '../src/core/document';
import { defaultSnapSettings } from '../src/core/snap';
import type { Tool, ToolContext } from '../src/tools/types';

export interface FakeContext extends ToolContext {
  prompts: string[];
  logs: string[];
  finished: boolean;
  preview: readonly Entity[];
  pendingSelection: ((ids: string[]) => void) | null;
}

export function fakeContext(doc = new Drawing()): FakeContext {
  const ctx: FakeContext = {
    doc,
    snap: defaultSnapSettings(),
    selection: new Set<string>(),
    prompts: [],
    logs: [],
    finished: false,
    preview: [],
    pendingSelection: null,
    aperture: () => 0.1,
    prompt: (t) => void ctx.prompts.push(t),
    log: (t) => void ctx.logs.push(t),
    setPreview: (e) => void (ctx.preview = e),
    setGhost: () => {},
    setTrackFrom: () => {},
    setDynText: () => {},
    finish: () => void (ctx.finished = true),
    runCommand: () => {},
    ui: {
      pickSymbol: async () => null,
      editComponent: async (init) => ({ tag: init.tag, desc: init.desc, mfg: '', cat: '' }),
      ladderSettings: async (init) => init,
      textInput: async (_t, _l, init) => init,
      confirm: async () => true,
    },
    requestSelection: (prompt, onDone) => {
      ctx.prompts.push(prompt);
      ctx.pendingSelection = onDone;
    },
  };
  return ctx;
}

export type Input = Point | string | { select: string[] } | { enter: true } | { move: Point };

/** Start a tool and feed it a sequence of inputs ('' or {enter:true} = Enter). */
export function drive(tool: Tool, ctx: FakeContext, inputs: Input[]): void {
  ctx.finished = false;
  ctx.pendingSelection = null;
  tool.start(ctx);
  for (const inp of inputs) {
    if (ctx.finished) break;
    if (typeof inp === 'string') {
      if (inp === '') tool.onEnter(ctx);
      else tool.onText(inp, ctx);
    } else if ('select' in inp) {
      const cb = ctx.pendingSelection as FakeContext['pendingSelection'];
      ctx.pendingSelection = null;
      if (cb) cb(inp.select);
      else throw new Error('tool did not request a selection');
    } else if ('enter' in inp) tool.onEnter(ctx);
    else if ('move' in inp) tool.onMove(inp.move, ctx);
    else tool.onPoint(inp, ctx);
  }
}
