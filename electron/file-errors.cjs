// Plain-language messages for failed file operations, for the main process (backup-file).
// Twin of src/app/file-errors.ts: keep both in step (tests/file-safety.test.ts compares them).
'use strict';

const KIND_BY_CODE = {
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
  ELOOP: 'link',
  EIO: 'io',
  EMFILE: 'io',
  ENFILE: 'io',
};

/** Error codes that are not in KIND_BY_CODE but still name a file system failure in error text. */
const OTHER_FS_CODES = new Set(['EINVAL', 'EEXIST', 'ENOTEMPTY', 'EXDEV', 'EMLINK', 'ENOTSUP', 'EOPNOTSUPP', 'ECANCELED', 'EPIPE', 'ENOSYS', 'EBADF']);

/** The OS error code of an error object or error text (in text only known codes count, see the twin). */
function fileErrorCode(err) {
  const own = err && typeof err === 'object' ? err.code : undefined;
  if (typeof own === 'string' && /^E[A-Z0-9]+$/.test(own)) return own;
  const text = err instanceof Error ? err.message : String(err == null ? '' : err);
  for (const m of text.matchAll(/\b(E[A-Z][A-Z0-9]+)\b(?=:|\s*\(|,|$)/g)) {
    if (KIND_BY_CODE[m[1]] || OTHER_FS_CODES.has(m[1])) return m[1];
  }
  return null;
}

function pathFromError(err) {
  const own = err && typeof err === 'object' ? err.path : undefined;
  if (typeof own === 'string' && own) return own;
  const text = err instanceof Error ? err.message : String(err == null ? '' : err);
  const m = /,\s*\w+\s+'([^']+)'(?:\s*->\s*'[^']*')?\s*$/.exec(text);
  return m ? m[1] : null;
}

function rawText(err) {
  const text = err instanceof Error ? err.message : String(err == null ? 'unknown error' : err);
  return text.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(?:\w*Error:\s*)+/, '');
}

const baseName = (p) => p.split(/[\\/]/).pop() || p;
const dirName = (p) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : i === 0 ? p.slice(0, 1) : '';
};

function lead(action, name) {
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

function reason(kind, dir, writing, reading = false) {
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
    case 'link':
      // A write refused because the file is a symbolic link, or a linked folder leads out of the
      // project's folder (electron/atomic-write.cjs).
      return writing
        ? `the file is a symbolic link (shortcut), or a linked folder on its path leads outside ${where}. Saving does not follow such links, so no other file can be overwritten through them. Use Save As to save under another name, or open the file the link points to.`
        : 'the path contains a loop of symbolic links.';
    case 'io':
      return 'the disk reported an input/output error. The drive may be failing, full of open files, or was removed.';
    default:
      return '';
  }
}

/** { code, kind, path, message, detail } for an error of a file operation. */
function describeFileError(err, opts = {}) {
  const action = opts.action || 'save';
  const code = fileErrorCode(err);
  const kind = (code && KIND_BY_CODE[code]) || 'unknown';
  const path = opts.path || pathFromError(err);
  const detail = rawText(err);
  const name = path ? baseName(path) : null;
  const dir = path ? dirName(path) || null : null;
  const why = reason(kind, action === 'list' ? path : dir, action !== 'read' && action !== 'list', action === 'read');
  const message = why ? `${lead(action, action === 'list' ? null : name)}: ${why}` : `${lead(action, action === 'list' ? null : name)}: ${detail}`;
  return { code, kind, path, message, detail };
}

module.exports = { describeFileError, fileErrorCode, KIND_BY_CODE };
