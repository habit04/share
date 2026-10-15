# Changelog

All notable changes to JCad Electrical are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The entries for 0.1.0 to 0.3.4 were reconstructed from the Git history (commit subjects and
messages). The date of each version is the date of the commit that set that version number in
`package.json`.

## [Unreleased]

## [0.5.2] - 2026-10-15

### Upgrade notes

- Windows x64 patch update from v0.5.1. Eligible TrueType collection fonts can now be embedded
  in vector PDFs. Support uses the collection's first face; the remaining PDF font roadmap
  and native TTC Plot/IPC verification remain open.

### Added

- Windows vector PDF export can embed face 0 of a permitted TrueType collection, using the
  same face as installed-font metrics. Extraction preserves the full glyph program, mappings
  and permissions, and rebuilds standalone checksums. Unsupported or restricted fonts keep
  the reported fallback; general collection-face selection and the rest of priority 12 remain open.

## [0.5.1] - 2026-10-14

### Upgrade notes

- Windows x64 update from v0.5.0. Canvas remains the initial renderer; the experimental 2D GPU
  candidate requires explicit selection and falls back to complete Canvas rendering.
- New profiles have 3D tools available without starting a viewport or geometry kernel. Stored
  opt-outs remain off, and foreign 3D import has its own preference. The existing tested 3D
  subset remains experimental; paper-space layouts still use the 2D view.
- Retain the v0.5.0 installer and a profile backup made before updating for rollback. v0.5.0
  does not understand the separate foreign-import preference; restore the older profile too.

### Added

- Offer an experimental 2D GPU candidate through explicit `GPURENDERER GPU` / `GPURENDERER CANVAS`
  selection in the ordinary Windows build. Canvas remains the default and complete fallback.
- Label the 3D orientation indicator with upright X, Y and Z letters, keeping end-on axes and
  overlapping projected directions readable during orbit and on high-DPI displays.
- Make experimental 3D tools available by default for new profiles while keeping the initial
  drawing in Canvas 2D. Preserve explicit opt-outs and old opted-in import preferences; expose
  foreign 3D import separately so the default does not change CAD classification or DWG guards.

### Fixed

- Generic 2D Select All no longer includes hidden retained 3D objects. Active 3D views, explicit
  object IDs and registered 3D commands keep intentional access, including undo and redo.

## [0.5.0] - 2026-10-14

### Upgrade notes

Major Windows x64 update with 2D compatibility, text and plotting improvements, safer
save/recovery behavior, and optional experimental 3D modelling. Enable 3D under
Options > Files > Experimental 3D and restart. Drawings containing 3D models save as
JCad DXF; DWG saving for those drawings remains guarded. Canvas is the default 2D
renderer. GPU diagnostics are included; the experimental 2D GPU renderer remains
development-only. macOS and Linux desktop updates remain paused at v0.4.5.

### Added

- Optional development GPU build adds bounded WebGL2 drawing coverage and GPU diagnostics.
  Canvas remains the ordinary renderer; unsupported geometry, fonts, SHX and active gradients
  use the complete Canvas view. Captured drawing font contexts invalidate GPU geometry and
  admission caches on arrival or resource changes. Experimental 3D mode hides the 2D GPU
  backing and restores the selected 2D renderer on exit. Combined hardware validation is
  recorded separately from the producer's frozen GPU evidence.

- Experimental 3D modelling behind Options > Files > Experimental 3D (off by default):
  a WebGL2 viewport, primitives, extrusion/revolution, Manifold Boolean operations,
  construction planes, transforms, measurement, snaps and grips. DIM3D supports aligned,
  linear and angular dimensions in measurement planes. Own solids and dimensions persist
  in DXF even when hidden, with typed metadata identities and checked edit transactions.
  DWG saves with a 3D model refuse safely; native ACIS modelling and full camera/font/plot
  parity remain outside this bounded feature. Canvas remains the default 2D renderer.
  See `docs/3D-STATUS.md` and `docs/WINDOWS-UPGRADE-INTEGRATION.md` for validation and limits.

- Native XY ordinate dimensions import and export as editable DXF dimensions, retaining datum
  frames, axes, text placement and supported style overrides. Geometry, block expansion and
  undo/redo use independently checked native reference cases. Unsupported modes refuse import;
  DWG saving remains guarded until native conversion is verified. Arc-length dimensions and an
  ordinate creation tool remain open.

- Windows SHXFONT/SHXLOAD reads selected SHX fonts/shapes through a confined native picker.
  Supported horizontal glyph paths and native metrics are local to each drawing tab, with
  captured raster/vector plotting and reported unsupported runs. Work, decoded data, pending
  hashing and caches are bounded. Eligible type-0 Unicode fonts plot as vector outlines;
  BigFont, vertical/mirrored text and complex-linetype glyph display remain open.

- Plot dialog loads bounded CTB/STB tables for the current plot. Native ACI/TrueColor rules,
  grayscale, screening and physical lineweights agree in vector PDF and raster plots;
  nested ByBlock widths resolve before plot overrides. STB selection explicitly applies one
  named style to the entire plot. Invalid files keep the valid table, and reopening the dialog
  resets it. Unsupported device/policy effects are reported. Imported named assignments and
  exact sheet table bindings remain open; see `PLOT-STYLE-TABLES.md`.

- Native DXF complex linetypes retain ordered text/shape descriptors, literal padded text,
  flags, radians, scales/offsets and remapped STYLE links. Anonymous/unused shape-file resources
  survive export and linetype purge. Missing/malformed resources refuse saving; DWG conversion
  is guarded until verified. Embedded text/shape display remains a reported dash fallback.

- Windows installed TrueType metrics use bounded background workers and a per-drawing context
  for Canvas painting, text bounds/selection, wrapping, masks, annotation fitting and raster plots.
  Native height, bearings, FIT/ALIGNED and verified vertical placement replace stroke measurements.
  Missing/unsupported font structures and glyph origins use Canvas fallback measurement; source
  STYLE data is retained. Font arrival and STYLE edits refresh caches without dirty/history changes.
  Pending plots await metrics and retain captured drawing definitions. Tall-glyph MTEXT leading,
  inline font changes remain open; SHX has a separate validated subset in `SHX-FONTS.md`.
- Windows vector PDF embeds permitted installed standalone TrueType programs with exact native
  advances, placement and Unicode maps. Font resources stay local to the captured plot, with
  eight-face/128 MiB limits and the same clip/layer/annotation culling as PDF painting. Missing,
  restricted, unsupported or shaping-dependent faces/runs use a reported substitute. TrueType
  collections, CFF/variable/color fonts, subsetting and preview/print-only embedding remain open.
- DXF layouts retain native closed straight-polyline viewport clips, including concave
  outlines, boundary appearance and the native enable flag. Canvas display, viewport
  activation, snapping and vector/raster plots honor the clip. Editing, copying and
  save/reopen retain its native boundary pointer. Curved clips and DWG clip import remain
  reported limitations. An AutoCAD 2027 normalized polygon fixture passed AUDIT with zero errors.
  DWG Save/Save As and Export Copy refuse retained clip boundaries until native reference
  preservation is verified; the save-error fallback selects DXF and keeps unsaved/recovery data.
- MTEXT flows through declared-height static and dynamic-manual columns, retaining explicit
  column breaks, formatting, reversed placement and overflow. Automatic-height balancing and
  native column export remain open.
- Native DXF gradient HATCH definitions retain names, angle, shift, dialog mode/tint, stored
  ACI/RGB colors and inactive descriptors. All nine native names roundtrip through an
  AutoCAD-normalized fixture. Verified unshifted LINEAR fills render in Canvas and vector/raster
  plots with holes, transparency and block transforms; vector PDF uses smooth axial shading.
  Nonlinear and shifted definitions retain data and report a solid-fill display fallback.
  HATCHEDIT angle/shift edits support undo/redo. EXPLODE protects retained gradients; DWG
  saving/export refuses them until native conversion is verified, keeping the DXF fallback.
  Patterned hatches with gradient tails retain their data and refuse native DXF export because
  AutoCAD rejects the combination; HATCHEDIT cannot introduce it. Explicit SOLID conversion
  retains inactive gradient data. Invalid or precision-collapsed gradient PDF transforms
  report a plotting error instead of emitting corrupt shading matrices.

### Fixed

- GPU diagnostics report the active experimental 3D viewport and return to Canvas 2D
  when it closes. The development GPU renderer keeps its own actual-use reporting.

- Experimental GPU aligned dimensions retain their exact Canvas text orientation during
  camera rebasing after native DXF reopen. This prevents a two-step floating-point angle
  difference from causing unnecessary Canvas fallback, while preserving strict source,
  glyph and triangle certificates, accuracy tolerances and the three-layout work budget.

- Experimental 3D picking pads culling bounds for tested grazing/oblique rays and retains
  double-precision hit normals. Camera aliases cannot resolve inherited object properties.
  Measurement reports count negative-winding volume magnitudes with a note and keep finite
  zero-volume centroids. Actual determinant error replaces an aspect-ratio cutoff; thin
  imported volumes stay measurable. Distance projection retains small/scientific components
  at large origins, while display-only rules remove rounded negative zero and near-normal
  XY angle residue. Exact threshold and overflow regressions are checked on Windows.

- Experimental 3D objects participate in the retained CAD graph, shared identity checks,
  clone remapping and atomic edit/history validation. Native parent/follower and dimension
  picture identities remain bound to proven source records; unsupported topology or payload
  changes refuse. Opaque application groups cannot supply native geometry flags or coordinates.
  Dimensions-only models receive DXF reopen-budget checks, and unsafe partial recovery cannot
  replace a previous good backup. Worker assets use native canonical containment on Windows.
- Invalid or duplicate native 3D handles produce the public DXF read error. They remain
  non-recoverable input errors, so damaged-file recovery cannot skip unsafe object identities.
- Retained foreign polyfaces bind their model-space and parent owners during DXF saving.
  Opaque application fields remain intact; unproven or contradictory placement refuses saving.

- Native layout rewrites retain physical page setup independently of drawing limits,
  unmodeled limits/extents/UCS and the overall paper viewport's identity and camera
  data. Copied sheets use their own current page settings when explicitly edited.

- Imported drawings keep unspecified annotation visibility defaults absent during
  export, avoiding an unsolicited native dictionary entry on a subsequent DWG save.
  Existing declarations, explicit edits and new drawing defaults remain supported.

- TABLESTYLE postflight compares complete adjacent reactor/extension-dictionary
  blocks symmetrically while retaining owner, ordered references and opaque data.
  Malformed, duplicate, nested or interleaved common framing refuses.

