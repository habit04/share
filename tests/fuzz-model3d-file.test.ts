/**
 * Fuzzing of the 3D file payload (milestone 6): seeded random mutations of valid DXF polyface
 * records with `JCAD_3D` data, of the payload JSON itself, and of `Feature3D` trees fed to
 * `evaluateFeature` with the in-process Manifold kernel. 2,000 iterations each with fixed seeds
 * (tests/helpers/fuzz.ts: a failure names its seed; replay with FUZZ_SEED=<seed>).
 *
 * Properties:
 * - `readDxf` either returns a drawing or throws a DxfReadError, nothing else; `decodeSolidPayload`
 *   never throws.
 * - A returned drawing passes `prepareDrawingState` (sealed, within the geometry budget) and every
 *   solid in it is well-formed: valid non-empty mesh, unique valid id, clean name, a history that
 *   passes the strict validator.
 * - Every POLYLINE record is accounted for: it became a solid, a 2D polyline, or a `dropped`
 *   import-report item (so nothing disappears silently). Only a file opened with `recover` may lose
 *   its last, incomplete record, and then the report says the file was recovered.
 * - True 3D dimensions (DIMENSION records with `JCAD_3D` data, docs/3D-DIMENSIONS.md): mutated
 *   records read without anything but DxfReadError escaping, every DIMENSION becomes a 3D or 2D
 *   dimension or a `dropped` item, and every 3D dimension read is consistent (valid plane, finite
 *   numbers, rebuildable by `makeDimension3D`, unique id); `decodeDimensionPayload` never throws.
 * - `evaluateFeature` either gives a closed, outward, in-budget mesh or rejects with one of the
 *   documented errors: Model3DInputError (FeatureEvalError is one), GeometryBudgetError or
 *   KernelError. A plain RangeError, TypeError or Error is a failure.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import type { Point } from '../src/core/geometry';
import { prepareDrawingState } from '../src/core/geometry-budget';
import { DxfReadError, readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf } from '../src/io/import-report';
import { MAX_SOLID_TRIANGLES } from '../src/model3d/budget';
import { isModel3DUserError } from '../src/model3d/errors';
import { evaluateFeature } from '../src/model3d/feature-eval';
import { MAX_SOLID_NAME_LENGTH, decodeDimensionPayload, decodeSolidPayload, validSolidId, validateFeature } from '../src/model3d/file-format';
import { ManifoldDirectKernel } from '../src/model3d/kernel/manifold-direct';
import { type Frame3, frameFromPlane, isOrthonormalFrame, v3, WORLD_XY_FRAME } from '../src/model3d/math';
import { STANDARD_DIMSTYLE } from '../src/core/dimension';
import { dimension3dMeasurement, dimension3dSpec, dimension3dText, makeDimension3D, planeWorld } from '../src/model3d/dimension3d';
import { meshIsClosed, meshTriangleCount, meshVolume, validateMesh } from '../src/model3d/mesh';
import { addDimensions3D, addSolids, model3dOf, newSolid, withModel3D } from '../src/model3d/model';
import { boxMesh, primitiveMesh, sphereMesh } from '../src/model3d/primitives';
import { extrudeMesh, revolveMesh } from '../src/model3d/sweep';
import type { Dimension3D, Feature3D, Profile3D, Solid3D } from '../src/model3d/types';
import { Rng, check, fuzz, fuzzSync, fuzzTimeout } from './helpers/fuzz';

const RUNS = 2000;
/** Replaying one seed (FUZZ_SEED): the outcome-coverage counts below do not apply. */
const REPLAY = !!process.env.FUZZ_SEED;

// ------------------------------------------------------------------ corpus

const tilted: Frame3 = frameFromPlane({ origin: v3(10.1, -3.3, 0.7), normal: v3(0.3, -0.2, 0.9) });
const square = (s: number, x = 0, y = 0): Point[] => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];
const ringProfile: Profile3D = { frame: WORLD_XY_FRAME, loops: [square(3), [...square(1, 1, 1)].reverse()] };

/** Small solids of every feature kind (small meshes keep 2,000 reads fast). */
function corpusSolids(): Solid3D[] {
  const box: Feature3D = { kind: 'box', frame: tilted, width: 2.5, depth: 1.25, height: 0.3 };
  const cyl: Feature3D = { kind: 'cylinder', frame: WORLD_XY_FRAME, radius: 0.7, height: 4.1, segments: 6 };
  const ext: Feature3D = { kind: 'extrude', profile: ringProfile, distance: -2.75 };
  const rev: Feature3D = { kind: 'revolve', profile: { frame: WORLD_XY_FRAME, loops: [square(1, 1, 0)] }, axis: { origin: v3(0, 0, 0), dir: v3(0, 1, 0) }, angle: Math.PI * 1.5, segments: 8 };
  const tree: Feature3D = { kind: 'boolean', op: 'subtract', operands: [{ kind: 'boolean', op: 'union', operands: [box, cyl] }, { kind: 'sphere', frame: WORLD_XY_FRAME, radius: 1, segments: 6, rings: 3 }] };
  return [
    newSolid({ id: 'box-1', feature: box, mesh: primitiveMesh(box), layer: 'PARTS', color: 3, name: 'Gland plate ünïcödé "q" \\U+0041' }),
    newSolid({ id: 'cyl-1', feature: cyl, mesh: primitiveMesh(cyl) }),
    newSolid({ id: 'ext-1', feature: ext, mesh: extrudeMesh(ringProfile, -2.75), color: 0 }),
    newSolid({ id: 'rev-1', feature: rev, mesh: revolveMesh({ frame: WORLD_XY_FRAME, loops: [square(1, 1, 0)] }, { origin: v3(0, 0, 0), dir: v3(0, 1, 0) }, Math.PI * 1.5, 8) }),
    newSolid({ id: 'tree-1', feature: tree, mesh: sphereMesh(1, 5, 3), name: 'Boolean' }),
    newSolid({ id: 'mesh-1', feature: { kind: 'mesh', source: 'edited' }, mesh: boxMesh(0.1, 0.2, 0.3), color: 255 }),
  ];
}

