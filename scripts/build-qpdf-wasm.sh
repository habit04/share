#!/usr/bin/env bash
# Production build recipe — qpdf 12.4.2 -> WebAssembly for the 12.4 restricted-PDF
# (P2) mode. Self-built from pinned, hash-verified inputs; nothing is fetched at
# build time and nothing in the app tree is touched except the output assets.
#
# Pins (do not change without re-running the spike's bounds measurements):
#   qpdf          12.4.2  sha256 8a58af5b6141319287c1883bec8bd1bd545b7567b7fc5e6ce5d25a1c85f36397
#   zlib          1.3.1   sha256 9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23
#   libjpeg-turbo 3.1.1   sha256 aadc97ea91f6ef078b0ae3a62bba69e008d9a7db19b34e4ac973b19b71b4217c
#   Emscripten    3.1.74  (emcc version is hard-checked)
#   MAXIMUM_MEMORY 805306368 bytes (768 MiB = 12288 pages) — declared maximum of
#   the shipped artifact, statically verifiable with
#   scripts/inspect-wasm-memory.mjs. The WASM cap bounds WASM linear memory
#   ONLY; MEMFS holds its files in external JS Uint8Arrays, so the runtime
#   enforces separate aggregate byte budgets (see
#   electron/restricted-pdf/README.md, "Memory model").
#
# Required environment:
#   EMSDK            path to an emsdk 3.1.74 checkout (emsdk_env.sh is sourced)
#   QPDF_TARBALL     path to qpdf-12.4.2.tar.gz
#   ZLIB_TARBALL     path to zlib-1.3.1.tar.gz
#   LIBJPEG_TARBALL  path to libjpeg-turbo-3.1.1.tar.gz (release asset, NOT the
#                    same-size git-archive tarball, whose hash differs)
# Optional:
#   QPDF_WASM_WORK   scratch build dir (default: <repo>/build/qpdf-wasm)
#   QPDF_WASM_OUT    asset output dir (default: <repo>/electron/restricted-pdf/assets)
#   TAR_OPTIONS      e.g. --no-same-owner on multi-user sandboxes
set -euo pipefail

QPDF_SHA256=8a58af5b6141319287c1883bec8bd1bd545b7567b7fc5e6ce5d25a1c85f36397
ZLIB_SHA256=9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23
LIBJPEG_SHA256=aadc97ea91f6ef078b0ae3a62bba69e008d9a7db19b34e4ac973b19b71b4217c
EMSDK_VERSION=3.1.74
MAXIMUM_MEMORY=805306368

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${QPDF_WASM_WORK:-$REPO/build/qpdf-wasm}"
OUT="${QPDF_WASM_OUT:-$REPO/electron/restricted-pdf/assets}"
: "${EMSDK:?set EMSDK to an emsdk $EMSDK_VERSION checkout}"
: "${QPDF_TARBALL:?set QPDF_TARBALL}"; : "${ZLIB_TARBALL:?set ZLIB_TARBALL}"; : "${LIBJPEG_TARBALL:?set LIBJPEG_TARBALL}"

verify() { # file expected_sha256 label
  local actual
  actual="$(sha256sum "$1" | awk '{print $1}')"
  if [ "$actual" != "$2" ]; then echo "HASH MISMATCH ($3): got $actual want $2" >&2; exit 1; fi
  echo "hash ok: $3 $actual"
}
verify "$QPDF_TARBALL" "$QPDF_SHA256" qpdf-12.4.2.tar.gz
verify "$ZLIB_TARBALL" "$ZLIB_SHA256" zlib-1.3.1.tar.gz
verify "$LIBJPEG_TARBALL" "$LIBJPEG_SHA256" libjpeg-turbo-3.1.1.tar.gz

# shellcheck disable=SC1091
source "$EMSDK/emsdk_env.sh" >/dev/null
EMCC_VERSION="$(emcc --version | head -1)"
case "$EMCC_VERSION" in *"$EMSDK_VERSION"*) echo "toolchain ok: $EMCC_VERSION" ;; *)
  echo "TOOLCHAIN MISMATCH: emcc is '$EMCC_VERSION', pinned $EMSDK_VERSION" >&2; exit 1 ;; esac
echo "cmake: $(cmake --version | head -1)"; echo "node: $(node --version)"

# Clean extraction — a stale or pre-populated source tree is never reused.
rm -rf "$WORK"
mkdir -p "$WORK/src" "$WORK/prefix" "$OUT"
tar -xzf "$ZLIB_TARBALL" -C "$WORK/src"
tar -xzf "$LIBJPEG_TARBALL" -C "$WORK/src"
tar -xzf "$QPDF_TARBALL" -C "$WORK/src"

