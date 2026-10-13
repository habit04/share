import { afterEach, describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { attributeText, translateEntity, type TextEntity, type InsertEntity } from '../src/core/entities';
import { readDxf, writeDxf } from '../src/io/dxf';
import { textStylesOf } from '../src/io/encoding';
import { drawingContext, renderPdfPages, type PdfPageSpec } from '../src/io/pdf-vector';
import { drawStyledText, setTextStyles, type TextCanvas } from '../src/render/hershey';
import { parseContentStream } from './helpers/pdf';

type Groups = Array<string | number>;
const source = (overrides: Groups, definitionOverrides = overrides) => [
  0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1015', 0, 'ENDSEC',
  0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'STYLE', 70, 1,
  0, 'STYLE', 2, 'NARROW', 70, 0, 40, 0, 41, 0.5, 50, 0.2 * 180 / Math.PI, 71, 0, 3, 'arial.ttf', 4, '',
  0, 'ENDTAB', 0, 'ENDSEC',
  0, 'SECTION', 2, 'BLOCKS', 0, 'BLOCK', 2, 'LABEL', 70, 0, 10, 0, 20, 0,
  0, 'ATTDEF', 8, '0', 10, 0, 20, 0, 40, 1, 1, 'Default', 3, 'Tag', 2, 'TAG', 70, 0, 7, 'NARROW', ...definitionOverrides,
  0, 'ENDBLK', 0, 'ENDSEC',
  0, 'SECTION', 2, 'ENTITIES',
  0, 'TEXT', 8, '0', 10, 1, 20, 2, 40, 1, 1, 'Text', 7, 'NARROW', ...overrides,
  0, 'INSERT', 8, '0', 2, 'LABEL', 66, 1, 10, 5, 20, 6,
  0, 'ATTRIB', 8, '0', 10, 5, 20, 6, 40, 1, 1, 'Override', 2, 'TAG', 70, 0, 7, 'NARROW', ...overrides,
  0, 'SEQEND', 0, 'ENDSEC', 0, 'EOF',
].join('\n');

function records(dxf: string, kind: string) {
  const lines = dxf.trimEnd().split(/\r?\n/);
  const result: Array<Map<number, string>> = [];
  let record: Map<number, string> | undefined;
  for (let i = 0; i < lines.length; i += 2) {
    const code = Number(lines[i]), value = lines[i + 1]!;
    if (code === 0) { if (record) result.push(record); record = value === kind ? new Map() : undefined; }
    else record?.set(code, value);
  }
  if (record) result.push(record);
  return result;
}

const text = (state: ReturnType<typeof readDxf>) => state.entities.find((e): e is TextEntity => e.type === 'text')!;
const insert = (state: ReturnType<typeof readDxf>) => state.entities.find((e): e is InsertEntity => e.type === 'insert')!;

describe('native explicit TEXT/attribute default overrides', () => {
  afterEach(() => setTextStyles({}));

  it.each([
    { label: 'both defaults', groups: [41, 1, 51, 0], widthFactor: 1, oblique: 0 },
    { label: 'width only', groups: [41, 1], widthFactor: 1, oblique: undefined },
    { label: 'oblique only', groups: [51, 0], widthFactor: undefined, oblique: 0 },
    { label: 'neither supplied', groups: [], widthFactor: undefined, oblique: undefined },
  ])('preserves $label presence for TEXT, ATTDEF and ATTRIB across repeated save/reopen', ({ groups, widthFactor, oblique }) => {
    let state = readDxf(source(groups));
    for (let round = 0; round < 3; round++) {
      for (const placement of [text(state), state.blocks.LABEL!.attributes[0]!, insert(state).attributePlacements!.TAG!]) {
        expect(placement.widthFactor).toBe(widthFactor);
        expect(placement.oblique).toBe(oblique);
      }
      const output = writeDxf(state);
      for (const kind of ['TEXT', 'ATTDEF', 'ATTRIB']) {
        const native = records(output, kind)[0]!;
        expect(native.has(41)).toBe(widthFactor !== undefined);
        expect(native.has(51)).toBe(oblique !== undefined);
        if (widthFactor !== undefined) expect(Number(native.get(41))).toBe(1);
        if (oblique !== undefined) expect(Number(native.get(51))).toBe(0);
      }
      state = readDxf(output);
    }
  });

  it('retains explicit ATTRIB defaults independently of nondefault ATTDEF appearance', () => {
    const state = readDxf(source([41, 1, 51, 0], [41, 2, 51, 30]));
    const reopened = readDxf(writeDxf(state));
    expect(reopened.blocks.LABEL!.attributes[0]!).toMatchObject({ widthFactor: 2, oblique: Math.PI / 6 });
    expect(insert(reopened).attributePlacements!.TAG!).toMatchObject({ widthFactor: 1, oblique: 0 });
    const label = attributeText(insert(reopened), reopened.blocks.LABEL!, reopened.blocks.LABEL!.attributes[0]!);
    expect(label).toMatchObject({ widthFactor: 1, oblique: 0, text: 'Override' });
  });

  it('preserves newly explicit defaults after an edit, undo/redo, movement and saving', () => {
    const state = readDxf(source([]));
    const drawing = new Drawing(state);
    const original = text(state);
    drawing.replaceEntities([{ ...original, widthFactor: 1, oblique: 0 }]);
    expect(drawing.dirty).toBe(true);
    drawing.undo();
    expect((drawing.entity(original.id) as TextEntity).widthFactor).toBeUndefined();
    drawing.redo();
    drawing.replaceEntities([translateEntity(drawing.entity(original.id)!, { x: 3, y: 4 })]);
    const reopened = text(readDxf(writeDxf(drawing.snapshot)));
    expect(reopened).toMatchObject({ widthFactor: 1, oblique: 0, position: { x: 4, y: 6 } });
  });

  it('saves explicit defaults added while editing an attribute definition and inserted label', () => {
    const drawing = new Drawing(readDxf(source([])));
    drawing.transact((state) => ({
      ...state,
      blocks: { ...state.blocks, LABEL: { ...state.blocks.LABEL!, attributes: state.blocks.LABEL!.attributes.map((a) => ({ ...a, widthFactor: 1, oblique: 0 })) } },
      entities: state.entities.map((e) => e.type === 'insert' ? {
        ...e, attributes: { ...e.attributes, TAG: 'Edited' },
        attributePlacements: { ...e.attributePlacements, TAG: { ...e.attributePlacements!.TAG!, widthFactor: 1, oblique: 0 } },
      } : e),
    }));
    drawing.undo();
    expect(drawing.blocks.LABEL!.attributes[0]!.widthFactor).toBeUndefined();
    drawing.redo();
    const reopened = readDxf(writeDxf(drawing.snapshot));
    expect(reopened.blocks.LABEL!.attributes[0]!).toMatchObject({ widthFactor: 1, oblique: 0 });
    expect(insert(reopened).attributePlacements!.TAG!).toMatchObject({ widthFactor: 1, oblique: 0 });
    expect(insert(reopened).attributes.TAG).toBe('Edited');
  });

  it.each([true, false])('keeps Canvas/PDF style resolution and anchors after reopen (explicit=%s)', (explicit) => {
    const state = readDxf(writeDxf(readDxf(source(explicit ? [41, 1, 51, 0] : []))));
    const expectedWidth = explicit ? 1 : 0.5, expectedSlant = explicit ? 0 : Math.tan(0.2);
    const label = attributeText(insert(state), state.blocks.LABEL!, state.blocks.LABEL!.attributes[0]!);
    setTextStyles(textStylesOf(state));
    for (const entity of [text(state), label]) {
      const calls: Array<{ kind: string; values: number[] }> = [];
      const canvas: TextCanvas = {
        save() {}, restore() {}, rotate() {}, fillText() {}, measureText: () => ({ width: 100 }),
        translate: (...values) => calls.push({ kind: 'translate', values }),
        transform: (...values) => calls.push({ kind: 'transform', values }), scale: (...values) => calls.push({ kind: 'scale', values }),
        font: '', textAlign: 'left', textBaseline: 'alphabetic',
      };
      expect(drawStyledText(canvas, entity, { scale: 10, toScreen: (p) => p })).toBe(true);
      expect(calls.find((c) => c.kind === 'translate')!.values).toEqual([entity.position.x, entity.position.y]);
      expect(calls.find((c) => c.kind === 'scale')?.values[0] ?? 1).toBe(expectedWidth);
      expect(calls.find((c) => c.kind === 'transform')?.values[2] ?? 0).toBeCloseTo(-expectedSlant);
      const page: PdfPageSpec = { width: 100, height: 100, label: 'Text', groups: [{ entities: [entity], k: 1, e: 0, f: 0, hidden: new Set(), ltUnit: 1, annoFactor: 1 }] };
      const rendered = renderPdfPages([page], drawingContext(state, () => undefined), { mode: 'color', lineweights: true, usePlotStyles: true })[0]!;
      const tm = parseContentStream(rendered.content).ops.find((op) => op.op === 'Tm')!;
      expect(Number(tm.args[0])).toBeCloseTo(expectedWidth, 3);
      expect(Number(tm.args[2])).toBeCloseTo(expectedSlant, 3);
      expect(tm.args.slice(4).map(Number)).toEqual([entity.position.x, entity.position.y]);
    }
  });
});