const CRLF = '\r\n';

/** The ENTITIES section of a written drawing as a minimal DXF (fast to read; same records). */
function entitiesOnly(text: string): string {
  const start = text.indexOf(`0${CRLF}SECTION${CRLF}2${CRLF}ENTITIES${CRLF}`);
  const end = text.indexOf(`0${CRLF}ENDSEC${CRLF}`, start);
  return `${text.slice(start, end)}0${CRLF}ENDSEC${CRLF}0${CRLF}EOF${CRLF}`;
}

const base = new Drawing().snapshot;
const corpusState: DrawingState = withModel3D(base, addSolids(model3dOf(base), corpusSolids()));
const FULL_TEXT = writeDxf(corpusState);
const ENTITIES_TEXT = entitiesOnly(FULL_TEXT);

// ------------------------------------------------------------------ pair-level DXF editing

type Pair = [code: string, value: string];

function toPairs(text: string): Pair[] {
  const lines = text.split(CRLF);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([lines[i]!, lines[i + 1]!]);
  return out;
}
const fromPairs = (pairs: readonly Pair[]): string => pairs.map(([c, v]) => `${c}${CRLF}${v}${CRLF}`).join('');

/** [start, end) pair ranges of each polyface record (POLYLINE through its SEQEND record). */
function polyfaceRanges(pairs: readonly Pair[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i]![0] !== '0' || pairs[i]![1] !== 'POLYLINE') continue;
    let j = i + 1;
    while (j < pairs.length && !(pairs[j]![0] === '0' && pairs[j]![1] === 'SEQEND')) j++;
    j = Math.min(j + 1, pairs.length);
    while (j < pairs.length && pairs[j]![0] !== '0') j++;
    out.push([i, j]);
  }
  return out;
}

/** [start, end) of each record (a 0 group and the groups up to the next one) inside a range. */
function recordsIn(pairs: readonly Pair[], [lo, hi]: [number, number]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = lo; i < hi; i++) {
    if (pairs[i]![0] !== '0') continue;
    let j = i + 1;
    while (j < hi && pairs[j]![0] !== '0') j++;
    out.push([i, j]);
  }
  return out;
}

const HOSTILE_NUMBERS = ['NaN', 'Infinity', '-Infinity', '-0', '0', '1e308', '1e309', '-1e400', '99999999999999999999', '1e-400', '0x10', ' 1 ', '1.5', '', '+', '-', '1e', '.5', '5.', '2147483648', '-2147483649', '32768', '65536', '١٢٣'];
const HOSTILE_INTS = ['0', '-1', '1', '2', '3', '7', '8', '9', '12', '32767', '32768', '-32768', '2147483648', '1.5', '', 'x', '1e3', '-0'];
const UNICODE = ['\u0000', '\u0007', '\u001f', '\u007f', '\u0085', '\ud800', '\udfff', '\ud83d\ude00', '\u202e', '\ufeff', 'é', 'é', 'İ', '\u2028', '\\U+0041', '\\U+D800', '%%c', '"', '\\', '\\\\', ' '];

// ------------------------------------------------------------------ payload mutation

