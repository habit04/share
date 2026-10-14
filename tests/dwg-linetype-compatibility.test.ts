import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor, type FileBridge } from '../src/app/editor';
import { dwgCompatibilityProblem } from '../src/app/dwg-compatibility';
import { exportDwgCopy } from '../src/app/export-dwg';
import { readDxf } from '../src/io/dxf';
import { Drawing } from '../src/core/document';

const fixture = readFileSync(new URL('./fixtures/interchange/r2018-truecolor-linetypes.dxf', import.meta.url), 'utf8');
const editors: Editor[] = [];
function setup(extension: 'dxf' | 'dwg') {
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  const ed = new Editor({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }) } as unknown as HTMLCanvasElement);
  editors.push(ed); ed.viewport.requestRender = () => {};
  const source = `C:\\private-linetype-tests\\source.${extension}`, destination = 'C:\\private-linetype-tests\\output.dwg', dxf = destination.replace(/\.dwg$/, '.dxf');
  const imported = readDxf(fixture);
  // Isolate this safeguard from the fixture's separately protected inactive hatch descriptor.
  ed.doc.load({ ...imported, entities: imported.entities.filter((entity) => entity.type !== 'hatch') }, source);
  ed.doc.addEntities([{ id: 'edit', type: 'line', layer: '0', color: 1, a: { x: 0, y: 0 }, b: { x: 10, y: 10 } }]);
  const disk = new Map([[source, 'SOURCE'], [destination, 'DESTINATION']]);
  const bridge: FileBridge = { platform: 'win32', openDxf: async () => null,
    chooseDrawingPath: vi.fn(async (_name, format) => format === 'dxf' ? dxf : destination), chooseDwgPath: vi.fn(async () => destination),
    dwgExportStatus: vi.fn(async () => ({ available: true })), saveDwg: vi.fn(async (path, text) => { disk.set(path, text); return path; }),
    exportDwg: vi.fn(async (path, text) => { disk.set(path, text); return path; }),
    saveDxf: vi.fn(async (_path, text) => { disk.set(dxf, text); return dxf; }) };
  ed.fileBridge = bridge;
  const saved = vi.fn(); ed.hooks.drawingSaved = saved;
  return { ed, source, destination, dxf, disk, bridge, saved };
}
afterEach(() => { editors.splice(0).forEach((ed) => ed.viewport.dispose()); vi.unstubAllGlobals(); });

describe('complex linetype DWG preservation safeguard', () => {
  it.each(['save', 'saveas', 'export'] as const)('refuses %s of a working DWG before native probing or writing', async (operation) => {
    const f = setup('dwg'), snapshot = f.ed.doc.snapshot, history = f.ed.doc.history(), before = [...f.disk];
    expect(operation === 'export' ? await exportDwgCopy(f.ed) : await f.ed.saveFile(operation === 'saveas')).toBe(false);
    expect(f.ed.doc.snapshot).toBe(snapshot); expect(f.ed.doc.history()).toEqual(history);
    expect(f.ed.doc.dirty).toBe(true); expect(f.ed.doc.filePath).toBe(f.source); expect([...f.disk]).toEqual(before);
    expect(f.bridge.saveDwg).not.toHaveBeenCalled(); expect(f.bridge.exportDwg).not.toHaveBeenCalled();
    expect(f.bridge.dwgExportStatus).not.toHaveBeenCalled();
    if (operation === 'saveas') expect(f.bridge.chooseDrawingPath).toHaveBeenCalledOnce();
    else expect(f.bridge.chooseDrawingPath).not.toHaveBeenCalled();
    expect(f.bridge.chooseDwgPath).not.toHaveBeenCalled(); expect(f.saved).not.toHaveBeenCalled();
    expect(f.ed.history.join('\n')).toMatch(/retained complex linetype.*choose DXF/s);
  });
  it('refuses DWG Save As from DXF without changing the source, selection or history', async () => {
    const f = setup('dxf'), snapshot = f.ed.doc.snapshot, history = f.ed.doc.history();
    f.ed.selection.add('edit');
    expect(await f.ed.saveFile(true)).toBe(false);
    expect(f.ed.doc.snapshot).toBe(snapshot); expect(f.ed.doc.history()).toEqual(history);
    expect(f.ed.selection.has('edit')).toBe(true); expect(f.ed.doc.dirty).toBe(true);
    expect(f.bridge.saveDwg).not.toHaveBeenCalled(); expect(f.disk.get(f.source)).toBe('SOURCE');
  });
  it('explicit DXF fallback retains the complete definitions through edit, undo, redo and fresh reopen', async () => {
    const f = setup('dwg'), original = f.ed.doc.snapshot.header!.linetypes;
    f.ed.doc.undo(); f.ed.doc.redo();
    expect(f.ed.doc.snapshot.header!.linetypes).toEqual(original);
    expect(await f.ed.saveFile(true, 'dxf')).toBe(true);
    expect(f.ed.doc.filePath).toBe(f.dxf); expect(f.ed.doc.dirty).toBe(false); expect(f.saved).toHaveBeenCalledOnce();
    const reopened = new Drawing(readDxf(f.disk.get(f.dxf)!));
    const gas = reopened.snapshot.header!.linetypes.find((lt) => lt.name === 'GAS_LINE')!;
    expect(gas.pattern).toEqual([12.7, -5.08, -6.35]);
    expect(f.disk.get(f.dxf)).toContain('ltypeshp.shx');
    expect(f.disk.get(f.dxf)).toContain('\r\n9\r\nGAS\r\n');
    expect(f.disk.get(f.source)).toBe('SOURCE'); expect(f.disk.get(f.destination)).toBe('DESTINATION');
  });
  it('checks unused retained definitions, while ordinary dash-only drawings keep DWG saving', () => {
    const state = readDxf(fixture);
    expect(dwgCompatibilityProblem({ ...state, entities: [], blocks: {}, layouts: [] })).toMatch(/complex linetype/);
    const basic = new Drawing().snapshot;
    expect(dwgCompatibilityProblem(basic)).toBeNull();
    expect(dwgCompatibilityProblem({ ...basic, header: { ...new Drawing().header, linetypes: [{ name: 'DASH', description: '', pattern: [2, -1] }] } })).toBeNull();
  });
});
