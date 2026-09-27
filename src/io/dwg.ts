/**
 * DWG import. The binary parsing is done by LibreDWG (GPL-3.0) compiled to
 * WebAssembly (@mlightcad/libredwg-web). That runs in the Electron main
 * process (or Node CLI / tests); this module converts the resulting
 * DwgDatabase JSON into our DrawingState. Only types are imported here so the
 * renderer bundle never includes the WASM.
 */
import type {
  DwgDatabase,
  DwgEntity,
  DwgLineEntity,
  DwgCircleEntity,
  DwgArcEntity,
  DwgLWPolylineEntity,
  DwgPolyline2dEntity,
  DwgTextEntity,
  DwgMTextEntity,
  DwgInsertEntity,
  DwgAttdefEntity,
  DwgBlockRecordTableEntry,
} from '@mlightcad/libredwg-web';
import type { Entity, BlockDef, Layer, AttributeDef, ColorSpec } from '../core/entities';
import { newId } from '../core/entities';
import type { DrawingState } from '../core/document';
import { DEFAULT_LAYERS } from '../core/document';
import type { Point } from '../core/geometry';

/** Subset of DwgDatabase we actually need (what the main process sends over IPC). */
export interface DwgImportPayload {
  header: { CLAYER?: unknown; INSUNITS?: unknown } & Record<string, unknown>;
  entities: DwgEntity[];
  layers: Array<{ name: string; colorIndex: number; off: boolean; frozen: boolean; locked: boolean; lineweight: number }>;
  blocks: Array<Pick<DwgBlockRecordTableEntry, 'name' | 'basePoint' | 'entities' | 'description'>>;
  version?: string;
}

/** Trim a full DwgDatabase down to the payload (drops thumbnails, dictionaries, classes). */
export function toImportPayload(db: DwgDatabase, version?: string): DwgImportPayload {
  return {
    header: (db.header ?? {}) as DwgImportPayload['header'],
    entities: db.entities ?? [],
    layers: (db.tables?.LAYER?.entries ?? []).map((l) => ({
      name: l.name,
      colorIndex: l.colorIndex,
      off: l.off,
      frozen: l.frozen,
      locked: l.locked,
      lineweight: l.lineweight,
    })),
    blocks: (db.tables?.BLOCK_RECORD?.entries ?? []).map((b) => ({
      name: b.name,
      basePoint: b.basePoint,
      entities: b.entities ?? [],
      description: b.description,
    })),
    version,
  };
}

const p2 = (p: { x: number; y: number } | undefined): Point => ({ x: p?.x ?? 0, y: p?.y ?? 0 });

function color(e: DwgEntity): ColorSpec {
  const c = e.colorIndex;
  if (c === undefined || c === 256 || c === 0) return 'ByLayer';
  return c;
}

/** Tessellate an LWPOLYLINE / POLYLINE2D segment with a bulge into points (excluding the start point). */
function bulgePoints(a: Point, b: Point, bulge: number): Point[] {
  if (!bulge || Math.abs(bulge) < 1e-9) return [b];
  const theta = 4 * Math.atan(bulge); // included angle, signed
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  if (chord < 1e-12) return [b];
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const d = Math.sqrt(Math.max(0, r * r - (chord / 2) * (chord / 2)));
  const nx = -(b.y - a.y) / chord;
  const ny = (b.x - a.x) / chord;
  const sign = theta > 0 ? 1 : -1;
  // centre lies to the left of chord for CCW (positive bulge) when |theta| < π
  const side = Math.abs(theta) <= Math.PI ? sign : -sign;
  const cx = mx + nx * d * side;
  const cy = my + ny * d * side;
  const a0 = Math.atan2(a.y - cy, a.x - cx);
  const n = Math.max(2, Math.ceil(Math.abs(theta) / (Math.PI / 12)));
  const out: Point[] = [];
  for (let i = 1; i <= n; i += 1) {
    const t = a0 + (theta * i) / n;
    out.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
  }
  out[out.length - 1] = b;
  return out;
}

function halign(h: number | undefined): 'left' | 'center' | 'right' {
  if (h === 1 || h === 4) return 'center';
  if (h === 2) return 'right';
  return 'left';
}

