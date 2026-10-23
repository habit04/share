/**
 * Canonical content digest for drawings (P31, milestone 31C support module).
 *
 * This module implements the ADMITTED digest definition: PROPOSAL-P31's
 * canonical-digest definition AS DISPOSITIONED by RULING-P31 G1–G7 (LEDGER.md).
 * The written spec ships here, with the module (RULING-P31 C4). Nothing else
 * in the tree defines what the digest covers; if this text and the code ever
 * disagree, that is a defect in one of them, not a choice.
 *
 * ## What is digested (G1)
 *
 * From `DrawingState`: `entities`, `layers`, `blocks`, `header`, `layouts`,
 * `currentLayer` and `space` are DIGESTED. Excluded, wholesale:
 * - `signatureRecord` — the record never digests itself;
 * - `cadGraph` — EXCLUDED WHOLESALE (G2);
 * - `meta` — EXCLUDED WHOLESALE (G3; the proposal's earlier "volatile
 *   fields" wording is retired — there is no field-level meta carve-out);
 * - `model3d`, `constraints`, `constraintsRetained` — outside this slice.
 * - `dataLinks` — EXCLUDED (Q1, lead ruling 2026-10-21 on PROPOSAL-P31-B).
 *   The exclusion attests NOTHING about the link records: a tampered,
 *   re-targeted or deleted link record does not change the digest. The
 *   linked cell CONTENT is digested as ordinary table content, so a
 *   data-link refresh changes the digest exactly as any table edit does.
 * Any other own key on `DrawingState` is a spec violation: the canonicalizer
 * THROWS rather than silently dropping it.
 *
 * ## Serialization (G4, G5, G7)
 *
 * The serializer is recursive and driven by explicit per-record-type field
 * allowlist tables (below). The tables fix the key order at every depth, so
 * the digest is independent of property insertion order. Arrays keep their
 * stored sequence order. Absent fields and fields whose value is `undefined`
 * are omitted. The serializer is STRICT: an own key that is not in the
 * applicable table THROWS, as does any value that is not a plain object,
 * array, string, finite number, boolean or null. A stored field missing from
 * its table is therefore a loud spec failure (the golden/maximally-populated
 * fixture tests exist to catch exactly that), never a silent drop.
 *
 * Display-only exclusion set (G5): exactly `colorLayer` and
 * `transparencyLayer`, at entity level only. These two keys are skipped when
 * they appear on an entity; they are NOT skipped anywhere else.
 *
 * Scalars (G7): numbers use JSON.stringify finite-number semantics; a NaN or
 * ±Infinity ANYWHERE in the digested content makes the canonicalizer THROW —
 * no digest is produced and capture/verification fail closed. Strings are
 * emitted as JSON string literals over their UTF-8 encoding, with NO Unicode
 * normalization. Booleans and null are JSON literals.
 *
 * ## Ordering (G6) — disposition AS AMENDED by the stability gate
 *
 * As first filed, the primary disposition was: entities in (space, then
 * entity id) order, `id` digested as a field and the ordering key,
 * `cadIdentity` digested as a field. The save/reopen stability gate REFUTED
 * id stability on the real round trip (continuation audit, 2026-10-21):
 * with the header table repaired, the canonical strings of two successive
 * writeDxf -> readDxf imports differ FIRST at the first entity's `id` —
 * the DXF reader mints ids with newId() (session-random) on every import
 * (src/io/dxf/read-core.ts), so ids are stable neither for ordering nor for
 * inclusion. Per RULING-P31 G6 the recorded fallback is therefore IN FORCE,
 * recorded here as the spec amendment the ruling prescribes (and in the
 * wiring-slice evidence):
 * - Entities are digested in STORED-SEQUENCE order within each space:
 *   model-space entities first (stored order), then each layout's paper
 *   entities (stored order), layouts taken in stored order.
 * - `id` is EXCLUDED from the digest (session-local identity, not content)
 *   and `cadIdentity` is EXCLUDED (a writer-assigned handle; reassignment
 *   on save is writer behaviour, not a content change).
 * - Blocks are digested sorted by block NAME; entities inside a block keep
 *   their stored sequence order. Layers and layouts keep stored order.
 * - String-keyed maps (insert attributes, attribute placements, dimension
 *   style overrides, dynamic parameter values, lookup keys/assignments) are
 *   serialized with keys in code-unit sorted order.
 * The gate (state-level, RULING-P31 C4/C6): capture the digest over imported
 * state, `writeDxf`, `readDxf`, recompute over the reopened state — the
 * digests must be EQUAL and verification must return 'content-match'.
 *
 * ## Coverage statements (RULING-P31 C5; acceptance findings (d4) and (f2))
 *
 * - Detection of edits and digest coverage are DIFFERENT mechanisms and must
 *   not be conflated. In-app edit detection at the document choke points is
 *   transition-based (any committed transition invalidates); it does not
 *   depend on this digest. OUT-OF-BAND digest verification attests only the
 *   digested content listed above: content carried ONLY in `cadGraph`, ONLY
 *   in `meta`, or only in `model3d`/`constraints`/`constraintsRetained` is
 *   OUTSIDE out-of-band digest coverage in this slice. An out-of-band
 *   mutation confined to an excluded field therefore verifies, precisely,
 *   'content-match' — that verdict is scoped to the digested content.
 * - (d4) The content digest attests DRAWING CONTENT only. The preserved
 *   signature payload's own bytes are NOT integrity-attested in this slice:
 *   flipping a payload byte is undetectable by this digest, by design.
 * - (f2) The serialized signature record is UNAUTHENTICATED: a hand-edited
 *   status string parses. Invalidation stickiness is an API discipline, not
 *   tamper-evidence. No cryptographic claim is made anywhere in this slice.
 * - Persistence (C6): nothing in this slice serializes `signatureRecord`
 *   into DXF or DWG. The stability property above is a STATE-LEVEL property
 *   of imported/reopened state, not a persistence claim about the record.
 *
 * The digest itself is `sha256Hex` (src/core/sha256.ts, reused unchanged)
 * over the canonical string.
 */
