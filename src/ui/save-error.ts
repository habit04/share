import type { FileErrorInfo } from '../app/file-errors';
import { modal, button } from './dialogkit';

export type SaveErrorChoice = 'retry' | 'saveas' | 'cancel';

/**
 * A save failed: say why in plain words and offer Retry (same place), Save As... (another
 * destination) or Cancel. The drawing stays modified and its autosave copy is kept either way.
 */
export function saveErrorDialog(info: FileErrorInfo, fileName: string, opts: { saveAs?: boolean } = {}): Promise<SaveErrorChoice> {
  return new Promise((resolve) => {
    const m = modal('Save Failed', 480, 'dark');
    m.root.classList.add('save-error-dialog');
    let done = false;
    const finish = (v: SaveErrorChoice) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish('cancel'));
    const p = document.createElement('p');
    p.className = 'save-error-message';
    p.setAttribute('role', 'alert');
    p.textContent = info.message;
    const note = document.createElement('p');
    note.className = 'save-error-note';
    note.textContent = `${fileName} is still open with all its changes and is still marked as modified; its autosave copy is kept. ${info.code ? `(${info.code})` : ''}`.trim();
    m.body.append(p, note);
    const retry = button('Retry', true);
    const saveAs = button('Save As...');
    const cancel = button('Cancel');
    retry.addEventListener('click', () => finish('retry'));
    saveAs.addEventListener('click', () => finish('saveas'));
    cancel.addEventListener('click', () => finish('cancel'));
    if (opts.saveAs === false) m.footer.append(retry, cancel);
    else m.footer.append(retry, saveAs, cancel);
    retry.focus();
  });
}
