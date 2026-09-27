/**
 * Core AutoCAD drafting commands registered on top of the Editor's basic set:
 * dimensions, extra entities, modify commands, blocks, inquiry, units/limits/views,
 * zoom options, selection modes, layer/linetype/lineweight command-line options,
 * object snap settings and tracking.
 */
import type { Editor } from './editor';
import type { Point, Bounds } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity, Layer, ColorSpec } from '../core/entities';
import { entityBounds } from '../core/entities';
import type { DimStyle } from '../core/dimension';
import { STANDARD_DIMSTYLE, ISO25_DIMSTYLE } from '../core/dimension';
import { STANDARD_LINETYPES, findLinetype, LINEWEIGHTS, nearestLineweight } from '../core/linetypes';
import { OSNAP_MODES, osmode } from '../core/snap';
import { formatLength, LUNIT_NAMES, INSUNIT_NAMES, parseDistance, type LinearUnits } from '../core/units';
import type { Tool, ToolContext } from '../tools/types';
import { scriptTool, point, pointOrKeyword, text, number, keyword, select, matchKeyword, dflt, type Step } from '../tools/script';
import { dimLinearTool, dimAlignedTool, dimRadiusTool, dimDiameterTool, dimAngularTool } from '../tools/dimension';
import { plineTool, ellipseTool, pointTool, xlineTool, rayTool, donutTool, polygonTool, mtextTool } from '../tools/drafting-draw';
import { filletTool, chamferTool, arrayTool, arrayRectTool, arrayPolarTool, stretchTool, breakTool, joinTool, lengthenTool, alignTool, matchPropTool } from '../tools/drafting-modify';
import { blockTool, insertTool, referencedBlocks, unusedLayers, unusedLinetypes } from '../tools/blocks';
import { distTool, idTool, areaTool, listTool } from '../tools/inquiry';
import { selectTool, qselectTool, selectionKeyword, selectionHistory } from '../tools/select';

type Reg = (name: string, aliases: string[], description: string, run: (ed: Editor, arg?: string) => void) => void;

/** Editor.emit is private; view changes made here still need to notify the status bar. */
function emitView(ed: Editor): void {
  (ed as unknown as { emit(ev: 'view'): void }).emit('view');
}

// ------------------------------------------------------------------ helpers

