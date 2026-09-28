/**
 * Symbol Builder conversions (pure, unit-tested).
 *
 * A symbol is edited as an ordinary drawing ("symbol state") in inches around
 * the origin:
 *  - geometry on layer `0` (any drafting command works on it),
 *  - attribute placeholders: TEXT entities on layer SYMATTR whose text is the
 *    attribute tag (TAG1, DESC1, TERM01 ...); position / height / justification
 *    / rotation of the text become those of the attribute definition,
 *  - explicit wire-connection pins: TEXT entities on layer SYMPIN whose text is
 *    a pin tag with an optional default pin number (`X1TERM01`, `X4TERM02=14`).
 *    The direction of a pin comes from where the marker sits on the geometry
 *    (a marker on a line end at x = -0.375 is a left pin whatever its text
 *    says), so COPY / MIRROR / ROTATE keep the pins right; the digit in the
 *    text is only used when no geometry is near the marker. Connections are
 *    also detected from the geometry alone (line endpoints at x = +-0.375 for
 *    horizontal symbols, y = +-0.375 for vertical ones).
 *  - the symbol's metadata (`SymbolMeta`: name, family, kind, orientation,
 *    attribute defaults) is stored in `DrawingState.meta`, so it is part of the
 *    undo history.
 *
 * `symbolStateToBlock` compiles that state into a BlockDef with the full
 * AutoCAD Electrical attribute set; `blockToSymbolState` does the reverse so
 * a library or user symbol can be opened for editing; `harvestBlock` and
 * `fromSelection` turn blocks of a drawing (e.g. manufacturer DWGs) or a
 * selection into a symbol state; `verticalVariant` and `createTwin` derive the
 * vertical and the NO / NC sibling of a symbol.
 */
import type { AttributeDef, BlockDef, Entity, Layer, LineEntity, TextEntity } from '../core/entities';
import { newId, explodeInsert, translateEntity, scaleEntityBy, rotateEntity, entityBounds } from '../core/entities';
import type { DrawingState } from '../core/document';
import { DEFAULT_LAYERS } from '../core/document';
import type { Point, Bounds } from '../core/geometry';
import { unionBounds, dist } from '../core/geometry';
import { acadeAttributes, connectionPoints, defaultPins, SYMBOL_HALF, DATA_ATTRIBUTES } from './attributes';
import { tagPrefix } from './symbols';
import type { SymbolStandard } from './userlib';

export const SYMATTR_LAYER = 'SYMATTR';
export const SYMPIN_LAYER = 'SYMPIN';
/** Half width of an inline symbol (wire stubs end at x = +-INLINE_HALF). */
export const INLINE_HALF = SYMBOL_HALF;
/** A pin marker this close to a geometry endpoint sits "on" it. */
export const PIN_SNAP_TOL = 0.02;
/** Endpoints this close to the wire level / the stub ends are snapped onto them after a harvest scale. */
export const HARVEST_SNAP_TOL = 0.03;

export type SymbolKind = 'parent' | 'child' | 'standalone' | 'terminal' | 'plc';
export type PinDirection = 1 | 2 | 4 | 8;
export type SymbolOrientation = 'H' | 'V';

export const SYMBOL_KINDS: Array<[SymbolKind, string]> = [
  ['parent', 'Parent / coil (WDTYPE COIL)'],
  ['child', 'Child contact (WDTYPE CONTACT)'],
  ['standalone', 'Device (no parent/child)'],
  ['terminal', 'Terminal (TERM01 + TAGSTRIP)'],
  ['plc', 'PLC I/O point (WDTYPE PLC)'],
];

/** Short kind labels for narrow controls (palette), derived from SYMBOL_KINDS. */
export const SYMBOL_KIND_SHORT: Array<[SymbolKind, string]> = SYMBOL_KINDS.map(([k, label]) => [k, label.replace(/\s*\(.*\)$/, '')]);

/** One-line explanation of what a kind (role) does, shown under the Role control. */
export function kindHint(kind: SymbolKind): string {
  switch (kind) {
    case 'parent':
      return 'Parent / coil: gets cross-referenced child contacts (AECHILD, AEXREF) and appears in the BOM.';
    case 'child':
      return 'Child contact: linked to a parent by tag; name it <parent>_NO / _NC so Toggle NO/NC and the pin defaults 13/14, 11/12 work.';
    case 'terminal':
      return 'Terminal: TERM01 is the terminal number, TAGSTRIP the strip; listed in the terminal reports.';
    case 'plc':
      return 'PLC I/O point: TAG1 holds the address (I:0.0 ...); listed in the PLC report.';
    default:
      return 'Device with no parent / child relation (push button, switch, lamp ...); tagged from the family.';
  }
}

export const PIN_DIRECTIONS: Array<[PinDirection, string]> = [
  [1, 'Left'],
  [2, 'Top'],
  [4, 'Right'],
  [8, 'Bottom'],
];

export const ORIENTATIONS: Array<[SymbolOrientation, string]> = [
  ['H', 'Horizontal (wire from the left / right)'],
  ['V', 'Vertical (wire from the top / bottom)'],
];

export interface SymbolMeta {
  /** Block name (upper case). */
  name: string;
  description: string;
  standard: SymbolStandard;
  category: string;
  /** Tag prefix, e.g. PB, CR, LS. */
  family: string;
  kind: SymbolKind;
  /** Contacts and pilot devices: normally open / closed variant (the name ends in _NO / _NC). */
  contact?: 'NO' | 'NC';
  /** Horizontal (inline on a rung, stubs at x = +-0.375) or vertical (stubs at y = +-0.375). */
  orientation: SymbolOrientation;
  /** Attribute default values (MFG, CAT, DESC1, RATING1 ... and vendor-specific invisible attributes), keyed by tag. */
  attrDefaults: Record<string, string>;
}

/** Older sessions kept the pin defaults keyed by marker id; `open` migrates them into the marker texts. */
export type LegacyPinDefaults = Record<string, string>;

/** WDTYPE value for a symbol kind. */
export function wdtypeFor(kind: SymbolKind, family: string): string {
  switch (kind) {
    case 'parent':
      return 'COIL';
    case 'child':
      return 'CONTACT';
    case 'terminal':
      return 'TERM';
    case 'plc':
      return 'PLC';
    default:
      return family.toUpperCase() || 'DEV';
  }
}

/** Attributes the palette offers for placement (visible text on the symbol). */
export const PLACEABLE_ATTRIBUTES = ['TAG1', 'DESC1', 'DESC2', 'DESC3', 'TERM01', 'INST', 'LOC', 'MFG', 'CAT', 'RATING1'] as const;
/** Attributes acadeAttributes adds invisibly when they were not placed. */
export const AUTOMATIC_ATTRIBUTES = [...DATA_ATTRIBUTES, 'TAGSTRIP'] as const;
/** Invisible data attributes whose defaults the palette offers for editing (order of the table). */
export const DEFAULT_EDITABLE_ATTRIBUTES = ['MFG', 'CAT', 'RATING1', 'INST', 'LOC', 'ASSYCODE'] as const;
export const KNOWN_ATTRIBUTES: ReadonlySet<string> = new Set<string>([...PLACEABLE_ATTRIBUTES, ...AUTOMATIC_ATTRIBUTES, 'TAG1', 'DESC1']);
export const isKnownAttribute = (tag: string): boolean => KNOWN_ATTRIBUTES.has(tag.toUpperCase());

