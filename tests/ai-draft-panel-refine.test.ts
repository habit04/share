import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { FakeElement, installFakeDocument } from './helpers/fake-dom';
import { Drawing } from '../src/core/document';
import type { Entity, Layer } from '../src/core/entities';
import { WindowAiConnection, type AiConnectionState, type AiPreloadBridge } from '../src/ai/host-bridge';
import type { AiDraftProvider } from '../src/ai/types';

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
  const state = { busy: false, editingBusy: false };
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
    get editingInteractionBusy(): boolean { return state.editingBusy; },
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
  cancelBtn: FakeElement;
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

function makePanel(connection?: WindowAiConnection) {
  const doc = new Drawing({ entities: [], layers: [layer0], currentLayer: '0' });
  const editor = fakeEditor(doc);
  const container = new FakeElement('div');
  const panel = new AiAssistantPanel(editor as never, container as never, undefined, connection);
  panel.toggle();
  const els = (panel as unknown as { draftEls: DraftEls }).draftEls;
  els.draftTab.fire('click');
  return { doc, editor, panel, els, container };
}

async function makeConnectedPanel() {
  let state: AiConnectionState = {
    provider: 'openai', model: 'gpt-5', configGeneration: 'host-1', enabled: false,
    keyPresent: false, keySource: null, keyPersistence: 'session', encryptionAvailable: true, configProblem: null,
  };
  let held = false;
  let release: () => void = () => {};
  const raw = {
    getState: vi.fn(() => held
      ? new Promise((resolve) => { release = () => { held = false; resolve({ ok: true, state: { ...state } }); }; })
      : Promise.resolve({ ok: true, state: { ...state } })),
  };
  const result = makePanel(new WindowAiConnection(raw as unknown as AiPreloadBridge));
  await flush();
  const provider = (result.panel as unknown as { fixtureDraftProvider: AiDraftProvider }).fixtureDraftProvider;
  const refine = vi.fn(provider.refine!.bind(provider));
  provider.refine = refine;
  return { ...result, refine, getState: raw.getState, holdRead: () => { held = true; }, release: () => release(),
    changeHostGeneration: () => { state = { ...state, configGeneration: 'host-2' }; } };
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
    expect(els.followUpEl.value).toBe('');
    expect(els.refineSentEl.textContent).toBe('');
    expect(doc.snapshot.entities).toHaveLength(0);
  });

  it('does not send edited wording after an earlier Refine click awaits host state', async () => {
    const { els, doc, panel, refine, holdRead, release } = await makeConnectedPanel();
    await generateRect(els);
    els.followUpEl.value = 'Change the radius to 4';
    els.followUpEl.fire('input');
    holdRead();
    els.refineBtn.fire('click');
    expect(els.cancelBtn.disabled).toBe(false);
    els.followUpEl.value = 'Change the radius to 5';
    els.followUpEl.fire('input');
    release();
    await flush();
    expect(refine).not.toHaveBeenCalled();
    expect(els.applyBtn.disabled).toBe(true);
    expect(els.followUpEl.value).toBe('Change the radius to 5');
    expect(doc.canUndo()).toBe(false);
    els.refineBtn.fire('click');
    await flush();
    expect(refine).toHaveBeenCalledOnce();
    expect(refine.mock.calls[0]![0].followUp).toBe('Change the radius to 5');
    panel.dispose();
  });

  it.each(['cancel', 'discard-follow-up'] as const)('honors %s while checking host state without launching a late model request', async (action) => {
    const { els, doc, panel, refine, holdRead, release } = await makeConnectedPanel();
    await generateRect(els);
    els.followUpEl.value = 'Change the radius to 5';
    els.followUpEl.fire('input');
    holdRead();
    els.refineBtn.fire('click');
    if (action === 'cancel') els.cancelBtn.fire('click');
    else els.discardFollowUpBtn.fire('click');
    release();
    await flush();
    expect(refine).not.toHaveBeenCalled();
    expect(els.versionEl.textContent).toContain('Preview version 1');
    expect(els.applyBtn.disabled).toBe(action === 'cancel');
    expect(els.followUpEl.value).toBe(action === 'cancel' ? 'Change the radius to 5' : '');
    expect(doc.canUndo()).toBe(false);
    panel.dispose();
  });

  it('does not restore Apply through Discard Follow-up after an unseen host configuration change', async () => {
    const { els, panel, doc, editor, changeHostGeneration } = await makeConnectedPanel();
    await generateRect(els);
    els.followUpEl.value = 'Change the radius to 5';
    els.followUpEl.fire('input');
    changeHostGeneration();
    els.discardFollowUpBtn.fire('click');
    await flush();
    expect(els.applyBtn.disabled).toBe(true);
    expect(els.followWrap.classList.contains('hidden')).toBe(true);
    expect(editor.previews.at(-1)).toBeNull();
    expect(doc.canUndo()).toBe(false);
    panel.dispose();
  });

  it('keeps an emptied follow-up unresolved until explicit Discard checks an unseen host generation change', async () => {
    const { els, panel, doc, editor, getState, refine, changeHostGeneration } = await makeConnectedPanel();
    await generateRect(els);
    els.followUpEl.value = 'Change the radius to 5';
    els.followUpEl.fire('input');
    const readsBeforeClear = getState.mock.calls.length;
    // A provider/configuration round trip may restore the same visible
    // provider and model, while the authoritative generation has advanced.
    changeHostGeneration();
    els.followUpEl.value = '';
    els.followUpEl.fire('input');
    await flush();
    expect(els.followUpEl.value).toBe('');
    expect(els.applyBtn.disabled).toBe(true);
    expect(els.refineBtn.disabled).toBe(true);
    expect(els.discardFollowUpBtn.disabled).toBe(false);
    expect(els.versionEl.textContent).toContain('Preview version 1');
    expect(getState).toHaveBeenCalledTimes(readsBeforeClear);
    expect(refine).not.toHaveBeenCalled();
    expect(doc.canUndo()).toBe(false);

    els.discardFollowUpBtn.fire('click');
    await flush();
    expect(getState).toHaveBeenCalledTimes(readsBeforeClear + 1);
    expect(els.applyBtn.disabled).toBe(true);
    expect(els.followWrap.classList.contains('hidden')).toBe(true);
    expect(editor.previews.at(-1)).toBeNull();
    expect(doc.snapshot.entities).toHaveLength(0);
    expect(doc.canUndo()).toBe(false);
    panel.dispose();
  });

  it('requires a new Apply click after follow-up input changes during its host-state check', async () => {
    const { els, panel, doc, holdRead, release } = await makeConnectedPanel();
    await generateRect(els);
    holdRead();
    els.applyBtn.fire('click');
    els.followUpEl.value = 'Change the radius to 5';
    els.followUpEl.fire('input');
    els.followUpEl.value = '';
    els.followUpEl.fire('input');
    release();
    await flush();
    expect(doc.snapshot.entities).toHaveLength(0);
    expect(doc.canUndo()).toBe(false);
    expect(els.applyBtn.disabled).toBe(true);
    expect(els.followUpEl.value).toBe('');
    els.discardFollowUpBtn.fire('click');
    await flush();
    expect(els.applyBtn.disabled).toBe(false);
    els.applyBtn.fire('click');
    await flush();
    expect(doc.snapshot.entities).toHaveLength(5);
    expect(doc.canUndo()).toBe(true);
    panel.dispose();
  });

  it('keeps a refinement settled during pan and restores controls when navigation ends', async () => {
    const { els, panel, doc, editor } = makePanel();
    await generateRect(els);
    const provider = (panel as unknown as { fixtureDraftProvider: AiDraftProvider }).fixtureDraftProvider;
    const originalRefine = provider.refine!.bind(provider);
    let release: () => void = () => {};
    const refine = vi.fn(async (...args: Parameters<NonNullable<AiDraftProvider['refine']>>) => {
      const result = await originalRefine(...args);
      await new Promise<void>((resolve) => { release = resolve; });
      return result;
    });
    provider.refine = refine;
    els.followUpEl.value = 'Change the radius to 5';
    els.followUpEl.fire('input');
    els.refineBtn.fire('click');
    await flush();
    expect(els.statusEl.textContent).toContain('Refining');

    editor.state.busy = true; // middle-button pan; no editing gesture
    editor.emit('view');
    release();
    await flush();
    expect(els.versionEl.textContent).toContain('Preview version 2');
    expect(els.applyBtn.disabled).toBe(true);
    expect(doc.snapshot.entities).toHaveLength(0);
    const preview = editor.previews.at(-1);
    expect(preview).not.toBeNull();

    editor.state.busy = false;
    editor.emit('view');
    expect(els.applyBtn.disabled).toBe(false);
    expect(editor.previews.at(-1)).toBe(preview);
    expect(refine).toHaveBeenCalledOnce();
    expect(doc.canUndo()).toBe(false);
    panel.dispose();
  });
});
