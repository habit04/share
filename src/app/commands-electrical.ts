/**
 * AutoCAD Electrical-style commands: component data / tags, catalog,
 * parent-child, wire tools, panel layout, project + title block, reports
 * and the audit. Registered at the end of Editor.registerCommands; dialogs
 * come from `editor.hooks.electrical` (default: src/ui/electrical-dialogs.ts).
 */
import type { Editor, FileBridge } from './editor';
import type { Point } from '../core/geometry';
import type { Entity, InsertEntity } from '../core/entities';
import { Drawing, type DrawingState } from '../core/document';
import { ComponentTool, componentDialogInit, componentAttributes, lookupSymbol } from '../tools/electrical';
import {
  TrimWireTool,
  WireGapTool,
  ScootTool,
  AlignTool,
  MultiBusTool,
  ThreePhaseComponentTool,
  WireNumberEditTool,
  CopyWireNumberTool,
  WireNumberLeaderTool,
  ToggleNcTool,
  SwapBlockTool,
  EditComponentTool,
  PlaceTool,
  CableTool,
  JumperTool,
  RemoveJumperTool,
} from '../tools/electrical-wires';
import { FootprintTool, BalloonTool, NameplateTool } from '../tools/panel';
import { assignWireNumbers, DEFAULT_BUS } from '../electrical/wires';
import { readWdSettings, writeWdSettings, WD_M_BLOCK, type WdSettings } from '../electrical/wdm';
import { retagDrawing, isFixedTag, TAG_FIXED_ATTRIBUTE } from '../electrical/tags';
import { updateCrossReferences, parentCandidates, childBlockChoices, type ChildBlockOptions } from '../electrical/xref';
import { LIBRARY_BLOCKS, findLibrarySymbol } from '../electrical/library';
import { tagPrefix } from '../electrical/symbols';
import { userLibrary } from '../electrical/userlib';
import { setUserCatalog, parseCatalog, userCatalogSize, catalogFamilyFor } from '../electrical/catalog';
import { packRegistry, packStatus } from '../electrical/packs';
import { schematicList, terminalStripTable, applyTerminalEdits, BALLOON_BLOCK, NAMEPLATE_BLOCK } from '../electrical/panel';
import { buildMotorCircuit, makeTagger, DEFAULT_CIRCUIT, type CircuitOptions } from '../electrical/circuits';
import { auditIssues } from '../electrical/audit';
import { REPORTS, reportToEntities, mergeReports, reportToCsv, plcIoReport, type Report } from '../electrical/reports';
import { withoutUnusedLibraryBlocks } from '../electrical/library';
import { withInsertAttributes } from '../electrical/attributes';
import { jumperText } from '../electrical/cables';
import {
  makeSheet,
  buildProjectXref,
  applyProjectXref,
  xrefProblems,
  planProjectRetag,
  withTags,
  planProjectWireNumbers,
  withWireNumbers,
  locationView,
  recordProjectStatus,
  type ProjectSheet,
  type ProjectXrefEntry,
  type XrefProblem,
  type LocationRow,
} from '../electrical/project-tools';
import { parsePlcIo, modulesFromRows, plcRowsToCsv, rowsFromPlcReport, DEFAULT_PLC_IMPORT } from '../electrical/plc-import';
import { applyTemplate, findTemplate, describeTemplate, type ReportTemplate } from '../electrical/report-templates';
import { projectMapping, titleBlockSources, applyTitleBlockMapping, mappedValues, parseWdt, formatWdt } from '../electrical/titleblock-map';
import { buildPlcModule, normalizePlcSettings, type PlcModuleSettings } from '../tools/plc';
import { WIRENO_LAYER } from '../electrical/wires';
import { findRails, nearestReference, rungReferences } from '../electrical/ladder';
import { projectDrawingIndex, resolveDrawingPath, resolveProjectPath, baseName } from './project';
import { readDxf, writeDxf } from '../io/dxf';
import { convertDwg } from '../io/dwg';
import type { ElectricalUi } from '../electrical/ui';
import {
  createElectricalDialogs,
  packsDialog,
  installPackFromPicker,
  confirmFilesDialog,
  reportTableDialog,
  locationViewDialog,
  plcImportDialog,
  cableDialog,
  reportTemplatesDialog,
  browserOpenTextFile,
  type AffectedDrawing,
  type ConfirmFilesResult,
  type DrawingPropertiesResultEx,
} from '../ui/electrical-dialogs';
import { isComponent } from '../electrical/families';

/** The dialog set: whatever main.ts installed on `hooks.electrical`, else the built-in dialogs (created lazily). */
export function electricalUi(editor: Editor): ElectricalUi {
  if (!editor.hooks.electrical) editor.hooks.electrical = createElectricalDialogs(editor);
  return editor.hooks.electrical;
}

/** Load every drawing of the project (current one from memory) for project-wide reports. */
export async function projectDocuments(editor: Editor): Promise<Array<{ name: string; doc: Drawing }>> {
  const out: Array<{ name: string; doc: Drawing }> = [{ name: editor.fileName(), doc: editor.doc }];
  const bridge = editor.fileBridge;
  if (!bridge?.openDrawing) return out;
  const sessions = editor.sessions.all;
  const activeId = editor.sessions.current.id;
  for (const d of editor.project.drawings) {
    const path = resolveDrawingPath(editor.project, d);
    if (path === editor.doc.filePath) continue;
    // Drawings open in another tab are reported from memory (unsaved edits included).
    const open = sessions.find((x) => x.id !== activeId && x.filePath === path);
    if (open) {
      const doc = new Drawing();
      doc.load(open.state, path);
      out.push({ name: baseName(path), doc });
      continue;
    }
    try {
      const res = await bridge.openDrawing(path);
      if (!res) continue;
      const state = res.kind === 'dwg' ? convertDwg(res.payload).state : readDxf(res.text);
      const doc = new Drawing();
      doc.load(state, path);
      doc.ensureBlocks(LIBRARY_BLOCKS);
      out.push({ name: baseName(path), doc });
    } catch (err) {
      editor.log(`Skipped ${baseName(path)}: ${(err as Error).message}`);
    }
  }
  return out;
}

async function buildReport(editor: Editor, key: string, projectWide: boolean): Promise<Report> {
  const def = REPORTS.find((r) => r.key === key) ?? REPORTS[0]!;
  if (!projectWide) return def.build(editor.doc);
  const docs = await projectDocuments(editor);
  return mergeReports(docs.map((d) => ({ drawing: d.name, report: def.build(d.doc) })));
}

async function saveCsv(editor: Editor, name: string, csv: string): Promise<string | null> {
  if (editor.fileBridge?.saveText) return editor.fileBridge.saveText(name, csv, 'CSV', 'csv');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return name;
}

function openReports(editor: Editor, key: string): void {
  electricalUi(editor).reports({
    initialKey: key,
    projectAvailable: editor.project.drawings.length > 0 && !!editor.fileBridge?.openDrawing,
    build: (k, pw) => buildReport(editor, k, pw),
    saveCsv: (n, c) => saveCsv(editor, n, c),
    putOnDrawing: (report) => placeReport(editor, report),
  });
}

function zoomTo(editor: Editor, p: Point, id?: string): void {
  const r = 1.5;
  editor.viewport.zoomToBounds({ min: { x: p.x - r, y: p.y - r }, max: { x: p.x + r, y: p.y + r } }, 0.05);
  if (id && editor.doc.entity(id)) editor.selection = new Set([id]);
  editor.render();
}

