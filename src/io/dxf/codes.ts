/**
 * DXF tables shared by the reader and the writer: the XDATA application names JCad writes and
 * recognises, the dimension type numbers of DIMENSION group 70 and the group-code classes the
 * reader checks values against.
 */
import type { DimensionEntity } from '../../core/entities';
import { DIM_VARIABLES } from '../../core/dimension';

/** AcadAnnotative xdata: marks an annotative object (Track E; AutoCAD 2008+ reads it, older readers ignore it). */
export const ANNO_APP = 'AcadAnnotative';



export const DIM_TYPE: Record<DimensionEntity['kind'], number> = { linear: 0, aligned: 1, angular: 5, diameter: 3, radius: 4 };

// ---------------------------------------------------------------- dimension styles

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

// ---------------------------------------------------------------- SPLINE / HATCH / LEADER / IMAGE / TABLE writers

/** XDATA application name carrying a JCad table's data on its INSERT. */
export const TABLE_APP = 'JCAD_TABLE';

/**
 * XDATA application name carrying an MTEXT's column definition (JSON in 1000 chunks): AC1015 has
 * no MTEXT columns, so JCad keeps them here and other programs show one column.
 */
export const MTEXT_COLUMNS_APP = 'JCAD_MTEXT_COLUMNS';
/** Disabled MTEXT mask settings that cannot be written as native fill groups in AutoCAD. */
export const MTEXT_BACKGROUND_APP = 'JCAD_MTEXT_BACKGROUND';

/**
 * XDATA application on the polyface mesh of each experimental 3D solid: the solid's id, name and
 * construction history as versioned JSON in 1000 chunks (src/model3d/file-format.ts,
 * docs/3D-FILE-FORMAT.md). Other programs are expected to show the polyface mesh and ignore the
 * data (not verified).
 */
export const MODEL3D_APP = 'JCAD_3D';

/** Real-valued group codes (points, distances, angles, scales): unreadable values there are invalid geometry. */
export const isRealCode = (code: number): boolean => (code >= 10 && code <= 59) || (code >= 110 && code <= 149) || (code >= 210 && code <= 239) || (code >= 1010 && code <= 1059);

export const isIntCode = (code: number): boolean => (code >= 60 && code <= 99) || (code >= 160 && code <= 179) || (code >= 270 && code <= 299) || (code >= 370 && code <= 389) || (code >= 400 && code <= 409) || (code >= 420 && code <= 429) || (code >= 440 && code <= 459) || (code >= 1060 && code <= 1071);

export const isRealText = (value: string): boolean => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim());

export const PRECISION_CODES: Readonly<Record<number, string>> = { 171: 'DIMALTD', 179: 'DIMADEC', 271: 'DIMDEC', 272: 'DIMTDEC' };

export const PRECISION_NAMES = new Set(['DIMDEC', 'DIMADEC', 'DIMALTD', 'DIMTDEC', 'LUPREC', 'AUPREC']);

export const UNSUPPORTED_DIM_CODES: Readonly<Record<number, string>> = { 49: 'DIMFXL', 79: 'DIMAZIN', 145: 'DIMTVP', 148: 'DIMALTRND', 175: 'DIMSOXD', 274: 'DIMALTTD', 275: 'DIMAUNIT', 276: 'DIMFRAC', 279: 'DIMTMOVE', 283: 'DIMTOLJ', 285: 'DIMALTZ', 286: 'DIMALTTZ', 288: 'DIMUPT', 290: 'DIMFXLON', 341: 'DIMLDRBLK' };

export const SUPPORTED_DIM_NAMES = new Set([...DIM_VARIABLES.map((v) => v.name), 'DIMSTYLE', 'DIMTOL', 'DIMLIM', 'DIMTIH', 'DIMTOH', 'DIMZIN', 'DIMSAH', 'DIMBLK']);

/** Applications whose data the reader models; other applications are reported as losses. */
export const isQuietXdataApp = (app: string, ownerKind?: string): boolean => app === DIMSTYLE_APP || app === TABLE_APP || app === MTEXT_COLUMNS_APP || (app === MTEXT_BACKGROUND_APP && ownerKind === 'MTEXT') || app === ANNO_APP;

/** Pointer groups that refer to other objects (dropped from raw records: those objects are not kept). */
export const isPointerCode = (code: number): boolean => code === 5 || code === 105 || (code >= 320 && code <= 369) || (code >= 390 && code <= 399) || (code >= 480 && code <= 481) || code === 67;
