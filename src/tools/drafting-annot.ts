/**
 * Annotation and fill commands: HATCH (-HATCH style), HATCHEDIT, LEADER / QLEADER,
 * MLEADER, TABLE, TABLEEDIT, FIELD and UPDATEFIELD.
 */
import type { Point } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity, HatchEntity, LeaderEntity, TableEntity, TextEntity, MTextEntity, HatchLoop, MTextAttachment } from '../core/entities';
import { newId, ellipsePoints, isFullEllipse, splinePoints, hatchGeometry } from '../core/entities';
import { HATCH_PATTERNS, findPattern, loopPolygon, pointInLoops, polygonArea } from '../core/hatch';
import { newTable, cellAt, setCellText, TABLE_DEFAULTS } from '../core/table';
import { mtextFromDxf, hasFormatting } from '../core/mtext';
import { evaluateFields, acVarField, ACVAR_FIELDS, type FieldContext } from '../core/fields';
import type { Drawing } from '../core/document';
import type { Tool, ToolContext } from './types';
import { scriptTool, point, pointOrKeyword, text, number, keyword, select, dflt, type Step } from './script';

const base = (ctx: ToolContext) => ({ id: newId(), layer: ctx.doc.currentLayer, color: 'ByLayer' as const });

/** Sticky settings, like AutoCAD's HPNAME / HPSCALE / HPANG and the Standard multileader style. */
export const annotDefaults = {
  hatchPattern: 'ANSI31',
  hatchScale: 1,
  /** Degrees. */
  hatchAngle: 0,
  hatchOrigin: null as Point | null,
  leaderArrow: 0.18,
  leaderTextHeight: 0.18,
  landingGap: 0.09,
  doglegLength: 0.36,
  tableColumns: 5,
  tableRows: 1,
  tableColumnWidth: TABLE_DEFAULTS.columnWidth,
  tableRowLines: 1,
  fieldName: 'Date',
};

// ------------------------------------------------------------------ boundaries

/** A closed object's outline as a hatch loop (closed polylines, circles, full ellipses, closed splines). */
export function loopFromEntity(e: Entity): HatchLoop | null {
  switch (e.type) {
    case 'polyline': {
      const n = e.points.length;
      const closed = e.closed || (n > 2 && g.eq(e.points[0]!, e.points[n - 1]!));
      if (!closed || n < 2) return null;
      const pts = e.closed ? [...e.points] : e.points.slice(0, -1);
      const bulges = e.bulges ? e.bulges.slice(0, pts.length) : undefined;
      return { points: pts, ...(bulges && bulges.some((b) => Math.abs(b) > 1e-12) ? { bulges } : {}) };
    }
    case 'circle':
      return { points: [g.add(e.center, { x: e.radius, y: 0 }), g.sub(e.center, { x: e.radius, y: 0 })], bulges: [1, 1] };
    case 'ellipse':
      return isFullEllipse(e) ? { points: ellipsePoints(e).slice(0, -1) } : null;
    case 'spline': {
      const pts = splinePoints(e);
      if (pts.length < 3) return null;
      const closed = e.closed || g.eq(pts[0]!, pts[pts.length - 1]!, 1e-9);
      return closed ? { points: g.eq(pts[0]!, pts[pts.length - 1]!, 1e-9) ? pts.slice(0, -1) : pts } : null;
    }
    default:
      return null;
  }
}

const loopArea = (l: HatchLoop): number => Math.abs(polygonArea(loopPolygon(l)));

/**
 * "Pick internal point": the smallest closed object around the point is the outer boundary,
 * and closed objects inside it that do not contain the point become islands.
 */
