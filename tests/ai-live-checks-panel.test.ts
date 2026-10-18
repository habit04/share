import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { FakeElement, installFakeDocument } from './helpers/fake-dom';
import type { Entity } from '../src/core/entities';
import { DEFAULT_UNITS } from '../src/core/units';
import { WindowAiConnection, type AiLiveChecksReport } from '../src/ai/host-bridge';

/**
 * Panel tests for the live provider checks block (docs/AI-LIVE-CHECKS.md
 * §Tests; DESIGN §9 T13). The connection is a fake preload bridge: no
 * network, no key, no provider call.
 */

const line: Entity = {
  type: 'line', id: 'e-line', layer: 'WIRES', color: 'ByLayer',
  a: { x: 0, y: 0 }, b: { x: 3, y: 4 },
};

function fakeEditor() {
  const listeners = new Map<string, Array<() => void>>();
  const editor = {
    selection: new Set(['e-line']),
    sessions: { activeId: 1, current: { id: 1, docId: 'doc-1', revision: 1, contentGeneration: 1 } },
    doc: {
      revision: 7, loadCount: 1, space: undefined,
      header: { units: { ...DEFAULT_UNITS, insunits: 1 } },
      snapshot: { model3d: undefined },
      lookupBlock: () => undefined,
      entity: (id: string) => (id === 'e-line' ? line : undefined),
    },
    entitiesSelected: (): Entity[] => [line],
    on: (ev: string, fn: () => void) => {
      listeners.set(ev, [...(listeners.get(ev) ?? []), fn]);
      return () => { listeners.set(ev, (listeners.get(ev) ?? []).filter((f) => f !== fn)); };
    },
    runCommand: vi.fn(() => { throw new Error('the AI panel must never dispatch a command'); }),
  };
  return editor;
}

interface FakeState {
  provider: string; model: string; enabled: boolean; keyPersistence: string;
  keyPresent: boolean; keySource: string | null; encryptionAvailable: boolean;
  configProblem: string | null; keyStored?: boolean; credentialProblem?: string | null;
  configGeneration: string;
}

const passReport: AiLiveChecksReport = {
  kind: 'jcad.ai.live-checks-report', version: 1, runTag: 'panel-test-run',
  provider: 'openai', model: 'gpt-5', status: 'pass', refusal: null,
  checks: [
    { id: 'probe', title: 'Connection probe', status: 'pass', detail: 'Model answered the probe.', usage: { inputTokens: 9, outputTokens: 2 } },
    { id: 'ask', title: 'Ask about the synthetic selection', status: 'pass', detail: 'Answer of 44 characters with 1 reference(s).' },
    { id: 'draft', title: 'Draft generate from the synthetic context', status: 'pass', detail: 'Proposal with 1 operation(s).' },
    { id: 'refine', title: 'Refine the generated plan', status: 'pass', detail: 'Proposal with 1 operation(s).' },
  ],
  totals: { providerCalls: 4, durationMs: 120, tokens: { inputTokens: 1919, outputTokens: 137 } },
};
const cancelledReport: AiLiveChecksReport = {
  ...passReport, status: 'cancelled',
  checks: [
    { id: 'probe', title: 'Connection probe', status: 'pass', detail: 'Model answered the probe.' },
    { id: 'ask', title: 'Ask about the synthetic selection', status: 'cancelled', detail: 'The request was cancelled.' },
    { id: 'draft', title: 'Draft generate from the synthetic context', status: 'skipped', detail: 'Run cancelled.' },
    { id: 'refine', title: 'Refine the generated plan', status: 'skipped', detail: 'Run cancelled.' },
  ],
  totals: { providerCalls: 2, durationMs: 40 },
};

