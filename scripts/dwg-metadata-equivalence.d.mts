export class DwgMetadataEquivalenceError extends Error {}
export function verifyDwgMetadataEquivalence(sourceDxf: string, targetDxf: string, targetInventory?: readonly {handle:string;type:string;dxfType:string}[]): {
  schemaVersion: 1;
  objects: number;
  views: number;
  metadataOwners: number;
  headerVariables: number;
};
