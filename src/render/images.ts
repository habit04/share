/**
 * Bitmaps for IMAGE entities in the desktop app. The IMAGEDEF path of a drawing is
 * absolute or relative to the drawing's folder; the Electron main process reads the
 * file (`read-image`, returns a data URL) and the renderer decodes it into an
 * ImageBitmap. The browser build has no file access: images stay a frame with
 * their file name (renderSettings.imageLoader is left unset there).
 */
import type { ImageLoader } from './draw';

/** An absolute POSIX, Windows drive (C:\ or C:/) or UNC (\\server\share) path. */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/** Folder part of a path (either separator), without the trailing separator. */
function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : i === 0 ? p.slice(0, 1) : '';
}

/** File name of a path (either separator). */
function baseOf(p: string): string {
  return p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
}

/** Join a relative path onto a folder, resolving `.` and `..`, in the folder's separator style. */
function joinPath(dir: string, rel: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  const parts = dir.split(/[\\/]/);
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 1) parts.pop();
    } else parts.push(seg);
  }
  const joined = parts.join(sep);
  return joined === '' ? sep : joined;
}

/**
 * The files to try for an image path, most likely first: the path itself when absolute,
 * else resolved against the drawing's folder; then the bare file name next to the drawing
 * (AutoCAD also looks there when a saved absolute path no longer exists). Empty when the
 * path is relative and the drawing was never saved.
 */
export function imageCandidates(imagePath: string, drawingPath: string | null | undefined): string[] {
  const p = imagePath.trim();
  if (!p) return [];
  const dir = drawingPath ? dirOf(drawingPath) : '';
  const out: string[] = [];
  if (isAbsolutePath(p)) out.push(p);
  else if (dir) out.push(joinPath(dir, p));
  if (dir) {
    const beside = joinPath(dir, baseOf(p));
    if (!out.includes(beside)) out.push(beside);
  }
  return out;
}

/** Decode a `data:<type>;base64,...` URL into a Blob (no fetch: the renderer's CSP blocks data: connections). */
export function dataUrlToBlob(url: string): Blob | null {
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
  if (!m) return null;
  const bin = atob(m[2]!);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] });
}

export interface ImageLoaderDeps {
  /** Electron bridge: the file as a data URL, null when it is missing or not readable. */
  readImage(path: string): Promise<string | null>;
  /** The drawing's own path (relative image paths resolve against its folder). */
  drawingPath(): string | null | undefined;
  /** Bitmap decoder (createImageBitmap in the renderer). */
  decode?(blob: Blob): Promise<ImageBitmap>;
}

/**
 * An ImageLoader over the desktop bridge. Bitmaps are cached by resolved file path, so a
 * relative name opened from two drawing folders loads two files, and repeated frames reuse
 * the same bitmap; a file that cannot be read resolves to null (the frame and name stay).
 */
export function bridgeImageLoader(deps: ImageLoaderDeps): ImageLoader & { clear(): void } {
  const cache = new Map<string, Promise<ImageBitmap | null>>();
  const decode = deps.decode ?? ((b: Blob) => createImageBitmap(b));
  const loadFile = (file: string): Promise<ImageBitmap | null> => {
    let hit = cache.get(file);
    if (!hit) {
      hit = deps
        .readImage(file)
        .then((url) => {
          const blob = url ? dataUrlToBlob(url) : null;
          return blob ? decode(blob) : null;
        })
        .catch(() => null);
      cache.set(file, hit);
    }
    return hit;
  };
  const loader = async (imagePath: string): Promise<ImageBitmap | null> => {
    for (const file of imageCandidates(imagePath, deps.drawingPath())) {
      const bmp = await loadFile(file);
      if (bmp) return bmp;
    }
    return null;
  };
  return Object.assign(loader, { clear: () => cache.clear() });
}
