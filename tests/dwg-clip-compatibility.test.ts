import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor, type FileBridge } from '../src/app/editor';
import { Autosaver, type AutosaveStore } from '../src/app/autosave';
import { dwgCompatibilityProblem } from '../src/app/dwg-compatibility';
import { exportDwgCopy } from '../src/app/export-dwg';
import { defaultLayout, type LayoutViewport } from '../src/core/layouts';
import { readDxf, writeDxf } from '../src/io/dxf';

let sequence = 0;
const editors: Editor[] = [];
const boundary = { id: 'clip', type: 'polyline' as const, layer: '0', color: 'ByLayer' as const, closed: true,
  points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 }] };

function setup(clipOn: boolean, originalFormat: 'dxf' | 'dwg' = 'dwg') {
  sequence += 1;
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const ed = new Editor({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }) } as unknown as HTMLCanvasElement);
  editors.push(ed);
  ed.viewport.requestRender = () => {};
  const original = `C:\\drawings\\clip-working-${sequence}.${originalFormat}`;
  const output = `C:\\drawings\\clip-output-${sequence}.dwg`;
  const dxf = output.replace(/\.dwg$/, '.dxf');
  const vp: LayoutViewport = { id: 'vp', center: { x: 5, y: 5 }, width: 10, height: 10, layer: '0', on: false,
    clipBoundary: boundary, clipOn, view: { center: { x: 100, y: 200 }, scale: 0.5, twist: 0.43 } };
  // The protected boundary is deliberately in an inactive, off viewport; all retained data counts.
  ed.doc.load({ ...ed.doc.snapshot, layouts: [{ ...defaultLayout('Inactive'), viewports: [vp] }], space: undefined }, original);
  ed.doc.addEntities([{ id: 'edit', type: 'line', layer: '0', color: 'ByLayer', a: { x: 1, y: 2 }, b: { x: 3, y: 4 } }]);
  const disk = new Map([[original, 'ORIGINAL WORKING FILE'], [output, 'ORIGINAL DESTINATION']]);
  const bridge: FileBridge = {
    platform: 'win32',
    openDxf: async () => null,
    chooseDrawingPath: vi.fn(async (_suggest, format) => format === 'dxf' ? dxf : output),
    chooseDwgPath: vi.fn(async () => output),
    dwgExportStatus: vi.fn(async () => ({ available: true })),
    saveDwg: vi.fn(async (path, text) => { disk.set(path, text); return path; }),
    exportDwg: vi.fn(async (path, text) => { disk.set(path, text); return path; }),
    saveDxf: vi.fn(async (path, text) => { const target = path ?? dxf; disk.set(target, text); return target; }),
  };
  ed.fileBridge = bridge;
  const backups = new Map([['clip-recovery.sv.dxf', writeDxf(ed.doc.snapshot)]]);
  const store: AutosaveStore = {
    write: async (name, text) => { backups.set(name, text); },
    read: async (name) => backups.get(name) ?? null,
    list: async () => [...backups.keys()].map((name) => ({ name, originalPath: original, savedAt: 1, title: 'Clipped drawing' })),
    remove: vi.fn(async (name) => { backups.delete(name); }),
  };
  const autosaver = new Autosaver(ed.sessions, store, () => 0);
  autosaver.adopt(ed.sessions.activeId, 'clip-recovery.sv.dxf');
  const drawingSaved = vi.fn((id, state) => { void autosaver.markSaved(id, state); });
  ed.hooks.drawingSaved = drawingSaved;
  return { ed, bridge, original, output, dxf, disk, backups, autosaver, drawingSaved, store };
}

afterEach(() => {
  for (const ed of editors.splice(0)) ed.viewport.dispose();
  vi.unstubAllGlobals();
});

