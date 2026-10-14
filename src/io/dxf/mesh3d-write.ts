/**
 * 3D solids, writer side: each `Solid3D` becomes a DXF polyface mesh (POLYLINE flag 64, mesh
 * VERTEX records flag 192, face records flag 128, SEQEND) carrying the `JCAD_3D` XDATA payload of
 * src/model3d/file-format.ts. The layout follows the DXF reference for polyface meshes (not
 * verified in AutoCAD or other programs, which are expected to show a plain mesh); JCad reads the
 * payload back (io/dxf/mesh3d-read.ts). See docs/3D-FILE-FORMAT.md for the record layout.
 *
 * Coordinates are written with the shortest decimal text that reads back as the same double (the
 * 2D writer's 10-decimal rounding would change tessellated vertices), so a mesh round-trips
 * exactly. A mesh beyond the 16-bit polyface counts (MAX_POLYFACE_VERTICES / MAX_POLYFACE_FACES)
 * is split into several polyface records of the same solid.
 */
import type { Solid3D } from '../../model3d/types';
import { meshTriangleCount, validateMesh } from '../../model3d/mesh';
import { encodePartPayload, encodeSolidPayload, MAX_SOLID_PARTS, payloadChunks } from '../../model3d/file-format';
import { MODEL3D_APP } from './codes';
import type { Writer } from './write-core';

/** Most vertices of one polyface record: its counts and face indices are 16-bit DXF integers. */
export const MAX_POLYFACE_VERTICES = 32767;
/** Most faces of one polyface record (group 72 is a 16-bit integer too). */
export const MAX_POLYFACE_FACES = 32767;

/**
 * A finite number as plain decimal text that `Number()` reads back bit-exactly: the shortest
 * round-trip digits of `String(n)`, with exponent notation expanded (some DXF readers do not
 * accept `1e-7`). Negative zero is written as 0.
 */
export function exactReal(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError('DXF coordinates of 3D objects must be finite numbers.');
  if (n === 0) return '0';
  const s = String(n);
  const e = s.indexOf('e');
  if (e < 0) return s;
  const negative = s.startsWith('-');
  const mantissa = s.slice(negative ? 1 : 0, e);
  const exp = Number(s.slice(e + 1));
  const dot = mantissa.indexOf('.');
  const digits = mantissa.replace('.', '');
  const point = (dot < 0 ? mantissa.length : dot) + exp;
  let out: string;
  if (point <= 0) out = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return negative ? `-${out}` : out;
}

/** One polyface record: global vertex ids in local order (null = every vertex in order) and local faces. */
interface Part {
  readonly vertices: readonly number[] | null;
  readonly faces: readonly number[];
}

/**
 * Split a mesh into polyface-sized parts. A mesh within the limits is one part holding every
 * vertex in stored order (so unreferenced vertices and numbering survive); a larger one is cut
 * into runs of consecutive triangles, each with the vertices it uses in first-use order.
 */
function partsOf(positions: readonly number[], indices: readonly number[]): Part[] {
  const nv = positions.length / 3, nt = indices.length / 3;
  if (nv <= MAX_POLYFACE_VERTICES && nt <= MAX_POLYFACE_FACES) return [{ vertices: null, faces: indices }];
  const parts: Part[] = [];
  let local = new Map<number, number>();
  let vertices: number[] = [];
  let faces: number[] = [];
  for (let t = 0; t < nt; t++) {
    const tri = [indices[3 * t]!, indices[3 * t + 1]!, indices[3 * t + 2]!];
    const added = tri.filter((v, k) => !local.has(v) && tri.indexOf(v) === k).length;
    if (faces.length / 3 + 1 > MAX_POLYFACE_FACES || vertices.length + added > MAX_POLYFACE_VERTICES) {
      parts.push({ vertices, faces });
      local = new Map();
      vertices = [];
      faces = [];
    }
    for (const v of tri) {
      let l = local.get(v);
      if (l === undefined) {
        l = vertices.length;
        local.set(v, l);
        vertices.push(v);
      }
      faces.push(l);
    }
  }
  if (faces.length) parts.push({ vertices, faces });
  return parts;
}

