import type { Editor } from '../app/editor';
import type { AutosaveEntry, AutosaveStore } from '../app/autosave';
import { readDxf } from '../io/dxf';
import { modal, button } from './dialogkit';
import { icon } from './icons';
import './icons-ui';
import { esc } from './dom';

/** Drawing Recovery Manager: offered at startup when autosave files exist. */
export async function recoveryDialog(editor: Editor, store: AutosaveStore): Promise<void> {
  const entries = await store.list();
  if (entries.length === 0) return;
  const m = modal('Drawing Recovery Manager', 560, 'dark');
  const intro = document.createElement('p');
  intro.textContent = 'The following drawings were autosaved and not saved afterwards. Open a recovered drawing to continue with it (it opens as a modified, unsaved copy), or discard it.';
  const list = document.createElement('div');
  list.className = 'recovery-list';
  const render = (items: AutosaveEntry[]) => {
    list.innerHTML = '';
    for (const e of items) {
      const row = document.createElement('div');
      row.className = 'recovery-row';
      row.innerHTML = `<span>${icon('recover')}</span><span><b>${esc(e.title)}</b><br><span class="when">${esc(e.originalPath ?? '(never saved)')} — autosaved ${new Date(e.savedAt).toLocaleString()}</span></span>`;
      const open = button('Open');
      const discard = button('Discard');
      open.addEventListener('click', async () => {
        const text = await store.read(e.name);
        if (!text) return editor.log(`Could not read autosave ${e.name}.`);
        try {
          const state = readDxf(text);
          editor.sessions.add(state, e.originalPath, true);
          editor.zoomExtents();
          editor.log(`Recovered ${e.title} from autosave (${state.entities.length} entities). Use SAVE to keep it.`);
          await store.remove(e.name);
          row.remove();
          if (!list.childElementCount) m.close();
        } catch (err) {
          editor.log(`Recovery failed: ${(err as Error).message}`);
        }
      });
      discard.addEventListener('click', async () => {
        await store.remove(e.name);
        row.remove();
        if (!list.childElementCount) m.close();
      });
      row.append(open, discard);
      list.appendChild(row);
    }
  };
  render(entries);
  m.body.append(intro, list);
  const discardAll = button('Discard All');
  discardAll.className += ' left';
  discardAll.addEventListener('click', async () => {
    for (const e of entries) await store.remove(e.name);
    m.close();
  });
  const close = button('Close', true);
  close.addEventListener('click', () => m.close());
  m.footer.append(discardAll, close);
}