const PIN_RE = /^X([1248])TERM(\d*)(?:=(.*))?$/i;
/** True for a pin tag with or without a default (`X1TERM01`, `x4term02=14`). */
export const isPinTag = (tag: string): boolean => PIN_RE.test(tag.trim());
/** Direction digit of a pin tag / marker text (1 left, 2 top, 4 right, 8 bottom). */
export const pinDirection = (tag: string): PinDirection | null => {
  const m = PIN_RE.exec(tag.trim());
  return m ? (parseInt(m[1]!, 10) as PinDirection) : null;
};
/** The attribute tag part of a marker text (`X4TERM02=14` -> `X4TERM02`). */
export const markerTag = (text: string): string => {
  const m = PIN_RE.exec(text.trim());
  return m ? `X${m[1]}TERM${m[2] ?? ''}`.toUpperCase() : text.trim().toUpperCase();
};
/** The default pin number stored in a marker text (`X4TERM02=14` -> `14`, `X4TERM02` -> ``). */
export const markerDefault = (text: string): string => {
  const m = PIN_RE.exec(text.trim());
  return m?.[3]?.trim() ?? '';
};
/** Marker text for a tag and a default (`X4TERM02`, `14` -> `X4TERM02=14`). */
export const markerText = (tag: string, def: string): string => (def.trim() ? `${tag}=${def.trim()}` : tag);

/** Prompt text of an attribute definition. */
export function attributePrompt(tag: string, kind: SymbolKind = 'standalone'): string {
  switch (tag) {
    case 'TAG1':
      return kind === 'plc' ? 'Address' : 'Component tag';
    case 'DESC1':
      return 'Description';
    case 'DESC2':
      return 'Description line 2';
    case 'DESC3':
      return 'Description line 3';
    case 'TERM01':
      return 'Terminal number';
    case 'INST':
      return 'Installation';
    case 'LOC':
      return 'Location';
    case 'MFG':
      return 'Manufacturer';
    case 'CAT':
      return 'Catalog number';
    case 'ASSYCODE':
      return 'Assembly code';
    case 'RATING1':
      return 'Rating';
    case 'RATING2':
      return 'Rating 2';
    case 'TAGSTRIP':
      return 'Terminal strip';
    default:
      return tag;
  }
}

/**
 * Default text height, position and justification for a newly placed attribute
 * placeholder. Horizontal symbols stack TAG1 above and DESC1-3 below; vertical
 * symbols put them to the right of the stub (ACADE's V* symbols).
 */
export function attributeDefaults(tag: string, orientation: SymbolOrientation = 'H'): { height: number; position: Point; align: TextEntity['align'] } {
  if (orientation === 'V') {
    switch (tag) {
      case 'TAG1':
        return { height: 0.125, position: { x: 0.45, y: 0.1 }, align: 'left' };
      case 'DESC1':
        return { height: 0.1, position: { x: 0.45, y: -0.1 }, align: 'left' };
      case 'DESC2':
        return { height: 0.1, position: { x: 0.45, y: -0.23 }, align: 'left' };
      case 'DESC3':
        return { height: 0.1, position: { x: 0.45, y: -0.36 }, align: 'left' };
      case 'TERM01':
        return { height: 0.08, position: { x: 0.15, y: 0 }, align: 'left' };
      default:
        return { height: 0.07, position: { x: 0.45, y: -0.5 }, align: 'left' };
    }
  }
  switch (tag) {
    case 'TAG1':
      return { height: 0.125, position: { x: 0, y: 0.3 }, align: 'center' };
    case 'DESC1':
      return { height: 0.1, position: { x: 0, y: -0.45 }, align: 'center' };
    case 'DESC2':
      return { height: 0.1, position: { x: 0, y: -0.58 }, align: 'center' };
    case 'DESC3':
      return { height: 0.1, position: { x: 0, y: -0.71 }, align: 'center' };
    case 'TERM01':
      return { height: 0.08, position: { x: 0, y: 0.15 }, align: 'center' };
    default:
      return { height: 0.07, position: { x: 0, y: -0.3 }, align: 'center' };
  }
}

/** The attribute placeholders a blank symbol of a kind starts with (removable). */
export function attributeTemplate(kind: SymbolKind): string[] {
  switch (kind) {
    case 'terminal':
      return ['TERM01'];
    default:
      return ['TAG1', 'DESC1'];
  }
}

/** Layers of a symbol editing document: the defaults plus the two marker layers. */
export function symbolLayers(): Layer[] {
  return [
    ...DEFAULT_LAYERS.map((l) => ({ ...l })),
    { name: SYMATTR_LAYER, color: 2, visible: true, locked: false, lineWeight: 0.25 },
    { name: SYMPIN_LAYER, color: 1, visible: true, locked: false, lineWeight: 0.25 },
  ];
}

const text = (layer: string, position: Point, value: string, height: number, align: TextEntity['align'] = 'center', rotation = 0): TextEntity => ({
  id: newId(),
  layer,
  color: 'ByLayer',
  type: 'text',
  position,
  text: value,
  height,
  rotation,
  align,
});

export const isPlaceholder = (e: Entity): e is TextEntity => e.type === 'text' && e.layer === SYMATTR_LAYER;
export const isPinMarker = (e: Entity): e is TextEntity => e.type === 'text' && e.layer === SYMPIN_LAYER && isPinTag(e.text);
export const isSymbolGeometry = (e: Entity): boolean => e.layer !== SYMATTR_LAYER && e.layer !== SYMPIN_LAYER;

/** A new attribute placeholder text (the palette's Place / Add buttons and the blank template). */
export function placeholderEntity(tag: string, position?: Point, height?: number, orientation: SymbolOrientation = 'H'): TextEntity {
  const d = attributeDefaults(tag, orientation);
  return text(SYMATTR_LAYER, position ?? d.position, tag.toUpperCase(), height ?? d.height, d.align);
}

/** Placeholders of the kind's template at their default positions. */
export function templatePlaceholders(kind: SymbolKind, orientation: SymbolOrientation = 'H'): TextEntity[] {
  return attributeTemplate(kind).map((t) => placeholderEntity(t, undefined, undefined, orientation));
}

/**
 * Justification / rotation of a pin marker label so it reads away from the
 * symbol: left pins end at the point, right pins start there, top and bottom
 * labels run along the stub (rotated 90 degrees) up or down from the point.
 */
export function markerLayout(dir: PinDirection): { align: TextEntity['align']; rotation: number } {
  switch (dir) {
    case 1:
      return { align: 'right', rotation: 0 };
    case 4:
      return { align: 'left', rotation: 0 };
    case 2:
      return { align: 'left', rotation: Math.PI / 2 };
    default:
      return { align: 'right', rotation: Math.PI / 2 };
  }
}

/** Pin marker text at a connection point with an optional default pin number. */
export function pinMarkerText(tag: string, position: Point, def = ''): TextEntity {
  const dir = pinDirection(tag) ?? 1;
  const l = markerLayout(dir);
  return text(SYMPIN_LAYER, position, markerText(markerTag(tag), def), 0.05, l.align, l.rotation);
}

