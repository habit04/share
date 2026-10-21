import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as vm from 'node:vm';

const require = createRequire(import.meta.url);
const { guardMemfsGrowth, grownCapacity } = require('../electron/restricted-pdf/memfs-guard.cjs') as {
  guardMemfsGrowth(memfs: unknown, budgetBytes: number): { reservedBytes(): number };
  grownCapacity(prevCapacity: number, requested: number): number;
};

interface FakeNode { contents: Uint8Array | null; usedBytes: number }

/**
 * A MEMFS stand-in that mirrors the pinned glue's storage semantics
 * (expand doubles below 1 MiB, grows 1.125x above, 256-byte floor for
 * non-empty files; resize allocates exactly the new size) and counts
 * allocations, so a test can prove the guard throws BEFORE one happens.
 */
function fakeMemfs() {
  const state = { allocations: 0, failExpand: false, failResize: false };
  const memfs = {
    expandFileStorage(node: FakeNode, newCapacity: number) {
      const prev = node.contents ? node.contents.length : 0;
      if (prev >= newCapacity) return;
      if (state.failExpand) { state.failExpand = false; throw new Error('allocator died'); }
      state.allocations += 1;
      // The pinned glue's rule, written out independently of the guard.
      let cap = Math.max(newCapacity, Math.floor(prev * (prev < 1024 * 1024 ? 2 : 1.125)));
      if (prev !== 0) cap = Math.max(cap, 256);
      node.contents = new Uint8Array(cap);
    },
    resizeFileStorage(node: FakeNode, newSize: number) {
      if (node.usedBytes === newSize) return;
      if (state.failResize) { state.failResize = false; throw new Error('allocator died'); }
      state.allocations += 1;
      node.contents = newSize === 0 ? null : new Uint8Array(newSize);
      node.usedBytes = newSize;
    },
  };
  return { memfs, state };
}
const node = (): FakeNode => ({ contents: null, usedBytes: 0 });

