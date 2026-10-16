import type { Entity } from '../core/entities';
import type { Point } from '../core/geometry';
import { INSUNIT_NAMES } from '../core/units';
import {
  AI_MAX_ATTRIBUTES,
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

function polylineLength(points: readonly Point[], closed: boolean): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1]!, points[i]!);
  if (closed && points.length > 2) total += dist(points[points.length - 1]!, points[0]!);
  return total;
}

function summarize(entity: Entity, source: AiSnapshotSource): AiObjectSnapshot {
  const notes: string[] = [];
  const geometry: Record<string, AiGeometryValue> = {};
  let text: string | undefined;
  let attributes: AiObjectSnapshot['attributes'];
  let tableText: readonly string[] | undefined;

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
      geometry.length = polylineLength(entity.points, entity.closed);
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
      geometry.block = entity.block;
      geometry.position = pt(entity.position);
      geometry.rotationDeg = deg(entity.rotation);
      geometry.scale = entity.scale;
      if (entity.scaleY !== undefined) geometry.scaleY = entity.scaleY;
      const hidden = new Set(entity.hiddenAttributes ?? []);
      const tags = Object.keys(entity.attributes).sort();
      const listed = tags.slice(0, AI_MAX_ATTRIBUTES);
      if (tags.length > listed.length) {
        notes.push(`attributes truncated to ${AI_MAX_ATTRIBUTES} of ${tags.length}`);
      }
      attributes = listed.map((tag) => {
        const bounded = boundText(entity.attributes[tag]!);
        if (bounded.note) notes.push(`attribute ${tag}: ${bounded.note}`);
        return hidden.has(tag)
          ? { tag, value: bounded.text, hidden: true }
          : { tag, value: bounded.text };
      });
      break;
    }
    case 'ellipse':
      geometry.center = pt(entity.center);
      geometry.majorAxis = pt(entity.majorAxis);
      geometry.ratio = entity.ratio;
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
      geometry.pattern = entity.pattern;
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
      geometry.columns = entity.cells.reduce((max, row) => Math.max(max, row.length), 0);
      const cells: string[] = [];
      let totalCells = 0;
      for (const row of entity.cells) {
        for (const cell of row) {
          if (cell.text === '') continue;
          totalCells += 1;
          if (cells.length < AI_MAX_TABLE_CELLS) {
            const bounded = boundText(cell.text);
            if (bounded.note) notes.push(`table cell: ${bounded.note}`);
            cells.push(bounded.text);
          }
        }
      }
      if (totalCells > cells.length) {
        notes.push(`table cells truncated to ${AI_MAX_TABLE_CELLS} of ${totalCells}`);
      }
      tableText = cells;
      break;
    }
  }

  const bounds = source.boundsFor(entity);
  const out: AiObjectSnapshot = {
    id: entity.id,
    type: entity.type,
    layer: entity.layer,
    geometry,
    ...(bounds ? { bounds: { min: pt(bounds.min), max: pt(bounds.max) } } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(attributes !== undefined ? { attributes } : {}),
    ...(tableText !== undefined ? { tableText } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
  return out;
}

function serialize(snapshot: Omit<AiSnapshot, 'serializedBytes'>): string {
  return JSON.stringify(snapshot);
}

/** Build the snapshot for the source's current selection. */
export function buildSelectionSnapshot(source: AiSnapshotSource): AiSnapshot {
  const binding = source.binding();
  const units = source.units();
  const entities = source.selectedEntities();
  const byId = new Map(entities.map((e) => [e.id, e] as const));

  const omitted: AiOmitted[] = [];
  let omittedCount = 0;
  const noteOmitted = (id: string, reason: AiOmitted['reason']): void => {
    omittedCount += 1;
    if (omitted.length < AI_MAX_OMITTED_LISTED) omitted.push({ id, reason });
  };

  // Selection ids that are not active-space entities: unsupported or stale.
  for (const id of binding.selectionIds) {
    if (!byId.has(id)) noteOmitted(id, source.missingIdKind(id));
  }

  const objects: AiObjectSnapshot[] = [];
  for (const entity of entities) {
    if (!SUPPORTED_TYPES.has(entity.type)) {
      noteOmitted(entity.id, 'unsupported-type');
      continue;
    }
    if (objects.length >= AI_MAX_OBJECTS) {
      noteOmitted(entity.id, 'object-limit');
      continue;
    }
    objects.push(summarize(entity, source));
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

  // Byte cap: omit whole objects from the end until the snapshot fits.
  // Object contents are already individually bounded, so this terminates.
  let included = objects;
  let bytes = byteLength(serialize(assemble(included)));
  while (bytes > AI_MAX_SNAPSHOT_BYTES && included.length > 0) {
    const removed = included[included.length - 1]!;
    included = included.slice(0, -1);
    noteOmitted(removed.id, 'byte-limit');
    bytes = byteLength(serialize(assemble(included)));
  }

  return { ...assemble(included), serializedBytes: bytes };
}

/** The exact text a provider would be given for a snapshot. */
export function serializeSnapshot(snapshot: AiSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}
