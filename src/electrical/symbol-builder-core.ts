/**
 * Symbol Builder conversions (pure, unit-tested).
 *
 * A symbol is edited as an ordinary drawing ("symbol state") in inches around
 * the origin:
 *  - geometry on layer `0` (any drafting command works on it),
 *  - attribute placeholders: TEXT entities on layer SYMATTR whose text is the
 *    attribute tag (TAG1, DESC1, TERM01 ...); position / height / justification
 *    of the text become those of the attribute definition,
 *  - explicit wire-connection pins: TEXT entities on layer SYMPIN whose text is
 *    a pin tag (X1TERM01 ...); the first digit is the ACADE direction
 *    (1 left, 2 top, 4 right, 8 bottom). Connections are also detected from
 *    the geometry (line endpoints at x = +-0.375, see `connectionPoints`).
 *
 * `symbolStateToBlock` compiles that state into a BlockDef with the full
 * AutoCAD Electrical attribute set; `blockToSymbolState` does the reverse so
 * a library or user symbol can be opened for editing; `harvestBlock` and
 * `fromSelection` turn blocks of a drawing (e.g. manufacturer DWGs) or a
 * selection into a symbol state.
 */
import type { AttributeDef, BlockDef, Entity, Layer, TextEntity } from '../core/entities';
import { newId, explodeInsert, translateEntity, scaleEntityBy, entityBounds } from '../core/entities';
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

export type SymbolKind = 'parent' | 'child' | 'standalone' | 'terminal' | 'plc';
export type PinDirection = 1 | 2 | 4 | 8;

export const SYMBOL_KINDS: Array<[SymbolKind, string]> = [
  ['parent', 'Parent / coil (WDTYPE COIL)'],
  ['child', 'Child contact (WDTYPE CONTACT)'],
  ['standalone', 'Standalone device (WDTYPE = family)'],
  ['terminal', 'Terminal (TERM01 + TAGSTRIP)'],
  ['plc', 'PLC I/O point (WDTYPE PLC)'],
];

export const PIN_DIRECTIONS: Array<[PinDirection, string]> = [
  [1, 'Left'],
  [2, 'Top'],
  [4, 'Right'],
  [8, 'Bottom'],
];

/** Short kind labels for narrow controls (palette). */
export const SYMBOL_KIND_SHORT: Array<[SymbolKind, string]> = [
  ['parent', 'Parent / coil'],
  ['child', 'Child contact'],
  ['standalone', 'Standalone device'],
  ['terminal', 'Terminal'],
  ['plc', 'PLC I/O point'],
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
  /** Child contacts: normally open / closed variant (the name ends in _NO / _NC). */
  contact?: 'NO' | 'NC';
  /** Default pin numbers of explicit pin markers, keyed by the marker entity id. */
  pinDefaults: Record<string, string>;
}

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
const KNOWN_ATTRIBUTES = new Set<string>([...PLACEABLE_ATTRIBUTES, ...AUTOMATIC_ATTRIBUTES, 'TAG1', 'DESC1']);

const PIN_RE = /^X([1248])TERM(\d*)$/i;
export const isPinTag = (tag: string): boolean => PIN_RE.test(tag);
export const pinDirection = (tag: string): PinDirection | null => {
  const m = PIN_RE.exec(tag);
  return m ? (parseInt(m[1]!, 10) as PinDirection) : null;
};

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

