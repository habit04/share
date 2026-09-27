/**
 * Minimal DXF (AC1015 / AutoCAD 2000) reader and writer.
 * Supports LINE, CIRCLE, ARC, LWPOLYLINE, TEXT, INSERT (+ ATTRIB), BLOCK, LAYER.
 */
import type { Entity, BlockDef, Layer, AttributeDef, ColorSpec } from '../core/entities';
import { newId } from '../core/entities';
import type { DrawingState } from '../core/document';
import { DEFAULT_LAYERS } from '../core/document';
import * as g from '../core/geometry';

// ---------------------------------------------------------------- writing

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const s = n.toFixed(10).replace(/\.?0+$/, '');
  return s === '-0' || s === '' ? '0' : s;
}

class Writer {
  private out: string[] = [];
  private handle = 0x100;
  pair(code: number, value: string | number): void {
    this.out.push(String(code), typeof value === 'number' ? fmt(value) : value);
  }
  nextHandle(): string {
    this.handle += 1;
    return this.handle.toString(16).toUpperCase();
  }
  toString(): string {
    return this.out.join('\r\n') + '\r\n';
  }
}

function colorCode(c: ColorSpec): number {
  return c === 'ByLayer' ? 256 : c;
}

function writeEntityCommon(w: Writer, e: Entity, owner: string, kind: string, subclass: string): void {
  w.pair(0, kind);
  w.pair(5, w.nextHandle());
  w.pair(330, owner);
  w.pair(100, 'AcDbEntity');
  w.pair(8, e.layer);
  if (e.color !== 'ByLayer') w.pair(62, colorCode(e.color));
  w.pair(100, subclass);
}

function writeEntity(w: Writer, e: Entity, owner: string, blocks: Readonly<Record<string, BlockDef>>): void {
  switch (e.type) {
    case 'line':
      writeEntityCommon(w, e, owner, 'LINE', 'AcDbLine');
      w.pair(10, e.a.x);
      w.pair(20, e.a.y);
      w.pair(30, 0);
      w.pair(11, e.b.x);
      w.pair(21, e.b.y);
      w.pair(31, 0);
      break;
    case 'circle':
      if (e.filled) {
        // Solid dot: a DONUT with zero inner radius = closed LWPOLYLINE of two bulge-1 vertices with constant width.
        writeEntityCommon(w, e, owner, 'LWPOLYLINE', 'AcDbPolyline');
        w.pair(90, 2);
        w.pair(70, 1);
        w.pair(43, e.radius);
        w.pair(10, e.center.x - e.radius / 2);
        w.pair(20, e.center.y);
        w.pair(42, 1);
        w.pair(10, e.center.x + e.radius / 2);
        w.pair(20, e.center.y);
        w.pair(42, 1);
        break;
      }
      writeEntityCommon(w, e, owner, 'CIRCLE', 'AcDbCircle');
      w.pair(10, e.center.x);
      w.pair(20, e.center.y);
      w.pair(30, 0);
      w.pair(40, e.radius);
      break;
    case 'arc':
      writeEntityCommon(w, e, owner, 'ARC', 'AcDbCircle');
      w.pair(10, e.center.x);
      w.pair(20, e.center.y);
      w.pair(30, 0);
      w.pair(40, e.radius);
      w.pair(100, 'AcDbArc');
      w.pair(50, g.deg(g.normAngle(e.startAngle)));
      w.pair(51, g.deg(g.normAngle(e.endAngle)));
      break;
    case 'polyline':
      writeEntityCommon(w, e, owner, 'LWPOLYLINE', 'AcDbPolyline');
      w.pair(90, e.points.length);
      w.pair(70, e.closed ? 1 : 0);
      for (const p of e.points) {
        w.pair(10, p.x);
        w.pair(20, p.y);
      }
      break;
    case 'text': {
      writeEntityCommon(w, e, owner, 'TEXT', 'AcDbText');
      w.pair(10, e.position.x);
      w.pair(20, e.position.y);
      w.pair(30, 0);
      w.pair(40, e.height);
      w.pair(1, e.text);
      if (e.rotation !== 0) w.pair(50, g.deg(e.rotation));
      const h = e.align === 'center' ? 1 : e.align === 'right' ? 2 : 0;
      if (h !== 0) {
        w.pair(72, h);
        w.pair(11, e.position.x);
        w.pair(21, e.position.y);
        w.pair(31, 0);
      }
      w.pair(100, 'AcDbText');
      break;
    }
    case 'insert': {
      const block = blocks[e.block];
      const hasAttribs = block ? block.attributes.length > 0 : false;
      writeEntityCommon(w, e, owner, 'INSERT', 'AcDbBlockReference');
      if (hasAttribs) w.pair(66, 1);
      w.pair(2, e.block);
      w.pair(10, e.position.x);
      w.pair(20, e.position.y);
      w.pair(30, 0);
      if (e.scale !== 1) {
        w.pair(41, e.scale);
        w.pair(42, e.scale);
        w.pair(43, e.scale);
      }
      if (e.rotation !== 0) w.pair(50, g.deg(e.rotation));
      if (hasAttribs && block) {
        for (const a of block.attributes) {
          const value = e.attributes[a.tag] ?? a.default;
          // Attribute position in world space
          const local = g.sub(a.position, block.basePoint);
          const world = g.add(e.position, g.rotate(g.scale(local, e.scale), e.rotation));
          w.pair(0, 'ATTRIB');
          w.pair(5, w.nextHandle());
          w.pair(330, owner);
          w.pair(100, 'AcDbEntity');
          w.pair(8, e.layer);
          w.pair(100, 'AcDbText');
          w.pair(10, world.x);
          w.pair(20, world.y);
          w.pair(30, 0);
          w.pair(40, a.height * e.scale);
          w.pair(1, value);
          if (e.rotation !== 0) w.pair(50, g.deg(e.rotation));
          const h = a.align === 'center' ? 1 : a.align === 'right' ? 2 : 0;
          if (h !== 0) {
            w.pair(72, h);
            w.pair(11, world.x);
            w.pair(21, world.y);
            w.pair(31, 0);
          }
          w.pair(100, 'AcDbAttribute');
          w.pair(2, a.tag);
          w.pair(70, a.invisible ? 1 : 0);
        }
        w.pair(0, 'SEQEND');
        w.pair(5, w.nextHandle());
        w.pair(330, owner);
        w.pair(100, 'AcDbEntity');
        w.pair(8, e.layer);
      }
      break;
    }
  }
}