- Native postflight checks expand only verified compact AC1032 built-in materials, checking
  every added default exactly while retaining all six mapper matrices, flags and object links.
  Custom, procedural and unknown payloads keep their existing full comparison/refusal.
- Retained MLEADERSTYLE checks preserve optional null block references and independent
  attachment fields; MLINESTYLE spelling differences require the same matched LTYPE object
  and table control. Legacy raw records remain exact; ambiguous typed bodies refuse.

- Native VISUALSTYLE postflight checks recognize RGB storage only in the eight typed color
  slots of its complete modern property bag. Derived palette companions can differ when
  explicit RGB agrees; standalone ACI, lighting, operations, framing and opaque data remain
  exact. Unsupported methods and ambiguous schemas refuse. Legacy records keep raw checks.
- Project source-basis scans reuse bounded path normalization within each synchronous scan.
  Native aliases and platform reads remain live on every comparison; the original path
  comparator and save guards remain intact. Oversized caches use uncached comparisons.

- Native postflight checks compare VPORT ambient RGB through a bounded, method-aware
  representation check. Only ordinary DXF RGB and native explicit-RGB C2 storage can
  agree; different RGB, unsupported methods and other retained properties still refuse.
  The correction uses the matching original AutoCAD DWG/DXF pair as its reference.

- Project batch preparation captures the active session once per synchronous source-basis
  scan, retaining fresh scans around asynchronous reads and writes. Project replacement,
  newly opened path aliases and tab/history changes still refuse stale writes. The existing
  512-drawing regression keeps its original deadline and preservation assertions.

- Native DataObject common-link accessors expose parsed reactors and extension dictionaries
  without requiring DWG-reader side caches. Strict metadata comparisons detect reordered,
  removed or changed links; binary roundtrip and independent postflight remain mandatory.

- This release combines completed PR #9 metadata/reference support with the Windows
  2D and reliability corrections. Graph-aware project preparation and session restore checks
  protect tabs, history and source proofs before mutations. Complex linetype edits, anonymous
  shape styles and viewport clip identities retain their newer compatibility behavior.
  Combined validation is separate from the released v0.4.9 evidence. The Windows installer
  is built and checked through this version's release pipeline.

- Legacy TABLESTYLE conversion checks retained row formats, inherited overrides, links,
  colors, grids and margins before choosing a modern native representation. Unsupported
  inactive values refuse before encoding. Native writer preparation preserves imported
  compatibility dictionary entries and child records; constructor cleanup remains bounded
  to styles without DXF or native DWG source provenance. Strict metadata snapshots and
  independent native postflight remain required; local projection tests do not certify a compiled helper.

- Windows text/PDF exports share drawing saves' native ordering and opened-source guards.
  PDF orders precede dialogs and slow font/image/conversion work; direct CSV reports capture
  before project reads and serialization. Older output, outside edits and retired owners
  refuse replacement. Cancellation joins owned conversion/write cleanup, detached report
  reads release unused source proofs, and unverified replacements explicitly require review.
  Plotting preserves drawing dirty/history/recovery state and obvious empty-model behavior.
  Existing project backups and the separate 512 MiB PDF ceiling remain supported.

- Plugin manifest/code reads compare fresh held-descriptor bytes, refusing same-size changes
  hidden by Windows timestamp collisions. Bounded scratch, size limits, confinement and
  existing trust policy are preserved; this does not implement plugin capability isolation.

- Windows save versions include fresh descriptor-read byte digests, refusing same-size external
  edits even when native timestamps collide. Returned drawing bytes match their original pins,
  and post-decode checks retain coherent opens. Own committed versions must match the exact write
  payload; unverified replacements retain dirty/recovery state, require destination review and
  stop dependent project writes.

- Windows Open retains bounded source-byte evidence for its drawing tab. A later normal Save
  refuses outside edits made since Open before replacing the original or its backup, preserving
  dirty state and recovery. Verified own saves advance the source; Save As to a separate file
  starts a new source. Duplicate opens, native aliases, reloads, overlapping saves and omitted
  proof contexts cannot silently refresh the baseline. Source evidence is runtime-only, with
  explicit capacity refusal; remaining filesystem provider and final OS race limits still apply.

- Project calculations capture one Windows save order before snapshots, bind all sources before
  reading and check the complete calculation basis before backups and every write. Bounded
  preparation supports larger projects, preserves paper-space undo, refuses duplicate sheet rows
  and cancels dependent writes when an open source changes. Committed files are reported
  individually; this does not make a multi-file save atomic.

- Windows saves capture host ordering before slow work and refuse older native path aliases.
  Unicode sibling grants remain separate, stored leaf casing is preserved, and every sharing
  retry rechecks authorization, file version and parent/root identity. Project backup preparation
  shares the bound save reservation; stale backups and external edits are preserved.
- Native drawing opens pair held-descriptor bytes with coherent filesystem identity. Saved
  drawings use commit receipts instead of fresh path lookups, preventing post-save junction
  changes from altering tab/source identity. Reloaded compatibility Save As dialogs cannot write
  an old document's payload. Dirty state and recovery survive failed or unverified saves.
- Portable writer admissions now always hash bounded executable/dependency bytes. The completed
  repair from PR #9 rejects same-size edits whose timestamps collide or were restored.
- Plugin unload revokes retained API handles and cancels owned prompts, dialogs and file pickers.
  Stale loads/reloads cannot replace newer entries; nested edits roll back after unload, including
  hostile error formatting and return-value getters. API v1 remains trusted page code.

- Native omitted TEXT/ATTDEF/ATTRIB width/slant groups mean entity defaults 1/0, rather than
  STYLE creation defaults. Generated labels and attributes emit canonical defaults on their
  first export, keeping repeated DXF exports consistent.
- SHX and plugin reads compare exact canonical filesystem paths, refusing Unicode sibling
  escapes and pre/post-read junction retargets. Plugin manifests/code use bounded held
  descriptors so path checks cannot be bypassed before opening a different file.

- Canvas linetypes follow signed lengths, merging consecutive gaps/dashes without inverting
  the next repetition. Leading gaps, dots and terminal dashes keep their phase; positive-only
  patterns no longer invent spaces. Standard patterns and the visibility threshold remain compatible.

- Installed TrueType MTEXT uses glyph ink for wrapping and attachment while retaining independent
  pen advances. Default line anchors include bearings and vertical descenders; explicit paragraph
  alignment retains reference-width slack. Dimension gaps and fitting include overhanging ink.
  Native tall-glyph leading, inline font families and automatic column heights remain approximate.
- Font lookup ignores inherited/malformed STYLE entries, so missing styles named `constructor`
  or `toString` cannot crash painting; legitimate owned styles with those names remain supported.
- Angular dimensions honor DIMSD1/DIMSD2 and keep distinct arrows attached to their defining
  legs when the displayed arc reverses. Text gaps cannot overrun blank-arrow backoffs.
- Named dimension-style edits update model space, every block and every paper layout while
  preserving per-entity overrides. Paper-space style commands use a document-wide undoable
  transition; usage checks protect styles referenced by block or layout dimensions.
- Supported native dimension overrides keep their explicit values when a named style
  temporarily matches them, including across DXF save/reopen and later style redefinitions.
  Scaling, Match Properties and assigning current dimension settings retain the corresponding
  override behavior.
- Clipped viewport selection includes visible hatch pattern strokes and dots, including
  nested inserts. Retained clip outlines keep their layer and linetype resources through
  purge and DXF export, even when clipping is disabled.
- MTEXT justification uses each paragraph's final line, prevents negative spacing around long
  words and avoids phantom lines from trailing spaces. Canvas and vector PDF honor explicit
  text width overrides consistently, including width factor 1 and Canvas oblique angle 0.
  Explicit native width 1 and oblique 0 survive TEXT, ATTDEF and ATTRIB DXF save/reopen.
- Windows paths preserve distinct composed/decomposed Unicode filenames across tabs, recent
  files, project references, persisted permissions, save queues and DWG export destination
  selection. Atomic writes and image permissions reject a differently spelled sibling folder
  outside the selected project, while each real file keeps its own exact previous-file backup.

## [0.4.9] - 2026-10-13

### Upgrade notes

Windows installer publication requires a signed package and fresh Windows installation
checks without AutoCAD.

- This update targets Windows x64 and requires no installed AutoCAD. Its bounded metadata
  coverage includes named VIEW cameras and native FIELD relationships. Full camera coordinates
  are retained; paper-space, tilted, reversed and perspective cameras cannot be restored faithfully
  in the 2D editor. A future 3D editor is separate work.
- Explicit legacy TABLESTYLE definitions retained from DXF refuse DWG export until their full
  properties can be proven equivalent to AC1032. Save those drawings as DXF; native modern
  table-style preservation does not establish conversion of legacy definitions.

### Added

- Retained CAD objects now have document identities and typed references. Exposed dictionaries,
  XRECORD data, application records, reactors, extension dictionaries and XDATA travel with
  edits, undo and saving. Integer and binary values remain exact; arbitrary strings are opaque.
- COPY, MIRROR, ARRAY and clipboard copies remap references within each copy set and clone
  owned metadata. Missing hard dependencies refuse the operation; cross-document soft references
  that cannot be resolved are removed with a specific message.
- Native FIELD/FIELDLIST objects retain expressions, child fields, ordered reference vectors,
  evaluator settings and cached values. JCad reevaluates supported filename/date/drawing-property
  expressions and available supported sheet values. Other evaluators, including object-property
  expressions, keep their imported display/cache even after geometry changes. UPDATEFIELD reports
  retained caches. Manual text overrides remove only the affected owned FIELD tree; Undo restores it.

### Fixed

- Named VIEW records preserve camera target, direction, display center, width, height, twist,
  lens and clipping settings. Planar Restore uses the source camera angle and coordinates;
  model view rotation survives document tabs and layout transitions.
- The Windows DWG reader exposes bounded native DXF metadata with an exact object inventory,
  verifies source coverage and reports fallback imports when the projection is incomplete.
- Independent source checks verify all 58 VISUALSTYLE properties, every ordered TABLESTYLE
  override format, and stored DWG creation/update clocks and timers in the three fixtures.
- Portable DWG saving checks source schema/identity coverage, exact opaque strings and its typed
  metadata/reference snapshot. A mandatory independent LibreDWG postflight then compares emitted
  DWG metadata with source DXF before replacing a destination: retained OBJECTS records, full VIEW
  cameras, common reactor/extension/XDATA data and nonvolatile headers with logical reference targets.
  Incomplete projection, unsupported schemas, read/write errors or changed values refuse output.
