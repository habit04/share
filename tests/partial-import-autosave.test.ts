/** Crash recovery must preserve the partial badge, exclusion history and source refusal. */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { Drawing } from '../src/core/document';
import { Autosaver, restoreAutosaveImportData, type AutosaveMeta, type AutosaveStore } from '../src/app/autosave';
import { ImportReportBuilder, countOf, importReportOf, isPartialImport, partialImportSaveBlock, withImportData } from '../src/io/import-report';
import { AUTOSAVE_IMPORT_LIMITS, cleanPartialImportProvenance, partialImportProvenance } from '../src/io/import-provenance';
import { readDxf } from '../src/io/dxf';
import { MemFs } from './helpers/memfs';
import { Rng } from './helpers/fuzz';

const require = createRequire(import.meta.url);
const { createAutosaveStore } = require('../electron/autosave-store.cjs') as { createAutosaveStore(dir: string, deps: { fs: MemFs }): AutosaveStore };
const { cleanPartialImportProvenance: cleanHost } = require('../electron/import-provenance.cjs') as { cleanPartialImportProvenance(value: unknown): unknown };
const source = 'C:\\drawings\\original.dwg';
const name = '11111111-1111-4111-8111-111111111111.sv.dxf';
const actions = ['dropped', 'simplified', 'kept', 'unsupported'] as const;

