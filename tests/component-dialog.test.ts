import { describe, it, expect, afterEach } from 'vitest';
import { Drawing } from '../src/core/document';
import type { BlockDef, InsertEntity, LineEntity } from '../src/core/entities';
import { userLibrary } from '../src/electrical/userlib';
import type { AttributeDefExt } from '../src/electrical/symbol-builder-core';
import type { ComponentDialogInit, ComponentDialogResult, ElectricalUi } from '../src/electrical/ui';
import { isFixedTag } from '../src/electrical/tags';
import { componentDialogInit, otherAttributePrompts, ComponentTool } from '../src/tools/electrical';
import { EditComponentTool } from '../src/tools/electrical-wires';
import { readDxf, writeDxf } from '../src/io/dxf';
import { LIBRARY_BLOCKS } from '../src/electrical/library';
import { fakeContext } from './fake-context';

// Insert / Edit Component dialog data: the "Other attributes" of user-library symbols
// (insertionPrompts, block order, verify flag) and the Fixed tag checkbox (TAGFIXED).

const tick = () => new Promise((r) => setTimeout(r, 0));
const at = (tag: string, extra: Partial<AttributeDefExt> = {}): AttributeDefExt => ({ tag, prompt: '', default: '', position: { x: 0, y: 0 }, height: 0.1, align: 'left', ...extra });
const userSymbol = (): BlockDef => ({
  name: 'CDT_VALVE',
  description: 'Test valve',
  basePoint: { x: 0, y: 0 },
  entities: [{ id: 'cdt-l', layer: '0', color: 'ByLayer', type: 'line', a: { x: -0.375, y: 0 }, b: { x: 0.375, y: 0 } } as LineEntity],
  attributes: [
    at('TAG1'),
    at('VOLTAGE', { prompt: 'Coil voltage', default: '24VDC' }),
    at('DESC1'),
    at('SERIAL', { prompt: 'Serial number', verify: true }),
    at('X1TERM01', { default: '1', invisible: true }),
    at('KIND', { default: 'VALVE', constant: true }),
    at('SIZE', { default: 'DN15', preset: true }),
    at('INST', { invisible: true }),
    at('NOTE', { invisible: true, placeholder: true }),
    at('MFG'),
  ],
});

afterEach(async () => {
  for (const n of userLibrary.names()) userLibrary.remove(n);
  await userLibrary.flush();
});

describe('Insert Component: other attributes of user-library symbols', () => {
  it('lists the prompts the standard fields do not cover, in block order, with the verify flag', () => {
    const prompts = otherAttributePrompts(userSymbol());
    expect(prompts.map((p) => [p.tag, p.prompt, p.default, p.verify])).toEqual([
      ['VOLTAGE', 'Coil voltage', '24VDC', false],
      ['SERIAL', 'Serial number', '', true],
      ['NOTE', 'NOTE', '', false],
    ]);
  });

  it('offers them for user-library symbols only', () => {
    userLibrary.put({ block: userSymbol(), standard: 'JIC', category: 'Mine', family: 'SV' });
    const d = new Drawing();
    const init = componentDialogInit(d, 'CDT_VALVE', { x: 1, y: 1 });
    expect(init.prompts?.map((p) => p.tag)).toEqual(['VOLTAGE', 'SERIAL', 'NOTE']);
    expect(init.attrs.VOLTAGE).toBe('24VDC');
    expect(init.fixedTag).toBeUndefined(); // insert: no Fixed tag checkbox
    expect(componentDialogInit(d, 'HPB11_NO', { x: 1, y: 1 }).prompts).toBeUndefined();
  });

  it('stores the values typed for them on the inserted component', async () => {
    userLibrary.put({ block: userSymbol(), standard: 'JIC', category: 'Mine', family: 'SV' });
    const d = new Drawing();
    const ctx = fakeContext(d);
    let seen: ComponentDialogInit | null = null;
    const ui = {
      editComponent: async (init: ComponentDialogInit): Promise<ComponentDialogResult> => {
        seen = init;
        return { attrs: { ...init.attrs, TAG1: 'SV1', VOLTAGE: '48VAC', SERIAL: 'sn-0042', NOTE: 'Spare' } };
      },
    } as unknown as ElectricalUi;
    const tool = new ComponentTool('CDT_VALVE', () => ui);
    tool.start(ctx);
    await tick();
    tool.onPoint({ x: 3, y: 3 }, ctx);
    await tick();
    expect(seen!.prompts?.length).toBe(3);
    const ins = d.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === 'CDT_VALVE')!;
    expect(ins.attributes).toMatchObject({ TAG1: 'SV1', VOLTAGE: '48VAC', SERIAL: 'sn-0042', NOTE: 'Spare' });
    // ...and they survive a DXF round trip (the block defines them).
    const back = readDxf(writeDxf(d.snapshot)).entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === 'CDT_VALVE')!;
    expect(back.attributes).toMatchObject({ VOLTAGE: '48VAC', SERIAL: 'sn-0042', NOTE: 'Spare' });
  });
});