/** AutoCAD wildcard (* ? ,) name matching. */
export function wildcardMatch(pattern: string, name: string): boolean {
  return pattern.split(',').some((p) => {
    const re = new RegExp(`^${p.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
    return re.test(name);
  });
}

function parseColor(text: string): ColorSpec | null {
  const t = text.trim().toUpperCase();
  const names: Record<string, number> = { RED: 1, YELLOW: 2, GREEN: 3, CYAN: 4, BLUE: 5, MAGENTA: 6, WHITE: 7 };
  if (t === 'BYLAYER') return 'ByLayer';
  if (names[t] !== undefined) return names[t]!;
  const n = parseInt(t, 10);
  return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
}

function parseLineweight(text: string): number | null {
  const t = text.trim().toUpperCase();
  if (t === 'BYLAYER') return -1;
  if (t === 'BYBLOCK') return -2;
  if (t === 'DEFAULT') return -3;
  const v = parseFloat(t);
  if (!Number.isFinite(v) || v < 0) return null;
  // AutoCAD accepts millimetres; values > 3 are taken as hundredths (e.g. 50 -> 0.50 mm).
  return nearestLineweight(v > 3 ? v / 100 : v);
}

/** Generic system variable command: "Enter new value for NAME <current>:". */
function sysvar(reg: Reg, name: string, description: string, get: (ed: Editor) => number, set: (ed: Editor, v: number) => void, opts: { integer?: boolean; allowZero?: boolean; allowNegative?: boolean } = {}): void {
  reg(name, [], description, (ed, arg) => {
    const apply = (v: number) => {
      set(ed, v);
      ed.log(`${name} = ${opts.integer ? v : v.toFixed(4)}`);
      ed.render();
    };
    if (arg !== undefined) {
      const v = parseDistance(arg);
      if (v === null || (!opts.allowNegative && v < 0) || (!opts.allowZero && v === 0 && !opts.allowNegative)) ed.log(`Invalid value for ${name}.`);
      else apply(opts.integer ? Math.round(v) : v);
      return;
    }
    ed.startTool(
      scriptTool(name, function* (ctx) {
        const cur = get(ed);
        const r = yield* number(ctx, `Enter new value for ${name} <${opts.integer ? cur : cur.toFixed(4)}>:`, cur, { from: null, allowZero: opts.allowZero ?? true, allowNegative: opts.allowNegative, integer: opts.integer });
        if (r && 'value' in r && r.value !== cur) apply(r.value);
      }),
    );
  });
}

// ------------------------------------------------------------------ ZOOM / VIEW

function zoomTool(ed: Editor, arg?: string): Tool {
  return scriptTool('ZOOM', function* (ctx) {
    const vp = ed.viewport;
    const after = () => {
      ed.render();
      emitView(ed);
    };
    const kws = ['All', 'Center', 'Extents', 'Previous', 'Scale', 'Window', 'OBject', 'In', 'Out', 'Dynamic'];
    const applyScale = (t: string): boolean => {
      const m = /^(\d*\.?\d+)(X|XP)?$/i.exec(t.trim());
      if (!m) return false;
      const n = parseFloat(m[1]!);
      if (!(n > 0)) return false;
      vp.pushView();
      if (m[2]) vp.zoomAt({ x: vp.width / 2, y: vp.height / 2 }, n);
      else {
        // Plain number: relative to the ZOOM All view.
        const lim = ed.doc.header.limits;
        const all = g.unionBounds(lim, ed.doc.extents()) ?? lim;
        vp.zoomToBounds(all, 0.02);
        vp.zoomAt({ x: vp.width / 2, y: vp.height / 2 }, n);
      }
      after();
      return true;
    };
    let first: string | null = arg?.trim() ? matchKeyword(arg.trim(), kws) ?? arg.trim() : null;
    if (first === null) {
      const r = yield* pointOrKeyword(`Specify corner of window, enter a scale factor (nX or nXP), or [${kws.join('/')}] <real time>:`, kws, { trackFrom: null });
      if (!r) {
        ctx.log('Real-time zoom: use the mouse wheel; middle-drag pans.');
        return;
      }
      if ('point' in r) {
        const a = r.point;
        const b = yield* point(ctx, 'Specify opposite corner:', {
          trackFrom: a,
          preview: (c) => [{ id: 'zw', layer: '0', color: 8, type: 'polyline', closed: true, points: [a, { x: c.x, y: a.y }, c, { x: a.x, y: c.y }] }],
        });
        if (!b) return;
        vp.pushView();
        vp.zoomToBounds(g.boundsOfPoints([a, b])!, 0.02);
        after();
        return;
      }
      first = 'keyword' in r ? r.keyword : r.text;
    }
    if (!first) return;
    if (applyScale(first)) return;
    switch (first) {
      case 'ALL': {
        const lim = ed.doc.header.limits;
        vp.pushView();
        vp.zoomToBounds(g.unionBounds(lim, ed.doc.extents()) ?? lim, 0.02);
        after();
        return;
      }
      case 'EXTENTS':
        vp.pushView();
        ed.zoomExtents();
        return;
      case 'PREVIOUS':
        if (!vp.popView()) ctx.log('No previous view saved.');
        else {
          zoomState.suppressHistory = true;
          after();
          zoomState.suppressHistory = false;
        }
        return;
      case 'IN':
        vp.pushView();
        vp.zoomAt({ x: vp.width / 2, y: vp.height / 2 }, 2);
        after();
        return;
      case 'OUT':
        vp.pushView();
        vp.zoomAt({ x: vp.width / 2, y: vp.height / 2 }, 0.5);
        after();
        return;
      case 'WINDOW': {
        const a = yield* point(ctx, 'Specify first corner:');
        if (!a) return;
        const b = yield* point(ctx, 'Specify opposite corner:', {
          trackFrom: a,
          preview: (c) => [{ id: 'zw', layer: '0', color: 8, type: 'polyline', closed: true, points: [a, { x: c.x, y: a.y }, c, { x: a.x, y: c.y }] }],
        });
        if (!b) return;
        vp.pushView();
        vp.zoomToBounds(g.boundsOfPoints([a, b])!, 0.02);
        after();
        return;
      }
      case 'CENTER': {
        const c = yield* point(ctx, 'Specify center point:');
        if (!c) return;
        const cur = vp.viewHeight;
        const h = yield* text(`Enter magnification or height <${formatLength(cur, ed.doc.header.units)}>:`, null, false);
        vp.pushView();
        vp.center = c;
        if (h !== null) {
          const m = /^(\d*\.?\d+)(X)?$/i.exec(h.trim());
          if (!m) ctx.log('Requires a height or magnification (nX).');
          else if (m[2]) vp.viewHeight = cur / parseFloat(m[1]!);
          else vp.viewHeight = parseFloat(m[1]!);
        }
        after();
        return;
      }
      case 'SCALE': {
        const s = yield* text('Enter a scale factor (nX or nXP):', null, false);
        if (s === null) return;
        if (!applyScale(s)) ctx.log('Requires a positive scale factor.');
        return;
      }
      case 'OBJECT': {
        const ids = yield* select(ctx);
        if (ids.length === 0) return;
        const set = new Set(ids);
        let b: Bounds | null = null;
        for (const e of ed.doc.entities) if (set.has(e.id)) b = g.unionBounds(b, entityBounds(e, ed.doc.lookupBlock));
        if (b) {
          vp.pushView();
          vp.zoomToBounds(b, 0.1);
          after();
        }
        return;
      }
      default:
        ctx.log('Requires a distance, a point, or an option keyword.');
    }
  });
}

const zoomState = { suppressHistory: false };

function viewTool(ed: Editor, arg?: string): Tool {
  return scriptTool('VIEW', function* (ctx) {
    const vp = ed.viewport;
    const kws = ['?', 'Delete', 'Orthographic', 'Restore', 'Save', 'Window'];
    const parts = (arg ?? '').split(/\s+/).filter(Boolean);
    let opt = parts[0] ? matchKeyword(parts[0], kws) : null;
    let name = parts[1];
    if (!opt) {
      opt = yield* keyword(ctx, 'Enter an option [?/Delete/Orthographic/Restore/Save/Window]:', kws);
      if (!opt) return;
    }
    const views = ed.doc.header.views;
    const askName = function* (prompt: string): Step<string | null> {
      if (name) return name;
      const t = yield* text(prompt, null, true);
      return t?.trim() || null;
    };
    switch (opt) {
      case '?':
        if (views.length === 0) ctx.log('No named views.');
        for (const v of views) ctx.log(`  ${v.name.padEnd(20)} center ${v.center.x.toFixed(4)}, ${v.center.y.toFixed(4)}  height ${v.height.toFixed(4)}`);
        return;
      case 'SAVE':
      case 'WINDOW': {
        const n = yield* askName('Enter view name to save:');
        if (!n) return;
        let center = vp.center;
        let height = vp.viewHeight;
        if (opt === 'WINDOW') {
          const a = yield* point(ctx, 'Specify first corner:');
          if (!a) return;
          const b = yield* point(ctx, 'Specify opposite corner:', { trackFrom: a });
          if (!b) return;
          const bb = g.boundsOfPoints([a, b])!;
          center = g.mid(bb.min, bb.max);
          height = Math.max(bb.max.y - bb.min.y, ((bb.max.x - bb.min.x) * vp.height) / Math.max(1, vp.width));
        }
        ed.doc.setHeader({ views: [...views.filter((v) => v.name.toUpperCase() !== n.toUpperCase()), { name: n, center, height }] });
        ctx.log(`View "${n}" saved.`);
        return;
      }
      case 'RESTORE': {
        const n = yield* askName('Enter view name to restore:');
        if (!n) return;
        const v = views.find((x) => x.name.toUpperCase() === n.toUpperCase());
        if (!v) {
          ctx.log(`Cannot find view "${n}".`);
          return;
        }
        vp.pushView();
        vp.center = v.center;
        vp.viewHeight = v.height;
        ed.render();
        emitView(ed);
        return;
      }
      case 'DELETE': {
        const n = yield* askName('Enter view name(s) to delete:');
        if (!n) return;
        const keep = views.filter((v) => !wildcardMatch(n, v.name));
        ed.doc.setHeader({ views: keep });
        ctx.log(`${views.length - keep.length} view(s) deleted.`);
        return;
      }
      default:
        ctx.log('Orthographic views are not available in a 2D drawing.');
    }
  });
}

// ------------------------------------------------------------------ UNITS / LIMITS

function unitsTool(ed: Editor): Tool {
  return scriptTool('UNITS', function* (ctx) {
    const u = ed.doc.header.units;
    ctx.log(`Report formats:      (Examples)`);
    ctx.log(`  1.  Scientific     1.55E+01`);
    ctx.log(`  2.  Decimal        15.50`);
    ctx.log(`  3.  Engineering    1'-3.50"`);
    ctx.log(`  4.  Architectural  1'-3 1/2"`);
    ctx.log(`  5.  Fractional     15 1/2`);
    const kws = ['Scientific', 'Decimal', 'Engineering', 'Architectural', 'Fractional'];
    const cur = LUNIT_NAMES[u.lunits];
    const t = yield* keyword(ctx, `Enter linear units type [Scientific/Decimal/Engineering/Architectural/Fractional] <${cur}>:`, [...kws, '1', '2', '3', '4', '5'], cur);
    if (!t) return;
    const idx = /^[1-5]$/.test(t) ? parseInt(t, 10) : kws.findIndex((k) => k.toUpperCase() === t) + 1;
    const lunits = (idx >= 1 && idx <= 5 ? idx : u.lunits) as LinearUnits;
    const isFraction = lunits === 4 || lunits === 5;
    const p = yield* number(ctx, isFraction ? `Enter denominator of smallest fraction to display (1, 2, 4, 8, 16, 32, 64, 128, or 256) <${2 ** u.luprec}>:` : `Enter number of digits to right of decimal point (0 to 8) <${u.luprec}>:`, isFraction ? 2 ** u.luprec : u.luprec, { integer: true, allowZero: true, from: null });
    if (!p || !('value' in p)) return;
    const luprec = isFraction ? Math.max(0, Math.min(8, Math.round(Math.log2(Math.max(1, p.value))))) : Math.max(0, Math.min(8, p.value));
    const ins = ['Inches', 'Feet', 'Millimeters', 'Centimeters', 'Meters', 'Unitless'];
    const insCodes: Record<string, number> = { INCHES: 1, FEET: 2, MILLIMETERS: 4, CENTIMETERS: 5, METERS: 6, UNITLESS: 0 };
    const curIns = INSUNIT_NAMES[u.insunits] ?? 'Inches';
    const i = yield* keyword(ctx, `Enter insertion scale units [Inches/Feet/Millimeters/Centimeters/Meters/Unitless] <${curIns}>:`, ins, curIns);
    const insunits = i && insCodes[i] !== undefined ? insCodes[i]! : u.insunits;
    ed.doc.setHeader({ units: { ...u, lunits, luprec, insunits } });
    ctx.log(`Units: ${LUNIT_NAMES[lunits]}, precision ${luprec}, insertion scale ${INSUNIT_NAMES[insunits] ?? insunits}.`);
  });
}

function limitsTool(ed: Editor): Tool {
  return scriptTool('LIMITS', function* (ctx) {
    const lim = ed.doc.header.limits;
    const f = (p: Point) => `${formatLength(p.x, ed.doc.header.units)},${formatLength(p.y, ed.doc.header.units)}`;
    ctx.log('Reset Model space limits:');
    const r = yield* pointOrKeyword(`Specify lower left corner or [ON/OFF] <${f(lim.min)}>:`, ['ON', 'OFF'], { trackFrom: null });
    let min = lim.min;
    if (r && 'keyword' in r) {
      ed.viewport.settings.gridBeyondLimits = r.keyword === 'OFF';
      ctx.log(r.keyword === 'ON' ? 'Limits checking on: grid clamped to the drawing limits.' : 'Limits checking off.');
      ed.render();
      return;
    }
    if (r && 'point' in r) min = r.point;
    else if (r && 'text' in r) {
      ctx.log('Requires a point or option keyword.');
      return;
    }
    const m = yield* point(ctx, `Specify upper right corner <${f(lim.max)}>:`, { trackFrom: min, preview: (c) => [{ id: 'lim', layer: '0', color: 8, type: 'polyline', closed: true, points: [min, { x: c.x, y: min.y }, c, { x: min.x, y: c.y }] }] });
    const max = m ?? lim.max;
    if (max.x <= min.x || max.y <= min.y) {
      ctx.log('Upper right corner must be above and to the right of the lower left corner.');
      return;
    }
    ed.doc.setHeader({ limits: { min, max } });
    ed.render();
  });
}

// ------------------------------------------------------------------ LAYER

const LAYER_KWS = ['?', 'Make', 'Set', 'New', 'ON', 'OFF', 'Color', 'Ltype', 'LWeight', 'Freeze', 'Thaw', 'LOck', 'Unlock'];

function layerNames(ed: Editor, pattern: string): Layer[] {
  return ed.doc.layers.filter((l) => wildcardMatch(pattern, l.name));
}

function ensureLayer(ed: Editor, name: string): Layer {
  const existing = ed.doc.layer(name);
  if (existing) return existing;
  const layer: Layer = { name, color: 7, visible: true, locked: false, lineWeight: 0.25 };
  ed.doc.addLayer(layer);
  return layer;
}

/** Apply one -LAYER option with its arguments. Returns a log line. */
function applyLayerOption(ed: Editor, opt: string, args: string[]): string {
  const names = args.join(' ');
  switch (opt) {
    case '?':
      return `Layers: ${ed.doc.layers.map((l) => `${l.name}${l.name === ed.doc.currentLayer ? ' (current)' : ''}${l.visible ? '' : ' [off]'}${l.frozen ? ' [frozen]' : ''}${l.locked ? ' [locked]' : ''} color ${l.color}${l.linetype ? ` ${l.linetype}` : ''}`).join('; ')}`;
    case 'MAKE': {
      if (!names) return 'Requires a layer name.';
      const l = ensureLayer(ed, names);
      if (!l.visible || l.frozen) ed.doc.updateLayer(l.name, { visible: true, frozen: false });
      ed.doc.setCurrentLayer(l.name);
      return `Layer "${l.name}" is now current.`;
    }
    case 'SET': {
      const l = ed.doc.layer(names);
      if (!l) return `Cannot find layer "${names}".`;
      if (l.frozen) return `Cannot set a frozen layer current.`;
      ed.doc.setCurrentLayer(l.name);
      return `Layer "${l.name}" is now current.`;
    }
    case 'NEW': {
      const created: string[] = [];
      for (const n of names.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!ed.doc.layer(n)) {
          ensureLayer(ed, n);
          created.push(n);
        }
      }
      return created.length ? `Created layer(s): ${created.join(', ')}` : 'No new layers created.';
    }
    case 'ON':
    case 'OFF':
    case 'FREEZE':
    case 'THAW':
    case 'LOCK':
    case 'UNLOCK': {
      const list = layerNames(ed, names || '*');
      if (list.length === 0) return `No layers match "${names}".`;
      for (const l of list) {
        if (opt === 'ON') ed.doc.updateLayer(l.name, { visible: !l.frozen });
        else if (opt === 'OFF') ed.doc.updateLayer(l.name, { visible: false });
        else if (opt === 'FREEZE') {
          if (l.name === ed.doc.currentLayer) continue;
          ed.doc.updateLayer(l.name, { frozen: true, visible: false });
        } else if (opt === 'THAW') ed.doc.updateLayer(l.name, { frozen: false, visible: true });
        else if (opt === 'LOCK') ed.doc.updateLayer(l.name, { locked: true });
        else ed.doc.updateLayer(l.name, { locked: false });
      }
      return `${list.length} layer(s) ${opt.toLowerCase()}${opt.endsWith('E') ? 'd' : opt === 'ON' || opt === 'OFF' ? '' : 'ed'}.`;
    }
    case 'COLOR': {
      const c = parseColor(args[0] ?? '');
      if (c === null || c === 'ByLayer') return 'Requires a color number (1-255) or name.';
      const list = layerNames(ed, args.slice(1).join(' ') || ed.doc.currentLayer);
      for (const l of list) ed.doc.updateLayer(l.name, { color: c });
      return `${list.length} layer(s) set to color ${c}.`;
    }
    case 'LTYPE': {
      const lt = args[0];
      if (!lt) return 'Requires a linetype name.';
      const known = findLinetype(lt, ed.doc.header.linetypes);
      if (!known) return `Linetype "${lt}" is not loaded. Use LINETYPE Load.`;
      const list = layerNames(ed, args.slice(1).join(' ') || ed.doc.currentLayer);
      for (const l of list) ed.doc.updateLayer(l.name, { linetype: known.name === 'Continuous' ? undefined : known.name });
      return `${list.length} layer(s) set to linetype ${known.name}.`;
    }
    case 'LWEIGHT': {
      const lw = parseLineweight(args[0] ?? '');
      if (lw === null || lw < 0) return 'Requires a lineweight in millimetres (0 - 2.11).';
      const list = layerNames(ed, args.slice(1).join(' ') || ed.doc.currentLayer);
      for (const l of list) ed.doc.updateLayer(l.name, { lineWeight: lw });
      return `${list.length} layer(s) set to lineweight ${lw.toFixed(2)} mm.`;
    }
    default:
      return `Invalid option keyword: ${opt}`;
  }
}

