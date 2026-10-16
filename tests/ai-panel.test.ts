import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { FakeElement, installFakeDocument } from './helpers/fake-dom';
import type { Entity } from '../src/core/entities';
import { DEFAULT_UNITS } from '../src/core/units';

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
      space: undefined,
      header: { units: { ...DEFAULT_UNITS, insunits: 1 } },
      snapshot: { model3d: undefined },
      lookupBlock: () => undefined,
      entity: (id: string) => entities.find((e) => e.id === id),
    },
    entitiesSelected: () => entities,
    on: (ev: string, fn: () => void) => {
      listeners.set(ev, [...(listeners.get(ev) ?? []), fn]);
      return () => {
        listeners.set(ev, (listeners.get(ev) ?? []).filter((f) => f !== fn));
      };
    },
    runCommand: vi.fn(() => { throw new Error('the AI panel must never dispatch a command'); }),
    listenerCount: () => [...listeners.values()].reduce((n, arr) => n + arr.length, 0),
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

function makePanel() {
  const editor = fakeEditor();
  const container = new FakeElement('div');
  // The panel's editor surface is structural; the real Editor satisfies it.
  const panel = new AiAssistantPanel(editor as never, container as never);
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
    expect(sent).toContain('"kind": "jcad.ai.selection-snapshot"');
    expect(sent).toContain('PB101');
    // The hostile drawing text is present as data and parsed as nothing:
    expect(sent).toContain('onerror=alert(1)');
    expect(parts.sentEl.children).toHaveLength(0);
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
