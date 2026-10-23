# P31B — Data links: design note (NO CODE)

**Status: DESIGN ONLY.** Filed under PROPOSAL-P31-B's future admission process:
this note designs P31B (table / external-data links) against the ADMITTED
§7.1 contract (RULING-P22 (3), LEDGER.md). It implements nothing. P31B's own
proposal (PROPOSAL-P31-B) and admission remain required before any P31B
integration — and before any P31B code beyond isolated prototypes, per the
program's standing pattern. Referenced from LEDGER L-003 by dated addendum
(2026-10-21). Branch: `muse/p31-project-data-signatures`.

Governing texts, read in full for this note: CONTRACTS.md §7.1 (P31B
consumes the ADMITTED P22 table contract only — P31B must not define its own
table representation, cell identity, or refresh write path); RULING-P22 (3)
(the admitted cell-identity story, RELIABLE items + six NEVER-ASSUMEs);
RULING-P22 (1)/(2)/(4) (the admitted write/read surface, the two pinned
JCAD_TABLE carrier conditions, composition gates); LEDGER L-003 + L-005
(P31B's dependency and P31's last-place integration order).

---

## 1. What a data link is

A **data link** binds a rectangular range of an external tabular source to a
rectangular range of cells of ONE table in ONE drawing, so the table's cell
content can be refreshed from the source (and, in a later slice, written
back). This is AutoCAD's DATALINK model (Excel range ↔ table), narrowed to
what JCad's admitted surface can honestly carry in a first slice:

- The table side is a `TableEntity` (src/core/table.ts) in a drawing —
  consumed exactly as P22's contract defines it. P31B defines NO table
  representation of its own.
- The source side is a **delimited text source** (CSV/TSV) identified by a
  stored path + a named-or-coordinate range. Spreadsheet workbooks
  (.xlsx/.ods) are OUT of the first slice: JCad has no admitted spreadsheet
  reader, adding one is a new-dependency proposal (and, for decoders, the
  L-004 / PROPOSAL-P28-DEP lead process is the precedent) — designing links
  around a reader that does not exist would repeat the error §7.1 exists to
  prevent. A workbook adapter can be proposed later behind the same
  `SourceRange` snapshot interface (§3) without changing the link model.

## 2. Link model

