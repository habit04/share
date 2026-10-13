/**
 * The versioned `JCAD_3D` payload that travels with each solid in a DXF file (see
 * docs/3D-FILE-FORMAT.md): the solid's id, optional name and construction history (`Feature3D`) as
 * JSON, written as XDATA 1000 strings on the solid's polyface mesh. The mesh itself is stored as
 * the polyface's vertex and face records and is authoritative on load; this payload never
 * regenerates geometry.
 *
 * Encoding is bounded (MAX_PAYLOAD_BYTES): a history too large for the file degrades to a
 * `{ kind: 'mesh', source: 'edited' }` feature, and the save flow logs that before writing
 * (`payloadDegradation`). Decoding is strict and hand-validated (no `any`): unknown keys, unknown
 * feature kinds, non-finite numbers or out-of-range sizes make the history invalid, and the caller
 * keeps the solid as a mesh and reports it. Payloads of a newer `v` are recognised and refused.
 */
import type { Point } from '../core/geometry';
import type { Frame3, Vec3 } from './math';
import type { BooleanFeature, Feature3D, Profile3D, Solid3D } from './types';

/** Schema version of the payload JCad writes ("v"). Readers refuse larger values explicitly. */
export const MODEL3D_FILE_VERSION = 1;

/**
 * Largest payload (escaped JSON, 7-bit ASCII, so characters = bytes) one polyface record carries.
 * Chosen well below the per-object extended-data size other CAD programs are reported to accept
 * (not verified here), leaving room for the group overhead.
 */
export const MAX_PAYLOAD_BYTES = 15_000;

/** Characters per XDATA 1000 string (DXF allows 255 bytes per group; JCad's other XDATA uses 250). */
export const PAYLOAD_CHUNK_CHARS = 250;

/** Deepest nesting of boolean operands accepted on read (bounds recursion on hostile input). */
export const MAX_FEATURE_DEPTH = 64;

/** Longest solid name kept from a file (longer names are shortened and reported). */
export const MAX_SOLID_NAME_LENGTH = 255;

/**
 * Tolerance for frames read from a file: each axis of unit length, the axes pairwise orthogonal
 * and zAxis = xAxis x yAxis, all within this absolute amount (frames JCad writes are exact to
 * about 1e-15; the slack admits frames computed by other tools in double precision).
 */
export const FRAME_TOLERANCE = 1e-6;

/** Longest solid id accepted from a file; ids are `newId()` strings, far shorter than this. */
export const MAX_SOLID_ID_LENGTH = 64;

/** Most polyface records one solid may be split into (see io/dxf/mesh3d-write.ts). */
export const MAX_SOLID_PARTS = 1000;

/**
 * The DXF reader's default limits (io/dxf/groups.ts and reader.ts use these numbers): a file
 * beyond any of them is refused by OPEN and by recovery. Because a file JCad cannot reopen must
 * never be written, a DXF save whose 3D solids push the file past them is refused, and an
 * autosave writes its recovery copy without the solids (see model3d/save-guard.ts). Per polyface
 * record the 16-bit counts (32,767 vertices, 32,767 faces) are handled by splitting, not refused.
 */
export const DXF_READ_LIMITS = Object.freeze({
  /** Group pairs (code + value lines) per file. */
  maxPairs: 2_000_000,
  /** Records (0 groups: every POLYLINE, VERTEX and SEQEND counts) per file. */
  maxRecords: 250_000,
  /** Characters of DXF text per file (128 MB). */
  maxSourceLength: 128 * 1024 * 1024,
});

/** What a reader learns from one payload. */
export type SolidPayload =
  /** Well-formed v1 data. `part` > 0 marks a continuation record of a split mesh (no feature). */
  | { readonly status: 'ok'; readonly id?: string; readonly name?: string; readonly nameCleaned?: true; readonly feature?: Feature3D; readonly part: number; readonly parts: number }
  /** The envelope is readable but the history is not (reason says why): keep the mesh, report it. */
  | { readonly status: 'bad-feature'; readonly id?: string; readonly name?: string; readonly nameCleaned?: true; readonly reason: string; readonly part: number; readonly parts: number }
  /** Written by a newer JCad: id / name when they look valid, the rest is not interpreted. */
  | { readonly status: 'newer'; readonly version: number; readonly id?: string; readonly name?: string }
  /** Not a JCad 3D payload at all (bad JSON, wrong shape, too large). */
  | { readonly status: 'invalid'; readonly reason: string };

