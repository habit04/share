/**
 * Property-based fuzzing of src/app/paths.ts (and the main process twin of pathKey in
 * electron/main.cjs): random Windows / POSIX / UNC paths with mixed separators, "." / "..",
 * NFC / NFD, case variants and trailing separators. Seeds are logged; replay with FUZZ_SEED.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import nodePath from 'node:path';
import { normalizePath, pathKey, samePath, dirName, fileBaseName, resolvePath, relativePath, rebaseProjectEntry, shortNames, isAbsolutePath, isWindowsPath, setPathPlatform, climbsOut } from '../src/app/paths';
import { rebaseProject, resolveDrawingPath, resolveProjectPath, type Project } from '../src/app/project';
import { Rng, fuzzSync, check, fuzzTimeout } from './helpers/fuzz';

afterEach(() => setPathPlatform(null));

// ------------------------------------------------------------------ generators
const NAMES = ['..old', 'a', 'A', 'b', 'dwg', 'DWG', 'Line1', 'line1', 'José', 'José', 'Ärger', 'Ärger', 'my file', 'x.y', '...', 'p1', 'proj', 'Proj', 'sub', 'é', 'é', 'ß', 'İ', 'a-b_c'];
const FILES = ['a.dxf', 'A.DXF', 'b.dxf', 'José.dxf', 'José.dxf', 'sheet 1.dxf', 'x.dxf', 'X.dxf', 'é.dxf', 'é.dxf'];

type Style = 'posix' | 'drive' | 'unc';

/** A clean segment list (no "." / ".."): the identity of a file. */
function genSegments(rng: Rng, min = 0, max = 5): string[] {
  const n = rng.int(min, max);
  return Array.from({ length: n }, () => rng.pick(NAMES));
}
/** Segments of a POSIX path on a POSIX system, where a backslash is an ordinary file name character. */
function posixSegments(rng: Rng, min = 0, max = 5): string[] {
  return genSegments(rng, min, max).map((s) => (rng.bool(0.05) ? `${s}\\${rng.pick(NAMES)}` : s));
}

/** Same location through dot segments / separators; only POSIX treats Unicode NFD as an alias. */
function spell(rng: Rng, segs: string[], sepChoices: string[], unicodeAliases = true): string {
  const out: string[] = [];
  for (const s of segs) {
    if (rng.bool(0.15)) out.push('.');
    if (rng.bool(0.15)) out.push(rng.pick(NAMES), '..');
    out.push(unicodeAliases && rng.bool(0.2) ? s.normalize('NFD') : s);
  }
  if (rng.bool(0.1)) out.push('.');
  let text = '';
  out.forEach((s, i) => {
    text += (i ? rng.pick(sepChoices) : '') + s;
  });
  if (out.length && rng.bool(0.2)) text += rng.pick(sepChoices);
  return text;
}

interface GenPath {
  style: Style;
  /** Root identity (drive letter, server+share) for building variants. */
  root: string;
  segs: string[];
  text: string;
}

/** Flip the case of some letters (only letters whose case mapping is one character both ways: not "ß" or "İ"). */
function caseVariant(rng: Rng, s: string): string {
  const flip = (c: string) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
  return [...s].map((c) => (rng.bool(0.3) && flip(flip(c)) === c && flip(c).length === 1 ? flip(c) : c)).join('');
}

function rootText(rng: Rng, style: Style, root: string, win32: boolean): string {
  // On Windows "//x" starts a UNC share, so POSIX roots there are a single "/".
  if (style === 'posix') return win32 ? '/' : rng.pick(['/', '//', '///']);
  if (style === 'drive') return `${rng.bool() ? root.toUpperCase() : root.toLowerCase()}:${rng.pick(['\\', '/', '\\\\'])}`;
  const [server, share] = root.split('|') as [string, string];
  const lead = win32 && rng.bool(0.3) ? '//' : '\\\\';
  return `${lead}${server}${rng.pick(['\\', '\\\\', '/'])}${share}${rng.pick(['\\', '/'])}`;
}

