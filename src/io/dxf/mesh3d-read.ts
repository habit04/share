/**
 * 3D solids, reader side: model-space polyface meshes (POLYLINE flag 64 with its VERTEX records)
 * into `Solid3D`s. See docs/3D-FILE-FORMAT.md.
 *
 * - A polyface with `JCAD_3D` XDATA (written by JCad) is always read, whether or not the
 *   experimental 3D setting is on: it came from JCad, and Save writes it back, so a 2D user never
 *   loses it. Its stored faces are the mesh (exactly; never re-tessellated from the history), its
 *   payload gives the id, name and construction history (src/model3d/file-format.ts). A history
 *   that does not validate, or a payload of a newer version, leaves a mesh solid and a report item.
 * - A polyface without that data (AutoCAD and other programs) becomes a `mesh`-feature solid only
 *   when the reader is told 3D is enabled (`DxfReadOptions.model3d`), with a `simplified` item;
 *   otherwise it is dropped and reported exactly as before milestone 5.
 * - Quadrilateral faces are split into two triangles; faces with fewer than three distinct
 *   vertices (edges) are not kept and reported; a face that names a vertex the record does not
 *   have, a non-polyface VERTEX or an unreadable number drops the whole record with a reason.
 *
 * Every drop or simplification is an import-report item: geometry is never discarded silently.
 */
import type { Obj } from './groups';
import { has, isIntegerText, num, shortText, str } from './groups';
import { isIntCode, isRealCode, isRealText, MODEL3D_APP } from './codes';
import { reportObj, type ReadContext } from './read-core';
import type { ColorSpec } from '../../core/entities';
import { newId } from '../../core/entities';
import type { ImportReportBuilder } from '../import-report';
import type { Dimension3D, Feature3D, Solid3D } from '../../model3d/types';
import { acceptsDimension3D, offPlusZ, readDimension3DRecord } from './dim3d-read';
import { type Mesh3D, meshIsClosed, validateMesh, weldVertices } from '../../model3d/mesh';
import { newSolid } from '../../model3d/model';
import { decodeSolidPayload, MAX_PAYLOAD_BYTES, MAX_SOLID_NAME_LENGTH, MODEL3D_FILE_VERSION, type SolidPayload } from '../../model3d/file-format';

/** Report reason for a foreign polyface imported as a mesh solid. */
export const FOREIGN_POLYFACE_REASON = 'imported polyface mesh: not editable parametrically';

/** Report reason (unchanged since before 3D support) for a polyface the reader does not import. */
export const POLYFACE_UNSUPPORTED_REASON = 'polyface meshes are not supported';

const IMPORTED: Feature3D = { kind: 'mesh', source: 'imported' };

const nameNote = `the name was shortened to ${MAX_SOLID_NAME_LENGTH} characters or had control characters removed`;

/** One polyface record read, before multi-record solids are joined. */
interface PartRecord {
  readonly obj: Obj;
  readonly where?: string;
  readonly id?: string;
  readonly name?: string;
  readonly feature: Feature3D;
  /** Index of this record among the solid's records (0 = first, carries the history). */
  readonly part: number;
  readonly parts: number;
  /** True for a continuation record (part > 0) of a JCad solid split into several records. */
  readonly continuation: boolean;
  readonly mesh: Mesh3D;
  readonly layer: string;
  readonly color: ColorSpec;
}

/** The `JCAD_3D` payload text of a record, null when it has none, or a problem. */
export function payloadText(o: Obj): { text: string } | { problem: string } | null {
  let found = false, active = false, bytes = 0;
  const chunks: string[] = [];
  for (const p of o.groups) {
    if (p.code === 1001) {
      active = p.value.trim() === MODEL3D_APP;
      if (active && found) return { problem: 'the record has the JCad 3D data twice' };
      if (active) found = true;
      continue;
    }
    if (!active) continue;
    if (p.code !== 1000) return { problem: `unexpected XDATA group ${p.code} in the JCad 3D data` };
    if (p.value.length > 255) return { problem: 'an XDATA string exceeds 255 characters' };
    bytes += p.value.length;
    if (bytes > MAX_PAYLOAD_BYTES) return { problem: `the JCad 3D data exceeds ${MAX_PAYLOAD_BYTES.toLocaleString('en-US')} bytes` };
    chunks.push(p.value);
  }
  return found ? { text: chunks.join('') } : null;
}

/** The first unreadable numeric group of the record or its vertices, described for the report. */
export function invalidNumber(objs: readonly Obj[]): string | null {
  for (const o of objs) {
    for (const p of o.groups) {
      if (p.code >= 1000) break;
      const bad = (isRealCode(p.code) && (!isRealText(p.value) || !Number.isFinite(Number(p.value)))) || (isIntCode(p.code) && !isIntegerText(p.value.trim()));
      if (bad) return `invalid numeric group ${p.code} at line ${(p.line ?? 1) + 1}: "${shortText(p.value)}" must be a complete ${isIntCode(p.code) ? 'integer' : 'number'}`;
    }
  }
  return null;
}