function layerTool(ed: Editor): Tool {
  return scriptTool('-LAYER', function* (ctx) {
    for (;;) {
      ctx.log(`Current layer:  "${ed.doc.currentLayer}"`);
      const opt = yield* keyword(ctx, 'Enter an option [?/Make/Set/New/ON/OFF/Color/Ltype/LWeight/Freeze/Thaw/LOck/Unlock]:', LAYER_KWS);
      if (!opt) return;
      const args: string[] = [];
      const ask = function* (prompt: string, d: string | null = null): Step<string | null> {
        const t = yield* text(prompt, d, true);
        return t === null ? null : t.trim() || d;
      };
      switch (opt) {
        case '?':
          break;
        case 'MAKE':
        case 'SET':
        case 'NEW': {
          const n = yield* ask(opt === 'NEW' ? 'Enter name list for new layer(s):' : opt === 'MAKE' ? 'Enter name for new layer (becomes the current layer) <0>:' : `Enter layer name to make current or <select object> <${ed.doc.currentLayer}>:`, opt === 'SET' ? ed.doc.currentLayer : null);
          if (!n) continue;
          args.push(n);
          break;
        }
        case 'ON':
        case 'OFF':
        case 'FREEZE':
        case 'THAW':
        case 'LOCK':
        case 'UNLOCK': {
          const n = yield* ask(`Enter name list of layer(s) to ${opt === 'ON' ? 'turn on' : opt === 'OFF' ? 'turn off' : opt.toLowerCase()}:`);
          if (!n) continue;
          args.push(n);
          break;
        }
        case 'COLOR': {
          const c = yield* ask('New color [Truecolor/COlorbook] :');
          if (!c) continue;
          const n = yield* ask(`Enter name list of layer(s) for color ${c} <${ed.doc.currentLayer}>:`, ed.doc.currentLayer);
          args.push(c, n ?? ed.doc.currentLayer);
          break;
        }
        case 'LTYPE': {
          const lt = yield* ask('Enter loaded linetype name or [?] <Continuous>:', 'Continuous');
          if (!lt) continue;
          if (lt === '?') {
            ctx.log(`Loaded linetypes: ${[...STANDARD_LINETYPES, ...ed.doc.header.linetypes].map((l) => l.name).join(', ')}`);
            continue;
          }
          const n = yield* ask(`Enter name list of layer(s) for linetype "${lt}" <${ed.doc.currentLayer}>:`, ed.doc.currentLayer);
          args.push(lt, n ?? ed.doc.currentLayer);
          break;
        }
        case 'LWEIGHT': {
          const lw = yield* ask('Enter lineweight (0.0mm - 2.11mm):');
          if (!lw) continue;
          const n = yield* ask(`Enter name list of layers(s) for lineweight ${lw} <${ed.doc.currentLayer}>:`, ed.doc.currentLayer);
          args.push(lw, n ?? ed.doc.currentLayer);
          break;
        }
      }
      ctx.log(applyLayerOption(ed, opt, args));
      ed.render();
    }
  });
}

