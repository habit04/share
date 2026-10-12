/** Bounded, acknowledgement-driven transport between JCad and its isolated DWG reader. */
const PROTOCOL_VERSION = 1;
const DWG_PROTOCOL_VERSION = PROTOCOL_VERSION;
const MAX_DWG_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_DWG_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MAX_DWG_CHUNK_BYTES = 1024 * 1024;
const MAX_DWG_MESSAGE_CHARS = 1024;
const WORKER_RESOURCE_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 });
const MAX_METADATA_NODES = 2_000_000;
const MAX_METADATA_DEPTH = 64;
const MAX_STRING_CHARS = 1024 * 1024;
const MAX_TOTAL_STRING_CHARS = 64 * 1024 * 1024;
const MAX_DWG_RECORDS = 250_000;

function validRequestId(id) { return Number.isSafeInteger(id) && id > 0; }
function validByteLength(bytes, maximum) { return Number.isSafeInteger(bytes) && bytes > 0 && bytes <= maximum; }
function validOffset(offset, byteLength) { return Number.isSafeInteger(offset) && offset >= 0 && offset <= byteLength; }

/**
 * No caller can raise the isolated worker's production heap or stack limits.
 * @param {Record<string, number>} input
 * @returns {Record<string, number>}
 */
function validateResourceLimits(input = WORKER_RESOURCE_LIMITS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid DWG worker resource limits.');
  const limits = /** @type {Record<string, number>} */ ({});
  const constraints = /** @type {Array<[string, number]>} */ ([['maxOldGenerationSizeMb', 16], ['maxYoungGenerationSizeMb', 1], ['stackSizeMb', 1]]);
  for (const [key, minimum] of constraints) {
    const value = input[key] === undefined ? WORKER_RESOURCE_LIMITS[key] : input[key];
    if (!Number.isSafeInteger(value) || value < minimum || value > WORKER_RESOURCE_LIMITS[key]) throw new Error('Invalid DWG worker resource limits.');
    limits[key] = value;
  }
  if (Object.keys(input).some((key) => !Object.hasOwn(WORKER_RESOURCE_LIMITS, key))) throw new Error('Invalid DWG worker resource limits.');
  return limits;
}

/** Require an exact contiguous, bounded byte chunk, including the final partial chunk. */
function validateChunk(bytes, offset, expectedOffset, byteLength) {
  if (!(bytes instanceof Uint8Array) || !validOffset(offset, byteLength) || offset !== expectedOffset ||
      !validByteLength(bytes.byteLength, MAX_DWG_CHUNK_BYTES) || bytes.byteLength > byteLength - offset) throw new Error('Invalid DWG reader byte chunk.');
  return offset + bytes.byteLength;
}

/** Never transfer an unbounded exception string or native diagnostic to the main process. */
function boundedErrorMessage(error) { return String(error?.message ?? error ?? 'The DWG reader failed.').slice(0, MAX_DWG_MESSAGE_CHARS); }

/**
 * Validate before serialization/IPC, using the renderer's import budgets. Traversal is
 * depth-bounded and builds no unbounded Object.values array. Names count toward string
 * budgets too. Sparse arrays cannot hide an excessive later iteration budget.
 */
function validateDwgPayload(payload, version = '') {
  const isPlain = (value) => value && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  if (!isPlain(payload) || typeof version !== 'string') throw new Error('Invalid DWG reader result.');
  let nodes = 0, stringChars = 0;
  const ancestors = new WeakSet();
  const string = (value) => {
    if (value.length > MAX_STRING_CHARS) throw new Error('DWG value exceeds the import string length limit (1048576).');
    if ((stringChars += value.length) > MAX_TOTAL_STRING_CHARS) throw new Error('DWG strings exceed the total import size limit.');
  };
  const visit = (value, depth) => {
    if (++nodes > MAX_METADATA_NODES) throw new Error('DWG metadata exceeds the import allocation budget.');
    if (depth > MAX_METADATA_DEPTH) throw new Error('DWG metadata nesting exceeds the import limit.');
    if (typeof value === 'string') { string(value); return; }
    if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return;
    // Native 64-bit XDATA integers can exceed Number's precise range. Keep their identity,
    // while refusing huge arbitrary-precision values that could amplify serialization.
    if (typeof value === 'bigint') {
      if (value < -(1n << 63n) || value > (1n << 64n) - 1n) throw new Error('DWG integer exceeds the native 64-bit metadata limit.');
      return;
    }
    // Native binary XDATA is exposed as Uint8Array. Preserve it, counting each byte just as
    // the renderer's Object.values metadata guard would, without constructing that array.
    if (value instanceof Uint8Array) {
      if ((nodes += value.byteLength) > MAX_METADATA_NODES) throw new Error('DWG metadata exceeds the import allocation budget.');
      return;
    }
    const array = Array.isArray(value);
    if ((!array && !isPlain(value)) || (array && (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_METADATA_NODES))) throw new Error('DWG reader result contains unsupported metadata.');
    if (ancestors.has(value)) throw new Error('DWG reader result contains cyclic metadata.');
    if (Object.getOwnPropertySymbols(value).length) throw new Error('DWG reader result contains unsupported metadata.');
    ancestors.add(value);
    let arrayEntries = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (array && String(Number(key)) === key && Number.isInteger(Number(key)) && Number(key) >= 0 && Number(key) < value.length) arrayEntries++;
      string(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('DWG reader result contains unsupported metadata.');
      visit(descriptor.value, depth + 1);
    }
    // Object.values omits holes. Count them too, so many sparse arrays cannot conceal
    // millions of later converter iterations in a tiny serialized payload.
    if (array && (nodes += value.length - arrayEntries) > MAX_METADATA_NODES) throw new Error('DWG metadata exceeds the import allocation budget.');
    ancestors.delete(value);
  };
  visit(payload, 0);
  string(version);
  let records = 0;
  const countRecords = (value, required = false) => {
    if (value === undefined && !required) return;
    if (!Array.isArray(value)) throw new Error('Invalid DWG reader record list.');
    records += value.length;
    if (records > MAX_DWG_RECORDS) throw new Error('DWG exceeds the import record limit (250000).');
  };
  for (const key of ['entities', 'layers', 'blocks']) countRecords(payload[key], true);
  for (const block of payload.blocks) {
    if (!isPlain(block)) throw new Error('Invalid DWG reader block.');
    countRecords(block.entities, true);
  }
  for (const key of ['imageDefs', 'styles', 'dimStyles', 'linetypes', 'layouts']) countRecords(payload[key]);
}

module.exports = { PROTOCOL_VERSION, DWG_PROTOCOL_VERSION, MAX_DWG_INPUT_BYTES, MAX_DWG_PAYLOAD_BYTES, MAX_DWG_CHUNK_BYTES,
  MAX_DWG_MESSAGE_CHARS, WORKER_RESOURCE_LIMITS, MAX_METADATA_NODES, MAX_METADATA_DEPTH,
  MAX_STRING_CHARS, MAX_TOTAL_STRING_CHARS, MAX_DWG_RECORDS, validRequestId, validByteLength,
  validOffset, validateResourceLimits, validateChunk, boundedErrorMessage, validateDwgPayload };
