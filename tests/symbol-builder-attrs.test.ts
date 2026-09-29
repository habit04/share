/**
 * Symbol Builder attribute editing: prompts, defaults, order, ATTDEF flags,
 * text height / justification, attribute templates, insertion prompts, the
 * user-library round trip (and loading an older library file), and the QA
 * checks / pre-save checklist.
 */
import { describe, it, expect } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import type { Entity, LineEntity, TextEntity } from '../src/core/entities';
import { newId } from '../src/core/entities';
import { findSymbol } from '../src/electrical/symbols';
import { UserLibrary, memoryUserLibraryStore, parseUserLibrary, serializeUserLibrary } from '../src/electrical/userlib';
import {
  blankSymbolState,
  blockToSymbolState,
  symbolStateToBlock,
  compilePlaceholders,
  orderedPlaceholders,
  attributeOrder,
  moveInOrder,
  quickAddAttributes,
  insertionPrompts,
  templatePosition,
  attdefFlags,
  attdefFlagProps,
  checkSymbol,
  saveChecklist,
  checklistWarnings,
  defaultMeta,
  metaOf,
  withMeta,
  placeholderEntity,
  pinMarkerText,
  attributePrompt,
  ATTRIBUTE_TEMPLATE_GROUPS,
  TEMPLATE_ATTRIBUTES,
  KNOWN_ATTRIBUTES,
  type AttributeDefExt,
  type SymbolMeta,
  type SymbolState,
} from '../src/electrical/symbol-builder-core';
import { validBlockName } from '../src/tools/blocks';

const line = (x1: number, y1: number, x2: number, y2: number): LineEntity => ({ id: newId(), layer: '0', color: 'ByLayer', type: 'line', a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });
const opts = { isBuiltin: (n: string) => !!findSymbol(n), isUser: () => false, validName: validBlockName, knownFamily: (f: string) => ['PB', 'CR', 'LS'].includes(f) };
const levels = (msgs: ReturnType<typeof checkSymbol>, level: string) => msgs.filter((m) => m.level === level).map((m) => m.text);

function relay(meta: Partial<SymbolMeta> = {}, extra: Entity[] = []): SymbolState {
  const m = defaultMeta({ name: 'USER_CR9', family: 'CR', kind: 'parent', ...meta });
  const entities: Entity[] = [line(-0.375, 0, -0.125, 0), line(0.125, 0, 0.375, 0), placeholderEntity('TAG1'), placeholderEntity('DESC1'), placeholderEntity('MFG', { x: 0, y: -0.9 }), ...extra];
  return { state: { ...blankSymbolState(m), entities }, meta: m };
}
const byTag = (list: readonly AttributeDefExt[]) => Object.fromEntries(list.map((a) => [a.tag, a]));

