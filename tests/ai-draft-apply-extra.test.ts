import { describe, expect, it, vi, afterEach } from 'vitest';
import { Drawing } from '../src/core/document';
import { entityBounds, type Entity, type Layer } from '../src/core/entities';
import { DEFAULT_UNITS } from '../src/core/units';
import { writeDxf } from '../src/io/dxf';
import { Editor } from '../src/app/editor/editor';
import { AiDraftController } from '../src/ai/draft-controller';
import { applyCompiledProposal } from '../src/ai/draft-apply';
import { captureDraftContext, type AiDraftSource } from '../src/ai/draft-context';
import { compileAiPlan } from '../src/ai/draft-compiler';
import { createEditorAiDraftSource } from '../src/ai/editor-draft-source';
import type { AiPlan, AiDraftResponse } from '../src/ai/draft-plan';
import type { AiBinding, AiDraftProvider } from '../src/ai/types';

const layer0: Layer = { name: '0', color: 7, visible: true, locked: false, lineWeight: -3 };

function harness(doc: Drawing, selection: string[]): AiDraftSource {
  const source: AiDraftSource = {
    binding: (): AiBinding => ({
      sessionId: 1, docId: 'doc', contentGeneration: 0,
      docRevision: doc.revision, docLoadCount: doc.loadCount,
      space: { layout: null, viewport: null }, selectionIds: selection,
    }),
    units: () => DEFAULT_UNITS,
    selectedEntities: () => doc.snapshot.entities.filter((e) => selection.includes(e.id)),
    entityById: (id) => doc.snapshot.entities.find((e) => e.id === id),
    boundsFor: (e) => entityBounds(e, undefined as never),
    missingIdKind: () => 'missing-object',
    modelState: () => doc.snapshot,
    frozenDefaults: () => ({ layer: doc.currentLayer, color: 'ByLayer' }),
    interactionBusy: () => false,
  };
  return source;
}

const circlePlan: AiDraftResponse = {
  kind: 'plan',
  plan: { message: null, operations: [{ op: 'createCircle', center: { x: 77001, y: 88002 }, radius: 3, layer: null }] },
};
const providerOf = (response: AiDraftResponse): AiDraftProvider => ({ id: 'fake', draft: async () => response });

describe('draft save/export exclusion and inclusion', () => {
  it('a normal save before Apply contains no staged geometry; after Apply it contains the committed result', async () => {
    const doc = new Drawing({ entities: [], layers: [layer0], currentLayer: '0' });
    const controller = new AiDraftController(harness(doc, []), doc);
    await controller.generate('a circle', providerOf(circlePlan), 'fixture');
    expect(controller.status.state).toBe('staged');
    const beforeSave = writeDxf(doc.snapshot);
    expect(beforeSave).not.toContain('77001');
    expect(beforeSave).not.toContain('88002');
    controller.apply();
    const afterSave = writeDxf(doc.snapshot);
    expect(afterSave).toContain('77001');
    expect(afterSave).toContain('88002');
    // Recovery path (undo history) matches: undo removes it again.
    doc.undo();
    expect(writeDxf(doc.snapshot)).not.toContain('77001');
  });
});

describe('reentrant apply', () => {
  it('an apply callback that re-enters apply() commits exactly once', async () => {
    const doc = new Drawing({ entities: [], layers: [layer0], currentLayer: '0' });
    let controller: AiDraftController;
    controller = new AiDraftController(harness(doc, []), doc, {
      applyFn: (capture, proposal) => {
        controller.apply(); // reentrant attempt: must be refused by the guard
        applyCompiledProposal(doc, capture, proposal);
      },
    });
    await controller.generate('a circle', providerOf(circlePlan), 'fixture');
    const revisionBefore = doc.revision;
    controller.apply();
    expect(doc.revision).toBe(revisionBefore + 1);
    expect(doc.snapshot.entities).toHaveLength(1);
  });
});

describe('frozen creation defaults', () => {
  it('created entities carry the defaults frozen at capture, not re-read ones', () => {
    const doc = new Drawing({ entities: [], layers: [layer0], currentLayer: '0' });
    const source = harness(doc, []);
    source.frozenDefaults = () => ({ layer: '0', color: 3, linetype: 'DASHED', lineWeight: 50 });
    const capture = captureDraftContext(source, 'a line', 'fixture');
    const plan: AiPlan = { message: null, operations: [{ op: 'createLine', a: { x: 0, y: 0 }, b: { x: 5, y: 0 }, layer: null }] };
    let n = 0;
    const out = compileAiPlan(plan, capture, () => `id-${++n}`, (e) => entityBounds(e, undefined as never));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const created = out.proposal.created[0];
    expect(created?.color).toBe(3);
    expect(created?.linetype).toBe('DASHED');
    expect(created?.lineWeight).toBe(50);
  });
});

describe('editor draft support (real Editor)', () => {
  const editors: Editor[] = [];
  afterEach(() => {
    for (const ed of editors.splice(0)) ed.viewport.dispose();
    vi.unstubAllGlobals();
  });

  function realEditor(): Editor {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const canvas = {
      width: 800, height: 600,
      getContext: () => ({}),
      getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }),
      addEventListener: () => {},
    } as unknown as HTMLCanvasElement;
    const ed = new Editor(canvas);
    editors.push(ed);
    return ed;
  }

  it('interactionBusy reflects tool state; the AI preview channel is independent of tool preview/ghost', () => {
    const ed = realEditor();
    expect(ed.interactionBusy).toBe(false);
    expect(ed.selectionPending).toBe(false);
    let overlay: unknown = null;
    ed.viewport.requestRender = (value) => { overlay = value; };
    const entity: Entity = { id: 'p1', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } };
    const before = ed.doc.snapshot;
    ed.setAiPreview({ added: [entity], modifiedAfter: [], originals: [], deleted: [] });
    const ov = overlay as { aiPreview: unknown; preview: unknown[]; ghost: unknown[] };
    expect(ov.aiPreview).toEqual({ added: [entity], modifiedAfter: [], originals: [], deleted: [] });
    expect(ov.preview).toEqual([]);
    expect(ov.ghost).toEqual([]);
    expect(ed.doc.snapshot).toBe(before);
    ed.setAiPreview(null);
    expect((overlay as { aiPreview: unknown }).aiPreview).toBeNull();
    ed.tool = { name: 'fake' } as never;
    expect(ed.interactionBusy).toBe(true);
    ed.tool = null;
    expect(ed.interactionBusy).toBe(false);
  });

  it('the editor draft source resolves frozen defaults through withEntityDefaults', () => {
    const ed = realEditor();
    ed.doc.currentColor = 3;
    const source = createEditorAiDraftSource(ed);
    const defaults = source.frozenDefaults();
    expect(defaults.color).toBe(3);
    expect(defaults.layer).toBe(ed.doc.currentLayer);
    expect(source.interactionBusy()).toBe(false);
    expect(source.modelState()).toBe(ed.doc.snapshot);
  });
});
