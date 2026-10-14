/** Actual Editor/report producers; native picker, receipts and host order are explicit transport doubles. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Editor as EditorType, FileBridge, OpenResult } from '../src/app/editor';
import { Drawing } from '../src/core/document';
import { readDxf, writeDxf, DxfReadError } from '../src/io/dxf';
import { REPORTS } from '../src/electrical/reports';
import * as electricalDialogs from '../src/ui/electrical-dialogs';
import { projectDocuments, runReportTemplate } from '../src/app/commands-electrical';
import { exportErrorText, exportFailed } from '../src/app/file-error-text';
import { fileErrorText } from '../src/app/file-error-text';
import { adoptOpenedSourceProof, captureOpenedSourceProof, forgetOpenedSourceProof } from '../src/app/opened-source-proof';
import { resetWindowsPathIdentitiesForTests, samePath, setPathPlatform } from '../src/app/paths';

let Editor: typeof EditorType, serial = 0;
beforeAll(async () => { globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {}; Editor = (await import('../src/app/editor')).Editor; });
afterEach(() => { vi.restoreAllMocks(); resetWindowsPathIdentitiesForTests(); setPathPlatform(null); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const template = { name: 'Race', title: 'Race', report: 'bom', output: 'csv' as const };
const dxf = writeDxf(new Drawing().snapshot);
const markerState = (value: string) => new Drawing({ entities: [{ id: 'marker', type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, height: 1, rotation: 0, align: 'left', text: value }] }).snapshot;
function setup() {
  const editor = new Editor({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement);
  const folder = `C:\\csv-${++serial}`, destination = `${folder}\\Race.csv`, physical = `C:\\native-csv-${serial}\\Race.csv`;
  editor.loadState(new Drawing().snapshot, `${folder}\\Active.dxf`); setPathPlatform('win32');
  const events: string[] = [], tickets = new Map<string, number>(), receipts = new Map<string, { path: string; identityPath: string }>(), disk = new Map<string, string>();
  let order = 0, latest = 0;
  const bridge: FileBridge = {
    platform: 'win32', openDxf: async () => null, saveDxf: async () => { throw new Error('A report must not save its source drawing'); },
    issueSaveAdmission: vi.fn(async kind => { const token = `csv-${++order}`; events.push(`issue:${kind}:${order}`); tickets.set(token, order); return token; }),
    bindSaveAdmission: vi.fn(async () => { throw new Error('Text output is bound by the native picker, not a renderer path'); }),
    choosePdfPath: vi.fn(async () => { throw new Error('Text output must not invoke the PDF chooser'); }),
    cancelSaveAdmission: vi.fn(async ticket => { events.push(`cancel:${ticket}`); tickets.delete(ticket); }),
    saveAdmissionResult: vi.fn(async ticket => { events.push(`receipt:${ticket}`); const result = receipts.get(ticket) ?? null; receipts.delete(ticket); return result; }),
    saveText: vi.fn(async (_name, text, _filter, _ext, opts) => {
      const ticket = opts?.admission, issued = ticket && tickets.get(ticket); events.push(`write:${issued}`);
      if (!issued) throw new Error('ERR_SAVE_TICKET'); if (issued < latest) throw new Error('ERR_SAVE_STALE: a newer export reached this file');
      latest = issued; disk.set(destination, text); receipts.set(ticket!, { path: destination, identityPath: physical }); return destination;
    }),
    openDrawing: vi.fn(async path => { events.push('read'); return { path: path!, kind: 'dxf' as const, text: dxf }; }),
    releaseOpenedSourceProof: vi.fn(async () => {}),
  };
  editor.fileBridge = bridge; const saved = vi.fn(); editor.hooks.drawingSaved = saved;
  const closed = `${folder}\\Closed.dxf`;
  editor.project = { ...editor.project, drawings: [{ file: closed, sheet: '1' }] };
  return { editor, bridge, folder, destination, physical, events, tickets, receipts, disk, saved, closed };
}

describe('text export ownership before report producers', () => {
  it('captures a text order before project reads and suppresses its late CSV after a newer export', async () => {
    const f = setup(), reading = deferred<OpenResult | null>();
    f.bridge.openDrawing = vi.fn(() => { f.events.push('read'); return reading.promise; });
    const older = runReportTemplate(f.editor, { ...template, projectWide: true }); await vi.waitFor(() => expect(f.bridge.openDrawing).toHaveBeenCalledOnce());
    expect(f.events.slice(0, 2)).toEqual(['issue:text-export:1', 'read']);
    await runReportTemplate(f.editor, template); const newer = f.disk.get(f.destination);
    reading.resolve({ path: f.closed, kind: 'dxf', text: dxf }); await older;
    expect(f.disk.get(f.destination)).toBe(newer); expect(newer).not.toMatch(/^Drawing,/); expect(f.editor.history.join('\n')).toMatch(/ERR_SAVE_STALE/); expect(f.tickets.size).toBe(0);
    expect(f.bridge.saveText).toHaveBeenNthCalledWith(2, 'Race.csv', expect.stringMatching(/^Drawing,/), 'CSV', 'csv', { admission: 'csv-1' });
  });
  it('retains its original bridge while project reads await, consumes a receipt and leaves drawing state untouched', async () => {
    const f = setup(), reading = deferred<OpenResult | null>(), other = setup(); f.bridge.openDrawing = vi.fn(() => reading.promise);
    f.editor.doc.dirty = true; f.editor.selection = new Set(['existing-selection']);
    const snapshot = f.editor.doc.snapshot, history = f.editor.doc.history(), selection = f.editor.selection;
    const running = runReportTemplate(f.editor, { ...template, projectWide: true }); await vi.waitFor(() => expect(f.bridge.openDrawing).toHaveBeenCalled());
    f.editor.fileBridge = other.bridge; reading.resolve({ path: f.closed, kind: 'dxf', text: dxf }); await running;
    expect(f.bridge.saveText).toHaveBeenCalledOnce(); expect(other.bridge.saveText).not.toHaveBeenCalled(); expect(f.bridge.saveAdmissionResult).toHaveBeenCalledWith('csv-1');
    expect(f.bridge.choosePdfPath).not.toHaveBeenCalled(); expect(f.bridge.bindSaveAdmission).not.toHaveBeenCalled(); expect(samePath(f.destination, f.physical)).toBe(false);
    expect(f.editor.doc.snapshot).toBe(snapshot); expect(f.editor.doc.history()).toEqual(history); expect(f.editor.selection).toBe(selection); expect(f.editor.doc.dirty).toBe(true); expect(f.saved).not.toHaveBeenCalled(); expect(f.tickets.size).toBe(0);
  });
  it('captures active and parked report sources plus the original bridge before a delayed issue response', async () => {
    const f = setup(), other = setup(), issue = f.bridge.issueSaveAdmission!, gate = deferred<void>(), parkedPath = `${f.folder}\\Parked.dxf`;
    f.editor.loadState(markerState('A'), `${f.folder}\\Active.dxf`);
    const original = f.editor.sessions.active, parked = f.editor.sessions.add(markerState('P'), parkedPath, true); f.editor.sessions.switchTo(original);
    f.editor.project = { ...f.editor.project, drawings: [{ file: parkedPath }, { file: f.closed }] };
    f.bridge.issueSaveAdmission = vi.fn(async kind => { const ticket = await issue(kind); await gate.promise; return ticket; });
    f.bridge.openDrawing = vi.fn(async source => ({ path: source!, kind: 'dxf' as const, text: writeDxf(markerState('C')), openedSourceProof: 'original-bridge-raw-proof' }));
    vi.spyOn(REPORTS.find(row => row.key === 'bom')!, 'build').mockImplementation(doc => ({ title: 'Race', columns: ['source'], rows: [[doc.entities.find(entity => entity.type === 'text')?.text ?? 'empty']] }));
    const running = runReportTemplate(f.editor, { ...template, projectWide: true }); expect(f.events[0]).toBe('issue:text-export:1');
    f.editor.sessions.switchTo(parked); f.editor.doc.replaceEntities(markerState('Q').entities); f.editor.sessions.add(markerState('B'), `${f.folder}\\New.dxf`, true);
    f.editor.project = { ...f.editor.project, drawings: [{ file: `${f.folder}\\Wrong.dxf` }] }; f.editor.fileBridge = other.bridge;
    gate.resolve(); await running;
    expect(f.disk.get(f.destination)).toBe('Drawing,source\r\nActive.dxf,A\r\nParked.dxf,P\r\nClosed.dxf,C\r\n'); expect(f.bridge.openDrawing).toHaveBeenCalledWith(f.closed);
    expect(other.bridge.openDrawing).not.toHaveBeenCalled(); expect(other.bridge.saveText).not.toHaveBeenCalled(); expect(f.bridge.releaseOpenedSourceProof).toHaveBeenCalledWith('original-bridge-raw-proof');
    expect(f.editor.doc.entities.find(entity => entity.type === 'text')?.text).toBe('B'); expect(f.editor.doc.dirty).toBe(true); expect(f.tickets.size).toBe(0);
  });
  it('captures direct AEREPORTCSV order before its asynchronous build microtask and a newer raw export', async () => {
    const f = setup(), issue = f.bridge.issueSaveAdmission!, gate = deferred<void>(); let issued = 0;
    f.bridge.issueSaveAdmission = vi.fn(async kind => { const ticket = await issue(kind); if (++issued === 1) await gate.promise; return ticket; });
    const older = f.editor.runCommand('AEREPORTCSV bom'); expect(f.events[0]).toBe('issue:text-export:1');
    const later = await f.bridge.issueSaveAdmission('text-export'); await f.bridge.saveText!('Race.csv', 'NEWER RAW CSV', 'CSV', 'csv', { admission: later });
    gate.resolve(); await older;
    expect(f.disk.get(f.destination)).toBe('NEWER RAW CSV'); expect(f.editor.history.join('\n')).toMatch(/ERR_SAVE_STALE/); expect(f.tickets.has('csv-1')).toBe(false);
    await f.bridge.cancelSaveAdmission!(later, 'text-export');
  });
  it('captures a generic drawing CSV before its native save call and cleans canceled choices', async () => {
    const f = setup(); f.bridge.saveText = vi.fn(async () => null);
    await runReportTemplate(f.editor, template);
    expect(f.events[0]).toBe('issue:text-export:1'); expect(f.bridge.saveText).toHaveBeenCalledWith('Race.csv', expect.any(String), 'CSV', 'csv', { admission: 'csv-1' });
    expect(f.bridge.saveAdmissionResult).not.toHaveBeenCalled(); expect(f.editor.history.join('\n')).not.toMatch(/Report Race saved:/); expect(f.tickets.size).toBe(0);
  });
  it('joins cancel cleanup when the actual CSV producer throws before the picker', async () => {
    const f = setup(), cancel = deferred<void>(); vi.spyOn(REPORTS.find(row => row.key === 'bom')!, 'build').mockImplementation(() => { throw new Error('producer failed'); });
    f.bridge.cancelSaveAdmission = vi.fn(async ticket => { await cancel.promise; f.tickets.delete(ticket); });
    const running = runReportTemplate(f.editor, template), failure = expect(running).rejects.toThrow('producer failed'); let finished = false; void running.catch(() => { finished = true; });
    await vi.waitFor(() => expect(f.bridge.cancelSaveAdmission).toHaveBeenCalledOnce()); expect(finished).toBe(false); expect(f.bridge.saveText).not.toHaveBeenCalled();
    cancel.resolve(); await failure; expect(finished).toBe(true); expect(f.tickets.size).toBe(0);
  });
  it('releases a reserved CSV order for an invalid template without producing a file', async () => {
    const f = setup(); await runReportTemplate(f.editor, { ...template, report: 'unknown' });
    expect(f.bridge.issueSaveAdmission).toHaveBeenCalledOnce(); expect(f.bridge.saveText).not.toHaveBeenCalled(); expect(f.tickets.size).toBe(0);
  });
  it('does not begin project reads when the host refuses admission capacity', async () => {
    const f = setup(); f.bridge.issueSaveAdmission = vi.fn(async () => { throw new Error('ERR_SAVE_CAPACITY'); });
    await expect(runReportTemplate(f.editor, { ...template, projectWide: true })).rejects.toThrow('ERR_SAVE_CAPACITY');
    expect(f.bridge.openDrawing).not.toHaveBeenCalled(); expect(f.bridge.saveText).not.toHaveBeenCalled(); expect(f.tickets.size).toBe(0);
  });
  it('reports admission failure at the report-template dialog discarded-promise boundary', async () => {
    const f = setup(); let options: Parameters<typeof electricalDialogs.reportTemplatesDialog>[0] | undefined;
    vi.spyOn(electricalDialogs, 'reportTemplatesDialog').mockImplementation(value => { options = value; });
    f.bridge.issueSaveAdmission = vi.fn(async () => { throw new Error('ERR_SAVE_CAPACITY'); }); f.editor.runCommand('AEREPORTTEMPLATES');
    expect(options).toBeDefined(); options!.run({ ...template, projectWide: true });
    await vi.waitFor(() => expect(f.editor.history.join('\n')).toMatch(/Export not saved:.*ERR_SAVE_CAPACITY/));
    expect(f.bridge.openDrawing).not.toHaveBeenCalled(); expect(f.bridge.saveText).not.toHaveBeenCalled(); expect(f.tickets.size).toBe(0);
  });
  it('allocates no export capability for a table-producing report', async () => {
    const f = setup(); await runReportTemplate(f.editor, { ...template, output: 'table' });
    expect(f.bridge.issueSaveAdmission).not.toHaveBeenCalled(); expect(f.bridge.saveText).not.toHaveBeenCalled(); expect(f.editor.doc.layer('REPORT')).toBeDefined();
  });
  it.each(['missing', 'unverified'] as const)('reports %s committed text output without false success or drawing cleanup', async failure => {
    const f = setup(); f.editor.doc.dirty = true;
    if (failure === 'missing') f.bridge.saveAdmissionResult = vi.fn(async () => null); else f.bridge.saveText = vi.fn(async () => { throw new Error('ERR_SAVE_COMMITTED: EACCES after replacement'); });
    await runReportTemplate(f.editor, template); const log = f.editor.history.join('\n');
    expect(log).toMatch(/Export verification failed: The file was replaced.*Review the destination/); expect(log).not.toMatch(/Export not saved:|Report Race saved:/); expect(f.editor.doc.dirty).toBe(true); expect(f.saved).not.toHaveBeenCalled(); expect(f.tickets.size).toBe(0);
  });
  it('refuses to call an identity-only result verified when a modern receipt API is absent', async () => {
    const f = setup(); delete f.bridge.saveAdmissionResult; await runReportTemplate(f.editor, template);
    expect(f.disk.size).toBe(1); expect(f.editor.history.join('\n')).toMatch(/file was replaced.*Review the destination/); expect(f.tickets.size).toBe(0);
  });
  it.each(['old Windows', 'non-Windows', 'browser'] as const)('preserves the four-argument %s bridge contract', async mode => {
    const f = setup(); if (mode === 'old Windows') delete f.bridge.choosePdfPath; else f.bridge.platform = mode === 'non-Windows' ? 'linux' : undefined;
    f.bridge.saveText = vi.fn(async () => 'download.csv'); await runReportTemplate(f.editor, template);
    expect(f.bridge.issueSaveAdmission).not.toHaveBeenCalled(); expect(f.bridge.saveText).toHaveBeenCalledWith('Race.csv', expect.any(String), 'CSV', 'csv'); expect(f.bridge.saveAdmissionResult).not.toHaveBeenCalled();
  });
});

describe('detached report read-proof cleanup', () => {
  it.each(['valid', 'damaged', 'skipped'] as const)('releases the unused %s raw read token, preserving the open tab token', async mode => {
    const f = setup(), session = f.editor.sessions.current;
    adoptOpenedSourceProof(session, session.contentGeneration, f.bridge, 'editor-owned-proof', session.filePath!);
    const complete = writeDxf(markerState('retained partial entity'));
    const source = mode === 'valid' ? complete : mode === 'damaged' ? complete.replace(/0\r?\nEOF\r?\n?$/, '') : 'invalid-dxf';
    if (mode === 'damaged') {
      let failure: unknown; try { readDxf(source); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(DxfReadError); expect((failure as DxfReadError).truncated).toBe(true);
    }
    f.bridge.openDrawing = vi.fn(async () => ({ path: f.closed, kind: 'dxf' as const, text: source, openedSourceProof: 'unused-report-proof' }));
    const documents = await projectDocuments(f.editor);
    if (mode === 'skipped') { expect(documents).toHaveLength(1); expect(f.editor.history.join('\n')).toMatch(/Skipped Closed\.dxf/); }
    else {
      expect(documents).toHaveLength(2); expect(documents[1]!.doc.entities.some(entity => entity.type === 'text' && entity.text === 'retained partial entity')).toBe(true);
      if (mode === 'damaged') expect(f.editor.history.join('\n')).toMatch(/Closed\.dxf is damaged.*report uses what was readable/);
    }
    expect(f.bridge.releaseOpenedSourceProof).toHaveBeenCalledWith('unused-report-proof'); expect(f.bridge.releaseOpenedSourceProof).not.toHaveBeenCalledWith('editor-owned-proof');
    const captured = captureOpenedSourceProof(session, f.bridge, session.filePath, 'in-place'); expect(captured?.hint.proof).toBe('editor-owned-proof'); await captured?.release(); forgetOpenedSourceProof(session);
  });
  it('keeps retained raw proof count bounded across many detached report reads, including null skips', async () => {
    const f = setup(), retained = new Set<string>(); let issued = 0, highWater = 0;
    f.editor.project = { ...f.editor.project, drawings: Array.from({ length: 6 }, (_, n) => ({ file: `${f.folder}\\Closed${n}.dxf`, sheet: String(n) })) };
    f.bridge.openDrawing = vi.fn(async source => {
      if (source?.endsWith('Closed5.dxf')) return null;
      if (retained.size >= 2) throw new Error('Read proof capacity exhausted'); const proof = `report-${++issued}`; retained.add(proof); highWater = Math.max(highWater, retained.size);
      return { path: source!, kind: 'dxf' as const, text: dxf, openedSourceProof: proof };
    });
    f.bridge.releaseOpenedSourceProof = vi.fn(async proof => { retained.delete(proof); });
    for (let n = 0; n < 3; n++) expect(await projectDocuments(f.editor)).toHaveLength(6);
    expect(issued).toBe(15); expect(highWater).toBe(1); expect(retained.size).toBe(0); expect(f.editor.history.join('\n')).not.toMatch(/capacity exhausted/);
  });
});

describe('text export messages', () => {
  it('keeps normal OS guidance but gives the replacement marker precedence over its underlying OS failure', () => {
    const error = new Error("EACCES: permission denied, open 'C:\\exports\\Race.csv'");
    expect(exportErrorText(error, 'Race.csv')).toBe(fileErrorText(error));
    const messages: string[] = [], committed = new Error(`Error invoking remote method 'save-text': Error: ERR_SAVE_COMMITTED: A replacement occurred. ${error.message}`);
    expect(exportFailed(message => messages.push(message), 'Race.csv')(committed)).toBeNull();
    expect(messages).toEqual(['Export verification failed: The file was replaced, but final save verification failed. Review the destination before saving again.']);
  });
});