emcmake cmake -S "$WORK/src/zlib-1.3.1" -B "$WORK/build/zlib" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$WORK/prefix"
cmake --build "$WORK/build/zlib" -j2
cmake --install "$WORK/build/zlib"

emcmake cmake -S "$WORK/src/libjpeg-turbo-3.1.1" -B "$WORK/build/libjpeg" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$WORK/prefix" \
  -DENABLE_SHARED=OFF -DWITH_SIMD=OFF
cmake --build "$WORK/build/libjpeg" -j2
cmake --install "$WORK/build/libjpeg"

# Crypto: implicit external providers OFF, native provider REQUIRED and default.
# Secure-random pins are explicit per the provenance audit: the native provider
# must never select its insecure fallback, and OS secure-random support must
# not be skipped (both already default OFF; pinning makes the intent auditable
# and fails the build if an upstream default ever flips).
QPDF_LINK_FLAGS="-sMODULARIZE=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sENVIRONMENT=node -sFORCE_FILESYSTEM=1 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=$MAXIMUM_MEMORY -sEXPORTED_RUNTIME_METHODS=callMain,FS"
emcmake cmake -S "$WORK/src/qpdf-12.4.2" -B "$WORK/build/qpdf" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$WORK/prefix" \
  -DCMAKE_PREFIX_PATH="$WORK/prefix" \
  -DBUILD_SHARED_LIBS=OFF -DBUILD_STATIC_LIBS=ON \
  -DUSE_IMPLICIT_CRYPTO=OFF -DREQUIRE_CRYPTO_NATIVE=ON -DDEFAULT_CRYPTO=native \
  -DUSE_INSECURE_RANDOM=OFF -DSKIP_OS_SECURE_RANDOM=OFF \
  -DINSTALL_PKGCONFIG=OFF -DINSTALL_CMAKE_PACKAGE=OFF -DINSTALL_EXAMPLES=OFF \
  -DCMAKE_EXE_LINKER_FLAGS="$QPDF_LINK_FLAGS"
cmake --build "$WORK/build/qpdf" -j2 --target qpdf

cp "$WORK/build/qpdf/qpdf/qpdf.js" "$WORK/build/qpdf/qpdf/qpdf.wasm" "$OUT/"
# The glue is Emscripten CommonJS output; the repository root package.json is
# "type": "module", so the assets directory carries a scoped CommonJS marker
# (see electron/restricted-pdf/assets/package.json) for Node/Electron loaders.
cat > "$OUT/package.json" <<'EOF'
{"description":"The qpdf WASM glue (qpdf.js) is Emscripten CommonJS output; this marker keeps Node and Electron loaders from treating it as an ES module under the repository's root \"type\": \"module\".","private":true,"type":"commonjs"}
EOF
WASM_SHA="$(sha256sum "$OUT/qpdf.wasm" | awk '{print $1}')"
JS_SHA="$(sha256sum "$OUT/qpdf.js" | awk '{print $1}')"
MEMORY_JSON="$(node "$REPO/scripts/inspect-wasm-memory.mjs" "$OUT/qpdf.wasm")"
echo "memory: $MEMORY_JSON"
node -e '
  const m = JSON.parse(process.argv[1]);
  const want = Number(process.argv[2]);
  if (!m.memories.length || m.maximumBytes !== want) {
    console.error(`DECLARED MAXIMUM MISMATCH: got ${m.maximumBytes}, want ${want}`);
    process.exit(1);
  }' "$MEMORY_JSON" "$MAXIMUM_MEMORY"

cat > "$OUT/build-receipt.json" <<EOF
{
  "engine": "qpdf 12.4.2",
  "sourceSha256": "$QPDF_SHA256",
  "zlib": "1.3.1", "zlibSha256": "$ZLIB_SHA256",
  "libjpegTurbo": "3.1.1", "libjpegSha256": "$LIBJPEG_SHA256",
  "emscripten": "$EMCC_VERSION",
  "cmake": "$(cmake --version | head -1)",
  "maximumMemoryBytes": $MAXIMUM_MEMORY,
  "declaredMemory": $MEMORY_JSON,
  "crypto": "native only (USE_IMPLICIT_CRYPTO=OFF, REQUIRE_CRYPTO_NATIVE=ON, DEFAULT_CRYPTO=native, USE_INSECURE_RANDOM=OFF, SKIP_OS_SECURE_RANDOM=OFF)",
  "linkFlags": "$QPDF_LINK_FLAGS",
  "qpdfWasmSha256": "$WASM_SHA",
  "qpdfJsSha256": "$JS_SHA"
}
EOF
echo "BUILD_OK"
sha256sum "$OUT/qpdf.js" "$OUT/qpdf.wasm"
cat "$OUT/build-receipt.json"