function cleanMText(s: string): string {
  return s
    .replace(/\\P/g, ' ')
    .replace(/\{\\[^;]*;([^}]*)\}/g, '$1')
    .replace(/\\[A-Za-z][^;]*;/g, '')
    .replace(/[{}]/g, '');
}

function convertEntity(e: DwgEntity, blockIndex: Map<string, string>): Entity | null {
  const base = { id: newId(), layer: e.layer || '0', color: color(e) };
  switch (e.type) {
    case 'LINE': {
      const l = e as DwgLineEntity;
      return { ...base, type: 'line', a: p2(l.startPoint), b: p2(l.endPoint) };
    }
    case 'CIRCLE': {
      const c = e as DwgCircleEntity;
      return { ...base, type: 'circle', center: p2(c.center), radius: c.radius };
    }
    case 'ARC': {
      const a = e as DwgArcEntity;
      return { ...base, type: 'arc', center: p2(a.center), radius: a.radius, startAngle: a.startAngle, endAngle: a.endAngle };
    }
    case 'LWPOLYLINE': {
      const pl = e as DwgLWPolylineEntity;
      const verts = pl.vertices ?? [];
      if (verts.length === 0) return null;
      const closed = (pl.flag & 1) === 1;
      const cw = pl.constantWidth ?? 0;
      if (closed && verts.length === 2 && cw > 0 && Math.abs(verts[0]!.bulge - 1) < 1e-6 && Math.abs(verts[1]!.bulge - 1) < 1e-6) {
        const a = p2(verts[0]);
        const b = p2(verts[1]);
        return { ...base, type: 'circle', center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, radius: Math.hypot(b.x - a.x, b.y - a.y) / 2 + cw / 2, filled: true };
      }
      const pts: Point[] = [p2(verts[0])];
      for (let i = 0; i < verts.length - 1; i += 1) pts.push(...bulgePoints(p2(verts[i]), p2(verts[i + 1]), verts[i]!.bulge));
      if (closed && verts.length > 1 && verts[verts.length - 1]!.bulge) {
        const arc = bulgePoints(p2(verts[verts.length - 1]), p2(verts[0]), verts[verts.length - 1]!.bulge);
        pts.push(...arc.slice(0, -1));
      }
      return { ...base, type: 'polyline', points: pts, closed };
    }
    case 'POLYLINE2D': {
      const pl = e as DwgPolyline2dEntity;
      const verts = pl.vertices ?? [];
      if (verts.length === 0) return null;
      const closed = (pl.flag & 1) === 1;
      const pts: Point[] = [p2(verts[0])];
      for (let i = 0; i < verts.length - 1; i += 1) pts.push(...bulgePoints(p2(verts[i]), p2(verts[i + 1]), verts[i]!.bulge));
      return { ...base, type: 'polyline', points: pts, closed };
    }
    case 'TEXT': {
      const t = e as DwgTextEntity;
      const align = halign(t.halign);
      const useEnd = t.halign !== 0 && t.endPoint && (t.endPoint.x !== 0 || t.endPoint.y !== 0);
      return {
        ...base,
        type: 'text',
        position: useEnd ? p2(t.endPoint) : p2(t.startPoint),
        text: t.text ?? '',
        height: t.textHeight || 0.125,
        rotation: t.rotation ?? 0,
        align,
      };
    }
    case 'MTEXT': {
      const m = e as DwgMTextEntity;
      const h = m.textHeight || 0.125;
      const ap = m.attachmentPoint ?? 1; // 1..9: TL TC TR ML MC MR BL BC BR
      const col = (ap - 1) % 3;
      const row = Math.floor((ap - 1) / 3);
      const align: 'left' | 'center' | 'right' = col === 0 ? 'left' : col === 1 ? 'center' : 'right';
      // Move insertion point to baseline of the first line for top/middle attachment.
      const rot = m.rotation ?? (m.direction ? Math.atan2(m.direction.y, m.direction.x) : 0);
      const drop = row === 0 ? h : row === 1 ? h / 2 : 0;
      const ins = p2(m.insertionPoint);
      const position = { x: ins.x + Math.sin(rot) * drop, y: ins.y - Math.cos(rot) * drop };
      return { ...base, type: 'text', position, text: cleanMText(m.text ?? ''), height: h, rotation: rot, align };
    }
    case 'INSERT': {
      const i = e as DwgInsertEntity;
      const attrs: Record<string, string> = {};
      for (const a of i.attribs ?? []) attrs[a.tag || a.attrTag] = a.text?.text ?? '';
      const name = blockIndex.get((i.name ?? '').toUpperCase()) ?? i.name;
      return {
        ...base,
        type: 'insert',
        block: name,
        position: p2(i.insertionPoint),
        rotation: i.rotation ?? 0,
        scale: i.xScale || 1,
        attributes: attrs,
      };
    }
    default:
      return null;
  }
}

