/**
 * Synchronous mesh-in / mesh-out Booleans on the Manifold WebAssembly module (manifold-3d,
 * Apache-2.0, see THIRD-PARTY-NOTICES.md). Runs inside the kernel worker (manifold.worker.ts) and
 * directly in Node for tests (manifold-direct.ts). It does no validation of its own beyond what
 * Manifold reports; callers use kernel.ts `prepareOperands` / `finishResult` around it.
 *
 * Precision: Manifold's mesh format stores positions as 32-bit floats. To keep that loss small
 * and independent of where a part sits in the world, both operands are shifted by the centre of
 * their joint bounding box before conversion and shifted back in double precision afterwards
 * (relative error about 6e-8 of the parts' extent). Output vertices whose float coordinates equal
 * those of exactly one input vertex get that vertex's original double coordinates back, so
 * geometry the operation did not cut is returned unchanged; only new intersection vertices carry
 * float precision.
 *
 * Winding: Manifold uses the same convention as mesh.ts (counter-clockwise seen from outside).
 * Every native object is freed with `delete()` before returning, also on failure.
 */
import Module, { type Manifold, type ManifoldToplevel } from 'manifold-3d';
import type { BooleanOp, PackedMesh } from './kernel';

export { MANIFOLD_VERSION } from './version';

/** Options for loading the WebAssembly module. */
export interface ManifoldLoadOptions {
  /**
   * URL of manifold.wasm. The worker passes the URL Vite emitted for the asset; in Node the
   * module finds the file next to manifold.js by itself.
   */
  readonly wasmUrl?: string;
}

/** Load and initialise the WebAssembly module (call once per thread and reuse the result). */
export async function loadManifold(opts: ManifoldLoadOptions = {}): Promise<ManifoldToplevel> {
  const wasmUrl = opts.wasmUrl;
  const wasm = await Module(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
  wasm.setup();
  return wasm;
}

/** Which operand Manifold refused, with its reason. */
export class ManifoldInputError extends Error {
  constructor(readonly operand: 'a' | 'b', message: string) {
    super(message);
    this.name = 'ManifoldInputError';
  }
}

/** Bounding-box centre of both operands (double precision). */
function jointCentre(a: PackedMesh, b: PackedMesh): [number, number, number] {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const m of [a, b]) {
    const p = m.positions;
    for (let i = 0; i + 2 < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = p[i + k]!;
        if (v < min[k]!) min[k] = v;
        if (v > max[k]!) max[k] = v;
      }
    }
  }
  return [0, 1, 2].map((k) => (Number.isFinite(min[k]!) ? (min[k]! + max[k]!) / 2 : 0)) as [number, number, number];
}

/** Manifold's own wording for its error statuses (as its throwing constructor reports them). */
const STATUS_TEXT: Readonly<Record<string, string>> = {
  NonFiniteVertex: 'Non-finite vertex', NotManifold: 'Not manifold', VertexOutOfBounds: 'Vertex index out of bounds',
  PropertiesWrongLength: 'Properties have wrong length', MissingPositionProperties: 'Less than three properties',
  MergeVectorsDifferentLengths: 'Merge vectors have different lengths', MergeIndexOutOfBounds: 'Merge index out of bounds',
  TransformWrongLength: 'Transform vector has wrong length', RunIndexWrongLength: 'Run index vector has wrong length',
  FaceIDWrongLength: 'Face ID vector has wrong length', InvalidConstruction: 'Manifold constructed with invalid parameters',
};

/**
 * The embind constructor behind `wasm.Manifold`. The public `Manifold` wrapper in manifold.js
 * builds the native object and throws when its status is not NoError, without freeing it; the
 * raw constructor returns the object whatever its status, so a refused mesh can be deleted.
 * Falls back to the public wrapper (and its small leak) if the layout ever changes.
 */
function rawManifoldConstructor(wasm: ManifoldToplevel): new (mesh: InstanceType<ManifoldToplevel['Mesh']>) => Manifold {
  const proto: unknown = Object.getPrototypeOf(wasm.Manifold.prototype);
  const ctor = proto && typeof proto === 'object' ? (proto as { constructor?: unknown }).constructor : undefined;
  return typeof ctor === 'function' && ctor !== Object ? (ctor as new (mesh: InstanceType<ManifoldToplevel['Mesh']>) => Manifold) : wasm.Manifold;
}