export function writeDxf(state: DrawingState): string {
  const w = new Writer();
  const MODEL_SPACE = '1F';
  const PAPER_SPACE = '1B';
  const blockList = Object.values(state.blocks);
  // Pre-assign a BLOCK_RECORD handle per block; block entities use it as their owner (330).
  const blockRecordHandles = new Map<string, string>();
  for (const b of blockList) blockRecordHandles.set(b.name, w.nextHandle());

  // HEADER
  w.pair(0, 'SECTION');
  w.pair(2, 'HEADER');
  w.pair(9, '$ACADVER');
  w.pair(1, 'AC1015');
  w.pair(9, '$HANDSEED');
  w.pair(5, 'FFFF');
  w.pair(9, '$INSUNITS');
  w.pair(70, 1);
  w.pair(9, '$CLAYER');
  w.pair(8, state.currentLayer);
  w.pair(9, '$LTSCALE');
  w.pair(40, 1);
  w.pair(9, '$TEXTSTYLE');
  w.pair(7, 'Standard');
  w.pair(0, 'ENDSEC');

  // CLASSES (empty)
  w.pair(0, 'SECTION');
  w.pair(2, 'CLASSES');
  w.pair(0, 'ENDSEC');

  // TABLES
  w.pair(0, 'SECTION');
  w.pair(2, 'TABLES');

  const table = (name: string, handle: string, count: number, body: () => void) => {
    w.pair(0, 'TABLE');
    w.pair(2, name);
    w.pair(5, handle);
    w.pair(330, '0');
    w.pair(100, 'AcDbSymbolTable');
    w.pair(70, count);
    body();
    w.pair(0, 'ENDTAB');
  };
  const record = (kind: string, owner: string, subclass: string, name: string, flags = 0) => {
    w.pair(0, kind);
    w.pair(5, w.nextHandle());
    w.pair(330, owner);
    w.pair(100, 'AcDbSymbolTableRecord');
    w.pair(100, subclass);
    w.pair(2, name);
    w.pair(70, flags);
  };

  table('VPORT', '8', 1, () => {
    record('VPORT', '8', 'AcDbViewportTableRecord', '*Active');
    w.pair(10, 0);
    w.pair(20, 0);
    w.pair(11, 1);
    w.pair(21, 1);
    w.pair(12, 5);
    w.pair(22, 4);
    w.pair(40, 12);
    w.pair(41, 1.6);
    w.pair(72, 1000);
  });
  table('LTYPE', '5', 3, () => {
    for (const name of ['ByBlock', 'ByLayer', 'Continuous']) {
      record('LTYPE', '5', 'AcDbLinetypeTableRecord', name);
      w.pair(3, name === 'Continuous' ? 'Solid line' : '');
      w.pair(72, 65);
      w.pair(73, 0);
      w.pair(40, 0);
    }
  });
  table('LAYER', '2', state.layers.length, () => {
    for (const l of state.layers) {
      record('LAYER', '2', 'AcDbLayerTableRecord', l.name, l.locked ? 4 : 0);
      w.pair(62, l.visible ? l.color : -l.color);
      w.pair(6, 'Continuous');
      w.pair(370, Math.round(l.lineWeight * 100));
      w.pair(390, 'F');
    }
  });
  table('STYLE', '3', 1, () => {
    record('STYLE', '3', 'AcDbTextStyleTableRecord', 'Standard');
    w.pair(40, 0);
    w.pair(41, 1);
    w.pair(50, 0);
    w.pair(71, 0);
    w.pair(42, 0.2);
    w.pair(3, 'txt');
    w.pair(4, '');
  });
  table('VIEW', '6', 0, () => {});
  table('UCS', '7', 0, () => {});
  table('APPID', '9', 1, () => {
    record('APPID', '9', 'AcDbRegAppTableRecord', 'ACAD');
  });
  table('DIMSTYLE', 'A', 1, () => {
    w.pair(100, 'AcDbDimStyleTable');
    w.pair(0, 'DIMSTYLE');
    w.pair(105, w.nextHandle());
    w.pair(330, 'A');
    w.pair(100, 'AcDbSymbolTableRecord');
    w.pair(100, 'AcDbDimStyleTableRecord');
    w.pair(2, 'Standard');
    w.pair(70, 0);
  });
  table('BLOCK_RECORD', '1', 2 + blockList.length, () => {
    const brec = (handle: string, name: string) => {
      w.pair(0, 'BLOCK_RECORD');
      w.pair(5, handle);
      w.pair(330, '1');
      w.pair(100, 'AcDbSymbolTableRecord');
      w.pair(100, 'AcDbBlockTableRecord');
      w.pair(2, name);
      w.pair(70, 0);
      w.pair(280, 1);
      w.pair(281, 0);
    };
    brec(MODEL_SPACE, '*Model_Space');
    brec(PAPER_SPACE, '*Paper_Space');
    for (const b of blockList) brec(blockRecordHandles.get(b.name)!, b.name);
  });
  w.pair(0, 'ENDSEC');

  // BLOCKS
  w.pair(0, 'SECTION');
  w.pair(2, 'BLOCKS');
  const blockShell = (owner: string, name: string, base: { x: number; y: number }, body: () => void) => {
    w.pair(0, 'BLOCK');
    w.pair(5, w.nextHandle());
    w.pair(330, owner);
    w.pair(100, 'AcDbEntity');
    w.pair(8, '0');
    w.pair(100, 'AcDbBlockBegin');
    w.pair(2, name);
    w.pair(70, 0);
    w.pair(10, base.x);
    w.pair(20, base.y);
    w.pair(30, 0);
    w.pair(3, name);
    w.pair(1, '');
    body();
    w.pair(0, 'ENDBLK');
    w.pair(5, w.nextHandle());
    w.pair(330, owner);
    w.pair(100, 'AcDbEntity');
    w.pair(8, '0');
    w.pair(100, 'AcDbBlockEnd');
  };
  blockShell(MODEL_SPACE, '*Model_Space', { x: 0, y: 0 }, () => {});
  blockShell(PAPER_SPACE, '*Paper_Space', { x: 0, y: 0 }, () => {});
  for (const b of blockList) {
    const owner = blockRecordHandles.get(b.name)!;
    w.pair(0, 'BLOCK');
    w.pair(5, w.nextHandle());
    w.pair(330, owner);
    w.pair(100, 'AcDbEntity');
    w.pair(8, '0');
    w.pair(100, 'AcDbBlockBegin');
    w.pair(2, b.name);
    w.pair(70, b.attributes.length > 0 ? 2 : 0);
    w.pair(10, b.basePoint.x);
    w.pair(20, b.basePoint.y);
    w.pair(30, 0);
    w.pair(3, b.name);
    w.pair(1, '');
    if (b.description) w.pair(4, b.description);
    for (const e of b.entities) writeEntity(w, e, owner, state.blocks);
    for (const a of b.attributes) {
      w.pair(0, 'ATTDEF');
      w.pair(5, w.nextHandle());
      w.pair(330, owner);
      w.pair(100, 'AcDbEntity');
      w.pair(8, '0');
      w.pair(100, 'AcDbText');
      w.pair(10, a.position.x);
      w.pair(20, a.position.y);
      w.pair(30, 0);
      w.pair(40, a.height);
      w.pair(1, a.default);
      const h = a.align === 'center' ? 1 : a.align === 'right' ? 2 : 0;
      if (h !== 0) {
        w.pair(72, h);
        w.pair(11, a.position.x);
        w.pair(21, a.position.y);
        w.pair(31, 0);
      }
      w.pair(100, 'AcDbAttributeDefinition');
      w.pair(3, a.prompt);
      w.pair(2, a.tag);
      w.pair(70, a.invisible ? 1 : 0);
    }
    w.pair(0, 'ENDBLK');
    w.pair(5, w.nextHandle());
    w.pair(330, owner);
    w.pair(100, 'AcDbEntity');
    w.pair(8, '0');
    w.pair(100, 'AcDbBlockEnd');
  }
  w.pair(0, 'ENDSEC');

  // ENTITIES
  w.pair(0, 'SECTION');
  w.pair(2, 'ENTITIES');
  for (const e of state.entities) writeEntity(w, e, MODEL_SPACE, state.blocks);
  w.pair(0, 'ENDSEC');

  // OBJECTS: root dictionary with the mandatory ACAD_GROUP entry
  w.pair(0, 'SECTION');
  w.pair(2, 'OBJECTS');
  w.pair(0, 'DICTIONARY');
  w.pair(5, 'C');
  w.pair(330, '0');
  w.pair(100, 'AcDbDictionary');
  w.pair(281, 1);
  w.pair(3, 'ACAD_GROUP');
  w.pair(350, 'D');
  w.pair(0, 'DICTIONARY');
  w.pair(5, 'D');
  w.pair(330, 'C');
  w.pair(100, 'AcDbDictionary');
  w.pair(281, 1);
  w.pair(0, 'ENDSEC');
  w.pair(0, 'EOF');
  return w.toString();
}