describe('attribute settings', () => {
  it('compiles prompts, flags and the block order from the meta', () => {
    const { state, meta } = relay({
      attrProps: { MFG: { prompt: 'Maker', invisible: true, preset: true }, DESC1: { verify: true }, TAG1: { prompt: '  ' } },
      attrOrder: ['MFG', 'TAG1'],
      attrDefaults: { MFG: 'ACME' },
    });
    const list = compilePlaceholders(state, meta);
    expect(list.map((a) => a.tag)).toEqual(['MFG', 'TAG1', 'DESC1']);
    const a = byTag(list);
    expect(a.MFG).toMatchObject({ prompt: 'Maker', invisible: true, placeholder: true, preset: true, default: 'ACME' });
    expect(a.DESC1!.verify).toBe(true);
    expect(a.TAG1!.prompt).toBe('Component tag'); // a blank prompt falls back to the standard one
    const block = symbolStateToBlock(state, meta);
    expect(block.attributes.slice(0, 3).map((x) => x.tag)).toEqual(['MFG', 'TAG1', 'DESC1']);
    // DESC2 / DESC3 derived from DESC1 do not inherit its flags or prompt
    const d2 = block.attributes.find((x) => x.tag === 'DESC2') as AttributeDefExt;
    expect(d2.verify).toBeUndefined();
    expect(d2.placeholder).toBeUndefined();
    expect(d2.prompt).toBe('Description line 2');
    expect(d2.invisible).toBe(true);
    // the placed MFG is not duplicated by the automatic data attributes
    expect(block.attributes.filter((x) => x.tag === 'MFG')).toHaveLength(1);
  });

  it('keeps text height, justification and rotation of the placeholder', () => {
    const t: TextEntity = { ...placeholderEntity('DESC1'), height: 0.2, align: 'right', rotation: Math.PI / 2 };
    const { state, meta } = relay({}, []);
    const s2: DrawingState = { ...state, entities: state.entities.map((e) => (e.type === 'text' && e.text === 'DESC1' ? { ...t, id: e.id } : e)) };
    const d = byTag(compilePlaceholders(s2, meta)).DESC1!;
    expect([d.height, d.align, d.rotation]).toEqual([0.2, 'right', Math.PI / 2]);
  });

  it('reorders with move up / down and follows the order in the palette list', () => {
    const { state, meta } = relay();
    const order = attributeOrder(state, meta);
    expect(order).toEqual(['TAG1', 'DESC1', 'MFG']);
    expect(moveInOrder(order, 'MFG', -1)).toEqual(['TAG1', 'MFG', 'DESC1']);
    expect(moveInOrder(order, 'TAG1', -1)).toEqual(order);
    expect(moveInOrder(order, 'MFG', 1)).toEqual(order);
    expect(moveInOrder(order, 'NOPE', 1)).toEqual(order);
    const m2 = defaultMeta({ ...meta, attrOrder: moveInOrder(order, 'MFG', -1) });
    expect(orderedPlaceholders(state, m2).map((t) => t.text)).toEqual(['TAG1', 'MFG', 'DESC1']);
  });

  it('is undoable: the settings live in DrawingState.meta', () => {
    const { state, meta } = relay();
    const doc = new Drawing();
    doc.load(state);
    doc.transact((s) => withMeta(s, defaultMeta({ ...meta, attrProps: { TAG1: { prompt: 'Relay tag' } }, attrOrder: ['DESC1', 'TAG1'] })));
    expect(metaOf(doc.snapshot)!.attrProps).toEqual({ TAG1: { prompt: 'Relay tag' } });
    expect(metaOf(doc.snapshot)!.attrOrder).toEqual(['DESC1', 'TAG1']);
    expect(doc.undo()).toBe(true);
    expect(metaOf(doc.snapshot)!.attrProps).toBeUndefined();
    expect(metaOf(doc.snapshot)!.attrOrder).toBeUndefined();
    expect(doc.redo()).toBe(true);
    expect(metaOf(doc.snapshot)!.attrProps!.TAG1!.prompt).toBe('Relay tag');
  });

  it('maps the ATTDEF mode flags (DXF group 70)', () => {
    const a = { tag: 'X', prompt: '', default: '', position: { x: 0, y: 0 }, height: 0.1, align: 'left' as const };
    expect(attdefFlags(a)).toBe(0);
    expect(attdefFlags({ ...a, invisible: true, constant: true, verify: true, preset: true })).toBe(15);
    expect(attdefFlags({ ...a, preset: true })).toBe(8);
    expect(attdefFlagProps(10)).toEqual({ constant: true, preset: true });
    expect(attdefFlagProps(5)).toEqual({ invisible: true, verify: true });
  });
});

describe('reopening a saved symbol', () => {
  it('restores invisible placed attributes as placeholders with their prompt, flags and order', () => {
    const { state, meta } = relay({ attrProps: { MFG: { prompt: 'Maker', invisible: true }, TAG1: { constant: true } }, attrOrder: ['DESC1', 'MFG', 'TAG1'], attrDefaults: { TAG1: 'CRX' } });
    const block = symbolStateToBlock(state, meta);
    const back = blockToSymbolState(block, { kind: 'parent', family: 'CR' });
    expect(back.state.entities.filter((e): e is TextEntity => e.type === 'text' && e.layer === 'SYMATTR').map((t) => t.text)).toEqual(['DESC1', 'MFG', 'TAG1']);
    expect(back.meta.attrProps).toEqual({ MFG: { prompt: 'Maker', invisible: true }, TAG1: { constant: true } });
    // auto-added invisible data attributes (INST, CAT ...) do not become placeholders
    expect(back.state.entities.some((e) => e.type === 'text' && e.text === 'INST')).toBe(false);
    const again = symbolStateToBlock(back.state, back.meta);
    expect(again.attributes.map((a) => [a.tag, a.prompt, a.invisible ?? false, (a as AttributeDefExt).constant ?? false])).toEqual(block.attributes.map((a) => [a.tag, a.prompt, a.invisible ?? false, (a as AttributeDefExt).constant ?? false]));
  });
  it('opens a built-in symbol without inventing settings', () => {
    const sym = blockToSymbolState(findSymbol('HPB11_NO')!);
    expect(sym.meta.attrProps).toBeUndefined();
    expect(sym.meta.attrOrder).toBeUndefined();
  });
});

