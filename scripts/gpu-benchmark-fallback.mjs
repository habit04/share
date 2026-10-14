/** Exact native safety refusals observed on the unchanged mixed-schematic poses. */
export const mixedSchematicFallbackReasons = Object.freeze([
  'Curve stroke overlap or precision margin requires Canvas rendering (b5)',
  'Unsupported Canvas stroke construction: native float curve parameters exceed precision budget',
  'Unsupported Canvas stroke construction: native float curve oval topology is unproved',
  'Unsupported Canvas stroke construction: native float curve radius is unproved',
]);
/**
 * Match reported safety causes without accepting unrelated device/driver failures.
 * Other fixtures retain their existing expected-message policy.
 * @param {string} fixture @param {unknown} expected @param {unknown} actual
 */
export function matchesBenchmarkFallbackReason(fixture, expected, actual) {
  if (typeof expected !== 'string' || !expected || typeof actual !== 'string') return false;
  if (fixture === 'mixed-schematic') {
    return expected === 'Curve stroke overlap or precision margin requires Canvas rendering'
      && mixedSchematicFallbackReasons.includes(actual);
  }
  return actual.includes(expected);
}
