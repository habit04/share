/**
 * MEMFS growth guard for the restricted PDF child (milestone 12.4;
 * accounting corrected in review rounds 1–2). The original child checked
 * the output size with a stat AFTER callMain returned — by then the engine
 * had already allocated whatever it allocated. This guard wraps the pinned
 * glue's MEMFS storage paths and refuses an operation BEFORE the
 * allocation/mutation whenever its accounted outcome would exceed the
 * byte budget. The engine then fails that write and the job fails closed;
 * the post-run stat check in the child remains as a backstop, and the
 * WASM declared memory maximum remains the hard physical bound.
 *
 * Audit of the exact pinned glue (qpdf.js, hash-pinned) — every path that
 * assigns retained MEMFS byte storage:
 *   - MEMFS.expandFileStorage — fresh Uint8Array via the doubling rule;
 *   - MEMFS.resizeFileStorage — fresh Uint8Array or null;
 *   - MEMFS.stream_ops.write — TWO fast paths that never reach expand:
 *     canOwn adopts a subarray of the source buffer, and an empty file at
 *     position zero assigns an exact-size buffer.slice; its fall-through
 *     allocates only via expandFileStorage.
 *   Everything else reaches storage through those three: stream_ops.
 *   allocate and node_ops.setattr call MEMFS.expand/resizeFileStorage on
 *   this same object, and FS.writeFile / FS.createDataFile dispatch
 *   through stream_ops.write. (MEMFS.createNode allocates no bytes —
 *   file contents start null — and stream_ops.mmap allocates in WASM
 *   linear memory, which the declared memory maximum bounds, not MEMFS
 *   retained storage.)
 *
 * Accounting is on ACTUAL OUTCOMES, not intentions: each node's charge is
 * re-derived from the storage it retains after every operation — an
 * owned array retains its length; an adopted view retains its whole
 * backing buffer, because the buffer stays alive while the view does.
 * A pinned no-op (resize to the current usedBytes returns before touching
 * capacity) therefore makes NO accounting change and can never mint
 * credit, and if a delegated operation throws, the charge is reconciled
 * to whatever storage actually remains — failures neither leak nor
 * manufacture capacity. The ledger is the sum of per-node retained bytes,
 * so it is nonnegative by construction and shared across all files (the
 * input and output files live in one MEMFS).
 *
 * Round 3 — two dispatch/forecast seams the direct wrappers did not reach:
 *   - CACHED DISPATCH: the pinned createNode (offset 15191) snapshots
 *     MEMFS.stream_ops.write into MEMFS.ops_table.file.stream.write the
 *     first time a node is created, and FS.write (offset 40292)
 *     dispatches through that cached entry (stream.stream_ops.write) for
 *     every file node. The glue factory's static init creates the root
 *     node BEFORE the child installs this guard, so the cache already
 *     holds the original function at install time. The guard therefore
 *     repoints every live ops_table alias that still references the
 *     original write to the guarded wrapper — and fails closed if an
 *     alias cannot be repointed — instead of guarding only the
 *     MEMFS.stream_ops property nobody dispatches through. (msync and
 *     allocate reach storage through dynamic MEMFS.stream_ops.write /
 *     MEMFS.expandFileStorage lookups, so they were already covered.)
 *   - BUFFER SLICE FORECAST: the pinned empty-file fast path assigns
 *     buffer.slice(offset, offset + length). For a Uint8Array that is an
 *     exact-size copy, but a Node Buffer's slice is a view that retains
 *     the source's whole backing buffer. The wrapper now forecasts the
 *     retention without constructing a forecast slice: exact intrinsic
 *     signed/unsigned 8-bit slices copy; native Buffer slices retain their
 *     whole backing. Unsupported/custom methods or species fail closed.
 *     The precheck runs BEFORE allocation or node mutation when
 *     that retained backing exceeds the budget; post-operation
 *     reconciliation alone would have admitted the write and only then
 *     reported the ledger over cap.
 */
'use strict';

const DOUBLING_MAX = 1024 * 1024;

