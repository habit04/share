import type { Point } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity } from '../core/entities';
import { newId, translateEntity, rotateEntity } from '../core/entities';
import type { Tool, ToolContext } from './types';

const fmt = (p: Point) => `${p.x.toFixed(4)}, ${p.y.toFixed(4)}`;

/** Base for tools that operate on a selection set (noun/verb or verb/noun). */
abstract class SelectionTool implements Tool {
  abstract readonly name: string;
  readonly acceptsDistance: boolean = false;
  protected ids: string[] = [];

  start(ctx: ToolContext): void {
    if (ctx.selection.size > 0) {
      this.ids = [...ctx.selection];
      ctx.log(`${this.ids.length} found`);
      this.begin(ctx);
    } else {
      ctx.requestSelection('Select objects:', (ids) => {
        if (ids.length === 0) {
          ctx.finish();
          return;
        }
        this.ids = ids;
        ctx.selection = new Set(ids);
        this.begin(ctx);
      });
    }
  }

  protected entities(ctx: ToolContext): Entity[] {
    const set = new Set(this.ids);
    return ctx.doc.entities.filter((e) => set.has(e.id));
  }

  protected abstract begin(ctx: ToolContext): void;
  onPoint(_p: Point, _ctx: ToolContext): void {}
  onMove(_p: Point, _ctx: ToolContext): void {}
  onText(text: string, ctx: ToolContext): void {
    ctx.log(`Invalid option keyword: ${text}`);
  }
  onEnter(ctx: ToolContext): void {
    ctx.finish();
  }
  onCancel(ctx: ToolContext): void {
    ctx.finish();
  }
}

export class EraseTool extends SelectionTool {
  readonly name = 'ERASE';
  protected begin(ctx: ToolContext): void {
    ctx.doc.removeEntities(this.ids);
    ctx.selection = new Set();
    ctx.finish();
  }
}

export class MoveTool extends SelectionTool {
  readonly name = 'MOVE';
  override readonly acceptsDistance: boolean = true;
  private base: Point | null = null;

  protected begin(ctx: ToolContext): void {
    this.base = null;
    ctx.prompt('Specify base point:');
  }

  override onPoint(p: Point, ctx: ToolContext): void {
    if (!this.base) {
      this.base = p;
      ctx.setTrackFrom(p);
      ctx.prompt('Specify second point:');
      return;
    }
    const d = g.sub(p, this.base);
    ctx.doc.replaceEntities(this.entities(ctx).map((e) => translateEntity(e, d)));
    ctx.finish();
  }

  override onMove(p: Point, ctx: ToolContext): void {
    if (!this.base) {
      ctx.setDynText([fmt(p)]);
      return;
    }
    const d = g.sub(p, this.base);
    ctx.setGhost(this.entities(ctx).map((e) => translateEntity(e, d)));
    ctx.setDynText([g.dist(this.base, p).toFixed(4), `${g.deg(g.normAngle(g.angleOf(this.base, p))).toFixed(0)}°`]);
  }
}

export class CopyTool extends SelectionTool {
  readonly name = 'COPY';
  override readonly acceptsDistance: boolean = true;
  private base: Point | null = null;

  protected begin(ctx: ToolContext): void {
    this.base = null;
    ctx.prompt('Specify base point:');
  }

  override onPoint(p: Point, ctx: ToolContext): void {
    if (!this.base) {
      this.base = p;
      ctx.setTrackFrom(p);
      ctx.prompt('Specify second point or <Enter to exit>:');
      return;
    }
    const d = g.sub(p, this.base);
    ctx.doc.addEntities(this.entities(ctx).map((e) => ({ ...translateEntity(e, d), id: newId() })));
    ctx.prompt('Specify second point or <Enter to exit>:');
  }

  override onMove(p: Point, ctx: ToolContext): void {
    if (!this.base) {
      ctx.setDynText([fmt(p)]);
      return;
    }
    const d = g.sub(p, this.base);
    ctx.setGhost(this.entities(ctx).map((e) => translateEntity(e, d)));
    ctx.setDynText([g.dist(this.base, p).toFixed(4)]);
  }
}

export class RotateTool extends SelectionTool {
  readonly name = 'ROTATE';
  private base: Point | null = null;

  protected begin(ctx: ToolContext): void {
    this.base = null;
    ctx.prompt('Specify base point:');
  }

  override onPoint(p: Point, ctx: ToolContext): void {
    if (!this.base) {
      this.base = p;
      ctx.setTrackFrom(p);
      ctx.prompt('Specify rotation angle or pick a point:');
      return;
    }
    const ang = g.angleOf(this.base, p);
    ctx.doc.replaceEntities(this.entities(ctx).map((e) => rotateEntity(e, this.base!, ang)));
    ctx.finish();
  }

  override onMove(p: Point, ctx: ToolContext): void {
    if (!this.base) {
      ctx.setDynText([fmt(p)]);
      return;
    }
    const ang = g.angleOf(this.base, p);
    ctx.setGhost(this.entities(ctx).map((e) => rotateEntity(e, this.base!, ang)));
    ctx.setDynText([`${g.deg(g.normAngle(ang)).toFixed(1)}°`]);
  }

  override onText(text: string, ctx: ToolContext): void {
    const v = parseFloat(text);
    if (this.base && Number.isFinite(v)) {
      ctx.doc.replaceEntities(this.entities(ctx).map((e) => rotateEntity(e, this.base!, g.rad(v))));
      ctx.finish();
      return;
    }
    ctx.log('Requires an angle.');
  }
}

/** DIST: measure between two points. */
export class DistTool implements Tool {
  readonly name = 'DIST';
  private a: Point | null = null;
  start(ctx: ToolContext): void {
    this.a = null;
    ctx.prompt('Specify first point:');
  }
  onPoint(p: Point, ctx: ToolContext): void {
    if (!this.a) {
      this.a = p;
      ctx.setTrackFrom(p);
      ctx.prompt('Specify second point:');
      return;
    }
    const d = g.dist(this.a, p);
    ctx.log(
      `Distance = ${d.toFixed(4)}, Angle in XY Plane = ${g.deg(g.normAngle(g.angleOf(this.a, p))).toFixed(2)}, Delta X = ${(p.x - this.a.x).toFixed(4)}, Delta Y = ${(p.y - this.a.y).toFixed(4)}`,
    );
    ctx.finish();
  }
  onMove(p: Point, ctx: ToolContext): void {
    if (this.a) {
      ctx.setPreview([{ id: 'tmp', layer: '0', color: 3, type: 'line', a: this.a, b: p }]);
      ctx.setDynText([g.dist(this.a, p).toFixed(4)]);
    } else ctx.setDynText([fmt(p)]);
  }
  onText(text: string, ctx: ToolContext): void {
    ctx.log(`Invalid option keyword: ${text}`);
  }
  onEnter(ctx: ToolContext): void {
    ctx.finish();
  }
  onCancel(ctx: ToolContext): void {
    ctx.finish();
  }
}
