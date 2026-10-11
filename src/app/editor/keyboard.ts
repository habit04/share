/**
 * Keys: Esc, the F3 / F7 .. F12 toggles, Ctrl+Z / Y / S / O / N / A and Delete.
 * The Editor's public method delegates here (its documentation is on the Editor).
 */
import type { Editor } from './editor';
import type { EditorInternals } from './internals';
import { makeContext } from './prompter';

export function onKeyDown(ed: Editor, st: EditorInternals, ev: KeyboardEvent): boolean {
  const key = ev.key;
  if (key === 'Escape') {
    ed.cancel();
    return true;
  }
  if (key === 'F3') {
    ed.toggle('osnap');
    return true;
  }
  if (key === 'F7') {
    ed.toggle('grid');
    return true;
  }
  if (key === 'F8') {
    ed.toggle('ortho');
    return true;
  }
  if (key === 'F9') {
    ed.toggle('gridSnap');
    return true;
  }
  if (key === 'F10') {
    ed.toggle('polar');
    return true;
  }
  if (key === 'F11') {
    ed.toggle('otrack');
    return true;
  }
  if (key === 'F12') {
    ed.toggle('dyn');
    return true;
  }
  if (ev.ctrlKey || ev.metaKey) {
    const k = key.toLowerCase();
    if (k === 'z') {
      if (!ev.shiftKey && ed.tool && (ed.tool.name === 'LINE' || ed.tool.name === 'PLINE' || ed.tool.name === 'AEWIRE')) {
        ed.tool.onText('U', makeContext(ed, st)); // stay in the command, undo the last segment
        return true;
      }
      ed.runCommand(ev.shiftKey ? 'REDO' : 'UNDO');
      return true;
    }
    if (k === 'y') {
      ed.runCommand('REDO');
      return true;
    }
    if (k === 's') {
      ed.runCommand(ev.shiftKey ? 'SAVEAS' : 'SAVE');
      return true;
    }
    if (k === 'o') {
      ed.runCommand('OPEN');
      return true;
    }
    if (k === 'n') {
      ed.runCommand('NEW');
      return true;
    }
    if (k === 'a') {
      ed.runCommand('SELECTALL');
      return true;
    }
    return false;
  }
  if (key === 'Delete' && !ed.tool && ed.selection.size > 0) {
    ed.runCommand('ERASE');
    return true;
  }
  return false;
}