/** A new explicit pin marker (the palette's Add pin button). */
export function pinMarkerEntity(dir: PinDirection, position: Point, index: number, def = ''): TextEntity {
  return pinMarkerText(`X${dir}TERM${String(index).padStart(2, '0')}`, position, def);
}

export interface SymbolState {
  state: DrawingState;
  meta: SymbolMeta;
}

/** Blank editing document (layers, meta and optionally the kind's attribute template). */
export function blankSymbolState(meta?: SymbolMeta, withTemplate = false): DrawingState {
  return { entities: meta && withTemplate ? templatePlaceholders(meta.kind, meta.orientation) : [], layers: symbolLayers(), blocks: {}, currentLayer: '0', ...(meta ? { meta: metaRecord(meta) } : {}) };
}

/** Meta with defaults filled in. */
export function defaultMeta(partial: Partial<SymbolMeta> & { name: string }): SymbolMeta {
  const m: SymbolMeta = {
    description: '',
    standard: 'JIC',
    category: 'User symbols',
    family: 'DEV',
    kind: 'standalone',
    orientation: 'H',
    attrDefaults: {},
    ...partial,
    name: partial.name.toUpperCase(),
  };
  m.attrDefaults = { ...m.attrDefaults };
  delete (m as { pinDefaults?: unknown }).pinDefaults; // legacy field of older sessions
  return m;
}

/** The meta as stored in `DrawingState.meta` (plain data). */
export function metaRecord(meta: SymbolMeta): Readonly<Record<string, unknown>> {
  return { ...meta, attrDefaults: { ...meta.attrDefaults } };
}

/** Read the symbol meta of an editing document (null for ordinary drawings). */
export function metaOf(state: DrawingState): SymbolMeta | null {
  const m = state.meta;
  if (!m || typeof m.name !== 'string' || typeof m.kind !== 'string') return null;
  return defaultMeta(m as unknown as Partial<SymbolMeta> & { name: string });
}

/** The state with its meta replaced. */
export function withMeta(state: DrawingState, meta: SymbolMeta): DrawingState {
  return { ...state, meta: metaRecord(meta) };
}

/** Guess the symbol kind from a block's attributes / WDTYPE default. */
export function kindFromBlock(block: BlockDef): SymbolKind {
  const wd = block.attributes.find((a) => a.tag === 'WDTYPE')?.default ?? '';
  if (wd === 'COIL') return 'parent';
  if (wd === 'CONTACT') return 'child';
  if (wd === 'TERM' || block.attributes.some((a) => a.tag === 'TERM01')) return 'terminal';
  if (wd === 'PLC') return 'plc';
  return 'standalone';
}

/** Guess the orientation of a block: pins on the top / bottom edge only, or a V-prefixed JIC name. */
export function orientationFromBlock(block: BlockDef): SymbolOrientation {
  const pins = block.attributes.filter((a) => isPinTag(a.tag));
  const horizontal = pins.some((a) => Math.abs(Math.abs(a.position.x - block.basePoint.x) - INLINE_HALF) < 1e-3);
  const vertical = pins.some((a) => Math.abs(Math.abs(a.position.y - block.basePoint.y) - INLINE_HALF) < 1e-3);
  if (vertical && !horizontal) return 'V';
  if (!vertical && !horizontal && /^V[A-Z]{1,4}\d/.test(block.name)) return 'V';
  return 'H';
}

/** Which attribute defaults of a block are worth keeping: every non-empty one, plus unknown invisible (vendor) attributes. */
function harvestDefaults(attributes: readonly AttributeDef[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of attributes) {
    const tag = a.tag.toUpperCase();
    if (isPinTag(tag) || tag === 'WDTYPE') continue;
    if (a.default.trim() || (a.invisible && !KNOWN_ATTRIBUTES.has(tag))) out[tag] = a.default;
  }
  return out;
}

/** Attribute rotation once `AttributeDef` carries one (another change adds the field; read it defensively). */
const attrRotation = (a: AttributeDef): number => (a as { rotation?: number }).rotation ?? 0;

/**
 * Library / user block -> editing document. Geometry keeps its layer (library
 * geometry is on `0`), visible attributes become placeholders (auto-added
 * invisible ones such as DESC2 / DESC3 are skipped, their defaults are kept in
 * `attrDefaults`), every X?TERM attribute becomes an explicit pin marker
 * carrying its default pin number.
 */
export function blockToSymbolState(block: BlockDef, meta?: Partial<SymbolMeta>): SymbolState {
  const shift = { x: -block.basePoint.x, y: -block.basePoint.y };
  const entities: Entity[] = block.entities.map((e) => ({ ...translateEntity(e, shift), id: newId() }));
  for (const a of block.attributes) {
    const p = { x: a.position.x + shift.x, y: a.position.y + shift.y };
    if (isPinTag(a.tag)) entities.push(pinMarkerText(a.tag, p, a.default));
    else if (!a.invisible) entities.push(text(SYMATTR_LAYER, p, a.tag.toUpperCase(), a.height, a.align, attrRotation(a)));
  }
  const kind = meta?.kind ?? kindFromBlock(block);
  const contact = meta?.contact ?? (/_NC$/.test(block.name) ? 'NC' : /_NO$/.test(block.name) ? 'NO' : undefined);
  const wd = block.attributes.find((a) => a.tag === 'WDTYPE')?.default;
  const family = meta?.family ?? (wd && !/^(COIL|CONTACT|TERM|PLC)$/.test(wd) ? wd : tagPrefix(block.name));
  const m = defaultMeta({
    description: block.description ?? '',
    orientation: orientationFromBlock(block),
    ...meta,
    name: meta?.name ?? block.name,
    family: family || tagPrefix(block.name),
    kind,
    ...(kind === 'child' || kind === 'standalone' ? (contact ? { contact } : kind === 'child' ? { contact: 'NO' as const } : {}) : {}),
    attrDefaults: { ...harvestDefaults(block.attributes), ...meta?.attrDefaults },
  });
  return { state: { entities, layers: symbolLayers(), blocks: {}, currentLayer: '0', meta: metaRecord(m) }, meta: m };
}

export interface CompiledPin {
  dir: PinDirection;
  point: Point;
  index: number;
  tag: string;
  default: string;
  /** Explicit marker id, or undefined for a connection detected from the geometry. */
  markerId?: string;
  /** Explicit marker: the direction digit written in its text (may disagree with the geometry after MIRROR / ROTATE). */
  textDir?: PinDirection;
  /** Explicit marker: whether it sits on a geometry endpoint. */
  onEndpoint?: boolean;
  /** Explicit marker: the default written in its text ('' = family default). */
  explicitDefault?: string;
}

/** Geometry entities of a symbol state normalised for a block: layer 0, ByLayer colour unless explicitly coloured, fresh ids. */
export function symbolGeometry(state: DrawingState): Entity[] {
  return state.entities.filter(isSymbolGeometry).map((e) => ({ ...e, id: newId(), layer: '0', color: typeof e.color === 'number' ? e.color : ('ByLayer' as const) }));
}

