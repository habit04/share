import './styles/app.css';
import './styles/parity.css';
import { Editor, type FileBridge } from './app/editor';
import { installGpuPrototype } from './app/gpu-prototype';
import { installGpu2dCandidateSelector } from './app/gpu-2d-candidate';
import { setDiagnosticRenderer } from './app/gpu-diagnostics';
import { Ribbon, ELECTRICAL_TABS } from './ui/ribbon';
import { CommandLine } from './ui/commandline';
import { StatusBar } from './ui/statusbar';
import { ProjectManager } from './ui/projectmanager';
import { pickSymbolDialog, editComponentDialog, ladderDialog, textInputDialog, layerDialog, confirmDialog, saveChangesDialog, reportsDialog, templateDialog, plcDialog, terminalStripDialog, wireTypeDialog } from './ui/dialogs';
import { PropertiesPalette } from './ui/properties';
import { AiAssistantPanel } from './ui/ai-panel';
import { windowAiConnection } from './ai/host-bridge';
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
import { plotDialog } from './ui/plot';
import { installDiagnostics } from './app/diagnostics';
import { drawingKindOf, readDwgInBrowser, describeDwgError } from './io/dwg-browser';
import { donateUrl } from './app/about';
import { Autosaver, bridgeAutosaveStore, localAutosaveStore, type AutosaveBridge } from './app/autosave';
import { recoveryDialog, NOTHING_TO_RECOVER } from './ui/recovery';
import { saveErrorDialog } from './ui/save-error';
import { describeFileError } from './app/file-errors';
import { exportFailed } from './app/file-error-text';
import { importReportDialog } from './ui/import-report';
import { closeDrawingTab, runCloseWorkflow, saveSymbolForClose, settleBeforeClose } from './app/closeflow';
import { saveAllDialog, saveFailedDialog, projectRecoveryDialog, projectRecoveryReadFailedDialog } from './ui/filedialogs';
import { ProjectAutosaver, drawingAutosaves, offerProjectRecovery } from './app/project-autosave';
import { showAppMenu } from './ui/appmenu';
import { EntityClipboard } from './ui/clipboard';
import { closeMenus } from './ui/menu';
import { createSymbolBuilderUi } from './ui/symbol-builder';
import { symbolBuilderOf } from './tools/symbol-builder';
import { userLibrary, bridgeUserLibraryStore, localUserLibraryStore, type UserLibraryBridge } from './electrical/userlib';
import { packRegistry, bridgePackStore, localPackStore, type PacksBridge } from './electrical/packs';
import { decodeDxfBytes } from './io/encoding';
import { ensureFileLimit, MAX_DRAWING_FILE_BYTES } from './io/file-limits';
import { installApi } from './app/api';
import { loadPlugins, registerPluginCommands } from './app/plugins';
import { registerDimStyleCommands } from './tools/dimension';
import { renderSettings, clearImageCache, colorDisplay } from './render/draw';
import { bridgeImageLoader } from './render/images';
import { createPdfjsEngine } from './io/underlay-pdfjs';
import { createUnderlayDisplayService, type UnderlayVariantCanvasFactory } from './app/underlay-render';
import { bridgeUnderlayBytes, nullUnderlayBytes } from './app/underlay-bytes';
import { visibleRegionFor } from './app/underlay-view';
import { installOpenProgress, type OpenProgressBridge } from './ui/open-progress';
import { registerDwgExportCommand } from './app/export-dwg';
import { fontMetrics } from './render/font-metrics';
import { createShapingHooks } from './app/shape-preparation';
import { setPdfShapingFactory } from './app/pdf-fonts';
import { installExperimental3d } from './app/experimental-3d';

