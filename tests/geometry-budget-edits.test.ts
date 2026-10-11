import { beforeAll, describe, expect, it } from 'vitest';
import { Drawing, DEFAULT_HEADER, type DrawingState } from '../src/core/document';
import { entityGeometryWork, type BlockDef, type Entity, type InsertEntity, type TextEntity } from '../src/core/entities';
import { MAX_DRAWING_EXPANSION_WORK, validateGeometryBudget } from '../src/core/geometry-budget';
import { defaultLayout } from '../src/core/layouts';
import { createApi } from '../src/app/api';
import type { Editor as EditorType } from '../src/app/editor';
import { fallbackUi } from '../src/app/editor/internals';
import { DEFAULT_WD_SETTINGS, readWdSettings, writeWdSettings } from '../src/electrical/wdm';
import type { DrawingPropertiesInit, ElectricalUi } from '../src/electrical/ui';

const text = (id: string, length = 1): TextEntity => ({ id, type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, text: 'X'.repeat(length), height: 1, rotation: 0, align: 'left' });
const oversized = () => text('oversized', MAX_DRAWING_EXPANSION_WORK);
const insert = (id: string, name = 'B'): InsertEntity => ({ id, type: 'insert', layer: '0', color: 'ByLayer', block: name, position: { x: 0, y: 0 }, scale: 1, rotation: 0, attributes: {} });
const block = (entity: Entity): BlockDef => ({ name: 'B', basePoint: { x: 0, y: 0 }, entities: [entity], attributes: [] });
const capture = (doc: Drawing) => ({ state: doc.snapshot, history: doc.history(), dirty: doc.dirty, revision: doc.revision, loadCount: doc.loadCount, filePath: doc.filePath });
function expectUnchanged(doc: Drawing, before: ReturnType<typeof capture>): void {
  expect(doc.snapshot).toBe(before.state);
  expect(doc.history()).toEqual(before.history);
  expect(doc.dirty).toBe(before.dirty);
  expect(doc.revision).toBe(before.revision);
  expect(doc.loadCount).toBe(before.loadCount);
  expect(doc.filePath).toBe(before.filePath);
}

describe('mutable caller data and geometry budget memoization', () => {
  it('rechecks a raw state when entities are added to the same array after validation', () => {
    const entities: Entity[] = [text('small')];
    const state: DrawingState = { ...new Drawing().snapshot, entities };
    validateGeometryBudget(state);
    entities.push(oversized());
    expect(() => validateGeometryBudget(state)).toThrow(/Drawing expansion/);
  });

  it('rechecks an entity changed in place, even when the state wrapper is new or shallow-frozen', () => {
    const entity = { ...text('small') };
    const state = { ...new Drawing().snapshot, entities: [entity] };
    expect(entityGeometryWork(entity)).toBe(2);
    validateGeometryBudget(state);
    entity.text = 'X'.repeat(MAX_DRAWING_EXPANSION_WORK);
    expect(entityGeometryWork(entity)).toBe(MAX_DRAWING_EXPANSION_WORK + 1);
    expect(() => validateGeometryBudget(Object.freeze({ ...state }))).toThrow(/Drawing expansion/);
  });

  it('takes immutable ownership of borrowed geometry while retaining its shared identities', () => {
    const entity = { ...text('small') };
    const entities: Entity[] = [entity];
    const definition = block(text('inside'));
    const definitions = { B: definition };
    const layouts = [{ ...defaultLayout('L1'), entities: [text('paper')] }];
    const doc = new Drawing({ entities, blocks: definitions, layouts });
    expect(doc.entities).toBe(entities);
    expect(doc.entity('small')).toBe(entity);
    expect(doc.blocks.B).toBe(definition);
    expect(doc.snapshot.layouts).toBe(layouts);
    expect(() => entities.push(oversized())).toThrow(TypeError);
    expect(() => { entity.text = 'changed'; }).toThrow(TypeError);
    expect(() => { (definition.entities as Entity[]).push(oversized()); }).toThrow(TypeError);
    expect(() => { layouts[0]!.entities.push(oversized()); }).toThrow(TypeError);
    expect(() => validateGeometryBudget(doc.snapshot)).not.toThrow();
    expect(doc.entity('small')).toMatchObject({ text: 'X' });
  });

  it('protects nested point data, loaded states and arrays returned by paper-space projections', () => {
    const points = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    const polyline: Entity = { id: 'poly', type: 'polyline', layer: '0', color: 'ByLayer', points, closed: false };
    const state: DrawingState = { ...new Drawing().snapshot, entities: [polyline], layouts: [defaultLayout('L1')], space: { layout: 'L1' } };
    const doc = new Drawing();
    doc.load(state, 'loaded.dxf');
    expect(doc.snapshot).toBe(state);
    expect(() => { points[0]!.x = 2; }).toThrow(TypeError);
    expect(() => points.push({ x: 3, y: 3 })).toThrow(TypeError);
    expect(() => { (doc.entities as Entity[]).push(oversized()); }).toThrow(TypeError);
    expect(() => { (doc.layouts as unknown[]).pop(); }).toThrow(TypeError);
  });

  it('seals nonenumerable geometry and refuses dynamic getter-backed snapshots', () => {
    const points = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    const entity = { id: 'poly', type: 'polyline', layer: '0', color: 'ByLayer', closed: false } as unknown as Entity;
    Object.defineProperty(entity, 'points', { value: points, enumerable: false, configurable: true });
    const doc = new Drawing({ entities: [entity] });
    expect(() => points.push({ x: 2, y: 2 })).toThrow(TypeError);
    const before = capture(doc);
    const dynamic = { ...text('dynamic') };
    Object.defineProperty(dynamic, 'text', { get: () => 'changing', enumerable: true });
    expect(() => doc.addEntities([dynamic])).toThrow(/value properties/);
    expectUnchanged(doc, before);
  });
});