// ------------------------------------------------------------------ LINETYPE / LWEIGHT / CHPROP

function linetypeTool(ed: Editor, arg?: string): Tool {
  return scriptTool('-LINETYPE', function* (ctx) {
    const kws = ['?', 'Create', 'Load', 'Set'];
    const parts = (arg ?? '').split(/\s+/).filter(Boolean);
    let opt = parts[0] ? matchKeyword(parts[0], kws) : null;
    for (;;) {
      if (!opt) {
        opt = yield* keyword(ctx, 'Enter an option [?/Create/Load/Set]:', kws);
        if (!opt) return;
      }
      const all = [...STANDARD_LINETYPES, ...ed.doc.header.linetypes];
      if (opt === '?') {
        for (const lt of all) ctx.log(`  ${lt.name.padEnd(12)} ${lt.description}`);
      } else if (opt === 'LOAD') {
        const n = parts[1] ?? (yield* text('Enter linetype(s) to load (* for all standard):', null, true));
        if (!n) return;
        const matches = STANDARD_LINETYPES.filter((lt) => wildcardMatch(n, lt.name) && lt.name !== 'Continuous');
        if (matches.length === 0) ctx.log(`Linetype "${n}" is not in the standard library.`);
        else {
          const extra = ed.doc.header.linetypes.filter((lt) => !matches.some((m) => m.name.toUpperCase() === lt.name.toUpperCase()));
          ed.doc.setHeader({ linetypes: [...extra, ...matches] });
          ctx.log(`Linetype(s) loaded: ${matches.map((m) => m.name).join(', ')}`);
        }
      } else if (opt === 'SET') {
        const n = parts[1] ?? (yield* text(`Specify linetype name or [?] <${ed.doc.header.celtype}>:`, ed.doc.header.celtype, true));
        if (!n) return;
        if (n === '?') {
          for (const lt of all) ctx.log(`  ${lt.name}`);
        } else if (/^bylayer$/i.test(n) || /^byblock$/i.test(n)) ed.doc.setHeader({ celtype: /^bylayer$/i.test(n) ? 'ByLayer' : 'ByBlock' });
        else {
          const lt = findLinetype(n, ed.doc.header.linetypes);
          if (!lt) ctx.log(`Linetype "${n}" is not loaded.`);
          else ed.doc.setHeader({ celtype: lt.name });
        }
        ctx.log(`Current entity linetype: ${ed.doc.header.celtype}`);
      } else ctx.log('Creating linetypes interactively is not supported; edit the LTYPE table in a DXF instead.');
      if (parts.length) return;
      opt = null;
    }
  });
}