/** The record's ACI colour (62); an out-of-range value gives ByLayer and a report reason. */
export function colorOf(o: Obj): { color: ColorSpec; problem?: string } {
  if (!has(o, 62)) return { color: 'ByLayer' };
  const c = Math.trunc(num(o, 62));
  if (c === 256) return { color: 'ByLayer' };
  if (c >= 0 && c <= 255) return { color: c };
  return { color: 'ByLayer', problem: `colour ${c} is not an ACI colour (0 to 256): ByLayer is used` };
}

/** Faces of the record as triangles, or why the record cannot be read. */
interface FaceResult {
  readonly mesh: Mesh3D;
  readonly quads: number;
  readonly degenerate: number;
}

function readFaces(vertices: readonly Obj[]): FaceResult | { problem: string } {
  const positions: number[] = [];
  const faces: number[][] = [];
  for (const v of vertices) {
    const flags = Math.trunc(num(v, 70));
    if ((flags & 128) === 0) return { problem: `VERTEX${has(v, 5) ? ` ${str(v, 5)}` : ''} is neither a polyface mesh vertex nor a face record (flags ${flags})` };
    if (flags & 64) {
      const missing = [10, 20, 30].find((code) => !has(v, code));
      if (missing !== undefined) return { problem: `mesh vertex ${positions.length / 3 + 1} has no coordinate group ${missing}` };
      positions.push(num(v, 10), num(v, 20), num(v, 30));
    }
    else faces.push([71, 72, 73, 74].map((code) => (has(v, code) ? Math.trunc(num(v, code)) : 0)));
  }
  const nv = positions.length / 3;
  const indices: number[] = [];
  let quads = 0, degenerate = 0;
  for (let f = 0; f < faces.length; f++) {
    const refs = faces[f]!.filter((i) => i !== 0).map((i) => Math.abs(i));
    const bad = refs.find((i) => i > nv);
    if (bad !== undefined) return { problem: `face record ${f + 1} refers to vertex ${bad}, but the mesh has ${nv} vertices` };
    // Drop repeated corners (a triangle written as a quad repeats its last vertex).
    const ring = refs.filter((i, k) => i !== refs[(k + refs.length - 1) % refs.length] || refs.length === 1);
    const unique = new Set(ring).size;
    if (ring.length < 3 || unique !== ring.length) {
      degenerate += 1;
      continue;
    }
    const [a, b, c, d] = ring.map((i) => i - 1);
    indices.push(a!, b!, c!);
    if (d !== undefined) {
      indices.push(a!, c!, d);
      quads += 1;
    }
  }
  return { mesh: { positions, indices }, quads, degenerate };
}

/**
 * Join the records of a split mesh: every pair of vertices with exactly the same coordinates
 * becomes one (the copies the writer made at each cut, but also coincident vertices the original
 * kept apart, so the vertex count may change), in first-occurrence order; every triangle is kept
 * (unlike `weldVertices`, no degenerate triangle is dropped).
 */