/** How much of a solid's data its payload can carry within MAX_PAYLOAD_BYTES. */
export type PayloadDegradation = 'none' | 'history' | 'history-and-name';

type Json = Record<string, unknown>;

/**
 * Escape JSON for an AC1015 DXF string: 7-bit ASCII only (the 255-byte group limit holds in any
 * code page and the writer's `\U+` escaping never touches it), no whitespace (the tokenizer trims
 * values, which would eat spaces at chunk boundaries) and no literal `\\` pairs (the reader decodes
 * `\U+XXXX` anywhere in the file, which must not reach a JSON-escaped backslash).
 */
function escapeJson(json: string): string {
  return json
    .replace(/\\\\/g, '\\u005c')
    .replace(/[^\x21-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function envelope(solid: Solid3D, mode: PayloadDegradation, parts: number): string {
  const body: Json = { v: MODEL3D_FILE_VERSION, id: solid.id };
  if (solid.name !== undefined && mode !== 'history-and-name') body.name = solid.name;
  body.feature = mode === 'none' ? solid.feature : { kind: 'mesh', source: 'edited' };
  if (parts > 1) body.parts = parts;
  return escapeJson(JSON.stringify(body));
}

/** The first record's payload text and what had to be left out to fit (see MAX_PAYLOAD_BYTES). */
export function encodeSolidPayload(solid: Solid3D, parts = 1): { readonly text: string; readonly degradation: PayloadDegradation } {
  for (const mode of ['none', 'history', 'history-and-name'] as const) {
    const text = envelope(solid, mode, parts);
    if (text.length <= MAX_PAYLOAD_BYTES) return { text, degradation: mode };
  }
  // The id is validated short by every producer; an absurd one is a programming error.
  throw new RangeError(`The id of 3D solid "${solid.id.slice(0, 40)}" is too long to save.`);
}

/** Payload of continuation record `part` (1-based after the first) of a solid split into `parts`. */
export function encodePartPayload(solid: Solid3D, part: number, parts: number): string {
  return escapeJson(JSON.stringify({ v: MODEL3D_FILE_VERSION, id: solid.id, part, parts }));
}

/** What `encodeSolidPayload` would have to leave out for this solid (the save flow logs it). */
export function payloadDegradation(solid: Solid3D): PayloadDegradation {
  return encodeSolidPayload(solid).degradation;
}

/** Split payload text into XDATA 1000 strings of at most PAYLOAD_CHUNK_CHARS characters. */
export function payloadChunks(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += PAYLOAD_CHUNK_CHARS) out.push(text.slice(i, i + PAYLOAD_CHUNK_CHARS));
  return out;
}

// ---------------------------------------------------------------- decoding

class FeatureError extends Error {}

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(path: string, what: string): never {
  throw new FeatureError(`${path} ${what}`);
}

function keysOnly(o: Json, path: string, required: readonly string[], optional: readonly string[] = []): void {
  for (const k of required) if (!Object.prototype.hasOwnProperty.call(o, k)) fail(path, `is missing "${k}"`);
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) fail(path, `has an unknown field "${k}"`);
}

function finite(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'must be a finite number');
  return v;
}

function positive(v: unknown, path: string): number {
  const n = finite(v, path);
  if (!(n > 0)) fail(path, 'must be positive');
  return n;
}

function vec3(v: unknown, path: string): Vec3 {
  if (!isObject(v)) fail(path, 'must be an {x, y, z} object');
  keysOnly(v, path, ['x', 'y', 'z']);
  return { x: finite(v.x, `${path}.x`), y: finite(v.y, `${path}.y`), z: finite(v.z, `${path}.z`) };
}