function genPath(rng: Rng, win32: boolean, style?: Style, root?: string, segs?: string[]): GenPath {
  const st: Style = style ?? rng.pick(['posix', 'drive', 'unc'] as const);
  const r = root ?? (st === 'drive' ? rng.pick(['C', 'D', 'c']) : st === 'unc' ? `${rng.pick(['srv', 'Srv', 'nas'])}|${rng.pick(['share', 'Share', 'proj'])}` : '/');
  const sg = segs ?? (st === 'posix' && !win32 ? posixSegments(rng) : genSegments(rng));
  const seps = st === 'posix' ? ['/', '//'] : ['\\', '/', '\\\\', '/\\'];
  return { style: st, root: r, segs: sg, text: rootText(rng, st, r, win32) + spell(rng, sg, seps, st === 'posix') };
}

/** Another spelling of exactly the same file (case-changed only where the path is a Windows path). */
function sameFile(rng: Rng, p: GenPath, win32: boolean): string {
  const segs = p.style === 'posix' ? p.segs : p.segs.map((s) => caseVariant(rng, s));
  const root = p.style === 'posix' ? p.root : caseVariant(rng, p.root);
  return genPath(rng, win32, p.style, root, segs).text;
}

const PLATFORMS = ['linux', 'win32'] as const;

// ------------------------------------------------------------------ main process twin
/**
 * The main process's pathKey (electron/path-registry.cjs, used by electron/main.cjs), evaluated from
 * its own source text with an injected `path` and `process.platform`, so this test pins the real
 * function (it fails when the main process changes it).
 */
function mainPathKey(platform: 'linux' | 'win32'): (p: string) => string | null {
  const src = readFileSync(new URL('../electron/path-registry.cjs', import.meta.url), 'utf8');
  const m = /function pathKey\(p\) \{[\s\S]*?\n\}/.exec(src);
  if (!m) throw new Error('pathKey not found in electron/path-registry.cjs');
  const make = new Function('path', 'process', `${m[0]}\nreturn pathKey;`) as (path: unknown, process: unknown) => (p: string) => string | null;
  return make(platform === 'win32' ? nodePath.win32 : nodePath.posix, { platform });
}

