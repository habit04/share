import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDxf, writeDxf } from '../../src/io/dxf';
import type { DrawingState } from '../../src/core/document';
import type { DimensionEntity, InsertEntity } from '../../src/core/entities';
import { leaderParts } from '../../src/core/entities';
import { aciToCss } from '../../src/render/palette';

const sources = [
  'tests/fixtures/interchange/r2000-dimensions.dxf',
  'tests/fixtures/interchange/r2000-hatch-curves.dxf',
  'fixtures/example_2000.dxf',
  'tests/fixtures/interchange/r2000-layouts-titleblock.dxf',
  'tests/fixtures/interchange/r2018-mtext.dxf',
  'tests/fixtures/interchange/r2018-table.dxf',
  'tests/fixtures/interchange/r2018-dimensions.dxf',
  'tests/fixtures/interchange/r2000-text-justification.dxf',
  'tests/fixtures/interchange/r2018-mtext-background.dxf',
  'tests/fixtures/interchange/r2018-minsert.dxf',
  'tests/fixtures/polyline-widths.dxf',
  'tests/fixtures/interchange/r2010-appearance.dxf',
];
function summary(state: DrawingState) {
  const counts = (entities: DrawingState['entities']) => entities.reduce<Record<string, number>>((out, entity) => {
    out[entity.type] = (out[entity.type] ?? 0) + 1; return out;
  }, {});
  const backgrounds = state.entities.flatMap((entity) => {
    const e = entity.type === 'leader' ? leaderParts(entity).find((p) => p.type === 'mtext') : entity;
    if (e?.type !== 'mtext' || !e.background || !(e.background.flags & 19)) return [];
    const bg = e.background;
    if (!(bg.flags & 3)) return [{ text: e.text, flags: bg.flags }]; // frame-only inert fields are normalized by AutoCAD
    if (bg.flags & 2) return [{ text: e.text, flags: bg.flags, scale: bg.scale }]; // window mask ignores its fallback color
    const layer = state.layers.find((l) => l.name === (bg.colorLayer ?? e.layer));
    const rgb = bg.trueColor ?? (bg.color === 'ByLayer' ? layer?.trueColor : undefined);
    const effectiveColor = rgb !== undefined ? `#${rgb.toString(16).padStart(6, '0')}` : aciToCss(bg.color === 'ByLayer' ? layer?.color ?? 7 : bg.color || 7);
    return [{ text: e.text, flags: bg.flags, scale: bg.scale, effectiveColor }];
  });
  return { model: counts(state.entities), paper: (state.layouts ?? []).filter((layout) => layout.entities.length).map((layout) => ({ name: layout.name, entities: counts(layout.entities) })), ...(state.blocks.NESTED_DIM ? { nested: counts(state.blocks.NESTED_DIM.entities) } : {}), ...(backgrounds.length ? { backgrounds } : {}) };
}

function nestedDimensionCase(repo: string): DrawingState {
  const state = readDxf(readFileSync(join(repo, sources[0]!), 'utf8'));
  const original = state.entities.find((entity): entity is DimensionEntity => entity.type === 'dimension');
  if (!original) throw new Error('The committed dimension fixture must contain a dimension.');
  const dimension: DimensionEntity = { ...original, id: 'nested-dimension', style: { ...original.style, tolerance: 'symmetrical', tolPlus: 0.1, tolDecimals: 2 } };
  return { ...state, layouts: [], entities: [{ type: 'insert', id: 'nested-insert', layer: '0', color: 'ByLayer', position: { x: 10, y: 12 }, block: 'NESTED_DIM', scale: 2, rotation: 0, attributes: {} }], blocks: { NESTED_DIM: { name: 'NESTED_DIM', basePoint: { x: 0, y: 0 }, entities: [dimension], attributes: [] } } };
}

function arrayAttributeCase(repo: string): DrawingState {
  const state = readDxf(readFileSync(join(repo, 'tests/fixtures/interchange/r2000-text-justification.dxf'), 'utf8'));
  const original = state.entities.find((entity): entity is InsertEntity => entity.type === 'insert' && entity.attributes.TAG1 === 'OVERRIDE');
  if (!original?.attributePlacements?.TAG1 || !state.blocks[original.block]) throw new Error('The independent TEXT fixture must have its native TAG1 placement.');
  const insert: InsertEntity = {
    ...original, id: 'native-array-attributes', rotation: Math.PI / 2, scale: 2, scaleY: 3,
    columns: 3, rows: 2, columnSpacing: 7, rowSpacing: 11,
    color: 2, trueColor: 0x2468ac, transparency: 96,
    attributePlacements: { ...original.attributePlacements, TAG1: { ...original.attributePlacements.TAG1, color: 5, trueColor: 0x123456, transparency: 127 } },
  };
  return { ...state, entities: [insert], layouts: [], blocks: { [original.block]: state.blocks[original.block]! } };
}

const [mode, repo, output] = process.argv.slice(2);
if (!repo || !output) throw new Error('Missing AutoCAD export helper arguments.');
if (mode === 'export') {
  const cases = [...sources, 'generated:nested-dimension-overrides', 'generated:minsert-attribute-overrides'].map((source, index) => {
    const state = source === 'generated:nested-dimension-overrides' ? nestedDimensionCase(repo)
      : source === 'generated:minsert-attribute-overrides' ? arrayAttributeCase(repo) : readDxf(readFileSync(join(repo, source), 'utf8'));
    const file = join(output, `jcad-${index}.dxf`);
    writeFileSync(file, writeDxf(state));
    return { source, file, expected: summary(state) };
  });
  writeFileSync(join(output, 'cases.json'), JSON.stringify(cases, null, 2));
} else if (mode === 'check') {
  const cases = JSON.parse(readFileSync(join(output, 'cases.json'), 'utf8')) as Array<{ expected: ReturnType<typeof summary> }>;
  const results = cases.map((test, index) => {
    const actual = summary(readDxf(readFileSync(join(output, `autocad-${index}.dxf`), 'utf8')));
    const equal = (a: unknown, b: unknown) => JSON.stringify(a, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([x], [y]) => x.localeCompare(y))) : value) === JSON.stringify(b, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([x], [y]) => x.localeCompare(y))) : value);
    return { index, expected: test.expected, actual, matched: equal(test.expected, actual) };
  });
  writeFileSync(join(output, 'roundtrip.json'), JSON.stringify(results, null, 2));
  for (const result of results) if (!result.matched) throw new Error(`AutoCAD changed entity types/counts in case ${result.index}: ${JSON.stringify(result)}`);
} else throw new Error('Unknown AutoCAD export helper mode.');