describe('attribute templates', () => {
  it('lists the AutoCAD Electrical attribute names and knows them all', () => {
    expect(TEMPLATE_ATTRIBUTES).toEqual(['TAG1', 'DESC1', 'DESC2', 'DESC3', 'INST', 'LOC', 'MFG', 'CAT', 'ASSYCODE', 'TERM01', 'TERM02', 'XREF', ...Array.from({ length: 12 }, (_, i) => `RATING${i + 1}`)]);
    for (const t of TEMPLATE_ATTRIBUTES) expect(KNOWN_ATTRIBUTES.has(t), t).toBe(true);
    expect(attributePrompt('RATING7')).toBe('Rating 7');
    expect(attributePrompt('XREF')).toBe('Cross-reference');
    expect(attributePrompt('TERM02')).toBe('Terminal number 2');
  });
  it('adds only the missing tags of a group, stacked, invisible for data groups, in one meta update', () => {
    const { state, meta } = relay();
    const r = quickAddAttributes(state, meta, 'tag')!;
    expect(r.entities.map((e) => e.text)).toEqual(['DESC2', 'DESC3']);
    expect(r.meta.attrOrder).toEqual(['TAG1', 'DESC1', 'MFG', 'DESC2', 'DESC3']);
    expect(r.meta.attrProps).toBeUndefined();
    const s2: DrawingState = { ...state, entities: [...state.entities, ...r.entities] };
    expect(quickAddAttributes(s2, r.meta, 'tag')).toBeNull();
    const rat = quickAddAttributes(s2, r.meta, 'ratings')!;
    expect(rat.entities).toHaveLength(12);
    expect(Object.keys(rat.meta.attrProps!).sort()).toEqual([...Array.from({ length: 12 }, (_, i) => `RATING${i + 1}`)].sort());
    expect(Object.values(rat.meta.attrProps!).every((p) => p.invisible)).toBe(true);
    const ys = rat.entities.map((e) => e.position.y);
    expect(new Set(ys.map((y) => y.toFixed(3))).size).toBe(12); // no two on top of each other
    // MFG was already placed, so the first rating stacks below it
    expect(Math.max(...ys)).toBeLessThan(-0.9);
    expect(quickAddAttributes(state, meta, 'nope')).toBeNull();
    expect(ATTRIBUTE_TEMPLATE_GROUPS.find((g) => g.key === 'catalog')!.invisible).toBe(true);
    // vertical symbols stack to the right of the stub
    expect(templatePosition('XREF', 'V', 0).x).toBeGreaterThan(0.3);
    const block = symbolStateToBlock({ ...s2, entities: [...s2.entities, ...rat.entities] }, rat.meta);
    expect(block.attributes.filter((a) => /^RATING\d+$/.test(a.tag))).toHaveLength(12);
    expect(checkSymbol({ ...s2, entities: [...s2.entities, ...rat.entities] }, rat.meta, opts).some((m) => /not a known ACADE attribute/.test(m.text))).toBe(false);
  });
});

describe('insertion prompts', () => {
  it('prompts the placed attributes in block order with their prompt texts, skipping constant / preset / pins / automatic data', () => {
    const { state, meta } = relay({
      attrProps: { MFG: { prompt: 'Maker', invisible: true }, DESC1: { preset: true }, TAG1: { verify: true } },
      attrOrder: ['MFG', 'TAG1', 'DESC1'],
    });
    const extra = placeholderEntity('RATING1', { x: 0, y: -1.1 });
    const s2 = { ...state, entities: [...state.entities, extra] };
    const m2 = defaultMeta({ ...meta, attrProps: { ...meta.attrProps, RATING1: { constant: true } }, attrDefaults: { RATING1: '24VDC' } });
    const block = symbolStateToBlock(s2, m2);
    expect(insertionPrompts(block).map((p) => [p.tag, p.prompt, p.verify, p.invisible])).toEqual([
      ['MFG', 'Maker', false, true],
      ['TAG1', 'Component tag', true, false],
    ]);
    // a built-in symbol prompts its visible attributes
    expect(insertionPrompts(findSymbol('HCR1')!).map((p) => p.tag)).toEqual(['TAG1', 'DESC1', 'DESC2', 'DESC3']);
  });
});