function point(v: unknown, path: string): Point {
  if (!isObject(v)) fail(path, 'must be an {x, y} object');
  keysOnly(v, path, ['x', 'y']);
  return { x: finite(v.x, `${path}.x`), y: finite(v.y, `${path}.y`) };
}

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** A placement frame: finite, unit axes, pairwise orthogonal, right-handed (z = x × y), within FRAME_TOLERANCE. */
function frame(v: unknown, path: string): Frame3 {
  if (!isObject(v)) fail(path, 'must be a frame object');
  keysOnly(v, path, ['origin', 'xAxis', 'yAxis', 'zAxis']);
  const f: Frame3 = { origin: vec3(v.origin, `${path}.origin`), xAxis: vec3(v.xAxis, `${path}.xAxis`), yAxis: vec3(v.yAxis, `${path}.yAxis`), zAxis: vec3(v.zAxis, `${path}.zAxis`) };
  for (const axis of ['xAxis', 'yAxis', 'zAxis'] as const) {
    if (Math.abs(Math.sqrt(dot(f[axis], f[axis])) - 1) > FRAME_TOLERANCE) fail(`${path}.${axis}`, 'must be a unit vector');
  }
  if (Math.abs(dot(f.xAxis, f.yAxis)) > FRAME_TOLERANCE || Math.abs(dot(f.yAxis, f.zAxis)) > FRAME_TOLERANCE || Math.abs(dot(f.zAxis, f.xAxis)) > FRAME_TOLERANCE) fail(path, 'axes must be pairwise orthogonal');
  const x = f.xAxis, y = f.yAxis, z = f.zAxis;
  const c = { x: x.y * y.z - x.z * y.y, y: x.z * y.x - x.x * y.z, z: x.x * y.y - x.y * y.x };
  if (Math.abs(c.x - z.x) > FRAME_TOLERANCE || Math.abs(c.y - z.y) > FRAME_TOLERANCE || Math.abs(c.z - z.z) > FRAME_TOLERANCE) fail(`${path}.zAxis`, 'must equal xAxis × yAxis (a right-handed frame)');
  return f;
}

function profile(v: unknown, path: string): Profile3D {
  if (!isObject(v)) fail(path, 'must be a profile object');
  keysOnly(v, path, ['frame', 'loops']);
  if (!Array.isArray(v.loops) || v.loops.length === 0) fail(`${path}.loops`, 'must be a non-empty array');
  const raw: readonly unknown[] = v.loops;
  const loops = raw.map((loop, i) => {
    if (!Array.isArray(loop) || loop.length < 3) fail(`${path}.loops[${i}]`, 'must be an array of at least 3 points');
    const pts: readonly unknown[] = loop;
    return pts.map((p, k) => point(p, `${path}.loops[${i}][${k}]`));
  });
  return { frame: frame(v.frame, `${path}.frame`), loops };
}

/** Optional tessellation count: kept when it is a finite number (primitives clamp it). */
function optionalCount(o: Json, key: string, path: string): Record<string, number> {
  return o[key] === undefined ? {} : { [key]: finite(o[key], `${path}.${key}`) };
}