function lweightTool(ed: Editor, arg?: string): Tool {
  return scriptTool('-LWEIGHT', function* (ctx) {
    const cur = ed.doc.header.celweight;
    const curText = cur === undefined ? 'ByLayer' : cur === -2 ? 'ByBlock' : `${cur.toFixed(2)} mm`;
    const t = arg ?? (yield* text(`Enter default lineweight for new objects or [?] <${curText}>:`, null, true));
    if (t === null) return;
    if (t.trim() === '?') {
      ctx.log(`Lineweights (mm): ByLayer ByBlock Default ${LINEWEIGHTS.map((w) => w.toFixed(2)).join(' ')}`);
      return;
    }
    const lw = parseLineweight(t);
    if (lw === null) {
      ctx.log('Requires a lineweight in millimetres, ByLayer, ByBlock or Default.');
      return;
    }
    ed.doc.setHeader({ celweight: lw === -1 || lw === -3 ? undefined : lw });
    ctx.log(`Current lineweight: ${lw < 0 ? (lw === -2 ? 'ByBlock' : 'ByLayer') : `${lw.toFixed(2)} mm`}`);
  });
}

function chpropTool(ed: Editor): Tool {
  return scriptTool('CHPROP', function* (ctx) {
    const ids = yield* select(ctx);
    if (ids.length === 0) return;
    const set = new Set(ids);
    const targets = () => ed.doc.entities.filter((e) => set.has(e.id));
    for (;;) {
      const opt = yield* keyword(ctx, 'Enter property to change [Color/LAyer/LType/ltScale/LWeight]:', ['Color', 'LAyer', 'LType', 'ltScale', 'LWeight']);
      if (!opt) return;
      let patch: ((e: Entity) => Entity) | null = null;
      if (opt === 'COLOR') {
        const c = yield* text('New color [Truecolor/COlorbook] <ByLayer>:', 'ByLayer', true);
        const col = parseColor(c ?? 'ByLayer');
        if (col === null) {
          ctx.log('Invalid color.');
          continue;
        }
        patch = (e) => ({ ...e, color: col });
      } else if (opt === 'LAYER') {
        const n = yield* text(`Enter new layer name <${ed.doc.currentLayer}>:`, ed.doc.currentLayer, true);
        if (!n) continue;
        if (!ed.doc.layer(n)) {
          ctx.log(`Cannot find layer "${n}".`);
          continue;
        }
        patch = (e) => ({ ...e, layer: n });
      } else if (opt === 'LTYPE') {
        const n = yield* text('Enter new linetype name <ByLayer>:', 'ByLayer', true);
        if (!n) continue;
        const lt = /^bylayer$/i.test(n) ? null : findLinetype(n, ed.doc.header.linetypes);
        if (!lt && !/^bylayer$/i.test(n)) {
          ctx.log(`Linetype "${n}" is not loaded.`);
          continue;
        }
        patch = (e) => ({ ...e, linetype: lt ? lt.name : undefined });
      } else if (opt === 'LTSCALE') {
        const v = yield* number(ctx, 'Specify new linetype scale <1.0000>:', 1, { from: null });
        if (!v || !('value' in v)) continue;
        patch = (e) => ({ ...e, ltscale: v.value === 1 ? undefined : v.value });
      } else {
        const t = yield* text('Enter new lineweight <ByLayer>:', 'ByLayer', true);
        const lw = parseLineweight(t ?? 'ByLayer');
        if (lw === null) {
          ctx.log('Invalid lineweight.');
          continue;
        }
        patch = (e) => ({ ...e, lineWeight: lw === -1 || lw === -3 ? undefined : lw });
      }
      ed.doc.replaceEntities(targets().map(patch));
      ctx.log(`${set.size} object(s) changed.`);
    }
  });
}

// ------------------------------------------------------------------ OSNAP / tracking

function osnapSet(ed: Editor, arg: string): void {
  const words = arg.trim().split(/[\s,]+/).filter(Boolean);
  if (words.length === 0 || words[0] === '?') {
    const on = OSNAP_MODES.filter((m) => ed.snap[m.key]).map((m) => m.label);
    ed.log(`Object snap modes (OSMODE ${osmode(ed.snap)}): ${on.length ? on.join(', ') : 'none'}${ed.snap.osnap ? '' : ' (OSNAP off)'}`);
    ed.log(`Keywords: ${OSNAP_MODES.map((m) => m.keyword).join(' ')} NONE ?  (prefix with - to remove)`);
    return;
  }
  for (const w of words) {
    const remove = w.startsWith('-');
    const key = w.replace(/^-/, '').toUpperCase();
    const flags = ed.snap as unknown as Record<string, boolean>;
    if (key === 'NONE' || key === 'NON') {
      for (const m of OSNAP_MODES) flags[m.key] = false;
      continue;
    }
    const mode = OSNAP_MODES.find((m) => key.startsWith(m.keyword) || m.label.toUpperCase().startsWith(key));
    if (!mode) {
      ed.log(`Unknown object snap mode: ${w}`);
      continue;
    }
    flags[mode.key] = !remove;
  }
  ed.snap.osnap = true;
  osnapSet(ed, '?');
  ed.render();
}

