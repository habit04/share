import type { DrawingState } from '../core/document';
import { entityBounds, type BlockLookup } from '../core/entities';
import { layoutsOf, paperEntities } from '../core/layouts';
import { textStylesOf } from '../io/encoding';
import { fontMetrics, requestTextFonts, textGeometryForStyles } from '../render/font-metrics';
import type { TextGeometryContext } from '../core/text-metrics';
import type { ResolvedXrefContext } from './xref-resolved';

/**
 * Captured xref contexts by captured-state identity (P20 slice 1, design
 * section 4 point 2). `capturePlot` registers the context it froze into the
 * CapturedPlot for the exact DrawingState object it froze, so the captured
 * lookup builders below — whose signatures carry only (state, geometry) —
 * wrap with the CAPTURED generation, never with whatever the live session
 * has since committed. A state that was never captured (or was captured
 * with no live graph) has no entry / a null entry and plots unwrapped:
 * the stamp-mismatch refusal of design section 3.5, by construction.
 */
const capturedXrefContexts = new WeakMap<DrawingState, ResolvedXrefContext | null>();

export function registerCapturedXrefContext(state: DrawingState, context: ResolvedXrefContext | null): void {
  capturedXrefContexts.set(state, context);
}

export function capturedXrefContextFor(state: DrawingState): ResolvedXrefContext | null {
  return capturedXrefContexts.get(state) ?? null;
}

/** Keep a pending plot on its captured drawing, including STYLE and block definitions. */
export async function capturedPlotLookup(state: DrawingState, geometry?: TextGeometryContext, xref?: ResolvedXrefContext | null): Promise<BlockLookup> {
  const styles = textStylesOf(state);
  const base: BlockLookup = Object.assign((name: string) => state.blocks[name], { textGeometry: geometry ?? textGeometryForStyles(styles) });
  // An explicit context (threaded from a CapturedPlot by the plot pipeline)
  // wins; otherwise the context capturePlot froze for this state identity.
  const context = xref !== undefined ? xref : capturedXrefContextFor(state);
  const lookup: BlockLookup = context ? context.expansionLookup(base) : base;
  await requestTextFonts(styles);
  // Bounds resolve formatted bold runs and fonts in visible annotation/block content too.
  for (const e of state.entities) entityBounds(e, lookup);
  for (const layout of layoutsOf(state)) for (const e of paperEntities(layout)) entityBounds(e, lookup);
  await fontMetrics.ready();
  return lookup;
}
