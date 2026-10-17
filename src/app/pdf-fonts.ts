import type { DrawingState } from '../core/document';
import { explodeInsert, mtextParts, dimensionParts, leaderParts, tableParts, type Entity, type BlockLookup } from '../core/entities';
import { layoutsOf, paperEntities } from '../core/layouts';
import type { FontMetricsRequest, TextAppearance, TextGeometryContext } from '../core/text-metrics';
import { textFontKey } from '../core/text-metrics';
import { textStylesOf } from '../io/encoding';
import { PdfFontRegistry, type PdfFontFace, type PdfShapedLine, type PdfShapedSegment } from '../io/pdf-fonts';
import { itemizeParagraph } from '../core/text-pipeline';
import { sha256BytesHex, sha256Hex } from '../core/sha256';
import { pdfGroupEntityVisible, pdfGroupView, type PdfDrawGroup } from '../io/pdf-vector';
import { expandControlCodes, findTextStyle, strokeTextWidth, UNICODE_FALLBACK_FONT } from '../render/hershey';
import { createTextGeometryContext, FontMetricsRegistry } from '../render/font-metrics';
import { capturedPlotLookup } from './plot-fonts';

export type PdfFontResult = { readonly font: Omit<PdfFontFace, 'key'> | null; readonly problem?: string };
/** Shaping hooks factory for captured-plot geometry contexts,
    set by app bootstrap when the Windows shape bridge exists.
    Kept as an injected factory so this module never imports the
    session implementation directly. */
let pdfShapingFactory: import('../core/text-metrics').ShapingHooksFactory | undefined;
export function setPdfShapingFactory(factory: import('../core/text-metrics').ShapingHooksFactory | undefined): void {
  pdfShapingFactory = factory;
}

export type PdfFontReader = (request: FontMetricsRequest) => Promise<PdfFontResult>;
export const pdfFontKey = textFontKey;
const familyName = (face: Extract<TextAppearance, { kind: 'canvas' }>) => face.family.split(',')[0]!.trim().replace(/^"|"$/g, '');

