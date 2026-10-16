import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { FakeElement, installFakeDocument } from './helpers/fake-dom';
import { Drawing } from '../src/core/document';
import type { Entity, Layer } from '../src/core/entities';

/**
 * Mocked desktop UI evidence for milestone 4 (docs/AI-ASSISTANT-M4.md): the
 * real panel + draft controller + offline fixture refinement over a real
 * Drawing. Generate → follow-up → Refine Preview → Apply, Apply gating
 * while a follow-up is unresolved, Discard Follow-up, and the version diff.
 */

const layer0: Layer = { name: '0', color: 7, visible: true, locked: false, lineWeight: -3 };

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
    interactionGeneration: 0,
    setAiPreview: (p: Preview | null) => { previews.push(p); },
    viewport: { zoomToPoints: vi.fn() },
    render: vi.fn(),
    runCommand: vi.fn(() => { throw new Error('the AI panel must never dispatch a command'); }),
    previews,
    state,
  };
  return editor;
}

type DraftEls = {
  draftTab: FakeElement; promptEl: FakeElement; generateBtn: FakeElement;
  statusEl: FakeElement; changesEl: FakeElement; applyBtn: FakeElement;
  discardBtn: FakeElement; versionEl: FakeElement; followWrap: FakeElement;
  followUpEl: FakeElement; refineBtn: FakeElement; discardFollowUpBtn: FakeElement;
  refineSentEl: FakeElement; sentEl: FakeElement;
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

function makePanel() {
  const doc = new Drawing({ entities: [], layers: [layer0], currentLayer: '0' });
  const editor = fakeEditor(doc);
  const container = new FakeElement('div');
  const panel = new AiAssistantPanel(editor as never, container as never);
  panel.toggle();
  const els = (panel as unknown as { draftEls: DraftEls }).draftEls;
  els.draftTab.fire('click');
  return { doc, editor, panel, els };
}

function texts(el: FakeElement): string {
  return [el.textContent, ...el.children.map(texts)].join('\n');
}

const RECT_PROMPT = 'Create a 100 × 60 rectangle with four circles of radius 3, centered 10 units from each corner.';

async function generateRect(els: DraftEls): Promise<void> {
  els.promptEl.value = RECT_PROMPT;
  els.promptEl.fire('input');
  els.generateBtn.fire('click');
  await flush();
  expect(els.statusEl.textContent).toContain('Preview ready');
}

describe('AiAssistantPanel follow-up refinement (milestone 4)', () => {
  it('Generate → follow-up → Refine → Apply: width 120 with corner circles, version diff shown', async () => {
    const { doc, els } = makePanel();
    await generateRect(els);
    expect(els.versionEl.textContent).toContain('Preview version 1');
    expect(els.followWrap.classList.contains('hidden')).toBe(false);
    expect(els.applyBtn.disabled).toBe(false);

    els.followUpEl.value = 'Change the rectangle width to 120 and keep the circles 10 units from the corners.';
    els.followUpEl.fire('input');
    // The exact refinement envelope is previewed before anything is sent…
    expect(els.refineSentEl.textContent).toContain('jcad.ai.draft-refine-context');
    expect(els.refineSentEl.textContent).toContain('Rectangle 1');
    expect(els.refineSentEl.textContent).toContain('Change the rectangle width to 120');
    // …and Apply is paused while the follow-up is unresolved.
    expect(els.applyBtn.disabled).toBe(true);
    expect(doc.snapshot.entities).toHaveLength(0);

    els.refineBtn.fire('click');
    await flush();
    expect(els.versionEl.textContent).toContain('Preview version 2');
    expect(els.statusEl.textContent).toContain('Updated preview ready');
    expect(texts(els.changesEl)).toContain('Changes from the previous preview version:');
    expect(texts(els.changesEl)).toContain('Rectangle 1 changed');
    expect(texts(els.changesEl)).toContain('120 × 60');
    expect(els.followUpEl.value).toBe('');
    expect(els.applyBtn.disabled).toBe(false);

    els.applyBtn.fire('click');
    await flush();
    const rect = doc.snapshot.entities.find((e) => e.type === 'polyline');
    expect(rect?.type === 'polyline' && rect.points.map((p) => [p.x, p.y])).toEqual([[0, 0], [120, 0], [120, 60], [0, 60]]);
    const centers = doc.snapshot.entities.filter((e) => e.type === 'circle')
      .map((c) => c.type === 'circle' && `${c.center.x},${c.center.y}`);
    expect(centers).toEqual(['10,10', '110,10', '110,50', '10,50']);
    expect(doc.undo()).toBe(true);
    expect(doc.snapshot.entities).toHaveLength(0);
  });

  it('removing a proposed circle through the follow-up UI shows it in the diff', async () => {
    const { doc, els } = makePanel();
    await generateRect(els);
    els.followUpEl.value = 'Remove Circle 2';
    els.followUpEl.fire('input');
    els.refineBtn.fire('click');
    await flush();
    expect(texts(els.changesEl)).toContain('Circle 2 removed');
    els.applyBtn.fire('click');
    await flush();
    expect(doc.snapshot.entities).toHaveLength(4);
  });

  it('a clarification keeps Apply paused; Discard Follow-up restores the original preview', async () => {
    const { doc, els } = makePanel();
    await generateRect(els);
    els.followUpEl.value = 'Make it look nicer';
    els.followUpEl.fire('input');
    els.refineBtn.fire('click');
    await flush();
    expect(els.statusEl.textContent).toContain('More detail needed');
    expect(els.applyBtn.disabled).toBe(true);
    expect(els.versionEl.textContent).toContain('Preview version 1');
    els.discardFollowUpBtn.fire('click');
    await flush();
    expect(els.applyBtn.disabled).toBe(false);
    expect(els.followUpEl.value).toBe('');
    els.applyBtn.fire('click');
    await flush();
    expect(doc.snapshot.entities).toHaveLength(5); // the original 100 × 60 preview applied
    const rect = doc.snapshot.entities.find((e) => e.type === 'polyline');
    expect(rect?.type === 'polyline' && rect.points.map((p) => [p.x, p.y])).toEqual([[0, 0], [100, 0], [100, 60], [0, 60]]);
  });

  it('Enter in the follow-up field never applies; Discard clears the whole session', async () => {
    const { doc, els } = makePanel();
    await generateRect(els);
    els.followUpEl.value = 'Change the radius to 5';
    els.followUpEl.fire('input');
    els.followUpEl.fire('keydown', { key: 'Enter' });
    await flush();
    expect(doc.snapshot.entities).toHaveLength(0);
    expect(els.statusEl.textContent).toContain('Follow-up entered');
    els.discardBtn.fire('click');
    await flush();
    expect(els.versionEl.textContent).toBe('');
    expect(els.followWrap.classList.contains('hidden')).toBe(true);
    expect(doc.snapshot.entities).toHaveLength(0);
  });
});