describe('geometry edits are rejected before the document commits', () => {
  it.each(['add', 'replace', 'replaceWith', 'transact'] as const)('rejects an oversized %s without changing state, history, flags or revision', (operation) => {
    const doc = new Drawing();
    doc.addEntities([text('keep')]);
    doc.addEntities([text('redo')]);
    doc.undo();
    doc.dirty = false;
    doc.filePath = 'keep.dxf';
    let notifications = 0;
    doc.subscribe(() => { notifications += 1; });
    const before = capture(doc);
    const change = () => {
      switch (operation) {
        case 'add': doc.addEntities([oversized()]); break;
        case 'replace': doc.replaceEntities([{ ...oversized(), id: 'keep' }]); break;
        case 'replaceWith': doc.replaceWith(['keep'], [oversized()]); break;
        case 'transact': doc.transact((state) => ({ ...state, entities: [oversized()] })); break;
      }
    };
    expect(change).toThrow(/Drawing expansion/);
    expectUnchanged(doc, before);
    expect(notifications).toBe(0);
    expect(doc.redo()).toBe(true);
    expect(doc.entities.map((entity) => entity.id)).toEqual(['keep', 'redo']);
  });

  it('rejects aggregate growth from many individually acceptable inserts or block redefinition', () => {
    const heavy = block(text('inside', 50_000));
    const doc = new Drawing({ blocks: { B: heavy }, entities: [insert('keep')] });
    let before = capture(doc);
    expect(() => doc.addEntities(Array.from({ length: 20 }, (_, index) => insert(`new${index}`)))).toThrow(/Drawing expansion/);
    expectUnchanged(doc, before);
    const other = new Drawing({ blocks: { B: block(text('inside')) }, entities: Array.from({ length: 21 }, (_, index) => insert(`${index}`)) });
    before = capture(other);
    expect(() => other.defineBlock(heavy)).toThrow(/Drawing expansion/);
    expectUnchanged(other, before);
    expect(other.blocks.B?.entities[0]).toMatchObject({ text: 'X' });
  });

  it('rejects an individually excessive insert and an unused excessive definition', () => {
    const doc = new Drawing({ entities: [insert('keep')] });
    const before = capture(doc);
    expect(() => doc.defineBlock(block(text('inside', 100_000)))).toThrow(/Block expansion/);
    expectUnchanged(doc, before);
    expect(() => doc.ensureBlocks([block(oversized())])).toThrow(/block definitions/);
    expectUnchanged(doc, before);
  });

  it('counts model and paper geometry together before committing a paper-space edit', () => {
    const doc = new Drawing({ entities: [text('model', 900_000)], layouts: [defaultLayout('L1')], space: { layout: 'L1' } });
    const before = capture(doc);
    expect(() => doc.addEntities([text('paper', 100_000)])).toThrow(/Drawing expansion/);
    expectUnchanged(doc, before);
    expect(doc.entities).toHaveLength(0);
    expect(doc.snapshot.entities[0]?.id).toBe('model');
  });

  it('refuses mutation of transaction input before it can corrupt the live drawing', () => {
    const doc = new Drawing({ entities: [text('keep')] });
    const before = capture(doc);
    expect(() => doc.transact((state) => {
      (state.entities as Entity[]).push(oversized());
      return state;
    })).toThrow(TypeError);
    expectUnchanged(doc, before);
  });
});

