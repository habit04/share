/**
 * Ordering of file writes. Every save captures a revision (a monotonically increasing number)
 * when it takes its snapshot; writes to the same destination run one after another, and a
 * write whose revision is older than the last completed write to that path is dropped, so an
 * older snapshot can never overwrite a newer one (a slow Save finishing after a later Save, or
 * a project-wide command writing a file the user saved from a tab meanwhile).
 */
import { pathIdentityKey } from './paths';

let revisionCounter = 0;

/** A new revision number; call it when the data to be written is captured. */
export function captureRevision(): number {
  revisionCounter += 1;
  return revisionCounter;
}

export type QueuedResult<T> = { status: 'written'; value: T } | { status: 'stale' };

export class SaveQueue {
  private tails = new Map<string, Promise<unknown>>();
  private completed = new Map<string, number>();

  constructor(public log: (text: string) => void = () => {}) {}

  /** Revision of the last completed write to `path` (0 = none). */
  lastCompleted(path: string): number {
    return this.completed.get(pathIdentityKey(path)) ?? 0;
  }

  /** Record a write that went through another route (Save As picked this path in the dialog). */
  markCompleted(path: string, revision: number): void {
    const k = pathIdentityKey(path);
    this.completed.set(k, Math.max(this.completed.get(k) ?? 0, revision));
  }

  /**
   * Run `write` after every earlier write to `path` has settled. When a newer revision has
   * completed for the path in the meantime, `write` is not called and the result is 'stale'.
   * `write` may return the path it actually wrote (a dialog may have chosen another one); then
   * that path, not `path`, is recorded as completed.
   */
  run<T>(path: string, revision: number, write: () => Promise<T>): Promise<QueuedResult<T>> {
    const k = pathIdentityKey(path);
    const prev = this.tails.get(k) ?? Promise.resolve();
    const job = prev.then(
      () => this.exec(k, path, revision, write),
      () => this.exec(k, path, revision, write),
    );
    const tail = job.catch(() => undefined);
    this.tails.set(k, tail);
    void tail.then(() => {
      if (this.tails.get(k) === tail) this.tails.delete(k);
    });
    return job;
  }

  private async exec<T>(k: string, path: string, revision: number, write: () => Promise<T>): Promise<QueuedResult<T>> {
    const done = this.completed.get(k) ?? 0;
    if (revision < done) {
      this.log(`Save of ${path} skipped: it holds an older revision (${revision}) than the one already written (${done}).`);
      return { status: 'stale' };
    }
    const value = await write();
    if (value !== null && value !== undefined && (value as unknown) !== false) {
      // A returned path is the file actually written (a dialog may have picked another one): only
      // that file holds this revision; the requested one is unchanged.
      if (typeof value === 'string') this.markCompleted(value, revision);
      else this.completed.set(k, Math.max(this.completed.get(k) ?? 0, revision));
    }
    return { status: 'written', value };
  }
}

/** The application's queue (all drawing and project writes go through it). */
export const saveQueue = new SaveQueue();

/** 53-bit FNV-1a style hash of a text (to tell whether a file changed since it was read). */
export function contentHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return `${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}:${text.length}`;
}
