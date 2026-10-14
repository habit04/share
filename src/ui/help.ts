import type { Editor, CommandDef } from '../app/editor';
import { modal, button, tabbedDialog } from './dialogkit';
import { esc } from './dom';
import { aboutInfo, donateUrl, authorLinks, safeAboutUrl, licenseLineHtml, supportContact } from '../app/about';
import { hasDwgSave } from '../app/drawing-save';
import { collectGpuDiagnostics, emptyGpuDiagnostics, gpuDiagnosticsLines, type GpuDiagnosticsBridge } from '../app/gpu-diagnostics';

/** Version compiled into the renderer (package.json version via Vite define). */
export const APP_VERSION_LABEL: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

export const SHORTCUTS: Array<[string, string]> = [
  ['F1', 'Help'],
  ['F2', 'Text window (command history)'],
  ['F3', 'Object snap on/off'],
  ['F7', 'Grid on/off'],
  ['F8', 'Ortho on/off'],
  ['F9', 'Grid snap on/off'],
  ['F10', 'Polar tracking on/off'],
  ['F12', 'Dynamic input on/off'],
  ['Esc', 'Cancel / deselect'],
  ['Enter / Space', 'Repeat last command / accept'],
  ['Ctrl+N', 'New drawing (new file tab)'],
  ['Ctrl+O', 'Open drawing'],
  ['Ctrl+S', 'Save'],
  ['Ctrl+Shift+S', 'Save As'],
  ['Ctrl+P', 'Plot to PDF'],
  ['Ctrl+Shift+P', 'Print (system print dialog)'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'],
  ['Ctrl+A', 'Select all'],
  ['Ctrl+C / Ctrl+X / Ctrl+V', 'Copy / Cut / Paste objects'],
  ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous drawing tab'],
  ['Ctrl+W, Ctrl+F4', 'Close drawing tab'],
  ['Ctrl+1', 'Properties palette'],
  ['Ctrl+3', 'Tool Palettes'],
  ['Ctrl+9', 'Command window on/off'],
  ['Ctrl+0', 'Clean screen'],
  ['Delete', 'Erase selection'],
  ['Wheel / middle drag', 'Zoom / pan; double middle-click zooms extents'],
  ['Shift+click', 'Remove from selection'],
  ['Right-click', 'Context menu (Repeat, Recent Input, Clipboard, Isolate ...)'],
];

/** HELP / F1: searchable command reference built from the registered commands. */
export function helpDialog(editor: Editor, query = ''): void {
  const m = modal('JCad Electrical Help', 760, 'dark');
  const openAbout = /^about$/i.test(query.trim());
  // HELP shortcuts (Help > Keyboard Shortcuts in the desktop menu) opens that tab instead of searching for the word.
  const openShortcuts = /^(shortcuts|keys)$/i.test(query.trim());
  if (openAbout || openShortcuts) query = '';
  const commands = document.createElement('div');
  const search = document.createElement('input');
  search.className = 'input help-search';
  search.placeholder = 'Search commands, aliases or descriptions';
  search.value = query;
  search.spellcheck = false;
  search.addEventListener('keydown', (ev) => ev.stopPropagation());
  const wrap = document.createElement('div');
  wrap.className = 'help-wrap';
  const table = document.createElement('table');
  table.className = 'help-table';
  const unique = (): CommandDef[] => {
    const seen = new Set<CommandDef>();
    const out: CommandDef[] = [];
    for (const d of editor.commands.values()) {
      if (seen.has(d)) continue;
      seen.add(d);
      out.push(d);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const rows = unique().filter((d) => !q || d.name.toLowerCase().includes(q) || d.aliases.some((a) => a.toLowerCase().includes(q)) || d.description.toLowerCase().includes(q));
    table.innerHTML = `<thead><tr><th>Command</th><th>Aliases</th><th>Description</th></tr></thead>`;
    const tb = document.createElement('tbody');
    for (const d of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="cmd" title="Run ${esc(d.name)}">${esc(d.name)}</td><td class="alias">${esc(d.aliases.join(', '))}</td><td>${esc(d.description)}</td>`;
      tr.querySelector('.cmd')!.addEventListener('click', () => {
        m.close();
        editor.runCommand(d.name);
      });
      tb.appendChild(tr);
    }
    if (rows.length === 0) tb.innerHTML = '<tr><td colspan="3">No matching commands.</td></tr>';
    table.appendChild(tb);
    count.textContent = `${rows.length} command(s)`;
  };
  const count = document.createElement('div');
  count.className = 'dlg-note';
  search.addEventListener('input', render);
  wrap.appendChild(table);
  commands.append(search, wrap, count);
  render();

  const keys = document.createElement('div');
  keys.className = 'help-keys';
  for (const [k, d] of SHORTCUTS) {
    const r = document.createElement('div');
    r.className = 'kv';
    r.innerHTML = `<span><kbd>${esc(k)}</kbd></span><span>${esc(d)}</span>`;
    keys.appendChild(r);
  }
  const keysWrap = document.createElement('div');
  keysWrap.append(keys);

  const about = document.createElement('div');
  const ab = aboutInfo();
  const openLink = (url: string) => {
    const safe = safeAboutUrl(url);
    if (!safe) return;
    if (window.jcad?.openExternal) void window.jcad.openExternal(safe);
    else window.open(safe, '_blank', 'noopener');
  };
  about.innerHTML = `<p><b>JCad Electrical</b> <span class="help-version">${esc(APP_VERSION_LABEL)}</span> — 2D electrical schematic drafting.</p>
    <p>Type commands at the command line (AutoComplete lists matches as you type; Tab cycles, Enter accepts). Option keywords in [brackets] are clickable. Coordinates: <code>x,y</code>, <code>@dx,dy</code>, <code>@dist&lt;angle</code>, or type a distance while dragging.</p>
    <p>Native DXF (AutoCAD 2000) save; ${hasDwgSave(editor.fileBridge) ? 'portable DWG save (Windows); ' : ''}DWG R14–2018 import; PDF plot; CSV reports. All artwork and symbol geometry are original.</p>
    <p class="help-update-row"></p>
    <div class="about-author"></div>
    <div class="about-donate"></div>
    <p class="dlg-note about-license">${licenseLineHtml()}</p>`;
  for (const a of about.querySelectorAll<HTMLAnchorElement>('.about-license a[data-about-url]')) {
    a.style.color = 'var(--accent)';
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      openLink(a.dataset.aboutUrl ?? '');
    });
  }
  const authorEl = about.querySelector('.about-author') as HTMLElement;
  if (ab.author.name || ab.author.bio) {
    const head = document.createElement('h4');
    head.textContent = ab.author.name ? `Made by ${ab.author.name}${ab.author.title ? `, ${ab.author.title}` : ''}${ab.author.location ? ` (${ab.author.location})` : ''}` : 'About the author';
    authorEl.appendChild(head);
    if (ab.author.bio) {
      const bio = document.createElement('p');
      bio.textContent = ab.author.bio;
      authorEl.appendChild(bio);
    }
    const links = authorLinks();
    if (links.length) {
      const row = document.createElement('div');
      row.className = 'about-links';
      for (const l of links) {
        const b = button(l.label);
        b.addEventListener('click', () => openLink(l.url));
        row.appendChild(b);
      }
      authorEl.appendChild(row);
    }
  }
  const contact = supportContact();
  if (contact) {
    const row = document.createElement('p');
    row.className = 'about-contact';
    row.append('Bugs or feature requests: ');
    const link = document.createElement('a');
    link.href = contact.url; link.textContent = contact.email;
    link.style.color = 'var(--accent)';
    link.addEventListener('click', (ev) => {
      if (window.jcad?.openExternal) { ev.preventDefault(); void window.jcad.openExternal(contact.url); }
    });
    row.append(link); authorEl.append(row);
  }
  const donateEl = about.querySelector('.about-donate') as HTMLElement;
  const donate = donateUrl();
  if (donate) {
    const msg = document.createElement('p');
    msg.textContent = ab.donate.message;
    const b = button(`Donate with Cash App ($${ab.donate.cashtag.replace(/^\$/, '')})`, true);
    b.addEventListener('click', () => openLink(donate));
    donateEl.append(msg, b);
  }
  const updateRow = about.querySelector('.help-update-row') as HTMLElement;
  const info = document.createElement('span');
  info.className = 'dlg-note';
  info.textContent = 'Version information is available in the desktop application.';
  const check = button('Check for Updates…');
  check.addEventListener('click', () => {
    m.close();
    editor.runCommand('CHECKUPDATES');
  });
  const report = button('Report a Problem…');
  report.addEventListener('click', () => {
    m.close();
    editor.runCommand('REPORTBUG');
  });
  updateRow.append(check, report, info);
  const bridge = window.jcad;
  const gpuSection = document.createElement('section');
  gpuSection.setAttribute('aria-label', 'GPU diagnostics');
  const gpuHeading = document.createElement('h4');
  gpuHeading.textContent = 'GPU diagnostics';
  const gpuText = document.createElement('pre');
  gpuText.style.whiteSpace = 'pre-wrap';
  gpuText.style.overflowWrap = 'anywhere';
  const gpuStatus = document.createElement('div');
  gpuStatus.className = 'dlg-note';
  gpuStatus.setAttribute('role', 'status');
  const retryGpu = button('Retry Diagnostics');
  const copyGpu = button('Copy Diagnostics');
  let gpu = emptyGpuDiagnostics('pending', APP_VERSION_LABEL);
  let generation = 0;
  const renderGpu = () => { gpuText.textContent = gpuDiagnosticsLines(gpu).join('\n'); };
  const loadGpu = async () => {
    const request = ++generation;
    gpu = emptyGpuDiagnostics('pending', APP_VERSION_LABEL);
    renderGpu();
    retryGpu.disabled = true;
    copyGpu.disabled = true;
    gpuStatus.textContent = 'Collecting diagnostics…';
    const result = await collectGpuDiagnostics(bridge as GpuDiagnosticsBridge | undefined, APP_VERSION_LABEL);
    if (request !== generation || !m.root.isConnected) return;
    gpu = result;
    renderGpu();
    retryGpu.disabled = false;
    copyGpu.disabled = false;
    gpuStatus.textContent = gpu.state === 'pending' ? 'Diagnostics are still pending. You can retry.' : gpu.state === 'unavailable' ? 'Diagnostics are unavailable in this session. You can retry.' : '';
  };
  retryGpu.addEventListener('click', () => void loadGpu());
  copyGpu.addEventListener('click', () => {
    void (async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(gpuDiagnosticsLines(gpu).join('\n'));
        gpuStatus.textContent = 'Diagnostics copied.';
      } catch {
        gpuStatus.textContent = 'Could not copy diagnostics. Select the diagnostic text and copy it manually.';
      }
    })();
  });
  gpuSection.append(gpuHeading, gpuText, copyGpu, retryGpu, gpuStatus);
  about.append(gpuSection);
  renderGpu();
  void loadGpu();
  if (bridge?.appInfo) {
    void bridge.appInfo().then((i) => {
      info.textContent = `Version ${i.version} (${i.platform} ${i.arch})${i.selfUpdate ? ' — updates install in place from GitHub Releases.' : ' — new versions are offered from the GitHub Releases page.'}`;
    }).catch(() => { info.textContent = `Version ${APP_VERSION_LABEL} — desktop version information unavailable.`; });
  } else {
    check.disabled = true;
    info.textContent = `Version ${APP_VERSION_LABEL} (browser preview) — updates are delivered with the desktop application.`;
  }

  m.body.appendChild(tabbedDialog([['Commands', commands], ['Keyboard Shortcuts', keysWrap], ['About', about]], openAbout ? 2 : openShortcuts ? 1 : 0));
  const close = button('Close', true);
  close.addEventListener('click', () => m.close());
  m.footer.append(close);
  setTimeout(() => search.focus(), 0);
}

/** TEXTSCR / F2: the command history in a larger, selectable window. */
export function textWindowDialog(editor: Editor): void {
  const m = modal('JCad Electrical Text Window', 760, 'dark');
  const pre = document.createElement('div');
  pre.className = 'text-window';
  pre.textContent = editor.history.join('\n');
  m.body.appendChild(pre);
  pre.scrollTop = pre.scrollHeight;
  const copy = button('Copy All');
  copy.className += ' left';
  copy.addEventListener('click', () => void navigator.clipboard?.writeText(editor.history.join('\n')));
  const clear = button('Clear History');
  clear.addEventListener('click', () => {
    editor.history.length = 0;
    editor.notify('log');
    pre.textContent = '';
  });
  const close = button('Close', true);
  close.addEventListener('click', () => m.close());
  m.footer.append(copy, clear, close);
  const off = editor.on('log', () => {
    pre.textContent = editor.history.join('\n');
    pre.scrollTop = pre.scrollHeight;
  });
  m.onClose(off);
  close.addEventListener('click', off);
}