function osnapTool(ed: Editor): Tool {
  return scriptTool('OSNAPSET', function* () {
    osnapSet(ed, '?');
    const t = yield* text('Enter list of object snap modes:', null, true);
    if (t) osnapSet(ed, t);
  });
}

// ------------------------------------------------------------------ DIMSTYLE / PURGE

const DIM_VARS: Array<{ name: string; key: keyof DimStyle; description: string; integer?: boolean }> = [
  { name: 'DIMTXT', key: 'textHeight', description: 'Dimension text height' },
  { name: 'DIMASZ', key: 'arrowSize', description: 'Dimension arrow size' },
  { name: 'DIMEXO', key: 'extOffset', description: 'Extension line offset' },
  { name: 'DIMEXE', key: 'extExtend', description: 'Extension line extension' },
  { name: 'DIMGAP', key: 'textGap', description: 'Gap around dimension text' },
  { name: 'DIMCEN', key: 'centerMark', description: 'Center mark size' },
  { name: 'DIMSCALE', key: 'scale', description: 'Overall dimension scale' },
  { name: 'DIMDEC', key: 'decimals', description: 'Dimension decimal places', integer: true },
  { name: 'DIMADEC', key: 'angularDecimals', description: 'Angular dimension decimal places', integer: true },
  { name: 'DIMLUNIT', key: 'lunit', description: 'Dimension linear units (1-5)', integer: true },
];

function dimstyleTool(ed: Editor, arg?: string): Tool {
  return scriptTool('-DIMSTYLE', function* (ctx) {
    const kws = ['Save', 'Restore', 'STatus', 'Variables', 'Apply', '?'];
    const parts = (arg ?? '').split(/\s+/).filter(Boolean);
    let opt = parts[0] ? matchKeyword(parts[0], kws) : null;
    if (!opt) {
      ctx.log(`Current dimension style: ${ed.doc.header.dimStyle.name}`);
      opt = yield* keyword(ctx, 'Enter a dimension style option [Save/Restore/STatus/Variables/Apply/?] <Restore>:', kws, 'Restore');
      if (!opt) return;
    }
    const ds = ed.doc.header.dimStyle;
    const styles: DimStyle[] = [STANDARD_DIMSTYLE, ISO25_DIMSTYLE];
    switch (opt) {
      case '?':
        ctx.log(`Named dimension styles: ${styles.map((s) => s.name).join(', ')}`);
        return;
      case 'STATUS':
      case 'VARIABLES':
        for (const v of DIM_VARS) ctx.log(`  ${v.name.padEnd(10)} ${String(ds[v.key]).padEnd(12)} ${v.description}`);
        return;
      case 'RESTORE': {
        const n = parts[1] ?? (yield* text(`Enter a dimension style name, [?] or <select dimension>:`, null, true));
        if (!n) return;
        const s = styles.find((x) => x.name.toUpperCase() === n.trim().toUpperCase());
        if (!s) {
          ctx.log(`Cannot find dimension style "${n}".`);
          return;
        }
        ed.doc.setHeader({ dimStyle: s });
        ctx.log(`Current dimension style: ${s.name}`);
        return;
      }
      case 'SAVE': {
        const n = parts[1] ?? (yield* text('Enter name for new dimension style or [?]:', null, true));
        if (!n) return;
        ed.doc.setHeader({ dimStyle: { ...ds, name: n.trim() } });
        ctx.log(`Dimension style "${n.trim()}" saved (current settings).`);
        return;
      }
      case 'APPLY': {
        const ids = yield* select(ctx);
        const set = new Set(ids);
        const dims = ed.doc.entities.filter((e) => set.has(e.id) && e.type === 'dimension');
        ed.doc.replaceEntities(dims.map((d) => (d.type === 'dimension' ? { ...d, style: ds } : d)));
        ctx.log(`${dims.length} dimension(s) updated to style ${ds.name}.`);
        return;
      }
    }
  });
}

function purgeTool(ed: Editor, arg?: string): Tool {
  return scriptTool('-PURGE', function* (ctx) {
    const kws = ['Blocks', 'LAyers', 'LTypes', 'All'];
    let opt = arg ? matchKeyword(arg.split(/\s+/)[0]!, kws) : null;
    if (!opt) {
      opt = yield* keyword(ctx, 'Enter type of unused objects to purge [Blocks/LAyers/LTypes/All]:', kws);
      if (!opt) return;
    }
    const pattern = arg?.split(/\s+/)[1] ?? (yield* text('Enter name(s) to purge <*>:', '*', true)) ?? '*';
    const verify = yield* keyword(ctx, 'Verify each name to be purged? [Yes/No] <Y>:', ['Yes', 'No'], 'Yes');
    const state = ed.doc.snapshot;
    let removed = 0;
    if (opt === 'BLOCKS' || opt === 'ALL') {
      const used = referencedBlocks(state);
      const names = Object.keys(state.blocks).filter((n) => !used.has(n) && wildcardMatch(pattern, n));
      if (names.length) {
        ed.doc.removeBlocks(names);
        removed += names.length;
        if (verify === 'YES') for (const n of names) ctx.log(`Deleting block "${n}".`);
      }
    }
    if (opt === 'LAYERS' || opt === 'ALL') {
      const names = unusedLayers(ed.doc.snapshot).filter((n) => wildcardMatch(pattern, n));
      if (names.length) {
        ed.doc.removeLayers(names);
        removed += names.length;
        if (verify === 'YES') for (const n of names) ctx.log(`Deleting layer "${n}".`);
      }
    }
    if (opt === 'LTYPES' || opt === 'ALL') {
      const names = unusedLinetypes(ed.doc.snapshot).filter((n) => wildcardMatch(pattern, n));
      if (names.length) {
        ed.doc.setHeader({ linetypes: ed.doc.header.linetypes.filter((l) => !names.includes(l.name)) });
        removed += names.length;
        if (verify === 'YES') for (const n of names) ctx.log(`Deleting linetype "${n}".`);
      }
    }
    ctx.log(removed ? `${removed} unused item(s) purged.` : 'No unnamed objects found to purge.');
  });
}