export function boundaryAt(entities: readonly Entity[], p: Point): HatchLoop[] | null {
  const loops = entities.map(loopFromEntity).filter((l): l is HatchLoop => !!l);
  const around = loops.filter((l) => pointInLoops(p, [loopPolygon(l)])).sort((a, b) => loopArea(a) - loopArea(b));
  const outer = around[0];
  if (!outer) return null;
  const outerPoly = loopPolygon(outer);
  const inner = loops.filter((l) => l !== outer && !pointInLoops(p, [loopPolygon(l)]) && loopPolygon(l).every((q) => pointInLoops(q, [outerPoly])));
  // Only the outermost islands (an island inside an island is filled again by the even-odd rule anyway).
  const islands = inner.filter((l) => !inner.some((o) => o !== l && loopArea(o) > loopArea(l) && loopPolygon(l).every((q) => pointInLoops(q, [loopPolygon(o)]))));
  return [outer, ...islands];
}

function hatchEntity(ctx: ToolContext, loops: HatchLoop[]): HatchEntity {
  const name = annotDefaults.hatchPattern.toUpperCase();
  const solid = name === 'SOLID';
  return {
    ...base(ctx),
    type: 'hatch',
    pattern: name,
    solid,
    angle: g.rad(annotDefaults.hatchAngle),
    scale: annotDefaults.hatchScale,
    ...(annotDefaults.hatchOrigin ? { origin: annotDefaults.hatchOrigin } : {}),
    loops,
    patternType: name === '_USER' ? 0 : 1,
  };
}

/** Pattern / scale / angle prompts shared by HATCH and HATCHEDIT. */
function* patternProperties(ctx: ToolContext, cur: { pattern: string; scale: number; angle: number }): Step<{ pattern: string; scale: number; angle: number } | null> {
  let pattern = cur.pattern;
  for (;;) {
    const t = yield* text(`Enter a pattern name or [?/Solid/User defined] <${pattern}>:`, pattern, false);
    if (t === null) return null;
    const v = t.trim().toUpperCase();
    if (v === '?') {
      for (const p of Object.values(HATCH_PATTERNS)) ctx.log(`${p.name.padEnd(8)} ${p.description}`);
      continue;
    }
    if (v === 'S' || v === 'SOLID') pattern = 'SOLID';
    else if (v === 'U' || v === 'USER' || v === 'USER DEFINED') {
      ctx.log('User-defined patterns are not supported; use LINE with a scale.');
      pattern = 'LINE';
    } else if (findPattern(v)) pattern = v;
    else {
      ctx.log(`Unknown pattern name: ${t.trim()}. Enter ? for the list.`);
      continue;
    }
    break;
  }
  if (pattern === 'SOLID') return { pattern, scale: cur.scale, angle: cur.angle };
  const sc = yield* number(ctx, `Specify a scale for the pattern ${dflt(cur.scale)}:`, cur.scale, { from: null });
  if (!sc || !('value' in sc)) return null;
  const an = yield* number(ctx, `Specify an angle for the pattern <${cur.angle.toFixed(0)}>:`, cur.angle, { from: null, allowZero: true, allowNegative: true });
  if (!an || !('value' in an)) return null;
  return { pattern, scale: sc.value, angle: an.value };
}