/** An endpoint of the symbol geometry and the direction the geometry leaves it (unit vector, or null). */
export interface GeometryEndpoint {
  point: Point;
  into: Point | null;
}

const unit = (from: Point, to: Point): Point | null => {
  const d = dist(from, to);
  return d < 1e-9 ? null : { x: (to.x - from.x) / d, y: (to.y - from.y) / d };
};

/** Endpoints of the symbol geometry a pin can sit on: line ends, polyline vertices, arc ends. */
export function geometryEndpoints(entities: readonly Entity[]): GeometryEndpoint[] {
  const out: GeometryEndpoint[] = [];
  for (const e of entities) {
    if (e.type === 'line') out.push({ point: e.a, into: unit(e.a, e.b) }, { point: e.b, into: unit(e.b, e.a) });
    else if (e.type === 'polyline') {
      e.points.forEach((p, i) => {
        const next = e.points[i + 1] ?? e.points[i - 1];
        out.push({ point: p, into: next ? unit(p, next) : null });
      });
    } else if (e.type === 'arc') {
      const at = (a: number): Point => ({ x: e.center.x + e.radius * Math.cos(a), y: e.center.y + e.radius * Math.sin(a) });
      const mid = at((e.startAngle + e.endAngle) / 2);
      for (const p of [at(e.startAngle), at(e.endAngle)]) out.push({ point: p, into: unit(p, mid) });
    }
  }
  return out;
}

const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) < tol;

/**
 * Direction a connection at `p` faces: the symbol edge it sits on (x = -0.375
 * left, +0.375 right, y = +0.375 top, -0.375 bottom); otherwise the wire comes
 * from the side opposite to where the geometry leaves the point (`into`, e.g.
 * a ground symbol's line goes down from its pin, so the pin faces up); with no
 * geometry direction, the sign of the larger coordinate.
 */
export function directionAt(p: Point, into: Point | null = null, tol = 0.01): PinDirection {
  if (near(p.x, -INLINE_HALF, tol)) return 1;
  if (near(p.x, INLINE_HALF, tol)) return 4;
  if (near(p.y, INLINE_HALF, tol)) return 2;
  if (near(p.y, -INLINE_HALF, tol)) return 8;
  if (into) {
    if (Math.abs(into.x) >= Math.abs(into.y)) return into.x > 0 ? 1 : 4;
    return into.y > 0 ? 8 : 2;
  }
  if (Math.abs(p.x) >= Math.abs(p.y)) return p.x < 0 ? 1 : 4;
  return p.y > 0 ? 2 : 8;
}

/** Whether a direction agrees with the side of the symbol a point is on. */
export function directionConsistent(dir: PinDirection, p: Point, tol = 1e-3): boolean {
  switch (dir) {
    case 1:
      return p.x < -tol;
    case 4:
      return p.x > tol;
    case 2:
      return p.y > tol;
    default:
      return p.y < -tol;
  }
}