A link is a plain serializable record (strings, numbers, arrays, records —
the sheet-set model's data discipline):

```text
DataLink {
  id: string                    // link-local stable id, minted at creation (newId-style)
  sourcePath: string            // exactly as recorded; never rewritten by validation or refresh
  sourceRange: {                // the source side, in source coordinates
    sheet?: string              // reserved for a future workbook adapter; absent for delimited files
    firstRow: number            // 0-based, inclusive
    firstCol: number            // 0-based, inclusive
    rowCount: number
    colCount: number
  }
  target: {
    tableCadIdentity?: string   // durable best-effort key (see §4); absent = unresolvable-on-reopen link
    firstRow: number            // 0-based grid coordinates in the table as stored (cells[row][col])
    firstCol: number
  }
  direction: 'down'             // refresh writes source -> table; see §6 for why up/two-way are excluded
  lastRefresh?: {               // staleness/tamper evidence, §7
    sourceDigest: string        // sha256Hex (src/core/sha256.ts) over the canonical source-range snapshot
    sourceModifiedAt?: string   // host-supplied mtime at refresh, informational only
    refreshedAt: string         // ISO timestamp of the refresh (host clock)
    cellFingerprints: string[]  // row-major fingerprints of the target cells AS WRITTEN by that refresh, §5
  }
}
```

Where links live is a PROPOSAL-P31-B decision, stated here as the design's
recommendation with its reasoning, because it determines the rest:

- **Recommended: a DrawingState sibling `dataLinks?: readonly DataLink[]`**,
  following the §1 precedent (model3d / constraints / signatureRecord):
  links are drawing content (they describe THIS drawing's tables), they
  must travel with undo history (a refresh is a drawing edit — §6), absent
  = no links, ordinary drawings untouched. This placement inherits three
  obligations the proposal must discharge expressly:
  (a) **Seal**: link records are plain data, so the whole-state seal
  certifies them with NO exemption (contrast signatureRecord's Uint8Array —
  the stage-C collision does not recur; the proposal must still state this
  rather than assume it).
  (b) **Digest**: a new DrawingState field needs a canonical-digest G1
  disposition. The design's recommendation: EXCLUDED from the content
  digest, like meta/cadGraph — a link is provenance/configuration, and its
  target cells' CONTENT is already digested as entity content. But note
  the asymmetry the proposal must state per C5's discipline: in-app edits
  to links still invalidate a preserved signature record (detection is
  transition-based, not digest-based), while out-of-band digest
  verification would not attest link records. If the contracts owner
  instead rules links DIGESTED, the per-type tables (G4) must be extended
  — either way it is a ruling, not an implementer's choice.
  (c) **Persistence**: nothing serializes dataLinks into DXF/DWG until a
  codec proposal names the carrier (the C6 posture from 31C). Until then a
  link survives in-session (undo/redo, tab parking) and is LOST on
  save/reopen — which is precisely why §4 keys links on cadIdentity and
  tolerates resolution failure instead of pretending ids persist. The
  proposal must say this in its non-claims, in so many words.
- The rejected alternative — links in `meta` — is refused for the G3
  reason: meta is an open, digest-excluded, application-data map with no
  per-key discipline; a contract-bearing structure does not belong there.
- The second rejected alternative — a sidecar file per drawing — breaks
  the undo/travel semantics §1 requires of document-level data and
  invents a second save lifecycle; AutoCAD keeps data links in the
  drawing for this reason.

## 3. Source side: snapshot, not live binding

Refresh never reads a live spreadsheet object. The host layer reads the
source file's bytes (through the app's existing file seam, with the
bounded-work caps of §8), parses the delimited range into a **source
snapshot**: a row-major `string[][]` plus its digest. Parsing rules the
proposal must pin (they are refresh-visible behaviour):

- Delimiter: by extension (.csv → comma, .tsv → tab) — no sniffing.
- Quoting: RFC-4180-style double-quote handling; a malformed quote is a
  parse REFUSAL of the whole refresh, never a best-effort partial grid.
- Encoding: UTF-8; a BOM is stripped; undecodable bytes refuse the refresh.
- Numbers stay TEXT. JCad table cells are text (P22 slice 1 is text cells
  only); no numeric coercion, no formula evaluation — a source cell
  `=SUM(A1:A2)` lands as the literal string if it lands at all, and §6's
  write rules may refuse formula-looking content rather than write an
  unevaluated formula into a drawing. Formatting (bold, fills, number
  formats) is NOT carried: the model has no per-cell formatting in this
  slice (P22 C5: per-cell overrides beyond height/attachment are separate
  future surface).

## 4. Cell identity: the admitted story, honoured exactly

Per RULING-P22 (3), a link's target cell is addressed **(table entity, row,
column)**, 0-based row-major over `cells[row][col]` as stored; merge-covered
positions are addressed through their owner cell via `cellOwners`. The link
record stores `(tableCadIdentity, firstRow, firstCol)` for its top-left
cell; the rest of the target rectangle is positional from there.

The six NEVER-ASSUMEs, and this design's answer to each:

1. **No id survival across save/reopen** (the reader mints a fresh
   `newId()` per import). → Links key on `cadIdentity + (row, col)`,
   never on `TableEntity.id`. In-session, id is used only as a lookup
   accelerator after cadIdentity resolution, never as the stored key.
2. **cadIdentity is best-effort, not guaranteed** (expressly not
   guaranteed after structural edits that renumber handles). → A link
   whose cadIdentity resolves to NO table is a **BROKEN link**: reported
   in P31B's own link-issues surface (the P31 family posture — P31A's
   link issues are reported, never retargeted), never silently rebound to
   a different table, never auto-deleted. A cadIdentity that resolves to
   MORE THAN ONE table (duplicate handles in a hostile or damaged file)
   is likewise broken-ambiguous: refresh refuses; it does not pick one.