/** -HATCH: internal point, selected closed objects or a drawn boundary; Properties sets pattern / scale / angle. */
export function hatchTool(): Tool {
  return scriptTool('HATCH', function* (ctx) {
    const loops: HatchLoop[] = [];
    const preview = (): Entity[] => (loops.length ? [hatchEntity(ctx, loops)] : []);
    for (;;) {
      const kws = ['Properties', 'Select objects', 'draW boundary', 'Origin'];
      const r = yield* pointOrKeyword('Specify internal point or [Properties/Select objects/draW boundary/Origin]:', kws, { preview });
      if (!r) break;
      if ('point' in r) {
        const found = boundaryAt(ctx.doc.entities.filter((e) => ctx.doc.layer(e.layer)?.visible !== false), r.point);
        if (!found) {
          ctx.log('Valid hatch boundary not found.');
          continue;
        }
        loops.push(...found);
        ctx.log('Selecting everything visible...');
        ctx.log('Analyzing the selected data...');
        ctx.setPreview(preview());
        continue;
      }
      if ('text' in r) {
        ctx.log(`Invalid option keyword: ${r.text}`);
        continue;
      }
      switch (r.keyword) {
        case 'PROPERTIES': {
          const p = yield* patternProperties(ctx, { pattern: annotDefaults.hatchPattern, scale: annotDefaults.hatchScale, angle: annotDefaults.hatchAngle });
          if (p) {
            annotDefaults.hatchPattern = p.pattern;
            annotDefaults.hatchScale = p.scale;
            annotDefaults.hatchAngle = p.angle;
          }
          break;
        }
        case 'SELECT OBJECTS': {
          const ids = yield* select(ctx, 'Select objects:', false);
          const set = new Set(ids);
          let n = 0;
          for (const e of ctx.doc.entities) {
            if (!set.has(e.id)) continue;
            const l = loopFromEntity(e);
            if (l) {
              loops.push(l);
              n += 1;
            }
          }
          if (n < ids.length) ctx.log(`${ids.length - n} object(s) are not closed and were ignored.`);
          break;
        }
        case 'DRAW BOUNDARY': {
          const pts: Point[] = [];
          const first = yield* point(ctx, 'Specify start point:');
          if (!first) break;
          pts.push(first);
          for (;;) {
            const q = yield* pointOrKeyword(`Specify next point or [${pts.length > 1 ? 'Undo' : 'Undo'}]:`, ['Undo'], {
              preview: (c) => [{ ...base(ctx), type: 'polyline', points: [...pts, c], closed: true }],
              trackFrom: pts[pts.length - 1]!,
            });
            if (!q) break;
            if ('keyword' in q) {
              if (pts.length > 1) pts.pop();
              continue;
            }
            if ('point' in q) pts.push(q.point);
          }
          if (pts.length >= 3) loops.push({ points: pts });
          else ctx.log('A boundary needs at least three points.');
          break;
        }
        case 'ORIGIN': {
          const o = yield* point(ctx, 'Specify origin point:');
          if (o) annotDefaults.hatchOrigin = o;
          break;
        }
      }
    }
    if (!loops.length) return;
    const h = hatchEntity(ctx, loops);
    if (!h.solid && hatchGeometry(h).dense) ctx.log('Hatch spacing too dense, or dash size too small; it is shown as a light fill.');
    ctx.doc.addEntities([h]);
  });
}

/** Pick one entity of a type: the pick-first set or a selection. */
function* pickOne<T extends Entity['type']>(ctx: ToolContext, prompt: string, type: T): Step<Extract<Entity, { type: T }> | null> {
  const ids = yield* select(ctx, prompt);
  const set = new Set(ids);
  const hit = ctx.doc.entities.find((e) => set.has(e.id) && e.type === type);
  return (hit as Extract<Entity, { type: T }> | undefined) ?? null;
}

/** HATCHEDIT: Properties (pattern, scale, angle) and Origin. */
export function hatchEditTool(): Tool {
  return scriptTool('HATCHEDIT', function* (ctx) {
    const h = yield* pickOne(ctx, 'Select hatch object:', 'hatch');
    if (!h) {
      ctx.log('No hatch selected.');
      return;
    }
    ctx.selection = new Set();
    const opt = yield* keyword(ctx, 'Enter hatch option [Disassociate/Style/Properties/Origin] <Properties>:', ['Disassociate', 'Style', 'Properties', 'Origin'], 'Properties');
    if (opt === 'PROPERTIES') {
      const p = yield* patternProperties(ctx, { pattern: h.solid ? 'SOLID' : h.pattern, scale: h.scale, angle: g.deg(h.angle) });
      if (!p) return;
      const solid = p.pattern === 'SOLID';
      const { patternLines: _drop, ...rest } = h;
      ctx.doc.replaceEntities([{ ...rest, pattern: p.pattern, solid, scale: p.scale, angle: g.rad(p.angle), patternType: 1 }]);
    } else if (opt === 'ORIGIN') {
      const o = yield* point(ctx, 'Specify origin point:');
      if (o) ctx.doc.replaceEntities([{ ...h, origin: o }]);
    } else if (opt === 'DISASSOCIATE') {
      ctx.doc.replaceEntities([{ ...h, associative: false }]);
    } else if (opt === 'STYLE') {
      const st = yield* keyword(ctx, 'Enter hatch style [Ignore/Outer/Normal] <Normal>:', ['Ignore', 'Outer', 'Normal'], 'Normal');
      ctx.doc.replaceEntities([{ ...h, style: st === 'IGNORE' ? 2 : st === 'OUTER' ? 1 : 0 }]);
    }
  });
}