/** Programs and matching geometry stay local to a captured PDF, outside global font caches. */
export async function capturedPdfLookup(state: DrawingState, reader?: PdfFontReader, groups?: readonly PdfDrawGroup[], capturedLookup?: BlockLookup, options?: { restricted?: boolean }) {
  const restricted = options?.restricted === true;
  const initialLookup = capturedLookup ?? await capturedPlotLookup(state);
  const strokeGeometry = initialLookup.textGeometry?.shxRun ? initialLookup.textGeometry : undefined;
  if (!reader) return { lookup: initialLookup, fonts: undefined, geometry: strokeGeometry, issues: [] as string[], restrictedFaces: [] as { key: string; request: FontMetricsRequest }[] };
  const read: PdfFontReader = restricted ? (request) => reader({ ...request, restricted: true }) : reader;
  const styles = textStylesOf(state), metrics = new FontMetricsRegistry();
  if (pdfShapingFactory) metrics.setShapingFactory(pdfShapingFactory);
  const native = createTextGeometryContext(styles, metrics);
  const wanted = new Map<string, { face: Extract<TextAppearance, { kind: 'canvas' }>; request: FontMetricsRequest }>();
  const usedByKey = new Map<string, Set<number>>();
  const plotted = new Map<string, { plain: string; face: Extract<TextAppearance, { kind: 'canvas' }> }>();
  const discover = (input: Parameters<TextGeometryContext['resolve']>[0]) => {
    const selected = strokeGeometry?.resolve(input);
    const face = selected?.kind === 'stroke' ? selected : native.resolve(input);
    if (face.kind === 'canvas') {
      const style = findTextStyle(input.style, styles);
      wanted.set(pdfFontKey(face), { face, request: { font: (face.strokeFallback ? UNICODE_FALLBACK_FONT : style?.font || style?.family || familyName(face)).replace(/^.*[\\/]/, ''), family: familyName(face), bold: face.bold, italic: face.italic } });
    }
    return face;
  };
  const discoverLookup: BlockLookup = (name: string) => state.blocks[name];
  const visit = (entities: readonly Entity[], hidden: ReadonlySet<string>, depth = 0) => {
    if (depth > 32) return;
    for (const e of entities) {
      if (hidden.has(e.layer) || state.layers.find((layer) => layer.name === e.layer)?.plot === false) continue;
      if (e.type === 'text') {
        if (e.text.trim()) {
          const face = discover(e);
          if (face.kind === 'canvas') {
            // Accumulate the plotted strings' codepoints for this face: the PDF
            // reader point-validates only those glyphs (plus closure and capital
            // A). Anything this walk somehow misses stays unvalidated, and the
            // writer falls back for that run instead of trusting it.
            // Collection is keyed by the face discover() finally returns for
            // the run — never by the pre-fallback style font — so a face that
            // resolution substituted (including a Unicode fallback face) still
            // receives its plotted characters. Stroke faces collect nothing:
            // native SHX glyphs keep priority whenever they cover a run.
            const key = pdfFontKey(face);
            let used = usedByKey.get(key);
            if (!used) usedByKey.set(key, used = new Set());
            const plain = expandControlCodes(e.text.replace(/%%[uUoOkK]/g, ''));
            plotted.set(`${key}\n${plain}`, { plain, face });
            for (const source of [e.text, plain]) for (const character of source) {
              if (used.size >= 65534) break;
              used.add(character.codePointAt(0)!);
            }
          }
        }
      }
      else if (e.type === 'insert') visit(explodeInsert(e, discoverLookup), hidden, depth + 1);
      else if (e.type === 'mtext') visit(mtextParts(e), hidden, depth + 1);
      else if (e.type === 'dimension') visit(dimensionParts(e), hidden, depth + 1);
      else if (e.type === 'leader') visit(leaderParts(e), hidden, depth + 1);
      else if (e.type === 'table') visit(tableParts(e), hidden, depth + 1);
    }
  };
  const hidden = new Set(state.layers.filter((layer) => !layer.visible || layer.plot === false).map((layer) => layer.name));
  if (groups) for (const group of groups) {
    const view = pdfGroupView(group);
    visit(group.entities.filter((entity) => pdfGroupEntityVisible(entity, group, initialLookup, view)), group.hidden);
  }
  else {
    visit(state.entities, hidden);
    for (const layout of layoutsOf(state)) visit(paperEntities(layout), hidden);
  }
  const faces: PdfFontFace[] = [], issues: string[] = [];
  let bytes = 0;
  for (const [key, { face, request }] of wanted) {
    if (faces.length >= 8) { issues.push(`Font ${request.family}: PDF font limit reached.`); continue; }
    try {
      const used = usedByKey.get(key);
      const result = await read(used?.size ? { ...request, usedCodepoints: [...used].sort((a, b) => a - b) } : request);
      if (!result.font) { issues.push(`Font ${request.family}: ${result.problem || 'installed font unavailable'}`); continue; }
      if (!(result.font.bytes instanceof Uint8Array) || bytes + result.font.bytes.byteLength > 128 * 1024 * 1024) { issues.push(`Font ${request.family}: PDF font size limit reached.`); continue; }
      const candidate = { ...result.font, key };
      // Validate the actual program before accepting geometry from its metrics.
      const checked = new PdfFontRegistry([candidate], { restricted });
      const problem = checked.rejections.get(key);
      if (problem) { issues.push(`Font ${request.family}: ${problem}`); continue; }
      const accepted = checked.face(key)!;
      metrics.register(face, accepted.metrics);
      faces.push(accepted); bytes += accepted.bytes.byteLength;
    } catch (error) { issues.push(`Font ${request.family}: ${error instanceof Error ? error.message : 'font unavailable'}`); }
  }
  const fonts = new PdfFontRegistry(faces, { restricted });
  // Shaping preparation (12.5 step 3): prepare every plotted text
  // that itemizes with shaped items, so the writer finds ready
  // runs synchronously. Without a bridge (non-Windows) the calls
  // are no-ops on a context with no hooks, states stay missing,
  // and the plot falls back with the reason in fontIssues.
  if (pdfShapingFactory && native.prepareShaping) {
    for (const { plain, face } of plotted.values()) {
      if (itemizeParagraph(plain).items.some((item) => item.route === 'shaped')) {
        await native.prepareShaping(plain, face);
      }
    }
  }
  // Descriptor claims are checked against host admission records at registration.
  // Plotting subsequently filters these to resources the PDF actually emitted.
  const restrictedFaces = restricted ? fonts.previewPrintKeys.flatMap((key) => {
    const entry = wanted.get(key);
    return entry ? [{ key, request: entry.request }] : [];
  }) : [];
  let oldNative: object | undefined, oldStroke: object | undefined, geometryKey = {};
  const geometry: TextGeometryContext | undefined = faces.length || strokeGeometry ? {
    get cacheKey() {
      if (oldNative !== native.cacheKey || oldStroke !== strokeGeometry?.cacheKey) { oldNative = native.cacheKey; oldStroke = strokeGeometry?.cacheKey; geometryKey = {}; }
      return geometryKey;
    },
    resolve(input) { const face = strokeGeometry?.resolve(input); return face?.kind === 'stroke' ? face : native.resolve(input); },
    measure(text, height, face) {
      if (face.kind === 'stroke' && strokeGeometry) return strokeGeometry.measure(text, height, face);
      const plain = expandControlCodes(text.replace(/%%[uUoOkK]/g, ''));
      if (face.kind === 'canvas' && fonts.face(pdfFontKey(face))) {
        if (native.advances?.(plain, height, face) !== null) return native.measure(plain, height, face);
        // advances() is also null for fully prepared shaped text:
        // there the shaped measurement is the native one.
        if (shapedItemsReady(native, plain, face)) return native.measure(plain, height, face);
      }
      const advance = strokeTextWidth(plain, height);
      return { advance, left: 0, right: advance, ascent: height, descent: 0 };
    },
    prepareShaping: native.prepareShaping ? (text, face) => native.prepareShaping!(text, face) : undefined,
    shaped: native.shaped ? (text, face, itemStart, itemEnd) => native.shaped!(text, face, itemStart, itemEnd) : undefined,
    shapedGlyphs: native.shapedGlyphs ? (text, face, itemStart, itemEnd) => native.shapedGlyphs!(text, face, itemStart, itemEnd) : undefined,
    fontSize: (height, face) => native.fontSize!(height, face),
    advances: (text, height, face) => native.advances!(text, height, face),
    baselineDescent: (height, face) => face.kind === 'stroke' && strokeGeometry ? strokeGeometry.baselineDescent!(height, face) : native.baselineDescent!(height, face),
    shxRun: strokeGeometry?.shxRun,
    get fontIssues() { return new Set([...(strokeGeometry?.fontIssues ?? []), ...(native.fontIssues ?? [])]); },
  } : undefined;
  const lookup: BlockLookup = Object.assign((name: string) => state.blocks[name], { textGeometry: geometry });
  const shapedText = geometry ? (text: string, face: TextAppearance) => shapedPdfLine(geometry, fonts, text, face) : undefined;
  return { lookup, fonts, geometry, issues, restrictedFaces, shapedText };
}


