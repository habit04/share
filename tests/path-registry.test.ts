import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// electron/path-registry.cjs and ipc-guard.cjs are plain CommonJS for the main process
// (type-checked by tsconfig.electron.json).
const require = createRequire(import.meta.url);
type Registry = {
  isKnown(p: unknown): boolean;
  isWritable(p: unknown): boolean;
  paths(): Iterable<string>;
  grant(p: unknown): boolean;
  grantRead(p: unknown): boolean;
  registerProject(file: string, project: unknown): { writable: string[]; readOnly: string[]; ignored: string[] };
  serialize(): string;
  restore(text: string): void;
};
const reg = require('../electron/path-registry.cjs') as {
  createPathRegistry: (o?: { onChange?: () => void }) => Registry;
  networkHost: (p: unknown) => string | null;
  isInside: (dir: string, child: string) => boolean;
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

  it('file content cannot make a path outside the project folder writable', () => {
    const { registry } = setup();
    registry.grant(project); // chosen in the Open Project dialog
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

  it('a file the user chose in a dialog keeps its write access when a project names it', () => {
    const { registry } = setup();
    const cover = abs('work', 'jobs', 'shared', 'cover.dxf');
    registry.grant(cover);
    registry.registerProject(project, { drawings: [{ file: '../shared/cover.dxf' }] });
    expect(registry.isWritable(cover)).toBe(true);
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