describe('MEMFS growth guard (12.4 corrections)', () => {
  it('accounts the capacity the pinned allocator will actually produce', () => {
    expect(grownCapacity(0, 100)).toBe(100); // empty file: exactly the request
    expect(grownCapacity(100, 120)).toBe(256); // doubling + the 256 floor
    expect(grownCapacity(2 * 1024 * 1024, 2 * 1024 * 1024 + 1)).toBe(Math.floor(2 * 1024 * 1024 * 1.125));
    expect(grownCapacity(500, 400)).toBe(500); // no growth, no change
  });

  it('growth within budget delegates and is accounted', () => {
    const { memfs, state } = fakeMemfs();
    const guard = guardMemfsGrowth(memfs, 1024);
    const file = node();
    memfs.expandFileStorage(file, 100);
    expect(state.allocations).toBe(1);
    expect(file.contents).toHaveLength(100);
    expect(guard.reservedBytes()).toBe(100);
    memfs.expandFileStorage(file, 120); // grows to 256 under the pinned rule
    expect(file.contents).toHaveLength(256);
    expect(guard.reservedBytes()).toBe(256);
  });

  it('growth beyond the budget throws BEFORE the allocation happens', () => {
    const { memfs, state } = fakeMemfs();
    guardMemfsGrowth(memfs, 300);
    const file = node();
    memfs.expandFileStorage(file, 100);
    expect(state.allocations).toBe(1);
    // Next growth would produce capacity 256+... exactly: prev 100 -> 256 is
    // within budget; a further expansion to 512+256 must be refused first.
    memfs.expandFileStorage(file, 120);
    const before = state.allocations;
    expect(() => memfs.expandFileStorage(file, 400)).toThrow(/exceeds the size limit/);
    expect(state.allocations).toBe(before); // the allocator was never called
    expect(file.contents).toHaveLength(256); // storage untouched
  });

  it('the budget is shared across files (input + output in one MEMFS)', () => {
    const { memfs } = fakeMemfs();
    const guard = guardMemfsGrowth(memfs, 512);
    const input = node(), output = node();
    memfs.expandFileStorage(input, 256);
    memfs.expandFileStorage(output, 200);
    expect(guard.reservedBytes()).toBe(456);
    expect(() => memfs.expandFileStorage(output, 300)).toThrow(/exceeds the size limit/);
  });

  it('resize is guarded too, and a shrink credits the budget back', () => {
    const { memfs, state } = fakeMemfs();
    const guard = guardMemfsGrowth(memfs, 512);
    const file = node();
    memfs.resizeFileStorage(file, 400);
    expect(guard.reservedBytes()).toBe(400);
    const before = state.allocations;
    expect(() => memfs.resizeFileStorage(file, 600)).toThrow(/exceeds the size limit/);
    expect(state.allocations).toBe(before);
    memfs.resizeFileStorage(file, 100);
    expect(guard.reservedBytes()).toBe(100);
    memfs.resizeFileStorage(file, 500); // fits again after the credit
    expect(guard.reservedBytes()).toBe(500);
  });

  it('fails closed when the glue growth functions are unreachable', () => {
    expect(() => guardMemfsGrowth(null, 100)).toThrow(/memory guard is unavailable/);
    expect(() => guardMemfsGrowth({}, 100)).toThrow(/memory guard is unavailable/);
    expect(() => guardMemfsGrowth({ expandFileStorage() {}, resizeFileStorage() {} }, 0)).toThrow(/memory guard is unavailable/);
  });

  it('a no-op resize makes no accounting change and never creates credit', () => {
    const { memfs } = fakeMemfs();
    const guard = guardMemfsGrowth(memfs, 300);
    const file = node();
    memfs.resizeFileStorage(file, 120); // contents 120, usedBytes 120
    memfs.expandFileStorage(file, 200); // capacity 256 under the pinned rule; usedBytes stays 120
    expect(file.contents).toHaveLength(256);
    expect(guard.reservedBytes()).toBe(256);
    memfs.resizeFileStorage(file, 120); // pinned no-op: usedBytes already 120
    expect(guard.reservedBytes()).toBe(256); // capacity is still 256, so the charge is too
    memfs.resizeFileStorage(file, 120); // repeated no-ops never create credit
    expect(guard.reservedBytes()).toBe(256);
    const other = node();
    expect(() => memfs.expandFileStorage(other, 300)).toThrow(/exceeds the size limit/);
    expect(other.contents).toBeNull();
  });

  it('a delegated failure before any storage change rolls its reservation back', () => {
    const { memfs, state } = fakeMemfs();
    const guard = guardMemfsGrowth(memfs, 4096);
    const file = node();
    memfs.expandFileStorage(file, 100);
    expect(guard.reservedBytes()).toBe(100);
    state.failExpand = true;
    expect(() => memfs.expandFileStorage(file, 500)).toThrow(/allocator died/);
    expect(file.contents).toHaveLength(100); // storage untouched
    expect(guard.reservedBytes()).toBe(100); // neither leaked nor manufactured
    state.failResize = true;
    expect(() => memfs.resizeFileStorage(file, 40)).toThrow(/allocator died/);
    expect(guard.reservedBytes()).toBe(100);
    memfs.resizeFileStorage(file, 40); // the same operation succeeds once the allocator lives
    expect(guard.reservedBytes()).toBe(40);
  });
});

/**
 * Extract the three storage methods from the EXACT pinned glue (balanced-
 * body scan, the MEMFS write pinned to its independently inspected offset
 * 19897 because the glue contains a second FS write with the same
 * signature) and evaluate them in an isolated VM context — the same
 * technique as the lead's regression probes. A stand-in exposing only
 * expand/resize cannot prove the first-write boundary.
 */
