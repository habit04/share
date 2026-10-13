/**
 * Checked native read shared by Node and the browser worker. The pinned facade returns an
 * allocated Dwg_Data pointer even for INVALIDDWG; pointer truthiness alone is not success.
 * include/dwg.h marks flags >=128 critical. Preserve lesser compatibility warnings.
 */
export const DWG_CRITICAL_ERROR = 128;
const OUT_OF_MEMORY = 8192;
const KNOWN_ERROR_FLAGS = 0x3fff;
const validPointer = (value) => Number.isInteger(value) && value > 0 && value <= 0xffffffff;

/**
 * Returns ownership of a successful pointer; frees/abandons a failed pointer itself.
 * @param {import('./dwg-native-read.mjs').NativeDwgModule} module
 * @param {Uint8Array | ArrayBuffer} input
 * @param {'dwg' | 'dxf'} [kind]
 * @param {(error: number) => void} [onReadStatus]
 * @returns {number}
 */
export function readNativeDwg(module, input, kind = 'dwg', onReadStatus) {
  if (kind !== 'dwg' && kind !== 'dxf') throw new Error('Unsupported native drawing kind.');
  if (!(input instanceof Uint8Array) && !(input instanceof ArrayBuffer)) throw new TypeError('Native drawing input must be bytes.');
  // The current pinned factory deliberately does not bind dxf_read_file. Normal app DXF
  // opens use the JS DXF reader. Do not misroute a requested native DXF read to DWG.
  if (kind === 'dxf' && typeof module.dxf_read_file !== 'function') throw new Error('This native DWG runtime does not expose DXF reading.');
  const path = `/jcad-input.${kind}`;
  let pointer;
  let flags;
  let failed = false;
  let failure;
  try {
    module.FS.writeFile(path, input instanceof Uint8Array ? input : new Uint8Array(input));
    const result = kind === 'dwg' ? module.dwg_read_file(path) : module.dxf_read_file(path);
    pointer = result?.data;
    flags = result?.error;
    if (!Number.isInteger(flags) || flags < 0 || flags > KNOWN_ERROR_FLAGS) throw new Error('LibreDWG returned invalid native error flags.');
    if (flags & OUT_OF_MEMORY) throw new Error('Failed to decode DWG: out of WASM memory. Use a smaller file.');
    if (flags >= DWG_CRITICAL_ERROR || !validPointer(pointer)) throw new Error(`LibreDWG could not read this file (native error ${flags}; unsupported version or corrupt data).`);
    if (flags) console.warn('Open dwg file with error code:', flags);
    onReadStatus?.(flags);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      if (module.FS.analyzePath(path, false).exists) module.FS.unlink(path);
    } catch (error) {
      // A failed unlink must not leak a pointer whose ownership never reached the caller.
      if (!failed) failure = error;
      failed = true;
    }
    if (failed && validPointer(pointer)) {
      try {
        if (Number.isInteger(flags) && flags >= 0 && flags <= KNOWN_ERROR_FLAGS && (flags & OUT_OF_MEMORY)) module.dwg_abandon(pointer);
        else module.dwg_free(pointer);
      } catch (error) {
        failure = new AggregateError([failure, error], failure instanceof Error ? failure.message : String(failure));
      }
    }
  }
  if (failed) throw failure;
  return pointer;
}
