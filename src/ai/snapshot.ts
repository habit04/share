import { polylineLength, type Entity } from '../core/entities';
import type { Point } from '../core/geometry';
import { INSUNIT_NAMES } from '../core/units';
import {
  AI_MAX_ATTRIBUTES,
  AI_MAX_GEOMETRY_POINTS,
  AI_MAX_OBJECTS,
  AI_MAX_OMITTED_LISTED,
  AI_MAX_SAMPLE_POINTS,
  AI_MAX_SNAPSHOT_BYTES,
  AI_MAX_TABLE_CELLS,
  AI_MAX_TEXT_CHARS,
} from './limits';
import type {
  AiGeometryValue,
  AiObjectSnapshot,
  AiOmitted,
  AiPoint,
  AiSnapshot,
  AiSnapshotSource,
} from './types';
import { AiError } from './types';

/**
 * Builds the bounded snapshot of explicitly selected objects that — and only
 * that — a provider may see (docs/AI-ASSISTANT.md). Pure: the source is only
 * read, and two calls over the same source state produce identical output.
 *
 * Field policy per entity type is a whitelist. Never included: image file
 * paths, field expressions, drawing metadata, the CAD graph, block
 * definition internals, unselected objects, undo history, file paths.
 */

const SUPPORTED_TYPES: ReadonlySet<string> = new Set([
  'line', 'circle', 'arc', 'polyline', 'text', 'insert', 'ellipse', 'point',
  'xline', 'ray', 'spline', 'hatch', 'leader', 'image', 'mtext', 'dimension',
  'table',
]);

const utf8 = new TextEncoder();

function byteLength(text: string): number {
  return utf8.encode(text).length;
}

function pt(p: Point): AiPoint {
  return { x: p.x, y: p.y };
}

