# DXF external-reference loading and refresh core (milestone 20)

Status: **implemented and headless-tested; not wired into the application,
not Windows-validated, not merged or released.** Those are separate states
and none of them is claimed here.

## What the base application (v0.5.2, a68dba5) already does

- A DXF/DWG external reference is a block definition carrying
  `xref: { path, overlay? }` (`src/core/entities.ts`): DXF BLOCK flag 4 =
  external reference, flag 8 = overlay, the path is group 1
  (`src/io/dxf/read-sections.ts`), and the writer writes the same record
  back (`src/io/dxf/writer.ts`). The DWG reader marks xref blocks too,
  but cannot recover their file paths and says so.
- An unloaded reference (block with no entities) draws a dashed named
  frame; EXPLODE refuses external references; xref-dependent LAYER flags
  16/32 round-trip.
- Nothing resolves the stored path or loads the referenced file.
  `docs/SUPPORT-MATRIX.md` states it plainly: "external files are not
  loaded."

Milestone 20 is the missing loader, as a **separately testable core**
(`src/io/xref-loading.ts`). It changes no existing file's behaviour, is
imported by no existing file, and makes no changes to shared drawing
models, codecs, Plot/PDF, fonts, GPU or 3D code. Application wiring
(reader construction, rendering of loaded content, UI) is a later,
separately owned step.

## The core in one paragraph

`stageXrefLoad(input, deps, options)` builds a complete immutable
`XrefSnapshot` — a reference tree plus the distinct parsed files, kept
apart from the host drawing. `XrefStore` holds the last successful
snapshot and swaps it in a single assignment only after a staged
load/refresh fully succeeds (`load` / `refresh`). All file access goes
through the injected `XrefFileReader`; the core performs no I/O, cannot
write, and the reader interface has no write operation, so referenced
files can never be rewritten through this core.

## Inputs and contracts

- **Roots**: either a host `DrawingState` (its recorded xref blocks are
  read with `collectXrefReferences`, verbatim paths and flags) or an
  explicit `XrefReferenceInput[]`.
- **Reader**: `readText(resolvedPath, context) => Promise<string>`.
  Injection *is* the permission boundary: the application supplies a
  reader that only reads what it is allowed to read (approved roots,
  desktop IPC admission, ...). An optional `authorize` callback is
  consulted **before every distinct read**, including nested ones; a
  denial means the reader is never called for that path. Missing files
  are recognised from a Node-style `code: 'ENOENT'` (or a matching
  message); the load `AbortSignal` is passed through to the reader.
- **Parser**: the existing DXF reader (`readDxf`, with the resolved path
  as `filePath`) by default; injectable so the core can be unit-tested
  without the full parser.
- **Outputs**: nodes keep `blockName`, the **verbatim** `originalPath`,
  a separate `resolvedPath`, the `overlay` flag, `depth`, a status, and
  child nodes. Loaded geometry lives only in `snapshot.files`, keyed by
  resolved path, each with its parsed `DrawingState`, UTF-8 byte length,
  entity count and the nested references it records. `externalContent()`
  flattens a snapshot to per-occurrence content with provenance; it does
  **not** apply INSERT placement (position / scale / rotation / block
  base point) — that is application wiring.

## Attach / overlay behaviour

