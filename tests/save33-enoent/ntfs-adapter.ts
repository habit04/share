// Control helper for the Save33 ENOENT error-identity fix suite
// (test-only). A counting + hookable fs adapter for
// coherentFileDigest's options.fs parameter, extended with an NTFS
// emulation mode. Converted from the external battery's
// ntfs-adapter.cjs to the repo's ESM test conventions; behaviour is
// unchanged.
//
// Base behavior is the micro-candidate counting adapter
// (micro-candidate/tests/counting-adapter.cjs): win32 path spelling
// is bridged to real POSIX temp files; stat returns REAL bigint
// stats; open returns REAL file handles. Only path spelling is
// bridged.
//
// NTFS emulation (options.freezeHandleStat): on Windows/NTFS,
// deleting a file that is held open puts it in delete-pending state:
// path lookups fail (ENOENT/EPERM), but the held handle keeps
// working and handle.stat returns UNCHANGED values — so the digest's
// :97 handle recheck cannot observe the deletion, and the first
// failing call is a path lookup inside pathCheck. POSIX unlink
// differs observably: it moves ctimeNs in the held inode's stat, so
// :97 catches a POSIX delete mid-read and the Windows leak never
// reproduces. freezeHandleStat closes that gap observably: the
// wrapped handle's stat() returns the bigint stat snapshot captured
// at open() time for every later call, which is exactly the NTFS
// observable (handle stat unchanged after a mid-read delete). The
// snapshot is a real Stats object captured from the real handle; no
// field is fabricated — only its freshness is frozen, which is the
// platform behavior being emulated.
//
// Hooks (all optional, all awaited): afterOpen, onRead (1-based
// index, before the real read delegates), onClose (after the real
// close, at most once per handle) — same contract as the counting
// adapter.
//
// F2 hardening (Codex review of the combined package): if the
// freeze capture or the afterOpen hook fails after the real FD was
// acquired, open() closes that FD before rethrowing, so a hook
// failure never leaks a descriptor. The initiating error is the
// error thrown; a failure of the cleanup close itself is attached
// to it distinctly (error.cleanupFailed === true and
// error.cleanupError). counts.openHandles tracks live real FDs so
// tests can prove closure. hooks.freezeError is a test-only fault
// injection: when set (with freezeHandleStat), the freeze capture
// throws it instead of statting, exercising the same guarded path
// as a genuine capture failure.
import type { BigIntStats } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';

export interface NtfsHookInfo {
  winPath: string;
  posixPath: string;
}

export interface NtfsFsHooks {
  freezeHandleStat?: boolean;
  freezeError?: Error;
  afterOpen?: (info: NtfsHookInfo) => void | Promise<void>;
  onRead?: (info: { index: number } & NtfsHookInfo) => void | Promise<void>;
  onClose?: (info: NtfsHookInfo) => void | Promise<void>;
}

export interface NtfsFsCounts {
  stat: Map<string, number>;
  realpath: Map<string, number>;
  open: Map<string, number>;
  handleStat: number;
  handleRead: number;
  handleClose: number;
  openHandles: number;
}

export interface NtfsHandle {
  // In freeze mode the wrapped stat returns the captured Stats
  // object itself (not a promise), exactly as the original did;
  // callers always await it, so the return type stays open.
  stat: (options?: { bigint?: boolean }) => unknown;
  // The digest's read calls are passed through to the real handle
  // verbatim, so the argument list stays dynamically typed exactly
  // as in the CommonJS original.
  read: (...args: any[]) => Promise<any>;
  close: (...args: any[]) => Promise<void>;
}

export interface NtfsFsApi {
  constants: typeof fsp.constants;
  realpath: (winPath: string) => Promise<string>;
  stat: (winPath: string, options?: { bigint?: boolean }) => Promise<unknown>;
  lstat: (winPath: string, options?: { bigint?: boolean }) => Promise<unknown>;
  open: (winPath: string, flags?: string | number) => Promise<NtfsHandle>;
}

export function createNtfsFs(posixRoot: string, hooks: NtfsFsHooks = {}): { fs: NtfsFsApi; counts: NtfsFsCounts } {
  const toPosix = (winPath: string) => {
    const rest = winPath.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/').replace(/^\/+/, '');
    return rest ? path.join(posixRoot, rest) : posixRoot;
  };
  const toWin = (posixPath: string) => {
    const rel = path.relative(posixRoot, posixPath);
    return rel ? `C:\\${rel.replace(/\//g, '\\')}` : 'C:\\';
  };
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  const counts: NtfsFsCounts = {
    stat: new Map(),
    realpath: new Map(),
    open: new Map(),
    handleStat: 0,
    handleRead: 0,
    handleClose: 0,
    openHandles: 0,
  };
  const api: NtfsFsApi = {
    constants: fsp.constants,
    realpath: async (winPath) => {
      bump(counts.realpath, winPath);
      return toWin(await fsp.realpath(toPosix(winPath)));
    },
    stat: (winPath, options) => {
      bump(counts.stat, winPath);
      return fsp.stat(toPosix(winPath), options);
    },
    lstat: (winPath, options) => fsp.lstat(toPosix(winPath), options),
    open: async (winPath, flags) => {
      bump(counts.open, winPath);
      const posixPath = toPosix(winPath);
      const real = await fsp.open(posixPath, flags);
      counts.openHandles += 1;
      const closeReal = async () => {
        try { await real.close(); } finally { counts.openHandles -= 1; }
      };
      // Captured directly from the real handle (not via the wrapped
      // stat) so the freeze capture itself is not counted as a
      // module handleStat. F2: the freeze capture and the afterOpen
      // hook run under one guard — on any failure the acquired FD is
      // closed and the INITIATING error is rethrown; a cleanup-close
      // failure is attached to it (cleanupFailed / cleanupError),
      // never substituted for it.
      let frozenStat: BigIntStats | null = null;
      try {
        if (hooks.freezeHandleStat) {
          if (hooks.freezeError) throw hooks.freezeError;
          frozenStat = await real.stat({ bigint: true });
        }
        if (hooks.afterOpen) await hooks.afterOpen({ winPath, posixPath });
      } catch (error) {
        try { await closeReal(); } catch (cleanupError) {
          const holder = error as { cleanupFailed?: boolean; cleanupError?: unknown };
          holder.cleanupFailed = true;
          holder.cleanupError = cleanupError;
        }
        throw error;
      }
      let closeHookFired = false;
      return {
        stat: (options) => {
          counts.handleStat += 1;
          return frozenStat ?? real.stat(options);
        },
        read: async (...args: any[]) => {
          counts.handleRead += 1;
          if (hooks.onRead) await hooks.onRead({ index: counts.handleRead, winPath, posixPath });
          return real.read(...args);
        },
        close: async () => {
          counts.handleClose += 1;
          await closeReal();
          if (hooks.onClose && !closeHookFired) {
            closeHookFired = true;
            await hooks.onClose({ winPath, posixPath });
          }
        },
      };
    },
  };
  return { fs: api, counts };
}