declare global {
  interface Window {
    /** Experimental 3D debug handle (src/app/experimental-3d.ts); set only when the flag is on. */
    jcad3d?: import('./app/experimental-3d').Experimental3d;
    jcad?: {
      openShxFont?(): Promise<import('./render/shx-fonts').ShxResource | null>;
      fontMetrics?(request: import('./core/text-metrics').FontMetricsRequest): Promise<import('./core/text-metrics').NativeFontMetrics | null>;
      shapeFont?(request: import('./core/text-metrics').ShapeBridgeRequest): Promise<import('./core/text-metrics').ShapeBridgeResult>;
      ai?: import('./ai/host-bridge').AiPreloadBridge;
      pdfFont?(request: import('./core/text-metrics').FontMetricsRequest): Promise<import('./app/pdf-fonts').PdfFontResult>;
      openDxf(): Promise<{ path: string; identityPath?: string; openedSourceProof?: string; text: string } | null>;
      releaseOpenedSourceProof?(proof: string): Promise<void>;
      openDrawing(file?: string): Promise<import('./app/editor').OpenResult | null>;
      openProject(file?: string, opts?: { userChosen?: boolean; textOnly?: boolean }): Promise<{ path: string; text: string } | null>;
      saveText(suggestName: string, text: string, filterName: string, ext: string, opts?: { admission?: string }): Promise<string | null>;
      backupFile?(file: string): Promise<import('./app/editor').BackupResult>;
      choosePdfPath?(suggestName: string, admission?: string): Promise<string | null>;
      plotPdf(dataUrl: string, suggestName: string, landscape: boolean, sheet?: { width: number; height: number; electron?: string }, opts?: { path?: string; admission?: string }): Promise<string | null>;
      printDrawing?(dataUrl: string, title: string, landscape: boolean, sheet?: { width: number; height: number; electron?: string }): Promise<boolean>;
      /** Track E: write vector PDF bytes (save-pdf IPC). */
      savePdf?(bytes: Uint8Array, suggestName: string, opts?: { path?: string; admission?: string; restricted?: { sha256: string; byteLength: number } }): Promise<string | null>;
      /** Restricted PDF (12.4): register the frozen digest + preview/print face claims before savePdf. */
      registerRestrictedPdf?(admission: string, claim: { path: string; sha256: string; byteLength: number; faces: readonly import('./core/text-metrics').FontMetricsRequest[] }): Promise<boolean>;
      saveDxf(path: string | null, text: string, suggestName: string, opts?: { backup?: boolean }): Promise<string | null>;
      chooseDrawingPath?(suggestName: string): Promise<string | null>;
      dwgExportStatus?(): Promise<{ available: boolean; reason?: string }>;
      chooseDwgPath?(suggestName: string): Promise<string | null>;
      exportDwg?(path: string, text: string): Promise<string | null>;
      onMenuCommand(cb: (cmd: string) => void): void;
      /** Close / quit / restart: the main process waits for the Save All workflow's answer (true = close). */
      onCloseRequest?(cb: (context: 'close' | 'quit' | 'restart') => Promise<boolean>): void;
      chooseProjectPath?(suggestName: string): Promise<string | null>;
      saveProject?(path: string, text: string): Promise<string | null>;
      setRecentFiles?(files: string[]): void;
      quit?(): void;
      /** Drawings handed over by the OS before the page loaded / afterwards (open each in its tab). */
      takeOpenFiles?(): Promise<string[]>;
      onOpenFiles?(cb: (files: string[]) => void): void;
      appInfo?(): Promise<{ version: string; platform: string; arch: string; packaged: boolean; selfUpdate: boolean; releases: string }>;
      openExternal?(url: string): Promise<boolean>;
      checkForUpdates?(): Promise<{ state: string; version?: string; message?: string }>;
      onUpdateStatus?(cb: (status: { state: string; version?: string; percent?: number; message?: string; manual?: boolean }) => void): void;
      platform: string;
      /** Desktop only: an image file (absolute path) as a data URL, null when it cannot be read. */
      readImage?(file: string): Promise<string | null>;
      /** Desktop only: a PDF underlay file (absolute path) as raw bytes, null when it cannot be read. */
      readUnderlay?(file: string): Promise<Uint8Array | null>;
    } & Partial<OpenProgressBridge> &
      Partial<AutosaveBridge> &
      Partial<UserLibraryBridge> &
      Partial<PacksBridge>;
  }
}

