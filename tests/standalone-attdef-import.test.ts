import { describe, expect, it } from 'vitest';
import { convertDwg, type DwgImportPayload } from '../src/io/dwg';
import { readDxf, writeDxf } from '../src/io/dxf';
import { validateCadState } from '../src/core/cad-graph';

// Authored source records: preset definitions with and without the invisible
// bit. These are standalone definitions, not an INSERT's attribute followers.
const definitions = [
  { handle: 'A1', tag: 'VISIBLE_A', flags: 8, value: '$TEXT$' },
  { handle: 'A2', tag: 'HIDDEN_A', flags: 9, value: 'HIDDEN_DEFAULT_A' },
  { handle: 'A3', tag: 'VISIBLE_B', flags: 8, value: '$TEXT$' },
  { handle: 'A4', tag: 'HIDDEN_B', flags: 9, value: 'HIDDEN_DEFAULT_B' },
];
const payload = (): DwgImportPayload => ({ header: { ATTMODE: 1 },
  layers: [{ name: '0', colorIndex: 7, off: false, frozen: false, locked: false, lineweight: 0 }], blocks: [],
  entities: [
    { type: 'LINE', handle: 'A0', layer: '0', startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 0 } },
    ...definitions.map((definition, index) => ({ type: 'ATTDEF', handle: definition.handle, layer: '0', tag: definition.tag, flags: definition.flags,
      // The captured customer DTO similarly lacks text.text (the default).
      text: { startPoint: { x: index, y: 1 }, endPoint: { x: 0, y: 0 }, textHeight: 1, rotation: 0, halign: 0, valign: 0, styleName: 'Standard' } })),
  ],
} as unknown as DwgImportPayload);
const nativeDxf = () => [
  0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1018', 9, '$ATTMODE', 70, 1, 0, 'ENDSEC',
  0, 'SECTION', 2, 'ENTITIES', 0, 'LINE', 5, 'A0', 100, 'AcDbEntity', 8, '0', 100, 'AcDbLine', 10, 0, 20, 0, 11, 1, 21, 0,
  ...definitions.flatMap((definition, index) => [
    0, 'ATTDEF', 5, definition.handle, 100, 'AcDbEntity', 8, '0', 100, 'AcDbText',
    10, index, 20, 1, 40, 1, 1, definition.value, 7, 'Standard', 72, 0,
    100, 'AcDbAttributeDefinition', 2, definition.tag, 3, 'Prompt', 70, definition.flags, 74, 0,
  ]),
  0, 'ENDSEC', 0, 'EOF', '',
].join('\n');

describe('honest standalone ATTDEF reporting during DWG import', () => {
  it('reports all visible and invisible fallback definitions as excluded without turning them into TEXT', () => {
    const { state, report } = convertDwg(payload(), '/private/standalone.dwg');
    expect(state.entities).toHaveLength(1); expect(state.entities[0]!.type).toBe('line');
    expect(report?.counts.ATTDEF).toEqual({ dropped: 4 });
    for (const definition of definitions) expect(report?.items.find(item => item.type === 'ATTDEF' && item.handle === definition.handle)).toMatchObject({
      action: 'dropped', layer: '0', where: 'model space', reason: expect.stringMatching(/standalone attribute-definition.*reader payload also omits its default value/),
    });
    expect(report?.counts.TEXT?.dropped ?? 0).toBe(0);
    expect(JSON.stringify(report?.items)).not.toContain('HIDDEN_DEFAULT');
  });

  it('reports definitions as kept when their exact checked source records survive and preserves their flags on copy/reopen', () => {
    const source = payload(), dxf = nativeDxf(), objects: Array<{ handle: string; type: string; dxfType: string; supertype: 'entity' }> = [];
    readDxf(dxf, { recordInventory: (handle, type) => objects.push({ handle, type, dxfType: type, supertype: 'entity' }) });
    source.nativeMetadata = { schemaVersion: 1, dxf, objects, readError: 0, writeError: 0, complete: true, notes: [] };
    const { state, report } = convertDwg(source, '/private/standalone.dwg');
    validateCadState(state);
    expect(state.cadGraph?.sourceFormat).toBe('DWG');
    expect(state.entities).toHaveLength(1); expect(state.entities[0]!.type).toBe('line');
    expect(report?.counts.ATTDEF).toEqual({ kept: 4 });
    expect(report?.items.filter(item => item.type === 'ATTDEF').every(item => item.reason.includes('not modeled or displayed'))).toBe(true);
    expect(report?.items.some(item => item.type === 'CAD_METADATA' && item.action === 'unsupported')).toBe(false);
    const reopened = readDxf(writeDxf(state), { recordInventory: () => {} });
    expect(reopened.entities).toHaveLength(1); // invisible/default values never become displayed text
    for (const definition of definitions) {
      const node = reopened.cadGraph!.nodes.find(node => node.type === 'ATTDEF' && node.sourceHandle === definition.handle)!;
      expect(node).toBeDefined();
      expect(node.groups).toContainEqual([2, definition.tag]);
      expect(node.groups).toContainEqual([1, definition.value]);
      expect(node.groups).toContainEqual([70, String(definition.flags)]);
    }
  });
});
