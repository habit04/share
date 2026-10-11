/**
 * DXF (AC1015 / AutoCAD 2000) reader and writer.
 * Entities: LINE, CIRCLE, ARC, LWPOLYLINE (bulges, constant width), POLYLINE,
 * TEXT, MTEXT, INSERT (+ ATTRIB), ELLIPSE, POINT, XLINE, RAY, SOLID/TRACE,
 * DIMENSION (with its anonymous *D block), SPLINE, HATCH (pattern definition lines),
 * LEADER (+ its MTEXT) and MULTILEADER, IMAGE (+ IMAGEDEF), ACAD_TABLE (cell data) and
 * external-reference blocks; fields in TEXT / MTEXT. Tables: LAYER (linetype, lineweight,
 * frozen/off/locked), LTYPE (dash patterns), VIEW, DIMSTYLE, BLOCK_RECORD.
 * Header: units, limits, LTSCALE, PDMODE/PDSIZE, DIM* variables, CELTYPE/CELWEIGHT.
 *
 * The public entry points; the code lives under io/dxf/ (see the module map in
 * docs/DEVELOPMENT.md): writer.ts and write-*.ts write, reader.ts and read-*.ts read, groups.ts
 * tokenizes, dimstyles.ts holds the DIMSTYLE codec both sides share and codes.ts the shared tables.
 */
export { DIMSTYLE_APP, TABLE_APP } from './dxf/codes';
export { DxfReadError } from './dxf/groups';
export { writeDxf } from './dxf/writer';
export { readDxf, type DxfReadOptions } from './dxf/reader';
export { insertScales, insertScaleFields } from './dxf/read-entities';
