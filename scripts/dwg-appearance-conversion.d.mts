import type { DwgDatabase, LibreDwgEx, Dwg_Data_Ptr } from '@mlightcad/libredwg-web';
export function convertDwgAppearanceDatabase(instance: LibreDwgEx, data: Dwg_Data_Ptr, convert?: (reader: LibreDwgEx, input: Dwg_Data_Ptr) => DwgDatabase): DwgDatabase;
