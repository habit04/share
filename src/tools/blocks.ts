/**
 * Block commands: BLOCK (define from a selection), INSERT (user blocks with
 * scale / rotation / attribute prompts) and PURGE helpers.
 */
import type { Point } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity, BlockDef, InsertEntity } from '../core/entities';
import { newId } from '../core/entities';
import type { DrawingState } from '../core/document';
import type { Tool, ToolContext } from './types';
import { scriptTool, point, pointOrKeyword, text, number, keyword, select, dflt } from './script';

export const blockDefaults = { lastInserted: '' };

/** Valid AutoCAD block name: no control characters or <>/\":;?*|,=` */
export function validBlockName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !/[<>/\\":;?*|,=`]/.test(name) && !name.startsWith('*');
}

/** Block names referenced by inserts anywhere (drawing + nested in other blocks). */
export function referencedBlocks(state: DrawingState): Set<string> {
  const used = new Set<string>();
  const visit = (list: readonly Entity[]) => {
    for (const e of list) {
      if (e.type !== 'insert' || used.has(e.block)) continue;
      used.add(e.block);
      const b = state.blocks[e.block];
      if (b) visit(b.entities);
    }
  };
  visit(state.entities);
  return used;
}

/** Layers no entity, block entity or attribute uses (never '0' or the current layer). */
export function unusedLayers(state: DrawingState): string[] {
  const used = new Set<string>(['0', state.currentLayer]);
  for (const e of state.entities) used.add(e.layer);
  for (const b of Object.values(state.blocks)) for (const e of b.entities) used.add(e.layer);
  return state.layers.map((l) => l.name).filter((n) => !used.has(n));
}

/** Linetypes loaded in the header that nothing references. */
export function unusedLinetypes(state: DrawingState): string[] {
  const used = new Set<string>();
  for (const l of state.layers) if (l.linetype) used.add(l.linetype.toUpperCase());
  const scan = (list: readonly Entity[]) => {
    for (const e of list) if (e.linetype) used.add(e.linetype.toUpperCase());
  };
  scan(state.entities);
  for (const b of Object.values(state.blocks)) scan(b.entities);
  return (state.header?.linetypes ?? []).map((l) => l.name).filter((n) => !used.has(n.toUpperCase()));
}

export function blockTool(): Tool {
  return scriptTool('BLOCK', function* (ctx) {
    let name = '';
    for (;;) {
      const t = yield* text('Enter block name or [?]:', null, true);
      if (t === null) return;
      const n = t.trim();
      if (n === '?') {
        const names = Object.keys(ctx.doc.blocks).filter((b) => !b.startsWith('*')).sort();
        ctx.log(`Defined blocks (${names.length}): ${names.join(', ')}`);
        continue;
      }
      if (!validBlockName(n)) {
        ctx.log('Invalid block name.');
        continue;
      }
      if (ctx.doc.blocks[n]) {
        const yn = yield* keyword(ctx, `Block "${n}" already exists. Redefine it? [Yes/No] <N>:`, ['Yes', 'No'], 'No');
        if (yn !== 'YES') continue;
      }
      name = n;
      break;
    }
    const basePoint = yield* point(ctx, 'Specify insertion base point:');
    if (!basePoint) return;
    const ids = yield* select(ctx, 'Select objects:', false);
    if (ids.length === 0) {
      ctx.log('0 found; block not created.');
      return;
    }
    const set = new Set(ids);
    const ents = ctx.doc.entities.filter((e) => set.has(e.id));
    const def: BlockDef = { name, basePoint, entities: ents.map((e) => ({ ...e, id: newId() })), attributes: [] };
    const insert: InsertEntity = { id: newId(), layer: ctx.doc.currentLayer, color: 'ByLayer', type: 'insert', block: name, position: basePoint, rotation: 0, scale: 1, attributes: {} };
    // Define the block and convert the selected objects to a reference of it in one undo step.
    ctx.doc.transact((s) => ({
      ...s,
      blocks: { ...s.blocks, [name]: def },
      entities: [...s.entities.filter((e) => !set.has(e.id)), insert],
    }));
    ctx.selection = new Set();
    blockDefaults.lastInserted = name;
    ctx.log(`Block "${name}" defined with ${ents.length} object(s).`);
  });
}

