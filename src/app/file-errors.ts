/**
 * Plain-language messages for failed file operations (save, autosave, backup, recovery).
 *
 * Errors reach the renderer through Electron IPC as text ("Error invoking remote method
 * 'save-dxf': Error: ENOSPC: no space left on device, write 'C:\\work\\panel.dxf'"), so the code
 * and the path are read from the message when the error object no longer carries them.
 *
 * Twin of electron/file-errors.cjs (the main process maps errors for backup-file the same way);
 * tests/file-safety.test.ts checks that both produce identical messages.
 */

export type FileErrorKind = 'disk-full' | 'permission' | 'read-only' | 'locked' | 'unavailable' | 'too-long' | 'is-folder' | 'io' | 'unknown';
export type FileAction = 'save' | 'autosave' | 'backup' | 'read' | 'list';

export interface FileErrorInfo {
  /** Node/OS error code (ENOSPC, EACCES ...) or null when none was found. */
  code: string | null;
  kind: FileErrorKind;
  /** File the operation was about (from the caller, else from the error), null when unknown. */
  path: string | null;
  /** One or two sentences for the user. */
  message: string;
  /** The original error text, for the command log / problem reports. */
  detail: string;
}

/** OS error code -> family (exported so tests can compare it with electron/file-errors.cjs). */
export const KIND_BY_CODE: Record<string, FileErrorKind> = {
  ENOSPC: 'disk-full',
  EDQUOT: 'disk-full',
  EFBIG: 'disk-full',
  EACCES: 'permission',
  EPERM: 'permission',
  EROFS: 'read-only',
  EBUSY: 'locked',
  ETXTBSY: 'locked',
  ELOCKED: 'locked',
  EAGAIN: 'locked',
  ENOENT: 'unavailable',
  ENOTDIR: 'unavailable',
  ENETUNREACH: 'unavailable',
  ENETDOWN: 'unavailable',
  ENETRESET: 'unavailable',
  EHOSTUNREACH: 'unavailable',
  EHOSTDOWN: 'unavailable',
  ETIMEDOUT: 'unavailable',
  ECONNRESET: 'unavailable',
  ECONNREFUSED: 'unavailable',
  ECONNABORTED: 'unavailable',
  ENOTCONN: 'unavailable',
  ENXIO: 'unavailable',
  ENODEV: 'unavailable',
  ESTALE: 'unavailable',
  ENAMETOOLONG: 'too-long',
  EISDIR: 'is-folder',
  EIO: 'io',
  EMFILE: 'io',
  ENFILE: 'io',
};

/** The OS error code of an error object or IPC error text. */
export function fileErrorCode(err: unknown): string | null {
  const own = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  if (typeof own === 'string' && /^E[A-Z0-9]+$/.test(own)) return own;
  const text = err instanceof Error ? err.message : String(err ?? '');
  const m = /\b(E[A-Z][A-Z0-9]+)\b(?=:|\s*\(|,|$)/.exec(text);
  return m ? m[1]! : null;
}

function pathFromError(err: unknown): string | null {
  const own = err && typeof err === 'object' ? (err as { path?: unknown }).path : undefined;
  if (typeof own === 'string' && own) return own;
  const text = err instanceof Error ? err.message : String(err ?? '');
  // Node: "..., open '/x/y.dxf'" or "..., copyfile '/a' -> '/b'" (the first path is the subject).
  const m = /,\s*\w+\s+'([^']+)'(?:\s*->\s*'[^']*')?\s*$/.exec(text);
  return m ? m[1]! : null;
}

function rawText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err ?? 'unknown error');
  return text.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(?:\w*Error:\s*)+/, '');
}

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
const dirName = (p: string) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : i === 0 ? p.slice(0, 1) : '';
};

function lead(action: FileAction, name: string | null): string {
  const n = name ? `"${name}"` : 'the file';
  switch (action) {
    case 'autosave':
      return `The autosave copy of ${n} could not be written`;
    case 'backup':
      return `The backup copy of ${n} could not be made`;
    case 'read':
      return `${name ? `"${name}"` : 'The file'} could not be read`;
    case 'list':
      return 'The recovery folder could not be read';
    default:
      return `${name ? `"${name}"` : 'The drawing'} could not be saved`;
  }
}

function reason(kind: FileErrorKind, dir: string | null, writing: boolean, reading = false): string {
  const where = dir ? `"${dir}"` : 'the folder';
  switch (kind) {
    case 'disk-full':
      return 'there is not enough free space on the disk. Free some space or choose another drive.';
    case 'permission':
      return writing
        ? `you do not have permission to write to ${where}, or the file is read-only or open in another program. Choose another folder or check the file's permissions.`
        : `you do not have permission to read ${where}. Check the folder's permissions.`;
    case 'read-only':
      return `${where} is on a read-only drive or share. Choose another folder.`;
    case 'locked':
      return 'the file is locked by another program (open elsewhere, or being synced or virus-scanned). Close it there and try again.';
    case 'unavailable':
      // Reading a file: the file itself is usually what is missing, not its folder.
      if (reading && dir) return `the file is no longer in ${where}, or that folder is not available. It may have been moved or deleted, or the network or removable drive is disconnected.`;
      return `${where} is not available. It may have been moved or deleted, or the network or removable drive is disconnected.`;
    case 'too-long':
      return 'the path is too long. Choose a shorter folder or file name.';
    case 'is-folder':
      return 'a folder with that name is in the way. Choose another file name.';
    case 'io':
      return 'the disk reported an input/output error. The drive may be failing, full of open files, or was removed.';
    default:
      return '';
  }
}

/** Map an error from a file operation to a clear message. */
export function describeFileError(err: unknown, opts: { action?: FileAction; path?: string | null } = {}): FileErrorInfo {
  const action = opts.action ?? 'save';
  const code = fileErrorCode(err);
  const kind: FileErrorKind = (code && KIND_BY_CODE[code]) || 'unknown';
  const path = opts.path || pathFromError(err);
  const detail = rawText(err);
  const name = path ? baseName(path) : null;
  const dir = path ? dirName(path) || null : null;
  const why = reason(kind, action === 'list' ? path : dir, action !== 'read' && action !== 'list', action === 'read');
  const message = why ? `${lead(action, action === 'list' ? null : name)}: ${why}` : `${lead(action, action === 'list' ? null : name)}: ${detail}`;
  return { code, kind, path, message, detail };
}