// ------------------------------------------------------------------ properties
describe('fuzz: path normalisation properties', () => {
  for (const platform of PLATFORMS) {
    const win32 = platform === 'win32';
    it(`normalisation is idempotent and keys are stable (${platform})`, () => {
      setPathPlatform(platform);
      const runs = fuzzSync(`paths/idempotent/${platform}`, 1500, (rng) => {
        const p = rng.bool(0.15) ? spell(rng, genSegments(rng, 1, 5), win32 ? ['\\', '/'] : ['/'], !win32) : genPath(rng, win32).text;
        const n = normalizePath(p);
        check(normalizePath(n) === n, () => `normalizePath not idempotent: ${JSON.stringify(p)} -> ${JSON.stringify(n)} -> ${JSON.stringify(normalizePath(n))}`);
        check(pathKey(n) === pathKey(p), () => `pathKey(normalizePath(p)) !== pathKey(p) for ${JSON.stringify(p)}`);
        check(pathKey(pathKey(p)) === pathKey(p), () => `pathKey not idempotent for ${JSON.stringify(p)}`);
        check(isAbsolutePath(n) === isAbsolutePath(p), () => `absoluteness changed by normalisation: ${JSON.stringify(p)} -> ${JSON.stringify(n)}`);
        if (!isWindowsPath(n)) check(n === n.normalize('NFC'), () => `not NFC: ${JSON.stringify(n)}`);
        check(!/[\\/]{2,}/.test(n.replace(/^\\\\/, '')), () => `repeated separators left in ${JSON.stringify(n)}`);
        const segs = n.replace(/^\\\\[^\\]+\\[^\\]+\\|^[A-Z]:\\|^[\\/]/, '').split(/[\\/]/);
        if (isAbsolutePath(n)) check(!segs.includes('.') && !segs.includes('..'), () => `dot segment left in absolute ${JSON.stringify(n)}`);
      });
      expect(runs).toBeGreaterThan(0);
    }, fuzzTimeout());

    it(`every spelling of one file is the same path; equality is an equivalence relation (${platform})`, () => {
      setPathPlatform(platform);
      fuzzSync(`paths/equivalence/${platform}`, 1000, (rng) => {
        const p = genPath(rng, win32);
        const a = sameFile(rng, p, win32);
        const b = sameFile(rng, p, win32);
        check(samePath(p.text, a) && samePath(a, p.text), () => `${JSON.stringify(p.text)} vs ${JSON.stringify(a)} should be the same file`);
        check(samePath(a, b), () => `${JSON.stringify(a)} vs ${JSON.stringify(b)} should be the same file`);
        check(samePath(a, a), () => `not reflexive: ${JSON.stringify(a)}`);
        // A different file: another last segment (or another folder) never matches.
        const other = genPath(rng, win32, p.style, p.root, [...p.segs, 'zz-other']);
        check(!samePath(p.text, other.text), () => `${JSON.stringify(p.text)} matched ${JSON.stringify(other.text)}`);
        // POSIX is case-sensitive: changing the case of a letter makes another file.
        if (p.style === 'posix' && p.segs.some((s) => s.toLowerCase() !== s.toUpperCase())) {
          const segs = p.segs.map((s) => s.toUpperCase() === s ? s.toLowerCase() : s.toUpperCase());
          const flipped = genPath(rng, win32, 'posix', '/', segs).text;
          const same = segs.every((s, i) => s.normalize('NFC') === p.segs[i]!.normalize('NFC'));
          check(samePath(p.text, flipped) === same, () => `POSIX case: ${JSON.stringify(p.text)} vs ${JSON.stringify(flipped)}`);
        }
        // transitivity through keys
        const c = sameFile(rng, p, win32);
        check(!(samePath(a, b) && samePath(b, c)) || samePath(a, c), 'not transitive');
      });
    }, fuzzTimeout());

    it(`relativePath then resolvePath round-trips (${platform})`, () => {
      setPathPlatform(platform);
      fuzzSync(`paths/relative-roundtrip/${platform}`, 1500, (rng) => {
        const style = rng.pick(['posix', 'drive', 'unc'] as const);
        // Shared prefix makes relative results likely.
        const segs = style === 'posix' && !win32 ? posixSegments : genSegments;
        const common = segs(rng, 0, 3);
        const d = genPath(rng, win32, style, undefined, [...common, ...segs(rng, 0, 3)]);
        const sameRoot = rng.bool(0.8);
        const t = genPath(rng, win32, sameRoot ? style : undefined, sameRoot ? d.root : undefined, [...common, ...segs(rng, 0, 3), rng.pick(FILES)]);
        const rel = relativePath(d.text, t.text);
        const back = resolvePath(d.text, rel);
        check(samePath(back, t.text), () => `relativePath(${JSON.stringify(d.text)}, ${JSON.stringify(t.text)}) = ${JSON.stringify(rel)} resolves to ${JSON.stringify(back)}`);
        if (!isAbsolutePath(rel)) check(!rel.includes('\\'), () => `relative path with backslashes: ${JSON.stringify(rel)}`);
      });
    }, fuzzTimeout());

    it(`dirName + file name rebuild the path (${platform})`, () => {
      setPathPlatform(platform);
      fuzzSync(`paths/dirname/${platform}`, 1000, (rng) => {
        const p = genPath(rng, win32, undefined, undefined, [...genSegments(rng, 0, 4), rng.pick(FILES)]);
        const n = normalizePath(p.text);
        const rebuilt = resolvePath(dirName(n), fileBaseName(n));
        check(samePath(rebuilt, p.text), () => `${JSON.stringify(p.text)}: dirName ${JSON.stringify(dirName(n))} + ${JSON.stringify(fileBaseName(n))} = ${JSON.stringify(rebuilt)}`);
      });
    }, fuzzTimeout());

    it(`project Save As to another folder and back keeps every reference (${platform})`, () => {
      setPathPlatform(platform);
      fuzzSync(`paths/rebase-roundtrip/${platform}`, 1000, (rng) => {
        const style = rng.pick(['posix', 'drive', 'unc'] as const);
        const root = style === 'drive' ? rng.pick(['C', 'D']) : style === 'unc' ? 'srv|share' : '/';
        const projDir = [...genSegments(rng, 0, 2), 'proj'];
        const oldFile = genPath(rng, win32, style, root, [...projDir, 'p.jcadproj.json']).text;
        const newDirStyle = rng.bool(0.85) ? style : rng.pick(['posix', 'drive', 'unc'] as const);
        const newRoot = newDirStyle === style && rng.bool(0.8) ? root : undefined;
        const newFile = genPath(rng, win32, newDirStyle, newRoot, [...genSegments(rng, 0, 3), rng.pick(['p.jcadproj.json', 'Q.jcadproj.json'])]).text;
        // Entries: below the project folder (relative), next to it ("../x"), and absolute elsewhere.
        const entries: string[] = [];
        for (let i = rng.int(1, 6); i > 0; i -= 1) {
          const kind = rng.pick(['inside', 'up', 'abs', 'abs-inside'] as const);
          const seps = win32 || style !== 'posix' ? ['/', '\\'] : ['/'];
          if (kind === 'inside') entries.push(spell(rng, [...genSegments(rng, 0, 2), rng.pick(FILES)], seps));
          else if (kind === 'up') entries.push(`..${rng.pick(seps)}${spell(rng, ['shared', rng.pick(FILES)], seps)}`);
          else if (kind === 'abs') entries.push(genPath(rng, win32, undefined, undefined, [...genSegments(rng, 1, 3), rng.pick(FILES)]).text);
          else entries.push(genPath(rng, win32, style, root, [...projDir, rng.pick(FILES)]).text);
        }
        const p: Project = { name: 'P', path: oldFile, drawings: entries.map((file) => ({ file })), settings: { catalogFile: entries[0] } };
        const want = p.drawings.map((d) => resolveDrawingPath(p, d));
        const moved = rebaseProject(p, newFile);
        const got = moved.drawings.map((d) => resolveDrawingPath(moved, d));
        got.forEach((g, i) => check(samePath(g, want[i]), () => `entry ${JSON.stringify(entries[i])} from ${JSON.stringify(oldFile)} to ${JSON.stringify(newFile)}: ${JSON.stringify(moved.drawings[i]!.file)} resolves to ${JSON.stringify(g)}, want ${JSON.stringify(want[i])}`));
        check(samePath(resolveProjectPath(moved, moved.settings!.catalogFile!), want[0]), 'catalog moved');
        // Absolute entries stay absolute unless they now sit inside the new project folder.
        moved.drawings.forEach((d, i) => {
          if (isAbsolutePath(entries[i]!)) check(isAbsolutePath(d.file) || !climbsOut(d.file), () => `absolute ${JSON.stringify(entries[i])} became ${JSON.stringify(d.file)}`);
        });
        const back = rebaseProject(moved, oldFile);
        back.drawings.forEach((d, i) => {
          check(samePath(resolveDrawingPath(back, d), want[i]), () => `round trip of ${JSON.stringify(entries[i])} via ${JSON.stringify(newFile)}: ${JSON.stringify(d.file)}`);
          // An entry that was inside the project folder comes back inside it (relative, no "..").
          const wasInside = !isAbsolutePath(entries[i]!) && !climbsOut(normalizePath(entries[i]!.replace(/\\/g, '/')));
          if (wasInside) check(!isAbsolutePath(d.file) && !climbsOut(normalizePath(d.file.replace(/\\/g, '/'))), () => `${JSON.stringify(entries[i])} escaped the project folder: ${JSON.stringify(d.file)} after ${JSON.stringify(newFile)} and back`);
        });
        // The round trip is stable: doing it again changes nothing.
        const again = rebaseProject(rebaseProject(back, newFile), oldFile);
        check(JSON.stringify(again.drawings) === JSON.stringify(back.drawings), () => `second round trip changed entries: ${JSON.stringify(back.drawings)} -> ${JSON.stringify(again.drawings)}`);
        // Same destination: nothing changes.
        check(JSON.stringify(rebaseProject(p, sameFile(rng, { style, root, segs: [...projDir, 'p.jcadproj.json'], text: oldFile }, win32)).drawings) === JSON.stringify(p.drawings), 'rebase onto the same file changed entries');
        // rebaseProjectEntry without an old path leaves relative entries alone
        for (const e of entries) if (!isAbsolutePath(e)) check(rebaseProjectEntry(e, undefined, newFile) === e, 'relative entry without project path changed');
      });
    }, fuzzTimeout());

    it(`short names are injective on distinct files (${platform})`, () => {
      setPathPlatform(platform);
      fuzzSync(`paths/shortnames/${platform}`, 800, (rng) => {
        const deep = rng.bool(0.3);
        const tail = deep ? Array.from({ length: rng.int(6, 10) }, () => rng.pick(['a', 'b', 'x'])) : [];
        const n = rng.int(2, 7);
        const paths: Array<string | null> = [];
        for (let i = 0; i < n; i += 1) {
          if (rng.bool(0.1)) {
            paths.push(null);
            continue;
          }
          if (paths.length && rng.bool(0.15)) {
            const prev = paths.filter((x): x is string => !!x);
            if (prev.length) {
              const q = rng.pick(prev);
              paths.push(rng.bool() ? q : normalizePath(q)); // the same file twice
              continue;
            }
          }
          const style = rng.pick(['posix', 'drive', 'unc'] as const);
          paths.push(genPath(rng, win32, style, undefined, [...genSegments(rng, 0, 2), ...tail, rng.pick(['a.dxf', 'A.dxf', 'José.dxf', 'José.dxf'])]).text);
        }
        const names = shortNames(paths, paths.map((_, i) => `Drawing${i + 1}.dxf`));
        for (let i = 0; i < n; i += 1) {
          for (let j = i + 1; j < n; j += 1) {
            const a = paths[i];
            const b = paths[j];
            if (!a || !b) continue;
            if (samePath(a, b)) continue;
            check(names[i]!.normalize('NFC') !== names[j]!.normalize('NFC'), () => `distinct files ${JSON.stringify(a)} and ${JSON.stringify(b)} both shown as ${JSON.stringify(names[i])}`);
          }
        }
      });
    }, fuzzTimeout());
  }
});

