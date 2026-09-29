/**
 * Drawing settings block: like AutoCAD Electrical's WD_M block, an insert on
 * layer WD_M at the origin whose invisible attributes hold the per-drawing
 * tag / wire-number formats, sheet number and IEC codes. Saving the drawing
 * to DXF carries the settings along.
 *
 * Drawing units (docs/METRIC.md): like AutoCAD Electrical's "Inches / MM"
 * drawing property, the UNITS attribute says whether the drawing is imperial
 * (library symbols at 1:1, 0.75" contacts) or metric (symbols, text heights and
 * offsets multiplied by 25.4, ladders laid out in millimetres). Without a WD_M
 * UNITS value the drawing's $INSUNITS decides (1 in, 4 mm, 5 cm, 6 m).
 */
import type { BlockDef, InsertEntity, AttributeDef, Entity } from '../core/entities';
import { newId, scaleEntityBy } from '../core/entities';
import type { Drawing, DrawingHeader, DrawingState } from '../core/document';

export interface WdSettings {
  /** R = tag number is the rung reference, S = sequential counter. */
  tagMode: 'reference' | 'sequential';
  tagStart: number;
  /** %F family, %N number, %S sheet, %D drawing number, %I installation, %L location. */
  tagFormat: string;
  wireMode: 'reference' | 'sequential';
  wireStart: number;
  wireFormat: string;
  /** Cross-reference text format: %N rung reference, %S sheet. */
  xrefFormat: string;
  /** Coil cross-reference style: one compact text line ("NO 101, 102 / NC 103") or a small graphical table. */
  xrefStyle: 'text' | 'table';
  sheet: string;
  drawingNumber: string;
  drawingDescription: string;
  iecProject: string;
  iecInstallation: string;
  iecLocation: string;
  standard: 'JIC' | 'IEC';
  rungSpacing: number;
  ladderWidth: number;
  /** Wire number placement for AEWIRENO. */
  wirePosition: 'above' | 'below' | 'inline';
  /** Drawing units: 'in' = imperial library scale 1, 'mm' = metric, everything x 25.4 (WD_M attribute UNITS). */
  drawingUnits: DrawingUnits;
}

export type DrawingUnits = 'in' | 'mm';

/** Millimetres per inch: the scale AutoCAD Electrical applies to its inch symbols in metric drawings. */
export const MM_PER_INCH = 25.4;

export const DEFAULT_WD_SETTINGS: WdSettings = {
  tagMode: 'reference',
  tagStart: 1,
  tagFormat: '%F%N',
  wireMode: 'reference',
  wireStart: 100,
  wireFormat: '%N',
  xrefFormat: '%N',
  xrefStyle: 'text',
  sheet: '1',
  drawingNumber: '',
  drawingDescription: '',
  iecProject: '',
  iecInstallation: '',
  iecLocation: '',
  standard: 'JIC',
  rungSpacing: 1,
  ladderWidth: 9,
  wirePosition: 'above',
  drawingUnits: 'in',
};

/** Metric ladder defaults: round millimetre values (about 1" rungs on a 9" ladder). */
export const METRIC_LADDER_DEFAULTS = { rungSpacing: 25, ladderWidth: 230 } as const;

/** Default settings for a drawing in the given units. */
export function defaultWdSettings(units: DrawingUnits = 'in'): WdSettings {
  return units === 'mm' ? { ...DEFAULT_WD_SETTINGS, ...METRIC_LADDER_DEFAULTS, drawingUnits: 'mm' } : { ...DEFAULT_WD_SETTINGS };
}

export const WD_M_LAYER = 'WD_M';

