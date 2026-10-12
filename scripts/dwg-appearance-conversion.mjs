/** Preserve both native color-book fields before the pinned converter projects only name. */
function withBookIdentity(color) {
  if (!color || typeof color !== 'object') return color;
  if (color.handle !== undefined && (!Number.isInteger(color.handle) || color.handle < 0 || color.handle > 0xffffffff)) throw new Error('DWG color reference is invalid. Its exact appearance cannot be imported.');
  const referenced = color.handle > 0 || (Number.isInteger(color.flag) && (color.flag & 0x40) !== 0);
  if (referenced && color.referenceResolved !== true) throw new Error('DWG color-book reference could not be resolved. Its exact appearance cannot be imported.');
  if (typeof color.name !== 'string' || !color.name || typeof color.book_name !== 'string' || !color.book_name) return color;
  // The underlying native reader resolves the exact DBCOLOR reference. Never use its
  // fallback ACI index to infer either RGB or a color-book identity.
  return { ...color, name: `${color.book_name}$${color.name}` };
}

export function convertDwgAppearanceDatabase(instance, data, convert = (reader, input) => reader.convert(input)) {
  const reader = new Proxy(instance, {
    get(target, key, receiver) {
      if (key === 'dwg_object_entity_get_color_object') return (entity) => withBookIdentity(target.dwg_object_entity_get_color_object(entity));
      if (key === 'dwg_dynapi_entity_data') return (...args) => {
        const value = target.dwg_dynapi_entity_data(...args);
        // Layer color uses this dynamic CMC accessor. MTEXT backgrounds keep their
        // separate name/book fields for the existing background-specific conversion.
        return args[1] === 'color' ? withBookIdentity(value) : value;
      };
      return Reflect.get(target, key, receiver);
    },
  });
  return convert(reader, data);
}