// ---------------------------------------------------------------- reading

interface Pair {
  code: number;
  value: string;
}

function tokenize(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i]!.trim(), 10);
    if (Number.isNaN(code)) continue;
    pairs.push({ code, value: lines[i + 1]!.trim() });
  }
  return pairs;
}

interface Obj {
  kind: string;
  groups: Pair[];
}

/** Group pairs into objects starting at each code 0. */
function objects(pairs: Pair[], start: number, end: number): Obj[] {
  const out: Obj[] = [];
  let cur: Obj | null = null;
  for (let i = start; i < end; i += 1) {
    const p = pairs[i]!;
    if (p.code === 0) {
      cur = { kind: p.value, groups: [] };
      out.push(cur);
    } else if (cur) cur.groups.push(p);
  }
  return out;
}

const num = (o: Obj, code: number, dflt = 0): number => {
  const p = o.groups.find((x) => x.code === code);
  if (!p) return dflt;
  const v = parseFloat(p.value);
  return Number.isNaN(v) ? dflt : v;
};
const str = (o: Obj, code: number, dflt = ''): string => o.groups.find((x) => x.code === code)?.value ?? dflt;

function readEntityObj(o: Obj): Entity | null {
  const layer = str(o, 8, '0');
  const rawColor = o.groups.find((x) => x.code === 62);
  const color: ColorSpec = rawColor && parseInt(rawColor.value, 10) !== 256 ? parseInt(rawColor.value, 10) : 'ByLayer';
  const base = { id: newId(), layer, color };
  switch (o.kind) {
    case 'LINE':
      return { ...base, type: 'line', a: { x: num(o, 10), y: num(o, 20) }, b: { x: num(o, 11), y: num(o, 21) } };
    case 'CIRCLE':
      return { ...base, type: 'circle', center: { x: num(o, 10), y: num(o, 20) }, radius: num(o, 40) };
    case 'ARC':
      return {
        ...base,
        type: 'arc',
        center: { x: num(o, 10), y: num(o, 20) },
        radius: num(o, 40),
        startAngle: g.rad(num(o, 50)),
        endAngle: g.rad(num(o, 51)),
      };
    case 'LWPOLYLINE': {
      const pts: g.Point[] = [];
      const bulges: number[] = [];
      let x: number | null = null;
      for (const p of o.groups) {
        if (p.code === 10) x = parseFloat(p.value);
        else if (p.code === 20 && x !== null) {
          pts.push({ x, y: parseFloat(p.value) });
          bulges.push(0);
          x = null;
        } else if (p.code === 42 && bulges.length) bulges[bulges.length - 1] = parseFloat(p.value);
      }
      const closed = (num(o, 70) & 1) === 1;
      const width = num(o, 43, 0);
      // Zero-hole donut (two bulge-1 vertices, constant width = radius): read back as a filled dot.
      if (closed && pts.length === 2 && width > 0 && Math.abs((bulges[0] ?? 0) - 1) < 1e-6 && Math.abs((bulges[1] ?? 0) - 1) < 1e-6) {
        const c = g.mid(pts[0]!, pts[1]!);
        const r = g.dist(pts[0]!, pts[1]!) / 2 + width / 2;
        return { ...base, type: 'circle', center: c, radius: r, filled: true };
      }
      return { ...base, type: 'polyline', points: tessellateBulges(pts, bulges, closed), closed };
    }
    case 'POLYLINE':
      // Old-style POLYLINE with VERTEX children is handled by caller.
      return null;
    case 'TEXT': {
      const h = num(o, 72, 0);
      const v = num(o, 73, 0);
      const align: 'left' | 'center' | 'right' = h === 1 || h === 4 ? 'center' : h === 2 ? 'right' : 'left';
      // Alignment point (11/21) applies for any non-default justification; fit/aligned (3/5) keep the first point.
      const useAlignPt = (h !== 0 || v !== 0) && h !== 3 && h !== 5 && o.groups.some((x) => x.code === 11);
      let position = useAlignPt ? { x: num(o, 11), y: num(o, 21) } : { x: num(o, 10), y: num(o, 20) };
      const height = num(o, 40, 0.125);
      const rotation = g.rad(num(o, 50));
      // Vertical justification: shift down to the baseline (1 bottom, 2 middle, 3 top).
      const drop = v === 2 ? height / 2 : v === 3 ? height : 0;
      if (drop) position = { x: position.x + Math.sin(rotation) * drop, y: position.y - Math.cos(rotation) * drop };
      return { ...base, type: 'text', position, text: str(o, 1), height, rotation, align };
    }
    case 'MTEXT': {
      // MTEXT: 10/20 attachment corner, 71 attachment point (1..9), 11/21 direction vector, 50 rotation (radians)
      const ap = Math.trunc(num(o, 71, 1));
      const col = (ap - 1) % 3;
      const row = Math.floor((ap - 1) / 3);
      const align: 'left' | 'center' | 'right' = col === 1 ? 'center' : col === 2 ? 'right' : 'left';
      const hasDir = o.groups.some((x) => x.code === 11);
      const rotation = hasDir ? Math.atan2(num(o, 21), num(o, 11)) : num(o, 50);
      const height = num(o, 40, 0.125);
      const drop = row === 0 ? height : row === 1 ? height / 2 : 0;
      const corner = { x: num(o, 10), y: num(o, 20) };
      const position = { x: corner.x + Math.sin(rotation) * drop, y: corner.y - Math.cos(rotation) * drop };
      const text = o.groups
        .filter((x) => x.code === 1 || x.code === 3)
        .map((x) => x.value)
        .join('')
        .replace(/\\P/g, ' ')
        .replace(/\{\\[^;]*;([^}]*)\}/g, '$1')
        .replace(/\\[A-Za-z][^;]*;/g, '')
        .replace(/[{}]/g, '');
      return { ...base, type: 'text', position, text, height, rotation, align };
    }
    case 'INSERT': {
      const sx = num(o, 41, 1);
      const sy = num(o, 42, sx);
      // Mirrored (negative) and non-uniform scales are not represented; keep the magnitude of X.
      return {
        ...base,
        type: 'insert',
        block: str(o, 2),
        position: { x: num(o, 10), y: num(o, 20) },
        scale: Math.abs(sx) || 1,
        rotation: g.rad(num(o, 50)) + (sx < 0 !== sy < 0 ? 0 : 0),
        attributes: {},
      };
    }
    default:
      return null;
  }
}

