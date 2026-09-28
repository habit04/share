import './styles/app.css';
import './styles/parity.css';
import { Editor, type FileBridge } from './app/editor';
import { Ribbon, ELECTRICAL_TABS } from './ui/ribbon';
import { CommandLine } from './ui/commandline';
import { StatusBar } from './ui/statusbar';
import { ProjectManager } from './ui/projectmanager';
import { pickSymbolDialog, editComponentDialog, ladderDialog, textInputDialog, layerDialog, confirmDialog, saveChangesDialog, reportsDialog, templateDialog, plcDialog, terminalStripDialog, wireTypeDialog } from './ui/dialogs';
import { PropertiesPalette } from './ui/properties';
import { saveSettings } from './app/settings';
import { buildTitleBar, buildFileTabs, buildLayoutTabs, installContextMenu, buildNavBar } from './ui/chrome';
import { seedDemoDrawing } from './app/demo';
import { optionsDialog, applyUiSettings, updateSettings } from './ui/options';
import { draftingSettingsDialog } from './ui/dsettings';
import { registerLayerCommands, buildLayerPanelContent, buildPropertiesPanelContent } from './ui/layerpanel';
import { QuickProperties, installRolloverTooltips } from './ui/quickprops';
import { makePaletteResizable, installAutoHide } from './ui/palettes';
import { ToolPalettes } from './ui/toolpalettes';
import { helpDialog, textWindowDialog } from './ui/help';
import { reportProblemDialog } from './ui/report';
import { installDiagnostics } from './app/diagnostics';
import { donateUrl } from './app/about';
import { Autosaver, bridgeAutosaveStore, localAutosaveStore, type AutosaveBridge } from './app/autosave';
import { recoveryDialog } from './ui/recovery';
import { showAppMenu } from './ui/appmenu';
import { EntityClipboard } from './ui/clipboard';
import { closeMenus } from './ui/menu';
import { createSymbolBuilderUi } from './ui/symbol-builder';
import { symbolBuilderOf } from './tools/symbol-builder';
import { userLibrary, bridgeUserLibraryStore, localUserLibraryStore, type UserLibraryBridge } from './electrical/userlib';

declare global {
  interface Window {
    jcad?: {
      openDxf(): Promise<{ path: string; text: string } | null>;
      openDrawing(file?: string): Promise<import('./app/editor').OpenResult | null>;
      openProject(file?: string): Promise<{ path: string; text: string } | null>;
      saveText(suggestName: string, text: string, filterName: string, ext: string): Promise<string | null>;
      plotPdf(dataUrl: string, suggestName: string, landscape: boolean): Promise<string | null>;
      saveDxf(path: string | null, text: string, suggestName: string): Promise<string | null>;
      onMenuCommand(cb: (cmd: string) => void): void;
      onQueryDirty(cb: () => boolean): void;
      setRecentFiles?(files: string[]): void;
      quit?(): void;
      appInfo?(): Promise<{ version: string; platform: string; arch: string; packaged: boolean; selfUpdate: boolean; releases: string }>;
      openExternal?(url: string): Promise<boolean>;
      checkForUpdates?(): Promise<{ state: string; version?: string; message?: string }>;
      onUpdateStatus?(cb: (status: { state: string; version?: string; percent?: number; message?: string; manual?: boolean }) => void): void;
      platform: string;
    } & Partial<AutosaveBridge> &
      Partial<UserLibraryBridge>;
  }
}

/** Show a native file picker; resolves with the chosen File (null when cancelled). */
function pickBrowserFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      input.remove();
      resolve(input.files?.[0] ?? null);
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * File access without Electron (website / `npm run dev`): files come from the browser's
 * file picker and go to its Downloads folder. DWG files are parsed in the page by
 * LibreDWG's WebAssembly (src/io/dwg-browser.ts, loaded on first use).
 */
