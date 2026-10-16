import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { FakeElement, installFakeDocument } from './helpers/fake-dom';
import { Drawing } from '../src/core/document';
import type { Entity, Layer } from '../src/core/entities';

/**
 * Mocked desktop UI evidence for milestone 3 (docs/AI-ASSISTANT-M3.md): the
 * real panel + draft controller + compiler + apply boundary over a real
 * Drawing, with the structural fake editor and fake DOM the panel tests use.
 * Generate → Preview → Discard and Generate → Preview → Apply → Undo → Redo.
 */

const layer0: Layer = { name: '0', color: 7, visible: true, locked: false, lineWeight: -3 };
const line = (id: string): Entity => ({
  id, type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 10, y: 0 },
});

interface Preview {
  added: readonly Entity[];
  modifiedAfter: readonly Entity[];
  originals: readonly Entity[];
  deleted: readonly Entity[];
}

function fakeEditor(doc: Drawing) {
  const listeners = new Map<string, Array<() => void>>();
  const previews: Array<Preview | null> = [];
  const state = { busy: false };
  const editor = {
    selection: new Set<string>(),
    sessions: { activeId: 1, current: { docId: 'doc-1', contentGeneration: 1 } },
    doc,
    entitiesSelected: (): Entity[] => doc.snapshot.entities.filter((e) => editor.selection.has(e.id)),
    on: (ev: string, fn: () => void) => {
      listeners.set(ev, [...(listeners.get(ev) ?? []), fn]);
      return () => { listeners.set(ev, (listeners.get(ev) ?? []).filter((f) => f !== fn)); };
    },
    emit: (ev: string) => { for (const fn of listeners.get(ev) ?? []) fn(); },
    get interactionBusy(): boolean { return state.busy; },
    setAiPreview: (p: Preview | null) => { previews.push(p); },
    viewport: { zoomToPoints: vi.fn() },
    runCommand: vi.fn(() => { throw new Error('the AI panel must never dispatch a command'); }),
    previews,
    state,
  };
  return editor;
}

type DraftEls = {
  draftTab: FakeElement; promptEl: FakeElement; generateBtn: FakeElement;
  statusEl: FakeElement; changesEl: FakeElement; applyBtn: FakeElement;
  discardBtn: FakeElement; fitBtn: FakeElement; summaryEl: FakeElement; sentEl: FakeElement;
};

let uninstall: () => void;
let AiAssistantPanel: typeof import('../src/ui/ai-panel').AiAssistantPanel;
beforeAll(async () => {
  uninstall = installFakeDocument();
  ({ AiAssistantPanel } = await import('../src/ui/ai-panel'));
});
afterAll(() => uninstall());

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};

function makeDraftPanel(doc: Drawing, selection: string[]) {
  const editor = fakeEditor(doc);
  editor.selection = new Set(selection);
  const container = new FakeElement('div');
  const panel = new AiAssistantPanel(editor as never, container as never);
  panel.toggle();
  const els = (panel as unknown as { draftEls: DraftEls }).draftEls;
  els.draftTab.fire('click');
  return { editor, panel, els };
}

function texts(el: FakeElement): string {
  return [el.textContent, ...el.children.map(texts)].join('\n');
}

