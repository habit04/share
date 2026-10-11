/**
 * src/app/paths.ts: one normalisation for every place that identifies a drawing, and
 * project-relative paths that survive moving the project file (src/app/project.ts).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { normalizePath, pathKey, samePath, dirName, resolveFromFile, relativePath, rebaseProjectEntry, shortNames, isAbsolutePath, setPathPlatform } from '../src/app/paths';
import { parseProject, serializeProject, rebaseProject, resolveDrawingPath, resolveProjectPath, projectDrawingIndex, projectEntryFor, type Project } from '../src/app/project';
import { pushRecent } from '../src/app/settings';

afterEach(() => setPathPlatform(null));

describe('path normalisation', () => {
  it('normalises Windows paths: separators, dot segments, drive letter, UNC shares', () => {
    expect(normalizePath('c:/Jobs//Line1/./dwg/../A.dxf')).toBe('C:\\Jobs\\Line1\\A.dxf');
    expect(normalizePath('C:\\Jobs\\Line1\\..\\..\\..\\A.dxf')).toBe('C:\\A.dxf'); // never above the root
    expect(normalizePath('\\\\server\\share\\proj\\..\\a.dxf')).toBe('\\\\server\\share\\a.dxf');
    expect(normalizePath('//server/share/proj/a.dxf')).toBe('/server/share/proj/a.dxf'); // POSIX, like Node's path.resolve in main.cjs
  });
  it('normalises POSIX paths and keeps their case; Unicode is compared in NFC', () => {
    expect(normalizePath('/home/u//proj/./dwg/../A.dxf')).toBe('/home/u/proj/A.dxf');
    expect(samePath('/home/u/A.dxf', '/home/u/a.dxf')).toBe(false);
    expect(samePath('/home/u/proj/../A.dxf', '/home/u/A.dxf')).toBe(true);
    expect(samePath('/p/Jose\u0301.dxf', '/p/Jos\u00e9.dxf')).toBe(true);
    expect(samePath(null, null)).toBe(false);
  });
  it('compares Windows paths case-insensitively, also when the app runs elsewhere', () => {
    expect(samePath('C:\\Jobs\\Line1\\A.DXF', 'c:/jobs/line1/a.dxf')).toBe(true);
    expect(samePath('C:\\Jobs\\Line1\\a.dxf', 'C:\\Jobs\\Line2\\a.dxf')).toBe(false);
    expect(pathKey('C:\\Jobs\\A.dxf')).toBe(pathKey('c:\\JOBS\\a.DXF'));
  });
  it('on Windows, relative and forward-slash paths are Windows paths too', () => {
    setPathPlatform('win32');
    expect(normalizePath('dwg/sub/../A.dxf')).toBe('dwg\\A.dxf');
    expect(samePath('dwg\\A.dxf', 'DWG/a.dxf')).toBe(true);
    setPathPlatform('linux');
    expect(samePath('dwg/A.dxf', 'dwg/a.dxf')).toBe(false);
  });
  it('resolves project-relative paths against the project file folder', () => {
    expect(dirName('/home/u/proj/p.jcadproj.json')).toBe('/home/u/proj');
    expect(resolveFromFile('/home/u/proj/p.jcadproj.json', 'dwg/a.dxf')).toBe('/home/u/proj/dwg/a.dxf');
    expect(resolveFromFile('/home/u/proj/p.jcadproj.json', '../shared/./b.dxf')).toBe('/home/u/shared/b.dxf');
    // A project written on Windows (backslashes) opened on another system.
    expect(resolveFromFile('/home/u/proj/p.jcadproj.json', 'dwg\\a.dxf')).toBe('/home/u/proj/dwg/a.dxf');
    expect(resolveFromFile('C:\\Jobs\\P\\p.jcadproj.json', 'dwg/a.dxf')).toBe('C:\\Jobs\\P\\dwg\\a.dxf');
    expect(resolveFromFile('C:\\Jobs\\P\\p.jcadproj.json', 'D:\\Lib\\x.dxf')).toBe('D:\\Lib\\x.dxf');
    expect(resolveFromFile(undefined, 'rel.dxf')).toBe('rel.dxf');
    expect(isAbsolutePath('C:/x.dxf') && isAbsolutePath('/x') && !isAbsolutePath('x/y') && !isAbsolutePath('C:x')).toBe(true);
  });
  it('makes relative paths with forward slashes, or keeps them absolute across drives / roots', () => {
    expect(relativePath('/home/u/proj', '/home/u/proj/dwg/a.dxf')).toBe('dwg/a.dxf');
    expect(relativePath('/home/u/new', '/home/u/proj/dwg/a.dxf')).toBe('../proj/dwg/a.dxf');
    expect(relativePath('C:\\Jobs\\New', 'c:\\jobs\\P\\a.dxf')).toBe('../P/a.dxf');
    expect(relativePath('D:\\Other', 'C:\\Jobs\\P\\a.dxf')).toBe('C:\\Jobs\\P\\a.dxf');
    expect(relativePath('/mnt/x', '/home/u/a.dxf')).toBe('/home/u/a.dxf'); // only the root in common
  });
  it('rebases project entries when the project file moves', () => {
    expect(rebaseProjectEntry('dwg/a.dxf', '/home/u/proj/p.jcadproj.json', '/home/u/proj/sub/p.jcadproj.json')).toBe('../dwg/a.dxf');
    expect(rebaseProjectEntry('/abs/lib/x.dxf', '/home/u/proj/p.json', '/home/u/new/p.json')).toBe('/abs/lib/x.dxf');
    expect(rebaseProjectEntry('/home/u/new/in.dxf', '/home/u/proj/p.json', '/home/u/new/p.json')).toBe('in.dxf');
    expect(rebaseProjectEntry('rel.dxf', undefined, '/home/u/new/p.json')).toBe('rel.dxf');
  });
  it('short names add the folder only where file names collide', () => {
    expect(shortNames(['/p/line1/a.dxf', '/p/line2/a.dxf', '/p/line1/b.dxf'])).toEqual(['a.dxf (line1)', 'a.dxf (line2)', 'b.dxf']);
    expect(shortNames(['/x/m/a.dxf', '/y/m/a.dxf'])).toEqual(['a.dxf (x/m)', 'a.dxf (y/m)']);
    expect(shortNames(['C:\\A\\a.dxf', 'c:\\a\\A.DXF'])).toEqual(['a.dxf', 'A.DXF']); // same file twice
  });
  it('the recent file list keeps one entry per file', () => {
    let l = pushRecent([], 'C:\\Jobs\\A.dxf');
    l = pushRecent(l, '/p/x.dxf');
    l = pushRecent(l, 'c:/jobs/a.DXF');
    expect(l).toEqual(['c:/jobs/a.DXF', '/p/x.dxf']);
    expect(pushRecent(l, '/p/X.dxf')).toHaveLength(3); // POSIX: another file
  });
});

describe('project paths', () => {
  const proj = (path: string, drawings: string[], catalog?: string): Project => ({ name: 'P', path, drawings: drawings.map((file) => ({ file })), settings: catalog ? { catalogFile: catalog } : undefined });

  it('identifies drawings by full path, case-insensitively for Windows project paths', () => {
    const p = proj('C:\\Jobs\\P\\p.jcadproj.json', ['dwg\\A.dxf', 'dwg/B.dxf', 'D:\\Lib\\C.dxf']);
    expect(resolveDrawingPath(p, p.drawings[0]!)).toBe('C:\\Jobs\\P\\dwg\\A.dxf');
    expect(projectDrawingIndex(p, 'c:/jobs/p/DWG/a.dxf')).toBe(0);
    expect(projectDrawingIndex(p, 'C:\\Jobs\\P\\dwg\\sub\\..\\B.dxf')).toBe(1);
    expect(projectDrawingIndex(p, 'd:\\lib\\c.DXF')).toBe(2);
    expect(projectDrawingIndex(p, 'C:\\Other\\A.dxf')).toBe(-1);
  });
  it('drawings with the same file name in different folders are different drawings', () => {
    const p = proj('/jobs/p/p.jcadproj.json', ['line1/a.dxf', 'line2/a.dxf']);
    expect(projectDrawingIndex(p, '/jobs/p/line2/a.dxf')).toBe(1);
    expect(projectDrawingIndex(p, '/jobs/p/line1/a.dxf')).toBe(0);
    expect(projectDrawingIndex(p, '/jobs/p/a.dxf')).toBe(-1);
    expect(projectDrawingIndex(p, '/jobs/p/LINE1/a.dxf')).toBe(-1); // POSIX is case-sensitive
  });
  it('new entries are relative below the project folder, absolute elsewhere', () => {
    const p = proj('/jobs/p/p.jcadproj.json', []);
    expect(projectEntryFor(p, '/jobs/p/dwg/x.dxf')).toBe('dwg/x.dxf');
    expect(projectEntryFor(p, '/elsewhere/y.dxf')).toBe('/elsewhere/y.dxf');
    expect(projectEntryFor({ name: 'x', drawings: [] }, '/a/./b.dxf')).toBe('/a/b.dxf');
  });
  it('Save As into another folder keeps drawing and catalog paths pointing at the same files', () => {
    const p = proj('/jobs/p/p.jcadproj.json', ['dwg/a.dxf', '../shared/b.dxf', '/abs/c.dxf'], 'parts.json');
    const before = p.drawings.map((d) => resolveDrawingPath(p, d));
    for (const dest of ['/jobs/archive/2026/p.jcadproj.json', '/jobs/p/sub/p.jcadproj.json', '/other/x.jcadproj.json']) {
      const moved = parseProject(serializeProject(rebaseProject(p, dest)), dest);
      expect(moved.drawings.map((d) => resolveDrawingPath(moved, d))).toEqual(before);
      expect(resolveProjectPath(moved, moved.settings!.catalogFile!)).toBe('/jobs/p/parts.json');
    }
    const archived = rebaseProject(p, '/jobs/archive/2026/p.jcadproj.json');
    expect(archived.drawings.map((d) => d.file)).toEqual(['../../p/dwg/a.dxf', '../../shared/b.dxf', '/abs/c.dxf']);
    expect(rebaseProject(p, '/jobs/p/p.jcadproj.json').drawings).toEqual(p.drawings); // same file: unchanged
  });
  it('Save As of a Windows project to another drive writes absolute paths', () => {
    const p = proj('C:\\Jobs\\P\\p.jcadproj.json', ['dwg\\A.dxf'], 'parts.json');
    const moved = rebaseProject(p, 'D:\\Backup\\p.jcadproj.json');
    expect(moved.drawings[0]!.file).toBe('C:\\Jobs\\P\\dwg\\A.dxf');
    expect(moved.settings!.catalogFile).toBe('C:\\Jobs\\P\\parts.json');
    const sibling = rebaseProject(p, 'c:\\jobs\\Q\\p.jcadproj.json');
    expect(sibling.drawings[0]!.file).toBe('../P/dwg/A.dxf');
    expect(resolveDrawingPath(sibling, sibling.drawings[0]!)).toBe('C:\\jobs\\P\\dwg\\A.dxf');
    expect(samePath(resolveDrawingPath(sibling, sibling.drawings[0]!), 'C:\\Jobs\\P\\dwg\\A.dxf')).toBe(true);
  });
});
