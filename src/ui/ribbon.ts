import type { Editor } from '../app/editor';
import { icon } from './icons';

interface RibbonButton {
  label: string;
  icon: string;
  command: string;
  size?: 'large' | 'small';
  tooltip?: string;
}

interface RibbonPanel {
  title: string;
  buttons: RibbonButton[];
  /** Small buttons are stacked 3 per column. */
  /** Dialog-launcher arrow in the panel title (AutoCAD's ↘): the settings dialog behind the panel. No launcher, no arrow. */
  launcher?: { command: string; tooltip: string };
}

interface RibbonTab {
  name: string;
  panels: RibbonPanel[];
}

const B = (label: string, ic: string, command: string, size: 'large' | 'small' = 'large', tooltip?: string): RibbonButton => ({
  label,
  icon: ic,
  command,
  size,
  tooltip,
});

export const RIBBON: RibbonTab[] = [
  {
    name: 'Home',
    panels: [
      {
        title: 'Draw',
        buttons: [
          B('Line', 'line', 'LINE'),
          B('Polyline', 'polyline', 'PLINE'),
          B('Circle', 'circle', 'CIRCLE'),
          B('Arc', 'arc', 'ARC'),
          B('Rectangle', 'rectangle', 'RECTANG', 'small'),
          B('Text', 'text', 'TEXT', 'small'),
          B('Distance', 'dist', 'DIST', 'small'),
          B('Spline', 'spline', 'SPLINE', 'small', 'Spline through fit points (SPLINE)'),
          B('Hatch', 'hatch', 'HATCH', 'small', 'Hatch an area: pick an internal point or select closed objects (HATCH)'),
        ],
      },
      {
        title: 'Modify',
        buttons: [
          B('Move', 'move', 'MOVE', 'small'),
          B('Copy', 'copy', 'COPY', 'small'),
          B('Rotate', 'rotate', 'ROTATE', 'small'),
          B('Erase', 'erase', 'ERASE', 'small'),
          B('Mirror', 'mirror', 'MIRROR', 'small'),
          B('Scale', 'scale', 'SCALE', 'small'),
          B('Trim', 'trim', 'TRIM', 'small'),
          B('Extend', 'extend', 'EXTEND', 'small'),
          B('Offset', 'offset', 'OFFSET', 'small'),
          B('Explode', 'explode', 'EXPLODE', 'small'),
          B('Undo', 'undo', 'UNDO', 'small'),
          B('Redo', 'redo', 'REDO', 'small'),
        ],
      },
      {
        title: 'Layers',
        buttons: [B('Layer\nProperties', 'layers', 'LAYER'), B('Properties', 'props', 'PROPERTIES', 'small'), B('Linetype', 'linetype', 'LINETYPE', 'small')],
        launcher: { command: 'LAYER', tooltip: 'Layer Properties Manager (LAYER)' },
      },
      {
        title: 'View',
        buttons: [
          B('Extents', 'zoomext', 'ZOOM E', 'small'),
          B('Window', 'zoomwin', 'ZOOM W', 'small'),
          B('Zoom In', 'zoomin', 'ZOOM I', 'small'),
          B('Zoom Out', 'zoomout', 'ZOOM O', 'small'),
          B('Grid', 'grid', 'GRID', 'small'),
          B('Snap', 'snap', 'SNAP', 'small'),
          B('Ortho', 'ortho', 'ORTHO', 'small'),
        ],
        launcher: { command: 'DSETTINGS', tooltip: 'Drafting Settings: snap, grid, polar, object snap (DSETTINGS)' },
      },
      {
        title: 'Utilities',
        buttons: [B('List', 'props', 'LIST', 'small'), B('Select All', 'check', 'SELECTALL', 'small'), B('Help', 'info', 'HELP', 'small'), B('Area', 'area', 'AREA', 'small'), B('ID Point', 'id', 'ID', 'small'), B('Quick Select', 'qselect', 'QSELECT', 'small')],
      },
      // ---- drafting parity panels
      {
        title: 'Draw More',
        buttons: [
          B('Ellipse', 'ellipse', 'ELLIPSE', 'small'),
          B('Polygon', 'polygon', 'POLYGON', 'small'),
          B('Donut', 'donut', 'DONUT', 'small'),
          B('Point', 'point', 'POINT', 'small'),
          B('Xline', 'xline', 'XLINE', 'small'),
          B('Ray', 'ray', 'RAY', 'small'),
        ],
      },
      {
        title: 'Modify More',
        buttons: [
          B('Fillet', 'fillet', 'FILLET', 'small'),
          B('Chamfer', 'chamfer', 'CHAMFER', 'small'),
          B('Array', 'array', 'ARRAY', 'small'),
          B('Stretch', 'stretch', 'STRETCH', 'small'),
          B('Break', 'break', 'BREAK', 'small'),
          B('Join', 'join', 'JOIN', 'small'),
          B('Lengthen', 'lengthen', 'LENGTHEN', 'small'),
          B('Align', 'alignobj', 'ALIGN', 'small'),
          B('Match', 'matchprop', 'MATCHPROP', 'small'),
        ],
      },
      {
        title: 'Block',
        buttons: [B('Insert', 'insert', 'INSERT'), B('Create', 'block', 'BLOCK', 'small'), B('Purge', 'purge', 'PURGE', 'small'), B('Explode', 'explode', 'EXPLODE', 'small')],
      },
    ],
  },
  {
    name: 'Annotate',
    panels: [
      {
        title: 'Text',
        buttons: [
          B('Multiline\nText', 'mtext', 'MTEXT'),
          B('Single Line', 'text', 'TEXT', 'small'),
          B('Lineweight', 'lw', 'LWEIGHT', 'small'),
          B('Linetype', 'linetype', 'LINETYPE', 'small'),
          B('Multileader', 'mleader', 'MLEADER', 'small', 'Multileader: arrowhead, landing and text (MLEADER)'),
          B('Leader', 'mleader', 'LEADER', 'small', 'Leader with annotation text (LEADER)'),
          B('Table', 'table', 'TABLE', 'small', 'Insert a table (TABLE)'),
          B('Edit Cell', 'edit', 'TABLEEDIT', 'small', 'Edit the text of a table cell (TABLEEDIT)'),
          B('Field', 'text', 'FIELD', 'small', 'Insert a field: date, file name, drawing properties (FIELD)'),
          B('Update\nFields', 'retag', 'UPDATEFIELD', 'small', 'Update fields in the selected objects (UPDATEFIELD)'),
        ],
      },
      {
        title: 'Dimensions',
        buttons: [
          B('Linear', 'dimlinear', 'DIMLINEAR'),
          B('Aligned', 'dimaligned', 'DIMALIGNED', 'small'),
          B('Angular', 'dimangular', 'DIMANGULAR', 'small'),
          B('Radius', 'dimradius', 'DIMRADIUS', 'small'),
          B('Diameter', 'dimdiameter', 'DIMDIAMETER', 'small'),
          B('Dim Style', 'props', 'DIMSTYLE', 'small'),
        ],
        launcher: { command: 'DIMSTYLE', tooltip: 'Dimension style (DIMSTYLE)' },
      },
      {
        title: 'Markup',
        buttons: [B('Distance', 'dist', 'DIST', 'small'), B('Area', 'area', 'AREA', 'small'), B('List', 'props', 'LIST', 'small'), B('Hatch', 'hatch', 'HATCH', 'small'), B('Edit Hatch', 'edit', 'HATCHEDIT', 'small', 'Change hatch pattern, scale or angle (HATCHEDIT)')],
      },
    ],
  },
  {
    name: 'Project',
    panels: [
      {
        title: 'Project Tools',
        buttons: [B('Manager', 'project', 'TOGGLEPM'), B('New\nDrawing', 'new', 'NEWSHEET'), B('Open\nProject', 'open', 'OPENPROJECT'), B('Open', 'open', 'OPEN', 'small'), B('Save', 'save', 'SAVE', 'small'), B('Save As', 'saveas', 'SAVEAS', 'small')],
      },
      {
        title: 'Other Tools',
        buttons: [B('Drawing\nProperties', 'dwgprops', 'AEDRAWINGPROPS'), B('Plot to\nPDF', 'plot', 'PLOT'), B('Print', 'plot', 'PRINT', 'small'), B('Add to\nProject', 'plus', 'PROJECTADD', 'small'), B('Save\nProject', 'save', 'PROJECTSAVE', 'small'), B('Wire\nNumbers', 'wireno', 'AEWIRENO', 'small')],
      },
      {
        title: 'Project Data',
        buttons: [B('Title\nBlock', 'titleblock', 'AETITLEBLOCK'), B('Project\nProperties', 'settings', 'AEPROJECTPROPS', 'small'), B('Load\nCatalog', 'catalog', 'AECATALOGLOAD', 'small'), B('Catalog\nPacks', 'catalog', 'AEPACKS', 'small', 'Catalog packs: install or remove signed manufacturer catalogs  (AEPACKS)'), B('Retag', 'retag', 'AERETAG', 'small')],
      },
      {
        title: 'Project-Wide',
        buttons: [
          B('Location\nView', 'tree', 'AELOCVIEW', 'large', 'Location View: components by installation / location code (AELOCVIEW)'),
          B('Xref Project', 'swap', 'AEXREFPROJECT', 'small', 'Update coil / contact cross-references across all project drawings (AEXREFPROJECT)'),
          B('Retag Project', 'retag', 'AERETAGPROJECT', 'small', 'Retag components project-wide; fixed tags are kept (AERETAGPROJECT)'),
          B('Wire Nos Project', 'wireno', 'AEWIRENOPROJECT', 'small', 'Wire numbers project-wide, unique across drawings (AEWIRENOPROJECT)'),
          B('Report\nTemplates', 'report', 'AEREPORTTEMPLATES', 'small', 'Create, edit and run report templates (AEREPORTTEMPLATES)'),
          B('Title Blocks\nAll', 'titleblock', 'AETITLEBLOCKALL', 'small', 'Update the title blocks of all project drawings (AETITLEBLOCKALL)'),
        ],
      },
    ],
  },
  {
    name: 'Schematic',
    panels: [
      {
        title: 'Insert Wires/Wire Numbers',
        buttons: [
          B('Wire', 'wire', 'AEWIRE'),
          B('Ladder', 'ladder', 'AELADDER'),
          B('Wire\nNumbers', 'wireno', 'AEWIRENO'),
          B('Multiple\nBus', 'wiremulti', 'AEMULTIBUS', 'small'),
          B('Trim Wire', 'trim', 'AETRIMWIRE', 'small'),
          B('Scoot', 'scoot', 'AESCOOT', 'small'),
          B('Wire Gap', 'gap', 'AEWIREGAP', 'small'),
          B('Wire Loop', 'loop', 'AEWIRELOOP', 'small'),
          B('Align', 'align', 'AEALIGN', 'small'),
        ],
      },
      {
        title: 'Insert Components',
        buttons: [
          B('Icon\nMenu', 'component', 'AECOMPONENT'),
          B('Push\nButton', 'pushbutton', 'AECOMPONENT HPB11_NO', 'small'),
          B('Coil', 'coil', 'AECOMPONENT HCR1', 'small'),
          B('Contact', 'contact', 'AECOMPONENT HCR1_NO', 'small'),
          B('Pilot Light', 'light', 'AECOMPONENT HLT1R', 'small'),
          B('Motor', 'motor', 'AECOMPONENT HMO1', 'small'),
          B('Fuse', 'fuse', 'AECOMPONENT HFU1', 'small'),
          B('Terminal', 'terminal', 'AECOMPONENT HT0001', 'small'),
          B('Ground', 'ground', 'AECOMPONENT HGND', 'small'),
          B('PLC Point', 'plc', 'AECOMPONENT HPLCI', 'small'),
          B('Child\nContact', 'child', 'AECHILD', 'small'),
          B('3 Phase', 'threephase', 'AECOMPONENT3', 'small'),
          B('Catalog\nBrowser', 'catalog', 'AECATALOG', 'small'),
          B('Circuit\nBuilder', 'circuit', 'AECIRCUIT'),
          B('Symbol\nBuilder', 'symbolbuilder', 'AESYMBUILDER', 'large', 'Symbol Builder: create or edit a schematic symbol and save it to the user library  (AESYMBUILDER)'),
        ],
      },
      {
        title: 'Edit Components',
        buttons: [
          B('Edit', 'edit', 'AEEDITCOMPONENT'),
          B('Move\nComponent', 'move', 'MOVE', 'small'),
          B('Copy\nComponent', 'copy', 'COPY', 'small'),
          B('Delete\nComponent', 'erase', 'ERASE', 'small'),
          B('Toggle NO/NC', 'toggle', 'AETOGGLENC', 'small'),
          B('Swap Block', 'swap', 'AESWAP', 'small'),
          B('Retag', 'retag', 'AERETAG', 'small'),
        ],
      },
      {
        title: 'Edit Wires/Wire Numbers',
        buttons: [
          B('Edit Wire\nNumber', 'edit', 'AEEDITWIRENO', 'small'),
          B('Wire Type', 'wiremulti', 'AEWIRETYPE', 'small'),
          B('Explode', 'explode', 'EXPLODE', 'small'),
          B('Copy Wire\nNumber', 'copyno', 'AECOPYWIRENO', 'small'),
          B('Wire No.\nLeader', 'wireleader', 'AEWIRENOLEADER', 'small'),
          B('Update\nBlocks', 'swap', 'AEUPDATEBLOCK', 'small'),
        ],
      },
      {
        title: 'Cables/Jumpers/PLC I/O',
        buttons: [
          B('Cable\nMarker', 'wiremulti', 'AECABLE', 'small', 'Cable Marker: assign wires to a cable with conductor numbers / colours (AECABLE)'),
          B('Cable\nSchedule', 'report', 'AECABLESCHEDULE', 'small', 'Cable schedule report (AECABLESCHEDULE)'),
          B('Jumper', 'loop', 'AEJUMPER', 'small', 'Jumper two terminals of a strip (AEJUMPER)'),
          B('Delete\nJumper', 'erase', 'AEJUMPERDEL', 'small', 'Remove the jumpers of a terminal (AEJUMPERDEL)'),
          B('PLC I/O\nImport', 'plc', 'AEPLCIO', 'small', 'PLC I/O Import: insert PLC modules from a CSV / TSV spreadsheet (AEPLCIO)'),
          B('PLC I/O\nExport', 'saveas', 'AEPLCIOEXPORT', 'small', 'Export the PLC I/O points of the drawing to CSV (AEPLCIOEXPORT)'),
        ],
      },
      {
        title: 'Other Tools',
        buttons: [
          B('Cross\nReference', 'swap', 'AEXREF'),
          B('PLC\nModule', 'plc', 'AEPLC'),
          B('Source\nArrow', 'extend', 'AESOURCE', 'small'),
          B('Dest.\nArrow', 'offset', 'AEDEST', 'small'),
          B('Properties', 'props', 'PROPERTIES', 'small'),
          B('Electrical\nAudit', 'audit', 'AEAUDIT', 'small'),
          B('Drawing\nProperties', 'dwgprops', 'AEDRAWINGPROPS', 'small'),
          B('Retag', 'retag', 'AERETAG', 'small'),
        ],
      },
    ],
  },
  {
    name: 'Panel',
    panels: [
      {
        title: 'Insert Component Footprints',
        buttons: [B('Schematic\nList', 'footprint', 'AESCHEMATICLIST'), B('Footprint', 'footprint', 'AEFOOTPRINT', 'small'), B('Balloon', 'balloon', 'AEBALLOON', 'small'), B('Nameplate', 'nameplate', 'AENAMEPLATE', 'small')],
      },
      {
        title: 'Terminal Footprints',
        buttons: [B('Terminal\nStrip', 'strip', 'AETERMSTRIP'), B('Terminal', 'terminal', 'AECOMPONENT HT0001', 'small'), B('Editor', 'edit', 'AETERMEDIT', 'small')],
      },
      {
        title: 'Panel Layout',
        buttons: [
          B('Enclosure', 'enclosure', 'AEPANEL', 'large', 'Enclosure outline with mounting plate and door swing (AEPANEL)'),
          B('DIN Rail', 'dinrail', 'AEDINRAIL', 'small', 'DIN rail (TS35 / TS32 / TS15) (AEDINRAIL)'),
          B('Wire Duct', 'wireduct', 'AEWIREDUCT', 'small', 'Wire duct run with its cover lines (AEWIREDUCT)'),
          B('Plate Grid', 'grid', 'AEPANELGRID', 'small', 'Mounting plate with a layout grid (AEPANELGRID)'),
          B('Align\nFootprints', 'align', 'AEFOOTPRINTALIGN', 'small', 'Align selected footprints on a DIN rail (AEFOOTPRINTALIGN)'),
          B('Terminal\nStrip FP', 'strip', 'AETERMFOOTPRINT', 'small', 'Terminal strip footprint numbered from the terminal strip table (AETERMFOOTPRINT)'),
          B('Panel\nHardware', 'report', 'AEPANELHW', 'small', 'List DIN rail, duct, enclosure and plate hardware with total lengths (AEPANELHW)'),
        ],
      },
      { title: 'Other Tools', buttons: [B('Panel\nReports', 'report', 'AEREPORT panel'), B('Terminal\nReport', 'terminal', 'AEREPORT terminals', 'small'), B('Strip\nReport', 'strip', 'AEREPORT strip', 'small'), B('Audit', 'audit', 'AEAUDIT', 'small')] },
    ],
  },
  {
    name: 'Reports',
    panels: [
      {
        title: 'Schematic',
        buttons: [
          B('Reports', 'report', 'AEREPORT bom'),
          B('Bill of\nMaterial', 'report', 'AEREPORT bom', 'small'),
          B('Component\nReport', 'report', 'AEREPORT components', 'small'),
          B('Wire\nFrom/To', 'wire', 'AEREPORT wires', 'small'),
          B('Wire\nLabels', 'wireno', 'AEREPORT labels', 'small'),
          B('PLC I/O\nAddress', 'plc', 'AEREPORT plc', 'small'),
          B('Missing\nCatalog', 'catalog', 'AEREPORT missing', 'small'),
        ],
      },
      {
        title: 'Panel',
        buttons: [B('Reports', 'report', 'AEREPORT panel'), B('Terminal\nReport', 'terminal', 'AEREPORT terminals', 'small'), B('Terminal\nStrip', 'strip', 'AEREPORT strip', 'small'), B('Panel\nComponents', 'footprint', 'AEREPORT panel', 'small'), B('Panel\nHardware', 'dinrail', 'AEREPORT panelhw', 'small', 'Panel hardware report: DIN rail, duct, enclosure and plate with lengths (AEREPORT panelhw)')],
      },
      { title: 'Audit', buttons: [B('Electrical\nAudit', 'audit', 'AEAUDIT'), B('Audit\nReport', 'check', 'AEREPORT audit', 'small')] },
    ],
  },
  {
    name: 'Import/Export Data',
    panels: [
      { title: 'Import', buttons: [B('From\nDXF', 'open', 'OPEN')] },
      { title: 'Export', buttons: [B('To DXF', 'saveas', 'SAVEAS'), B('Save', 'save', 'SAVE', 'small')] },
    ],
  },
  {
    name: 'Conversion Tools',
    panels: [{ title: 'Convert', buttons: [B('Explode', 'explode', 'EXPLODE'), B('Line to\nWire', 'wire', 'LINE2WIRE', 'small')] }],
  },
  {
    name: 'Add-ins',
    panels: [{ title: 'Apps', buttons: [B('Command\nList', 'info', 'HELP'), B('Report\nProblem', 'info', 'REPORTBUG')] }],
  },
  {
    name: 'View',
    panels: [
      { title: 'Navigate 2D', buttons: [B('Pan', 'pan', 'PAN'), B('Zoom\nExtents', 'zoomext', 'ZOOM E'), B('Window', 'zoomwin', 'ZOOM W', 'small'), B('Zoom In', 'zoomin', 'ZOOM I', 'small'), B('Zoom Out', 'zoomout', 'ZOOM O', 'small')] },
      { title: 'Palettes', buttons: [B('Project\nManager', 'project', 'TOGGLEPM'), B('Properties', 'props', 'PROPERTIES', 'small'), B('Layers', 'layers', 'LAYER', 'small')] },
      // ---- drafting parity panels
      { title: 'Views', buttons: [B('Previous', 'zoomprev', 'ZOOM P', 'small'), B('Zoom All', 'zoomext', 'ZOOM A', 'small'), B('Named\nViews', 'view', 'VIEW', 'small'), B('Units', 'units', 'UNITS', 'small'), B('Limits', 'grid', 'LIMITS', 'small'), B('Regen', 'redo', 'REGEN', 'small')] },
      // ---- paper-space layouts (Track E, tools/layouts.ts)
      { title: 'Layout', buttons: [B('New\nLayout', 'plus', 'LAYOUT N'), B('From\nTemplate', 'titleblock', 'LAYOUTWIZARD'), B('Page Setup', 'settings', 'PAGESETUP', 'small'), B('Viewport', 'view', 'MVIEW', 'small'), B('Lock Viewport', 'lock', 'MVIEW L', 'small'), B('Model Space', 'model', 'MSPACE', 'small'), B('Paper Space', 'rectangle', 'PSPACE', 'small'), B('Model Tab', 'house', 'MODEL', 'small')] },
    ],
  },
];

