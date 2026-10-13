# 3D objects in DXF files (format version 1)

How JCad Electrical stores its experimental 3D solids (`DrawingState.model3d`) in a DXF file, how
it reads them back, and what other programs see. Code: `src/io/dxf/mesh3d-write.ts` (writing),
`src/io/dxf/mesh3d-read.ts` (reading), `src/model3d/file-format.ts` (the versioned payload and its
validator). DWG files cannot hold 3D objects in this version (see [the last section](#dwg)).

## Record layout

Each solid is written in the model-space `ENTITIES` section, after the 2D entities and any
retained raw records, as one DXF **polyface mesh**: a `POLYLINE` with flag 64, its mesh vertices,
its face records and a `SEQEND`. This entity exists in every DXF version JCad writes (AC1015 and
later). The records follow the DXF reference polyface layout; they have not been verified in
AutoCAD or other programs. A drawing without solids writes none
of this and no extra `APPID` record: its DXF is byte-identical to the one earlier versions wrote
(guarded by `tests/dxf-3d-identity.test.ts` against golden outputs in `tests/golden/dxf-3d/`).

```
0  POLYLINE                 5  <handle>   330 <model space block record>
100 AcDbEntity              8  <layer>    62 <ACI colour, omitted for ByLayer>
100 AcDbPolyFaceMesh        66 1          10 0  20 0  30 0
70 64                       71 <vertex count>   72 <face count>
1001 JCAD_3D                1000 <payload chunk> ... (see below)
0  VERTEX   5 <h>  330 <POLYLINE handle>  100 AcDbEntity  8 <layer>  [62 <colour>]
            100 AcDbVertex  100 AcDbPolyFaceMeshVertex  10 x  20 y  30 z  70 192   (one per vertex)
0  VERTEX   5 <h>  330 <POLYLINE handle>  100 AcDbEntity  8 <layer>  [62 <colour>]
            100 AcDbFaceRecord  10 0  20 0  30 0  70 128  71 a  72 b  73 c        (one per triangle)
0  SEQEND   5 <h>  330 <POLYLINE handle>  100 AcDbEntity  8 <layer>
```

- Vertices are the solid's mesh vertices in stored order, in world coordinates (WCS), written with
  the shortest decimal text that reads back as the same double and without exponent notation.
  Negative zero is written as `0`.
- Face records are the mesh triangles in stored order, with 1-based vertex numbers, counter-
  clockwise seen from outside. Edges are all visible (no negative numbers); group 74 is not
  written (triangles only).
- Handles follow the writer's single counter; `VERTEX` and `SEQEND` are owned (330) by their
  `POLYLINE`, following the DXF reference's owner rules for sub-entities.
- The `APPID` table gains one record, `JCAD_3D`, when the drawing has at least one solid.
- **Large meshes.** Polyface counts and face vertex numbers are 16-bit DXF integers, so one record
  holds at most 32,767 vertices and 32,767 faces. A larger mesh is cut into several polyface
  records (runs of consecutive triangles, each with the vertices it uses). The first record
  carries the full payload with `"parts": n`; the others carry `{"v":1,"id":...,"part":k,"parts":n}`.
  On reading, the parts are joined and every pair of vertices with exactly the same coordinates is
  merged (the copies made at the cuts, but also coincident vertices the original kept apart): the
  triangles and their geometry are identical, but the vertex count and numbering may change and
  vertices no triangle uses are not stored. Meshes within the limits round-trip exactly.

## XDATA payload (`JCAD_3D`)

The payload is JSON:

```json
{ "v": 1, "id": "e1k2x9q3", "name": "Gland plate", "feature": { "kind": "box", "frame": {...}, "width": 2, "depth": 1, "height": 0.3 } }
```

| Field | Meaning |
| --- | --- |
| `v` | Payload schema version, `MODEL3D_FILE_VERSION` = 1. Required. |
| `id` | The solid's id (`newId()` style: letters, digits, `_ - . :`, at most 64 characters). |
| `name` | Optional user label. |
| `feature` | The construction history, a `Feature3D` (`src/model3d/types.ts`): `box`, `wedge`, `cylinder`, `sphere`, `cone`, `torus`, `extrude`, `revolve`, `boolean` (exactly two operands, nested up to 64 levels) or `mesh` (`source`: `imported` / `edited`). Field names and units are those of the TypeScript types (drawing units, radians, frames as origin plus unit X / Y / Z axes). |
| `parts`, `part` | Only for meshes split into several records (see above). |

Encoding: the JSON is made 7-bit and whitespace-free before it is written (every character
outside `!`..`~`, including spaces, becomes a `\uXXXX` escape, and an escaped backslash becomes
`\` so the reader's `\U+XXXX` decoding never touches it). It is split into `1000` strings of
at most 250 characters (DXF allows 255 bytes per group), directly after `1001 JCAD_3D`.

**Limits.** At most 15,000 characters of payload per record (`MAX_PAYLOAD_BYTES`), chosen to stay
well below the extended-data size other CAD programs are reported to accept per object (not
verified here). A name is kept up to 255 characters without control characters; a longer or
dirty name is cleaned on reading and reported. A solid whose history does not fit is saved with
`"feature": {"kind": "mesh", "source": "edited"}` (and, if even that does not fit, without its
name); the geometry is unaffected, and the Save command logs how many objects were stored that way.

## Reading

- The stored faces are the mesh, exactly. The history is never re-evaluated on load: it records
  how to rebuild the solid when it is edited.
- The payload is validated strictly by a hand-written validator: unknown fields (including
  `__proto__`), unknown feature kinds, non-finite numbers, non-positive sizes, frames whose axes
  are not unit length, pairwise orthogonal and right-handed (z = x × y) within 1e-6
  (`FRAME_TOLERANCE`), a revolve axis of zero length, a cone with two zero radii, a torus whose tube is
  not smaller than its ring, booleans without exactly two operands and nesting beyond 64 levels
  are all rejected. A rejected or unreadable history keeps the solid with
  `{"kind": "mesh", "source": "imported"}` and adds a **simplified** item to the import report
  ("JCad 3D construction history ignored (...)"). A malformed or duplicate id gets a fresh id.
- `v` greater than 1 (a newer JCad): the solid is kept as a mesh (id and name when they look
  valid) and the report gets an **unsupported** item ("written by a newer JCad").
- Polyfaces written by JCad (with `JCAD_3D`) are read whatever the experimental 3D setting is,
  because Save writes them back; with the setting off the report notes that the drawing holds
  3D objects that are kept but not shown. Recovery (autosave) copies are read the same way.
- Polyfaces of other programs (no `JCAD_3D`) become `mesh` solids only when the reader is told
  3D is enabled (`DxfReadOptions.model3d`, the experimental setting): **simplified**, "imported
  polyface mesh: not editable parametrically", plus notes for four-sided faces split into two
  triangles, a mesh that is not closed or not consistently oriented, and true colour / colour
  book / transparency not kept.
  With the setting off they are dropped and reported exactly as before 3D support ("polyface
  meshes are not supported").
- A face naming a vertex the record does not have, a `VERTEX` that is neither a mesh vertex nor a
  face record, a mesh vertex without its 10 / 20 / 30 coordinates, an unreadable number or a
  record without faces drops that record (**dropped**, with the reason). A colour outside 0..256
  (negative or too large) becomes ByLayer and is reported; ACI 0 (ByBlock) is kept. A duplicate
  `1001 JCAD_3D`, a `1000` string over 255 characters, a payload over 15,000 characters, other
  XDATA groups inside the JCad data and `part` / `parts` out of range make the data unreadable
  (mesh kept, reported). Faces with fewer than three distinct vertices (edges) are skipped and
  reported. Other applications' XDATA on the polyface is reported as not kept.
- Polyfaces inside block definitions or on layouts are dropped and reported (3D objects live in
  model space). Polygon meshes (`POLYLINE` flag 16) are dropped and reported.
- Solids read from a file go through the same geometry budget as every drawing state (500,000
  triangles per solid, 2,000,000 in total); a file beyond it fails to open the way an oversized
  2D file does. The DXF reader's own limits usually apply first (next section).

## File size limits (`DXF_READ_LIMITS`)

The DXF reader refuses, by default, a file with more than **2,000,000 group pairs**, more than
**250,000 records** (every `POLYLINE`, `VERTEX` and `SEQEND` is a record) or more than
**134,217,728 characters** (128 MB). These numbers live in one exported constant,
`DXF_READ_LIMITS` in `src/model3d/file-format.ts`, which the reader uses. A polyface costs about
13 group pairs per triangle plus 11 per vertex, so a file holds roughly 100,000 triangles in
total. JCad never writes a file it cannot open again:

- **Save / Save As (DXF)** of a drawing whose solids push the file past a limit is refused:
  nothing is written, `lastFileError` and the log give the triangle count, the limit exceeded
  and "Reduce the 3D model (fewer objects or less mesh detail) and save again"; the drawing stays
  modified. (A 2D-only drawing is not checked here; its behaviour is unchanged.)
- **Autosave** then writes the recovery copy **without the solids** and records their number as
  `omitted3d` in the autosave index; the Drawing Recovery Manager shows it on the row and logs it
  when the copy is opened. The open drawing keeps its solids.
- **EXPORTDWG / DWG Save** never write solids at all (see [DWG](#dwg)).
- Per record, the 16-bit polyface counts (32,767 vertices, 32,767 faces) are not refused: the
  mesh is split into several records (see [Record layout](#record-layout)).

## Limitations

- Meshes split into several records (more than 32,767 vertices or faces) keep their geometry and
  triangle count, but vertex numbering may change and unused vertices are not stored.
- Negative zero is written and read back as `0` (JSON and the coordinate writer have no -0).
- Version 1 rejects unknown fields, so any added field requires a new `v`.
- Solids carry an ACI colour only: true colour, colour book and transparency of imported
  polyfaces are not kept (reported). Polyfaces inside blocks or on layouts are dropped and
  reported. The payload is capped at 15,000 characters per record (larger histories are stored as
  meshes).
- Not verified in AutoCAD or any other program. No edge is marked invisible, so a program that
  draws polyface edges will show every triangle edge.
- Empty solids (no triangles) cannot exist: `newSolid`, `addSolids` and `replaceSolid` throw, and
  the writer refuses one in a hand-made state.

## Version policy

- `MODEL3D_FILE_VERSION` changes whenever the payload or the record layout changes in a way a
  version-1 reader would misread (new feature kinds, new fields, different units). Readers accept
  every version up to their own and refuse newer ones explicitly (mesh kept, history not read,
  reported), never guessing.
- Because version 1 rejects unknown fields, adding even an optional field requires a new version.
- A reader of version N must keep reading versions 1..N-1 (upgrade on load if needed).

## What other programs see

Expected (following the DXF reference; not verified in AutoCAD or other programs): a mesh per
solid on its layer, in its colour (ACI; ByLayer when the solid uses ByLayer), with every triangle
edge visible because no edge is marked invisible. The `JCAD_3D` data is expected to be ignored by programs that do not know it, and is lost if such a program
rewrites the object (JCad then imports the mesh as a foreign polyface). Editing the mesh in
another program while keeping the data makes JCad show the edited mesh with the old history.

## DWG

The portable DWG writer cannot write these records. Saving a drawing with solids as DWG, and
`EXPORTDWG`, are refused with "DWG files cannot hold 3D objects in this version; save as DXF, or enable Experimental 3D (Options > Files) to view or erase them";
nothing is written and no solid is dropped.

Opening a DWG does not go through the DXF reader: LibreDWG's payload is converted by
`convertDwg` in `src/io/dwg.ts`, which has no polyface conversion, so a polyface mesh
(`POLYLINE_PFACE`) is dropped and listed in the import report, whatever the experimental setting
(unit-tested with a synthetic payload in `tests/model3d-dxf.test.ts`; not verified with a DWG
fixture that contains a polyface). The DXF rules above apply to DXF files only.
