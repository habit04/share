/**
 * Drawing settings block: like AutoCAD Electrical's WD_M block, an insert on
 * layer WD_M at the origin whose invisible attributes hold the per-drawing
 * tag / wire-number formats, sheet number and IEC codes. Saving the drawing
 * to DXF carries the settings along.
 */
import type { BlockDef, InsertEntity, AttributeDef } from '../core/entities';
import { newId } from '../core/entities';
import type { Drawing } from '../core/document';

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
}

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
};

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

/** Convert the attribute values of a WD_M insert into settings (defaults fill the gaps). */
export function settingsFromAttributes(attrs: Readonly<Record<string, string>>): WdSettings {
  const s: WdSettings = { ...DEFAULT_WD_SETTINGS };
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
  return s;
}

export function attributesFromSettings(s: WdSettings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, tag] of ATTRS) {
    const v = s[key];
    out[tag] = key === 'tagMode' || key === 'wireMode' ? (v === 'sequential' ? 'S' : 'R') : String(v);
  }
  return out;
}

/** Read the drawing settings (defaults when the drawing has no WD_M block). */
export function readWdSettings(doc: Drawing): WdSettings {
  const ins = findWdM(doc);
  return ins ? settingsFromAttributes(ins.attributes) : { ...DEFAULT_WD_SETTINGS };
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
