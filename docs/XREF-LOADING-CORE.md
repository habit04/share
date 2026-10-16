# DXF external-reference loading and refresh core (milestone 20, corrected 20.1)

Status: **implemented and headless-tested as a backend candidate; not
wired into the application, not Windows-validated, not natively
validated, not merged or released.** Those are separate milestones and
none of them is claimed here. Priority 20 is not complete.

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

This milestone is the missing loader, as a **separately testable core**
(`src/io/xref-loading.ts`). It changes no existing file's behaviour, is
imported by no existing file, and makes no changes to shared drawing
models, codecs, Plot/PDF, fonts, GPU or 3D code. Application wiring
(reader construction, rendering of loaded content, UI) is a later,
separately owned step.

## The core in one paragraph

`stageXrefLoad(input, deps, options)` builds a complete `XrefSnapshot` —
a reference tree plus the distinct parsed files, kept apart from the
host drawing. `XrefStore` holds the last successful snapshot and
publishes a staged snapshot only under the publication guard below.
All file access goes through the injected adapter (`XrefFileReader`);
the core performs no I/O, cannot write, and the adapter interface has
no write operation, so referenced files can never be rewritten through
this core. Snapshots handed out by the core are deep copies sealed with
the existing immutable-data helper (`src/core/immutable-data.ts`).

## Identity, locations and resolution (20.1)

Lexical path handling reuses the renderer's existing helpers
(`src/app/paths.ts`: `normalizePath`, `pathKey`, `resolveFromFile`,
`isAbsolutePath`). Lexical results only *locate a candidate* for the
adapter. They are **not** file identity and **not** authorization:

- Before any read of a file, the adapter's `identify(resolvedPath, ctx)`
  step may supply a stable canonical **identity** (`id`), a stable
  **owning location** (the absolute location child references resolve
  against — which may differ from the requested spelling, e.g. through
  a link or alias), and optional **version** evidence.
- Sharing, cycle detection and the snapshot's file keys are keyed by
  that identity (`id:<id>`). Two spellings with one identity are read
  once and shared, with every occurrence's context (block name, verbatim
  path, resolved path, depth) retained on the file record. Two files
  whose spellings merely *look* alike (case-colliding Windows names)
  with distinct identities are read and kept separately.
- If `identify` returns null or an unusable location, the node is
  diagnosed `unresolved-location` **before** any read.
- The same identity reporting two different versions inside one load is
  refused per-node as `inconsistent-version`: a snapshot never mixes
  two contents of one file.
- Ancestry is **seeded with the host identity** (from
  `input.hostIdentity`, or by identifying `hostPath` when the adapter
  offers it), and root references resolve against the host's owning
  location. A reference back to the host — by any spelling the adapter
  identifies as the host — is cut as a `cycle` on its first edge and is
  never read as external geometry.
- When the adapter supplies no `identify`, identity falls back to the
  lexical path key (`path:<pathKey>`). That fallback cannot detect
  aliases or case-collisions; it is a documented weakening, not a
  guarantee, and native alias evidence remains pending.
- Ambiguous anchors are diagnosed, never guessed: a relative reference
  with no anchored containing location, and drive-relative paths
  (`C:leaf.dxf`, whose meaning depends on a per-drive working
  directory) in either the reference or its container, are
  `unresolved-path` and are not sent to the reader.

The original reference path and the attach/overlay flag are preserved
verbatim on every node; resolution and identity live in separate
fields.

## Attach / overlay behaviour (provisional policy)

