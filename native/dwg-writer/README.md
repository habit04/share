# JCad portable Windows DWG writer

The offline Rust helper accepts only `convert input.dxf output.dwg report.json` in a fresh private working directory. It emits AutoCAD 2018-format DWG (`AC1032`) and a schema-1 SHA-256 verification report. It requires neither AutoCAD nor a managed runtime on the user's computer.

The parent verifies the packaged executable and manifest, enforces cancellation/deadlines/output limits, and commits accepted output atomically with a backup. The helper installs and reads back a Windows Job Object **1 GiB process memory limit before parsing**. Failure to attach or verify this limit refuses conversion. The job does not set `KILL_ON_JOB_CLOSE`; its handle is held through conversion.

Preflight limits are 128 MiB input, 1 MiB per line, 2,000,000 group pairs, 250,000 records, 20,000 blocks and 256 layouts. Declared vertex/knot/hatch counts and spline degrees are checked before parser allocation. Only complete UTF-8 DXF interchange versions AC1015–AC1032 emitted by JCad are accepted. Unsupported entity records, including retained REGION/3DSOLID/BODY/surface/proxy data, refuse export rather than dropping content. Numeric inputs must be finite. A generated DWG is reopened and compared for entity/block/layout structure and known semantic fields; unhandled reader notifications or differences refuse success. Exact format-progress notices are allowed separately from actual warnings. This check supplements the independent AutoCAD conformance suite and does not establish universal DWG fidelity.

When a spline has both control and fit data, JCad's control-point geometry is emitted. Auxiliary fits, tangents, tolerances and original editing flags survive in registered `JCAD_SPLINE_FIT` XDATA: schema-1 JSON split into at most 240-character group-1000 strings, at most 4096 ASCII bytes, with a SHA-256 fingerprint of the actual degree/control points/knots/weights and curve flags. Existing conflicting packets and metadata exceeding the conservative 16,000-byte per-entity XDATA budget refuse export. The helper's own-output verifier checks the actual native curve fingerprint before restoring auxiliary fields solely for comparison. Other CAD programs see the preserved control-point curve and do not interpret the packet as native fit editing history. Ordinary JCad import through LibreDWG may omit XDATA and auxiliary fit-edit history; it does not restore this packet today.

Dependencies are exact versions with a Cargo lockfile. `scripts/prepare-dwg-writer.mjs` stages the independently hashed upstream crate and reviewed patches into the ignored `vendor/acadrust` directory. `scripts/build-dwg-writer.mjs` builds with the pinned Rust toolchain and stages the binary and manifests for packaging. Do not modify a Cargo registry cache or bypass these preparation checks.

The private patched DWG reader is used only to verify files just emitted by this helper. It must not read external DWGs: its frame-only MTEXT storage assumptions match this writer and can differ from AutoCAD-authored files. JCad's external DWG import continues to use its existing isolated LibreDWG reader.

Paper-space BLOCK markers preserve full logical names while their BLOCK_HEADER names keep the abbreviated binary convention. Only primary paper-space owners use implicit mode1; secondary sheet markers and geometry encode their actual owner in mode0, even when DXF group67 marks them as paper space. Native regressions inspect encoded object fields before private-reader name/ownership restoration and then require full snapshots and layout closure. Source-absent Model layouts receive the same ModelType plot flag that the encoder stores; explicit imported layout flags remain unchanged. A complete two-sheet DXF fixture checks imported layout identities, plot flags and reciprocal block references through full native reopening. A private flag mutation must still refuse preservation.

INSERT retains a declared SEQEND identity and its explicit parent owner. Reactor, extension-dictionary and XDATA payloads on a SEQEND remain unsupported, and incoming metadata pointers still refuse when that marker lacks a registered metadata identity. Identity retention does not certify those unsupported payloads.

Default dictionaries and their placeholders retain explicitly declared ordered reactors and extension dictionaries through the existing common-object caches. Those links are parsed separately from owner and default-entry pointers. Native regressions inspect the encoded common fields, complete snapshots and reopened links; the independent C postflight remains required before saving.

Named entity and ATTRIB colors receive their required DBCOLOR records before the checked baseline through the pinned encoder's existing preparation. The exact RGB, Unicode book/name fields, native owner and entity references are checked after binary encoding and reopening. Matching records are reused; declared references with a missing or wrong class, conflicting names/RGB, or ambiguous split book/name fields refuse without replacing retained data. Generated records must be absent from the source OBJECTS inventory, and endpoint/object counts remain bounded. The full metadata and independent C comparisons remain required.

Run `cargo test --locked` after preparation. Release packaging must use the staged binary and matching integrity manifest; any signing or binary mutation must happen before the final manifest is generated.

The standalone source archive already includes the verified patched `vendor/acadrust` tree. To rebuild its helper without the full application's Node tooling, install the pinned **Rust 1.99.0 GNU** toolchain with target `x86_64-pc-windows-gnu`, open a terminal in `native/dwg-writer`, and run:

```text
cargo +1.99.0-x86_64-pc-windows-gnu test --locked --target x86_64-pc-windows-gnu
cargo +1.99.0-x86_64-pc-windows-gnu build --locked --release --target x86_64-pc-windows-gnu
```

The rebuilt binary is `target/x86_64-pc-windows-gnu/release/JcadDwgWriter.exe`. Signing, installer creation and Node packaging require the full repository's dependencies and release configuration; rebuilding this standalone helper does not require signing credentials.