function applyProjectSettingsToDrawing(editor: Editor, s: WdSettings): WdSettings {
  const ps = editor.project.settings;
  if (!ps) return s;
  return {
    ...s,
    tagFormat: ps.tagFormat ?? s.tagFormat,
    wireFormat: ps.wireFormat ?? s.wireFormat,
    tagMode: ps.tagMode ?? s.tagMode,
    iecProject: ps.iecProject ?? s.iecProject,
    iecInstallation: ps.installation ?? s.iecInstallation,
    iecLocation: ps.location ?? s.iecLocation,
    standard: ps.standard ?? s.standard,
  };
}

/** Load the project's user catalog file (if any) through the file bridge. */
export async function loadProjectCatalog(editor: Editor): Promise<void> {
  const file = editor.project.settings?.catalogFile;
  if (!file) return;
  const path = resolveProjectPath(editor.project, file);
  try {
    const res = await editor.fileBridge?.openProject?.(path);
    if (!res) return;
    setUserCatalog(parseCatalog(res.text));
    editor.log(`User catalog loaded: ${userCatalogSize()} part(s) from ${baseName(path)}.`);
  } catch (err) {
    editor.log(`User catalog ${baseName(path)} not loaded (${(err as Error).message}); use AECATALOGLOAD to pick it.`);
  }
}

/** Library lookups for childBlockChoices: drawing / library blocks and the user library's same-family contacts. */
export function childBlockOptions(editor: Pick<Editor, 'doc'>): ChildBlockOptions {
  return {
    exists: (name) => !!editor.doc.lookupBlock(name) || !!findLibrarySymbol(name),
    candidates: (parentBlock, kind) => {
      const family = tagPrefix(parentBlock);
      return userLibrary
        .all()
        .filter((s) => s.wdtype === 'CONTACT' && s.family === family && new RegExp(`_${kind}$`).test(s.block.name))
        .map((s) => s.block.name)
        .sort();
    },
  };
}

