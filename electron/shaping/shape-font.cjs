/**
 * Shaping worker mode (12.5 engine switch-over, step 2; contract v4
 * §9.1: a third usage mode on the existing font host — no new
 * transport). One request shapes ONE production of ONE context with
 * the vendored capped HarfBuzz build:
 *
 *   - the face program comes from the same read the PDF path uses
 *     (readWindowsPdfFont): the fsType embedding gate, collection
 *     face selection, and standalone-face extraction are inherited
 *     unchanged, and the exact bytes shaped are hashed here, inside
 *     the host process tree, so the returned programSha256 is a
 *     serving-path identity, never a renderer assertion;
 *   - the engine assets load only through verify-assets.cjs (hash +
 *     binary-parsed 256 MiB declared maximum); a failed verification
 *     makes shaping unavailable — there is no fallback artifact;
 *   - the buffer carries the whole context text with the item range
 *     (whole-text-plus-range, §2.5): script, direction, and language
 *     are set explicitly from the request (never guessed), the
 *     cluster level is monotone-graphemes, and the positional BOT/EOT
 *     flags reflect the item's position in its context (§3.3). The
 *     default-ignorable policy is the recorded engine-default-hide:
 *     neither preserve nor remove flags are set;
 *   - counts are preflighted from the engine arrays BEFORE the
 *     result is materialized (§9.4.1): glyph expansion over 4x the
 *     item length or a wire size over the per-item cap refuses with
 *     the named bound instead of posting a payload.
 *
 * The result is plain data (glyphs with item-relative cluster ranges
 * tiled from the monotone cluster boundaries, advance totals, face
 * facts). Run assembly — binding, uncovered classification, ink —
 * belongs to the renderer's preparation layer, which re-validates
 * everything under the interface contracts before any consumer sees
 * it (§10).
 */
'use strict';
const { createHash } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { readWindowsPdfFont } = require('../pdf-font.cjs');
const { verifyAssets, ASSETS } = require('./verify-assets.cjs');

/** §9.3: a single production's context is bounded by the batch cap. */
const MAX_CONTEXT_UTF16_UNITS = 65536;
/** §9.3 preflight bounds (mirrors SHAPING_LIMITS / SHAPED_RUN_WIRE). */
const GLYPH_EXPANSION_FACTOR = 4;
const MAX_ITEM_RESULT_BYTES = 256 * 1024;
const WIRE_HEADER_BYTES = 64;
const WIRE_BYTES_PER_GLYPH = 28;
/** HB_BUFFER_FLAG_BEGINNING_OF_TEXT / END_OF_TEXT. */
const FLAG_BOT = 0x0001;
const FLAG_EOT = 0x0002;
/** hb_direction_t values (the wrapper's Buffer.setDirection takes the
    numeric enum, NOT a string — probe-verified 2026-10-17:
    validation-12.5-engine/probe-item-clusters.log). */
const DIRECTION = { ltr: 4, rtl: 5 };

const fail = (problem) => {
  throw new Error(problem);
};

/** The validated shape block of a request (the host validates first;
    the worker re-validates — workerData is a trust boundary here as
    everywhere else in this host). Exported for the host's validator
    so both sides apply one definition. */
function shapeFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid shape request.');
  const shape = value.shape;
  if (!shape || typeof shape !== 'object' || Array.isArray(shape)) fail('Invalid shape request.');
  if (typeof shape.text !== 'string' || shape.text.length === 0 || shape.text.length > MAX_CONTEXT_UTF16_UNITS) {
    fail('Invalid shape context text.');
  }
  const { itemStart, itemEnd } = shape;
  if (
    !Number.isSafeInteger(itemStart) || !Number.isSafeInteger(itemEnd) ||
    itemStart < 0 || itemEnd > shape.text.length || itemEnd <= itemStart
  ) {
    fail('Invalid shape item range.');
  }
  if (typeof shape.script !== 'string' || !/^[A-Za-z]{4}$/.test(shape.script)) fail('Invalid shape script.');
  if (shape.direction !== 'ltr' && shape.direction !== 'rtl') fail('Invalid shape direction.');
  const features = shape.features === undefined ? [] : shape.features;
  if (
    !Array.isArray(features) || features.length > 32 ||
    features.some((feature) => typeof feature !== 'string' || !/^[A-Za-z0-9]{4}=(on|off)$/.test(feature))
  ) {
    fail('Invalid shape features.');
  }
  return {
    text: shape.text,
    itemStart,
    itemEnd,
    script: shape.script,
    direction: shape.direction,
    features: [...features],
  };
}

