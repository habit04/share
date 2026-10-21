/**
 * OPEN / SAVE / IMPORTREPORT on a real editor with a fake file bridge: the report dialog hook
 * after open, partial recovery of a truncated file, and the hard refusal to Save over the
 * source file of a partial import (dropped/simplified content or a recovered file); the old
 * confirm-over warning remains only for imports whose report holds no losses.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImportReport } from '../src/io/import-report';
import { Drawing } from '../src/core/document';
import { readDxf, writeDxf } from '../src/io/dxf';

const text = (p: string) => readFileSync(join(__dirname, 'fixtures', p), 'latin1');
function polyfaceCommonOwners(groups: readonly (readonly [number, string])[]): number[] {
  const owners: number[] = []; let depth = 0;
  for (let index = 0; index < groups.length; index++) {
    const [code, value] = groups[index]!;
    if (code === 102) { depth += value.startsWith('{') ? 1 : value === '}' ? -1 : 0; continue; }
    if (!depth && [100, 8, 1001].includes(code)) break;
    if (!depth && code === 330) owners.push(index);
  }
  return owners;
}

async function makeEditor(files: Record<string, string>, answers: boolean[]) {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  const { Editor } = await import('../src/app/editor');
  const ed = new Editor({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }) } as unknown as HTMLCanvasElement);
  const logs: string[] = [];
  const asked: Array<{ title: string; message: string }> = [];
  const saves: Array<{ path: string | null; text: string }> = [];
  const reports: Array<{ report: ImportReport; name: string }> = [];
  ed.log = (t: string) => void logs.push(t);
  ed.ui = {
    pickSymbol: async () => null,
    editComponent: async () => null,
    ladderSettings: async (i) => i,
    textInput: async (_t, _l, i) => i,
    confirm: async (title, message) => {
      asked.push({ title, message });
      return answers.shift() ?? true;
    },
  };
  ed.hooks.importReport = (report, name) => void reports.push({ report, name });
  ed.fileBridge = {
    openDxf: async () => null,
    openDrawing: async (path?: string) => (path && files[path] !== undefined ? { path, kind: 'dxf' as const, text: files[path]! } : null),
    saveDxf: async (path: string | null, t: string) => {
      saves.push({ path, text: t });
      return path ?? '/out/copy.dxf';
    },
  } as unknown as NonNullable<typeof ed.fileBridge>;
  return { ed, logs, asked, saves, reports };
}

describe('import report in the editor', () => {
  it('Windows DWG open keeps its path and subsequent Save uses the portable writer with source-loss consent', async () => {
    const f = await makeEditor({}, [true]);
    const writes: string[] = [];
    f.ed.fileBridge!.platform = 'win32';
    f.ed.fileBridge!.dwgExportStatus = async () => ({ available: true });
    f.ed.fileBridge!.saveDwg = async (path) => { writes.push(path); return path; };
    f.ed.fileBridge!.openDrawing = async () => ({ path: '/d/working.dwg', kind: 'dwg', version: 'AC1032', payload: { header: {}, entities: [], layers: [], blocks: [] } });
    expect(await f.ed.openFile()).toBe(true);
    expect(f.ed.doc.filePath).toBe('/d/working.dwg');
    expect(f.ed.doc.dirty).toBe(false);
    f.ed.doc.addEntities([{ id: 'edit-dwg', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 2, y: 3 } }]);
    expect(await f.ed.saveFile(false)).toBe(true);
    expect(writes).toEqual(['/d/working.dwg']);
    expect(f.saves).toEqual([]);
    expect(f.asked[0]?.message).toMatch(/properties JCad cannot read/);
    expect(f.ed.doc.dirty).toBe(false);
  });

  it('non-Windows DWG opens as an unsaved DXF copy', async () => {
    const f = await makeEditor({}, []);
    f.ed.fileBridge!.platform = 'linux';
    f.ed.fileBridge!.openDrawing = async () => ({ path: '/d/original.dwg', kind: 'dwg', payload: { header: {}, entities: [], layers: [], blocks: [] } });
    expect(await f.ed.openFile()).toBe(true);
    expect(f.ed.doc.filePath).toBeNull();
    expect(f.ed.doc.dirty).toBe(true);
    expect(f.ed.suggestedName).toBe('original.dxf');
  });

  it('SAVEAS choosing the original source of a partial import is refused without asking', async () => {
    const f = await makeEditor({ '/d/saveas-source.dxf': text('unsupported-content.dxf') }, []);
    await f.ed.openFile('/d/saveas-source.dxf');
    f.ed.fileBridge!.chooseDrawingPath = async () => '/d/saveas-source.dxf';
    expect(await f.ed.saveFile(true)).toBe(false);
    expect(f.asked).toHaveLength(0);
    expect(f.saves).toEqual([]);
    expect(f.ed.lastFileError).toMatch(/partial import/);
    expect(f.ed.doc.filePath).toBe('/d/saveas-source.dxf');
  });

  it('a re-imported partial drawing still cannot save over its source', async () => {
    const f = await makeEditor({ '/d/repeated-source.dxf': text('unsupported-content.dxf') }, []);
    await f.ed.openFile('/d/repeated-source.dxf');
    expect(await f.ed.saveFile(false)).toBe(false);
    await f.ed.openFile('/d/repeated-source.dxf');
    expect(await f.ed.saveFile(false)).toBe(false);
    expect(f.asked).toHaveLength(0);
    expect(f.saves).toEqual([]);
  });

  it('explicit SAVEAS selecting the source of a partial import is refused', async () => {
    const f = await makeEditor({ '/d/explicit-source.dxf': text('unsupported-content.dxf') }, []);
    await f.ed.openFile('/d/explicit-source.dxf');
    f.ed.fileBridge!.chooseDrawingPath = async () => '/d/explicit-source.dxf';
    expect(await f.ed.saveFile(true)).toBe(false);
    expect(f.asked).toHaveLength(0);
    expect(f.saves).toEqual([]);
  });
  it('OPEN shows the report dialog when content was lost; SAVE over the source is refused, Save As to a new file works', async () => {
    const { ed, logs, asked, saves, reports } = await makeEditor({ '/d/plant.dxf': text('unsupported-content.dxf') }, []);
    await ed.openFile('/d/plant.dxf');
    expect(reports).toHaveLength(1);
    expect(reports[0]!.report.sourcePath).toBe('/d/plant.dxf');
    expect(logs.join('\n')).toMatch(/DXF import: 6 object\(s\) dropped or simplified, 5 kept without being shown/);
    expect(reports[0]!.report.counts.POLYLINE).toEqual({ kept: 1 });
    const before = ed.doc.snapshot, history = ed.doc.history();
    // A partial import can never overwrite its source: no confirmation is offered.
    expect(await ed.saveFile(false)).toBe(false);
    expect(asked).toEqual([]);
    expect(saves).toEqual([]);
    expect(ed.lastFileError).toMatch(/partial import/);
    // Save As chooses a separate destination before the write; the original is not written.
    ed.fileBridge!.chooseDrawingPath = async () => '/out/copy.dxf';
    expect(await ed.saveFile(true)).toBe(true);
    expect(saves.map((s) => s.path)).toEqual(['/out/copy.dxf']);
    expect(saves[0]!.text).toContain('3DSOLID');
    expect(ed.doc.snapshot).toBe(before); expect(ed.doc.history()).toEqual(history);
    expect(ed.doc.filePath).toBe('/out/copy.dxf'); expect(ed.doc.dirty).toBe(false);
    const reopened = readDxf(saves[0]!.text, { model3d: false });
    const handles = ['107', '108', '109', '10A', '10B', '10C'];
    for (const snapshot of [before, reopened]) {
      expect(snapshot.cadGraph!.nodes.filter(node => handles.includes(node.sourceHandle ?? '')).map(node => node.sourceHandle)).toEqual(handles);
    }
    for (const handle of handles) {
      const source = before.cadGraph!.nodes.filter(node => node.sourceHandle === handle), saved = reopened.cadGraph!.nodes.filter(node => node.sourceHandle === handle);
      expect(source).toHaveLength(1); expect(saved).toHaveLength(1); expect(saved[0]!.type).toBe(source[0]!.type);
      const owner = reopened.cadGraph!.nodes.find(node => node.type === 'BLOCK_RECORD' && node.groups.some(([code, value]) => code === 2 && value === '*Model_Space'))!.sourceHandle!;
      const sourceOwners = polyfaceCommonOwners(source[0]!.groups), savedOwners = polyfaceCommonOwners(saved[0]!.groups);
      expect(savedOwners).toHaveLength(1);
      const expected = [...source[0]!.groups];
      if (handle === '107') {
        expect(sourceOwners).toHaveLength(1); expected[sourceOwners[0]!] = [330, owner];
      } else if (sourceOwners.length === 0) {
        expect(source[0]!.groups[0]).toEqual([5, handle]);
        expect(savedOwners[0]).toBe(1); expect(saved[0]!.groups[1]).toEqual([330, '107']);
        expected.splice(1, 0, [330, '107']);
      }
      expect(saved[0]!.groups).toEqual(expected);
    }
    ed.runCommand('IMPORTREPORT');
    expect(reports).toHaveLength(2);
  }, 30000);

  it('a truncated file asks before opening what was readable, opens as recovered, and cannot overwrite its source', async () => {
    const { ed, asked, reports, saves } = await makeEditor({ '/d/cut.dxf': text('broken/truncated.dxf') }, [true]);
    await ed.openFile('/d/cut.dxf');
    expect(asked[0]!.message).toMatch(/ends early at line 83.*Open what was readable\?/s);
    expect(ed.doc.entities.map((e) => e.type)).toEqual(['line', 'circle']);
    expect(ed.doc.dirty).toBe(true);
    expect(reports[0]!.report.recovered?.line).toBe(83);
    // A recovered drawing is a partial import: saving over the source is refused, not confirmed.
    expect(await ed.saveFile(false)).toBe(false);
    expect(asked).toHaveLength(1);
    expect(saves).toEqual([]);
    expect(ed.lastFileError).toMatch(/recovered from a damaged file/);
  }, 30000);

  it('declining recovery leaves the current drawing; structural damage is reported, not opened', async () => {
    const { ed, logs } = await makeEditor({ '/d/cut.dxf': text('broken/truncated.dxf'), '/d/bad.dxf': text('broken/unbalanced.dxf') }, [false]);
    const before = ed.doc.snapshot;
    await ed.openFile('/d/cut.dxf');
    expect(ed.doc.snapshot).toBe(before);
    expect(logs.join('\n')).toMatch(/Not opened: \/d\/cut\.dxf is damaged/);
    await ed.openFile('/d/bad.dxf');
    expect(ed.doc.snapshot).toBe(before);
    expect(logs.join('\n')).toMatch(/Failed to open drawing: Line 9: a new SECTION starts before section HEADER/);
  }, 30000);

  it('a clean file opens without a dialog and saves without asking', async () => {
    const { ed, asked, reports, saves, logs } = await makeEditor({ '/d/ok.dxf': writeDxf(new Drawing().snapshot) }, []);
    await ed.openFile('/d/ok.dxf');
    expect(ed.doc.filePath, logs.join('\n')).toBe('/d/ok.dxf');
    expect(reports).toHaveLength(0);
    await ed.saveFile(false);
    expect(asked).toHaveLength(0);
    expect(saves.map((s) => s.path)).toEqual(['/d/ok.dxf']);
  }, 30000);
});
