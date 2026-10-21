/**
 * Bounded CFF (Compact Font Format) structural parser and Type2 charstring bounding-box
 * evaluator for name-keyed CFF 1 fonts. No font programs or glyph instructions are executed
 * for rendering: charstrings are only walked to accumulate the control-point hull of each
 * glyph, mirroring the control-point bounds the glyf reader derives from glyph headers.
 * Anything the evaluator cannot prove — the deprecated seac endchar form, unmodelled
 * operators, operand-stack or call-depth excess inside one glyph — marks that glyph's
 * bounds unknown instead of guessing, exactly like the bitmap-glyph precedent in
 * font-metrics.cjs. Structural corruption and the shared total-work budget refuse the
 * whole font, mirroring the glyf point-work safeguard.
 * Format: Adobe TN #5176 (CFF) and TN #5177 (Type2 charstrings).
 */
const MAX_CFF_GLYPHS = 65535;
const MAX_INDEX_ENTRIES = 65536;
const MAX_CHARSTRING_BYTES = 1024 * 1024;
const MAX_SUBR_DEPTH = 10;
const MAX_OPERAND_STACK = 48;
const MAX_TOTAL_WORK = 2_000_000;
const MAX_COORDINATE = 98303;
/** Structural DICT budgets, enforced before entry arrays or real strings grow. */
const MAX_DICT_BYTES = 64 * 1024;
const MAX_DICT_ENTRIES = 1024;
const MAX_DICT_REAL_DIGITS = 32;

/** @typedef {[number, number, number, number]} CffBounds */

/** @returns {never} */
function fail(message) { throw new Error(`CFF metrics: ${message}`); }
/** Per-glyph semantic failure: the glyph's bounds stay unknown, the font still parses. */
class UnknownGlyph extends Error {}
/** @returns {never} */
function unknown() { throw new UnknownGlyph('unproven glyph bounds'); }
/** @param {Buffer} data @param {number} offset @param {number} length @param {string} what */
function need(data, offset, length, what) {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset > data.length || length > data.length - offset) fail(`truncated or invalid ${what}`);
}

/**
 * Read one CFF INDEX at `offset`. Returns its entries as subarrays and the offset just
 * past the INDEX. Counts and offset sizes are validated against the table length.
 * @param {Buffer} data @param {number} offset @param {string} what @returns {{ entries: Buffer[], end: number }}
 */
function readIndex(data, offset, what) {
  need(data, offset, 2, `${what} INDEX`);
  const count = data.readUInt16BE(offset);
  if (count > MAX_INDEX_ENTRIES) fail(`invalid ${what} INDEX count`);
  if (!count) return { entries: [], end: offset + 2 };
  need(data, offset + 2, 1, `${what} INDEX offset size`);
  const offSize = data[offset + 2];
  if (offSize < 1 || offSize > 4) fail(`invalid ${what} INDEX offset size`);
  const offsetsAt = offset + 3, dataAt = offsetsAt + (count + 1) * offSize;
  need(data, offsetsAt, (count + 1) * offSize, `${what} INDEX offsets`);
  const readOffset = (index) => {
    let value = 0;
    for (let i = 0; i < offSize; i++) value = value * 256 + data[offsetsAt + index * offSize + i];
    return value;
  };
  const entries = [];
  let previous = readOffset(0);
  if (previous !== 1) fail(`invalid ${what} INDEX first offset`);
  for (let i = 0; i < count; i++) {
    const next = readOffset(i + 1);
    if (next < previous) fail(`invalid ${what} INDEX offset order`);
    need(data, dataAt + previous - 1, next - previous, `${what} INDEX entry`);
    entries.push(data.subarray(dataAt + previous - 1, dataAt + next - 1));
    previous = next;
  }
  return { entries, end: dataAt + previous - 1 };
}

/**
 * Decode the operands/operators of one DICT. Operand values are numbers; operators are
 * returned as their (possibly two-byte) code. Malformed encodings refuse the font.
 * @param {Buffer} data @returns {{ operands: number[], op: number }[]}
 */