const ATTRS: Array<[keyof WdSettings, string]> = [
  ['tagMode', 'TAGMODE'],
  ['tagStart', 'TAG_START'],
  ['tagFormat', 'TAGFMT'],
  ['wireMode', 'WIREMODE'],
  ['wireStart', 'WIRE_START'],
  ['wireFormat', 'WIREFMT'],
  ['xrefFormat', 'XREFFMT'],
  ['xrefStyle', 'XREFSTYLE'],
  ['sheet', 'SHEET'],
  ['drawingNumber', 'DWGNAM'],
  ['drawingDescription', 'DWGDESC'],
  ['iecProject', 'IEC_PROJ'],
  ['iecInstallation', 'IEC_INST'],
  ['iecLocation', 'IEC_LOC'],
  ['standard', 'STANDARD'],
  ['rungSpacing', 'RUNGDIST'],
  ['ladderWidth', 'LADDERWIDTH'],
  ['wirePosition', 'WIREPOS'],
  ['drawingUnits', 'UNITS'],
];

const attrDefs: AttributeDef[] = ATTRS.map(([key, tag], i) => ({
  tag,
  prompt: tag,
  default: String(DEFAULT_WD_SETTINGS[key]),
  position: { x: 0, y: -0.1 * i },
  height: 0.05,
  align: 'left',
  invisible: true,
}));

/** The settings block: a small marker cross plus the invisible attributes. */
export const WD_M_BLOCK: BlockDef = {
  name: 'WD_M',
  description: 'Drawing settings (AutoCAD Electrical style)',
  basePoint: { x: 0, y: 0 },
  entities: [
    { id: 'wdm1', layer: '0', color: 'ByLayer', type: 'line', a: { x: -0.05, y: 0 }, b: { x: 0.05, y: 0 } },
    { id: 'wdm2', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: -0.05 }, b: { x: 0, y: 0.05 } },
  ],
  attributes: attrDefs,
};

export function findWdM(doc: Drawing): InsertEntity | undefined {
  return doc.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === WD_M_BLOCK.name);
}

/** WD_M UNITS attribute value -> drawing units (undefined when absent or unknown). */
export function parseUnitsAttribute(v: string | undefined): DrawingUnits | undefined {
  const t = (v ?? '').trim().toUpperCase();
  if (t === 'MM' || t === 'METRIC' || t === 'MILLIMETERS' || t === 'MILLIMETRES' || t === '1') return 'mm';
  if (t === 'IN' || t === 'INCH' || t === 'INCHES' || t === 'IMPERIAL' || t === '0') return 'in';
  return undefined;
}

/**
 * Convert the attribute values of a WD_M insert into settings (defaults fill the gaps).
 * `fallbackUnits` applies when the block has no UNITS value (older drawings: the $INSUNITS choice).
 */
export function settingsFromAttributes(attrs: Readonly<Record<string, string>>, fallbackUnits: DrawingUnits = 'in'): WdSettings {
  const units = parseUnitsAttribute(attrs.UNITS) ?? fallbackUnits;
  const s: WdSettings = defaultWdSettings(units);
  const num = (v: string | undefined, d: number) => {
    const n = parseFloat(v ?? '');
    return Number.isFinite(n) ? n : d;
  };
  const mode = (v: string | undefined, d: 'reference' | 'sequential') => (v === 'S' || v === 'sequential' ? 'sequential' : v === 'R' || v === 'reference' ? 'reference' : d);
  s.tagMode = mode(attrs.TAGMODE, s.tagMode);
  s.tagStart = num(attrs.TAG_START, s.tagStart);
  s.tagFormat = attrs.TAGFMT || s.tagFormat;
  s.wireMode = mode(attrs.WIREMODE, s.wireMode);
  s.wireStart = num(attrs.WIRE_START, s.wireStart);
  s.wireFormat = attrs.WIREFMT || s.wireFormat;
  s.xrefFormat = attrs.XREFFMT || s.xrefFormat;
  s.xrefStyle = attrs.XREFSTYLE === 'table' ? 'table' : 'text';
  s.sheet = attrs.SHEET ?? s.sheet;
  s.drawingNumber = attrs.DWGNAM ?? s.drawingNumber;
  s.drawingDescription = attrs.DWGDESC ?? s.drawingDescription;
  s.iecProject = attrs.IEC_PROJ ?? '';
  s.iecInstallation = attrs.IEC_INST ?? '';
  s.iecLocation = attrs.IEC_LOC ?? '';
  s.standard = attrs.STANDARD === 'IEC' ? 'IEC' : 'JIC';
  s.rungSpacing = num(attrs.RUNGDIST, s.rungSpacing);
  s.ladderWidth = num(attrs.LADDERWIDTH, s.ladderWidth);
  s.wirePosition = attrs.WIREPOS === 'below' ? 'below' : attrs.WIREPOS === 'inline' ? 'inline' : 'above';
  s.drawingUnits = units;
  return s;
}

