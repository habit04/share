import type { Editor } from '../app/editor';
import type { AutosaveEntry, AutosaveStore, Autosaver } from '../app/autosave';
import { omitted3dText, restoreAutosaveImportData } from '../app/autosave';
import { RecoveryActions } from '../app/recovery-actions';
import { describeFileError } from '../app/file-errors';
import { modal, button } from './dialogkit';
import { icon } from './icons';
import './icons-ui';
import { esc } from './dom';

type RecoveryAutosaver = Pick<Autosaver, 'adopt'> & Partial<Pick<Autosaver, 'owns'>>;

/** Logged when the Recovery Manager is asked for (DRAWINGRECOVERY, Retry) and has nothing to offer. */
export const NOTHING_TO_RECOVER = 'Drawing Recovery Manager: no autosaved drawings to recover.';

/**
 * Drawing Recovery Manager: offered at startup when autosave files exist. Backups that belong to
 * drawings open in this session are not offered. When the recovery folder cannot be read, an
 * error is shown instead of an empty list (the files are left alone).
 */
export async function recoveryDialog(editor: Editor, store: AutosaveStore, autosaver?: RecoveryAutosaver): Promise<'shown' | 'empty' | 'error'> {
  let entries: AutosaveEntry[];
  try {
    entries = await store.list();
  } catch (err) {
    recoveryErrorDialog(editor, store, autosaver, err);
    return 'error';
  }
  entries = entries.filter((e) => !autosaver?.owns?.(e.name));
  if (entries.length === 0) return 'empty';
  const m = modal('Drawing Recovery Manager', 560, 'dark');
  m.root.classList.add('recovery-dialog');
  const intro = document.createElement('p');
  intro.textContent = 'The following drawings were autosaved and not saved afterwards. Open a recovered drawing to continue with it (it opens as a modified, unsaved copy; the backup is kept until you save), or discard it.';
  const list = document.createElement('div');
  list.className = 'recovery-list';
  const actions = new RecoveryActions(entries, {
    read: (name) => store.read(name),
    remove: (name) => store.remove(name),
    openRecovered: async (e, text) => {
      // Read like OPEN: a backup that ends early offers to open what was readable (marked as recovered).
      const state = await editor.readDxfText(text, e.originalPath);
      if (!state) throw new Error(`The backup of ${e.title} is damaged and was not opened.`);
      const idx = editor.sessions.add(restoreAutosaveImportData(state, e), e.originalPath, true);
      editor.zoomExtents();
      // The backup stays on disk (and keeps being refreshed) until this drawing is saved.
      const session = editor.sessions.all[idx];
      if (session) autosaver?.adopt(session.id, e.name);
      editor.log(`Recovered ${e.title} from autosave (${state.entities.length} entities). Use SAVE to keep it; the backup is kept until then.`);
      const missing3d = omitted3dText(e);
      if (missing3d) editor.log(missing3d);
      editor.showImportReport(false);
    },
  });
  const discardAll = button('Discard All');
  discardAll.className += ' left';
  discardAll.title = 'Delete the backups still listed (drawings you opened keep theirs until saved)';
  const close = button('Close', true);
  const closeIfDone = () => {
    if (actions.listed.length === 0) m.close();
  };
  const render = () => {
    list.innerHTML = '';
    for (const e of actions.listed) {
      const row = document.createElement('div');
      row.className = 'recovery-row';
      row.dataset.name = e.name;
      const err = actions.errors.get(e.name);
      row.innerHTML = `<span>${icon('recover')}</span><span><b>${esc(e.title)}</b><br><span class="when">${esc(e.originalPath ?? '(never saved)')} — autosaved ${new Date(e.savedAt).toLocaleString()}</span>${omitted3dText(e) ? `<br><span class="when">${esc(omitted3dText(e)!)}</span>` : ''}${err ? `<br><span class="recovery-error" role="alert">${esc(err)}</span>` : ''}</span>`;
      const open = button('Open');
      const discard = button('Discard');
      open.disabled = actions.busy;
      discard.disabled = actions.busy;
      open.addEventListener('click', () => {
        void actions.open(e.name).then((r) => {
          if (r.status === 'failed') editor.log(r.error);
          closeIfDone();
        });
      });
      discard.addEventListener('click', () => {
        void actions.discard(e.name).then((r) => {
          if (r.status === 'failed') editor.log(`Could not delete the backup of ${e.title}: ${r.error}`);
          closeIfDone();
        });
      });
      row.append(open, discard);
      list.appendChild(row);
    }
    discardAll.disabled = actions.busy || actions.listed.length === 0;
    m.root.classList.toggle('busy', actions.busy);
  };
  actions.onChange = render;
  render();
  m.body.append(intro, list);
  discardAll.addEventListener('click', () => {
    void actions.discardAll().then((r) => {
      if (r.status !== 'done') return;
      if (r.failed.length) editor.log(`${r.failed.length} backup(s) could not be deleted; they stay listed.`);
      closeIfDone();
    });
  });
  close.addEventListener('click', () => m.close());
  m.footer.append(discardAll, close);
  return 'shown';
}

/** The recovery folder exists but cannot be read: say so (with Retry) instead of showing nothing. */
function recoveryErrorDialog(editor: Editor, store: AutosaveStore, autosaver: RecoveryAutosaver | undefined, err: unknown): void {
  const info = describeFileError(err, { action: 'list' });
  editor.log(`${info.message} (${info.detail})`);
  const m = modal('Drawing Recovery Manager', 520, 'dark');
  m.root.classList.add('recovery-dialog', 'recovery-error-state');
  const p = document.createElement('p');
  p.className = 'recovery-error';
  p.setAttribute('role', 'alert');
  p.textContent = info.message;
  const note = document.createElement('p');
  note.textContent = 'Autosave copies there were not changed or deleted. Fix the problem and choose Retry to look again.';
  m.body.append(p, note);
  const retry = button('Retry', true);
  const close = button('Close');
  retry.addEventListener('click', () => {
    m.close();
    void recoveryDialog(editor, store, autosaver).then((r) => {
      if (r === 'empty') editor.log(NOTHING_TO_RECOVER);
    });
  });
  close.addEventListener('click', () => m.close());
  m.footer.append(retry, close);
}