import { sha256Hex } from '../core/sha256';
import type { DrawingState } from '../core/document';
import type { Entity } from '../core/entities';

/* ------------------------------------------------------------------ */
/* Serializer core                                                     */
/* ------------------------------------------------------------------ */

/** A field allowlist: the key order is the array order. */
type Table = readonly string[];

/** How one field's value is serialized. */
type FieldSpec =
  | { readonly k: 'scalar' }
  | { readonly k: 'table'; readonly table: Table; readonly fields: FieldSpecs; readonly skip?: ReadonlySet<string> }
  | { readonly k: 'entity' }
  | { readonly k: 'array'; readonly of: FieldSpec }
  | { readonly k: 'map'; readonly of: FieldSpec }
  | { readonly k: 'variant'; readonly disc: string; readonly variants: Readonly<Record<string, TableSpec>> };

interface TableSpec {
  readonly table: Table;
  readonly fields: FieldSpecs;
}

type FieldSpecs = Readonly<Record<string, FieldSpec>>;

const S: FieldSpec = { k: 'scalar' };
const arr = (of: FieldSpec): FieldSpec => ({ k: 'array', of });
const map = (of: FieldSpec): FieldSpec => ({ k: 'map', of });
const tbl = (table: Table, fields: FieldSpecs): FieldSpec => ({ k: 'table', table, fields });
const variant = (disc: string, variants: Readonly<Record<string, TableSpec>>): FieldSpec => ({
  k: 'variant', disc, variants,
});
const ENT: FieldSpec = { k: 'entity' };

const isPlainRecord = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
};

const scalarString = (v: unknown, path: string): string => {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) {
        throw new Error(`canonical-digest: non-finite number at ${path} — refusing to digest (G7)`);
      }
      return JSON.stringify(v);
    default:
      throw new Error(`canonical-digest: non-scalar value at ${path} (${typeof v}) — refusing to digest`);
  }
};

function serializeWithSpec(v: unknown, spec: FieldSpec, path: string): string {
  switch (spec.k) {
    case 'scalar':
      return scalarString(v, path);
    case 'array': {
      if (!Array.isArray(v)) throw new Error(`canonical-digest: expected array at ${path}`);
      return `[${v.map((item, i) => serializeWithSpec(item, spec.of, `${path}[${i}]`)).join(',')}]`;
    }
    case 'map': {
      if (!isPlainRecord(v)) throw new Error(`canonical-digest: expected string map at ${path}`);
      const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${serializeWithSpec(v[k], spec.of, `${path}.${k}`)}`).join(',')}}`;
    }
    case 'table': {
      if (!isPlainRecord(v)) throw new Error(`canonical-digest: expected record at ${path}`);
      return serializeTable(v, spec.table, spec.fields, path, spec.skip);
    }
    case 'variant': {
      if (!isPlainRecord(v)) throw new Error(`canonical-digest: expected record at ${path}`);
      const discValue = v[spec.disc];
      if (typeof discValue !== 'string') {
        throw new Error(`canonical-digest: missing discriminant ${spec.disc} at ${path}`);
      }
      const chosen = spec.variants[discValue];
      if (!chosen) {
        throw new Error(`canonical-digest: no table for ${spec.disc}=${JSON.stringify(discValue)} at ${path} — unmodelled variant`);
      }
      return serializeTable(v, chosen.table, chosen.fields, path);
    }
    case 'entity':
      return serializeEntity(v as Entity, path);
  }
}

/** Serialize a plain record against an allowlist table, strictly. */
function serializeTable(
  rec: Record<string, unknown>,
  table: Table,
  fields: FieldSpecs,
  path: string,
  skip?: ReadonlySet<string>,
): string {
  const allowed = new Set(table);
  for (const key of Object.keys(rec)) {
    if (skip?.has(key)) continue;
    if (!allowed.has(key)) {
      throw new Error(`canonical-digest: field ${JSON.stringify(key)} at ${path} is not in its allowlist table — refusing to silently drop it (G4)`);
    }
  }
  const parts: string[] = [];
  for (const key of table) {
    if (!Object.hasOwn(rec, key)) continue;
    const value = rec[key];
    if (value === undefined) continue;
    const spec = fields[key];
    if (!spec) throw new Error(`canonical-digest: table lists ${key} at ${path} but no field spec exists`);
    parts.push(`${JSON.stringify(key)}:${serializeWithSpec(value, spec, `${path}.${key}`)}`);
  }
  return `{${parts.join(',')}}`;
}

/* ------------------------------------------------------------------ */
/* Shared small tables                                                 */
/* ------------------------------------------------------------------ */