function pinnedMemfs() {
  const glue = fs.readFileSync(new URL('../electron/restricted-pdf/assets/qpdf.js', import.meta.url), 'utf8');
  const body = (signature: string, pinnedOffset?: number): string => {
    const start = glue.indexOf(signature);
    if (start < 0 || (pinnedOffset === undefined ? glue.indexOf(signature, start + signature.length) !== -1 : start !== pinnedOffset)) {
      throw new Error('pinned method signature/offset changed');
    }
    const open = start + signature.length - 1;
    let depth = 0, quote = '', escaped = false;
    for (let i = open; i < glue.length; i += 1) {
      const c = glue[i]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === quote) quote = '';
      } else if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth += 1;
      else if (c === '}' && (depth -= 1) === 0) return glue.slice(open, i + 1);
    }
    throw new Error('unterminated pinned method');
  };
  const context = vm.createContext({ MEMFS: {}, HEAP8: new Uint8Array(1) });
  vm.runInContext(
    'MEMFS.expandFileStorage = function(node,newCapacity)' + body('expandFileStorage(node,newCapacity){') + ';\n'
    + 'MEMFS.resizeFileStorage = function(node,newSize)' + body('resizeFileStorage(node,newSize){') + ';\n'
    + 'MEMFS.stream_ops = { write: function(stream,buffer,offset,length,position,canOwn)'
    + body('write(stream,buffer,offset,length,position,canOwn){', 19897) + ' };',
    context, { timeout: 100 });
  const memfs = (context as { MEMFS: unknown }).MEMFS;
  const run = (statement: string, bindings: Record<string, unknown>): unknown => {
    Object.assign(context, bindings);
    return vm.runInContext(statement, context, { timeout: 100 });
  };
  return { memfs, run };
}

interface PinnedNode { contents: Uint8Array | null; usedBytes: number }
const pinnedNode = (): PinnedNode => ({ contents: null, usedBytes: 0 });