export function attributesFromSettings(s: WdSettings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, tag] of ATTRS) {
    const v = s[key];
    out[tag] = key === 'tagMode' || key === 'wireMode' ? (v === 'sequential' ? 'S' : 'R') : key === 'drawingUnits' ? (v === 'mm' ? 'MM' : 'INCHES') : String(v);
  }
  return out;
}

/** Read the drawing settings (defaults for the drawing's $INSUNITS when it has no WD_M block). */
export function readWdSettings(doc: Drawing): WdSettings {
  const ins = findWdM(doc);
  const fallback = unitsFromInsunits(doc.header.units.insunits);
  return ins ? settingsFromAttributes(ins.attributes, fallback) : defaultWdSettings(fallback);
}

/** Write settings into the WD_M block (inserting it at the origin when missing). One undo step. */
export function writeWdSettings(doc: Drawing, s: WdSettings): void {
  doc.ensureBlocks([WD_M_BLOCK]);
  if (!doc.layer(WD_M_LAYER)) doc.addLayer({ name: WD_M_LAYER, color: 8, visible: false, locked: true, lineWeight: 0.25 });
  const attrs = attributesFromSettings(s);
  const existing = findWdM(doc);
  if (existing) {
    doc.replaceEntities([{ ...existing, attributes: { ...existing.attributes, ...attrs } }]);
    return;
  }
  const ins: InsertEntity = { id: newId(), layer: WD_M_LAYER, color: 'ByLayer', type: 'insert', block: WD_M_BLOCK.name, position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: attrs };
  doc.addEntities([ins]);
}

// ---------------------------------------------------------------- drawing units (imperial / metric)

/** Drawing units per inch for the $INSUNITS codes that matter here (absent = unitless / unknown). */
const UNITS_PER_INCH: Readonly<Record<number, number>> = { 1: 1, 2: 1 / 12, 4: MM_PER_INCH, 5: MM_PER_INCH / 10, 6: MM_PER_INCH / 1000 };

/** $INSUNITS -> the electrical drawing-units choice (mm, cm and m drawings are metric). */
export function unitsFromInsunits(insunits: number): DrawingUnits {
  return insunits === 4 || insunits === 5 || insunits === 6 ? 'mm' : 'in';
}

/** $INSUNITS code written for a drawing-units choice. */
export function insunitsFor(units: DrawingUnits): number {
  return units === 'mm' ? 4 : 1;
}

/**
 * Drawing units per inch of library geometry: 1 for imperial drawings, 25.4 for
 * millimetre drawings (2.54 for cm and 0.0254 for m when $INSUNITS says so;
 * 1/12 for feet when nothing overrides $INSUNITS).
 */
export function unitScaleFor(units: DrawingUnits | undefined, insunits = 1): number {
  if (units === 'mm') return insunits === 5 || insunits === 6 ? UNITS_PER_INCH[insunits]! : MM_PER_INCH;
  if (units === 'in') return 1;
  return UNITS_PER_INCH[insunits] ?? 1;
}