function writeRecordHead(w: Writer, kind: string, owner: string, solid: Solid3D): string {
  const handle = w.nextHandle();
  w.pair(0, kind);
  w.pair(5, handle);
  w.pair(330, owner);
  w.pair(100, 'AcDbEntity');
  w.pair(8, solid.layer);
  if (solid.color !== 'ByLayer') w.pair(62, solid.color);
  return handle;
}

function writePart(w: Writer, solid: Solid3D, owner: string, part: Part, payload: string, partIndex: number): void {
  const p = solid.mesh.positions;
  const ids = part.vertices;
  const nv = ids ? ids.length : p.length / 3;
  const nf = part.faces.length / 3;
  const polyline = writeRecordHead(w, 'POLYLINE', owner, solid);
  w.anchor(polyline, { kind: 'solid3d', id: solid.id, ...(partIndex ? { part: `polyface:${partIndex}` } : {}) });
  w.pair(100, 'AcDbPolyFaceMesh');
  w.pair(66, 1);
  w.pair(10, 0);
  w.pair(20, 0);
  w.pair(30, 0);
  w.pair(70, 64);
  w.pair(71, nv);
  w.pair(72, nf);
  w.pair(1001, MODEL3D_APP);
  for (const chunk of payloadChunks(payload)) w.pair(1000, chunk);
  for (let i = 0; i < nv; i++) {
    const g = ids ? ids[i]! : i;
    const handle = writeRecordHead(w, 'VERTEX', polyline, solid);
    w.anchor(handle, { kind: 'solid3d', id: solid.id, part: `polyface:${partIndex}:vertex:${i}:mesh:${g}` });
    w.pair(100, 'AcDbVertex');
    w.pair(100, 'AcDbPolyFaceMeshVertex');
    w.pair(10, exactReal(p[3 * g]!));
    w.pair(20, exactReal(p[3 * g + 1]!));
    w.pair(30, exactReal(p[3 * g + 2]!));
    w.pair(70, 192);
  }
  for (let f = 0; f < nf; f++) {
    const handle = writeRecordHead(w, 'VERTEX', polyline, solid);
    w.anchor(handle, { kind: 'solid3d', id: solid.id, part: `polyface:${partIndex}:face:${f}` });
    w.pair(100, 'AcDbFaceRecord');
    w.pair(10, 0);
    w.pair(20, 0);
    w.pair(30, 0);
    w.pair(70, 128);
    // 1-based vertex numbers; positive = visible edge.
    w.pair(71, part.faces[3 * f]! + 1);
    w.pair(72, part.faces[3 * f + 1]! + 1);
    w.pair(73, part.faces[3 * f + 2]! + 1);
  }
  w.pair(0, 'SEQEND');
  const end = w.nextHandle();
  w.pair(5, end);
  w.anchor(end, { kind: 'solid3d', id: solid.id, part: `polyface:${partIndex}:seqend` });
  w.pair(330, polyline);
  w.pair(100, 'AcDbEntity');
  w.pair(8, solid.layer);
}

/**
 * Write one solid as one or more polyface records owned by `owner` (the model-space block
 * record). Throws an Error for a mesh that cannot be stored (invalid, or without triangles):
 * the save then fails visibly instead of writing a file that loses or corrupts the solid.
 */
export function writeSolid(w: Writer, solid: Solid3D, owner: string): void {
  const problem = validateMesh(solid.mesh) ?? (meshTriangleCount(solid.mesh) === 0 ? 'the mesh has no triangles' : null);
  if (problem) throw new Error(`3D solid ${solid.name ? `"${solid.name}"` : solid.id} cannot be saved: ${problem}.`);
  const parts = partsOf(solid.mesh.positions, solid.mesh.indices);
  if (parts.length > MAX_SOLID_PARTS) throw new Error(`3D solid ${solid.id} cannot be saved: its mesh needs more than ${MAX_SOLID_PARTS} polyface records.`);
  parts.forEach((part, k) => writePart(w, solid, owner, part, k === 0 ? encodeSolidPayload(solid, parts.length).text : encodePartPayload(solid, k, parts.length), k));
}