export function registerElectricalCommands(editor: Editor): void {
  const reg = (name: string, aliases: string[], description: string, run: (ed: Editor, arg?: string) => void) => editor.register({ name, aliases, description, run });
  const ui = () => electricalUi(editor);
  const settings = () => applyProjectSettingsToDrawing(editor, readWdSettings(editor.doc));
  editor.doc.ensureBlocks([WD_M_BLOCK, BALLOON_BLOCK, NAMEPLATE_BLOCK]);

  // ---- components, tags, catalog
  reg('AECOMPONENT', ['COMPONENT', 'CMP', 'AEC'], 'Insert component from icon menu (ACADE data: INST/LOC/DESC/MFG/CAT/pins)', (ed, arg) => ed.startTool(new ComponentTool(arg, ui, settings)));
  reg('AEEDITCOMPONENT', ['EDITCOMPONENT', 'AEEDIT'], 'Edit component data (tag, location, description, catalog, pins)', (ed) => ed.startTool(new EditComponentTool(ui)));
  reg('AECHILD', ['CHILD', 'INSERTCHILD'], 'Insert child contact: pick the parent coil, then NO or NC', (ed) => {
    const parents = parentCandidates(ed.doc);
    if (parents.length === 0) {
      ed.log('No parent devices (coils) in the drawing yet.');
      return;
    }
    void ui()
      .pickList('Insert Child Contact: select parent', parents.map((p) => ({ value: p.id, label: p.tag, detail: `${p.description || p.block}  rung ${p.ref ?? '?'}  (${p.contacts} contact${p.contacts === 1 ? '' : 's'})` })), { detailHeader: 'Description / rung / contacts', okLabel: 'Next' })
      .then(async (id) => {
        if (!id) return;
        const parent = ed.doc.entities.find((e): e is InsertEntity => e.id === id);
        if (!parent) return;
        // User child symbols first (the parent's own _NO/_NC twin, then same-family user contacts), then the built-in contact.
        const items = (['NO', 'NC'] as const).flatMap((kind) =>
          childBlockChoices(parent.block, kind, childBlockOptions(ed)).map((block) => ({
            value: block,
            label: kind === 'NO' ? 'Normally open' : 'Normally closed',
            detail: `${block}${userLibrary.has(block) ? ' (user library)' : ''}  ${findLibrarySymbol(block)?.description ?? ed.doc.lookupBlock(block)?.description ?? ''}`.trimEnd(),
          })),
        );
        const block = await ui().pickList(`Contact type for ${parent.attributes.TAG1}`, items, { detailHeader: 'Symbol' });
        if (!block) return;
        ed.startTool(new ComponentTool(block, ui, settings, parent.id));
      });
  });
  reg('AECOMPONENT3', ['COMPONENT3', 'AEC3'], 'Insert a 3-phase (3-pole) component onto a 3-wire bus', (ed, arg) => ed.startTool(new ThreePhaseComponentTool(arg, ui)));
  reg('AERETAG', ['RETAG'], 'Retag components in ladder order [Selection/Project/project Duplicates]; fixed tags are kept', (ed, arg) => {
    const a = (arg ?? '').toUpperCase();
    if (a === 'P' || a === 'PROJECT' || a === 'D' || a === 'PD' || a === 'DUPLICATES') {
      void runProjectRetag(ed, a === 'P' || a === 'PROJECT' ? 'all' : 'duplicates');
      return;
    }
    const only = a.startsWith('S') && ed.selection.size ? new Set(ed.selection) : undefined;
    const r = retagDrawing(ed.doc, settings(), only);
    if (r.count) updateCrossReferences(ed.doc, settings());
    ed.log(`RETAG: ${r.count} tag(s) updated${r.renamed.size ? ` (${[...r.renamed].slice(0, 6).map(([a, b]) => `${a}->${b}`).join(', ')}${r.renamed.size > 6 ? ', ...' : ''})` : ''}.`);
  });
  reg('AETOGGLENC', ['TOGGLENC'], 'Toggle a contact between NO and NC', (ed) => ed.startTool(new ToggleNcTool()));
  reg('AESWAP', ['SWAPBLOCK', 'AESWAPBLOCK'], 'Swap a component symbol, keeping its data', (ed) => ed.startTool(new SwapBlockTool()));
  reg('AEUPDATEBLOCK', ['UPDATEBLOCK'], 'Update symbol block definitions from the library (built-in and user symbols)', (ed) => {
    const lib = [...LIBRARY_BLOCKS, ...userLibrary.all().map((s) => s.block), WD_M_BLOCK, BALLOON_BLOCK, NAMEPLATE_BLOCK];
    let n = 0;
    ed.doc.transact((s) => {
      const blocks = { ...s.blocks };
      for (const b of lib) {
        const cur = blocks[b.name];
        if (cur && cur !== b) {
          // Keep attribute definitions this drawing added on top of the library symbol (XREF, JUMPER,
          // TAGFIXED ...): the DXF writer only writes values whose block defines the tag.
          const have = new Set(b.attributes.map((a) => a.tag));
          const extra = cur.attributes.filter((a) => !have.has(a.tag));
          blocks[b.name] = extra.length ? { ...b, attributes: [...b.attributes, ...extra] } : b;
          n += 1;
        }
      }
      return n ? { ...s, blocks } : s;
    });
    ed.log(`${n} block definition(s) updated from the symbol library.`);
    ed.render();
  });
  reg('AECATALOG', ['CATALOG', 'CATALOGBROWSER'], 'Catalog browser: pick a part for the selected component', (ed, arg) => {
    const sel = [...ed.selection].map((id) => ed.doc.entity(id)).find((e): e is InsertEntity => !!e && isComponent(e));
    const family = arg ?? (sel ? catalogFamilyFor(componentDialogInit(ed.doc, sel.block, sel.position, sel).family) : undefined);
    void ui()
      .catalogBrowser({ family, type: sel && /_NC$/.test(sel.block) ? 'NC' : sel && /_NO$/.test(sel.block) ? 'NO' : undefined })
      .then((item) => {
        if (!item) return;
        if (sel) {
          const attrs = componentAttributes({ ...sel.attributes, MFG: item.mfg, CAT: item.cat, DESC1: sel.attributes.DESC1 || item.desc, ASSYCODE: item.assycode ?? sel.attributes.ASSYCODE ?? '', RATING1: item.rating ?? sel.attributes.RATING1 ?? '' });
          ed.doc.replaceEntities([{ ...sel, attributes: attrs }]);
          ed.log(`${sel.attributes.TAG1 ?? sel.block}: ${item.mfg} ${item.cat} assigned.`);
        } else ed.log(`Catalog: ${item.mfg} ${item.cat} - ${item.desc} (select a component first to assign it).`);
      });
  });
  reg('AECATALOGLOAD', ['LOADCATALOG'], 'Load a user catalog JSON file (overrides the built-in parts)', (ed) => {
    const pick = ui().openTextFile?.('.json') ?? Promise.resolve(null);
    void pick.then((res) => {
      if (!res) return;
      try {
        setUserCatalog(parseCatalog(res.text));
        ed.project = { ...ed.project, settings: { ...ed.project.settings, catalogFile: res.path } };
        ed.hooks.projectChanged?.();
        ed.log(`User catalog loaded: ${userCatalogSize()} part(s). Path stored in the project settings (PROJECTSAVE to keep it).`);
      } catch (err) {
        ed.log(`Catalog not loaded: ${(err as Error).message}`);
      }
    });
  });
  // ---- catalog packs (signed manufacturer catalogs, see docs/CATALOG-PACKS.md)
  reg('AEPACKS', ['PACKS', 'CATALOGPACKS'], 'Catalog packs: list, install or remove signed manufacturer catalogs', (ed) => void packsDialog(ed));
  reg('AEPACKINSTALL', ['PACKINSTALL', 'INSTALLPACK'], 'Install a catalog pack file (*.jcadpack.json) after verifying its signature', (ed) => void installPackFromPicker(ed));
  reg('AEPACKLIST', ['PACKLIST'], 'List the installed catalog packs (licensee, expiry, part count)', (ed) => {
    const list = packRegistry.list();
    if (list.length === 0) {
      ed.log('No catalog packs installed (AEPACKINSTALL installs a *.jcadpack.json file).');
      return;
    }
    for (const p of list) ed.log(`${p.doc.name} v${p.doc.version} (${p.doc.id}) by ${p.doc.publisher}: ${p.items.length} part(s), licensed to ${p.doc.license.licensee}, ${packStatus(p)}.`);
    for (const e of packRegistry.errors) ed.log(`Not loaded: ${e}`);
    ed.log(`${list.length} pack(s); files in ${packRegistry.location ?? 'the app data folder (packs/)'}.`);
  });

  // ---- wires
  reg('AETRIMWIRE', ['TRIMWIRE'], 'Trim a wire segment between components / junctions', (ed) => ed.startTool(new TrimWireTool()));
  reg('AEWIREGAP', ['WIREGAP'], 'Insert wire gaps at crossings', (ed) => ed.startTool(new WireGapTool('gap')));
  reg('AEWIRELOOP', ['WIRELOOP'], 'Insert wire jump-over loops at crossings', (ed) => ed.startTool(new WireGapTool('loop')));
  reg('AESCOOT', ['SCOOT'], 'Scoot: slide a component or wire number along its wire', (ed) => ed.startTool(new ScootTool()));
  reg('AEALIGN', [], 'Align components with a reference [Vertical/Horizontal]', (ed, arg) => ed.startTool(new AlignTool(arg?.toUpperCase().startsWith('H') ? 'horizontal' : 'vertical')));
  reg('AEMULTIBUS', ['MULTIBUS', 'BUS'], 'Multiple bus: N parallel wires', (ed) => ed.startTool(new MultiBusTool((init) => ui().busSettings(init), { ...DEFAULT_BUS, layer: ed.wireLayer })));
  reg('AEWIRENO', ['WIRENO'], 'Insert wire numbers (fixed numbers are kept) [start / P = project sheet-based / PD = project drawing start]', (ed, arg) => {
    const a = (arg ?? '').toUpperCase();
    if (a === 'P' || a === 'PROJECT' || a === 'PD') {
      void runProjectWireNumbers(ed, a !== 'PD');
      return;
    }
    const s = settings();
    const start = arg ? parseInt(arg, 10) : s.wireStart;
    const n = assignWireNumbers(ed.doc, { start: Number.isFinite(start) ? start : 100, position: s.wirePosition, format: s.wireFormat, mode: s.wireMode, sheet: s.sheet });
    ed.log(`${n} wire number(s) assigned.`);
  });
  reg('AEEDITWIRENO', ['EDITWIRENO'], 'Edit a wire number: fixed flag, position, find / replace', (ed) => ed.startTool(new WireNumberEditTool(ui)));
  reg('AECOPYWIRENO', ['COPYWIRENO'], 'Copy a wire number to another wire', (ed) => ed.startTool(new CopyWireNumberTool()));
  reg('AEWIRENOLEADER', ['WIRENOLEADER'], 'Move a wire number with a leader', (ed) => ed.startTool(new WireNumberLeaderTool()));
  reg('AEXREF', ['XREF'], 'Update coil/contact cross-references [Drawing/Project] (project-wide when the drawing is in a project)', (ed, arg) => {
    const a = (arg ?? '').toUpperCase();
    if (a.startsWith('P') || (!a.startsWith('D') && editor.project.drawings.length > 1 && projectDrawingIndex(ed.project, ed.doc.filePath) >= 0)) {
      void runProjectXref(ed);
      return;
    }
    const n = updateCrossReferences(ed.doc, settings());
    ed.log(`Cross-references updated for ${n} tag(s).`);
  });

  // ---- panel
  reg('AESCHEMATICLIST', ['SCHEMATICLIST', 'AEPANELLIST'], 'Schematic list: insert panel footprints for schematic components', (ed) => {
    void projectDocuments(ed).then((docs) => {
      const rows = schematicList(docs.map((d) => ({ name: d.name, entities: d.doc.entities })), ed.doc.entities);
      if (rows.length === 0) {
        ed.log('No schematic components found (in this drawing or the project).');
        return;
      }
      void ui()
        .schematicList(rows)
        .then((row) => {
          if (row) ed.startTool(new FootprintTool(row));
        });
    });
  });
  reg('AEFOOTPRINT', ['FOOTPRINT'], 'Insert a footprint for the selected schematic component', (ed) => {
    const sel = [...ed.selection].map((id) => ed.doc.entity(id)).find((e): e is InsertEntity => !!e && isComponent(e));
    if (!sel) {
      ed.runCommand('AESCHEMATICLIST');
      return;
    }
    const rows = schematicList([{ name: ed.fileName(), entities: [sel] }], ed.doc.entities);
    if (rows[0]) ed.startTool(new FootprintTool(rows[0]));
  });
  reg('AEBALLOON', ['BALLOON'], 'Insert an item number balloon on a footprint', (ed) => ed.startTool(new BalloonTool()));
  reg('AENAMEPLATE', ['NAMEPLATE'], 'Insert a nameplate for a footprint or component', (ed) => ed.startTool(new NameplateTool((t, l, i) => (ed.ui ? ed.ui.textInput(t, l, i) : Promise.resolve(i)))));
  reg('AETERMEDIT', ['TERMEDIT', 'TERMINALEDITOR'], 'Terminal strip editor', (ed) => {
    const rows = terminalStripTable(ed.doc.entities, ed.doc.lookupBlock);
    if (rows.length === 0) {
      ed.log('No terminals in the drawing.');
      return;
    }
    void ui()
      .terminalStripEditor(rows)
      .then((edited) => {
        if (!edited) return;
        const rep = applyTerminalEdits(ed.doc.entities, edited);
        if (rep.length) ed.doc.replaceEntities(rep);
        ed.log(`${rep.length} terminal(s) updated.`);
      });
  });

  // ---- project / drawing properties / title block
  reg('AEDRAWINGPROPS', ['DRAWINGPROPERTIES', 'DWGPROPS', 'AESETTINGS'], 'Drawing properties: sheet, description, tag / wire formats, IEC codes', (ed) => {
    const idx = projectDrawingIndex(ed.project, ed.doc.filePath);
    const current = readWdSettings(ed.doc);
    void ui()
      .drawingProperties({ settings: current, drawing: idx >= 0 ? ed.project.drawings[idx]! : null, fileName: ed.fileName() })
      .then((r) => {
        if (!r) return;
        writeWdSettings(ed.doc, { ...r.settings, sheet: r.sheet || r.settings.sheet, drawingDescription: r.description, drawingNumber: r.dwgno });
        if (idx >= 0) {
          const x = r as DrawingPropertiesResultEx;
          const drawings = ed.project.drawings.map((d, i) => (i === idx ? { ...d, description: r.description || undefined, sheet: r.sheet || undefined, dwgno: r.dwgno || undefined, rev: x.rev === undefined ? d.rev : x.rev || undefined, date: x.date === undefined ? d.date : x.date || undefined } : d));
          ed.project = { ...ed.project, drawings };
          ed.hooks.projectChanged?.();
        }
        ed.log('Drawing properties saved in the WD_M settings block.');
      });
  });
  reg('AEPROJECTPROPS', ['PROJECTPROPERTIES', 'PROJPROPS'], 'Project properties: description lines, catalog file, default formats', (ed) => {
    void ui()
      .projectProperties(ed.project)
      .then((p) => {
        if (!p) return;
        ed.project = { ...p, path: ed.project.path };
        ed.hooks.projectChanged?.();
        ed.log('Project properties updated (PROJECTSAVE writes them to the project file).');
        void loadProjectCatalog(ed);
      });
  });
  reg('AETITLEBLOCK', ['UPDATETITLEBLOCK', 'TITLEBLOCK'], 'Update the title block from project and drawing properties through the project mapping (.wdt) [All drawings]', (ed, arg) => {
    if ((arg ?? '').toUpperCase().startsWith('A')) {
      void runTitleBlocksAll(ed);
      return;
    }
    const idx = projectDrawingIndex(ed.project, ed.doc.filePath);
    const sheet = makeSheet(ed.doc, { name: ed.fileName(), path: ed.doc.filePath, index: idx, entrySheet: idx >= 0 ? ed.project.drawings[idx]?.sheet : undefined, projectSettings: ed.project.settings });
    const r = titleBlockChange(ed, sheet);
    if (!r.found) {
      ed.log('No title block in this drawing (use NEWSHEET for a sheet with a title block, or name your title block with BLOCK = in the project mapping).');
      return;
    }
    if (r.changed) ed.doc.transact(() => r.state);
    const values = mappedValues(projectMapping(ed.project), titleBlockSources(ed.project, idx, sheet.settings, sheet.name));
    ed.log(`Title block ${r.changed ? 'updated' : 'already up to date'}: ${Object.entries(values).filter(([k, v]) => v && ['PROJECT', 'TITLE', 'SHEET', 'DWGNO', 'REV'].includes(k)).map(([k, v]) => `${k}=${v}`).join(', ')}.`);
  });

  // ---- circuits
  reg('AECIRCUIT', ['CIRCUITBUILDER', 'CIRCUIT'], 'Circuit builder: start/stop, reversing or jog motor control circuit', (ed) => {
    const s = settings();
    const init: CircuitOptions = { ...DEFAULT_CIRCUIT, standard: s.standard, spacing: s.rungSpacing, drawLadder: rungReferences(ed.doc).length === 0 };
    void ui()
      .circuitBuilder(init)
      .then((o) => {
        if (!o) return;
        const build = (origin: Point, doc: Drawing): Entity[] => {
          const rails = findRails(doc, origin);
          const opts: CircuitOptions = { ...o, left: rails.left?.a.x ?? origin.x, right: rails.right?.a.x ?? origin.x + (o.right - o.left), top: origin.y, drawLadder: o.drawLadder || !(rails.left && rails.right) };
          const refs = rungReferences(doc);
          if (refs.length >= 2) opts.spacing = Math.abs(refs[0]!.position.y - refs[1]!.position.y);
          const refOf = (y: number) => (opts.drawLadder ? String(o.firstReference + Math.round((opts.top - y) / opts.spacing)) : nearestReference(doc, { x: opts.left, y }));
          return buildMotorCircuit(opts, makeTagger(doc, s, refOf));
        };
        ed.startTool(
          new PlaceTool('AECIRCUIT', build, 'Specify the first rung on the ladder (left rail intersection) for the circuit:', () => {
            assignWireNumbers(ed.doc, { start: s.wireStart, position: s.wirePosition, format: s.wireFormat });
            updateCrossReferences(ed.doc, s);
            ed.log(`${o.kind} circuit inserted; wire numbers and cross-references updated.`);
          }),
        );
      });
  });

  // ---- reports / audit
  reg('AEREPORT', ['REPORT', 'BOM'], `Reports [${REPORTS.map((r) => r.key).join('/')}] with project scope, CSV and put-on-drawing`, (ed, arg) => openReports(ed, (arg ?? 'bom').toLowerCase()));
  reg('AEAUDIT', ['AUDIT', 'ELECTRICALAUDIT'], 'Electrical audit with jump-to-error', (ed) => {
    const run = () => auditIssues(ed.doc);
    ui().audit(run(), (issue) => issue.position && zoomTo(ed, issue.position, issue.entityId), run);
  });
  reg('AEREPORTCSV', [], 'Write a report straight to CSV [key]', (ed, arg) => {
    void buildReport(ed, (arg ?? 'bom').toLowerCase(), false).then((r) => saveCsv(ed, `${r.title.replace(/[^A-Za-z0-9]+/g, '_')}.csv`, reportToCsv(r)).then((p) => p && ed.log(`Report saved: ${p}`)));
  });
  reg('AESYMBOLINFO', [], 'List the pin / data attributes of a symbol', (ed, arg) => {
    const def = arg ? lookupSymbol(arg.toUpperCase()) : undefined;
    if (!def) {
      ed.log('Usage: AESYMBOLINFO <block name>');
      return;
    }
    ed.log(`${def.name}: ${def.description ?? ''}`);
    for (const a of def.attributes) ed.log(`  ${a.tag.padEnd(10)} ${a.invisible ? '(invisible) ' : ''}default "${a.default}" at ${a.position.x.toFixed(3)}, ${a.position.y.toFixed(3)}`);
  });

  registerProjectCommands(editor);

  // Load the project catalog whenever a project with a catalog file is opened.
  let loadedCatalog = '';
  editor.on('file', () => {
    const f = editor.project.settings?.catalogFile ?? '';
    if (f && f !== loadedCatalog) {
      loadedCatalog = f;
      void loadProjectCatalog(editor);
    }
  });
}

