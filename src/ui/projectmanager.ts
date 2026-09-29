import type { Editor } from '../app/editor';
import { icon } from './icons';
import { esc } from './dom';
import { baseName, resolveDrawingPath } from '../app/project';
import { showMenu, type MenuItem } from './menu';
import { projectStatus, type SheetStatus } from '../electrical/project-tools';

/** Short status line of a drawing: location codes and cross-reference result of the last project-wide run. */
export function sheetStatusText(st: SheetStatus | undefined): string {
  if (!st) return '';
  const parts: string[] = [];
  const codes = [...st.inst.map((i) => `+${i}`), ...st.loc.map((l) => `-${l}`)];
  if (codes.length) parts.push(codes.slice(0, 4).join(' ') + (codes.length > 4 ? ' ...' : ''));
  if (st.xrefIssues !== undefined) parts.push(st.xrefIssues ? `xref: ${st.xrefIssues} issue(s)` : 'xref OK');
  return parts.join(' · ');
}

/** Left-docked Project Manager palette (project tree + details pane). */
export class ProjectManager {
  readonly el: HTMLElement;
  private treeEl: HTMLElement;
  private detailsEl: HTMLElement;

  constructor(private editor: Editor, container: HTMLElement) {
    this.el = container;
    this.el.className = 'palette project-manager';

    // AutoCAD palettes carry a vertical title strip on the docked edge.
    const strip = document.createElement('div');
    strip.className = 'palette-strip';
    strip.innerHTML = `<span class="palette-strip-btns">${icon('close')}${icon('pin')}</span><span class="palette-strip-title">Project Manager</span>`;
    strip.querySelector('svg')?.addEventListener('click', () => this.el.classList.add('hidden'));
    const body = document.createElement('div');
    body.className = 'palette-body';
    const bar = document.createElement('div');
    bar.className = 'palette-titlebar';
    bar.innerHTML = `<span class="palette-title">Project Manager</span>`;

    const toolbar = document.createElement('div');
    toolbar.className = 'palette-toolbar';
    const mk = (ic: string, title: string, cmd: string) => {
      const b = document.createElement('button');
      b.className = 'palette-tool';
      b.innerHTML = icon(ic);
      b.title = title;
      b.addEventListener('click', () => this.editor.runCommand(cmd));
      return b;
    };
    toolbar.append(mk('new', 'New drawing from template', 'NEWSHEET'), mk('open', 'Open project', 'OPENPROJECT'), mk('plus', 'Add current drawing to project', 'PROJECTADD'), mk('save', 'Save project', 'PROJECTSAVE'), mk('report', 'Reports', 'AEREPORT bom'), mk('settings', 'Project properties (AEPROJECTPROPS)', 'AEPROJECTPROPS'));
    toolbar.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      showMenu({ x: ev.clientX, y: ev.clientY }, this.projectMenu());
    });
    const proj = document.createElement('div');
    proj.className = 'palette-project-select';
    proj.innerHTML = `<span class="pm-project-name">Sample Project</span>${icon('chevron')}`;
    proj.title = 'Open project (OPENPROJECT)';
    proj.addEventListener('click', () => this.editor.runCommand('OPENPROJECT'));

    this.treeEl = document.createElement('div');
    this.treeEl.className = 'project-tree';

    const detailsHeader = document.createElement('div');
    detailsHeader.className = 'palette-section-title';
    detailsHeader.innerHTML = `<span>Details</span>`;
    this.detailsEl = document.createElement('div');
    this.detailsEl.className = 'project-details';

    body.append(bar, toolbar, proj, this.treeEl, detailsHeader, this.detailsEl);
    this.el.append(strip, body);

    editor.on('file', () => this.render());
    editor.on('change', () => this.renderDetails());
    editor.on('selection', () => this.renderDetails());
    this.render();
  }

  toggle(): void {
    this.el.classList.toggle('hidden');
  }

  refresh(): void {
    this.render();
  }

  private render(): void {
    const name = this.editor.fileName();
    const project = this.editor.project;
    const current = this.editor.doc.filePath;
    this.el.querySelector('.pm-project-name')!.textContent = project.name;
    const rows: string[] = [`<div class="tree-node open"><span class="tree-twisty">▾</span>${icon('project')}<span>${esc(project.name)}</span></div>`];
    let currentListed = false;
    project.drawings.forEach((d, i) => {
      const label = baseName(d.file);
      const resolved = resolveDrawingPath(project, d);
      const isCurrent = current !== null && (resolved === current || d.file === current);
      if (isCurrent) currentListed = true;
      const st = projectStatus.get(resolved) ?? projectStatus.get(label);
      const status = sheetStatusText(st);
      const warn = st?.xrefIssues ? ' style="color:#d08000"' : '';
      rows.push(
        `<div class="tree-node lvl1 ${isCurrent ? 'active' : ''}" data-index="${i}" title="${esc(resolved)}${status ? `\n${esc(status)}` : ''}"><span class="tree-twisty"></span>${icon('model')}<span>${esc(label)}${isCurrent && this.editor.doc.dirty ? '*' : ''}</span>${d.description ? `<span class="tree-desc">${esc(d.description)}</span>` : ''}${status ? `<span class="tree-desc"${warn}>${esc(status)}</span>` : ''}</div>`,
      );
    });
    if (!currentListed) rows.push(`<div class="tree-node active lvl1"><span class="tree-twisty"></span>${icon('model')}<span>${esc(name)}${this.editor.doc.dirty ? '*' : ''}</span><span class="tree-desc">(not in project)</span></div>`);
    if (project.drawings.length === 0) rows.push(`<div class="tree-node lvl1 muted"><span class="tree-twisty"></span><span>Use "Add to Project" or open a project file</span></div>`);
    const recent = this.editor.settings.recentFiles;
    rows.push(`<div class="tree-node open"><span class="tree-twisty">▾</span>${icon('open')}<span>Recent Files</span></div>`);
    if (recent.length === 0) rows.push(`<div class="tree-node lvl1 muted"><span class="tree-twisty"></span><span>none</span></div>`);
    recent.forEach((f, i) => rows.push(`<div class="tree-node lvl1" data-recent="${i}" title="${esc(f)}"><span class="tree-twisty"></span>${icon('model')}<span>${esc(baseName(f))}</span></div>`));
    rows.push(`<div class="tree-node lvl1 muted" data-reports="1" title="Double-click to open the reports (AEREPORT)"><span class="tree-twisty"></span>${icon('report')}<span>Reports</span></div>`);
    this.treeEl.innerHTML = rows.join('');
    // Drawings open in their own file tab (or switch to the tab that already shows them).
    const openInTab = (f: string) => void this.editor.sessions.openInTab(f, (x) => this.editor.openFile(x));
    this.treeEl.querySelectorAll<HTMLElement>('[data-index]').forEach((n) => {
      n.addEventListener('dblclick', () => {
        const d = project.drawings[parseInt(n.dataset.index!, 10)];
        if (d) openInTab(resolveDrawingPath(project, d));
      });
      n.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        const d = project.drawings[parseInt(n.dataset.index!, 10)];
        showMenu({ x: ev.clientX, y: ev.clientY }, [{ label: 'Open', run: () => d && openInTab(resolveDrawingPath(project, d)) }, null, ...this.projectMenu()]);
      });
    });
    this.treeEl.querySelector('.tree-node.open')?.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      showMenu({ x: (ev as MouseEvent).clientX, y: (ev as MouseEvent).clientY }, this.projectMenu());
    });
    this.treeEl.querySelectorAll<HTMLElement>('[data-recent]').forEach((n) =>
      n.addEventListener('dblclick', () => {
        const f = this.editor.settings.recentFiles[parseInt(n.dataset.recent!, 10)];
        if (f) void (f.endsWith('.json') ? this.editor.openProject(f) : openInTab(f));
      }),
    );
    this.treeEl.querySelector('[data-reports]')?.addEventListener('dblclick', () => this.editor.runCommand('AEREPORT bom'));
    this.renderDetails();
  }

  /** Project-wide commands for the context menus. */
  private projectMenu(): MenuItem[] {
    const run = (cmd: string) => () => this.editor.runCommand(cmd);
    return [
      { label: 'Update Cross-References (project)', run: run('AEXREFPROJECT') },
      { label: 'Retag Components (project)...', run: run('AERETAGPROJECT') },
      { label: 'Wire Numbers (project)...', run: run('AEWIRENOPROJECT') },
      { label: 'Update Title Blocks (all drawings)', run: run('AETITLEBLOCKALL') },
      null,
      { label: 'Location View...', run: run('AELOCVIEW') },
      { label: 'Reports...', run: run('AEREPORT bom') },
      { label: 'Cable Schedule...', run: run('AECABLESCHEDULE') },
      { label: 'Report Templates...', run: run('AEREPORTTEMPLATES') },
      { label: 'Run Report Template...', run: run('AEREPORTRUN') },
      null,
      { label: 'Project Properties...', run: run('AEPROJECTPROPS') },
      { label: 'Drawing Properties...', run: run('AEDRAWINGPROPS') },
    ];
  }

  private statusDetails(): string {
    const path = this.editor.doc.filePath;
    const st = (path && projectStatus.get(path)) || projectStatus.get(this.editor.fileName());
    if (!st) return '';
    const rows: string[] = [];
    if (st.inst.length) rows.push(`<div class="kv"><span>Installation</span><span>${esc(st.inst.join(', '))}</span></div>`);
    if (st.loc.length) rows.push(`<div class="kv"><span>Location</span><span>${esc(st.loc.join(', '))}</span></div>`);
    if (st.xrefIssues !== undefined) rows.push(`<div class="kv"><span>Cross-ref</span><span>${st.xrefIssues ? `${st.xrefIssues} issue(s)` : 'OK'}${st.xrefTime ? ` (${esc(st.xrefTime)})` : ''}</span></div>`);
    return rows.join('');
  }

  private renderDetails(): void {
    const doc = this.editor.doc;
    const counts = new Map<string, number>();
    for (const e of doc.entities) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    const comps = doc.entities.filter((e) => e.type === 'insert').length;
    const wires = doc.entities.filter((e) => e.type === 'line' && e.layer === 'WIRES').length;
    const sel = this.editor.selection.size;
    this.detailsEl.innerHTML = `
      <div class="kv"><span>File</span><span>${esc(this.editor.fileName())}</span></div>
      <div class="kv"><span>Status</span><span>${doc.dirty ? 'Modified' : 'Saved'}</span></div>
      <div class="kv"><span>Layers</span><span>${doc.layers.length}</span></div>
      <div class="kv"><span>Objects</span><span>${doc.entities.length}</span></div>
      <div class="kv"><span>Components</span><span>${comps}</span></div>
      <div class="kv"><span>Wires</span><span>${wires}</span></div>
      <div class="kv"><span>Selected</span><span>${sel}</span></div>
      ${this.statusDetails()}
    `;
  }
}