/** The underlay post-process target background (design A.2.1): the editor's declared surface. */
function underlayTargetBackground(): readonly [number, number, number] {
  if (colorDisplay.paper) return [1, 1, 1];
  const hex = colorDisplay.background;
  const n = Number.parseInt(hex.replace('#', ''), 16);
  if (!Number.isFinite(n)) return [1, 1, 1];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Pixel-access canvas factory for underlay style variants (design 5.3). */
const domVariantCanvasFactory: UnderlayVariantCanvasFactory = {
  create(width: number, height: number) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('a 2d canvas context is unavailable for underlay variants');
    return {
      canvas,
      width,
      height,
      context: {
        drawImage: (image: unknown, dx: number, dy: number) => { context.drawImage(image as CanvasImageSource, dx, dy); },
        getImageData: (x: number, y: number, w: number, h: number) => context.getImageData(x, y, w, h),
        putImageData: (image: { data: Uint8ClampedArray }, dx: number, dy: number) => { context.putImageData(new ImageData(new Uint8ClampedArray(image.data), width, height), dx, dy); },
      },
    };
  },
};

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
/** Open the rendered sheet in a new window and call the browser's print dialog. */
function browserPrint(dataUrl: string, title: string, landscape: boolean, sheet?: { width: number; height: number }): Promise<boolean> {
  // A hidden iframe prints from the page itself: no popup permission needed and the
  // @page size matches the chosen sheet.
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
    frame.setAttribute('aria-hidden', 'true');
    document.body.appendChild(frame);
    const finish = (ok: boolean) => {
      setTimeout(() => frame.remove(), 1000);
      resolve(ok);
    };
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win) {
      finish(false);
      return;
    }
    const size = sheet ? `${sheet.width.toFixed(2)}in ${sheet.height.toFixed(2)}in` : landscape ? 'landscape' : 'portrait';
    doc.open();
    doc.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/[<>&]/g, '')}</title><style>html,body{margin:0;background:#fff;height:100%}img{width:100%;height:100%;object-fit:contain;display:block}@page{margin:0;size:${size}}</style></head><body><img id="p"></body></html>`,
    );
    doc.close();
    const img = doc.getElementById('p') as HTMLImageElement | null;
    if (!img) {
      finish(false);
      return;
    }
    img.onload = () => {
      try {
        win.focus();
        win.print();
        finish(true);
      } catch {
        finish(false);
      }
    };
    img.onerror = () => finish(false);
    img.src = dataUrl;
  });
}

/** Browser edition PLOT: build the PDF in the page (lossless when deflate is available) and download it. */
async function browserPlotPdf(dataUrl: string, suggestName: string, sheet: { width: number; height: number }): Promise<string | null> {
  const { imagePdf, deflate, rgbaToRgb, dataUrlBytes } = await import('./io/pdf');
  const img = new Image();
  await new Promise<void>((ok, fail) => {
    img.onload = () => ok();
    img.onerror = () => fail(new Error('Could not decode the plot image.'));
    img.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const rgb = rgbaToRgb(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  const packed = await deflate(rgb);
  const pdf = packed
    ? imagePdf({ width: canvas.width, height: canvas.height, data: packed, kind: 'rgb', deflated: true }, sheet, suggestName)
    : imagePdf({ width: canvas.width, height: canvas.height, data: dataUrlBytes(canvas.toDataURL('image/jpeg', 0.92)), kind: 'jpeg' }, sheet, suggestName);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer], { type: 'application/pdf' }));
  a.download = suggestName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return suggestName;
}