// These references are captured in the trusted one-shot child, before any PDF
// work. The pinned glue writes signed HEAP8 as well as unsigned input views.
const { Buffer: NativeBuffer } = require('node:buffer');
const byteConstructors = [Uint8Array, Int8Array, NativeBuffer];
const bytePrototypes = byteConstructors.map(ctor => ctor.prototype);
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedConstructor = Object.getPrototypeOf(Uint8Array);
const isView = ArrayBuffer.isView;
const descriptor = Object.getOwnPropertyDescriptor;
const prototypeOf = Object.getPrototypeOf;
const apply = Reflect.apply;
/** @returns {never} */
function unavailable() { throw new Error('The restricted PDF engine memory guard is unavailable.'); }
/** @param {object} object @param {PropertyKey} key */
function requiredGetter(object, key) {
  const property = descriptor(object, key);
  if (!property || typeof property.get !== 'function') unavailable();
  return property.get;
}
const bufferGetter = requiredGetter(typedPrototype, 'buffer');
const backingLengthGetter = requiredGetter(ArrayBuffer.prototype, 'byteLength');
const intrinsicRows = [
  ...['slice', 'subarray', 'buffer', 'byteLength', 'byteOffset', 'length'].map(key => [typedPrototype, key]),
  [ArrayBuffer.prototype, 'byteLength'], [typedConstructor, Symbol.species],
  ...bytePrototypes.flatMap(proto => ['constructor', 'slice', 'subarray', 'buffer', 'byteLength', 'byteOffset', 'length'].map(key => [proto, key])),
  ...byteConstructors.flatMap(ctor => [[ctor, Symbol.species], [ctor, 'prototype']]),
].map(([object, key]) => ({ object, key, original: descriptor(object, key) }));
const intrinsicLinks = [...bytePrototypes, ...byteConstructors].map(object => ({ object, original: prototypeOf(object) }));
const ownInputKeys = ['slice', 'subarray', 'constructor', 'buffer', 'byteLength', 'byteOffset', 'length', Symbol.species];
const descriptorKeys = ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'];

/** Nonallocating forecast for only the pinned child\'s intrinsic 8-bit views. */
function trustedByteStorage(input, length) {
  // isView rejects proxies without invoking their traps. Do not look up an
  // input method/constructor/getter before rejecting unknown shapes.
  if (!isView(input)) unavailable();
  const prototype = prototypeOf(input);
  if (!bytePrototypes.includes(prototype)) unavailable();
  if (ownInputKeys.some(key => descriptor(input, key) !== undefined)) unavailable();
  for (const row of intrinsicRows) {
    const current = descriptor(row.object, row.key), original = row.original;
    if (!current || !original) {
      if (current !== original) unavailable();
      continue;
    }
    if (descriptorKeys.some(key => current[key] !== original[key])) unavailable();
  }
  if (intrinsicLinks.some(row => prototypeOf(row.object) !== row.original)) unavailable();
  // Native getters inspect internal slots; no input slice, constructor,
  // species or renderer-supplied callback is called to compute the budget.
  const backing = apply(bufferGetter, input, []);
  if (prototypeOf(backing) !== ArrayBuffer.prototype || descriptor(backing, 'byteLength') !== undefined) unavailable();
  const backingBytes = apply(backingLengthGetter, backing, []);
  return { backingBytes, sliceBytes: prototype === bytePrototypes[2] ? backingBytes : length };
}


/** The capacity expandFileStorage will hold after growing `prev` toward `requested`. */
function grownCapacity(prevCapacity, requested) {
  if (prevCapacity >= requested) return prevCapacity;
  const factor = prevCapacity < DOUBLING_MAX ? 2 : 1.125;
  const grown = Math.max(requested, Math.floor(prevCapacity * factor));
  return prevCapacity !== 0 ? Math.max(grown, 256) : grown;
}

/** Bytes of storage a node's contents actually retain (0 for null / non-array contents). */
function retainedBytes(contents) {
  if (!contents || typeof contents.length !== 'number') return 0;
  const backing = contents.buffer;
  return backing && typeof backing.byteLength === 'number' ? backing.byteLength : contents.length;
}

/**
 * Wrap a MEMFS implementation's storage paths with a shared byte budget.
 * Throws (failing the engine load closed) when the storage functions are
 * not reachable, and throws from inside a storage call — before the
 * allocation — when the budget would be exceeded.
 * @param {{ expandFileStorage: Function, resizeFileStorage: Function,
 *   stream_ops?: { write: Function },
 *   ops_table?: Record<string, { stream?: { write?: Function } } | undefined> }} memfs
 * @param {number} budgetBytes total MEMFS retained-capacity budget across all files
 * @returns {{ reservedBytes: () => number }}
 */