// ------------------------------------------------------------ project-wide tools (AEXREF / AERETAG / AEWIRENO project, AELOCVIEW ...)

/** Dialogs used by the project-wide commands (replaceable, e.g. by tests or another UI). */
export const projectUi = {
  confirmFiles: (title: string, intro: string, items: AffectedDrawing[], opts: { backupAvailable: boolean }): Promise<ConfirmFilesResult | null> => confirmFilesDialog(title, intro, items, opts),
  showProblems: (editor: Editor, sheets: readonly LoadedSheet[], problems: XrefProblem[]): void => showXrefProblems(editor, sheets, problems),
};

/** A project drawing loaded for a project-wide command, with where it came from. */
export interface LoadedSheet extends ProjectSheet {
  /** active = the drawing in the editor, session = another open tab, file = read from disk. */
  source: 'active' | 'session' | 'file';
  sessionId?: number;
}

/** Bridge extension a desktop build may provide for the .bak copy before project-wide saves (not in FileBridge yet). */
type BackupBridge = FileBridge & { backupFile?(path: string): Promise<string | null> };

/** Only the desktop bridge reads project drawings by path (the browser bridge would show a file picker per drawing). */
export function canReadProjectFiles(editor: Pick<Editor, 'fileBridge'>): boolean {
  return !!editor.fileBridge?.openDrawing && typeof window !== 'undefined' && !!window.jcad;
}

