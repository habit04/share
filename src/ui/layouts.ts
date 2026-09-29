/**
 * Layout UI (Track E): the Model | Layout1 | + tabs under the canvas (right-click menu with
 * New / From Template / Delete / Rename / Move or Copy / Page Setup / Plot), the Page Setup
 * dialog and the Layout Wizard. The commands and the space switching live in tools/layouts.ts.
 */
import type { Editor } from '../app/editor';
import { esc } from './dom';
import { icon } from './icons';
import { showMenu, type MenuItem } from './menu';
import { modal, button, dlgRow, dlgGroup, dlgCheck, numberInput, selectInput, textField } from './dialogkit';
import {
  LAYOUT_PAPERS,
  findLayout,
  formatScale,
  layoutsOf,
  paperDef,
  paperFor,
  paperLabel,
  sheetSize,
  STANDARD_SCALES,
  uniqueLayoutName,
  type Layout,
  type LayoutPaper,
  type PaperUnits,
  type PlotStyleMode,
} from '../core/layouts';
import { layoutController, type LayoutController } from '../tools/layouts';

export const PLOT_STYLE_LABELS: Array<[PlotStyleMode, string]> = [
  ['monochrome', 'monochrome.ctb (all black)'],
  ['grayscale', 'grayscale.ctb'],
  ['color', 'acad.ctb (object colours)'],
  ['screening', 'Screening (lighter ink)'],
];

/** Paper choices: the catalog plus the layout's own custom size. */
function paperOptions(current: LayoutPaper): Array<[string, string]> {
  const out: Array<[string, string]> = LAYOUT_PAPERS.map((p) => [p.id, p.label]);
  if (!paperDef(current.id)) out.push(['custom', paperLabel(current)]);
  return out;
}

/** Layout tabs under the canvas (AutoCAD's Model / layout tabs). */
export function buildLayoutTabs(editor: Editor, el: HTMLElement): void {
  const c = layoutController(editor);
  c.ui.pageSetup = (name) => pageSetupDialog(editor, name);
  c.ui.wizard = () => layoutWizardDialog(editor);
  el.className = 'layout-tabs';
  let lastKey = '';
  const refresh = (force = false) => {
    const state = editor.doc.snapshot;
    const layouts = layoutsOf(state);
    const space = editor.doc.space;
    const key = `${layouts.map((l) => l.name).join('|')}#${space?.layout ?? ''}`;
    if (!force && key === lastKey) return;
    lastKey = key;
    el.innerHTML = '';
    const model = document.createElement('button');
    model.className = 'layout-tab' + (!space ? ' active' : '');
    model.textContent = 'Model';
    model.title = 'Model space';
    model.addEventListener('click', () => c.activate(null));
    model.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      showMenu({ x: ev.clientX, y: ev.clientY }, [
        { label: 'New Layout', run: () => newLayout(editor, c) },
        { label: 'From Template...', run: () => editor.runCommand('LAYOUTWIZARD') },
        null,
        { label: 'Plot...', run: () => editor.runCommand('PLOT') },
      ]);
    });
    el.appendChild(model);
    layouts.forEach((l, i) => {
      const tab = document.createElement('button');
      const active = space?.layout.toUpperCase() === l.name.toUpperCase();
      tab.className = 'layout-tab' + (active ? ' active' : '');
      tab.textContent = l.name;
      const s = sheetSize(l);
      tab.title = `${l.name}: ${paperLabel(l.paper)}, ${l.paper.orientation} (${+s.width.toFixed(2)} x ${+s.height.toFixed(2)} ${l.paper.units}), ${l.viewports.length} viewport(s)`;
      tab.dataset.layout = l.name;
      tab.addEventListener('click', () => c.activate(l.name));
      tab.addEventListener('dblclick', () => renameLayout(editor, c, l.name));
      tab.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        const items: MenuItem[] = [
          { label: 'New Layout', run: () => newLayout(editor, c) },
          { label: 'From Template...', run: () => editor.runCommand('LAYOUTWIZARD') },
          { label: 'Delete', disabled: layouts.length <= 1 && l.entities.length === 0 && l.viewports.length === 0, run: () => deleteLayout(editor, c, l.name) },
          { label: 'Rename', run: () => renameLayout(editor, c, l.name) },
          {
            label: 'Move or Copy',
            items: [
              { label: 'Move Left', disabled: i === 0, run: () => c.moveLayout(l.name, i - 1) },
              { label: 'Move Right', disabled: i === layouts.length - 1, run: () => c.moveLayout(l.name, i + 1) },
              { label: 'Create a Copy', run: () => c.copyLayout(l.name) },
            ],
          },
          null,
          { label: 'Page Setup Manager...', run: () => pageSetupDialog(editor, l.name) },
          { label: 'Plot...', run: () => (c.activate(l.name), editor.runCommand('PLOT')) },
          null,
          { label: 'Activate Model Tab', run: () => c.activate(null) },
        ];
        showMenu({ x: ev.clientX, y: ev.clientY }, items);
      });
      el.appendChild(tab);
    });
    const add = document.createElement('button');
    add.className = 'layout-tab add';
    add.title = 'New layout';
    add.innerHTML = icon('plus');
    add.addEventListener('click', () => newLayout(editor, c));
    el.appendChild(add);
  };
  editor.on('change', () => refresh());
  editor.on('space', () => refresh());
  editor.on('file', () => refresh(true));
  refresh(true);
}

