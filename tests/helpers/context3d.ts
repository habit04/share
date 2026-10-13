/**
 * A 3D ToolContext for unit tests: tests/fake-context.ts plus the optional 3D members
 * (src/tools3d/context.ts) with a settable construction plane, recorded ghost solids, scripted
 * 3D picks (as the 3D view would record a click or the cursor) and the in-process Manifold kernel
 * (or any kernel passed in). `drive3d` feeds inputs like `drive` and waits for asynchronous steps.
 */
import { Drawing } from '../../src/core/document';
import type { Point } from '../../src/core/geometry';
import { type Frame3, WORLD_XY_FRAME } from '../../src/model3d/math';
import type { GeometryKernel } from '../../src/model3d/kernel/kernel';
import { ManifoldDirectKernel } from '../../src/model3d/kernel/manifold-direct';
import type { Solid3D } from '../../src/model3d/types';
import { type Pick3, extendContext3d } from '../../src/tools3d/context';
import type { Script3DTool } from '../../src/tools3d/script3d';
import { type FakeContext, type Input, fakeContext } from '../fake-context';

export interface Fake3DContext extends FakeContext {
  /** Ghost solids the tool shows now. */
  preview3d: readonly Solid3D[];
  /** Every non-empty ghost list the tool showed. */
  previews: (readonly Solid3D[])[];
  /** 3D picks by tool point (what a click or the cursor in the 3D view records). */
  picks: Pick3[];
  plane: Frame3;
  planeName: string;
  /** How many times the kernel was asked for. */
  kernelRequests: number;
}

export interface Fake3DOptions {
  readonly plane?: Frame3;
  /** Kernel to hand out (default: one shared ManifoldDirectKernel per context). */
  readonly kernel?: GeometryKernel;
}

let sharedKernel: ManifoldDirectKernel | null = null;

/** The in-process Manifold kernel, shared by the tests of one file (loading WASM once). */
export function directKernel(): ManifoldDirectKernel {
  sharedKernel ??= new ManifoldDirectKernel();
  return sharedKernel;
}

export function fake3dContext(doc = new Drawing(), opts: Fake3DOptions = {}): Fake3DContext {
  const ctx = fakeContext(doc) as Fake3DContext;
  ctx.preview3d = [];
  ctx.previews = [];
  ctx.picks = [];
  ctx.plane = opts.plane ?? WORLD_XY_FRAME;
  ctx.planeName = 'World';
  ctx.kernelRequests = 0;
  const near = (a: Point, b: Point) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
  extendContext3d(ctx, {
    plane: () => ctx.plane,
    planeName: () => ctx.planeName,
    setPlane: (f, n) => {
      ctx.plane = f;
      ctx.planeName = n;
    },
    pickAt: (p) => ctx.picks.find((k) => near(k.p2, p)) ?? null,
    kernel: () => {
      ctx.kernelRequests++;
      return opts.kernel ?? directKernel();
    },
    setPreview3d: (s) => {
      ctx.preview3d = s;
      if (s.length) ctx.previews.push(s);
    },
  });
  return ctx;
}

/** Start a 3D tool and feed inputs (as `drive`), awaiting any computation between and after them. */
export async function drive3d(tool: Script3DTool, ctx: FakeContext, inputs: Input[]): Promise<void> {
  ctx.finished = false;
  ctx.pendingSelection = null;
  tool.start(ctx);
  for (const inp of inputs) {
    await tool.idle();
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
  await tool.idle();
}