/**
 * Every drawing of the project as a sheet: the active drawing and other
 * open tabs from memory (so unsaved edits count), closed drawings read
 * through the file bridge (DXF only; DWG is read-only). When the project
 * has no drawings, the current drawing alone is used.
 */
export async function loadProjectSheets(editor: Editor, opts: { files?: boolean } = {}): Promise<{ sheets: LoadedSheet[]; skipped: string[] }> {
  const project = editor.project;
  const sessions = editor.sessions.all;
  const activeId = editor.sessions.current.id;
  const sheets: LoadedSheet[] = [];
  const skipped: string[] = [];
  const isEntry = (file: string | null, i: number, path: string) => !!file && (file === path || projectDrawingIndex(project, file) === i);
  for (let i = 0; i < project.drawings.length; i += 1) {
    const d = project.drawings[i]!;
    const path = resolveDrawingPath(project, d);
    const base = { name: baseName(path), path, index: i, entrySheet: d.sheet, projectSettings: project.settings };
    if (isEntry(editor.doc.filePath, i, path)) {
      sheets.push({ ...makeSheet(editor.doc, base), source: 'active', sessionId: activeId });
      continue;
    }
    const s = sessions.find((x) => x.id !== activeId && isEntry(x.filePath, i, path));
    if (s) {
      const doc = new Drawing();
      doc.load(s.state, s.filePath);
      sheets.push({ ...makeSheet(doc, base), source: 'session', sessionId: s.id });
      continue;
    }
    if (opts.files === false || !canReadProjectFiles(editor)) {
      skipped.push(`${base.name} (not open)`);
      continue;
    }
    try {
      const res = await editor.fileBridge!.openDrawing!(path);
      if (!res) {
        skipped.push(base.name);
        continue;
      }
      if (res.kind === 'dwg') {
        skipped.push(`${base.name} (DWG is read-only)`);
        continue;
      }
      const doc = new Drawing();
      doc.load(readDxf(res.text), path);
      doc.ensureBlocks(LIBRARY_BLOCKS);
      sheets.push({ ...makeSheet(doc, base), source: 'file' });
    } catch (err) {
      skipped.push(`${base.name} (${(err as Error).message})`);
    }
  }
  if (project.drawings.length === 0) sheets.push({ ...makeSheet(editor.doc, { name: editor.fileName(), path: editor.doc.filePath, index: -1, projectSettings: project.settings }), source: 'active', sessionId: activeId });
  return { sheets, skipped };
}

export interface SheetChange {
  state: DrawingState;
  detail: string;
}

/**
 * Apply new states to project sheets. Open drawings change in their tabs
 * (one undo step each); closed drawings are written as DXF through the
 * bridge only after the user confirms the list (with an optional .bak copy
 * when the bridge supports it). Returns null when cancelled.
 */
export async function commitSheets(editor: Editor, sheets: readonly LoadedSheet[], changes: ReadonlyMap<number, SheetChange>, title: string, intro: string, alwaysConfirm = false): Promise<{ open: number; written: number; failed: string[] } | null> {
  const items: AffectedDrawing[] = [...changes].map(([i, c]) => ({ name: sheets[i]!.name, kind: sheets[i]!.source === 'file' ? 'file' : 'open', detail: c.detail }));
  if (items.length === 0) return { open: 0, written: 0, failed: [] };
  const bridge = editor.fileBridge as BackupBridge | null;
  let choice: ConfirmFilesResult = { files: false, backup: false };
  if (alwaysConfirm || items.some((i) => i.kind === 'file')) {
    const r = await projectUi.confirmFiles(title, intro, items, { backupAvailable: !!bridge?.backupFile });
    if (!r) return null;
    choice = r;
  }
  let open = 0;
  let written = 0;
  const failed: string[] = [];
  for (const [i, c] of changes) {
    const sh = sheets[i]!;
    if (sh.source !== 'file') {
      if (editor.sessions.current.id === sh.sessionId) {
        editor.doc.transact(() => c.state);
        open += 1;
        continue;
      }
      const s = editor.sessions.all.find((x) => x.id === sh.sessionId);
      if (!s) {
        failed.push(`${sh.name} (tab closed)`);
        continue;
      }
      s.undo.push(s.state);
      s.redo = [];
      s.state = c.state;
      s.dirty = true;
      open += 1;
      continue;
    }
    if (!choice.files || !sh.path || !bridge) continue;
    try {
      if (choice.backup && bridge.backupFile) await bridge.backupFile(sh.path);
      const out = await bridge.saveDxf(sh.path, writeDxf(withoutUnusedLibraryBlocks(c.state)), sh.name);
      if (out) written += 1;
      else failed.push(sh.name);
    } catch (err) {
      failed.push(`${sh.name} (${(err as Error).message})`);
    }
  }
  if (open) editor.notify('file');
  return { open, written, failed };
}

function logCommit(editor: Editor, what: string, r: { open: number; written: number; failed: string[] } | null, skipped: string[]): void {
  if (!r) {
    editor.log(`${what}: cancelled, nothing changed.`);
    return;
  }
  editor.log(`${what}: ${r.open} open drawing(s) updated${r.written ? `, ${r.written} closed drawing file(s) saved` : ''}.`);
  if (r.failed.length) editor.log(`Not updated: ${r.failed.join(', ')}.`);
  if (skipped.length) editor.log(`Skipped: ${skipped.join(', ')}${canReadProjectFiles(editor) ? '' : ' (open them in tabs, or use the desktop app to update closed drawings)'}.`);
}

/** Text + attribute fingerprint of the cross-reference data of a state, to skip drawings where nothing changes. */
function xrefSignature(s: DrawingState): string {
  const parts: string[] = [];
  for (const e of s.entities) {
    if (e.layer === 'XREF' && e.type === 'text') parts.push(`${e.text}@${e.position.x.toFixed(3)},${e.position.y.toFixed(3)}`);
    else if (e.layer === 'XREF' && e.type === 'line') parts.push(`L${e.a.x.toFixed(3)},${e.a.y.toFixed(3)},${e.b.x.toFixed(3)},${e.b.y.toFixed(3)}`);
    else if (e.type === 'insert' && (e.attributes.XREF !== undefined || e.attributes.XREFNO !== undefined)) parts.push(`${e.id}:${e.attributes.XREF ?? ''}|${e.attributes.XREFNO ?? ''}|${e.attributes.XREFNC ?? ''}`);
  }
  return parts.sort().join(';');
}