3. **Indices are positional** — inserting/deleting a row renumbers later
   rows, so a bare (cadIdentity, row, col) link CAN silently retarget
   after a structural edit. §7.1 names stable row/column identity across
   refresh, undo and reopen as the requirement the consuming design must
   handle, and the contract supplies positional identity + best-effort
   durable key and NOTHING stronger. → This is the design's central
   problem; §5 is devoted to it. Short form: refresh reconciles against
   per-cell fingerprints recorded at link creation / last refresh and
   REFUSES rather than retarget when the reconciliation is ambiguous.
4. **Covered cells are virtual in the native record** (173 = 1, no
   content); covered data exists only via the JCAD_TABLE carrier, only in
   the two admitted carrier conditions, restored only by JCad's own read
   path. → **Covered-cell disposition (express):** a link's target
   rectangle is defined over OWNER cells. Expanding the rectangle through
   `cellOwners`: any grid position whose owner lies outside the rectangle
   makes the link INVALID for refresh (the rectangle cuts through a
   merge). Refresh writes owner cells only; covered positions are never
   written (there is nothing to write — they are virtual). A link whose
   rectangle CONTAINS a merge is fine iff the whole merge is inside the
   rectangle; the merge's span is not altered by refresh. If a refresh
   would need to CHANGE a span (source shape implies different merges),
   it refuses (§5) — refresh never merges or unmerges.
5. **No persistent table/row/cell UUID exists.** → This design does NOT
   introduce one by implication. §5's fingerprints are a reconciliation
   heuristic with a REFUSAL outcome, not an identity: they can prove
   "these cells are not the ones the link last wrote" but never mint a
   durable identity the contract does not supply. Whether P31B should
   propose the §7.1-contemplated optional-UUID extension (an optional
   field on the model) is OPEN QUESTION Q2 (§10) — the design's position
   is that slice 1 must NOT require it: fingerprints + refusal carry the
   safety property without new model surface; a UUID extension can be
   proposed later if field experience shows refusal rates demand it.
6. **No keying on style name or handle** (synthesized TABLESTYLEs are
   signature-derived, regenerated per write, names Standard,
   Standard_2, …; an imported table's original style name is not
   retained). → Links store nothing about style. Refresh writes cell
   text/raw only and lets the admitted writer re-derive styles exactly
   as it does for any edit.

## 5. Refresh and reconciliation: never silently retarget

This section is the design's answer to NEVER-ASSUME (iii), stated as
decidable rules. "Refresh" = replace the target rectangle's cell contents
from a fresh source snapshot.

**Preconditions checked before ANY cell is written** (any failure =
whole-refresh refusal, drawing untouched, refusal reported with its
reason; refresh is atomic or does not happen):

- R1 RESOLUTION: the link's cadIdentity resolves to exactly one table in
  the drawing. Zero → broken link reported; more than one → ambiguous,
  refused. (In-session creation binds by entity id, then records
  cadIdentity; a table whose entity carries NO cadIdentity can be linked
  in-session but the link is born with `tableCadIdentity` absent and is
  reported `unresolvable-on-reopen` from the start — creating it is
  allowed, hiding its fragility is not.)
- R2 SHAPE: the source snapshot's shape must equal the link's recorded
  range shape (rowCount × colCount). A source that grew/shrank rows or
  columns is NOT auto-fitted: refresh refuses with `source-shape-changed`
  and the user-facing remedy is an explicit re-range operation (a
  separate command that re-records the range and the fingerprints —
  itself a drawing edit through transact). Silent grow/shrink is how a
  link overwrites cells outside its rectangle; it is therefore
  impossible by construction, not by care.
- R3 GRID SHAPE: the table's CURRENT grid must still contain the whole
  target rectangle (rows/cols not deleted out from under it). If the
  grid shrank so the rectangle no longer fits → `target-out-of-range`,
  refused.
