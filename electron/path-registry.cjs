/**
 * The file paths the renderer may name (electron/main.cjs), and what it may do with them.
 *
 * - Readable ("known"): may be opened by name. Files the user chose in our dialogs or saved to,
 *   the Recent Documents list, and the drawings and catalog file of an opened project.
 * - Writable: may be saved over or backed up by name. Files the user chose in a dialog, handed
 *   over through the OS or saved to, and the drawings an opened project lists (see below).
 *
 * A project's drawing entries are resolved to absolute paths first (relative ones against the
 * project's folder, "." / ".." collapsed) and only then checked; entries of other file types
 * than .dxf / .dwg (so never package.json or another .json), Windows stream names
 * ("file.json:x.dxf"), device paths (\\?\..., \\.\...) and network paths (\\server\share\...,
 * //server/share/...) on another server than the project are ignored, so opening a file never
 * makes the program contact another computer. What remains is writable:
 *
 * - for a project the user chose (its Open Project dialog, an OS hand-over, or Recent Documents
 *   for a project file the user chose earlier): wherever the drawing lives;
 * - for a project opened only by name (a plugin, a script, the OPENPROJECT command with a path):
 *   inside the project's folder only; drawings outside it are readable only.
 *
 * The catalog file is always readable only. Access the user granted through a dialog is never
 * reduced by file content. Both lists are persisted in recent.json, so Recent Documents keep
 * working after a restart.
 */
const path = require('node:path');

const MAX_PATH = 4096;
const MAX_WRITABLE = 500;
const MAX_READ_ONLY = 200;
const DRAWING_RE = /\.(dxf|dwg)$/i;

/**
 * Identity key of a path, the twin of src/app/paths.ts pathKey: absolute only, "." / ".." and
 * separators resolved, Unicode NFC (macOS hands out decomposed names while project files and
 * typed names are usually composed, so "José.dxf" matches either way), case-folded on Windows.
 * A relative path or one with a NUL byte has no key and is never "known". (Self-contained apart from
 * `path` and `process`: tests/fuzz-paths.test.ts evaluates its source text per platform.)
 * @param {unknown} p
 * @returns {string | null}
 */
function pathKey(p) {
  if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0') || !path.isAbsolute(p)) return null;
  const k = path.resolve(p).normalize('NFC');
  return process.platform === 'win32' ? k.toLowerCase() : k;
}

/**
 * The server a network path points at: "\\server\share\..." or "//server/share/..." (either
 * separator), also "\\?\UNC\server\share\...". Other "\\?\" / "\\.\" device paths give "", which
 * never matches a server.
 * @param {unknown} p
 * @returns {string | null} the lower-case server name, "" for a device path, null for a local path
 */
function networkHost(p) {
  if (typeof p !== 'string' || !/^[\\/]{2}/.test(p)) return null;
  const unc = /^[\\/]{2}[?.][\\/]unc[\\/]([^\\/]+)/i.exec(p);
  if (unc) return unc[1].toLowerCase();
  if (/^[\\/]{2}[?.](?:[\\/]|$)/.test(p)) return '';
  const m = /^[\\/]{2}([^\\/]+)/.exec(p);
  return m ? m[1].toLowerCase() : '';
}

/**
 * A Windows stream name ("C:\\jobs\\package.json:x.dxf" writes a stream of package.json) or
 * another ":" after the drive. Other systems allow ":" in file names.
 * @param {string} p  an absolute path
 */
function streamName(p) {
  return process.platform === 'win32' && p.replace(/^[A-Za-z]:/, '').includes(':');
}

/**
 * Is `child` the folder `dir` or inside it? Both are resolved first.
 * @param {string} dir
 * @param {string} child
 */