const POINT: TableSpec = { table: ['x', 'y'], fields: { x: S, y: S } };
const POINT3: TableSpec = { table: ['x', 'y', 'z'], fields: { x: S, y: S, z: S } };
const pointSpec = tbl(POINT.table, POINT.fields);
const point3Spec = tbl(POINT3.table, POINT3.fields);

const FIELD_LINK: TableSpec = {
  table: ['native', 'code', 'value'],
  fields: { native: S, code: S, value: S },
};
const fieldLinkSpec = tbl(FIELD_LINK.table, FIELD_LINK.fields);

const JUSTIFICATION: TableSpec = {
  table: ['horizontal', 'vertical'],
  fields: { horizontal: S, vertical: S },
};

const TEXT_PLACEMENT_FIELDS: FieldSpecs = {
  position: pointSpec,
  firstAlignmentPoint: pointSpec,
  height: S,
  rotation: S,
  align: S,
  widthFactor: S,
  oblique: S,
  justification: tbl(JUSTIFICATION.table, JUSTIFICATION.fields),
  alignmentPoint: pointSpec,
};
const TEXT_PLACEMENT_TABLE: Table = [
  'position', 'firstAlignmentPoint', 'height', 'rotation', 'align',
  'widthFactor', 'oblique', 'justification', 'alignmentPoint',
];

const APPEARANCE_FIELDS: FieldSpecs = {
  layer: S, color: S, trueColor: S, colorName: S, transparency: S,
};
const APPEARANCE_TABLE: Table = ['layer', 'color', 'trueColor', 'colorName', 'transparency'];

/** MTextColumns (core/mtext.ts), shared by the mtext variant and leader textColumns. */
const MTEXT_COLUMNS: TableSpec = {
  table: ['type', 'count', 'width', 'gutter', 'autoHeight', 'reversed', 'heights'],
  fields: { type: S, count: S, width: S, gutter: S, autoHeight: S, reversed: S, heights: arr(S) },
};
const mtextColumnsSpec = tbl(MTEXT_COLUMNS.table, MTEXT_COLUMNS.fields);

/**
 * MTextBackground (core/mtext.ts), shared by the mtext variant and leader
 * textBackground. Its `colorLayer` is a stored field OF THIS RECORD and is
 * digested: the G5 exclusion set applies to an entity's own keys only.
 */
const MTEXT_BACKGROUND: TableSpec = {
  table: ['flags', 'scale', 'color', 'trueColor', 'colorName', 'transparency', 'colorLayer'],
  fields: { flags: S, scale: S, color: S, trueColor: S, colorName: S, transparency: S, colorLayer: S },
};
const mtextBackgroundSpec = tbl(MTEXT_BACKGROUND.table, MTEXT_BACKGROUND.fields);

/**
 * LeaderEntity.textAppearance: AttributeAppearance plus EntityBase's
 * colorLayer/transparencyLayer picked into the nested record. Inside this
 * record those two are stored fields and are digested (G5 is entity-level).
 */
const LEADER_TEXT_APPEARANCE: TableSpec = {
  table: [...APPEARANCE_TABLE, 'colorLayer', 'transparencyLayer'],
  fields: { ...APPEARANCE_FIELDS, colorLayer: S, transparencyLayer: S },
};

/* ------------------------------------------------------------------ */
/* Dynamic (parametric) structures                                     */
/* ------------------------------------------------------------------ */

const DPV: FieldSpec = variant('kind', {
  distance: { table: ['kind', 'value'], fields: { kind: S, value: S } },
  angle: { table: ['kind', 'value'], fields: { kind: S, value: S } },
  flip: { table: ['kind', 'value'], fields: { kind: S, value: S } },
  visibility: { table: ['kind', 'value'], fields: { kind: S, value: S } },
  lookup: { table: ['kind', 'value'], fields: { kind: S, value: S } },
  opaque: { table: ['kind', 'payload'], fields: { kind: S, payload: S } },
});

const DYNAMIC_INSTANCE: TableSpec = {
  table: ['block', 'values'],
  fields: { block: S, values: map(DPV) },
};

const GRIP: TableSpec = {
  table: ['role', 'movesWithValue'],
  fields: { role: S, movesWithValue: S },
};
const gripSpec = tbl(GRIP.table, GRIP.fields);

const DIST_CONSTRAINT: FieldSpec = variant('kind', {
  unbounded: { table: ['kind'], fields: { kind: S } },
  range: { table: ['kind', 'min', 'max'], fields: { kind: S, min: S, max: S } },
  increment: { table: ['kind', 'min', 'max', 'increment'], fields: { kind: S, min: S, max: S, increment: S } },
  list: { table: ['kind', 'values'], fields: { kind: S, values: arr(S) } },
});
const ANGLE_CONSTRAINT: FieldSpec = variant('kind', {
  unbounded: { table: ['kind'], fields: { kind: S } },
  range: { table: ['kind', 'min', 'max'], fields: { kind: S, min: S, max: S } },
});

