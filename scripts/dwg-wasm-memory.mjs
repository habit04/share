/**
 * Inspect WASM memory declarations without compiling or allocating them. The DWG loader
 * applies its policy to an in-memory copy; the checked vendor factory/WASM pair stays intact.
 */
import assert from 'node:assert/strict';

export const WASM_PAGE_BYTES = 65536;
export const MAX_DWG_WASM_BYTES = 2 * 1024 * 1024 * 1024;

function inspectWasm(bytes) {
  assert.ok(bytes instanceof Uint8Array && bytes.length >= 8, 'Truncated WASM header.');
  assert.deepEqual(Array.from(bytes.subarray(0, 8)), [0, 97, 115, 109, 1, 0, 0, 0], 'Invalid WASM header/version.');
  let offset = 8, boundary = bytes.length;
  const byte = () => { assert.ok(offset < boundary, 'Truncated WASM section.'); return bytes[offset++]; };
  const u32 = () => {
    let value = 0;
    for (let count = 0; count < 5; count++) {
      const part = byte(); value += (part & 127) * 2 ** (count * 7);
      assert.ok(value <= 0xffffffff, 'WASM integer exceeds u32.');
      if (!(part & 128)) return value;
    }
    throw new Error('Overlong WASM integer.');
  };
  const string = () => {
    const size = u32(); assert.ok(size <= 4096 && offset + size <= boundary, 'Invalid WASM import name.');
    const result = new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(offset, offset + size)); offset += size; return result;
  };
  const valueType = () => { const type = byte(); if (type === 0x63 || type === 0x64) u32(); };
  const limits = () => {
    const flags = u32(); assert.ok(flags <= 3, 'Candidate must retain wasm32 limits.');
    const minPages = u32(), maxPages = flags & 1 ? u32() : null;
    assert.ok(maxPages === null || maxPages >= minPages, 'Invalid WASM limits.');
    return { flags, minPages, maxPages, minBytes: minPages * WASM_PAGE_BYTES, maxBytes: maxPages === null ? null : maxPages * WASM_PAGE_BYTES };
  };
  const memories = [];
  let memorySection = null;
  let importsSeen = false;
  while (offset < bytes.length) {
    boundary = bytes.length;
    const start = offset;
    const section = byte(), size = u32(), end = offset + size;
    assert.ok(end <= bytes.length, 'Truncated WASM section payload.'); boundary = end;
    if (section === 2) {
      assert.ok(!importsSeen, 'Duplicate WASM import section.'); importsSeen = true;
      const count = u32(); assert.ok(count <= 4096, 'WASM import count exceeds inspection budget.');
      for (let index = 0; index < count; index++) {
        const module = string(), name = string(), kind = byte();
        if (kind === 0) u32();
        else if (kind === 1) { valueType(); limits(); }
        else if (kind === 2) memories.push({ origin: 'import', module, name, ...limits() });
        else if (kind === 3) { valueType(); byte(); }
        else if (kind === 4) { byte(); u32(); }
        else throw new Error('Unknown WASM import kind.');
      }
      assert.equal(offset, end, 'Invalid WASM import section length.');
    } else if (section === 5) {
      assert.ok(!memorySection, 'Duplicate WASM memory section.');
      const count = u32(); assert.ok(count <= 1, 'Candidate must retain one linear memory.');
      for (let index = 0; index < count; index++) memories.push({ origin: 'defined', ...limits() });
      assert.equal(offset, end, 'Invalid WASM memory section length.');
      memorySection = { start, end };
    }
    offset = end;
  }
  return { memories, memorySection };
}

/** Existing native provenance inspection API: never instantiates the candidate. */
export function wasmMemoryLimits(bytes) {
  return inspectWasm(bytes).memories;
}

function encodeU32(value) {
  const bytes = [];
  do {
    const part = value % 128; value = Math.floor(value / 128);
    bytes.push(part | (value ? 128 : 0));
  } while (value);
  return bytes;
}

/**
 * Bind the shipped module's sole, defined wasm32 memory to an engine-enforced maximum.
 * This covers initial allocation and both JS and native WASM memory.grow. Imported/shared/
 * multiple memories are deliberately refused until their complete ownership is implemented.
 * No vendor file is changed, and no unrelated section or factory code is rewritten.
 * @param {Uint8Array} bytes
 * @param {number} maxBytes
 * @returns {Uint8Array}
 */
export function boundDwgWasmMemory(bytes, maxBytes = MAX_DWG_WASM_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < WASM_PAGE_BYTES || maxBytes > 65536 * WASM_PAGE_BYTES || maxBytes % WASM_PAGE_BYTES !== 0) {
    throw new RangeError('The DWG WASM memory limit must be a whole number of wasm32 pages.');
  }
  const { memories, memorySection } = inspectWasm(bytes);
  assert.ok(memories.length === 1 && memorySection && memories[0].origin === 'defined', 'DWG requires exactly one defined WASM memory.');
  const memory = memories[0];
  assert.ok(memory.flags === 0 || memory.flags === 1, 'DWG requires an unshared wasm32 memory.');
  assert.ok(memory.minPages <= 65536 && (memory.maxPages === null || memory.maxPages <= 65536), 'Invalid wasm32 memory page count.');
  if (memory.minBytes > maxBytes) throw new RangeError(`The DWG WASM initial memory exceeds the ${maxBytes / (1024 * 1024)} MB limit.`);
  const maxPages = Math.min(memory.maxPages ?? maxBytes / WASM_PAGE_BYTES, maxBytes / WASM_PAGE_BYTES);
  const body = [1, 1, ...encodeU32(memory.minPages), ...encodeU32(maxPages)];
  const section = Uint8Array.from([5, ...encodeU32(body.length), ...body]);
  const bounded = new Uint8Array(memorySection.start + section.length + bytes.length - memorySection.end);
  bounded.set(bytes.subarray(0, memorySection.start));
  bounded.set(section, memorySection.start);
  bounded.set(bytes.subarray(memorySection.end), memorySection.start + section.length);
  return bounded;
}