/** Expand bulge (arc) segments of a polyline into straight segments. */
function tessellateBulges(pts: g.Point[], bulges: number[], closed: boolean): g.Point[] {
  if (!bulges.some((b) => Math.abs(b) > 1e-9)) return pts;
  const out: g.Point[] = [];
  const n = pts.length;
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i += 1) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const bulge = bulges[i] ?? 0;
    out.push(a);
    if (Math.abs(bulge) < 1e-9) continue;
    const theta = 4 * Math.atan(bulge);
    const chord = g.dist(a, b);
    if (chord < 1e-12) continue;
    const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
    const m = g.mid(a, b);
    const d = Math.sqrt(Math.max(0, r * r - (chord / 2) * (chord / 2)));
    const nrm = { x: -(b.y - a.y) / chord, y: (b.x - a.x) / chord };
    const side = Math.abs(theta) <= Math.PI ? Math.sign(theta) : -Math.sign(theta);
    const c = { x: m.x + nrm.x * d * side, y: m.y + nrm.y * d * side };
    const a0 = g.angleOf(c, a);
    const steps = Math.max(2, Math.ceil(Math.abs(theta) / (Math.PI / 12)));
    for (let k = 1; k < steps; k += 1) out.push(g.polar(c, a0 + (theta * k) / steps, r));
  }
  if (!closed) out.push(pts[n - 1]!);
  return out;
}

