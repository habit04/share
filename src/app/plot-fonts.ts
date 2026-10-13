import type { DrawingState } from '../core/document';
import { entityBounds, type BlockLookup } from '../core/entities';
import { layoutsOf, paperEntities } from '../core/layouts';
import { textStylesOf } from '../io/encoding';
import { fontMetrics, requestTextFonts, textGeometryForStyles } from '../render/font-metrics';

/** Keep a pending plot on its captured drawing, including STYLE and block definitions. */
export async function capturedPlotLookup(state: DrawingState): Promise<BlockLookup> {
  const styles = textStylesOf(state);
  const lookup: BlockLookup = Object.assign((name: string) => state.blocks[name], { textGeometry: textGeometryForStyles(styles) });
  await requestTextFonts(styles);
  // Bounds resolve formatted bold runs and fonts in visible annotation/block content too.
  for (const e of state.entities) entityBounds(e, lookup);
  for (const layout of layoutsOf(state)) for (const e of paperEntities(layout)) entityBounds(e, lookup);
  await fontMetrics.ready();
  return lookup;
}
