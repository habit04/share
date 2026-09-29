import type { Editor } from '../app/editor';
import { icon } from './icons';
import './icons-ui';
import { lineweightDisplay } from '../render/draw';
import { formatCoordinate, saveSettings, type UserSettings } from '../app/settings';
import { showMenu, type MenuItem } from './menu';
import { OSNAP_LABELS } from './dsettings';
import { updateSettings } from './options';
import { t, onLocaleChange } from '../app/i18n';
// Track E: MODEL / PAPER button and the annotation-scale dropdown follow the active space.
import { STANDARD_SCALES } from '../core/layouts';
import { layoutController, setAnnotationScale } from '../tools/layouts';
import { spaceCaption, annotationScaleCaption, viewportScaleCaption } from './layouts';

interface ToggleDef {
  key: string;
  icon: string;
  /** Tooltip (translated when called). */
  title: () => string;
  /** Short name for the Customize menu. */
  name: () => string;
  isOn: (ed: Editor) => boolean;
  toggle: (ed: Editor) => void;
  /** Items for the small dropdown arrow / right-click menu. */
  menu?: (ed: Editor, refresh: () => void) => MenuItem[];
}

const TOGGLES: ToggleDef[] = [
  {
    key: 'grid',
    icon: 'grid',
    title: () => t('status.grid.title'),
    name: () => t('status.grid.name'),
    isOn: (e) => e.viewport.settings.gridVisible,
    toggle: (e) => e.toggle('grid'),
    menu: (e) => [
      { label: t('status.grid.lines'), check: e.settings.gridStyle === 'lines', run: () => updateSettings(e, { gridStyle: 'lines' }) },
      { label: t('status.grid.dots'), check: e.settings.gridStyle === 'dots', run: () => updateSettings(e, { gridStyle: 'dots' }) },
      null,
      { label: t('status.grid.settings'), run: () => e.runCommand('DSETTINGS 0') },
    ],
  },
  {
    key: 'snap',
    icon: 'snap',
    title: () => t('status.snap.title'),
    name: () => t('status.snap.name'),
    isOn: (e) => e.snap.gridSnap,
    toggle: (e) => e.toggle('gridSnap'),
    menu: (e) => [
      ...snapChoices(e).map((v): MenuItem => ({ label: t('status.snap.spacing', { value: v }), check: e.settings.snapSpacing === v, run: () => updateSettings(e, { snapSpacing: v }) })),
      null,
      { label: t('status.snap.settings'), run: () => e.runCommand('DSETTINGS 0') },
    ],
  },
  { key: 'ortho', icon: 'ortho', title: () => t('status.ortho.title'), name: () => t('status.ortho.name'), isOn: (e) => e.snap.ortho, toggle: (e) => e.toggle('ortho') },
  {
    key: 'polar',
    icon: 'polar',
    title: () => t('status.polar.title'),
    name: () => t('status.polar.name'),
    isOn: (e) => e.snap.polar,
    toggle: (e) => e.toggle('polar'),
    menu: (e) => [
      ...[90, 45, 30, 22.5, 18, 15, 10, 5].map((v): MenuItem => ({ label: `${v}, ${v * 2}, ${v * 3}...`, check: e.settings.polarIncrement === v, run: () => updateSettings(e, { polarIncrement: v }) })),
      null,
      { label: t('status.tracking.settings'), run: () => e.runCommand('DSETTINGS 1') },
    ],
  },
  {
    key: 'osnap',
    icon: 'osnap',
    title: () => t('status.osnap.title'),
    name: () => t('status.osnap.name'),
    isOn: (e) => e.snap.osnap,
    toggle: (e) => e.toggle('osnap'),
    menu: (e) => [
      ...OSNAP_LABELS.map(([k]): MenuItem => ({ label: osnapLabel(k), check: e.settings.osnapModes[k], run: () => updateSettings(e, { osnapModes: { ...e.settings.osnapModes, [k]: !e.settings.osnapModes[k] } }) })),
      null,
      { label: t('status.osnap.settings'), run: () => e.runCommand('DSETTINGS 2') },
    ],
  },
  {
    key: 'otrack',
    icon: 'otrack',
    title: () => t('status.otrack.title'),
    name: () => t('status.otrack.name'),
    isOn: (e) => e.snap.otrack,
    toggle: (e) => e.toggle('otrack'),
    menu: (e) => [{ label: t('status.osnap.settings'), run: () => e.runCommand('DSETTINGS 2') }, { label: t('status.tracking.settings'), run: () => e.runCommand('DSETTINGS 1') }],
  },
  {
    key: 'dyn',
    icon: 'dyn',
    title: () => t('status.dyn.title'),
    name: () => t('status.dyn.name'),
    isOn: (e) => e.dynamicInput,
    toggle: (e) => e.toggle('dyn'),
    menu: (e) => [{ label: t('status.dyn.settings'), run: () => e.runCommand('DSETTINGS 3') }],
  },
  { key: 'lw', icon: 'lw', title: () => t('status.lw.title'), name: () => t('status.lw.name'), isOn: () => lineweightDisplay.enabled, toggle: (e) => e.toggle('lw') },
  { key: 'qp', icon: 'qp', title: () => t('status.qp.title'), name: () => t('status.qp.name'), isOn: (e) => e.settings.quickProperties, toggle: (e) => e.runCommand('QPMODE') },
];