/** Project cross-reference states for the sheets (only sheets whose cross-reference data changes). */
function projectXrefChanges(sheets: readonly ProjectSheet[]): { changes: Map<number, SheetChange>; entries: ProjectXrefEntry[] } {
  const entries = buildProjectXref(sheets);
  const changes = new Map<number, SheetChange>();
  sheets.forEach((s, i) => {
    const next = applyProjectXref(entries, s);
    if (xrefSignature(next) === xrefSignature(s.doc.snapshot)) return;
    const n = entries.filter((x) => (x.coil && x.coil.sheet === s) || x.contacts.some((c) => c.sheet === s)).length;
    changes.set(i, { state: next, detail: `${n} tag(s) cross-referenced` });
  });
  return { changes, entries };
}

function showXrefProblems(editor: Editor, sheets: readonly LoadedSheet[], problems: XrefProblem[]): void {
  const shown = problems.filter((p) => p.kind !== 'no-children');
  if (shown.length === 0) return;
  const r: Report = { title: 'Cross-Reference Problems', columns: ['Problem', 'Tag', 'Drawing', 'Rung', 'Detail'], rows: shown.map((p) => [p.kind === 'no-parent' ? 'No parent' : 'Duplicate parent', p.tag, p.sheet, p.ref, p.detail]) };
  const active = sheets.find((s) => s.source === 'active' && editor.sessions.current.id === s.sessionId);
  reportTableDialog(editor, r, {
    hint: `${shown.length} problem(s). Double-click a row on the current drawing (${active?.name ?? '-'}) to zoom to it.`,
    onRow: (i) => {
      const p = shown[i];
      if (!p || !active || p.sheet !== active.name) return;
      const hit = active.doc.entities.find((e): e is InsertEntity => e.type === 'insert' && e.attributes.TAG1 === p.tag && (nearestReference(active.doc, e.position) ?? '') === p.ref);
      if (hit) zoomTo(editor, hit.position, hit.id);
    },
  });
}

/** AEXREF project-wide. */
export async function runProjectXref(editor: Editor): Promise<void> {
  editor.log('Cross-referencing the project ...');
  const { sheets, skipped } = await loadProjectSheets(editor);
  const { changes, entries } = projectXrefChanges(sheets);
  const problems = xrefProblems(entries);
  const r = await commitSheets(editor, sheets, changes, 'Update Cross-References (Project)', `Coil / contact references across ${sheets.length} drawing(s): ${entries.length} tag(s).`);
  logCommit(editor, `Cross-references (${entries.length} tag(s) in ${sheets.length} drawing(s))`, r, skipped);
  recordProjectStatus(sheets, problems);
  editor.hooks.projectChanged?.();
  const bad = problems.filter((p) => p.kind !== 'no-children');
  if (bad.length) editor.log(`${bad.filter((p) => p.kind === 'no-parent').length} contact(s) without a parent, ${bad.filter((p) => p.kind === 'duplicate-parent').length} duplicate parent(s).`);
  if (r) projectUi.showProblems(editor, sheets, problems);
}

/** Rebuild sheet records over new states (for a second pass such as cross-referencing after a retag). */
function resheet(sheets: readonly LoadedSheet[], states: ReadonlyMap<number, DrawingState>, project: Editor['project']): LoadedSheet[] {
  return sheets.map((s, i) => {
    const st = states.get(i);
    if (!st) return s;
    const doc = new Drawing();
    doc.load(st, s.path);
    return { ...makeSheet(doc, { name: s.name, path: s.path, index: s.index, entrySheet: s.index >= 0 ? project.drawings[s.index]?.sheet : undefined, projectSettings: project.settings }), source: s.source, sessionId: s.sessionId };
  });
}

/** AERETAG project-wide (all tags, or only duplicates), followed by the project cross-reference. */
export async function runProjectRetag(editor: Editor, mode: 'all' | 'duplicates'): Promise<void> {
  const { sheets, skipped } = await loadProjectSheets(editor);
  const plan = planProjectRetag(sheets, mode);
  const tagged = new Map<number, DrawingState>();
  for (const [i, m] of plan.changes) tagged.set(i, withTags(sheets[i]!.doc.snapshot, m));
  const after = resheet(sheets, tagged, editor.project);
  const x = projectXrefChanges(after);
  const changes = new Map<number, SheetChange>();
  after.forEach((s, i) => {
    const n = plan.changes.get(i)?.size ?? 0;
    const st = x.changes.get(i)?.state ?? tagged.get(i);
    if (st) changes.set(i, { state: st, detail: n ? `${n} tag(s) changed` : 'cross-references only' });
  });
  if (plan.count === 0) editor.log(`RETAG (project, ${mode}): all tags already follow the format.`);
  const renamed = plan.renamed.slice(0, 8).map((r) => `${r.from || '(blank)'}->${r.to}`);
  const r = await commitSheets(editor, sheets, changes, `Retag Components (Project, ${mode === 'all' ? 'all tags' : 'duplicates only'})`, `${plan.count} component(s) get a new tag${renamed.length ? `: ${renamed.join(', ')}${plan.renamed.length > 8 ? ' ...' : ''}` : ''}. Fixed tags (TAGFIXED) are kept.`, true);
  logCommit(editor, `RETAG project (${plan.count} tag(s))`, r, skipped);
  if (r) recordProjectStatus(after, xrefProblems(x.entries));
  editor.hooks.projectChanged?.();
}

/** AEWIRENO project-wide. */
export async function runProjectWireNumbers(editor: Editor, perSheet: boolean): Promise<void> {
  const { sheets, skipped } = await loadProjectSheets(editor);
  const plan = planProjectWireNumbers(sheets, { perSheet });
  const changes = new Map<number, SheetChange>();
  for (const [i, texts] of plan) {
    const s = sheets[i]!;
    const before = s.doc.entities.filter((e) => e.type === 'text' && e.layer === WIRENO_LAYER).map((e) => (e.type === 'text' ? e.text : '')).sort().join(',');
    const now = texts.map((t) => t.text).sort().join(',');
    if (before === now && texts.length) continue;
    if (texts.length === 0 && !before) continue;
    changes.set(i, { state: withWireNumbers(s.doc.snapshot, texts), detail: `${texts.length} wire number(s)${perSheet ? ` from ${(parseInt(s.sheet, 10) || i + 1) * 100}` : ''}` });
  }
  const total = [...plan.values()].reduce((n, t) => n + t.length, 0);
  const r = await commitSheets(editor, sheets, changes, 'Wire Numbers (Project)', `${total} wire number(s), unique across ${sheets.length} drawing(s); fixed numbers are kept.`, true);
  logCommit(editor, `Wire numbers project-wide (${total})`, r, skipped);
}

const PLC_INPUT_BLOCKS = ['HPB11_NO', 'HLS11_NO', 'HPS11_NO', 'HFS11_NO', 'HTS11_NO', 'HPX11_NO', 'HSS11', 'HFL11_NO', 'HPE11_NO'];
const PLC_OUTPUT_BLOCKS = ['HCR1', 'HKM1', 'HSOL1', 'HLT1R', 'HSV1', 'HHN1', 'HMO1'];

