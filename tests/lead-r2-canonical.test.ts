/**
 * Independent bounded R2 controls. Prepared only; the lead owns execution.
 * Pure interface/synthetic data, no engine, font, native or PDF acceptance.
 * Copy this unchanged into the admitted private source/tests directory.
 */
import { describe, expect, it } from 'vitest';
import { ShapeSnapshotBuilder, validateShapedRun, type ShapedRunContext } from '../src/core/text-shaping-snapshot';
import { isSha256Hex, validateShapeKey, type ShapeCheck, type ShapeKey, type ShapedRun } from '../src/core/text-shaping';
import { glyph, makeKey, makeRun, sha256 } from './helpers/shaping-fixture';

const TEXT = '\u0627\u0628';
const FACE = { glyphCount: 2000, unitsPerEm: 2048 };
const INK = { xMin: 0, yMin: -200, xMax: 1000, yMax: 700 };

function example(epoch: unknown = {}) {
  const key = makeKey({ paragraphText: TEXT, itemStart: 0, itemEnd: TEXT.length, fontEpoch: epoch });
  const run = makeRun(key, TEXT, { glyphs: [glyph(101, 1, 2), glyph(100, 0, 1)], ink: { ...INK } });
  const context: ShapedRunContext = { key, itemText: TEXT, itemTextSha256: sha256(TEXT), ...FACE };
  return { key, run, context };
}

function refused(result: ShapeCheck, prefix: string) {
  expect(result).toMatchObject({ ok: false, problem: expect.stringContaining(prefix) });
}

function ownData(target: object, key: PropertyKey, value: unknown) {
  Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: false });
}

describe('exact totals and opaque epoch controls', () => {
  it('admits canonical data and freezes the actual indexed glyph records', () => {
    const { key, run, context } = example();
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 7, fontEpoch: key.fontEpoch });
    expect(builder.add(key, run, context)).toEqual({ ok: true });
    const snapshot = builder.seal();
    expect(snapshot.captureGeneration).toBe(7);
    expect(snapshot.size).toBe(1);
    expect(snapshot.get(key)).toBe(run);
    expect(Object.isFrozen(run.glyphs)).toBe(true);
    expect(Object.isFrozen(run.glyphs[0])).toBe(true);
    expect(Reflect.set(run.glyphs[0]!, 'xAdvance', 999)).toBe(false);
    expect(snapshot.get(key)?.advanceX).toBe(1000);
  });

  it('rejects fractional totals atomically, then admits the unchanged exact-integer counterpart', () => {
    const { key, run, context } = example();
    const bad = { ...run, advanceY: -5e-7 };
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: key.fontEpoch });
    refused(builder.add(key, bad, context), 'advance-sum:');
    expect(Object.isFrozen(key)).toBe(false);
    expect(Object.isFrozen(bad)).toBe(false);
    expect(bad.advanceY).toBe(-5e-7);
    expect(builder.add(key, run, context)).toEqual({ ok: true });
    const snapshot = builder.seal();
    expect(snapshot.size).toBe(1);
    expect(snapshot.get(key)).toBe(run);
    expect(snapshot.get(key)?.advanceY).toBe(0);
  });

  it('keeps exact signed i64 totals beyond i32 without shrinking supplied ink or changing caps', () => {
    const text = '\u0627'.repeat(4096);
    const key = makeKey({ paragraphText: text, itemStart: 0, itemEnd: text.length });
    // Authored zero-ink glyphs isolate the declared wire-total range. This
    // is not a real-font ink/pen-position oracle. Every individual metric
    // remains <=64*16384, and the 4096 records fit the existing result cap.
    const ink = { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
    const run = makeRun(key, text, {
      glyphs: Array.from({ length: text.length }, (_, index) => glyph(100, index, index + 1, { xAdvance: 1048576, yAdvance: -1048576 })),
      ink,
    });
    expect(run.advanceX).toBe(2 ** 32);
    expect(run.advanceY).toBe(-(2 ** 32));
    expect(validateShapedRun(run, { key, itemText: text, itemTextSha256: sha256(text), glyphCount: 2000, unitsPerEm: 16384 })).toEqual({ ok: true });
    expect(run.ink).toBe(ink);
    expect(run.ink).toEqual({ xMin: 0, yMin: 0, xMax: 0, yMax: 0 });
  });

  it('does not traverse, stringify, call or freeze the real opaque function epoch', () => {
    let touched = 0;
    const epoch = () => { touched += 1; throw Error('Opaque epoch was called'); };
    Object.defineProperty(epoch, 'toJSON', { get() { touched += 1; throw Error('Opaque epoch was traversed'); } });
    const { key, run, context } = example(epoch);
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: epoch });
    expect(builder.add(key, run, context)).toEqual({ ok: true });
    const snapshot = builder.seal();
    expect(snapshot.get(key)).toBe(run);
    expect(snapshot.fontEpoch).toBe(epoch);
    expect(snapshot.get({ ...key, fontEpoch: () => undefined })).toBeUndefined();
    expect(touched).toBe(0);
    expect(Object.isFrozen(epoch)).toBe(false);
  });

  it('does not coerce an object-shaped digest to obtain a nominally valid hash', () => {
    let calls = 0;
    const value = { toString() { calls += 1; return sha256(TEXT); } };
    expect(isSha256Hex(value)).toBe(false);
    expect(calls).toBe(0);
  });
});