function isInside(dir, child) {
  const rel = path.relative(path.resolve(dir), path.resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * @param {{ onChange?: () => void }} [opts]  onChange: the persisted lists changed (write recent.json)
 */
function createPathRegistry({ onChange } = {}) {
  /** @type {Map<string, string>} key -> the path as it was given, for every readable path */
  const readable = new Map();
  /** @type {Set<string>} keys of the writable paths (all of them readable too) */
  const writable = new Set();

  /**
   * @param {unknown} p
   * @param {boolean} write
   * @param {boolean} notify
   */
  function add(p, write, notify) {
    const k = pathKey(p);
    if (k === null) return false;
    const was = readable.has(k);
    if (write || !was) {
      // Most recent last: the persisted lists keep the newest entries.
      readable.delete(k);
      readable.set(k, /** @type {string} */ (p));
    }
    if (write) writable.add(k);
    if (notify && onChange && (write || !was)) onChange();
    return true;
  }

  /** @param {Iterable<[string, string]>} entries @param {number} max */
  const newest = (entries, max) => [...entries].map(([, p]) => p).slice(-max);

  return {
    /** @param {unknown} p  May the renderer open / read this path by name? */
    isKnown(p) {
      const k = pathKey(p);
      return k !== null && readable.has(k);
    },
    /** @param {unknown} p  May the renderer save over / back up this path by name? */
    isWritable(p) {
      const k = pathKey(p);
      return k !== null && writable.has(k);
    },
    /** Every readable path as it was given (the read-image rule looks next to them). */
    paths() {
      return readable.values();
    },
    /**
     * A file the user chose in one of our dialogs, or saved to: readable and writable.
     * @param {unknown} p
     */
    grant(p) {
      return add(p, true, true);
    },
    /**
     * A file named by file content (a project's entries): readable; write access it already has
     * from a dialog is kept.
     * @param {unknown} p
     */
    grantRead(p) {
      return add(p, false, true);
    },
    /**
     * Register what an opened project file lists. Relative entries resolve against the project
     * folder like src/app/paths.ts resolveFromFile (backslashes written on Windows are separators
     * here too); the checks below apply to the resolved absolute path. Drawings (.dxf / .dwg)
     * become readable and writable - inside the project's folder always, elsewhere only when the
     * user chose the project (`userChosen`; outside the folder they are readable only otherwise);
     * the catalog file (.json) is readable only; other file types, stream names, device paths and
     * network paths on another server than the project are ignored.
     * @param {string} projectFile
     * @param {any} project  the parsed project JSON
     * @param {{ userChosen?: boolean }} [opts]  userChosen: opened through a dialog, an OS
     *   hand-over or Recent Documents (not only by name)
     * @returns {{ writable: string[], readOnly: string[], ignored: string[] }}
     */
    registerProject(projectFile, project, opts = {}) {
      /** @type {{ writable: string[], readOnly: string[], ignored: string[] }} */
      const out = { writable: [], readOnly: [], ignored: [] };
      const dir = path.dirname(projectFile);
      const projectHost = networkHost(projectFile);
      const anywhere = !!(opts && opts.userChosen === true);
      /** @param {unknown} f */
      const entry = (f) => {
        if (typeof f !== 'string' || !f || f.length > MAX_PATH || f.includes('\0')) return null;
        const p = process.platform === 'win32' ? f : f.replace(/\\/g, '/');
        const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(dir, p);
        // As written (\\server\share\... and //server/share/... on every system), else as resolved (a
        // relative entry of a project on a share is on that server).
        const written = networkHost(f);
        const host = written === null ? networkHost(abs) : written;
        if ((host !== null && (host === '' || host !== projectHost)) || streamName(abs)) {
          out.ignored.push(f);
          return null;
        }
        return abs;
      };
      const drawings = project && Array.isArray(project.drawings) ? project.drawings : [];
      for (const d of drawings) {
        const p = entry(d && d.file);
        if (!p) continue;
        if (!DRAWING_RE.test(p)) out.ignored.push(p);
        else if (anywhere || isInside(dir, p)) {
          if (add(p, true, true)) out.writable.push(p);
        } else if (add(p, false, true)) out.readOnly.push(p);
      }
      const catalog = entry(project && project.settings && project.settings.catalogFile);
      if (catalog) {
        if (!/\.json$/i.test(catalog)) out.ignored.push(catalog);
        else if (add(catalog, false, true)) out.readOnly.push(catalog);
      }
      return out;
    },
    /** The content of recent.json. */
    serialize() {
      const w = [...readable].filter(([k]) => writable.has(k));
      const r = [...readable].filter(([k]) => !writable.has(k));
      return JSON.stringify({ version: 2, writable: newest(w, MAX_WRITABLE), readOnly: newest(r, MAX_READ_ONLY) });
    },
    /**
     * Restore the lists from recent.json. The plain array written by 0.4 and earlier made every
     * remembered path writable, file content included; from it only drawings and
     * *.jcadproj.json project files stay writable, anything else becomes readable only.
     * @param {string} text
     */
    restore(text) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      if (Array.isArray(parsed)) {
        for (const p of parsed) if (typeof p === 'string') add(p, DRAWING_RE.test(p) || /\.jcadproj\.json$/i.test(p), false);
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      if (Array.isArray(parsed.readOnly)) for (const p of parsed.readOnly) if (typeof p === 'string') add(p, false, false);
      if (Array.isArray(parsed.writable)) for (const p of parsed.writable) if (typeof p === 'string') add(p, true, false);
    },
  };
}

module.exports = { createPathRegistry, pathKey, networkHost, isInside, streamName };
