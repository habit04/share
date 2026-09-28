import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/document';
import { constrainDirection, defaultSnapSettings } from '../src/core/snap';
import { RIBBON } from '../src/ui/ribbon';
import type { Entity } from '../src/core/entities';

// Behaviour behind controls that used to be decorative (see the UI audit): the Home > Properties
// colour combo, DSETTINGS additional polar angles, and ribbon labels that must match their command.

const line = (id: string, color: Entity['color'] = 'ByLayer'): Entity => ({ id, layer: '0', color, type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } });

describe('current colour (CECOLOR)', () => {
  it('applies to new ByLayer objects only, and not to copies added without defaults', () => {
    const d = new Drawing();
    d.currentColor = 1;
    d.addEntities([line('a'), line('b', 3)]);
    d.addEntities([line('c')], false);
    expect(d.entities.map((e) => e.color)).toEqual([1, 3, 'ByLayer']);
  });
  it('leaves new objects ByLayer by default', () => {
    const d = new Drawing();
    d.addEntities([line('a')]);
    expect(d.entities[0]!.color).toBe('ByLayer');
  });
});

describe('polar additional angles', () => {
  const s = { ...defaultSnapSettings(), polar: true, polarIncrement: 90, polarAdditional: [30] };
  it('tracks an additional angle and its opposite direction', () => {
    const p = constrainDirection({ x: 0, y: 0 }, { x: Math.cos(0.54), y: Math.sin(0.54) }, s);
    expect(Math.atan2(p.y, p.x)).toBeCloseTo(Math.PI / 6, 9);
    const q = constrainDirection({ x: 0, y: 0 }, { x: -Math.cos(0.54), y: -Math.sin(0.54) }, s);
    expect(Math.atan2(q.y, q.x)).toBeCloseTo(-5 * Math.PI / 6, 9);
  });
  it('still prefers the increment when it is closer', () => {
    const p = constrainDirection({ x: 0, y: 0 }, { x: 5, y: 0.2 }, s);
    expect(p.y).toBeCloseTo(0, 9);
  });
});

describe('ribbon', () => {
  it('has no button that only started TEXT under a conversion label', () => {
    const conv = RIBBON.find((t) => t.name === 'Conversion Tools')!;
    expect(conv.panels.flatMap((p) => p.buttons).some((b) => b.command === 'TEXT')).toBe(false);
  });
  it('labels every AEREPORT button with the report it opens', () => {
    const panel = RIBBON.find((t) => t.name === 'Panel')!;
    const byLabel = new Map(panel.panels.flatMap((p) => p.buttons).map((b) => [b.label.replace('\n', ' '), b.command]));
    expect(byLabel.get('Terminal Report')).toBe('AEREPORT terminals');
    expect(byLabel.get('Strip Report')).toBe('AEREPORT strip');
  });
});
