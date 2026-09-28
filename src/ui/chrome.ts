import type { Editor } from '../app/editor';
import { icon } from './icons';
import './icons-ui';
import { esc } from './dom';
import { drawPreview } from '../render/draw';
import { sessionTitle } from '../app/sessions';
import { showMenu, type MenuItem } from './menu';
import { symbolBuilderOf } from '../tools/symbol-builder';

/** Title bar with Quick Access Toolbar, InfoCenter search and the application-menu button. */
export function buildTitleBar(editor: Editor, el: HTMLElement, onAppMenu?: (anchor: HTMLElement) => void): void {
  el.className = 'titlebar';
  const qat: Array<[string, string, string]> = [
    ['new', 'New (Ctrl+N)', 'NEW'],
    ['open', 'Open (Ctrl+O)', 'OPEN'],
    ['save', 'Save (Ctrl+S)', 'SAVE'],
    ['saveas', 'Save As (Ctrl+Shift+S)', 'SAVEAS'],
    ['print', 'Plot (Ctrl+P)', 'PLOT'],
    ['undo', 'Undo (Ctrl+Z)', 'UNDO'],
    ['redo', 'Redo (Ctrl+Y)', 'REDO'],
  ];
  const logo = document.createElement('button');
  logo.className = 'app-logo';
  logo.innerHTML = `${icon('bolt')}<span>J</span>`;
  logo.title = 'Application menu';
  logo.addEventListener('click', () => onAppMenu?.(logo));
  const bar = document.createElement('div');
  bar.className = 'qat';
  for (const [ic, title, cmd] of qat) {
    const b = document.createElement('button');
    b.className = 'qat-btn';
    b.innerHTML = icon(ic);
    b.title = title;
    b.addEventListener('click', () => editor.runCommand(cmd));
    bar.appendChild(b);
  }
  const more = document.createElement('button');
  more.className = 'qat-btn qat-more';
  more.innerHTML = icon('chevron');
  more.title = 'Customize Quick Access Toolbar';
  more.addEventListener('click', () =>
    showMenu(more, [
      { label: 'Workspace: Drafting & Annotation', check: editor.settings.workspace === 'drafting', run: () => editor.runCommand('WORKSPACE drafting') },
      { label: 'Workspace: Electrical', check: editor.settings.workspace === 'electrical', run: () => editor.runCommand('WORKSPACE electrical') },
      null,
      { label: 'Show Menu Bar (F10 in AutoCAD)', run: () => editor.log('The native menu bar is provided by the desktop window.') },
      { label: 'Options...', run: () => editor.runCommand('OPTIONS') },
    ]),
  );
  bar.appendChild(more);
  const title = document.createElement('div');
  title.className = 'window-title';
  const search = document.createElement('div');
  search.className = 'title-search';
  search.innerHTML = `<input placeholder="Type a keyword or phrase" spellcheck="false">${icon('search')}`;
  const searchInput = search.querySelector('input')!;
  searchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      editor.runCommand(`HELP ${searchInput.value}`);
      searchInput.value = '';
    }
  });
  const infocenter = document.createElement('div');
  infocenter.className = 'infocenter';
  infocenter.innerHTML = `<button class="ic-btn user" title="About JCad Electrical, the author and how to support the project">${icon('user')}<span>Support</span></button><button class="ic-btn" title="Help (F1)">${icon('help')}</button>`;
  infocenter.querySelector('.ic-btn.user')!.addEventListener('click', () => editor.runCommand('ABOUT'));
  infocenter.querySelector('.ic-btn:last-child')!.addEventListener('click', () => editor.runCommand('HELP'));
  el.append(logo, bar, title, search, infocenter);
  const refresh = () => {
    title.textContent = `JCad Electrical  —  ${editor.fileName()}${editor.doc.dirty ? '*' : ''}`;
    document.title = `${editor.fileName()}${editor.doc.dirty ? '*' : ''} — JCad Electrical`;
  };
  editor.on('file', refresh);
  editor.on('change', refresh);
  refresh();
}