function feature(v: unknown, path: string, depth: number): Feature3D {
  if (depth > MAX_FEATURE_DEPTH) fail(path, `nests deeper than ${MAX_FEATURE_DEPTH} levels`);
  if (!isObject(v)) fail(path, 'must be a feature object');
  const kind = v.kind;
  switch (kind) {
    case 'box':
    case 'wedge':
      keysOnly(v, path, ['kind', 'frame', 'width', 'depth', 'height']);
      return { kind, frame: frame(v.frame, `${path}.frame`), width: positive(v.width, `${path}.width`), depth: positive(v.depth, `${path}.depth`), height: positive(v.height, `${path}.height`) };
    case 'cylinder':
      keysOnly(v, path, ['kind', 'frame', 'radius', 'height'], ['segments']);
      return { kind, frame: frame(v.frame, `${path}.frame`), radius: positive(v.radius, `${path}.radius`), height: positive(v.height, `${path}.height`), ...optionalCount(v, 'segments', path) };
    case 'sphere':
      keysOnly(v, path, ['kind', 'frame', 'radius'], ['segments', 'rings']);
      return { kind, frame: frame(v.frame, `${path}.frame`), radius: positive(v.radius, `${path}.radius`), ...optionalCount(v, 'segments', path), ...optionalCount(v, 'rings', path) };
    case 'cone': {
      keysOnly(v, path, ['kind', 'frame', 'baseRadius', 'topRadius', 'height'], ['segments']);
      const baseRadius = finite(v.baseRadius, `${path}.baseRadius`), topRadius = finite(v.topRadius, `${path}.topRadius`);
      if (baseRadius < 0 || topRadius < 0 || (baseRadius === 0 && topRadius === 0)) fail(path, 'needs radii >= 0, not both 0');
      return { kind, frame: frame(v.frame, `${path}.frame`), baseRadius, topRadius, height: positive(v.height, `${path}.height`), ...optionalCount(v, 'segments', path) };
    }
    case 'torus': {
      keysOnly(v, path, ['kind', 'frame', 'majorRadius', 'minorRadius'], ['segments', 'rings']);
      const majorRadius = positive(v.majorRadius, `${path}.majorRadius`), minorRadius = positive(v.minorRadius, `${path}.minorRadius`);
      if (minorRadius >= majorRadius) fail(path, 'needs minorRadius < majorRadius');
      return { kind, frame: frame(v.frame, `${path}.frame`), majorRadius, minorRadius, ...optionalCount(v, 'segments', path), ...optionalCount(v, 'rings', path) };
    }
    case 'extrude': {
      keysOnly(v, path, ['kind', 'profile', 'distance']);
      const distance = finite(v.distance, `${path}.distance`);
      if (distance === 0) fail(`${path}.distance`, 'must not be 0');
      return { kind, profile: profile(v.profile, `${path}.profile`), distance };
    }
    case 'revolve': {
      // `segments` (steps per full turn) is part of a revolve's history (types.ts RevolveFeature).
      keysOnly(v, path, ['kind', 'profile', 'axis', 'angle'], ['segments']);
      if (!isObject(v.axis)) fail(`${path}.axis`, 'must be an {origin, dir} object');
      keysOnly(v.axis, `${path}.axis`, ['origin', 'dir']);
      const angle = finite(v.angle, `${path}.angle`);
      if (angle === 0) fail(`${path}.angle`, 'must not be 0');
      const dir = vec3(v.axis.dir, `${path}.axis.dir`);
      if (!(Math.sqrt(dot(dir, dir)) > 0)) fail(`${path}.axis.dir`, 'must not be the zero vector');
      return { kind, profile: profile(v.profile, `${path}.profile`), axis: { origin: vec3(v.axis.origin, `${path}.axis.origin`), dir }, angle, ...optionalCount(v, 'segments', path) };
    }
    case 'boolean': {
      keysOnly(v, path, ['kind', 'op', 'operands']);
      const op = v.op;
      if (op !== 'union' && op !== 'subtract' && op !== 'intersect') fail(`${path}.op`, 'must be union, subtract or intersect');
      if (!Array.isArray(v.operands) || v.operands.length !== 2) fail(`${path}.operands`, 'must hold exactly two features');
      const raw: readonly unknown[] = v.operands;
      const operands = raw.map((x, i) => feature(x, `${path}.operands[${i}]`, depth + 1));
      const result: BooleanFeature = { kind, op, operands };
      return result;
    }
    case 'mesh': {
      keysOnly(v, path, ['kind', 'source']);
      const source = v.source;
      if (source !== 'imported' && source !== 'edited') fail(`${path}.source`, 'must be imported or edited');
      return { kind, source };
    }
    default:
      return fail(`${path}.kind`, typeof kind === 'string' ? `"${kind.slice(0, 40)}" is not a known feature kind` : 'is missing');
  }
}

