/**
 * DXF tables shared by the reader and the writer: the XDATA application names JCad writes and
 * recognises, the dimension type numbers of DIMENSION group 70 and the group-code classes the
 * reader checks values against.
 */
import type { DimensionEntity } from '../../core/entities';

/** AcadAnnotative xdata: marks an annotative object (Track E; AutoCAD 2008+ reads it, older readers ignore it). */
export const ANNO_APP = 'AcadAnnotative';

/** DIMENSION group 70: the type number of each dimension kind (the writer adds the flag bits 32 and 128). */
export const DIM_TYPE: Record<DimensionEntity['kind'], number> = { linear: 0, aligned: 1, angular: 5, diameter: 3, radius: 4 };

/**
 * XDATA application on DIMSTYLE table records. Real DIMSTYLE records reference arrowhead
 * blocks by BLOCK_RECORD handle (342 DIMBLK, 343 DIMBLK1, 344 DIMBLK2), which would need an
 * arrow block definition per type; instead each record written here carries 1000-string
 * name/value pairs under this application:
 *   DIMBLK1 <block>, DIMBLK2 <block>  standard arrow block names ("." = closed filled)
 *   TOLERANCE basic                   boxed basic dimensions (no DIM* variable of its own)
 *   ALTPLACEMENT below                alternate units under the primary value
 * Other programs ignore it. The current style's arrows also go to $DIMBLK / $DIMBLK1 /
 * $DIMBLK2 / $DIMSAH in the header, and the reader resolves 342-344 handles of records
 * written by other programs through the BLOCK_RECORD names.
 */
export const DIMSTYLE_APP = 'JCAD_DIMSTYLE';

/** XDATA application name carrying a JCad table's data on its INSERT. */
export const TABLE_APP = 'JCAD_TABLE';

/** Real-valued group codes (points, distances, angles, scales): unreadable values there are invalid geometry. */
export const isRealCode = (code: number): boolean => (code >= 10 && code <= 59) || (code >= 110 && code <= 149) || (code >= 210 && code <= 239) || (code >= 1010 && code <= 1059);

/** Pointer groups that refer to other objects (dropped from raw records: those objects are not kept). */
export const isPointerCode = (code: number): boolean => code === 5 || code === 105 || (code >= 320 && code <= 369) || (code >= 390 && code <= 399) || (code >= 480 && code <= 481) || code === 67;
