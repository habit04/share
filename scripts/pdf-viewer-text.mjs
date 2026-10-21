/**
 * Compare native-viewer text with independently authored, ordered text entities.
 * Viewers may insert layout separators between spatially distinct entities.
 * Never normalize, trim or replace characters inside a source entity.
 * This validation helper is not used by PDF generation or application rendering.
 */
export const PDF_VIEWER_TEXT_LIMITS = Object.freeze({
  maxActualCodeUnits: 10_000,
  maxSourceCodeUnits: 10_000,
  maxFragments: 64,
  maxSeparatorCodeUnits: 16,
});

const isLayout = value => value === ' ' || value === '\r' || value === '\n';

/**
 * Empty/edge-layout source fragments are refused instead of ambiguously
 * consuming source whitespace as an inter-entity separator. Bounds count UTF-16
 * code units; supplementary Unicode is still compared literally, without NFC.
 * @param {unknown} actual
 * @param {unknown} fragments
 * @returns {import('./pdf-viewer-text.mjs').PdfViewerTextResult}
 */
export function comparePdfViewerText(actual, fragments) {
  /** @returns {{ok: false, reason: string, fragmentIndex: number, offset: number}} */
  const reject = (reason, fragmentIndex = 0, offset = 0) => ({ ok: false, reason, fragmentIndex, offset });
  if (typeof actual !== 'string') return reject('invalid-actual');
  if (actual.length > PDF_VIEWER_TEXT_LIMITS.maxActualCodeUnits) return reject('actual-limit');
  if (!Array.isArray(fragments) || fragments.length === 0) return reject('invalid-fragments');
  if (fragments.length > PDF_VIEWER_TEXT_LIMITS.maxFragments) return reject('fragment-limit');
  let sourceUnits = 0;
  for (let index = 0; index < fragments.length; index++) {
    if (!Object.hasOwn(fragments, index)) return reject('unsupported-fragment', index);
    const fragment = fragments[index];
    if (typeof fragment !== 'string' || fragment.length === 0) return reject('unsupported-fragment', index);
    sourceUnits += fragment.length;
    if (sourceUnits > PDF_VIEWER_TEXT_LIMITS.maxSourceCodeUnits) return reject('source-limit', index);
    if (isLayout(fragment[0]) || isLayout(fragment.at(-1))) return reject('unsupported-fragment', index);
  }
  let offset = 0;
  const separators = [];
  for (let index = 0; index < fragments.length; index++) {
    const start = offset;
    while (index > 0 && offset < actual.length && isLayout(actual[offset])) {
      offset++;
      if (offset - start > PDF_VIEWER_TEXT_LIMITS.maxSeparatorCodeUnits) return reject('separator-limit', index, offset);
    }
    if (index > 0) separators.push(actual.slice(start, offset));
    if (!actual.startsWith(fragments[index], offset)) return reject('fragment-mismatch', index, offset);
    offset += fragments[index].length;
  }
  if (offset !== actual.length) return reject('trailing-content', fragments.length, offset);
  return { ok: true, sourceFragments: fragments.length, separators };
}