function parseDict(data) {
  // Bound the structure before allocating anything: genuine Top/Private DICTs
  // are a few hundred bytes, so these generous caps only refuse abuse.
  if (data.length > MAX_DICT_BYTES) fail('CFF DICT exceeds the safe size limit');
  const entries = [];
  let operands = [];
  let position = 0;
  const push = (value) => { operands.push(value); if (operands.length > MAX_OPERAND_STACK) fail('CFF DICT operand stack exceeds the safe limit'); };
  while (position < data.length) {
    const byte = data[position];
    if (byte <= 21) {
      if (entries.length >= MAX_DICT_ENTRIES) fail('CFF DICT entry count exceeds the safe limit');
      let op = byte;
      position++;
      if (byte === 12) {
        need(data, position, 1, 'CFF DICT operator');
        op = 1200 + data[position];
        position++;
      }
      entries.push({ operands, op });
      operands = [];
    } else if (byte === 28) {
      need(data, position, 3, 'CFF DICT number');
      push(data.readInt16BE(position + 1)); position += 3;
    } else if (byte === 29) {
      need(data, position, 5, 'CFF DICT number');
      push(data.readInt32BE(position + 1)); position += 5;
    } else if (byte === 30) {
      position++;
      let text = '', done = false;
      while (!done) {
        need(data, position, 1, 'CFF DICT real number');
        const packed = data[position++];
        for (const nibble of [packed >> 4, packed & 15]) {
          if (nibble <= 9) text += String(nibble);
          else if (nibble === 10) text += '.';
          else if (nibble === 11) text += 'E';
          else if (nibble === 12) text += 'E-';
          else if (nibble === 14) text += '-';
          else if (nibble === 15) { done = true; break; }
          else fail('invalid CFF DICT real number');
          if (text.length > MAX_DICT_REAL_DIGITS) fail('CFF DICT real number exceeds the safe limit');
        }
      }
      const value = Number(text);
      if (!Number.isFinite(value)) fail('invalid CFF DICT real number');
      push(value);
    } else if (byte === 255 || byte >= 22 && byte <= 31) fail('invalid CFF DICT number');
    else if (byte >= 247 && byte <= 254) {
      need(data, position, 2, 'CFF DICT number');
      const second = data[position + 1];
      push(byte <= 250 ? (byte - 247) * 256 + second + 108 : -((byte - 251) * 256) - second - 108);
      position += 2;
    } else {
      push(byte - 139); position++;
    }
  }
  if (operands.length) fail('CFF DICT ends with unused operands');
  return entries;
}

/** @param {number} count @returns {number} the subr bias for a subr INDEX of this size */
function subrBias(count) { return count < 1240 ? 107 : count < 33900 ? 1131 : 32768; }

/**
 * Parse and structurally validate a 'CFF ' table for a name-keyed CFF 1 font with
 * `glyphCount` glyphs. CID-keyed fonts (a ROS operator in the Top DICT) and CFF2 are
 * refused: their character codes are collection CIDs, not glyph ids.
 * @param {Buffer} data the 'CFF ' table bytes
 * @param {number} glyphCount glyph count from the SFNT maxp table
 * @param {number} [unitsPerEm] head unitsPerEm, when the caller knows it: the effective
 * FontMatrix (default .001 scale when absent) is only accepted when its uniform scale is consistent with it
 * @returns {{ charStrings: Buffer[], localSubrs: Buffer[], globalSubrs: Buffer[] }}
 */
