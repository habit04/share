import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { FakeElement, installFakeDocument } from './helpers/fake-dom';
import type { Entity } from '../src/core/entities';
import { DEFAULT_UNITS } from '../src/core/units';
import type { AiAskRequest, AiProvider } from '../src/ai/types';
import { serializeSnapshot } from '../src/ai/snapshot';

const line: Entity = {
  type: 'line', id: 'e-line', layer: 'WIRES', color: 'ByLayer',
  a: { x: 0, y: 0 }, b: { x: 3, y: 4 },
};
const hostileText: Entity = {
  type: 'text', id: 'e-text', layer: 'TAGS', color: 'ByLayer',
  position: { x: 1, y: 2 }, text: '<img src=x onerror=alert(1)> PB101', height: 2.5, rotation: 0, align: 'left',
};

/** Structural fake of the Editor surface the panel and AI source read. */
function fakeEditor() {
  const entities = [line, hostileText];
  const listeners = new Map<string, Array<() => void>>();
  const editor = {
    selection: new Set(['e-line', 'e-text']),
    sessions: {
      activeId: 1,
      current: { id: 1, docId: 'doc-1', revision: 1, contentGeneration: 1 },
    },
    doc: {
      revision: 7,
      loadCount: 1,
      space: undefined as { layout: string; viewport?: string } | undefined,
      header: { units: { ...DEFAULT_UNITS, insunits: 1 } },
      snapshot: { model3d: undefined },
      lookupBlock: () => undefined,
      entity: (id: string) => entities.find((e) => e.id === id),
    },
    entitiesSelected: (): Entity[] => entities.filter((e) => editor.selection.has(e.id)),
    on: (ev: string, fn: () => void) => {
      listeners.set(ev, [...(listeners.get(ev) ?? []), fn]);
      return () => {
        listeners.set(ev, (listeners.get(ev) ?? []).filter((f) => f !== fn));
      };
    },
    runCommand: vi.fn(() => { throw new Error('the AI panel must never dispatch a command'); }),
    listenerCount: () => [...listeners.values()].reduce((n, arr) => n + arr.length, 0),
    emit: (ev: string) => { for (const fn of listeners.get(ev) ?? []) fn(); },
  };
  return editor;
}

type PanelInternals = {
  summaryEl: FakeElement; sentEl: FakeElement; questionEl: FakeElement;
  askBtn: FakeElement; cancelBtn: FakeElement; statusEl: FakeElement;
  answerEl: FakeElement; refsEl: FakeElement;
};

let uninstall: () => void;
let AiAssistantPanel: typeof import('../src/ui/ai-panel').AiAssistantPanel;

beforeAll(async () => {
  uninstall = installFakeDocument();
  ({ AiAssistantPanel } = await import('../src/ui/ai-panel'));
});
afterAll(() => uninstall());