const PARAMETER: FieldSpec = variant('kind', {
  'linear-distance': {
    table: ['kind', 'id', 'name', 'basePoint', 'direction', 'defaultValue', 'constraint', 'grips'],
    fields: {
      kind: S, id: S, name: S, basePoint: pointSpec, direction: pointSpec,
      defaultValue: S, constraint: DIST_CONSTRAINT, grips: arr(gripSpec),
    },
  },
  angle: {
    table: ['kind', 'id', 'name', 'basePoint', 'defaultValue', 'constraint', 'grips'],
    fields: {
      kind: S, id: S, name: S, basePoint: pointSpec,
      defaultValue: S, constraint: ANGLE_CONSTRAINT, grips: arr(gripSpec),
    },
  },
  flip: {
    table: ['kind', 'id', 'name', 'basePoint', 'defaultValue'],
    fields: { kind: S, id: S, name: S, basePoint: pointSpec, defaultValue: S },
  },
  visibility: {
    table: ['kind', 'id', 'name', 'basePoint', 'defaultState', 'states'],
    fields: {
      kind: S, id: S, name: S, basePoint: pointSpec, defaultState: S,
      states: arr(tbl(['name', 'visible'], { name: S, visible: arr(S) })),
    },
  },
  lookup: {
    table: ['kind', 'id', 'name', 'basePoint', 'inputs', 'defaultRow', 'rows'],
    fields: {
      kind: S, id: S, name: S, basePoint: pointSpec, inputs: arr(S), defaultRow: S,
      rows: arr(tbl(['name', 'key', 'assignments'], { name: S, key: map(DPV), assignments: map(DPV) })),
    },
  },
  'opaque-parameter': {
    table: ['kind', 'id', 'name', 'sourceKind', 'payload'],
    fields: { kind: S, id: S, name: S, sourceKind: S, payload: S },
  },
});

const WHOLE_SELECTION: TableSpec = { table: ['entityId'], fields: { entityId: S } };
const wholeSelectionSpec = tbl(WHOLE_SELECTION.table, WHOLE_SELECTION.fields);
const STRETCH_POINTS: FieldSpec = variant('kind', {
  frame: { table: ['kind'], fields: { kind: S } },
  points: { table: ['kind', 'indices'], fields: { kind: S, indices: arr(S) } },
});
const STRETCH_SELECTION: TableSpec = {
  table: ['entityId', 'points'],
  fields: { entityId: S, points: STRETCH_POINTS },
};
const stretchSelectionSpec = tbl(STRETCH_SELECTION.table, STRETCH_SELECTION.fields);

const ACTION_BASE: FieldSpecs = { kind: S, id: S, name: S, parameterId: S };
const ACTION: FieldSpec = variant('kind', {
  stretch: {
    table: ['kind', 'id', 'name', 'parameterId', 'frame', 'selection', 'distanceMultiplier', 'angleOffset'],
    fields: {
      ...ACTION_BASE,
      frame: tbl(['kind', 'min', 'max'], { kind: S, min: pointSpec, max: pointSpec }),
      selection: arr(stretchSelectionSpec), distanceMultiplier: S, angleOffset: S,
    },
  },
  move: {
    table: ['kind', 'id', 'name', 'parameterId', 'selection', 'distanceMultiplier', 'angleOffset'],
    fields: { ...ACTION_BASE, selection: arr(wholeSelectionSpec), distanceMultiplier: S, angleOffset: S },
  },
  rotate: {
    table: ['kind', 'id', 'name', 'parameterId', 'center', 'selection'],
    fields: { ...ACTION_BASE, center: pointSpec, selection: arr(wholeSelectionSpec) },
  },
  scale: {
    table: ['kind', 'id', 'name', 'parameterId', 'basePoint', 'selection'],
    fields: { ...ACTION_BASE, basePoint: pointSpec, selection: arr(wholeSelectionSpec) },
  },
  flip: {
    table: ['kind', 'id', 'name', 'parameterId', 'axisA', 'axisB', 'selection'],
    fields: { ...ACTION_BASE, axisA: pointSpec, axisB: pointSpec, selection: arr(wholeSelectionSpec) },
  },
  array: {
    table: ['kind', 'id', 'name', 'parameterId', 'selection', 'spacing'],
    fields: { ...ACTION_BASE, selection: arr(wholeSelectionSpec), spacing: S },
  },
  'opaque-action': {
    table: ['kind', 'id', 'name', 'parameterId', 'sourceKind', 'payload'],
    fields: { ...ACTION_BASE, sourceKind: S, payload: S },
  },
});

const DYNAMIC_DEFINITION: TableSpec = {
  table: ['version', 'parameters', 'actions', 'alignment'],
  fields: {
    version: S,
    parameters: arr(PARAMETER),
    actions: arr(ACTION),
    alignment: tbl(['basePoint', 'direction', 'mode'], {
      basePoint: pointSpec, direction: pointSpec, mode: S,
    }),
  },
};
const dynamicDefinitionSpec = tbl(DYNAMIC_DEFINITION.table, DYNAMIC_DEFINITION.fields);
const dynamicInstanceSpec = tbl(DYNAMIC_INSTANCE.table, DYNAMIC_INSTANCE.fields);

/* ------------------------------------------------------------------ */
/* Entities                                                            */
/* ------------------------------------------------------------------ */

/** G5 display-only exclusion set — entity level only, exactly these two. */
const ENTITY_DISPLAY_ONLY: ReadonlySet<string> = new Set(['colorLayer', 'transparencyLayer']);

/**
 * G6 fallback (in force — see the Ordering section): entity identity fields
 * are excluded from the digest. `id` is session-local (the DXF reader mints
 * it with newId() on every import) and `cadIdentity` is a writer-assigned
 * handle; neither is content. Distinct from the G5 set: these keys are
 * KNOWN and deliberately not digested, at entity level only.
 */