// ------------------------------------------------------------------ LEADER / QLEADER / MLEADER

/** Text lines until an empty line; null when none were entered. */
function* textLines(first: string, next: string): Step<string[]> {
  const lines: string[] = [];
  for (;;) {
    const t = yield* text(lines.length ? next : first, null, true);
    if (t === null || t === '') break;
    lines.push(t);
  }
  return lines;
}

/** Text placement at the end of a landing: to the right reads from the left, "middle of top line". */
function placeText(end: Point, dir: number, h: number, gap: number): { textPosition: Point; textAttachment: MTextAttachment } {
  return { textPosition: { x: end.x + dir * gap, y: end.y + h / 2 }, textAttachment: dir >= 0 ? 1 : 3 };
}

/** LEADER (and QLEADER): points, then annotation text; Format switches Spline / STraight / Arrow / None. */
export function leaderTool(name = 'LEADER'): Tool {
  return scriptTool(name, function* (ctx) {
    const h = annotDefaults.leaderTextHeight;
    const arrowSize = annotDefaults.leaderArrow;
    const start = yield* point(ctx, name === 'QLEADER' ? 'Specify first leader point, or [Settings] <Settings>:' : 'Specify leader start point:');
    if (!start) return;
    const pts: Point[] = [start];
    let spline = false;
    let arrow = true;
    const build = (extra?: Point): LeaderEntity => ({ ...base(ctx), type: 'leader', vertices: extra ? [...pts, extra] : [...pts], arrow, arrowSize, textHeight: h, ...(spline ? { spline } : {}), kind: 'leader' });
    for (;;) {
      const kws = pts.length > 1 ? ['Annotation', 'Format', 'Undo'] : [];
      const r = yield* pointOrKeyword(pts.length > 1 ? 'Specify next point or [Annotation/Format/Undo] <Annotation>:' : 'Specify next point:', kws, { preview: (c) => [build(c)], trackFrom: pts[pts.length - 1]! });
      if (!r) {
        if (pts.length > 1) break;
        return;
      }
      if ('point' in r) {
        if (!g.eq(r.point, pts[pts.length - 1]!)) pts.push(r.point);
        continue;
      }
      if ('text' in r) {
        ctx.log(`Invalid option keyword: ${r.text}`);
        continue;
      }
      if (r.keyword === 'UNDO') {
        if (pts.length > 1) pts.pop();
        continue;
      }
      if (r.keyword === 'FORMAT') {
        const f = yield* keyword(ctx, 'Enter leader format option [Spline/STraight/Arrow/None] <Exit>:', ['Spline', 'STraight', 'Arrow', 'None', 'Exit'], 'Exit');
        if (f === 'SPLINE') spline = true;
        else if (f === 'STRAIGHT') spline = false;
        else if (f === 'ARROW') arrow = true;
        else if (f === 'NONE') arrow = false;
        continue;
      }
      break;
    }
    const lines = yield* textLines('Enter first line of annotation text or <options>:', 'Enter next line of annotation text:');
    const last = pts[pts.length - 1]!;
    const prev = pts[pts.length - 2]!;
    const dir = last.x >= prev.x ? 1 : -1;
    const seg = g.sub(last, prev);
    // A hook line (landing) when the last segment is not close to horizontal.
    const needsHook = Math.abs(Math.atan2(seg.y, Math.abs(seg.x))) > g.rad(15);
    const dogleg = needsHook ? { x: dir * arrowSize, y: 0 } : undefined;
    const end = dogleg ? g.add(last, dogleg) : last;
    const leader: LeaderEntity = {
      ...build(),
      ...(dogleg && lines.length ? { dogleg } : {}),
      ...(lines.length ? { text: lines.join('\n'), ...placeText(end, dir, h, h / 2) } : {}),
    };
    ctx.doc.addEntities([leader]);
  });
}

