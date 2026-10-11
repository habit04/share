/**
 * Dialogs of the file-safety workflows: the Save All list shown when the window closes,
 * the per-file question after a failed .bak copy, and the project recovery offer.
 * Built with the dialog kit like the other dialogs; the logic lives in src/app/closeflow.ts.
 */
import { modal, button } from './dialogkit';
import { esc } from './dom';
import { closeErrorText, type UnsavedItem, type CloseDecision } from '../app/closeflow';

const KIND_LABEL: Record<UnsavedItem['kind'], string> = { drawing: 'Drawing', symbol: 'Symbol (user library)', project: 'Project' };

/**
 * Save All / Discard All / Cancel for everything that is unsaved. Each row has a checkbox:
 * unticked items are discarded (the main button then reads "Save Selected").
 */
export function saveAllDialog(items: readonly UnsavedItem[], context: 'close' | 'quit' | 'restart' = 'close'): Promise<CloseDecision> {
  return new Promise((resolve) => {
    const m = modal('Save Changes', 560);
    let done = false;
    const finish = (v: CloseDecision) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish({ action: 'cancel' }));
    const intro = document.createElement('p');
    intro.textContent = `${items.length} item(s) have unsaved changes. Save them before ${context === 'restart' ? 'restarting to install the update' : 'closing JCad Electrical'}?`;
    const list = document.createElement('div');
    list.className = 'report-wrap save-all-list';
    list.style.maxHeight = '260px';
    const boxes: HTMLInputElement[] = [];
    for (const it of items) {
      const row = document.createElement('label');
      row.className = 'radio-row save-all-row';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = true;
      box.dataset.key = it.key;
      boxes.push(box);
      const text = document.createElement('span');
      text.innerHTML = ` <b>${esc(it.title)}</b> <span class="hint">${esc(KIND_LABEL[it.kind])}${it.detail ? ` - ${esc(it.detail)}` : ''}</span>`;
      row.append(box, text);
      list.appendChild(row);
    }
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Items are saved one after another; if one cannot be saved, nothing is closed and the error is shown. Unticked items are discarded.';
    m.body.append(intro, list, hint);
    const save = button('Save All', true);
    const discard = button("Discard All");
    const cancel = button('Cancel');
    const sync = () => {
      const n = boxes.filter((b) => b.checked).length;
      save.textContent = n === boxes.length ? 'Save All' : n === 0 ? 'Close Without Saving' : 'Save Selected';
    };
    for (const b of boxes) b.addEventListener('change', sync);
    save.addEventListener('click', () => finish({ action: 'save', keys: new Set(boxes.filter((b) => b.checked).map((b) => b.dataset.key!)) }));
    discard.addEventListener('click', () => finish({ action: 'discard' }));
    cancel.addEventListener('click', () => finish({ action: 'cancel' }));
    m.footer.append(save, discard, cancel);
    setTimeout(() => save.focus(), 0);
  });
}

/** A save failed while closing: say which item and why (the window stays open). */
export function saveFailedDialog(title: string, error: string): Promise<void> {
  return new Promise((resolve) => {
    const m = modal('Save Failed', 480);
    m.onClose(() => resolve());
    const p = document.createElement('p');
    p.textContent = closeErrorText(title, error);
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Nothing was closed. Items saved before this one stay saved; save the rest yourself or close again.';
    m.body.append(p, hint);
    const ok = button('OK', true);
    ok.addEventListener('click', () => {
      m.close();
      resolve();
    });
    m.footer.append(ok);
  });
}

/**
 * The .bak copy of a drawing failed before a project-wide command rewrites it: skip that drawing
 * (default) or write it without a backup. Resolves true only for "Continue Without Backup".
 */
export function backupFailedDialog(name: string, path: string, error: string): Promise<boolean> {
  return new Promise((resolve) => {
    const m = modal('Backup Failed', 520);
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish(false));
    const p = document.createElement('p');
    p.textContent = `The backup copy of ${name} could not be written (${error}).`;
    const where = document.createElement('div');
    where.className = 'hint';
    where.textContent = path;
    const q = document.createElement('p');
    q.textContent = `Skip ${name} (it is left unchanged), or write it without a backup?`;
    m.body.append(p, where, q);
    const skip = button(`Skip ${name}`, true);
    const go = button('Continue Without Backup');
    skip.addEventListener('click', () => finish(false));
    go.addEventListener('click', () => finish(true));
    m.footer.append(skip, go);
    setTimeout(() => skip.focus(), 0);
  });
}

/** Startup offer for an autosaved project with unsaved changes: 'open' | 'discard' | 'later'. */
export function projectRecoveryDialog(name: string, path: string | null, savedAt: number): Promise<'open' | 'discard' | 'later'> {
  return new Promise((resolve) => {
    const m = modal('Project Recovery', 520);
    let done = false;
    const finish = (v: 'open' | 'discard' | 'later') => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish('later'));
    const p = document.createElement('p');
    p.textContent = `Unsaved changes to project ${name} were autosaved ${new Date(savedAt).toLocaleString()} and not saved afterwards.`;
    const where = document.createElement('div');
    where.className = 'hint';
    where.textContent = path ?? '(project never saved)';
    const q = document.createElement('p');
    q.textContent = 'Open the recovered project (as modified, unsaved changes), or discard the autosave?';
    m.body.append(p, where, q);
    const open = button('Open Recovered Project', true);
    const discard = button('Discard');
    const later = button('Later');
    open.addEventListener('click', () => finish('open'));
    discard.addEventListener('click', () => finish('discard'));
    later.addEventListener('click', () => finish('later'));
    m.footer.append(open, discard, later);
  });
}

/** Read failures keep recovery available and offer a deliberate retry. */
export function projectRecoveryReadFailedDialog(name: string, error: unknown): Promise<'retry' | 'later'> {
  return new Promise((resolve) => {
    const m = modal('Project Recovery Could Not Be Read', 520);
    let done = false;
    const finish = (choice: 'retry' | 'later') => {
      if (done) return;
      done = true;
      m.close();
      resolve(choice);
    };
    m.onClose(() => finish('later'));
    const p = document.createElement('p');
    p.textContent = `${name} could not be read: ${error instanceof Error ? error.message : String(error)}`;
    const hint = document.createElement('p');
    hint.textContent = 'The recovery copy is kept. Retry now, or continue to drawing recovery and try this project next time.';
    m.body.append(p, hint);
    const retry = button('Retry', true);
    const later = button('Later');
    retry.addEventListener('click', () => finish('retry'));
    later.addEventListener('click', () => finish('later'));
    m.footer.append(retry, later);
  });
}
