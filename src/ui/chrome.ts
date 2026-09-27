import type { Editor } from '../app/editor';
import { icon } from './icons';

/** Title bar with Quick Access Toolbar. */
export function buildTitleBar(editor: Editor, el: HTMLElement): void {
  el.className = 'titlebar';
  const qat: Array<[string, string, string]> = [
    ['new', 'New (Ctrl+N)', 'NEW'],
    ['open', 'Open (Ctrl+O)', 'OPEN'],
    ['save', 'Save (Ctrl+S)', 'SAVE'],
    ['saveas', 'Save As (Ctrl+Shift+S)', 'SAVEAS'],
    ['print', 'Plot', 'HELP'],
    ['undo', 'Undo (Ctrl+Z)', 'UNDO'],
    ['redo', 'Redo (Ctrl+Y)', 'REDO'],
  ];
  const logo = document.createElement('div');
  logo.className = 'app-logo';
  logo.innerHTML = `${icon('bolt')}<span>V</span>`;
  logo.title = 'VoltCAD 2D';
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
  const title = document.createElement('div');
  title.className = 'window-title';
  const search = document.createElement('div');
  search.className = 'title-search';
  search.innerHTML = `<input placeholder="Type a keyword or phrase" spellcheck="false">${icon('search')}`;
  const searchInput = search.querySelector('input')!;
  searchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      editor.runCommand(searchInput.value);
      searchInput.value = '';
    }
  });
  el.append(logo, bar, title, search);
  const refresh = () => {
    title.textContent = `VoltCAD 2D Electrical  —  ${editor.fileName()}${editor.doc.dirty ? '*' : ''}`;
    document.title = `${editor.fileName()}${editor.doc.dirty ? '*' : ''} — VoltCAD 2D Electrical`;
  };
  editor.on('file', refresh);
  editor.on('change', refresh);
  refresh();
}

/** Drawing file tabs above the canvas. */
export function buildFileTabs(editor: Editor, el: HTMLElement): void {
  el.className = 'file-tabs';
  const refresh = () => {
    el.innerHTML = `<div class="file-tab active"><span>${editor.fileName()}${editor.doc.dirty ? '*' : ''}</span>${icon('close')}</div><button class="file-tab-add" title="New drawing">${icon('plus')}</button>`;
    el.querySelector('.file-tab-add')!.addEventListener('click', () => editor.runCommand('NEW'));
  };
  editor.on('file', refresh);
  editor.on('change', refresh);
  refresh();
}

/** Model / Layout tabs under the canvas. */
export function buildLayoutTabs(_editor: Editor, el: HTMLElement): void {
  el.className = 'layout-tabs';
  el.innerHTML = `
    <button class="layout-tab active">Model</button>
    <button class="layout-tab">Layout1</button>
    <button class="layout-tab">Layout2</button>
    <button class="layout-tab add" title="New layout">${icon('plus')}</button>`;
}

/** Right-click context menu on the canvas. */
export function installContextMenu(editor: Editor, canvas: HTMLElement): void {
  let menu: HTMLElement | null = null;
  const hide = () => {
    menu?.remove();
    menu = null;
  };
  canvas.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    hide();
    menu = document.createElement('div');
    menu.className = 'context-menu';
    const items: Array<[string, () => void] | null> = editor.tool
      ? [
          ['Enter', () => editor.pressEnter()],
          ['Cancel', () => editor.cancel()],
          null,
          ['Pan', () => {}],
          ['Zoom Extents', () => editor.zoomExtents()],
        ]
      : [
          [editor.lastCommand ? `Repeat ${editor.lastCommand}` : 'Repeat', () => editor.pressEnter()],
          null,
          ['Erase', () => editor.runCommand('ERASE')],
          ['Move', () => editor.runCommand('MOVE')],
          ['Copy Selection', () => editor.runCommand('COPY')],
          ['Rotate', () => editor.runCommand('ROTATE')],
          null,
          ['Undo', () => editor.runCommand('UNDO')],
          ['Redo', () => editor.runCommand('REDO')],
          null,
          ['Zoom Extents', () => editor.zoomExtents()],
          ['Deselect All', () => editor.cancel()],
        ];
    for (const it of items) {
      if (!it) {
        const sep = document.createElement('div');
        sep.className = 'context-sep';
        menu.appendChild(sep);
        continue;
      }
      const b = document.createElement('button');
      b.className = 'context-item';
      b.textContent = it[0];
      b.addEventListener('click', () => {
        hide();
        it[1]();
      });
      menu.appendChild(b);
    }
    menu.style.left = `${ev.clientX}px`;
    menu.style.top = `${ev.clientY}px`;
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    if (r.bottom > window.innerHeight) menu.style.top = `${ev.clientY - r.height}px`;
    if (r.right > window.innerWidth) menu.style.left = `${ev.clientX - r.width}px`;
  });
  window.addEventListener('mousedown', (ev) => {
    if (menu && !menu.contains(ev.target as Node)) hide();
  });
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') hide();
  });
}
