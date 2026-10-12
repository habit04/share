/** Retain the CMC fields discarded by the pinned converter's MTEXT RGB-only projection. */
export function convertDwgMTextDatabase(instance, data, convert = (reader, input) => reader.convert(input)) {
  const commonEntities = new Map();
  const backgrounds = new Map();
  let currentObject;
  const reader = new Proxy(instance, {
    get(target, key, receiver) {
      if (key === 'dwg_object_to_entity') return (object) => {
        currentObject = object;
        return target.dwg_object_to_entity(object);
      };
      if (key === 'dwg_object_to_entity_tio') return (object) => {
        const tio = target.dwg_object_to_entity_tio(object);
        if (tio && object === currentObject) {
          if (!commonEntities.has(tio) && commonEntities.size >= 250_000) throw new RangeError('DWG entity metadata exceeds the safe conversion budget.');
          commonEntities.set(tio, target.dwg_object_to_entity(object));
        }
        return tio;
      };
      if (key === 'dwg_dynapi_entity_data') return (...args) => {
        const value = target.dwg_dynapi_entity_data(...args);
        if (args[1] === 'bg_fill_color' && value && typeof value === 'object') {
          const common = commonEntities.get(args[0]);
          if (common) {
            const handle = target.dwg_object_entity_get_handle_object(common)?.value;
            if (handle !== undefined) {
              const color = {};
              for (const field of ['index', 'rgb', 'method']) if (Number.isFinite(value[field])) color[field] = value[field];
              if (typeof value.name === 'string') color.name = value.name;
              if (typeof value.book_name === 'string') color.bookName = value.book_name;
              backgrounds.set(handle.toString(16).toUpperCase(), color);
            }
          }
        }
        return value;
      };
      return Reflect.get(target, key, receiver);
    },
  });
  const database = convert(reader, data);
  const enrich = (entities) => {
    for (const entity of entities ?? []) {
      if (entity.type !== 'MTEXT') continue;
      const background = backgrounds.get(String(entity.handle).toUpperCase());
      if (background) entity.backgroundFillColorData = background;
    }
  };
  enrich(database.entities);
  for (const block of database.blocks ?? []) enrich(block.entities);
  for (const block of database.tables?.BLOCK_RECORD?.entries ?? []) enrich(block.entities);
  return database;
}
