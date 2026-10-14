// Field-specific native DIMENSION roundtrip contract; actual authored data and current native codec remain the reference.
import assert from 'node:assert/strict';
const epsilon = 1e-8; // Current DXF Writer formats 10 decimal places; native raster tolerances are unchanged.
const defaults = { baselineSpacing: 0.38, dimLineExtend: 0, suppressDimLine1: false, suppressDimLine2: false,
  suppressExt1: false, suppressExt2: false, arrow: 'closed-filled', textVertical: 'centered', textAlign: 'aligned',
  textJustify: 'centered', fit: 'best', textInside: false, dimLineInside: true, post: '', round: 0, linearFactor: 1,
  suppressLeadingZeros: false, suppressTrailingZeros: false, decimalSeparator: 46, textStyle: 'Standard',
  dimLineWeight: -2, extLineWeight: -2, altUnits: false, altFactor: 25.4, altDecimals: 2, altLunit: 2, altPost: '',
  altPlacement: 'after', tolerance: 'none', tolPlus: 0, tolMinus: 0, tolDecimals: 4, tolScale: 1, toleranceZeroSuppression: 0 };
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const times = (a, s) => ({ x: a.x * s, y: a.y * s });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const length = (a) => Math.hypot(a.x, a.y);
const unit = (a) => { const n = length(a); assert.ok(n > 0, 'Original nondegenerate native anchor'); return times(a, 1 / n); };
const close = (actual, expected, label) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= epsilon, `${label}: ${actual} versus original-derived ${expected}`);
const point = (actual, expected, label) => { assert.ok(actual && expected, label); close(actual.x, expected.x, `${label}.x`); close(actual.y, expected.y, `${label}.y`); };
function style(source) {
  /** @type {Record<string, any>} */
  const value = { ...defaults };
  for (const [key, member] of Object.entries(source)) if (member !== undefined) value[key] = member;
  value.arrow2 = source.arrow2 ?? source.arrow ?? defaults.arrow;
  return value;
}
export function nativeAnchorPrediction(source) {
  const output = { p1: source.p1, p2: source.p2, linePoint: source.linePoint, center: source.center, changes: [] };
  if (source.kind === 'linear' || source.kind === 'aligned') {
    const u = source.kind === 'linear' ? { x: Math.cos(source.rotation), y: Math.sin(source.rotation) } : unit(sub(source.p2, source.p1));
    output.linePoint = add(source.linePoint, times(u, dot(sub(source.p2, source.linePoint), u)));
    output.changes.push({ field: 'linePoint', before: source.linePoint, predicted: output.linePoint,
      basis: 'write-annotations.ts group10 = linePoint + u*dot(p2-linePoint,u); read-annotations.ts consumes native definition point. Original perpendicular dimension-line locus must remain unchanged.' });
  } else if (source.kind === 'radius' || source.kind === 'diameter') {
    const radius = length(sub(source.p2, source.p1));
    const toLoc = sub(source.linePoint, source.p1), dir = unit(length(toLoc) > 1e-9 ? toLoc : sub(source.p2, source.p1));
    const q = add(source.p1, times(dir, radius)), far = add(source.p1, times(dir, -radius));
    output.p1 = source.kind === 'diameter' ? times(add(q, far), 0.5) : source.p1;
    output.p2 = q;
    const leader = Math.max(0, length(sub(source.linePoint, q)));
    output.linePoint = source.textPosition ?? add(q, times(unit(sub(q, output.p1)), leader));
    output.changes.push({ field: 'p2', before: source.p2, predicted: q,
      basis: 'write-annotations.ts radialPoints rotates equal-radius definition q toward ORIGINAL linePoint; native radius15 / diameter10; reader p2=q. Original center/radius/leader and measurement remain required.' });
    if (source.kind === 'diameter') output.changes.push({ field: 'p1', before: source.p1, predicted: output.p1, basis: 'Reader midpoint(native q,far); native endpoints derive from original center/radius.' });
    output.changes.push({ field: 'linePoint', before: source.linePoint, predicted: output.linePoint,
      basis: 'Reader explicit userText(group11,flag128) or q + normalized(q-center)*leader40. This field is predicted exactly; unchanged raster is separately required.' });
  }
  return output;
}
export function measurement(source) {
  if (source.kind === 'linear') return Math.abs(dot(sub(source.p2, source.p1), { x: Math.cos(source.rotation), y: Math.sin(source.rotation) }));
  if (source.kind === 'aligned' || source.kind === 'radius') return length(sub(source.p2, source.p1));
  if (source.kind === 'diameter') return 2 * length(sub(source.p2, source.p1));
  assert.equal(source.kind, 'angular');
  const a = sub(source.p1, source.center), b = sub(source.p2, source.center);
  // The retained original fixture has a counterclockwise quarter-circle selected by linePoint.
  const normalized = (Math.atan2(b.y, b.x) - Math.atan2(a.y, a.x) + Math.PI * 2) % (Math.PI * 2);
  assert.ok(normalized > 0 && normalized < Math.PI, 'Bounded original angular measurement contract');
  return normalized;
}
export function verifyReopenedDimension(actual, original) {
  assert.equal(actual.type, 'dimension'); assert.equal(actual.kind, original.kind);
  const predicted = nativeAnchorPrediction(original);
  for (const field of ['p1', 'p2', 'linePoint']) point(actual[field], predicted[field], `${original.id}:${field}`);
  if (original.center) point(actual.center, original.center, `${original.id}:center`); else assert.equal(actual.center, undefined);
  close(actual.rotation, original.rotation, `${original.id}:rotation`);
  close(measurement(actual), measurement(original), `${original.id}:measurement`);
  if (original.kind === 'linear' || original.kind === 'aligned') {
    const u = original.kind === 'linear' ? { x: Math.cos(original.rotation), y: Math.sin(original.rotation) } : unit(sub(original.p2, original.p1));
    close(dot(sub(actual.linePoint, original.linePoint), { x: -u.y, y: u.x }), 0, `${original.id}:original perpendicular dimension-line locus`);
  }
  assert.deepEqual(actual.text, original.text, `${original.id}:exact raw authoring text`);
  if (original.textPosition) point(actual.textPosition, original.textPosition, `${original.id}:explicit textPosition`); else assert.equal(actual.textPosition, undefined);
  for (const angle of ['textRotation', 'oblique']) { if (original[angle] === undefined) assert.equal(actual[angle], undefined); else close(actual[angle], original[angle], `${original.id}:${angle}`); }
  const actualStyle = style(actual.style), originalStyle = style(original.style);
  assert.deepEqual(Object.keys(actualStyle).sort(), Object.keys(originalStyle).sort(), `${original.id}:no unknown style field lost or gained`);
  for (const field of Object.keys(originalStyle)) {
    if (typeof originalStyle[field] === 'number') close(actualStyle[field], originalStyle[field], `${original.id}:effective style.${field}`);
    else assert.deepEqual(actualStyle[field], originalStyle[field], `${original.id}:effective style.${field}`);
  }
  for (const field of ['layer', 'color', 'trueColor', 'lineWeight']) assert.deepEqual(actual[field], original[field], `${original.id}:original appearance.${field}`);
  assert.equal(actual.transparency ?? 255, original.transparency ?? 255);
  assert.equal(actual.linetype ?? 'ByLayer', original.linetype ?? 'ByLayer'); assert.equal(actual.ltscale ?? 1, original.ltscale ?? 1);
  return { originalId: original.id, reopenedId: actual.id, kind: original.kind, originalMeasurement: measurement(original), reopenedMeasurement: measurement(actual),
    before: original, after: actual, anchorPredictions: predicted.changes, exactRawAuthoringSource: false,
    limits: ['Supported native style overrides may be re-materialized as styleOverrides by the reader; this fixture has no arbitrary original override map.', 'No fields beyond the documented native anchor definitions and supported style defaults are exempted.', 'Independent pre-save Canvas raster is still mandatory; predicted anchors alone do not prove appearance.'] };
}
export function verifySavedNativeDimensions(text, originalDimensions) {
  const lines = text.split(/\r?\n/), sections = new Map(); let section = '', record;
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = Number(lines[index].trim()), value = lines[index + 1].trim();
    if (code === 0 && value === 'SECTION') { section = lines[index + 3]?.trim(); continue; }
    if (code === 0 && value === 'ENDSEC') { section = ''; record = null; continue; }
    if (!section) continue;
    if (code === 0) { record = { type: value, pairs: [] }; if (!sections.has(section)) sections.set(section, []); sections.get(section).push(record); }
    if (record) record.pairs.push({ code, value });
  }
  const first = (record, code) => record.pairs.find((pair) => pair.code === code)?.value;
  const number = (record, code) => Number(first(record, code));
  const nativePoint = (record, code) => ({ x: number(record, code), y: number(record, code + 10) });
  const records = (sections.get('ENTITIES') ?? []).filter((record) => record.type === 'DIMENSION');
  assert.equal(records.length, originalDimensions.length, 'All original dimensions remain native editable DIMENSION records');
  const codes = { linear: 0, aligned: 1, diameter: 3, radius: 4, angular: 5 };
  return records.map((record, index) => {
    const original = originalDimensions[index], predicted = nativeAnchorPrediction(original);
    assert.equal(number(record, 70) & 15, codes[original.kind]); close(number(record, 42), measurement(original), `${original.id}:saved native measurement`);
    assert.equal(first(record, 1), original.text); assert.equal(first(record, 3), original.style.name);
    const definition = original.kind === 'radius' ? predicted.p1 : original.kind === 'diameter' ? predicted.p2 : predicted.linePoint;
    point(nativePoint(record, 10), definition, `${original.id}:saved original-derived native definition`);
    if (original.textPosition) { assert.ok(number(record, 70) & 128); point(nativePoint(record, 11), original.textPosition, `${original.id}:native explicit text`); }
    else assert.equal(number(record, 70) & 128, 0);
    if (original.kind === 'linear' || original.kind === 'aligned' || original.kind === 'angular') { point(nativePoint(record, 13), original.p1, `${original.id}:native p1`); point(nativePoint(record, 14), original.p2, `${original.id}:native p2`); }
    if (original.kind === 'angular') point(nativePoint(record, 15), original.center, `${original.id}:native center`);
    if (original.kind === 'linear') close(number(record, 50) * Math.PI / 180, original.rotation, `${original.id}:native rotation`);
    if (original.kind === 'radius' || original.kind === 'diameter') {
      const q = predicted.p2, far = add(original.p1, times(sub(q, original.p1), -1));
      point(nativePoint(record, 15), original.kind === 'radius' ? q : far, `${original.id}:native q/far from ORIGINAL authoring anchors`);
      close(number(record, 40), Math.max(0, length(sub(original.linePoint, q))), `${original.id}:native original leader`);
    }
    const pictureName = first(record, 2); assert.match(pictureName, /^\*D\d+$/);
    const block = (sections.get('BLOCKS') ?? []).find((entry) => entry.type === 'BLOCK' && first(entry, 2) === pictureName);
    assert.ok(block, `${original.id}:native picture block exists`); assert.ok(first(block, 330), 'Native picture has a block-record owner');
    const blockEntries = sections.get('BLOCKS') ?? [], position = blockEntries.indexOf(block), paint = [];
    for (let part = position + 1; part < blockEntries.length && blockEntries[part].type !== 'ENDBLK'; part++) {
      if (blockEntries[part].type === 'BLOCK') throw new Error('Native DIM picture is unterminated');
      paint.push(blockEntries[part]); assert.equal(first(blockEntries[part], 330), first(block, 330), 'Native picture primitives have the original picture owner');
    }
    assert.ok(paint.length > 0, 'Native DIM picture is nonempty; no command-part count is invented');
    assert.ok(first(record, 330), 'Native editable dimension has an owner');
    return { originalId: original.id, nativeKind: number(record, 70) & 15, measurement: number(record, 42), pictureName, owner: first(record, 330), pictureOwner: first(block, 330) };
  });
}
