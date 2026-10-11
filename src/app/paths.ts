/**
 * One place for file path handling in the renderer. Drawings, projects, recent files and
 * file tabs are identified by their normalised full path (never by file name alone):
 *
 *  - separators: a Windows-style path (drive letter, UNC share, or the app runs on Windows)
 *    uses backslashes; a POSIX path keeps forward slashes;
 *  - "." and ".." segments are resolved and repeated separators collapsed;
 *  - Unicode NFC (macOS hands out decomposed names, typed names are composed);
 *  - comparison is case-insensitive for Windows paths and case-sensitive elsewhere;
 *  - project-relative entries resolve against the folder of the project file, and are
 *    stored with forward slashes so a project opens on any system.
 *
 * Pure string functions (no Node `path`), so the sandboxed renderer and the tests share them.
 */

let platformOverride: string | null = null;

/** Platform the paths come from: the desktop bridge's process.platform, else the browser's guess. */
export function pathPlatform(): string {
  if (platformOverride) return platformOverride;
  const g = globalThis as { window?: { jcad?: { platform?: string } }; navigator?: { platform?: string } };
  const p = g.window?.jcad?.platform;
  if (typeof p === 'string' && p) return p;
  const nav = g.navigator?.platform ?? '';
  return /^win/i.test(nav) ? 'win32' : 'posix';
}

/** Tests (and nothing else) pin the platform; null goes back to detection. */
export function setPathPlatform(p: string | null): void {
  platformOverride = p;
}

const DRIVE = /^[a-zA-Z]:(?:[\\/]|$)/;

/** A path in Windows form: drive letter, UNC share, or any non-POSIX-rooted path while running on Windows. */
export function isWindowsPath(p: string): boolean {
  if (DRIVE.test(p) || /^\\\\/.test(p)) return true;
  if (pathPlatform() === 'win32') return !p.startsWith('/') || p.startsWith('//') || p.includes('\\');
  return false;
}

/** Absolute: "/x", "C:\x", "C:/x", "\\server\share\x" (a bare "C:" or "dir\x" is not absolute). */
export function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p) || p.startsWith('/');
}

interface Parsed {
  /** "", "/", "C:\" or "\\server\share\" (Windows roots end with a backslash). */
  root: string;
  segments: string[];
  windows: boolean;
}

function parse(input: string): Parsed {
  const p = input.normalize('NFC');
  const windows = isWindowsPath(p);
  let rest = p;
  let root = '';
  if (windows) {
    rest = rest.replace(/\//g, '\\');
    const unc = /^\\\\([^\\]+)\\+([^\\]+)/.exec(rest);
    const drive = /^([a-zA-Z]):(\\|$)/.exec(rest);
    if (unc) {
      root = `\\\\${unc[1]}\\${unc[2]}\\`;
      rest = rest.slice(unc[0].length);
    } else if (drive) {
      root = `${drive[1]!.toUpperCase()}:\\`;
      rest = rest.slice(drive[0].length);
    } else if (rest.startsWith('\\')) {
      root = '\\';
      rest = rest.replace(/^\\+/, '');
    }
  } else if (rest.startsWith('/')) {
    root = '/';
    rest = rest.replace(/^\/+/, '');
  }
  const sep = windows ? /\\+/ : /\/+/;
  const segments: string[] = [];
  for (const s of rest.split(sep)) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (segments.length && segments[segments.length - 1] !== '..') segments.pop();
      else if (!root) segments.push('..'); // a relative path may climb; a rooted one stops at the root
      continue;
    }
    segments.push(s);
  }
  return { root, segments, windows };
}

function format(p: Parsed): string {
  const body = p.segments.join(p.windows ? '\\' : '/');
  if (!p.root) return body || '.';
  return p.root + body;
}

/** Normalised form of a path: one separator style, no "." / ".." / repeated separators, NFC. */
export function normalizePath(p: string): string {
  if (!p) return p;
  return format(parse(p));
}

/** Identity key: the normalised path, lower-cased for Windows paths. */
export function pathKey(p: string): string {
  const n = normalizePath(p);
  return isWindowsPath(n) ? n.toLowerCase() : n;
}

/** Do two paths name the same file? (null / empty never matches.) */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return pathKey(a) === pathKey(b);
}