function browserFileBridge(): FileBridge {
  return {
    openDxf: async () => {
      const f = await pickBrowserFile('.dxf');
      return f ? { path: f.name, text: await f.text() } : null;
    },
    openDrawing: async () => {
      const f = await pickBrowserFile('.dxf,.dwg');
      if (!f) return null;
      const { drawingKindOf } = await import('./io/dwg-browser');
      if (drawingKindOf(f.name) === 'dwg') {
        const { readDwgInBrowser, describeDwgError } = await import('./io/dwg-browser');
        try {
          const { payload, version } = await readDwgInBrowser(await f.arrayBuffer());
          return { path: f.name, kind: 'dwg', payload, version };
        } catch (err) {
          throw new Error(describeDwgError(err));
        }
      }
      return { path: f.name, kind: 'dxf', text: await f.text() };
    },
    saveDxf: async (path, text, suggestName) => {
      const name = path ?? suggestName;
      const blob = new Blob([text], { type: 'application/dxf' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      return name;
    },
    // Text exports (AESYMLIBEXPORT JSON, REPORTBUG's Save Report, CSV) download in the browser build.
    saveText: (suggestName, text) => browserDownload(suggestName, text),
  };
}

/**
 * Browser edition notice (GitHub Pages). Shown with `?web`, or whenever there is no Electron
 * bridge and the page is not a `?demo` capture; the dismissal is remembered per browser.
 */
function installWebBanner(app: HTMLElement): void {
  const params = new URLSearchParams(location.search);
  const forced = params.has('web');
  if (!forced && (window.jcad || params.has('demo'))) return;
  const key = 'jcad.webBannerDismissed';
  try {
    if (!forced && localStorage.getItem(key) === '1') return;
  } catch {
    /* storage unavailable: always show */
  }
  const style = document.createElement('style');
  style.textContent = `
    .web-banner { display: flex; align-items: center; gap: 10px; padding: 5px 10px; font-size: 12px; line-height: 1.35;
      background: #1f3a5f; color: #e6eefc; border-bottom: 1px solid #3d8bff; flex: 0 0 auto; }
    .web-banner strong { font-weight: 600; }
    .web-banner span { flex: 1 1 auto; min-width: 0; }
    .web-banner a { color: #9cc4ff; white-space: nowrap; }
    .web-banner button { flex: 0 0 auto; background: transparent; border: 1px solid #6a9be0; color: inherit; border-radius: 3px;
      padding: 1px 7px; cursor: pointer; font: inherit; }
    .web-banner button:hover { background: rgba(255,255,255,0.12); }`;
  document.head.appendChild(style);
  const bar = document.createElement('div');
  bar.className = 'web-banner';
  bar.setAttribute('role', 'note');
  const text = document.createElement('span');
  const label = document.createElement('strong');
  label.textContent = 'Browser edition: ';
  text.append(label, 'files are opened from and saved to your Downloads folder; install the desktop app for autosave, projects and updates. ');
  const link = document.createElement('a');
  link.href = '../';
  link.textContent = 'Get the desktop app';
  text.appendChild(link);
  const close = document.createElement('button');
  close.type = 'button';
  close.title = 'Dismiss';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => {
    bar.remove();
    try {
      localStorage.setItem(key, '1');
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new Event('resize'));
  });
  bar.append(text, close);
  app.insertBefore(bar, app.firstChild);
}

async function browserDownload(name: string, text: string): Promise<string | null> {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return name;
}

function boot(): void {
  installDiagnostics();
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <div id="titlebar"></div>
    <div id="ribbon"></div>
    <div class="workspace">
      <div id="project-manager"></div>
      <div class="center">
        <div id="file-tabs"></div>
        <div class="canvas-wrap"><canvas id="drawing" tabindex="0"></canvas>
          <div class="viewcube" title="Top view"><span class="vc-n">N</span><span class="vc-e">E</span><span class="vc-s">S</span><span class="vc-w">W</span><span class="vc-face">TOP</span><span class="vc-wcs">WCS ▾</span></div>
          <div class="navbar" id="navbar"></div>
        </div>
        <div id="layout-tabs"></div>
        <div id="command-window"></div>
      </div>
      <div id="properties"></div>
      <div id="symbol-builder"></div>
    </div>
    <div id="statusbar"></div>`;

  installWebBanner(app);

  const canvas = document.getElementById('drawing') as HTMLCanvasElement;
  const canvasWrap = canvas.parentElement as HTMLElement;
  const editor = new Editor(canvas);
  editor.fileBridge = window.jcad ?? browserFileBridge();
  editor.ui = {
    pickSymbol: () =>
      pickSymbolDialog(editor, editor.settings.symbolStandard, (std) => {
        editor.settings = { ...editor.settings, symbolStandard: std };
        saveSettings(editor.settings);
      }),
    editComponent: (init) => editComponentDialog(editor, init),
    ladderSettings: (init) => ladderDialog(init),
    textInput: (t, l, i) => textInputDialog(t, l, i),
    confirm: (t, m) => confirmDialog(t, m),
    saveChanges: (name) => saveChangesDialog(name),
  };
  editor.layerDialogRequested = () => layerDialog(editor);
  applyUiSettings(editor);

  // ------------------------------------------------------------ commands owned by the UI layer
  const reg = (name: string, aliases: string[], description: string, run: (ed: Editor, arg?: string) => void) => editor.register({ name, aliases, description, run });
  reg('TOGGLEPM', [], 'Toggle Project Manager palette', () => {
    pm.toggle();
    editor.settings = { ...editor.settings, projectManagerVisible: !pm.el.classList.contains('hidden') };
    saveSettings(editor.settings);
  });
  registerLayerCommands(editor);

  // Multi-document: NEW / OPEN / NEWSHEET / RECENT work with file tabs.
  const origOpen = editor.commands.get('OPEN')!;
  const origNewSheet = editor.commands.get('NEWSHEET')!;
  reg('NEW', ['QNEW'], 'New drawing (opens a new file tab)', (ed) => {
    ed.sessions.add();
    ed.log('New drawing.');
  });
  reg('OPEN', [], 'Open a DXF or DWG drawing in a new tab', (ed, arg) => void ed.sessions.openInTab(arg, (f) => ed.openFile(f)));
  reg('NEWSHEET', ['TEMPLATE'], 'New drawing from a sheet template (new tab)', (ed, arg) => {
    ed.sessions.add();
    origNewSheet.run(ed, arg);
  });
  reg('RECENT', [], 'Open a recent file by index', (ed, arg) => {
    const i = parseInt(arg ?? '1', 10) - 1;
    const f = ed.settings.recentFiles[i];
    if (!f) return ed.settings.recentFiles.forEach((r, k) => ed.log(`  ${k + 1}. ${r}`));
    if (f.endsWith('.json')) void ed.openProject(f);
    else void ed.sessions.openInTab(f, (x) => origOpen.run(ed, x) as unknown as Promise<void>);
  });
  const closeTab = async (i: number): Promise<boolean> => {
    // Symbol Builder tabs save to the user library instead of a file.
    if (symbolBuilderOf(editor).isSymbolSession(i)) return symbolBuilderOf(editor).closeSession(i);
    if (editor.sessions.isDirty(i)) {
      const ok = await confirmDialog('Unsaved changes', `${editor.sessions.titleOf(i)} has unsaved changes. Discard them?`);
      if (!ok) return false;
    }
    void autosaver.discardFor(editor.sessions.all[i]!.id);
    editor.sessions.close(i);
    return true;
  };
  reg('CLOSE', [], 'Close the current drawing tab', (ed) => void closeTab(ed.sessions.active));
  reg('CLOSEALL', [], 'Close all drawing tabs', async (ed) => {
    for (let i = ed.sessions.count - 1; i >= 0; i -= 1) if (!(await closeTab(i))) break;
  });
  reg('CLOSEALLOTHER', [], 'Close all other drawing tabs', async (ed) => {
    const keep = ed.sessions.all[ed.sessions.active]!.id;
    for (let i = ed.sessions.count - 1; i >= 0; i -= 1) {
      if (ed.sessions.all[i]!.id === keep) continue;
      if (!(await closeTab(i))) break;
    }
  });
  reg('NEXTTAB', [], 'Switch to the next drawing tab (Ctrl+Tab)', (ed) => ed.sessions.cycle(1));
  reg('PREVTAB', [], 'Switch to the previous drawing tab (Ctrl+Shift+Tab)', (ed) => ed.sessions.cycle(-1));

  reg('OPTIONS', ['OP', 'CONFIG'], 'Options dialog (Display, Drafting, Selection, Files, Units)', (ed, arg) => optionsDialog(ed, parseInt(arg ?? '0', 10) || 0));
  reg('DSETTINGS', ['DS', 'SE', 'DDRMODES'], 'Drafting Settings (Snap and Grid, Polar, Object Snap, Dynamic Input)', (ed, arg) => draftingSettingsDialog(ed, parseInt(arg ?? '0', 10) || 0));
  reg('HELP', ['?', 'F1'], 'Help: searchable command reference and keyboard shortcuts', (ed, arg) => helpDialog(ed, arg ?? ''));
  reg('TEXTSCR', ['F2', 'TEXTWINDOW'], 'Text window with the command history', (ed) => textWindowDialog(ed));
  reg('DONATE', ['TIP', 'SUPPORT'], 'Support JCad Electrical (opens the Cash App page)', (ed) => {
    const url = donateUrl();
    if (!url) {
      ed.log('No donation link is configured (see src/app/about.json).');
      return;
    }
    ed.log(`Opening ${url}`);
    if (window.jcad?.openExternal) void window.jcad.openExternal(url);
    else window.open(url, '_blank', 'noopener');
  });
  reg('ABOUT', [], 'About JCad Electrical, the author and how to support it', (ed) => helpDialog(ed, 'about'));
  reg('REPORTBUG', ['BUGREPORT', 'REPORTPROBLEM'], 'Report a problem: prefilled GitHub issue, copy or save a report with diagnostics', (ed) => reportProblemDialog(ed, 'bug'));
  reg('FEEDBACK', ['SENDFEEDBACK', 'FEATUREREQUEST'], 'Send feedback or request a feature', (ed) => reportProblemDialog(ed, 'feedback'));
  reg('CHECKUPDATES', ['UPDATE', 'CHECKFORUPDATES'], 'Check GitHub Releases for a newer JCad Electrical', (ed) => {
    const b = window.jcad;
    if (!b?.checkForUpdates) {
      ed.log('Updates are checked by the desktop application; download builds from https://github.com/habit04/share/releases');
      return;
    }
    ed.log('Checking for updates...');
    void b
      .checkForUpdates()
      .then((r) => {
        if (r.state === 'up-to-date') ed.log(`JCad Electrical ${r.version ?? ''} is up to date.`);
        else if (r.state === 'available') ed.log(`Update available: JCad Electrical ${r.version ?? ''}.`);
        else if (r.state === 'downloaded') ed.log(`Update ${r.version ?? ''} downloaded; it installs when the application restarts.`);
        else if (r.state === 'busy') ed.log('An update check is already running.');
        else if (r.state === 'error') ed.log(`Update check failed: ${r.message ?? 'unknown error'}`);
      })
      .catch((err: unknown) => ed.log(`Update check failed: ${err instanceof Error ? err.message : String(err)}`));
  });
  let lastProgressStep = -1;
  window.jcad?.onUpdateStatus?.((s) => {
    if (s.state === 'available') editor.log(`A newer JCad Electrical (${s.version ?? ''}) is available${s.manual ? ' on the releases page' : ''}.`);
    else if (s.state === 'downloading' && s.percent !== undefined) {
      const step = Math.floor(s.percent / 25);
      if (step !== lastProgressStep) {
        lastProgressStep = step;
        editor.log(`Downloading update: ${step * 25}%`);
      }
    } else if (s.state === 'downloaded') {
      lastProgressStep = -1;
      editor.log(`Update ${s.version ?? ''} downloaded; restart to install.`);
    }
  });
  reg('COMMANDLINE', [], 'Show the command window (Ctrl+9)', () => setCommandWindow(true));
  reg('COMMANDLINEHIDE', [], 'Hide the command window (Ctrl+9)', () => setCommandWindow(false));
  reg('CLEANSCREEN', ['CLEANSCREENON', 'CLEANSCREENOFF'], 'Toggle clean screen (Ctrl+0)', () => {
    app.classList.toggle('clean-screen');
    editor.resize();
  });
  reg('QPMODE', ['QP'], 'Toggle Quick Properties panel on selection', (ed) => {
    updateSettings(ed, { quickProperties: !ed.settings.quickProperties });
    ed.log(`<Quick Properties ${ed.settings.quickProperties ? 'on' : 'off'}>`);
    qp.render();
  });
  reg('TOOLPALETTES', ['TP', 'TOOLPALETTESCLOSE'], 'Toggle the Tool Palettes window (Ctrl+3)', () => tp.toggle());
  reg('WORKSPACE', ['WSCURRENT'], 'Switch workspace [drafting/electrical]', (ed, arg) => {
    const ws = (arg ?? '').toLowerCase().startsWith('d') ? 'drafting' : (arg ?? '').toLowerCase().startsWith('e') ? 'electrical' : null;
    if (!ws) return ed.log(`Workspace: ${ed.settings.workspace}. Options: drafting, electrical.`);
    updateSettings(ed, { workspace: ws });
    ribbon.refresh();
    ed.log(`Workspace: ${ws === 'drafting' ? 'Drafting & Annotation' : 'ACADE & 2D Drafting'}.`);
  });
  reg('ANNOSCALE', ['CANNOSCALE'], 'Set the annotation scale (e.g. 1:50)', (ed, arg) => {
    const v = (arg ?? '').trim();
    if (!/^\d+(\.\d+)?:\d+(\.\d+)?$/.test(v)) return ed.log(`Annotation scale: ${ed.settings.annotationScale}`);
    updateSettings(ed, { annotationScale: v });
  });
  reg('COPYCLIP', [], 'Copy selected objects to the clipboard (Ctrl+C)', () => clipboard.copy());
  reg('CUTCLIP', [], 'Cut selected objects to the clipboard (Ctrl+X)', () => clipboard.cut());
  reg('PASTECLIP', [], 'Paste objects from the clipboard at the cursor (Ctrl+V)', () => clipboard.paste());
  reg('AUTOSAVE', [], 'Write autosave files now', () => void autosaver.runNow().then((n) => editor.log(`${n} drawing(s) autosaved.`)));

  editor.hooks = {
    reports: (key) => reportsDialog(editor, key, (name, csv) => editor.fileBridge?.saveText?.(name, csv, 'CSV', 'csv') ?? browserDownload(name, csv)),
    template: () => templateDialog(),
    plc: (init) => plcDialog(init),
    terminalStrip: (init) => terminalStripDialog(init),
    wireType: (cur) => wireTypeDialog(editor, cur),
    properties: () => {
      props.toggle();
      editor.settings = { ...editor.settings, propertiesVisible: !props.el.classList.contains('hidden') };
      saveSettings(editor.settings);
    },
    projectChanged: () => pm.refresh(),
    symbolBuilder: createSymbolBuilderUi(editor, document.getElementById('symbol-builder')!),
  };

  // ------------------------------------------------------------ chrome
  buildTitleBar(editor, document.getElementById('titlebar')!, (anchor) => showAppMenu(editor, anchor, { exit: () => (window.jcad?.quit ? window.jcad.quit() : window.close()) }));
  const ribbon = new Ribbon(editor, document.getElementById('ribbon')!);
  ribbon.customPanelContent.set('Home/Layers', buildLayerPanelContent(editor));
  ribbon.extraPanels.push({ tab: 'Home', after: 'Layers', title: 'Properties', el: buildPropertiesPanelContent(editor) });
  ribbon.tabFilter = (name) => editor.settings.workspace === 'electrical' || !ELECTRICAL_TABS.includes(name);
  ribbon.setActive(editor.settings.ribbonTab);
  ribbon.onTabChange = (i) => {
    editor.settings = { ...editor.settings, ribbonTab: i };
    saveSettings(editor.settings);
  };
  const pm = new ProjectManager(editor, document.getElementById('project-manager')!);
  if (!editor.settings.projectManagerVisible) pm.el.classList.add('hidden');
  makePaletteResizable(pm.el, { edge: 'right', initial: editor.settings.paletteWidths.projectManager, onWidth: (w) => updateSettings(editor, { paletteWidths: { ...editor.settings.paletteWidths, projectManager: Math.round(w) } }) });
  installAutoHide(pm.el, { initial: editor.settings.paletteAutoHide.projectManager, onChange: (a) => updateSettings(editor, { paletteAutoHide: { ...editor.settings.paletteAutoHide, projectManager: a } }) });
  const props = new PropertiesPalette(editor, document.getElementById('properties')!);
  makePaletteResizable(props.el, { edge: 'left', initial: editor.settings.paletteWidths.properties, onWidth: (w) => updateSettings(editor, { paletteWidths: { ...editor.settings.paletteWidths, properties: Math.round(w) } }) });
  installAutoHide(props.el, { initial: editor.settings.paletteAutoHide.properties, onChange: (a) => updateSettings(editor, { paletteAutoHide: { ...editor.settings.paletteAutoHide, properties: a } }) });
  if (editor.settings.propertiesVisible) props.toggle();
  buildFileTabs(editor, document.getElementById('file-tabs')!);
  buildLayoutTabs(editor, document.getElementById('layout-tabs')!);
  const cmdEl = document.getElementById('command-window')!;
  const cmd = new CommandLine(editor, cmdEl, editor.settings.recentInput);
  cmd.onRecentChanged = (recent) => {
    editor.settings = { ...editor.settings, recentInput: [...recent] };
    saveSettings(editor.settings);
  };
  const setCommandWindow = (visible: boolean) => {
    cmdEl.classList.toggle('hidden', !visible);
    if (editor.settings.commandWindowVisible !== visible) {
      editor.settings = { ...editor.settings, commandWindowVisible: visible };
      saveSettings(editor.settings);
    }
    editor.resize();
  };
  setCommandWindow(editor.settings.commandWindowVisible);
  new StatusBar(editor, document.getElementById('statusbar')!);
  const clipboard = new EntityClipboard(editor);
  installContextMenu(editor, canvas, { recentInput: () => cmd.recentInput(), runInput: (t) => cmd.setText(t, true), clipboard });
  buildNavBar(editor, document.getElementById('navbar')!);
  const qp = new QuickProperties(editor, canvasWrap);
  installRolloverTooltips(editor, canvas, canvasWrap);
  const tp = new ToolPalettes(editor, canvasWrap);

  // ------------------------------------------------------------ user symbol library (Symbol Builder)
  const bridge = window.jcad;
  userLibrary.setStore(bridge?.userLibraryRead && bridge.userLibraryWrite ? bridgeUserLibraryStore(bridge as UserLibraryBridge) : localUserLibraryStore(localStorage));
  void userLibrary.load().then((n) => {
    if (n) editor.log(`User symbol library: ${n} symbol(s) available in the icon menu (User: categories).`);
    if (userLibrary.lastError) editor.log(`User symbol library could not be read: ${userLibrary.lastError}`);
  });

  // ------------------------------------------------------------ autosave + recovery
  const store = bridge?.autosaveWrite && bridge.autosaveList && bridge.autosaveRead && bridge.autosaveRemove ? bridgeAutosaveStore(bridge as AutosaveBridge) : localAutosaveStore(localStorage);
  const autosaver = new Autosaver(editor.sessions, store, () => editor.settings.autosaveMinutes, (id) => symbolBuilderOf(editor).sessions.has(id));
  autosaver.onSaved = (n) => editor.log(`Autosave: ${n} drawing(s) written.`);
  autosaver.onError = (title, err) => editor.log(`Autosave of ${title} failed: ${err instanceof Error ? err.message : String(err)} (will retry).`);
  autosaver.start();
  editor.on('snap', () => autosaver.restart()); // settings changed (interval may differ)
  editor.on('file', () => {
    if (!editor.doc.dirty && editor.doc.filePath) void autosaver.discardFor(editor.sessions.current.id);
    window.jcad?.setRecentFiles?.(editor.settings.recentFiles);
  });
  window.jcad?.setRecentFiles?.(editor.settings.recentFiles);

  // ------------------------------------------------------------ mouse
  canvas.addEventListener('mousemove', (ev) => editor.onMouseMove(ev));
  canvas.addEventListener('mousedown', (ev) => {
    closeMenus();
    editor.onMouseDown(ev);
    cmd.focus();
  });
  // mouseup on window so a drag released outside the canvas still ends the window selection / pan
  window.addEventListener('mouseup', (ev) => editor.onMouseUp(ev));
  canvas.addEventListener('dblclick', (ev) => editor.onDoubleClick(ev));
  let lastMiddleClick = 0;
  canvas.addEventListener('auxclick', (ev) => {
    if (ev.button !== 1) return;
    ev.preventDefault();
    // browsers do not emit dblclick for the middle button: detect it ourselves
    const now = performance.now();
    if (now - lastMiddleClick < 400) editor.zoomExtents();
    lastMiddleClick = now;
  });
  canvas.addEventListener('wheel', (ev) => editor.onWheel(ev), { passive: false });
  canvas.addEventListener('mouseleave', () => editor.onMouseLeave());

  // ------------------------------------------------------------ keyboard
  window.addEventListener('keydown', (ev) => {
    const target = ev.target as HTMLElement;
    const inField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
    if (document.querySelector('.modal-backdrop')) return; // dialogs handle their own keys
    const typing = inField && (target as HTMLInputElement).value !== '';
    const ctrl = ev.ctrlKey || ev.metaKey;
    const k = ev.key.toLowerCase();
    // Global chrome shortcuts (before the editor so they work everywhere).
    if (ev.key === 'F1') return run('HELP');
    if (ev.key === 'F2') return run('TEXTSCR');
    if (ctrl && ev.key === 'Tab') return run(ev.shiftKey ? 'PREVTAB' : 'NEXTTAB');
    if (ctrl && (k === 'w' || ev.key === 'F4')) return run('CLOSE');
    if (ctrl && k === '1') return run('PROPERTIES');
    if (ctrl && k === '3') return run('TOOLPALETTES');
    if (ctrl && k === '9') return run(cmdEl.classList.contains('hidden') ? 'COMMANDLINE' : 'COMMANDLINEHIDE');
    if (ctrl && k === '0') return run('CLEANSCREEN');
    if (ctrl && k === 'p') return run('PLOT');
    if (ctrl && !typing && !editor.tool) {
      if (k === 'c') return run('COPYCLIP');
      if (k === 'x') return run('CUTCLIP');
      if (k === 'v') return run('PASTECLIP');
    }
    // While editing typed text, Delete / Ctrl+A belong to the text field, not the drawing.
    if (typing && (ev.key === 'Delete' || (ctrl && k === 'a'))) return;
    if (editor.onKeyDown(ev)) {
      ev.preventDefault();
      return;
    }
    if (!inField) {
      if (ev.key === 'Enter') {
        editor.pressEnter();
        ev.preventDefault();
      } else if (ev.key.length === 1 && !ctrl && !ev.altKey) {
        cmd.focus();
      }
    }
    function run(command: string): void {
      ev.preventDefault();
      editor.runCommand(command);
    }
  });

  window.addEventListener('resize', () => editor.resize());
  const ro = new ResizeObserver(() => editor.resize());
  ro.observe(canvas.parentElement!);
  editor.resize();

  window.jcad?.onMenuCommand((c) => editor.runCommand(c));
  // Unsaved-work guard: the browser prompt, and the Electron close handler asks via this flag.
  window.addEventListener('beforeunload', (ev) => {
    if (editor.sessions.anyDirty() && !window.jcad) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });
  window.jcad?.onQueryDirty(() => editor.sessions.anyDirty());

  if (new URLSearchParams(location.search).has('demo')) {
    seedDemoDrawing(editor);
  }
  editor.zoomExtents();
  cmd.focus();
  if (!new URLSearchParams(location.search).has('norecover')) void recoveryDialog(editor, store, autosaver);
  // expose for automation / debugging
  (window as unknown as { editor: Editor; jacUi: unknown }).editor = editor;
  (window as unknown as { jacUi: unknown }).jacUi = { ribbon, cmd, qp, tp, pm, props, clipboard, autosaver, store };
}

boot();