function parseCff(data, glyphCount, unitsPerEm) {
  if (!Number.isInteger(glyphCount) || glyphCount < 1 || glyphCount > MAX_CFF_GLYPHS) fail('invalid CFF glyph count');
  need(data, 0, 4, 'CFF header');
  const major = data[0];
  if (major === 2) fail('CFF2 outlines are unsupported');
  if (major !== 1) fail('unsupported CFF version');
  const headerSize = data[2], offSize = data[3];
  if (headerSize < 4 || offSize < 1 || offSize > 4) fail('invalid CFF header');
  need(data, 0, headerSize, 'CFF header');
  const names = readIndex(data, headerSize, 'CFF name');
  if (names.entries.length !== 1) fail('a CFF table in one SFNT face must contain exactly one font');
  const topIndex = readIndex(data, names.end, 'CFF top DICT');
  if (topIndex.entries.length !== 1) fail('a CFF table in one SFNT face must contain exactly one top DICT');
  const strings = readIndex(data, topIndex.end, 'CFF string');
  const globalSubrs = readIndex(data, strings.end, 'CFF global subr');
  let charsetOffset, charStringsOffset, privateSize, privateOffset, cidKeyed = false;
  let charstringType, paintType, fontMatrix;
  for (const { operands, op } of parseDict(topIndex.entries[0])) {
    if (op === 1230 || op === 1236 || op === 1237) cidKeyed = true;
    else if (op === 15) { if (operands.length !== 1) fail('invalid CFF charset offset'); charsetOffset = operands[0]; }
    else if (op === 17) { if (operands.length !== 1) fail('invalid CFF CharStrings offset'); charStringsOffset = operands[0]; }
    else if (op === 18) { if (operands.length !== 2) fail('invalid CFF Private DICT reference'); [privateSize, privateOffset] = operands; }
    else if (op === 1206) { if (operands.length !== 1) fail('invalid CFF CharstringType'); charstringType = operands[0]; }
    else if (op === 1205) { if (operands.length !== 1) fail('invalid CFF PaintType'); paintType = operands[0]; }
    else if (op === 1220) fail('synthetic CFF fonts (SyntheticBase) are not supported');
    else if (op === 1207) { if (operands.length !== 6) fail('invalid CFF FontMatrix'); fontMatrix = operands; }
  }
  if (cidKeyed) fail('CID-keyed CFF fonts are not supported; use Canvas fallback');
  // The evaluator models Type 2 charstrings only; a declared Type 1 program
  // (CharstringType 1) must never be walked as if it were Type 2.
  if (charstringType !== undefined && charstringType !== 2) fail('unsupported CFF CharstringType; Type 2 charstrings are required');
  // PaintType 2 strokes its outlines; hull bounds of the fill path would lie.
  if (paintType !== undefined && paintType !== 0) fail('stroking CFF outlines (PaintType 2) are not supported');
  // A FontMatrix is supported only when it is exactly the uniform glyph-space
  // scale the metrics contract assumes; anything else (rotation, shear,
  // translation, a scale at odds with head unitsPerEm) would silently rescale
  // or distort every reported bound, so it refuses instead of guessing.
  if (fontMatrix) {
    const [a, b, c, d, e, f] = fontMatrix;
    if (!fontMatrix.every(Number.isFinite) || b !== 0 || c !== 0 || e !== 0 || f !== 0 || !(a > 0) || a !== d) fail('unsupported CFF FontMatrix; only a uniform glyph-space scale is supported');
  }
  // An omitted FontMatrix uses the CFF default .001 scale, not 1/unitsPerEm.
  const matrixScale = fontMatrix ? fontMatrix[0] : 0.001;
  if (unitsPerEm !== undefined && Math.abs(matrixScale * unitsPerEm - 1) > 1e-4) fail('CFF FontMatrix does not match the head unitsPerEm');
  if (charStringsOffset === undefined) fail('missing CFF CharStrings offset');
  // The charset is validated in place; bounds need only its coverage, never its SIDs' names.
  const maxSid = 391 + strings.entries.length;
  const charset = charsetOffset ?? 0;
  if (!Number.isInteger(charset) || charset < 0) fail('invalid CFF charset offset');
  if (charset > 2) {
    need(data, charset, 1, 'CFF charset');
    const format = data[charset];
    let covered = 0, position = charset + 1;
    if (format === 0) {
      need(data, position, (glyphCount - 1) * 2, 'CFF charset');
      for (let i = 0; i < glyphCount - 1; i++) if (data.readUInt16BE(position + i * 2) >= maxSid) fail('invalid CFF charset glyph name');
      covered = glyphCount - 1;
    } else if (format === 1 || format === 2) {
      while (covered < glyphCount - 1) {
        need(data, position, format === 1 ? 3 : 4, 'CFF charset range');
        const first = data.readUInt16BE(position), left = format === 1 ? data[position + 2] : data.readUInt16BE(position + 2);
        if (first >= maxSid || first + left >= maxSid) fail('invalid CFF charset glyph name');
        covered += left + 1;
        position += format === 1 ? 3 : 4;
      }
    } else fail('unsupported CFF charset format');
    if (covered !== glyphCount - 1) fail('CFF charset does not cover the SFNT glyph count');
  }
  const charStrings = readIndex(data, charStringsOffset, 'CFF CharStrings');
  if (charStrings.entries.length !== glyphCount) fail('CFF CharStrings count does not match the SFNT glyph count');
  for (const entry of charStrings.entries) if (entry.length > MAX_CHARSTRING_BYTES) fail('CFF charstring exceeds the safe size limit');
  let localSubrs = [];
  if (privateOffset !== undefined) {
    if (privateSize === undefined || privateOffset === undefined || !Number.isInteger(privateSize) || !Number.isInteger(privateOffset) || privateSize < 0) fail('invalid CFF Private DICT reference');
    need(data, privateOffset, privateSize, 'CFF Private DICT');
    let subrsOffset;
    for (const { operands, op } of parseDict(data.subarray(privateOffset, privateOffset + privateSize))) {
      if (op === 19) { if (operands.length !== 1) fail('invalid CFF Subrs offset'); subrsOffset = operands[0]; }
    }
    if (subrsOffset !== undefined) {
      if (!Number.isInteger(subrsOffset) || subrsOffset < 0) fail('invalid CFF Subrs offset');
      localSubrs = readIndex(data, privateOffset + subrsOffset, 'CFF local subr').entries;
    }
  }
  return { charStrings: charStrings.entries, localSubrs, globalSubrs: globalSubrs.entries };
}

