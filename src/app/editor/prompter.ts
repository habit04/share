/**
 * Tools and the command line: the context a tool works with, starting / finishing / cancelling
 * tools, running commands, typed input (points, distances, text, selection keywords) and Enter.
 * The Editor's public methods delegate here (their documentation is on the Editor).
 */
import type { Point } from '../../core/geometry';
import * as g from '../../core/geometry';
import { constrainDirection } from '../../core/snap';
import type { Tool, ToolContext } from '../../tools/types';
import { parsePointInput, isPlainNumber } from '../input';
import type { Editor } from './editor';
import { fallbackUi, type EditorInternals } from './internals';

export function makeContext(ed: Editor, st: EditorInternals): ToolContext {
  return {
    doc: ed.doc,
    snap: ed.snap,
    get selection() {
      return ed.selection;
    },
    set selection(v: Set<string>) {
      ed.selection = v;
      ed.notify('selection');
      ed.render();
    },
    aperture: () => (ed.viewport.settings.pickBox + 2) * ed.viewport.worldPerPixel(),
    prompt: (t) => ed.setPrompt(t),
    log: (t) => ed.log(t),
    setPreview: (e) => {
      st.overlay.preview = e;
      ed.render();
    },
    setGhost: (e) => {
      st.overlay.ghost = e;
      ed.render();
    },
    setTrackFrom: (p) => {
      st.overlay.trackFrom = p;
      if (p) ed.lastPoint = p;
      ed.render();
    },
    setDynText: (lines) => {
      st.overlay.dynText = ed.dynamicInput ? lines : [];
      ed.render();
    },
    finish: () => ed.finishTool(),
    runCommand: (name) => ed.runCommand(name),
    ui: ed.ui ?? fallbackUi,
    requestSelection: (prompt, onDone) => {
      st.selReq = { prompt, onDone, ids: new Set() };
      updateCursorMode(ed, st);
      ed.setPrompt(prompt);
    },
  };
}

export function startTool(ed: Editor, st: EditorInternals, tool: Tool): void {
  if (ed.tool) ed.tool.onCancel(makeContext(ed, st));
  clearOverlay(ed, st);
  ed.tool = tool;
  ed.toolName = tool.name;
  ed.lastCommand = tool.name;
  tool.start(makeContext(ed, st));
  updateCursorMode(ed, st);
  ed.notify('tool');
  ed.render();
}

export function finishTool(ed: Editor, st: EditorInternals): void {
  ed.tool = null;
  ed.toolName = '';
  st.selReq = null;
  clearOverlay(ed, st);
  updateCursorMode(ed, st);
  ed.setPrompt('Type a command');
  ed.notify('tool');
  ed.render();
}

export function cancel(ed: Editor, st: EditorInternals): void {
  if (st.gripDrag) {
    st.gripDrag = null;
    st.overlay.ghost = [];
    st.overlay.trackFrom = null;
    updateCursorMode(ed, st);
    ed.setPrompt('Type a command');
    ed.render();
    return;
  }
  if (ed.tool) {
    ed.log('*Cancel*');
    ed.tool.onCancel(makeContext(ed, st));
    ed.finishTool();
    return;
  }
  if (st.selReq) {
    st.selReq = null;
    ed.finishTool();
    return;
  }
  if (ed.selection.size > 0) {
    ed.selection.clear();
    ed.notify('selection');
    ed.render();
  }
}

export function clearOverlay(ed: Editor, st: EditorInternals): void {
  st.overlay.preview = [];
  st.overlay.ghost = [];
  st.overlay.trackFrom = null;
  st.overlay.acquired = undefined;
  st.overlay.trackPaths = undefined;
  st.acquired = [];
  st.overlay.dynText = [];
  st.overlay.selectionBox = null;
  st.overlay.hover = null;
  st.dragStart = null;
  st.dragWorld = null;
}

export function acceptsFreeText(ed: Editor): boolean {
  return ed.tool?.acceptsFreeText?.() ?? false;
}

export function updateCursorMode(ed: Editor, st: EditorInternals): void {
  st.overlay.cursorMode = st.selReq ? 'select' : ed.tool ? 'point' : 'idle';
}

export function runCommand(ed: Editor, input: string): void {
  const text = input.trim();
  if (!text) return;
  const [name, ...rest] = text.split(/\s+/);
  const def = ed.commands.get(name!.toUpperCase());
  if (!def) {
    ed.log(`Unknown command "${name}". Press F1 for help.`);
    return;
  }
  if (ed.tool) ed.cancel();
  ed.lastCommand = def.name;
  ed.lastCommandLine = text;
  if (!def.startsTool) ed.log(`Command: ${def.name}`);
  def.run(ed, rest.join(' ') || undefined);
  ed.notify('tool');
}

export function submitInput(ed: Editor, st: EditorInternals, raw: string): void {
  const text = raw.trim();
  if (text.length === 0) {
    ed.pressEnter();
    return;
  }
  ed.log(`${ed.prompt} ${text}`);
  if (st.selReq) {
    const handled = ed.selectionKeyword ? ed.selectionKeyword(text, st.selReq.ids) : false;
    if (handled || text.toUpperCase() === 'ALL') {
      if (!handled) for (const e of ed.doc.entities) st.selReq.ids.add(e.id);
      ed.selection = new Set(st.selReq.ids);
      ed.notify('selection');
      ed.render();
      ed.log(`${st.selReq.ids.size} found`);
    } else ed.log('Expects a point or Window/Last/Crossing/BOX/ALL/Fence/WPolygon/CPolygon/Add/Remove/Previous/Undo');
    return;
  }
  if (ed.tool) {
    if (ed.acceptsFreeText()) {
      ed.tool.onText(raw, makeContext(ed, st));
      return;
    }
    const p = ed.parsePoint(text);
    if (p) {
      acceptPoint(ed, st, p);
      return;
    }
    const num = parseFloat(text);
    if (ed.tool.acceptsDistance && isPlainNumber(text) && Number.isFinite(num) && st.overlay.trackFrom && st.cursorWorld) {
      // direct distance entry along the cursor direction
      const dir = constrainDirection(st.overlay.trackFrom, st.cursorWorld, ed.snap);
      const ang = g.angleOf(st.overlay.trackFrom, dir);
      acceptPoint(ed, st, g.polar(st.overlay.trackFrom, ang, num));
      return;
    }
    ed.tool.onText(text, makeContext(ed, st));
    return;
  }
  ed.runCommand(text);
}

export function pressEnter(ed: Editor, st: EditorInternals): void {
  if (st.selReq) {
    const req = st.selReq;
    st.selReq = null;
    updateCursorMode(ed, st);
    const ids = [...req.ids];
    ed.setPrompt('');
    req.onDone(ids);
    return;
  }
  if (ed.tool) {
    ed.tool.onEnter(makeContext(ed, st));
    return;
  }
  if (ed.lastCommandLine) ed.runCommand(ed.lastCommandLine);
}

export function parsePoint(ed: Editor, text: string): Point | null {
  return parsePointInput(text, ed.lastPoint ?? { x: 0, y: 0 });
}

export function acceptPoint(ed: Editor, st: EditorInternals, p: Point): void {
  ed.lastPoint = p;
  st.acquired = [];
  st.overlay.acquired = undefined;
  st.overlay.trackPaths = undefined;
  ed.tool?.onPoint(p, makeContext(ed, st));
  ed.notify('tool');
}