function guardMemfsGrowth(memfs, budgetBytes) {
  if (!memfs || typeof memfs.expandFileStorage !== 'function' || typeof memfs.resizeFileStorage !== 'function') {
    throw new Error('The restricted PDF engine memory guard is unavailable.');
  }
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) {
    throw new Error('The restricted PDF engine memory guard is unavailable.');
  }
  let reserved = 0;
  /** @type {WeakMap<object, number>} what the ledger charges each node */
  const charged = new WeakMap();
  const chargedOf = (node) => charged.get(node) || 0;
  /** Re-derive a node's charge from the storage it actually retains now. */
  const reconcile = (node) => {
    if (!node || typeof node !== 'object') return;
    const now = retainedBytes(node.contents);
    const was = chargedOf(node);
    if (now !== was) { reserved += now - was; charged.set(node, now); }
  };
  /** Refuse BEFORE allocation/mutation when the predicted outcome would exceed the budget. */
  const precheck = (node, predictedRetained) => {
    if (reserved - chargedOf(node) + predictedRetained > budgetBytes) {
      throw new Error('The restricted PDF output exceeds the size limit.');
    }
  };
  const expand = memfs.expandFileStorage;
  const resize = memfs.resizeFileStorage;
  memfs.expandFileStorage = (node, newCapacity) => {
    const prevCapacity = node && node.contents ? node.contents.length : 0;
    precheck(node, grownCapacity(prevCapacity, newCapacity));
    try { return expand(node, newCapacity); } finally { reconcile(node); }
  };
  memfs.resizeFileStorage = (node, newSize) => {
    // The pinned resize returns immediately when usedBytes === newSize,
    // leaving capacity untouched, so a no-op makes NO accounting change;
    // any other resize retains exactly newSize (0 frees the storage).
    const noop = Boolean(node) && node.usedBytes === newSize;
    if (!noop) precheck(node, newSize === 0 ? 0 : newSize);
    try { return resize(node, newSize); } finally { reconcile(node); }
  };
  const ops = memfs.stream_ops;
  if (ops !== undefined && ops !== null) {
    if (typeof ops.write !== 'function') {
      throw new Error('The restricted PDF engine memory guard is unavailable.');
    }
    const write = ops.write;
    const guardedWrite = (stream, buffer, offset, length, position, canOwn) => {
      const node = stream && stream.node;
      if (node && length) {
        const storage = trustedByteStorage(buffer, length);
        // Mirror the pinned write's own branch conditions to predict the
        // allocation BEFORE it happens. Its two fast paths allocate/adopt
        // without calling expandFileStorage; an in-place overwrite
        // (position + length <= usedBytes) retains the same storage; the
        // remaining fall-through allocates only via the guarded expand.
        const fastPath = Boolean(buffer && buffer.subarray && (!node.contents || node.contents.subarray));
        if (fastPath && canOwn) {
          // Adoption retains the source's whole backing buffer, not just
          // the adopted view's length.
          precheck(node, Math.max(storage.backingBytes, length));
        } else if (fastPath && node.usedBytes === 0 && position === 0) {
          // Native signed/unsigned 8-bit slices copy exactly length bytes;
          // native Buffer.slice retains the whole backing. Refuse using
          // those facts BEFORE invoking either slice or the pinned write.
          precheck(node, Math.max(storage.sliceBytes, length));
        }
      }
      try { return write(stream, buffer, offset, length, position, canOwn); } finally { if (node) reconcile(node); }
    };
    ops.write = guardedWrite;
    // Repoint the pinned createNode's cached dispatch aliases (see the
    // header): every file node created before OR after this install
    // dispatches through MEMFS.ops_table.<kind>.stream, whose write was
    // snapshotted from MEMFS.stream_ops.write at first-node creation —
    // in the real child that is the factory's static init, before the
    // guard exists. Aliases pointing at a different function (e.g. the
    // chrdev table) are not MEMFS storage dispatch and are left alone.
    const table = memfs.ops_table;
    if (table && typeof table === 'object') {
      for (const entry of Object.values(table)) {
        const cached = entry && entry.stream;
        if (cached && cached !== ops && cached.write === write) {
          cached.write = guardedWrite;
          if (cached.write !== guardedWrite) {
            // A live alias still reaches the unwrapped original: the
            // bound would be void, so fail the engine load closed.
            throw new Error('The restricted PDF engine memory guard is unavailable.');
          }
        }
      }
    }
  }
  return { reservedBytes: () => reserved };
}

module.exports = { guardMemfsGrowth, grownCapacity };
