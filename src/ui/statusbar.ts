import type { Editor } from '../app/editor';
import { icon } from './icons';
import './icons-ui';
import { lineweightDisplay } from '../render/draw';
import { formatCoordinate, saveSettings, type UserSettings } from '../app/settings';
import { showMenu, type MenuItem } from './menu';
import { OSNAP_LABELS } from './dsettings';
import { updateSettings } from './options';

interface ToggleDef {
  key: string;
  icon: string;
  title: string;
  isOn: (ed: Editor) => boolean;
  toggle: (ed: Editor) => void;
  /** Items for the small dropdown arrow / right-click menu. */
  menu?: (ed: Editor, refresh: () => void) => MenuItem[];
}

const TOGGLES: ToggleDef[] = [
  {
    key: 'grid',
    icon: 'grid',
    title: 'Display drawing grid (F7)',
    isOn: (e) => e.viewport.settings.gridVisible,
    toggle: (e) => e.toggle('grid'),
    menu: (e) => [
      { label: 'Grid style: Lines', check: e.settings.gridStyle === 'lines', run: () => updateSettings(e, { gridStyle: 'lines' }) },
      { label: 'Grid style: Dots', check: e.settings.gridStyle === 'dots', run: () => updateSettings(e, { gridStyle: 'dots' }) },
      null,
      { label: 'Grid Settings...', run: () => e.runCommand('DSETTINGS 0') },
    ],
  },
  {
    key: 'snap',
    icon: 'snap',
    title: 'Snap to drawing grid (F9)',
    isOn: (e) => e.snap.gridSnap,
    toggle: (e) => e.toggle('gridSnap'),
    menu: (e) => [
      ...[0.0625, 0.125, 0.25, 0.5, 1].map((v): MenuItem => ({ label: `Snap spacing ${v}`, check: e.settings.snapSpacing === v, run: () => updateSettings(e, { snapSpacing: v }) })),
      null,
      { label: 'Snap Settings...', run: () => e.runCommand('DSETTINGS 0') },
    ],
  },
  { key: 'ortho', icon: 'ortho', title: 'Restrict cursor orthogonally (F8)', isOn: (e) => e.snap.ortho, toggle: (e) => e.toggle('ortho') },
  {
    key: 'polar',
    icon: 'polar',
    title: 'Polar tracking (F10)',
    isOn: (e) => e.snap.polar,
    toggle: (e) => e.toggle('polar'),
    menu: (e) => [
      ...[90, 45, 30, 22.5, 18, 15, 10, 5].map((v): MenuItem => ({ label: `${v}, ${v * 2}, ${v * 3}...`, check: e.settings.polarIncrement === v, run: () => updateSettings(e, { polarIncrement: v }) })),
      null,
      { label: 'Tracking Settings...', run: () => e.runCommand('DSETTINGS 1') },
    ],
  },
  {
    key: 'osnap',
    icon: 'osnap',
    title: 'Object snap (F3)',
    isOn: (e) => e.snap.osnap,
    toggle: (e) => e.toggle('osnap'),
    menu: (e) => [
      ...OSNAP_LABELS.map(([k, label]): MenuItem => ({ label, check: e.settings.osnapModes[k], run: () => updateSettings(e, { osnapModes: { ...e.settings.osnapModes, [k]: !e.settings.osnapModes[k] } }) })),
      null,
      { label: 'Object Snap Settings...', run: () => e.runCommand('DSETTINGS 2') },
    ],
  },
  {
    key: 'otrack',
    icon: 'otrack',
    title: 'Object snap tracking (F11)',
    isOn: (e) => e.snap.otrack,
    toggle: (e) => e.toggle('otrack'),
    menu: (e) => [{ label: 'Object Snap Settings...', run: () => e.runCommand('DSETTINGS 2') }, { label: 'Tracking Settings...', run: () => e.runCommand('DSETTINGS 1') }],
  },
  {
    key: 'dyn',
    icon: 'dyn',
    title: 'Dynamic input (F12)',
    isOn: (e) => e.dynamicInput,
    toggle: (e) => e.toggle('dyn'),
    menu: (e) => [{ label: 'Dynamic Input Settings...', run: () => e.runCommand('DSETTINGS 3') }],
  },
  { key: 'lw', icon: 'lw', title: 'Show/hide lineweight (LWDISPLAY)', isOn: () => lineweightDisplay.enabled, toggle: (e) => e.toggle('lw') },
  { key: 'qp', icon: 'qp', title: 'Quick Properties (QP)', isOn: (e) => e.settings.quickProperties, toggle: (e) => e.runCommand('QPMODE') },
];

const RIGHT_ITEMS: Array<[string, string]> = [
  ['workspace', 'Workspace switching'],
  ['units', 'Units'],
  ['isolate', 'Isolate objects'],
  ['clean', 'Clean screen'],
];