/** Connections detected from the geometry alone (no marker needed): horizontal at x = +-0.375, vertical at y = +-0.375. */
export function detectedConnections(geometry: readonly Entity[], orientation: SymbolOrientation): Array<{ dir: PinDirection; point: Point }> {
  if (orientation === 'H') return connectionPoints({ name: '', basePoint: { x: 0, y: 0 }, entities: geometry, attributes: [] }).map((c) => ({ dir: c.dir, point: c.point }));
  const out: Array<{ dir: PinDirection; point: Point }> = [];
  const seen = new Set<string>();
  for (const e of geometry) {
    if (e.type !== 'line') continue;
    for (const p of [e.a, e.b]) {
      const dir: PinDirection | null = near(p.y, INLINE_HALF, 1e-6) ? 2 : near(p.y, -INLINE_HALF, 1e-6) ? 8 : null;
      if (!dir) continue;
      const key = `${dir}:${p.x.toFixed(4)},${p.y.toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ dir, point: p });
    }
  }
  out.sort((a, b) => b.point.y - a.point.y || a.point.x - b.point.x);
  return out;
}

/**
 * Wire connections of the symbol: explicit pin markers (direction from the
 * geometry they sit on) plus geometry connections that no marker covers,
 * ordered top to bottom, left before right, and numbered 01.. in that order.
 */
export function compilePins(state: DrawingState, meta: Pick<SymbolMeta, 'name' | 'family'> & Partial<Pick<SymbolMeta, 'orientation'>>): CompiledPin[] {
  const geometry = symbolGeometry(state);
  const endpoints = geometryEndpoints(geometry);
  const markers = state.entities.filter(isPinMarker);
  const pins = defaultPins(meta.family, meta.name);
  const raw: Array<Omit<CompiledPin, 'index' | 'tag'>> = markers.map((m) => {
    const textDir = pinDirection(m.text)!;
    let best: GeometryEndpoint | null = null;
    for (const ep of endpoints) if (dist(ep.point, m.position) < PIN_SNAP_TOL && (!best || dist(ep.point, m.position) < dist(best.point, m.position))) best = ep;
    const onEndpoint = best !== null;
    const dir = best ? directionAt(m.position, best.into) : textDir;
    const explicitDefault = markerDefault(m.text);
    return { dir, point: m.position, markerId: m.id, default: explicitDefault, textDir, onEndpoint, explicitDefault };
  });
  // Detected connections keep the default pin number acadeAttributes would give them (their own order);
  // one that coincides with an explicit marker is replaced by it.
  detectedConnections(geometry, meta.orientation ?? 'H').forEach((c, i) => {
    if (!raw.some((r) => dist(r.point, c.point) < PIN_SNAP_TOL)) raw.push({ dir: c.dir, point: c.point, default: pins[i] ?? '' });
  });
  raw.sort((a, b) => b.point.y - a.point.y || a.point.x - b.point.x || a.dir - b.dir);
  return raw.map((r, i) => ({ ...r, index: i + 1, tag: `X${r.dir}TERM${String(i + 1).padStart(2, '0')}`, default: r.default || pins[i] || String(i + 1) }));
}

/**
 * Marker texts (and label layout) that disagree with the compiled pins, as
 * replacement entities: the controller applies them after every change so the
 * labels on the canvas always show the tag the palette and the saved block use.
 */
export function markerUpdates(state: DrawingState, pins: readonly CompiledPin[]): TextEntity[] {
  const out: TextEntity[] = [];
  for (const p of pins) {
    if (!p.markerId) continue;
    const m = state.entities.find((e) => e.id === p.markerId);
    if (!m || m.type !== 'text') continue;
    const want = markerText(p.tag, p.explicitDefault ?? '');
    const l = markerLayout(p.dir);
    if (m.text !== want || m.align !== l.align || Math.abs(m.rotation - l.rotation) > 1e-9) out.push({ ...m, text: want, align: l.align, rotation: l.rotation });
  }
  return out;
}

/** Attribute placeholders of the state as attribute definitions (visible), with the meta's defaults. */
export function compilePlaceholders(state: DrawingState, meta: Pick<SymbolMeta, 'kind'> & Partial<Pick<SymbolMeta, 'attrDefaults'>>): AttributeDef[] {
  const out: AttributeDef[] = [];
  const seen = new Set<string>();
  const defaults = meta.attrDefaults ?? {};
  for (const t of state.entities.filter(isPlaceholder)) {
    const tag = t.text.trim().toUpperCase();
    if (!tag || seen.has(tag) || isPinTag(tag)) continue;
    seen.add(tag);
    const def = defaults[tag] ?? (tag === 'TAG1' && meta.kind === 'plc' ? 'I:0.0' : '');
    const a: AttributeDef = { tag, prompt: attributePrompt(tag, meta.kind), default: def, position: t.position, height: t.height, align: t.align };
    // Text rotation survives once AttributeDef carries a `rotation` field (see attrRotation); harmless extra property until then.
    if (Math.abs(t.rotation) > 1e-9) (a as { rotation?: number }).rotation = t.rotation;
    out.push(a);
  }
  return out;
}

/**
 * Editing document -> block definition with the full ACADE attribute set.
 * Placeholders become visible attributes, pins (explicit + detected) become the
 * invisible X?TERMnn attributes, then `acadeAttributes` adds the data set and
 * WDTYPE for the symbol kind; DESC2 / DESC3 that were not placed stay invisible
 * (what is placed is what shows), the meta's attribute defaults win, and
 * unknown (vendor) defaults become invisible attributes of their own.
 */
export function symbolStateToBlock(state: DrawingState, meta: SymbolMeta): BlockDef {
  const name = meta.name.toUpperCase();
  const entities = symbolGeometry(state);
  const attrs: AttributeDef[] = compilePlaceholders(state, meta);
  for (const p of compilePins(state, meta)) attrs.push({ tag: p.tag, prompt: `Pin ${p.index}`, default: p.default, position: p.point, height: 0.06, align: 'center', invisible: true });
  const base: BlockDef = { name, description: meta.description, basePoint: { x: 0, y: 0 }, entities, attributes: attrs };
  // acadeAttributes would number the geometry connections on its own; the pins above already cover them.
  const extra = acadeAttributes(base, meta.family.toUpperCase(), wdtypeFor(meta.kind, meta.family))
    .filter((a) => !isPinTag(a.tag))
    .map((a) => {
      const def = meta.attrDefaults[a.tag];
      const auto = a.tag === 'DESC2' || a.tag === 'DESC3';
      return { ...a, ...(auto ? { invisible: true } : {}), ...(def !== undefined && a.tag !== 'WDTYPE' ? { default: def } : {}) };
    });
  const all = [...attrs, ...extra];
  const have = new Set(all.map((a) => a.tag));
  let slot = 0;
  for (const [tag, def] of Object.entries(meta.attrDefaults)) {
    const t = tag.toUpperCase();
    if (have.has(t) || isPinTag(t) || t === 'WDTYPE') continue;
    have.add(t);
    all.push({ tag: t, prompt: t, default: def, position: { x: -0.3 + (slot % 4) * 0.2, y: 0.75 + Math.floor(slot / 4) * 0.1 }, height: 0.07, align: 'center', invisible: true });
    slot += 1;
  }
  return { ...base, attributes: all };
}

export interface HarvestOptions {
  /** Point of the block (block coordinates) that becomes the symbol origin; default the block's base point. */
  basePoint?: Point;
  /** Scale uniformly so the geometry is this wide (0.75 for an inline symbol); undefined keeps the size. */
  scaleToWidth?: number;
}

export type BasePointChoice = 'insert' | 'center' | 'stubs' | 'left' | 'bottom' | 'top';

export const BASE_POINT_CHOICES: Array<[BasePointChoice, string]> = [
  ['insert', 'Block insertion point'],
  ['stubs', 'Midpoint of the wire stubs'],
  ['center', 'Centre of the geometry'],
  ['left', 'Middle of the left edge'],
  ['bottom', 'Bottom centre'],
  ['top', 'Top centre'],
];

const isTextLike = (e: Entity) => e.type === 'text' || e.type === 'mtext';

/** Bounds of the drawn geometry only (inserts exploded, text ignored). */
export function geometryBounds(entities: readonly Entity[], lookup: (name: string) => BlockDef | undefined): Bounds | null {
  return boundsOfEntities(explodeAll(entities, lookup).filter((e) => !isTextLike(e)), lookup);
}

/**
 * Resolve a base-point choice against some entities (block coordinates):
 * text is ignored so a part number under the symbol does not shift the centre;
 * "stubs" is the midpoint between the leftmost and the rightmost line endpoint
 * (the wire level of an inline symbol).
 */
export function resolveBasePoint(choice: BasePointChoice, entities: readonly Entity[], lookup: (name: string) => BlockDef | undefined, insertion: Point): Point {
  if (choice === 'insert') return insertion;
  const geometry = explodeAll(entities, lookup).filter((e) => !isTextLike(e));
  if (choice === 'stubs') {
    const pts = geometryEndpoints(geometry.filter((e) => e.type === 'line')).map((ep) => ep.point);
    if (pts.length >= 2) {
      let l = pts[0]!;
      let r = pts[0]!;
      for (const p of pts) {
        if (p.x < l.x - 1e-9 || (near(p.x, l.x, 1e-9) && Math.abs(p.y) < Math.abs(l.y))) l = p;
        if (p.x > r.x + 1e-9 || (near(p.x, r.x, 1e-9) && Math.abs(p.y) < Math.abs(r.y))) r = p;
      }
      return { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
    }
  }
  const bounds = boundsOfEntities(geometry, lookup);
  if (!bounds) return insertion;
  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cy = (bounds.min.y + bounds.max.y) / 2;
  switch (choice) {
    case 'left':
      return { x: bounds.min.x, y: cy };
    case 'bottom':
      return { x: cx, y: bounds.min.y };
    case 'top':
      return { x: cx, y: bounds.max.y };
    default:
      return { x: cx, y: cy };
  }
}

export function boundsOfEntities(entities: readonly Entity[], lookup: (name: string) => BlockDef | undefined): Bounds | null {
  let b: Bounds | null = null;
  for (const e of entities) b = unionBounds(b, entityBounds(e, lookup));
  return b;
}

/** Explode inserts (recursively) into primitives; other entities pass through. */
export function explodeAll(entities: readonly Entity[], lookup: (name: string) => BlockDef | undefined): Entity[] {
  const out: Entity[] = [];
  for (const e of entities) {
    if (e.type === 'insert') out.push(...explodeInsert(e, lookup, 1).map((x) => ({ ...x, id: newId() })));
    else out.push({ ...e, id: newId() });
  }
  return out;
}

/** Snap line / polyline endpoints within `tol` of the wire level (y = 0) and the stub ends (x = +-0.375) exactly onto them. */
export function snapStubEndpoints(entities: readonly Entity[], tol = HARVEST_SNAP_TOL): Entity[] {
  const snapPt = (p: Point): Point => {
    let { x, y } = p;
    if (Math.abs(y) < tol) y = 0;
    if (Math.abs(x - INLINE_HALF) < tol) x = INLINE_HALF;
    else if (Math.abs(x + INLINE_HALF) < tol) x = -INLINE_HALF;
    return x === p.x && y === p.y ? p : { x, y };
  };
  return entities.map((e) => {
    if (e.type === 'line') {
      const a = snapPt(e.a);
      const b = snapPt(e.b);
      return a === e.a && b === e.b ? e : { ...e, a, b };
    }
    if (e.type === 'polyline' && e.points.length > 1) {
      const pts = [...e.points];
      pts[0] = snapPt(pts[0]!);
      pts[pts.length - 1] = snapPt(pts[pts.length - 1]!);
      return { ...e, points: pts };
    }
    return e;
  });
}

/** Move entities so `base` becomes the origin and optionally scale them to a width (then snap the stub ends). */
function normalise(entities: Entity[], base: Point, lookup: (name: string) => BlockDef | undefined, scaleToWidth?: number): { entities: Entity[]; scale: number } {
  let list = entities.map((e) => translateEntity(e, { x: -base.x, y: -base.y }));
  let scale = 1;
  if (scaleToWidth && scaleToWidth > 0) {
    // Measure the geometry only: placeholder / pin texts are not part of the symbol's width.
    const b = boundsOfEntities(list.filter((e) => isSymbolGeometry(e) && !isTextLike(e)), lookup);
    const w = b ? b.max.x - b.min.x : 0;
    if (w > 1e-9) {
      scale = scaleToWidth / w;
      list = list.map((e) => scaleEntityBy(e, { x: 0, y: 0 }, scale));
      list = snapStubEndpoints(list);
    }
  }
  return { entities: list, scale };
}

/**
 * Harvest a block of a drawing (typically from a manufacturer DWG) into a
 * symbol state: nested inserts are exploded into primitives, attribute
 * definitions with known ACADE tags become placeholders (visible) or pin
 * markers (X?TERM, carrying their pin numbers), every attribute default
 * (visible or invisible, vendor-specific ones included) is kept in
 * `attrDefaults`, unknown visible attributes keep their default text as plain
 * text, and the geometry is moved so the chosen base point is the origin (and
 * optionally scaled to the inline width).
 */
export function harvestBlock(state: DrawingState, blockName: string, opts: HarvestOptions = {}): SymbolState | null {
  const def = state.blocks[blockName];
  if (!def) return null;
  const lookup = (n: string) => state.blocks[n];
  const base = opts.basePoint ?? def.basePoint;
  const geometry = explodeAll(def.entities, lookup).filter((e) => e.type !== 'text' || (e.layer !== SYMATTR_LAYER && e.layer !== SYMPIN_LAYER));
  const markers: Entity[] = [];
  for (const a of def.attributes) {
    const tag = a.tag.toUpperCase();
    if (isPinTag(tag)) markers.push(pinMarkerText(tag, a.position, a.default));
    else if (!a.invisible && KNOWN_ATTRIBUTES.has(tag)) markers.push(text(SYMATTR_LAYER, a.position, tag, a.height, a.align, attrRotation(a)));
    else if (!a.invisible && a.default.trim()) geometry.push(text('0', a.position, a.default, a.height, a.align, attrRotation(a)));
  }
  const norm = normalise([...geometry, ...markers], base, lookup, opts.scaleToWidth);
  // Marker text keeps a readable size after scaling.
  const entities = norm.entities.map((e) => (e.type === 'text' && (e.layer === SYMATTR_LAYER || e.layer === SYMPIN_LAYER) ? { ...e, height: e.layer === SYMPIN_LAYER ? 0.05 : Math.max(0.05, Math.min(0.2, e.height)) } : e));
  const kind = kindFromBlock(def);
  const attrDefaults = harvestDefaults(def.attributes);
  // Unknown visible attributes stay as plain text on the symbol; do not duplicate them as invisible attributes.
  for (const a of def.attributes) if (!a.invisible && !KNOWN_ATTRIBUTES.has(a.tag.toUpperCase())) delete attrDefaults[a.tag.toUpperCase()];
  const meta = defaultMeta({
    name: blockName,
    description: def.description ?? '',
    kind,
    orientation: orientationFromBlock(def),
    ...(kind === 'child' ? { contact: /_NC$/.test(blockName) ? ('NC' as const) : ('NO' as const) } : {}),
    attrDefaults,
  });
  return { state: { entities, layers: symbolLayers(), blocks: {}, currentLayer: '0', meta: metaRecord(meta) }, meta };
}

/** Selected drawing objects -> symbol state (inserts exploded, base point to the origin, optional scale). */
export function fromSelection(entities: readonly Entity[], basePoint: Point, lookup: (name: string) => BlockDef | undefined, opts: { scaleToWidth?: number } = {}): SymbolState {
  const exploded = explodeAll(entities, lookup);
  const norm = normalise(exploded, basePoint, lookup, opts.scaleToWidth);
  const meta = defaultMeta({ name: 'USER1' });
  return { state: { entities: norm.entities, layers: symbolLayers(), blocks: {}, currentLayer: '0', meta: metaRecord(meta) }, meta };
}

// ---------------------------------------------------------------- variants

/** Name of the vertical variant: HPB11_NO -> VPB11_NO, USER_PB1 -> USER_PB1_V, USER_K1_NO -> USER_K1_V_NO. */
export function verticalName(name: string): string {
  const n = name.toUpperCase();
  if (/^H[A-Z]{1,4}\d/.test(n)) return `V${n.slice(1)}`;
  const m = /^(.*?)(_N[OC])$/.exec(n);
  return m ? `${m[1]}_V${m[2]}` : `${n}_V`;
}

/**
 * The vertical variant of a horizontal symbol: geometry rotated -90 degrees
 * about the origin (the left stub goes to the top, the right one to the
 * bottom), pin markers follow and are relabelled top / bottom, the known
 * attribute placeholders move to the vertical template positions, other
 * placeholders keep their rotated position but stay readable.
 */
export function verticalVariant(sym: SymbolState): SymbolState {
  const meta = defaultMeta({ ...sym.meta, name: verticalName(sym.meta.name), orientation: 'V' });
  const swap: Record<number, PinDirection> = { 1: 2, 4: 8, 2: 4, 8: 1 };
  const entities: Entity[] = sym.state.entities.map((e) => {
    const role = isPinMarker(e) ? 'pin' : isPlaceholder(e) ? 'attr' : 'geometry';
    const rotated = rotateEntity(e, { x: 0, y: 0 }, -Math.PI / 2);
    if (role === 'attr') {
      const t = e as TextEntity;
      const tag = t.text.trim().toUpperCase();
      if (['TAG1', 'DESC1', 'DESC2', 'DESC3', 'TERM01'].includes(tag)) {
        const d = attributeDefaults(tag, 'V');
        return { ...t, id: newId(), position: d.position, align: d.align, rotation: 0 };
      }
      return { ...(rotated as TextEntity), id: newId(), rotation: 0 };
    }
    if (role === 'pin') {
      const t = e as TextEntity;
      const dir = swap[pinDirection(t.text) ?? 1]!;
      const l = markerLayout(dir);
      const tag = markerTag(t.text).replace(/^X\d/, `X${dir}`);
      return { ...(rotated as TextEntity), id: newId(), text: markerText(tag, markerDefault(t.text)), align: l.align, rotation: l.rotation };
    }
    return { ...rotated, id: newId() };
  });
  return { state: { ...sym.state, entities, meta: metaRecord(meta) }, meta };
}

/** NO <-> NC of a block name: USER_LS1_NO -> USER_LS1_NC; a name without suffix gets _NC. */
export function twinName(name: string): string {
  const n = name.toUpperCase();
  if (/_NO$/.test(n)) return n.replace(/_NO$/, '_NC');
  if (/_NC$/.test(n)) return n.replace(/_NC$/, '_NO');
  return `${n}_NC`;
}

/** Swap the standard NO / NC pin numbers (13/14 <-> 11/12, 23/24 <-> 21/22 ...). */
export function twinPin(pin: string): string {
  const m = /^(\d)([1-4])$/.exec(pin.trim());
  if (!m) return pin;
  const map: Record<string, string> = { '1': '3', '2': '4', '3': '1', '4': '2' };
  return `${m[1]}${map[m[2]!]}`;
}

/** Description wording of the twin: "normally open" <-> "normally closed", " NO" <-> " NC". */
export function twinDescription(desc: string, to: 'NO' | 'NC'): string {
  const from = to === 'NO' ? 'NC' : 'NO';
  return desc
    .replace(/normally\s+(open|closed)/gi, (m) => (to === 'NO' ? 'normally open' : 'normally closed').replace(/^n/, m.charAt(0)))
    .replace(new RegExp(`(^|[\\s,(/-])${from}(?=$|[\\s,)/.-])`, 'g'), `$1${to}`);
}

const GAP = 0.125;
/** The NC blade of the standard contact (HCR1_NC): a diagonal line across the gap. */
const isBladeLine = (e: Entity): e is LineEntity => e.type === 'line' && Math.abs(e.a.x - e.b.x) > GAP && Math.abs(e.a.y - e.b.y) > 0.1 && Math.abs(e.a.x + e.b.x) < 0.05 && Math.abs(e.a.y + e.b.y) < 0.05;
const hasContactGap = (entities: readonly Entity[]): boolean => {
  const vertical = (x: number) => entities.some((e) => e.type === 'line' && near(e.a.x, e.b.x, 1e-6) && near(e.a.x, x, 1e-3) && Math.abs(e.a.y - e.b.y) > 0.1);
  return vertical(-GAP) && vertical(GAP);
};

/**
 * The NO / NC twin of a symbol: name with the suffix swapped, contact flag and
 * default pin numbers swapped, description reworded; for the standard contact
 * geometry (two verticals at x = +-0.125) the NC blade line is added or removed.
 */
export function createTwin(sym: SymbolState): SymbolState {
  const to: 'NO' | 'NC' = sym.meta.contact === 'NC' || /_NC$/.test(sym.meta.name) ? 'NO' : 'NC';
  const meta = defaultMeta({ ...sym.meta, name: twinName(sym.meta.name), contact: to, description: twinDescription(sym.meta.description, to) });
  let entities: Entity[] = sym.state.entities.map((e) => {
    const copy = { ...e, id: newId() };
    if (isPinMarker(copy)) {
      const def = markerDefault(copy.text);
      return def ? { ...copy, text: markerText(markerTag(copy.text), twinPin(def)) } : copy;
    }
    return copy;
  });
  if (hasContactGap(entities.filter(isSymbolGeometry))) {
    if (to === 'NC' && !entities.some(isBladeLine)) entities.push({ id: newId(), layer: '0', color: 'ByLayer', type: 'line', a: { x: -GAP - 0.05, y: -0.16 }, b: { x: GAP + 0.05, y: 0.16 } });
    else if (to === 'NO') entities = entities.filter((e) => !isBladeLine(e));
  }
  return { state: { ...sym.state, entities, meta: metaRecord(meta) }, meta };
}

// ---------------------------------------------------------------- check

export interface CheckMessage {
  level: 'error' | 'warning' | 'info' | 'ok';
  text: string;
}

export interface CheckOptions {
  /** Names of built-in library symbols (collisions are errors). */
  isBuiltin(name: string): boolean;
  /** Names of user symbols (a collision is fine when it is the symbol being edited). */
  isUser(name: string): boolean;
  /** Name the session started with (editing an existing user symbol). */
  editingName?: string | null;
  validName(name: string): boolean;
  /** Whether a parent / coil symbol of a family exists (child contacts need one to cross-reference). */
  hasParent?(family: string): boolean;
}

const fmtPt = (p: Point) => `(${p.x.toFixed(3)}, ${p.y.toFixed(3)})`;

/** Validation shown by the palette's Check button and run before saving. */
export function checkSymbol(state: DrawingState, meta: SymbolMeta, opts: CheckOptions): CheckMessage[] {
  const out: CheckMessage[] = [];
  const name = meta.name.trim().toUpperCase();
  const orientation = meta.orientation ?? 'H';
  if (!name) out.push({ level: 'error', text: 'The symbol needs a block name.' });
  else if (/\s/.test(name)) out.push({ level: 'error', text: `"${name}" contains whitespace; use _ instead (AECOMPONENT <name> and "Type it" cannot take spaces).` });
  else if (!opts.validName(name)) out.push({ level: 'error', text: `"${name}" is not a valid block name (no <>/\\":;?*|,=\` characters).` });
  else if (opts.isBuiltin(name)) out.push({ level: 'error', text: `"${name}" is a built-in library symbol; choose another name.` });
  else if (opts.isUser(name) && name !== (opts.editingName ?? '').toUpperCase()) out.push({ level: 'warning', text: `"${name}" already exists in the user library and will be replaced.` });
  if (meta.kind === 'child' && !/_N[OC]$/.test(name)) out.push({ level: 'warning', text: 'Child contact names should end in _NO or _NC (Toggle NO/NC and the default pins 13/14, 11/12 use it).' });
  if (meta.standard === 'JIC' && /^IEC_/.test(name)) out.push({ level: 'warning', text: 'The name starts with IEC_ but the standard is JIC; IEC symbols are listed under the IEC icon menu.' });
  if (meta.standard === 'IEC' && /^[HV][A-Z]{1,4}\d/.test(name) && !/^IEC_/.test(name)) out.push({ level: 'warning', text: 'The name looks like a JIC library name (H.. / V..) but the standard is IEC; consider an IEC_ prefix.' });
  if (!meta.family.trim()) out.push({ level: 'error', text: 'Set a family (tag prefix), e.g. PB, CR, LS.' });
  if (meta.kind === 'child' && opts.hasParent && meta.family.trim() && !opts.hasParent(meta.family.trim().toUpperCase())) {
    out.push({ level: 'warning', text: `No parent / coil symbol of family ${meta.family.toUpperCase()} exists (built-in or user library); the contact will have nothing to cross-reference.` });
  }
  const rawGeometry = state.entities.filter(isSymbolGeometry);
  const offLayer = rawGeometry.filter((e) => e.layer !== '0');
  if (offLayer.length) out.push({ level: 'info', text: `${offLayer.length} object(s) on layer ${[...new Set(offLayer.map((e) => e.layer))].join(', ')} will be moved to layer 0 in the symbol.` });
  const geometry = symbolGeometry(state);
  if (geometry.length === 0) out.push({ level: 'error', text: 'The symbol has no geometry.' });
  const b = boundsOfEntities(geometry, () => undefined);
  if (b && (Math.abs(b.min.x) > 2 || Math.abs(b.max.x) > 2 || Math.abs(b.min.y) > 2 || Math.abs(b.max.y) > 2)) {
    out.push({ level: 'error', text: `Geometry extends to ${Math.max(Math.abs(b.min.x), Math.abs(b.max.x), Math.abs(b.min.y), Math.abs(b.max.y)).toFixed(2)} in from the origin; symbols should stay within +-2 in (use SCALE / MOVE).` });
  }
  const pins = compilePins(state, meta);
  if (pins.length === 0) {
    out.push({ level: 'error', text: orientation === 'V' ? 'No wire connection: end a line at y = +-0.375 on x = 0 or add an explicit pin.' : 'No wire connection: end a line at x = +-0.375 on y = 0 or add an explicit pin.' });
  }
  const inline = orientation === 'V' ? pins.some((p) => Math.abs(Math.abs(p.point.y) - INLINE_HALF) < 1e-4 && Math.abs(p.point.x) < 1e-4) : pins.some((p) => Math.abs(Math.abs(p.point.x) - INLINE_HALF) < 1e-4 && Math.abs(p.point.y) < 1e-4);
  if (pins.length > 0 && !inline && meta.kind !== 'terminal') {
    out.push({ level: 'warning', text: orientation === 'V' ? 'Nothing connects at (0, +-0.375): a vertical device should have its wire stubs end there so it breaks the wire it is dropped on.' : 'Nothing connects at (+-0.375, 0): an inline device should have its wire stubs end there so it breaks the wire it is dropped on.' });
  }
  for (let i = 0; i < pins.length; i += 1) {
    const p = pins[i]!;
    for (let j = i + 1; j < pins.length; j += 1) {
      const q = pins[j]!;
      if (dist(p.point, q.point) < PIN_SNAP_TOL) out.push({ level: 'error', text: `Two pins on one point ${fmtPt(p.point)}: ${p.tag} and ${q.tag}. Remove one marker.` });
    }
    if (!directionConsistent(p.dir, p.point)) {
      const side = PIN_DIRECTIONS.find(([d]) => d === p.dir)?.[1].toLowerCase();
      out.push({ level: 'error', text: `${p.tag} is a ${side} pin but sits at ${fmtPt(p.point)}; move it to the ${side} edge or add it with the right direction.` });
    }
    if (p.markerId && !p.onEndpoint) out.push({ level: 'warning', text: `Pin ${p.tag} at ${fmtPt(p.point)} is not on a line end; wires will connect to a point with no geometry.` });
  }
  const placeholders = compilePlaceholders(state, meta);
  const tags = new Set(placeholders.map((a) => a.tag));
  if (meta.kind === 'terminal') {
    if (!tags.has('TERM01')) out.push({ level: 'error', text: 'A terminal needs a TERM01 attribute (palette: Attributes, pick TERM01, Add or Place).' });
  } else if (!tags.has('TAG1')) out.push({ level: 'error', text: 'Place a TAG1 attribute (palette: Attributes, pick TAG1, Add or Place) so the component can be tagged.' });
  if (!tags.has('DESC1') && meta.kind !== 'terminal') out.push({ level: 'warning', text: 'No DESC1 attribute: descriptions will not show on the drawing.' });
  const tag1 = placeholders.find((a) => a.tag === 'TAG1');
  if (tag1 && b && tag1.position.x > b.min.x - 1e-6 && tag1.position.x < b.max.x + 1e-6 && tag1.position.y > b.min.y - 1e-6 && tag1.position.y < b.max.y + 1e-6 && Math.abs(tag1.position.x) < INLINE_HALF && Math.abs(tag1.position.y) < INLINE_HALF) {
    out.push({ level: 'warning', text: `TAG1 at ${fmtPt(tag1.position)} sits on the geometry inside the 0.75 in box; the tag text will print over the symbol.` });
  }
  const unknownText = state.entities.filter(isPlaceholder).filter((t) => !KNOWN_ATTRIBUTES.has(t.text.trim().toUpperCase()));
  for (const t of unknownText) out.push({ level: 'warning', text: `Placeholder "${t.text}" is not a known ACADE attribute; it becomes a custom attribute.` });
  const tagLikeText = rawGeometry.filter((e): e is TextEntity => e.type === 'text' && (KNOWN_ATTRIBUTES.has(e.text.trim().toUpperCase()) || isPinTag(e.text)));
  for (const t of tagLikeText) out.push({ level: 'warning', text: `Text "${t.text.trim()}" on layer ${t.layer} looks like an attribute tag but is plain geometry; select it and use "Convert selected text to attribute".` });
  const badPins = state.entities.filter((e) => e.type === 'text' && e.layer === SYMPIN_LAYER && !isPinTag(e.text));
  for (const t of badPins) out.push({ level: 'warning', text: `Text "${(t as TextEntity).text}" on ${SYMPIN_LAYER} is not a pin tag (X1TERM01 ...) and is ignored.` });
  if (!out.some((m) => m.level === 'error' || m.level === 'warning')) out.unshift({ level: 'ok', text: `OK: ${geometry.length} object(s), ${pins.length} wire connection(s), ${placeholders.length} visible attribute(s).` });
  return out;
}

/** Counts of a check result for badges ("2 errors, 1 warning"). */
export function summarizeCheck(msgs: readonly CheckMessage[]): { errors: number; warnings: number; text: string } {
  const errors = msgs.filter((m) => m.level === 'error').length;
  const warnings = msgs.filter((m) => m.level === 'warning').length;
  const parts: string[] = [];
  if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  return { errors, warnings, text: parts.length ? parts.join(', ') : 'OK' };
}

/** Suggest a free block name like USER_PB1. */
export function suggestSymbolName(family: string, exists: (name: string) => boolean): string {
  const fam = (family.trim().toUpperCase() || 'DEV').replace(/[^A-Z0-9]/g, '');
  for (let i = 1; i < 1000; i += 1) {
    const n = `USER_${fam}${i}`;
    if (!exists(n)) return n;
  }
  return `USER_${fam}_${Date.now()}`;
}

/** Block name typed by the user: upper case, whitespace becomes `_`. */
export function normalizeSymbolName(name: string): string {
  return name.toUpperCase().replace(/\s+/g, '_');
}

/** How saving under a new name while editing an existing symbol should proceed. */
export type RenameChoice = 'rename' | 'copy' | 'cancel';

/**
 * Apply a rename choice before the new symbol is stored: `rename` removes the
 * old entry (through `lib.rename`, which keeps its dates / category) so `put`
 * of the new block replaces it; `copy` keeps the old one; `cancel` aborts.
 * Returns the message to log, or null when cancelled.
 */
export function applyRenameChoice(choice: RenameChoice, oldName: string, newName: string, lib: { has(name: string): boolean; rename(oldName: string, newName: string): boolean; remove(name: string): boolean }): string | null {
  if (choice === 'cancel') return null;
  if (choice === 'copy') return `Saved as a new symbol ${newName}; ${oldName} is kept in the library.`;
  if (lib.has(newName)) {
    lib.remove(oldName);
    return `${newName} already existed and is replaced; ${oldName} is removed from the library.`;
  }
  return lib.rename(oldName, newName) ? `${oldName} renamed to ${newName}.` : `Saved as a new symbol ${newName}; ${oldName} could not be renamed.`;
}