describe('user library', () => {
  it('keeps prompts, order and flags through save and load', async () => {
    const store = memoryUserLibraryStore();
    const lib = new UserLibrary(store);
    await lib.load();
    const { state, meta } = relay({ attrProps: { MFG: { prompt: 'Maker', invisible: true, verify: true }, TAG1: { preset: true } }, attrOrder: ['MFG', 'TAG1'] });
    const block = symbolStateToBlock(state, meta);
    lib.put({ block, standard: 'JIC', category: 'Test', family: 'CR', wdtype: 'COIL' });
    await lib.flush();
    const lib2 = new UserLibrary(store);
    await lib2.load();
    const loaded = lib2.get('USER_CR9')!.block;
    expect(loaded.attributes.map((a) => a.tag).slice(0, 3)).toEqual(['MFG', 'TAG1', 'DESC1']);
    const mfg = loaded.attributes.find((a) => a.tag === 'MFG') as AttributeDefExt;
    expect(mfg).toMatchObject({ prompt: 'Maker', invisible: true, verify: true, placeholder: true });
    expect((loaded.attributes.find((a) => a.tag === 'TAG1') as AttributeDefExt).preset).toBe(true);
    expect(insertionPrompts(loaded).map((p) => p.tag)).toEqual(['MFG', 'DESC1']);
    const reopened = blockToSymbolState(loaded, { kind: 'parent', family: 'CR' });
    expect(reopened.meta.attrProps).toEqual({ MFG: { prompt: 'Maker', invisible: true, verify: true }, TAG1: { preset: true } });
  });

  it('loads an older user-library.json (no prompts order or flags) unchanged', async () => {
    const old = JSON.stringify({
      format: 'jcad-user-library',
      version: 1,
      symbols: [
        {
          block: {
            name: 'USER_OLD1',
            basePoint: { x: 0, y: 0 },
            description: 'Old limit switch',
            entities: [
              { id: 'a', layer: '0', color: 'ByLayer', type: 'line', a: { x: -0.375, y: 0 }, b: { x: -0.1, y: 0 } },
              { id: 'b', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0.1, y: 0 }, b: { x: 0.375, y: 0 } },
            ],
            attributes: [
              { tag: 'TAG1', prompt: 'Component tag', default: '', position: { x: 0, y: 0.3 }, height: 0.125, align: 'center' },
              { tag: 'DESC1', prompt: 'Description', default: '', position: { x: 0, y: -0.45 }, height: 0.1, align: 'center' },
              { tag: 'MFG', prompt: 'MFG', default: 'ACME', position: { x: 0, y: 0.45 }, height: 0.07, align: 'center', invisible: true },
              { tag: 'X1TERM01', prompt: 'Pin 1', default: '1', position: { x: -0.375, y: 0 }, height: 0.06, align: 'center', invisible: true },
              { tag: 'X4TERM02', prompt: 'Pin 2', default: '2', position: { x: 0.375, y: 0 }, height: 0.06, align: 'center', invisible: true },
            ],
          },
          standard: 'JIC',
          category: 'Old',
          family: 'LS',
          created: 1700000000000,
          modified: 1700000000000,
        },
      ],
    });
    const [sym] = parseUserLibrary(old);
    expect(sym!.block.attributes).toHaveLength(5);
    expect(sym!.block.attributes.every((a) => (a as AttributeDefExt).constant === undefined && (a as AttributeDefExt).placeholder === undefined)).toBe(true);
    const store = memoryUserLibraryStore();
    store.json = old;
    const lib = new UserLibrary(store);
    expect(await lib.load()).toBe(1);
    expect(lib.lastError).toBeNull();
    const st = blockToSymbolState(lib.get('USER_OLD1')!.block, { family: 'LS' });
    expect(st.meta.attrProps).toBeUndefined();
    expect(st.meta.attrDefaults.MFG).toBe('ACME');
    expect(st.state.entities.filter((e) => e.type === 'text' && e.layer === 'SYMATTR').map((e) => (e as TextEntity).text)).toEqual(['TAG1', 'DESC1']);
    expect(insertionPrompts(lib.get('USER_OLD1')!.block).map((p) => p.tag)).toEqual(['TAG1', 'DESC1']);
    // written back without new fields it never had
    const again = JSON.parse(serializeUserLibrary(lib.all()));
    expect(Object.keys(again.symbols[0].block.attributes[0]).sort()).toEqual(['align', 'default', 'height', 'position', 'prompt', 'tag']);
  });
});