/** Ribbon tabs that belong to the Electrical workspace (hidden in "Drafting & Annotation"). */
export const ELECTRICAL_TABS = ['Project', 'Schematic', 'Panel', 'Reports', 'Import/Export Data', 'Conversion Tools'];

let currentRibbon: Ribbon | null = null;

/** Activate a ribbon tab by name from modules that do not hold the Ribbon instance (e.g. the Symbol Builder shows Schematic). */
export function showRibbonTab(name: string): boolean {
  const i = RIBBON.findIndex((t) => t.name === name);
  if (i < 0 || !currentRibbon) return false;
  currentRibbon.showTab(i);
  return true;
}

export class Ribbon {
  readonly el: HTMLElement;
  private active = 0;
  private tabsEl: HTMLElement;
  private bodyEl: HTMLElement;
  /** Extra controls appended to a data-table panel, keyed "Tab/Panel" (e.g. the layer dropdown). */
  readonly customPanelContent = new Map<string, HTMLElement>();
  /** Whole panels inserted after a named panel (e.g. Home > Properties combos). */
  readonly extraPanels: Array<{ tab: string; after: string; title: string; el: HTMLElement }> = [];
  /** Workspace filter: tabs for which this returns false are not shown. */
  tabFilter: (name: string) => boolean = () => true;

