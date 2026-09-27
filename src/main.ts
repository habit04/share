import './styles/app.css';
import { Editor, type FileBridge } from './app/editor';
import { Ribbon } from './ui/ribbon';
import { CommandLine } from './ui/commandline';
import { StatusBar } from './ui/statusbar';
import { ProjectManager } from './ui/projectmanager';
import { pickSymbolDialog, editComponentDialog, ladderDialog, textInputDialog, layerDialog, confirmDialog } from './ui/dialogs';
import { buildTitleBar, buildFileTabs, buildLayoutTabs, installContextMenu, buildNavBar } from './ui/chrome';
import { seedDemoDrawing } from './app/demo';

declare global {
  interface Window {
    voltcad?: {
      openDxf(): Promise<{ path: string; text: string } | null>;
      openDrawing(file?: string): Promise<import('./app/editor').OpenResult | null>;
      saveDxf(path: string | null, text: string, suggestName: string): Promise<string | null>;
      onMenuCommand(cb: (cmd: string) => void): void;
      onQueryDirty(cb: () => boolean): void;
      platform: string;
    };
  }
}

function browserFileBridge(): FileBridge {
  return {
    openDxf: () =>
      new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.dxf';
        input.addEventListener('change', async () => {
          const f = input.files?.[0];
          if (!f) return resolve(null);
          resolve({ path: f.name, text: await f.text() });
        });
        input.addEventListener('cancel', () => resolve(null));
        input.click();
      }),
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
  };
}

function boot(): void {
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <div id="titlebar"></div>
    <div id="ribbon"></div>
    <div class="workspace">
      <div id="project-manager"></div>
      <div class="center">
        <div id="file-tabs"></div>
        <div class="canvas-wrap"><canvas id="drawing" tabindex="0"></canvas>
          <div class="viewcube" title="Top view"><span class="vc-n">N</span><span class="vc-e">E</span><span class="vc-s">S</span><span class="vc-w">W</span><span class="vc-face">TOP</span></div>
          <div class="navbar" id="navbar"></div>
        </div>
        <div id="layout-tabs"></div>
        <div id="command-window"></div>
      </div>
    </div>
    <div id="statusbar"></div>`;

  const canvas = document.getElementById('drawing') as HTMLCanvasElement;
  const editor = new Editor(canvas);
  editor.fileBridge = window.voltcad ?? browserFileBridge();
  editor.ui = {
    pickSymbol: () => pickSymbolDialog(editor),
    editComponent: (init) => editComponentDialog(editor, init),
    ladderSettings: (init) => ladderDialog(init),
    textInput: (t, l, i) => textInputDialog(t, l, i),
    confirm: (t, m) => confirmDialog(t, m),
  };
  editor.layerDialogRequested = () => layerDialog(editor);
  editor.register({ name: 'TOGGLEPM', aliases: [], description: 'Toggle Project Manager palette', run: () => pm.toggle() });

  buildTitleBar(editor, document.getElementById('titlebar')!);
  new Ribbon(editor, document.getElementById('ribbon')!);
  const pm = new ProjectManager(editor, document.getElementById('project-manager')!);
  buildFileTabs(editor, document.getElementById('file-tabs')!);
  buildLayoutTabs(editor, document.getElementById('layout-tabs')!);
  const cmd = new CommandLine(editor, document.getElementById('command-window')!);
  new StatusBar(editor, document.getElementById('statusbar')!);
  installContextMenu(editor, canvas);
  buildNavBar(editor, document.getElementById('navbar')!);

  // Mouse
  canvas.addEventListener('mousemove', (ev) => editor.onMouseMove(ev));
  canvas.addEventListener('mousedown', (ev) => {
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

  // Keyboard: anything typed while the canvas has focus goes to the command line.
  window.addEventListener('keydown', (ev) => {
    const target = ev.target as HTMLElement;
    const inField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
    if (document.querySelector('.modal-backdrop')) return; // dialogs handle their own keys
    const typing = inField && (target as HTMLInputElement).value !== '';
    // While editing typed text, Delete / Ctrl+A belong to the text field, not the drawing.
    if (typing && (ev.key === 'Delete' || ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a'))) return;
    if (editor.onKeyDown(ev)) {
      ev.preventDefault();
      return;
    }
    if (!inField) {
      if (ev.key === 'Enter') {
        editor.pressEnter();
        ev.preventDefault();
      } else if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        cmd.focus();
      }
    }
  });

  window.addEventListener('resize', () => editor.resize());
  const ro = new ResizeObserver(() => editor.resize());
  ro.observe(canvas.parentElement!);
  editor.resize();

  window.voltcad?.onMenuCommand((c) => editor.runCommand(c));
  // Unsaved-work guard: the browser prompt, and the Electron close handler asks via this flag.
  window.addEventListener('beforeunload', (ev) => {
    if (editor.doc.dirty && !window.voltcad) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });
  window.voltcad?.onQueryDirty(() => editor.doc.dirty);

  if (new URLSearchParams(location.search).has('demo')) {
    seedDemoDrawing(editor);
  }
  editor.zoomExtents();
  cmd.focus();
  // expose for automation / debugging
  (window as unknown as { editor: Editor }).editor = editor;
}

boot();
