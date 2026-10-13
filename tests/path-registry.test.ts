import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { ipcHandlerSource } from './helpers/main-process';

// electron/path-registry.cjs and ipc-guard.cjs are plain CommonJS for the main process
// (type-checked by tsconfig.electron.json).
const require = createRequire(import.meta.url);
type Registry = {
  isKnown(p: unknown): boolean;
  isWritable(p: unknown): boolean;
  paths(): Iterable<string>;
  grant(p: unknown): boolean;
  grantRead(p: unknown): boolean;
  registerProject(file: string, project: unknown, opts?: { userChosen?: boolean }): { writable: string[]; readOnly: string[]; ignored: string[] };
  serialize(): string;
  restore(text: string): void;
  writeRoot(p: unknown): string | null;
  grantDerived(p: unknown, source: unknown): boolean;
};
const reg = require('../electron/path-registry.cjs') as {
  createPathRegistry: (o?: { onChange?: () => void }) => Registry;
  networkHost: (p: unknown) => string | null;
  isInside: (dir: string, child: string) => boolean;
  streamName: (p: string) => boolean;
};
const guard = require('../electron/ipc-guard.cjs') as {
  createPathPolicy: (d: unknown) => { writable: (p: unknown, what: string, type: RegExp) => string | null; known: (p: unknown, what: string) => string | null };
};

const posix = process.platform !== 'win32';
const abs = (...p: string[]) => (posix ? `/${p.join('/')}` : `C:\\${p.join('\\')}`);
const DXF = /\.dxf$/i;
const PROJECT = /\.json$/i;
const BACKUP = /\.(dxf|jcadproj\.json)$/i;

function setup() {
  const registry = reg.createPathRegistry();
  const log: string[] = [];
  const policy = guard.createPathPolicy({
    isKnownPath: (p: string) => registry.isKnown(p),
    isWritablePath: (p: string) => registry.isWritable(p),
    knownPaths: () => registry.paths(),
    log: { reject: (k: string, d: string) => log.push(`${k}: ${d}`) },
  });
  return { registry, policy, log };
}