/** Anything with entities and (optionally) a header: a Drawing, a DrawingState or `{ entities }`. */
export interface UnitSource {
  readonly entities: readonly Entity[];
  readonly header?: DrawingHeader;
}

function wdmOf(doc: UnitSource): InsertEntity | undefined {
  return doc.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === WD_M_BLOCK.name);
}

/**
 * The drawing's unit scale (drawing units per library inch): the WD_M UNITS
 * attribute when present, otherwise $INSUNITS; 1 for `{ entities }` without either.
 */
export function drawingUnitScale(doc: UnitSource): number {
  const insunits = doc.header?.units.insunits ?? 1;
  const units = parseUnitsAttribute(wdmOf(doc)?.attributes.UNITS);
  if (units) return unitScaleFor(units, insunits);
  return doc.header ? unitScaleFor(undefined, insunits) : 1;
}

/** The drawing's units choice (see `drawingUnitScale`). */
export function drawingUnitsOf(doc: UnitSource): DrawingUnits {
  return parseUnitsAttribute(wdmOf(doc)?.attributes.UNITS) ?? unitsFromInsunits(doc.header?.units.insunits ?? 1);
}

export interface UnitChangeOptions {
  /**
   * Scale the existing geometry about the origin so it keeps its real size
   * (an imperial drawing converted to mm grows by 25.4). Off: only the settings
   * change and existing objects keep their coordinates.
   */
  rescale: boolean;
}

export interface UnitChangeResult {
  from: DrawingUnits;
  to: DrawingUnits;
  /** Factor applied to the geometry (1 when not rescaled or unchanged). */
  factor: number;
  /** Entities scaled. */
  count: number;
}

/**
 * Switch the drawing between inches and millimetres: sets $INSUNITS, the WD_M
 * UNITS value and the ladder settings (untouched defaults become the other
 * system's round defaults, custom values convert exactly), and optionally
 * rescales every existing object about the origin (the WD_M block stays put).
 * One undo step, header included.
 */
export function setDrawingUnits(doc: Drawing, to: DrawingUnits, opts: UnitChangeOptions = { rescale: false }): UnitChangeResult {
  const current = readWdSettings(doc);
  const from = drawingUnitsOf(doc);
  const factor = from === to ? 1 : to === 'mm' ? MM_PER_INCH : 1 / MM_PER_INCH;
  const convert = (v: number, inchDefault: number, metricDefault: number) => {
    if (from === to) return v;
    if (to === 'mm' && v === inchDefault) return metricDefault;
    if (to === 'in' && v === metricDefault) return inchDefault;
    return Math.round(v * factor * 1000) / 1000;
  };
  const next: WdSettings = {
    ...current,
    drawingUnits: to,
    rungSpacing: convert(current.rungSpacing, DEFAULT_WD_SETTINGS.rungSpacing, METRIC_LADDER_DEFAULTS.rungSpacing),
    ladderWidth: convert(current.ladderWidth, DEFAULT_WD_SETTINGS.ladderWidth, METRIC_LADDER_DEFAULTS.ladderWidth),
  };
  doc.ensureBlocks([WD_M_BLOCK]);
  if (!doc.layer(WD_M_LAYER)) doc.addLayer({ name: WD_M_LAYER, color: 8, visible: false, locked: true, lineWeight: 0.25 });
  const k = opts.rescale ? factor : 1;
  let count = 0;
  const header = doc.header;
  doc.transact((st: DrawingState) => {
    const origin = { x: 0, y: 0 };
    let entities = st.entities.map((e) => {
      if (k === 1 || (e.type === 'insert' && e.block === WD_M_BLOCK.name)) return e;
      count += 1;
      return scaleEntityBy(e, origin, k);
    });
    const attrs = attributesFromSettings(next);
    const wdm = entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === WD_M_BLOCK.name);
    if (wdm) entities = entities.map((e) => (e === wdm ? { ...wdm, attributes: { ...wdm.attributes, ...attrs } } : e));
    else entities = [...entities, { id: newId(), layer: WD_M_LAYER, color: 'ByLayer', type: 'insert', block: WD_M_BLOCK.name, position: origin, rotation: 0, scale: 1, attributes: attrs }];
    const lim = header.limits;
    return {
      ...st,
      entities,
      header: {
        ...header,
        units: { ...header.units, insunits: insunitsFor(to) },
        ...(k !== 1 ? { limits: { min: { x: lim.min.x * k, y: lim.min.y * k }, max: { x: lim.max.x * k, y: lim.max.y * k } } } : {}),
      },
    };
  });
  return { from, to, factor: k, count };
}