/** MLEADER: arrowhead location, landing location, then the text (Standard multileader style). */
export function mleaderTool(): Tool {
  return scriptTool('MLEADER', function* (ctx) {
    const h = annotDefaults.leaderTextHeight;
    let tip: Point | null = null;
    let contentFirst = false;
    for (;;) {
      const r = yield* pointOrKeyword('Specify leader arrowhead location or [leader Landing first/Content first/Options] <Options>:', ['leader Landing first', 'Content first', 'Options']);
      if (!r) return;
      if ('point' in r) {
        tip = r.point;
        break;
      }
      if ('keyword' in r && r.keyword === 'CONTENT FIRST') {
        contentFirst = true;
        break;
      }
      if ('keyword' in r && r.keyword === 'LEADER LANDING FIRST') {
        ctx.log('Leader landing first: specify the arrowhead next.');
        continue;
      }
      if ('keyword' in r && r.keyword === 'OPTIONS') {
        const s = yield* number(ctx, `Specify arrowhead size ${dflt(annotDefaults.leaderArrow)}:`, annotDefaults.leaderArrow, { from: null, allowZero: true });
        if (s && 'value' in s) annotDefaults.leaderArrow = s.value;
        const d = yield* number(ctx, `Specify fixed landing distance ${dflt(annotDefaults.doglegLength)}:`, annotDefaults.doglegLength, { from: null, allowZero: true });
        if (d && 'value' in d) annotDefaults.doglegLength = d.value;
        continue;
      }
      if ('text' in r) ctx.log(`Invalid option keyword: ${r.text}`);
    }
    let lines: string[] = [];
    if (contentFirst) {
      lines = yield* textLines('Enter text:', 'Enter next line:');
      const t = yield* point(ctx, 'Specify leader arrowhead location:');
      if (!t) return;
      tip = t;
    }
    const at = tip!;
    const build = (landing: Point): LeaderEntity => {
      const dir = landing.x >= at.x ? 1 : -1;
      const dogleg = annotDefaults.doglegLength > 0 ? { x: dir * annotDefaults.doglegLength, y: 0 } : undefined;
      const end = dogleg ? g.add(landing, dogleg) : landing;
      return {
        ...base(ctx),
        type: 'leader',
        vertices: [at, landing],
        arrow: annotDefaults.leaderArrow > 0,
        arrowSize: annotDefaults.leaderArrow,
        ...(dogleg ? { dogleg } : {}),
        textHeight: h,
        ...(lines.length ? { text: lines.join('\n'), ...placeText(end, dir, h, annotDefaults.landingGap) } : {}),
        kind: 'mleader',
      };
    };
    const landing = yield* point(ctx, 'Specify leader landing location:', { preview: (c) => [build(c)], trackFrom: at });
    if (!landing) return;
    if (!contentFirst) lines = yield* textLines('Enter text:', 'Enter next line:');
    ctx.doc.addEntities([build(landing)]);
  });
}

// ------------------------------------------------------------------ TABLE / TABLEEDIT

