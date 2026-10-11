/**
 * Progress dialog for large DWG files (desktop).
 *
 * The main process reads DWG files with LibreDWG in a worker thread (electron/dwg-host.cjs). For
 * a file over the size threshold it announces the read on 'open-progress' ({ id, state: 'start' |
 * 'end' | 'cancelled', name, size, cancellable }); this dialog shows the file, its size and the
 * elapsed time with an indeterminate bar (LibreDWG reports no percentage) and a Cancel button that
 * asks the main process to stop the read (the open then fails with "Open cancelled").
 */
import { modal, button } from './dialogkit';
import { esc } from './dom';

export interface OpenProgressEvent {
  id: number;
  state: 'start' | 'end' | 'cancelled';
  name: string;
  size: number;
  cancellable?: boolean;
}

export interface OpenProgressBridge {
  onOpenProgress(cb: (p: OpenProgressEvent) => void): void;
  cancelOpen(id: number): Promise<boolean>;
}

/** "12.3 MB" / "850 KB". */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Wire the dialog to the bridge. `log` receives one line when a read is cancelled. */
export function installOpenProgress(bridge: OpenProgressBridge, log: (text: string) => void): void {
  const open = new Map<number, { close: () => void; timer: number }>();
  bridge.onOpenProgress((p) => {
    if (!p || typeof p.id !== 'number') return;
    if (p.state === 'start') {
      const m = modal('Opening Drawing', 420, 'dark');
      m.root.classList.add('open-progress');
      const started = Date.now();
      m.body.innerHTML =
        `<div style="font-size:12px;line-height:1.6">Reading <b>${esc(p.name)}</b> (${formatBytes(p.size)})...</div>` +
        `<div class="open-progress-bar" role="progressbar" aria-label="Reading the drawing" style="height:6px;margin:10px 0 6px;border-radius:3px;background:rgba(255,255,255,.12);overflow:hidden">` +
        `<div style="height:100%;width:30%;background:#4a90d9;border-radius:3px;animation:jcad-indeterminate 1.2s ease-in-out infinite"></div></div>` +
        `<div class="open-progress-elapsed" style="font-size:11px;opacity:.75">0 s</div>`;
      if (!document.getElementById('jcad-indeterminate-style')) {
        const st = document.createElement('style');
        st.id = 'jcad-indeterminate-style';
        st.textContent = '@keyframes jcad-indeterminate{0%{transform:translateX(-100%)}100%{transform:translateX(340%)}}';
        document.head.appendChild(st);
      }
      const elapsed = m.body.querySelector<HTMLElement>('.open-progress-elapsed');
      const timer = window.setInterval(() => {
        if (elapsed) elapsed.textContent = `${Math.round((Date.now() - started) / 1000)} s`;
      }, 500);
      const cancel = button('Cancel');
      cancel.disabled = p.cancellable === false;
      cancel.addEventListener('click', () => {
        cancel.disabled = true;
        void bridge.cancelOpen(p.id);
      });
      m.footer.append(cancel);
      // Esc / the close box cancel the read too.
      m.onClose(() => {
        window.clearInterval(timer);
        if (open.has(p.id)) {
          open.delete(p.id);
          if (p.cancellable !== false) void bridge.cancelOpen(p.id);
        }
      });
      open.set(p.id, { close: m.close, timer });
      return;
    }
    const entry = open.get(p.id);
    if (!entry) return;
    open.delete(p.id);
    window.clearInterval(entry.timer);
    entry.close();
    if (p.state === 'cancelled') log(`Opening ${p.name} was cancelled.`);
  });
}