describe('readable / writable paths (electron/path-registry.cjs)', () => {
  const project = abs('work', 'jobs', 'a', 'plant.jcadproj.json');

  it.runIf(!posix)('Windows: Unicode-equivalent filenames keep separate persisted write grants', () => {
    const composed = abs('work', 'Jos\u00e9.dxf');
    const decomposed = abs('work', 'Jose\u0301.dxf');
    const { registry } = setup();
    registry.grant(composed);
    expect(registry.isKnown(decomposed)).toBe(false);
    expect(registry.isWritable(decomposed)).toBe(false);
    registry.grantRead(decomposed);
    const restarted = reg.createPathRegistry();
    restarted.restore(registry.serialize());
    expect(restarted.isWritable(composed)).toBe(true);
    expect(restarted.isKnown(decomposed)).toBe(true);
    expect(restarted.isWritable(decomposed)).toBe(false);
    expect([...restarted.paths()].sort()).toEqual([composed, decomposed].sort());
  });

  it('a project opened only by name: file content cannot make a path outside the project folder writable', () => {
    const { registry } = setup();
    registry.grant(project); // chosen in a dialog once, opened by name now (a plugin, OPENPROJECT <path>)
    const r = registry.registerProject(project, {
      drawings: [
        { file: 'sheets/s1.dxf' },
        { file: 'sheets\\s2.dwg' },
        { file: '../../package.json' },
        { file: '../shared/cover.dxf' },
        { file: abs('etc', 'evil.dxf') },
        { file: '\\\\attacker\\share\\x.dxf' },
        { file: '//attacker/share/y.dxf' },
        { file: 'notes.txt' },
        { file: 42 },
      ],
      settings: { catalogFile: '../../package.json' },
    });
    const pkg = abs('work', 'package.json');
    // ../../package.json as a drawing is the wrong type (ignored); as the catalog it is readable only.
    expect(registry.isKnown(pkg)).toBe(true);
    expect(registry.isWritable(pkg)).toBe(false);
    expect(r.readOnly).toContain(pkg);
    // Drawings inside the project folder are writable, outside it readable only.
    expect(registry.isWritable(abs('work', 'jobs', 'a', 'sheets', 's1.dxf'))).toBe(true);
    expect(registry.isWritable(abs('work', 'jobs', 'a', 'sheets', 's2.dwg'))).toBe(true);
    expect(registry.isKnown(abs('work', 'jobs', 'shared', 'cover.dxf'))).toBe(true);
    expect(registry.isWritable(abs('work', 'jobs', 'shared', 'cover.dxf'))).toBe(false);
    expect(registry.isWritable(abs('etc', 'evil.dxf'))).toBe(false);
    // Network drawings named by a local project, and other file types, are not registered at all.
    expect(r.ignored).toEqual(expect.arrayContaining(['\\\\attacker\\share\\x.dxf', '//attacker/share/y.dxf']));
    expect(registry.isKnown('//attacker/share/y.dxf')).toBe(false);
    expect(registry.isKnown(abs('work', 'jobs', 'a', 'notes.txt'))).toBe(false);
  });

  // The maintainer's rule for 0.4.1: a project the user chose (Open Project dialog, OS hand-over,
  // Recent Documents) may have its drawings written wherever they are; nothing else changes.
  const chosenEntries = () => ({
    drawings: [
      { file: 'sheets/s1.dxf' },
      { file: '../shared/cover.dxf' },
      { file: abs('elsewhere', 'plant', 'p1.dwg') },
      { file: 'sheets/../../../../../outside.DXF' },
      { file: '../../package.json' },
      { file: 'sheets/s1.dxf/../../../package.json' },
      { file: 'sheets/../package.json' },
      { file: 'notes.txt' },
      { file: 'run.dxf.exe' },
      { file: 'sheet.dxf ' },
      { file: '\\\\attacker\\share\\x.dxf' },
      { file: '//attacker/share/y.dxf' },
      { file: '\\\\?\\C:\\jobs\\device.dxf' },
      { file: '\\\\.\\pipe\\p.dxf' },
      { file: 'nul\u0000.dxf' },
      { file: 42 },
    ],
    settings: { catalogFile: '../../package.json' },
  });

  it('a project the user chose: its .dxf / .dwg drawings are writable wherever they are, nothing else', () => {
    const { registry, policy, log } = setup();
    registry.grant(project);
    const r = registry.registerProject(project, chosenEntries(), { userChosen: true });
    const outsideDxf = abs('work', 'jobs', 'shared', 'cover.dxf');
    const otherTree = abs('elsewhere', 'plant', 'p1.dwg');
    const climbed = abs('outside.DXF');
    for (const p of [abs('work', 'jobs', 'a', 'sheets', 's1.dxf'), outsideDxf, otherTree, climbed]) {
      expect(registry.isWritable(p), p).toBe(true);
      expect(r.writable).toContain(p);
    }
    // ".." is resolved before the type check: none of the package.json spellings is writable (or a drawing).
    const pkg = abs('work', 'package.json');
    expect(registry.isWritable(pkg)).toBe(false);
    expect(registry.isWritable(abs('work', 'jobs', 'a', 'package.json'))).toBe(false);
    expect(registry.isKnown(abs('work', 'jobs', 'a', 'package.json'))).toBe(false);
    // The catalog file stays readable only.
    expect(registry.isKnown(pkg)).toBe(true);
    expect(r.readOnly).toEqual([pkg]);
    expect(policy.writable(pkg, 'save-project', PROJECT)).toBeNull();
    expect(log.pop()).toMatch(/^save-project: read-only .*package\.json$/);
    // Other types, network paths on another server, device paths and NUL bytes are not registered.
    expect(registry.isKnown(abs('work', 'jobs', 'a', 'notes.txt'))).toBe(false);
    expect(registry.isKnown(abs('work', 'jobs', 'a', 'run.dxf.exe'))).toBe(false);
    expect(registry.isKnown(abs('work', 'jobs', 'a', 'sheet.dxf '))).toBe(false);
    expect(registry.isKnown('//attacker/share/y.dxf')).toBe(false);
    expect(registry.isKnown('\\\\attacker\\share\\x.dxf')).toBe(false);
    expect(r.ignored).toEqual(expect.arrayContaining(['\\\\attacker\\share\\x.dxf', '//attacker/share/y.dxf', '\\\\?\\C:\\jobs\\device.dxf', '\\\\.\\pipe\\p.dxf']));
    expect(r.writable).toHaveLength(4);
    // The write channels keep their own file types: a writable .dwg is not written by save-dxf.
    expect(policy.writable(otherTree, 'save-dxf', DXF)).toBeNull();
    expect(log.pop()).toMatch(/^save-dxf: wrong file type/);
    expect(policy.writable(outsideDxf, 'save-dxf', DXF)).toBe(outsideDxf);
    expect(policy.writable(outsideDxf, 'backup-file', BACKUP)).toBe(outsideDxf);
  });

  it('the same project opened only by name grants nothing beyond its folder', () => {
    const { registry } = setup();
    registry.grant(project);
    const r = registry.registerProject(project, chosenEntries());
    expect(r.writable).toEqual([abs('work', 'jobs', 'a', 'sheets', 's1.dxf')]);
    for (const p of [abs('work', 'jobs', 'shared', 'cover.dxf'), abs('elsewhere', 'plant', 'p1.dwg'), abs('outside.DXF')]) {
      expect(registry.isKnown(p), p).toBe(true);
      expect(registry.isWritable(p), p).toBe(false);
    }
    // userChosen must be exactly true (a truthy string from a renderer does not count).
    const again = setup().registry;
    again.registerProject(project, chosenEntries(), { userChosen: 'yes' as unknown as boolean });
    expect(again.isWritable(abs('work', 'jobs', 'shared', 'cover.dxf'))).toBe(false);
  });

  it('a chosen project on a network share: drawings on that server or on local disks, not on another server', () => {
    const { registry } = setup();
    const share = '\\\\fileserver\\jobs\\plant\\p.jcadproj.json';
    const r = registry.registerProject(share, { drawings: [{ file: '\\\\fileserver\\archive\\old.dxf' }, { file: '//FileServer/archive/old2.dxf' }, { file: '\\\\other\\jobs\\x.dxf' }, { file: abs('local', 'l.dxf') }] }, { userChosen: true });
    expect(r.ignored).toEqual(['\\\\other\\jobs\\x.dxf']);
    expect(registry.isWritable(abs('local', 'l.dxf'))).toBe(true);
    expect(registry.isKnown('\\\\other\\jobs\\x.dxf')).toBe(false);
    if (!posix) {
      expect(registry.isWritable('\\\\fileserver\\archive\\old.dxf')).toBe(true);
      expect(registry.isWritable('\\\\fileserver\\archive\\old2.dxf')).toBe(true);
    }
  });

  it.runIf(!posix)('Windows: a stream name after a drawing extension is not a drawing ("package.json:x.dxf")', () => {
    const { registry } = setup();
    const r = registry.registerProject(project, { drawings: [{ file: 'package.json:x.dxf' }, { file: 'C:\\work\\package.json:x.dxf' }] }, { userChosen: true });
    expect(r.writable).toEqual([]);
    expect(reg.streamName('C:\\work\\package.json:x.dxf')).toBe(true);
    expect(reg.streamName('C:\\work\\a.dxf')).toBe(false);
  });

  it('the write access of a chosen project persists in recent.json (Recent Documents after a restart)', () => {
    const a = reg.createPathRegistry();
    a.grant(project);
    a.registerProject(project, { drawings: [{ file: '../shared/cover.dxf' }] }, { userChosen: true });
    const b = reg.createPathRegistry();
    b.restore(a.serialize());
    expect(b.isWritable(abs('work', 'jobs', 'shared', 'cover.dxf'))).toBe(true);
  });

  it('a file the user chose in a dialog keeps its write access when a project names it', () => {
    const { registry } = setup();
    const cover = abs('work', 'jobs', 'shared', 'cover.dxf');
    registry.grant(cover);
    registry.registerProject(project, { drawings: [{ file: '../shared/cover.dxf' }] });
    expect(registry.isWritable(cover)).toBe(true);
  });

  it('writes of drawings a project opened by name made writable stay in its folder (writeRoot, E-5), also after a restart', () => {
    const { registry } = setup();
    const folder = abs('work', 'jobs', 'a');
    const s1 = abs('work', 'jobs', 'a', 'sheets', 's1.dxf');
    const cover = abs('work', 'jobs', 'shared', 'cover.dxf');
    const mine = abs('work', 'jobs', 'a', 'mine.dxf');
    registry.grant(mine); // chosen in a dialog first: never confined by file content
    registry.registerProject(project, { drawings: [{ file: 'sheets/s1.dxf' }, { file: '../shared/cover.dxf' }, { file: 'mine.dxf' }] });
    expect(registry.writeRoot(s1)).toBe(folder);
    expect(registry.writeRoot(cover)).toBeNull(); // readable only
    expect(registry.writeRoot(mine)).toBeNull();
    const b = reg.createPathRegistry();
    b.restore(registry.serialize());
    expect(b.isWritable(s1)).toBe(true);
    expect(b.writeRoot(s1)).toBe(folder);
    // Opening the project through a dialog (the user chose it) or choosing the drawing lifts it.
    b.registerProject(project, { drawings: [{ file: 'sheets/s1.dxf' }] }, { userChosen: true });
    expect(b.writeRoot(s1)).toBeNull();
    registry.grant(s1);
    expect(registry.writeRoot(s1)).toBeNull();
    // A chosen project's drawings are written in their own folders.
    const c = reg.createPathRegistry();
    c.registerProject(project, { drawings: [{ file: 'sheets/s1.dxf' }] }, { userChosen: true });
    expect(c.writeRoot(s1)).toBeNull();
    // Garbage in recent.json is ignored.
    const d = reg.createPathRegistry();
    d.restore(JSON.stringify({ version: 2, writable: [s1], writeRoots: { [s1]: 42, [cover]: folder, relative: 'x' } }));
    expect(d.writeRoot(s1)).toBeNull();
    expect(d.writeRoot(cover)).toBeNull();
  });

  it('a DWG-derived DXF inherits read/write authority and persisted project confinement', () => {
    const snapshots: string[] = [];
    const registry: Registry = reg.createPathRegistry({ onChange: () => snapshots.push(registry.serialize()) });
    const dwg = abs('work', 'jobs', 'a', 'sheets', 'source.dwg');
    const twin = abs('work', 'jobs', 'a', 'sheets', 'source.dxf');
    const folder = abs('work', 'jobs', 'a');
    registry.registerProject(project, { drawings: [{ file: 'sheets/source.dwg' }] });
    expect(registry.grantDerived(twin, dwg)).toBe(true);
    expect(registry.isWritable(twin)).toBe(true);
    expect(registry.writeRoot(twin)).toBe(folder);
    const restarted = reg.createPathRegistry();
    restarted.restore(snapshots[snapshots.length - 1]!);
    expect(restarted.writeRoot(twin)).toBe(folder);

    const readOnly = abs('work', 'jobs', 'outside.dwg');
    const readOnlyTwin = abs('work', 'jobs', 'outside.dxf');
    registry.grantRead(readOnly);
    registry.grantDerived(readOnlyTwin, readOnly);
    expect(registry.isKnown(readOnlyTwin)).toBe(true);
    expect(registry.isWritable(readOnlyTwin)).toBe(false);
    expect(registry.grantDerived(twin, abs('unknown.dwg'))).toBe(false);

    // A subsequent native file choice lifts confinement on the source and its derived sibling.
    registry.grant(dwg);
    registry.grantDerived(twin, dwg);
    expect(registry.writeRoot(twin)).toBeNull();
    // Previously chosen DXFs keep that grant even when a confined source is opened afterwards.
    registry.registerProject(project, { drawings: [{ file: 'sheets/confined.dwg' }] });
    registry.grantDerived(twin, abs('work', 'jobs', 'a', 'sheets', 'confined.dwg'));
    expect(registry.writeRoot(twin)).toBeNull();
  });

  it('recent.json as written on each change carries the write root of every confined drawing, the last one too', () => {
    const snapshots: string[] = [];
    const registry: Registry = reg.createPathRegistry({ onChange: () => snapshots.push(registry.serialize()) });
    const folder = abs('work', 'jobs', 'a');
    const s1 = abs('work', 'jobs', 'a', 'sheets', 's1.dxf');
    const s2 = abs('work', 'jobs', 'a', 'sheets', 's2.dxf');
    registry.registerProject(project, { drawings: [{ file: 'sheets/s1.dxf' }, { file: 'sheets/s2.dxf' }] });
    // What onChange wrote last is what a restart reads (the queue writes the newest snapshot).
    const restarted = reg.createPathRegistry();
    restarted.restore(snapshots[snapshots.length - 1]!);
    expect(restarted.isWritable(s2)).toBe(true);
    expect(restarted.writeRoot(s1)).toBe(folder);
    expect(restarted.writeRoot(s2)).toBe(folder);
    // Opening the project as chosen lifts the roots in the persisted state too.
    registry.registerProject(project, { drawings: [{ file: 'sheets/s1.dxf' }, { file: 'sheets/s2.dxf' }] }, { userChosen: true });
    const again = reg.createPathRegistry();
    again.restore(snapshots[snapshots.length - 1]!);
    expect(again.writeRoot(s1)).toBeNull();
    expect(again.writeRoot(s2)).toBeNull();
  });

  it('save-dxf (by name) and backup-file hand the write root to the atomic writer; a confined save does not lift it', () => {
    const save = ipcHandlerSource('save-dxf');
    expect(save).toMatch(/const root = \(target && registry\.writeRoot\(target\)\) \?\? undefined;/);
    expect(save).toMatch(/await writeUserFile\(target, text, \{ backup: [^}]*, root \}\);\s*\/\/[^\n]*\n\s*if \(!root\) registry\.grant\(target\);/);
    expect(ipcHandlerSource('backup-file')).toMatch(/\(src, dest\) => copyFileAtomic\(src, dest, \{ root: registry\.writeRoot\(src\) \?\? undefined \}\)/);
  });

  it('write channels: each accepts its own file type and only writable paths, refusals are logged', () => {
    const { registry, policy, log } = setup();
    registry.grant(project);
    registry.registerProject(project, { drawings: [{ file: 'sheets/s1.dxf' }, { file: '../shared/cover.dxf' }], settings: { catalogFile: '../../package.json' } });
    const pkg = abs('work', 'package.json');
    // save-project cannot overwrite the catalog file (readable only).
    expect(policy.writable(pkg, 'save-project', PROJECT)).toBeNull();
    expect(log.pop()).toMatch(/^save-project: read-only .*package\.json$/);
    // save-dxf refuses a .json path even when that path is writable (the project file itself).
    expect(policy.writable(project, 'save-dxf', DXF)).toBeNull();
    expect(log.pop()).toMatch(/^save-dxf: wrong file type: .*plant\.jcadproj\.json$/);
    expect(policy.writable(pkg, 'save-dxf', DXF)).toBeNull();
    expect(log.pop()).toMatch(/^save-dxf: wrong file type/);
    // backup-file: drawings and *.jcadproj.json, writable ones only.
    expect(policy.writable(abs('work', 'jobs', 'shared', 'cover.dxf'), 'backup-file', BACKUP)).toBeNull();
    expect(log.pop()).toMatch(/^backup-file: read-only/);
    expect(policy.writable(abs('work', 'jobs', 'a', 'sheets', 's1.dxf'), 'backup-file', BACKUP)).toBe(abs('work', 'jobs', 'a', 'sheets', 's1.dxf'));
    expect(policy.writable(project, 'backup-file', BACKUP)).toBe(project);
    expect(policy.writable(project, 'save-project', PROJECT)).toBe(project);
    expect(policy.writable(abs('work', 'other.dxf'), 'save-dxf', DXF)).toBeNull();
    expect(log.pop()).toMatch(/^save-dxf: not a file chosen by the user/);
    expect(policy.writable('relative.dxf', 'save-dxf', DXF)).toBeNull();
    expect(log.pop()).toMatch(/^save-dxf: relative path/);
  });

  it('the catalog file is readable only, also inside the project folder', () => {
    const { registry } = setup();
    registry.grant(project);
    const r = registry.registerProject(project, { settings: { catalogFile: 'parts.json' } });
    expect(r.readOnly).toEqual([abs('work', 'jobs', 'a', 'parts.json')]);
    expect(registry.isKnown(abs('work', 'jobs', 'a', 'parts.json'))).toBe(true);
    expect(registry.isWritable(abs('work', 'jobs', 'a', 'parts.json'))).toBe(false);
  });

  it('persists both lists; the plain array of 0.4 keeps write access for drawings and projects only', () => {
    const changes: number[] = [];
    const a = reg.createPathRegistry({ onChange: () => changes.push(1) });
    a.grant(project);
    a.registerProject(project, { drawings: [{ file: 's1.dxf' }, { file: '../x.dxf' }], settings: { catalogFile: 'parts.json' } });
    expect(changes.length).toBeGreaterThan(0);
    const b = reg.createPathRegistry();
    b.restore(a.serialize());
    expect(b.isWritable(project)).toBe(true);
    expect(b.isWritable(abs('work', 'jobs', 'a', 's1.dxf'))).toBe(true);
    expect(b.isKnown(abs('work', 'jobs', 'x.dxf'))).toBe(true);
    expect(b.isWritable(abs('work', 'jobs', 'x.dxf'))).toBe(false);
    expect(b.isWritable(abs('work', 'jobs', 'a', 'parts.json'))).toBe(false);

    const old = reg.createPathRegistry();
    old.restore(JSON.stringify([abs('d', 'a.dxf'), abs('d', 'p.jcadproj.json'), abs('d', 'package.json'), 'relative.dxf', 7]));
    expect(old.isWritable(abs('d', 'a.dxf'))).toBe(true);
    expect(old.isWritable(abs('d', 'p.jcadproj.json'))).toBe(true);
    expect(old.isKnown(abs('d', 'package.json'))).toBe(true);
    expect(old.isWritable(abs('d', 'package.json'))).toBe(false);
    expect(old.isKnown('relative.dxf')).toBe(false);
    old.restore('not json');
    expect(old.isKnown(abs('d', 'a.dxf'))).toBe(true);
  });

  it('networkHost(): UNC and //server paths, device paths, local paths', () => {
    expect(reg.networkHost('\\\\Server\\share\\a.png')).toBe('server');
    expect(reg.networkHost('//server/share/a.png')).toBe('server');
    expect(reg.networkHost('\\/server\\share')).toBe('server');
    expect(reg.networkHost('\\\\?\\UNC\\host\\share\\a.png')).toBe('host');
    expect(reg.networkHost('\\\\?\\C:\\a.png')).toBe('');
    expect(reg.networkHost('\\\\.\\pipe\\x')).toBe('');
    expect(reg.networkHost('C:\\a.png')).toBeNull();
    expect(reg.networkHost('/home/a.png')).toBeNull();
    expect(reg.isInside(abs('a'), abs('a', 'b', 'c.dxf'))).toBe(true);
    expect(reg.isInside(abs('a'), abs('ab', 'c.dxf'))).toBe(false);
    expect(reg.isInside(abs('a', 'b'), abs('a', 'c.dxf'))).toBe(false);
  });
});
