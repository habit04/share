import type { TextStyle } from './encoding';
import { isTrueTypeStyle } from '../render/hershey';

/** Describe the renderer and measurement limits without claiming every font uses strokes. */
export function fontImportWarning(style: Pick<TextStyle, 'name' | 'font' | 'family' | 'bigFont'>): string | undefined {
  if (!((style.font && !/^txt(?:\.shx)?$/i.test(style.font)) || style.bigFont || style.family)) return undefined;
  const rendering = isTrueTypeStyle(style)
    ? 'installed TrueType/OpenType font families and fallbacks determine its appearance; matching Windows font metrics or Canvas fallback metrics determine bounds and wrapping'
    : 'a stroke font substitute approximates its appearance and metrics';
  return `font "${style.family || style.font}" of style "${style.name}" is kept for export; ${rendering} (font files are not embedded)`;
}