describe('QA checks and the pre-save checklist', () => {
  const noPins = (): SymbolState => {
    const m = defaultMeta({ name: 'USER_CR8', family: 'CR', kind: 'parent' });
    return { state: { ...blankSymbolState(m), entities: [line(-0.2, 0, 0.2, 0), placeholderEntity('TAG1'), placeholderEntity('DESC1')] }, meta: m };
  };
  it('flags a symbol without connection points', () => {
    const { state, meta } = noPins();
    expect(levels(checkSymbol(state, meta, opts), 'error').some((t) => /No wire connection/.test(t))).toBe(true);
    const items = saveChecklist(state, meta, opts);
    expect(items.find((i) => i.key === 'pins')).toMatchObject({ ok: false, level: 'error' });
  });
  it('flags overlapping pins', () => {
    const { state, meta } = relay({}, [pinMarkerText('X1TERM01', { x: -0.375, y: 0 }), pinMarkerText('X1TERM03', { x: -0.375, y: 0 })]);
    expect(levels(checkSymbol(state, meta, opts), 'error').some((t) => /Two pins on one point/.test(t))).toBe(true);
    const item = saveChecklist(state, meta, opts).find((i) => i.key === 'overlap')!;
    expect(item.ok).toBe(false);
    expect(item.detail).toMatch(/X1TERM01 \/ X1TERM02/);
  });
  it('flags a parent symbol without TAG1', () => {
    const { state, meta } = relay();
    const noTag: DrawingState = { ...state, entities: state.entities.filter((e) => !(e.type === 'text' && e.text === 'TAG1')) };
    expect(levels(checkSymbol(noTag, meta, opts), 'error').some((t) => /TAG1/.test(t))).toBe(true);
    const item = saveChecklist(noTag, meta, opts).find((i) => i.key === 'tag')!;
    expect(item).toMatchObject({ ok: false, level: 'error', label: 'TAG1 attribute (parent symbol)' });
    const term = saveChecklist(noTag, defaultMeta({ ...meta, kind: 'terminal' }), opts).find((i) => i.key === 'tag')!;
    expect(term.label).toMatch(/TERM01/);
  });
  it('warns about an unknown family', () => {
    const { state, meta } = relay({ family: 'QQX' });
    expect(levels(checkSymbol(state, meta, opts), 'warning').some((t) => /Family QQX is not used by any library symbol/.test(t))).toBe(true);
    const items = saveChecklist(state, meta, opts);
    expect(items.find((i) => i.key === 'family')).toMatchObject({ ok: false, level: 'warning', detail: 'QQX' });
    expect(checklistWarnings(items).map((i) => i.key)).toEqual(['family']);
    // without the lookup (older callers) no family warning is raised
    expect(levels(checkSymbol(state, meta, { ...opts, knownFamily: undefined }), 'warning').some((t) => /Family QQX/.test(t))).toBe(false);
  });
  it('warns about inconsistent attribute flags', () => {
    const { state, meta } = relay({ attrProps: { MFG: { constant: true }, TAG1: { invisible: true } } });
    const w = levels(checkSymbol(state, meta, opts), 'warning');
    expect(w.some((t) => /MFG is constant but has no default/.test(t))).toBe(true);
    expect(w.some((t) => /TAG1 is invisible/.test(t))).toBe(true);
    const item = saveChecklist(state, meta, opts).find((i) => i.key === 'attributes')!;
    expect(item.ok).toBe(false);
    expect(item.detail).toBe('TAG1, MFG');
  });
  it('ticks every item of a good symbol', () => {
    const { state, meta } = relay();
    const items = saveChecklist(state, meta, opts);
    expect(items.map((i) => i.key)).toEqual(['name', 'pins', 'overlap', 'tag', 'family', 'desc', 'attributes']);
    expect(items.every((i) => i.ok)).toBe(true);
    expect(checklistWarnings(items)).toEqual([]);
    const bad = saveChecklist(state, defaultMeta({ ...meta, name: 'HPB11_NO' }), opts);
    expect(bad.find((i) => i.key === 'name')!.ok).toBe(false);
  });
});