/**
 * Walk one glyph's Type2 charstring (and its subrs) accumulating the control-point hull.
 * The current point, operand stack and hint state are shared with subrs, as the format
 * requires. Shared `work` accounting keeps pathological fonts inside the total budget.
 * @param {{ charStrings: Buffer[], localSubrs: Buffer[], globalSubrs: Buffer[] }} cff
 * @param {number} glyph @param {{ work: number }} budget
 * @returns {CffBounds}
 */
function evaluateGlyph(cff, glyph, budget) {
  const state = { x: 0, y: 0, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, points: 0, stems: 0, stack: /** @type {number[]} */ ([]), firstOp: true };
  const point = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > MAX_COORDINATE || Math.abs(y) > MAX_COORDINATE) unknown();
    state.x = x; state.y = y; state.points++;
    if (x < state.minX) state.minX = x; if (x > state.maxX) state.maxX = x;
    if (y < state.minY) state.minY = y; if (y > state.maxY) state.maxY = y;
  };
  const charge = (amount) => { budget.work += amount; if (budget.work > MAX_TOTAL_WORK) fail('CFF charstring work exceeds the safe limit'); };
  /**
   * Consume the operand stack for one operator, applying the width rule: when the first
   * operator of the glyph charstring carries one operand more than its pattern, that
   * operand is the advance width and never a coordinate.
   * @param {(count: number) => boolean} widthWhen @param {(operands: number[]) => number[] | null} validate
   */
  const take = (widthWhen, validate) => {
    let operands = state.stack.splice(0, state.stack.length);
    if (state.firstOp) {
      state.firstOp = false;
      if (widthWhen(operands.length)) operands = operands.slice(1);
    }
    const checked = validate(operands);
    if (checked === null) unknown();
    return /** @type {number[]} */ (checked);
  };
  const exact = (count) => (operands) => operands.length === count ? operands : null;
  const pairs = (operands) => operands.length && operands.length % 2 === 0 ? operands : null;
  /** @param {Buffer} bytes @param {number} depth @returns {'ended' | 'returned'} */
  const exec = (bytes, depth) => {
    let position = 0;
    const push = (value) => { state.stack.push(value); if (state.stack.length > MAX_OPERAND_STACK) unknown(); charge(1); };
    while (position < bytes.length) {
      const byte = bytes[position];
      if (byte === 28) {
        if (position + 2 >= bytes.length) unknown();
        push(bytes.readInt16BE(position + 1)); position += 3; continue;
      }
      if (byte === 255) {
        if (position + 4 >= bytes.length) unknown();
        push(bytes.readInt32BE(position + 1) / 65536); position += 5; continue;
      }
      if (byte >= 32) {
        if (byte <= 246) { push(byte - 139); position++; }
        else {
          if (position + 1 >= bytes.length) unknown();
          const second = bytes[position + 1];
          push(byte <= 250 ? (byte - 247) * 256 + second + 108 : -((byte - 251) * 256) - second - 108);
          position += 2;
        }
        continue;
      }
      charge(1);
      if (byte === 14) { // endchar: at any depth it finishes the glyph (a subr may
        // end with endchar instead of return, TN5177 section 2.3); the termination
        // propagates out through every enclosing call.
        const operands = state.stack.splice(0, state.stack.length);
        // 0 operands: plain end. 1: width only before the first width-taking
        // operator. 4/5: the deprecated seac form composes two other glyphs,
        // which this evaluator does not model.
        if (operands.length === 0 || (state.firstOp && operands.length === 1)) return 'ended';
        unknown();
      }
      if (byte === 11) { // return
        if (depth === 0) unknown();
        return 'returned';
      }
      if (byte === 10 || byte === 29) { // callsubr / callgsubr: only the top operand is the subr number
        // Every other operand stays on the shared stack untouched. In particular a
        // pending width is NOT consumed here: it belongs to the first stack-clearing
        // operator, which may be the moveto inside the subroutine (TN5177 3.1).
        const operand = state.stack.pop();
        if (operand === undefined || !Number.isInteger(operand)) unknown();
        const list = byte === 10 ? cff.localSubrs : cff.globalSubrs;
        const index = operand + subrBias(list.length);
        if (index < 0 || index >= list.length) unknown();
        if (depth + 1 > MAX_SUBR_DEPTH) unknown();
        position++;
        const outcome = exec(list[index], depth + 1);
        if (outcome === 'ended') return 'ended';
        if (outcome !== 'returned') unknown();
        continue;
      }
      if (byte === 1 || byte === 3 || byte === 18 || byte === 23) { // hstem/vstem/hstemhm/vstemhm
        const operands = take((count) => count % 2 === 1, pairs);
        state.stems += operands.length / 2;
        position++; continue;
      }
      if (byte === 19 || byte === 20) { // hintmask/cntrmask: stem pairs, then mask bytes in-stream
        const operands = take((count) => count % 2 === 1, (values) => values.length % 2 === 0 ? values : null);
        state.stems += operands.length / 2;
        position++;
        const maskBytes = Math.ceil(state.stems / 8);
        if (position + maskBytes > bytes.length) unknown();
        position += maskBytes;
        continue;
      }
      if (byte === 21) { const [dx, dy] = take((count) => count === 3, exact(2)); point(state.x + dx, state.y + dy); position++; continue; }
      if (byte === 22) { const [dx] = take((count) => count === 2, exact(1)); point(state.x + dx, state.y); position++; continue; }
      if (byte === 4) { const [dy] = take((count) => count === 2, exact(1)); point(state.x, state.y + dy); position++; continue; }
      if (byte === 5) { // rlineto
        const operands = take((count) => count % 2 === 1, pairs);
        for (let i = 0; i < operands.length; i += 2) point(state.x + operands[i], state.y + operands[i + 1]);
        position++; continue;
      }
      if (byte === 6 || byte === 7) { // hlineto/vlineto alternate axes
        const operands = take((count) => count % 2 === 1, (values) => values.length ? values : null);
        operands.forEach((value, i) => {
          const horizontal = (i % 2 === 0) === (byte === 6);
          point(horizontal ? state.x + value : state.x, horizontal ? state.y : state.y + value);
        });
        position++; continue;
      }
      const curve = (operands, at) => {
        point(state.x + operands[at], state.y + operands[at + 1]);
        point(state.x + operands[at + 2], state.y + operands[at + 3]);
        point(state.x + operands[at + 4], state.y + operands[at + 5]);
      };
      if (byte === 8) { // rrcurveto
        const operands = take((count) => count % 6 === 1, (values) => values.length && values.length % 6 === 0 ? values : null);
        for (let at = 0; at < operands.length; at += 6) curve(operands, at);
        position++; continue;
      }
      if (byte === 24) { // rcurveline: curves, then one line from the last pair
        const operands = take((count) => count % 6 === 3, (values) => values.length >= 8 && (values.length - 2) % 6 === 0 ? values : null);
        for (let at = 0; at < operands.length - 2; at += 6) curve(operands, at);
        point(state.x + operands[operands.length - 2], state.y + operands[operands.length - 1]);
        position++; continue;
      }
      if (byte === 25) { // rlinecurve: lines, then one curve from the last six
        const operands = take((count) => count % 2 === 1, (values) => values.length >= 8 && values.length % 2 === 0 ? values : null);
        for (let i = 0; i < operands.length - 6; i += 2) point(state.x + operands[i], state.y + operands[i + 1]);
        curve(operands, operands.length - 6);
        position++; continue;
      }
      if (byte === 27 || byte === 26) { // hhcurveto / vvcurveto
        const operands = take((count) => count % 4 === 2, (values) => values.length >= 4 && (values.length % 4 === 0 || values.length % 4 === 1) ? values : null);
        let at = 0, cross = 0;
        if (operands.length % 4 === 1) { cross = operands[0]; at = 1; }
        let first = true;
        for (; at < operands.length; at += 4) {
          const [a, b, c, d] = [operands[at], operands[at + 1], operands[at + 2], operands[at + 3]];
          if (byte === 27) { // horizontal tangents: c1 (dx, cross?), c2 (+dx,+dy), end (+dx, same y)
            point(state.x + a, state.y + (first ? cross : 0));
            point(state.x + b, state.y + c);
            point(state.x + d, state.y);
          } else {
            point(state.x + (first ? cross : 0), state.y + a);
            point(state.x + b, state.y + c);
            point(state.x, state.y + d);
          }
          first = false;
        }
        position++; continue;
      }
      if (byte === 30 || byte === 31) { // vhcurveto / hvcurveto: groups of four alternate the starting tangent axis
        const operands = take((count) => count % 4 === 2, (values) => values.length >= 4 && (values.length % 4 === 0 || values.length % 4 === 1) ? values : null);
        // The optional extra operand is the LAST one, not a first-curve control
        // delta as in hh/vvcurveto: it extends the final curve's endpoint along
        // the axis that curve's end delta lacks (TN5177 section 4.1).
        const hasTail = operands.length % 4 === 1;
        const tail = hasTail ? operands[operands.length - 1] : 0;
        const groups = (operands.length - (hasTail ? 1 : 0)) / 4;
        for (let group = 0; group < groups; group++) {
          const [a, b, c, d] = [operands[group * 4], operands[group * 4 + 1], operands[group * 4 + 2], operands[group * 4 + 3]];
          const horizontal = (group % 2 === 0) === (byte === 31);
          const extend = group === groups - 1 && hasTail ? tail : 0;
          if (horizontal) { // deltas (dx,0) (dx,dy) (tail?,dy): end delta lacks x
            point(state.x + a, state.y);
            point(state.x + b, state.y + c);
            point(state.x + extend, state.y + d);
          } else { // deltas (0,dy) (dx,dy) (dx,tail?): end delta lacks y
            point(state.x, state.y + a);
            point(state.x + b, state.y + c);
            point(state.x + d, state.y + extend);
          }
        }
        position++; continue;
      }
      if (byte === 12) {
        if (position + 1 >= bytes.length) unknown();
        const escape = bytes[position + 1];
        if (escape === 34) { // hflex: dx1 dx2 dy2 dx3 dx4 dx5 dx6 (TN5177 4.1)
          // Start/end points and first/last control points share the starting y;
          // the joining point and its neighbours share one y, so the second
          // curve's second control point cancels dy2 exactly.
          const operands = take((count) => count === 8, exact(7));
          const startY = state.y;
          point(state.x + operands[0], startY);
          point(state.x + operands[1], state.y + operands[2]);
          point(state.x + operands[3], state.y);
          point(state.x + operands[4], state.y);
          point(state.x + operands[5], startY);
          point(state.x + operands[6], startY);
        } else if (escape === 35) { // flex: six delta pairs; the depth operand moves no point
          const operands = take((count) => count === 14, exact(13));
          curve(operands, 0); curve(operands, 6);
        } else if (escape === 36) { // hflex1: dx1 dy1 dx2 dy2 dx3 dx4 dx5 dy5 dx6
          // Like hflex, but the first curve is unconstrained; the endpoint still
          // returns to the starting y (the total dy cancels).
          const operands = take((count) => count === 10, exact(9));
          const startY = state.y;
          point(state.x + operands[0], state.y + operands[1]);
          point(state.x + operands[2], state.y + operands[3]);
          point(state.x + operands[4], state.y);
          point(state.x + operands[5], state.y);
          point(state.x + operands[6], state.y + operands[7]);
          point(state.x + operands[8], startY);
        } else if (escape === 37) { // flex1: five delta pairs plus d6
          // The final point follows d6 along the dominant axis; its other
          // coordinate RETURNS to the flex starting point's coordinate instead
          // of keeping the final control point's (TN5177 4.1, Figure 3).
          const operands = take((count) => count === 12, exact(11));
          const startX = state.x, startY = state.y;
          curve(operands, 0);
          point(state.x + operands[6], state.y + operands[7]); point(state.x + operands[8], state.y + operands[9]);
          let totalX = 0, totalY = 0;
          for (let i = 0; i < 10; i += 2) { totalX += operands[i]; totalY += operands[i + 1]; }
          if (Math.abs(totalX) > Math.abs(totalY)) point(state.x + operands[10], startY); else point(startX, state.y + operands[10]);
        } else unknown();
        position += 2; continue;
      }
      // Reserved and unmodelled operators (arithmetic escapes, dotsection, ...) are
      // never guessed: this glyph's bounds stay unknown.
      unknown();
    }
    // Running off the end of a charstring without endchar (or of a subr without
    // return) means the glyph's outline was never completed.
    return unknown();
  };
  // A zero-length charstring has no endchar terminator, so nothing about the
  // glyph is proven; it is unknown rather than a known empty outline.
  if (!cff.charStrings[glyph].length) unknown();
  if (exec(cff.charStrings[glyph], 0) !== 'ended' || state.stack.length) unknown();
  if (!state.points) return [0, 0, 0, 0];
  return [Math.floor(state.minX), Math.floor(state.minY), Math.ceil(state.maxX), Math.ceil(state.maxY)];
}

