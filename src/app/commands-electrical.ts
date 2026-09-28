/**
 * AutoCAD Electrical-style commands: component data / tags, catalog,
 * parent-child, wire tools, panel layout, project + title block, reports
 * and the audit. Registered at the end of Editor.registerCommands; dialogs
 * come from `editor.hooks.electrical` (default: src/ui/electrical-dialogs.ts).
 */
import type { Editor } from './editor';
import type { Point } from '../core/geometry';
import type { Entity, InsertEntity } from '../core/entities';
import { Drawing } from '../core/document';
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
} from '../tools/electrical-wires';
import { FootprintTool, BalloonTool, NameplateTool } from '../tools/panel';
import { assignWireNumbers, DEFAULT_BUS } from '../electrical/wires';
import { readWdSettings, writeWdSettings, WD_M_BLOCK, type WdSettings } from '../electrical/wdm';
import { retagDrawing } from '../electrical/tags';
import { updateCrossReferences, parentCandidates, childBlockFor } from '../electrical/xref';
import { LIBRARY_BLOCKS } from '../electrical/library';
import { setUserCatalog, parseCatalog, userCatalogSize, catalogFamilyFor } from '../electrical/catalog';
import { schematicList, terminalStripTable, applyTerminalEdits, BALLOON_BLOCK, NAMEPLATE_BLOCK } from '../electrical/panel';
import { buildMotorCircuit, makeTagger, DEFAULT_CIRCUIT, type CircuitOptions } from '../electrical/circuits';
import { auditIssues } from '../electrical/audit';
import { REPORTS, reportToEntities, mergeReports, reportToCsv, type Report } from '../electrical/reports';
import { updateTitleBlock } from '../electrical/templates';
import { findRails, nearestReference, rungReferences } from '../electrical/ladder';
import { titleBlockFields, projectDrawingIndex, resolveDrawingPath, resolveProjectPath, baseName } from './project';
import { readDxf } from '../io/dxf';
import { convertDwg } from '../io/dwg';
import type { ElectricalUi } from '../electrical/ui';
import { createElectricalDialogs } from '../ui/electrical-dialogs';
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
  for (const d of editor.project.drawings) {
    const path = resolveDrawingPath(editor.project, d);
    if (path === editor.doc.filePath) continue;
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
    putOnDrawing: (report) => {
      if (!editor.doc.layer('REPORT')) editor.doc.addLayer({ name: 'REPORT', color: 7, visible: true, locked: false, lineWeight: 0.25 });
      editor.startTool(new PlaceTool('AEREPORTTABLE', (o) => reportToEntities(report, o), `Specify top-left corner for the ${report.title} table:`));
    },
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
        const kind = await ui().pickList(`Contact type for ${parent.attributes.TAG1}`, [
          { value: 'NO', label: 'Normally open', detail: childBlockFor(parent.block, 'NO') },
          { value: 'NC', label: 'Normally closed', detail: childBlockFor(parent.block, 'NC') },
        ]);
        if (!kind) return;
        ed.startTool(new ComponentTool(childBlockFor(parent.block, kind as 'NO' | 'NC'), ui, settings, parent.id));
      });
  });
  reg('AECOMPONENT3', ['COMPONENT3', 'AEC3'], 'Insert a 3-phase (3-pole) component onto a 3-wire bus', (ed, arg) => ed.startTool(new ThreePhaseComponentTool(arg, ui)));
  reg('AERETAG', ['RETAG'], 'Retag all components in ladder order with the drawing tag format', (ed, arg) => {
    const only = arg?.toUpperCase().startsWith('S') && ed.selection.size ? new Set(ed.selection) : undefined;
    const r = retagDrawing(ed.doc, settings(), only);
    if (r.count) updateCrossReferences(ed.doc, settings());
    ed.log(`RETAG: ${r.count} tag(s) updated${r.renamed.size ? ` (${[...r.renamed].slice(0, 6).map(([a, b]) => `${a}->${b}`).join(', ')}${r.renamed.size > 6 ? ', ...' : ''})` : ''}.`);
  });
  reg('AETOGGLENC', ['TOGGLENC'], 'Toggle a contact between NO and NC', (ed) => ed.startTool(new ToggleNcTool()));
  reg('AESWAP', ['SWAPBLOCK', 'AESWAPBLOCK'], 'Swap a component symbol, keeping its data', (ed) => ed.startTool(new SwapBlockTool()));
  reg('AEUPDATEBLOCK', ['UPDATEBLOCK'], 'Update symbol block definitions from the library', (ed) => {
    const lib = [...LIBRARY_BLOCKS, WD_M_BLOCK, BALLOON_BLOCK, NAMEPLATE_BLOCK];
    let n = 0;
    ed.doc.transact((s) => {
      const blocks = { ...s.blocks };
      for (const b of lib) {
        if (blocks[b.name] && blocks[b.name] !== b) {
          blocks[b.name] = b;
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

  // ---- wires
  reg('AETRIMWIRE', ['TRIMWIRE'], 'Trim a wire segment between components / junctions', (ed) => ed.startTool(new TrimWireTool()));
  reg('AEWIREGAP', ['WIREGAP'], 'Insert wire gaps at crossings', (ed) => ed.startTool(new WireGapTool('gap')));
  reg('AEWIRELOOP', ['WIRELOOP'], 'Insert wire jump-over loops at crossings', (ed) => ed.startTool(new WireGapTool('loop')));
  reg('AESCOOT', ['SCOOT'], 'Scoot: slide a component or wire number along its wire', (ed) => ed.startTool(new ScootTool()));
  reg('AEALIGN', ['ALIGN'], 'Align components with a reference [Vertical/Horizontal]', (ed, arg) => ed.startTool(new AlignTool(arg?.toUpperCase().startsWith('H') ? 'horizontal' : 'vertical')));
  reg('AEMULTIBUS', ['MULTIBUS', 'BUS'], 'Multiple bus: N parallel wires', (ed) => ed.startTool(new MultiBusTool((init) => ui().busSettings(init), { ...DEFAULT_BUS, layer: ed.wireLayer })));
  reg('AEWIRENO', ['WIRENO'], 'Insert wire numbers (fixed numbers are kept)', (ed, arg) => {
    const s = settings();
    const start = arg ? parseInt(arg, 10) : s.wireStart;
    const n = assignWireNumbers(ed.doc, { start: Number.isFinite(start) ? start : 100, position: s.wirePosition, format: s.wireFormat });
    ed.log(`${n} wire number(s) assigned.`);
  });
  reg('AEEDITWIRENO', ['EDITWIRENO'], 'Edit a wire number: fixed flag, position, find / replace', (ed) => ed.startTool(new WireNumberEditTool(ui)));
  reg('AECOPYWIRENO', ['COPYWIRENO'], 'Copy a wire number to another wire', (ed) => ed.startTool(new CopyWireNumberTool()));
  reg('AEWIRENOLEADER', ['WIRENOLEADER'], 'Move a wire number with a leader', (ed) => ed.startTool(new WireNumberLeaderTool()));
  reg('AEXREF', ['XREF'], 'Update coil/contact cross-references', (ed) => {
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
          const drawings = ed.project.drawings.map((d, i) => (i === idx ? { ...d, description: r.description || undefined, sheet: r.sheet || undefined, dwgno: r.dwgno || undefined } : d));
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
  reg('AETITLEBLOCK', ['UPDATETITLEBLOCK', 'TITLEBLOCK'], 'Update the title block from project and drawing properties', (ed) => {
    const s = readWdSettings(ed.doc);
    const idx = projectDrawingIndex(ed.project, ed.doc.filePath);
    const fields = titleBlockFields(ed.project, idx, s.drawingDescription, s.drawingNumber);
    if (s.sheet && idx < 0) fields.SHEET = s.sheet;
    if (!updateTitleBlock(ed.doc, fields)) ed.log('No title block in this drawing (use NEWSHEET for a sheet with a title block).');
    else ed.log(`Title block updated: ${Object.entries(fields).filter(([k]) => ['PROJECT', 'TITLE', 'SHEET', 'DWGNO'].includes(k)).map(([k, v]) => `${k}=${v}`).join(', ')}.`);
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
