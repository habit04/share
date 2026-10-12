import type { DwgDatabase, LibreDwgEx, Dwg_Data_Ptr, Dwg_Object_Type } from '@mlightcad/libredwg-web';
export function convertDwgDatabase(instance: LibreDwgEx, data: Dwg_Data_Ptr, objectTypes: Pick<typeof Dwg_Object_Type, 'DWG_TYPE_INSERT' | 'DWG_TYPE_MINSERT'>): DwgDatabase;