- Independent AutoCAD-authored fixtures cover full named cameras, parent/child and object-reference
  FIELDs, exact 64-bit XRECORD integers/binary and Unicode strings with literal escape text.
  Fixed installed probes require connected copy, atomic hard-reference delete refusal and normal
  DWG Save As/Save/fresh reopen checks for all three fixtures on Windows 0.4.9 and later.

These changes do not add a general 3D editor, native dynamic-block behavior or every proprietary
CAD class. Unknown or unencodable retained data can prevent DWG saving; keep the original and use
DXF when the portable writer cannot prove preservation.

## [0.4.8] - 2026-10-12

### Upgrade notes

- Windows layouts now retain planar viewport view rotation from DWG and DXF. The model's
  coordinates stay intact. Perspective, tilted/reversed 3D views and nonrectangular viewport
  clipping still produce import warnings. macOS and Linux desktop updates remain paused at 0.4.5.

### Added

- **VPTWIST** sets an unlocked layout viewport's absolute view angle in degrees. A selected
  viewport frame also exposes **View rotation** in Properties. Positive angles turn the
  model counterclockwise on the sheet; viewport locks protect its view settings.

### Fixed

- Imported viewport rotation applies consistently to canvas display, vector/raster plotting,
  selection, snapping, coordinate conversion, pan, anchored zoom and zoom windows. Native
  arcs, text, block attributes, images and wide polylines turn with the viewport.
- DWG/DXF viewport centers are converted between display and world coordinates using their
  view target and twist. Saving and reopening retains the angle, model view center and scale
  without rotating the underlying entities.
- Window/crossing selection follows the visible screen rectangle in a rotated view, and
  layers frozen in the active viewport are excluded from picking and object snaps.
- Windows installed-release checks verify quarter-turn and oblique viewport save/reopen and
  model-coordinate preservation using the signed application on a runner without AutoCAD.

## [0.4.7] - 2026-10-12

### Upgrade notes

- Windows Save and Save As now support DWG without installed AutoCAD. Review import warnings
  before replacing an existing DWG, or use Save As to keep the original. macOS and Linux
  desktop updates remain paused at 0.4.5.

### Added

- Windows **Save As** offers DWG or DXF. A DWG saved with Save As becomes the working file,
  and **Save** writes subsequent edits back to it without installed AutoCAD. Opening a DWG
  retains its filename for normal saving.
- Normal DWG saves use the bundled AutoCAD 2018-format writer, independent round-trip checks,
  per-file save ordering, atomic replacement and an exact previous-file `.bak`. Conversion
  failures keep unsaved edits and recovery copies.

### Fixed

- Saving over an imported or recovered DWG warns about content JCad could not retain,
  including unreadable metadata. Choose Save As to preserve the original file.
- Explicit DXF export controls keep their DXF-only destination picker. **Export DWG copy**
  continues to create a separate copy without changing the working file or saved state.
- Windows installed-release checks exercise DWG Save As, in-place Save and semantic reopen
  on a fresh Windows runner that verifies AutoCAD is absent before installation.

## [0.4.6] - 2026-10-12

### Upgrade notes

- New desktop builds target Windows x64. macOS and Linux downloads remain at 0.4.5 while their
  updates are paused; the browser edition continues to receive supported renderer changes.
- Windows adds **Export > DWG copy** / **EXPORTDWG** without requiring installed AutoCAD.
  **SAVE** and **SAVEAS** still save the working drawing as DXF. Exporting a copy keeps its
  existing destination, unsaved edits, undo history and recovery state.

### Added

- A bundled native Windows writer produces AutoCAD 2018-format DWG (`AC1032`). It converts a
  captured DXF snapshot in a private directory and reopens the result to check supported
  entity, block, layout, geometry, text, attribute and appearance fields before committing it.
- Exports use native destination selection, per-file save ordering, atomic replacement and
  backups. Cancellation, conversion errors and concurrent destination changes preserve the
  existing file. Overwriting an imported original asks for confirmation when its import report
  records lost or unreadable content.
- The writer applies and verifies a Windows Job Object 1 GiB process-memory limit before
  parsing, with bounded input, record collections, diagnostics, output and conversion time.
  Unsupported retained 3D/ACIS content and verification differences refuse export.
- The build pins the Rust toolchain, dependency lockfile, upstream writer source and reviewed
  patches. Corresponding modified source and dependency notices accompany the helper. Publisher
  signing precedes its integrity manifest; the protected ASAR records the final helper hashes.

### Fixed

- Portable DWG copies reopen with their native entity transparency, Unicode color-book names
  and rectangular block-array attributes. The Windows package includes the appearance reader
  adapter and its matching, checked native runtime.

### Known limitations

- DWG copies contain the drawing JCad currently holds. They cannot recover content discarded or
  simplified during import. Review **IMPORTREPORT** and keep original files when fidelity matters.
- This is supported 2D interchange, with AC1032 output only. It does not establish universal
  compatibility with every DWG entity, application dictionary, dynamic block, field or font.
  A detected unsupported record or changed field refuses export; some valid drawings can exceed
  the memory or collection limits. See [DWG saving](docs/DWG-SAVING.md).

## [0.4.5] - 2026-10-12

### Upgrade notes

- DWG import keeps the 128 MiB input ceiling, with tighter parser and converted-result memory
  budgets. Some large valid files may be refused with a clear message; the current drawing stays intact.
- The browser edition is unchanged. Desktop DWG parsing now uses a separate process on every open.

### Fixed

- Desktop DWG files parse in a disposable utility process, with a separate heap-limited worker
  inside it. Native parser failures and worker heap exhaustion are isolated from JCad's main
  process. The worker's actual heap limit is checked before parsing; each file gets a fresh process.
- The WebAssembly engine enforces a 2 GiB linear-memory maximum, including direct WASM growth
  and initial allocation checks. Original vendor factory/WASM bytes and provenance stay intact.
- A parent OS-metrics watchdog stops the whole parser process at a sampled 3 GiB threshold.
  It remains active while native parsing blocks the child's event loop and fails closed when
  process metrics cannot be verified. Sampling can allow temporary overshoot; this is not an
  instantaneous OS memory allocation cap.
- The reader waits for positive startup measurements before loading the parser, including
  delayed Mac process metrics. Linux uses bounded parent reads of `/proc` resident/peak memory
  with process-identity checks rather than depending on undocumented Electron memory fields.
- DWG opens share one parser, at most four outstanding requests and 128 MiB of reserved input.
  Converted results are checked for metadata, string, record and nesting budgets, then transferred
  in acknowledged 1 MiB chunks with a 64 MiB result cap. Binary XDATA is preserved within those limits.
- Real Electron containment checks cover cancellation, damaged files, native-buffer growth and
  V8 exhaustion, followed by successful valid-file reads. Installer smoke tests additionally
  require the actual shipping executable to cancel, reject damaged data and reopen a valid DWG.
- Desktop settings are checkpointed atomically before migration is acknowledged and before an
  approved close or update restart. Immediate restarts preserve edits and deletions; an empty
  lost Chromium storage origin can recover the latest complete checkpoint. A failed settings
  write keeps closing cancelable and leaves the previous checkpoint intact.
- Normal DWG process teardown no longer creates a misleading crash-log entry. Unexpected
  crashes, memory exhaustion and other child-process failures remain logged.

### Known limitations

- Memory limits can refuse large valid drawings as well as damaged ones. DWG compatibility and
  the browser edition's memory safeguards retain the documented limits. Desktop process
  isolation is not an OS permissions sandbox or a strict cap on total system memory.

## [0.4.4] - 2026-10-11

### Upgrade notes

- DXF saves choose the version required by native drawing properties. RGB/named colors require
  AutoCAD 2004, MTEXT masks 2007, transparency 2010 and MTEXT frames 2018; ACI-only drawings
  keep AutoCAD 2000 output when no other property requires a newer version.
- macOS 13 Ventura or later remains required. Windows updates install after **Restart Now**;
  choosing **Later** and quitting normally does not install an update.
- Array cells share their attribute values. Explode an electrical array and assign separate
  tags when its copies need independent identities; the electrical audit explains this.

### Added

- Native TEXT, ATTDEF and ATTRIB justification retains both alignment anchors and all fifteen
  legal horizontal/vertical combinations, including an anchor at the origin. FIT retains height
  while fitting width; ALIGNED fits height and width together. Attribute placement overrides
  remain independent of their definitions through transforms, DXF save/reopen and vector PDF.
- Polyline start/end widths round-trip through DXF groups 40/41 and exposed DWG fields,
  including independent legacy POLYLINE defaults and explicit zero widths. Straight and bulged
  segments render tapered footprints used by bounds and hit testing; snaps stay on the centerline.
  Nonuniform and sheared width geometry can be saved through native nested block references.
- ACI, true-color RGB, supplied color-book names and ByLayer/ByBlock/explicit opacity survive
  supported imports, transforms, block inheritance, DXF persistence and canvas/PDF output.
  Native ATTDEF/ATTRIB overrides and LEADER annotation foregrounds keep their own appearance.
- Native MTEXT background fills and text frames retain padding, ACI/RGB/name fields and flags,
  including associated LEADER annotations. Window-color fills follow the drawing background;
  column gutters remain unmasked. Disabled settings use registered, bounded metadata that
  survives JCad save/reopen without emitting invalid inactive native fields.
- MINSERT rectangular arrays retain row/column counts, rotated drawing-unit spacing and shared
  attributes through DXF/DWG import and native DXF export. Nested arrays preserve affine geometry,
  and the Properties palette edits array dimensions with undo/redo and existing geometry limits.
- About, Report a Problem and the download page show the public support email
  `Justinrod04@gmail.com`. Desktop email links allow only that exact recipient; reports remain
  available through Copy Report and Save Report.
- A pinned native LibreDWG repair build validates fractional MTEXT mask scales and color-book
  strings with an independent seven-mask AutoCAD DWG. Matching factory/WASM bytes, corresponding
  modified source, checked patches and SHA-256 provenance accompany the candidate runtime.

### Fixed

- The Mac website download button offers an explicit Apple Silicon or Intel choice instead
  of assuming every Mac needs the Apple Silicon installer.
- Corrupt DWG files with critical native errors are rejected instead of opening as empty
  drawings. Failed native pointers and temporary inputs are cleaned up, and a later valid
  read starts with a fresh Node runtime; recoverable compatibility warnings still import.
- Fitted text axes follow their authoritative anchors under nonuniform and mirrored transforms,
  including inverse attribute placement. Associated LEADER text no longer inherits unrelated
  leader RGB, name or alpha when its own foreground uses defaults.