const ENTITY_IDENTITY_FIELDS: ReadonlySet<string> = new Set(['id', 'cadIdentity']);

const ENTITY_BASE_TABLE: Table = [
  'type', 'layer', 'color', 'linetype', 'lineWeight',
  'ltscale', 'trueColor', 'colorName', 'transparency', 'annotative',
];
const ENTITY_BASE_FIELDS: FieldSpecs = {
  type: S, layer: S, color: S, linetype: S,
  lineWeight: S, ltscale: S, trueColor: S, colorName: S, transparency: S,
  annotative: S,
};

const DIM_STYLE_TABLE: Table = [
  'name', 'textHeight', 'arrowSize', 'extOffset', 'extExtend', 'textGap',
  'centerMark', 'scale', 'decimals', 'lunit', 'angularDecimals',
  'baselineSpacing', 'dimLineExtend', 'suppressDimLine1', 'suppressDimLine2',
  'suppressExt1', 'suppressExt2', 'dimLineColor', 'extLineColor',
  'dimLineWeight', 'extLineWeight', 'arrow', 'arrow2', 'textVertical',
  'textAlign', 'textJustify', 'textColor', 'textStyle', 'fit', 'textInside',
  'dimLineInside', 'post', 'round', 'linearFactor', 'suppressLeadingZeros',
  'suppressTrailingZeros', 'decimalSeparator', 'altUnits', 'altFactor',
  'altDecimals', 'altLunit', 'altPost', 'altPlacement', 'tolerance', 'tolPlus',
  'tolMinus', 'tolDecimals', 'tolScale', 'toleranceZeroSuppression',
];
const DIM_STYLE_FIELDS: FieldSpecs = Object.fromEntries(DIM_STYLE_TABLE.map((k) => [k, S]));
const dimStyleSpec = tbl(DIM_STYLE_TABLE, DIM_STYLE_FIELDS);

const ATTRIBUTE_PLACEMENT: TableSpec = {
  table: [...TEXT_PLACEMENT_TABLE, ...APPEARANCE_TABLE, 'style'],
  fields: { ...TEXT_PLACEMENT_FIELDS, ...APPEARANCE_FIELDS, style: S },
};

