/**
 * Shader programs of the 3D viewport (GLSL ES 3.00 for WebGL2) and their uniform locations.
 *
 * Shared conventions:
 * - Attribute locations are fixed: 0 = position (vec3), 1 = normal (vec3, solids) or colour
 *   (vec4, lines). Vertex arrays are built once per buffer with those locations.
 * - Positions are float32 relative to a batch origin; `u_offset` = origin - camera target and
 *   `u_viewProj` = projection x view-relative-to-target (see scene-data.ts), so world coordinates
 *   far from the origin stay precise.
 * - Solids are flat shaded: the normal is per triangle (vertices are de-indexed), lit by a
 *   directional headlight along the view direction plus ambient light, two-sided (back faces are
 *   lit like front faces, so inward-wound or open meshes still read correctly).
 * - The id program writes each solid's 24-bit index + 1 as RGB (0 = background) for GPU picking.
 */
import type { Vec3 } from '../../model3d/math';
import type { Mesh3D } from '../../model3d/mesh';
import { featureEdges, solidVertices } from '../scene-data';
import type { GpuDevice } from './device';

export const ATTR_POSITION = 0;
export const ATTR_NORMAL = 1;
export const ATTR_COLOR = 1;

const SOLID_VS = `#version 300 es
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
uniform mat4 u_viewProj;
uniform vec3 u_offset;
out vec3 v_normal;
void main() {
  v_normal = a_normal;
  gl_Position = u_viewProj * vec4(a_pos + u_offset, 1.0);
}`;

const SOLID_FS = `#version 300 es
precision highp float;
in vec3 v_normal;
uniform vec4 u_color;
uniform vec3 u_light;
uniform float u_ambient;
out vec4 o_color;
void main() {
  float l = length(v_normal);
  float d = l > 0.0 ? abs(dot(v_normal / l, u_light)) : 1.0;
  o_color = vec4(u_color.rgb * (u_ambient + (1.0 - u_ambient) * d), u_color.a);
}`;

const LINE_VS = `#version 300 es
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec4 a_color;
uniform mat4 u_viewProj;
uniform vec3 u_offset;
uniform vec3 u_fadeCenter;
out vec4 v_color;
out vec2 v_fadePos;
void main() {
  vec3 p = a_pos + u_offset;
  v_color = a_color;
  v_fadePos = p.xy - u_fadeCenter.xy;
  gl_Position = u_viewProj * vec4(p, 1.0);
}`;

const LINE_FS = `#version 300 es
precision highp float;
in vec4 v_color;
in vec2 v_fadePos;
uniform vec4 u_tint;
uniform vec2 u_fade;
out vec4 o_color;
void main() {
  vec4 c = v_color * u_tint;
  if (u_fade.y > 0.0) c.a *= 1.0 - smoothstep(u_fade.x, u_fade.y, length(v_fadePos));
  if (c.a <= 0.0) discard;
  o_color = c;
}`;

const ID_VS = `#version 300 es
layout(location = 0) in vec3 a_pos;
uniform mat4 u_viewProj;
uniform vec3 u_offset;
void main() {
  gl_Position = u_viewProj * vec4(a_pos + u_offset, 1.0);
}`;

const ID_FS = `#version 300 es
precision highp float;
uniform vec4 u_id;
out vec4 o_color;
void main() {
  o_color = u_id;
}`;

export interface SolidProgram {
  readonly program: WebGLProgram;
  readonly viewProj: WebGLUniformLocation | null;
  readonly offset: WebGLUniformLocation | null;
  readonly color: WebGLUniformLocation | null;
  readonly light: WebGLUniformLocation | null;
  readonly ambient: WebGLUniformLocation | null;
}

export interface LineProgram {
  readonly program: WebGLProgram;
  readonly viewProj: WebGLUniformLocation | null;
  readonly offset: WebGLUniformLocation | null;
  readonly fadeCenter: WebGLUniformLocation | null;
  readonly tint: WebGLUniformLocation | null;
  readonly fade: WebGLUniformLocation | null;
}

export interface IdProgram {
  readonly program: WebGLProgram;
  readonly viewProj: WebGLUniformLocation | null;
  readonly offset: WebGLUniformLocation | null;
  readonly id: WebGLUniformLocation | null;
}

export interface Programs {
  readonly solid: SolidProgram;
  readonly line: LineProgram;
  readonly id: IdProgram;
}

/** Compile every program (throws with the driver's log when one fails). */
export function createPrograms(device: GpuDevice): Programs {
  const gl = device.gl;
  const solid = device.createProgram(SOLID_VS, SOLID_FS);
  const line = device.createProgram(LINE_VS, LINE_FS);
  const id = device.createProgram(ID_VS, ID_FS);
  const u = (p: WebGLProgram, name: string) => gl.getUniformLocation(p, name);
  return {
    solid: { program: solid, viewProj: u(solid, 'u_viewProj'), offset: u(solid, 'u_offset'), color: u(solid, 'u_color'), light: u(solid, 'u_light'), ambient: u(solid, 'u_ambient') },
    line: { program: line, viewProj: u(line, 'u_viewProj'), offset: u(line, 'u_offset'), fadeCenter: u(line, 'u_fadeCenter'), tint: u(line, 'u_tint'), fade: u(line, 'u_fade') },
    id: { program: id, viewProj: u(id, 'u_viewProj'), offset: u(id, 'u_offset'), id: u(id, 'u_id') },
  };
}

