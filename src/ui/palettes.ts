/** Shared palette behaviour: drag-to-resize handle and auto-hide (collapse to the vertical strip). */

export function makePaletteResizable(el: HTMLElement, opts: { edge: 'left' | 'right'; min?: number; max?: number; initial?: number; onWidth: (w: number) => void }): void {
  const min = opts.min ?? 160;
  const max = opts.max ?? 640;
  if (opts.initial) el.style.width = `${Math.max(min, Math.min(max, opts.initial))}px`;
  const handle = document.createElement('div');
  handle.className = 'palette-resizer';
  handle.title = 'Drag to resize';
  if (opts.edge === 'right') el.appendChild(handle);
  else el.prepend(handle);
  let startX = 0;
  let startW = 0;
  const onMove = (ev: MouseEvent) => {
    const dx = ev.clientX - startX;
    const w = Math.max(min, Math.min(max, opts.edge === 'right' ? startW + dx : startW - dx));
    el.style.width = `${w}px`;
    el.style.setProperty('--peek-width', `${w}px`);
  };
  const onUp = () => {
    handle.classList.remove('dragging');
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    opts.onWidth(el.getBoundingClientRect().width);
  };
  handle.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    startX = ev.clientX;
    startW = el.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  el.style.setProperty('--peek-width', `${opts.initial ?? (el.getBoundingClientRect().width || 268)}px`);
}

/**
 * Auto-hide: the palette collapses to its title strip; hovering the strip peeks the body
 * as an overlay. The pin icon in the strip toggles it (like AutoCAD's Auto-hide button).
 */
export function installAutoHide(el: HTMLElement, opts: { initial: boolean; onChange: (auto: boolean) => void }): { set: (auto: boolean) => void; get: () => boolean } {
  const pin = el.querySelectorAll<SVGElement>('.palette-strip-btns svg')[1] ?? null;
  const strip = el.querySelector<HTMLElement>('.palette-strip');
  let hideTimer = 0;
  const set = (auto: boolean) => {
    el.classList.toggle('autohide', auto);
    el.classList.remove('peek');
    pin?.classList.toggle('active', auto);
    opts.onChange(auto);
  };
  pin?.addEventListener('click', () => set(!el.classList.contains('autohide')));
  if (pin) (pin as unknown as HTMLElement).setAttribute('title', 'Auto-hide');
  strip?.addEventListener('mouseenter', () => {
    if (!el.classList.contains('autohide')) return;
    window.clearTimeout(hideTimer);
    el.classList.add('peek');
  });
  el.addEventListener('mouseleave', () => {
    if (!el.classList.contains('autohide')) return;
    hideTimer = window.setTimeout(() => el.classList.remove('peek'), 250);
  });
  el.addEventListener('mouseenter', () => window.clearTimeout(hideTimer));
  set(opts.initial);
  return { set, get: () => el.classList.contains('autohide') };
}

/** Make a floating window draggable by a handle element, constrained to its offset parent. */
export function makeDraggable(el: HTMLElement, handle: HTMLElement): void {
  let off: { x: number; y: number } | null = null;
  handle.addEventListener('mousedown', (ev) => {
    if ((ev.target as HTMLElement).closest('svg, button, input')) return;
    const r = el.getBoundingClientRect();
    off = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    ev.preventDefault();
  });
  window.addEventListener('mousemove', (ev) => {
    if (!off) return;
    const parent = (el.offsetParent as HTMLElement | null) ?? document.body;
    const pr = parent.getBoundingClientRect();
    const x = Math.max(0, Math.min(pr.width - el.offsetWidth, ev.clientX - pr.left - off.x));
    const y = Math.max(0, Math.min(pr.height - el.offsetHeight, ev.clientY - pr.top - off.y));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.right = 'auto';
  });
  window.addEventListener('mouseup', () => (off = null));
}
