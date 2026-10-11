/**
 * DXF reading, shared by the entity codecs and the section readers: the read context (dimension
 * styles, blocks read so far, field values, IMAGE entities waiting for their IMAGEDEF, the import
 * report), the properties every entity starts with and the report entry for one record.
 */
import { newId, type BlockDef, type ColorSpec, type DimStyle, type ImageEntity } from '../../core/entities';
import type { FieldContext } from '../../core/fields';
import type { ImportReportBuilder, RawDxfEntity } from '../import-report';
import { num, has, str, type Obj } from './groups';
import type { TableStyleData } from './read-annotations';

/** Entity properties common to every DXF entity (layer, colour, linetype, lineweight, ltscale). */
export function commonProps(o: Obj): { id: string; layer: string; color: ColorSpec; linetype?: string; lineWeight?: number; ltscale?: number; trueColor?: number } {
  const layer = str(o, 8, '0');
  const rawColor = o.groups.find((x) => x.code === 62);
  const color: ColorSpec = rawColor && parseInt(rawColor.value, 10) !== 256 ? parseInt(rawColor.value, 10) : 'ByLayer';
  const base: { id: string; layer: string; color: ColorSpec; linetype?: string; lineWeight?: number; ltscale?: number } = { id: newId(), layer, color };
  const lt = str(o, 6);
  if (lt && lt.toUpperCase() !== 'BYLAYER') base.linetype = lt;
  if (has(o, 370)) {
    const lw = Math.trunc(num(o, 370));
    if (lw >= 0) base.lineWeight = lw / 100;
    else if (lw === -2) base.lineWeight = -2;
  }
  if (has(o, 48) && num(o, 48) !== 1) base.ltscale = num(o, 48);
  if (has(o, 420)) (base as { trueColor?: number }).trueColor = Math.trunc(num(o, 420)) & 0xffffff;
  return base;
}

export interface ReadContext {
  dimStyles: Map<string, DimStyle>;
  dimStyle: DimStyle;
  /** Block definitions read so far (BLOCKS precedes ENTITIES), for per-insert attribute visibility. */
  blocks?: Record<string, BlockDef>;
  /** Values for field expressions in TEXT / MTEXT. */
  fields?: FieldContext;
  /** IMAGE entities waiting for their IMAGEDEF (OBJECTS comes last), by IMAGEDEF handle. */
  pendingImages?: Map<ImageEntity, string>;
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