let enginePromise = null;
/** Load (once per worker) the verified vendored engine wrapper. */
function loadEngine() {
  if (enginePromise === null) {
    enginePromise = (async () => {
      verifyAssets();
      const hb = await import(pathToFileURL(path.join(ASSETS, 'index.mjs')).href);
      // The wrapper binds its wasm from beside the glue; touching the
      // version forces the lazy load inside this worker so a load
      // failure surfaces as this job's error, not a later trap.
      const version = hb.versionString();
      if (typeof version !== 'string' || version.length === 0) fail('Shaping engine failed to load.');
      return hb;
    })();
  }
  return enginePromise;
}

/**
 * Convert engine glyph infos into item-relative tiled ranges.
 * Probe-verified frame (2026-10-17, probe-item-clusters.log): the
 * engine returns clusters in ORIGINAL string coordinates (the
 * addText item offset is baked into them), so item-relativity is
 * `cluster - itemStart`. `infos` are in visual order; cluster
 * boundaries are derived from the SET of cluster values, so RTL
 * descent needs no special case. The same probe measured the
 * engine's surrounding-text reach at ±5 code points — joining and
 * mark offsets beyond that reach silently differ from whole-context
 * shaping, which is exactly what the preparation layer's comparison
 * (step 1) exists to catch before any item production is consumed.
 */
function tileGlyphs(infos, itemStart, itemEnd) {
  const boundaries = [...new Set(infos.map((info) => info.cluster))].sort((a, b) => a - b);
  const endOf = (cluster) => {
    for (const boundary of boundaries) if (boundary > cluster) return boundary;
    return itemEnd;
  };
  return infos.map((info) => ({
    glyph: info.codepoint,
    clusterStart: info.cluster - itemStart,
    clusterEnd: endOf(info.cluster) - itemStart,
    xAdvance: info.xAdvance,
    yAdvance: info.yAdvance,
    xOffset: info.xOffset,
    yOffset: info.yOffset,
  }));
}

async function readWindowsShapedFont(request) {
  const shape = shapeFields(request ?? {});
  const { bytes, metrics } = await readWindowsPdfFont(request);
  const programSha256 = createHash('sha256').update(bytes).digest('hex');
  const hb = await loadEngine();
  const itemLength = shape.itemEnd - shape.itemStart;
  const blob = new hb.Blob(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const face = new hb.Face(blob, 0);
  const font = new hb.Font(face);
  font.setScale(metrics.unitsPerEm, metrics.unitsPerEm);
  const buffer = new hb.Buffer();
  buffer.addText(shape.text, shape.itemStart, itemLength);
  buffer.setDirection(DIRECTION[shape.direction]);
  buffer.setScript(shape.script);
  buffer.setLanguage('und');
  buffer.setClusterLevel(0); // HB_BUFFER_CLUSTER_LEVEL_MONOTONE_GRAPHEMES
  buffer.setFlags((shape.itemStart === 0 ? FLAG_BOT : 0) | (shape.itemEnd === shape.text.length ? FLAG_EOT : 0));
  const features = shape.features.map((feature) => hb.Feature.fromString(feature));
  hb.shape(font, buffer, features);
  const infos = buffer.getGlyphInfosAndPositions();
  // Preflight (§9.4.1): counts from the engine arrays, before any
  // result object exists. An over-cap production is a named refusal,
  // never a payload.
  if (infos.length > GLYPH_EXPANSION_FACTOR * itemLength) {
    fail(`glyph-expansion: ${infos.length} glyphs exceed 4x the item length ${itemLength} (§9.3)`);
  }
  const wireBytes = WIRE_HEADER_BYTES + infos.length * WIRE_BYTES_PER_GLYPH;
  if (wireBytes > MAX_ITEM_RESULT_BYTES) {
    fail(`result-bytes: preflighted result is ${wireBytes} bytes, over the per-item cap (§9.3)`);
  }
  const glyphs = tileGlyphs(infos, shape.itemStart, shape.itemEnd);
  let advanceX = 0;
  let advanceY = 0;
  for (const glyph of glyphs) {
    advanceX += glyph.xAdvance;
    advanceY += glyph.yAdvance;
  }
  return {
    kind: 'shaped',
    glyphs,
    advanceX,
    advanceY,
    unitsPerEm: metrics.unitsPerEm,
    faceGlyphCount: metrics.advances.length,
    programSha256,
    /** Program size for the session's transport-ledger charge
        (2x program + per-item cap, §9.4): the byte count of the
        exact program shaped, reported — never the bytes. */
    programBytes: bytes.length,
  };
}

module.exports = { readWindowsShapedFont, shapeFields, tileGlyphs, MAX_CONTEXT_UTF16_UNITS };