/** True when the text itemizes with shaped items and every one is
    ready on this context (the wrapper measure gate's shaped arm). */
function shapedItemsReady(geometry: TextGeometryContext, plain: string, face: TextAppearance): boolean {
  if (!geometry.shapedGlyphs) return false;
  const itemized = itemizeParagraph(plain);
  let any = false;
  for (const item of itemized.items) {
    if (item.route === 'refused') return false;
    if (item.route !== 'shaped') continue;
    any = true;
    if (geometry.shapedGlyphs(plain, face, item.derivation.itemStart, item.derivation.itemEnd).state !== 'ready') return false;
  }
  return any;
}

const faceProgramHashes = new WeakMap<PdfFontFace, string>();
function faceProgramHash(face: PdfFontFace): string {
  let hash = faceProgramHashes.get(face);
  if (!hash) {
    hash = sha256BytesHex(face.bytes);
    faceProgramHashes.set(face, hash);
  }
  return hash;
}

/**
 * Build the writer's shaped-line plan for one plotted text, or
 * null — today's path, byte-for-byte — when the line has no shaped
 * items, any item is unprepared or refused, a subitem was shaped
 * by a face other than the captured selected face (step-3 scope:
 * fallback-face subitems serve the screen only), or the registry
 * refuses a shaped assignment (budget, unusable glyph). Segments
 * are returned in VISUAL order (L2 over the items' uniform
 * levels); each carries its logical advance so the writer can lay
 * them out from the visual start.
 */