/** -TABLE: columns, data rows, then the insertion point (Width / Height set column width and row height). */
export function tableTool(): Tool {
  return scriptTool('TABLE', function* (ctx) {
    ctx.log('Current table style: "Standard"');
    const c = yield* number(ctx, `Enter number of columns or [Auto] <${annotDefaults.tableColumns}>:`, annotDefaults.tableColumns, { from: null, integer: true, min: 1, keywords: ['Auto'] });
    if (!c) return;
    if ('value' in c) annotDefaults.tableColumns = Math.min(100, c.value);
    const r = yield* number(ctx, `Enter number of data rows or [Auto] <${annotDefaults.tableRows}>:`, annotDefaults.tableRows, { from: null, integer: true, min: 1, keywords: ['Auto'] });
    if (!r) return;
    if ('value' in r) annotDefaults.tableRows = Math.min(1000, r.value);
    const make = (p: Point): TableEntity =>
      newTable(base(ctx), { position: p, columns: annotDefaults.tableColumns, dataRows: annotDefaults.tableRows, columnWidth: annotDefaults.tableColumnWidth, rowLines: annotDefaults.tableRowLines });
    for (;;) {
      const q = yield* pointOrKeyword('Specify insertion point or [Style/Width/Height]:', ['Style', 'Width', 'Height'], { preview: (p) => [make(p)] });
      if (!q) return;
      if ('point' in q) {
        const t = make(q.point);
        ctx.doc.addEntities([t]);
        ctx.log(`Table: ${t.columnWidths.length} column(s), ${t.rowHeights.length} row(s) (title, header, ${annotDefaults.tableRows} data). Use TABLEEDIT to fill cells.`);
        return;
      }
      if ('text' in q) {
        ctx.log(`Invalid option keyword: ${q.text}`);
        continue;
      }
      if (q.keyword === 'WIDTH') {
        const w = yield* number(ctx, `Specify column width ${dflt(annotDefaults.tableColumnWidth)}:`, annotDefaults.tableColumnWidth, { from: null });
        if (w && 'value' in w) annotDefaults.tableColumnWidth = w.value;
      } else if (q.keyword === 'HEIGHT') {
        const h = yield* number(ctx, `Specify data row height (in lines) <${annotDefaults.tableRowLines}>:`, annotDefaults.tableRowLines, { from: null, integer: true, min: 1 });
        if (h && 'value' in h) annotDefaults.tableRowLines = h.value;
      } else ctx.log('Only the Standard table style is available.');
    }
  });
}

/** TABLEEDIT: pick a cell, then type its text (Enter keeps the current text). */
export function tableEditTool(): Tool {
  return scriptTool('TABLEEDIT', function* (ctx) {
    for (;;) {
      const p = yield* point(ctx, 'Pick a table cell:');
      if (!p) return;
      const tables = ctx.doc.entities.filter((e): e is TableEntity => e.type === 'table');
      let found: { t: TableEntity; row: number; col: number } | null = null;
      for (const t of tables) {
        const c = cellAt(t, p);
        if (c) {
          found = { t, ...c };
          break;
        }
      }
      if (!found) {
        ctx.log('No table cell at that point.');
        continue;
      }
      const cur = found.t.cells[found.row]?.[found.col]?.text ?? '';
      const v = yield* text(`Enter cell text <${cur}>:`, cur, true);
      if (v === null) return;
      if (v !== cur) ctx.doc.replaceEntities([setCellText(found.t, found.row, found.col, v)]);
      return;
    }
  });
}

// ------------------------------------------------------------------ FIELD / UPDATEFIELD

/** Values for field evaluation from the drawing (file name, current date). */
export function fieldContextFor(doc: Drawing, extra: FieldContext = {}): FieldContext {
  return { filePath: doc.filePath, now: new Date(), ...extra };
}

/** Re-evaluate the fields of one entity; the same object when nothing changes. */
export function updateEntityFields(e: Entity, fc: FieldContext): Entity {
  if (e.type === 'text' && e.field) {
    const value = evaluateFields(e.field.code, fc);
    // A stale link (text edited since) is left alone.
    if (e.field.value !== e.text || value === e.text) return e;
    return { ...e, text: value, field: { code: e.field.code, value } };
  }
  if (e.type === 'mtext' && e.field) {
    if (e.field.value !== e.text) return e;
    const raw = evaluateFields(e.field.code, fc);
    const value = mtextFromDxf(raw);
    if (value === e.text) return e;
    const { raw: _old, ...rest } = e;
    return { ...rest, text: value, ...(hasFormatting(raw) ? { raw } : {}), field: { code: e.field.code, value } } as MTextEntity;
  }
  return e;
}