const floatKey = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/**
 * Run `op` on two closed meshes and return the result as typed arrays (positions in double
 * precision, see the module comment). Throws ManifoldInputError when Manifold refuses an operand
 * (e.g. "Not manifold"), or Error for any other kernel failure.
 */
export function manifoldBoolean(wasm: ManifoldToplevel, op: BooleanOp, a: PackedMesh, b: PackedMesh): PackedMesh {
  const centre = jointCentre(a, b);
  // Float coordinates of each input vertex -> its original double coordinates (null if two differ).
  const originals = new Map<string, [number, number, number] | null>();
  const toNative = (m: PackedMesh): Float32Array => {
    const f = new Float32Array(m.positions.length);
    for (let i = 0; i + 2 < m.positions.length; i += 3) {
      const x = m.positions[i]!, y = m.positions[i + 1]!, z = m.positions[i + 2]!;
      const fx = Math.fround(x - centre[0]), fy = Math.fround(y - centre[1]), fz = Math.fround(z - centre[2]);
      f[i] = fx; f[i + 1] = fy; f[i + 2] = fz;
      const key = floatKey(fx, fy, fz);
      const seen = originals.get(key);
      if (seen === undefined) originals.set(key, [x, y, z]);
      else if (seen && (seen[0] !== x || seen[1] !== y || seen[2] !== z)) originals.set(key, null);
    }
    return f;
  };
  const owned: Manifold[] = [];
  const make = (which: 'a' | 'b', m: PackedMesh): Manifold => {
    const mesh = new wasm.Mesh({ numProp: 3, vertProperties: toNative(m), triVerts: m.indices });
    let solid: Manifold;
    try {
      solid = new (rawManifoldConstructor(wasm))(mesh);
    } catch (err) {
      throw new ManifoldInputError(which, err instanceof Error ? err.message : String(err));
    }
    owned.push(solid);
    // Owned before the status check, so a refused operand is freed in the finally block below.
    const status = solid.status();
    if (status !== 'NoError') throw new ManifoldInputError(which, STATUS_TEXT[status] ?? status);
    return solid;
  };
  try {
    const ma = make('a', a);
    const mb = make('b', b);
    const result = op === 'union' ? ma.add(mb) : op === 'subtract' ? ma.subtract(mb) : ma.intersect(mb);
    owned.push(result);
    const status = result.status();
    if (status !== 'NoError') throw new Error(`Manifold reported ${status}`);
    const out = result.getMesh();
    const numProp = out.numProp;
    if (!(numProp >= 3)) throw new Error(`Manifold returned ${numProp} properties per vertex`);
    const vp = out.vertProperties;
    const count = Math.floor(vp.length / numProp);
    const positions = new Float64Array(count * 3);
    for (let v = 0; v < count; v++) {
      // The first three properties of every vertex are its position; any others are ignored.
      const fx = vp[v * numProp]!, fy = vp[v * numProp + 1]!, fz = vp[v * numProp + 2]!;
      const orig = originals.get(floatKey(fx, fy, fz));
      if (orig) {
        positions[3 * v] = orig[0]; positions[3 * v + 1] = orig[1]; positions[3 * v + 2] = orig[2];
      } else {
        positions[3 * v] = fx + centre[0]; positions[3 * v + 1] = fy + centre[1]; positions[3 * v + 2] = fz + centre[2];
      }
    }
    let indices = Uint32Array.from(out.triVerts);
    // Vertices duplicated only for differing properties are listed in the merge vectors; with
    // position-only input there are none, but map them back to one vertex if present.
    const from = out.mergeFromVert, to = out.mergeToVert;
    if (from && to && from.length > 0) {
      const remap = new Map<number, number>();
      for (let i = 0; i < from.length; i++) remap.set(from[i]!, to[i]!);
      indices = indices.map((i) => remap.get(i) ?? i);
    }
    return { positions, indices };
  } finally {
    for (const m of owned) m.delete();
  }
}
