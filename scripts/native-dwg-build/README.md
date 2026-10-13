# Controlled native DWG decoder and metadata repair

This workflow builds a candidate runtime. It does not change `node_modules`, acquire credentials,
sign an installer, create a release, or publish anything. Integration into JCad is a separate step.

The pinned `@mlightcad/libredwg-web` 0.7.14 source declares MTEXT's background fill scale as a
`BL` integer in its native structures, decoder specs and dynamic API metadata. The independent
AutoCAD 2027 fixture has fractional native scales (1.5 and 1.25). Reading those bits as an integer
also corrupts the following color/column fields. The repair changes all six production scale
declarations to `BD` and updates the native unit-test declaration/expectation. It also corrects
the owning-DWG-aware dynamic API projection of CMC color-book names: R2007+ strings are converted
from TU using the existing native conversion function, null strings become empty, and pre-R2007
code-page bytes keep their existing representation. Conversion buffers use RAII cleanup. Other
shared CMC projections retain their fields and expose a borrowed WASM32 native
color-reference pointer. The entity getter now resolves only that exact reference
to DBCOLOR in the owning drawing, preserves the entity's index/alpha/flags and
projects referenced RGB/method/name/book_name with null-safe, version-aware strings.
`hasReference` and `referenceResolved` distinguish unresolved/wrong-type references;
the application refuses those rather than guessing a palette color.

The pinned decoder also consumes a referenced entity color handle twice: once
while decoding common color data, then again before decoding the common handle
prefix. The second read replaces the DBCOLOR reference with the following layer
reference and shifts later fields. The repair reads that handle exactly once in
its R2004+ handle-stream position: owner (when present), reactors, extension
dictionary, legacy handles, optional color reference, then layer. Model-space
entities with implicit ownership and block entities with explicit owners use the
same ordering. This move is limited to `IS_DECODER`; existing free/print/DXF
projections and the native encoder's separate handle path remain unchanged.

The MINSERT attribute getter selects the actual native INSERT or MINSERT layout
before reading owned handles. MINSERT places array count/spacing fields before
those handles, so treating it as INSERT dereferenced spacing bytes as pointers.
Existing vector/linked-list traversal is retained after selecting the correct fields.

For ATTRIB, the decoder stops its single-line field sequence at the lock-position
bit, as specified by ODA section 20.4.4. Its extra R2010+ KeepDuplicateRecords read
belongs to the existing DXF/export projection and must not consume bytes from the
DWG stream. That read is excluded only for `IS_DECODER`. ATTDEF retains its
separate R2010+ byte before the prompt; the ATTRIB repair does not alter ATTDEF.

`mtext-background-scale.patch.json` is an exact checked patch, not a search-and-replace over an
arbitrary dependency version. `patch-source.mjs` verifies the source HEAD, pinned submodule,
package build scripts/license Git blobs, every complete file preimage, and exact replacement
counts before writing. It rejects reapplication or drift and records original/modified SHA256
digests. The field types are checked again after autogen and after compilation.

## Bounded metadata projection

The candidate adds `jcad_dwg_export_metadata` around the already decoded drawing.
It copies a source inventory of canonical hexadecimal handles, native/DXF type
names and entity/object classifications, then writes the native DXF projection
into one owned fixed-size memory stream. No output path or native pointer is
returned. The output limit is 32 MiB and the inventory limit is 100000 objects;
an exhausted stream returns an error and no partial DXF. Application import also
has record, string and total payload limits. A trapped native projection discards
the module while retaining geometry already copied by the fallback converter.

The native `complete` result is only a precondition. LibreDWG can skip classes
without propagating every error to its top-level writer. The application must
reconcile every source identity against projected records and report unsupported
objects, omitted references and decoder/write errors. Candidate Windows geometry
conversion bypasses the old borrowed EED and XRECORD getters: the complete C DXF
projection supplies typed metadata, including binary and int64 values, instead.
The old accepted runtime and its appearance policy remain separate until this
candidate passes the new `metadata-graph` acceptance policy.

