/**
 * Just enough of the DOM for UI classes that build plain elements (the Properties palette, the
 * command line) to run in Node: elements with children, classes, values, listeners and text.
 * `installFakeDocument()` puts a `document` on globalThis (when there is none) and returns the
 * function that removes it again.
 */

/** A minimal stand-in for an HTMLElement (or a text node). */
export class FakeElement {
  readonly children: FakeElement[] = [];
  readonly classes = new Set<string>();
  readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
  readonly style: Record<string, string> = {};
  textContent = '';
  value = '';
  selected = false;
  spellcheck = true;
  autocomplete = '';
  placeholder = '';
  title = '';
  disabled = false;
  scrollTop = 0;
  scrollHeight = 0;
  constructor(readonly tagName: string) {}
  get className(): string {
    return [...this.classes].join(' ');
  }
  set className(v: string) {
    this.classes.clear();
    for (const c of v.split(/\s+/).filter(Boolean)) this.classes.add(c);
  }
  readonly classList = {
    add: (c: string) => void this.classes.add(c),
    remove: (c: string) => void this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
    toggle: (c: string, force?: boolean) => {
      const on = force ?? !this.classes.has(c);
      if (on) this.classes.add(c);
      else this.classes.delete(c);
      return on;
    },
  };
  set innerHTML(_v: string) {
    this.children.length = 0;
  }
  get innerHTML(): string {
    return '';
  }
  appendChild(c: FakeElement): FakeElement {
    this.children.push(c);
    return c;
  }
  append(...cs: FakeElement[]): void {
    this.children.push(...cs);
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  /** Dispatch an event object (default: a bare one) to the listeners of `type`. */
  fire(type: string, ev: Record<string, unknown> = {}): void {
    const event = { key: '', preventDefault() {}, stopPropagation() {}, ...ev };
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  querySelector(): null {
    return null;
  }
  focus(): void {}
  blur(): void {}
}

/** Install a fake `document` unless a real one exists; returns the uninstaller. */
export function installFakeDocument(): () => void {
  const g = globalThis as Record<string, unknown>;
  if ('document' in g) return () => {};
  g.document = {
    createElement: (t: string) => new FakeElement(t),
    createTextNode: (t: string) => Object.assign(new FakeElement('#text'), { textContent: t }),
    querySelectorAll: () => [],
  };
  return () => {
    delete g.document;
  };
}