function newLayout(editor: Editor, c: LayoutController): void {
  const n = c.newLayout(uniqueLayoutName(editor.doc.snapshot));
  if (n) {
    editor.log(`Layout "${n}" created.`);
    c.activate(n);
  }
}

function renameLayout(editor: Editor, c: LayoutController, name: string): void {
  const ui = editor.ui;
  if (!ui) return;
  void ui.textInput('Rename Layout', 'Layout name', name).then((v) => {
    if (v !== null && v.trim() && v.trim() !== name && c.renameLayout(name, v)) editor.log(`Layout "${name}" renamed to "${v.trim()}".`);
  });
}

function deleteLayout(editor: Editor, c: LayoutController, name: string): void {
  const ui = editor.ui;
  const go = () => c.deleteLayout(name);
  if (!ui) return void go();
  void ui.confirm('Delete Layout', `The layout "${name}" will be permanently deleted.`).then((ok) => {
    if (ok) go();
  });
}

/** Page Setup (PAGESETUP): paper, orientation, plot scale, margins and plot style of one layout. */
export function pageSetupDialog(editor: Editor, name: string): void {
  const c = layoutController(editor);
  const lay = findLayout(editor.doc.snapshot, name);
  if (!lay) return;
  const m = modal(`Page Setup - ${esc(lay.name)}`, 560, 'dark');
  m.root.querySelector('.modal')?.classList.add('page-setup');
  let paper: LayoutPaper = lay.paper;
  let plotScale = lay.plotScale;
  let style: PlotStyleMode = lay.plotStyle ?? 'monochrome';
  let screening = lay.screening ?? 50;
  let lineweights = lay.plotLineweights !== false;
  let usePlotStyles = lay.usePlotStyles !== false;
  const units = () => paper.units;
  let margins = { ...lay.margins };
  const summary = document.createElement('div');
  summary.className = 'dlg-note';
  const refresh = () => {
    const s = sheetSize({ paper });
    summary.textContent = `Sheet ${+s.width.toFixed(2)} x ${+s.height.toFixed(2)} ${units()} ${paper.orientation}; printable ${+(s.width - margins.left - margins.right).toFixed(2)} x ${+(s.height - margins.top - margins.bottom).toFixed(2)} ${units()}; plots at ${plotScale === 'fit' ? 'fit to paper' : plotScale}.`;
  };
  const marginBox = document.createElement('div');
  const buildMargins = () => {
    marginBox.innerHTML = '';
    const step = units() === 'mm' ? 0.5 : 0.05;
    const max = units() === 'mm' ? 100 : 4;
    for (const side of ['left', 'bottom', 'right', 'top'] as const) {
      marginBox.appendChild(dlgRow(`Margin ${side} (${units()})`, numberInput(+margins[side].toFixed(3), 0, max, step, (v) => ((margins = { ...margins, [side]: v }), refresh()))));
    }
  };
  const convertMargins = (from: PaperUnits, to: PaperUnits) => {
    if (from === to) return;
    const k = to === 'mm' ? 25.4 : 1 / 25.4;
    margins = { left: margins.left * k, bottom: margins.bottom * k, right: margins.right * k, top: margins.top * k };
  };
  const paperSel = selectInput(paperOptions(paper), paper.id, (id) => {
    if (id === 'custom') return;
    const next = paperFor(id, paper.orientation);
    convertMargins(paper.units, next.units);
    paper = next;
    buildMargins();
    refresh();
  });
  const orient = selectInput([['landscape', 'Landscape'], ['portrait', 'Portrait']], paper.orientation, (v) => ((paper = { ...paper, orientation: v as LayoutPaper['orientation'] }), refresh()));
  const scaleSel = selectInput([['1:1', '1:1 (paper at full size)'], ['fit', 'Fit to paper']], plotScale, (v) => ((plotScale = v), refresh()));
  const styleSel = selectInput(PLOT_STYLE_LABELS, style, (v) => ((style = v as PlotStyleMode), (screenRow.style.display = style === 'screening' ? '' : 'none')));
  const screenRow = dlgRow('Screening (%)', numberInput(screening, 5, 100, 5, (v) => (screening = v)));
  screenRow.style.display = style === 'screening' ? '' : 'none';
  buildMargins();
  m.body.append(
    dlgGroup('Paper size', [dlgRow('Paper', paperSel), dlgRow('Drawing orientation', orient)]),
    dlgGroup('Plot scale and area', [dlgRow('Scale', scaleSel), marginBox]),
    dlgGroup('Plot style table (pen assignments)', [dlgRow('Style', styleSel), screenRow, dlgCheck('Plot object lineweights', lineweights, (v) => (lineweights = v)), dlgCheck('Plot with plot styles', usePlotStyles, (v) => (usePlotStyles = v))]),
    summary,
  );
  refresh();
  const ok = button('OK', true);
  ok.addEventListener('click', () => {
    c.editLayout(lay.name, (l) => ({ ...l, paper, plotScale, margins, plotStyle: style, screening, plotLineweights: lineweights, usePlotStyles }));
    editor.log(`Page setup of "${lay.name}": ${paperLabel(paper)} ${paper.orientation}, ${plotScale}, ${style}.`);
    m.close();
  });
  const cancel = button('Cancel');
  cancel.addEventListener('click', () => m.close());
  m.footer.append(ok, cancel);
}