function fakeConnection(report: AiLiveChecksReport = passReport) {
  const slices: Record<string, FakeState> = {
    openai: {
      provider: 'openai', model: 'gpt-5', enabled: true, keyPersistence: 'session',
      keyPresent: true, keySource: 'session', encryptionAvailable: true, configProblem: null,
      configGeneration: 'gen-1',
    },
    anthropic: {
      provider: 'anthropic', model: 'claude-sonnet-5-5', enabled: true, keyPersistence: 'session',
      keyPresent: true, keySource: 'session', encryptionAvailable: true, configProblem: null,
      configGeneration: 'gen-1',
    },
  };
  let current = 'openai';
  const snapshot = () => ({ ...slices[current]! });
  const runLiveChecks = vi.fn(async () => ({ ok: true as const, report }));
  const cancelLiveChecks = vi.fn(async () => ({ ok: true as const, cancelled: true }));
  const raw = {
    getState: async () => ({ ok: true, state: snapshot() }),
    setProvider: async (provider: string) => { current = provider; return { ok: true, state: snapshot() }; },
    setModel: async (model: string) => { slices[current]!.model = model; return { ok: true, state: snapshot() }; },
    setKey: async () => ({ ok: true, state: snapshot() }),
    forgetKey: async () => ({ ok: true, state: snapshot() }),
    setEnabled: async (enabled: boolean) => { slices[current]!.enabled = enabled; return { ok: true, state: snapshot() }; },
    testConnection: async () => ({ ok: true, probe: { model: slices[current]!.model } }),
    ask: async () => ({ ok: true, answer: { text: 'x', references: [] } }),
    draft: async () => ({ ok: true, draft: {} }),
    draftRefine: async () => ({ ok: true, draft: {} }),
    cancel: async () => ({ ok: true, cancelled: true }),
    usage: async () => ({ ok: true, usage: {} }),
    runLiveChecks,
    cancelLiveChecks,
  };
  return { raw, slices, runLiveChecks, cancelLiveChecks };
}

type LiveEls = {
  liveRunBtn: FakeElement & { disabled: boolean };
  liveCancelBtn: FakeElement & { disabled: boolean };
  liveConfirmEl: FakeElement; liveConfirmText: FakeElement;
  liveConfirmBtn: FakeElement & { disabled: boolean };
  liveConfirmCancelBtn: FakeElement;
  liveResultEl: FakeElement;
  providerSelect: FakeElement & { value: string };
  testBtn: FakeElement & { disabled: boolean };
};
type PanelInternals = { settingsEls: LiveEls | null };

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

async function makeConnectedPanel(report?: AiLiveChecksReport, over?: Partial<FakeState>) {
  const fake = fakeConnection(report);
  if (over) Object.assign(fake.slices.openai!, over);
  const editor = fakeEditor();
  const container = new FakeElement('div');
  const panel = new AiAssistantPanel(editor as never, container as never, undefined,
    new WindowAiConnection(fake.raw as never));
  panel.toggle();
  await flush();
  const els = (panel as unknown as PanelInternals).settingsEls!;
  return { panel, els, ...fake };
}

