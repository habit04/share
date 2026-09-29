import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { icons } from '../src/ui/icons';
import '../src/ui/icons-ui';
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

describe('ribbon commands', () => {
  // Every ribbon button runs a registered command (by name or alias). The registrations are
  // read from the sources so the check needs no DOM-backed Editor.
  const registered = (() => {
    const names = new Set<string>();
    const files = ['src/main.ts', ...['src/app', 'src/tools'].flatMap((dir) => readdirSync(dir).filter((n) => n.endsWith('.ts')).map((n) => join(dir, n)))];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\breg\(\s*'([^']+)'\s*,\s*\[([^\]]*)\]/g)) {
        names.add(m[1]!.toUpperCase());
        for (const a of m[2]!.matchAll(/'([^']+)'/g)) names.add(a[1]!.toUpperCase());
      }
      for (const m of src.matchAll(/\bname:\s*'([A-Z0-9_\-+]+)'(?:\s*,\s*aliases:\s*\[([^\]]*)\])?/g)) {
        names.add(m[1]!.toUpperCase());
        for (const a of (m[2] ?? '').matchAll(/'([^']+)'/g)) names.add(a[1]!.toUpperCase());
      }
    }
    return names;
  })();
  const buttons = RIBBON.flatMap((t) => t.panels.flatMap((p) => p.buttons.map((b) => ({ tab: t.name, ...b }))));

  it('only has buttons whose command is registered', () => {
    const missing = buttons.filter((b) => !registered.has(b.command.split(/\s+/)[0]!.toUpperCase())).map((b) => `${b.tab}: ${b.command}`);
    expect(missing).toEqual([]);
  });
  it('only uses icons that exist', () => {
    expect(buttons.filter((b) => !(b.icon in icons)).map((b) => `${b.tab}: ${b.icon}`)).toEqual([]);
  });
  it('reaches the project-wide, cable / jumper / PLC I/O and panel layout commands', () => {
    const on = (tab: string) => new Set(buttons.filter((b) => b.tab === tab).map((b) => b.command));
    for (const c of ['AELOCVIEW', 'AEXREFPROJECT', 'AERETAGPROJECT', 'AEWIRENOPROJECT', 'AEREPORTTEMPLATES', 'AETITLEBLOCKALL']) expect(on('Project').has(c), c).toBe(true);
    for (const c of ['AECABLE', 'AECABLESCHEDULE', 'AEJUMPER', 'AEJUMPERDEL', 'AEPLCIO', 'AEPLCIOEXPORT']) expect(on('Schematic').has(c), c).toBe(true);
    for (const c of ['AEDINRAIL', 'AEWIREDUCT', 'AEPANEL', 'AEPANELGRID', 'AEFOOTPRINTALIGN', 'AETERMFOOTPRINT', 'AEPANELHW']) expect(on('Panel').has(c), c).toBe(true);
    for (const c of ['SPLINE', 'HATCH', 'MLEADER', 'TABLE', 'FIELD']) expect(on('Annotate').has(c) || on('Home').has(c), c).toBe(true);
  });
  it('draws splines, hatches, multileaders, tables and panel hardware with their own icons', () => {
    const iconOf = (c: string) => buttons.find((b) => b.command === c)!.icon;
    expect(['SPLINE', 'HATCH', 'MLEADER', 'TABLE', 'AEDINRAIL', 'AEWIREDUCT', 'AEPANEL'].map(iconOf)).toEqual(['spline', 'hatch', 'mleader', 'table', 'dinrail', 'wireduct', 'enclosure']);
  });
});
