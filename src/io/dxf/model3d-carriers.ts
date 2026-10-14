/** Exact imported polyface bindings. Mesh-index slots are proved by the reader, never inferred on save. */
import type { DrawingState } from '../../core/document';
import { CadGraphError, type CadGroup, type CadNode } from '../../core/cad-graph';
import type { Solid3D } from '../../model3d/types';
import { decodeSolidPayload, encodePartPayload, encodeSolidPayload, payloadChunks } from '../../model3d/file-format';
import { payloadText } from './mesh3d-read';
import { exactReal } from './mesh3d-write';
import { MODEL3D_APP } from './codes';
import type { Writer } from './write-core';

const equal = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((value, index) => value === b[index]);
export function assertSolidCarrierTopology(solid: Solid3D, baseline: Solid3D): void {
  if (solid.mesh.positions.length !== baseline.mesh.positions.length || !equal(solid.mesh.indices, baseline.mesh.indices)) {
    throw new CadGraphError('dependency', `Cannot save edited 3D solid ${solid.name || solid.id}: its imported polyface follower topology has no proven correspondence. Export a separate new mesh or restore its source topology.`);
  }
}

function replaceOwnPayload(groups: readonly CadGroup[], text: string): CadGroup[] {
  const output: CadGroup[] = [];
  let depth = 0, own = false, found = false;
  for (const group of groups) {
    const [code, raw] = group;
    if (code === 102) { depth += raw.trim().startsWith('{') ? 1 : raw.trim() === '}' ? -1 : 0; output.push(group); continue; }
    if (!depth && code === 1001) {
      own = raw.trim() === MODEL3D_APP;
      if (own) {
        if (found) throw new CadGraphError('dependency', 'Cannot regenerate duplicate JCAD_3D application data.');
        found = true; output.push(group, ...payloadChunks(text).map(chunk => [1000, chunk] as const));
        continue;
      }
    }
    if (!own || depth) output.push(group);
  }
  if (!found) output.push([1001, MODEL3D_APP], ...payloadChunks(text).map(chunk => [1000, chunk] as const));
  return output;
}

/** Preserve source quads, invisible edges, extra groups and references; only modeled fields change. */
export function solidCarrierGroups(groups: readonly CadGroup[], node: CadNode, solid: Solid3D, baseline: Solid3D, parts: number): CadGroup[] {
  assertSolidCarrierTopology(solid, baseline);
  const part = node.anchor?.kind === 'solid3d' ? node.anchor.part : undefined;
  let output = [...groups];
  if (node.type === 'POLYLINE') {
    const raw = payloadText({ kind: node.type, groups: node.groups.map(([code, value]) => ({ code, value })) });
    const decoded = raw && 'text' in raw ? decodeSolidPayload(raw.text) : undefined;
    if (raw && (!decoded || decoded.status !== 'ok')) {
      const { cadIdentity: _currentIdentity, ...current } = solid;
      const { cadIdentity: _baselineIdentity, ...original } = baseline;
      if (JSON.stringify(current) !== JSON.stringify(original)) throw new CadGraphError('dependency', 'Cannot edit a retained 3D carrier with unknown, newer or invalid JCAD_3D data. Its original payload is retained.');
    } else {
      const index = part ? Number(/^polyface:(\d+)$/.exec(part)?.[1]) : 0;
      if (!Number.isSafeInteger(index) || index < 0 || index >= parts) throw new CadGraphError('invalid', 'Imported 3D carrier part binding is invalid.');
      if (decoded?.status === 'ok' && (decoded.parts !== parts || decoded.part !== index)) throw new CadGraphError('dependency', 'Cannot regenerate an incomplete or reordered source 3D part set without a proven complete carrier mapping.');
      output = replaceOwnPayload(output, index === 0 ? encodeSolidPayload(solid, parts).text : encodePartPayload(solid, index, parts));
    }
  }
  const vertex = part && /^polyface:\d+:vertex:\d+:mesh:(\d+)$/.exec(part);
  const index = vertex ? Number(vertex[1]) : undefined;
  if (index !== undefined && (!Number.isSafeInteger(index) || index < 0 || 3 * index + 2 >= solid.mesh.positions.length)) throw new CadGraphError('invalid', 'Imported polyface vertex binding is outside its mesh.');
  let depth = 0, application = false;
  output = output.flatMap(([code, raw]): CadGroup[] => {
    if (code === 102) { depth += raw.trim().startsWith('{') ? 1 : raw.trim() === '}' ? -1 : 0; return [[code, raw]]; }
    if (!depth && code === 1001) application = true;
    if (depth || application) return [[code, raw]];
    if (index !== undefined && [10, 20, 30].includes(code)) return [[code, exactReal(solid.mesh.positions[3 * index + (code - 10) / 10]!)]];
    if (code === 8 && solid.layer !== baseline.layer) return [[code, solid.layer]];
    if (solid.color !== baseline.color && [62, 420, 430].includes(code)) return code === 62 ? [[62, String(solid.color === 'ByLayer' ? 256 : solid.color)]] : [];
    return [[code, raw]];
  });
  if (solid.color !== baseline.color && !output.some(([code]) => code === 62)) {
    const at = output.findIndex(([code, raw]) => code === 100 && raw !== 'AcDbEntity');
    output.splice(at < 0 ? output.length : at, 0, [62, String(solid.color === 'ByLayer' ? 256 : solid.color)]);
  }
  return output;
}

/** Emit source topology with temporary handles; the existing graph plan resolves every final reference. */
export function writeRetainedSolid(w: Writer, state: DrawingState, solid: Solid3D, owner: string, boundNodes?: readonly CadNode[]): boolean {
  const nodes = boundNodes ?? state.cadGraph?.nodes.filter(node => node.anchor?.kind === 'solid3d' && node.anchor.id === solid.id) ?? [];
  if (!nodes.length) return false;
  const primary = nodes.find(node => node.anchor?.kind === 'solid3d' && !node.anchor.part);
  if (!primary?.baselineSolid || primary.type !== 'POLYLINE') throw new CadGraphError('dependency', 'Imported 3D solid has no exact primary carrier baseline.');
  const parts = nodes.filter(node => node.type === 'POLYLINE').length;
  if (nodes.filter(node => node.type === 'SEQEND').length !== parts) throw new CadGraphError('dependency', 'Imported polyface carrier has no complete proven SEQEND sequence.');
  for (const node of nodes) {
    if (node.section !== 'ENTITIES' || !node.anchor) throw new CadGraphError('dependency', 'Imported 3D solid carrier is outside model space.');
    const handle = w.nextHandle();
    w.pair(0, node.type); w.pair(5, handle); w.anchor(handle, node.anchor);
    const groups = solidCarrierGroups(node.groups, node, solid, primary.baselineSolid, parts);
    let depth = 0, common = true;
    for (const [code, raw] of groups) {
      if (code === 102) depth += raw.trim().startsWith('{') ? 1 : raw.trim() === '}' ? -1 : 0;
      if (!depth && code === 100) common = false;
      if (!depth && code === 5) continue;
      w.pair(code, common && !depth && code === 330 && node.type === 'POLYLINE' ? owner : raw);
    }
  }
  return true;
}
