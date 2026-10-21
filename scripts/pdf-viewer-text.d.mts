export declare const PDF_VIEWER_TEXT_LIMITS: Readonly<{
  maxActualCodeUnits: 10000;
  maxSourceCodeUnits: 10000;
  maxFragments: 64;
  maxSeparatorCodeUnits: 16;
}>;
export type PdfViewerTextResult =
  | { ok: true; sourceFragments: number; separators: string[] }
  | { ok: false; reason: string; fragmentIndex: number; offset: number };
/** Exact source text, bounded ASCII space/CR/LF only between entity records. */
export declare function comparePdfViewerText(actual: unknown, fragments: unknown): PdfViewerTextResult;
