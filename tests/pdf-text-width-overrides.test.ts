import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { drawingContext, renderPdfPages, type PdfPageSpec } from '../src/io/pdf-vector';
import { parseContentStream } from './helpers/pdf';

describe('PDF native text width overrides', () => {
  it.each([[undefined, 0.5], [1, 1], [0.8, 0.8]])('uses widthFactor %s with STYLE width .5', (widthFactor, expected) => {
    const doc = new Drawing({ entities: [{ id: 'text', layer: '0', color: 'ByLayer', type: 'text', style: 'ARIAL', text: 'Width', position: { x: 1, y: 1 }, height: 1, rotation: 0, align: 'left', ...(widthFactor === undefined ? {} : { widthFactor }) }],
      meta: { textStyles: { ARIAL: { name: 'ARIAL', font: 'arial.ttf', bigFont: '', flags: 0, height: 0, widthFactor: 0.5, oblique: 0, generation: 0 } } } });
    const page: PdfPageSpec = { width: 100, height: 100, label: 'Text', groups: [{ entities: doc.snapshot.entities, k: 1, e: 0, f: 0, hidden: new Set(), ltUnit: 1, annoFactor: 1 }] };
    const rendered = renderPdfPages([page], drawingContext(doc.snapshot, doc.lookupBlock), { mode: 'color', lineweights: true, usePlotStyles: true })[0]!;
    const tm = parseContentStream(rendered.content).ops.find((op) => op.op === 'Tm')!;
    expect(Number(tm.args[0])).toBeCloseTo(expected!, 3);
  });
});
