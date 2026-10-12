/**
 * The pinned LibreDWG converter handles INSERT but omits its native MINSERT sibling.
 * Both expose the same fields, including row/column counts. Route only that conversion
 * discriminator through INSERT, without changing native pointers or library globals.
 */
export function convertDwgDatabase(instance, data, objectTypes) {
  const converter = new Proxy(instance, {
    get(target, key, receiver) {
      if (key === 'dwg_object_get_fixedtype') return (object) => {
        const type = target.dwg_object_get_fixedtype(object);
        return type === objectTypes.DWG_TYPE_MINSERT ? objectTypes.DWG_TYPE_INSERT : type;
      };
      return Reflect.get(target, key, receiver);
    },
  });
  return converter.convert(data);
}