- Property edits commit once when a control loses focus during rerender, so one undo restores
  the previous value. Choosing an ACI color clears prior RGB/name overrides and retains opacity.
- DXF exports choose the highest native format required by any entity, layer, attribute or
  associated annotation: RGB/names require 2004, MTEXT fills 2007, opacity 2010 and frames 2018.
  Widths and arrays retain 2000 output when no other property requires a newer format.
- Desktop regression checks exercise all five CAD fixtures through actual open/save/backup/reopen,
  rendering, bounds and property undo. The AutoCAD oracle checks native width, color, array,
  text-anchor and attribute fields in addition to AUDIT and entity counts.

### Known limitations

- The repaired native reader validates the documented mask fields. Complete DWG compatibility
  is not established; converter omissions and ambiguous layer transparency remain.
- Supplied color-book identities do not load vendor palettes. MTEXT background transparency is
  retained with its unsupported effect reported, rather than applied. Fonts, vertical text
  offsets, MTEXT column flow and nonuniform MTEXT layout retain the documented approximations.
- Bulged width outlines use bounded sampling and beveled joins. Exported affine width wrappers
  reopen as block references and must fit the existing nesting/work budgets. MINSERT cells share
  attributes; distinct electrical identities require exploding and assigning separate tags.
- Existing file, geometry and worker limits still apply. The native repair does not establish a
  strict bound on total process/native memory or initial WASM allocation.

## [0.4.3] - 2026-10-11

### Upgrade notes

- **macOS 13 Ventura or later remains required.** Macs on macOS 11 or 12 should keep 0.4.1.
- **After installing 0.4.3**, signed Windows NSIS updates install only after **Restart Now**.
  Choosing **Later** and quitting normally does not install an update. macOS and Linux use
  manual downloads; older installed versions retain their own update behaviour.
- Drawings (DXF/DWG) are limited to **128 MiB** and project JSON files to **8 MiB**. Files and
  expanded geometry exceeding the supported limits are refused with an explanation.

### Fixed

- Saves and backups through linked folders, junctions and native path aliases identify the same
  destination. Writes to that destination run in invocation order; changing an alias while a
  write is queued refuses the write. Project-derived DXF paths keep their folder restrictions.
- Geometry budgets cover imports, edits, undo/redo, library changes and active or background
  project sheets before changing state or writing a batch. Rejected changes preserve the
  drawing and history; immutable accepted snapshots keep nested-block caches safe to reuse.
- Malformed DXF numeric tokens and HATCH collection counts cannot become plausible geometry
  or unbounded parsing loops. DXF/DWG HATCH and SPLINE work is checked before expensive
  tessellation or fit interpolation; the guard and sampler share the same integer sample plan.
- DXF exports retain imported `$AUNITS`, `$CELTSCALE` and `$TEXTSTYLE` values. Import reports
  disclose unsupported metadata and dimension settings, SHX font substitution, installed font
  rendering, and approximate text bounds/wrapping and MTEXT column flow.
- Native file choices and OS hand-over control project write grants. Image reads resolve real
  paths without extending access through a link outside permitted drawing folders.

### Security

- The renderer uses the secure bundled `jcad://app/index.html` origin, enabling Web Crypto.
  A bounded one-time migration carries legacy file-origin preferences over without running old
  application or plugin code. Production ignores development-server overrides.
- Drawing and project reads/writes have matching byte limits; recovery, library, plugin and
  catalog data are bounded too. Browser DWG parsing runs in a disposable worker with a 60-second
  deadline and cancellation; desktop DWG parsing remains in its bounded worker.
- Plugin trust is remembered only for a SHA-256 digest. Problem reports omit local paths and
  drawing names unless explicitly included. Trusted plugins still have full renderer access.

### Changed

- macOS update instructions describe manual DMG replacement and direct only blocked first
  launches to Privacy & Security; notarized builds ordinarily use the normal downloaded-app
  confirmation.
- Shipping binaries retain disabled command-line inspection throughout validation, with ASAR
  integrity checks and debugging-argument refusal. Full packaged Playwright tests use a separate
  unpublished test ASAR; exact shipping installers run independent save/restart, preference
  migration and DWG probes on each platform, including both macOS architectures.
- Publication requires verified Windows publisher signing and macOS Developer ID/notarization.
  Source-bound provenance includes shipping fuse evidence and every installer, updater feed and
  external blockmap. Aggregate verification also runs in build-only rehearsals; release notes
  use the verified signing status and the complete published set receives a GitHub attestation.
- Performance gates measure cold state acceptance, first geometry preparation and first render,
  actual full redraws versus cached cursor frames, and filesystem reads, parsing and reports for
  a reproducible 20-sheet project. Node.js 22.20+ and 24.12+ are supported within those majors.

### Known limitations

- DXF/DWG interchange remains limited to the documented support matrix. The regression exports
  were checked with AutoCAD 2027 AUDIT and normalized entity counts, which does not certify
  arbitrary drawings or complete CAD compatibility. Automatic MTEXT column flow remains
  approximate; native/WASM total memory is not strictly capped.

## [0.4.2] - 2026-10-11

### Upgrade notes

- **macOS 13 Ventura or later is required.** On macOS 11 Big Sur or 12 Monterey do not install
  this version (it does not start there): keep JCad Electrical 0.4.1, whose disk images stay on
  https://github.com/habit04/share/releases/tag/v0.4.1. Version 0.4.1 offers this update on every
  Mac; from this version on, a Mac older than a release needs is no longer offered its download
  (the release's `latest-mac.yml` names the minimum macOS version).

### Security

Findings of `docs/SECURITY-REVIEW.md` closed after 0.4.1 (the Status table there has the
decisions and tests). Several are ported and adapted from the draft pull request #2.

- Electron 44.7.0 (was 33.4.11, out of support; E-2): current Chromium, V8 and image decoders
  for the drawings' IMAGE files, and the Electron runtime advisories that `npm audit` listed are
  gone. **macOS 13 Ventura or later is now required** (0.4.1 ran on macOS 11 and 12); Windows 10
  and the Linux packages are unchanged. Vitest 5 (was 2.1.9) for the unit tests; development
  supports Node.js 22.20+ or 24.12+ within those major versions, tested in both CI jobs.
- Saves do not follow symbolic links (E-5): a drawing, project or backup whose file is a
  symbolic link is not saved over (the message suggests Save As), the temporary file is created
  exclusively, and the folder is checked again just before the rename. Folders reached through a
  link or junction save normally, also on drives that cannot report a file's final path (RAM
  disks, some network and virtual drives); a project opened by name keeps its drawings' saves
  inside its folder, also after a restart. Writes through different folder aliases of one
  destination share an invocation-ordered queue; retargeting an alias while queued refuses the
  write instead of saving somewhere else. DXF files derived from project DWGs retain the same
  folder restriction.
- DXF text is parsed in linear time (E-6): trailing spaces, field expressions and unknown MTEXT
  escapes no longer take quadratic time on crafted input.
- DWG reader limits (E-7): 128 MiB per file, desktop worker V8 limits of 2048/64/8 MiB
  (old generation/young generation/stack), and 60 s plus 1 s per input MiB to read. A 2 GiB
  per-memory JavaScript growth guard covers the shipped LibreDWG allocator; it does not bound
  total process/native memory or initial WASM allocations. Browser workers have a 60 s deadline
  and no explicit heap/WASM cap. DWG files are never parsed in the main process. Drawing,
  project, image and pack reads in the main process are size-checked on one file handle, and a
  named pipe under a file's name is refused at once instead of blocking the read (and the exit).
- Updates (E-8): the downloaded installer is checked again by the application (SHA-512 from the
  release metadata, and the publisher signature of a signed Windows installation) right after the
  download and just before an explicit Restart Now; a failed check installs nothing. Ordinary
  quitting never installs an update. A postponed update can be revisited through Check for Updates.
- Web permissions are denied (E-12) except clipboard writes from the application page, and
  every window (also the hidden plot and print windows) refuses pop-ups, navigation and
  `<webview>`.
- Drawing candidates exceeding 100,000 work units per insert, 1,000,000 expanded model/layout
  units or the separate 1,000,000-unit block-definition budget are refused before changing state
  (E-13). Imports, edits, libraries, project batches and undo/history restoration share these
  checks. Accepted snapshots are immutable; block expansion caches track nested dependencies.
- Renderer hardening (E-15): stricter Content-Security-Policy (`base-uri`, `object-src`,
  `frame-src`, `form-action`), developer tools only in development builds, and Electron fuses in
  the installers (no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no `--inspect`, app code only
  from `app.asar`), checked by the packaged smoke test.
- Problem reports leave out local paths and the drawing name unless you tick **Include local
  file paths and the drawing name** (E-16).
- Plugins: only a SHA-256 digest remembers a trust answer, and the plugin trust model is
  documented in `docs/PLUGIN-API.md` (E-10). Catalog pack keys are looked up as own properties
  (E-17); plot and print sheets are at most 200 inches a side (E-18).

### Added

- DXF: dimension styles keep their decimal separator (DIMDSEP), text style (DIMTXSTY),
  dimension and extension lineweights (DIMLWD / DIMLWE), tolerance zero suppression (DIMTZIN)
  and the `[]` placeholder of DIMAPOST; a dimension's own changes to its style (DSTYLE
  overrides) are read and written. Xref-dependent layer flags are kept.
- DXF: tables take their TABLESTYLE's text heights, alignment and cell margin; IMAGE entities in
  layouts keep their file name. MTEXT column definitions (static and dynamic) survive through
  `JCAD_MTEXT_COLUMNS` extended data, and explicit column breaks render separately. Automatic
  flow by column height remains approximate; external AutoCAD 2000 readers display one column.
- DXF output that AutoCAD's AUDIT accepts: 2D drawing limits, the plot style dictionary the
  layers refer to, every text style a dimension or text names, dimensions inside blocks with
  their picture block, non-associative hatches.
- Release provenance: each build records the commit, version, signing status and the SHA-256 of
  every installer; the release job verifies them against the tested commit, publishes
  `release-provenance.json` and `SHA256SUMS.txt`, and has GitHub attest the artifact set. The
  uploaded set (installers, their blockmaps and the update feeds) is verified in every run of the
  release workflow, a rehearsal without a tag included.
- Performance budgets for loading, a full redraw (at extents and zoomed in), the cursor-only
  frame, hovering and window selection on the 50,000-entity drawing, asserted in CI and in the
  release checks (`scripts/bench-budgets.mjs`).
- `tests/fixtures/manifest.json` with `npm run check:fixtures` (run before `npm test`): a missing
  committed fixture fails the tests instead of skipping them.