function deg(rad: number): number {
  return (rad * 180) / Math.PI;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

interface BoundedText {
  text: string;
  note?: string;
}

function boundText(raw: string): BoundedText {
  if (raw.length <= AI_MAX_TEXT_CHARS) return { text: raw };
  return {
    text: raw.slice(0, AI_MAX_TEXT_CHARS),
    note: `text truncated to ${AI_MAX_TEXT_CHARS} of ${raw.length} characters`,
  };
}

function samplePoints(points: readonly Point[], notes: string[]): readonly AiPoint[] {
  if (points.length > AI_MAX_SAMPLE_POINTS) {
    notes.push(`vertices truncated to ${AI_MAX_SAMPLE_POINTS} of ${points.length}`);
  }
  return points.slice(0, AI_MAX_SAMPLE_POINTS).map(pt);
}

function summarize(entity: Entity, source: AiSnapshotSource): AiObjectSnapshot {
  const notes: string[] = [];
  const geometry: Record<string, AiGeometryValue> = {};
  let text: string | undefined;
  let attributes: AiObjectSnapshot['attributes'];
  let tableText: readonly string[] | undefined;
  const name = (raw: string, label: string): string => {
    const bounded = boundText(raw);
    if (bounded.note) notes.push(`${label}: ${bounded.note}`);
    return bounded.text;
  };

  const withText = (raw: string | undefined): void => {
    if (raw === undefined) return;
    const bounded = boundText(raw);
    text = bounded.text;
    if (bounded.note) notes.push(bounded.note);
  };

  switch (entity.type) {
    case 'line':
      geometry.a = pt(entity.a);
      geometry.b = pt(entity.b);
      geometry.length = dist(entity.a, entity.b);
      break;
    case 'circle':
      geometry.center = pt(entity.center);
      geometry.radius = entity.radius;
      geometry.diameter = entity.radius * 2;
      geometry.circumference = 2 * Math.PI * entity.radius;
      geometry.area = Math.PI * entity.radius * entity.radius;
      break;
    case 'arc':
      geometry.center = pt(entity.center);
      geometry.radius = entity.radius;
      geometry.startAngleDeg = deg(entity.startAngle);
      geometry.endAngleDeg = deg(entity.endAngle);
      break;
    case 'polyline':
      geometry.vertexCount = entity.points.length;
      geometry.closed = entity.closed;
      geometry.vertices = samplePoints(entity.points, notes);
      if (entity.points.length <= AI_MAX_GEOMETRY_POINTS && !entity.widthFrame) {
        geometry.length = polylineLength(entity);
      } else {
        notes.push('polyline length not included: geometry exceeds the measurement work limit or has an affine width frame');
      }
      if (entity.bulges?.length) notes.push('sampled vertices are endpoints; curved segments may lie between them');
      break;
    case 'text':
      geometry.position = pt(entity.position);
      geometry.height = entity.height;
      geometry.rotationDeg = deg(entity.rotation);
      withText(entity.text);
      break;
    case 'mtext':
      geometry.position = pt(entity.position);
      geometry.height = entity.height;
      geometry.width = entity.width;
      geometry.rotationDeg = deg(entity.rotation);
      withText(entity.text);
      break;
    case 'insert': {
      geometry.block = name(entity.block, 'block name');
      geometry.position = pt(entity.position);
      geometry.rotationDeg = deg(entity.rotation);
      geometry.scale = entity.scale;
      if (entity.scaleY !== undefined) geometry.scaleY = entity.scaleY;
      geometry.mirror = entity.mirror ?? false;
      geometry.columns = entity.columns ?? 1;
      geometry.rows = entity.rows ?? 1;
      if (entity.columnSpacing !== undefined) geometry.columnSpacing = entity.columnSpacing;
      if (entity.rowSpacing !== undefined) geometry.rowSpacing = entity.rowSpacing;
      const hidden = new Set((entity.hiddenAttributes ?? []).slice(0, AI_MAX_GEOMETRY_POINTS));
      if ((entity.hiddenAttributes?.length ?? 0) > AI_MAX_GEOMETRY_POINTS) {
        notes.push(`hidden attribute flags are based on the first ${AI_MAX_GEOMETRY_POINTS} hidden tags`);
      }
      const listed: string[] = [];
      for (const tag in entity.attributes) {
        if (!Object.hasOwn(entity.attributes, tag)) continue;
        if (listed.length === AI_MAX_ATTRIBUTES) {
          notes.push(`attributes limited to the first ${AI_MAX_ATTRIBUTES} entries; additional entries excluded`);
          break;
        }
        listed.push(tag);
      }
      listed.sort();
      attributes = listed.map((tag) => {
        const bounded = boundText(entity.attributes[tag]!);
        if (bounded.note) notes.push(`attribute value: ${bounded.note}`);
        const shownTag = name(tag, 'attribute tag');
        return hidden.has(tag)
          ? { tag: shownTag, value: bounded.text, hidden: true }
          : { tag: shownTag, value: bounded.text };
      });
      break;
    }
    case 'ellipse':
      geometry.center = pt(entity.center);
      geometry.majorAxis = pt(entity.majorAxis);
      geometry.ratio = entity.ratio;
      geometry.startParam = entity.startParam;
      geometry.endParam = entity.endParam;
      break;
    case 'point':
      geometry.position = pt(entity.position);
      break;
    case 'xline':
    case 'ray':
      geometry.base = pt(entity.base);
      geometry.direction = pt(entity.direction);
      break;
    case 'spline':
      geometry.degree = entity.degree;
      geometry.controlPointCount = entity.controlPoints.length;
      geometry.closed = entity.closed;
      geometry.controlPoints = samplePoints(entity.controlPoints, notes);
      break;
    case 'hatch':
      geometry.pattern = name(entity.pattern, 'hatch pattern');
      geometry.solid = entity.solid;
      geometry.loopCount = entity.loops.length;
      geometry.angleDeg = deg(entity.angle);
      geometry.scale = entity.scale;
      break;
    case 'leader':
      geometry.vertexCount = entity.vertices.length;
      geometry.vertices = samplePoints(entity.vertices, notes);
      geometry.arrow = entity.arrow;
      withText(entity.text);
      break;
    case 'image':
      // The stored file path is deliberately excluded (docs/AI-ASSISTANT.md).
      geometry.position = pt(entity.position);
      geometry.sizeX = entity.size.x;
      geometry.sizeY = entity.size.y;
      notes.push('image file path is not included');
      break;
    case 'dimension':
      geometry.kind = entity.kind;
      geometry.p1 = pt(entity.p1);
      geometry.p2 = pt(entity.p2);
      geometry.linePoint = pt(entity.linePoint);
      if (entity.text !== undefined && entity.text !== '') {
        withText(entity.text);
        notes.push('dimension text is the stored override; the measured value is not included');
      }
      break;
    case 'table': {
      geometry.position = pt(entity.position);
      geometry.rows = entity.cells.length;
      geometry.columns = entity.columnWidths.length;
      const cells: string[] = [];
      let inspected = 0;
      let truncated = false;
      for (let r = 0; r < entity.cells.length; r++) {
        if (r >= AI_MAX_TABLE_CELLS) { truncated = true; break; }
        const row = entity.cells[r]!;
        for (let c = 0; c < row.length; c++) {
          if (inspected >= AI_MAX_TABLE_CELLS) { truncated = true; break; }
          inspected += 1;
          const cell = row[c]!;
          if (cell.text === '') continue;
          const bounded = boundText(cell.text);
          if (bounded.note) notes.push(`table cell: ${bounded.note}`);
          cells.push(bounded.text);
        }
        if (truncated) break;
      }
      if (truncated) {
        notes.push(`table scan limited to ${AI_MAX_TABLE_CELLS} cells and rows; later cell texts not included`);
      }
      tableText = cells;
      break;
    }
  }

  // Generic bounds can expand entire blocks/tables, format unbounded text,
  // tessellate curves or traverse hatch data. Those are not bounded reads.
  const cheapBounds = ['line', 'circle', 'arc', 'ellipse', 'point', 'xline', 'ray'].includes(entity.type);
  const bounds = cheapBounds ? source.boundsFor(entity) : null;
  if (!cheapBounds) notes.push('bounds enrichment not included for this entity type');
  const layer = name(entity.layer, 'layer name');
  const out: AiObjectSnapshot = {
    id: entity.id,
    type: entity.type,
    layer,
    geometry,
    ...(bounds ? { bounds: { min: pt(bounds.min), max: pt(bounds.max) } } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(attributes !== undefined ? { attributes } : {}),
    ...(tableText !== undefined ? { tableText } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
  return out;
}

/** Build the snapshot for the source's current selection. */
export function buildSelectionSnapshot(source: AiSnapshotSource): AiSnapshot {
  const binding = source.binding();
  for (const value of [binding.space.layout, binding.space.viewport]) {
    if (value !== null && (value.length > AI_MAX_SNAPSHOT_BYTES || byteLength(value) > AI_MAX_SNAPSHOT_BYTES)) {
      throw new AiError('invalid-context', 'The drawing space metadata exceeds the AI context limit.');
    }
  }
  const units = source.units();
  const entities = source.selectedEntities();
  const byId = new Map(entities.map((e) => [e.id, e] as const));

  const omitted: AiOmitted[] = [];
  let omissionBytes = 0;
  let omittedCount = 0;
  const noteOmitted = (id: string, reason: AiOmitted['reason']): void => {
    omittedCount += 1;
    if (omitted.length >= AI_MAX_OMITTED_LISTED || id.length > AI_MAX_SNAPSHOT_BYTES) return;
    const entry = { id, reason };
    const bytes = byteLength(JSON.stringify(entry));
    if (omissionBytes + bytes <= AI_MAX_SNAPSHOT_BYTES / 4) {
      omitted.push(entry);
      omissionBytes += bytes;
    }
  };

  // Selection ids that are not active-space entities: unsupported or stale.
  for (const id of binding.selectionIds) {
    if (!byId.has(id)) noteOmitted(id, source.missingIdKind(id));
  }

  const objects: AiObjectSnapshot[] = [];
  let objectBytes = 0;
  let inspectedObjects = 0;
  for (const entity of entities) {
    if (!SUPPORTED_TYPES.has(entity.type)) {
      noteOmitted(entity.id, 'unsupported-type');
      continue;
    }
    if (inspectedObjects >= AI_MAX_OBJECTS) {
      noteOmitted(entity.id, 'object-limit');
      continue;
    }
    inspectedObjects += 1;
    if (entity.id.length > AI_MAX_SNAPSHOT_BYTES) {
      noteOmitted(entity.id, 'byte-limit');
      continue;
    }
    const object = summarize(entity, source);
    const bytes = byteLength(JSON.stringify(object));
    if (objectBytes + bytes > AI_MAX_SNAPSHOT_BYTES) {
      noteOmitted(entity.id, 'byte-limit');
      continue;
    }
    objects.push(object);
    objectBytes += bytes;
  }

  const space = binding.space.layout === null
    ? ({ kind: 'model' } as const)
    : ({
        kind: 'layout',
        layout: binding.space.layout,
        ...(binding.space.viewport !== null ? { viewport: binding.space.viewport } : {}),
      } as const);

  const unitInfo = {
    insunits: units.insunits,
    insunitsName: INSUNIT_NAMES[units.insunits] ?? `code ${units.insunits}`,
    lunits: units.lunits,
    luprec: units.luprec,
    auprec: units.auprec ?? 0,
  };

  const assemble = (included: readonly AiObjectSnapshot[]): Omit<AiSnapshot, 'serializedBytes'> => ({
    kind: 'jcad.ai.selection-snapshot',
    version: 1,
    units: unitInfo,
    space,
    selection: {
      total: binding.selectionIds.length,
      included: included.length,
      omittedCount,
      omitted: [...omitted],
      omittedListTruncated: omittedCount > omitted.length,
    },
    objects: included,
  });

  // Include the byte-count field itself in the exact wire representation.
  const measured = (included: readonly AiObjectSnapshot[]): AiSnapshot => {
    const payload = assemble(included);
    let snapshot: AiSnapshot = { ...payload, serializedBytes: 0 };
    let bytes = byteLength(serializeSnapshot(snapshot));
    while (snapshot.serializedBytes !== bytes) {
      snapshot = { ...payload, serializedBytes: bytes };
      bytes = byteLength(serializeSnapshot(snapshot));
    }
    return snapshot;
  };

  // Omission metadata is also inside the byte budget. Keep reference IDs
  // intact, trimming listed entries (never the exact count) when necessary.
  let included = objects;
  let snapshot = measured(included);
  while (snapshot.serializedBytes > AI_MAX_SNAPSHOT_BYTES && included.length > 0) {
    const removed = included[included.length - 1]!;
    included = included.slice(0, -1);
    noteOmitted(removed.id, 'byte-limit');
    snapshot = measured(included);
  }
  while (snapshot.serializedBytes > AI_MAX_SNAPSHOT_BYTES && omitted.length > 0) {
    omitted.pop();
    snapshot = measured(included);
  }
  if (snapshot.serializedBytes > AI_MAX_SNAPSHOT_BYTES) {
    throw new AiError('invalid-context', 'The drawing space metadata exceeds the AI context limit.');
  }
  return snapshot;
}

/** The exact text a provider would be given for a snapshot. */
export function serializeSnapshot(snapshot: AiSnapshot): string {
  return JSON.stringify(snapshot);
}