describe('MEMFS guard against the actual pinned glue (12.4 round 2)', () => {
  it('the pinned no-op resize keeps actual capacity charged (no manufactured credit)', () => {
    const { memfs, run } = pinnedMemfs();
    const guard = guardMemfsGrowth(memfs, 300);
    const file = pinnedNode();
    run('MEMFS.expandFileStorage(node,100);MEMFS.expandFileStorage(node,120);node.usedBytes=120;', { node: file });
    expect(file.contents).toHaveLength(256); // expansion slack: capacity 256, used 120
    expect(guard.reservedBytes()).toBe(256);
    run('MEMFS.resizeFileStorage(node,120);', { node: file }); // pinned no-op
    expect(guard.reservedBytes()).toBe(256);
    run('MEMFS.resizeFileStorage(node,120);', { node: file }); // and again
    expect(guard.reservedBytes()).toBe(256);
    const other = pinnedNode();
    expect(() => run('MEMFS.expandFileStorage(other,300);', { other })).toThrow(/exceeds the size limit/);
    expect(other.contents).toBeNull(); // 256 retained + 300 requested cannot fit a 300 budget
    expect(guard.reservedBytes()).toBe(256);
  });

  it('the pinned first write (empty-file slice) is charged; an over-budget one is refused before allocating', () => {
    const over = pinnedMemfs();
    const overGuard = guardMemfsGrowth(over.memfs, 128);
    const bigNode = pinnedNode();
    const big = new Uint8Array(300);
    expect(() => over.run('MEMFS.stream_ops.write({node},input,0,input.length,0,false);', { node: bigNode, input: big }))
      .toThrow(/exceeds the size limit/);
    expect(bigNode.contents).toBeNull(); // refused BEFORE the slice allocated
    expect(overGuard.reservedBytes()).toBe(0);

    const ok = pinnedMemfs();
    const okGuard = guardMemfsGrowth(ok.memfs, 300);
    const smallNode = pinnedNode();
    const small = new Uint8Array(100);
    ok.run('MEMFS.stream_ops.write({node},input,0,input.length,0,false);', { node: smallNode, input: small });
    expect(smallNode.usedBytes).toBe(100);
    expect(smallNode.contents).toHaveLength(100);
    expect(okGuard.reservedBytes()).toBe(100); // an ordinary first write is charged
  });

  it('canOwn adoption charges the retained backing buffer, not the view length', () => {
    const backing = new Uint8Array(500);
    const view = backing.subarray(100, 200); // a 100-byte view; adopting it retains all 500
    const tight = pinnedMemfs();
    guardMemfsGrowth(tight.memfs, 300);
    const tightNode = pinnedNode();
    expect(() => tight.run('MEMFS.stream_ops.write({node},input,0,input.length,0,true);', { node: tightNode, input: view }))
      .toThrow(/exceeds the size limit/);
    expect(tightNode.contents).toBeNull(); // refused before adoption

    const room = pinnedMemfs();
    const roomGuard = guardMemfsGrowth(room.memfs, 600);
    const node = pinnedNode();
    room.run('MEMFS.stream_ops.write({node},input,0,input.length,0,true);', { node, input: view });
    expect(node.contents).toHaveLength(100);
    expect(node.usedBytes).toBe(100);
    expect(roomGuard.reservedBytes()).toBe(500); // the whole backing buffer is retained
  });

  it('a Buffer view slice retains its whole backing: refused over budget, charged honestly within it', () => {
    const backing = new ArrayBuffer(500);
    new Uint8Array(backing).fill(109);
    const snapshot = new Uint8Array(backing.slice(0));
    const input = Buffer.from(backing, 40, 100); // 100-byte view; Buffer.slice retains all 500

    const tight = pinnedMemfs();
    const tightGuard = guardMemfsGrowth(tight.memfs, 300);
    const tightNode = pinnedNode();
    expect(() => tight.run('MEMFS.stream_ops.write({node},input,0,100,0,false);', { node: tightNode, input }))
      .toThrow(/exceeds the size limit/);
    expect(tightNode.contents).toBeNull(); // refused BEFORE the node mutated
    expect(tightNode.usedBytes).toBe(0);
    expect(tightGuard.reservedBytes()).toBe(0);
    expect(new Uint8Array(backing)).toEqual(snapshot); // input backing untouched

    const room = pinnedMemfs();
    const roomGuard = guardMemfsGrowth(room.memfs, 600);
    const node = pinnedNode();
    room.run('MEMFS.stream_ops.write({node},input,0,100,0,false);', { node, input });
    expect(node.usedBytes).toBe(100);
    expect(node.contents!.byteLength).toBe(100); // the view is 100 bytes...
    expect(roomGuard.reservedBytes()).toBe(500); // ...but it retains the whole 500-byte backing
    expect(new Uint8Array(backing)).toEqual(snapshot);
  });

  it('a Uint8Array view slice is a real copy: charged the view size, not the backing', () => {
    const backing = new ArrayBuffer(500);
    new Uint8Array(backing).fill(109);
    const snapshot = new Uint8Array(backing.slice(0));
    const input = new Uint8Array(backing, 40, 100);
    const { memfs, run } = pinnedMemfs();
    const guard = guardMemfsGrowth(memfs, 300);
    const file = pinnedNode();
    run('MEMFS.stream_ops.write({node},input,0,100,0,false);', { node: file, input });
    expect(file.usedBytes).toBe(100);
    expect(file.contents!.buffer.byteLength).toBe(100); // an independent exact-size copy
    expect(guard.reservedBytes()).toBe(100);
    expect(new Uint8Array(backing)).toEqual(snapshot);
  });

  it('multi-file accounting stays accurate across slice, expansion and in-place writes', () => {
    const { memfs, run } = pinnedMemfs();
    const guard = guardMemfsGrowth(memfs, 1024);
    const a = pinnedNode(), b = pinnedNode();
    const write = (n: PinnedNode, size: number, position: number) =>
      run('MEMFS.stream_ops.write({node},input,0,input.length,pos,false);', { node: n, input: new Uint8Array(size), pos: position });
    write(a, 100, 0); // empty-file slice: charged 100
    expect(guard.reservedBytes()).toBe(100);
    write(b, 50, 0); // second file: +50
    expect(guard.reservedBytes()).toBe(150);
    write(a, 40, 100); // append: expand path grows a's capacity 100 -> 256 (doubling, then the 256 floor)
    expect(a.usedBytes).toBe(140);
    expect(guard.reservedBytes()).toBe(306);
    write(a, 40, 10); // in-place overwrite: no storage change
    expect(a.usedBytes).toBe(140);
    expect(guard.reservedBytes()).toBe(306);
  });
});