- R4 FINGERPRINT RECONCILIATION: at link creation and at every
  successful refresh, P31B records one fingerprint per target cell:
  `sha256Hex` over the cell's (text, raw ?? '') canonical pair, row-major
  (§2's `cellFingerprints`). At refresh, the CURRENT target cells'
  fingerprints are recomputed and compared:
  - ALL MATCH → the cells are exactly what the link last wrote (or the
    user restored identical content); refresh proceeds.
  - SOME DIFFER → the cells were edited since (by the user, by another
    link, by undo to a different state). This is EXPECTED use, not an
    error: refresh reports `cells-modified-since-refresh` with the
    differing coordinates and requires the refresh to be CONFIRMED as an
    overwrite (the command's explicit force flag / UI confirmation). The
    confirmation is per-refresh, never a stored "always overwrite" bit
    on the link — a stored bit would reintroduce silent overwrite after
    the next structural edit.
  - STRUCTURAL SUSPICION → the decisive case: if the grid's row/column
    COUNT differs from what it was at last refresh (the fingerprint
    vector's implied grid shape is recorded alongside: target grid rows/
    cols at record time), a positional shift may have occurred: rows
    inserted above the rectangle move every target row down while the
    recorded (row, col) now points at DIFFERENT cells whose fingerprints
    will (almost surely) differ — caught by the differing-fingerprints
    path — BUT a shift can also move IDENTICAL content into place (a
    duplicated header row is the realistic case). Fingerprints cannot
    distinguish "my cells moved" from "my cells were replaced by
    identical ones", and row insertion INSIDE a run of equal rows is
    genuinely ambiguous. RULE: when the grid shape changed since last
    refresh AND any fingerprint differs, refresh REFUSES outright
    (`grid-shape-changed`) — confirmation cannot override; the remedy is
    the explicit re-range/re-bind operation, where a human looks at the
    table. When the grid shape changed and ALL fingerprints still match,
    refresh also refuses: matching fingerprints under a changed grid
    cannot be distinguished from coincidence at the boundary rows (the
    rectangle's first/last row may now hold a neighbour's identical
    content). Grid shape change ⇒ refusal, unconditionally; re-bind is
    the only path. This is the strongest rule in the design and it is
    deliberate: it is the only rule under which "refresh never silently
    retargets" is actually true rather than usually true.
- R5 MERGE INTEGRITY: the rectangle is expanded through `cellOwners`;
  if any covered position's owner lies outside the rectangle, or any
  owner inside the rectangle is covered from outside it → refused
  (`merge-boundary`). (Also checked at creation.)
- R6 OVERLAP: two links whose target rectangles overlap in the same
  table — creation of the second is refused unless the overlap is
  resolved by the user; refresh of either reports the overlap. Links
  must not fight over cells.

**What refresh writes, when it proceeds:** for each owner cell in the
rectangle, the source snapshot's corresponding text; `raw` is CLEARED
unless the new text equals the old text (a `raw` that no longer matches
its text is stale formatted content — table.ts's discipline: raw is
"formatted DXF content when it still matches text"). Title/header/data
roles are not link business: refresh writes text into whatever cells the
rectangle covers. The write happens inside ONE `Drawing.transact`
(§6). Post-write, the link's `lastRefresh` is replaced (new source
digest, new fingerprints of the cells AS WRITTEN, grid shape) in the
SAME transaction — fingerprints and content can never drift apart across
an undo boundary.

**Undo interplay:** undoing a refresh restores the pre-refresh cells AND
the pre-refresh `lastRefresh` record together (both are DrawingState),
so a redo/undo cycle cannot resurrect fingerprints that describe content
the state does not hold. A refresh after an undo reconciles against the
RESTORED fingerprints — which describe the restored content — so R4
still means what it says.

**In-session structural edits** (the user inserts a row in a linked
table through the editor, no refresh involved): nothing happens at edit
time (P31B installs no edit hooks in slice 1 — a hook watching every
table edit is surface §10 Q4 asks the contracts owner to rule on). The
next refresh hits R4's grid-shape rule and refuses. The link is never
adjusted silently at edit time either — "helpfully" shifting a link's
row on insert is exactly the silent retarget this design forbids, even
when the shift guess would usually be right.

## 6. Refresh direction

Slice 1 is **down-only** (source → table), AutoCAD's "download" direction:

- **Up (table → source) is excluded**: writing user files from drawing
  content is a second trust surface (path handling, overwrite of the
  user's source data), and the delimited-source writer (quoting,
  encoding, atomic replace) is its own design. Not designed here beyond
  this refusal; a later slice may propose it.
- **Two-way is excluded**: it is up + down + a conflict rule, and the
  conflict rule would need cell-level provenance this contract does not
  supply (see NEVER-ASSUME (v)).
- Refresh itself is a drawing edit: ONE transact, one undo step, dirty
  set (CONTRACTS §1). The link record update rides the same transaction
  (§5). A refresh that changes no cell content (source identical) is a
  no-op transaction — but it DOES update `lastRefresh.refreshedAt` only
  if the proposal rules that a timestamp bump is worth an undo step;
  the design's recommendation: identical source digest ⇒ NO transaction
  at all, report `already-current`. (Timestamps are evidence, not
  content; minting undo steps for them trains users to ignore undo.)

## 7. Staleness and tamper posture

- **Staleness is shown, never auto-healed.** A link is STALE when the
  host's current source digest differs from `lastRefresh.sourceDigest`.
  Staleness is computed when the host checks (on demand / on drawing
  open, if the proposal so rules) and surfaced in the link-issues list;
  NOTHING refreshes automatically. Auto-refresh on open would make
  opening a drawing a mutating act — refused as a design principle.
- **The digest is a change detector, not a signature.** sha256Hex over
  the canonical snapshot text (§3's parse output, re-serialized
  canonically — the proposal must pin the canonical form: parsed grid,
  LF row separators, no trailing newline) detects "the source changed
  since refresh". It attests NOTHING about who changed it or whether
  the new content is trustworthy — the (f2) posture from 31C applies
  verbatim: unauthenticated, API discipline. A source file that was
  tampered with refreshes exactly like a source file that was edited;
  the defence is that refresh is always an explicit, confirmed,
  undoable act with the refusal rules of §5 — never a silent one.
- **Path posture:** `sourcePath` is recorded verbatim and resolved by
  the host at refresh time (relative to the drawing file, the project
  precedent). The refresh reader must refuse paths that climb out of
  the drawing's/project's directory tree unless the link was created
  with an absolute path — the `climbsOut` discipline in
  src/app/paths.ts is the precedent to name in the proposal. No network
  sources (no URLs) in slice 1.
- **Cell content is untrusted input.** Source text lands in cells as
  TEXT. It is never evaluated as a field expression by refresh itself
  (if the text contains a `%<\...>%` sequence it displays through the
  normal field machinery only where the drawing already evaluates
  fields — refresh neither adds nor suppresses that), never interpreted
  as a formula (§3), and bounded per §8.

## 8. Bounded work

Refresh is bounded in the geometry-budget discipline (refuse atomically,
never partially apply):

- Source file size cap: 8 MiB (the P28 adapter cap precedent) — refuse
  before parsing.
- Range caps: rowCount × colCount ≤ 100,000 cells per link; a single
  cell's text ≤ 32 KiB after parse; violations refuse the refresh.
- Fingerprint cost is linear in the rectangle (one sha256 per cell);
  the cap above bounds it.
- Parse time is linear in file size; no regex over untrusted text with
  backtracking risk (the fields.ts E-6 lesson: hand-scan where a regex
  could go quadratic).
- Refresh writes go through the existing prepare/validate path, so a
  hostile link record in a hand-edited state meets the same validation
  as any other state (the sibling is validated like constraints/model3d
  are — the proposal names the validator).

## 9. What PROPOSAL-P31-B must admit (the surface, for the future filing)

1. `DrawingState.dataLinks?: readonly DataLink[]` (document.ts) + the
   digest disposition ruling (§2(b)) + the seal statement (§2(a)) + a
   state validator for link records.
2. The link operations module (isolated, src/project/): link creation
   (with R5/R6 checks), fingerprint computation, reconciliation
   evaluation (pure: state + snapshot → decision per R1–R6), and the
   refresh transition builder (pure: state + decision + snapshot → next
   state) consumed by ONE transact call site.
3. The host refresh seam: source read + parse (§3) + digest, behind the
   app's file seam, with §8's caps; NO codec change — refresh writes go
   through the ADMITTED P22 write path unchanged on the next save, and
   the read path is untouched (P31B defines no refresh write path of
   its own, per §7.1 — the "write path" IS an ordinary transact whose
   result the ordinary writer emits).
4. The link-issues surface (broken / ambiguous / stale / modified /
   grid-shape-changed / merge-boundary / overlap) as data — the UI that
   displays it is a separate later proposal, as with 31A.
5. Failing-first acceptance examples mirroring §5's rules, including:
   the duplicated-header-row ambiguity refusal; the undo-restores-
   fingerprints case; the carrier-covered-cell case (a link over a
   merge whose covered cell carries text via the JCAD_TABLE carrier —
   refresh writes the owner only and the covered content survives a
   save/reopen through the admitted carrier conditions); the
   cadIdentity-missing and cadIdentity-duplicated refusals; the
   no-cadIdentity in-session link reported from birth.
6. Explicit non-claims: no persistence of links in DXF/DWG (until a
   codec proposal), no workbook sources, no up/two-way refresh, no
   auto-refresh, no formulas/fields/formatting, no UUID identity, no
   DWG-path claim.

Also carried from the program record (not P31B surface, but P31's
integration preconditions): the RULING-P18-S3 C7 G4 item — the
canonical-digest tables must cover P18 slice 3's `MLeaderNative.contexts`
when P31 composes. It will interact with §2(b)'s disposition ruling if
links are ruled DIGESTED (both land in the same tables); recorded here
so PROPOSAL-P31-B's author meets both in one sitting.

## 10. Open questions for the contracts owner

- Q1 (§2(b)): digest disposition for `dataLinks` — EXCLUDED (this
  design's recommendation) or DIGESTED? The C5 statement either way.
- Q2 (§4(5)): is fingerprint reconciliation + refusal an acceptable
  slice-1 answer to §7.1's "stable row/column identity" requirement,
  or does the contracts owner require the optional-UUID model extension
  to be proposed WITH slice 1? The design argues refusal carries the
  safety property; the ruling is the contracts owner's.
- Q3 (§5 R4): is the unconditional grid-shape-change refusal too
  strong — e.g. should a row insertion BELOW the target rectangle
  (provably unable to shift it) be permitted? The design says no
  exceptions in slice 1 (decidability over convenience); a ruled
  refinement would need to define "provably" against positional
  indices, which is exactly the argument the design avoids.
- Q4 (§5): edit-time hooks — should slice 1 install a table-edit
  observer that marks links `grid-shape-changed` immediately (better
  reporting, more shared surface in document.ts), or is
  refresh-time-only detection (this design) the admitted posture?
- Q5 (§6): the `already-current` no-transaction rule — is a
  digest-identical refresh allowed to update `refreshedAt` outside a
  transaction (outsideHistory-class), or is no-write-at-all the rule?
- Q6 (§3): delimited-source scope — is CSV/TSV-only an acceptable
  slice-1 source class, with workbooks gated on a separate
  dependency proposal (L-004 process), or does the contracts owner
  want the workbook adapter designed (not built) in PROPOSAL-P31-B
  itself?
- Q7 (§7): relative-path base — drawing directory or project
  directory — and the exact climbsOut rule for link sources, given
  links are drawing content but sources are project-shaped data.
- Q8: interaction with 31C — a refresh is an ordinary edit for
  signature detection (it invalidates via C2 like any transact; the
  design assumes YES and asks the contracts owner to confirm no
  special case is wanted).

## Coverage limits of this note

Design only: no code, no tests, no fixtures. Source-format claims rest
on the admitted P22 record (Linux/headless evidence); native AutoCAD
DATALINK behaviour is a reference model, not a compatibility claim.
DWG is out of scope throughout (the DWG table path stays `simplified`
per RULING-P22 (4)(h), and nothing here designs around it).