const RIGHT_ITEMS: Array<[string, () => string]> = [
  ['annoscale', () => t('status.annoscale.name')],
  ['workspace', () => t('status.workspace.name')],
  ['units', () => t('status.units.name')],
  ['isolate', () => t('status.isolate.name')],
  ['clean', () => t('status.clean.name')],
];

/** Snap spacing presets: inch fractions, or round millimetres in a metric drawing ($INSUNITS 4). */
function snapChoices(e: Editor): number[] {
  return e.doc.header.units.insunits === 4 ? [1, 2.5, 5, 10, 25] : [0.0625, 0.125, 0.25, 0.5, 1];
}

/** Object snap mode names (translated). */
export function osnapLabel(k: keyof UserSettings['osnapModes']): string {
  switch (k) {
    case 'endpoint':
      return t('osnap.endpoint');
    case 'midpoint':
      return t('osnap.midpoint');
    case 'center':
      return t('osnap.center');
    case 'quadrant':
      return t('osnap.quadrant');
    case 'intersection':
      return t('osnap.intersection');
    case 'perpendicular':
      return t('osnap.perpendicular');
    default:
      return t('osnap.nearest');
  }
}

/** Length unit type names (translated). */
export function unitTypeLabel(u: UserSettings['units']): string {
  switch (u) {
    case 'engineering':
      return t('units.engineering');
    case 'architectural':
      return t('units.architectural');
    case 'fractional':
      return t('units.fractional');
    default:
      return t('units.decimal');
  }
}

export class StatusBar {
  readonly el: HTMLElement;
  private coordsEl: HTMLElement;
  private buttons = new Map<string, HTMLElement>();
  private wsEl: HTMLElement;
  private unitsEl: HTMLElement;
  private modelEl: HTMLElement;
  private annoEl: HTMLElement;
  private isoEl: HTMLElement;
  private cleanEl: HTMLElement;
  private customizeEl: HTMLElement;
  private toggleButtons = new Map<string, { button: HTMLElement; arrow: HTMLElement | null }>();
  private lastCoordPoint: { x: number; y: number } | null = null;

