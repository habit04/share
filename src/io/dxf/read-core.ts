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
import type { MLeaderStyleRetained } from '../../core/multileader';
import { ImportReportBuilder } from '../import-report';
import { transparencyFromDxf, validColorName } from '../../core/appearance';
import type { EntityBase } from '../../core/entities';
import type { RawDxfEntity } from '../import-report';
import type { Model3DReader } from './mesh3d-read';

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
  const base: { id: string; cadIdentity?: string; layer: string; color: ColorSpec; linetype?: string; lineWeight?: number; ltscale?: number } = { id: newId(), ...(has(o, 5) ? { cadIdentity: str(o, 5).trim() } : {}), layer, color };
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
  /** P18: MLEADERSTYLE names by upper-case handle (OBJECTS comes last; a MULTILEADER's trailing group 340 names one). */
  mleaderStyles?: ReadonlyMap<string, string>;
  /** P18 (AMENDMENT-P18-S2-A, must-fix V-1): MLEADERSTYLE retained values by upper-case handle —
   *  the source values of the style groups no entity field supplies; a style whose values all
   *  match the specimen constants has NO entry, so authored round trips are untouched. */
  mleaderStyleValues?: ReadonlyMap<string, MLeaderStyleRetained>;
  /** P18 slice 2 (PROPOSAL-P18-S2 item (1)): BLOCK_RECORD names by upper-case handle
   *  (TABLES precedes ENTITIES; a MULTILEADER's 341 / trailing 344 name one). */
  blockRecordNames?: ReadonlyMap<string, string>;
  /** P17 round 6: the canonical handles of EVERY HATCH record in the file
   *  (BLOCKS + ENTITIES sections: any space, any block definition, and
   *  records no entity list models — retained raw records included),
   *  pre-scanned from the raw pairs like the maps above, so a hatch's
   *  boundary resolution can tell a hatch-typed target apart from an
   *  ordinary cross-space boundary without depending on section order.
   *  Absent on read paths that build their own context: the cross-space
   *  hatch check then simply does not engage (same-list checks remain). */
  hatchHandles?: ReadonlySet<string>;
  /** P18 S3-D (RULING-P18-S3-D (1)(i)): the OBJECTS DICTIONARY records and the
   *  ACDB_MLEADEROBJECTCONTEXTDATA_CLASS records, by upper-case handle — the raw
   *  material readMLeader's extension-dictionary join resolves a MULTILEADER's
   *  annotative context objects through. Absent on read paths that build their
   *  own context: the object path then simply does not engage. */
  mleaderContextData?: {
    dictionaries: ReadonlyMap<string, Obj>;
    contextObjects: ReadonlyMap<string, Obj>;
    /** P18 FIX group 1(b): SCALE objects by upper-case handle -> group-300 name. */
    scales: ReadonlyMap<string, string>;
  };
  /** Anonymous blocks replaced by native tables. */
  consumedBlocks?: Set<string>;
  /** Remarks about content that was simplified. */
  notes?: string[];
  /** Import report: dropped / simplified / kept objects. */
  report?: ImportReportBuilder;
  /** Unknown model-space records kept as raw group codes. */
  raw?: RawDxfEntity[];
  /** Model-space polyface meshes into experimental 3D solids (io/dxf/mesh3d-read.ts). */
  solids?: Model3DReader;
  /** Where the objects being read are (report text). */
  where?: string;
  /** Block names whose JCAD_DYNAMIC definition report entry was already emitted
   *  (the definition entry is reported once per block, not once per insert). */
  dynamicDefinitionReports?: Set<string>;
  /** Raw JCAD_CONSTRAINTS payload text captured from the *Model_Space BLOCK
   *  record. Decoding is deferred to reader.ts: entity refs are `#<index>`
   *  ordinals into the model-space entity list, which only exists after the
   *  ENTITIES section has been read. */
  constraintsRaw?: string;
  /** Source $MEASUREMENT (0 = imperial, 1 = metric), set by the HEADER section reader.
   *  In a metric file the stored pattern definitions are the ISO ones, at 25.4x the
   *  imperial table JCad fits against (see fitPatternToLines' unit factor). */
  measurement?: number;
}

/**
 * Emit the import-report entry for one block's JCAD_DYNAMIC definition carrier, once
 * per block per read. Called from read-sections (where the definition is decoded) and
 * again from read-pass for inserts of that block; the shared set keeps it to one entry.
 */
export function reportDynamicDefinition(ctx: ReadContext, blockName: string, retained: boolean): void {
  if (!ctx.report) return;
  ctx.dynamicDefinitionReports ??= new Set<string>();
  if (ctx.dynamicDefinitionReports.has(blockName)) return;
  ctx.dynamicDefinitionReports.add(blockName);
  ctx.report.add({
    type: 'BLOCK',
    action: 'simplified',
    reason: retained
      ? 'dynamic-block definition data in JCAD_DYNAMIC could not be read (malformed or a newer version); the raw payload is retained for JCad re-export, and the block is imported as a static block'
      : 'dynamic-block definition is kept in JCAD_DYNAMIC for JCad reimport; native dynamic-block parameters and actions are not modeled, and other CAD programs show the static block',
    ...(ctx.where ? { where: ctx.where } : {}),
  });
}

export function reportObj(ctx: ReadContext, o: Obj, action: 'dropped' | 'simplified' | 'kept', reason: string): void {
  if (!ctx.report) return;
  const handle = str(o, 5);
  ctx.report.add({ type: o.kind, action, reason, ...(handle ? { handle } : {}), layer: str(o, 8, '0'), ...(o.line ? { line: o.line } : {}), ...(ctx.where ? { where: ctx.where } : {}) });
}