function joinParts(meshes: readonly Mesh3D[]): Mesh3D {
  const positions: number[] = [];
  const indices: number[] = [];
  const seen = new Map<string, number>();
  for (const m of meshes) {
    const local: number[] = [];
    for (let i = 0; i + 2 < m.positions.length; i += 3) {
      const x = m.positions[i]!, y = m.positions[i + 1]!, z = m.positions[i + 2]!;
      const key = `${x},${y},${z}`;
      let g = seen.get(key);
      if (g === undefined) {
        g = positions.length / 3;
        seen.set(key, g);
        positions.push(x, y, z);
      }
      local.push(g);
    }
    for (const i of m.indices) indices.push(local[i]!);
  }
  return { positions, indices };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Collects the polyface records of model space while the entity pass runs (`polyface`), then joins
 * them into solids (`build`). Created by readDxf; `enabled` is `DxfReadOptions.model3d`.
 */
export class Model3DReader {
  private readonly records: PartRecord[] = [];
  /** True 3D dimensions read so far (model space, file order). */
  private readonly dims: Array<{ readonly obj: Obj; readonly where?: string; readonly dim: Dimension3D }> = [];
  /** Other programs' DIMENSIONs off the +Z plane read flat by the 2D path because 3D is off. */
  private flatDims = 0;

  constructor(
    /** Import polyfaces without JCad data as mesh solids (the experimental 3D setting is on). */
    readonly enabled: boolean,
    private readonly report?: ImportReportBuilder,
  ) {}

  /** True when this record would be read by `polyface` (JCad data, or 3D enabled). */
  accepts(o: Obj): boolean {
    return this.enabled || o.groups.some((p) => p.code === 1001 && p.value.trim() === MODEL3D_APP);
  }

  /**
   * Read a model-space DIMENSION as a true 3D dimension when it is one (io/dxf/dim3d-read.ts:
   * JCad 3D data, or a non-Z extrusion with 3D enabled). Returns true when the record was consumed
   * (read or dropped with a report item); false sends it down the unchanged 2D path.
   */
  dimension(o: Obj, ctx: ReadContext): boolean {
    if (!acceptsDimension3D(o, this.enabled)) {
      if (!this.enabled && o.kind === 'DIMENSION' && offPlusZ(o)) this.flatDims += 1;
      return false;
    }
    const r = readDimension3DRecord(o, ctx);
    if ('twoD' in r) return false;
    if ('drop' in r) {
      reportObj(ctx, o, 'dropped', r.drop);
      return true;
    }
    this.dims.push({ obj: o, ...(ctx.where ? { where: ctx.where } : {}), dim: r.dim });
    return true;
  }

  /**
   * The 3D dimensions read, in file order; an id already used (by a solid in `taken` or an earlier
   * dimension) gets a fresh `newId()`. With 3D disabled, a note says they are kept but hidden.
   */
  buildDimensions(taken: ReadonlySet<string>): Dimension3D[] {
    const used = new Set(taken);
    const out = this.dims.map(({ dim }) => {
      const d = used.has(dim.id) ? { ...dim, id: newId() } : dim;
      used.add(d.id);
      return d;
    });
    if (this.flatDims) {
      this.report?.note(`${plural(this.flatDims, 'dimension')} of this drawing ${this.flatDims === 1 ? 'lies' : 'lie'} in a plane other than the XY plane (or ${this.flatDims === 1 ? 'faces' : 'face'} -Z) and ${this.flatDims === 1 ? 'was' : 'were'} read flat in the XY plane; enable Experimental 3D (Options > Files) to read ${this.flatDims === 1 ? 'it' : 'them'} as 3D dimensions in ${this.flatDims === 1 ? 'its plane' : 'their planes'}.`);
    }
    if (out.length && !this.enabled) {
      this.report?.note(`This drawing contains ${plural(out.length, 'experimental 3D dimension')}. ${out.length === 1 ? 'It is' : 'They are'} kept and saved with the drawing, but shown only when Experimental 3D is on: enable Experimental 3D (Options > Files) to view or erase ${out.length === 1 ? 'it' : 'them'}.`);
    }
    return out;
  }

  /** Read one model-space polyface record (`o` and the VERTEX records that follow it). */
  polyface(o: Obj, vertices: readonly Obj[], ctx: ReadContext): void {
    const payload = payloadText(o);
    if (!payload && !this.enabled) {
      reportObj(ctx, o, 'dropped', POLYFACE_UNSUPPORTED_REASON);
      return;
    }
    const invalid = invalidNumber([o, ...vertices]);
    if (invalid) {
      reportObj(ctx, o, 'dropped', `polyface mesh: ${invalid}`);
      return;
    }
    const faces = readFaces(vertices);
    if ('problem' in faces) {
      reportObj(ctx, o, 'dropped', `polyface mesh: ${faces.problem}`);
      return;
    }
    const structural = validateMesh(faces.mesh) ?? (faces.mesh.indices.length === 0 ? 'it has no faces' : null);
    if (structural) {
      reportObj(ctx, o, 'dropped', `polyface mesh: ${structural}${faces.degenerate ? ` (${plural(faces.degenerate, 'face')} with fewer than 3 distinct vertices)` : ''}`);
      return;
    }
    const decoded: SolidPayload | null = !payload ? null : 'problem' in payload ? { status: 'invalid', reason: payload.problem } : decodeSolidPayload(payload.text);
    const losses: string[] = [];
    if (faces.degenerate) losses.push(`${plural(faces.degenerate, 'face')} with fewer than 3 distinct vertices (edges) not kept`);
    let feature: Feature3D = IMPORTED;
    let id: string | undefined, name: string | undefined;
    let part = 0, parts = 1;
    if (!decoded) {
      const notes = [FOREIGN_POLYFACE_REASON];
      if (faces.quads) notes.push(`${plural(faces.quads, 'four-sided face')} split into triangles`);
      if (!meshIsClosed(weldVertices(faces.mesh, 0))) notes.push('the mesh is not closed or not consistently oriented, so volume and solid operations may not be meaningful');
      if (has(o, 420) || has(o, 430) || has(o, 440)) notes.push('true colour, colour book and transparency are not kept on 3D objects (the ACI colour is used)');
      losses.unshift(notes.join('; '));
    } else if (decoded.status === 'ok') {
      ({ id, name, part, parts } = decoded);
      if (decoded.feature) feature = decoded.feature;
      if (decoded.nameCleaned) losses.push(nameNote);
    } else if (decoded.status === 'bad-feature') {
      ({ id, name, part, parts } = decoded);
      if (decoded.nameCleaned) losses.push(nameNote);
      losses.unshift(`JCad 3D construction history ignored (${decoded.reason}): kept as a mesh, not editable parametrically`);
    } else if (decoded.status === 'newer') {
      ({ id, name } = decoded);
      this.report?.add({ type: o.kind, action: 'unsupported', reason: `3D object written by a newer JCad (3D data version ${decoded.version}; this version reads ${MODEL3D_FILE_VERSION}): kept as a mesh, its construction history is not read`, ...(has(o, 5) ? { handle: str(o, 5) } : {}), layer: str(o, 8, '0'), ...(o.line ? { line: o.line } : {}), ...(ctx.where ? { where: ctx.where } : {}) });
    } else {
      losses.unshift(`JCad 3D data unreadable (${decoded.reason}): kept as a mesh, not editable parametrically`);
    }
    const color = colorOf(o);
    if (color.problem) losses.push(color.problem);
    const apps = [...new Set(o.groups.filter((p) => p.code === 1001 && p.value.trim() !== MODEL3D_APP).map((p) => p.value.trim()))];
    if (apps.length) losses.push(`extended data (XDATA) of ${apps.join(', ')} is not kept`);
    for (const reason of losses) reportObj(ctx, o, 'simplified', reason);
    this.records.push({
      obj: o, ...(ctx.where ? { where: ctx.where } : {}), ...(id !== undefined ? { id } : {}), ...(name !== undefined ? { name } : {}),
      feature, part, parts, continuation: part > 0, mesh: faces.mesh, layer: str(o, 8, '0'), color: color.color,
    });
  }

  private note(r: PartRecord, reason: string): void {
    const o = r.obj;
    this.report?.add({ type: o.kind, action: 'simplified', reason, ...(has(o, 5) ? { handle: str(o, 5) } : {}), layer: r.layer, ...(o.line ? { line: o.line } : {}), ...(r.where ? { where: r.where } : {}) });
  }

  /**
   * The solids read, in file order. A solid split into several records is joined (exact duplicate
   * vertices at the cuts are merged); missing or orphaned parts are kept and reported. Duplicate or
   * missing ids get a fresh `newId()`. With 3D disabled, a note says the solids are kept but hidden.
   */
  build(): Solid3D[] {
    const continuations = new Map<string, PartRecord[]>();
    for (const r of this.records) if (r.continuation && r.id !== undefined) continuations.set(r.id, [...(continuations.get(r.id) ?? []), r]);
    const consumed = new Set<PartRecord>();
    const used = new Set<string>();
    const out: Solid3D[] = [];
    const add = (r: PartRecord, mesh: Mesh3D, feature: Feature3D) => {
      const id = r.id !== undefined && !used.has(r.id) ? r.id : newId();
      used.add(id);
      out.push(newSolid({ id, layer: r.layer, color: r.color, mesh, feature, ...(r.name !== undefined ? { name: r.name } : {}) }));
    };
    for (const r of this.records) {
      if (r.continuation) continue;
      if (r.parts === 1 || r.id === undefined) {
        if (r.parts > 1) this.note(r, `the first of ${r.parts} records of a 3D object has no valid id, so its other records cannot be joined to it`);
        add(r, r.mesh, r.feature);
        continue;
      }
      const pieces: (PartRecord | undefined)[] = [r];
      for (const c of continuations.get(r.id) ?? []) {
        if (consumed.has(c) || c.parts !== r.parts || pieces[c.part]) continue;
        pieces[c.part] = c;
        consumed.add(c);
      }
      const present = pieces.filter((p): p is PartRecord => !!p);
      if (present.length < r.parts) this.note(r, `${plural(r.parts - present.length, 'record')} of the ${r.parts} that make up this 3D object ${r.parts - present.length === 1 ? 'is' : 'are'} missing: the mesh is incomplete`);
      add(r, joinParts(present.map((p) => p.mesh)), r.feature);
    }
    for (const r of this.records) {
      if (!r.continuation || consumed.has(r)) continue;
      this.note(r, `part ${r.part + 1} of ${r.parts} of a 3D object without its first record: kept as a separate mesh, not editable parametrically`);
      add(r, r.mesh, IMPORTED);
    }
    if (out.length && !this.enabled) {
      this.report?.note(`This drawing contains ${plural(out.length, 'experimental 3D object')}. ${out.length === 1 ? 'It is' : 'They are'} kept and saved with the drawing, but shown only when Experimental 3D is on: enable Experimental 3D (Options > Files) to view or erase ${out.length === 1 ? 'it' : 'them'}.`);
    }
    return out;
  }
}