const ENTITY_VARIANTS: Readonly<Record<string, TableSpec>> = {
  line: { table: ['a', 'b'], fields: { a: pointSpec, b: pointSpec } },
  circle: {
    table: ['center', 'radius', 'filled'],
    fields: { center: pointSpec, radius: S, filled: S },
  },
  arc: {
    table: ['center', 'radius', 'startAngle', 'endAngle'],
    fields: { center: pointSpec, radius: S, startAngle: S, endAngle: S },
  },
  polyline: {
    table: ['points', 'closed', 'bulges', 'width', 'widths', 'vertexIds', 'widthFrame', 'filled'],
    fields: {
      points: arr(pointSpec), closed: S, bulges: arr(S), width: S,
      widths: arr(tbl(['start', 'end'], { start: S, end: S })),
      vertexIds: arr(S),
      widthFrame: tbl(
        ['points', 'bulges', 'width', 'widths', 'origin', 'x', 'y'],
        {
          points: arr(pointSpec), bulges: arr(S), width: S,
          widths: arr(tbl(['start', 'end'], { start: S, end: S })),
          origin: pointSpec, x: pointSpec, y: pointSpec,
        },
      ),
      filled: S,
    },
  },
  text: {
    table: [...TEXT_PLACEMENT_TABLE, 'text', 'bold', 'field', 'style'],
    fields: { ...TEXT_PLACEMENT_FIELDS, text: S, bold: S, field: fieldLinkSpec, style: S },
  },
  insert: {
    table: [
      'block', 'position', 'rotation', 'scale', 'scaleY', 'mirror', 'attributes',
      'columns', 'rows', 'columnSpacing', 'rowSpacing', 'hiddenAttributes',
      'attributePlacements', 'dynamic', 'dynamicRetained',
    ],
    fields: {
      block: S, position: pointSpec, rotation: S, scale: S, scaleY: S, mirror: S,
      attributes: map(S), columns: S, rows: S, columnSpacing: S, rowSpacing: S,
      hiddenAttributes: arr(S),
      attributePlacements: map(tbl(ATTRIBUTE_PLACEMENT.table, ATTRIBUTE_PLACEMENT.fields)),
      dynamic: dynamicInstanceSpec, dynamicRetained: S,
    },
  },
  ellipse: {
    table: ['center', 'majorAxis', 'ratio', 'startParam', 'endParam'],
    fields: { center: pointSpec, majorAxis: pointSpec, ratio: S, startParam: S, endParam: S },
  },
  point: { table: ['position'], fields: { position: pointSpec } },
  xline: { table: ['base', 'direction'], fields: { base: pointSpec, direction: pointSpec } },
  ray: { table: ['base', 'direction'], fields: { base: pointSpec, direction: pointSpec } },
  spline: {
    table: ['degree', 'knots', 'controlPoints', 'weights', 'fitPoints', 'closed', 'periodic', 'startTangent', 'endTangent'],
    fields: {
      degree: S, knots: arr(S), controlPoints: arr(pointSpec), weights: arr(S),
      fitPoints: arr(pointSpec), closed: S, periodic: S,
      startTangent: pointSpec, endTangent: pointSpec,
    },
  },
  hatch: {
    table: [
      'pattern', 'solid', 'angle', 'scale', 'origin', 'loops', 'patternLines',
      'associative', 'style', 'patternType', 'double', 'gradient', 'gradientFrame',
    ],
    fields: {
      pattern: S, solid: S, angle: S, scale: S, origin: pointSpec,
      loops: arr(tbl(['points', 'bulges'], { points: arr(pointSpec), bulges: arr(S) })),
      patternLines: arr(tbl(
        ['angle', 'base', 'offset', 'dashes'],
        { angle: S, base: pointSpec, offset: pointSpec, dashes: arr(S) },
      )),
      associative: S, style: S, patternType: S, double: S,
      gradient: tbl(
        ['name', 'angle', 'shift', 'singleColor', 'tint', 'colors', 'kind', 'reserved', 'colorMode', 'colorCount'],
        {
          name: S, angle: S, shift: S, singleColor: S, tint: S,
          colors: arr(tbl(['position', 'color', 'trueColor'], { position: S, color: S, trueColor: S })),
          kind: S, reserved: S, colorMode: S, colorCount: S,
        },
      ),
      gradientFrame: tbl(['origin', 'x', 'y'], { origin: pointSpec, x: pointSpec, y: pointSpec }),
    },
  },
  leader: {
    table: [
      'vertices', 'arrow', 'arrowSize', 'dogleg', 'spline', 'extraPaths', 'text',
      'raw', 'textPosition', 'textHeight', 'textAttachment', 'textWidth',
      'textRotation', 'textBackground', 'textAppearance', 'textLayer',
      'textLineSpacing', 'textColumns', 'kind',
    ],
    fields: {
      vertices: arr(pointSpec), arrow: S, arrowSize: S, dogleg: pointSpec, spline: S,
      extraPaths: arr(arr(pointSpec)), text: S, raw: S, textPosition: pointSpec,
      textHeight: S, textAttachment: S, textWidth: S, textRotation: S,
      textBackground: mtextBackgroundSpec,
      textAppearance: tbl(LEADER_TEXT_APPEARANCE.table, LEADER_TEXT_APPEARANCE.fields),
      textLayer: S, textLineSpacing: S, textColumns: mtextColumnsSpec, kind: S,
    },
  },
  image: {
    table: ['path', 'position', 'u', 'v', 'size', 'clip', 'clipOn', 'flags', 'brightness', 'contrast', 'fade'],
    fields: {
      path: S, position: pointSpec, u: pointSpec, v: pointSpec,
      size: tbl(['x', 'y'], { x: S, y: S }),
      clip: arr(pointSpec), clipOn: S, flags: S, brightness: S, contrast: S, fade: S,
    },
  },
  mtext: {
    table: [
      'position', 'text', 'height', 'width', 'rotation', 'attachment',
      'lineSpacing', 'raw', 'field', 'columns', 'background', 'style',
    ],
    fields: {
      position: pointSpec, text: S, height: S, width: S, rotation: S,
      attachment: S, lineSpacing: S, raw: S, field: fieldLinkSpec,
      columns: mtextColumnsSpec,
      background: mtextBackgroundSpec,
      style: S,
    },
  },
  dimension: {
    table: [
      'kind', 'p1', 'p2', 'linePoint', 'rotation', 'ordinateAxis',
      'ordinateRotation', 'center', 'text', 'textPosition', 'textRotation',
      'oblique', 'style', 'styleOverrides',
    ],
    fields: {
      kind: S, p1: pointSpec, p2: pointSpec, linePoint: pointSpec, rotation: S,
      ordinateAxis: S, ordinateRotation: S, center: pointSpec, text: S,
      textPosition: pointSpec, textRotation: S, oblique: S,
      style: dimStyleSpec, styleOverrides: map(S),
    },
  },
  table: {
    table: ['position', 'rotation', 'rowHeights', 'columnWidths', 'cells', 'textHeight', 'margin'],
    fields: {
      position: pointSpec, rotation: S, rowHeights: arr(S), columnWidths: arr(S),
      cells: arr(arr(tbl(
        ['text', 'raw', 'height', 'attachment', 'span'],
        {
          text: S, raw: S, height: S, attachment: S,
          span: tbl(['rows', 'cols'], { rows: S, cols: S }),
        },
      ))),
      textHeight: S, margin: S,
    },
  },
};

function serializeEntity(entity: Entity, path: string): string {
  const rec = entity as unknown as Record<string, unknown>;
  if (!isPlainRecord(rec)) throw new Error(`canonical-digest: entity at ${path} is not a plain record`);
  const type = rec.type;
  if (typeof type !== 'string') throw new Error(`canonical-digest: entity at ${path} has no type`);
  const variantSpec = ENTITY_VARIANTS[type];
  if (!variantSpec) {
    throw new Error(`canonical-digest: no allowlist table for entity type ${JSON.stringify(type)} at ${path} — unmodelled variant`);
  }
  // Strictness across base + variant tables, with the G5 display-only set
  // and the G6 identity fields skipped (known, deliberately not digested).
  const allowed = new Set([...ENTITY_BASE_TABLE, ...variantSpec.table]);
  for (const key of Object.keys(rec)) {
    if (ENTITY_DISPLAY_ONLY.has(key)) continue;
    if (ENTITY_IDENTITY_FIELDS.has(key)) continue;
    if (!allowed.has(key)) {
      throw new Error(`canonical-digest: field ${JSON.stringify(key)} at ${path} is not in its allowlist table — refusing to silently drop it (G4)`);
    }
  }
  const parts: string[] = [];
  const emit = (table: Table, fields: FieldSpecs): void => {
    for (const key of table) {
      if (!Object.hasOwn(rec, key)) continue;
      const value = rec[key];
      if (value === undefined) continue;
      const spec = fields[key];
      if (!spec) throw new Error(`canonical-digest: no field spec for ${key} at ${path}`);
      parts.push(`${JSON.stringify(key)}:${serializeWithSpec(value, spec, `${path}.${key}`)}`);
    }
  };
  emit(ENTITY_BASE_TABLE, ENTITY_BASE_FIELDS);
  emit(variantSpec.table, variantSpec.fields);
  return `{${parts.join(',')}}`;
}