/** Default text height and position for a newly placed attribute placeholder. */
export function attributeDefaults(tag: string): { height: number; position: Point } {
  switch (tag) {
    case 'TAG1':
      return { height: 0.125, position: { x: 0, y: 0.3 } };
    case 'DESC1':
      return { height: 0.1, position: { x: 0, y: -0.45 } };
    case 'DESC2':
      return { height: 0.1, position: { x: 0, y: -0.58 } };
    case 'DESC3':
      return { height: 0.1, position: { x: 0, y: -0.71 } };
    case 'TERM01':
      return { height: 0.08, position: { x: 0, y: 0.15 } };
    default:
      return { height: 0.07, position: { x: 0, y: -0.3 } };
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
export const isPinMarker = (e: Entity): e is TextEntity => e.type === 'text' && e.layer === SYMPIN_LAYER && isPinTag(e.text.trim());
export const isSymbolGeometry = (e: Entity): boolean => e.layer !== SYMATTR_LAYER && e.layer !== SYMPIN_LAYER;

/** A new attribute placeholder text (the palette's Place button). */
export function placeholderEntity(tag: string, position?: Point, height?: number): TextEntity {
  const d = attributeDefaults(tag);
  return text(SYMATTR_LAYER, position ?? d.position, tag.toUpperCase(), height ?? d.height);
}

/** Pin marker text at a connection point; the label extends away from the symbol (left pins read to the left ...). */
export function pinMarkerText(tag: string, position: Point): TextEntity {
  const dir = pinDirection(tag);
  return text(SYMPIN_LAYER, position, tag.toUpperCase(), 0.05, dir === 1 ? 'right' : dir === 4 ? 'left' : 'center');
}

/** A new explicit pin marker (the palette's Add pin button). */
export function pinMarkerEntity(dir: PinDirection, position: Point, index: number): TextEntity {
  return pinMarkerText(`X${dir}TERM${String(index).padStart(2, '0')}`, position);
}

export interface SymbolState {
  state: DrawingState;
  meta: SymbolMeta;
}

/** Blank editing document (only layers). */
export function blankSymbolState(): DrawingState {
  return { entities: [], layers: symbolLayers(), blocks: {}, currentLayer: '0' };
}

/** Meta with defaults filled in. */
export function defaultMeta(partial: Partial<SymbolMeta> & { name: string }): SymbolMeta {
  return {
    description: '',
    standard: 'JIC',
    category: 'User symbols',
    family: 'DEV',
    kind: 'standalone',
    pinDefaults: {},
    ...partial,
    name: partial.name.toUpperCase(),
  };
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

/**
 * Library / user block -> editing document. Geometry keeps its layer (library
 * geometry is on `0`), visible attributes become placeholders, every X?TERM
 * attribute becomes an explicit pin marker (so its pin number is editable;
 * markers that coincide with a geometry connection replace the auto pin).
 */
export function blockToSymbolState(block: BlockDef, meta?: Partial<SymbolMeta>): SymbolState {
  const shift = { x: -block.basePoint.x, y: -block.basePoint.y };
  const entities: Entity[] = block.entities.map((e) => ({ ...translateEntity(e, shift), id: newId() }));
  const pinDefaults: Record<string, string> = {};
  for (const a of block.attributes) {
    const p = { x: a.position.x + shift.x, y: a.position.y + shift.y };
    if (isPinTag(a.tag)) {
      const t = pinMarkerText(a.tag, p);
      pinDefaults[t.id] = a.default;
      entities.push(t);
    } else if (!a.invisible) {
      entities.push(text(SYMATTR_LAYER, p, a.tag, a.height, a.align));
    }
  }
  const kind = meta?.kind ?? kindFromBlock(block);
  const contact = meta?.contact ?? (/_NC$/.test(block.name) ? 'NC' : /_NO$/.test(block.name) ? 'NO' : undefined);
  const family = meta?.family ?? (block.attributes.find((a) => a.tag === 'WDTYPE')?.default.match(/^(COIL|CONTACT|TERM|PLC)$/) ? tagPrefix(block.name) : block.attributes.find((a) => a.tag === 'WDTYPE')?.default) ?? tagPrefix(block.name);
  return {
    state: { entities, layers: symbolLayers(), blocks: {}, currentLayer: '0' },
    meta: defaultMeta({ description: block.description ?? '', ...meta, name: meta?.name ?? block.name, family: family || tagPrefix(block.name), kind, ...(kind === 'child' ? { contact: contact ?? 'NO' } : {}), pinDefaults }),
  };
}

export interface CompiledPin {
  dir: PinDirection;
  point: Point;
  index: number;
  tag: string;
  default: string;
  /** Explicit marker id, or undefined for a connection detected from the geometry. */
  markerId?: string;
}

/** Geometry entities of a symbol state normalised for a block: layer 0, ByLayer colour unless explicitly coloured, fresh ids. */
export function symbolGeometry(state: DrawingState): Entity[] {
  return state.entities.filter(isSymbolGeometry).map((e) => ({ ...e, id: newId(), layer: '0', color: typeof e.color === 'number' ? e.color : ('ByLayer' as const) }));
}

/**
 * Wire connections of the symbol: explicit pin markers plus geometry
 * connections that no marker covers, ordered like `connectionPoints`
 * (top to bottom, left before right) and numbered 01.. in that order.
 */
export function compilePins(state: DrawingState, meta: Pick<SymbolMeta, 'name' | 'family' | 'pinDefaults'>): CompiledPin[] {
  const geometry = symbolGeometry(state);
  const markers = state.entities.filter(isPinMarker);
  const pins = defaultPins(meta.family, meta.name);
  const raw: Array<Omit<CompiledPin, 'index' | 'tag'>> = markers.map((m) => ({ dir: pinDirection(m.text.trim())!, point: m.position, markerId: m.id, default: meta.pinDefaults[m.id] ?? '' }));
  // Detected connections keep the default pin number acadeAttributes would give them (their own order);
  // one that coincides with an explicit marker is replaced by it.
  connectionPoints({ name: meta.name, basePoint: { x: 0, y: 0 }, entities: geometry, attributes: [] }).forEach((c, i) => {
    if (!raw.some((r) => dist(r.point, c.point) < 1e-4)) raw.push({ dir: c.dir, point: c.point, default: pins[i] ?? '' });
  });
  raw.sort((a, b) => b.point.y - a.point.y || a.point.x - b.point.x || a.dir - b.dir);
  return raw.map((r, i) => ({ ...r, index: i + 1, tag: `X${r.dir}TERM${String(i + 1).padStart(2, '0')}`, default: r.default || pins[i] || String(i + 1) }));
}

/** Attribute placeholders of the state as attribute definitions (visible). */
export function compilePlaceholders(state: DrawingState, meta: Pick<SymbolMeta, 'kind'>): AttributeDef[] {
  const out: AttributeDef[] = [];
  const seen = new Set<string>();
  for (const t of state.entities.filter(isPlaceholder)) {
    const tag = t.text.trim().toUpperCase();
    if (!tag || seen.has(tag) || isPinTag(tag)) continue;
    seen.add(tag);
    out.push({ tag, prompt: attributePrompt(tag, meta.kind), default: tag === 'TAG1' && meta.kind === 'plc' ? 'I:0.0' : '', position: t.position, height: t.height, align: t.align });
  }
  return out;
}

/**
 * Editing document -> block definition with the full ACADE attribute set.
 * Placeholders become visible attributes, pins (explicit + detected) become the
 * invisible X?TERMnn attributes, then `acadeAttributes` adds the data set and
 * WDTYPE for the symbol kind.
 */
export function symbolStateToBlock(state: DrawingState, meta: SymbolMeta): BlockDef {
  const name = meta.name.toUpperCase();
  const entities = symbolGeometry(state);
  const attrs: AttributeDef[] = compilePlaceholders(state, meta);
  for (const p of compilePins(state, meta)) attrs.push({ tag: p.tag, prompt: `Pin ${p.index}`, default: p.default, position: p.point, height: 0.06, align: 'center', invisible: true });
  const base: BlockDef = { name, description: meta.description, basePoint: { x: 0, y: 0 }, entities, attributes: attrs };
  // acadeAttributes would number the geometry connections on its own; the pins above already cover them.
  const extra = acadeAttributes(base, meta.family.toUpperCase(), wdtypeFor(meta.kind, meta.family)).filter((a) => !isPinTag(a.tag));
  return extra.length ? { ...base, attributes: [...attrs, ...extra] } : base;
}

export interface HarvestOptions {
  /** Point of the block (block coordinates) that becomes the symbol origin; default the block's base point. */
  basePoint?: Point;
  /** Scale uniformly so the geometry is this wide (0.75 for an inline symbol); undefined keeps the size. */
  scaleToWidth?: number;
}

export type BasePointChoice = 'insert' | 'center' | 'left' | 'bottom' | 'top';

/** Resolve a base-point choice against the bounds of some entities. */
export function resolveBasePoint(choice: BasePointChoice, bounds: Bounds | null, insertion: Point): Point {
  if (choice === 'insert' || !bounds) return insertion;
  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cy = (bounds.min.y + bounds.max.y) / 2;
  switch (choice) {
    case 'center':
      return { x: cx, y: cy };
    case 'left':
      return { x: bounds.min.x, y: cy };
    case 'bottom':
      return { x: cx, y: bounds.min.y };
    case 'top':
      return { x: cx, y: bounds.max.y };
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

/** Move entities so `base` becomes the origin and optionally scale them to a width. */
function normalise(entities: Entity[], base: Point, lookup: (name: string) => BlockDef | undefined, scaleToWidth?: number): { entities: Entity[]; scale: number } {
  let list = entities.map((e) => translateEntity(e, { x: -base.x, y: -base.y }));
  let scale = 1;
  if (scaleToWidth && scaleToWidth > 0) {
    // Measure the geometry only: placeholder / pin texts are not part of the symbol's width.
    const b = boundsOfEntities(list.filter(isSymbolGeometry), lookup);
    const w = b ? b.max.x - b.min.x : 0;
    if (w > 1e-9) {
      scale = scaleToWidth / w;
      list = list.map((e) => scaleEntityBy(e, { x: 0, y: 0 }, scale));
    }
  }
  return { entities: list, scale };
}

/**
 * Harvest a block of a drawing (typically from a manufacturer DWG) into a
 * symbol state: nested inserts are exploded into primitives, attribute
 * definitions with known ACADE tags become placeholders (visible) or pin
 * markers (X?TERM), unknown visible attributes keep their default text as
 * plain text, and the geometry is moved so the chosen base point is the
 * origin (and optionally scaled to the inline width).
 */
export function harvestBlock(state: DrawingState, blockName: string, opts: HarvestOptions = {}): SymbolState | null {
  const def = state.blocks[blockName];
  if (!def) return null;
  const lookup = (n: string) => state.blocks[n];
  const base = opts.basePoint ?? def.basePoint;
  const geometry = explodeAll(def.entities, lookup).filter((e) => e.type !== 'text' || (e.layer !== SYMATTR_LAYER && e.layer !== SYMPIN_LAYER));
  const markers: Entity[] = [];
  const pinDefaults: Record<string, string> = {};
  for (const a of def.attributes) {
    const tag = a.tag.toUpperCase();
    if (isPinTag(tag)) {
      const t = pinMarkerText(tag, a.position);
      pinDefaults[t.id] = a.default;
      markers.push(t);
    } else if (!a.invisible && KNOWN_ATTRIBUTES.has(tag)) {
      markers.push(text(SYMATTR_LAYER, a.position, tag, a.height, a.align));
    } else if (!a.invisible && a.default.trim()) {
      geometry.push(text('0', a.position, a.default, a.height, a.align));
    }
  }
  const norm = normalise([...geometry, ...markers], base, lookup, opts.scaleToWidth);
  // Marker text keeps a readable size after scaling.
  const entities = norm.entities.map((e) => (e.type === 'text' && (e.layer === SYMATTR_LAYER || e.layer === SYMPIN_LAYER) ? { ...e, height: e.layer === SYMPIN_LAYER ? 0.05 : Math.max(0.05, Math.min(0.2, e.height)) } : e));
  const kind = kindFromBlock(def);
  return {
    state: { entities, layers: symbolLayers(), blocks: {}, currentLayer: '0' },
    meta: defaultMeta({ name: blockName, description: def.description ?? '', kind, ...(kind === 'child' ? { contact: /_NC$/.test(blockName) ? ('NC' as const) : ('NO' as const) } : {}), pinDefaults }),
  };
}

/** Selected drawing objects -> symbol state (inserts exploded, base point to the origin, optional scale). */
export function fromSelection(entities: readonly Entity[], basePoint: Point, lookup: (name: string) => BlockDef | undefined, opts: { scaleToWidth?: number } = {}): SymbolState {
  const exploded = explodeAll(entities, lookup);
  const norm = normalise(exploded, basePoint, lookup, opts.scaleToWidth);
  return { state: { entities: norm.entities, layers: symbolLayers(), blocks: {}, currentLayer: '0' }, meta: defaultMeta({ name: 'USER1', pinDefaults: {} }) };
}

export interface CheckMessage {
  level: 'error' | 'warning' | 'ok';
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
}

/** Validation shown by the palette's Check button and run before saving. */
export function checkSymbol(state: DrawingState, meta: SymbolMeta, opts: CheckOptions): CheckMessage[] {
  const out: CheckMessage[] = [];
  const name = meta.name.trim().toUpperCase();
  if (!name) out.push({ level: 'error', text: 'The symbol needs a block name.' });
  else if (!opts.validName(name)) out.push({ level: 'error', text: `"${name}" is not a valid block name (no <>/\\":;?*|,=\` characters).` });
  else if (opts.isBuiltin(name)) out.push({ level: 'error', text: `"${name}" is a built-in library symbol; choose another name.` });
  else if (opts.isUser(name) && name !== (opts.editingName ?? '').toUpperCase()) out.push({ level: 'warning', text: `"${name}" already exists in the user library and will be replaced.` });
  if (meta.kind === 'child' && !/_N[OC]$/.test(name)) out.push({ level: 'warning', text: 'Child contact names should end in _NO or _NC (Toggle NO/NC and the default pins 13/14, 11/12 use it).' });
  if (!meta.family.trim()) out.push({ level: 'error', text: 'Set a family (tag prefix), e.g. PB, CR, LS.' });
  const geometry = symbolGeometry(state);
  if (geometry.length === 0) out.push({ level: 'error', text: 'The symbol has no geometry.' });
  const b = boundsOfEntities(geometry, () => undefined);
  if (b && (Math.abs(b.min.x) > 2 || Math.abs(b.max.x) > 2 || Math.abs(b.min.y) > 2 || Math.abs(b.max.y) > 2)) {
    out.push({ level: 'error', text: `Geometry extends to ${Math.max(Math.abs(b.min.x), Math.abs(b.max.x), Math.abs(b.min.y), Math.abs(b.max.y)).toFixed(2)} in from the origin; symbols should stay within +-2 in (use SCALE / MOVE).` });
  }
  const pins = compilePins(state, meta);
  if (pins.length === 0) out.push({ level: 'error', text: 'No wire connection: end a line at x = +-0.375 or add an explicit pin.' });
  const inline = pins.some((p) => Math.abs(Math.abs(p.point.x) - INLINE_HALF) < 1e-4 && Math.abs(p.point.y) < 1e-4);
  if (pins.length > 0 && !inline && meta.kind !== 'terminal') out.push({ level: 'warning', text: 'Nothing connects at (+-0.375, 0): an inline device should have its wire stubs end there so it breaks the wire it is dropped on.' });
  const placeholders = compilePlaceholders(state, meta);
  const tags = new Set(placeholders.map((a) => a.tag));
  if (meta.kind === 'terminal') {
    if (!tags.has('TERM01')) out.push({ level: 'error', text: 'A terminal needs a TERM01 attribute (Attributes > Add > TERM01, then Place).' });
  } else if (!tags.has('TAG1')) out.push({ level: 'error', text: 'Place a TAG1 attribute (Attributes > Add > TAG1) so the component can be tagged.' });
  if (!tags.has('DESC1') && meta.kind !== 'terminal') out.push({ level: 'warning', text: 'No DESC1 attribute: descriptions will not show on the drawing.' });
  const unknownText = state.entities.filter(isPlaceholder).filter((t) => !KNOWN_ATTRIBUTES.has(t.text.trim().toUpperCase()));
  for (const t of unknownText) out.push({ level: 'warning', text: `Placeholder "${t.text}" is not a known ACADE attribute; it becomes a custom attribute.` });
  const badPins = state.entities.filter((e) => e.type === 'text' && e.layer === SYMPIN_LAYER && !isPinTag(e.text.trim()));
  for (const t of badPins) out.push({ level: 'warning', text: `Text "${(t as TextEntity).text}" on ${SYMPIN_LAYER} is not a pin tag (X1TERM01 ...) and is ignored.` });
  if (out.length === 0) out.push({ level: 'ok', text: `OK: ${geometry.length} object(s), ${pins.length} wire connection(s), ${placeholders.length} visible attribute(s).` });
  return out;
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
