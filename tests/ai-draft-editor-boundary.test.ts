import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '../src/app/editor/editor';
import { createEditorAiDraftSource } from '../src/ai/editor-draft-source';
import { captureDraftContext, draftBindingNow } from '../src/ai/draft-context';
import { aiDraftBindingsEqual } from '../src/ai/types';
import type { Entity } from '../src/core/entities';

const editors: Editor[] = [];
function editor(): Editor {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const canvas = { width: 800, height: 600, getContext: () => ({}),
    getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }),
    addEventListener: () => {} } as unknown as HTMLCanvasElement;
  const ed = new Editor(canvas);
  editors.push(ed);
  return ed;
}
afterEach(() => { for (const ed of editors.splice(0)) ed.viewport.dispose(); vi.unstubAllGlobals(); });

describe('AI preview editor ownership and real interaction boundary', () => {
  it('an old owner cannot clear a newer preview or modify manual tool channels', () => {
    const ed = editor(), first = {}, next = {};
    const e: Entity = { id: 'preview', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } };
    let latest: Parameters<typeof ed.viewport.requestRender>[0] | undefined;
    ed.viewport.requestRender = value => { latest = value; };
    const preview = { added: [e], originals: [], modifiedAfter: [], deleted: [] };
    const before = ed.doc.snapshot, revision = ed.doc.revision;
    ed.setAiPreview(preview, first);
    ed.setAiPreview({ ...preview, added: [{ ...e, id: 'new-preview' }] }, next);
    ed.setAiPreview(null, first);
    expect(latest?.aiPreview?.added[0]?.id).toBe('new-preview');
    expect(latest?.preview).toEqual([]);
    expect(latest?.ghost).toEqual([]);
    expect(ed.doc.snapshot).toBe(before);
    expect(ed.doc.revision).toBe(revision);
    ed.setAiPreview(null, next);
    expect(latest?.aiPreview).toBeNull();
  });

  it('a selection gesture invalidates a capture even if it ends without changing document or selection', () => {
    const ed = editor(), source = createEditorAiDraftSource(ed);
    const before = ed.doc.snapshot, revision = ed.doc.revision;
    const capture = captureDraftContext(source, 'create a circle', 'fixture');
    const interaction = vi.fn(); ed.on('interaction', interaction);
    const event = { button: 0, clientX: 400, clientY: 300, shiftKey: false, preventDefault() {} } as MouseEvent;
    ed.onMouseDown(event);
    expect(ed.interactionBusy).toBe(true);
    expect(interaction).toHaveBeenCalledOnce();
    ed.onMouseUp(event);
    expect(ed.interactionBusy).toBe(false);
    expect(ed.doc.snapshot).toBe(before);
    expect(ed.doc.revision).toBe(revision);
    expect(aiDraftBindingsEqual(capture.binding, draftBindingNow(source, 'fixture'))).toBe(false);
  });

  it('a grip gesture is busy and revokes the capture without committing a zero-distance stretch', () => {
    const ed = editor();
    const e: Entity = { id: 'line', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 3, y: 4 } };
    ed.doc.transactDrawing(s => ({ ...s, entities: [e] })); ed.selection = new Set([e.id]);
    const source = createEditorAiDraftSource(ed), capture = captureDraftContext(source, 'move 10 right', 'fixture');
    const point = ed.viewport.toScreen(e.a);
    const event = { button: 0, clientX: point.x, clientY: point.y, shiftKey: false, preventDefault() {} } as MouseEvent;
    const revision = ed.doc.revision;
    ed.onMouseDown(event);
    expect(ed.interactionBusy).toBe(true);
    ed.onMouseUp(event);
    expect(ed.doc.revision).toBe(revision);
    expect(aiDraftBindingsEqual(capture.binding, draftBindingNow(source, 'fixture'))).toBe(false);
  });

  it('the Draft source refuses a hidden 2D canvas while the 3D view owns the screen', () => {
    const ed = editor(), source = createEditorAiDraftSource(ed);
    const before = ed.doc.snapshot;
    ed.hooks.aiDraftingAvailable = () => false;
    expect(() => captureDraftContext(source, 'create a circle', 'fixture')).toThrow(/2D Model view/);
    expect(ed.doc.snapshot).toBe(before);
  });
});