/* ------------------------------------------------------------------ */
/* Blocks, layers, header, layouts                                     */
/* ------------------------------------------------------------------ */

const ATTRIBUTE_DEF: TableSpec = {
  table: ['tag', 'prompt', 'default', 'invisible', 'style', ...TEXT_PLACEMENT_TABLE, ...APPEARANCE_TABLE],
  fields: {
    tag: S, prompt: S, default: S, invisible: S, style: S,
    ...TEXT_PLACEMENT_FIELDS, ...APPEARANCE_FIELDS,
  },
};

const BLOCK_DEF: TableSpec = {
  table: ['name', 'basePoint', 'entities', 'attributes', 'description', 'dynamic', 'dynamicRetained', 'xref'],
  fields: {
    name: S, basePoint: pointSpec, entities: arr(ENT),
    attributes: arr(tbl(ATTRIBUTE_DEF.table, ATTRIBUTE_DEF.fields)),
    description: S, dynamic: dynamicDefinitionSpec, dynamicRetained: S,
    xref: tbl(['path', 'overlay'], { path: S, overlay: S }),
  },
};
const blockDefSpec = tbl(BLOCK_DEF.table, BLOCK_DEF.fields);

const LAYER: TableSpec = {
  table: [
    'name', 'color', 'visible', 'locked', 'lineWeight', 'linetype', 'frozen',
    'plot', 'trueColor', 'colorName', 'transparency', 'xrefFlags',
  ],
  fields: {
    name: S, color: S, visible: S, locked: S, lineWeight: S, linetype: S,
    frozen: S, plot: S, trueColor: S, colorName: S, transparency: S, xrefFlags: S,
  },
};
const layerSpec = tbl(LAYER.table, LAYER.fields);

const STYLE_REF: FieldSpec = variant('kind', {
  text: {
    table: ['kind', 'name', 'sourceHandle'],
    fields: { kind: S, name: S, sourceHandle: S },
  },
  shape: { table: ['kind', 'sourceId'], fields: { kind: S, sourceId: S } },
  unresolved: { table: ['kind', 'sourceHandle'], fields: { kind: S, sourceHandle: S } },
});

const HEADER: TableSpec = {
  table: [
    'units', 'ltscale', 'limits', 'pdmode', 'pdsize', 'dimStyle', 'linetypes',
    'views', 'celtype', 'celweight', 'celtscale', 'textStyle', 'cannoscale',
    'annoAllVisible',
  ],
  fields: {
    units: tbl(
      ['lunits', 'luprec', 'insunits', 'auprec', 'aunits'],
      { lunits: S, luprec: S, insunits: S, auprec: S, aunits: S },
    ),
    ltscale: S,
    limits: tbl(['min', 'max'], { min: pointSpec, max: pointSpec }),
    pdmode: S, pdsize: S, dimStyle: dimStyleSpec,
    linetypes: arr(tbl(
      ['name', 'description', 'pattern', 'complex'],
      {
        name: S, description: S, pattern: arr(S),
        complex: tbl(
          ['flags', 'alignment', 'totalPatternLength', 'elements'],
          {
            flags: S, alignment: S, totalPatternLength: S,
            elements: arr(tbl(
              ['flags', 'shapeNumber', 'style', 'scale', 'rotation', 'offsetX', 'offsetY', 'text'],
              {
                flags: S, shapeNumber: S, style: STYLE_REF, scale: S,
                rotation: S, offsetX: S, offsetY: S, text: S,
              },
            )),
          },
        ),
      },
    )),
    views: arr(tbl(
      ['name', 'center', 'height', 'width', 'twist', 'camera'],
      {
        name: S, center: pointSpec, height: S, width: S, twist: S,
        camera: tbl(
          ['displayCenter', 'direction', 'target', 'width', 'twist', 'lensLength', 'frontClip', 'backClip', 'mode', 'flags'],
          {
            displayCenter: pointSpec, direction: point3Spec, target: point3Spec,
            width: S, twist: S, lensLength: S, frontClip: S, backClip: S,
            mode: S, flags: S,
          },
        ),
      },
    )),
    celtype: S, celweight: S, celtscale: S, textStyle: S, cannoscale: S,
    annoAllVisible: S,
  },
};
const headerSpec = tbl(HEADER.table, HEADER.fields);

const VIEWPORT_VIEW: TableSpec = {
  table: ['center', 'scale', 'twist', 'locked'],
  fields: { center: pointSpec, scale: S, twist: S, locked: S },
};