  constructor(private editor: Editor, container: HTMLElement) {
    this.el = container;
    this.el.className = 'ribbon';
    this.tabsEl = document.createElement('div');
    this.tabsEl.className = 'ribbon-tabs';
    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'ribbon-body';
    this.el.append(this.tabsEl, this.bodyEl);
    this.setActive(2); // Schematic tab is the natural home for an electrical workspace
    currentRibbon = this;
  }

  /** Active tab index. */
  get activeTab(): number {
    return this.active;
  }

  /** Show a tab (no-op when it is already active or hidden by the workspace filter). */
  showTab(i: number): void {
    if (i === this.active || !RIBBON[i] || !this.tabFilter(RIBBON[i]!.name)) return;
    this.setActive(i);
  }

  onTabChange: ((i: number) => void) | null = null;

  setActive(i: number): void {
    this.active = Math.max(0, Math.min(RIBBON.length - 1, i));
    if (!this.tabFilter(RIBBON[this.active]!.name)) {
      const first = RIBBON.findIndex((t) => this.tabFilter(t.name));
      if (first >= 0) this.active = first;
    }
    this.renderTabs();
    this.renderBody();
    this.onTabChange?.(this.active);
  }

  /** Re-render after the workspace filter or custom content changed. */
  refresh(): void {
    this.setActive(this.active);
  }

