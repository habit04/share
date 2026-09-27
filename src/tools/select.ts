/**
 * SELECT with AutoCAD selection modes (Window/Crossing/Fence/WPolygon/CPolygon/
 * Previous/Last/ALL/Add/Remove/Undo) and a command-line QSELECT.
 */
import type { Point } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity, ColorSpec } from '../core/entities';
import { entityTypeName } from '../core/entities';
import { selectByBox, selectByFence, selectByPolygon, pickEntity } from '../core/selection';
import type { Tool, ToolContext } from './types';
import { scriptTool, point, pointOrKeyword, type Step } from './script';

/** The selection set of the previous command (SELECT Previous). */
export const selectionHistory: { previous: string[] } = { previous: [] };

const SELECT_KEYWORDS = ['Window', 'Crossing', 'Fence', 'WPolygon', 'CPolygon', 'Previous', 'Last', 'ALL', 'Add', 'Remove', 'Undo', 'BOX'];

function visibility(ctx: ToolContext): { hidden: Set<string>; locked: Set<string> } {
  return {
    hidden: new Set(ctx.doc.layers.filter((l) => !l.visible).map((l) => l.name)),
    locked: new Set(ctx.doc.layers.filter((l) => l.locked).map((l) => l.name)),
  };
}

/** Collect polygon / fence points until Enter. */
function* collectPoints(ctx: ToolContext, mode: 'fence' | 'window' | 'crossing'): Step<Point[]> {
  const pts: Point[] = [];
  const firstPrompt = mode === 'fence' ? 'Specify first fence point or pick/drag cursor:' : 'First polygon point:';
  const nextPrompt = mode === 'fence' ? 'Specify next fence point or [Undo]:' : 'Specify endpoint of line or [Undo]:';
  for (;;) {
    const r = yield* pointOrKeyword(pts.length === 0 ? firstPrompt : nextPrompt, ['Undo'], {
      trackFrom: pts[pts.length - 1] ?? null,
      preview: (c) => {
        const all = [...pts, c];
        if (all.length < 2) return [];
        return [{ id: 'selpoly', layer: '0', color: mode === 'window' ? 5 : 3, type: 'polyline', closed: mode !== 'fence' && all.length > 2, points: all }];
      },
    });
    if (!r) break;
    if ('point' in r) pts.push(r.point);
    else if ('keyword' in r) pts.pop();
  }
  ctx.setPreview([]);
  return pts;
}

/** Selection by a keyword mode; returns the ids found (or null when the mode needs nothing else). */
export function* selectByMode(ctx: ToolContext, mode: string): Step<string[] | null> {
  const { hidden, locked } = visibility(ctx);
  const ents = ctx.doc.entities;
  const look = ctx.doc.lookupBlock;
  switch (mode) {
    case 'ALL':
      return ents.filter((e) => !hidden.has(e.layer) && !locked.has(e.layer)).map((e) => e.id);
    case 'LAST': {
      for (let i = ents.length - 1; i >= 0; i -= 1) if (!hidden.has(ents[i]!.layer)) return [ents[i]!.id];
      return [];
    }
    case 'PREVIOUS': {
      const live = new Set(ents.map((e) => e.id));
      return selectionHistory.previous.filter((id) => live.has(id));
    }
    case 'WINDOW':
    case 'CROSSING':
    case 'BOX': {
      const a = yield* point(ctx, 'Specify first corner:');
      if (!a) return [];
      const b = yield* point(ctx, 'Specify opposite corner:', {
        trackFrom: a,
        preview: (c) => [{ id: 'selbox', layer: '0', color: mode === 'CROSSING' ? 3 : 5, type: 'polyline', closed: true, points: [a, { x: c.x, y: a.y }, c, { x: a.x, y: c.y }] }],
      });
      ctx.setPreview([]);
      if (!b) return [];
      const m = mode === 'BOX' ? (b.x >= a.x ? 'window' : 'crossing') : mode === 'WINDOW' ? 'window' : 'crossing';
      return selectByBox(g.boundsOfPoints([a, b])!, m, ents, look, hidden, locked).map((e) => e.id);
    }
    case 'FENCE': {
      const pts = yield* collectPoints(ctx, 'fence');
      return selectByFence(pts, ents, look, hidden, locked).map((e) => e.id);
    }
    case 'WPOLYGON':
    case 'CPOLYGON': {
      const pts = yield* collectPoints(ctx, mode === 'WPOLYGON' ? 'window' : 'crossing');
      return selectByPolygon(pts, mode === 'WPOLYGON' ? 'window' : 'crossing', ents, look, hidden, locked).map((e) => e.id);
    }
    default:
      return null;
  }
}

