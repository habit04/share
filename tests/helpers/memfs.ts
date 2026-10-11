/**
 * In-memory fs/promises subset for crash and fault fuzzing of electron/atomic-write.cjs and
 * electron/autosave-store.cjs (POSIX paths).
 *
 * Every call is one step. A crash can be scheduled at step N: that call (and every later one)
 * throws CRASH and does nothing, except that a write or copy interrupted by the crash leaves a
 * truncated file. `restart()` then applies what a power cut does to data that was never
 * fsync'ed (a file whose last write was not synced may come back truncated) and lets the next
 * "launch" use the file system again. Non-crash failures (EIO, ENOSPC, EPERM ...) can be injected
 * per call through `inject`.
 */
import nodePath from 'node:path';
import type { Rng } from './fuzz';

const p = nodePath.posix;
const normalize = (file: string): string => p.normalize(file.replace(/\\/g, '/'));

export class CrashError extends Error {
  code = 'ECRASH';
  constructor() {
    super('simulated crash');
  }
}

export const fsError = (code: string, what: string, file: string) => Object.assign(new Error(`${code}: simulated failure, ${what} '${file}'`), { code, path: file, syscall: what });

interface MemFile {
  data: string;
  mode: number;
  mtimeMs: number;
  /** Written since the last fsync of its handle (lost or truncated by a power cut). */
  dirty: boolean;
}

export type Injector = (op: string, path: string, step: number) => Error | null;