export function insertTool(arg?: string): Tool {
  return scriptTool('INSERT', function* (ctx) {
    let name = arg?.trim() ?? '';
    while (!ctx.doc.blocks[name]) {
      const d = blockDefaults.lastInserted;
      const t = yield* text(`Enter block name or [?]${d ? ` <${d}>` : ''}:`, d || null, true);
      if (t === null) return;
      const n = t.trim();
      if (n === '?') {
        const names = Object.keys(ctx.doc.blocks).filter((b) => !b.startsWith('*')).sort();
        ctx.log(`Defined blocks (${names.length}): ${names.join(', ')}`);
        continue;
      }
      // AutoCAD resolves case-insensitively.
      const found = Object.keys(ctx.doc.blocks).find((b) => b.toUpperCase() === n.toUpperCase());
      if (!found) {
        ctx.log(`Block "${n}" not found.`);
        continue;
      }
      name = found;
    }
    const block = ctx.doc.blocks[name]!;
    let scale = 1;
    let rotation = 0;
    const make = (pos: Point, attrs: Record<string, string> = {}): InsertEntity => ({
      id: newId(),
      layer: ctx.doc.currentLayer,
      color: 'ByLayer',
      type: 'insert',
      block: name,
      position: pos,
      rotation,
      scale,
      attributes: attrs,
    });
    let position: Point | null = null;
    while (!position) {
      const r = yield* pointOrKeyword('Specify insertion point or [Scale/Rotate]:', ['Scale', 'Rotate'], { ghost: (c) => [make(c)], trackFrom: null });
      if (!r) return;
      if ('point' in r) position = r.point;
      else if ('keyword' in r && r.keyword === 'SCALE') {
        const s = yield* number(ctx, `Specify scale factor for XYZ axes ${dflt(scale)}:`, scale, { from: null });
        if (s && 'value' in s) scale = s.value;
      } else if ('keyword' in r) {
        const a = yield* number(ctx, `Specify rotation angle <${g.deg(rotation).toFixed(0)}>:`, g.deg(rotation), { allowZero: true, allowNegative: true, from: null });
        if (a && 'value' in a) rotation = g.rad(a.value);
      } else ctx.log(`Invalid option keyword: ${r.text}`);
    }
    const pos = position;
    const sx = yield* number(ctx, `Enter X scale factor, specify opposite corner, or [Corner/XYZ] ${dflt(scale)}:`, scale, { from: pos, keywords: ['Corner', 'XYZ'] });
    if (sx && 'value' in sx) scale = sx.value;
    else if (sx && 'keyword' in sx) ctx.log('Only uniform scaling is supported.');
    const sy = yield* number(ctx, 'Enter Y scale factor <use X scale factor>:', scale, { from: null });
    if (sy && 'value' in sy && Math.abs(sy.value - scale) > 1e-9) ctx.log('Non-uniform scaling is not supported; using the X scale factor.');
    const rot = yield { prompt: `Specify rotation angle <${g.deg(rotation).toFixed(0)}>:`, distance: false, trackFrom: pos, ghost: (c: Point) => [make(c === pos ? pos : pos)] };
    if (rot.type === 'point') rotation = g.angleOf(pos, rot.p);
    else if (rot.type === 'text') {
      const v = parseFloat(rot.text);
      if (Number.isFinite(v)) rotation = g.rad(v);
      else ctx.log('Requires a valid angle; using the default.');
    }
    const attrs: Record<string, string> = {};
    if (block.attributes.length) ctx.log('Enter attribute values');
    for (const a of block.attributes) {
      const v = yield* text(`${a.prompt || a.tag}${a.default ? ` <${a.default}>` : ''}:`, a.default, true);
      if (v === null) return;
      attrs[a.tag] = v;
    }
    ctx.doc.addEntities([make(pos, attrs)]);
    blockDefaults.lastInserted = name;
  });
}