/** Parse a list of entity objects, folding ATTRIB/SEQEND into inserts and VERTEX into polylines. */
function readEntities(objs: Obj[]): Entity[] {
  const out: Entity[] = [];
  let i = 0;
  while (i < objs.length) {
    const o = objs[i]!;
    if (o.kind === 'POLYLINE') {
      const pts: g.Point[] = [];
      const closed = (num(o, 70) & 1) === 1;
      let j = i + 1;
      while (j < objs.length && objs[j]!.kind === 'VERTEX') {
        pts.push({ x: num(objs[j]!, 10), y: num(objs[j]!, 20) });
        j += 1;
      }
      if (j < objs.length && objs[j]!.kind === 'SEQEND') j += 1;
      const rawColor = o.groups.find((x) => x.code === 62);
      out.push({
        id: newId(),
        type: 'polyline',
        layer: str(o, 8, '0'),
        color: rawColor && parseInt(rawColor.value, 10) !== 256 ? parseInt(rawColor.value, 10) : 'ByLayer',
        points: pts,
        closed,
      });
      i = j;
      continue;
    }
    const e = readEntityObj(o);
    if (e && e.type === 'insert') {
      const attrs: Record<string, string> = {};
      let j = i + 1;
      while (j < objs.length && objs[j]!.kind === 'ATTRIB') {
        attrs[str(objs[j]!, 2)] = str(objs[j]!, 1);
        j += 1;
      }
      if (j < objs.length && objs[j]!.kind === 'SEQEND') j += 1;
      out.push({ ...e, attributes: attrs });
      i = j;
      continue;
    }
    if (e) out.push(e);
    i += 1;
  }
  return out;
}