export class StatusBar {
  readonly el: HTMLElement;
  private coordsEl: HTMLElement;
  private buttons = new Map<string, HTMLElement>();
  private wsEl: HTMLElement;
  private unitsEl: HTMLElement;
  private lastCoordPoint: { x: number; y: number } | null = null;

  constructor(private editor: Editor, container: HTMLElement) {
    this.el = container;
    this.el.className = 'statusbar';

    this.coordsEl = document.createElement('div');
    this.coordsEl.className = 'status-coords';
    this.coordsEl.title = 'Click to cycle Absolute / Relative / Off; right-click for options';
    this.coordsEl.addEventListener('click', () => {
      const order: UserSettings['coordDisplay'][] = ['absolute', 'relative', 'off'];
      const next = order[(order.indexOf(this.editor.settings.coordDisplay) + 1) % order.length]!;
      updateSettings(this.editor, { coordDisplay: next });
      this.refreshCoords();
    });
    this.coordsEl.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      showMenu({ x: ev.clientX, y: ev.clientY }, [
        { label: 'Absolute', check: this.editor.settings.coordDisplay === 'absolute', run: () => updateSettings(this.editor, { coordDisplay: 'absolute' }) },
        { label: 'Relative (to last point)', check: this.editor.settings.coordDisplay === 'relative', run: () => updateSettings(this.editor, { coordDisplay: 'relative' }) },
        { label: 'Off', check: this.editor.settings.coordDisplay === 'off', run: () => updateSettings(this.editor, { coordDisplay: 'off' }) },
        null,
        { label: 'Units...', run: () => this.editor.runCommand('OPTIONS 4') },
      ]);
    });
    this.el.appendChild(this.coordsEl);
    this.buttons.set('coords', this.coordsEl);

    const model = document.createElement('button');
    model.className = 'status-btn on text';
    model.textContent = 'MODEL';
    model.title = 'Model space (paper-space layouts are not supported yet)';
    model.addEventListener('click', () => this.editor.log('Only model space is available: paper-space layouts are not supported yet. Plot from model space with PLOT.'));
    this.el.appendChild(model);
    this.buttons.set('model', model);

    for (const t of TOGGLES) {
      const group = document.createElement('div');
      group.className = 'status-group';
      const b = document.createElement('button');
      b.className = 'status-btn';
      b.innerHTML = icon(t.icon);
      b.title = t.title;
      b.addEventListener('click', () => {
        t.toggle(this.editor);
        this.refresh();
      });
      b.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        const items = t.menu?.(this.editor, () => this.refresh()) ?? [];
        showMenu({ x: ev.clientX, y: ev.clientY }, [...items, ...(items.length ? [null] : []), { label: 'Customize status bar...', run: () => this.showCustomize(customize) }], { minWidth: 220 });
      });
      group.appendChild(b);
      if (t.menu) {
        const arrow = document.createElement('button');
        arrow.className = 'status-btn arrow';
        arrow.innerHTML = icon('chevron');
        arrow.title = `${t.title} — settings`;
        arrow.addEventListener('click', () => showMenu(arrow, t.menu!(this.editor, () => this.refresh()), { above: true, minWidth: 220 }));
        group.appendChild(arrow);
      }
      this.buttons.set(t.key, group);
      this.el.appendChild(group);
    }

    const spacer = document.createElement('div');
    spacer.className = 'status-spacer';
    this.el.appendChild(spacer);

    // No annotation-scale control: there are no annotative objects, so a scale picker would change nothing.
    // Text and dimension sizes are set directly (text height, DIMSCALE).

    this.wsEl = document.createElement('div');
    this.wsEl.className = 'status-text clickable';
    this.wsEl.title = 'Workspace switching';
    this.wsEl.addEventListener('click', () =>
      showMenu(
        this.wsEl,
        [
          { label: 'Drafting & Annotation', check: this.editor.settings.workspace === 'drafting', run: () => this.editor.runCommand('WORKSPACE drafting') },
          { label: 'Electrical & 2D Drafting', check: this.editor.settings.workspace === 'electrical', run: () => this.editor.runCommand('WORKSPACE electrical') },
        ],
        { above: true, alignRight: true },
      ),
    );
    this.el.appendChild(this.wsEl);
    this.buttons.set('workspace', this.wsEl);

    this.unitsEl = document.createElement('div');
    this.unitsEl.className = 'status-text clickable';
    this.unitsEl.title = 'Drawing units (Options > Units)';
    this.unitsEl.addEventListener('click', () =>
      showMenu(
        this.unitsEl,
        [
          ...(['decimal', 'engineering', 'architectural', 'fractional'] as const).map((u): MenuItem => ({ label: u[0]!.toUpperCase() + u.slice(1), check: this.editor.settings.units === u, run: () => updateSettings(this.editor, { units: u }) })),
          null,
          ...([0, 1, 2, 3, 4, 6] as const).map((p): MenuItem => ({ label: `Precision ${p}`, check: this.editor.settings.precision === p, run: () => updateSettings(this.editor, { precision: p }) })),
          null,
          { label: 'Units...', run: () => this.editor.runCommand('OPTIONS 4') },
        ],
        { above: true, alignRight: true },
      ),
    );
    this.el.appendChild(this.unitsEl);
    this.buttons.set('units', this.unitsEl);

    const iso = document.createElement('button');
    iso.className = 'status-btn';
    iso.innerHTML = icon('isolate');
    iso.title = 'Isolate objects (layers of the selection)';
    iso.addEventListener('click', () =>
      showMenu(iso, [{ label: 'Isolate Objects', run: () => this.editor.runCommand('LAYISO') }, { label: 'Hide Objects', run: () => this.editor.runCommand('LAYOFF') }, { label: 'End Object Isolation', run: () => this.editor.runCommand('LAYUNISO') }], { above: true, alignRight: true }),
    );
    this.el.appendChild(iso);
    this.buttons.set('isolate', iso);

    const clean = document.createElement('button');
    clean.className = 'status-btn';
    clean.innerHTML = icon('clean');
    clean.title = 'Clean screen (Ctrl+0)';
    clean.addEventListener('click', () => this.editor.runCommand('CLEANSCREEN'));
    this.el.appendChild(clean);
    this.buttons.set('clean', clean);

    const customize = document.createElement('button');
    customize.className = 'status-btn';
    customize.innerHTML = icon('menu');
    customize.title = 'Customization';
    customize.addEventListener('click', () => this.showCustomize(customize));
    this.el.appendChild(customize);

    editor.on('view', () => this.refreshCoords());
    editor.on('snap', () => this.refresh());
    editor.on('tool', () => this.refresh());
    editor.on('file', () => this.refresh());
    this.refresh();
  }

  private showCustomize(anchor: HTMLElement): void {
    const items: MenuItem[] = [
      { label: 'Coordinates', check: this.visible('coords'), run: () => this.setVisible('coords', !this.visible('coords')) },
      { label: 'Model Space', check: this.visible('model'), run: () => this.setVisible('model', !this.visible('model')) },
      ...TOGGLES.map((t): MenuItem => ({ label: t.title.replace(/ \(.*\)$/, ''), check: this.visible(t.key), run: () => this.setVisible(t.key, !this.visible(t.key)) })),
      ...RIGHT_ITEMS.map(([k, label]): MenuItem => ({ label, check: this.visible(k), run: () => this.setVisible(k, !this.visible(k)) })),
      null,
      { label: 'Show all', run: () => updateSettings(this.editor, { statusBarItems: {} }) },
    ];
    showMenu(anchor, items, { above: true, alignRight: true, minWidth: 220 });
    // re-apply after any change
    setTimeout(() => this.refresh(), 0);
  }

  private visible(key: string): boolean {
    return this.editor.settings.statusBarItems[key] !== false;
  }
  private setVisible(key: string, v: boolean): void {
    this.editor.settings = { ...this.editor.settings, statusBarItems: { ...this.editor.settings.statusBarItems, [key]: v } };
    saveSettings(this.editor.settings);
    this.refresh();
  }

  private refreshCoords(): void {
    const s = this.editor.settings;
    const mode = s.coordDisplay;
    this.coordsEl.classList.toggle('off', mode === 'off');
    if (mode === 'off') {
      if (this.editor.lastPoint) this.coordsEl.textContent = formatCoordinate(this.editor.lastPoint.x, this.editor.lastPoint.y, s);
      return;
    }
    const p = this.editor.cursorPosition();
    if (!p) return;
    if (mode === 'relative' && this.editor.lastPoint) {
      const dx = p.x - this.editor.lastPoint.x;
      const dy = p.y - this.editor.lastPoint.y;
      const d = Math.hypot(dx, dy);
      const a = (Math.atan2(dy, dx) * 180) / Math.PI;
      this.coordsEl.textContent = `${d.toFixed(s.precision)}<${(a < 0 ? a + 360 : a).toFixed(0)}, 0.0000`;
      return;
    }
    this.lastCoordPoint = p;
    this.coordsEl.textContent = formatCoordinate(p.x, p.y, s);
  }

  refresh(): void {
    for (const t of TOGGLES) {
      const b = this.buttons.get(t.key)!.querySelector('.status-btn') ?? this.buttons.get(t.key)!;
      b.classList.toggle('on', t.isOn(this.editor));
    }
    for (const [k, el] of this.buttons) el.classList.toggle('status-hidden', !this.visible(k));
    const s = this.editor.settings;
    this.wsEl.innerHTML = `${icon('settings')} <span>${s.workspace === 'drafting' ? 'Drafting &amp; Annotation' : 'Electrical &amp; 2D Drafting'}</span>${icon('chevron')}`;
    const unitName = s.units[0]!.toUpperCase() + s.units.slice(1);
    this.unitsEl.textContent = `${unitName} · ${s.unitSuffix}`;
    this.refreshCoords();
  }
}
