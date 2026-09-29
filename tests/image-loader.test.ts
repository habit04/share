import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { imageCandidates, isAbsolutePath, dataUrlToBlob, bridgeImageLoader } from '../src/render/images';

// IMAGE bitmaps in the desktop app: path resolution against the drawing folder, the
// data-URL bridge (electron/main.cjs `read-image`) and the per-path bitmap cache.

describe('image path resolution', () => {
  it('knows absolute POSIX, drive and UNC paths', () => {
    expect(['/img/a.png', 'C:\\img\\a.png', 'c:/img/a.png', '\\\\srv\\share\\a.png'].map(isAbsolutePath)).toEqual([true, true, true, true]);
    expect(['a.png', '.\\img\\a.png', '../a.png'].map(isAbsolutePath)).toEqual([false, false, false]);
  });
  it('resolves relative names against the drawing folder and falls back to the file next to the drawing', () => {
    expect(imageCandidates('logo.png', '/home/u/proj/sheet1.dxf')).toEqual(['/home/u/proj/logo.png']);
    expect(imageCandidates('.\\img\\logo.png', '/home/u/proj/sheet1.dxf')).toEqual(['/home/u/proj/img/logo.png', '/home/u/proj/logo.png']);
    expect(imageCandidates('..\\shared\\logo.png', 'C:\\proj\\dwg\\sheet1.dxf')).toEqual(['C:\\proj\\shared\\logo.png', 'C:\\proj\\dwg\\logo.png']);
    expect(imageCandidates('C:\\old\\place\\logo.png', '/home/u/proj/sheet1.dxf')).toEqual(['C:\\old\\place\\logo.png', '/home/u/proj/logo.png']);
    // Unsaved drawing: only absolute paths can be read.
    expect(imageCandidates('logo.png', null)).toEqual([]);
    expect(imageCandidates('/img/logo.png', null)).toEqual(['/img/logo.png']);
    expect(imageCandidates('  ', '/a/b.dxf')).toEqual([]);
  });
});

describe('bridge image loader', () => {
  const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64')}`;

  it('decodes a data URL into a typed blob', async () => {
    const blob = dataUrlToBlob(png)!;
    expect(blob.type).toBe('image/png');
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    expect(dataUrlToBlob('not a data url')).toBeNull();
  });

  it('reads through the bridge, tries the candidates in order and caches by resolved path', async () => {
    const reads: string[] = [];
    let drawing = '/proj/a/sheet.dxf';
    const fakeBitmap = (tag: string) => ({ tag }) as unknown as ImageBitmap;
    const loader = bridgeImageLoader({
      readImage: async (file) => {
        reads.push(file);
        return file.startsWith('/proj/') ? png : null;
      },
      drawingPath: () => drawing,
      decode: async (blob) => fakeBitmap(`${blob.type}:${blob.size}`),
    });
    const first = await loader('logo.png');
    expect(first).toEqual({ tag: 'image/png:7' });
    expect(await loader('logo.png')).toBe(first);
    expect(reads).toEqual(['/proj/a/logo.png']);
    // A missing absolute path falls back to the file beside the drawing.
    expect(await loader('/gone/logo2.png')).not.toBeNull();
    expect(reads.slice(1)).toEqual(['/gone/logo2.png', '/proj/a/logo2.png']);
    // Another drawing folder: the same relative name is another file.
    drawing = '/proj/b/sheet.dxf';
    const other = await loader('logo.png');
    expect(other).not.toBe(first);
    expect(reads[reads.length - 1]).toBe('/proj/b/logo.png');
    // Unreadable everywhere: null, so the frame and file name stay.
    drawing = '/elsewhere/x.dxf';
    expect(await loader('logo.png')).toBeNull();
    loader.clear();
    drawing = '/proj/a/sheet.dxf';
    await loader('logo.png');
    expect(reads.filter((r) => r === '/proj/a/logo.png')).toHaveLength(2);
  });

  it('turns bridge and decoder failures into null', async () => {
    const loader = bridgeImageLoader({ readImage: async () => { throw new Error('Invalid path'); }, drawingPath: () => '/p/x.dxf' });
    expect(await loader('a.png')).toBeNull();
    const bad = bridgeImageLoader({ readImage: async () => png, drawingPath: () => '/p/x.dxf', decode: async () => { throw new Error('corrupt'); } });
    expect(await bad('a.png')).toBeNull();
  });
});

describe('read-image IPC', () => {
  const main = readFileSync('electron/main.cjs', 'utf8');
  const preload = readFileSync('electron/preload.cjs', 'utf8');
  it('is exposed through the preload bridge', () => {
    expect(preload).toContain("readImage: (file) => ipcRenderer.invoke('read-image', file)");
  });
  it('accepts absolute image paths only, up to 50 MB, and returns a data URL', () => {
    const section = main.slice(main.indexOf("ipcMain.handle('read-image'"), main.indexOf('end of read-image'));
    expect(section).toContain('path.isAbsolute(file)');
    expect(section).toContain('IMAGE_TYPES[path.extname(file).toLowerCase()]');
    expect(section).toContain('stat.size > MAX_IMAGE_BYTES');
    expect(section).toContain('data:${type};base64,');
    expect(main).toContain('const MAX_IMAGE_BYTES = 50 * 1024 * 1024;');
    for (const ext of ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']) expect(main).toContain(`'${ext}': 'image/`);
  });
});