/** Drawing file tabs above the canvas: one per open document session. */
export function buildFileTabs(editor: Editor, el: HTMLElement): void {
  el.className = 'file-tabs';
  let preview: HTMLElement | null = null;
  let previewTimer = 0;
  const hidePreview = () => {
    window.clearTimeout(previewTimer);
    preview?.remove();
    preview = null;
  };
  const closeTab = (i: number) => {
    const doIt = () => editor.sessions.close(i);
    const sb = symbolBuilderOf(editor);
    if (sb.isSymbolSession(i)) return void sb.closeSession(i);
    if (!editor.sessions.isDirty(i)) return doIt();
    void editor.ui?.confirm('Unsaved changes', `${editor.sessions.titleOf(i)} has unsaved changes. Discard them?`).then((ok) => {
      if (ok) doIt();
    });
  };
  const refresh = () => {
    hidePreview();
    el.innerHTML = '';
    const sessions = editor.sessions.all;
    sessions.forEach((s, i) => {
      const tab = document.createElement('div');
      const active = i === editor.sessions.active;
      tab.className = 'file-tab' + (active ? ' active' : '');
      const dirty = editor.sessions.isDirty(i);
      tab.innerHTML = `<span class="file-tab-name">${esc(sessionTitle(s))}${dirty ? '*' : ''}</span><button class="file-tab-close" title="Close">${icon('close')}</button>`;
      tab.title = s.filePath ?? sessionTitle(s);
      tab.addEventListener('click', (ev) => {
        if ((ev.target as HTMLElement).closest('.file-tab-close')) return;
        editor.switchSession(i);
      });
      tab.addEventListener('auxclick', (ev) => {
        if (ev.button === 1) {
          ev.preventDefault();
          closeTab(i);
        }
      });
      tab.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        showMenu({ x: ev.clientX, y: ev.clientY }, [
          { label: 'New', run: () => editor.runCommand('NEW') },
          { label: 'Open...', run: () => editor.runCommand('OPEN') },
          { label: 'Save', run: () => editor.runCommand('SAVE') },
          { label: 'Save As...', run: () => editor.runCommand('SAVEAS') },
          null,
          { label: 'Close', run: () => closeTab(i) },
          { label: 'Close All Other Drawings', run: () => editor.runCommand('CLOSEALLOTHER') },
          null,
          { label: 'Copy Full File Path', disabled: !s.filePath, run: () => void navigator.clipboard?.writeText(s.filePath ?? '') },
        ]);
      });
      tab.querySelector('.file-tab-close')!.addEventListener('click', () => closeTab(i));
      // Hover preview thumbnail (AutoCAD shows model/layout thumbnails).
      tab.addEventListener('mouseenter', () => {
        window.clearTimeout(previewTimer);
        previewTimer = window.setTimeout(() => {
          hidePreview();
          const st = i === editor.sessions.active ? editor.doc.snapshot : s.state;
          preview = document.createElement('div');
          preview.className = 'file-tab-preview';
          const c = document.createElement('canvas');
          c.width = 220;
          c.height = 150;
          const ctx = c.getContext('2d')!;
          ctx.fillStyle = editor.viewport.settings.background;
          ctx.fillRect(0, 0, c.width, c.height);
          drawPreview(ctx, st.entities, st.layers, (n) => st.blocks[n], c.width, c.height, '#d8d8d8', 10);
          const cap = document.createElement('div');
          cap.className = 'file-tab-preview-title';
          cap.textContent = `${sessionTitle(s)} — Model`;
          preview.append(c, cap);
          document.body.appendChild(preview);
          const r = tab.getBoundingClientRect();
          preview.style.left = `${Math.min(r.left, window.innerWidth - 240)}px`;
          preview.style.top = `${r.bottom + 2}px`;
        }, 450);
      });
      tab.addEventListener('mouseleave', hidePreview);
      el.appendChild(tab);
    });
    const add = document.createElement('button');
    add.className = 'file-tab-add';
    add.title = 'New drawing (Ctrl+N)';
    add.innerHTML = icon('plus');
    add.addEventListener('click', () => editor.runCommand('NEW'));
    const spacer = document.createElement('span');
    spacer.className = 'file-tabs-spacer';
    const list = document.createElement('button');
    list.className = 'file-tab-list';
    list.title = 'File tab list';
    list.innerHTML = icon('chevron');
    list.addEventListener('click', () =>
      showMenu(
        list,
        editor.sessions.all.map((s, i) => ({ label: `${sessionTitle(s)}${editor.sessions.isDirty(i) ? '*' : ''}`, check: i === editor.sessions.active, run: () => editor.switchSession(i) })),
      ),
    );
    el.append(add, spacer, list);
  };
  editor.on('file', refresh);
  editor.on('change', refresh);
  refresh();
}

/** Model / Layout tabs under the canvas. */
export function buildLayoutTabs(editor: Editor, el: HTMLElement): void {
  el.className = 'layout-tabs';
  el.innerHTML = `
    <button class="layout-tab active">Model</button>
    <button class="layout-tab">Layout1</button>
    <button class="layout-tab">Layout2</button>
    <button class="layout-tab add" title="New layout">${icon('plus')}</button>`;
  el.querySelectorAll<HTMLButtonElement>('.layout-tab:not(.active):not(.add)').forEach((b) =>
    b.addEventListener('click', () => editor.log('Paper-space layouts are not available yet; plot from model space with PLOT.')),
  );
}

