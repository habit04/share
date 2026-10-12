import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { serialize, deserialize } from 'node:v8';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error plain JS desktop/CLI reader
import { readDwgPayload } from '../scripts/dwg-reader.mjs';

const require = createRequire(import.meta.url);
const { PROTOCOL_VERSION, DWG_PROTOCOL_VERSION, MAX_DWG_INPUT_BYTES, MAX_DWG_PAYLOAD_BYTES,
  MAX_DWG_CHUNK_BYTES, MAX_DWG_MESSAGE_CHARS, WORKER_RESOURCE_LIMITS, MAX_METADATA_NODES,
  MAX_METADATA_DEPTH, MAX_STRING_CHARS, MAX_TOTAL_STRING_CHARS, MAX_DWG_RECORDS,
  validRequestId, validByteLength, validOffset, validateResourceLimits, validateChunk,
  boundedErrorMessage, validateDwgPayload } = require('../electron/dwg-protocol.cjs');

function payload(extra: Record<string, unknown> = {}) {
  return { header: {}, entities: [], layers: [], blocks: [], ...extra };
}

describe('DWG process transport metadata', () => {
  it('defines bounded protocol, input, output and per-frame contracts', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(DWG_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
    expect(MAX_DWG_INPUT_BYTES).toBe(128 * 1024 * 1024);
    expect(MAX_DWG_PAYLOAD_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_DWG_CHUNK_BYTES).toBe(1024 * 1024);
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) expect(validRequestId(value)).toBe(false);
    expect(validRequestId(1)).toBe(true);
    expect(validRequestId(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(validByteLength(MAX_DWG_INPUT_BYTES, MAX_DWG_INPUT_BYTES)).toBe(true);
    for (const value of [0, -1, NaN, Infinity, MAX_DWG_INPUT_BYTES + 1]) expect(validByteLength(value, MAX_DWG_INPUT_BYTES)).toBe(false);
    expect(validOffset(0, 5)).toBe(true);
    expect(validOffset(5, 5)).toBe(true);
    for (const value of [-1, 6, 0.5, NaN, '0']) expect(validOffset(value, 5)).toBe(false);
  });

  it('permits lower worker limits and never mutates the frozen production defaults', () => {
    const defaults = validateResourceLimits();
    expect(defaults).toEqual({ maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 });
    expect(defaults).not.toBe(WORKER_RESOURCE_LIMITS);
    expect(Object.isFrozen(WORKER_RESOURCE_LIMITS)).toBe(true);
    expect(validateResourceLimits({ maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 8 })).toEqual({ maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 8, stackSizeMb: 8 });
    expect(validateResourceLimits({ maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 1, stackSizeMb: 1 })).toEqual({ maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 1, stackSizeMb: 1 });
  });

  it('rejects excessive, invalid and unknown resource limits', () => {
    for (const value of [null, 123, [], { maxOldGenerationSizeMb: 513 }, { maxOldGenerationSizeMb: 15 },
      { maxYoungGenerationSizeMb: 65 }, { maxYoungGenerationSizeMb: 0 }, { stackSizeMb: 9 },
      { stackSizeMb: 0.5 }, { maxOldGenerationSizeMb: null }, { maxOldGenerationSizeMb: NaN }, { maxOldGenerationSizeMb: '24' }, { codeRangeSizeMb: 4096 }]) {
      expect(() => validateResourceLimits(value)).toThrow(/resource limits/);
    }
  });

  it('requires contiguous bounded chunks including a final partial frame', () => {
    const total = MAX_DWG_CHUNK_BYTES + 3;
    expect(validateChunk(new Uint8Array(MAX_DWG_CHUNK_BYTES), 0, 0, total)).toBe(MAX_DWG_CHUNK_BYTES);
    expect(validateChunk(new Uint8Array(3), MAX_DWG_CHUNK_BYTES, MAX_DWG_CHUNK_BYTES, total)).toBe(total);
    for (const [bytes, offset, expected, length] of [
      [new Uint8Array(0), 0, 0, 2], [new Uint8Array(3), 0, 0, 2],
      [new Uint8Array(MAX_DWG_CHUNK_BYTES + 1), 0, 0, total], [new Uint8Array(1), 1, 0, 2],
      [new Uint8Array(1), 0, 1, 2], [new Uint8Array(1), -1, -1, 2],
      [new Uint8Array(1), 0.5, 0.5, 2], [new ArrayBuffer(1), 0, 0, 2], [[1], 0, 0, 2],
    ]) expect(() => validateChunk(bytes, offset, expected, length)).toThrow(/byte chunk/);
  });

  it('bounds native errors before transferring them', () => {
    expect(boundedErrorMessage(new Error('bad drawing'))).toBe('bad drawing');
    expect(boundedErrorMessage('x'.repeat(MAX_DWG_MESSAGE_CHARS + 20))).toHaveLength(MAX_DWG_MESSAGE_CHARS);
    expect(boundedErrorMessage(undefined)).toBe('The DWG reader failed.');
  });
});

describe('DWG payload validation before serialization', () => {
  it.each(['example_r14.dwg', 'example_2000.dwg', 'example_2004.dwg', 'example_2007.dwg', 'example_2010.dwg', 'example_2013.dwg', 'example_2018.dwg',
    '../tests/fixtures/interchange/r2018-mtext-background.dwg'])('accepts the actual bounded native payload of %s', async (file) => {
    const result = await readDwgPayload(readFileSync(join(__dirname, '../fixtures', file)));
    expect(() => validateDwgPayload(result.payload, result.version)).not.toThrow();
    const serialized = serialize(result);
    expect(serialized.byteLength).toBeLessThanOrEqual(MAX_DWG_PAYLOAD_BYTES);
    const back = deserialize(serialized);
    expect(back.payload.entities.length).toBe(result.payload.entities.length);
    expect(back.version).toBe(result.version);
    expect(() => validateDwgPayload(back.payload, back.version)).not.toThrow();
  }, 60_000);

  it('preserves bounded native binary XDATA and shared plain values across V8 serialization', () => {
    const point = { x: 2, y: 3 };
    const input = payload({ header: Object.assign(Object.create(null), { DIMTXT: 0.5 }), entities: [{ type: 'LINE', start: point, end: point,
      xdata: [{ code: 1004, value: Uint8Array.from([0, 10, 128, 255]) }] }] });
    expect(() => validateDwgPayload(input, 'r2018')).not.toThrow();
    const back = deserialize(serialize({ payload: input, version: 'r2018' }));
    expect(Array.from(back.payload.entities[0].xdata[0].value)).toEqual([0, 10, 128, 255]);
    expect(back.payload.entities[0].start).toBe(back.payload.entities[0].end);
    expect(() => validateDwgPayload(back.payload, back.version)).not.toThrow();
    expect(() => validateDwgPayload(payload({ bytes: Buffer.from([1, 2]) }))).not.toThrow();
  });

  it('counts binary bytes toward the metadata budget, including the exact boundary', () => {
    // Root + four core containers + the binary value itself use six metadata nodes.
    expect(() => validateDwgPayload(payload({ bytes: new Uint8Array(MAX_METADATA_NODES - 6) }))).not.toThrow();
    expect(() => validateDwgPayload(payload({ bytes: new Uint8Array(MAX_METADATA_NODES - 5) }))).toThrow(/allocation budget/);
    expect(() => validateDwgPayload(payload({ bytes: new Uint8Array(MAX_METADATA_NODES + 1) }))).toThrow(/allocation budget/);
  });

  it('retains signed and unsigned native 64-bit integers without precision loss', () => {
    const values = [-(1n << 63n), 9223372036854775808n, (1n << 64n) - 1n];
    const input = payload({ entities: [{ type: 'POINT', xdata: values }] });
    expect(() => validateDwgPayload(input)).not.toThrow();
    const back = deserialize(serialize(input));
    expect(back.entities[0].xdata).toEqual(values);
    expect(() => validateDwgPayload(back)).not.toThrow();
    for (const value of [-(1n << 63n) - 1n, 1n << 64n, 1n << 1_000_000n]) expect(() => validateDwgPayload(payload({ integer: value }))).toThrow(/64-bit/);
  });

  it('counts sparse array slots and aggregate slots so tiny serialized arrays cannot hide work', () => {
    expect(() => validateDwgPayload(payload({ a: new Array(MAX_METADATA_NODES + 1) }))).toThrow(/unsupported metadata/);
    expect(() => validateDwgPayload(payload({ a: new Array(MAX_METADATA_NODES - 6) }))).not.toThrow();
    expect(() => validateDwgPayload(payload({ a: new Array(1_000_000), b: new Array(1_000_000) }))).toThrow(/allocation budget/);
  });

  it('rejects cyclic metadata, unsupported prototypes, functions, symbols and other typed arrays', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    for (const value of [cyclic, new Date(), new Map(), new Set(), new Int32Array(2), new Uint8ClampedArray(2),
      new ArrayBuffer(4), Object.create({ x: 1 }), () => 5, Symbol('value')]) {
      expect(() => validateDwgPayload(payload({ data: value }))).toThrow(/cyclic|unsupported/);
    }
    const namedSymbol = payload(); Object.defineProperty(namedSymbol, Symbol('field'), { value: 1, enumerable: true });
    expect(() => validateDwgPayload(namedSymbol)).toThrow(/unsupported/);
    class CustomArray extends Array {}
    expect(() => validateDwgPayload(payload({ data: new CustomArray() }))).toThrow(/unsupported/);
  });

  it('rejects enumerable accessors without invoking them', () => {
    let calls = 0;
    const input = payload();
    Object.defineProperty(input, 'computed', { enumerable: true, get() { calls++; return 'must not execute'; } });
    expect(() => validateDwgPayload(input)).toThrow(/unsupported metadata/);
    expect(calls).toBe(0);
  });

  it('bounds nesting at the renderer import limit', () => {
    const nested = (depth: number) => { let value: unknown = 'leaf'; for (let i = 0; i < depth; i++) value = { value }; return value; };
    expect(() => validateDwgPayload(payload({ data: nested(MAX_METADATA_DEPTH - 1) }))).not.toThrow();
    expect(() => validateDwgPayload(payload({ data: nested(MAX_METADATA_DEPTH) }))).toThrow(/nesting/);
  });

  it('bounds individual strings, names and the version', () => {
    expect(() => validateDwgPayload(payload({ text: 'a'.repeat(MAX_STRING_CHARS) }))).not.toThrow();
    expect(() => validateDwgPayload(payload({ text: 'a'.repeat(MAX_STRING_CHARS + 1) }))).toThrow(/string length/);
    expect(() => validateDwgPayload(payload({ ['k'.repeat(MAX_STRING_CHARS + 1)]: '' }))).toThrow(/string length/);
    expect(() => validateDwgPayload(payload(), 'v'.repeat(MAX_STRING_CHARS + 1))).toThrow(/string length/);
  });

  it('counts aggregate string content even when many values share one string', () => {
    const repeated = 's'.repeat(MAX_STRING_CHARS);
    expect(() => validateDwgPayload(payload({ values: Array(MAX_TOTAL_STRING_CHARS / MAX_STRING_CHARS).fill(repeated) }))).toThrow(/total import size/);
    expect(() => validateDwgPayload(payload({ values: Array(63).fill(repeated) }))).not.toThrow();
  });

  it('counts entities, blocks and every table list against one record budget', () => {
    const input = payload({ entities: new Array(MAX_DWG_RECORDS - 2), blocks: [{ entities: [null] }] });
    expect(() => validateDwgPayload(input)).not.toThrow();
    expect(() => validateDwgPayload({ ...input, layers: [null] })).toThrow(/record limit/);
    for (const table of ['imageDefs', 'styles', 'dimStyles', 'linetypes', 'layouts']) {
      expect(() => validateDwgPayload(payload({ [table]: new Array(MAX_DWG_RECORDS + 1) }))).toThrow(/record limit/);
    }
  });

  it('requires core record arrays and bounded block entity lists', () => {
    for (const value of [null, [], { entities: [] }, payload({ layers: {} }), payload({ blocks: [null] }),
      payload({ blocks: [{}] }), payload({ styles: {} })]) expect(() => validateDwgPayload(value)).toThrow(/Invalid DWG/);
    expect(() => validateDwgPayload(payload(), 17)).toThrow(/Invalid DWG/);
  });
});