describe('AiAssistantPanel live provider checks (T13)', () => {
  it('gates the Run button on key present + enabled + no credential/config problem', async () => {
    const ready = await makeConnectedPanel();
    expect(ready.els.liveRunBtn.disabled).toBe(false); // key present, enabled, no problems
    ready.panel.dispose();

    const disabledStates: Array<Partial<FakeState>> = [
      { keyPresent: false },
      { enabled: false },
      { credentialProblem: 'credential-corrupt' },
      { configProblem: 'config unreadable' },
    ];
    for (const over of disabledStates) {
      const attempt = await makeConnectedPanel(undefined, over);
      expect(attempt.els.liveRunBtn.disabled).toBe(true);
      attempt.panel.dispose();
    }
  });

  it('first click only reveals a confirmation naming the destination; nothing is invoked', async () => {
    const { panel, els, runLiveChecks } = await makeConnectedPanel();
    els.liveRunBtn.fire('click');
    expect(runLiveChecks).not.toHaveBeenCalled();
    expect(els.liveConfirmEl.classes.has('hidden')).toBe(false);
    expect(els.liveConfirmText.textContent).toBe('Run 4 checks against OpenAI · gpt-5 now?');
    expect(els.liveRunBtn.classes.has('hidden')).toBe(true);
    // The confirmation's own Cancel resets without invoking anything.
    els.liveConfirmCancelBtn.fire('click');
    expect(els.liveConfirmEl.classes.has('hidden')).toBe(true);
    expect(els.liveRunBtn.classes.has('hidden')).toBe(false);
    expect(runLiveChecks).not.toHaveBeenCalled();
    panel.dispose();
  });

  it('second click invokes the run exactly once and renders the report text', async () => {
    const { panel, els, runLiveChecks } = await makeConnectedPanel();
    els.liveRunBtn.fire('click');
    els.liveConfirmBtn.fire('click');
    await flush();
    expect(runLiveChecks).toHaveBeenCalledTimes(1);
    expect(els.liveResultEl.classes.has('hidden')).toBe(false);
    expect(els.liveResultEl.textContent).toContain('JCad live provider checks — OpenAI · gpt-5');
    expect(els.liveResultEl.textContent).toContain('Result: PASS — 4 provider call(s)');
    expect(els.liveResultEl.textContent).toContain('1919 input / 137 output tokens reported');
    expect(els.liveResultEl.textContent).toContain('4. Refine the generated plan — PASS');
    // Controls restore after the run settles.
    expect(els.liveCancelBtn.classes.has('hidden')).toBe(true);
    expect(els.liveRunBtn.classes.has('hidden')).toBe(false);
    expect(els.liveRunBtn.disabled).toBe(false);
    panel.dispose();
  });

  it('a settings change resets a pending confirmation', async () => {
    const { panel, els, runLiveChecks } = await makeConnectedPanel();
    els.liveRunBtn.fire('click');
    expect(els.liveConfirmEl.classes.has('hidden')).toBe(false);
    els.providerSelect.value = 'anthropic';
    els.providerSelect.fire('change');
    await flush();
    expect(els.liveConfirmEl.classes.has('hidden')).toBe(true);
    expect(els.liveRunBtn.classes.has('hidden')).toBe(false);
    expect(runLiveChecks).not.toHaveBeenCalled();
    panel.dispose();
  });

  it('hiding the panel resets a pending confirmation', async () => {
    const { panel, els, runLiveChecks } = await makeConnectedPanel();
    els.liveRunBtn.fire('click');
    expect(els.liveConfirmEl.classes.has('hidden')).toBe(false);
    panel.toggle(); // hides
    expect(els.liveConfirmEl.classes.has('hidden')).toBe(true);
    expect(runLiveChecks).not.toHaveBeenCalled();
    panel.dispose();
  });

  it('Cancel checks invokes the cancel channel while a run is active', async () => {
    let release: (value: { ok: true; report: AiLiveChecksReport }) => void = () => {};
    const { panel, els, runLiveChecks, cancelLiveChecks } = await makeConnectedPanel();
    runLiveChecks.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    els.liveRunBtn.fire('click');
    els.liveConfirmBtn.fire('click');
    await flush();
    expect(runLiveChecks).toHaveBeenCalledTimes(1);
    expect(els.liveCancelBtn.classes.has('hidden')).toBe(false);
    expect(els.liveCancelBtn.disabled).toBe(false);
    expect(els.liveRunBtn.classes.has('hidden')).toBe(true);
    els.liveCancelBtn.fire('click');
    await flush();
    expect(cancelLiveChecks).toHaveBeenCalledTimes(1);
    release({ ok: true, report: cancelledReport });
    await flush();
    expect(els.liveResultEl.textContent).toContain('Result: CANCELLED');
    expect(els.liveCancelBtn.classes.has('hidden')).toBe(true);
    expect(els.liveRunBtn.classes.has('hidden')).toBe(false);
    panel.dispose();
  });
});
