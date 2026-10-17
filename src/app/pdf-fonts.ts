import type { DrawingState } from '../core/document';
import { explodeInsert, mtextParts, dimensionParts, leaderParts, tableParts, type Entity, type BlockLookup } from '../core/entities';
import { layoutsOf, paperEntities } from '../core/layouts';
import type { FontMetricsRequest, TextAppearance, TextGeometryContext } from '../core/text-metrics';
import { textFontKey } from '../core/text-metrics';
import { textStylesOf } from '../io/encoding';
import { PdfFontRegistry, type PdfFontFace } from '../io/pdf-fonts';
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
      if (face.kind === 'canvas' && fonts.face(pdfFontKey(face)) && native.advances?.(plain, height, face) !== null) return native.measure(plain, height, face);
      const advance = strokeTextWidth(plain, height);
      return { advance, left: 0, right: advance, ascent: height, descent: 0 };
    },
    fontSize: (height, face) => native.fontSize!(height, face),
    advances: (text, height, face) => native.advances!(text, height, face),
    baselineDescent: (height, face) => face.kind === 'stroke' && strokeGeometry ? strokeGeometry.baselineDescent!(height, face) : native.baselineDescent!(height, face),
    shxRun: strokeGeometry?.shxRun,
    get fontIssues() { return new Set([...(strokeGeometry?.fontIssues ?? []), ...(native.fontIssues ?? [])]); },
  } : undefined;
  const lookup: BlockLookup = Object.assign((name: string) => state.blocks[name], { textGeometry: geometry });
  return { lookup, fonts, geometry, issues, restrictedFaces };
}
