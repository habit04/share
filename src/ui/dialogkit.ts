import { icon } from './icons';

let modalCounter = 0;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Focusable elements of a dialog in document order (hidden ones skipped). */
function focusableIn(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => e.offsetParent !== null || e === document.activeElement);
}

/**
 * Shared building blocks for the dark AutoCAD-style dialogs (Options, Drafting Settings, Help ...).
 * The dialog is announced as a modal (role, aria-modal, labelled by its title), keeps Tab /
 * Shift+Tab inside itself, and gives the focus back to the element that had it when it closes.
 * Escape closes it unless a popup menu is open on top (the menu takes that Escape).
 */
export function modal(
  title: string,
  width = 520,
  theme: 'light' | 'dark' = 'dark',
): { root: HTMLElement; body: HTMLElement; footer: HTMLElement; close: () => void; onClose: (fn: () => void) => void } {
  const root = document.createElement('div');
  root.className = 'modal-backdrop';
  const dlg = document.createElement('div');
  dlg.className = `modal ${theme}`;
  dlg.style.width = `${width}px`;
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.tabIndex = -1;
  const titleId = `modal-title-${(modalCounter += 1)}`;
  dlg.setAttribute('aria-labelledby', titleId);
  const head = document.createElement('div');
  head.className = 'modal-title';
  head.innerHTML = `<span id="${titleId}">${title}</span><button class="modal-close" title="Close" aria-label="Close">${icon('close')}</button>`;
  const body = document.createElement('div');
  body.className = 'modal-body';
  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  dlg.append(head, body, footer);
  root.appendChild(dlg);
  document.body.appendChild(root);
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const closers: Array<() => void> = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    root.remove();
    window.removeEventListener('keydown', onKey, true);
    if (previouslyFocused && previouslyFocused.isConnected && document.body.contains(previouslyFocused)) {
      try {
        previouslyFocused.focus({ preventScroll: true });
      } catch {
        /* element not focusable any more */
      }
    }
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      // A context menu above the dialog owns Escape (src/ui/menu.ts closes it and stops the event).
      if (document.querySelector('.context-menu')) return;
      ev.stopPropagation();
      for (const fn of closers) fn();
      close();
      return;
    }
    if (ev.key === 'Tab') {
      const list = focusableIn(dlg);
      if (list.length === 0) {
        ev.preventDefault();
        dlg.focus();
        return;
      }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && dlg.contains(active);
      if (!inside) {
        ev.preventDefault();
        (ev.shiftKey ? last : first).focus();
      } else if (!ev.shiftKey && active === last) {
        ev.preventDefault();
        first.focus();
      } else if (ev.shiftKey && active === first) {
        ev.preventDefault();
        last.focus();
      }
    }
  };
  window.addEventListener('keydown', onKey, true);
  head.querySelector('.modal-close')!.addEventListener('click', () => {
    for (const fn of closers) fn();
    close();
  });
  // Initial focus: the first control of the body / footer unless the caller focuses something itself.
  setTimeout(() => {
    if (closed) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && dlg.contains(active) && active !== dlg) return;
    const list = focusableIn(dlg).filter((e) => !e.classList.contains('modal-close'));
    (list[0] ?? dlg).focus();
  }, 0);
  return { root, body, footer, close, onClose: (fn) => closers.push(fn) };
}

export function button(label: string, primary = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'btn' + (primary ? ' primary' : '');
  b.textContent = label;
  return b;
}

/** Tab strip + pages; returns the container. */
export function tabbedDialog(pages: Array<[string, HTMLElement]>, initial = 0, onChange?: (i: number) => void): HTMLElement {
  const wrap = document.createElement('div');
  const tabs = document.createElement('div');
  tabs.className = 'dlg-tabs';
  const bodies: HTMLElement[] = [];
  const btns: HTMLButtonElement[] = [];
  const activate = (i: number) => {
    btns.forEach((b, k) => b.classList.toggle('active', k === i));
    bodies.forEach((b, k) => b.classList.toggle('active', k === i));
    onChange?.(i);
  };
  pages.forEach(([name, el], i) => {
    const b = document.createElement('button');
    b.className = 'dlg-tab';
    b.textContent = name;
    b.addEventListener('click', () => activate(i));
    btns.push(b);
    tabs.appendChild(b);
    const page = document.createElement('div');
    page.className = 'dlg-page';
    page.appendChild(el);
    bodies.push(page);
  });
  wrap.append(tabs, ...bodies);
  activate(Math.max(0, Math.min(pages.length - 1, initial)));
  return wrap;
}

export function dlgGroup(title: string, children: HTMLElement[]): HTMLElement {
  const g = document.createElement('fieldset');
  g.className = 'dlg-group';
  const l = document.createElement('legend');
  l.textContent = title;
  g.append(l, ...children);
  return g;
}

export function dlgRow(label: string, control: HTMLElement): HTMLElement {
  const r = document.createElement('label');
  r.className = 'dlg-row';
  const s = document.createElement('span');
  s.textContent = label;
  r.append(s, control);
  return r;
}

export function dlgCheck(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const l = document.createElement('label');
  l.className = 'dlg-check';
  const i = document.createElement('input');
  i.type = 'checkbox';
  i.checked = checked;
  i.addEventListener('change', () => onChange(i.checked));
  l.append(i, document.createTextNode(label));
  return l;
}

export function numberInput(value: number, min: number, max: number, step: number, onChange: (v: number) => void, slider = false): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'dlg-color';
  const i = document.createElement('input');
  i.type = 'number';
  i.className = 'input';
  i.min = String(min);
  i.max = String(max);
  i.step = String(step);
  i.value = String(value);
  const commit = (v: number) => {
    if (!Number.isFinite(v)) return;
    const c = Math.min(max, Math.max(min, v));
    i.value = String(c);
    if (slider) range.value = String(c);
    onChange(c);
  };
  i.addEventListener('change', () => commit(parseFloat(i.value)));
  i.addEventListener('keydown', (ev) => ev.stopPropagation());
  const range = document.createElement('input');
  range.type = 'range';
  range.min = String(min);
  range.max = String(max);
  range.step = String(step);
  range.value = String(value);
  range.addEventListener('input', () => commit(parseFloat(range.value)));
  if (slider) wrap.append(range);
  wrap.append(i);
  return wrap;
}

export function colorInput(value: string, onChange: (v: string) => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'dlg-color';
  const c = document.createElement('input');
  c.type = 'color';
  c.value = value;
  const t = document.createElement('input');
  t.className = 'input';
  t.value = value;
  t.spellcheck = false;
  c.addEventListener('input', () => {
    t.value = c.value;
    onChange(c.value);
  });
  t.addEventListener('change', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(t.value)) {
      c.value = t.value.toLowerCase();
      onChange(c.value);
    } else t.value = c.value;
  });
  t.addEventListener('keydown', (ev) => ev.stopPropagation());
  wrap.append(c, t);
  return wrap;
}

export function selectInput(options: Array<[string, string]>, value: string, onChange: (v: string) => void): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'input';
  for (const [v, label] of options) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    if (v === value) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

export function textField(value: string, onChange: (v: string) => void, placeholder = ''): HTMLInputElement {
  const i = document.createElement('input');
  i.className = 'input';
  i.value = value;
  i.placeholder = placeholder;
  i.spellcheck = false;
  i.addEventListener('change', () => onChange(i.value));
  i.addEventListener('keydown', (ev) => ev.stopPropagation());
  return i;
}