/** Library block for a device tag on an AEPLCIO rung: the block whose family matches the tag prefix, else a push button / relay coil. */
export function plcDeviceBlock(tag: string, kind: 'input' | 'output'): string | null {
  const family = /^[A-Z]+/i.exec(tag)?.[0]?.toUpperCase() ?? '';
  const list = kind === 'input' ? [...PLC_INPUT_BLOCKS, ...PLC_OUTPUT_BLOCKS] : [...PLC_OUTPUT_BLOCKS, ...PLC_INPUT_BLOCKS];
  const hit = list.find((b) => tagPrefix(b) === family && !!findLibrarySymbol(b));
  const fallback = kind === 'input' ? 'HPB11_NO' : 'HCR1';
  return hit ?? (findLibrarySymbol(fallback) ? fallback : null);
}

/** Entities of several PLC modules placed side by side from `origin` (top-left of the first module). */
export function buildPlcModules(origin: Point, modules: PlcModuleSettings[]): Entity[] {
  const out: Entity[] = [];
  let x = origin.x;
  for (const m of modules) {
    const s = normalizePlcSettings(m);
    const reach = 0.75 + (s.rungs ? (s.rungLength ?? 3) : 0) + 1.2;
    if (s.kind === 'input') x += reach;
    out.push(...buildPlcModule({ x, y: origin.y }, s));
    x += 1.5 + (s.kind === 'output' ? reach : 0) + 0.8;
  }
  return out;
}

function zoomToRow(editor: Editor, row: LocationRow): void {
  zoomTo(editor, row.position, row.entityId);
}

function placeReport(editor: Editor, report: Report): void {
  if (!editor.doc.layer('REPORT')) editor.doc.addLayer({ name: 'REPORT', color: 7, visible: true, locked: false, lineWeight: 0.25 });
  editor.startTool(new PlaceTool('AEREPORTTABLE', (o) => reportToEntities(report, o), `Specify top-left corner for the ${report.title} table:`));
}

/** Run a report template: build (drawing or project), filter / sort / pick columns, then show, place or write CSV. */
export async function runReportTemplate(editor: Editor, t: ReportTemplate): Promise<void> {
  const def = REPORTS.find((r) => r.key === t.report);
  if (!def) {
    editor.log(`Report template ${t.name}: unknown report "${t.report}".`);
    return;
  }
  const base = t.projectWide ? mergeReports((await projectDocuments(editor)).map((d) => ({ drawing: d.name, report: def.build(d.doc) }))) : def.build(editor.doc);
  const r = applyTemplate(base, t);
  if (t.output === 'table') placeReport(editor, r);
  else if (t.output === 'csv') {
    const p = await saveCsv(editor, `${(t.title || t.name).replace(/[^A-Za-z0-9]+/g, '_')}.csv`, reportToCsv(r));
    if (p) editor.log(`Report ${t.name} saved: ${p}`);
  } else reportTableDialog(editor, r, { saveCsv: (n, c) => saveCsv(editor, n, c), putOnDrawing: (rep) => placeReport(editor, rep), hint: `${r.rows.length} row(s) — template ${t.name}` });
  editor.log(`Report template ${t.name}: ${r.rows.length} row(s).`);
}

/** Title block values for one sheet through the project mapping. */
function titleBlockChange(editor: Editor, s: ProjectSheet, state: DrawingState = s.doc.snapshot): { state: DrawingState; found: number; changed: number } {
  const m = projectMapping(editor.project);
  const values = titleBlockSources(editor.project, s.index, s.settings, s.name);
  return applyTitleBlockMapping(state, m, values);
}