/** The writer's escaping (file-format.ts escapeJson): 7-bit, no whitespace, no `\\` pairs. */
const escapePayload = (json: string): string => json.replace(/\\\\/g, '\\u005c').replace(/[^\x21-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

function hostileJsonValue(rng: Rng): unknown {
  return rng.pick<unknown>([null, true, false, 0, -1, 1e308, -1e308, 5e-324, 2 ** 53 + 1, '', 'x', 'box', '__proto__', [], [1, 2, 3], {}, { x: 1, y: 2, z: 3 }, { kind: 'mesh', source: 'imported' }, rng.pick(UNICODE).repeat(rng.int(1, 300))]);
}

/** Every object / array inside a JSON value (walk order), for picking a random place to mutate. */
function containers(v: unknown, out: Array<Record<string, unknown> | unknown[]> = []): Array<Record<string, unknown> | unknown[]> {
  if (Array.isArray(v)) { out.push(v); for (const x of v) containers(x, out); }
  else if (v && typeof v === 'object') { out.push(v as Record<string, unknown>); for (const x of Object.values(v)) containers(x, out); }
  return out;
}

const deepTree = (depth: number, leaf: unknown): unknown => {
  let f = leaf;
  for (let i = 0; i < depth; i++) f = { kind: 'boolean', op: 'union', operands: [f, leaf] };
  return f;
};

/** A hostile variant of payload JSON text (structure-level, then text-level injections). */
function mutatePayloadJson(rng: Rng, json: string): string {
  const data = JSON.parse(json) as unknown;
  const steps = rng.int(1, 3);
  for (let s = 0; s < steps; s++) {
    const all = containers(data);
    const target = rng.pick(all);
    const keys = Array.isArray(target) ? target.map((_, i) => String(i)) : Object.keys(target);
    const kind = rng.int(0, 5);
    if (kind === 0 && keys.length) (target as Record<string, unknown>)[rng.pick(keys)] = hostileJsonValue(rng);
    else if (kind === 1 && keys.length && !Array.isArray(target)) delete target[rng.pick(keys)];
    else if (kind === 2) (target as Record<string, unknown>)[rng.pick(['extra', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'parts', 'part', 'segments', 'rings', 'v'])] = hostileJsonValue(rng);
    else if (kind === 3 && keys.length) (target as Record<string, unknown>)[rng.pick(keys)] = deepTree(rng.int(1, 120), { kind: 'box', frame: WORLD_XY_FRAME, width: 1, depth: 1, height: 1 });
    else if (kind === 4 && Array.isArray(target)) target.push(hostileJsonValue(rng));
    else if (keys.length) {
      const k = rng.pick(keys);
      const v = (target as Record<string, unknown>)[k];
      if (typeof v === 'number') (target as Record<string, unknown>)[k] = rng.pick([v * 1e300, -v, v + 1e-9, Math.round(v * 1000) / 1000, 0, -0, v * 1.000001]);
      else if (typeof v === 'string') (target as Record<string, unknown>)[k] = v + rng.pick(UNICODE);
    }
  }
  let text = JSON.stringify(data);
  // Text-level injections JSON.stringify cannot produce: non-JSON numbers, duplicate keys, __proto__.
  const injections = rng.int(0, 2);
  for (let s = 0; s < injections; s++) {
    const kind = rng.int(0, 4);
    if (kind === 0) {
      const numbers = [...text.matchAll(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi)];
      if (numbers.length) {
        const m = rng.pick(numbers);
        text = text.slice(0, m.index) + rng.pick(['NaN', 'Infinity', '-Infinity', '-0', '1e999', '0x10', '01', '1.5e-400', '-1e-320', '+1', '.5']) + text.slice(m.index + m[0].length);
      }
    } else if (kind === 1) {
      const braces = [...text.matchAll(/\{/g)];
      if (braces.length) {
        const m = rng.pick(braces);
        text = `${text.slice(0, m.index + 1)}${rng.pick(['"__proto__":{"v":2,"kind":"box"},', '"__proto__":null,', '"constructor":{"prototype":{}},', '"v":1,', '"kind":"box",'])}${text.slice(m.index + 1)}`;
      }
    } else if (kind === 2) text = text.slice(0, rng.int(0, text.length));
    else if (kind === 3) text = `${'['.repeat(rng.int(1, 5000))}${text}`;
    else text = text.replace(/"(v|id|kind)":/, (_m, k: string) => `"${k}":${rng.pick(['2', '"x"', 'null', '1'])},"${k}":`);
  }
  return text;
}

/** `pairs.splice(at, remove, ...items)` without spreading (tens of thousands of 1-character chunks overflow the call stack). */
function spliceIn(pairs: Pair[], at: number, remove: number, items: readonly Pair[]): void {
  const tail = pairs.slice(at + remove);
  pairs.length = at;
  for (const item of items) pairs.push(item);
  for (const item of tail) pairs.push(item);
}

/** Replace the JCAD_3D data groups of the POLYLINE record at `at` with chunks of `payload`. */
function setPayload(rng: Rng, pairs: Pair[], at: number, payload: string): void {
  let i = at + 1;
  while (i < pairs.length && pairs[i]![0] !== '1001' && pairs[i]![0] !== '0') i++;
  if (pairs[i]?.[0] !== '1001') return;
  let j = i + 1;
  while (j < pairs.length && pairs[j]![0] === '1000') j++;
  const size = rng.pick([250, 250, 255, 256, 400, 1]);
  const chunks: Pair[] = [];
  for (let k = 0; k < payload.length; k += size) chunks.push(['1000', payload.slice(k, k + size)]);
  spliceIn(pairs, i + 1, j - i - 1, chunks);
}

/** The joined 1000 strings after `1001 JCAD_3D` in the record at `at`, or null. */
function payloadAt(pairs: readonly Pair[], at: number): string | null {
  let i = at + 1;
  while (i < pairs.length && !(pairs[i]![0] === '1001' && pairs[i]![1] === 'JCAD_3D') && pairs[i]![0] !== '0') i++;
  if (pairs[i]?.[0] !== '1001') return null;
  let text = '';
  for (let j = i + 1; j < pairs.length && pairs[j]![0] === '1000'; j++) text += pairs[j]![1];
  return text;
}

// ------------------------------------------------------------------ DXF mutation

type Mutation = 'truncate' | 'swap-codes' | 'number' | 'payload' | 'xdata' | 'index' | 'count' | 'records' | 'flags' | 'unicode' | 'strip-jcad';

/** Apply one mutation to a polyface record; returns its name (for the failure message). */
function mutate(rng: Rng, pairs: Pair[], payloads: string[]): Mutation {
  const ranges = polyfaceRanges(pairs);
  if (!ranges.length) return 'truncate';
  const range = rng.pick(ranges);
  const [lo, hi] = range;
  const m = rng.weighted<Mutation>([[1, 'truncate'], [2, 'swap-codes'], [3, 'number'], [5, 'payload'], [2, 'xdata'], [3, 'index'], [1, 'count'], [2, 'records'], [2, 'flags'], [1, 'unicode'], [1, 'strip-jcad']]);
  const records = recordsIn(pairs, range);
  const faceRecords = records.filter(([s, e]) => pairs.slice(s, e).some(([c, v]) => c === '100' && v === 'AcDbFaceRecord'));
  switch (m) {
    case 'truncate':
      pairs.length = rng.int(lo, hi); // the caller may also drop the last value line
      break;
    case 'swap-codes': {
      const a = rng.int(lo, hi - 1), b = rng.int(lo, hi - 1);
      const t = pairs[a]![0];
      pairs[a]![0] = pairs[b]![0];
      pairs[b]![0] = t;
      break;
    }
    case 'number': {
      const numeric = [];
      for (let i = lo; i < hi; i++) if (['10', '20', '30', '62', '66', '70', '71', '72', '73', '74'].includes(pairs[i]![0])) numeric.push(i);
      if (numeric.length) pairs[rng.pick(numeric)]![1] = rng.pick(HOSTILE_NUMBERS);
      break;
    }
    case 'payload': {
      const text = payloadAt(pairs, lo);
      if (text === null) break;
      let mutated: string;
      try {
        mutated = mutatePayloadJson(rng, text);
      } catch {
        mutated = text.slice(0, rng.int(0, text.length)); // not JSON any more after an earlier mutation
      }
      const encoded = rng.bool(0.9) ? escapePayload(mutated) : mutated;
      payloads.push(encoded);
      setPayload(rng, pairs, lo, encoded);
      break;
    }
    case 'xdata': {
      let i = lo + 1;
      while (i < hi && pairs[i]![0] !== '1001') i++;
      if (i >= hi) break;
      const kind = rng.int(0, 4);
      if (kind === 0) { // the JCad data twice
        let j = i + 1;
        while (j < hi && pairs[j]![0] === '1000') j++;
        spliceIn(pairs, j, 0, pairs.slice(i, j).map((p) => [...p] as Pair));
      } else if (kind === 1) pairs.splice(rng.int(i + 1, i + 3), 0, ['1001', 'ACAD'], ['1000', 'x']);
      else if (kind === 2) pairs.splice(rng.int(i + 1, i + 3), 0, [rng.pick(['1002', '1040', '1070', '1005', '1010']), rng.pick(['{', '1.5', 'NaN', '}', 'abc'])]);
      else if (kind === 3) pairs.splice(i, 0, ['1001', 'OTHER_APP'], ['1000', 'data']);
      else pairs.splice(i + 1, 0, ['1000', 'x'.repeat(rng.pick([255, 256, 300, 20000]))]);
      break;
    }
    case 'index': {
      if (!faceRecords.length) break;
      const [s, e] = rng.pick(faceRecords);
      const codes = [];
      for (let i = s; i < e; i++) if (['71', '72', '73', '74'].includes(pairs[i]![0])) codes.push(i);
      const nv = Number(pairs.slice(lo, hi).find(([c]) => c === '71')?.[1] ?? 8);
      const value = rng.pick([...HOSTILE_INTS, String(nv), String(nv + 1), String(-nv), String(-(nv + 1))]);
      if (codes.length && rng.bool(0.8)) pairs[rng.pick(codes)]![1] = value;
      else pairs.splice(e, 0, ['74', value]);
      break;
    }
    case 'count': {
      for (let i = lo; i < hi; i++) if ((pairs[i]![0] === '71' || pairs[i]![0] === '72') && i < (records[1]?.[0] ?? hi)) { if (rng.bool(0.5)) pairs[i]![1] = rng.pick(HOSTILE_INTS); }
      break;
    }
    case 'records': {
      const inner = records.slice(1);
      if (!inner.length) break;
      const [s, e] = rng.pick(inner);
      const kind = rng.int(0, 2);
      if (kind === 0) pairs.splice(s, e - s);
      else if (kind === 1) spliceIn(pairs, e, 0, pairs.slice(s, e).map((p) => [...p] as Pair));
      else {
        const [s2, e2] = rng.pick(inner);
        const moved = pairs.splice(s2, e2 - s2);
        spliceIn(pairs, Math.min(s, pairs.length), 0, moved);
      }
      break;
    }
    case 'flags': {
      const [s, e] = rng.pick(records);
      for (let i = s; i < e; i++) if (pairs[i]![0] === '70') { pairs[i]![1] = rng.pick(['0', '1', '8', '16', '32', '64', '65', '128', '192', '255', '-1', '64.5']); break; }
      break;
    }
    case 'unicode': {
      const values = [];
      for (let i = lo; i < hi; i++) if (['8', '1000', '1001', '5', '330'].includes(pairs[i]![0])) values.push(i);
      if (values.length) {
        const i = rng.pick(values);
        const v = pairs[i]![1];
        const at = rng.int(0, v.length);
        pairs[i]![1] = v.slice(0, at) + rng.pick(UNICODE) + v.slice(at);
      }
      break;
    }
    case 'strip-jcad': {
      // A foreign polyface: the same mesh without JCad data (imported only when 3D is enabled).
      for (let i = hi - 1; i > lo; i--) if (pairs[i]![0] === '1001' || pairs[i]![0] === '1000') pairs.splice(i, 1);
      break;
    }
  }
  return m;
}

/** Number of POLYLINE records the reader sees (code 0 with value POLYLINE, as it trims them). */
function polylineRecords(text: string): number {
  const lines = text.split(/\r?\n/);
  let n = 0;
  for (let i = 0; i + 1 < lines.length; i += 2) if (lines[i]!.trim() === '0' && lines[i + 1]!.trim() === 'POLYLINE') n++;
  return n;
}

/** Check the read drawing (see the module comment); `text` is what was read. */
function checkDrawing(state: DrawingState, text: string, recovered: boolean): void {
  prepareDrawingState(state);
  check(Object.isFrozen(state) && (state.model3d === undefined || Object.isFrozen(state.model3d.solids)), 'state not sealed');
  const solids = state.model3d?.solids ?? [];
  check(state.model3d === undefined || solids.length > 0, 'an empty 3D model was kept');
  const ids = new Set<string>();
  let tris = 0;
  for (const s of solids) {
    const problem = validateMesh(s.mesh);
    check(problem === null, () => `solid ${s.id}: ${problem}`);
    check(meshTriangleCount(s.mesh) > 0, `solid ${s.id} has no triangles`);
    tris += meshTriangleCount(s.mesh);
    check(validSolidId(s.id) === s.id && !ids.has(s.id), `bad or duplicate id ${JSON.stringify(s.id)}`);
    ids.add(s.id);
    check(s.name === undefined || (typeof s.name === 'string' && s.name.length <= MAX_SOLID_NAME_LENGTH && !/[\u0000-\u001f\u007f-\u009f]/.test(s.name)), () => `unclean name ${JSON.stringify(s.name)}`);
    const valid = validateFeature(s.feature);
    check('feature' in valid, () => `solid ${s.id} kept an invalid history: ${'problem' in valid ? valid.problem : ''}`);
    check(s.color === 'ByLayer' || (typeof s.color === 'number' && Number.isInteger(s.color) && s.color >= 0 && s.color <= 255), () => `bad colour ${JSON.stringify(s.color)}`);
    check(state.layers.some((l) => l.name === s.layer), `solid layer ${s.layer} missing from the layer table`);
  }
  check(tris <= text.length, 'more triangles than the file could describe');
  // Every POLYLINE is accounted for: a solid, a 2D polyline, or a dropped report item.
  const report = importReportOf(state);
  const droppedLines = new Set((report?.items ?? []).filter((i) => i.type === 'POLYLINE' && i.action === 'dropped').map((i) => i.line ?? -1));
  check((report?.omitted ?? 0) === 0, 'report items were capped; the accounting below would be incomplete');
  const accounted = solids.length + state.entities.filter((e) => e.type === 'polyline').length + droppedLines.size;
  const expected = polylineRecords(text);
  if (recovered) check(accounted === expected || (accounted === expected - 1 && !!report?.recovered), () => `recovered file: ${accounted} of ${expected} POLYLINE records accounted for`);
  else check(accounted === expected, () => `${accounted} of ${expected} POLYLINE records accounted for (solids ${solids.length}, report ${JSON.stringify(report?.items.filter((i) => i.type === 'POLYLINE'))})`);
}

describe('fuzzing JCAD_3D payloads and polyface records', () => {
  it('reads the unmutated corpus exactly (entities-only and full file)', () => {
    for (const text of [ENTITIES_TEXT, FULL_TEXT]) {
      const state = readDxf(text, { model3d: true });
      expect(state.model3d?.solids.map((s) => s.id)).toEqual(corpusState.model3d!.solids.map((s) => s.id));
      expect(importReportOf(state)).toBeUndefined();
    }
  });

  it('readDxf throws only DxfReadError, keeps every record accounted for and yields sealed, in-budget drawings', () => {
    const tally = new Map<string, number>();
    fuzzSync('model3d-dxf-mutation', RUNS, (rng) => {
      const pairs = toPairs(rng.bool(0.95) ? ENTITIES_TEXT : FULL_TEXT);
      const payloads: string[] = [];
      const applied: Mutation[] = [];
      for (let k = rng.int(1, 3); k > 0; k--) applied.push(mutate(rng, pairs, payloads));
      let text = fromPairs(pairs);
      if (applied.includes('truncate') && rng.bool(0.3)) text = text.slice(0, text.lastIndexOf(CRLF, text.length - 3) + 2); // cut a value line too
      for (const p of payloads) {
        const decoded = decodeSolidPayload(p); // documented never to throw
        tally.set(`payload:${decoded.status}`, (tally.get(`payload:${decoded.status}`) ?? 0) + 1);
      }
      const recover = rng.bool(0.5);
      let state: DrawingState;
      try {
        state = readDxf(text, { model3d: rng.bool(0.7), recover });
      } catch (err) {
        check(err instanceof DxfReadError, () => `[${applied.join(', ')}] readDxf threw ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
        tally.set('DxfReadError', (tally.get('DxfReadError') ?? 0) + 1);
        return;
      }
      try {
        checkDrawing(state, text, recover);
      } catch (err) {
        throw new Error(`[${applied.join(', ')}] ${err instanceof Error ? err.message : String(err)}`);
      }
      const solids = state.model3d?.solids.length ?? 0;
      tally.set(solids === 6 ? 'six solids' : 'fewer or more solids', (tally.get(solids === 6 ? 'six solids' : 'fewer or more solids') ?? 0) + 1);
    });
    console.log(`fuzz model3d-dxf-mutation outcomes: ${JSON.stringify(Object.fromEntries(tally))}`);
    // The mutations must actually reach the interesting paths, not just break the file.
    if (!REPLAY) expect(tally.get('fewer or more solids') ?? 0).toBeGreaterThan(50);
    if (!REPLAY) expect(tally.get('six solids') ?? 0).toBeGreaterThan(200);
    if (!REPLAY) expect(tally.get('payload:bad-feature') ?? 0).toBeGreaterThan(50);
    if (!REPLAY) expect(tally.get('payload:invalid') ?? 0).toBeGreaterThan(20);
  }, fuzzTimeout());

  it('decodeSolidPayload never throws on mutated payload text', () => {
    const originals = corpusSolids().map((s) => payloadAt(toPairs(ENTITIES_TEXT), toPairs(ENTITIES_TEXT).findIndex(([c, v], i, all) => c === '0' && v === 'POLYLINE' && payloadAt(all, i)?.includes(`"id":"${s.id}"`)))!);
    fuzzSync('model3d-payload-decode', RUNS, (rng) => {
      let text = rng.pick(originals);
      try { text = mutatePayloadJson(rng, text); } catch { /* keep the original */ }
      if (rng.bool(0.5)) text = escapePayload(text);
      const out = decodeSolidPayload(text);
      check(['ok', 'bad-feature', 'newer', 'invalid'].includes(out.status), `unknown status ${out.status}`);
      if (out.status === 'ok' && out.feature) check('feature' in validateFeature(out.feature), 'an accepted feature does not revalidate');
      if (out.status === 'ok' || out.status === 'bad-feature') check(out.id === undefined || validSolidId(out.id) === out.id, 'an invalid id was accepted');
      // The decoded data never carries a prototype other than Object's.
      if (out.status === 'ok' && out.feature) check(JSON.stringify(out.feature).length < 20_000 && Object.getPrototypeOf(out.feature) === Object.prototype, 'feature prototype');
    });
  }, fuzzTimeout());
});

// ------------------------------------------------------------------ Feature3D trees

const kernel = new ManifoldDirectKernel();
afterAll(() => kernel.dispose());

const HOSTILE_REALS = [NaN, Infinity, -Infinity, -0, 0, -1, 1e-320, 1e-12, 1e12, 1e300, -1e300, 2 ** 53, 0.5, 3.7];

function frameOf(rng: Rng): Frame3 {
  if (rng.bool(0.6)) return { ...WORLD_XY_FRAME, origin: v3(rng.int(-3, 3) / 2, rng.int(-3, 3) / 2, rng.int(-3, 3) / 2) };
  return frameFromPlane({ origin: v3(rng.next(), rng.next(), rng.next()), normal: v3(rng.next() - 0.5, rng.next() - 0.5, rng.next() + 0.1) });
}

function circleLoop(cx: number, cy: number, r: number, n: number, cw = false): Point[] {
  const pts = Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((2 * Math.PI * i) / n), y: cy + r * Math.sin((2 * Math.PI * i) / n) }));
  return cw ? pts.reverse() : pts;
}

function profileOf(rng: Rng): Profile3D {
  const outer = rng.bool(0.5) ? square(rng.int(1, 4), 0.5, 0) : circleLoop(2, 1, 1, rng.int(3, 40));
  const loops: Point[][] = [outer];
  if (rng.bool(0.3)) loops.push(rng.bool(0.5) ? [...square(0.4, 1, 0.3)].reverse() : circleLoop(2, 1, 0.3, rng.int(3, 12), true));
  return { frame: rng.bool(0.7) ? WORLD_XY_FRAME : frameOf(rng), loops };
}

/** A random, mostly valid feature tree of at most `depth` Boolean levels. */
function featureOf(rng: Rng, depth: number): Feature3D {
  const seg = rng.bool(0.8) ? rng.int(3, 12) : undefined;
  const kind = depth > 0 && rng.bool(0.35) ? 'boolean' : rng.pick(['box', 'wedge', 'cylinder', 'sphere', 'cone', 'torus', 'extrude', 'revolve'] as const);
  switch (kind) {
    case 'box': case 'wedge': return { kind, frame: frameOf(rng), width: rng.int(1, 4) / 2, depth: rng.int(1, 4) / 2, height: rng.int(1, 4) / 2 };
    case 'cylinder': return { kind, frame: frameOf(rng), radius: rng.int(1, 4) / 3, height: rng.int(1, 4) / 2, ...(seg ? { segments: seg } : {}) };
    case 'sphere': return { kind, frame: frameOf(rng), radius: rng.int(1, 4) / 3, ...(seg ? { segments: seg, rings: rng.int(2, 6) } : {}) };
    case 'cone': return { kind, frame: frameOf(rng), baseRadius: rng.int(0, 3) / 3, topRadius: rng.int(1, 3) / 3, height: 1, ...(seg ? { segments: seg } : {}) };
    case 'torus': return { kind, frame: frameOf(rng), majorRadius: 1, minorRadius: rng.int(1, 4) / 5, ...(seg ? { segments: seg, rings: rng.int(3, 6) } : {}) };
    case 'extrude': return { kind, profile: profileOf(rng), distance: rng.pick([-2, -0.5, 0.5, 1, 3]) };
    case 'revolve': {
      const profile = profileOf(rng);
      const f = profile.frame;
      return { kind, profile, axis: { origin: f.origin, dir: rng.bool(0.5) ? f.yAxis : f.xAxis }, angle: rng.pick([Math.PI / 2, Math.PI, 2 * Math.PI, -Math.PI / 3]), ...(seg ? { segments: seg } : {}) };
    }
    case 'boolean': return { kind, op: rng.pick(['union', 'subtract', 'intersect'] as const), operands: [featureOf(rng, depth - 1), featureOf(rng, depth - 1)] };
  }
}

/** Mutate one field somewhere in the tree (in place on a deep copy). */
function mutateFeature(rng: Rng, root: Feature3D): unknown {
  const copy = JSON.parse(JSON.stringify(root)) as unknown;
  const all = containers(copy);
  const target = rng.pick(all) as Record<string, unknown>;
  const keys = Object.keys(target);
  const kind = rng.int(0, 9);
  const key = keys.length ? rng.pick(keys) : 'x';
  const v = target[key];
  if (kind <= 3 && (typeof v === 'number' || keys.length)) target[key] = rng.pick(HOSTILE_REALS);
  else if (kind === 4) target[key] = hostileJsonValue(rng);
  else if (kind === 5) delete target[key];
  else if (kind === 6 && Array.isArray(target)) {
    if (rng.bool(0.5)) target.push(rng.bool(0.5) ? { ...(target[0] as object) } : { x: 1e300, y: NaN });
    else target.splice(0, rng.int(0, target.length));
  } else if (kind === 7) return deepTree(rng.int(20, 80), copy);
  else if (kind === 8) {
    // Profiles that the sketch step would refuse: self-intersecting, collinear, repeated points.
    const loop = [{ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 2, y: 0 }, { x: 0, y: 2 }];
    const bad = rng.pick([loop, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }], [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], [...square(1)].reverse(), square(1e-300), square(1e300), circleLoop(0, 0, 1, rng.int(300, 600))]);
    return { kind: 'extrude', profile: { frame: WORLD_XY_FRAME, loops: rng.bool(0.5) ? [bad] : [square(1), bad] }, distance: 1 };
  } else target[rng.pick(['kind', 'op', 'source'])] = rng.pick(['xor', 'mesh', 'unknown', 'boolean', 'union', '__proto__', 'imported']);
  return copy;
}

/** The documented evaluation errors (src/model3d/errors.ts): Model3DInputError, GeometryBudgetError, KernelError. */
const DOCUMENTED = (err: unknown): boolean => isModel3DUserError(err);

describe('fuzzing Feature3D trees through evaluateFeature', () => {
  it('only documented errors escape, and every result is a closed, outward, in-budget mesh', async () => {
    expect((await kernel.ready()).available).toBe(true);
    const tally = new Map<string, number>();
    await fuzz('model3d-feature-eval', RUNS, async (rng) => {
      const tree = featureOf(rng, rng.int(0, 2));
      const input = rng.bool(0.8) ? mutateFeature(rng, tree) : tree;
      try {
        const mesh = await evaluateFeature(input as Feature3D, kernel);
        check(validateMesh(mesh) === null, 'invalid mesh');
        check(meshTriangleCount(mesh) > 0 && meshTriangleCount(mesh) <= MAX_SOLID_TRIANGLES, 'triangle count');
        check(meshIsClosed(mesh), 'open mesh');
        check(meshVolume(mesh) > 0, () => `volume ${meshVolume(mesh)}`);
        tally.set('mesh', (tally.get('mesh') ?? 0) + 1);
      } catch (err) {
        check(DOCUMENTED(err), () => `undocumented ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)} for ${JSON.stringify(input).slice(0, 2000)}`);
        const name = err instanceof Error ? err.name : 'other';
        tally.set(name, (tally.get(name) ?? 0) + 1);
      }
    });
    console.log(`fuzz model3d-feature-eval outcomes: ${JSON.stringify(Object.fromEntries(tally))}`);
    if (!REPLAY) expect(tally.get('mesh') ?? 0).toBeGreaterThan(300);
    if (!REPLAY) expect(tally.get('KernelError') ?? 0).toBeGreaterThan(10);
    if (!REPLAY) expect(tally.get('Model3DInputError') ?? 0).toBeGreaterThan(100);
    if (!REPLAY) expect(tally.get('FeatureEvalError') ?? 0).toBeGreaterThan(50);
  }, fuzzTimeout());
});

// ------------------------------------------------------------------ 3D dimensions (DIMENSION records with JCAD_3D data)

const DIM_RUNS = 1000;

/** Dimensions of every kind in a tilted plane, a negative-normal plane and a world plane. */
function corpusDimensions(): Dimension3D[] {
  const s = STANDARD_DIMSTYLE;
  const neg = frameFromPlane({ origin: v3(-4, 0.5, 2), normal: v3(-0.2, -0.9, -0.4) });
  const xz: Frame3 = { origin: v3(0, 3, 0), xAxis: v3(1, 0, 0), yAxis: v3(0, 0, 1), zAxis: v3(0, -1, 0) };
  const P = (f: Frame3, x: number, y: number, z = 0) => planeWorld(f, { x, y }, z);
  return [
    makeDimension3D({ id: 'dim-al', kind: 'aligned', plane: tilted, p1: P(tilted, 0, 0), p2: P(tilted, 3, 4), location: P(tilted, 0, 3), style: s, layer: 'DIMS', color: 2 }),
    makeDimension3D({ id: 'dim-lx', kind: 'linear', axis: 'x', plane: neg, p1: P(neg, 1, 1), p2: P(neg, 4, 5), location: P(neg, 2, 7), style: s }),
    makeDimension3D({ id: 'dim-ly', kind: 'linear', axis: 'y', plane: xz, p1: P(xz, 1, 1), p2: P(xz, 4, 5), location: P(xz, 7, 3), style: s, textOverride: 'H <>' }),
    makeDimension3D({ id: 'dim-an', kind: 'angular', plane: tilted, vertex: P(tilted, 0, 0), p1: P(tilted, 2, 0), p2: P(tilted, 0, 2), location: P(tilted, 1, 1), style: s }),
    makeDimension3D({ id: 'dim-pr', kind: 'aligned', plane: xz, p1: P(xz, 0, 0), p2: P(xz, 3, 4, 2), location: P(xz, -1, 2), style: s }),
  ];
}

const dimCorpusState: DrawingState = withModel3D({ ...base, layers: [...base.layers, { name: 'DIMS', color: 3, visible: true, locked: false, lineWeight: 0.25 }] }, addDimensions3D(model3dOf(base), corpusDimensions()));
const DIM_TEXT = entitiesOnly(writeDxf(dimCorpusState));

/** [start, end) pair ranges of each DIMENSION record. */
function dimensionRanges(pairs: readonly Pair[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i]![0] !== '0' || pairs[i]![1] !== 'DIMENSION') continue;
    let j = i + 1;
    while (j < pairs.length && pairs[j]![0] !== '0') j++;
    out.push([i, j]);
  }
  return out;
}

type DimMutation = 'truncate' | 'number' | 'payload' | 'xdata' | 'flags' | 'strip-jcad' | 'extrusion' | 'swap-codes' | 'text';

/** Apply one mutation to a DIMENSION record; returns its name (for the failure message). */
function mutateDimension(rng: Rng, pairs: Pair[], payloads: string[]): DimMutation {
  const ranges = dimensionRanges(pairs);
  if (!ranges.length) return 'truncate';
  const [lo, hi] = rng.pick(ranges);
  const m = rng.weighted<DimMutation>([[1, 'truncate'], [4, 'number'], [4, 'payload'], [2, 'xdata'], [2, 'flags'], [1, 'strip-jcad'], [2, 'extrusion'], [1, 'swap-codes'], [1, 'text']]);
  switch (m) {
    case 'truncate':
      pairs.length = rng.int(lo, hi);
      break;
    case 'number': {
      const numeric = [];
      for (let i = lo; i < hi; i++) if (['10', '20', '30', '11', '21', '31', '13', '23', '33', '14', '24', '34', '15', '25', '35', '42', '50', '70', '71', '62'].includes(pairs[i]![0])) numeric.push(i);
      if (numeric.length) pairs[rng.pick(numeric)]![1] = rng.pick([...HOSTILE_NUMBERS, '0', '1', '-1', '1e300']);
      break;
    }
    case 'payload': {
      const text = payloadAt(pairs, lo);
      if (text === null) break;
      let mutated: string;
      try {
        mutated = mutatePayloadJson(rng, text);
      } catch {
        mutated = text.slice(0, rng.int(0, text.length));
      }
      const encoded = rng.bool(0.9) ? escapePayload(mutated) : mutated;
      payloads.push(encoded);
      setPayload(rng, pairs, lo, encoded);
      break;
    }
    case 'xdata': {
      let i = lo + 1;
      while (i < hi && !(pairs[i]![0] === '1001' && pairs[i]![1] === 'JCAD_3D')) i++;
      if (i >= hi) break;
      const kind = rng.int(0, 3);
      if (kind === 0) {
        let j = i + 1;
        while (j < hi && pairs[j]![0] === '1000') j++;
        spliceIn(pairs, j, 0, pairs.slice(i, j).map((p) => [...p] as Pair));
      } else if (kind === 1) pairs.splice(rng.int(i + 1, i + 2), 0, [rng.pick(['1002', '1040', '1070']), rng.pick(['{', '1.5', 'NaN'])]);
      else if (kind === 2) pairs.splice(i, 0, ['1001', 'OTHER_APP'], ['1000', 'data']);
      else pairs.splice(i + 1, 0, ['1000', 'x'.repeat(rng.pick([255, 256, 20000]))]);
      break;
    }
    case 'flags':
      for (let i = lo; i < hi; i++) if (pairs[i]![0] === '70') { pairs[i]![1] = rng.pick(['0', '1', '2', '3', '4', '5', '6', '32', '33', '37', '160', '-1', '1.5']); break; }
      break;
    case 'strip-jcad':
      for (let i = hi - 1; i > lo; i--) if (pairs[i]![0] === '1001' && pairs[i]![1] === 'JCAD_3D') {
        let j = i + 1;
        while (j < pairs.length && pairs[j]![0] === '1000') j++;
        pairs.splice(i, j - i);
      }
      break;
    case 'extrusion':
      for (let i = lo; i < hi; i++) if (['210', '220', '230'].includes(pairs[i]![0]) && rng.bool(0.5)) pairs[i]![1] = rng.pick(['0', '1', '-1', '0.5', '1e-300', 'NaN']);
      break;
    case 'swap-codes': {
      const a = rng.int(lo, hi - 1), b = rng.int(lo, hi - 1);
      const t = pairs[a]![0];
      pairs[a]![0] = pairs[b]![0];
      pairs[b]![0] = t;
      break;
    }
    case 'text':
      for (let i = lo; i < hi; i++) if (pairs[i]![0] === '1' || pairs[i]![0] === '3') { pairs[i]![1] = rng.pick(['', '<>', ' ', '<> (projected)', ' (projected)', '\\U+0041', rng.pick(UNICODE).repeat(rng.int(1, 80))]); break; }
      break;
  }
  return m;
}

/** Number of DIMENSION records the reader sees. */
function dimensionRecords(text: string): number {
  const lines = text.split(/\r?\n/);
  let n = 0;
  for (let i = 0; i + 1 < lines.length; i += 2) if (lines[i]!.trim() === '0' && lines[i + 1]!.trim() === 'DIMENSION') n++;
  return n;
}

/** Check the read drawing's dimensions (see the module comment); `text` is what was read. */
function checkDimensions(state: DrawingState, text: string, recovered: boolean): void {
  prepareDrawingState(state);
  const dims3 = state.model3d?.dimensions ?? [];
  check(state.model3d === undefined || state.model3d.solids.length > 0 || dims3.length > 0, 'an empty 3D model was kept');
  check(state.model3d?.dimensions === undefined || dims3.length > 0, 'an empty dimension list was kept');
  check(dims3.every((d) => Object.isFrozen(d)), 'dimension not sealed');
  const ids = new Set<string>();
  for (const d of dims3) {
    check(validSolidId(d.id) === d.id && !ids.has(d.id), `bad or duplicate id ${JSON.stringify(d.id)}`);
    ids.add(d.id);
    check(isOrthonormalFrame(d.plane, 1e-6), `dimension ${d.id}: plane is not orthonormal`);
    check([d.p1, d.p2, ...(d.vertex ? [d.vertex] : [])].every((p) => Number.isFinite(p.x + p.y + p.z)) && Number.isFinite(d.offset), `dimension ${d.id}: non-finite numbers`);
    check(Number.isFinite(dimension3dMeasurement(d)), `dimension ${d.id}: measurement not finite`);
    // Rebuilding through the constructor works (the data is consistent) and the text can be laid out.
    makeDimension3D(dimension3dSpec(d));
    check(typeof dimension3dText(d) === 'string', 'no text');
    check(state.layers.some((l) => l.name === d.layer), `dimension layer ${d.layer} missing from the layer table`);
    check(d.color === 'ByLayer' || (typeof d.color === 'number' && Number.isInteger(d.color) && d.color >= 0 && d.color <= 255), () => `bad colour ${JSON.stringify(d.color)}`);
  }
  // Every DIMENSION is accounted for: a 3D dimension, a 2D dimension, or a dropped report item.
  const report = importReportOf(state);
  check((report?.omitted ?? 0) === 0, 'report items were capped');
  const dropped = new Set((report?.items ?? []).filter((i) => i.type === 'DIMENSION' && i.action === 'dropped').map((i) => i.line ?? -1));
  const accounted = dims3.length + state.entities.filter((e) => e.type === 'dimension').length + dropped.size;
  const expected = dimensionRecords(text);
  if (recovered) check(accounted === expected || (accounted === expected - 1 && !!report?.recovered), () => `recovered: ${accounted} of ${expected} DIMENSION records accounted for`);
  else check(accounted === expected, () => `${accounted} of ${expected} DIMENSION records accounted for (3D ${dims3.length})`);
}

describe('fuzzing 3D dimension records', () => {
  it('reads the unmutated dimension corpus exactly', () => {
    const state = readDxf(DIM_TEXT, { model3d: true });
    expect(state.model3d?.dimensions?.map((d) => d.id)).toEqual(corpusDimensions().map((d) => d.id));
    expect(importReportOf(state)).toBeUndefined();
  });

  it('readDxf throws only DxfReadError, keeps every DIMENSION accounted for and yields valid dimensions', () => {
    const tally = new Map<string, number>();
    fuzzSync('model3d-dimension-mutation', DIM_RUNS, (rng) => {
      const pairs = toPairs(DIM_TEXT);
      const payloads: string[] = [];
      const applied: DimMutation[] = [];
      for (let k = rng.int(1, 3); k > 0; k--) applied.push(mutateDimension(rng, pairs, payloads));
      let text = fromPairs(pairs);
      if (applied.includes('truncate') && rng.bool(0.3)) text = text.slice(0, text.lastIndexOf(CRLF, text.length - 3) + 2);
      for (const p of payloads) {
        const decoded = decodeDimensionPayload(p); // documented never to throw
        tally.set(`payload:${decoded.status}`, (tally.get(`payload:${decoded.status}`) ?? 0) + 1);
      }
      const recover = rng.bool(0.5);
      let state: DrawingState;
      try {
        state = readDxf(text, { model3d: rng.bool(0.7), recover });
      } catch (err) {
        check(err instanceof DxfReadError, () => `[${applied.join(', ')}] readDxf threw ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
        tally.set('DxfReadError', (tally.get('DxfReadError') ?? 0) + 1);
        return;
      }
      try {
        checkDimensions(state, text, recover);
      } catch (err) {
        throw new Error(`[${applied.join(', ')}] ${err instanceof Error ? err.message : String(err)}`);
      }
      const n = state.model3d?.dimensions?.length ?? 0;
      const key = n === 5 ? 'five dimensions' : 'fewer dimensions';
      tally.set(key, (tally.get(key) ?? 0) + 1);
    });
    console.log(`fuzz model3d-dimension-mutation outcomes: ${JSON.stringify(Object.fromEntries(tally))}`);
    if (!REPLAY) expect(tally.get('five dimensions') ?? 0).toBeGreaterThan(200);
    if (!REPLAY) expect(tally.get('fewer dimensions') ?? 0).toBeGreaterThan(20);
    if (!REPLAY) expect(tally.get('payload:invalid') ?? 0).toBeGreaterThan(20);
  }, fuzzTimeout());
});