describe('malformed scalar diagnostics refuse without coercion exceptions', () => {
  it('refuses a plain object with non-callable toString in a feature slot', () => {
    const { key } = example();
    const bad = { ...key, features: [{ toString: 0 }] } as unknown as ShapeKey;
    refused(validateShapeKey(bad), 'invalid-key:');
  });

  it('refuses a null-prototype object in a buffer flag slot', () => {
    const { key } = example();
    const bad = { ...key, bufferFlags: [Object.create(null)] } as unknown as ShapeKey;
    refused(validateShapeKey(bad), 'invalid-key:');
  });

  it('does not invoke a feature object conversion while constructing its refusal', () => {
    const { key } = example();
    let calls = 0;
    const feature = { toString() { calls += 1; throw Error('Invalid producer scalar was coerced'); } };
    const bad = { ...key, features: [feature] } as unknown as ShapeKey;
    refused(validateShapeKey(bad), 'invalid-key:');
    expect(calls).toBe(0);
  });

  it('refuses a Symbol GID without interpolating it into an exception', () => {
    const { run, context } = example();
    const bad = { ...run, glyphs: [{ ...run.glyphs[0]!, glyph: Symbol('invalid GID') }, run.glyphs[1]!] } as unknown as ShapedRun;
    refused(validateShapedRun(bad, context), 'glyph-range:');
  });

  it('refuses a Symbol cluster offset without interpolating it into an exception', () => {
    const { run, context } = example();
    const bad = { ...run, glyphs: [{ ...run.glyphs[0]!, clusterStart: Symbol('invalid offset') }, run.glyphs[1]!] } as unknown as ShapedRun;
    refused(validateShapedRun(bad, context), 'cluster-partition:');
  });

  it('refuses a Symbol uncovered kind without interpolating it into an exception', () => {
    const { key, context } = example();
    const run = makeRun(key, TEXT, { glyphs: [], uncovered: [{ start: 0, end: 2, kind: 'unmapped' }], ink: { ...INK } });
    const bad = { ...run, uncovered: [{ start: 0, end: 2, kind: Symbol('invalid kind') }] } as unknown as ShapedRun;
    refused(validateShapedRun(bad, context), 'uncovered-kind:');
  });
});

describe('canonical arrays cannot carry non-callable overrides of later-used methods', () => {
  it('refuses an uncovered array whose own map data property is zero', () => {
    const { key, run, context } = example();
    const ranges: ShapedRun['uncovered'] = [];
    ownData(ranges, 'map', 0);
    const bad = { ...run, uncovered: ranges };
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: key.fontEpoch });
    refused(builder.add(key, bad, context), 'non-plain-data:');
    expect(Object.isFrozen(key)).toBe(false);
    expect(Object.isFrozen(ranges)).toBe(false);
    expect(builder.add(key, run, context)).toEqual({ ok: true });
    expect(builder.seal().get(key)).toBe(run);
  });

  it('refuses own null Symbol.iterator on the key bufferFlags array', () => {
    const { key, run, context } = example();
    const flags = [...key.bufferFlags];
    ownData(flags, Symbol.iterator, null);
    const badKey = { ...key, bufferFlags: flags };
    const badRun = { ...run, binding: { ...run.binding, bufferFlags: flags } };
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: key.fontEpoch });
    refused(builder.add(badKey, badRun, context), 'non-plain-data:');
    expect(flags[0]).toBe('bot');
  });

  it('refuses a binding feature array whose own some property is null', () => {
    const { key, run, context } = example();
    const features = [...key.features];
    ownData(features, 'some', null);
    const bad = { ...run, binding: { ...run.binding, features } };
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: key.fontEpoch });
    refused(builder.add(key, bad, context), 'non-plain-data:');
  });

  it('refuses a glyph array that would become non-iterable for existing extraction consumers', () => {
    const { key, run, context } = example();
    const glyphs = [...run.glyphs];
    ownData(glyphs, Symbol.iterator, null);
    const bad = { ...run, glyphs };
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: key.fontEpoch });
    refused(builder.add(key, bad, context), 'non-plain-data:');
    expect(Object.isFrozen(glyphs)).toBe(false);
  });
});