function convertAttdef(a: DwgAttdefEntity): AttributeDef {
  const t = a.text;
  const useAlign = t?.halign !== 0 && a.alignmentPoint && (a.alignmentPoint.x !== 0 || a.alignmentPoint.y !== 0);
  return {
    tag: a.tag || a.attrTag || 'ATTR',
    prompt: a.prompt ?? '',
    default: t?.text ?? '',
    position: useAlign ? p2(a.alignmentPoint) : p2(t?.startPoint),
    height: t?.textHeight || 0.125,
    align: halign(t?.halign),
    invisible: ((a.flags ?? 0) & 1) === 1,
  };
}

export interface DwgImportResult {
  state: DrawingState;
  skipped: Record<string, number>;
}

/** Convert a LibreDWG database payload into a DrawingState. */
export function convertDwg(payload: DwgImportPayload): DwgImportResult {
  const skipped: Record<string, number> = {};
  const blockIndex = new Map<string, string>();
  for (const b of payload.blocks) if (b.name && !b.name.startsWith('*')) blockIndex.set(b.name.toUpperCase(), b.name);

  const blocks: Record<string, BlockDef> = {};
  for (const b of payload.blocks) {
    if (!b.name || b.name.startsWith('*')) continue;
    const entities: Entity[] = [];
    const attributes: AttributeDef[] = [];
    for (const e of b.entities) {
      if (e.type === 'ATTDEF') {
        attributes.push(convertAttdef(e as DwgAttdefEntity));
        continue;
      }
      const c = convertEntity(e, blockIndex);
      if (c) entities.push(c);
      else skipped[e.type] = (skipped[e.type] ?? 0) + 1;
    }
    blocks[b.name] = { name: b.name, basePoint: p2(b.basePoint), entities, attributes, description: b.description || undefined };
  }

  const entities: Entity[] = [];
  for (const e of payload.entities) {
    if (e.isInPaperSpace) continue;
    if (e.type === 'ATTDEF' || e.type === 'VIEWPORT') continue;
    const c = convertEntity(e, blockIndex);
    if (c) entities.push(c);
    else skipped[e.type] = (skipped[e.type] ?? 0) + 1;
  }

  const layers: Layer[] = payload.layers
    .filter((l) => l.name)
    .map((l) => ({
      name: l.name,
      color: Math.abs(l.colorIndex) || 7,
      visible: !l.off && !l.frozen,
      locked: !!l.locked,
      lineWeight: l.lineweight > 0 && l.lineweight < 200 ? l.lineweight / 100 : 0.25,
    }));
  const names = new Set(layers.map((l) => l.name));
  const ensure = (n: string) => {
    if (!names.has(n)) {
      names.add(n);
      layers.push(DEFAULT_LAYERS.find((d) => d.name === n) ?? { name: n, color: 7, visible: true, locked: false, lineWeight: 0.25 });
    }
  };
  ensure('0');
  for (const e of entities) ensure(e.layer);
  for (const b of Object.values(blocks)) for (const e of b.entities) ensure(e.layer);

  const rawClayer = typeof payload.header.CLAYER === 'string' ? payload.header.CLAYER : '0';
  const currentLayer =
    layers.find((l) => l.name === rawClayer)?.name ??
    layers.find((l) => l.name.toUpperCase().replace(/\s+/g, '_') === rawClayer.toUpperCase().replace(/\s+/g, '_'))?.name ??
    '0';

  return { state: { entities, layers, blocks, currentLayer }, skipped };
}
