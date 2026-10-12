/**
 * DXF reading, shared by the entity codecs and the section readers: the read context (dimension
 * styles, blocks read so far, field values, IMAGE entities waiting for their IMAGEDEF, the import
 * report), the properties every entity starts with and the report entry for one record.
 */
import type { Obj } from './groups';
import type { ColorSpec, DimStyle, BlockDef } from '../../core/entities';
import { str, has, num } from './groups';
import { newId } from '../../core/entities';
import type { FieldContext } from '../../core/fields';
import type { TableStyleData } from './read-annotations';
import { ImportReportBuilder } from '../import-report';
import { transparencyFromDxf, validColorName } from '../../core/appearance';
import type { EntityBase } from '../../core/entities';
import type { RawDxfEntity } from '../import-report';

/** Entity properties common to every DXF entity (layer, colour, linetype, lineweight, ltscale). */
/** Separate class-level appearance from MTEXT/ATTRIB background color groups. */
export function commonAppearanceObject(o: Obj): Obj {
  const start = o.groups.findIndex((p) => p.code === 100 && p.value === 'AcDbEntity');
  if (start < 0) return o;
  const end = o.groups.findIndex((p, i) => i > start && (p.code === 100 || p.code === 1001));
  return { ...o, groups: o.groups.slice(start + 1, end < 0 ? undefined : end) };
}

export function commonProps(o: Obj): EntityBase {
  const common = commonAppearanceObject(o);
  const layer = str(o, 8, '0');
  const rawColor = o.groups.find((x) => x.code === 62);
  const color: ColorSpec = rawColor && Number(rawColor.value) !== 256 ? Number(rawColor.value) : 'ByLayer';
  const base: { id: string; layer: string; color: ColorSpec; linetype?: string; lineWeight?: number; ltscale?: number } = { id: newId(), layer, color };
  const lt = str(o, 6);
  if (lt && lt.toUpperCase() !== 'BYLAYER') base.linetype = lt;
  if (has(o, 370)) {
    const lw = Math.trunc(num(o, 370));
    if (lw >= 0) base.lineWeight = lw / 100;
    else if (lw === -2) base.lineWeight = -2;
  }
  if (has(o, 48) && num(o, 48) !== 1) base.ltscale = num(o, 48);
  const colorObject = o.kind === 'MTEXT' ? common : o;
  if (has(colorObject, 420)) (base as { trueColor?: number }).trueColor = Math.trunc(num(colorObject, 420)) & 0xffffff;
  const transparency = has(common, 440) ? transparencyFromDxf(Number(str(common, 440))) : undefined;
  const name = str(common, 430);
  return { ...base, ...(transparency !== undefined ? { transparency } : {}), ...(validColorName(name) ? { colorName: name } : {}) };
}

export interface ReadContext {
  dimStyles: Map<string, DimStyle>;
  dimStyle: DimStyle;
  /** Block definitions read so far (BLOCKS precedes ENTITIES), for per-insert attribute visibility. */
  blocks?: Record<string, BlockDef>;
  /** Values for field expressions in TEXT / MTEXT. */
  fields?: FieldContext;
  /**
   * IMAGE entities waiting for their IMAGEDEF (OBJECTS comes last): entity id -> IMAGEDEF handle.
   * By id, because placing an entity (extrusion) may copy it.
   */
  pendingImages?: Map<string, string>;
  /** STYLE record names by upper-case handle (DIMTXSTY overrides name a style by handle). */
  textStyleHandles?: Map<string, string>;
  /** TABLESTYLE objects by upper-case handle (OBJECTS comes last; ACAD_TABLE group 342 names one). */
  tableStyles?: Map<string, TableStyleData>;
  /** Anonymous blocks replaced by native tables. */
  consumedBlocks?: Set<string>;
  /** Remarks about content that was simplified. */
  notes?: string[];
  /** Import report: dropped / simplified / kept objects. */
  report?: ImportReportBuilder;
  /** Unknown model-space records kept as raw group codes. */
  raw?: RawDxfEntity[];
  /** Where the objects being read are (report text). */
  where?: string;
}

export function reportObj(ctx: ReadContext, o: Obj, action: 'dropped' | 'simplified' | 'kept', reason: string): void {
  if (!ctx.report) return;
  const handle = str(o, 5);
  ctx.report.add({ type: o.kind, action, reason, ...(handle ? { handle } : {}), layer: str(o, 8, '0'), ...(o.line ? { line: o.line } : {}), ...(ctx.where ? { where: ctx.where } : {}) });
}
