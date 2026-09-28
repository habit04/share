import type { Editor } from '../app/editor';
import { icon } from './icons';
import './icons-ui';
import { esc } from './dom';
import { baseName } from '../app/project';
import { closeMenus } from './menu';

interface AppMenuEntry {
  label: string;
  icon: string;
  run?: () => void;
  sub?: Array<{ label: string; run: () => void }>;
}

/** The application menu behind the red "J" button: file commands plus Recent Documents. */
export function showAppMenu(editor: Editor, _anchor: HTMLElement, opts: { exit?: () => void } = {}): void {
  closeMenus();
  document.querySelector('.appmenu')?.remove();
  const root = document.createElement('div');
  root.className = 'appmenu';
  const left = document.createElement('div');
  left.className = 'appmenu-left';
  const right = document.createElement('div');
  right.className = 'appmenu-right';
  const footer = document.createElement('div');
  footer.className = 'appmenu-footer';
  root.append(left, right, footer);
  document.body.appendChild(root);
  const close = () => {
    root.remove();
    window.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
  };
  const onDown = (ev: MouseEvent) => {
    if (!root.contains(ev.target as Node)) close();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      close();
    }
  };
  setTimeout(() => {
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
  }, 0);
  const run = (cmd: string) => () => {
    close();
    editor.runCommand(cmd);
  };
  const entries: AppMenuEntry[] = [
    { label: 'New', icon: 'new', run: run('NEW'), sub: [{ label: 'Drawing', run: run('NEW') }, { label: 'Drawing from Sheet Template...', run: run('NEWSHEET') }] },
    { label: 'Open', icon: 'open', run: run('OPEN'), sub: [{ label: 'Drawing (DXF / DWG)...', run: run('OPEN') }, { label: 'Project...', run: run('OPENPROJECT') }] },
    { label: 'Save', icon: 'save', run: run('SAVE') },
    { label: 'Save As', icon: 'saveas', run: run('SAVEAS') },
    { label: 'Export', icon: 'export', sub: [{ label: 'DXF (AutoCAD 2000)...', run: run('SAVEAS') }, { label: 'PDF...', run: run('PLOT') }, { label: 'Bill of Material CSV...', run: run('AEREPORT bom') }, { label: 'Wire From/To CSV...', run: run('AEREPORT wires') }] },
    { label: 'Plot', icon: 'plot', run: run('PLOT') },
    { label: 'Drawing Utilities', icon: 'wrench', sub: [{ label: 'Drawing Properties...', run: run('AEDRAWINGPROPS') }, { label: 'Units (Options > Units)', run: run('OPTIONS 4') }, { label: 'Audit report', run: run('AEREPORT audit') }, { label: 'Purge (blocks, layers, linetypes)...', run: run('PURGE') }] },
    { label: 'Close', icon: 'close', run: run('CLOSE'), sub: [{ label: 'Current Drawing', run: run('CLOSE') }, { label: 'All Drawings', run: run('CLOSEALL') }] },
  ];
  const showRecent = () => {
    right.innerHTML = '<h4>Recent Documents</h4>';
    const recent = editor.settings.recentFiles;
    if (recent.length === 0) {
      const e = document.createElement('div');
      e.className = 'appmenu-empty';
      e.textContent = 'No recent documents.';
      right.appendChild(e);
    }
    recent.forEach((f, i) => {
      const b = document.createElement('button');
      b.className = 'appmenu-recent';
      b.innerHTML = `${icon(f.endsWith('.json') ? 'project' : 'model')}<span>${i + 1}. ${esc(baseName(f))}</span><span class="path">${esc(f)}</span>`;
      b.title = f;
      b.addEventListener('click', () => {
        close();
        editor.runCommand(`RECENT ${i + 1}`);
      });
      right.appendChild(b);
    });
  };
  const showSub = (e: AppMenuEntry) => {
    right.innerHTML = `<h4>${esc(e.label)}</h4>`;
    for (const s of e.sub ?? []) {
      const b = document.createElement('button');
      b.className = 'appmenu-recent';
      b.innerHTML = `${icon(e.icon)}<span>${esc(s.label)}</span>`;
      b.addEventListener('click', s.run);
      right.appendChild(b);
    }
  };
  for (const e of entries) {
    const b = document.createElement('button');
    b.className = 'appmenu-item';
    b.innerHTML = `${icon(e.icon)}<span>${esc(e.label)}</span>${e.sub ? `<span class="appmenu-arrow">${icon('chevron')}</span>` : ''}`;
    b.addEventListener('mouseenter', () => {
      left.querySelectorAll('.appmenu-item').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      if (e.sub) showSub(e);
      else showRecent();
    });
    b.addEventListener('click', () => {
      if (e.run) e.run();
      else if (e.sub) showSub(e);
    });
    left.appendChild(b);
  }
  showRecent();
  const opt = document.createElement('button');
  opt.className = 'btn';
  opt.textContent = 'Options';
  opt.addEventListener('click', run('OPTIONS'));
  const exit = document.createElement('button');
  exit.className = 'btn';
  exit.textContent = 'Exit JCad Electrical';
  exit.addEventListener('click', () => {
    close();
    if (opts.exit) opts.exit();
    else window.close();
  });
  footer.append(opt, exit);
}