  private renderTabs(): void {
    this.tabsEl.innerHTML = '';
    RIBBON.forEach((tab, i) => {
      if (!this.tabFilter(tab.name)) return;
      const b = document.createElement('button');
      b.className = 'ribbon-tab' + (i === this.active ? ' active' : '');
      b.textContent = tab.name;
      b.addEventListener('click', () => this.setActive(i));
      this.tabsEl.appendChild(b);
    });
    const spacer = document.createElement('div');
    spacer.className = 'ribbon-tabs-spacer';
    this.tabsEl.appendChild(spacer);
    const min = document.createElement('button');
    min.className = 'ribbon-tab ribbon-min';
    min.innerHTML = icon('chevron');
    min.title = 'Minimize ribbon';
    min.addEventListener('click', () => this.el.classList.toggle('collapsed'));
    this.tabsEl.appendChild(min);
  }

  private renderBody(): void {
    this.bodyEl.innerHTML = '';
    const tab = RIBBON[this.active]!;
    for (const panel of tab.panels) {
      const p = document.createElement('div');
      p.className = 'ribbon-panel';
      const content = document.createElement('div');
      content.className = 'ribbon-panel-content';
      let smallCol: HTMLElement | null = null;
      for (const btn of panel.buttons) {
        const b = document.createElement('button');
        b.className = `ribbon-btn ${btn.size === 'small' ? 'small' : 'large'}`;
        b.title = btn.tooltip ?? `${btn.label.replace('\n', ' ')}  (${btn.command})`;
        b.innerHTML = `<span class="ribbon-icon">${icon(btn.icon)}</span><span class="ribbon-label">${btn.label.replace('\n', btn.size === 'small' ? ' ' : '<br>')}</span>`;
        b.addEventListener('click', () => this.editor.runCommand(btn.command));
        if (btn.size === 'small') {
          if (!smallCol || smallCol.childElementCount >= 3) {
            smallCol = document.createElement('div');
            smallCol.className = 'ribbon-small-col';
            content.appendChild(smallCol);
          }
          smallCol.appendChild(b);
        } else {
          smallCol = null;
          content.appendChild(b);
        }
      }
      const custom = this.customPanelContent.get(`${tab.name}/${panel.title}`);
      if (custom) content.appendChild(custom);
      const title = document.createElement('div');
      title.className = 'ribbon-panel-title';
      title.innerHTML = `<span>${panel.title}</span>`;
      if (panel.launcher) {
        const launch = document.createElement('button');
        launch.className = 'panel-arrow';
        launch.title = panel.launcher.tooltip;
        launch.innerHTML = icon('chevron');
        const cmd = panel.launcher.command;
        launch.addEventListener('click', () => this.editor.runCommand(cmd));
        title.appendChild(launch);
      }
      p.append(content, title);
      this.bodyEl.appendChild(p);
      for (const extra of this.extraPanels) {
        if (extra.tab !== tab.name || extra.after !== panel.title) continue;
        const ep = document.createElement('div');
        ep.className = 'ribbon-panel';
        const ec = document.createElement('div');
        ec.className = 'ribbon-panel-content';
        ec.appendChild(extra.el);
        const et = document.createElement('div');
        et.className = 'ribbon-panel-title';
        et.innerHTML = `<span>${extra.title}</span>`;
        ep.append(ec, et);
        this.bodyEl.appendChild(ep);
      }
    }
  }
}