function registerProjectCommands(editor: Editor): void {
  const reg = (name: string, aliases: string[], description: string, run: (ed: Editor, arg?: string) => void) => editor.register({ name, aliases, description, run });

  reg('AEXREFPROJECT', ['XREFPROJECT', 'AEXREFP'], 'Update coil/contact cross-references across all project drawings', (ed) => void runProjectXref(ed));
  reg('AERETAGPROJECT', ['RETAGPROJECT'], 'Retag components project-wide [All/Duplicates] (fixed tags are kept)', (ed, arg) => {
    const a = (arg ?? '').toUpperCase();
    if (a.startsWith('A') || a.startsWith('D')) {
      void runProjectRetag(ed, a.startsWith('D') ? 'duplicates' : 'all');
      return;
    }
    void electricalUi(ed)
      .pickList('Retag Components: project-wide', [
        { value: 'all', label: 'All components', detail: 'Renumber every tag in sheet and ladder order with each drawing\'s tag format' },
        { value: 'duplicates', label: 'Duplicates only', detail: 'Keep unique tags; retag repeated and blank tags only' },
      ], { detailHeader: 'What changes', okLabel: 'Next' })
      .then((m) => m && void runProjectRetag(ed, m === 'duplicates' ? 'duplicates' : 'all'));
  });
  reg('AEWIRENOPROJECT', ['WIRENOPROJECT'], 'Wire numbers project-wide, unique across drawings [Sheet-based/Drawing start]', (ed, arg) => {
    const a = (arg ?? '').toUpperCase();
    if (a.startsWith('S') || a.startsWith('D')) {
      void runProjectWireNumbers(ed, a.startsWith('S'));
      return;
    }
    void electricalUi(ed)
      .pickList('Wire Numbers: project-wide', [
        { value: 'sheet', label: 'Sheet-based start', detail: 'Sequential numbers start at sheet x 100 (sheet 3: 300, 301 ...); rung-based drawings keep rung numbers' },
        { value: 'drawing', label: 'Drawing start number', detail: 'Each drawing starts at its own WIRE_START; numbers stay unique across the project' },
      ], { detailHeader: 'Numbering', okLabel: 'Next' })
      .then((m) => m && void runProjectWireNumbers(ed, m === 'sheet'));
  });
  reg('AEFIXTAG', ['FIXTAG'], 'Toggle the fixed-tag flag (TAGFIXED) of the selected components; RETAG keeps fixed tags', (ed) => {
    const sel = [...ed.selection].map((id) => ed.doc.entity(id)).filter((e): e is InsertEntity => !!e && e.type === 'insert' && isComponent(e));
    if (sel.length === 0) {
      ed.log('Select components first, then AEFIXTAG.');
      return;
    }
    const fix = !sel.every((e) => isFixedTag(e));
    ed.doc.transact((s) => withInsertAttributes(s, new Map(sel.map((e) => [e.id, { [TAG_FIXED_ATTRIBUTE]: fix ? '1' : '' }]))));
    ed.log(`${sel.length} tag(s) ${fix ? 'fixed' : 'released'}: ${sel.map((e) => e.attributes.TAG1 ?? e.block).join(', ')}.`);
  });

  reg('AELOCVIEW', ['LOCVIEW', 'LOCATIONVIEW'], 'Location View: components by installation / location code, with CSV and zoom-to', (ed) => {
    const load = async () => {
      const { sheets, skipped } = await loadProjectSheets(ed);
      if (skipped.length) ed.log(`Location View: skipped ${skipped.join(', ')}.`);
      recordProjectStatus(sheets);
      ed.hooks.projectChanged?.();
      return { sheets, groups: locationView(sheets, { jumperText }) };
    };
    void load().then(({ sheets, groups }) => {
      const current = sheets.findIndex((s) => s.source === 'active');
      locationViewDialog(ed, groups, {
        currentSheet: current,
        zoomTo: (row) => zoomToRow(ed, row),
        saveCsv: (n, c) => saveCsv(ed, n, c),
        putOnDrawing: (r) => placeReport(ed, r),
        refresh: () => load().then((x) => x.groups),
        scopeLabel: sheets.length > 1 || ed.project.drawings.length ? `Project ${ed.project.name}: ${sheets.length} drawing(s)` : `Drawing ${ed.fileName()}`,
      });
    });
  });

  reg('AEPLCIO', ['PLCIO', 'PLCIMPORT'], 'PLC I/O from a spreadsheet (CSV / TSV): preview, then insert modules with point descriptions', (ed) => {
    void browserOpenTextFile('.csv,.tsv,.txt').then(async (file) => {
      if (!file) return;
      const parsed = parsePlcIo(file.text);
      for (const w of parsed.warnings.slice(0, 5)) ed.log(`AEPLCIO: ${w}`);
      if (parsed.rows.length === 0) {
        ed.log(`AEPLCIO: no I/O points in ${baseName(file.path)} (needs an Address column).`);
        return;
      }
      const res = await plcImportDialog(ed, parsed, DEFAULT_PLC_IMPORT, (n, c) => saveCsv(ed, n, c));
      if (!res) return;
      const spacing = res.options.spacing;
      const modules = modulesFromRows(res.rows, res.options).map((m) => ({ ...m, spacing, deviceBlock: plcDeviceBlock }));
      const blocks = new Set<string>();
      if (res.options.rungs) for (const m of modules) for (const p of m.io ?? []) if (p.device) blocks.add(plcDeviceBlock(p.device, m.kind) ?? '');
      ed.doc.ensureBlocks([...blocks].map((b) => findLibrarySymbol(b)).filter((b): b is NonNullable<typeof b> => !!b));
      if (!ed.doc.layer('WIREFIXED')) ed.doc.addLayer({ name: 'WIREFIXED', color: 3, visible: true, locked: false, lineWeight: 0.25 });
      ed.startTool(
        new PlaceTool('AEPLCIO', (o) => buildPlcModules(o, modules), `Specify top-left corner for ${modules.length} PLC module(s):`, () => {
          ed.log(`AEPLCIO: ${modules.length} module(s) with ${res.rows.length} point(s) inserted (${modules.map((m) => m.tag).join(', ')}).`);
        }),
      );
    });
  });
  reg('AEPLCIOEXPORT', ['PLCIOEXPORT'], 'Export the PLC I/O points of the drawing to a CSV spreadsheet (AEPLCIO format)', (ed) => {
    const rows = rowsFromPlcReport(plcIoReport(ed.doc).rows);
    if (rows.length === 0) {
      ed.log('No PLC I/O points in this drawing.');
      return;
    }
    void saveCsv(ed, 'PLC_IO.csv', plcRowsToCsv(rows)).then((p) => p && ed.log(`${rows.length} PLC I/O point(s) saved: ${p}`));
  });

  reg('AECABLE', ['CABLE', 'CABLEMARKER'], 'Assign wires to a cable: conductor numbers / colours and cable markers', (ed) => ed.startTool(new CableTool((n, init, existing) => cableDialog(init, n, existing))));
  reg('AECABLESCHEDULE', ['CABLESCHEDULE'], 'Cable schedule report (cables, conductors, from / to, wire numbers)', (ed) => openReports(ed, 'cables'));
  reg('AEJUMPER', ['JUMPER'], 'Jumper two terminals of a strip (recorded in both terminals\' JUMPER attribute)', (ed) => ed.startTool(new JumperTool()));
  reg('AEJUMPERDEL', ['JUMPERDEL', 'AEDELJUMPER'], 'Remove the jumpers of a terminal', (ed) => ed.startTool(new RemoveJumperTool()));

  reg('AEREPORTRUN', ['REPORTRUN'], 'Run a saved report template: AEREPORTRUN <name>', (ed, arg) => {
    const list = ed.project.reportTemplates ?? [];
    if (!arg) {
      if (list.length === 0) {
        ed.log('No report templates in the project (AEREPORTTEMPLATES creates them).');
        return;
      }
      void electricalUi(ed)
        .pickList('Run Report Template', list.map((t) => ({ value: t.name, label: t.name, detail: describeTemplate(t) })), { detailHeader: 'Template', okLabel: 'Run' })
        .then((n) => {
          const t = n ? findTemplate(ed.project, n) : undefined;
          if (t) void runReportTemplate(ed, t);
        });
      return;
    }
    const t = findTemplate(ed.project, arg);
    if (!t) ed.log(`No report template "${arg}" (templates: ${list.map((x) => x.name).join(', ') || 'none'}).`);
    else void runReportTemplate(ed, t);
  });
  reg('AEREPORTTEMPLATES', ['REPORTTEMPLATES', 'AEREPORTFORMAT'], 'Create / edit / run report templates (saved in the project file)', (ed) => {
    reportTemplatesDialog({
      templates: ed.project.reportTemplates ?? [],
      columnsOf: (key) => (REPORTS.find((r) => r.key === key) ?? REPORTS[0]!).build(ed.doc).columns,
      run: (t) => void runReportTemplate(ed, t),
      save: (list) => {
        ed.project = { ...ed.project, reportTemplates: list.length ? list : undefined };
        ed.hooks.projectChanged?.();
      },
      projectAvailable: ed.project.drawings.length > 0,
    });
  });

  reg('AETITLEBLOCKALL', ['TITLEBLOCKALL'], 'Update the title blocks of all project drawings from the project mapping', (ed) => void runTitleBlocksAll(ed));
  reg('AEWDTIMPORT', ['WDTIMPORT'], 'Import a title block mapping (.wdt) into the project', (ed) => {
    void browserOpenTextFile('.wdt,.txt').then((f) => {
      if (!f) return;
      const m = parseWdt(f.text);
      if (m.entries.length === 0) {
        ed.log(`${baseName(f.path)}: no ATTRIBUTE = SOURCE lines found.`);
        return;
      }
      ed.project = { ...ed.project, titleBlockMap: formatWdt(m) };
      ed.hooks.projectChanged?.();
      ed.log(`Title block mapping imported: ${m.entries.length} attribute(s)${m.blocks.length ? ` for ${m.blocks.join(', ')}` : ''} (PROJECTSAVE keeps it).`);
    });
  });
  reg('AEWDTEXPORT', ['WDTEXPORT'], 'Export the project title block mapping as a .wdt file', (ed) => {
    const text = formatWdt(projectMapping(ed.project));
    const name = `${ed.project.name.replace(/[^A-Za-z0-9_-]+/g, '_')}.wdt`;
    const save = ed.fileBridge?.saveText?.(name, text, 'Title block mapping', 'wdt') ?? saveCsv(ed, name, text);
    void save.then((p) => p && ed.log(`Title block mapping saved: ${p}`));
  });
}

/** AETITLEBLOCK for every project drawing (closed drawings saved after confirmation). */
export async function runTitleBlocksAll(editor: Editor): Promise<void> {
  const { sheets, skipped } = await loadProjectSheets(editor);
  const changes = new Map<number, SheetChange>();
  let missing = 0;
  sheets.forEach((s, i) => {
    const r = titleBlockChange(editor, s);
    if (!r.found) missing += 1;
    if (r.changed) changes.set(i, { state: r.state, detail: `${r.changed} title block(s)` });
  });
  const r = await commitSheets(editor, sheets, changes, 'Update Title Blocks (Project)', `Title block attributes from the project mapping for ${sheets.length} drawing(s).`);
  logCommit(editor, 'Title blocks', r, skipped);
  if (missing) editor.log(`${missing} drawing(s) have no title block matching the mapping.`);
}
