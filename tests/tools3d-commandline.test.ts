/**
 * The command line (src/ui/commandline.ts) at experimental 3D prompts, over a minimal fake DOM:
 * Space still submits (AutoCAD habit, as at 2D prompts) while typed points stay text for the 3D
 * parser, so "@dx,dy" keeps the height of the last 3D point.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Editor as EditorType } from '../src/app/editor';
import type { CommandLine as CommandLineType } from '../src/ui/commandline';
import { meshBounds } from '../src/model3d/mesh';
import { model3dOf } from '../src/model3d/model';
import { FakeElement, installFakeDocument } from './helpers/fake-dom';

const g = globalThis as Record<string, unknown>;
let Editor: typeof EditorType;
let CommandLine: typeof CommandLineType;
let installExperimental3d: typeof import('../src/app/experimental-3d').installExperimental3d;
let uninstall: () => void = () => {};
beforeAll(async () => {
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  uninstall = installFakeDocument();
  Editor = (await import('../src/app/editor')).Editor;
  ({ CommandLine } = await import('../src/ui/commandline'));
  ({ installExperimental3d } = await import('../src/app/experimental-3d'));
});
afterAll(async () => {
  uninstall();
  const { RIBBON } = await import('../src/ui/ribbon');
  const i = RIBBON.findIndex((t) => t.name === '3D');
  if (i >= 0) RIBBON.splice(i, 1);
});
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;

describe('command line at 3D prompts', () => {
  it('Space submits the typed text, and Space on an empty line is Enter (accepts the default)', () => {
    const ed = new Editor(canvas());
    ed.settings = { ...ed.settings, experimental3d: true };
    installExperimental3d(ed);
    const cmd = new CommandLine(ed, new FakeElement('div') as unknown as HTMLElement);
    const input = cmd.input as unknown as FakeElement;
    let prevented = 0;
    const key = (k: string, text = '') => {
      input.value = text;
      input.fire('keydown', { key: k, preventDefault: () => void prevented++ });
    };
    // "BOX<space>0,0<space>2,2<space>5<space>": every Space submits, like Enter.
    key(' ', 'BOX');
    key(' ', '0,0');
    key(' ', '2,2');
    key(' ', '5');
    expect(prevented).toBe(4);
    const solids = () => model3dOf(ed.doc.snapshot).solids;
    expect(solids()).toHaveLength(1);
    // Second box: Space on the empty line takes the default height <5>.
    key(' ', 'BOX');
    key(' ', '10,0,1');
    key(' ', '@2,2');
    expect(ed.prompt).toBe('Specify height or [2Point] <5.0000>:');
    key(' ');
    expect(ed.tool).toBeNull();
    // "@2,2" was measured from (10, 0, 1) in 3D: the base stays at z = 1.
    expect(meshBounds(solids()[1]!.mesh)).toEqual({ min: { x: 10, y: 0, z: 1 }, max: { x: 12, y: 2, z: 6 } });
    // Enter behaves the same.
    key('Enter', 'SPHERE');
    key('Enter', '0,0,20');
    key('Enter', '2');
    expect(solids()).toHaveLength(3);
  });

  it('clicking each 3DPLANE option in the prompt selects that plane', () => {
    const ed = new Editor(canvas());
    ed.settings = { ...ed.settings, experimental3d: true };
    installExperimental3d(ed);
    const container = new FakeElement('div');
    const cmd = new CommandLine(ed, container as unknown as HTMLElement);
    const input = cmd.input as unknown as FakeElement;
    const enter = (text = '') => {
      input.value = text;
      input.fire('keydown', { key: 'Enter' });
    };
    enter('BOX');
    enter('0,0');
    enter('2,2');
    enter('5');
    const promptEl = container.children[2]!.children[1]!;
    const options = () => promptEl.children.filter((c) => c.classes.has('prompt-option'));
    const click = (label: string) => {
      const opt = options().find((o) => o.textContent === label);
      if (!opt) throw new Error(`no option ${label} in "${ed.prompt}"`);
      opt.fire('click');
    };
    const expected: Array<[string, string]> = [['World', 'World'], ['Top', 'XY'], ['Front', 'XZ'], ['Right', 'YZ']];
    for (const [label, plane] of expected) {
      enter('3DPLANE');
      expect(options().map((o) => o.textContent)).toEqual(['World', 'Top', 'Front', 'Right', 'Solid face', 'Origin']);
      click(label);
      expect(ed.tool).toBeNull();
      expect(ed.history.at(-1)).toBe(`Construction plane: ${plane}.`);
    }
    enter('3DPLANE');
    click('Origin');
    expect(ed.prompt).toMatch(/^Specify new origin point </);
    enter('0,0,3');
    expect(ed.history).toContain('Construction plane: XY @ 0,0,3.');
    enter('3DPLANE');
    click('Solid face');
    expect(ed.prompt).toBe('Select a face of a solid:');
    enter('1,1');
    expect(ed.tool).toBeNull();
    expect(ed.history.at(-1)).toBe('Construction plane: Face @ 1,1,5.');
    // The typed spellings still work.
    for (const t of ['XZ', 'YZ', 'XY']) {
      enter(`3DPLANE ${t}`);
      expect(ed.history.at(-1)).toBe(`Construction plane: ${t}.`);
    }
  });
});