export function shapedPdfLine(
  geometry: TextGeometryContext,
  fonts: PdfFontRegistry,
  text: string,
  appearance: TextAppearance,
): PdfShapedLine | null {
  if (appearance.kind !== 'canvas' || !geometry.shapedGlyphs) return null;
  const plain = expandControlCodes(text.replace(/%%[uUoOkK]/g, ''));
  const itemized = itemizeParagraph(plain);
  if (!itemized.items.some((item) => item.route === 'shaped')) return null;
  const faceKey = pdfFontKey(appearance);
  const face = fonts.face(faceKey);
  if (!face) return null;
  const programHash = faceProgramHash(face);
  interface LogicalSegment { segment: PdfShapedSegment; level: number }
  const logical: LogicalSegment[] = [];
  for (const item of itemized.items) {
    if (item.route === 'refused') return null;
    const start = item.route === 'shaped' ? item.derivation.itemStart : item.itemStart;
    const end = item.route === 'shaped' ? item.derivation.itemEnd : item.itemEnd;
    const cpIndex = itemized.utf16Offsets.indexOf(start);
    const level = cpIndex >= 0 ? itemized.levels[cpIndex]! : itemized.paragraphLevel;
    if (item.route === 'direct') {
      const run = fonts.encode(faceKey, plain.slice(start, end));
      if (!run) return null;
      logical.push({
        level,
        segment: { kind: 'direct', start, end, faceKey, resourceName: run.resourceName, hex: run.hex, advance: run.advance },
      });
      continue;
    }
    const state = geometry.shapedGlyphs(plain, appearance, start, end);
    if (state.state !== 'ready') return null;
    const glyphs: { code: number; glyph: number; xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }[] = [];
    let advance = 0;
    let resourceName = '';
    for (const subitem of state.subitems) {
      if (subitem.programSha256 !== programHash) return null;
      const identity = `${subitem.programSha256}:${sha256Hex(plain)}:${start}:${end}:${subitem.start}:${subitem.end}`;
      const assigned = fonts.encodeShaped(faceKey, identity, subitem.glyphs, (cs, ce) => plain.slice(subitem.start + cs, subitem.start + ce));
      if (!assigned) return null;
      resourceName = assigned.resourceName;
      subitem.glyphs.forEach((glyph, index) => {
        glyphs.push({
          code: assigned.codes[index]!,
          glyph: glyph.glyph,
          xAdvance: glyph.xAdvance,
          yAdvance: glyph.yAdvance,
          xOffset: glyph.xOffset,
          yOffset: glyph.yOffset,
        });
        advance += glyph.xAdvance;
      });
    }
    logical.push({
      level,
      segment: {
        kind: 'shaped', start, end, faceKey, resourceName,
        direction: item.derivation.direction, glyphs, advance,
      },
    });
  }
  if (!logical.length) return null;
  // L2: from the highest level down to the lowest odd level,
  // reverse any contiguous sequence of segments at or above it.
  const order = logical.map((entry, index) => ({ ...entry, index }));
  const maxLevel = Math.max(...order.map((entry) => entry.level));
  const lowestOdd = Math.min(...order.map((entry) => entry.level).filter((level) => level % 2 === 1), Number.POSITIVE_INFINITY);
  if (lowestOdd !== Number.POSITIVE_INFINITY) {
    for (let level = maxLevel; level >= lowestOdd; level -= 1) {
      let i = 0;
      while (i < order.length) {
        if (order[i]!.level < level) { i += 1; continue; }
        let j = i;
        while (j + 1 < order.length && order[j + 1]!.level >= level) j += 1;
        const run = order.splice(i, j - i + 1).reverse();
        order.splice(i, 0, ...run);
        i = j + 1;
      }
    }
  }
  return {
    logicalText: plain,
    baseDirection: itemized.paragraphLevel % 2 === 1 ? 'rtl' : 'ltr',
    segments: order.map((entry) => entry.segment),
  };
}