/**
 * Strictly validate a parsed `Feature3D`: a fresh copy holding only the known fields, or an Error
 * message naming the first problem (a JSON path such as `feature.operands[1].radius`).
 */
export function validateFeature(value: unknown): { readonly feature: Feature3D } | { readonly problem: string } {
  try {
    return { feature: feature(value, 'feature', 0) };
  } catch (err) {
    if (err instanceof FeatureError) return { problem: err.message };
    throw err;
  }
}

/** A well-formed solid id from a file (`newId()` style: letters, digits, `_ - . :`), else undefined. */
export function validSolidId(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_SOLID_ID_LENGTH && /^[A-Za-z0-9_.:-]+$/.test(v) ? v : undefined;
}

/**
 * A name as kept from a file: control characters removed and at most MAX_SOLID_NAME_LENGTH
 * characters. `cleaned` says whether anything changed (the reader reports it).
 */
export function cleanSolidName(raw: string): { readonly name: string; readonly cleaned: boolean } {
  const name = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, MAX_SOLID_NAME_LENGTH);
  return { name, cleaned: name !== raw };
}

function validName(v: unknown): { name: string; cleaned: boolean } | undefined {
  return typeof v === 'string' ? cleanSolidName(v) : undefined;
}

function partInfo(o: Json): { part: number; parts: number } | string {
  const parts = o.parts === undefined ? 1 : o.parts;
  const part = o.part === undefined ? 0 : o.part;
  if (typeof parts !== 'number' || !Number.isInteger(parts) || parts < 1 || parts > MAX_SOLID_PARTS) return `"parts" must be an integer from 1 to ${MAX_SOLID_PARTS}`;
  if (typeof part !== 'number' || !Number.isInteger(part) || part < 0 || part >= parts) return '"part" must be an integer below "parts"';
  return { part, parts };
}

/**
 * Decode one payload (the joined 1000 strings of a `JCAD_3D` record). Never throws: every outcome,
 * including malformed input, is a `SolidPayload` the reader turns into a solid or a report item.
 */
export function decodeSolidPayload(text: string): SolidPayload {
  if (text.length > MAX_PAYLOAD_BYTES) return { status: 'invalid', reason: `the data exceeds ${MAX_PAYLOAD_BYTES.toLocaleString('en-US')} bytes` };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { status: 'invalid', reason: 'the data is not valid JSON' };
  }
  if (!isObject(data)) return { status: 'invalid', reason: 'the data is not a JSON object' };
  const v = data.v;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return { status: 'invalid', reason: 'the data has no valid version "v"' };
  const id = validSolidId(data.id);
  const named = validName(data.name);
  const name = named?.name;
  if (v > MODEL3D_FILE_VERSION) return { status: 'newer', version: v, ...(id !== undefined ? { id } : {}), ...(name !== undefined ? { name } : {}) };
  const info = partInfo(data);
  if (typeof info === 'string') return { status: 'invalid', reason: info };
  const envelopeKeys = info.part > 0 ? ['v', 'id', 'part', 'parts'] : ['v', 'id', 'name', 'feature', 'parts'];
  const unknown = Object.keys(data).find((k) => !envelopeKeys.includes(k));
  const base = { ...(id !== undefined ? { id } : {}), ...(name !== undefined ? { name } : {}), ...(named?.cleaned ? { nameCleaned: true as const } : {}), ...info };
  if (unknown) return { status: 'bad-feature', ...base, reason: `the data has an unknown field "${unknown.slice(0, 40)}"` };
  if (data.name !== undefined && name === undefined) return { status: 'bad-feature', ...base, reason: 'the name is not a string' };
  if (info.part > 0) return id === undefined ? { status: 'invalid', reason: 'a continuation record has no valid solid id' } : { status: 'ok', id, part: info.part, parts: info.parts };
  const checked = validateFeature(data.feature);
  if ('problem' in checked) return { status: 'bad-feature', ...base, reason: checked.problem };
  return { status: 'ok', ...base, feature: checked.feature };
}
