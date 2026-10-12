/**
 * OPEN / SAVE / IMPORTREPORT on a real editor with a fake file bridge: the report dialog hook
 * after open, partial recovery of a truncated file, and the warning before Save writes over a
 * source file whose content could not be kept (No = Save As).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImportReport } from '../src/io/import-report';
import { Drawing } from '../src/core/document';
import { writeDxf } from '../src/io/dxf';

const text = (p: string) => readFileSync(join(__dirname, 'fixtures', p), 'latin1');

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

  it('SAVEAS choosing the original source still warns; a changed or replaced session cannot use its answer', async () => {
    const f = await makeEditor({ '/d/saveas-source.dxf': text('unsupported-content.dxf') }, [true]);
    await f.ed.openFile('/d/saveas-source.dxf');
    f.ed.fileBridge!.chooseDrawingPath = async () => '/d/saveas-source.dxf';
    f.ed.ui!.confirm = async (title, message) => {
      f.asked.push({ title, message });
      // An external command replaces the document while the loss warning is pending.
      f.ed.newDrawing();
      return true;
    };
    expect(await f.ed.saveFile(true)).toBe(false);
    expect(f.asked).toHaveLength(1);
    expect(f.saves).toEqual([]);
    expect(f.ed.lastFileError).toMatch(/changed or closed/);
  });

  it('a newly imported report at the same source asks again', async () => {
    const f = await makeEditor({ '/d/repeated-source.dxf': text('unsupported-content.dxf') }, [true, true]);
    await f.ed.openFile('/d/repeated-source.dxf');
    expect(await f.ed.saveFile(false)).toBe(true);
    await f.ed.openFile('/d/repeated-source.dxf');
    expect(await f.ed.saveFile(false)).toBe(true);
    expect(f.asked).toHaveLength(2);
  });

  it('explicit SAVEAS selecting the source asks before writing', async () => {
    const f = await makeEditor({ '/d/explicit-source.dxf': text('unsupported-content.dxf') }, [true]);
    await f.ed.openFile('/d/explicit-source.dxf');
    f.ed.fileBridge!.chooseDrawingPath = async () => '/d/explicit-source.dxf';
    expect(await f.ed.saveFile(true)).toBe(true);
    expect(f.asked).toHaveLength(1);
    expect(f.saves.map((s) => s.path)).toEqual(['/d/explicit-source.dxf']);
  });
  it('OPEN shows the report dialog when content was lost; SAVE over the source asks, No goes to Save As', async () => {
    const { ed, logs, asked, saves, reports } = await makeEditor({ '/d/plant.dxf': text('unsupported-content.dxf') }, [false]);
    await ed.openFile('/d/plant.dxf');
    expect(reports).toHaveLength(1);
    expect(reports[0]!.report.sourcePath).toBe('/d/plant.dxf');
    expect(logs.join('\n')).toMatch(/DXF import: 9 object\(s\) dropped or simplified, 2 kept without being shown/);
    await ed.saveFile(false);
    expect(asked.map((a) => a.title)).toEqual(['Save over the original file?']);
    expect(asked[0]!.message).toMatch(/plant\.dxf contained 9 object\(s\) JCad cannot keep/);
    // No -> Save As: the bridge is asked for a new path (null), the original is not written.
    expect(saves.map((s) => s.path)).toEqual([null]);
    expect(saves[0]!.text).toContain('3DSOLID');
    ed.runCommand('IMPORTREPORT');
    expect(reports).toHaveLength(2);
  }, 30000);

  it('a truncated file asks before opening what was readable and opens as recovered', async () => {
    const { ed, asked, reports, saves } = await makeEditor({ '/d/cut.dxf': text('broken/truncated.dxf') }, [true, true]);
    await ed.openFile('/d/cut.dxf');
    expect(asked[0]!.message).toMatch(/ends early at line 83.*Open what was readable\?/s);
    expect(ed.doc.entities.map((e) => e.type)).toEqual(['line', 'circle']);
    expect(ed.doc.dirty).toBe(true);
    expect(reports[0]!.report.recovered?.line).toBe(83);
    await ed.saveFile(false);
    expect(asked[1]!.message).toMatch(/recovered from a damaged file/);
    expect(saves.map((s) => s.path)).toEqual(['/d/cut.dxf']); // Yes: saved over it
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