describe('Edit Component: Fixed tag', () => {
  const place = () => {
    const d = new Drawing();
    const ins: InsertEntity = { id: 'pb', layer: 'SYMS', color: 'ByLayer', type: 'insert', block: 'HPB11_NO', position: { x: 2, y: 2 }, rotation: 0, scale: 1, attributes: { TAG1: 'PB7', DESC1: 'START' } };
    d.ensureBlocks(LIBRARY_BLOCKS);
    d.addEntities([ins]);
    return { d, ctx: fakeContext(d) };
  };
  const edit = async (ctx: ReturnType<typeof fakeContext>, answer: (init: ComponentDialogInit) => ComponentDialogResult) => {
    let seen: ComponentDialogInit | null = null;
    const ui = { editComponent: async (init: ComponentDialogInit) => ((seen = init), answer(init)) } as unknown as ElectricalUi;
    new EditComponentTool(() => ui).start(ctx);
    await tick();
    await tick();
    return seen! as ComponentDialogInit;
  };

  it('shows the current TAGFIXED state and sets / clears it like AEFIXTAG', async () => {
    const { d, ctx } = place();
    ctx.selection.add('pb');
    const first = await edit(ctx, (init) => ({ attrs: init.attrs, fixedTag: true }));
    expect(first.fixedTag).toBe(false);
    let now = d.entity('pb') as InsertEntity;
    expect(isFixedTag(now)).toBe(true);
    expect(now.attributes.TAG1).toBe('PB7');
    // The block now defines TAGFIXED, so the flag is written to DXF and read back.
    expect(d.lookupBlock('HPB11_NO')!.attributes.some((a) => a.tag === 'TAGFIXED')).toBe(true);
    const back = readDxf(writeDxf(d.snapshot)).entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === 'HPB11_NO')!;
    expect(isFixedTag(back)).toBe(true);
    // One undo step undoes the edit and the flag together.
    d.undo();
    expect(isFixedTag(d.entity('pb') as InsertEntity)).toBe(false);
    d.redo();
    const second = await edit(ctx, (init) => ({ attrs: init.attrs, fixedTag: false }));
    expect(second.fixedTag).toBe(true);
    now = d.entity('pb') as InsertEntity;
    expect(isFixedTag(now)).toBe(false);
    expect(now.attributes.TAGFIXED).toBeUndefined();
    expect(ctx.logs.some((l) => /tag released/.test(l))).toBe(true);
  });

  it('has no Fixed tag checkbox for child contacts', () => {
    const d = new Drawing();
    const child: InsertEntity = { id: 'c', layer: 'SYMS', color: 'ByLayer', type: 'insert', block: 'HCR1_NO', position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: { TAG1: 'CR1' } };
    d.addEntities([child]);
    expect(componentDialogInit(d, 'HCR1_NO', child.position, child).fixedTag).toBeUndefined();
  });
});
