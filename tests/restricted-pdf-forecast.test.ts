import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

// Read the actual shipped module, without evaluating the qpdf factory or WASM.
// Each fixture has its own realm so intrinsic observation and refusal controls
// cannot modify the test runner's typed arrays or another test's environment.
const guardSource = readFileSync(new URL('../electron/restricted-pdf/memfs-guard.cjs', import.meta.url), 'utf8');
type Guard = { reservedBytes(): number };
type GuardExports = { guardMemfsGrowth(memfs: object, budget: number): Guard };
interface Result {
  sliceCalls: number;
  allocatedBytes: number;
  delegated: number;
  effects: number;
  error: string;
  used: number;
  nodeUnchanged: boolean;
  reserved: number;
  retained: number;
}

function fixture(budget: number, nativeBuffer = false) {
  const module = { exports: {} as Partial<GuardExports> };
  const context = createContext({ module, require: (name: string) => {
    if (name !== 'node:buffer') throw new Error('Unexpected guard dependency');
    return { Buffer };
  }, ...(nativeBuffer ? { Uint8Array, Int8Array, ArrayBuffer } : {}) });
  const run = (code: string) => runInContext(code, context, { timeout: 100 });
  run(`globalThis.observed = { sliceCalls: 0, allocatedBytes: 0, delegated: 0, effects: 0 };`);
  if (!nativeBuffer) {
    // Install the measurement before trusted module capture. This calls the
    // real intrinsic and counts its actual allocation, including a discarded
    // forecast slice. Custom-input callbacks are installed AFTER capture.
    run(`
      const typed = Object.getPrototypeOf(Uint8Array.prototype);
      const original = Object.getOwnPropertyDescriptor(typed, 'slice');
      const realSlice = original.value;
      Object.defineProperty(typed, 'slice', { ...original, value: function(...args) {
        const result = Reflect.apply(realSlice, this, args);
        observed.sliceCalls++;
        observed.allocatedBytes += result.buffer.byteLength;
        return result;
      }});
    `);
  }
  run(guardSource);
  run(`
    const write = (stream, buffer, offset, length, position, canOwn) => {
      observed.delegated++;
      stream.node.contents = canOwn ? buffer.subarray(offset, offset + length) : buffer.slice(offset, offset + length);
      stream.node.usedBytes = length;
      return length;
    };
    globalThis.memfs = { expandFileStorage(){}, resizeFileStorage(){},
      stream_ops: { write }, ops_table: { file: { stream: { write } } } };
    globalThis.node = { contents: null, usedBytes: 0 };
  `);
  if (typeof module.exports.guardMemfsGrowth !== 'function') throw new Error('Guard export unavailable');
  const guard = module.exports.guardMemfsGrowth(context.memfs as object, budget);
  return {
    run,
    setInput(input: Buffer) { context.input = input; },
    write(): Result {
      let error = '';
      try { run('memfs.ops_table.file.stream.write({node}, input, 0, input.length, 0, false)'); }
      catch (caught) {
        // VM errors have a different realm's Error prototype.
        error = String(caught && typeof caught === 'object' && 'message' in caught ? caught.message : caught);
      }
      const state = run(`({ ...observed, used: node.usedBytes,
        nodeUnchanged: node.contents === null && node.usedBytes === 0,
        retained: node.contents?.buffer.byteLength ?? 0 })`) as Omit<Result, 'error' | 'reserved'>;
      return { ...state, error, reserved: guard.reservedBytes() };
    },
  };
}

describe('restricted PDF nonallocating MEMFS write forecast', () => {
  it.each(['Uint8Array', 'Int8Array'])('refuses over-cap %s before any forecast allocation or delegation', kind => {
    const f = fixture(128);
    f.run(`globalThis.input = new ${kind}(300)`);
    expect(f.write()).toEqual({ sliceCalls: 0, allocatedBytes: 0, delegated: 0, effects: 0,
      error: 'The restricted PDF output exceeds the size limit.', used: 0,
      nodeUnchanged: true, reserved: 0, retained: 0 });
  });

  it.each(['Uint8Array', 'Int8Array'])('makes exactly the delegated copy for supported %s views', kind => {
    const f = fixture(300);
    f.run(`globalThis.input = new ${kind}(new ArrayBuffer(500), 40, 100)`);
    expect(f.write()).toEqual({ sliceCalls: 1, allocatedBytes: 100, delegated: 1, effects: 0,
      error: '', used: 100, nodeUnchanged: false, reserved: 100, retained: 100 });
  });

  it('refuses a native Buffer slice whose whole backing exceeds the budget', () => {
    const f = fixture(300, true);
    f.setInput(Buffer.from(new ArrayBuffer(500), 40, 100));
    expect(f.write()).toEqual({ sliceCalls: 0, allocatedBytes: 0, delegated: 0, effects: 0,
      error: 'The restricted PDF output exceeds the size limit.', used: 0,
      nodeUnchanged: true, reserved: 0, retained: 0 });
  });

  it('charges the whole native Buffer backing when it fits', () => {
    const f = fixture(600, true);
    f.setInput(Buffer.from(new ArrayBuffer(500), 40, 100));
    expect(f.write()).toEqual({ sliceCalls: 0, allocatedBytes: 0, delegated: 1, effects: 0,
      error: '', used: 100, nodeUnchanged: false, reserved: 500, retained: 500 });
  });

  it.each(['slice', 'constructor', 'species'])('refuses custom %s without invoking supplied code', kind => {
    const f = fixture(300);
    f.run('globalThis.input = new Uint8Array(100)');
    if (kind === 'slice') f.run(`Object.defineProperty(input, 'slice', {get(){observed.effects++;return Uint8Array.prototype.slice;}})`);
    if (kind === 'constructor') f.run(`Object.defineProperty(input, 'constructor', {get(){observed.effects++;return Uint8Array;}})`);
    if (kind === 'species') f.run(`Object.defineProperty(Uint8Array, Symbol.species, {get(){observed.effects++;return Uint8Array;},configurable:true})`);
    expect(f.write()).toEqual({ sliceCalls: 0, allocatedBytes: 0, delegated: 0, effects: 0,
      error: 'The restricted PDF engine memory guard is unavailable.', used: 0,
      nodeUnchanged: true, reserved: 0, retained: 0 });
  });
});
