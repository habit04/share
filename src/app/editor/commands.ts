/**
 * The built-in commands (drawing and modify tools, toggles, zoom, files, electrical basics,
 * project, plot) and the registration of the other command sets (drafting, electrical, Symbol
 * Builder, units, panel, layouts). The Editor registers them when it is created.
 */
import { LineTool, PolylineTool, CircleTool, ArcTool, RectangleTool, TextTool } from '../../tools/draw';
import { EraseTool, MoveTool, CopyTool, RotateTool, DistTool } from '../../tools/modify';
import { WireTool, LadderTool, ComponentTool, assignWireNumbers } from '../../tools/electrical';
import { TrimTool, ExtendTool, OffsetTool, MirrorTool, ScaleTool, ExplodeTool, ZoomWindowTool, PanTool } from '../../tools/edit';
import { updateCrossReferences } from '../../electrical/xref';
import { newFromTemplate, SHEET_SIZES } from '../../electrical/templates';
import { PlcModuleTool, SignalArrowTool, TerminalStripTool, DEFAULT_PLC, DEFAULT_STRIP } from '../../tools/plc';
import { registerElectricalCommands } from '../commands-electrical';
import { registerDraftingCommands } from '../commands-drafting';
import { registerSymbolBuilderCommands } from '../../tools/symbol-builder';
import { registerUnitCommands } from '../../electrical/wdm';
import { registerPanelCommands } from '../../tools/panel';
// Track E: paper-space layouts (commands, controller, space switching).
import { registerLayoutCommands } from '../../tools/layouts';
import type { CommandDef } from './types';
import type { Editor } from './editor';
import { fallbackUi } from './internals';

