/** Copied, bounded native DXF projection. Native pointers stay inside one read. */
export const MAX_NATIVE_METADATA_DXF_BYTES = 32 * 1024 * 1024;
export const MAX_NATIVE_METADATA_OBJECTS = 100_000;
const validFlags = (value) => Number.isInteger(value) && value >= 0 && value <= 0x3fff;
const plain = (value) => value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** The complete C projection owns metadata; never use the old borrowed decoders. */
export function metadataGeometryReader(instance) {
  return new Proxy(instance, {
    get(target, key, receiver) {
      if (key === 'dwg_object_entity_get_xdata' || key === 'dwg_object_xrecord_get_xdata') return () => [];
      return Reflect.get(target, key, receiver);
    },
  });
}

function boundedUtf8(value) {
  if (typeof value !== 'string' || value.length > MAX_NATIVE_METADATA_DXF_BYTES) return false;
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > MAX_NATIVE_METADATA_DXF_BYTES) return false;
  }
  return true;
}

/** Validate native copied values before they enter the existing import/IPC budgets. */
export function validateNativeMetadata(value, readError) {
  if (!validFlags(readError) || !plain(value) || value.schemaVersion !== 1 || !boundedUtf8(value.dxf) ||
      !Array.isArray(value.objects) || value.objects.length > MAX_NATIVE_METADATA_OBJECTS ||
      !validFlags(value.writeError) || typeof value.complete !== 'boolean' || !Array.isArray(value.notes) ||
      value.notes.length > 16 || value.notes.some((note) => typeof note !== 'string' || note.length > 1024)) throw new Error('Invalid native metadata projection.');
  const identities = new Set();
  const objects = value.objects.map((object) => {
    if (!plain(object) || typeof object.handle !== 'string' || !/^[1-9A-F][0-9A-F]{0,15}$/.test(object.handle) ||
        identities.has(object.handle) || typeof object.type !== 'string' || !object.type || object.type.length > 256 ||
        typeof object.dxfType !== 'string' || !object.dxfType || object.dxfType.length > 256 ||
        !['entity', 'object', 'unknown'].includes(object.supertype)) throw new Error('Invalid native metadata object inventory.');
    identities.add(object.handle);
    return { handle: object.handle, type: object.type, dxfType: object.dxfType, supertype: object.supertype };
  });
  const notes = [...value.notes];
  if (readError) notes.push(`Native DWG decoder returned compatibility flags ${readError}; metadata is not certified complete.`);
  return { schemaVersion: 1, dxf: value.dxf, objects, readError, writeError: value.writeError,
    complete: value.complete && readError === 0 && value.writeError === 0, notes };
}

/** A native trap discards the module after geometry was copied; do not walk it to free. */
export function projectNativeMetadata(module, pointer, readError) {
  const unavailable = (note) => ({ schemaVersion: 1, dxf: '', objects: [], readError,
    writeError: null, complete: false, notes: [note] });
  if (typeof module?.jcad_dwg_export_metadata !== 'function') return { metadata: unavailable('The native DWG runtime has no checked metadata projection.'), abandon: false };
  let result;
  try { result = module.jcad_dwg_export_metadata(pointer, MAX_NATIVE_METADATA_DXF_BYTES); }
  catch { return { metadata: unavailable('Native DWG metadata projection failed; supported geometry was imported without metadata preservation.'), abandon: true }; }
  try { return { metadata: validateNativeMetadata(result, readError), abandon: false }; }
  catch { return { metadata: unavailable('Native DWG metadata projection returned invalid or oversized data; metadata was not retained.'), abandon: false }; }
}
