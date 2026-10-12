import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error plain JS policy shared with the desktop loader and native verifier
import { boundDwgWasmMemory, wasmMemoryLimits, MAX_DWG_WASM_BYTES, WASM_PAGE_BYTES } from '../scripts/dwg-wasm-memory.mjs';

const header = [0, 97, 115, 109, 1, 0, 0, 0];
function u32(value: number) {
  const bytes = [];
  do { const part = value % 128; value = Math.floor(value / 128); bytes.push(part | (value ? 128 : 0)); } while (value);
  return bytes;
}
const section = (id: number, body: number[]) => [id, ...u32(body.length), ...body];
const name = (value: string) => [value.length, ...new TextEncoder().encode(value)];
const memoryBody = (min: number, max?: number, flags = max === undefined ? 0 : 1) => [1, ...u32(flags), ...u32(min), ...(max === undefined ? [] : u32(max))];

/** Exports a real WASM memory.grow instruction, which a JS prototype patch cannot intercept. */
function growModule(min: number, max?: number) {
  return Uint8Array.from([
    ...header,
    ...section(0, [...name('policy test'), 11, 22, 33]),
    ...section(1, [1, 0x60, 1, 0x7f, 1, 0x7f]),
    ...section(3, [1, 0]),
    ...section(5, memoryBody(min, max)),
    ...section(7, [2, ...name('memory'), 2, 0, ...name('grow'), 0, 0]),
    ...section(10, [1, 6, 0, 0x20, 0, 0x40, 0, 0x0b]),
    ...section(0, [...name('trailing metadata'), 44, 55, 66]),
  ]);
}

type GrowExports = { memory: WebAssembly.Memory; grow: (pages: number) => number };
async function instantiate(bytes: Uint8Array): Promise<GrowExports> {
  return (await WebAssembly.instantiate(bytes as Uint8Array<ArrayBuffer>)).instance.exports as GrowExports;
}