/**
 * Round 3: the pinned createNode SNAPSHOTS MEMFS.stream_ops.write into
 * MEMFS.ops_table.file.stream.write the first time a node is created, and
 * every file node dispatches through that cached table entry — the glue
 * factory's static init creates the root node before the child installs
 * the guard, so wrapping only the MEMFS.stream_ops property leaves the
 * actual dispatch unguarded. This fixture evaluates the ACTUAL pinned
 * createNode (offset-pinned) with only the FS node identity/type helpers
 * stubbed — the cache operations are the pinned body's own, not mirrored —
 * the same construction as the lead's independent cache-dispatch probe.
 */
function pinnedMemfsWithNodes() {
  const glue = fs.readFileSync(new URL('../electron/restricted-pdf/assets/qpdf.js', import.meta.url), 'utf8');
  const body = (signature: string, pinnedOffset?: number): string => {
    const start = glue.indexOf(signature);
    if (start < 0 || (pinnedOffset !== undefined && start !== pinnedOffset)) {
      throw new Error('pinned method signature/offset changed');
    }
    const open = start + signature.length - 1;
    let depth = 0, quote = '', escaped = false;
    for (let i = open; i < glue.length; i += 1) {
      const c = glue[i]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === quote) quote = '';
      } else if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth += 1;
      else if (c === '}' && (depth -= 1) === 0) return glue.slice(open, i + 1);
    }
    throw new Error('unterminated pinned method');
  };
  const context = vm.createContext({ HEAP8: new Uint8Array(1) });
  vm.runInContext(
    'const FS = {\n'
    + '  isBlkdev: mode => (mode & 61440) === 24576,\n'
    + '  isFIFO: mode => (mode & 61440) === 4096,\n'
    + '  isDir: mode => (mode & 61440) === 16384,\n'
    + '  isFile: mode => (mode & 61440) === 32768,\n'
    + '  isLink: mode => (mode & 61440) === 40960,\n'
    + '  isChrdev: mode => (mode & 61440) === 8192,\n'
    + '  createNode: (parent, name, mode, dev) => ({ parent, name, mode, dev }),\n'
    + '  chrdev_stream_ops: {},\n'
    + '  ErrnoError: class ErrnoError extends Error { constructor(errno) { super("errno " + errno); this.errno = errno; } },\n'
    + '};\n'
    + 'const MEMFS = { node_ops: {}, stream_ops: {}, ops_table: null };\n'
    + 'MEMFS.createNode = function(parent,name,mode,dev)' + body('createNode(parent,name,mode,dev){', 15191) + ';\n'
    + 'MEMFS.expandFileStorage = function(node,newCapacity)' + body('expandFileStorage(node,newCapacity){') + ';\n'
    + 'MEMFS.resizeFileStorage = function(node,newSize)' + body('resizeFileStorage(node,newSize){') + ';\n'
    + 'MEMFS.stream_ops.write = function(stream,buffer,offset,length,position,canOwn)'
    + body('write(stream,buffer,offset,length,position,canOwn){', 19897) + ';\n'
    + 'globalThis.memfs = MEMFS;',
    context, { timeout: 100 });
  const memfs = (context as { memfs: unknown }).memfs;
  const run = (statement: string, bindings: Record<string, unknown>): unknown => {
    Object.assign(context, bindings);
    return vm.runInContext(statement, context, { timeout: 100 });
  };
  return { memfs, run };
}