  constructor(private editor: Editor, container: HTMLElement) {
    this.el = container;
    this.el.className = 'statusbar';

    this.coordsEl = document.createElement('div');
    this.coordsEl.className = 'status-coords';
    this.coordsEl.addEventListener('click', () => {
      const order: UserSettings['coordDisplay'][] = ['absolute', 'relative', 'off'];
      const next = order[(order.indexOf(this.editor.settings.coordDisplay) + 1) % order.length]!;
      updateSettings(this.editor, { coordDisplay: next });
      this.refreshCoords();
    });
    this.coordsEl.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      showMenu({ x: ev.clientX, y: ev.clientY }, [
        { label: t('status.coords.absolute'), check: this.editor.settings.coordDisplay === 'absolute', run: () => updateSettings(this.editor, { coordDisplay: 'absolute' }) },
        { label: t('status.coords.relative'), check: this.editor.settings.coordDisplay === 'relative', run: () => updateSettings(this.editor, { coordDisplay: 'relative' }) },
        { label: t('status.coords.off'), check: this.editor.settings.coordDisplay === 'off', run: () => updateSettings(this.editor, { coordDisplay: 'off' }) },
        null,
        { label: t('status.units.dialog'), run: () => this.editor.runCommand('OPTIONS 4') },
      ]);
    });
    this.el.appendChild(this.coordsEl);
    this.buttons.set('coords', this.coordsEl);

    const model = document.createElement('button');
    model.className = 'status-btn on text';
    // Model tab: go to the last layout; in a layout: toggle paper space / the current viewport.
    model.addEventListener('click', () => {
      const c = layoutController(this.editor);
      if (c.mode === 'model') this.editor.runCommand('TILEMODE 0');
      else this.editor.runCommand(c.mode === 'paper' ? 'MSPACE' : 'PSPACE');
      this.refresh();
    });
    this.modelEl = model;
    this.el.appendChild(model);
    this.buttons.set('model', model);

    for (const def of TOGGLES) {
      const group = document.createElement('div');
      group.className = 'status-group';
      const b = document.createElement('button');
      b.className = 'status-btn';
      b.innerHTML = icon(def.icon);
      b.addEventListener('click', () => {
        def.toggle(this.editor);
        this.refresh();
      });
      b.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        const items = def.menu?.(this.editor, () => this.refresh()) ?? [];
        showMenu({ x: ev.clientX, y: ev.clientY }, [...items, ...(items.length ? [null] : []), { label: t('status.customize.menu'), run: () => this.showCustomize(customize) }], { minWidth: 220 });
      });
      group.appendChild(b);
      let arrow: HTMLElement | null = null;
      if (def.menu) {
        const a = document.createElement('button');
        a.className = 'status-btn arrow';
        a.innerHTML = icon('chevron');
        a.addEventListener('click', () => showMenu(a, def.menu!(this.editor, () => this.refresh()), { above: true, minWidth: 220 }));
        group.appendChild(a);
        arrow = a;
      }
      this.toggleButtons.set(def.key, { button: b, arrow });
      this.buttons.set(def.key, group);
      this.el.appendChild(group);
    }

    const spacer = document.createElement('div');
    spacer.className = 'status-spacer';
    this.el.appendChild(spacer);

    // Annotation scale (CANNOSCALE); in a floating viewport it also sets the viewport scale.
    this.annoEl = document.createElement('div');
    this.annoEl.className = 'status-text clickable status-annoscale';
    this.annoEl.addEventListener('click', () =>
      showMenu(
        this.annoEl,
        STANDARD_SCALES.map((sc): MenuItem => ({ label: sc, check: annotationScaleCaption(this.editor) === sc, run: () => (setAnnotationScale(this.editor, sc), this.refresh()) })),
        { above: true, alignRight: true },
      ),
    );
    this.el.appendChild(this.annoEl);
    this.buttons.set('annoscale', this.annoEl);

    this.wsEl = document.createElement('div');
    this.wsEl.className = 'status-text clickable';
    this.wsEl.addEventListener('click', () =>
      showMenu(
        this.wsEl,
        [
          { label: t('status.workspace.drafting'), check: this.editor.settings.workspace === 'drafting', run: () => this.editor.runCommand('WORKSPACE drafting') },
          { label: t('status.workspace.electrical'), check: this.editor.settings.workspace === 'electrical', run: () => this.editor.runCommand('WORKSPACE electrical') },
        ],
        { above: true, alignRight: true },
      ),
    );
    this.el.appendChild(this.wsEl);
    this.buttons.set('workspace', this.wsEl);

    this.unitsEl = document.createElement('div');
    this.unitsEl.className = 'status-text clickable';
    this.unitsEl.addEventListener('click', () =>
      showMenu(
        this.unitsEl,
        [
          ...(['decimal', 'engineering', 'architectural', 'fractional'] as const).map((u): MenuItem => ({ label: unitTypeLabel(u), check: this.editor.settings.units === u, run: () => updateSettings(this.editor, { units: u }) })),
          null,
          ...([0, 1, 2, 3, 4, 6] as const).map((p): MenuItem => ({ label: t('status.units.precision', { value: p }), check: this.editor.settings.precision === p, run: () => updateSettings(this.editor, { precision: p }) })),
          null,
          { label: t('status.units.dialog'), run: () => this.editor.runCommand('OPTIONS 4') },
          { label: t('status.units.drawing'), run: () => this.editor.runCommand('DSETTINGS 4') },
        ],
        { above: true, alignRight: true },
      ),
    );
    this.el.appendChild(this.unitsEl);
    this.buttons.set('units', this.unitsEl);

    const iso = document.createElement('button');
    iso.className = 'status-btn';
    iso.innerHTML = icon('isolate');
    iso.addEventListener('click', () =>
      showMenu(iso, [{ label: t('status.isolate.isolate'), run: () => this.editor.runCommand('LAYISO') }, { label: t('status.isolate.hide'), run: () => this.editor.runCommand('LAYOFF') }, { label: t('status.isolate.end'), run: () => this.editor.runCommand('LAYUNISO') }], { above: true, alignRight: true }),
    );
    this.isoEl = iso;
    this.el.appendChild(iso);
    this.buttons.set('isolate', iso);

    const clean = document.createElement('button');
    clean.className = 'status-btn';
    clean.innerHTML = icon('clean');
    clean.addEventListener('click', () => this.editor.runCommand('CLEANSCREEN'));
    this.cleanEl = clean;
    this.el.appendChild(clean);
    this.buttons.set('clean', clean);

    const customize = document.createElement('button');
    customize.className = 'status-btn';
    customize.innerHTML = icon('menu');
    customize.addEventListener('click', () => this.showCustomize(customize));
    this.customizeEl = customize;
    this.el.appendChild(customize);

    onLocaleChange(() => this.refresh());
    editor.on('view', () => this.refreshCoords());
    editor.on('snap', () => this.refresh());
    editor.on('tool', () => this.refresh());
    editor.on('file', () => this.refresh());
    editor.on('space', () => this.refresh());
    this.refresh();
  }

  private showCustomize(anchor: HTMLElement): void {
    const items: MenuItem[] = [
      { label: t('status.coords.name'), check: this.visible('coords'), run: () => this.setVisible('coords', !this.visible('coords')) },
      { label: t('status.model.name'), check: this.visible('model'), run: () => this.setVisible('model', !this.visible('model')) },
      ...TOGGLES.map((def): MenuItem => ({ label: def.name(), check: this.visible(def.key), run: () => this.setVisible(def.key, !this.visible(def.key)) })),
      ...RIGHT_ITEMS.map(([k, label]): MenuItem => ({ label: label(), check: this.visible(k), run: () => this.setVisible(k, !this.visible(k)) })),
      null,
      { label: t('status.customize.showAll'), run: () => updateSettings(this.editor, { statusBarItems: {} }) },
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

  /** Tooltips and captions in the current language (called on every refresh, so a language switch shows at once). */
  private applyLabels(): void {
    this.coordsEl.title = t('status.coords.title');
    this.modelEl.textContent = spaceCaption(this.editor) === 'PAPER' ? t('status.paper.label') : t('status.model.label');
    this.annoEl.title = t('status.annoscale.title');
    this.modelEl.title = t('status.model.title');
    for (const def of TOGGLES) {
      const b = this.toggleButtons.get(def.key);
      if (!b) continue;
      b.button.title = def.title();
      if (b.arrow) b.arrow.title = t('status.toggle.settings', { name: def.title() });
    }
    this.wsEl.title = t('status.workspace.title');
    this.unitsEl.title = t('status.units.title');
    this.isoEl.title = t('status.isolate.title');
    this.cleanEl.title = t('status.clean.title');
    this.customizeEl.title = t('status.customize.title');
  }

  refresh(): void {
    this.applyLabels();
    for (const def of TOGGLES) {
      const b = this.buttons.get(def.key)!.querySelector('.status-btn') ?? this.buttons.get(def.key)!;
      b.classList.toggle('on', def.isOn(this.editor));
    }
    for (const [k, el] of this.buttons) el.classList.toggle('status-hidden', !this.visible(k));
    const s = this.editor.settings;
    const ws = document.createElement('span');
    ws.textContent = s.workspace === 'drafting' ? t('status.workspace.drafting') : t('status.workspace.electrical');
    this.wsEl.innerHTML = `${icon('settings')} ${ws.outerHTML}${icon('chevron')}`;
    this.unitsEl.textContent = `${unitTypeLabel(s.units)} · ${s.unitSuffix}`;
    const vpScale = viewportScaleCaption(this.editor);
    this.annoEl.innerHTML = `${vpScale ? `<span title="${t('status.vpscale.title')}">VP ${vpScale}</span> · ` : ''}<span>${icon('text')} ${annotationScaleCaption(this.editor)}</span>${icon('chevron')}`;
    this.refreshCoords();
  }
}