export function registerBuiltinCommands(ed: Editor): void {
  const reg = (name: string, aliases: string[], description: string, run: (ed: Editor, arg?: string) => void) =>
    ed.register({ name, aliases, description, run });

  reg('LINE', ['L'], 'Draw line segments', (ed) => ed.startTool(new LineTool()));
  reg('PLINE', ['PL'], 'Draw a polyline', (ed) => ed.startTool(new PolylineTool()));
  reg('CIRCLE', ['C'], 'Draw a circle', (ed) => ed.startTool(new CircleTool()));
  reg('ARC', ['A'], 'Draw a 3-point arc', (ed) => ed.startTool(new ArcTool()));
  reg('RECTANG', ['REC', 'RECTANGLE'], 'Draw a rectangle', (ed) => ed.startTool(new RectangleTool()));
  reg('TEXT', ['T', 'DT', 'DTEXT'], 'Single-line text', (ed) => ed.startTool(new TextTool()));
  reg('ERASE', ['E', 'DEL'], 'Erase objects', (ed) => ed.startTool(new EraseTool()));
  reg('MOVE', ['M'], 'Move objects', (ed) => ed.startTool(new MoveTool()));
  reg('COPY', ['CO', 'CP'], 'Copy objects', (ed) => ed.startTool(new CopyTool()));
  reg('ROTATE', ['RO'], 'Rotate objects', (ed) => ed.startTool(new RotateTool()));
  reg('DIST', ['DI'], 'Measure distance', (ed) => ed.startTool(new DistTool()));
  reg('TRIM', ['TR'], 'Trim objects at cutting edges', (ed) => ed.startTool(new TrimTool()));
  reg('EXTEND', ['EX'], 'Extend lines to boundary edges', (ed) => ed.startTool(new ExtendTool()));
  reg('OFFSET', ['O'], 'Offset lines, arcs, circles, polylines', (ed) => ed.startTool(new OffsetTool()));
  reg('MIRROR', ['MI'], 'Mirror objects about a line', (ed) => ed.startTool(new MirrorTool()));
  reg('SCALE', ['SC'], 'Scale objects about a base point', (ed) => ed.startTool(new ScaleTool()));
  reg('EXPLODE', ['X'], 'Explode blocks and polylines', (ed) => ed.startTool(new ExplodeTool()));
  reg('PAN', ['P'], 'Pan: drag with the left button (or any time with the middle button); Esc ends', (ed) => ed.startTool(new PanTool()));
  reg('LWDISPLAY', ['LW'], 'Toggle lineweight display', (ed) => ed.toggle('lw'));
  reg('DYNMODE', ['DYN', 'F12'], 'Toggle dynamic input', (ed) => ed.toggle('dyn'));
  reg('CURSORSIZE', [], 'Crosshair size in percent of screen (5-100)', (ed, arg) => {
    const v = parseInt(arg ?? '', 10);
    if (Number.isFinite(v) && v >= 1 && v <= 100) {
      ed.viewport.settings.crosshairSize = v;
      ed.render();
    } else ed.log(`CURSORSIZE = ${ed.viewport.settings.crosshairSize} (enter 1-100)`);
  });
  reg('LINE2WIRE', [], 'Convert selected lines to wires', (ed) => {
    const lines = ed.entitiesSelected().filter((e) => e.type === 'line');
    if (lines.length === 0) {
      ed.log('Select lines first.');
      return;
    }
    ed.doc.replaceEntities(lines.map((e) => ({ ...e, layer: 'WIRES', color: 'ByLayer' as const })));
    ed.log(`${lines.length} line(s) converted to wires.`);
  });
  reg('UNDO', ['U'], 'Undo last action', (ed) => {
    if (!ed.doc.undo()) ed.log('Nothing to undo.');
  });
  reg('REDO', ['MREDO'], 'Redo', (ed) => {
    if (!ed.doc.redo()) ed.log('Nothing to redo.');
  });
  reg('ZOOM', ['Z'], 'Zoom [Extents/All/In/Out]', (ed, arg) => {
    const a = (arg ?? 'E').toUpperCase();
    if (a.startsWith('E') || a.startsWith('A')) ed.zoomExtents();
    else if (a.startsWith('W')) {
      ed.startTool(
        new ZoomWindowTool((b) => {
          ed.viewport.zoomToBounds(b, 0.02);
          ed.render();
          ed.notify('view');
        }),
      );
      return;
    } else if (a.startsWith('I')) ed.viewport.zoomAt({ x: ed.viewport.width / 2, y: ed.viewport.height / 2 }, 1.5);
    else if (a.startsWith('O')) ed.viewport.zoomAt({ x: ed.viewport.width / 2, y: ed.viewport.height / 2 }, 1 / 1.5);
    else ed.log('Zoom options: Extents, All, Window, In, Out');
    ed.render();
    ed.notify('view');
  });
  reg('REGEN', ['RE'], 'Regenerate display', (ed) => ed.render());
  reg('GRID', ['F7'], 'Toggle grid', (ed) => ed.toggle('grid'));
  reg('SNAP', ['F9'], 'Toggle grid snap', (ed) => ed.toggle('gridSnap'));
  reg('ORTHO', ['F8'], 'Toggle ortho', (ed) => ed.toggle('ortho'));
  reg('POLAR', ['F10'], 'Toggle polar tracking', (ed) => ed.toggle('polar'));
  reg('OSNAP', ['F3', 'OS'], 'Toggle object snap', (ed) => ed.toggle('osnap'));
  reg('SELECTALL', ['ALL'], 'Select all objects', (ed) => {
    ed.selection = new Set(ed.doc.entities.map((e) => e.id));
    ed.notify('selection');
    ed.render();
  });
  reg('NEW', ['QNEW'], 'New drawing', (ed) => ed.newDrawing());
  reg('OPEN', [], 'Open a DXF or DWG drawing', (ed, arg) => void ed.openFile(arg));
  reg('SAVE', ['QSAVE'], 'Save drawing (DXF)', (ed) => void ed.saveFile(false));
  reg('SAVEAS', [], 'Save drawing as (DXF)', (ed) => void ed.saveFile(true));
  reg('IMPORTREPORT', [], 'Show what opening this drawing dropped, simplified or kept without showing', (ed) => ed.showImportReport(true));
  reg('LIST', ['LI'], 'List selected objects', (ed) => ed.listSelection());
  reg('HELP', ['?'], 'List commands', (ed) => {
    const seen = new Set<CommandDef>();
    for (const d of ed.commands.values()) {
      if (seen.has(d)) continue;
      seen.add(d);
      ed.log(`  ${d.name.padEnd(12)} ${d.aliases.length ? `(${d.aliases.join(', ')})` : ''}  ${d.description}`);
    }
  });
  // Electrical
  reg('AEWIRE', ['WIRE', 'W'], 'Insert wire', (ed) => ed.startTool(new WireTool(ed.wireLayer)));
  reg('AELADDER', ['LADDER'], 'Insert ladder', (ed) => ed.startTool(new LadderTool()));
  reg('AECOMPONENT', ['COMPONENT', 'CMP', 'AEC'], 'Insert component from icon menu', (ed, arg) => ed.startTool(new ComponentTool(arg)));
  reg('AEWIRENO', ['WIRENO'], 'Insert wire numbers', (ed, arg) => {
    const start = arg ? parseInt(arg, 10) : 100;
    const n = assignWireNumbers(ed.doc, Number.isFinite(start) ? start : 100);
    ed.log(`${n} wire number(s) assigned.`);
  });
  reg('LAYER', ['LA'], 'Layer properties', (ed) => ed.layerDialogRequested?.());
  reg('PROPERTIES', ['PR', 'CH', 'MO'], 'Properties palette', (ed) => ed.hooks.properties?.());
  reg('AEXREF', ['XREF'], 'Update coil/contact cross-references', (ed) => {
    const n = updateCrossReferences(ed.doc);
    ed.log(`Cross-references updated for ${n} tag(s).`);
  });
  reg('AEREPORT', ['REPORT', 'BOM'], 'Schematic reports [bom/components/wires/terminals/audit]', (ed, arg) => ed.hooks.reports?.((arg ?? 'bom').toLowerCase()));
  reg('AEPLC', ['PLC'], 'Insert parametric PLC I/O module', (ed) => ed.startTool(new PlcModuleTool((init) => ed.hooks.plc?.(init) ?? Promise.resolve(init ?? DEFAULT_PLC))));
  reg('AETERMSTRIP', ['TERMSTRIP'], 'Insert terminal strip', (ed) => ed.startTool(new TerminalStripTool((init) => ed.hooks.terminalStrip?.(init) ?? Promise.resolve(init ?? DEFAULT_STRIP))));
  reg('AESOURCE', ['SOURCE'], 'Insert source signal arrow', (ed) => ed.startTool(new SignalArrowTool('source', (t, l, i) => (ed.ui ?? fallbackUi).textInput(t, l, i))));
  reg('AEDEST', ['DEST'], 'Insert destination signal arrow', (ed) => ed.startTool(new SignalArrowTool('destination', (t, l, i) => (ed.ui ?? fallbackUi).textInput(t, l, i))));
  reg('AEWIRETYPE', ['WIRETYPE'], 'Choose the wire type (layer) for new wires', (ed) => {
    void (ed.hooks.wireType?.(ed.wireLayer) ?? Promise.resolve(null)).then((layer) => {
      if (layer) {
        ed.wireLayer = layer;
        ed.log(`Wire type set to ${layer}.`);
      }
    });
  });
  reg('NEWSHEET', ['TEMPLATE'], 'New drawing from a sheet template', (ed) => {
    void ed.confirmDiscardPublic().then((ok) => {
      if (!ok) return;
      void (ed.hooks.template?.() ?? Promise.resolve({ size: SHEET_SIZES[1]!, fields: {} })).then((r) => {
        if (!r) return;
        ed.loadState(newFromTemplate(r.size, r.fields), null);
        ed.doc.dirty = true;
        ed.log(`New ${r.size.name} sheet.`);
      });
    });
  });
  reg('OPENPROJECT', ['PROJECT'], 'Open a project file', (ed, arg) => void ed.openProject(arg));
  reg('NEWPROJECT', [], 'Start a new, empty project (asks to save changes to the current project first)', (ed, arg) => void ed.newProjectCommand(arg));
  reg('PROJECTADD', [], 'Add the current drawing to the project', (ed) => ed.addCurrentToProject());
  reg('PROJECTSAVE', [], 'Save the project file', (ed) => void ed.saveProject());
  reg('PROJECTSAVEAS', [], 'Save the project file under a new name or folder (drawing paths keep pointing at the same files)', (ed) => void ed.saveProject(true));
  reg('PLOT', ['PDF'], 'Plot the drawing to PDF', (ed) => void ed.plot());
  reg('PRINT', ['PRINTDRAWING'], 'Print the drawing (system print dialog)', (ed) => void ed.print());
  reg('RECENT', [], 'Open a recent file by index', (ed, arg) => {
    const i = parseInt(arg ?? '1', 10) - 1;
    const f = ed.settings.recentFiles[i];
    if (f && f.endsWith('.json')) void ed.openProject(f, { userChosen: ed.apiCommandDepth === 0 });
    else if (f) void ed.openFile(f);
    else ed.settings.recentFiles.forEach((r, k) => ed.log(`  ${k + 1}. ${r}`));
  });
  registerDraftingCommands(ed);
  registerElectricalCommands(ed);
  registerSymbolBuilderCommands(ed);
  registerUnitCommands(ed);
  registerPanelCommands(ed);
  registerLayoutCommands(ed);
}
