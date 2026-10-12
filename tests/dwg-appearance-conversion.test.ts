import { describe, expect, it } from 'vitest';
import { convertDwgAppearanceDatabase } from '../scripts/dwg-appearance-conversion.mjs';

describe('native DWG color-book projection', () => {
  it('retains the exact resolved entity/layer book identity without mutating native metadata or background fields', () => {
    const color = { index: 151, method: 0xc2, rgb: 0xc2abcdef, name: 'Pearl Δ', book_name: 'Studio Book', alpha_type: 2, alpha: 127, handle: 17, referenceResolved: true };
    const layer = { ...color, rgb: 0xc2123456, name: 'Teal 雷', handle: 0, referenceResolved: false };
    const background = { ...color, name: 'Slate', book_name: 'Other Book' };
    const instance = {
      dwg_object_entity_get_color_object: () => color,
      dwg_dynapi_entity_data: (_pointer: number, field: string) => field === 'color' ? layer : background,
    } as unknown as Parameters<typeof convertDwgAppearanceDatabase>[0];
    convertDwgAppearanceDatabase(instance, 1 as Parameters<typeof convertDwgAppearanceDatabase>[1], (reader) => {
      expect(reader.dwg_object_entity_get_color_object(2 as never)).toEqual({ ...color, name: 'Studio Book$Pearl Δ' });
      expect(reader.dwg_dynapi_entity_data(3 as never, 'color')).toEqual({ ...layer, name: 'Studio Book$Teal 雷' });
      expect(reader.dwg_dynapi_entity_data(3 as never, 'bg_fill_color')).toBe(background);
      return { entities: [] } as unknown as ReturnType<typeof convertDwgAppearanceDatabase>;
    });
    expect(color.name).toBe('Pearl Δ');
    expect(layer.name).toBe('Teal 雷');
  });

  it('does not fabricate a book name or RGB from incomplete projected color fields', () => {
    const colors = [{ index: 151, name: '', book_name: '' }, { index: 3, name: 'Green' }, { index: 4, name: '', book_name: 'Book' }];
    const instance = { dwg_object_entity_get_color_object: (pointer: number) => colors[pointer] } as unknown as Parameters<typeof convertDwgAppearanceDatabase>[0];
    convertDwgAppearanceDatabase(instance, 1 as Parameters<typeof convertDwgAppearanceDatabase>[1], (reader) => {
      for (let index = 0; index < colors.length; index++) expect(reader.dwg_object_entity_get_color_object(index as never)).toBe(colors[index]);
      return { entities: [] } as unknown as ReturnType<typeof convertDwgAppearanceDatabase>;
    });
  });

  it.each([
    { index: 151, flag: 0x40 },
    { index: 151, flag: 0x40, handle: 17, referenceResolved: false },
    { index: 151, handle: 17 },
    { index: 151, handle: -1, referenceResolved: true },
    { index: 151, handle: 0x1_0000_0000, referenceResolved: true },
  ])('refuses unresolved or invalid native references instead of importing their ACI fallback: %j', (color) => {
    const instance = { dwg_object_entity_get_color_object: () => color } as unknown as Parameters<typeof convertDwgAppearanceDatabase>[0];
    expect(() => convertDwgAppearanceDatabase(instance, 1 as Parameters<typeof convertDwgAppearanceDatabase>[1], (reader) => {
      reader.dwg_object_entity_get_color_object(2 as never);
      return { entities: [] } as unknown as ReturnType<typeof convertDwgAppearanceDatabase>;
    })).toThrow(/color.*reference/);
  });
});