/** LAYOUTWIZARD: name, paper, orientation, viewport scale and a title block from the sheet templates. */
export function layoutWizardDialog(editor: Editor): void {
  const c = layoutController(editor);
  const state = editor.doc.snapshot;
  const m = modal('Create Layout', 520, 'dark');
  let name = uniqueLayoutName(state);
  let paper: LayoutPaper = paperFor(state.header?.units.insunits === 4 ? 'a3' : 'tabloid', 'landscape');
  let scale = 'fit';
  let titleBlock = true;
  const fields: Record<string, string> = { TITLE: '', DWGNO: '' };
  m.body.append(
    dlgGroup('Layout', [dlgRow('Name', textField(name, (v) => (name = v)))]),
    dlgGroup('Paper', [
      dlgRow('Paper size', selectInput(LAYOUT_PAPERS.map((p) => [p.id, p.label]), paper.id, (id) => (paper = paperFor(id, paper.orientation)))),
      dlgRow('Orientation', selectInput([['landscape', 'Landscape'], ['portrait', 'Portrait']], paper.orientation, (v) => (paper = { ...paper, orientation: v as LayoutPaper['orientation'] }))),
    ]),
    dlgGroup('Viewport', [dlgRow('Scale', selectInput([['fit', 'Scaled to fit'], ...STANDARD_SCALES.map((s): [string, string] => [s, s])], scale, (v) => (scale = v)))]),
    dlgGroup('Title block', [
      dlgCheck('Sheet border and title block (WD_TITLEBLOCK)', titleBlock, (v) => (titleBlock = v)),
      dlgRow('Drawing title', textField('', (v) => (fields.TITLE = v), 'SCHEMATIC')),
      dlgRow('Drawing number', textField('', (v) => (fields.DWGNO = v), '001')),
    ]),
  );
  const ok = button('Finish', true);
  ok.addEventListener('click', () => {
    const f = Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim()));
    const made = c.createFromWizard({ name, paper, scale, titleBlock, fields: f });
    if (!made) return;
    m.close();
    editor.log(`Layout "${made}" created (${paperLabel(paper)} ${paper.orientation}, viewport ${scale === 'fit' ? 'scaled to fit' : scale}).`);
    c.activate(made);
  });
  const cancel = button('Cancel');
  cancel.addEventListener('click', () => m.close());
  m.footer.append(ok, cancel);
}

/** Status bar helpers: MODEL / PAPER caption and the annotation-scale caption. */
export function spaceCaption(editor: Editor): 'MODEL' | 'PAPER' {
  const s = editor.doc.space;
  return s && !s.viewport ? 'PAPER' : 'MODEL';
}

export function annotationScaleCaption(editor: Editor): string {
  return editor.doc.header.cannoscale ?? '1:1';
}

/** The viewport scale shown next to the annotation scale while a floating viewport is active. */
export function viewportScaleCaption(editor: Editor): string | null {
  const s = editor.doc.space;
  if (!s?.viewport) return null;
  const lay = findLayout(editor.doc.snapshot, s.layout);
  const v = lay?.viewports.find((x) => x.id === s.viewport);
  return v ? formatScale(v.view.scale) : null;
}

export type { Layout };