/**
 * Bounds for every glyph of a name-keyed CFF 1 font. Glyphs the evaluator cannot prove
 * are reported with zero bounds and `known: false`, mirroring the bitmap precedent.
 * @param {Buffer | Uint8Array} cffTable the 'CFF ' table bytes
 * @param {number} glyphCount glyph count from the SFNT maxp table
 * @param {number} [unitsPerEm] head unitsPerEm, forwarded to the FontMatrix check
 * @returns {{ glyphBounds: CffBounds[], glyphBoundsKnown: boolean[] }}
 */
function cffGlyphBounds(cffTable, glyphCount, unitsPerEm) {
  const data = Buffer.isBuffer(cffTable) ? cffTable : Buffer.from(cffTable.buffer, cffTable.byteOffset, cffTable.byteLength);
  const cff = parseCff(data, glyphCount, unitsPerEm);
  const budget = { work: 0 };
  const glyphBounds = /** @type {CffBounds[]} */ ([]), glyphBoundsKnown = [];
  for (let glyph = 0; glyph < glyphCount; glyph++) {
    try {
      glyphBounds.push(evaluateGlyph(cff, glyph, budget));
      glyphBoundsKnown.push(true);
    } catch (error) {
      if (!(error instanceof UnknownGlyph)) throw error;
      glyphBounds.push([0, 0, 0, 0]);
      glyphBoundsKnown.push(false);
    }
  }
  return { glyphBounds, glyphBoundsKnown };
}

module.exports = { cffGlyphBounds, parseCff, MAX_CFF_GLYPHS, MAX_CHARSTRING_BYTES, MAX_TOTAL_WORK };