describe('AiAssistantPanel Draft / Edit (milestone 3)', () => {
  it('Generate → Preview → Discard leaves the drawing untouched', async () => {
    const doc = new Drawing({ entities: [line('e1')], layers: [layer0], currentLayer: '0' });
    const { editor, panel, els } = makeDraftPanel(doc, ['e1']);
    els.promptEl.value = 'Move the selected objects 10 units right';
    els.promptEl.fire('input');
    expect(els.sentEl.textContent).toContain('jcad.ai.draft-context');
    els.generateBtn.fire('click');
    await flush();
    expect(els.statusEl.textContent).toContain('Preview ready');
    expect(texts(els.changesEl)).toContain('Move 1 object(s) by (10.0000, 0.0000)');
    expect(els.applyBtn.disabled).toBe(false);
    // Preview is staged on the AI channel; the drawing itself is untouched.
    const preview = editor.previews[editor.previews.length - 1];
    expect(preview?.modifiedAfter).toHaveLength(1);
    expect(doc.snapshot.entities[0]?.type === 'line' && (doc.snapshot.entities[0] as Extract<Entity, { type: 'line' }>).a).toEqual({ x: 0, y: 0 });
    expect(doc.dirty).toBe(false);
    expect(doc.canUndo()).toBe(false);
    expect(editor.selection.has('e1')).toBe(true);

    els.discardBtn.fire('click');
    await flush();
    expect(editor.previews[editor.previews.length - 1]).toBeNull();
    expect(els.applyBtn.disabled).toBe(true);
    expect(doc.canUndo()).toBe(false);
    panel.dispose();
  });

  it('Generate → Preview → Apply → Undo → Redo commits exactly the previewed change', async () => {
    const doc = new Drawing({ entities: [line('e1')], layers: [layer0], currentLayer: '0' });
    const { editor, panel, els } = makeDraftPanel(doc, ['e1']);
    els.promptEl.value = 'Move the selected objects 10 units right';
    els.promptEl.fire('input');
    els.generateBtn.fire('click');
    await flush();
    els.fitBtn.fire('click');
    expect(editor.viewport.zoomToPoints).toHaveBeenCalled();
    els.applyBtn.fire('click');
    await flush();
    const moved = doc.snapshot.entities[0];
    expect(moved?.type === 'line' && moved.a).toEqual({ x: 10, y: 0 });
    expect(doc.dirty).toBe(true);
    expect(doc.canUndo()).toBe(true);
    expect(editor.previews[editor.previews.length - 1]).toBeNull();
    // Consumed: Apply is disabled and cannot run twice.
    expect(els.applyBtn.disabled).toBe(true);
    expect(doc.undo()).toBe(true);
    expect(doc.snapshot.entities[0]?.type === 'line' && (doc.snapshot.entities[0] as Extract<Entity, { type: 'line' }>).a).toEqual({ x: 0, y: 0 });
    expect(doc.redo()).toBe(true);
    expect(doc.snapshot.entities[0]?.type === 'line' && (doc.snapshot.entities[0] as Extract<Entity, { type: 'line' }>).a).toEqual({ x: 10, y: 0 });
    panel.dispose();
  });

  it('creates the documented rectangle demonstration in a blank drawing', async () => {
    const doc = new Drawing({ entities: [], layers: [layer0], currentLayer: '0' });
    const { panel, els } = makeDraftPanel(doc, []);
    els.promptEl.value = 'Create a 100 × 60 rectangle with four circles of radius 3, centered 10 units from each corner.';
    els.promptEl.fire('input');
    els.generateBtn.fire('click');
    await flush();
    expect(texts(els.changesEl)).toContain('5 created');
    els.applyBtn.fire('click');
    await flush();
    expect(doc.snapshot.entities).toHaveLength(5);
    expect(doc.undo()).toBe(true);
    expect(doc.snapshot.entities).toHaveLength(0);
    panel.dispose();
  });

  it('editing the prompt after staging invalidates the proposal', async () => {
    const doc = new Drawing({ entities: [line('e1')], layers: [layer0], currentLayer: '0' });
    const { editor, panel, els } = makeDraftPanel(doc, ['e1']);
    els.promptEl.value = 'Move the selected objects 10 units right';
    els.promptEl.fire('input');
    els.generateBtn.fire('click');
    await flush();
    expect(els.applyBtn.disabled).toBe(false);
    els.promptEl.value = 'Move the selected objects 20 units right';
    els.promptEl.fire('input');
    await flush();
    expect(els.statusEl.textContent).toContain('description changed');
    expect(els.applyBtn.disabled).toBe(true);
    expect(editor.previews[editor.previews.length - 1]).toBeNull();
    expect(doc.canUndo()).toBe(false);
    panel.dispose();
  });

  it('a document edit after staging invalidates the proposal (no silent rebase)', async () => {
    const doc = new Drawing({ entities: [line('e1')], layers: [layer0], currentLayer: '0' });
    const { editor, panel, els } = makeDraftPanel(doc, ['e1']);
    els.promptEl.value = 'Delete the selected objects';
    els.promptEl.fire('input');
    els.generateBtn.fire('click');
    await flush();
    expect(els.applyBtn.disabled).toBe(false);
    doc.addEntities([line('e2')]);
    editor.emit('change');
    await flush();
    expect(els.statusEl.textContent).toContain('generate again');
    expect(els.applyBtn.disabled).toBe(true);
    expect(doc.snapshot.entities).toHaveLength(2); // the delete never applied
    panel.dispose();
  });

  it('Enter in the draft prompt never applies changes', async () => {
    const doc = new Drawing({ entities: [line('e1')], layers: [layer0], currentLayer: '0' });
    const { panel, els } = makeDraftPanel(doc, ['e1']);
    els.promptEl.value = 'Delete the selected objects';
    els.promptEl.fire('input');
    els.generateBtn.fire('click');
    await flush();
    els.promptEl.fire('keydown', { key: 'Enter' });
    await flush();
    expect(doc.snapshot.entities).toHaveLength(1);
    expect(doc.canUndo()).toBe(false);
    panel.dispose();
  });
});