- End-to-end checks: saving through a linked folder, an image next to a drawing known by a
  linked path, a refused symbolic-link destination, denied web permissions with clipboard writes
  still allowed, and the raster PLOT placed edge to edge.

### Changed

- Shipping installers disable Electron command-line inspection and reject debugging arguments.
  Full packaged Playwright coverage uses a separate unpublished test ASAR; shipping installers
  verify binary fuses and run bounded save/restart and preference-migration probes.
- Release publication requires configured Windows publisher and Apple Developer ID/notarization
  credentials. Empty-tag rehearsal builds can still run without them and report their actual status.
- Performance gates measure first state acceptance, first geometry preparation and first render
  before warmup, plus filesystem reads/parsing and all reports for a reproducible 20-sheet project.

- Large drawings: frames that only move the cursor reuse the drawn scene, and the spatial index
  is built shortly after an edit instead of on the first hover. Reports find rung references
  with a sorted index instead of a scan per row.
- Cached block expansions (and the spatial index) follow the blocks nested inside them, so
  redefining or undoing a nested block no longer leaves stale geometry or picking.
- The screenshot runner scans its output by whole lines across chunks; a failure marker split
  between two chunks is no longer missed.
- Maintainability (reliability review item 26), with no change in behaviour: the three largest
  source files are split by responsibility, and every existing import keeps working through the
  original file. `src/io/dxf.ts` (2783 lines) re-exports the DXF reader and writer from
  `src/io/dxf/` (tokenizer, shared codecs, one module per side for the core, the entity codecs and
  the sections); `src/app/editor.ts` (1685 lines) re-exports the `Editor` from `src/app/editor/`,
  whose class delegates to one module per responsibility (commands, prompter, selection, pointer,
  keyboard, view, documents and tabs, saves, project, plot); `electron/main.cjs` (1111 lines) wires
  the modules under `electron/main/` (app-data files, window and close workflow, menu, DWG reading,
  IPC for drawings, plot, stores and updates, files handed over by the OS) and stays the only place
  that creates the IPC guard and the path registry. The module map is in `docs/DEVELOPMENT.md`.
- Module boundaries: the drafting commands and the Symbol Builder palette no longer cast the
  Editor to reach its private members (`notify` and the new `setHover` instead); tests keep the
  Drawing's undo history (also in `scripts/`, `e2e/` and `electron/`), the Editor's private members
  and Electron's own `ipcMain` behind their supported APIs.

### Fixed

- Geometry budgets now cover edits, history restoration, library changes and background project
  tabs. Accepted snapshots are sealed before cache reuse; rejected changes preserve document and
  history state. UI commands report budget refusals and API callers receive the error.
- Spline work guards and tessellation share one integer sample plan, including fractional sampling
  requests, so the guard counts the same work the sampler performs.
- DXF and exposed DWG headers retain $AUNITS, $CELTSCALE and $TEXTSTYLE source values on export.
- Font import warnings distinguish installed TrueType/OpenType rendering from SHX stroke-font
  substitution and disclose the shared approximation used for bounds and text wrapping.

## [0.4.1] - 2026-10-11

### Added

- Download alerts: an hourly GitHub Actions workflow (`download-alerts.yml`, `scripts/download-alerts.mjs`)
  compares the release download counters with the last run and comments on the "Download tracker"
  issue when an installer was downloaded, so subscribers get a GitHub notification or e-mail.
- Release gates: `release.yml` runs a `checks` job (workflow validation, lint, all type checks, unit
  tests, build, UI click check, screenshot comparison, Electron end-to-end) on the exact release
  commit; the installers are built from that commit only after it passed, every installer is then
  installed or extracted on its own OS and smoke-tested as a packaged application (`packaged-smoke`
  job, `scripts/packaged-smoke.mjs`: NSIS silent install, `.dmg` via `hdiutil` on macOS for the
  first time, AppImage and `.deb` extraction), and the release is published only when the tag
  still points at the tested commit. The signing steps are unchanged.
- `scripts/e2e-electron.mjs --packaged <executable>` (`npm run e2e:packaged`) runs the end-to-end
  checks against an installed application; new checks for SAVEAS, AUTOSAVE / recovery copies, the
  large-DWG progress dialog and Cancel, and the IPC guard. CI runs the end-to-end test on macOS too.
- Manual workflows: **Packaged smoke test (existing release)** for the installers of a published
  release, and **Screenshot baselines** to regenerate the approved screenshots on the CI browser.
- Approved screenshots: `screenshots/baseline/` with `npm run screenshot:compare` (pixelmatch with a
  per-image tolerance, masks and diff images uploaded by CI) and `npm run screenshot:approve`;
  screenshot pages run with a fixed time zone, locale and calendar date.
- Development setup: Node 22 declared in `package.json` `engines`, `.nvmrc` / `.node-version`, and
  `engine-strict` in `.npmrc`; `docs/DEVELOPMENT.md`.
- Static checks: ESLint flat config with typescript-eslint for `src/`, `tests/`, `electron/`,
  `scripts/` (`npm run lint`), `tsconfig.electron.json` and `tsconfig.scripts.json` (checkJs) with
  `npm run typecheck:all`, and `npm run check:workflows` (js-yaml); all run in CI.
- Performance: `tests/perf-dense.test.ts` (`npm run bench:node`: 50,000-entity drawing with and
  without the spatial index, 20-drawing project reports) and `scripts/bench.mjs` (`npm run bench`:
  rendering, hover and window selection in Chromium); numbers in `docs/PERFORMANCE.md`.
- Documentation: `docs/SUPPORT-MATRIX.md` (what survives DXF / DWG import and export),
  `docs/RELEASE.md` (cutting, verifying and delivering a release; dependency review checklist) and
  `docs/SECURITY-REVIEW.md` (security review of the desktop shell and file readers, with the status
  of each finding).
- Application icon: a relay contact on the JCad blue tile, for the installers and the installed
  application (Start menu, dock, desktop entry), the application page and the website
  (`scripts/make-icons.mjs`, `npm run icons`, generated as SVG, PNG, `.ico` and `.icns`; a unit test
  re-renders it and compares). The 0.4.0 installers used Electron's default icon.
- File associations: the installers register JCad Electrical for `.dxf` drawings and
  `.jcadproj.json` projects, and a project file handed over by the operating system (a
  double-click, "Open with", a second launch) opens as the current project.
- Release notes: the GitHub release body is the tag's section of this changelog plus download notes
  (`scripts/release-notes.mjs`, used by `release.yml`, which stops when the tag has no section);
  `docs/releases/v0.4.0.md` holds the notes for the 0.4.0 release page.

### Changed

- Hit testing, window / crossing / fence / polygon selection and the object-snap search use a
  spatial index (`src/core/spatial-index.ts`) on drawings of 2,000 entities or more, with exactly
  the same results: picking on a 50,000-entity drawing went from 15-40 ms to under 0.02 ms.
- The Electrical Audit counts wire ends through the same index and computes symbol outlines
  once: the project-wide reports over 20 dense sheets went from about 147 s to 5-10 s, with
  identical output.
- DWG files are parsed in a worker thread in the main process instead of on its event loop; files of
  1 MB or more show a progress dialog with Cancel.
- The plugin loader reports a plugin whose load throws, never settles (30 s) or whose trust prompt
  fails, marks it failed and loads the next one; uncaught errors from a plugin's timers or promises
  are reported with its name. `docs/PLUGIN-API.md` now says plainly that plugins run in the
  application page with its globals, lists their capabilities and the isolation options considered.
- Drawing has a supported undo-history API (`history()`, `restoreHistory()`, `undoLimit`); the
  drawing tabs, the Symbol Builder and tests no longer reach into its private fields.

### Security

- Every IPC handler checks its caller: only the application page in the main window's top frame
  may use the bridge; other senders are refused and logged in `<app data>/ipc-rejections.log`.
- File paths from the renderer go through one policy: open / save / back up by name only for files
  the user chose and the drawings of a project (see the project entry under Fixed); `read-image`
  only for images next to such a file or named by an opened drawing; plugin and catalog-pack files
  must stay inside their folders after symbolic links are resolved.

### Fixed

- Project-wide commands (AEXREFPROJECT, AERETAGPROJECT, AEWIRENOPROJECT, AETITLEBLOCKALL) no
  longer overwrite a drawing whose requested `.bak` copy failed: the drawing is skipped and listed,
  unless you choose **Continue Without Backup** in a dialog that names the file.
- Project-wide commands apply their changes only to the drawing revision they were calculated
  from: a tab edited while the command ran, a closed drawing that changed on disk or was opened in
  a tab meanwhile, or a file saved again in between is reported as a conflict and left alone.
  Switching tabs while closed drawings load no longer mixes up the current drawing.
- The project has its own modified flag (properties, drawing list, catalog file, report templates,
  title block mapping), an autosave with **Project Recovery** at the next start, and
  Save / Don't Save / Cancel before `OPENPROJECT`, the new `NEWPROJECT` and closing.
- Closing the window, quitting and restarting for an update show one **Save Changes** dialog for
  every modified drawing tab, Symbol Builder tab and the project (Save All / Discard All / Cancel,
  per-item choice); items are saved one after another and a failure keeps the window open. The
  main process waits for the answer instead of closing after three seconds, and Save no longer
  saved only the active drawing. A Symbol Builder tab counts as saved once the user library file is
  written, and drawings changed by the saves themselves (a symbol save updates the drawings that
  use it) are asked about again, as is anything you change while Save All is still saving (the
  window stays usable meanwhile): Save All may then ask a second time instead of closing without a
  question. The drawing and project autosaves being written, and the removal of the backups of
  drawings just saved, finish before the window closes (a few seconds at most).
- File paths are normalised in one place (`src/app/paths.ts`): separators, `.` / `..`, Unicode,
  case-insensitive comparison for Windows paths. Projects, tabs ("is this drawing already open"),
  recent files and the main process's allowed-path list use it, and drawings with the same file
  name in different folders are no longer confused (they show their folder, e.g. `a.dxf (line1)`).
- `PROJECTSAVEAS` (new) into another folder recalculates relative drawing and catalog paths so they
  still point at the same files; `PROJECTSAVE` writes to the project's own file without a dialog.
