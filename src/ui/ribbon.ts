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
        buttons: [B('Layer\nProperties', 'layers', 'LAYER'), B('Properties', 'props', 'PROPERTIES', 'small'), B('Plot', 'plot', 'PLOT', 'small')],
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
      },
      {
        title: 'Utilities',
        buttons: [B('List', 'props', 'LIST', 'small'), B('Select All', 'check', 'SELECTALL', 'small'), B('Help', 'info', 'HELP', 'small')],
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
        buttons: [B('Drawing\nProperties', 'dwgprops', 'AEDRAWINGPROPS'), B('Plot to\nPDF', 'plot', 'PLOT'), B('Add to\nProject', 'plus', 'PROJECTADD', 'small'), B('Save\nProject', 'save', 'PROJECTSAVE', 'small'), B('Reference\nNumbers', 'wireno', 'AEWIRENO', 'small')],
      },
      {
        title: 'Project Data',
        buttons: [B('Update\nTitle Block', 'titleblock', 'AETITLEBLOCK'), B('Project\nProperties', 'settings', 'AEPROJECTPROPS', 'small'), B('Load\nCatalog', 'catalog', 'AECATALOGLOAD', 'small'), B('Retag', 'retag', 'AERETAG', 'small')],
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
      { title: 'Other Tools', buttons: [B('Panel\nReports', 'report', 'AEREPORT panel'), B('Terminal\nReport', 'strip', 'AEREPORT strip', 'small'), B('Audit', 'audit', 'AEAUDIT', 'small')] },
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
        buttons: [B('Reports', 'report', 'AEREPORT panel'), B('Terminal\nReport', 'terminal', 'AEREPORT terminals', 'small'), B('Terminal\nStrip', 'strip', 'AEREPORT strip', 'small'), B('Panel\nComponents', 'footprint', 'AEREPORT panel', 'small')],
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
    panels: [{ title: 'Convert', buttons: [B('Explode', 'explode', 'EXPLODE'), B('Convert\nText', 'text', 'TEXT', 'small'), B('Line to\nWire', 'wire', 'LINE2WIRE', 'small')] }],
  },
  {
    name: 'Add-ins',
    panels: [{ title: 'Apps', buttons: [B('Command\nList', 'info', 'HELP')] }],
  },
  {
    name: 'View',
    panels: [
      { title: 'Navigate 2D', buttons: [B('Pan', 'pan', 'PAN'), B('Zoom\nExtents', 'zoomext', 'ZOOM E'), B('Window', 'zoomwin', 'ZOOM W', 'small'), B('Zoom In', 'zoomin', 'ZOOM I', 'small'), B('Zoom Out', 'zoomout', 'ZOOM O', 'small')] },
      { title: 'Palettes', buttons: [B('Project\nManager', 'project', 'TOGGLEPM'), B('Properties', 'props', 'PROPERTIES', 'small'), B('Layers', 'layers', 'LAYER', 'small')] },
    ],
  },
];

export class Ribbon {
  readonly el: HTMLElement;
  private active = 0;
  private tabsEl: HTMLElement;
  private bodyEl: HTMLElement;

  constructor(private editor: Editor, container: HTMLElement) {
    this.el = container;
    this.el.className = 'ribbon';
    this.tabsEl = document.createElement('div');
    this.tabsEl.className = 'ribbon-tabs';
    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'ribbon-body';
    this.el.append(this.tabsEl, this.bodyEl);
    this.setActive(2); // Schematic tab is the natural home for an electrical workspace
  }

  onTabChange: ((i: number) => void) | null = null;

  setActive(i: number): void {
    this.active = Math.max(0, Math.min(RIBBON.length - 1, i));
    this.renderTabs();
    this.renderBody();
    this.onTabChange?.(this.active);
  }

  private renderTabs(): void {
    this.tabsEl.innerHTML = '';
    RIBBON.forEach((tab, i) => {
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
      const title = document.createElement('div');
      title.className = 'ribbon-panel-title';
      title.innerHTML = `<span>${panel.title}</span><span class="panel-arrow">${icon('chevron')}</span>`;
      p.append(content, title);
      this.bodyEl.appendChild(p);
    }
  }
}