describe('fuzz: renderer pathKey agrees with electron/main.cjs pathKey', () => {
  it('POSIX absolute paths (linux main process)', () => {
    setPathPlatform('linux');
    const main = mainPathKey('linux');
    fuzzSync('paths/main-twin/linux', 1500, (rng) => {
      const p = genPath(rng, false, 'posix');
      const k = main(p.text);
      check(k !== null, () => `main rejected ${JSON.stringify(p.text)}`);
      check(k === pathKey(p.text), () => `${JSON.stringify(p.text)}: main ${JSON.stringify(k)} vs renderer ${JSON.stringify(pathKey(p.text))}`);
      // Two spellings are one key on both sides, or on neither.
      const q = rng.bool() ? sameFile(rng, p, false) : genPath(rng, false, 'posix').text;
      check((main(p.text) === main(q)) === samePath(p.text, q), () => `${JSON.stringify(p.text)} vs ${JSON.stringify(q)}: main and renderer disagree on identity`);
    });
  }, fuzzTimeout());
  it('drive and UNC paths (win32 main process)', () => {
    setPathPlatform('win32');
    const main = mainPathKey('win32');
    fuzzSync('paths/main-twin/win32', 1500, (rng) => {
      const p = genPath(rng, true, rng.pick(['drive', 'unc'] as const));
      const k = main(p.text);
      check(k !== null, () => `main rejected ${JSON.stringify(p.text)}`);
      check(isWindowsPath(p.text), 'not a Windows path');
      check(k === pathKey(p.text), () => `${JSON.stringify(p.text)}: main ${JSON.stringify(k)} vs renderer ${JSON.stringify(pathKey(p.text))}`);
      const q = rng.bool() ? sameFile(rng, p, true) : genPath(rng, true, rng.pick(['drive', 'unc'] as const)).text;
      check((main(p.text) === main(q)) === samePath(p.text, q), () => `${JSON.stringify(p.text)} vs ${JSON.stringify(q)}: main and renderer disagree on identity`);
    });
  }, fuzzTimeout());
  it('the main process rejects relative paths and NUL bytes', () => {
    const main = mainPathKey('linux');
    expect(main('dwg/a.dxf')).toBeNull();
    expect(main('/a/\0b')).toBeNull();
    expect(mainPathKey('win32')('C:dwg\\a.dxf')).toBeNull();
  });
});