export class MemFs {
  files = new Map<string, MemFile>();
  dirs = new Set<string>(['/']);
  step = 0;
  crashAt = Infinity;
  crashed = false;
  inject: Injector | null = null;
  readonly constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1 };
  /** Calls made, for failure messages. */
  trace: string[] = [];
  private clock = 1_000_000;

  constructor(private rng: Rng) {}

  /** One fs call: yields (an await point), then crashes / fails as scheduled. Returns 'crash' for the interrupted call. */
  private async enter(op: string, path: string): Promise<'ok' | 'crash'> {
    await Promise.resolve();
    if (this.crashed) throw new CrashError();
    this.step += 1;
    this.trace.push(`${this.step} ${op} ${path}`);
    if (this.step >= this.crashAt) {
      this.crashed = true;
      return 'crash';
    }
    const err = this.inject?.(op, path, this.step);
    if (err) throw err;
    return 'ok';
  }

  private noent(op: string, file: string): Error {
    return fsError('ENOENT', op, file);
  }

  private parentExists(file: string): boolean {
    return this.dirs.has(p.dirname(file));
  }

  // ---------------------------------------------------------------- fs/promises API
  async readFile(file: string, _enc?: unknown): Promise<string> {
    file = normalize(file);
    if ((await this.enter('readFile', file)) === 'crash') throw new CrashError();
    const f = this.files.get(file);
    if (!f) throw this.noent('open', file);
    return f.data;
  }

  async readdir(dir: string): Promise<string[]> {
    dir = normalize(dir);
    if ((await this.enter('readdir', dir)) === 'crash') throw new CrashError();
    if (!this.dirs.has(dir)) throw this.noent('scandir', dir);
    const out: string[] = [];
    for (const f of this.files.keys()) if (p.dirname(f) === dir) out.push(p.basename(f));
    for (const d of this.dirs) if (d !== dir && p.dirname(d) === dir) out.push(p.basename(d));
    return out.sort();
  }

  async mkdir(dir: string, _opts?: unknown): Promise<void> {
    dir = normalize(dir);
    if ((await this.enter('mkdir', dir)) === 'crash') throw new CrashError();
    let d = dir;
    while (d !== '/' && !this.dirs.has(d)) {
      this.dirs.add(d);
      d = p.dirname(d);
    }
  }

  async stat(file: string): Promise<{ isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; mode: number; mtimeMs: number; size: number }> {
    file = normalize(file);
    if ((await this.enter('stat', file)) === 'crash') throw new CrashError();
    if (this.dirs.has(file)) return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, mode: 0o40755, mtimeMs: this.clock, size: 0 };
    const f = this.files.get(file);
    if (!f) throw this.noent('stat', file);
    return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, mode: f.mode, mtimeMs: f.mtimeMs, size: f.data.length };
  }

  /** No symbolic links here; count lstat independently for failure injection. */
  async lstat(file: string): ReturnType<MemFs['stat']> {
    file = normalize(file);
    if ((await this.enter('lstat', file)) === 'crash') throw new CrashError();
    if (this.dirs.has(file)) return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, mode: 0o40755, mtimeMs: this.clock, size: 0 };
    const f = this.files.get(file);
    if (!f) throw this.noent('lstat', file);
    return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, mode: f.mode, mtimeMs: f.mtimeMs, size: Buffer.byteLength(f.data, 'utf8') };
  }

  async access(file: string, _mode?: number): Promise<void> {
    file = normalize(file);
    if ((await this.enter('access', file)) === 'crash') throw new CrashError();
    if (!this.files.has(file) && !this.dirs.has(file)) throw this.noent('access', file);
  }

  async chmod(file: string, mode: number): Promise<void> {
    file = normalize(file);
    if ((await this.enter('chmod', file)) === 'crash') throw new CrashError();
    const f = this.files.get(file);
    if (!f) throw this.noent('chmod', file);
    f.mode = 0o100000 | mode;
  }

  async realpath(file: string): Promise<string> {
    file = normalize(file);
    if ((await this.enter('realpath', file)) === 'crash') throw new CrashError();
    if (!this.files.has(file) && !this.dirs.has(file)) throw this.noent('realpath', file);
    return file;
  }

  async rename(from: string, to: string): Promise<void> {
    from = normalize(from);
    to = normalize(to);
    if ((await this.enter('rename', `${from} -> ${to}`)) === 'crash') throw new CrashError();
    const f = this.files.get(from);
    if (!f) throw this.noent('rename', from);
    if (!this.parentExists(to)) throw this.noent('rename', to);
    if (this.dirs.has(to)) throw fsError('EISDIR', 'rename', to);
    this.files.delete(from);
    this.files.set(to, f); // one atomic directory update
  }

  async copyFile(src: string, dest: string, flags = 0): Promise<void> {
    src = normalize(src);
    dest = normalize(dest);
    const r = await this.enter('copyFile', `${src} -> ${dest}`);
    const f = this.files.get(src);
    if (r === 'crash') {
      // Interrupted copy: the destination holds a prefix of the source.
      if (f && this.parentExists(dest)) this.files.set(dest, { data: f.data.slice(0, this.rng.int(0, Math.max(0, f.data.length - 1))), mode: 0o100644, mtimeMs: this.tick(), dirty: true });
      throw new CrashError();
    }
    if (!f) throw this.noent('copyfile', src);
    if ((flags & this.constants.COPYFILE_EXCL) && (this.files.has(dest) || this.dirs.has(dest))) throw fsError('EEXIST', 'copyfile', dest);
    if (!this.parentExists(dest)) throw this.noent('copyfile', dest);
    this.files.set(dest, { data: f.data, mode: f.mode, mtimeMs: this.tick(), dirty: true });
  }

  async rm(file: string, opts?: { force?: boolean }): Promise<void> {
    file = normalize(file);
    if ((await this.enter('rm', file)) === 'crash') throw new CrashError();
    if (!this.files.delete(file) && !opts?.force) throw this.noent('rm', file);
  }

  async unlink(file: string): Promise<void> {
    return this.rm(file);
  }

  async open(file: string, flags: string | number): Promise<{ stat(): Promise<{ size: number; isFile(): boolean }>; read(buffer: Uint8Array, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>; writeFile(data: string | Uint8Array, enc?: unknown): Promise<void>; sync(): Promise<void>; close(): Promise<void> }> {
    file = normalize(file);
    if ((await this.enter(`open(${flags})`, file)) === 'crash') throw new CrashError();
    if (flags === 'wx') {
      if (this.files.has(file)) throw fsError('EEXIST', 'open', file);
      if (!this.parentExists(file)) throw this.noent('open', file);
      this.files.set(file, { data: '', mode: 0o100644, mtimeMs: this.tick(), dirty: true });
    } else if (!this.files.has(file) && !this.dirs.has(file)) throw this.noent('open', file);
    let closed = false;
    let readOffset = 0;
    const openedFile = this.files.get(file);
    const self = this;
    return {
      async stat() {
        if ((await self.enter('fh.stat', file)) === 'crash') throw new CrashError();
        if (closed) throw fsError('EBADF', 'fstat', file);
        return { size: openedFile ? Buffer.byteLength(openedFile.data, 'utf8') : 0, isFile: () => !!openedFile };
      },
      async read(buffer, offset, length, position) {
        if ((await self.enter('fh.read', file)) === 'crash') throw new CrashError();
        if (closed) throw fsError('EBADF', 'read', file);
        if (!openedFile) throw self.noent('read', file);
        const bytes = Buffer.from(openedFile.data, 'utf8');
        const start = position ?? readOffset;
        const bytesRead = Math.max(0, Math.min(length, bytes.length - start));
        buffer.set(bytes.subarray(start, start + bytesRead), offset);
        if (position === null) readOffset += bytesRead;
        return { bytesRead };
      },
      async writeFile(data: string | Uint8Array) {
        const text = typeof data === 'string' ? data : Buffer.from(data).toString('latin1');
        const r = await self.enter('fh.writeFile', file);
        const f = self.files.get(file);
        if (r === 'crash') {
          if (f) {
            f.data = text.slice(0, self.rng.int(0, Math.max(0, text.length - 1)));
            f.dirty = true;
          }
          throw new CrashError();
        }
        if (closed) throw fsError('EBADF', 'write', file);
        if (!f) throw self.noent('write', file);
        f.data = text;
        f.dirty = true;
        f.mtimeMs = self.tick();
      },
      async sync() {
        if ((await self.enter('fh.sync', file)) === 'crash') throw new CrashError();
        const f = self.files.get(file);
        if (f) f.dirty = false;
      },
      async close() {
        if ((await self.enter('fh.close', file)) === 'crash') throw new CrashError();
        closed = true;
      },
    };
  }

  // ---------------------------------------------------------------- test controls
  private tick(): number {
    this.clock += 1;
    return this.clock;
  }

  /** Synchronous setup (no step counted). */
  put(file: string, data: string, mtimeMs?: number): void {
    file = normalize(file);
    let d = p.dirname(file);
    while (!this.dirs.has(d)) {
      this.dirs.add(d);
      d = p.dirname(d);
    }
    this.files.set(file, { data, mode: 0o100644, mtimeMs: mtimeMs ?? this.tick(), dirty: false });
  }

  get(file: string): string | undefined {
    file = normalize(file);
    return this.files.get(file)?.data;
  }

  list(dir: string): string[] {
    dir = normalize(dir);
    return [...this.files.keys()].filter((f) => p.dirname(f) === dir).map((f) => p.basename(f)).sort();
  }

  /**
   * The next launch. After a power cut (the default) data that was written but never fsync'ed may
   * be lost (truncated at a random point); the file system works again and the step counter restarts.
   */
  restart(powerCut = true): void {
    for (const f of this.files.values()) {
      if (powerCut && f.dirty && this.rng.bool(0.5)) f.data = f.data.slice(0, this.rng.int(0, f.data.length));
      f.dirty = false;
    }
    this.crashed = false;
    this.crashAt = Infinity;
    this.inject = null;
    this.step = 0;
    this.trace = [];
  }
}