// ------------------------------------------------------------------ registration

export function registerDraftingCommands(editor: Editor): void {
  const reg: Reg = (name, aliases, description, run) => editor.register({ name, aliases, description, run });

  // Dimensions
  reg('DIMLINEAR', ['DLI', 'DIMLIN'], 'Linear dimension (horizontal/vertical/rotated)', (ed) => ed.startTool(dimLinearTool()));
  reg('DIMALIGNED', ['DAL', 'DIMALI'], 'Aligned dimension', (ed) => ed.startTool(dimAlignedTool()));
  reg('DIMRADIUS', ['DRA', 'DIMRAD'], 'Radius dimension', (ed) => ed.startTool(dimRadiusTool()));
  reg('DIMDIAMETER', ['DDI', 'DIMDIA'], 'Diameter dimension', (ed) => ed.startTool(dimDiameterTool()));
  reg('DIMANGULAR', ['DAN', 'DIMANG'], 'Angular dimension', (ed) => ed.startTool(dimAngularTool()));
  reg('DIMSTYLE', ['D', 'DST', '-DIMSTYLE', 'DDIM'], 'Dimension style [Save/Restore/STatus/Variables/Apply/?]', (ed, arg) => ed.startTool(dimstyleTool(ed, arg)));
  for (const v of DIM_VARS) {
    sysvar(
      reg,
      v.name,
      v.description,
      (ed) => ed.doc.header.dimStyle[v.key] as number,
      (ed, val) => ed.doc.setHeader({ dimStyle: { ...ed.doc.header.dimStyle, [v.key]: v.key === 'lunit' ? (Math.max(1, Math.min(5, Math.round(val))) as LinearUnits) : val } }),
      { integer: v.integer, allowZero: true },
    );
  }

  // Draw
  reg('PLINE', ['PL'], 'Draw a polyline [Arc/Close/Halfwidth/Length/Undo/Width]', (ed) => ed.startTool(plineTool()));
  reg('ELLIPSE', ['EL'], 'Draw an ellipse or elliptical arc', (ed) => ed.startTool(ellipseTool()));
  reg('POINT', ['PO'], 'Draw point objects (PDMODE/PDSIZE set the marker)', (ed) => ed.startTool(pointTool()));
  reg('XLINE', ['XL'], 'Construction line [Hor/Ver/Ang/Bisect/Offset]', (ed) => ed.startTool(xlineTool()));
  reg('RAY', [], 'Semi-infinite construction line', (ed) => ed.startTool(rayTool()));
  reg('DONUT', ['DO', 'DOUGHNUT'], 'Filled ring', (ed) => ed.startTool(donutTool()));
  reg('POLYGON', ['POL'], 'Regular polygon [Edge / Inscribed / Circumscribed]', (ed) => ed.startTool(polygonTool()));
  reg('MTEXT', ['MT', '-MTEXT'], 'Multi-line text with word wrap', (ed) => ed.startTool(mtextTool()));
  sysvar(reg, 'PDMODE', 'Point display mode (0-4, +32 circle, +64 square)', (ed) => ed.doc.header.pdmode, (ed, v) => ed.doc.setHeader({ pdmode: Math.max(0, Math.round(v)) }), { integer: true, allowZero: true });
  sysvar(reg, 'PDSIZE', 'Point display size (0 = 5% of view, <0 = percent of view)', (ed) => ed.doc.header.pdsize, (ed, v) => ed.doc.setHeader({ pdsize: v }), { allowZero: true, allowNegative: true });

  // Modify
  reg('FILLET', ['F'], 'Fillet two lines or a polyline [Radius/Trim/Polyline/Multiple]', (ed) => ed.startTool(filletTool()));
  reg('CHAMFER', ['CHA'], 'Chamfer two lines [Distance/Angle/Trim/Multiple]', (ed) => ed.startTool(chamferTool()));
  reg('ARRAY', ['AR', '-ARRAY'], 'Array objects [Rectangular/Polar]', (ed) => ed.startTool(arrayTool()));
  reg('ARRAYRECT', [], 'Rectangular array', (ed) => ed.startTool(arrayRectTool()));
  reg('ARRAYPOLAR', [], 'Polar array', (ed) => ed.startTool(arrayPolarTool()));
  reg('STRETCH', ['S'], 'Stretch vertices inside a crossing window', (ed) => ed.startTool(stretchTool()));
  reg('BREAK', ['BR'], 'Break an object between two points', (ed) => ed.startTool(breakTool()));
  reg('JOIN', ['J'], 'Join lines, arcs and polylines', (ed) => ed.startTool(joinTool()));
  reg('LENGTHEN', ['LEN'], 'Lengthen lines and arcs [DElta/Percent/Total]', (ed) => ed.startTool(lengthenTool()));
  reg('ALIGN', ['AL'], 'Align objects with source/destination point pairs', (ed) => ed.startTool(alignTool()));
  reg('MATCHPROP', ['MA', 'PAINTER'], 'Copy properties from a source object', (ed) => ed.startTool(matchPropTool()));
  reg('CHPROP', ['-CHPROP'], 'Change color/layer/linetype/ltscale/lineweight of objects', (ed) => ed.startTool(chpropTool(ed)));

  // Blocks
  reg('BLOCK', ['B', '-BLOCK', 'BMAKE'], 'Define a block from selected objects', (ed) => ed.startTool(blockTool()));
  reg('INSERT', ['I', '-INSERT', 'DDINSERT', 'CLASSICINSERT'], 'Insert a block [name, scale, rotation, attributes]', (ed, arg) => ed.startTool(insertTool(arg)));
  reg('PURGE', ['PU', '-PURGE'], 'Purge unused blocks, layers, linetypes [Blocks/LAyers/LTypes/All]', (ed, arg) => ed.startTool(purgeTool(ed, arg)));

  // Inquiry
  reg('DIST', ['DI', 'MEASUREGEOM'], 'Measure distance [Multiple points]', (ed) => ed.startTool(distTool()));
  reg('AREA', ['AA'], 'Measure area and perimeter [Object/Add/Subtract]', (ed) => ed.startTool(areaTool()));
  reg('ID', [], 'Display the coordinates of a point', (ed) => ed.startTool(idTool()));
  reg('LIST', ['LI', 'LS'], 'List object information', (ed) => ed.startTool(listTool()));

  // Units / limits / views / zoom
  reg('UNITS', ['UN', '-UNITS', 'DDUNITS'], 'Drawing units (format, precision, insertion scale)', (ed) => ed.startTool(unitsTool(ed)));
  reg('LIMITS', [], 'Drawing limits [ON/OFF]', (ed) => ed.startTool(limitsTool(ed)));
  sysvar(reg, 'LTSCALE', 'Global linetype scale', (ed) => ed.doc.header.ltscale, (ed, v) => ed.doc.setHeader({ ltscale: v }));
  sysvar(
    reg,
    'GRIDDISPLAY',
    'Grid display: 0 = within limits only, 1 = beyond limits',
    (ed) => (ed.viewport.settings.gridBeyondLimits ? 1 : 0),
    (ed, v) => {
      ed.viewport.settings.gridBeyondLimits = (Math.round(v) & 1) === 1;
    },
    { integer: true, allowZero: true },
  );
  reg('VIEW', ['V', '-VIEW', 'DDVIEW'], 'Named views [?/Delete/Restore/Save/Window]', (ed, arg) => ed.startTool(viewTool(ed, arg)));
  reg('ZOOM', ['Z'], 'Zoom [All/Center/Extents/Previous/Scale/Window/OBject/In/Out]', (ed, arg) => ed.startTool(zoomTool(ed, arg)));
  reg('REGEN', ['RE', 'REGENALL', 'REA'], 'Regenerate the drawing', (ed) => {
    ed.log('Regenerating model.');
    ed.render();
  });

  // Selection
  reg('SELECT', [], 'Select objects [Window/Crossing/Fence/WPolygon/CPolygon/Previous/Last/ALL/Add/Remove/Undo]', (ed) => ed.startTool(selectTool()));
  reg('QSELECT', [], 'Quick select by type / layer / color', (ed, arg) => ed.startTool(qselectTool(arg)));

  // Layers / linetypes / lineweights
  const layerCommand = (ed: Editor, arg?: string) => {
    const parts = (arg ?? '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      ed.startTool(layerTool(ed));
      return;
    }
    const opt = matchKeyword(parts[0]!, LAYER_KWS);
    if (!opt) {
      ed.log(`Invalid option keyword: ${parts[0]}`);
      return;
    }
    ed.log(applyLayerOption(ed, opt, parts.slice(1)));
    ed.render();
  };
  reg('-LAYER', [], 'Layer options [?/Make/Set/New/ON/OFF/Color/Ltype/LWeight/Freeze/Thaw/LOck/Unlock]', layerCommand);
  const layerDialog = editor.commands.get('LAYER');
  reg('LAYER', ['LA', 'DDLMODES'], 'Layer Properties Manager (with options: LAYER ON|OFF|Freeze|Thaw|LOck|Unlock|Make|Set|New|Color|Ltype|LWeight <names>)', (ed, arg) => {
    if (arg && arg.trim()) layerCommand(ed, arg);
    else layerDialog?.run(ed, arg);
  });
  reg('LINETYPE', ['LT', 'LTYPE', '-LINETYPE', 'DDLTYPE'], 'Linetypes [?/Load/Set]', (ed, arg) => ed.startTool(linetypeTool(ed, arg)));
  reg('CELTYPE', [], 'Current entity linetype', (ed, arg) => ed.startTool(linetypeTool(ed, `Set${arg ? ` ${arg}` : ''}`)));
  reg('LWEIGHT', ['-LWEIGHT', 'LINEWEIGHT'], 'Default lineweight for new objects', (ed, arg) => ed.startTool(lweightTool(ed, arg)));
  reg('CELWEIGHT', [], 'Current entity lineweight', (ed, arg) => ed.startTool(lweightTool(ed, arg)));

  // Object snap settings and tracking
  reg('OSNAPSET', ['-OSNAP', 'OSMODE'], 'Set running object snap modes (END MID CEN NOD QUA INT INS PER TAN NEA NONE)', (ed, arg) => {
    if (arg) osnapSet(ed, arg);
    else ed.startTool(osnapTool(ed));
  });
  reg('OTRACK', ['F11'], 'Toggle object snap tracking', (ed, arg) => {
    ed.snap.otrack = arg ? /^(on|1)$/i.test(arg.trim()) : !ed.snap.otrack;
    ed.log(`<Otrack ${ed.snap.otrack ? 'on' : 'off'}>`);
    ed.render();
  });
  sysvar(reg, 'POLARANG', 'Polar tracking angle increment (degrees)', (ed) => ed.snap.polarIncrement, (ed, v) => {
    ed.snap.polarIncrement = v;
  });
  sysvar(
    reg,
    'POLARMODE',
    'Polar mode bits (2 = track along polar angles)',
    (ed) => (ed.snap.polarTracking ? 2 : 0),
    (ed, v) => {
      ed.snap.polarTracking = (Math.round(v) & 2) !== 0;
    },
    { integer: true, allowZero: true },
  );

  // Selection keywords during any "Select objects:" prompt, and the Previous set.
  editor.selectionKeyword = (t: string, ids: Set<string>) => selectionKeyword(t, editor, ids);
  editor.on('selection', () => {
    if (editor.selection.size > 0) selectionHistory.previous = [...editor.selection];
  });

  // View history for ZOOM Previous: remember the view before each burst of wheel/pan changes.
  let lastView = { center: editor.viewport.center, scale: editor.viewport.scale };
  let lastChange = 0;
  editor.on('view', () => {
    const vp = editor.viewport;
    if (Math.abs(vp.scale - lastView.scale) < 1e-12 && g.eq(vp.center, lastView.center, 1e-9)) return;
    const now = Date.now();
    if (!zoomState.suppressHistory && now - lastChange > 700) {
      const top = vp.viewHistory[vp.viewHistory.length - 1];
      if (!top || Math.abs(top.scale - lastView.scale) > 1e-12 || !g.eq(top.center, lastView.center, 1e-9)) {
        vp.viewHistory.push(lastView);
        if (vp.viewHistory.length > 20) vp.viewHistory.shift();
      }
    }
    lastView = { center: vp.center, scale: vp.scale };
    lastChange = now;
  });
}

export { dflt };
export type { ToolContext };
