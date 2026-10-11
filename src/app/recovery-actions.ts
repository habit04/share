/**
 * The actions of the Drawing Recovery Manager without the DOM (src/ui/recovery.ts draws it).
 *
 * - One action at a time: while an Open / Discard / Discard All is running every other request
 *   is ignored (the dialog also disables its buttons), so a double click cannot open the same
 *   backup twice or discard a backup that is being opened.
 * - A backup that was opened is no longer listed and is never touched by Discard All: it now
 *   belongs to the open drawing and stays on disk until that drawing is saved.
 * - Discard All removes only the entries still listed; one that fails stays listed with its error.
 */
import type { AutosaveEntry } from './autosave';
import { describeFileError, fileErrorCode } from './file-errors';

export interface RecoveryHost {
  /** The backup's DXF text, null when it no longer exists. */
  read(name: string): Promise<string | null>;
  remove(name: string): Promise<void>;
  /** Open the text as a modified drawing (parse, add a tab, adopt the backup); throws when it cannot. */
  openRecovered(entry: AutosaveEntry, text: string): void | Promise<void>;
}

export type RecoveryResult = { status: 'done' } | { status: 'ignored' } | { status: 'failed'; error: string };

export class RecoveryActions {
  private opened = new Set<string>();
  private removed = new Set<string>();
  private running = false;
  /** Last error per entry name (shown in its row). */
  readonly errors = new Map<string, string>();
  /** Called whenever the list, the busy state or an error changes. */
  onChange: (() => void) | null = null;

  constructor(
    readonly entries: readonly AutosaveEntry[],
    private host: RecoveryHost,
  ) {}

  /** True while an action runs: the dialog disables its buttons. */
  get busy(): boolean {
    return this.running;
  }
  /** Entries still offered (not opened, not discarded). */
  get listed(): AutosaveEntry[] {
    return this.entries.filter((e) => this.isListed(e.name));
  }
  isListed(name: string): boolean {
    return this.entries.some((e) => e.name === name) && !this.opened.has(name) && !this.removed.has(name);
  }
  wasOpened(name: string): boolean {
    return this.opened.has(name);
  }

  private async exclusive(fn: () => Promise<RecoveryResult>): Promise<RecoveryResult> {
    if (this.running) return { status: 'ignored' };
    this.running = true;
    this.onChange?.();
    try {
      return await fn();
    } finally {
      this.running = false;
      this.onChange?.();
    }
  }

  open(name: string): Promise<RecoveryResult> {
    if (this.running || !this.isListed(name)) return Promise.resolve({ status: 'ignored' });
    const entry = this.entries.find((e) => e.name === name)!;
    return this.exclusive(async () => {
      try {
        const text = await this.host.read(name);
        if (!text) throw new Error(`The backup file ${name} no longer exists.`);
        await this.host.openRecovered(entry, text);
        this.opened.add(name);
        this.errors.delete(name);
        return { status: 'done' };
      } catch (err) {
        const error = fileErrorCode(err) ? describeFileError(err, { action: 'read' }).message : `Recovery failed: ${err instanceof Error ? err.message : String(err)}`;
        this.errors.set(name, error);
        return { status: 'failed', error };
      }
    });
  }

  discard(name: string): Promise<RecoveryResult> {
    if (this.running || !this.isListed(name)) return Promise.resolve({ status: 'ignored' });
    return this.exclusive(async () => {
      try {
        await this.host.remove(name);
        this.removed.add(name);
        this.errors.delete(name);
        return { status: 'done' };
      } catch (err) {
        const error = `Could not delete the backup: ${describeFileError(err).detail}`;
        this.errors.set(name, error);
        return { status: 'failed', error };
      }
    });
  }

  /** Remove every entry still listed; resolves which were removed and which failed. */
  async discardAll(): Promise<{ status: 'ignored' } | { status: 'done'; removed: string[]; failed: string[] }> {
    if (this.running) return { status: 'ignored' };
    const removed: string[] = [];
    const failed: string[] = [];
    const r = await this.exclusive(async () => {
      for (const e of this.listed) {
        try {
          await this.host.remove(e.name);
          this.removed.add(e.name);
          this.errors.delete(e.name);
          removed.push(e.name);
        } catch (err) {
          this.errors.set(e.name, `Could not delete the backup: ${describeFileError(err).detail}`);
          failed.push(e.name);
        }
      }
      return { status: 'done' };
    });
    return r.status === 'ignored' ? { status: 'ignored' } : { status: 'done', removed, failed };
  }
}
