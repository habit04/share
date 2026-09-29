import type { BlockDef, Entity } from '../../src/core/entities';
import type { DrawingState } from '../../src/core/document';
import { DEFAULT_LAYERS } from '../../src/core/document';

/** A small symbol with a few lines, a circle and one attribute (like a contact). */
export const PERF_BLOCK: BlockDef = {
  name: 'PERF_SYM',
  basePoint: { x: 0, y: 0 },
  entities: [
    { id: 'b1', layer: '0', color: 'ByLayer', type: 'line', a: { x: -0.25, y: 0 }, b: { x: -0.05, y: 0 } },
    { id: 'b2', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0.05, y: 0 }, b: { x: 0.25, y: 0 } },
    { id: 'b3', layer: '0', color: 'ByLayer', type: 'line', a: { x: -0.05, y: -0.1 }, b: { x: -0.05, y: 0.1 } },
    { id: 'b4', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0.05, y: -0.1 }, b: { x: 0.05, y: 0.1 } },
    { id: 'b5', layer: '0', color: 'ByLayer', type: 'circle', center: { x: 0, y: 0.2 }, radius: 0.03 },
  ],
  attributes: [{ tag: 'TAG1', prompt: 'Tag', default: 'X', position: { x: 0, y: 0.25 }, height: 0.1, align: 'center' }],
};

/**
 * A deterministic "large schematic": `lines` wires on a grid, `inserts` symbol references and
 * `texts` labels spread over a 200 x 150 unit sheet.
 */
export function bigDrawing(lines = 5000, inserts = 1000, texts = 500): DrawingState {
  const entities: Entity[] = [];
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < lines; i += 1) {
    const x = rnd() * 200;
    const y = rnd() * 150;
    const horizontal = i % 2 === 0;
    const len = 0.5 + rnd() * 5;
    entities.push({ id: `L${i}`, layer: 'WIRES', color: 'ByLayer', type: 'line', a: { x, y }, b: horizontal ? { x: x + len, y } : { x, y: y + len } });
  }
  for (let i = 0; i < inserts; i += 1) {
    entities.push({
      id: `I${i}`,
      layer: 'SYMS',
      color: 'ByLayer',
      type: 'insert',
      block: PERF_BLOCK.name,
      position: { x: rnd() * 200, y: rnd() * 150 },
      rotation: i % 4 === 0 ? Math.PI / 2 : 0,
      scale: 1,
      attributes: { TAG1: `K${i}` },
    });
  }
  for (let i = 0; i < texts; i += 1) {
    entities.push({ id: `T${i}`, layer: 'DESC', color: 'ByLayer', type: 'text', position: { x: rnd() * 200, y: rnd() * 150 }, text: `LABEL ${i} MOTOR STARTER`, height: 0.125, rotation: 0, align: 'left' });
  }
  return { entities, layers: DEFAULT_LAYERS.map((l) => ({ ...l })), blocks: { [PERF_BLOCK.name]: PERF_BLOCK }, currentLayer: '0' };
}