export function readDxf(text: string): DrawingState {
  const pairs = tokenize(text);
  const layers: Layer[] = [];
  const blocks: Record<string, BlockDef> = {};
  let entities: Entity[] = [];
  let currentLayer = '0';

  // find sections
  let i = 0;
  while (i < pairs.length) {
    const p = pairs[i]!;
    if (p.code === 0 && p.value === 'SECTION') {
      const name = pairs[i + 1]?.value ?? '';
      let j = i + 2;
      while (j < pairs.length && !(pairs[j]!.code === 0 && pairs[j]!.value === 'ENDSEC')) j += 1;
      const objs = objects(pairs, i + 2, j);
      if (name === 'HEADER') {
        for (let k = i + 2; k < j; k += 1) {
          if (pairs[k]!.code === 9 && pairs[k]!.value === '$CLAYER') currentLayer = pairs[k + 1]?.value ?? '0';
        }
      } else if (name === 'TABLES') {
        for (const o of objs) {
          if (o.kind !== 'LAYER') continue;
          const name2 = str(o, 2);
          if (!name2) continue;
          const c = Math.trunc(num(o, 62, 7));
          const flags = Math.trunc(num(o, 70));
          layers.push({
            name: name2,
            color: Math.abs(c) || 7,
            visible: c >= 0 && (flags & 1) === 0, // negative colour = off, flag 1 = frozen
            locked: (flags & 4) === 4,
            lineWeight: num(o, 370, 25) / 100,
          });
        }
      } else if (name === 'BLOCKS') {
        let k = 0;
        while (k < objs.length) {
          const o = objs[k]!;
          if (o.kind !== 'BLOCK') {
            k += 1;
            continue;
          }
          let m = k + 1;
          while (m < objs.length && objs[m]!.kind !== 'ENDBLK') m += 1;
          const inner = objs.slice(k + 1, m);
          const attributes: AttributeDef[] = inner
            .filter((x) => x.kind === 'ATTDEF')
            .map((x) => {
              const h = num(x, 72, 0);
              const align: 'left' | 'center' | 'right' = h === 1 || h === 4 ? 'center' : h === 2 ? 'right' : 'left';
              const useAlignPt = h !== 0 && x.groups.some((y) => y.code === 11);
              return {
                tag: str(x, 2),
                prompt: str(x, 3),
                default: str(x, 1),
                position: useAlignPt ? { x: num(x, 11), y: num(x, 21) } : { x: num(x, 10), y: num(x, 20) },
                height: num(x, 40, 0.125),
                align,
                invisible: (Math.trunc(num(x, 70)) & 1) === 1,
              };
            });
          const bname = str(o, 2);
          const anonymousLayout = /^\*(MODEL_SPACE|PAPER_SPACE)/i.test(bname);
          if (bname && !anonymousLayout) {
            blocks[bname] = {
              name: bname,
              basePoint: { x: num(o, 10), y: num(o, 20) },
              entities: readEntities(inner.filter((x) => x.kind !== 'ATTDEF')),
              attributes,
              description: str(o, 4) || undefined,
            };
          }
          k = m + 1;
        }
      } else if (name === 'ENTITIES') {
        entities = readEntities(objs);
      }
      i = j + 1;
    } else i += 1;
  }

  const layerNames = new Set(layers.map((l) => l.name));
  // Ensure every referenced layer exists.
  const ensure = (name: string) => {
    if (!layerNames.has(name)) {
      layerNames.add(name);
      const dflt = DEFAULT_LAYERS.find((l) => l.name === name);
      layers.push(dflt ?? { name, color: 7, visible: true, locked: false, lineWeight: 0.25 });
    }
  };
  ensure('0');
  for (const e of entities) ensure(e.layer);
  for (const b of Object.values(blocks)) for (const e of b.entities) ensure(e.layer);
  ensure(currentLayer);

  return { entities, layers, blocks, currentLayer };
}
