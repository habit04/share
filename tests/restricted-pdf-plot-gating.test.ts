import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import type { Editor } from '../src/app/editor';
import type { TextEntity } from '../src/core/entities';
import { restrictedPdfOffered, type PlotOptions } from '../src/app/plot';
import { plotLayoutsOrVector } from '../src/app/plot-vector';
import { pdfFontFixture } from './helpers/pdf-font-fixture';

const style = (name = 'FACE', font = 'arial.ttf') => ({ name, font, bigFont: '', flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0 });
const text = (id = 'text'): TextEntity => ({ id, type: 'text', layer: '0', color: 'ByLayer', style: 'FACE', text: 'AB', position: { x: 3, y: 4 }, height: 7.3, rotation: 0, align: 'left' });
function drawing() { return new Drawing({ entities: [text()], meta: { textStyles: { FACE: style() } } }); }
const baseOptions: PlotOptions = { paper: 'letter', orientation: 'portrait', scale: 'fit', margin: 0.5 };

function editorStub(bridge: Record<string, unknown>) {
  const saved: Uint8Array[] = [], plotted: string[] = [], logs: string[] = [];
  const full = {
    ...bridge,
    ...('savePdf' in bridge ? {} : { savePdf: async (bytes: Uint8Array) => { saved.push(bytes); return 'out.pdf'; } }),
    ...('plotPdf' in bridge ? {} : { plotPdf: async () => { plotted.push('raster'); return 'out.pdf'; } }),
  };
  const editor = { doc: drawing(), fileName: () => 'Gate.dxf', log: (value: string) => logs.push(value), fileBridge: full } as unknown as Editor;
  return { editor, saved, plotted, logs };
}

describe('restricted PDF offer gating (12.4 corrections)', () => {
  it('the option is offered only for the Windows desktop vector capability', () => {
    const fn = async () => true;
    expect(restrictedPdfOffered(null)).toBe(false);
    expect(restrictedPdfOffered(undefined)).toBe(false);
    expect(restrictedPdfOffered({})).toBe(false); // browser bridge
    expect(restrictedPdfOffered({ platform: 'win32' })).toBe(false); // no registration call
    expect(restrictedPdfOffered({ platform: 'win32', registerRestrictedPdf: fn })).toBe(false); // no vector save
    expect(restrictedPdfOffered({ platform: 'darwin', registerRestrictedPdf: fn, savePdf: fn })).toBe(false);
    expect(restrictedPdfOffered({ platform: 'win32', registerRestrictedPdf: fn, savePdf: fn })).toBe(true);
  });

  it('a restricted request on the Raster route is refused before anything is written', async () => {
    const stub = editorStub({ platform: 'win32' });
    const options: PlotOptions = { ...baseOptions, output: 'raster', security: 'restricted-p2' };
    await expect(plotLayoutsOrVector(stub.editor, { action: 'pdf', options })).resolves.toBe(true);
    expect(stub.logs.join(' ')).toContain('Editing restrictions require Vector PDF output');
    expect(stub.logs.join(' ')).toContain('was not written');
    expect(stub.saved).toEqual([]); // no vector save happened
    expect(stub.plotted).toEqual([]); // and no silent ordinary raster write either
  });

  it('an ordinary Raster request is NOT refused by the new guard (control)', async () => {
    const stub = editorStub({ platform: 'win32' });
    const options: PlotOptions = { ...baseOptions, output: 'raster', security: 'none' };
    // Model-tab raster falls through to the caller's raster path (false),
    // exactly as before — the guard fires only for restricted requests.
    await expect(plotLayoutsOrVector(stub.editor, { action: 'pdf', options })).resolves.toBe(false);
    expect(stub.logs.join(' ')).not.toContain('Editing restrictions require');
  });

  it('a restricted Vector request proceeds; with no preview/print face it saves ordinarily and says so', async () => {
    const stub = editorStub({
      platform: 'win32',
      pdfFont: async (request: { family?: string }) => ({ font: pdfFontFixture({ family: request.family, fsType: 0 }) }),
    });
    const options: PlotOptions = { ...baseOptions, output: 'vector', security: 'restricted-p2' };
    await expect(plotLayoutsOrVector(stub.editor, { action: 'pdf', options })).resolves.toBe(true);
    expect(stub.saved).toHaveLength(1);
    expect(stub.logs.join(' ')).toContain('no preview/print font was used in this plot');
    expect(stub.logs.join(' ')).not.toContain('Editing restrictions require Vector PDF output');
  });

  it('a restricted request through a browser bridge never reaches a save (no vector route offered)', async () => {
    // No savePdf/plotPdf at all: the flow reports plotting unavailable
    // rather than degrading — and the dialog never offers the mode here
    // (restrictedPdfOffered is false for this bridge shape).
    const logs: string[] = [];
    const editor = { doc: drawing(), fileName: () => 'Gate.dxf', log: (value: string) => logs.push(value), fileBridge: { platform: undefined } } as unknown as Editor;
    const options: PlotOptions = { ...baseOptions, output: 'vector', security: 'restricted-p2' };
    await expect(plotLayoutsOrVector(editor, { action: 'pdf', options })).resolves.toBe(true);
    expect(logs.join(' ')).toContain('Plotting is not available here.');
  });
});