/** Update every field in a list of entities; returns the changed ones. */
export function updateFields(entities: readonly Entity[], fc: FieldContext): { found: number; changed: Entity[] } {
  let found = 0;
  const changed: Entity[] = [];
  for (const e of entities) {
    if ((e.type === 'text' || e.type === 'mtext') && e.field) found += 1;
    const u = updateEntityFields(e, fc);
    if (u !== e) changed.push(u);
  }
  return { found, changed };
}

/** Date formats offered by FIELD (AutoCAD's list, abbreviated). */
const DATE_FORMATS = ['M/d/yyyy', 'dddd, MMMM d, yyyy', 'd MMMM yyyy', 'MM/dd/yy', 'yyyy-MM-dd', 'd-MMM-yy', 'h:mm tt', 'M/d/yyyy h:mm tt'];
const FILENAME_FORMATS: Record<string, string> = { NAME: '%fn2', 'NAME.EXT': '%fn6', PATH: '%fn7', FOLDER: '%fn1' };

/** FIELD: choose an \AcVar field and its format, then place it as single-line text. */
export function fieldTool(): Tool {
  return scriptTool('FIELD', function* (ctx) {
    const names = [...ACVAR_FIELDS];
    const pick = yield* keyword(ctx, `Enter field name [${names.join('/')}] <${annotDefaults.fieldName}>:`, names, annotDefaults.fieldName);
    if (!pick) return;
    const name = names.find((n) => n.toUpperCase() === pick) ?? 'Date';
    annotDefaults.fieldName = name;
    let format: string | undefined;
    if (/date$/i.test(name)) {
      DATE_FORMATS.forEach((f, i) => ctx.log(`  ${i + 1}. ${f}`));
      const f = yield* text(`Enter date format or number <${DATE_FORMATS[0]}>:`, DATE_FORMATS[0]!, true);
      if (f === null) return;
      const n = parseInt(f, 10);
      format = /^\d+$/.test(f.trim()) && DATE_FORMATS[n - 1] ? DATE_FORMATS[n - 1] : f.trim() || DATE_FORMATS[0];
    } else if (name === 'Filename') {
      const f = yield* keyword(ctx, 'Enter filename format [Name/NAME.Ext/Path/Folder] <NAME.Ext>:', ['Name', 'NAME.Ext', 'Path', 'Folder'], 'NAME.Ext');
      format = FILENAME_FORMATS[f ?? 'NAME.EXT'] ?? '%fn6';
    }
    const code = acVarField(name, format);
    const fc = fieldContextFor(ctx.doc);
    const value = evaluateFields(code, fc);
    ctx.log(`Field value: ${value}`);
    const height = 0.2;
    const make = (p: Point): TextEntity => ({ ...base(ctx), type: 'text', position: p, text: value, height, rotation: 0, align: 'left', field: { code, value } });
    const p = yield* point(ctx, 'Specify start point of text:', { preview: (c) => [make(c)] });
    if (!p) return;
    ctx.doc.addEntities([make(p)]);
  });
}

/** UPDATEFIELD: re-evaluate the fields of the selected objects. */
export function updateFieldTool(): Tool {
  return scriptTool('UPDATEFIELD', function* (ctx) {
    const ids = yield* select(ctx, 'Select objects:');
    const set = new Set(ids);
    const { found, changed } = updateFields(
      ctx.doc.entities.filter((e) => set.has(e.id)),
      fieldContextFor(ctx.doc),
    );
    if (changed.length) ctx.doc.replaceEntities(changed);
    ctx.log(`${found} field(s) found.`);
    ctx.log(`${changed.length} field(s) updated.`);
  });
}