function makePanel(provider?: AiProvider) {
  const editor = fakeEditor();
  const container = new FakeElement('div');
  // The panel's editor surface is structural; the real Editor satisfies it.
  const panel = new AiAssistantPanel(editor as never, container as never, provider);
  return { editor, panel, parts: panel as unknown as PanelInternals, container };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('AiAssistantPanel', () => {
  it('starts hidden and toggles without dispatching a command', () => {
    const { editor, panel, container } = makePanel();
    expect(container.classes.has('hidden')).toBe(true);
    panel.toggle();
    expect(container.classes.has('hidden')).toBe(false);
    expect(editor.runCommand).not.toHaveBeenCalled();
    panel.dispose();
  });

  it('shows exactly what will be sent, as inert text', () => {
    const { panel, parts } = makePanel();
    panel.toggle();
    expect(parts.summaryEl.textContent).toContain('2 of 2 selected objects');
    const sent = parts.sentEl.textContent;
    expect(JSON.parse(sent).kind).toBe('jcad.ai.selection-snapshot');
    expect(sent).toContain('PB101');
    // The hostile drawing text is present as data and parsed as nothing:
    expect(sent).toContain('onerror=alert(1)');
    expect(parts.sentEl.children).toHaveLength(0);
    panel.dispose();
  });

  it('labels fixture mode with a non-empty selection', () => {
    const { panel, container } = makePanel();
    panel.toggle();
    const texts = (el: FakeElement): string => [el.textContent, ...el.children.map(texts)].join('\n');
    expect(texts(container)).toContain('Offline demo — no AI model connected');
    expect(texts(container)).toContain('nothing is sent outside JCad');
    panel.dispose();
  });

  it('prevents focused palette controls from forwarding drawing shortcuts', () => {
    const { panel, parts, container } = makePanel();
    panel.toggle();
    for (const target of [parts.askBtn, parts.cancelBtn]) {
      for (const key of ['Enter', 'Delete', 'Escape', 'z']) {
        const stopPropagation = vi.fn();
        container.fire('keydown', { key, target, ctrlKey: key === 'z', stopPropagation });
        expect(stopPropagation).toHaveBeenCalledOnce();
      }
    }
    panel.dispose();
  });

  it('previews exactly the snapshot delivered to the provider', async () => {
    let received: AiAskRequest | undefined;
    const provider: AiProvider = {
      id: 'test', ask: async (request) => {
        received = request;
        return { text: 'Five drawing units.', references: ['e-line'] };
      },
    };
    const { panel, parts } = makePanel(provider);
    panel.toggle();
    const preview = parts.sentEl.textContent;
    parts.questionEl.value = 'How long is the line?';
    parts.askBtn.fire('click');
    await flush();
    expect(received).toBeDefined();
    expect(serializeSnapshot(received!.snapshot)).toBe(preview);
    panel.dispose();
  });

  it('removes a displayed answer when its drawing or selection context changes', async () => {
    const { editor, panel, parts } = makePanel();
    panel.toggle();
    parts.questionEl.value = 'find PB101';
    parts.askBtn.fire('click');
    await flush();
    expect(parts.answerEl.textContent).toContain('PB101');
    editor.doc.revision += 1;
    editor.emit('change');
    expect(parts.answerEl.textContent).toBe('');
    expect(parts.refsEl.textContent).toBe('');
    expect(parts.statusEl.textContent).toContain('context changed');
    parts.askBtn.fire('click');
    await flush();
    expect(parts.answerEl.textContent).toContain('PB101');
    editor.selection.delete('e-text');
    editor.emit('selection');
    expect(parts.answerEl.textContent).toBe('');
    panel.dispose();
  });

  it('renders an unusable context error and disables Ask without throwing', () => {
    const { editor, panel, parts } = makePanel();
    editor.doc.space = { layout: 'x'.repeat(70_000) };
    expect(() => panel.toggle()).not.toThrow();
    expect(parts.askBtn.disabled).toBe(true);
    expect(parts.sentEl.textContent).toBe('');
    expect(parts.statusEl.textContent).toContain('metadata exceeds');
    editor.doc.space = undefined;
    editor.emit('space');
    expect(parts.askBtn.disabled).toBe(false);
    expect(parts.sentEl.textContent).not.toBe('');
    panel.dispose();
  });

  it('asks through the fixture provider and renders the answer as text', async () => {
    const { editor, panel, parts } = makePanel();
    panel.toggle();
    parts.questionEl.value = 'find PB101';
    parts.askBtn.fire('click');
    await flush();
    expect(parts.answerEl.textContent).toContain('PB101');
    expect(parts.answerEl.children).toHaveLength(0);
    expect(parts.refsEl.textContent).toContain('e-text');
    expect(editor.runCommand).not.toHaveBeenCalled();
    panel.dispose();
  });

  it('dispose unsubscribes from the editor and the controller', () => {
    const { editor, panel } = makePanel();
    expect(editor.listenerCount()).toBe(4);
    panel.dispose();
    expect(editor.listenerCount()).toBe(0);
  });
});

describe('AiAssistantPanel connection settings (milestone 2)', () => {
  interface FakeState {
    provider: string; model: string; enabled: boolean; keyPersistence: string;
    keyPresent: boolean; keySource: string | null; encryptionAvailable: boolean; configProblem: string | null;
    keyStored?: boolean; credentialProblem?: string | null;
  }
  function fakeConnection() {
    const slices: Record<string, FakeState> = {
      openai: {
        provider: 'openai', model: 'gpt-5', enabled: false, keyPersistence: 'session',
        keyPresent: false, keySource: null, encryptionAvailable: true, configProblem: null,
      },
      anthropic: {
        provider: 'anthropic', model: 'claude-sonnet-5-5', enabled: false, keyPersistence: 'session',
        keyPresent: false, keySource: null, encryptionAvailable: true, configProblem: null,
      },
    };
    let current = 'openai';
    const state = slices[current]!;
    const snapshot = () => ({ ...slices[current]! });
    const raw = {
      getState: async () => ({ ok: true, state: snapshot() }),
      setProvider: async (provider: string) => { current = provider; return { ok: true, state: snapshot() }; },
      setModel: async (model: string) => { slices[current]!.model = model; return { ok: true, state: snapshot() }; },
      setKey: async (_key: string, persistence: string) => {
        const s = slices[current]!;
        s.keyPresent = true;
        s.keySource = persistence === 'encrypted' ? 'stored' : 'session';
        s.keyPersistence = persistence;
        return { ok: true, state: snapshot() };
      },
      forgetKey: async () => { const s = slices[current]!; s.keyPresent = false; s.keyStored = false; s.credentialProblem = null; s.keySource = null; return { ok: true, state: snapshot() }; },
      setEnabled: async (enabled: boolean) => { slices[current]!.enabled = enabled; return { ok: true, state: snapshot() }; },
      testConnection: async () => ({ ok: true, probe: { model: slices[current]!.model, inputTokens: 3, outputTokens: 1 } }),
      ask: async () => ({
        ok: true,
        answer: {
          text: current === 'anthropic' ? 'Claude answer about PB101.' : 'Live answer about PB101.', references: ['e-text'],
          usage: { inputBytes: 100, outputChars: 24, durationMs: 5 },
          providerUsage: { inputTokens: 42, outputTokens: 7 },
        },
      }),
      cancel: async () => ({ ok: true, cancelled: true }),
      usage: async () => ({ ok: true, usage: { requests: 1 } }),
    };
    // Tests read `state` as "the currently selected provider's slice".
    const stateFacade = {
      get provider() { return slices[current]!.provider; },
      get model() { return slices[current]!.model; },
      get enabled() { return slices[current]!.enabled; },
      get keyPresent() { return slices[current]!.keyPresent; },
      get keySource() { return slices[current]!.keySource; },
    };
    void state;
    return { raw, state: stateFacade as unknown as FakeState, slices };
  }

  type SettingsInternals = PanelInternals & {
    settingsEls: {
      providerSelect: FakeElement & { value: string };
      modelSelect: FakeElement; modelCustom: FakeElement;
      persistSession: FakeElement & { checked: boolean }; persistEncrypted: FakeElement & { checked: boolean };
      keyInput: FakeElement & { value: string }; saveKeyBtn: FakeElement; forgetKeyBtn: FakeElement & { disabled: boolean };
      testBtn: FakeElement & { disabled: boolean }; enableCheck: FakeElement & { checked: boolean; disabled: boolean };
      stateEl: FakeElement; errorEl: FakeElement;
    } | null;
    providerLabelEl: FakeElement; sentLabelEl: FakeElement; usageEl: FakeElement; billingEl: FakeElement;
  };

  async function makeConnected() {
    const { WindowAiConnection } = await import('../src/ai/host-bridge');
    const { raw, state, slices } = fakeConnection();
    const editor = fakeEditor();
    const container = new FakeElement('div');
    const panel = new AiAssistantPanel(editor as never, container as never, undefined,
      new WindowAiConnection(raw as never));
    return { editor, panel, parts: panel as unknown as SettingsInternals, state, container, raw, slices };
  }

  it('shows host state, gates enabling on a key, and clears the password field on submit', async () => {
    const { panel, parts, state } = await makeConnected();
    panel.toggle();
    await flush();
    expect(parts.settingsEls).not.toBeNull();
    expect(parts.settingsEls!.stateEl.textContent).toContain('API key: not saved');
    expect(parts.settingsEls!.enableCheck.disabled).toBe(true);
    parts.settingsEls!.keyInput.value = 'sk-secret';
    parts.settingsEls!.saveKeyBtn.fire('click');
    // Cleared synchronously on submission, before the host answered.
    expect(parts.settingsEls!.keyInput.value).toBe('');
    await flush();
    expect(state.keyPresent).toBe(true);
    expect(parts.settingsEls!.stateEl.textContent).toContain('this session only');
    expect(parts.settingsEls!.enableCheck.disabled).toBe(false);
    expect(parts.settingsEls!.saveKeyBtn.textContent).toBe('Replace Key');
    panel.dispose();
  });

  it('offers Forget for unusable stored ciphertext while keeping live requests and probes disabled', async () => {
    const { panel, parts, slices } = await makeConnected();
    Object.assign(slices.openai!, { keyStored: true, keyPresent: false, credentialProblem: 'credential-corrupt', enabled: true });
    panel.toggle();
    await flush();
    const els = parts.settingsEls!;
    expect(els.forgetKeyBtn.disabled).toBe(false);
    expect(els.testBtn.disabled).toBe(true);
    expect(els.enableCheck.disabled).toBe(true);
    expect(els.stateEl.textContent).toContain('saved key cannot be decrypted');
    expect(els.stateEl.textContent).not.toContain('API key: saved (');
    expect(els.saveKeyBtn.textContent).toBe('Replace Key');
    expect(parts.providerLabelEl.textContent).toContain('Offline demo');
    els.forgetKeyBtn.fire('click');
    await flush();
    expect(els.forgetKeyBtn.disabled).toBe(true);
    expect(els.stateEl.textContent).toContain('API key: not saved');
    panel.dispose();
  });

  it('routes asks to the fixture demo until live is enabled, then to the host with destination labels', async () => {
    const { panel, parts, state } = await makeConnected();
    panel.toggle();
    await flush();
    parts.questionEl.value = 'find PB101';
    parts.askBtn.fire('click');
    await flush();
    expect(parts.answerEl.textContent).toContain('PB101');
    expect(parts.providerLabelEl.textContent).toContain('Offline demo');
    // Save a key and enable: the next ask goes to the host bridge.
    parts.settingsEls!.keyInput.value = 'sk-secret';
    parts.settingsEls!.saveKeyBtn.fire('click');
    await flush();
    parts.settingsEls!.enableCheck.checked = true;
    parts.settingsEls!.enableCheck.fire('change');
    await flush();
    expect(state.enabled).toBe(true);
    expect(parts.providerLabelEl.textContent).toContain('Live AI: OpenAI · gpt-5');
    expect(parts.sentLabelEl.textContent).toContain('sent to OpenAI (model: gpt-5)');
    expect(parts.askBtn.textContent).toBe('Ask OpenAI');
    expect(parts.billingEl.classes.has('hidden')).toBe(false);
    parts.askBtn.fire('click');
    await flush();
    expect(parts.answerEl.textContent).toBe('Live answer about PB101.');
    expect(parts.usageEl.textContent).toContain('42 input tokens');
    expect(parts.usageEl.textContent).toContain('7 output tokens');
    panel.dispose();
  });

  it('discloses the probe charge and reports connection success', async () => {
    const { panel, parts, container } = await makeConnected();
    panel.toggle();
    await flush();
    const texts = (el: FakeElement): string => [el.textContent, ...el.children.map(texts)].join('\n');
    expect(texts(container)).toContain('may incur a small charge');
    expect(texts(container)).toContain('no drawing content');
    expect(texts(container)).toContain('not zero retention');
    parts.settingsEls!.keyInput.value = 'sk-secret';
    parts.settingsEls!.saveKeyBtn.fire('click');
    await flush();
    parts.settingsEls!.testBtn.fire('click');
    await flush();
    expect(parts.settingsEls!.stateEl.textContent).toContain('Connection OK');
    panel.dispose();
  });

  it('switching providers clears the old answer and re-reads that provider\'s separate state', async () => {
    const { panel, parts, state } = await makeConnected();
    panel.toggle();
    await flush();
    // Bring OpenAI live and get an answer on screen.
    parts.settingsEls!.keyInput.value = 'sk-secret';
    parts.settingsEls!.saveKeyBtn.fire('click');
    await flush();
    parts.settingsEls!.enableCheck.checked = true;
    parts.settingsEls!.enableCheck.fire('change');
    await flush();
    parts.questionEl.value = 'find PB101';
    parts.askBtn.fire('click');
    await flush();
    expect(parts.answerEl.textContent).toBe('Live answer about PB101.');
    // Switch to Anthropic: the OpenAI answer is cleared, Anthropic has
    // its own (empty) key state and its own default model, and routing
    // falls back to the demo until Anthropic is configured — never to
    // OpenAI (no automatic fallback).
    parts.settingsEls!.providerSelect.value = 'anthropic';
    parts.settingsEls!.providerSelect.fire('change');
    await flush();
    expect(state.provider).toBe('anthropic');
    expect(parts.answerEl.textContent).toBe('');
    expect(parts.settingsEls!.stateEl.textContent).toContain('Provider: Anthropic · Model: claude-sonnet-5-5');
    expect(parts.settingsEls!.stateEl.textContent).toContain('API key: not saved');
    expect(parts.providerLabelEl.textContent).toContain('Offline demo');
    // Configure Anthropic and ask: the answer is Claude's, labelled so.
    parts.settingsEls!.keyInput.value = 'sk-ant-secret';
    parts.settingsEls!.saveKeyBtn.fire('click');
    await flush();
    parts.settingsEls!.enableCheck.checked = true;
    parts.settingsEls!.enableCheck.fire('change');
    await flush();
    expect(parts.askBtn.textContent).toBe('Ask Anthropic');
    expect(parts.sentLabelEl.textContent).toContain('sent to Anthropic (model: claude-sonnet-5-5)');
    parts.askBtn.fire('click');
    await flush();
    expect(parts.answerEl.textContent).toBe('Claude answer about PB101.');
    panel.dispose();
  });

  it('forgetting the key returns routing to the offline demo', async () => {
    const { panel, parts, state } = await makeConnected();
    panel.toggle();
    await flush();
    parts.settingsEls!.keyInput.value = 'sk-secret';
    parts.settingsEls!.saveKeyBtn.fire('click');
    await flush();
    parts.settingsEls!.forgetKeyBtn.fire('click');
    await flush();
    expect(state.keyPresent).toBe(false);
    expect(parts.providerLabelEl.textContent).toContain('Offline demo');
    panel.dispose();
  });

  it('clears unsaved credentials on provider changes, hide and disposal and restores the provider persistence choice', async () => {
    const { panel, parts } = await makeConnected();
    panel.toggle();
    await flush();
    const els = parts.settingsEls!;
    els.keyInput.value = 'unsaved-openai-key';
    els.persistEncrypted.checked = true;
    els.providerSelect.value = 'anthropic';
    els.providerSelect.fire('change');
    expect(els.keyInput.value).toBe('');
    await flush();
    expect(els.persistEncrypted.checked).toBe(false);
    expect(els.persistSession.checked).toBe(true);
    els.keyInput.value = 'unsaved-anthropic-key';
    panel.toggle();
    expect(els.keyInput.value).toBe('');
    panel.toggle();
    await flush();
    els.keyInput.value = 'unsaved-key';
    panel.dispose();
    expect(els.keyInput.value).toBe('');
  });

  it('pauses questions while a provider mutation is pending and never queues a second settings mutation', async () => {
    const { panel, parts, raw } = await makeConnected();
    panel.toggle();
    await flush();
    const changeProvider = raw.setProvider;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    raw.setProvider = async (provider) => {
      const result = await changeProvider(provider);
      await gate;
      return result;
    };
    raw.ask = vi.fn(raw.ask);
    raw.setModel = vi.fn(raw.setModel);
    const els = parts.settingsEls!;
    els.providerSelect.value = 'anthropic';
    els.providerSelect.fire('change');
    expect(parts.askBtn.disabled).toBe(true);
    expect(els.providerSelect.disabled).toBe(true);
    parts.questionEl.value = 'find PB101';
    parts.questionEl.fire('keydown', { key: 'Enter' });
    els.modelSelect.value = 'different-model';
    els.modelSelect.fire('change');
    expect(raw.ask).not.toHaveBeenCalled();
    expect(raw.setModel).not.toHaveBeenCalled();
    await flush();
    expect(parts.answerEl.textContent).toBe('');
    release();
    await flush();
    expect(parts.askBtn.disabled).toBe(false);
    expect(els.stateEl.textContent).toContain('Provider: Anthropic');
    panel.dispose();
  });

  it('cancels a pending answer and clears a displayed answer when model or enabled state changes', async () => {
    const { editor, panel, parts, raw } = await makeConnected();
    panel.toggle();
    await flush();
    const els = parts.settingsEls!;
    els.keyInput.value = 'sk-test-only';
    els.saveKeyBtn.fire('click');
    await flush();
    els.enableCheck.checked = true;
    els.enableCheck.fire('change');
    await flush();
    parts.questionEl.value = 'find PB101';
    parts.askBtn.fire('click');
    await flush();
    expect(parts.answerEl.textContent).toContain('Live answer');
    els.modelSelect.value = 'gpt-5.5';
    els.modelSelect.fire('change');
    expect(parts.answerEl.textContent).toBe('');
    await flush();
    const answer = await raw.ask();
    let release: () => void = () => {};
    raw.ask = () => new Promise((resolve) => { release = () => resolve(answer); });
    raw.cancel = vi.fn(raw.cancel);
    parts.askBtn.fire('click');
    els.enableCheck.checked = false;
    els.enableCheck.fire('change');
    expect(raw.cancel).toHaveBeenCalledOnce();
    release();
    await flush();
    expect(parts.answerEl.textContent).toBe('');
    expect(parts.providerLabelEl.textContent).toContain('Offline demo');
    expect(editor.runCommand).not.toHaveBeenCalled();
    panel.dispose();
  });

  it('ignores a late connection read after disposal', async () => {
    const { panel, parts, raw } = await makeConnected();
    const result = await raw.getState();
    let release: () => void = () => {};
    raw.getState = () => new Promise((resolve) => { release = () => resolve(result); });
    panel.toggle();
    const message = parts.settingsEls!.stateEl.textContent;
    panel.dispose();
    release();
    await flush();
    expect(parts.settingsEls!.stateEl.textContent).toBe(message);
  });
});