/** RGBA (0..1) encoding of pick index `i` (0-based) for the id buffer: i + 1 in 24 bits. */
export function encodePickId(i: number): [number, number, number, number] {
  const v = i + 1;
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, 1];
}

/** Inverse of `encodePickId` from read-back bytes: the 0-based index, or -1 for the background. */
export function decodePickId(r: number, g: number, b: number): number {
  return ((r << 16) | (g << 8) | b) - 1;
}

/** GPU copies of one mesh: flat-shaded triangles and feature edges, positions relative to `origin`. */
export interface MeshGpu {
  readonly vao: WebGLVertexArrayObject;
  readonly vbo: WebGLBuffer;
  readonly vertexCount: number;
  readonly edgeVao: WebGLVertexArrayObject | null;
  readonly edgeVbo: WebGLBuffer | null;
  readonly edgeVertexCount: number;
  readonly origin: Vec3;
  /** The mesh these buffers were made from (pruning compares it with the current model). */
  readonly mesh: Mesh3D;
  /** Frame number of the last draw (for pruning buffers of meshes no longer shown). */
  lastUsed: number;
  disposed: boolean;
}

/**
 * Per-mesh GPU buffers, cached in a WeakMap keyed by the sealed `Mesh3D` object (drawing state
 * never mutates a mesh, so identity means "same geometry"; the entry goes with the mesh). Buffers
 * of meshes that left the document's model, or were not drawn for `maxIdleFrames` frames, are
 * deleted from the GPU (undo can bring a mesh back; it is then uploaded again). `reset()` forgets everything without touching GL: use it after
 * a context loss, when every old GL object is already invalid.
 */
export class MeshBufferCache {
  private map = new WeakMap<Mesh3D, MeshGpu>();
  private live = new Set<MeshGpu>();
  frame = 0;

  constructor(private readonly device: GpuDevice, private readonly maxIdleFrames = 600) {}

  /** The buffers of `mesh`, uploading them on first use. */
  get(mesh: Mesh3D): MeshGpu {
    const hit = this.map.get(mesh);
    if (hit && !hit.disposed) {
      hit.lastUsed = this.frame;
      return hit;
    }
    const sv = solidVertices(mesh);
    const vbo = this.device.createBuffer(sv.data);
    const vao = this.device.createVertexArray(vbo, [[ATTR_POSITION, 3], [ATTR_NORMAL, 3]]);
    const edges = featureEdges(mesh, sv.origin);
    let edgeVao: WebGLVertexArrayObject | null = null, edgeVbo: WebGLBuffer | null = null;
    if (edges.length) {
      // Edge vertices carry a white colour; the line program tints them per solid.
      const data = new Float32Array((edges.length / 3) * 7);
      for (let i = 0; i < edges.length / 3; i++) data.set([edges[i * 3]!, edges[i * 3 + 1]!, edges[i * 3 + 2]!, 1, 1, 1, 1], i * 7);
      edgeVbo = this.device.createBuffer(data);
      edgeVao = this.device.createVertexArray(edgeVbo, [[ATTR_POSITION, 3], [ATTR_COLOR, 4]]);
    }
    const entry: MeshGpu = { vao, vbo, vertexCount: sv.vertexCount, edgeVao, edgeVbo, edgeVertexCount: edges.length / 3, origin: sv.origin, mesh, lastUsed: this.frame, disposed: false };
    this.map.set(mesh, entry);
    this.live.add(entry);
    return entry;
  }

  /**
   * Delete GPU buffers that are no longer needed: with `current` (the meshes of the document's
   * model, e.g. after an edit), every mesh not in it; always, meshes idle for longer than
   * `maxIdleFrames` frames.
   */
  prune(current?: ReadonlySet<Mesh3D>): void {
    const gl = this.device.gl;
    for (const e of this.live) {
      if (current ? current.has(e.mesh) : this.frame - e.lastUsed <= this.maxIdleFrames) continue;
      gl.deleteVertexArray(e.vao);
      gl.deleteBuffer(e.vbo);
      if (e.edgeVao) gl.deleteVertexArray(e.edgeVao);
      if (e.edgeVbo) gl.deleteBuffer(e.edgeVbo);
      e.disposed = true;
      this.live.delete(e);
    }
  }

  /** Number of meshes with live GPU buffers. */
  get size(): number {
    return this.live.size;
  }

  /** Forget every entry (after a context loss: the GL objects are gone already). */
  reset(): void {
    for (const e of this.live) e.disposed = true;
    this.live.clear();
    this.map = new WeakMap();
  }
}
