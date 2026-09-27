/**
 * Timer-based autosave of every dirty drawing (DXF text) plus the recovery list shown at
 * startup. The store is the Electron app-data folder (IPC) or localStorage in the browser.
 */
import type { DrawingState } from '../core/document';
import { writeDxf } from '../io/dxf';
import { sessionTitle, type SessionManager } from './sessions';

export interface AutosaveMeta {
  /** Path of the drawing being edited, or null for an untitled drawing. */
  originalPath: string | null;
  title: string;
  savedAt: number;
}
export interface AutosaveEntry extends AutosaveMeta {
  name: string;
}
export interface AutosaveStore {
  write(name: string, text: string, meta: AutosaveMeta): Promise<void>;
  list(): Promise<AutosaveEntry[]>;
  read(name: string): Promise<string | null>;
  remove(name: string): Promise<void>;
}

/** Stable file name for a session's autosave. */
export function autosaveName(title: string, sessionId: number): string {
  const base = title.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'Drawing';
  return `${base}_${sessionId}.sv.dxf`;
}

/** Minimal storage shape so the browser store can be unit tested with a Map-backed fake. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

const PREFIX = 'jcad.autosave.';

/** Browser fallback: keeps autosaves in localStorage (small drawings only). */
export function localAutosaveStore(storage: KeyValueStorage): AutosaveStore {
  const keys = () => {
    const out: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i);
      if (k && k.startsWith(PREFIX)) out.push(k);
    }
    return out;
  };
  return {
    async write(name, text, meta) {
      try {
        storage.setItem(PREFIX + name, JSON.stringify({ meta, text }));
      } catch {
        /* quota exceeded: skip this autosave */
      }
    },
    async list() {
      const out: AutosaveEntry[] = [];
      for (const k of keys()) {
        try {
          const v = JSON.parse(storage.getItem(k) ?? '') as { meta: AutosaveMeta };
          out.push({ name: k.slice(PREFIX.length), ...v.meta });
        } catch {
          /* ignore broken entries */
        }
      }
      return out.sort((a, b) => b.savedAt - a.savedAt);
    },
    async read(name) {
      try {
        const v = JSON.parse(storage.getItem(PREFIX + name) ?? '') as { text: string };
        return typeof v.text === 'string' ? v.text : null;
      } catch {
        return null;
      }
    },
    async remove(name) {
      storage.removeItem(PREFIX + name);
    },
  };
}

export interface AutosaveBridge {
  autosaveWrite(name: string, text: string, meta: AutosaveMeta): Promise<void>;
  autosaveList(): Promise<AutosaveEntry[]>;
  autosaveRead(name: string): Promise<string | null>;
  autosaveRemove(name: string): Promise<void>;
}

export function bridgeAutosaveStore(b: AutosaveBridge): AutosaveStore {
  return { write: (n, t, m) => b.autosaveWrite(n, t, m), list: () => b.autosaveList(), read: (n) => b.autosaveRead(n), remove: (n) => b.autosaveRemove(n) };
}

/** Decide which sessions need an autosave: dirty ones whose state changed since the last write. */
export function sessionsToAutosave(sessions: ReadonlyArray<{ id: number; dirty: boolean; state: DrawingState }>, lastSaved: ReadonlyMap<number, DrawingState>): number[] {
  return sessions.filter((s) => s.dirty && lastSaved.get(s.id) !== s.state).map((s) => s.id);
}

export class Autosaver {
  private timer = 0;
  private lastSaved = new Map<number, DrawingState>();
  private names = new Map<number, string>();
  onSaved: ((count: number) => void) | null = null;

  constructor(private sessions: SessionManager, private store: AutosaveStore, private minutes: () => number) {}

  start(): void {
    this.stop();
    const m = this.minutes();
    if (m <= 0) return;
    this.timer = window.setInterval(() => void this.runNow(), m * 60_000);
  }
  stop(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
  }
  /** Re-read the interval (after Options changed). */
  restart(): void {
    this.start();
  }

  async runNow(): Promise<number> {
    const all = this.sessions.all;
    const ids = sessionsToAutosave(all, this.lastSaved);
    let n = 0;
    for (const id of ids) {
      const s = all.find((x) => x.id === id)!;
      const name = autosaveName(sessionTitle(s), s.id);
      try {
        await this.store.write(name, writeDxf(s.state), { originalPath: s.filePath, title: sessionTitle(s), savedAt: Date.now() });
        this.lastSaved.set(id, s.state);
        this.names.set(id, name);
        n += 1;
      } catch {
        /* ignore: next tick retries */
      }
    }
    if (n) this.onSaved?.(n);
    return n;
  }

  /** After a successful save or a clean close, the autosave for that session is obsolete. */
  async discardFor(sessionId: number): Promise<void> {
    const name = this.names.get(sessionId);
    this.lastSaved.delete(sessionId);
    this.names.delete(sessionId);
    if (name) await this.store.remove(name);
  }
}