describe('quiet and history transitions are atomic', () => {
  it.each(['quiet', 'space'] as const)('keeps every state when a %s change rejects an entry on the redo stack', (operation) => {
    const doc = new Drawing({ layouts: [defaultLayout('L1')] });
    doc.addEntities([text('keep')]);
    doc.addEntities([text('redo')]);
    doc.undo();
    doc.dirty = false;
    const before = capture(doc);
    const patch = (state: DrawingState): DrawingState => state.entities.some((entity) => entity.id === 'redo')
      ? { ...state, entities: [oversized()] }
      : { ...state, header: { ...(state.header ?? DEFAULT_HEADER), ltscale: 2 } };
    expect(() => operation === 'quiet' ? doc.patchQuiet(patch, false) : doc.setSpace({ layout: 'L1' }, patch)).toThrow(/Drawing expansion/);
    expectUnchanged(doc, before);
    expect(doc.header.ltscale).toBe(1);
    expect(doc.space).toBeUndefined();
  });

  it('checks old states before library definitions are quietly added to all history entries', () => {
    const doc = new Drawing({ entities: Array.from({ length: 21 }, (_, index) => insert(`${index}`)) });
    doc.removeEntities(doc.entities.map((entity) => entity.id));
    const before = capture(doc);
    expect(() => doc.ensureBlocks([block(text('inside', 50_000))])).toThrow(/Drawing expansion/);
    expectUnchanged(doc, before);
    expect(doc.blocks.B).toBeUndefined();
    expect(doc.undo()).toBe(true);
    expect(doc.entities).toHaveLength(21);
  });

  it('rejects imported oversized history before replacing either history stack', () => {
    const doc = new Drawing({ entities: [text('keep')] });
    doc.addEntities([text('second')]);
    const before = capture(doc);
    const invalid = { ...doc.snapshot, entities: [oversized()] };
    expect(() => doc.restoreHistory({ undo: [new Drawing().snapshot], redo: [invalid] })).toThrow(/Drawing expansion/);
    expectUnchanged(doc, before);
    expect(doc.undo()).toBe(true);
    expect(doc.entities.map((entity) => entity.id)).toEqual(['keep']);
  });

  it('keeps unchanged identities through accepted quiet changes, undo, redo and repeated loads', () => {
    const doc = new Drawing({ layouts: [defaultLayout('L1')] });
    doc.addEntities([text('a')]);
    doc.addEntities([text('b')]);
    const entities = doc.snapshot.entities;
    const entity = entities[0];
    doc.setHeader({ ltscale: 2 });
    doc.setSpace({ layout: 'L1' });
    doc.patchQuiet((state) => ({ ...state, layouts: state.layouts!.map((layout) => ({ ...layout, plotScale: '1:2' })) }));
    expect(doc.snapshot.entities).toBe(entities);
    expect(doc.undo()).toBe(true);
    expect(doc.snapshot.entities[0]).toBe(entity);
    expect(doc.redo()).toBe(true);
    const state = doc.snapshot;
    const history = doc.history();
    doc.load(state);
    doc.restoreHistory(history);
    expect(doc.snapshot).toBe(state);
    expect(doc.snapshot.entities).toBe(entities);
    expect(() => validateGeometryBudget(state)).not.toThrow();
  });
});

