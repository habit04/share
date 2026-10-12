# Controlled native MTEXT background repair

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
shared CMC projections are unchanged.

`mtext-background-scale.patch.json` is an exact checked patch, not a search-and-replace over an
arbitrary dependency version. `patch-source.mjs` verifies the source HEAD, pinned submodule,
package build scripts/license Git blobs, every complete file preimage, and exact replacement
counts before writing. It rejects reapplication or drift and records original/modified SHA256
digests. The field types are checked again after autogen and after compilation.

## Pins and commands

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

The workflow is manually dispatchable and also runs on pushes to `codex/cad-fidelity-five` that
change this workflow, this directory, or the two controlled fixture files. This allows the first
feature-branch build before the workflow is registered on the default branch. It uses read-only
repository permissions, no signing credentials/secrets, a 60-minute job bound, and a 90-second
native fixture process bound.

The root agent supplies these independently generated fixtures:

- `tests/fixtures/interchange/r2018-mtext-background.dwg`
- `tests/fixtures/interchange/r2018-mtext-background.expected.json`

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
0/0/0. The pinned raw factory has no decoded EED/XDATA accessor; XDATA retention is not certified
here. This fixture also does not exercise native embedded MTEXT containers; both embedded/main
scale declarations are patched and checked, but embedded runtime equivalence needs its own fixture.

The successful artifact contains the matching compiled JS/WASM pair, full modified corresponding
source (including the pinned submodule), `COPYING`, checked patch/build scripts, patch/fixture
reports, provenance and SHA256 checksums. No failed candidate is uploaded under the validated
artifact name. This gate establishes the fixture's native decoding, not complete CAD compatibility,
all DWG versions, browser adapter behavior, or final signed installer behavior.

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