function browserFileBridge(): FileBridge {
  const drawingBytes = (file: File) => {
    ensureFileLimit(file, MAX_DRAWING_FILE_BYTES);
    return file.arrayBuffer();
  };
  return {
    openDxf: async () => {
      const f = await pickBrowserFile('.dxf');
      return f ? { path: f.name, text: decodeDxfBytes(new Uint8Array(await drawingBytes(f))).text } : null;
    },
    openDrawing: async () => {
      const f = await pickBrowserFile('.dxf,.dwg');
      if (!f) return null;
      if (drawingKindOf(f.name) === 'dwg') {
        try {
          const { payload, version } = await readDwgInBrowser(await drawingBytes(f));
          return { path: f.name, kind: 'dwg', payload, version };
        } catch (err) {
          throw new Error(describeDwgError(err));
        }
      }
      return { path: f.name, kind: 'dxf', text: decodeDxfBytes(new Uint8Array(await drawingBytes(f))).text };
    },
    saveDxfCreatesCopy: true,
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
    // Browser: PLOT builds the PDF in the page and downloads it; PRINT uses the browser's print dialog.
    plotPdf: (dataUrl, suggestName, _landscape, sheet) => browserPlotPdf(dataUrl, suggestName, sheet ?? { width: 11, height: 8.5 }),
    printDrawing: (dataUrl, title, landscape, sheet) => browserPrint(dataUrl, title, landscape, sheet),
    // Track E: vector PDF bytes download as a file.
    savePdf: async (bytes, suggestName) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: 'application/pdf' }));
      a.download = suggestName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      return suggestName;
    },
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
  // A page loaded before a redeploy asks for chunks that no longer exist (hashed names change):
  // reload once to pick up the current build instead of failing the open.
  window.addEventListener('vite:preloadError', (ev) => {
    let already = false;
    try {
      already = sessionStorage.getItem('jcad.reloadedForStaleChunk') === '1';
      sessionStorage.setItem('jcad.reloadedForStaleChunk', '1');
    } catch {
      /* storage blocked: just try once */
    }
    if (already) return;
    ev.preventDefault();
    window.location.reload();
  });
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <div id="titlebar"></div>
    <div id="ribbon"></div>
    <div class="workspace">
      <div id="project-manager"></div>
      <div class="center">
        <div id="file-tabs"></div>
        <div class="canvas-wrap"><canvas id="drawing" tabindex="0"></canvas>
          <div class="viewcube" title="Top view"><span class="vc-n">N</span><span class="vc-e">E</span><span class="vc-s">S</span><span class="vc-w">W</span><span class="vc-face">TOP</span><span class="vc-wcs">WCS</span></div>
          <div class="navbar" id="navbar"></div>
        </div>
        <div id="layout-tabs"></div>
        <div id="command-window"></div>
      </div>
      <div id="properties"></div>
      <div id="ai-assistant"></div>
      <div id="symbol-builder"></div>
    </div>
    <div id="statusbar"></div>`;

  installWebBanner(app);

  const canvas = document.getElementById('drawing') as HTMLCanvasElement;
  const canvasWrap = canvas.parentElement as HTMLElement;
  if (window.jcad?.platform === 'win32' && window.jcad.fontMetrics) fontMetrics.setReader((request) => window.jcad!.fontMetrics!(request));
  if (window.jcad?.platform === 'win32' && window.jcad.shapeFont) {
    const shapeFont = window.jcad.shapeFont.bind(window.jcad);
    fontMetrics.setShapingFactory((init) => createShapingHooks({ bridge: (request) => shapeFont(request), ...init }));
    setPdfShapingFactory((init) => createShapingHooks({ bridge: (request) => shapeFont(request), ...init }));
  }
  document.fonts?.addEventListener('loadingdone', () => fontMetrics.invalidateFallbacks());
  const editor = new Editor(canvas);
  editor.fileBridge = window.jcad ?? browserFileBridge();
  registerDwgExportCommand(editor);
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
  registerDimStyleCommands(editor);
  installApi(editor);
  registerPluginCommands(editor);

  // Multi-document: NEW / OPEN / NEWSHEET / RECENT work with file tabs.
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
    // Picked from Recent Documents by the user (a plugin running RECENT through its API opens it by name).
    if (f.endsWith('.json')) void ed.openProject(f, { userChosen: ed.apiCommandDepth === 0 });
    // Await the open itself: the tab made for it must not be dropped as "cancelled" while the file still loads.
    else void ed.sessions.openInTab(f, (x) => ed.openFile(x));
  });
  reg('CLEARRECENT', [], 'Clear the recent file list (File > Open Recent > Clear Recent)', (ed) => {
    updateSettings(ed, { recentFiles: [] });
    ed.notify('file');
    ed.log('Recent file list cleared.');
  });
  const closeTab = async (i: number): Promise<boolean> => {
    // Symbol Builder tabs save to the user library instead of a file.
    if (symbolBuilderOf(editor).isSymbolSession(i)) return symbolBuilderOf(editor).closeSession(i);
    return closeDrawingTab(editor.sessions, i, {
      confirmDiscard: (title) => confirmDialog('Unsaved changes', `${title} has unsaved changes. Discard them?`),
      discardBackup: (id) => void autosaver.discardFor(id),
      changed: (title) => editor.log(`Close cancelled: ${title} changed while the discard question was open. Close it again to review those changes.`),
    });
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
        else if (r.state === 'unsupported') ed.log(`No update for this computer: JCad Electrical ${r.version ?? ''} needs a newer operating system.`);
        else if (r.state === 'downloaded') ed.log(`Update ${r.version ?? ''} downloaded; it installs when the application restarts.`);
        else if (r.state === 'busy') ed.log('An update check is already running.');
        else if (r.state === 'error') ed.log(`Update check failed: ${r.message ?? 'unknown error'}`);
      })
      .catch((err: unknown) => ed.log(`Update check failed: ${err instanceof Error ? err.message : String(err)}`));
  });
  let lastProgressStep = -1;
  window.jcad?.onUpdateStatus?.((s) => {
    if (s.state === 'available') editor.log(`A newer JCad Electrical (${s.version ?? ''}) is available${s.manual ? ' on the releases page' : ''}.`);
    else if (s.state === 'unsupported' && s.message) editor.log(s.message);
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
  // ANNOSCALE / CANNOSCALE are registered by tools/layouts.ts (Track E: annotative scaling).
  reg('COPYCLIP', [], 'Copy selected objects to the clipboard (Ctrl+C)', () => clipboard.copy());
  reg('CUTCLIP', [], 'Cut selected objects to the clipboard (Ctrl+X)', () => clipboard.cut());
  reg('PASTECLIP', [], 'Paste objects from the clipboard at the cursor (Ctrl+V)', () => clipboard.paste());
  reg('AUTOSAVE', [], 'Write autosave files now', () => void autosaver.runNow().then((n) => editor.log(`${n} drawing(s) autosaved.`)));

  editor.hooks = {
    plot: (mode) => plotDialog(editor, mode),
    reports: (key) => reportsDialog(editor, key, (name, csv) => editor.fileBridge?.saveText?.(name, csv, 'CSV', 'csv').catch(exportFailed((t) => editor.log(t), name)) ?? browserDownload(name, csv)),
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
    importReport: (report, fileName) => importReportDialog(report, fileName),
  };

  // Experimental 3D (inert unless Options > Experimental > 3D modelling was on at startup).
  const experimental3d = installExperimental3d(editor);
  editor.hooks.aiDraftingAvailable = () => !(experimental3d?.active ?? false);
  let aiWasIn3d = experimental3d?.active ?? false;
  const syncAiDraftView = () => {
    const active = experimental3d?.active ?? false;
    if (active !== aiWasIn3d) {
      aiWasIn3d = active;
      editor.noteInteractionStart();
    }
  };
  editor.on('view', syncAiDraftView);
  editor.on('log', syncAiDraftView);
  setDiagnosticRenderer(() => experimental3d?.active ? 'WebGL2 experimental 3D modelling viewport' : 'Canvas 2D');
  if (__JCAD_GPU_EXPERIMENTAL__) installGpuPrototype(editor, () => experimental3d?.active ?? false);
  else installGpu2dCandidateSelector(editor, () => experimental3d?.active ?? false);

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
  // AI Assistant palette (docs/AI-ASSISTANT.md): read-only, toggled directly —
  // never through runCommand, which would cancel the current drawing tool.
  // Width is not persisted in this milestone (the settings record is closed).
  const aiPanel = new AiAssistantPanel(editor, document.getElementById('ai-assistant')!, undefined, windowAiConnection());
  makePaletteResizable(aiPanel.el, { edge: 'left', initial: 320, onWidth: () => {} });
  editor.hooks.aiAssistant = () => aiPanel.toggle();
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
  const aiToggle = document.createElement('button');
  aiToggle.className = 'status-btn text';
  aiToggle.textContent = 'AI';
  aiToggle.title = 'AI Assistant — ask about selected objects (read-only)';
  aiToggle.addEventListener('keydown', (ev) => ev.stopPropagation());
  aiToggle.addEventListener('click', () => editor.hooks.aiAssistant?.());
  document.getElementById('statusbar')!.appendChild(aiToggle);
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

  // Large DWG files: progress dialog with Cancel while the main process reads them in a worker.
  if (bridge?.onOpenProgress && bridge.cancelOpen) installOpenProgress(bridge as OpenProgressBridge, (t) => editor.log(t));

  // ------------------------------------------------------------ raster images (IMAGE entities; desktop only)
  // The browser build cannot read image files: images stay a frame with their file name there.
  if (bridge?.readImage) {
    const readImage = bridge.readImage.bind(bridge);
    const images = bridgeImageLoader({ readImage, drawingPath: () => editor.doc.filePath });
    renderSettings.imageLoader = images;
    renderSettings.requestRedraw = () => editor.render();
    editor.on('file', () => {
      // Relative image names resolve against the new drawing's folder.
      images.clear();
      clearImageCache();
    });
  }

  // ------------------------------------------------------------ DXF xrefs (P20 slice 1, design section 6.4)
  // Install the xref context provider on renderSettings, following the
  // imageLoader installation pattern above: the editor resolves the
  // active document's resolved xref context through it per frame, keyed
  // by that document's session stamp (the registry itself refuses a
  // stamp mismatch). Documents without a live graph answer null and
  // every render/plot consumer draws exactly as before.
  renderSettings.xrefContextProvider = (stamp) => editor.xrefSessions.currentContextFor(stamp);

  // ------------------------------------------------------------ PDF underlays (P28 finish, design section 1)
  // Always constructed — NOT conditional on the bridge (413 D-4 corrected
  // justification): the service is what produces page content at all, and it
  // cannot lean on renderSettings.requestRedraw, which is only set inside
  // the readImage block above. Without a byte channel (browser build, or a
  // bridge without readUnderlay) the posture is frame + label via
  // nullUnderlayBytes; DWF/DGN stay frame + label by design (Q7).
  const underlayBytes = bridge?.readUnderlay
    ? bridgeUnderlayBytes({ readUnderlay: bridge.readUnderlay.bind(bridge), drawingPath: () => editor.doc.filePath })
    : nullUnderlayBytes;
  const underlays = createUnderlayDisplayService({
    engine: createPdfjsEngine(),
    bytesFor: underlayBytes,
    definitions: () => editor.doc.snapshot.underlays,
    requestRedraw: () => editor.render(),
    visibleRegion: (def) => visibleRegionFor(
      { viewBounds: () => editor.viewport.visibleBounds(), pageSizeOf: (id) => underlays.pageSizeOf(id) },
      def,
      editor.doc.snapshot.entities.filter((e) => e.type === 'underlay'),
    ),
    targetBackground: () => underlayTargetBackground(),
    variantCanvasFactory: domVariantCanvasFactory,
  });
  renderSettings.underlaySource = (e) => underlays.source(e);
  renderSettings.underlayBytes = underlayBytes;
  // Captured plots bind their byte source to the captured document's path
  // at capture time (#57 P2 (1)); screen loads keep the live getter above.
  renderSettings.underlayBytesFor = (drawingPath: string | null) => bridge?.readUnderlay
    ? bridgeUnderlayBytes({ readUnderlay: bridge.readUnderlay.bind(bridge), drawingPath: () => drawingPath })
    : nullUnderlayBytes;
  editor.on('file', () => underlays.clear());
  // Reload Underlays (Q5 CLOSED, design 3.6): explicit, per-definition
  // generation retirement over the ACTIVE document's definitions — the draw
  // path re-loads, the plot path re-runs ensure(). No watcher, no
  // prompt-on-focus, no quiet revalidation.
  reg('RELOADUNDERLAYS', [], 'Reload every PDF underlay of the active document from its file', () => {
    for (const def of Object.values(editor.doc.snapshot.underlays ?? {})) underlays.invalidate(def.id);
    editor.render();
  });

  // ------------------------------------------------------------ catalog packs (signed manufacturer catalogs)
  packRegistry.setStore(bridge?.packsList && bridge.packsRead && bridge.packsWrite && bridge.packsRemove ? bridgePackStore(bridge as PacksBridge) : localPackStore(localStorage));
  void packRegistry.load().then(({ loaded, errors }) => {
    if (loaded) editor.log(`Catalog packs: ${loaded} installed (${packRegistry.list().map((p) => `${p.doc.name} - licensed to ${p.doc.license.licensee}`).join('; ')}).`);
    for (const p of packRegistry.list()) if (p.verified.expired) editor.log(`Warning: the licence of catalog pack "${p.doc.name}" expired on ${p.verified.expires}. The parts keep working; renew to receive updates.`);
    for (const e of errors) editor.log(`Catalog pack not loaded: ${e}`);
  });

  // ------------------------------------------------------------ autosave + recovery
  const autosaveStore = bridge?.autosaveWrite && bridge.autosaveList && bridge.autosaveRead && bridge.autosaveRemove ? bridgeAutosaveStore(bridge as AutosaveBridge) : localAutosaveStore(localStorage);
  // The project's autosave lives in the same store; drawings (autosaver, Drawing Recovery Manager) see only drawing autosaves.
  const store = drawingAutosaves(autosaveStore);
  const autosaver = new Autosaver(editor.sessions, store, () => editor.settings.autosaveMinutes, (id) => symbolBuilderOf(editor).sessions.has(id));
  autosaver.onSaved = (n) => editor.log(`Autosave: ${n} drawing(s) written.`);
  autosaver.onError = (title, err) => editor.log(`${describeFileError(err, { action: 'autosave', path: title }).message} (Autosave will retry.)`);
  autosaver.start();
  editor.on('snap', () => autosaver.restart()); // settings changed (interval may differ)
  // A completed save removes the backup only if that exact revision is still the drawing's state.
  editor.hooks.drawingSaved = (sessionId, state) => void autosaver.markSaved(sessionId, state);
  editor.hooks.saveError = (info, fileName, opts) => saveErrorDialog(info, fileName, opts);
  // The project's own unsaved changes are autosaved next to the drawings (removed once saved / discarded).
  const projectAutosaver = new ProjectAutosaver(editor, autosaveStore, () => editor.settings.autosaveMinutes > 0);
  projectAutosaver.onError = (err) => editor.log(`${describeFileError(err, { action: 'autosave', path: `Project ${editor.project.name}` }).message} (The next change to the project tries again.)`);
  editor.on('file', () => {
    // Other ways a drawing becomes clean (project-wide writes, tab switches): same revision check.
    // This runs inside tab switches too, so it reads the live document instead of syncing the
    // session list (markSaved compares with the session only after it has settled).
    if (!editor.doc.dirty && editor.doc.filePath) void autosaver.markSaved(editor.sessions.activeId, editor.doc.snapshot);
    window.jcad?.setRecentFiles?.(editor.settings.recentFiles);
  });
  reg('DRAWINGRECOVERY', ['DRM'], 'Drawing Recovery Manager: autosaved drawings that were not saved', (ed) => {
    void recoveryDialog(ed, store, autosaver).then((r) => {
      if (r === 'empty') ed.log(NOTHING_TO_RECOVER);
    });
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
    if (ctrl && ev.shiftKey && k === 'p') return run('PRINT');
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
  // Unsaved-work guard of the browser build (the desktop app asks through the Save All workflow below).
  window.addEventListener('beforeunload', (ev) => {
    // (The browser build cannot reopen projects, so only drawings count here; the desktop app asks through Save All.)
    if (editor.sessions.anyDirty() && !window.jcad) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });
  // Save All on close / quit / restart: every modified drawing, Symbol Builder tab and the project.
  let closing: Promise<boolean> | null = null;
  const closeWorkflow = (context: 'close' | 'quit' | 'restart'): Promise<boolean> => {
    if (closing) return closing;
    const sb = symbolBuilderOf(editor);
    closing = runCloseWorkflow(
      editor,
      {
        ask: (items) => saveAllDialog(items, context),
        saveSymbol: () => saveSymbolForClose(sb, userLibrary),
        showError: (title, error) => saveFailedDialog(title, error),
        // Answer only after autosaves being written are complete (they are what recovers discarded work)
        // and the backups of drawings saved just now are removed, but a hung write is not waited for;
        // anything edited meanwhile is asked about again.
        settle: async () => {
          if (!(await settleBeforeClose([projectAutosaver.flush(), autosaver.idle()]))) editor.log('Closing without waiting longer for an autosave that is still being written.');
        },
      },
      (id) => sb.sessions.has(id),
    )
      .then(async (ok) => {
        const projectBeforeCleanup = editor.projectState;
        const drawingsBeforeCleanup = editor.sessions.all.map((s) => ({ id: s.id, revision: s.revision }));
        // Still modified after an allowed close = the user chose not to save the project (Discard All or
        // unticked): its autosave goes, as with Don't Save (a failed save never gets here).
        if (ok && editor.projectDirty && !(await settleBeforeClose([projectAutosaver.discard()]))) {
          editor.log('Project autosave cleanup is still pending; the remaining recovery copy is kept.');
        }
        if (ok && (editor.projectState.generation !== projectBeforeCleanup.generation || editor.projectState.revision !== projectBeforeCleanup.revision ||
            editor.sessions.all.length !== drawingsBeforeCleanup.length || editor.sessions.all.some((s, i) => s.id !== drawingsBeforeCleanup[i]?.id || s.revision !== drawingsBeforeCleanup[i]?.revision))) {
          projectAutosaver.schedule();
          editor.log('Closing cancelled because work changed during autosave cleanup. Close again to review those changes.');
          return false;
        }
        return ok;
      })
      .finally(() => {
        closing = null;
      });
    return closing;
  };
  window.jcad?.onCloseRequest?.(closeWorkflow);

  if (new URLSearchParams(location.search).has('demo')) {
    seedDemoDrawing(editor);
  }
  editor.zoomExtents();
  cmd.focus();
  if (!new URLSearchParams(location.search).has('norecover')) {
    void (async () => {
      try {
        await offerProjectRecovery(editor, autosaveStore, projectRecoveryDialog, projectAutosaver, projectRecoveryReadFailedDialog);
      } catch (err) {
        editor.log(`Project recovery failed: ${err instanceof Error ? err.message : String(err)}. Recovery copies are kept.`);
      } finally {
        await recoveryDialog(editor, store, autosaver);
      }
    })().catch((err) => editor.log(`Drawing recovery failed: ${err instanceof Error ? err.message : String(err)}.`));
  }
  // Files handed over by the OS ("Open with", a double click, a second launch): one after another,
  // each drawing in its own tab, a project file (.jcadproj.json) as the current project.
  let handOver: Promise<void> = Promise.resolve();
  const openHandedOver = (files: string[]): void => {
    handOver = handOver.then(async () => {
      for (const f of files) {
        if (/\.json$/i.test(f)) await editor.openProject(f, { userChosen: true });
        else await editor.sessions.openInTab(f, (x) => editor.openFile(x));
      }
    });
  };
  window.jcad?.onOpenFiles?.(openHandedOver);
  void window.jcad?.takeOpenFiles?.().then(openHandedOver, () => {});
  // expose for automation / debugging
  (window as unknown as { editor: Editor; jacUi: unknown }).editor = editor;
  (window as unknown as { jacUi: unknown }).jacUi = { ribbon, cmd, qp, tp, pm, props, clipboard, autosaver, store, autosaveStore, projectAutosaver };
  void loadPlugins(editor);
}

boot();
