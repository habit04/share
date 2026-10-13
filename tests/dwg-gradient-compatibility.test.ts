import { afterEach, describe, expect, it, vi } from 'vitest';
import { Drawing } from '../src/core/document';
import type { HatchEntity } from '../src/core/entities';
import { defaultLayout } from '../src/core/layouts';
import { Editor, type FileBridge } from '../src/app/editor';
import { dwgCompatibilityProblem } from '../src/app/dwg-compatibility';
import { exportDwgCopy } from '../src/app/export-dwg';
import { readDxf } from '../src/io/dxf';

const editors: Editor[] = [];
const gradient = (kind = 1): HatchEntity => ({ id: 'h', type: 'hatch', layer: '0', color: 1, solid: true, pattern: 'SOLID', angle: 0, scale: 1,
  loops: [{ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }],
  gradient: { name: 'LINEAR', angle: 0, shift: 0, singleColor: false, tint: 0.5, kind, colors: [{ position: 0, color: 0 }, { position: 1, trueColor: 0xffffff }] } });
function setup(kind: number) {
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  const ed = new Editor({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }) } as unknown as HTMLCanvasElement);
  editors.push(ed); ed.viewport.requestRender = () => {};
  const source = 'C:\\private-gradient-tests\\source.dwg', output = 'C:\\private-gradient-tests\\output.dwg', dxf = output.replace(/\.dwg$/, '.dxf');
  ed.doc.load({ ...ed.doc.snapshot, entities: [gradient(kind)] }, source);
  ed.doc.addEntities([{ id: 'edit', type: 'line', layer: '0', color: 1, a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }]);
  const disk = new Map([[source, 'SOURCE'], [output, 'DESTINATION']]);
  const bridge: FileBridge = { platform: 'win32', openDxf: async () => null,
    chooseDrawingPath: vi.fn(async (_name, format) => format === 'dxf' ? dxf : output), chooseDwgPath: vi.fn(async () => output),
    dwgExportStatus: vi.fn(async () => ({ available: true })), saveDwg: vi.fn(async (path, text) => { disk.set(path, text); return path; }),
    exportDwg: vi.fn(async (path, text) => { disk.set(path, text); return path; }),
    saveDxf: vi.fn(async (_path, text) => { disk.set(dxf, text); return dxf; }) };
  ed.fileBridge = bridge;
  const saved = vi.fn(); ed.hooks.drawingSaved = saved;
  return { ed, source, output, dxf, disk, bridge, saved };
}
afterEach(() => { editors.splice(0).forEach((ed) => ed.viewport.dispose()); vi.unstubAllGlobals(); });

describe('retained gradient DWG saving safeguard', () => {
  it.each([0, 1, 3])('refuses Save, Save As and Export Copy without committing state or calling the native writer (kind=%s)', async (kind) => {
    for (const operation of ['save', 'saveas', 'export']) {
      const f = setup(kind), state = f.ed.doc.snapshot, history = f.ed.doc.history(), before = [...f.disk];
      expect(operation === 'export' ? await exportDwgCopy(f.ed) : await f.ed.saveFile(operation === 'saveas')).toBe(false);
      expect(f.ed.doc.snapshot).toBe(state); expect(f.ed.doc.history()).toEqual(history);
      expect(f.ed.doc.dirty).toBe(true); expect(f.ed.doc.filePath).toBe(f.source); expect([...f.disk]).toEqual(before);
      expect(f.bridge.saveDwg).not.toHaveBeenCalled(); expect(f.bridge.exportDwg).not.toHaveBeenCalled();
      expect(f.bridge.dwgExportStatus).not.toHaveBeenCalled(); expect(f.saved).not.toHaveBeenCalled();
      expect(f.ed.history.join('\n')).toMatch(/retained hatch gradient settings.*choose DXF/s);
    }
  });
  it.each([0, 1])('explicit DXF Save As retains metadata and completes normal save bookkeeping (kind=%s)', async (kind) => {
    const f = setup(kind), original = (f.ed.doc.entities[0] as HatchEntity).gradient;
    expect(await f.ed.saveFile(true, 'dxf')).toBe(true);
    expect(f.ed.doc.filePath).toBe(f.dxf); expect(f.ed.doc.dirty).toBe(false); expect(f.saved).toHaveBeenCalledOnce();
    const back = (readDxf(f.disk.get(f.dxf)!).entities[0] as HatchEntity).gradient!;
    expect({ ...back, kind: back.kind ?? 1 }).toEqual({ ...original, kind });
    expect(f.disk.get(f.source)).toBe('SOURCE'); expect(f.disk.get(f.output)).toBe('DESTINATION');
  });
  it('checks unused block definitions and inactive paper layouts as retained data', () => {
    const base = new Drawing().snapshot;
    expect(dwgCompatibilityProblem({ ...base, blocks: { G: { name: 'G', basePoint: { x: 0, y: 0 }, attributes: [], entities: [gradient(0)] } } })).toMatch(/gradient settings/);
    expect(dwgCompatibilityProblem({ ...base, layouts: [{ ...defaultLayout('Inactive'), entities: [gradient()] }] })).toMatch(/gradient settings/);
    expect(dwgCompatibilityProblem(base)).toBeNull();
  });
});