The flag lives on the reference as recorded **in its immediate host**
(DXF BLOCK flags 4/8 in that host's file). The unit policy below follows
Autodesk's published description of nesting and overlaying referenced
drawings ("About Nesting and Overlaying Referenced Drawings",
https://help.autodesk.com/cloudhelp/2025/ENU/AutoCAD-MAC-Core/files/GUID-0D7D1315-B58A-4BCD-9953-282FF578B144.htm),
summarised in our own words. **This policy is provisional: native /
AutoCAD confirmation is PENDING**, and the wording here does not claim
full parity with any specific AutoCAD version.

- Both attachments and overlays are visible in the drawing that
  references them directly.
- An overlay is not carried further: when its immediate host is itself
  referenced by another drawing, the overlay does not appear in that
  other drawing. An attachment is carried through.
- A nested reference's relative path is resolved against its immediate
  host, not against the drawing that is ultimately open.

Loader policy for a load rooted at one host:

- Depth 1 (the root drawing's own references): always loaded, attach or
  overlay.
- Depth ≥ 2 (nested): an attachment is carried into the root and
  loaded; an overlay is recorded as `not-carried-overlay` — verbatim
  and resolved paths kept — but its file is not read and its own
  references are not traversed.
- A root overlay's attached children are still carried and loaded: the
  overlay flag of the root edge affects drawings above the root, which
  are out of scope for this load.

Reference-type changes (attach ↔ overlay), detach, bind and unload are
editing operations on the host drawing; the core performs none of them.

## Accounting: edges, files, bytes, entities (20.1)

Checks run in a fixed order per node, and the first two steps run
**before every early return** (empty path, suppressed overlay, cycle,
depth, DWG refusal):

1. Cancellation is checked; the declaration-edge counter is incremented
   and the edge budget (`maxReferences`) enforced — fatally. **Every**
   declaration edge counts: loaded, failed, suppressed, duplicate and
   cyclic edges alike.
2. Path/anchor diagnosis, overlay suppression, depth and format checks.
3. Adapter identification (before authorization and reading), cycle
   check by identity, version-consistency check.
4. The distinct-file budget (`maxFiles`) is enforced before a read of a
   new file — fatally.
5. Authorization gate (optional `authorize`); denial means no read.
   The reader may also refuse authoritatively: `EACCES`/`EPERM`
   rejections are classified `denied`, `ENOENT`/`ENOTDIR` as `missing`,
   anything else as `read-error`.
6. The read is given the **remaining allowance** (`maxBytes` = the
   smaller of the per-file limit and the unspent cumulative budget);
   once the cumulative budget is spent, no further read is scheduled.
   **Delivered bytes are charged whether or not the content is then
   accepted** — rejected, oversize and unparseable deliveries all count.
   A response whose declared byte length disagrees with the delivered
   text is `inconsistent-response`. A per-file oversize is a per-node
   `file-limit` failure (charged); pushing the cumulative total over
   budget is fatal.
7. Parsing uses the existing DXF reader with its allocation bounds
   **lowered from the caller's budgets** — the source-length cap is the
   per-file byte budget (characters never exceed UTF-8 bytes) — and
   never raised: the parser's own string/pair/record limits
   (1 MiB strings, 2,000,000 pairs, 250,000 records by default) stay in
   force. Parsing is synchronous and **not preemptible**: cancellation
   is rechecked immediately after a parse, but a running parse cannot
   be interrupted, and these limits bound the work this core accepts —
   they are **not** process-memory caps (the reader's string, the
   charger's transient UTF-8 encoding, the parser's structures and the
   publication deep-copy all allocate outside them).
8. Entity accounting counts model-space entities, block-definition
   entities, paper-space layout entities, and retained unsupported raw
   records (`meta.dxfRawEntities`, reported separately on the file
   record) against the per-file and cumulative entity budgets.

Defaults: depth 8; 64 declaration edges; 64 distinct files; 16 MiB per
file; 64 MiB cumulative delivered bytes; 200,000 counted entities per
file; 500,000 cumulative. Callers may only set positive integers.

Cancellation is **normalized**: wherever an operation (identify,
authorize, read, parse) throws after the signal has aborted — or throws
an `AbortError` — the attempt is a fatal cancellation, never an
ordinary per-node failure. The signal is rechecked after every
operation, after staging, and again at publication.

## Publication: atomic refresh without stale results (20.1)

`XrefStore` stamps every load/refresh attempt with a request token and
captures the store's generation and host epoch at its start. At
publication, all of the following must still hold, or the attempt is
**stale** and publishes nothing:

- its token is still the latest issued (a newer attempt — successful,
  failed or cancelled — supersedes every older in-flight attempt);
- the store generation and host epoch are unchanged since it started;
- the attempt's host is still the store's bound host;
- the attempt's signal is not aborted (publication-time recheck).

Host lifecycle: the first successful commit binds the store to that
attempt's host key (`options.hostKey`, else the host identity id, else
the host path). `bindHost(key)` / `close()` model host replacement and
closure: they advance the host epoch, drop the old host's graph, and
invalidate every in-flight attempt. A stale or cancelled attempt
preserves the last good graph **even if its reader ignored the abort
signal** — publication is a single assignment of a fully staged,
sealed snapshot that happens only after all checks pass.

Refresh semantics: a **refresh never publishes an incomplete
snapshot**, in any mode. An incomplete refresh returns its staged
snapshot as an **inspection candidate** (`committed: false`,
`preserved: true`, candidate in `staged`) and the last good graph stays
published — in particular when an existing resolved dependency becomes
missing or denied. The `partial` mode affects only the **initial
load**, where no last-good graph exists yet: a partial load may publish
its incomplete snapshot explicitly. Cancellation and fatal limits never
publish in any mode.

Immutability: staged snapshots returned by `stageXrefLoad` are sealed
deep copies; publication seals a **further** copy, so the committed
graph shares no mutable object with the staged diagnostics, with
parser-returned states, or with caller-owned inputs (which are never
frozen or mutated). Earlier publications are unaffected by later loads.

## Failure statuses

Per node (with the attempted resolved path where one exists):
`missing`, `denied`, `read-error`, `parse-error`,
`unsupported-format` (DWG), `unresolved-path`, `unresolved-location`,
`inconsistent-version`, `inconsistent-response`, `cycle`,
`depth-limit`, `file-limit`, `not-carried-overlay` (informational, not
a failure). Fatal to a whole staging: `cancelled`, `total-limit`
(edge, distinct-file, cumulative byte and cumulative entity budgets).

Node statuses correspond roughly to AutoCAD's reference-palette states:
`loaded` ≈ Loaded, `missing` ≈ Not Found, the other failures ≈
Unresolved. No `orphaned` status is produced: a reference whose parent
failed cannot be discovered at all, because discovery requires parsing
the parent — see limitations.

## Tests (headless)

`tests/xref-loading.test.ts` (53 tests) runs against authored fixtures
in `tests/fixtures/xref/` (registered in `tests/fixtures/manifest.json`)
through fake in-memory adapters mapped to a virtual project layout.
Covered, in addition to the original milestone's cases: app/paths-based
resolution and ambiguous-anchor refusal; identity-based sharing across
spellings; distinct identities with case-colliding names; the seeded
host cycle through an alias spelling; children resolved against an
adapter owning location; unavailable-location diagnosis before reading;
version inconsistency; edge accounting before every early return
(exact and one-over budgets, suppressed overlays, cycles, dense shared
graphs); the distinct-file budget; delivered-byte charging with the
remaining-allowance contract (including the exact counterexample of two
11-byte deliveries against 10/15-byte budgets); inconsistent declared
byte lengths; layout and retained-record entity accounting; the
parser source-length bound; authoritative EACCES/EPERM denial;
cancellation normalization after authorize and after parse, and at
publication; stale publication (out-of-order completion, a newer
failed attempt, host replacement, host closure); partial refresh as
candidate-only (missing and denied dependencies); and runtime
immutability of staged and committed snapshots with earlier
publications unchanged.

These are Linux/Node headless unit checks against the **existing** DXF
parser. They are not AutoCAD compatibility evidence.

## Unresolved compatibility requirements / limitations

1. **DWG references are not loaded** (reported `unsupported-format`).
   Loading them needs the existing DWG pipeline, whose reader works on
   binary data and does not currently expose an xref file's path.
2. **No AutoCAD search-path fallback.** Only the saved path (absolute,
   or relative to the immediate host / its adapter owning location) is
   tried. Filename-only fallback is deliberately absent: silently
   loading a same-named file from another folder would cross the
   reader's permission boundary.
3. **No display or editing wiring.** Loaded content is not rendered,
   clipped (XCLIP), faded, or selectable through this core; INSERT
   transforms are not applied; layer names are kept per-file exactly as
   parsed — AutoCAD's dependent-symbol prefixing, layer collision
   merging and VISRETAIN behaviour are integration concerns, as are
   reload notifications / file watching.
4. **Native alias evidence is pending.** The identity model consumes
   adapter-supplied identity; producing trustworthy canonical identity
   and owning locations on Windows (junctions, UNC, 8.3 names,
   case-insensitive volumes) is the future adapter's work, as is
   registering native path identities (`src/app/paths.ts` has a native
   identity registry the integration can use). Without `identify`, the
   lexical fallback of §Identity applies.
5. **Loading is sequential depth-first**, for deterministic accounting
   and cancellation. No cross-load cache: every refresh re-reads every
   file. Publication deep-copies and seals each snapshot (an
   allocation proportional to the loaded content). Large-project
   performance is unmeasured.
6. **Discovery is block-record based**, matching how the base readers
   record xrefs (BLOCK flag 4). References recorded only in DWG
   structures the base DWG reader cannot expose, or in underlay/image
   definitions (IMAGEDEF paths are a separate mechanism), are out of
   scope.
7. **No `orphaned` reporting** (see above).

## Pending Windows / application / native validation (lead-owned)

- A real permission-controlled adapter on Windows (Electron/IPC):
  identity and owning-location production, drive/UNC/network paths,
  junctions, case-insensitive identity against the real filesystem,
  Unicode and spaced names, project relocation.
- AutoCAD side-by-side checks of attach/overlay carriage on the
  authored fixture set; AUDIT / re-export of a host after application
  wiring exists.
- Applying INSERT transforms and block base points to loaded content,
  xref layer prefixing, clipping, and plot/PDF behaviour — all in the
  application milestone that consumes this core, with the support
  matrix updated there ("external files are not loaded" remains true of
  the shipped application until then).
