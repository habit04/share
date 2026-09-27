import { icon } from './icons';

/** Shared building blocks for the dark AutoCAD-style dialogs (Options, Drafting Settings, Help ...). */
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
  const head = document.createElement('div');
  head.className = 'modal-title';
  head.innerHTML = `<span>${title}</span><button class="modal-close" title="Close">${icon('close')}</button>`;
  const body = document.createElement('div');
  body.className = 'modal-body';
  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  dlg.append(head, body, footer);
  root.appendChild(dlg);
  document.body.appendChild(root);
  const closers: Array<() => void> = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    root.remove();
    window.removeEventListener('keydown', onKey, true);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      for (const fn of closers) fn();
      close();
    }
  };
  window.addEventListener('keydown', onKey, true);
  head.querySelector('.modal-close')!.addEventListener('click', () => {
    for (const fn of closers) fn();
    close();
  });
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