- A slow open finishes in the tab that started it even if you switch tabs meanwhile (or opens in
  a new tab if that tab was edited); `RECENT` no longer replaced the active drawing when the file
  took a moment to load. Saves to the same file are queued, and an older save never overwrites a
  newer one: `SAVEAS` asks for the file name first and then waits for a save of that file still on
  its way, and a slower, older save of a drawing no longer moves the drawing back to its file or
  marks it as saved while the file holds the older version. A drawing name typed without `.dxf` in
  the Save As dialog (or a project name typed without `.json` in Save Project As) gets the extension,
  and when a file of that completed name already exists, Save As asks before replacing it (Windows
  and macOS complete the name in the dialog itself and ask there; the Linux file dialog asks only
  about the name as typed).
- Saves are crash-safe: drawings (`SAVE`, `SAVEAS`, project-wide updates), projects and other
  exports, plotted PDFs, autosaves, the user symbol library, catalog packs, the recent list and the
  window state are written to a temporary file in the same folder, flushed to disk and renamed over
  the destination (with retries and a copy fallback when Windows briefly locks the file). Saving over
  a drawing or project keeps the previous version as `<name>.bak`. An interrupted save can no longer
  leave a truncated file as the only copy.
- The project-wide `.bak` copy (`backup-file`) goes through the same temporary file + rename and
  reports `{ ok: false, error }` with a clear message when no complete copy could be made, instead
  of failing silently (what happens to that drawing is described above).
- Autosave backups are named after a permanent per-document id instead of the drawing title and
  a session number that restarted every launch, so a new session can no longer overwrite a backup
  that was not recovered yet. `autosave/index.json` keeps the title, path and time of each backup;
  backups from 0.4.0 are migrated on the first start (the project's autosave keeps its own name, so
  Project Recovery finds it after a crash).
- Autosave records exactly the revision it wrote: edits made while a backup is being written are no
  longer treated as backed up. Autosave runs never overlap (a request during a run queues one more),
  and Save, Close and quitting wait for a write in flight. A completed save removes the backup only
  when the drawing was not changed again after that save.
- Switching drawing tabs no longer clears the target drawing's "modified" flag and undo history (the
  file tabs read the session list while the tab was being loaded), which also made a drawing opened
  from the Recovery Manager look saved and could delete its backup.
- Drawing Recovery Manager: Discard All deletes only the backups still listed (never one opened in
  this session), a double click opens a backup only once, and the buttons are disabled while an
  action runs. An unreadable recovery folder shows an error with Retry instead of an empty list.
  `DRAWINGRECOVERY` (`DRM`) opens the manager at any time.
- Save errors explain the cause (disk full, permission or read-only, locked file, folder or network
  drive not available, path too long) for every save: drawings, the project, project-wide updates,
  CSV / report / `.wdt` / symbol library exports, plotted PDFs and the problem report are reported
  on the command line (and in the dialog that started them) instead of being lost as an unhandled
  error. A drawing that cannot be opened because its file or folder is gone is described the same
  way. `SAVE`, `SAVEAS`, `PROJECTSAVE` and `PROJECTSAVEAS` offer Retry, Save As... and Cancel; the
  drawing or project stays modified and its autosave backup is kept when a save fails.
- Opening a DXF or DWG file reports everything it could not bring in unchanged: an Import
  Report (counts per type, the first 50 objects with handle, layer, place and reason, Copy
  Report; `IMPORTREPORT` shows it again) instead of silent loss, also when the drawing finished
  opening in a background tab. Saving over a source file that
  held such content asks first and offers Save As.
- Unknown DXF entities that can be kept safely (3D faces, and 3D solids / regions / bodies with
  inline data) stay in the drawing and are written back verbatim on their layer at the end of
  the entities on save, through undo and through project-wide rewrites.
- Damaged DXF files are rejected with the line and the reason (non-numeric group codes,
  unbalanced SECTION / ENDSEC, content outside sections) instead of opening half-read; a file
  that ends early offers to open what was readable and is marked as recovered. The same applies to
  a backup opened from the Drawing Recovery Manager; project-wide reports read such a closed drawing
  as far as it goes and say so on the command line, and project-wide updates leave it unchanged.
  Objects with NaN / infinite coordinates, negative radii or fewer than two polyline vertices are
  left out and listed instead of becoming geometry at the origin.
- DXF layers with the Default lineweight (370 = -3) read as 0.25 mm instead of a negative width.
- DXF arcs, circles, polylines and block references with extrusion (0,0,-1) (mirrored objects)
  open in their true place instead of mirrored; other non-planar objects are reported.
- DWG import keeps paper-space layouts with their entities and floating viewports, text styles,
  named dimension styles (used by the dimensions that name them), custom linetype patterns,
  true colours of objects and layers, ByBlock colours, the plot flag of layers, and 3D
  polylines (flattened). DWG layers are no longer all imported as locked. What the DWG reader
  cannot see (page setups, per-viewport frozen layers, fixed text heights) is listed in the
  Import Report.
- Block colours: ByBlock (0) is no longer confused with ByLayer (256). ByBlock content takes the
  block reference's colour (or its layer's colour when the reference is ByLayer), nested blocks
  resolve outwards, layer-0 ByLayer content shows the reference layer's colour, explicit colours
  are untouched; the same on screen, in vector PDF plots and with EXPLODE.
- Library symbols stay recolourable from their block reference under that rule: the built-in
  JIC / IEC / vertical libraries and the Symbol Builder draw symbol geometry ByBlock on layer 0
  (it was ByLayer). Symbols saved earlier are converted when a drawing or the user library is
  loaded (the library file is rewritten only with the next change to it); blocks from other
  programs are not touched.
- Undo / Redo no longer revert settings that are documented as not undoable (drawing header
  variables, the current layer, the active layout / viewport and viewport zoom, library blocks);
  the rules per setting are in the user manual.
- `new Drawing({...})` keeps the header, the active space and every other field it is given.
- Clicking where overlapping objects are equally close selects (and highlights) the topmost one
  instead of the one underneath.
- A project file can no longer give the program permission to overwrite anything but drawings: of
  the files a project lists, only `.dxf` / `.dwg` drawings (checked after `..` in the path is
  resolved) can be written by `SAVE` and the project-wide commands, never its catalog file or any
  other file type, and drawings on a network share only when the project is on that same server.
  Drawings outside the project's folder are written when you opened the project yourself (Open
  Project, a double-click or "Open with", Recent Documents); for a project opened only by its path
  (a plugin, `OPENPROJECT <path>`) they are saved only after you confirm them in the Save As dialog.
  Saving a drawing writes only `.dxf` files and saving a project only `.json` project files.
- Text from drawing files and plugins is always shown as text: the annotation scale name in the
  status bar and the titles of dialogs (file, layout, symbol and plugin names). An annotation
  scale in a DXF header that is not a plain scale name is ignored.
- Opening a drawing no longer makes the program connect to another computer to load its images:
  images on a network share are loaded only for drawings opened from that same server.
- Links opened in your browser (About, Report a Problem, updates) are checked after the address is
  normalised, so they can only lead to this project's GitHub pages or the donation page.
- "Open with JCad Electrical" and drawings handed to a second launch (or, on macOS, opened from
  the Finder) open in their own tab; they were ignored.
- `CLOSE` closes the tab it asked about: when another tab closed while its "Discard changes?"
  question was shown (a background open that failed), it could close a different drawing, with its
  unsaved changes and backup, without asking.
- A file picked in the Open dialog that is already open, or `RECENT` clicked twice while the file
  loads, shows its tab instead of opening a second copy whose saves would overwrite each other. An
  open that lands in a new tab while you work in another tab stays in the background. Files that
  fail to open are no longer added to Recent Documents.
- Closing: after Cancel in the "not responding" question, the Save All dialog the page shows once it
  responds again is honoured; a restart for an update that does not happen no longer leaves the
  window closing without the unsaved-work question; Discard All removes the project autosave (the
  next start no longer offers the discarded changes).
