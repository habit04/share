import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readDxf, writeDxf } from '../src/io/dxf';
import { Drawing } from '../src/core/document';
import { CopyTool } from '../src/tools/modify';
import { drive, fakeContext } from './fake-context';
import type { CadNode } from '../src/core/cad-graph';
const sourceText = readFileSync(new URL('./fixtures/interchange/r2018-field-object-reference.dxf', import.meta.url), 'utf8');
const group = (node: CadNode, code: number) => node.groups.find(([c]) => c === code)?.[1].trim();
describe('independent native object-property FIELD references', () => {
  it('retains the normalized expression and both reference-vector and cached-value edges', () => {
    const state = readDxf(sourceText);
    const field = state.cadGraph!.nodes.find(node => node.type === 'FIELD' && group(node, 1) === 'AcObjProp')!;
    expect(group(field, 2)).toContain('Object(%<\\_ObjIdx 0>%).Length');
    const refs = field.references!.filter(ref => ref.target && state.cadGraph!.nodes.some(node => node.id === ref.target && node.type === 'LINE'));
    expect(refs.map(ref => field.groups[ref.groupIndex]![0])).toEqual([331, 330]);
    expect(refs[0]!.target).toBe(refs[1]!.target);
    const text = state.entities.find(entity => entity.type === 'mtext' && entity.field?.code.includes('AcObjProp'))!;
    expect(text).toMatchObject({ field: { native: true } });
    expect(text.type === 'mtext' && text.text).not.toContain('####');
  });
  it('copies the connected selection and remaps both field edges to the copied line on save/reopen', () => {
    const state = readDxf(sourceText), doc = new Drawing(state);
    const fields = state.cadGraph!.nodes.filter(node => node.type === 'FIELD');
    const line = doc.entities.find(entity => state.cadGraph!.nodes.some(node => node.id === entity.cadIdentity && node.sourceHandle === '18D'))!;
    const peer = doc.entities.find(entity => state.cadGraph!.nodes.some(node => node.id === entity.cadIdentity && node.sourceHandle === '18E'))!;
    const text = doc.entities.find(entity => entity.type === 'mtext' && entity.field?.code.includes('AcObjProp'))!;
    const ctx = fakeContext(doc); ctx.selection = new Set([line.id, peer.id, text.id]);
    drive(new CopyTool(), ctx, [{ x: 0, y: 0 }, { x: 30, y: 40 }, '']);
    expect(doc.snapshot.cadGraph!.nodes.filter(node => node.type === 'FIELD')).toHaveLength(fields.length + 2);
    const copied = doc.entities[doc.entities.length - 3]!;
    const native = doc.snapshot.cadGraph!.nodes.find(node => node.type === 'FIELD' && !node.sourceHandle && group(node, 1) === 'AcObjProp')!;
    expect(native.references!.filter(ref => [330, 331].includes(native.groups[ref.groupIndex]![0]) && ref.target === copied.cadIdentity)).toHaveLength(2);
    const back = readDxf(writeDxf(doc.snapshot)), instances = back.cadGraph!.nodes.filter(node => node.type === 'FIELD' && group(node, 1) === 'AcObjProp');
    expect(instances).toHaveLength(2);
    const targets = instances.map(field => field.references!.find(ref => field.groups[ref.groupIndex]![0] === 331)!.target);
    expect(new Set(targets).size).toBe(2);
    for (const field of instances) {
      const pointer = field.references!.find(ref => field.groups[ref.groupIndex]![0] === 331)!;
      expect(field.references!.filter(ref => field.groups[ref.groupIndex]![0] === 330 && ref.target === pointer.target)).toHaveLength(1);
    }
  });
});