describe('supported plugin batch transactions obey document budgets', () => {
  let Editor: typeof EditorType;
  beforeAll(async () => {
    const globals = globalThis as Record<string, unknown>;
    globals.requestAnimationFrame = () => 1;
    globals.cancelAnimationFrame = () => {};
    Editor = (await import('../src/app/editor')).Editor;
  });

  it('rejects an excessive pending batch and permits the next valid transaction', () => {
    const canvas = { getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement;
    const editor = new Editor(canvas);
    const { api } = createApi(editor, 'budget-test');
    const before = capture(editor.doc);
    expect(() => api.document.transact(() => {
      api.document.add(text('one', 600_000));
      api.document.add(text('two', 600_000));
    })).toThrow(/Drawing expansion/);
    expectUnchanged(editor.doc, before);
    api.document.transact(() => {
      api.document.add(text('valid-one'));
      api.document.add(text('valid-two'));
    });
    expect(editor.doc.entities.map((entity) => entity.id)).toEqual(['valid-one', 'valid-two']);
    expect(editor.doc.undo()).toBe(true);
    expect(editor.doc.snapshot).toBe(before.state);
  });

  it('reports a rejected built-in command, preserves history and permits the next valid edit', () => {
    const canvas = { getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement;
    const editor = new Editor(canvas);
    editor.doc.addEntities([text('keep')]);
    editor.doc.dirty = false;
    editor.register({ name: 'OVERSIZED', aliases: [], description: 'Test a rejected edit', run: (ed) => ed.doc.addEntities([oversized()]) });
    const before = capture(editor.doc);
    expect(() => editor.runCommand('OVERSIZED')).not.toThrow();
    expectUnchanged(editor.doc, before);
    expect(editor.history.at(-1)).toMatch(/Edit canceled:.*safe geometry budget.*try again/);
    expect(editor.prompt).toBe('Type a command');
    editor.runCommand('LINE');
    editor.submitInput('0,0');
    editor.submitInput('1,0');
    expect(editor.doc.entities).toHaveLength(2);
    expect(editor.doc.undo()).toBe(true);
    expect(editor.doc.snapshot).toBe(before.state);
  });

  it('ends a rejected mouse-driven tool and continues accepting valid commands', () => {
    const canvas = { getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement;
    const editor = new Editor(canvas);
    editor.startTool({ name: 'OVERSIZED', start: (ctx) => ctx.prompt('Pick a point'), onPoint: (_point, ctx) => ctx.doc.addEntities([oversized()]), onMove: () => {}, onText: () => {}, onEnter: () => {}, onCancel: () => {} });
    const before = capture(editor.doc);
    expect(() => editor.onMouseDown({ button: 0, clientX: 10, clientY: 10 } as MouseEvent)).not.toThrow();
    expectUnchanged(editor.doc, before);
    expect(editor.tool).toBeNull();
    expect(editor.prompt).toBe('Type a command');
    editor.runCommand('LINE');
    editor.submitInput('0,0');
    editor.submitInput('1,0');
    expect(editor.doc.entities).toHaveLength(1);
  });

  it('handles a returned asynchronous tool refusal without canceling a newer tool', async () => {
    const canvas = { getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement;
    const editor = new Editor(canvas);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    editor.register({ name: 'PENDING', aliases: [], description: 'Pending tool', run: (ed) => ed.startTool({ name: 'PENDING', start: async (ctx) => { await pending; ctx.doc.addEntities([oversized()]); }, onPoint: () => {}, onMove: () => {}, onText: () => {}, onEnter: () => {}, onCancel: () => {} }) });
    editor.runCommand('PENDING');
    const before = capture(editor.doc);
    editor.runCommand('LINE');
    const current = editor.tool;
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expectUnchanged(editor.doc, before);
    expect(editor.tool).toBe(current);
    expect(editor.history.at(-1)).toMatch(/Edit canceled:/);
    editor.submitInput('0,0');
    editor.submitInput('1,0');
    expect(editor.doc.entities).toHaveLength(1);
  });

  it('reports a rejected signal-arrow dialog edit and accepts the next valid edit', async () => {
    const canvas = { getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement;
    const editor = new Editor(canvas);
    editor.ui = { ...fallbackUi, textInput: async () => 'X'.repeat(100_000) };
    editor.runCommand('AESOURCE');
    editor.doc.dirty = false;
    const before = capture(editor.doc);
    editor.submitInput('0,0');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expectUnchanged(editor.doc, before);
    expect(editor.history.at(-1)).toMatch(/Edit canceled:.*safe geometry budget/);
    expect(editor.tool).toBeNull();
    expect(editor.prompt).toBe('Type a command');
    editor.ui = fallbackUi;
    editor.runCommand('AESOURCE');
    editor.submitInput('0,0');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editor.doc.entities).toHaveLength(1);
    expect(editor.doc.entities[0]).toMatchObject({ type: 'insert', attributes: { SIGCODE: '' } });
    expect(editor.doc.undo()).toBe(true);
    expect(editor.doc.snapshot).toBe(before.state);
  });

  it('handles an asynchronous drawing-properties command refusal and permits a later valid dialog update', async () => {
    const canvas = { getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement;
    const editor = new Editor(canvas);
    writeWdSettings(editor.doc, DEFAULT_WD_SETTINGS);
    editor.doc.dirty = false;
    let description = 'X'.repeat(100_000);
    editor.hooks.electrical = { drawingProperties: async (init: DrawingPropertiesInit) => ({ settings: init.settings, description, sheet: '1', dwgno: 'D1' }) } as ElectricalUi;
    const before = capture(editor.doc);
    await editor.runCommand('AEDRAWINGPROPS');
    expectUnchanged(editor.doc, before);
    expect(editor.history.at(-1)).toMatch(/Edit canceled:.*safe geometry budget/);
    description = 'Valid description';
    await editor.runCommand('AEDRAWINGPROPS');
    expect(readWdSettings(editor.doc).drawingDescription).toBe(description);
    expect(editor.doc.undo()).toBe(true);
    expect(editor.doc.snapshot).toBe(before.state);
  });

  it.each(['command', 'tool'] as const)('returns an API %s promise whose budget refusal still propagates after the API depth resets', async (kind) => {
    const canvas = { getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement;
    const editor = new Editor(canvas);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const edit = async () => { await pending; editor.doc.addEntities([oversized()]); };
    editor.register({ name: 'ASYNC_OVERSIZED', aliases: [], description: 'Rejected asynchronous edit', run: (ed) => kind === 'command'
      ? edit()
      : ed.startTool({ name: 'PENDING', start: edit, onPoint: () => {}, onMove: () => {}, onText: () => {}, onEnter: () => {}, onCancel: () => {} }) });
    const { api } = createApi(editor, 'budget-test');
    const before = capture(editor.doc);
    const result = api.commands.run('ASYNC_OVERSIZED');
    expect(result).toBeInstanceOf(Promise);
    expect(editor.apiCommandDepth).toBe(0);
    const rejected = expect(result).rejects.toThrow(/safe geometry budget/);
    finish();
    await rejected;
    expectUnchanged(editor.doc, before);
    expect(editor.history.some((message) => message.startsWith('Edit canceled:'))).toBe(false);
    api.document.add(text('next-valid'));
    expect(editor.doc.entities.map((entity) => entity.id)).toEqual(['next-valid']);
  });

  it.each(['human', 'api'] as const)('preserves %s handling when an awaited dialog starts a rejected tool later', async (origin) => {
    const canvas = { getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement;
    const editor = new Editor(canvas);
    let finish!: () => void;
    const dialog = new Promise<void>((resolve) => { finish = resolve; });
    editor.register({ name: 'DELAYED_TOOL', aliases: [], description: 'Dialog then rejected tool', run: (ed) => dialog.then(() => ed.startTool({ name: 'DELAYED', start: async (ctx) => { await Promise.resolve(); ctx.doc.addEntities([oversized()]); }, onPoint: () => {}, onMove: () => {}, onText: () => {}, onEnter: () => {}, onCancel: () => {} })) });
    const { api } = createApi(editor, 'budget-test');
    const before = capture(editor.doc);
    const result = origin === 'api' ? api.commands.run('DELAYED_TOOL') : editor.runCommand('DELAYED_TOOL');
    expect(editor.apiCommandDepth).toBe(0);
    const settled = origin === 'api' ? expect(result).rejects.toThrow(/safe geometry budget/) : expect(result).resolves.toBeUndefined();
    finish();
    await settled;
    expectUnchanged(editor.doc, before);
    expect(editor.tool).toBeNull();
    expect(editor.prompt).toBe('Type a command');
    expect(editor.history.filter((message) => message.startsWith('Edit canceled:'))).toHaveLength(origin === 'api' ? 0 : 1);
    editor.runCommand('LINE');
    editor.submitInput('0,0');
    editor.submitInput('1,0');
    expect(editor.doc.entities).toHaveLength(1);
  });

  it('propagates unrelated failures from a tool started after an API dialog', async () => {
    const canvas = { getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement;
    const editor = new Editor(canvas);
    editor.register({ name: 'BROKEN_DELAYED_TOOL', aliases: [], description: 'Unexpected tool startup failure', run: (ed) => Promise.resolve().then(() => ed.startTool({ name: 'BROKEN', start: async () => { throw new Error('unexpected asynchronous startup'); }, onPoint: () => {}, onMove: () => {}, onText: () => {}, onEnter: () => {}, onCancel: () => {} })) });
    const { api } = createApi(editor, 'budget-test');
    await expect(api.commands.run('BROKEN_DELAYED_TOOL')).rejects.toThrow('unexpected asynchronous startup');
    expect(editor.history.some((message) => message.startsWith('Edit canceled:'))).toBe(false);
  });

  it('propagates unrelated failures and plugin command budget refusals', () => {
    const canvas = { getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement;
    const editor = new Editor(canvas);
    editor.register({ name: 'BROKEN', aliases: [], description: 'Unexpected failure', run: () => { throw new Error('unexpected'); } });
    editor.register({ name: 'OVERSIZED', aliases: [], description: 'Rejected edit', run: (ed) => ed.doc.addEntities([oversized()]) });
    expect(() => editor.runCommand('BROKEN')).toThrow('unexpected');
    const { api } = createApi(editor, 'budget-test');
    const before = capture(editor.doc);
    expect(() => api.commands.run('OVERSIZED')).toThrow(/safe geometry budget/);
    expectUnchanged(editor.doc, before);
  });
});