describe('partial import autosave provenance', () => {
  it.each(['dropped', 'simplified', 'recovered'] as const)('preserves %s history and source protection through autosave, host restart and recovery', async loss => {
    const builder = new ImportReportBuilder();
    if (loss === 'recovered') builder.recovered = { line: 42, message: 'Original file ended early' };
    else builder.add({ type: 'INSERT', action: loss, handle: '122CE4', layer: 'SIGNATURE', where: 'model space', reason: 'Signature excluded by import budget' });
    const state = withImportData(new Drawing().snapshot, builder.build('DWG', source));
    const fs = new MemFs(new Rng(73)), store = createAutosaveStore('/recovery', { fs });
    const sessions = { all: [{ id: 1, docId: name.replace('.sv.dxf', ''), dirty: true, state, filePath: source, untitledName: 'Drawing1.dxf' }] };
    const autosaver = new Autosaver(sessions, store, () => 10);
    expect(await autosaver.runNow()).toBe(1);
    const restarted = createAutosaveStore('/recovery', { fs });
    const entry = (await restarted.list())[0]!;
    expect(entry.originalPath).toBe(source); expect(entry.partialImport).toBeDefined();
    expect(entry.partialImportSourcePath).toBe(source);
    expect(JSON.stringify(entry.partialImport)).not.toContain(source); expect(JSON.stringify(entry.partialImport)).not.toContain('sourcePath');
    const parsed = readDxf((await restarted.read(name))!, { filePath: source });
    const recovered = restoreAutosaveImportData(parsed, entry);
    expect(isPartialImport(recovered)).toBe(true); // The tab badge uses this exact predicate.
    expect(importReportOf(recovered)?.sourcePath).toBe(source);
    expect(partialImportSaveBlock(recovered, source)).toMatch(/cannot be saved over its source/);
    expect(partialImportSaveBlock(recovered, 'C:\\drawings\\separate-copy.dxf')).toBeNull();
    if (loss === 'recovered') expect(importReportOf(recovered)?.recovered).toEqual(builder.recovered);
    else expect(importReportOf(recovered)?.items).toContainEqual(expect.objectContaining({ type: 'INSERT', action: loss, handle: '122CE4', layer: 'SIGNATURE' }));
    // An autosave of the recovered tab must retain the history through a second crash.
    expect(partialImportProvenance(recovered)?.counts.some(count => count.dropped || count.simplified) || partialImportProvenance(recovered)?.recovered).toBeTruthy();
  });

  it('caps diagnostic detail without losing aggregate counts or adding filesystem authority', () => {
    const builder = new ImportReportBuilder();
    for (let index = 0; index < 180; index++) for (const action of actions) builder.add({ type: `TYPE_${index}`, action, reason: 'r'.repeat(2000), handle: `H${index}`, layer: 'x'.repeat(400), where: 'w'.repeat(2000) });
    const state = withImportData(new Drawing().snapshot, builder.build('DWG', source));
    const provenance = partialImportProvenance(state)!;
    expect(provenance.counts.length).toBeLessThanOrEqual(AUTOSAVE_IMPORT_LIMITS.types); expect(provenance.items).toHaveLength(AUTOSAVE_IMPORT_LIMITS.items);
    expect(provenance.items.every(item => item.reason.length <= AUTOSAVE_IMPORT_LIMITS.text)).toBe(true);
    expect(provenance.omitted).toBe(720 - AUTOSAVE_IMPORT_LIMITS.items); expect(JSON.stringify(provenance).length).toBeLessThan(128 * 1024);
    expect(cleanHost(provenance)).toEqual(provenance);
    const restored = restoreAutosaveImportData(new Drawing().snapshot, { originalPath: source, partialImport: provenance });
    for (const action of actions) expect(countOf(importReportOf(restored)!, action)).toBe(180 + (action === 'unsupported' ? 1 : 0));
    expect(Object.hasOwn(provenance, 'sourcePath')).toBe(false);
  });

  it('retains the original import spelling after Save As and preserves uncapped font substitution counts', async () => {
    const builder = new ImportReportBuilder(); builder.add({ type: 'INSERT', action: 'dropped', reason: 'excluded' });
    for (let index = 0; index < 1100; index++) builder.add({ type: 'STYLE', action: 'unsupported', reason: `Font ${index} uses a substitute` });
    const state = withImportData(new Drawing().snapshot, builder.build('DWG', source)), copy = 'C:\\copies\\drawing-copy.dxf';
    const fs = new MemFs(new Rng(88)), store = createAutosaveStore('/recovery', { fs });
    const sessions = { all: [{ id: 1, docId: name.replace('.sv.dxf', ''), dirty: true, state, filePath: copy, untitledName: 'Drawing1.dxf' }] };
    expect(await new Autosaver(sessions, store, () => 10).runNow()).toBe(1);
    const entry = (await createAutosaveStore('/recovery', { fs }).list())[0]!;
    expect(entry.originalPath).toBe(copy); expect(entry.partialImportSourcePath).toBe(source); expect(entry.partialImport?.fontSubstitutions).toBe(1100);
    const restored = restoreAutosaveImportData(new Drawing().snapshot, entry);
    expect(importReportOf(restored)?.sourcePath).toBe(source); expect(importReportOf(restored)?.fontSubstitutions).toBe(1100);
    expect(partialImportSaveBlock(restored, source)).not.toBeNull(); expect(partialImportSaveBlock(restored, copy)).toBeNull();
    expect(partialImportProvenance(restored)?.fontSubstitutions).toBe(1100);
  });

  it.each([null, 5, {}, { version: 1 }, { version: 1, format: 'DXF', counts: [], items: [], omitted: 0, notes: [] }, { version: 1, format: 'DXF', counts: Array(129).fill({}), items: [], omitted: 0, notes: [] }])('keeps malformed supplied history conservatively partial: %j', value => {
    expect(cleanHost(value)).toEqual(cleanPartialImportProvenance(value));
    const restored = restoreAutosaveImportData(new Drawing().snapshot, { originalPath: source, partialImport: value as AutosaveMeta['partialImport'] });
    expect(isPartialImport(restored)).toBe(true); expect(partialImportSaveBlock(restored, source)).not.toBeNull();
  });

  it('sanitizes metadata loaded from an existing host index and does not accept embedded source paths or proofs', async () => {
    const builder = new ImportReportBuilder(); builder.add({ type: 'INSERT', action: 'dropped', reason: 'excluded' });
    const provenance = { ...partialImportProvenance(withImportData(new Drawing().snapshot, builder.build('DXF', source)))!, sourcePath: 'C:\\untrusted\\other.dwg', openedSourceProof: 'invented' };
    const fs = new MemFs(new Rng(5)); fs.put(`/recovery/${name}`, 'copy'); fs.put('/recovery/index.json', JSON.stringify({ version: 1, entries: { [name]: { originalPath: source, title: 'copy', savedAt: 1, partialImport: provenance } } }));
    const entry = (await createAutosaveStore('/recovery', { fs }).list())[0]!;
    expect(entry.partialImport).toEqual(cleanPartialImportProvenance(provenance));
    const restored = restoreAutosaveImportData(new Drawing().snapshot, entry);
    expect(importReportOf(restored)?.sourcePath).toBe(source); expect(JSON.stringify(restored.meta)).not.toContain('untrusted'); expect(JSON.stringify(restored.meta)).not.toContain('invented');
    expect(restoreAutosaveImportData(new Drawing().snapshot, { originalPath: '/complete.dxf' }).meta).toBeUndefined();
  });
});
