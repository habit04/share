/** #57 P2 (1) pin — the captured plot's underlay byte source (export-admission.ts:35).
 *
 * The finding, verbatim in substance: the callback stored on CapturedPlot is
 * the LIVE underlayBytes built in main.ts with
 * drawingPath: () => editor.doc.filePath. Freezing that function reference
 * does not freeze its source folder: after capturePlot(A) and an awaited
 * destination picker / tab switch to B, a relative sheet.pdf resolves
 * against B while the plotted geometry/definitions still belong to A.
 *
 * This pin is the two-open-documents / same-relative-name case: capture A,
 * switch the live document to B, and the captured source must still resolve
 * A's bytes — while the live screen source keeps following the active
 * document (the retained live getter).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Editor as EditorType } from '../src/app/editor';
import { Drawing } from '../src/core/document';
import type { UnderlayDefinition } from '../src/core/underlay';
import { capturePlot } from '../src/app/export-admission';
import { bridgeUnderlayBytes } from '../src/app/underlay-bytes';
import * as draw from '../src/render/draw';

let Editor: typeof EditorType;
beforeAll(async () => {
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
});
afterEach(() => {
  vi.restoreAllMocks();
  draw.renderSettings.underlayBytes = undefined;
  (draw.renderSettings as { underlayBytesFor?: unknown }).underlayBytesFor = undefined;
});

const BYTES_A = new Uint8Array([0xa1]);
const BYTES_B = new Uint8Array([0xb2]);
const DEF: UnderlayDefinition = { id: 'underlaydef:41', handle: '41', kind: 'pdf', sourcePath: 'sheet.pdf', retainedGroups: [] };

function setup() {
  const editor = new Editor({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement);
  const files = new Map<string, Uint8Array>([['/A/sheet.pdf', BYTES_A], ['/B/sheet.pdf', BYTES_B]]);
  const readUnderlay = async (file: string): Promise<Uint8Array | null> => files.get(file) ?? null;
  // The composition root's LIVE source (main.ts): the path getter reads the
  // active document at load time — correct for screen loads.
  draw.renderSettings.underlayBytes = bridgeUnderlayBytes({ readUnderlay, drawingPath: () => editor.doc.filePath });
  // The composition root's captured-source factory (the fixed wiring): bind
  // a source to one document path, frozen at capture.
  (draw.renderSettings as { underlayBytesFor?: (p: string | null) => ReturnType<typeof bridgeUnderlayBytes> }).underlayBytesFor =
    (drawingPath: string | null) => bridgeUnderlayBytes({ readUnderlay, drawingPath: () => drawingPath });
  const stateA = new Drawing({ entities: [] }).snapshot;
  editor.loadState(stateA, '/A/drawing.dxf');
  return { editor };
}

describe('captured plot underlay source (#57 P2 (1))', () => {
  it('resolves the captured document’s bytes after the live document switches (same relative name)', async () => {
    const { editor } = setup();
    const captured = capturePlot(editor);
    // The awaited destination picker / tab switch: B becomes the live doc.
    editor.loadState(new Drawing({ entities: [] }).snapshot, '/B/drawing.dxf');
    expect(editor.doc.filePath).toBe('/B/drawing.dxf');
    expect(await captured.underlayBytes!(DEF)).toEqual(BYTES_A);
  });

  it('the live screen source keeps following the active document (retained live getter)', async () => {
    const { editor } = setup();
    editor.loadState(new Drawing({ entities: [] }).snapshot, '/B/drawing.dxf');
    expect(await draw.renderSettings.underlayBytes!(DEF)).toEqual(BYTES_B);
  });

  it('a plot captured after the switch binds the newly active document', async () => {
    const { editor } = setup();
    editor.loadState(new Drawing({ entities: [] }).snapshot, '/B/drawing.dxf');
    const captured = capturePlot(editor);
    expect(await captured.underlayBytes!(DEF)).toEqual(BYTES_B);
  });
});
