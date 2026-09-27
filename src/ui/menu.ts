import { icon } from './icons';
import { esc } from './dom';

/** A popup menu entry; `null` renders a separator. */
export type MenuItem =
  | {
      label: string;
      run?: () => void;
      items?: MenuItem[];
      check?: boolean;
      disabled?: boolean;
      icon?: string;
      /** Small swatch colour shown before the label. */
      swatch?: string;
    }
  | null;

let openRoot: HTMLElement | null = null;
let offHandlers: Array<() => void> = [];

export function closeMenus(): void {
  openRoot?.remove();
  openRoot = null;
  for (const off of offHandlers) off();
  offHandlers = [];
}

/**
 * Show a dark AutoCAD-style popup at a point or anchored below/above an element.
 * Submenus open on hover to the right (or left when there is no room).
 */
export function showMenu(anchor: HTMLElement | { x: number; y: number }, items: MenuItem[], opts: { above?: boolean; alignRight?: boolean; minWidth?: number } = {}): HTMLElement {
  closeMenus();
  const root = buildLevel(items, opts.minWidth);
  root.classList.add('context-root');
  document.body.appendChild(root);
  openRoot = root;
  const r = root.getBoundingClientRect();
  let x: number;
  let y: number;
  if (anchor instanceof HTMLElement) {
    const a = anchor.getBoundingClientRect();
    x = opts.alignRight ? a.right - r.width : a.left;
    y = opts.above ? a.top - r.height - 2 : a.bottom + 2;
  } else {
    x = anchor.x;
    y = anchor.y;
    if (y + r.height > window.innerHeight) y = Math.max(0, anchor.y - r.height);
  }
  if (x + r.width > window.innerWidth) x = Math.max(0, window.innerWidth - r.width - 4);
  if (y + r.height > window.innerHeight) y = Math.max(0, window.innerHeight - r.height - 4);
  root.style.left = `${x}px`;
  root.style.top = `${y}px`;
  const onDown = (ev: MouseEvent) => {
    if (!root.contains(ev.target as Node)) closeMenus();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') closeMenus();
  };
  const onBlur = () => closeMenus();
  // Defer so the click that opened the menu does not close it.
  setTimeout(() => {
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    offHandlers.push(() => window.removeEventListener('mousedown', onDown, true), () => window.removeEventListener('keydown', onKey, true), () => window.removeEventListener('blur', onBlur));
  }, 0);
  return root;
}

function buildLevel(items: MenuItem[], minWidth?: number): HTMLElement {
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  if (minWidth) menu.style.minWidth = `${minWidth}px`;
  let sub: HTMLElement | null = null;
  const closeSub = () => {
    sub?.remove();
    sub = null;
  };
  for (const it of items) {
    if (!it) {
      const sep = document.createElement('div');
      sep.className = 'context-sep';
      menu.appendChild(sep);
      continue;
    }
    const b = document.createElement('button');
    b.className = 'context-item' + (it.disabled ? ' disabled' : '') + (it.items ? ' has-sub' : '');
    const [label, accel] = it.label.split('\t');
    b.innerHTML = `<span class="context-check">${it.check ? icon('check') : ''}</span>${it.swatch ? `<span class="context-swatch" style="background:${esc(it.swatch)}"></span>` : ''}${it.icon ? `<span class="context-ic">${icon(it.icon)}</span>` : ''}<span class="context-label">${esc(label ?? '')}</span>${accel ? `<span class="context-accel">${esc(accel)}</span>` : ''}${it.items ? `<span class="context-arrow">${icon('chevron')}</span>` : ''}`;
    if (it.disabled) b.disabled = true;
    if (it.items) {
      const open = () => {
        closeSub();
        sub = buildLevel(it.items!);
        sub.classList.add('context-sub');
        document.body.appendChild(sub);
        const br = b.getBoundingClientRect();
        const sr = sub.getBoundingClientRect();
        let x = br.right - 2;
        if (x + sr.width > window.innerWidth) x = br.left - sr.width + 2;
        let y = br.top - 3;
        if (y + sr.height > window.innerHeight) y = Math.max(0, window.innerHeight - sr.height - 4);
        sub.style.left = `${x}px`;
        sub.style.top = `${y}px`;
        sub.addEventListener('mouseleave', (ev) => {
          const to = ev.relatedTarget as Node | null;
          if (to && (menu.contains(to) || sub?.contains(to))) return;
          closeSub();
        });
      };
      b.addEventListener('mouseenter', open);
      b.addEventListener('click', open);
    } else {
      b.addEventListener('mouseenter', () => closeSub());
      b.addEventListener('click', () => {
        if (it.disabled) return;
        closeMenus();
        it.run?.();
      });
    }
    menu.appendChild(b);
  }
  menu.addEventListener('mouseleave', (ev) => {
    const to = ev.relatedTarget as Node | null;
    if (to && sub?.contains(to)) return;
    closeSub();
  });
  const origRemove = menu.remove.bind(menu);
  menu.remove = () => {
    closeSub();
    origRemove();
  };
  return menu;
}