The flag lives on the reference as recorded **in its immediate host**
(DXF BLOCK flags 4/8 in that host's file). Autodesk's help ("About
Nesting and Overlaying Referenced Drawings",
https://help.autodesk.com/cloudhelp/2025/ENU/AutoCAD-MAC-Core/files/GUID-0D7D1315-B58A-4BCD-9953-282FF578B144.htm)
describes the semantics, summarised here in our own words:

- Both attachments and overlays are visible in the drawing that
  references them directly.
- An overlay is **not** carried further: when its immediate host is
  itself referenced by another drawing, the overlay does not appear in
  that other drawing. An attachment **is** carried through.
- A nested reference's relative path is resolved against its **immediate
  host**, not against the drawing that is ultimately open.

The loader implements exactly that, for a load rooted at one host:

- Depth 1 (the root drawing's own references): always loaded, attach or
  overlay.
- Depth ≥ 2 (nested): an **attachment** is carried into the root and
  loaded; an **overlay** is recorded as `not-carried-overlay` — the node
  keeps its verbatim and resolved paths — but its file is not read and
  its own references are not traversed (they could not be carried into
  the root either, through a reference the root never receives).
- A root overlay's **attached** children are still carried and loaded:
  the overlay flag of the root edge affects drawings above the root,
  which are out of scope for this load. (Regression-pinned by
  `tests/xref-loading.test.ts`: host → `OVLROOT` overlay →
  `KID` attach is loaded; parent → `INNER` overlay at depth 2 is not
  read.)

Reference-type changes (attach ↔ overlay), detach, bind and unload are
editing operations on the host drawing; the core performs none of them
and never rewrites the stored path or flag.

## Resolution, cycles, limits, cancellation

- **Paths**: lexical resolution over both `/` and `\` separator styles,
  so Windows paths stored in a DXF resolve identically on any OS.
  Absolute forms (drive letter, UNC, rooted) stand alone; relative
  paths join the containing file's folder and fold `.` / `..` (clamped
  at the root for absolute paths). Resolved paths are canonical
  `/`-separated. The stored path is never modified. Cycle/identity
  comparison is case-insensitive for Windows-style paths and
  case-sensitive otherwise.
- **Cycles**: tracked against the ancestor chain by resolved-path key.
  A repeated ancestor becomes a `cycle` node and a `cycle` failure with
  the full chain (e.g. `a.dxf -> b.dxf -> a.dxf`); it is not read again.
  A file referenced from two unrelated places (a diamond) is read and
  parsed **once** per staged load and shared by both nodes.
- **Failures per node** (recorded, with attempted resolved path):
  `missing`, `denied`, `read-error`, `parse-error`,
  `unsupported-format` (DWG, see below), `unresolved-path` (empty stored
  path), `cycle`, `depth-limit`, `file-limit` (per-file bytes/entities).
- **Limits** (defaults; callers may only set positive integers):
  depth 8, 64 reference nodes, 16 MiB per file, 64 MiB cumulative
  bytes, 200,000 entities per file, 500,000 cumulative entities.
  Per-node limits fail that node; **cumulative limits are fatal**:
  staging aborts with no snapshot, because a half-counted tree cannot be
  distinguished from a complete one.
- **Cancellation**: the `AbortSignal` is checked before the load, before
  and after every read, and between child loads, and is forwarded to
  the reader. Cancellation is fatal: no snapshot, nothing committed.
- **Atomic refresh**: staging never touches the committed snapshot.
  Default `strict` mode: **any** failure discards the staged snapshot;
  the store keeps the last successful snapshot object (same identity,
  same generation) and returns the failures with `committed: false,
  preserved: true`. Only a fully successful staging is swapped in.
  `partial` mode is an explicit opt-in that commits the references that
  did load, with failures recorded inside the snapshot; cancellation
  and cumulative limits still refuse to commit there.

Node statuses correspond roughly to AutoCAD's reference-palette states:
`loaded` ≈ Loaded, `missing` ≈ Not Found, the other failure statuses ≈
Unresolved. No `orphaned` status is produced: a reference whose parent
failed cannot be discovered at all, because discovery requires parsing
the parent — see limitations.

## Tests (headless)

`tests/xref-loading.test.ts` (27 tests) runs against authored fixtures
in `tests/fixtures/xref/` (registered in `tests/fixtures/manifest.json`)
through a fake in-memory reader mapped to a virtual project layout.
Covered: path normalization/resolution (drive, UNC, backslashes,
immediate-host rule), verbatim path/flag collection, nested loading,
nested-overlay non-carriage and root-overlay carriage, geometry
separation and host immutability (including a `writeDxf` check that the
stored path survives untouched), diamond sharing, missing, cycles
(two-file and self), permission denial (reader never called), parse
error, DWG refusal, empty path, every limit, cancellation (before and
between reads), strict-refresh preservation by object identity,
partial mode, and fatal refusal in partial mode.

These are Linux/Node headless unit checks against the **existing** DXF
parser. They are not AutoCAD compatibility evidence.

## Unresolved compatibility requirements / limitations

1. **DWG references are not loaded.** Legacy xref paths usually point
   at `.dwg` files. This core reports them `unsupported-format` without
   reading them. Loading them needs the existing DWG pipeline, whose
   reader works on binary data and does not currently expose an xref
   file's path at all (the block name is substituted, with a note).
   A DWG-capable reader/parse pair for `XrefLoaderDeps` is future work.
2. **No AutoCAD search-path fallback.** Only the saved path (absolute,
   or relative to the immediate host) is tried. AutoCAD additionally
   searches the current drawing's folder variants, project and support
   search paths, and can fall back to the file name alone. Filename-only
   fallback is deliberately absent: silently loading a same-named file
   from another folder would cross the reader's permission boundary.
   Whether to add ordered, reader-scoped search folders is a product
   decision for integration.
3. **No display or editing wiring.** Loaded content is not rendered,
   clipped (XCLIP), faded, or selectable through this core; INSERT
   transforms are not applied; layer names are kept per-file exactly as
   parsed — AutoCAD's `file|layer` dependent-symbol prefixing, layer
   collision merging and VISRETAIN behaviour are integration concerns,
   as are reload notifications / file watching.
4. **Loading is sequential depth-first**, for deterministic limit
   accounting and cancellation. No cross-load cache: every refresh
   re-reads every file. Byte accounting measures a transient UTF-8
   encoding of the reader's string. Large-project performance is
   unmeasured.
5. **Discovery is block-record based**, matching how the base readers
   record xrefs (BLOCK flag 4). References recorded only in DWG
   structures the base DWG reader cannot expose, or in underlay/image
   definitions (IMAGEDEF paths are a separate mechanism), are out of
   scope.
6. **No `orphaned` reporting** (see above), and no attempt to resolve a
   reference whose parent parsed but whose own path points outside what
   the injected reader permits — that is a `denied`/`missing` result by
   design, not something the core works around.

## Pending Windows / application validation (owned by integration)

- A real permission-controlled reader on Windows (Electron/IPC):
  drive-letter, UNC and network paths, junctions, case-insensitive
  identity against the real filesystem, Unicode and spaced names,
  project relocation.
- AutoCAD side-by-side checks of attach/overlay carriage on the
  authored fixture set (and AUDIT / re-export of a host whose
  references were loaded by the application once wiring exists).
- Applying INSERT transforms and block base points to loaded content,
  xref layer prefixing, clipping, and plot/PDF behaviour — all in the
  application milestone that consumes this core, with the support
  matrix updated there (`External references` row: "external files are
  not loaded" remains true of the shipped application until then).