The independent `r2018-views-fields` fixture is authored by the checked-in
AutoCAD 2027 .NET oracle and has native AUDIT errors/fixes of 0/0. Its expected
records come directly from AutoCAD DXFOUT, never from JCad output. It exercises
three named views, full 3D direction/target and camera fields, a real nested FIELD
expression and cached values, FIELDLIST and extension/application dictionaries,
binary XRECORD data, exact int64 `9007199254740993`, and ordered hard/soft references.
The compiled gate requires zero decoder and projection errors and compares the
actual projected groups and inventory identities with these independent records.
It also proves a 128-byte output cap rejects the projection before a normal read.

The fixture exposed three pinned native defects addressed by checked preimages:

- AcValue flag bit 0 controls whether its typed body is present; bit 1 does not
  suppress the body. String values use a byte count and main-stream UTF-16 data
  for R2007+, rather than a separate T string-stream field. The decoder bounds
  the allocation to 1 MiB and validates UTF-16 length and its terminator.
  FIELD DXF output places child values before the main value and emits its
  `ACFD_FIELD_VALUE` / `ACVALUE_END` markers. See ODA FIELD (printed page 200)
  and AcValue section 20.4.99 (printed page 241).
  The native free traversal uses the same body flag guard so these newly
  decoded strings/buffers are released; the native encoder retains its path.
- VIEW's stream flags are mapped into DXF masks 1/2/4, with the fourth stream bit
  opposite to DXF's front-clip-at-eye bit 16 (ODA VIEW, printed page 174).
  This remapping is decoder-only; pre-R13 and other native projections retain
  their existing behavior.
- DXF groups 160–169 use `PRId64`; wasm32's 32-bit `long` otherwise truncates
  native 64-bit XRECORD values.

These gates cover defined records and source identities. They do not certify
unknown proprietary object schemas, raw DWG object bytes, arbitrary FIELD
evaluators, or all files and DWG versions. Retention through the portable writer
requires a separate typed graph comparison after saving and reopening.