/** Parse the WDUNITS argument: "", "?", "IN", "MM", optionally followed by "RESCALE" / "KEEP". */
export function parseUnitsCommand(arg: string | undefined): { units?: DrawingUnits; rescale: boolean; query: boolean } | null {
  const words = (arg ?? '').trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words[0] === '?') return { rescale: false, query: true };
  const units = parseUnitsAttribute(words[0]) ?? (words[0] === 'I' ? 'in' : words[0] === 'M' ? 'mm' : undefined);
  if (!units) return null;
  const opt = words[1] ?? '';
  if (opt && !/^(R|RESCALE|S|SCALE|K|KEEP|N|NO)$/.test(opt)) return null;
  return { units, rescale: /^(R|RESCALE|S|SCALE)$/.test(opt), query: false };
}

/** Structural slice of the Editor that `registerUnitCommands` needs (keeps this module free of app imports). */
export interface UnitCommandHost {
  readonly doc: Drawing;
  log(text: string): void;
  zoomExtents(): void;
  register(def: { name: string; aliases: string[]; description: string; run: (host: any, arg?: string) => void }): void;
}

/** Run WDUNITS against a host (exported for tests; the registered command calls it). */
export function runUnitsCommand(host: Pick<UnitCommandHost, 'doc' | 'log' | 'zoomExtents'>, arg: string | undefined): void {
  const p = parseUnitsCommand(arg);
  if (!p) {
    host.log('WDUNITS: expected IN or MM, optionally followed by RESCALE or KEEP.');
    return;
  }
  if (p.query || !p.units) {
    const u = drawingUnitsOf(host.doc);
    host.log(`Drawing units: ${u === 'mm' ? 'millimetres (library symbols x 25.4)' : 'inches (library symbols x 1)'}; $INSUNITS ${host.doc.header.units.insunits}; symbol scale ${drawingUnitScale(host.doc)}. WDUNITS MM|IN [RESCALE] switches.`);
    return;
  }
  const r = setDrawingUnits(host.doc, p.units, { rescale: p.rescale });
  const name = (u: DrawingUnits) => (u === 'mm' ? 'millimetres' : 'inches');
  if (r.from === r.to) host.log(`Drawing units are already ${name(r.to)}.`);
  else host.log(`Drawing units: ${name(r.from)} -> ${name(r.to)}${r.factor !== 1 ? `; ${r.count} object(s) scaled by ${Number(r.factor.toFixed(6))}` : '; existing objects keep their coordinates (add RESCALE to convert them)'}.`);
  if (r.factor !== 1) host.zoomExtents();
}

/**
 * WDUNITS [IN|MM] [RESCALE|KEEP]: report or switch the drawing units (the
 * command-line twin of the Units tab in Drafting Settings). Call once at
 * start-up next to registerElectricalCommands(editor).
 */
export function registerUnitCommands(editor: UnitCommandHost): void {
  editor.register({
    name: 'WDUNITS',
    aliases: ['AEUNITS', 'DRAWINGUNITS'],
    description: 'Electrical drawing units: WDUNITS [IN|MM] [RESCALE|KEEP] (metric scales symbols by 25.4)',
    run: (_ed: unknown, arg?: string) => runUnitsCommand(editor, arg),
  });
}