describe('retained viewport clip DWG compatibility safeguard', () => {
  it.each([true, false].flatMap(enabled => (['save', 'saveas', 'export'] as const).map(operation => ({ enabled, operation }))))(
    'refuses a reopened DXF clip with retained graph metadata before any destination write (enabled: $enabled, operation: $operation)',
    async ({ enabled, operation }) => {
      const f = setup(enabled);
      f.ed.doc.load(readDxf(writeDxf(f.ed.doc.snapshot)), f.original);
      f.ed.doc.addEntities([{ id: 'graph-edit', type: 'line', layer: '0', color: 'ByLayer', a: { x: 20, y: 0 }, b: { x: 21, y: 0 } }]);
      expect(f.ed.doc.snapshot.cadGraph!.nodes.some(node => node.anchor?.kind === 'viewport' && node.anchor.part === 'clip-boundary')).toBe(true);
      const state = f.ed.doc.snapshot, history = f.ed.doc.history(), disk = [...f.disk], recovery = [...f.backups];
      expect(operation === 'export' ? await exportDwgCopy(f.ed) : await f.ed.saveFile(operation === 'saveas')).toBe(false);
      expect(f.bridge.saveDwg).not.toHaveBeenCalled();
      expect(f.bridge.exportDwg).not.toHaveBeenCalled();
      expect(f.bridge.saveDxf).not.toHaveBeenCalled();
      expect([...f.disk]).toEqual(disk);
      expect(f.ed.doc.snapshot).toBe(state);
      expect(f.ed.doc.history()).toEqual(history);
      expect(f.ed.doc.filePath).toBe(f.original);
      expect(f.ed.doc.dirty).toBe(true);
      expect([...f.backups]).toEqual(recovery);
      expect(f.drawingSaved).not.toHaveBeenCalled();
  });

  it.each([true, false])('refuses working DWG Save, DWG Save As and Export Copy without changing retained data (clip enabled: %s)', async (enabled) => {
    for (const operation of ['save', 'saveas', 'export'] as const) {
      const f = setup(enabled);
      const state = f.ed.doc.snapshot;
      const history = f.ed.doc.history();
      const disk = [...f.disk];
      const recovery = [...f.backups];
      const result = operation === 'export' ? await exportDwgCopy(f.ed) : await f.ed.saveFile(operation === 'saveas');
      expect(result).toBe(false);
      expect(f.bridge.saveDwg).not.toHaveBeenCalled();
      expect(f.bridge.exportDwg).not.toHaveBeenCalled();
      expect(f.bridge.saveDxf).not.toHaveBeenCalled();
      expect(f.bridge.dwgExportStatus).not.toHaveBeenCalled();
      expect([...f.disk]).toEqual(disk);
      expect(f.ed.doc.snapshot).toBe(state);
      expect(f.ed.doc.filePath).toBe(f.original);
      expect(f.ed.doc.dirty).toBe(true);
      expect(f.ed.doc.history()).toEqual(history);
      expect([...f.backups]).toEqual(recovery);
      expect(f.autosaver.nameFor(f.ed.sessions.activeId)).toBe('clip-recovery.sv.dxf');
      expect(f.drawingSaved).not.toHaveBeenCalled();
      expect(f.store.remove).not.toHaveBeenCalled();
      expect(f.ed.history.join('\n')).toMatch(/viewport clipping boundaries.*choose DXF/s);
      if (operation === 'export') expect(f.bridge.chooseDwgPath).not.toHaveBeenCalled();
    }
  });

  it.each([true, false])('DWG Save As from a DXF cannot silently drop its retained clip (enabled: %s)', async (enabled) => {
    const f = setup(enabled, 'dxf');
    expect(await f.ed.saveFile(true)).toBe(false);
    expect(f.bridge.saveDwg).not.toHaveBeenCalled();
    expect(f.disk.get(f.output)).toBe('ORIGINAL DESTINATION');
    expect(f.ed.doc.filePath).toBe(f.original);
    expect(f.ed.doc.dirty).toBe(true);
    expect(f.backups.has('clip-recovery.sv.dxf')).toBe(true);
  });

  it.each([true, false])('explicit DXF Save As preserves enabled/disabled clips and completes normal saved/recovery bookkeeping (enabled: %s)', async (enabled) => {
    const f = setup(enabled);
    const history = f.ed.doc.history();
    expect(await f.ed.saveFile(true, 'dxf')).toBe(true);
    expect(f.bridge.saveDwg).not.toHaveBeenCalled();
    expect(f.bridge.exportDwg).not.toHaveBeenCalled();
    expect(f.bridge.dwgExportStatus).not.toHaveBeenCalled();
    expect(f.ed.doc.filePath).toBe(f.dxf);
    expect(f.ed.doc.dirty).toBe(false);
    expect(f.ed.doc.history()).toEqual(history);
    expect(f.disk.get(f.original)).toBe('ORIGINAL WORKING FILE');
    const reopened = readDxf(f.disk.get(f.dxf)!);
    expect(reopened.layouts![0]!.viewports[0]!.clipBoundary?.points).toEqual(boundary.points);
    expect(reopened.layouts![0]!.viewports[0]!.clipOn !== false).toBe(enabled);
    expect(reopened.entities).toHaveLength(1);
    await f.autosaver.idle();
    expect(f.drawingSaved).toHaveBeenCalledOnce();
    expect(f.backups.has('clip-recovery.sv.dxf')).toBe(false);
  });

  it('the save-error Save As choice selects a DXF fallback before any DWG writer call', async () => {
    const f = setup(false);
    f.ed.hooks.saveError = vi.fn(async () => 'saveas' as const);
    expect(await f.ed.saveFile(false)).toBe(true);
    expect(f.bridge.chooseDrawingPath).toHaveBeenCalledWith(expect.any(String), 'dxf');
    expect(f.bridge.saveDwg).not.toHaveBeenCalled();
    expect(f.bridge.saveDxf).toHaveBeenCalledOnce();
    expect(f.ed.doc.filePath).toBe(f.dxf);
    expect(f.disk.get(f.original)).toBe('ORIGINAL WORKING FILE');
  });

  it('checks the captured drawing even if its clip is removed while Save As chooses a destination', async () => {
    const f = setup(true);
    f.bridge.chooseDrawingPath = vi.fn(async () => {
      f.ed.doc.transactDrawing((state) => ({ ...state, layouts: state.layouts!.map((layout) => ({ ...layout, viewports: layout.viewports.map((viewport) => {
        const { clipBoundary: _boundary, ...unclipped } = viewport;
        return unclipped;
      }) })) }));
      return f.output;
    });
    expect(await f.ed.saveFile(true)).toBe(false);
    expect(dwgCompatibilityProblem(f.ed.doc.snapshot)).toBeNull();
    expect(f.bridge.saveDwg).not.toHaveBeenCalled();
    expect(f.bridge.dwgExportStatus).not.toHaveBeenCalled();
    expect(f.disk.get(f.output)).toBe('ORIGINAL DESTINATION');
    expect(f.ed.doc.filePath).toBe(f.original);
    expect(f.ed.doc.dirty).toBe(true);
    expect(f.backups.has('clip-recovery.sv.dxf')).toBe(true);
  });

  it('does not gate drawings that have no retained clipping boundary', () => {
    const f = setup(true);
    const viewport = f.ed.doc.snapshot.layouts![0]!.viewports[0]!;
    const { clipBoundary: _boundary, ...rectangular } = viewport;
    expect(dwgCompatibilityProblem({ layouts: [{ ...defaultLayout('Rectangle'), viewports: [rectangular] }] })).toBeNull();
    expect(dwgCompatibilityProblem({})).toBeNull();
  });
});