The CLASS gate also checks every projected definition against copied native
class values and the independently authored DXF definitions. R2007 and later
store the class DWG and maintenance versions as BL, whereas R2004 uses BS
([ODA sections 5.8 and 10.2](https://www.opendesign.com/files/guestdownloads/OpenDesign_Specification_for_.dwg_files.pdf)).
The pinned decoder used BS in both paths. A maintenance value above 255 shifted
the scalar class stream and corrupted subsequent flags and counts while names
in the separate string stream still appeared correct. The checked repair uses
the source-version-specific width and keeps the two unknown fields separate.
The existing copied class getter also converts R2007+ C++/application names
from their actual UTF-16 representation before returning owned strings.

The runtime refuses an invalid class number/discriminator or missing class
inventory before exporting metadata. The original AutoCAD DXF CLASS definitions
are checked separately from the native copied values, so a decoder and projection
agreeing on the same corrupt flags does not pass the acceptance gate.

CMC color-book components from R2007+ are already converted from UTF-16 to UTF-8
when joined. Their DXF output now uses the UTF-8 path directly, preserving the
original Unicode name instead of interpreting its bytes again as a legacy code
page. The appearance gate checks the actual DBCOLOR source object and its name,
in addition to the existing resolved entity color checks.

AXISMODE and AXISUNIT are pre-R13 binary header fields. The DXF projection now
emits them only for that source version, rather than synthesizing absent modern
DWG properties as zero. This does not add encoding of legacy nonzero axis values.

Normal CI also runs `validate-vendored-metadata.mjs` against the accepted runtime
for all three tracked, independently authored AutoCAD fixtures: named views and
filename fields; real AcObjProp Length fields with both indexed and cached object
references; and Unicode view/dictionary/FIELD strings plus an opaque XRECORD
literal containing `\U+0041` and escaped JSON. The last literal is independently
checked through native .NET after DWG reopen and compared exactly without Unicode
substitution. Reports bind each fixture to the accepted factory/WASM byte hashes.
This check does not rebuild or modify the runtime. Fixture and validator changes
use normal CI; source-recipe and toolchain changes trigger the controlled native
build, which also remains available through manual workflow dispatch.

## Pins and commands

The decoder also reads inline ENC RGB before its optional alpha word, following
[ODA section 2.11](https://www.opendesign.com/files/guestdownloads/OpenDesign_Specification_for_.dwg_files.pdf#page=13).
Book-color handle placement follows section 20.4.2; the single-line ATTRIB ending follows
section 20.4.4. These repairs preserve the existing nondecoder projections. Failed compiled
gates may upload a clearly labeled diagnostic factory/WASM with corresponding source and
license; those bundles have no accepted provenance and are never integrated into the app.

- Source: `mlightcad/libredwg-web`, tag `v0.7.14`, commit
  `1dd682f46339f37b67c5ff1085d10d04a8c16d7e`.
- Submodule: `zserge/jsmn`, commit `85695f3d5903b1cd5b4030efe50db3b4f5f3c928`.
- SDK: Emscripten `4.0.23`, emsdk commit `c0bb220cb6e6f4e0fabb6f6db9efd53390ef5e56`,
  release binary hash `aaa43392544d695232b70eda706d751f18980c2a`.
- The original distributed npm binary's compiler version is **unknown**. Upstream's installation
  script selects `latest`; its distributed WASM has no producer/version custom section. This
  build records its own pinned compiler rather than claiming to reproduce that unknown compiler.
- Declaration generation: TypeScript 5.7.3 from an integrity-pinned isolated CI package lock.
  Emscripten 4.0.23's `--emit-tsd` invokes `tsc --outFile`; the runner's newer global compiler
  removed that option. The temporary tools directory is installed with `npm ci --ignore-scripts
  --no-audit --no-fund` and placed first on PATH after sourcing the SDK. A tiny declaration probe
  exercises the exact options before the native build. This changes no native compiler/memory
  flags, upstream source scripts, application dependencies or installed `node_modules`.
- Ubuntu 24.04 CI prerequisites: autoconf, automake, libtool, build-essential, pkg-config,
  python3, git, zlib1g-dev, texinfo. No JavaScript dependencies need to be installed to run the
  upstream native build scripts with npm; the declaration compiler alone is installed in its
  separate runner-temp directory.

After the pinned SDK is installed/activated and its environment sourced:

```sh
node scripts/native-dwg-build/patch-source.mjs apply "$NATIVE_SOURCE" "$NATIVE_ARTIFACT/patch-report.json"
(cd "$NATIVE_SOURCE" && ./autogen.sh)
node scripts/native-dwg-build/patch-source.mjs verify "$NATIVE_SOURCE"
(cd "$NATIVE_SOURCE/bindings/javascript" && npm run build:prepare && npm run build:obj && npm run build:wasm)
node scripts/native-dwg-build/patch-source.mjs verify "$NATIVE_SOURCE"
```

These are the pinned package's official native build scripts, with `MAKEFLAGS=-j2`. Their original
memory flags remain `INITIAL_MEMORY=1GB`, `MAXIMUM_MEMORY=4GB`, `ALLOW_MEMORY_GROWTH=1`; the compiled
candidate is not a new resource-limit policy. JCad's loader/worker limits require separate checks
when integrating the candidate. Matching factory glue and WASM must always be integrated together.

## Native acceptance gate

The workflow is manually dispatchable and also runs on the two configured feature branches when
the checked native patch, source/toolchain pins, patch applicator or isolated declaration compiler
changes. Ordinary fixture/tooling changes are checked against the accepted pair in normal CI.
This allows the first feature-branch build before registration on the default branch. It uses read-only
repository permissions, no signing credentials/secrets, a 60-minute job bound, and a 90-second
native fixture process bound.

The root agent supplies these independently generated fixtures:

- `tests/fixtures/interchange/r2018-mtext-background.dwg`
- `tests/fixtures/interchange/r2018-mtext-background.expected.json`
- `tests/fixtures/interchange/r2018-portable-appearance.dwg` and its expected JSON
- `tests/fixtures/interchange/r2018-native-shipping.dwg` and its expected JSON

The additional native gate checks exact DBCOLOR RGB and Unicode book/name identity,
inline layer color identity, all three transparency modes, and the real shipping
combination's MINSERT row/column/spacing and TAG1=QF1 owned attribute. The combination
was independently accepted by AutoCAD 2027 with AUDIT 0. Raw native getters must
complete without memory faults; application conversion and full geometry remain
separate checks.

The DWG was created/normalized with AutoCAD 2027 and saved as DWG 2018; it is JCad's own drawing,
not an Autodesk vendor asset. The expected JSON comes from the normalized DXF. The validator calls
the compiled factory/dynamic API directly, bypassing JCad and the package converter's fallbacks.
It requires zero native decoder error bits, all seven unique MTEXT records, exact flags, fractional
scales, ACI indices, RGB bytes, color-book strings, and native default column fields. Frame-only
and off masks have no active fill-color/scale assertions. Window-color masks do not assert their
ignored explicit color. The report records raw method/index/RGB/name/book fields for the known
ACI/RGB examples so the application mapping can be based on native evidence.
The pinned decoder recomputes CMC indices by palette lookup. A valid explicitly encoded ByAci
index is therefore checked as its native identity when that lookup loses it; the raw index is
still recorded. The RGB/book test requires the original RGB bytes and full book/name strings.

The actual AutoCAD-normalized `COLUMN ONE\NCOLUMN TWO` record has no native group 75/48/49 (or
76/78/79/50) column fields. It has application XDATA: group 1001 `JCAD_MTEXT_COLUMNS` and group
1000 JSON with type 1, count 2, width 6, gutter 3 and heights [20,20]. That is JCad metadata,
not a native column definition. The gate therefore checks native column type/width/gutter are
0/0/0. The original borrowed EED/XDATA accessor is not certified safe or complete;
XDATA retention is not certified by the seven-mask gate. This fixture also does not
exercise native embedded MTEXT containers; both embedded/main
scale declarations are patched and checked, but embedded runtime equivalence needs its own fixture.

The successful artifact contains the matching compiled JS/WASM pair, full modified corresponding
source (including the pinned submodule), `COPYING`, checked patch/build scripts, patch/fixture
reports, provenance and SHA256 checksums. No failed candidate is uploaded under the validated
artifact name. This gate establishes the fixture's native decoding, not complete CAD compatibility,
all DWG versions, browser adapter behavior, or final signed installer behavior.

The metadata gate also compares every projected CLASS definition against copied native values
from the existing `dwg_get_class` getter, within the same live read. Its application/CPP string
getter converts R2007+ UTF-16 using the owning file version, with bounded null-safe owned values.
The original getter truncated those names at the first UTF-16 null byte. It checks complete class
coverage, DXF/CPP/application names, proxy flags, zombie/entity discriminators and stored counts.
The private `out_dxf.c` repair retains the native ACDBPLACEHOLDER/LAYOUT definitions that modern
DXF export otherwise omits, and keeps the stored SPATIAL_INDEX application name. DATATABLE's
specified DXF spelling is the only name alias in this gate. No class pointer leaves the read.
The report retains both the copied native values and projected class groups; provenance requires
their verification before accepting the factory/WASM pair. This does not certify unexposed
class-maintenance/version fields or opaque native object bytes.

## License and primary sources

The npm package declares GPL-3.0; native source headers grant GPL-3.0-or-later. Keep `COPYING`,
the relevant per-file notices, this patch and corresponding source available with any distributed
candidate. Provenance names the exact upstream commit and identifies the local modifications.

- [Pinned source](https://github.com/mlightcad/libredwg-web/tree/1dd682f46339f37b67c5ff1085d10d04a8c16d7e)
- [Official native build instructions](https://github.com/mlightcad/libredwg-web/blob/1dd682f46339f37b67c5ff1085d10d04a8c16d7e/bindings/javascript/README.md)
- [Pinned build scripts](https://github.com/mlightcad/libredwg-web/blob/1dd682f46339f37b67c5ff1085d10d04a8c16d7e/bindings/javascript/package.json)
- [GNU decoder uses BD for MTEXT fill scale](https://github.com/LibreDWG/libredwg/blob/master/src/dwg.spec)
- [Emscripten SDK installation](https://emscripten.org/docs/getting_started/downloads.html)
- [Pinned emsdk release metadata](https://github.com/emscripten-core/emsdk/blob/c0bb220cb6e6f4e0fabb6f6db9efd53390ef5e56/emscripten-releases-tags.json)