- Project-wide commands: **Continue Without Backup** now writes the drawing when its `.bak` cannot
  be written (a folder or locked file in the way made the write fail again), and a truncated closed
  drawing is listed as damaged ("OPEN it to recover") instead of as a file error. Closed drawings
  left unchanged because you unticked saving closed files are listed on the command line ("Not
  updated (closed drawing files were not saved, as chosen): ...") instead of being left out of the
  summary. Failed CSV, report and `.wdt` exports name the file and folder chosen in the Save dialog.

## [0.4.0] - 2026-09-29

### Added

- `LICENSE` with the full text of the GNU General Public License version 3, and
  `"license": "GPL-3.0-only"` in `package.json`.
- `THIRD-PARTY-NOTICES.md` listing every runtime and development dependency with its licence,
  copyright holder and link, the Hershey font notice, the LibreDWG and Electron / Chromium
  notices and the licence texts that must travel with the installers.
- This changelog and a user manual (`docs/USER-MANUAL.md`).
- Help > About shows "Licensed under the GNU GPL v3 · Third-party notices"; both links open
  the files on GitHub through the same allowlisted link handler as the other About links.
- Drafting entities: `SPLINE` (fit points with start / end tangents and Close, or control
  vertices with a degree), `HATCH` (internal point with boundary detection, selected closed
  objects or a drawn boundary; ANSI31-38, NET, NET3, DOTS, LINE, BRICK and SOLID, scale, angle,
  origin) and `HATCHEDIT`, `LEADER` / `QLEADER` and `MLEADER` (arrowhead, straight or spline
  leader, landing, multi-line text), `TABLE` and `TABLEEDIT`, `FIELD` and `UPDATEFIELD` (Date,
  CreateDate, SaveDate, PlotDate, Filename, Title, Subject, Author, Keywords, Comments,
  LastSavedBy, Login). EXPLODE, LIST, grips, snaps and the Properties palette know the new types.
- IMAGE entities and external references are read and written; the desktop app draws image
  bitmaps (`.png`, `.jpg`, `.gif`, `.bmp`, `.webp` up to 50 MB) through a read-only bridge that
  resolves relative paths against the drawing folder; xrefs draw as a named frame.
- MTEXT format codes are drawn: colours, heights, width factor, oblique, bold / italic,
  underline / overline / strike-through, stacked fractions and tolerances, paragraph alignment.
- Dimension styles: arrowhead types (closed filled, closed blank, closed, open, oblique,
  architectural tick, dot, small dot, blank dot, none; separate first / second arrows), text
  placement (DIMTAD, DIMJUST, DIMTIH / DIMTOH), extension and dimension line suppression,
  DIMDLE, fit options, DIMPOST prefix / suffix, rounding, measurement scale, zero suppression,
  alternate units (after or below the primary value) and symmetrical, deviation, limits and
  basic tolerances; named styles saved in the drawing.
- `DIMSTYLE` opens the Dimension Style Manager (Set Current, New, Modify, Compare, Delete; the
  style editor has Lines, Symbols and Arrows, Text, Fit, Primary Units, Alternate Units and
  Tolerances tabs with a live preview); `-DIMSTYLE` (and DIMSTYLE with an option)
  Save / Restore / STatus / Variables / Apply / ? on the command line. Every DIM* variable of the
  style is a command.
- `DIMBASELINE`, `DIMCONTINUE`, `DIMTEDIT` and `DIMEDIT`, and Annotate > Dimensions ribbon
  buttons for Baseline, Continue, Text Edit, Dim Edit and Dim Style.
- DXF: every named dimension style is written as a DIMSTYLE record and read back (arrowheads,
  basic tolerances and alternate-unit placement in `JCAD_DIMSTYLE` XDATA; arrow blocks of other
  programs' records are resolved from their handles); the current style's `$DIM*` header
  variables include `$DIMBLK`, `$DIMBLK1`, `$DIMBLK2`, `$DIMSAH`, `$DIMTOL`, `$DIMLIM`, `$DIMTIH`,
  `$DIMTOH` and `$DIMZIN`; DIMENSION groups 52 (oblique) and 53 (text rotation) round-trip.
- DWG: the remaining DIM* header variables (arrows, tolerances, alternate units, text placement,
  fit, colours, DIMPOST / DIMAPOST, DIMRND, DIMLFAC, DIMZIN ...) are applied to the current style.
- Project-wide electrical tools: `AEXREFPROJECT`, `AERETAGPROJECT` (all tags or duplicates only),
  `AEWIRENOPROJECT` (sheet-based or per-drawing start numbers). Open drawings change in their
  tabs; closed drawings are listed for confirmation and saved as DXF, optionally with a `.bak`
  copy. A problem list shows contacts without a parent and duplicate parents.
- `AEFIXTAG` and a Fixed tag checkbox in Edit Component (`TAGFIXED`); retagging keeps fixed tags.
- `AELOCVIEW` Location View: components by installation / location over the project with
  jumpers, zoom-to, CSV and Put on Drawing.
- `AEPLCIO` imports PLC I/O from a CSV / TSV spreadsheet (preview, modules, point descriptions,
  optional device rungs) and `AEPLCIOEXPORT` writes the drawing's I/O points back to CSV.
- Cables and jumpers: `AECABLE` (cable tag, type, conductor numbers or colours, `WD_CABLE`
  markers with FROM / TO), `AECABLESCHEDULE` (Cable Schedule report), `AEJUMPER`, `AEJUMPERDEL`.
- Report templates saved in the project file: `AEREPORTTEMPLATES` and `AEREPORTRUN <name>`
  (columns and order, sort, filters, title, drawing or project scope, dialog / table / CSV
  output).
- Title block mapping in the project (`.wdt` format, Project Properties > Title Block Mapping
  tab), `AETITLEBLOCKALL`, `AEWDTIMPORT` and `AEWDTEXPORT`.
- The Project Manager shows installation / location codes and the cross-reference status per
  drawing, and its context menu runs the project-wide commands. Project Properties is tabbed
  (General, Description Lines, Title Block Mapping).
- Panel hardware: `AEDINRAIL` (TS35 / TS32 / TS15), `AEWIREDUCT` (1x1 to 4x4 in with cover lines),
  `AEPANEL` (standard or custom enclosure with mounting plate, hinges and door swing),
  `AEPANELGRID`, `AEFOOTPRINTALIGN`, `AETERMFOOTPRINT` (terminal strip footprint from the terminal
  table) and `AEPANELHW`; a Panel Hardware report (`AEREPORT panelhw`); ribbon panels for the
  project-wide, cable / jumper / PLC I/O and panel layout commands.
- 41 hand-drawn JIC vertical symbols (`VPB11_NO`, `VCR1`, `VTD1_NO`, `VXF1` ...) and 12 IEC
  `NAME_V` symbols, used by the icon menu's Vertical choice.
- Symbol Builder: an insertion prompt, invisible / constant / verify / preset flags, text height
  and justification per attribute, reordering, attribute template buttons and a pre-save
  checklist. Insert Component asks for the other attributes of user symbols in block order.
- DXF: attribute definitions keep the constant, verify and preset flags.
- Metric drawings: the WD_M `UNITS` value (or `$INSUNITS`) makes symbols, junction dots, ladders,
  3-phase inserts, circuits, wire numbers and sheet templates scale by 25.4; `WDUNITS` and a
  Drawing Units page in Drafting Settings switch a drawing, optionally rescaling it
  (`docs/METRIC.md`).
- DXF code pages: files are decoded by byte order mark, `$ACADVER` and `$DWGCODEPAGE` (desktop
  and browser), `\U+` / `\M+` escapes are decoded, and the writer escapes non-ASCII text. STYLE
  records round-trip and TEXT / MTEXT with a TrueType style are drawn in that font.
- High-DPI drawing area: the canvas follows the device pixel ratio and redraws when it changes.
- Localization: interface strings go through a translation table; Options > Display > Language
  (System default, English, partial Spanish).
- Plugins: the `jcad` plugin API (also `window.jcadApi`), plugins loaded from the `plugins`
  folder in the app data folder after a one-time confirmation, `PLUGINS`, `PLUGINLOAD`,
  `PLUGINRELOAD`, `SCRIPTRUN`, `docs/PLUGIN-API.md` and three example plugins in
  `examples/plugins/`.
- LIST shows spline, hatch, leader, table and image properties and the text style of TEXT / MTEXT.
- Paper-space layouts: `Model | Layout1 | +` tabs under the drawing with a right-click menu (New
  Layout, From Template, Delete, Rename, Move or Copy, Page Setup Manager, Plot); `LAYOUT`
  (New / Copy / Delete / Rename / Set / ? / Template), `LAYOUTWIZARD`, `PAGESETUP`, `MODEL`,
  `TILEMODE`, `MSPACE`, `PSPACE`; a Layout panel on the View tab.
- Floating viewports: `MVIEW` (two corners, Fit, ON / OFF, Lock), `MVSETUP`, `VPSCALE`. Double-click
  inside a viewport to work in it and outside to return to the paper; zooming inside an unlocked
  viewport changes its view; viewport frames move, stretch, copy and erase like objects.
- Annotation scale: `CANNOSCALE` (also a status-bar list), `ANNOALLVISIBLE` and `OBJECTSCALE`;
  annotative text, dimensions, leaders and blocks keep their paper height. The status bar's MODEL
  button shows PAPER in a layout and switches between the paper and the current viewport.
- DXF paper space: `*Paper_Space` blocks, VIEWPORT entities, LAYOUT objects in `ACAD_LAYOUT`,
  `$CANNOSCALE` / `$ANNOALLVISIBLE` and `AcadAnnotative` XDATA are written and read; layouts made in
  AutoCAD are imported with their viewports. Non-rectangular viewport clipping is not supported.
- Vector PDF plotting: real paths, text, hatches, images and dashed linetypes, one page per sheet
  (the current tab or all layouts), plot style tables (monochrome, grayscale, colour, screening),
  plotted lineweights, and hidden / frozen / no-plot layers left out. Layers have a no-plot flag
  (DXF group 290).
- CI: a UI click check (every command and clickable control of the built renderer), the
  screenshot scripts as gates and an Electron end-to-end test on Ubuntu and Windows.
- Signing: the Windows build is signed through Azure Artifact Signing and the macOS build with a
  Developer ID and notarized when the corresponding repository secrets exist
  (`docs/CODE-SIGNING.md`).

### Changed

- PLOT and PRINT open the same Plot / Print dialog with two outputs: "Plot to PDF" writes the
  file and "Print…" opens the print dialog where the printer is chosen.
- When the active tab has no visible objects, the Plot / Print dialog explains what to do and
  both buttons are shown disabled; disabled dialog buttons now have a visible disabled style.
- Browser edition: Plot to PDF builds the PDF in the page (the rendered sheet as a single-page
  PDF sized to the chosen paper, lossless with a JPEG fallback) and downloads it, so the
  desktop application is no longer needed to plot.
- Browser edition: PRINT uses a hidden frame instead of a pop-up window, so no pop-up
  permission is needed and the page size matches the sheet.
- PLOT writes a vector PDF by default; the Plot dialog's "PDF output" still offers a raster image.
  In a layout the dialog uses the layout's page setup, and PRINT prints the layout's sheet.
- Radius and diameter dimension text is horizontal unless the style asks for aligned text.
- DIM* variable commands accept BYLAYER / BYBLOCK for the dimension colours.
- The current dimension style read from a DXF is the header variables applied over the named
  style of the same name (not the header variables alone).
- Dimension lines, extension lines and text are drawn in their DIMCLRD / DIMCLRE / DIMCLRT
  colours in the drawing area.
- A cable conductor runs from device to device: FROM / TO are the device pins at the two ends
  of the wire segment (rails show as L1 / L2), not the far ends of the whole net.
- A selected solid hatch is drawn with a lighter fill so its boundary shows.
- When a page's Content-Security-Policy blocks plugin code and no desktop bridge is available,
  the plugin error says so.

### Fixed

- Hatch pattern definition lines stored in a DXF are used as saved (ISO scales, double
  hatches) instead of being replaced by the built-in definition.
- DXF text chunks keep their trailing spaces (a 250-character MTEXT chunk may end in one).
- `$DIMTIH` / `$DIMTOH` in written DXF files match the style instead of always being 1.
- Cable markers are no longer counted as components in reports.
- DXF files opened in the browser edition are decoded by their code page.
- Non-ASCII PDF titles are written as UTF-16, and the landing page's assets are cache-busted.

## [0.3.4] - 2026-09-28

### Added

- `PRINT` command: sends the drawing to a printer through the system print dialog
  (Ctrl+Shift+P, File > Print, application menu Plot > Print, ribbon Project > Print). The
  browser edition opens the sheet and uses the browser's print dialog.
- Plot / Print dialog for PLOT and PRINT: paper size (Letter, Legal, Tabloid 11 x 17, ANSI
  C/D/E, Arch C/D, ISO A4-A0, or a custom sheet fitted to the drawing), orientation
  (automatic, landscape, portrait), scale (fit, 1:1, 1:2, 1:4, 2:1; a scale that does not fit
  is reduced and reported) and margins. The choices are remembered.

### Fixed

- The plotted sheet is rendered at the paper's proportions, named page sizes are passed to
  Electron, and the PDF page size is given in inches (the unit Electron expects) instead of
  microns.
- Browser printing sets the CSS page size to the sheet size.

## [0.3.3] - 2026-09-28

### Added

- DWG import of HATCH entities: each boundary path becomes a closed polyline (solid hatches
  are filled, pattern hatches keep the outline); edge-defined boundaries (lines, arcs,
  ellipses, splines) are sampled.
- DWG import of tables (ACAD_TABLE) through their anonymous block. Tables whose position
  LibreDWG cannot read (2013 and later files) are placed inside the sheet border when they
  fit, otherwise beside the drawing, with a note in the import log.
- The DXF reader maps ACAD_TABLE to an insert of its table block at the insertion point.
- The import log lists notes next to the skipped-entity summary.

### Changed

- Removed decorative controls that did nothing: panel-title arrows without a dialog, the
  Layout1 / Layout2 / + tabs, navigation wheel, orbit, annotation scale picker, dead check
  boxes in Options and Drafting Settings, the icon menu scale field, the layer dialog Plot
  column and Set Current button, the Project Manager gear and the Preview header.
- Wired the remaining controls: dialog launchers, the InfoCenter search icon, Quick Select,
  the Tool Palettes drag grip, the Symbol Builder auto-hide pin, layer dialog Freeze, aperture
  size, hover grip colour and additional polar angles.

### Fixed

- `ALIGN` ran `AEALIGN` because of an alias collision.
- `LINETYPE`, `LWEIGHT` and the linetype, lineweight and colour combos were shadowed by stubs
  that changed nothing; they now drive CELTYPE / CELWEIGHT and a real current colour for new
  objects.
- `PAN` is a tool (drag with the left button); the OTRACK status bar button and F11 / F12 work.
- `CLEARRECENT` (File > Open Recent > Clear Recent) is registered; `HELP shortcuts` opens the
  Keyboard Shortcuts tab.
- Anonymous block names are written with the anonymous flag so AutoCAD accepts the DXF.
- Browser edition: a page loaded before a website update reloads itself once when a code
  chunk is missing, instead of failing to open a DWG file.

## [0.3.2] - 2026-09-28

### Changed

- The decorative "Sign In" button in the title bar is replaced by **Support**, which opens
  Help > About with the author and donation details.

## [0.3.1] - 2026-09-28

### Added

- Help > About shows the author, a short bio, project links and a **Donate with Cash App**
  button; Help > Donate and the `DONATE` command open the same page. All of it is configured
  in `src/app/about.json`.
- Signed **catalog packs**: manufacturer catalogs as one signed `*.jcadpack.json` file per
  buyer (Ed25519 signature checked against the publisher keys built into the app). The
  application shows "Licensed to <buyer>" and the expiry, refuses unsigned, edited or
  unknown-key packs, and still loads expired packs with a warning. New commands `AEPACKS`,
  `AEPACKINSTALL`, `AEPACKLIST`, a Catalog Packs dialog, a Source column and **Packs...**
  button in the Catalog Browser, and a Project > Catalog Packs ribbon button.
- `scripts/pack-sign.mjs` (`keygen`, `csv2catalog`, `sign`, `verify`) and
  `docs/CATALOG-PACKS.md` for publishers.
- Public website (landing page with download buttons filled from the latest GitHub Release)
  and a **browser edition** of the application that opens DWG files in the page with the
  LibreDWG WebAssembly build.

## [0.3.0] - 2026-09-28

### Added

- **Symbol Builder** (`AESYMBUILDER`): draw a symbol in its own file tab, or start from a
  library symbol, a block of the current drawing or selected objects; place attributes and
  pins from a docked palette with a live preview and a Check list; save to a persistent
  **user library** (`user-library.json` in the application data folder, localStorage in the
  browser) whose symbols appear in the icon menu and tool palettes under "User:" categories.
  Library commands `AESYMSAVE`, `AESYMCHECK`, `AESYMVERTICAL`, `AESYMTWIN`, `AESYMTEXT2ATTR`,
  `AESYMRENAME`, `AESYMDELETE`, `AESYMLIBEXPORT`, `AESYMLIBIMPORT`; symbols can also be written
  out as a DXF block file.
- Symbol Builder: pin direction taken from where the marker sits (so COPY / MIRROR / ROTATE
  keep pins right), new checks (duplicate or wrong-side pins, markers off a line end, TAG1 over
  the geometry, tag-like plain text, off-layer geometry, standard / name mismatch, child
  families without a parent), attribute defaults, "Make vertical", NO / NC twins, Rename /
  Save as copy, and undo of the symbol's name, family, role and orientation.
- **Vertical symbols** end to end: top / bottom connections, attribute rotation (ATTDEF / ATTRIB
  group 50 in DXF and DWG), vertical wire breaking and snapping, and the icon menu's Vertical
  option inserts the library's vertical twin or builds one.
- `AECOMPONENT3` hides TAG1 on poles 2 and 3 and numbers the pins per pole.
- **Help > Report a Problem** (`REPORTBUG`): collects a description, version, platform, recent
  command history and captured errors, then opens a prefilled GitHub issue, copies the report
  or saves it as a text file (optionally with the drawing as DXF). `FEEDBACK` opens the feature
  request form. The main process logs crashes to `error.log` in the application data folder.
- Extended symbol libraries: one-line power, PLC module and fluid-power symbols (96), the IEC
  extended set (124) and refined JIC control symbols, for 454 symbols in 52 categories.
- A second launch of the desktop application focuses the running window instead of starting
  another instance.

### Changed

- `AECHILD` offers the parent's own NO / NC twin and the user's contacts of the same family
  first, then the built-in contact.
- Saved and autosaved DXF files keep only the library symbols the drawing uses (and every user
  block); the library is restored when the drawing is opened.
- The update restart goes through the same unsaved-changes prompt as closing the window.
- Browser edition: `AESYMLIBEXPORT` and REPORTBUG's Save Report download the file.

### Fixed

- SAVE only clears the unsaved flag of the revision that was written; edits made while the
  file dialog was open stay flagged.
- A drawing opened from the Drawing Recovery Manager keeps (and refreshes) its backup until it
  is saved, instead of losing it the moment it is opened.
- Mirrored (negative X scale) and non-uniformly scaled inserts are drawn and exported
  correctly; MIRROR on a component reflects its geometry while attribute text stays readable.
- The browser autosave reports failed writes and retries them instead of treating them as
  saved.
- The user symbol library cannot be overwritten after a failed read, keeps entries it cannot
  parse, validates names and geometry, and is written atomically with one backup copy.
- Tag-prefix rules of the extended libraries no longer depend on import order; a stale PURGE
  stub no longer shadows the real command.

## [0.2.0] - 2026-09-28

### Added

- Update check against GitHub Releases a few seconds after start-up, from **Help > Check for
  Updates** and with the `CHECKUPDATES` command. Windows installer and Linux AppImage builds
  download the update and install it on restart; macOS and `.deb` builds are offered the
  matching download. Help > About shows the version and an update button.
- The Insert Component icon menu has a search box across all categories.

### Changed

- All symbol sets are served through one library module used by the editor, tools, palettes,
  dialogs and templates.
- Installer file names contain no spaces, and releases carry the update metadata.

## [0.1.1] - 2026-09-27

### Changed

- macOS builds are ad-hoc signed (so macOS does not report them as damaged) and are built as
  separate Apple Silicon and Intel disk images.

## [0.1.0] - 2026-09-27

First release.

### Added

- Desktop 2D drafting application (Electron + TypeScript) with a ribbon, Project Manager and
  Properties palettes, command window with AutoComplete, status bar toggles, file tabs for
  several open drawings, and a canvas with grid, crosshair, object snaps, object snap
  tracking, polar tracking and grips.
- Drafting commands: LINE, PLINE with arcs and widths, CIRCLE, ARC, RECTANG, TEXT, MTEXT,
  ELLIPSE, POINT, XLINE, RAY, DONUT, POLYGON; linear, aligned, radius, diameter and angular
  dimensions with dimension styles; ERASE, MOVE, COPY, ROTATE, MIRROR, SCALE, TRIM, EXTEND,
  OFFSET, EXPLODE, FILLET, CHAMFER, ARRAY, STRETCH, BREAK, JOIN, LENGTHEN, ALIGN, MATCHPROP,
  CHPROP; BLOCK, INSERT, PURGE; DIST, AREA, ID, LIST; ZOOM, VIEW, UNITS, LIMITS; selection
  modes; layers, linetypes and lineweights.
- Electrical workflow in the style of AutoCAD Electrical: ladders, wires with junction dots,
  JIC and IEC 60617 style symbol libraries, component insertion with tag, location,
  description, manufacturer and catalog data, child contacts, 3-pole devices, retagging,
  wire numbers, coil / contact cross-references, parametric PLC I/O modules, source /
  destination arrows, terminal strips and the Terminal Strip Editor, wire types, panel
  footprints, balloons and nameplates, the Circuit Builder, and wire editing tools (trim,
  gaps, loops, scoot, align, multiple bus).
- Reports (bill of material, components, wire from / to, wire labels, PLC I/O, missing catalog
  data, terminals, terminal strip, panel, electrical audit) with CSV export and tables on the
  drawing; the Electrical Audit dialog.
- Generic parts catalog with a Catalog Browser and user catalog files.
- Sheet templates (ANSI A-D, ISO A3 / A4) with an attributed title block; project files
  (`*.jcadproj.json`) with project properties.
- DWG import (R14 to 2018) through LibreDWG WebAssembly; DXF (AutoCAD 2000) open and save;
  PDF plotting.
- Hershey Roman Simplex stroke font for text.
- Options and Drafting Settings dialogs, Quick Properties, rollover tooltips, Tool Palettes,
  the Help window with a keyboard shortcut list, the text window, the application menu,
  in-application object clipboard.
- Autosave with a Drawing Recovery Manager, remembered window size and position, and a native
  File > Open Recent menu.
- Installers for Windows, macOS and Linux built by GitHub Actions.

### Changed

- Renamed the application to JCad Electrical.

[Unreleased]: https://github.com/habit04/share/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/habit04/share/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/habit04/share/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/habit04/share/compare/v0.4.9...v0.5.0
[0.4.9]: https://github.com/habit04/share/compare/v0.4.8...v0.4.9
[0.4.8]: https://github.com/habit04/share/compare/v0.4.7...v0.4.8
[0.4.7]: https://github.com/habit04/share/compare/v0.4.6...v0.4.7
[0.4.6]: https://github.com/habit04/share/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/habit04/share/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/habit04/share/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/habit04/share/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/habit04/share/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/habit04/share/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/habit04/share/compare/v0.3.4...v0.4.0
[0.3.4]: https://github.com/habit04/share/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/habit04/share/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/habit04/share/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/habit04/share/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/habit04/share/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/habit04/share/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/habit04/share/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/habit04/share/releases/tag/v0.1.0