/** Right-click context menu on the canvas (with Recent Input, Clipboard and Isolate flyouts). */
export function installContextMenu(editor: Editor, canvas: HTMLElement, opts: { recentInput?: () => readonly string[]; runInput?: (text: string) => void; clipboard?: { cut(): void; copy(): void; paste(): void; canPaste(): boolean } } = {}): void {
  canvas.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const recent = opts.recentInput?.() ?? [];
    const recentItems: MenuItem[] = recent.length ? recent.slice(0, 12).map((r) => ({ label: r, run: () => (opts.runInput ? opts.runInput(r) : editor.runCommand(r)) })) : [{ label: '(no recent input)', disabled: true, run: () => {} }];
    const hasSel = editor.selection.size > 0;
    const items: MenuItem[] = editor.tool
      ? [
          { label: 'Enter', run: () => editor.pressEnter() },
          { label: 'Cancel', run: () => editor.cancel() },
          null,
          { label: 'Recent Input', items: recentItems },
          null,
          { label: 'Pan', run: () => editor.runCommand('PAN') },
          { label: 'Zoom Extents', run: () => editor.zoomExtents() },
          { label: 'Zoom Window', run: () => editor.runCommand('ZOOM W') },
          null,
          { label: 'Snap Overrides', items: [{ label: 'Object Snap Settings...', run: () => editor.runCommand('DSETTINGS') }, { label: 'Toggle Object Snap (F3)', run: () => editor.toggle('osnap') }, { label: 'Toggle Ortho (F8)', run: () => editor.toggle('ortho') }, { label: 'Toggle Polar (F10)', run: () => editor.toggle('polar') }] },
        ]
      : [
          { label: editor.lastCommand ? `Repeat ${editor.lastCommand}` : 'Repeat', run: () => editor.pressEnter(), disabled: !editor.lastCommand },
          { label: 'Recent Input', items: recentItems },
          null,
          {
            label: 'Clipboard',
            items: [
              { label: 'Cut\tCtrl+X', disabled: !hasSel, run: () => opts.clipboard?.cut() },
              { label: 'Copy\tCtrl+C', disabled: !hasSel, run: () => opts.clipboard?.copy() },
              { label: 'Paste\tCtrl+V', disabled: !(opts.clipboard?.canPaste() ?? false), run: () => opts.clipboard?.paste() },
            ],
          },
          {
            label: 'Isolate',
            items: [
              { label: 'Isolate Objects (layers of selection)', disabled: !hasSel, run: () => editor.runCommand('LAYISO') },
              { label: 'Hide Objects (turn layer off)', disabled: !hasSel, run: () => editor.runCommand('LAYOFF') },
              { label: 'End Object Isolation', run: () => editor.runCommand('LAYUNISO') },
            ],
          },
          null,
          { label: 'Undo\tCtrl+Z', run: () => editor.runCommand('UNDO'), disabled: !editor.doc.canUndo() },
          { label: 'Redo\tCtrl+Y', run: () => editor.runCommand('REDO'), disabled: !editor.doc.canRedo() },
          null,
          { label: 'Erase', disabled: !hasSel, run: () => editor.runCommand('ERASE') },
          { label: 'Move', disabled: !hasSel, run: () => editor.runCommand('MOVE') },
          { label: 'Copy Selection', disabled: !hasSel, run: () => editor.runCommand('COPY') },
          { label: 'Rotate', disabled: !hasSel, run: () => editor.runCommand('ROTATE') },
          { label: 'Scale', disabled: !hasSel, run: () => editor.runCommand('SCALE') },
          null,
          { label: 'Pan', run: () => editor.runCommand('PAN') },
          { label: 'Zoom Extents', run: () => editor.zoomExtents() },
          { label: 'Zoom Window', run: () => editor.runCommand('ZOOM W') },
          null,
          { label: 'Quick Select...', run: () => editor.runCommand('SELECTALL') },
          { label: 'Select All\tCtrl+A', run: () => editor.runCommand('SELECTALL') },
          { label: 'Deselect All', disabled: !hasSel, run: () => editor.cancel() },
          null,
          { label: 'Quick Properties', check: editor.settings.quickProperties, run: () => editor.runCommand('QPMODE') },
          { label: 'Properties', run: () => editor.runCommand('PROPERTIES') },
          { label: 'Options...', run: () => editor.runCommand('OPTIONS') },
        ];
    showMenu({ x: ev.clientX, y: ev.clientY }, items);
  });
}

/** Navigation bar under the ViewCube (wheel, pan, zoom, orbit, show motion). */
export function buildNavBar(editor: Editor, el: HTMLElement): void {
  const items: Array<[string, string, () => void]> = [
    ['navwheel', 'Navigation wheel', () => editor.runCommand('PAN')],
    ['pan', 'Pan', () => editor.runCommand('PAN')],
    ['zoomext', 'Zoom extents', () => editor.zoomExtents()],
    ['zoomwin', 'Zoom window', () => editor.runCommand('ZOOM W')],
    ['orbit', 'Orbit (2D drawing: not available)', () => editor.log('Orbit is not available in a 2D drawing.')],
  ];
  for (const [ic, title, fn] of items) {
    const b = document.createElement('button');
    b.className = 'nav-btn';
    b.title = title;
    b.innerHTML = icon(ic);
    b.addEventListener('click', fn);
    el.appendChild(b);
  }
}