describe('engine-enforced DWG WASM memory limit', () => {
  it('bounds both direct WASM and JS growth without changing the global prototype', async () => {
    const grow = WebAssembly.Memory.prototype.grow;
    const exports = await instantiate(boundDwgWasmMemory(growModule(2, 100), 4 * WASM_PAGE_BYTES));
    expect(exports.memory.buffer.byteLength).toBe(2 * WASM_PAGE_BYTES);
    expect(exports.grow(2)).toBe(2);
    expect(exports.memory.buffer.byteLength).toBe(4 * WASM_PAGE_BYTES);
    expect(exports.grow(1)).toBe(-1);
    expect(exports.memory.buffer.byteLength).toBe(4 * WASM_PAGE_BYTES);
    expect(() => exports.memory.grow(1)).toThrow(RangeError);
    expect(WebAssembly.Memory.prototype.grow).toBe(grow);
    expect(new WebAssembly.Memory({ initial: 1, maximum: 100 }).grow(8)).toBe(1);
  });

  it('adds an engine maximum to unbounded memory and preserves a stricter existing maximum', async () => {
    const unbounded = await instantiate(boundDwgWasmMemory(growModule(1), 3 * WASM_PAGE_BYTES));
    expect(unbounded.grow(2)).toBe(1);
    expect(unbounded.grow(1)).toBe(-1);
    const stricter = await instantiate(boundDwgWasmMemory(growModule(1, 2), 4 * WASM_PAGE_BYTES));
    expect(stricter.grow(1)).toBe(1);
    expect(stricter.grow(1)).toBe(-1);
    expect(wasmMemoryLimits(boundDwgWasmMemory(growModule(1, 2), 4 * WASM_PAGE_BYTES))[0].maxPages).toBe(2);
  });

  it('rejects excessive initial allocation before any module is instantiated', () => {
    expect(() => boundDwgWasmMemory(growModule(5, 100), 4 * WASM_PAGE_BYTES)).toThrow(/initial memory exceeds/);
    expect(() => boundDwgWasmMemory(growModule(1, 2), 0)).toThrow(/whole number/);
    for (const limit of [NaN, Infinity, -1, 4.5 * WASM_PAGE_BYTES, 65537 * WASM_PAGE_BYTES]) {
      expect(() => boundDwgWasmMemory(growModule(1, 2), limit)).toThrow(RangeError);
    }
  });

  it('accepts an initial memory exactly at its cap but refuses any growth', async () => {
    const exports = await instantiate(boundDwgWasmMemory(growModule(4, 100), 4 * WASM_PAGE_BYTES));
    expect(exports.grow(0)).toBe(4);
    expect(exports.grow(1)).toBe(-1);
    expect(exports.memory.buffer.byteLength).toBe(4 * WASM_PAGE_BYTES);
  });

  it('preserves the input and all bytes outside the one memory section', () => {
    // Same-length LEB encodings make the byte-level invariant especially clear.
    const input = growModule(1, 100), before = Uint8Array.from(input);
    const bounded = boundDwgWasmMemory(input, 4 * WASM_PAGE_BYTES);
    expect(input).toEqual(before);
    expect(bounded).not.toBe(input);
    const changed = Array.from(input.keys()).filter((index) => bounded[index] !== input[index]);
    expect(changed).toHaveLength(1);
    expect(input[changed[0]!]).toBe(100);
    expect(bounded[changed[0]!]).toBe(4);
    expect(WebAssembly.validate(bounded)).toBe(true);
  });

  it('retains surrounding custom sections when adding a maximum changes the section length', async () => {
    const input = growModule(1);
    const original = await WebAssembly.compile(input as Uint8Array<ArrayBuffer>);
    const bounded = await WebAssembly.compile(boundDwgWasmMemory(input, 256 * WASM_PAGE_BYTES));
    for (const label of ['policy test', 'trailing metadata']) {
      const before = WebAssembly.Module.customSections(original, label).map((bytes) => Array.from(new Uint8Array(bytes)));
      const after = WebAssembly.Module.customSections(bounded, label).map((bytes) => Array.from(new Uint8Array(bytes)));
      expect(after).toEqual(before);
      expect(after).toHaveLength(1);
    }
  });

  it('fails closed for missing, imported, shared, wasm64 and multiple memories', () => {
    const imported = section(2, [1, ...name('env'), ...name('memory'), 2, 1, 1, 2]);
    const samples = [
      Uint8Array.from(header),
      Uint8Array.from([...header, ...imported]),
      Uint8Array.from([...header, ...section(5, memoryBody(1, 2, 3))]),
      Uint8Array.from([...header, ...section(5, memoryBody(1, 2, 4))]),
      Uint8Array.from([...header, ...section(5, [2, 1, 1, 2, 1, 1, 2])]),
      Uint8Array.from([...header, ...imported, ...section(5, memoryBody(1, 2))]),
      Uint8Array.from([...header, ...section(5, memoryBody(1, 2)), ...section(5, memoryBody(1, 2))]),
    ];
    for (const bytes of samples) expect(() => boundDwgWasmMemory(bytes)).toThrow();
  });

  it('rejects truncated, overflowing and inconsistent memory declarations', () => {
    for (const bytes of [
      Uint8Array.from([0, 97]),
      Uint8Array.from([...header, 5, 9, 1, 1]),
      Uint8Array.from([...header, ...section(5, [1, 1, 128])]),
      Uint8Array.from([...header, ...section(5, [1, 1, 255, 255, 255, 255, 31, 2])]),
      Uint8Array.from([...header, ...section(5, [1, 1, 128, 128, 128, 128, 128, 0, 2])]),
      Uint8Array.from([...header, ...section(5, memoryBody(3, 2))]),
      Uint8Array.from([...header, ...section(5, memoryBody(1, 65537))]),
      Uint8Array.from([...header, ...section(5, [1, 1, 1, 2, 0])]),
    ]) expect(() => boundDwgWasmMemory(bytes)).toThrow();
  });

  it('caps the checked vendor runtime in memory while retaining its original byte image', () => {
    const bytes = readFileSync(join(__dirname, '../vendor/libredwg-web-bg/factory/libredwg-web.wasm'));
    const original = Buffer.from(bytes);
    expect(wasmMemoryLimits(bytes)).toEqual([{ origin: 'defined', flags: 1, minPages: 16384, maxPages: 65536, minBytes: 1073741824, maxBytes: 4294967296 }]);
    const bounded = boundDwgWasmMemory(bytes);
    expect(wasmMemoryLimits(bounded)).toEqual([{ origin: 'defined', flags: 1, minPages: 16384, maxPages: 32768, minBytes: 1073741824, maxBytes: MAX_DWG_WASM_BYTES }]);
    expect(bytes.equals(original)).toBe(true);
    expect(WebAssembly.validate(bounded)).toBe(true);
  });
});