interface PinnedFileNode extends PinnedNode {
  stream_ops: { write: (stream: unknown, buffer: Uint8Array, offset: number, length: number, position: number, canOwn: boolean) => number };
}

describe('MEMFS guard: cached ops_table dispatch (12.4 round 3)', () => {
  it('repoints a cached ops_table alias of the wrapped write (guard API level)', () => {
    const originalWrite = (stream: { node: FakeNode }, buffer: Uint8Array, offset: number, length: number, _position?: number, _canOwn?: boolean) => {
      stream.node.contents = buffer.slice(offset, offset + length);
      stream.node.usedBytes = length;
      return length;
    };
    const memfs = {
      expandFileStorage() {},
      resizeFileStorage() {},
      stream_ops: { write: originalWrite },
      ops_table: { file: { stream: { write: originalWrite } } },
    };
    const guard = guardMemfsGrowth(memfs, 128);
    const file: FakeNode = { contents: null, usedBytes: 0 };
    expect(() => memfs.ops_table.file.stream.write({ node: file }, new Uint8Array(300), 0, 300, 0, false))
      .toThrow(/exceeds the size limit/);
    expect(file.contents).toBeNull();
    expect(guard.reservedBytes()).toBe(0);
    memfs.ops_table.file.stream.write({ node: file }, new Uint8Array(100), 0, 100, 0, false);
    expect(file.usedBytes).toBe(100);
    expect(guard.reservedBytes()).toBe(100); // in-budget cached dispatch is charged
  });

  it('cache warmed before install: a NEW node refuses cached over-budget writes (slice and adoption)', () => {
    for (const canOwn of [false, true]) {
      const { memfs, run } = pinnedMemfsWithNodes();
      run("MEMFS.createNode(null,'/',16384|511,0);", {}); // factory static-init order: cache first
      const guard = guardMemfsGrowth(memfs, 128);
      const file = run("MEMFS.createNode(null,'after-factory',32768|384,0);", {}) as PinnedFileNode;
      expect(() => run('node.stream_ops.write({node},input,0,input.length,0,canOwn);',
        { node: file, input: new Uint8Array(300), canOwn })).toThrow(/exceeds the size limit/);
      expect(file.contents).toBeNull(); // refused BEFORE mutation through the cached entry
      expect(guard.reservedBytes()).toBe(0);
    }
  });

  it('cache warmed before install: a node created BEFORE install is guarded too', () => {
    const { memfs, run } = pinnedMemfsWithNodes();
    run("MEMFS.createNode(null,'/',16384|511,0);", {});
    const existing = run("MEMFS.createNode(null,'before-install',32768|384,0);", {}) as PinnedFileNode;
    const guard = guardMemfsGrowth(memfs, 128);
    expect(() => run('node.stream_ops.write({node},input,0,input.length,0,false);',
      { node: existing, input: new Uint8Array(300) })).toThrow(/exceeds the size limit/);
    expect(existing.contents).toBeNull();
    expect(guard.reservedBytes()).toBe(0);
  });

  it('cache warmed before install: an in-budget cached write succeeds and is charged', () => {
    const { memfs, run } = pinnedMemfsWithNodes();
    run("MEMFS.createNode(null,'/',16384|511,0);", {});
    const guard = guardMemfsGrowth(memfs, 300);
    const file = run("MEMFS.createNode(null,'normal-cached',32768|384,0);", {}) as PinnedFileNode;
    run('node.stream_ops.write({node},input,0,input.length,0,false);', { node: file, input: new Uint8Array(100) });
    expect(file.usedBytes).toBe(100);
    expect(file.contents).toHaveLength(100);
    expect(guard.reservedBytes()).toBe(100);
  });
});