export function selectTool(): Tool {
  return scriptTool('SELECT', function* (ctx) {
    const set = new Set<string>();
    let removing = false;
    const history: string[][] = [];
    const apply = (ids: string[]) => {
      history.push([...set]);
      const before = set.size;
      for (const id of ids) if (removing) set.delete(id);
      else set.add(id);
      ctx.selection = new Set(set);
      ctx.log(removing ? `${ids.length} found, ${before - set.size} removed, ${set.size} total` : `${ids.length} found, ${set.size} total`);
    };
    for (;;) {
      const r = yield* pointOrKeyword(removing ? 'Remove objects:' : 'Select objects:', SELECT_KEYWORDS, { trackFrom: null });
      if (!r) break;
      if ('point' in r) {
        const { hidden, locked } = visibility(ctx);
        const hit = pickEntity(r.point, ctx.doc.entities, ctx.doc.lookupBlock, ctx.aperture(), hidden, locked);
        if (hit) apply([hit.id]);
        else {
          // Empty pick starts an implied window (BOX).
          const ids = yield* selectByMode(ctx, 'BOX');
          if (ids) apply(ids);
        }
        continue;
      }
      if ('text' in r) {
        ctx.log(`Invalid option keyword: ${r.text}`);
        ctx.log('Expects a point or Window/Last/Crossing/BOX/ALL/Fence/WPolygon/CPolygon/Add/Remove/Previous/Undo');
        continue;
      }
      if (r.keyword === 'ADD') removing = false;
      else if (r.keyword === 'REMOVE') removing = true;
      else if (r.keyword === 'UNDO') {
        const prev = history.pop();
        if (prev) {
          set.clear();
          for (const id of prev) set.add(id);
          ctx.selection = new Set(set);
        }
      } else {
        const ids = yield* selectByMode(ctx, r.keyword);
        if (ids) apply(ids);
      }
    }
    ctx.selection = new Set(set);
    if (set.size) selectionHistory.previous = [...set];
  });
}

/** Handle a keyword typed during another command's "Select objects:" prompt (ALL, Last, Previous). */
export function selectionKeyword(text: string, ctx: { doc: ToolContext['doc'] }, ids: Set<string>): boolean {
  const t = text.trim().toUpperCase();
  const hidden = new Set(ctx.doc.layers.filter((l) => !l.visible).map((l) => l.name));
  if (t === 'ALL') {
    for (const e of ctx.doc.entities) if (!hidden.has(e.layer)) ids.add(e.id);
    return true;
  }
  if (t === 'L' || t === 'LAST') {
    const ents = ctx.doc.entities;
    for (let i = ents.length - 1; i >= 0; i -= 1) if (!hidden.has(ents[i]!.layer)) {
      ids.add(ents[i]!.id);
      break;
    }
    return true;
  }
  if (t === 'P' || t === 'PREVIOUS') {
    const live = new Set(ctx.doc.entities.map((e) => e.id));
    for (const id of selectionHistory.previous) if (live.has(id)) ids.add(id);
    return true;
  }
  return false;
}

export interface QSelectFilter {
  type?: string; // AutoCAD entity name, e.g. LINE, or '*'
  layer?: string; // name or '*'
  color?: ColorSpec | '*';
}

export function qselect(entities: readonly Entity[], f: QSelectFilter): Entity[] {
  const wantType = f.type && f.type !== '*' ? f.type.toUpperCase() : null;
  const wantLayer = f.layer && f.layer !== '*' ? f.layer.toUpperCase() : null;
  return entities.filter((e) => {
    if (wantType && entityTypeName(e) !== wantType && !(wantType === 'POLYLINE' && e.type === 'polyline') && !(wantType === 'BLOCK' && e.type === 'insert')) return false;
    if (wantLayer && e.layer.toUpperCase() !== wantLayer) return false;
    if (f.color !== undefined && f.color !== '*' && e.color !== f.color) return false;
    return true;
  });
}

const QS_TYPES = ['Line', 'Circle', 'Arc', 'LWPolyline', 'Text', 'MText', 'Insert', 'Dimension', 'Ellipse', 'Point', 'Xline', 'Ray', 'All'];

/** QSELECT [type [layer [color]]] — no arguments prompts for each filter. */
export function qselectTool(arg?: string): Tool {
  return scriptTool('QSELECT', function* (ctx) {
    const parts = (arg ?? '').split(/\s+/).filter(Boolean);
    let type = parts[0];
    let layer = parts[1];
    let colorText = parts[2];
    if (!type) {
      for (;;) {
        const a = yield { prompt: `Enter object type [${QS_TYPES.join('/')}] <All>:`, distance: false };
        if (a.type === 'enter') {
          type = '*';
          break;
        }
        if (a.type === 'text') {
          const k = QS_TYPES.find((t) => t.toUpperCase().startsWith(a.text.trim().toUpperCase()));
          if (k) {
            type = k === 'All' ? '*' : k;
            break;
          }
          ctx.log(`Invalid option keyword: ${a.text}`);
        }
      }
      const l = yield { prompt: 'Enter layer name or * for any <*>:', distance: false, free: true };
      layer = l.type === 'text' ? l.text.trim() : '*';
      const c = yield { prompt: 'Enter color number, ByLayer, or * for any <*>:', distance: false, free: true };
      colorText = c.type === 'text' ? c.text.trim() : '*';
    }
    let color: ColorSpec | '*' = '*';
    if (colorText && colorText !== '*') color = /^bylayer$/i.test(colorText) ? 'ByLayer' : parseInt(colorText, 10);
    const found = qselect(ctx.doc.entities, { type: type === 'ALL' ? '*' : type, layer: layer ?? '*', color });
    ctx.selection = new Set(found.map((e) => e.id));
    if (found.length) selectionHistory.previous = found.map((e) => e.id);
    ctx.log(`${found.length} item(s) selected.`);
  });
}
