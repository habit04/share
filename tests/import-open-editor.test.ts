/**
 * OPEN / SAVE / IMPORTREPORT on a real editor with a fake file bridge: the report dialog hook
 * after open, partial recovery of a truncated file, and the warning before Save writes over a
 * source file whose content could not be kept (No = Save As).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImportReport } from '../src/io/import-report';

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
  it('OPEN shows the report dialog when content was lost; SAVE over the source asks, No goes to Save As', async () => {
    const { ed, logs, asked, saves, reports } = await makeEditor({ '/d/plant.dxf': text('unsupported-content.dxf') }, [false]);
    await ed.openFile('/d/plant.dxf');
    expect(reports).toHaveLength(1);
    expect(reports[0]!.report.sourcePath).toBe('/d/plant.dxf');
    expect(logs.join('\n')).toMatch(/DXF import: 10 object\(s\) dropped or simplified, 2 kept without being shown/);
    await ed.saveFile(false);
    expect(asked.map((a) => a.title)).toEqual(['Save over the original file?']);
    expect(asked[0]!.message).toMatch(/plant\.dxf contained 10 object\(s\) JCad cannot keep/);
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
    const { ed, asked, reports, saves } = await makeEditor({ '/d/ok.dxf': text('interchange-reference.dxf') }, []);
    await ed.openFile('/d/ok.dxf');
    expect(reports).toHaveLength(0);
    await ed.saveFile(false);
    expect(asked).toHaveLength(0);
    expect(saves.map((s) => s.path)).toEqual(['/d/ok.dxf']);
  }, 30000);
});
