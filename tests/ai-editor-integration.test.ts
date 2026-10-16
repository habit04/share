import { describe, it, expect, beforeAll } from 'vitest';
import type { Entity } from '../src/core/entities';
import { AiAskController } from '../src/ai/ask-controller';
import { createEditorAiSource } from '../src/ai/editor-source';
import { FixtureProvider } from '../src/ai/fixture-provider';
import type { AiProvider } from '../src/ai/types';

/**
 * State preservation against a real Editor (docs/AI-ASSISTANT.md §2):
 * asking, cancelling and failing must leave drawing data, selection, tool,
 * view, active space, undo/redo, dirty state and save behaviour untouched.
 */

type EditorClass = typeof import('../src/app/editor/editor').Editor;
let Editor: EditorClass;

beforeAll(async () => {
  (globalThis as Record<string, unknown>).requestAnimationFrame = () => 1;
  (globalThis as Record<string, unknown>).cancelAnimationFrame = () => {};
  ({ Editor } = await import('../src/app/editor/editor'));
}, 120_000);

const canvas = () => ({
  getContext: () => ({}),
  getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }),
  width: 0, height: 0,
}) as unknown as HTMLCanvasElement;

const line: Entity = {
  type: 'line', id: 'ai-line', layer: 'WIRES', color: 'ByLayer',
  a: { x: 0, y: 0 }, b: { x: 3, y: 4 },
};
const text: Entity = {
  type: 'text', id: 'ai-text', layer: 'TAGS', color: 'ByLayer',
  position: { x: 1, y: 2 }, text: 'PB101', height: 2.5, rotation: 0, align: 'left',
};

function makeEditor() {
  const editor = new Editor(canvas());
  editor.doc.transact((s) => ({ ...s, entities: [line, text] }));
  editor.selection.add('ai-line');
  editor.selection.add('ai-text');
  editor.doc.dirty = false; // a saved drawing
  return editor;
}

function editorState(editor: InstanceType<EditorClass>) {
  return {
    snapshot: editor.doc.snapshot,
    revision: editor.doc.revision,
    selectionSet: editor.selection,
    selection: [...editor.selection],
    undoDepth: editor.doc.history().undo.length,
    redoDepth: editor.doc.history().redo.length,
    dirty: editor.doc.dirty,
    filePath: editor.doc.filePath,
    tool: editor.tool,
    toolName: editor.toolName,
    space: editor.doc.space,
    viewCenter: { ...editor.viewport.center },
    viewScale: editor.viewport.scale,
  };
}

function expectStatePreserved(editor: InstanceType<EditorClass>, before: ReturnType<typeof editorState>) {
  const after = editorState(editor);
  expect(after.snapshot).toBe(before.snapshot);
  expect(after.revision).toBe(before.revision);
  expect(after.selectionSet).toBe(before.selectionSet);
  expect(after.selection).toEqual(before.selection);
  expect(after.undoDepth).toBe(before.undoDepth);
  expect(after.redoDepth).toBe(before.redoDepth);
  expect(after.dirty).toBe(before.dirty);
  expect(after.filePath).toBe(before.filePath);
  expect(after.tool).toBe(before.tool);
  expect(after.toolName).toBe(before.toolName);
  expect(after.space).toBe(before.space);
  expect(after.viewCenter).toEqual(before.viewCenter);
  expect(after.viewScale).toBe(before.viewScale);
}

describe('AI ask flow against a real Editor', () => {
  it('binds the snapshot to the live session/document/revision/space/selection', () => {
    const editor = makeEditor();
    const source = createEditorAiSource(editor);
    const binding = source.binding();
    expect(binding.docId).toBe(editor.sessions.current.docId);
    expect(binding.docRevision).toBe(editor.doc.revision);
    expect(binding.selectionIds).toEqual(['ai-line', 'ai-text']);
    const controller = new AiAskController(source, new FixtureProvider());
    const snapshot = controller.previewSnapshot();
    expect(snapshot.objects.map((o) => o.id)).toEqual(['ai-line', 'ai-text']);
    expect(snapshot.units.insunitsName).toBeDefined();
    controller.dispose();
  });

  it('a full ask preserves every piece of editor state', async () => {
    const editor = makeEditor();
    const before = editorState(editor);
    const controller = new AiAskController(createEditorAiSource(editor), new FixtureProvider());
    const status = await controller.ask('how many objects?');
    expect(status.state).toBe('answered');
    expectStatePreserved(editor, before);
    controller.dispose();
  });

  it('cancel and provider-error cycles preserve every piece of editor state', async () => {
    const editor = makeEditor();
    const before = editorState(editor);
    const failing: AiProvider = { id: 'fail', ask: async () => { throw new Error('nope'); } };
    const c1 = new AiAskController(createEditorAiSource(editor), failing);
    expect((await c1.ask('count')).state).toBe('error');
    c1.dispose();

    const hanging: AiProvider = { id: 'hang', ask: () => new Promise(() => {}) };
    const c2 = new AiAskController(createEditorAiSource(editor), hanging);
    const asking = c2.ask('count');
    c2.cancel();
    expect((await asking).state).toBe('cancelled');
    c2.dispose();

    expectStatePreserved(editor, before);
  });

  it('an edit-then-undo in the real editor makes an in-flight answer stale', async () => {
    const editor = makeEditor();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const slow: AiProvider = {
      id: 'slow',
      ask: async () => { await gate; return { text: 'answer', references: [] }; },
    };
    const controller = new AiAskController(createEditorAiSource(editor), slow);
    const asking = controller.ask('count');
    const revisionBefore = editor.doc.revision;
    editor.doc.transact((s) => ({ ...s, entities: s.entities.map((e) => e.id === 'ai-line' ? { ...e, b: { x: 9, y: 9 } } : e) }));
    editor.doc.undo();
    // Content is back where it started; only the revision moved.
    expect(editor.doc.revision).toBe(revisionBefore + 2);
    release();
    expect((await asking).state).toBe('stale');
    controller.dispose();
  });
});