/** Last path component ("a.dxf" for "C:\x\a.dxf" and "/x/a.dxf"). */
export function fileBaseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/** Folder of a file path, normalised ("" when the path has no folder part). */
export function dirName(p: string): string {
  const parsed = parse(p);
  if (parsed.segments.length === 0) return parsed.root;
  parsed.segments.pop();
  if (!parsed.root && parsed.segments.length === 0) return '';
  return format(parsed);
}

/**
 * Resolve `file` against folder `dir`. Absolute files are only normalised. Relative entries
 * written on the other system (backslashes in a POSIX project, or the reverse) still work.
 */
export function resolvePath(dir: string, file: string): string {
  if (isAbsolutePath(file) || !dir) return normalizePath(file);
  const base = parse(dir);
  const rel = file.replace(/[\\/]+/g, base.windows ? '\\' : '/');
  return normalizePath(format(base) + (base.windows ? '\\' : '/') + rel);
}

/** Resolve a project-relative path against the folder of the project file. */
export function resolveFromFile(baseFile: string | null | undefined, file: string): string {
  if (!baseFile) return isAbsolutePath(file) ? normalizePath(file) : file;
  return resolvePath(dirName(baseFile), file);
}

/**
 * `target` relative to folder `dir`, with forward slashes ("dwg/a.dxf", "../other/a.dxf").
 * Returns the normalised absolute target when there is no sensible relative form: another
 * drive or share, or the two only share the filesystem root.
 */
export function relativePath(dir: string, target: string): string {
  const d = parse(dir);
  const t = parse(target);
  if (!d.root || !t.root || d.windows !== t.windows) return normalizePath(target);
  const fold = (s: string) => (d.windows ? s.toLowerCase() : s);
  if (fold(d.root) !== fold(t.root)) return normalizePath(target);
  let i = 0;
  while (i < d.segments.length && i < t.segments.length && fold(d.segments[i]!) === fold(t.segments[i]!)) i += 1;
  if (i === 0 && d.segments.length > 0) return normalizePath(target);
  const up = d.segments.slice(i).map(() => '..');
  const rel = [...up, ...t.segments.slice(i)].join('/');
  return rel || '.';
}

/**
 * A project entry re-expressed for a project file that moves from `oldProjectFile` to
 * `newProjectFile`, so it still names the same file. Entries that were absolute stay absolute
 * unless they now sit inside the new project folder.
 */
export function rebaseProjectEntry(file: string, oldProjectFile: string | null | undefined, newProjectFile: string): string {
  const wasAbsolute = isAbsolutePath(file);
  if (!wasAbsolute && !oldProjectFile) return file; // nothing to resolve against: leave it
  const abs = wasAbsolute ? normalizePath(file) : resolveFromFile(oldProjectFile, file);
  const rel = relativePath(dirName(newProjectFile), abs);
  if (isAbsolutePath(rel)) return rel;
  if (wasAbsolute && rel.startsWith('..')) return abs;
  return rel;
}

/** Short names for a list of paths: the file name, plus parent folders only where names collide. */
export function shortNames(paths: ReadonlyArray<string | null>, fallback: ReadonlyArray<string> = []): string[] {
  const names = paths.map((p, i) => (p ? fileBaseName(p) : (fallback[i] ?? '')));
  const parts = paths.map((p) => (p ? normalizePath(p).split(/[\\/]/).filter(Boolean) : []));
  const out = [...names];
  for (let depth = 1; depth < 8; depth += 1) {
    const groups = new Map<string, number[]>();
    out.forEach((n, i) => {
      if (!paths[i]) return;
      const k = n.toLowerCase();
      groups.set(k, [...(groups.get(k) ?? []), i]);
    });
    let clash = false;
    for (const idx of groups.values()) {
      if (idx.length < 2) continue;
      if (new Set(idx.map((i) => pathKey(paths[i]!))).size < 2) continue; // the same file twice
      clash = true;
      for (const i of idx) {
        const segs = parts[i]!;
        const folder = segs.slice(Math.max(0, segs.length - 1 - depth), segs.length - 1).join('/');
        out[i] = folder ? `${names[i]} (${folder})` : names[i]!;
      }
    }
    if (!clash) break;
  }
  return out;
}