const LAYOUT: TableSpec = {
  table: [
    'name', 'paper', 'plotScale', 'margins', 'entities', 'viewports',
    'plotStyle', 'screening', 'plotLineweights', 'usePlotStyles', 'pristine',
  ],
  fields: {
    name: S,
    paper: tbl(
      ['id', 'width', 'height', 'units', 'orientation'],
      { id: S, width: S, height: S, units: S, orientation: S },
    ),
    plotScale: S,
    margins: tbl(
      ['left', 'bottom', 'right', 'top'],
      { left: S, bottom: S, right: S, top: S },
    ),
    entities: arr(ENT),
    viewports: arr(tbl(
      ['id', 'center', 'width', 'height', 'view', 'layer', 'on', 'frozenLayers', 'clipBoundary', 'clipOn'],
      {
        id: S, center: pointSpec, width: S, height: S,
        view: tbl(VIEWPORT_VIEW.table, VIEWPORT_VIEW.fields),
        layer: S, on: S, frozenLayers: arr(S), clipBoundary: ENT, clipOn: S,
      },
    )),
    plotStyle: S, screening: S, plotLineweights: S, usePlotStyles: S, pristine: S,
  },
};

const SPACE_REF: TableSpec = {
  table: ['layout', 'viewport'],
  fields: { layout: S, viewport: S },
};

/* ------------------------------------------------------------------ */
/* Top level                                                           */
/* ------------------------------------------------------------------ */

/** G1: keys excluded wholesale — never digested, never an error. */
const STATE_EXCLUDED: ReadonlySet<string> = new Set([
  'signatureRecord', 'cadGraph', 'meta', 'model3d', 'constraints', 'constraintsRetained', 'dataLinks',
]);
/** G1: keys digested, in this fixed order. */
const STATE_TABLE: Table = [
  'entities', 'layers', 'blocks', 'header', 'layouts', 'currentLayer', 'space',
];

/**
 * Serialize entities in digest order (G6 fallback in force): stored sequence
 * within each space — model space first, then each layout's paper entities,
 * layouts in stored order.
 */
function entitiesInDigestOrder(state: DrawingState): string {
  const parts: string[] = [];
  state.entities.forEach((e, i) => parts.push(serializeEntity(e, `entities[${i}]`)));
  (state.layouts ?? []).forEach((layout, li) => {
    layout.entities.forEach((e, i) => parts.push(serializeEntity(e, `layouts[${li}].entities[${i}]`)));
  });
  return `[${parts.join(',')}]`;
}

/**
 * The canonical string for a drawing state, per the spec in this module's
 * header. Throws on any content the spec does not cover (unknown field,
 * unmodelled variant, non-finite number, non-plain value) — fail closed.
 */
export function canonicalDrawingString(state: DrawingState): string {
  const rec = state as unknown as Record<string, unknown>;
  if (!isPlainRecord(rec)) throw new Error('canonical-digest: state is not a plain record');
  for (const key of Object.keys(rec)) {
    if (STATE_EXCLUDED.has(key)) continue;
    if (!STATE_TABLE.includes(key)) {
      throw new Error(`canonical-digest: field ${JSON.stringify(key)} on DrawingState is outside the G1 disposition — refusing to silently drop it`);
    }
  }
  const parts: string[] = [];
  for (const key of STATE_TABLE) {
    if (!Object.hasOwn(rec, key)) continue;
    const value = rec[key];
    if (value === undefined) continue;
    switch (key) {
      case 'entities':
        parts.push(`"entities":${entitiesInDigestOrder(state)}`);
        break;
      case 'layers':
        parts.push(`"layers":${serializeWithSpec(value, arr(layerSpec), 'layers')}`);
        break;
      case 'blocks': {
        if (!isPlainRecord(value)) throw new Error('canonical-digest: blocks is not a record');
        const names = Object.keys(value).filter((k) => value[k] !== undefined).sort();
        const inner = names.map(
          (name) => `${JSON.stringify(name)}:${serializeWithSpec(value[name], blockDefSpec, `blocks.${name}`)}`,
        );
        parts.push(`"blocks":{${inner.join(',')}}`);
        break;
      }
      case 'header':
        parts.push(`"header":${serializeWithSpec(value, headerSpec, 'header')}`);
        break;
      case 'layouts': {
        // Layouts keep stored order; their entities are already covered by
        // the entities pass above, so serialize layouts WITHOUT entities
        // here (entities serialize exactly once, in digest order).
        if (!Array.isArray(value)) throw new Error('canonical-digest: layouts is not an array');
        const layoutSpecNoEntities: FieldSpec = {
          k: 'table',
          table: LAYOUT.table.filter((k) => k !== 'entities'),
          fields: LAYOUT.fields,
          skip: new Set(['entities']),
        };
        parts.push(`"layouts":${serializeWithSpec(value, arr(layoutSpecNoEntities), 'layouts')}`);
        break;
      }
      case 'currentLayer':
        parts.push(`"currentLayer":${scalarString(value, 'currentLayer')}`);
        break;
      case 'space':
        parts.push(`"space":${serializeWithSpec(value, tbl(SPACE_REF.table, SPACE_REF.fields), 'space')}`);
        break;
      default:
        throw new Error(`canonical-digest: unhandled state key ${key}`);
    }
  }
  return `{${parts.join(',')}}`;
}

/** The canonical content digest: SHA-256 (hex) of the canonical string. */
export function drawingContentDigest(state: DrawingState): string {
  return sha256Hex(canonicalDrawingString(state));
}
