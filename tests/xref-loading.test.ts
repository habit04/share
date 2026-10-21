/**
 * Milestone 20 / 20.1: DXF external-reference loading / refresh core.
 *
 * All file access is a fake in-memory adapter over the authored fixtures
 * in tests/fixtures/xref/, mapped onto a virtual project layout:
 *
 *   /proj/drawings/host.dxf          refs ../parts/child.dxf, ..\shared\leaf.dxf, overlay-root.dxf (overlay)
 *   /proj/parts/child.dxf            refs grand.dxf (attach)
 *   /proj/parts/grand.dxf            leaf content
 *   /proj/shared/leaf.dxf            leaf content
 *   /proj/drawings/overlay-root.dxf  refs kid.dxf (attach)
 *   /proj/drawings/kid.dxf           leaf content
 *   /proj/drawings/overlay-parent.dxf refs inner.dxf (overlay, nested)
 *   /proj/cycle-a.dxf <-> /proj/cycle-b.dxf, /proj/self-cycle.dxf
 *
 * These are headless checks only; Windows/application/native validation
 * is pending (see docs/XREF-LOADING-CORE.md).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setPathPlatform } from '../src/app/paths';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDxf, writeDxf } from '../src/io/dxf';
import type { DrawingState } from '../src/core/document';
import {
  collectXrefReferences,
  normalizeCadPath,
  resolveXrefPath,
  cadPathKey,
  stageXrefLoad,
  externalContent,
  XrefStore,
  type XrefFileIdentity,
  type XrefFileReader,
  type XrefReadResult,
  type XrefReferenceInput,
} from '../src/io/xref-loading';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'xref', name), 'utf8');

const HOST_PATH = '/proj/drawings/host.dxf';

/** The virtual project, keyed by the resolved paths the loader must compute. */
function projectFiles(): Map<string, string> {
  return new Map<string, string>([
    ['/proj/parts/child.dxf', fixture('child.dxf')],
    ['/proj/parts/grand.dxf', fixture('grand.dxf')],
    ['/proj/shared/leaf.dxf', fixture('leaf.dxf')],
    ['/proj/drawings/overlay-root.dxf', fixture('overlay-root.dxf')],
    ['/proj/drawings/kid.dxf', fixture('kid.dxf')],
    ['/proj/drawings/overlay-parent.dxf', fixture('overlay-parent.dxf')],
    ['/proj/drawings/inner.dxf', fixture('inner.dxf')],
    ['/proj/cycle-a.dxf', fixture('cycle-a.dxf')],
    ['/proj/cycle-b.dxf', fixture('cycle-b.dxf')],
    ['/proj/self-cycle.dxf', fixture('self-cycle.dxf')],
    ['/proj/drawings/bad.dxf', fixture('broken/bad.dxf')],
  ]);
}

function enoent(path: string): Error & { code?: string } {
  const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as Error & { code?: string };
  error.code = 'ENOENT';
  return error;
}

interface FakeReader extends XrefFileReader {
  readonly calls: string[];
  readonly allowances: number[];
  readonly identifyCalls: string[];
  readonly files: Map<string, string>;
}

function fakeReader(files = projectFiles(), identify?: (path: string, context: { depth: number }) => XrefFileIdentity | null): FakeReader {
  const calls: string[] = [];
  const allowances: number[] = [];
  const identifyCalls: string[] = [];
  const reader: FakeReader = {
    calls,
    allowances,
    identifyCalls,
    files,
    async readText(resolvedPath: string, context: { maxBytes: number }): Promise<XrefReadResult> {
      calls.push(resolvedPath);
      allowances.push(context.maxBytes);
      const text = files.get(resolvedPath);
      if (text === undefined) throw enoent(resolvedPath);
      return text;
    },
  };
  if (identify) {
    reader.identify = async (resolvedPath: string, context: { depth: number }) => {
      identifyCalls.push(resolvedPath);
      return identify(resolvedPath, context);
    };
  }
  return reader;
}

const hostState = () => readDxf(fixture('host.dxf'));

// The lexical path helpers are platform-aware by design (20.1 review,
// item 8): pin the platform for this file so expectations are identical
// on Linux and Windows, and restore auto-detection afterwards. A
// dedicated test below pins win32 and checks the Windows contract.
beforeAll(() => setPathPlatform('posix'));
afterAll(() => setPathPlatform(null));

describe('path resolution (app/paths helpers)', () => {
  it('normalizes drive, rooted and relative paths and folds dot segments', () => {
    expect(normalizeCadPath('C:\\proj\\parts\\..\\shared\\leaf.dxf')).toBe('C:\\proj\\shared\\leaf.dxf');
    expect(normalizeCadPath('/proj/./parts/child.dxf')).toBe('/proj/parts/child.dxf');
    expect(normalizeCadPath('../up.dxf')).toBe('../up.dxf');
    expect(normalizeCadPath('/../clamped.dxf')).toBe('/clamped.dxf');
  });

  it('resolves relative paths against the containing file, never the root drawing', () => {
    expect(resolveXrefPath('../parts/child.dxf', HOST_PATH)).toBe('/proj/parts/child.dxf');
    expect(resolveXrefPath('grand.dxf', '/proj/parts/child.dxf')).toBe('/proj/parts/grand.dxf');
    expect(resolveXrefPath('..\\shared\\leaf.dxf', HOST_PATH)).toBe('/proj/shared/leaf.dxf');
    expect(resolveXrefPath('C:\\abs\\file.dxf', HOST_PATH)).toBe('C:\\abs\\file.dxf');
  });

  it('refuses ambiguous anchors instead of guessing', () => {
    expect(resolveXrefPath('loose.dxf', null)).toBeNull(); // relative, no containing location
    expect(resolveXrefPath('C:leaf.dxf', HOST_PATH)).toBeNull(); // drive-relative
    expect(resolveXrefPath('leaf.dxf', 'C:host.dxf')).toBeNull(); // drive-relative container
    expect(resolveXrefPath('C:\\abs\\file.dxf', null)).toBe('C:\\abs\\file.dxf'); // absolute needs no anchor
  });

  it('lexical keys fold Windows case (and are documented as not identity)', () => {
    expect(cadPathKey('C:\\Proj\\Leaf.dxf')).toBe(cadPathKey('c:\\proj\\leaf.dxf'));
    expect(cadPathKey('/Proj/Leaf.dxf')).not.toBe(cadPathKey('/proj/leaf.dxf'));
  });

  it('windows platform contract: the same helpers spell relative results with backslashes', () => {
    setPathPlatform('win32');
    try {
      expect(normalizeCadPath('../up.dxf')).toBe('..\\up.dxf');
      expect(resolveXrefPath('leaf.dxf', 'C:\\proj\\host.dxf')).toBe('C:\\proj\\leaf.dxf');
      expect(normalizeCadPath('/proj/parts/child.dxf')).toBe('/proj/parts/child.dxf'); // rooted POSIX keeps its form
    } finally {
      setPathPlatform('posix');
    }
  });
});

describe('collecting references from a drawing', () => {
  it('returns the recorded references verbatim, in block order, with overlay flags', () => {
    expect(collectXrefReferences(hostState())).toEqual([
      { blockName: 'CHILD', path: '../parts/child.dxf' },
      { blockName: 'LEAFWIN', path: '..\\shared\\leaf.dxf' },
      { blockName: 'OVLROOT', path: 'overlay-root.dxf', overlay: true },
    ]);
  });
});

describe('loading', () => {
  it('loads root attach + overlay references and nested attachments, resolving each against its immediate host', async () => {
    const reader = fakeReader();
    const outcome = await stageXrefLoad({ hostState: hostState(), hostPath: HOST_PATH }, { reader });
    expect(outcome.fatal).toBe(false);
    expect(outcome.failures).toEqual([]);
    const snap = outcome.snapshot!;
    expect(reader.calls).toEqual([
      '/proj/parts/child.dxf',
      '/proj/parts/grand.dxf',
      '/proj/shared/leaf.dxf',
      '/proj/drawings/overlay-root.dxf',
      '/proj/drawings/kid.dxf',
    ]);
    const [child, leafwin, ovlroot] = snap.nodes;
    expect(child).toMatchObject({ blockName: 'CHILD', originalPath: '../parts/child.dxf', resolvedPath: '/proj/parts/child.dxf', overlay: false, depth: 1, status: 'loaded' });
    expect(child!.children[0]).toMatchObject({ blockName: 'GRAND', originalPath: 'grand.dxf', resolvedPath: '/proj/parts/grand.dxf', depth: 2, status: 'loaded' });
    expect(leafwin).toMatchObject({ originalPath: '..\\shared\\leaf.dxf', resolvedPath: '/proj/shared/leaf.dxf', status: 'loaded' });
    expect(ovlroot).toMatchObject({ overlay: true, depth: 1, status: 'loaded' });
    expect(ovlroot!.children[0]).toMatchObject({ blockName: 'KID', resolvedPath: '/proj/drawings/kid.dxf', depth: 2, status: 'loaded' });
    expect(snap.stats.filesLoaded).toBe(5);
    expect(snap.stats.referencesSeen).toBe(5);
    expect(snap.stats.totalEntities).toBe(2 + 2 + 1 + 2 + 1);
    expect(snap.stats.loadedBytes).toBeGreaterThan(0);
    expect(snap.stats.bytesDelivered).toBe(snap.stats.loadedBytes);
  });

  it('records a nested overlay without reading its file, and reports no failure', async () => {
    const reader = fakeReader();
    const refs: XrefReferenceInput[] = [{ blockName: 'PARENT', path: 'overlay-parent.dxf' }];
    const outcome = await stageXrefLoad({ references: refs, hostPath: '/proj/drawings/host.dxf' }, { reader });
    expect(outcome.failures).toEqual([]);
    const parent = outcome.snapshot!.nodes[0]!;
    expect(parent.status).toBe('loaded');
    expect(parent.children[0]).toMatchObject({ blockName: 'INNER', originalPath: 'inner.dxf', resolvedPath: '/proj/drawings/inner.dxf', overlay: true, status: 'not-carried-overlay' });
    expect(reader.calls).toEqual(['/proj/drawings/overlay-parent.dxf']);
  });

  it('keeps loaded geometry separate from the host drawing and never mutates the host', async () => {
    const host = hostState();
    const before = JSON.stringify(host);
    const outcome = await stageXrefLoad({ hostState: host, hostPath: HOST_PATH }, { reader: fakeReader() });
    expect(JSON.stringify(host)).toBe(before);
    expect(Object.isFrozen(host)).toBe(false);
    expect(host.blocks.CHILD!.entities).toHaveLength(0);
    expect(host.blocks.CHILD!.xref).toEqual({ path: '../parts/child.dxf' });
    expect(writeDxf(host)).toContain('..\\shared\\leaf.dxf');
    const content = externalContent(outcome.snapshot!);
    expect(content.map((c) => c.file.owningLocation)).toEqual([
      '/proj/parts/child.dxf',
      '/proj/parts/grand.dxf',
      '/proj/shared/leaf.dxf',
      '/proj/drawings/overlay-root.dxf',
      '/proj/drawings/kid.dxf',
    ]);
    for (const c of content) {
      expect(c.file.state).not.toBe(host);
      for (const e of c.entities) expect(host.entities).not.toContain(e);
    }
    expect(content[0]!.entities.map((e) => e.type)).toEqual(['line', 'insert']);
  });

  it('lexical fallback (no adapter identity): a file referenced twice by spelling is read once and shared', async () => {
    const files = projectFiles();
    files.set('/proj/leaf.dxf', fixture('leaf.dxf'));
    const reader = fakeReader(files);
    const refs: XrefReferenceInput[] = [
      { blockName: 'A', path: 'leaf.dxf' },
      { blockName: 'B', path: './leaf.dxf' },
    ];
    const outcome = await stageXrefLoad({ references: refs, hostPath: '/proj/host.dxf' }, { reader });
    expect(outcome.failures).toEqual([]);
    expect(reader.calls).toEqual(['/proj/leaf.dxf']);
    const [a, b] = outcome.snapshot!.nodes;
    expect(a!.fileKey).toBe(b!.fileKey);
    expect(a!.fileKey!.startsWith('path:')).toBe(true);
    expect(outcome.snapshot!.stats.filesLoaded).toBe(1);
    expect(outcome.snapshot!.files[a!.fileKey!]!.occurrences.map((o) => o.originalPath)).toEqual(['leaf.dxf', './leaf.dxf']);
  });

  it('a drawing with no references stages an empty snapshot', async () => {
    const reader = fakeReader();
    const outcome = await stageXrefLoad({ references: [], hostPath: HOST_PATH }, { reader });
    expect(outcome.snapshot).toMatchObject({ nodes: [], failures: [], stats: { filesLoaded: 0, referencesSeen: 0 } });
    expect(reader.calls).toEqual([]);
  });
});

describe('adapter identity (20.1)', () => {
  it('shares by adapter identity across different spellings: one read, one file, two occurrences', async () => {
    const files = projectFiles();
    files.set('/proj/a.dxf', fixture('leaf.dxf'));
    files.set('/proj/link/a.dxf', fixture('leaf.dxf'));
    const reader = fakeReader(files, (path) => {
      if (path === '/proj/host.dxf') return { id: 'HOST', owningLocation: '/proj/host.dxf', version: 'v1' };
      return path === '/proj/a.dxf' || path === '/proj/link/a.dxf' ? { id: 'F1', owningLocation: '/proj/a.dxf', version: 'v1' } : null;
    });
    const refs: XrefReferenceInput[] = [
      { blockName: 'A', path: 'a.dxf' },
      { blockName: 'B', path: 'link/a.dxf' },
    ];
    const outcome = await stageXrefLoad({ references: refs, hostPath: '/proj/host.dxf' }, { reader });
    expect(outcome.failures).toEqual([]);
    expect(reader.calls).toEqual(['/proj/a.dxf']); // the alias spelling is never read
    const snap = outcome.snapshot!;
    expect(snap.stats.filesLoaded).toBe(1);
    const [a, b] = snap.nodes;
    expect(a!.fileKey).toBe('id:F1');
    expect(b!.fileKey).toBe('id:F1');
    expect(snap.files['id:F1']!.occurrences.map((o) => o.blockName)).toEqual(['A', 'B']);
    expect(snap.files['id:F1']!.owningLocation).toBe('/proj/a.dxf');
  });

  it('distinct identities with case-colliding Windows names are NOT merged', async () => {
    const files = new Map<string, string>();
    const reader: XrefFileReader & { calls: string[] } = {
      calls: [],
      identify: async (path: string) => ({ id: path.startsWith('C:\\Proj') ? 'UPPER' : 'lower', owningLocation: path, version: 'v1' }),
      async readText(path: string) {
        this.calls.push(path);
        return fixture('leaf.dxf');
      },
    };
    void files;
    const refs: XrefReferenceInput[] = [
      { blockName: 'U', path: 'C:\\Proj\\Leaf.dxf' },
      { blockName: 'L', path: 'c:\\proj\\leaf.dxf' },
    ];
    const outcome = await stageXrefLoad({ references: refs, hostPath: null }, { reader });
    expect(outcome.failures).toEqual([]);
    expect(reader.calls).toHaveLength(2); // both files actually read
    expect(outcome.snapshot!.stats.filesLoaded).toBe(2);
    expect(Object.keys(outcome.snapshot!.files).sort()).toEqual(['id:UPPER', 'id:lower']);
  });

  it('cuts a reference back to the host on its first edge, using the seeded host identity (alias spelling)', async () => {
    const files = projectFiles();
    files.set('/proj/drawings/alias-of-host.dxf', fixture('host.dxf'));
    const hostIdentity: XrefFileIdentity = { id: 'HOST', owningLocation: HOST_PATH, version: 'v1' };
    const reader = fakeReader(files, (path) => (path === '/proj/drawings/alias-of-host.dxf' ? { id: 'HOST', owningLocation: HOST_PATH, version: 'v1' } : null));
    const outcome = await stageXrefLoad(
      { references: [{ blockName: 'SELFIE', path: 'alias-of-host.dxf' }], hostPath: HOST_PATH, hostIdentity },
      { reader },
    );
    const node = outcome.snapshot!.nodes[0]!;
    expect(node.status).toBe('cycle');
    expect(outcome.failures[0]).toMatchObject({ kind: 'cycle', chain: [HOST_PATH, HOST_PATH] });
    expect(reader.calls).toEqual([]); // identified as the host: never read as external geometry
    expect(outcome.snapshot!.hostIdentity).toBe('HOST');
  });

  it('resolves children against the adapter owning location, not the requested spelling', async () => {
    const files = projectFiles();
    files.set('/proj/link/parent.dxf', fixture('child.dxf')); // child.dxf refs grand.dxf
    files.set('/proj/real/grand.dxf', fixture('grand.dxf'));
    const reader = fakeReader(files, (path) => {
      if (path === '/proj/host.dxf') return { id: 'HOST', owningLocation: '/proj/host.dxf', version: 'v1' };
      if (path === '/proj/link/parent.dxf') return { id: 'P', owningLocation: '/proj/real/parent.dxf', version: 'v1' };
      if (path === '/proj/real/grand.dxf') return { id: 'G', owningLocation: path, version: 'v1' };
      return null;
    });
    const outcome = await stageXrefLoad({ references: [{ blockName: 'P', path: 'link/parent.dxf' }], hostPath: '/proj/host.dxf' }, { reader });
    expect(outcome.failures).toEqual([]);
    expect(reader.calls).toEqual(['/proj/link/parent.dxf', '/proj/real/grand.dxf']);
    expect(reader.identifyCalls).toContain('/proj/real/grand.dxf');
    expect(outcome.snapshot!.nodes[0]!.children[0]).toMatchObject({ status: 'loaded', resolvedPath: '/proj/real/grand.dxf' });
  });

  it('diagnoses an unavailable/ambiguous location before any read', async () => {
    const reader = fakeReader(projectFiles(), () => null);
    const outcome = await stageXrefLoad({ references: [{ blockName: 'X', path: 'leaf.dxf' }], hostPath: '/proj/host.dxf' }, { reader });
    expect(reader.calls).toEqual([]);
    expect(outcome.snapshot!.nodes[0]!.status).toBe('unresolved-location');
    expect(outcome.failures[0]).toMatchObject({ kind: 'unresolved-location' });
  });

  it('refuses two versions of one identity inside a load as an inconsistent snapshot', async () => {
    const files = projectFiles();
    files.set('/proj/leaf.dxf', fixture('leaf.dxf'));
    let n = 0;
    const reader = fakeReader(files, (path) => {
      if (path === '/proj/host.dxf') return { id: 'HOST', owningLocation: '/proj/host.dxf', version: 'v1' };
      return path === '/proj/leaf.dxf' ? { id: 'F1', owningLocation: '/proj/leaf.dxf', version: `v${++n}` } : null;
    });
    const refs: XrefReferenceInput[] = [
      { blockName: 'A', path: 'leaf.dxf' },
      { blockName: 'B', path: 'leaf.dxf' },
    ];
    const outcome = await stageXrefLoad({ references: refs, hostPath: '/proj/host.dxf' }, { reader });
    expect(reader.calls).toEqual(['/proj/leaf.dxf']);
    expect(outcome.snapshot!.nodes.map((x) => x.status)).toEqual(['loaded', 'inconsistent-version']);
    expect(outcome.failures[0]).toMatchObject({ kind: 'inconsistent-version' });
  });
});

describe('failures', () => {
  it('reports a missing file with its attempted resolved path', async () => {
    const files = projectFiles();
    files.set('/proj/leaf.dxf', fixture('leaf.dxf'));
    const refs: XrefReferenceInput[] = [
      { blockName: 'GONE', path: 'gone.dxf' },
      { blockName: 'LEAF', path: 'leaf.dxf' },
    ];
    const outcome = await stageXrefLoad({ references: refs, hostPath: '/proj/host.dxf' }, { reader: fakeReader(files) });
    expect(outcome.fatal).toBe(false);
    expect(outcome.failures).toEqual([
      expect.objectContaining({ kind: 'missing', blockName: 'GONE', originalPath: 'gone.dxf', resolvedPath: '/proj/gone.dxf', depth: 1 }),
    ]);
    expect(outcome.snapshot!.nodes.map((n) => n.status)).toEqual(['missing', 'loaded']);
  });

  it('classifies authoritative reader EACCES / EPERM refusals as denied, not read-error', async () => {
    const reader: XrefFileReader = {
      async readText(path: string): Promise<XrefReadResult> {
        throw Object.assign(new Error(`permission denied, open '${path}'`), { code: path.includes('a.') ? 'EACCES' : 'EPERM' });
      },
    };
    const refs: XrefReferenceInput[] = [
      { blockName: 'A', path: 'a.dxf' },
      { blockName: 'B', path: 'b.dxf' },
    ];
    const outcome = await stageXrefLoad({ references: refs, hostPath: '/proj/host.dxf' }, { reader });
    expect(outcome.snapshot!.nodes.map((n) => n.status)).toEqual(['denied', 'denied']);
    expect(outcome.failures.map((f) => f.kind)).toEqual(['denied', 'denied']);
  });

  it('detects a two-file cycle and a self-cycle, with the chain, without looping', async () => {
    const outcome = await stageXrefLoad({ references: [{ blockName: 'A', path: 'cycle-a.dxf' }], hostPath: '/proj/host.dxf' }, { reader: fakeReader() });
    const a = outcome.snapshot!.nodes[0]!;
    expect(a.status).toBe('loaded');
    const b = a.children[0]!;
    expect(b).toMatchObject({ blockName: 'CYCLEB', status: 'loaded', resolvedPath: '/proj/cycle-b.dxf' });
    const back = b.children[0]!;
    expect(back).toMatchObject({ blockName: 'CYCLEA', status: 'cycle', resolvedPath: '/proj/cycle-a.dxf' });
    expect(outcome.failures).toEqual([
      expect.objectContaining({ kind: 'cycle', chain: ['/proj/cycle-a.dxf', '/proj/cycle-b.dxf', '/proj/cycle-a.dxf'] }),
    ]);
    const self = await stageXrefLoad({ references: [{ blockName: 'S', path: 'self-cycle.dxf' }], hostPath: '/proj/host.dxf' }, { reader: fakeReader() });
    expect(self.snapshot!.nodes[0]!.children[0]).toMatchObject({ status: 'cycle', resolvedPath: '/proj/self-cycle.dxf' });
  });

  it('a denied read through the gate never reaches the reader', async () => {
    const reader = fakeReader();
    const outcome = await stageXrefLoad(
      { references: [{ blockName: 'SECRET', path: 'leaf.dxf' }], hostPath: '/proj/host.dxf' },
      { reader, authorize: (p) => !p.endsWith('leaf.dxf') },
    );
    expect(reader.calls).toEqual([]);
    expect(outcome.snapshot!.nodes[0]!.status).toBe('denied');
  });

  it('reports an unparseable referenced file as a parse error', async () => {
    const outcome = await stageXrefLoad({ references: [{ blockName: 'BAD', path: 'bad.dxf' }], hostPath: '/proj/drawings/host.dxf' }, { reader: fakeReader() });
    expect(outcome.snapshot!.nodes[0]!.status).toBe('parse-error');
    expect(outcome.failures[0]).toMatchObject({ kind: 'parse-error', resolvedPath: '/proj/drawings/bad.dxf' });
  });

  it('refuses DWG references without reading them (documented DXF-only scope)', async () => {
    const reader = fakeReader();
    const outcome = await stageXrefLoad({ references: [{ blockName: 'LEGACY', path: 'legacy.dwg' }], hostPath: '/proj/host.dxf' }, { reader });
    expect(reader.calls).toEqual([]);
    expect(outcome.snapshot!.nodes[0]!.status).toBe('unsupported-format');
  });

  it('reports empty and unanchored paths as unresolved, without a read', async () => {
    const reader = fakeReader();
    const empty = await stageXrefLoad({ references: [{ blockName: 'EMPTY', path: '' }], hostPath: '/proj/host.dxf' }, { reader });
    expect(empty.snapshot!.nodes[0]).toMatchObject({ status: 'unresolved-path', resolvedPath: null });
    const unanchored = await stageXrefLoad({ references: [{ blockName: 'REL', path: 'leaf.dxf' }], hostPath: null }, { reader });
    expect(unanchored.snapshot!.nodes[0]!.status).toBe('unresolved-path');
    const driveRelative = await stageXrefLoad({ references: [{ blockName: 'DR', path: 'C:leaf.dxf' }], hostPath: '/proj/host.dxf' }, { reader });
    expect(driveRelative.snapshot!.nodes[0]!.status).toBe('unresolved-path');
    expect(reader.calls).toEqual([]);
  });
});

describe('accounting and limits (20.1)', () => {
  const leafFiles = () => {
    const files = projectFiles();
    files.set('/proj/leaf.dxf', fixture('leaf.dxf'));
    return files;
  };

  it('counts every declaration edge before early returns: two empty paths with maxReferences 1 abort fatally', async () => {
    const refs: XrefReferenceInput[] = [
      { blockName: 'E1', path: '' },
      { blockName: 'E2', path: '' },
    ];
    const outcome = await stageXrefLoad({ references: refs, hostPath: '/proj/host.dxf' }, { reader: fakeReader() }, { limits: { maxReferences: 1 } });
    expect(outcome.fatal).toBe(true);
    expect(outcome.snapshot).toBeNull();
    expect(outcome.failures[0]).toMatchObject({ kind: 'total-limit' });
  });

  it('counts suppressed nested overlays and cycle edges against the edge budget', async () => {
    const overlay = await stageXrefLoad(
      { references: [{ blockName: 'P', path: 'overlay-parent.dxf' }], hostPath: '/proj/drawings/host.dxf' },
      { reader: fakeReader() },
      { limits: { maxReferences: 1 } },
    );
    expect(overlay.fatal).toBe(true); // edge 2 is the suppressed INNER overlay
    const cycle = await stageXrefLoad(
      { references: [{ blockName: 'A', path: 'cycle-a.dxf' }], hostPath: '/proj/host.dxf' },
      { reader: fakeReader() },
      { limits: { maxReferences: 2 } },
    );
    expect(cycle.fatal).toBe(true); // edge 3 would be the cycle edge
  });

  it('an exact edge budget passes: the full host graph is exactly 5 edges', async () => {
    const outcome = await stageXrefLoad({ hostState: hostState(), hostPath: HOST_PATH }, { reader: fakeReader() }, { limits: { maxReferences: 5 } });
    expect(outcome.fatal).toBe(false);
    expect(outcome.failures).toEqual([]);
  });

  it('enforces an independent unique-file budget before reading a new file', async () => {
    const reader = fakeReader();
    const outcome = await stageXrefLoad({ hostState: hostState(), hostPath: HOST_PATH }, { reader }, { limits: { maxFiles: 2 } });
    expect(outcome.fatal).toBe(true);
    expect(outcome.failures[0]).toMatchObject({ kind: 'total-limit' });
    expect(reader.calls).toEqual(['/proj/parts/child.dxf', '/proj/parts/grand.dxf']); // the third distinct file is never read
  });

  it('a dense shared graph: many edges, one file, both budgets respected independently', async () => {
    const refs: XrefReferenceInput[] = Array.from({ length: 6 }, (_, i) => ({ blockName: `R${i}`, path: 'leaf.dxf' }));
    const outcome = await stageXrefLoad({ references: refs, hostPath: '/proj/host.dxf' }, { reader: fakeReader(leafFiles()) }, { limits: { maxReferences: 6, maxFiles: 1 } });
    expect(outcome.failures).toEqual([]);
    expect(outcome.snapshot!.stats).toMatchObject({ referencesSeen: 6, filesLoaded: 1 });
  });

  it("charges delivered bytes including rejections, passes the remaining allowance, and stops when the budget is spent (reviewer's example)", async () => {
    const allowances: number[] = [];
    const reader: XrefFileReader = {
      async readText(_path: string, context: { maxBytes: number }): Promise<XrefReadResult> {
        allowances.push(context.maxBytes);
        return '12345678901'; // 11 UTF-8 bytes, whatever the allowance says
      },
    };
    const refs: XrefReferenceInput[] = [
      { blockName: 'A', path: 'a.dxf' },
      { blockName: 'B', path: 'b.dxf' },
      { blockName: 'C', path: 'c.dxf' },
    ];
    const outcome = await stageXrefLoad({ references: refs, hostPath: '/proj/host.dxf' }, { reader }, { limits: { maxFileBytes: 10, maxTotalBytes: 15 } });
    expect(allowances).toEqual([10, 4]); // second read gets only the unspent allowance; a third is never scheduled
    expect(outcome.fatal).toBe(true);
    expect(outcome.snapshot).toBeNull();
    expect(outcome.failures[0]).toMatchObject({ kind: 'total-limit' });
  });

  it('rejected deliveries show up in bytesDelivered even when other files load', async () => {
    const files = leafFiles();
    files.set('/proj/big.dxf', 'x'.repeat(500));
    const refs: XrefReferenceInput[] = [
      { blockName: 'BIG', path: 'big.dxf' },
      { blockName: 'LEAF', path: 'leaf.dxf' },
    ];
    const outcome = await stageXrefLoad({ references: refs, hostPath: '/proj/host.dxf' }, { reader: fakeReader(files) }, { limits: { maxFileBytes: 400, maxTotalBytes: 100_000 } });
    const snap = outcome.snapshot!;
    expect(snap.nodes.map((n) => n.status)).toEqual(['file-limit', 'loaded']);
    expect(snap.stats.bytesDelivered).toBe(500 + snap.stats.loadedBytes);
    expect(snap.stats.filesLoaded).toBe(1);
  });

  it('rejects a response whose declared byte length disagrees with what was delivered', async () => {
    const reader: XrefFileReader = {
      async readText(): Promise<XrefReadResult> {
        return { text: fixture('leaf.dxf'), byteLength: 999_999 };
      },
    };
    const outcome = await stageXrefLoad({ references: [{ blockName: 'L', path: 'leaf.dxf' }], hostPath: '/proj/host.dxf' }, { reader });
    expect(outcome.snapshot!.nodes[0]!.status).toBe('inconsistent-response');
    expect(outcome.snapshot!.stats.bytesDelivered).toBe(new TextEncoder().encode(fixture('leaf.dxf')).length);
    expect(outcome.snapshot!.stats.filesLoaded).toBe(0);
  });

  it('counts paper-space layout entities and retained raw records toward the per-file entity cap', async () => {
    const leaf = readDxf(fixture('leaf.dxf'));
    const baseCount = leaf.entities.length; // 2
    const withExtras = (fn: (s: DrawingState) => DrawingState) => (text: string): DrawingState => fn(readDxf(text));
    // Layout-only content: a fabricated state whose only extra entities live in a layout.
    const layoutState = (s: DrawingState): DrawingState => ({
      ...s,
      layouts: [{ name: 'L1', paper: { id: 'custom', width: 297, height: 210, units: 'mm', orientation: 'landscape' }, plotScale: 'fit', margins: { left: 0, right: 0, top: 0, bottom: 0 }, entities: [leaf.entities[0]!, leaf.entities[0]!, leaf.entities[0]!], viewports: [] }],
    });
    const reader = fakeReader(leafFiles());
    const outcome = await stageXrefLoad(
      { references: [{ blockName: 'L', path: 'leaf.dxf' }], hostPath: '/proj/host.dxf' },
      { reader, parse: withExtras(layoutState) },
      { limits: { maxEntitiesPerFile: baseCount + 2 } },
    );
    expect(outcome.snapshot!.nodes[0]!.status).toBe('file-limit'); // 2 model + 3 layout = 5 > 4
    // Retained raw records count too.
    const rawState = (s: DrawingState): DrawingState => ({ ...s, meta: { ...(s.meta ?? {}), dxfRawEntities: [{}, {}] as never } });
    const outcome2 = await stageXrefLoad(
      { references: [{ blockName: 'L', path: 'leaf.dxf' }], hostPath: '/proj/host.dxf' },
      { reader: fakeReader(leafFiles()), parse: withExtras(rawState) },
      { limits: { maxEntitiesPerFile: baseCount + 1 } },
    );
    expect(outcome2.snapshot!.nodes[0]!.status).toBe('file-limit'); // 2 + 2 retained > 3
    const outcome3 = await stageXrefLoad(
      { references: [{ blockName: 'L', path: 'leaf.dxf' }], hostPath: '/proj/host.dxf' },
      { reader: fakeReader(leafFiles()), parse: withExtras(rawState) },
      { limits: { maxEntitiesPerFile: baseCount + 2 } },
    );
    expect(outcome3.snapshot!.nodes[0]!.status).toBe('loaded');
    expect(outcome3.snapshot!.files['path:/proj/leaf.dxf']!.retainedRecords).toBe(2);
  });

  it('hands the parser a source-length bound lowered from the per-file byte budget (and never parses oversize input)', async () => {
    const seen: number[] = [];
    const parse = (text: string, path: string, bounds: { maxSourceLength: number }): DrawingState => {
      seen.push(bounds.maxSourceLength);
      return readDxf(text, { filePath: path, maxSourceLength: bounds.maxSourceLength });
    };
    const outcome = await stageXrefLoad({ references: [{ blockName: 'L', path: 'leaf.dxf' }], hostPath: '/proj/host.dxf' }, { reader: fakeReader(leafFiles()), parse }, { limits: { maxFileBytes: 4096 } });
    expect(outcome.snapshot!.nodes[0]!.status).toBe('loaded');
    expect(seen).toEqual([4096]);
    seen.length = 0;
    const over = await stageXrefLoad({ references: [{ blockName: 'L', path: 'leaf.dxf' }], hostPath: '/proj/host.dxf' }, { reader: fakeReader(leafFiles()), parse }, { limits: { maxFileBytes: 32 } });
    expect(over.snapshot!.nodes[0]!.status).toBe('file-limit');
    expect(seen).toEqual([]); // oversize input is rejected before parsing
  });

  it('enforces the depth limit on nested references', async () => {
    const outcome = await stageXrefLoad({ hostState: hostState(), hostPath: HOST_PATH }, { reader: fakeReader() }, { limits: { maxDepth: 1 } });
    const child = outcome.snapshot!.nodes[0]!;
    expect(child.status).toBe('loaded');
    expect(child.children[0]).toMatchObject({ blockName: 'GRAND', status: 'depth-limit', depth: 2 });
  });

  it('rejects invalid limits as a programming error', async () => {
    await expect(stageXrefLoad({ references: [], hostPath: '/proj/host.dxf' }, { reader: fakeReader() }, { limits: { maxDepth: 0 } })).rejects.toThrow(TypeError);
  });
});

describe('cancellation normalization (20.1)', () => {
  it('an already-aborted signal performs no reads', async () => {
    const reader = fakeReader();
    const controller = new AbortController();
    controller.abort();
    const outcome = await stageXrefLoad({ hostState: hostState(), hostPath: HOST_PATH }, { reader }, { signal: controller.signal });
    expect(outcome.cancelled).toBe(true);
    expect(outcome.snapshot).toBeNull();
    expect(reader.calls).toEqual([]);
  });

  it('aborting between reads stops staging and reports cancellation', async () => {
    const files = projectFiles();
    const controller = new AbortController();
    let reads = 0;
    const reader: XrefFileReader = {
      async readText(resolvedPath: string): Promise<XrefReadResult> {
        reads += 1;
        if (reads === 1) controller.abort();
        const text = files.get(resolvedPath);
        if (text === undefined) throw enoent(resolvedPath);
        return text;
      },
    };
    const outcome = await stageXrefLoad({ hostState: hostState(), hostPath: HOST_PATH }, { reader }, { signal: controller.signal });
    expect(outcome.cancelled).toBe(true);
    expect(outcome.snapshot).toBeNull();
    expect(reads).toBe(1);
  });

  it('an authorization gate that aborts and then rejects is a cancellation, not a denial', async () => {
    const controller = new AbortController();
    const outcome = await stageXrefLoad(
      { references: [{ blockName: 'L', path: 'leaf.dxf' }], hostPath: '/proj/host.dxf' },
      {
        reader: fakeReader((() => { const f = projectFiles(); f.set('/proj/leaf.dxf', fixture('leaf.dxf')); return f; })()),
        authorize: () => {
          controller.abort();
          throw new Error('gate exploded');
        },
      },
      { signal: controller.signal },
    );
    expect(outcome.cancelled).toBe(true);
    expect(outcome.fatal).toBe(true);
    expect(outcome.snapshot).toBeNull();
    expect(outcome.failures[0]).toMatchObject({ kind: 'cancelled' });
  });

  it('a parser that aborts and returns a valid state is a cancellation, never a successful stage', async () => {
    const controller = new AbortController();
    const files = projectFiles();
    files.set('/proj/leaf.dxf', fixture('leaf.dxf'));
    const outcome = await stageXrefLoad(
      { references: [{ blockName: 'L', path: 'leaf.dxf' }], hostPath: '/proj/host.dxf' },
      {
        reader: fakeReader(files),
        parse: (text: string) => {
          controller.abort();
          return readDxf(text);
        },
      },
      { signal: controller.signal },
    );
    expect(outcome.cancelled).toBe(true);
    expect(outcome.snapshot).toBeNull();
    expect(outcome.failures[0]).toMatchObject({ kind: 'cancelled' });
  });
});

describe('runtime immutability of published snapshots (20.1)', () => {
  it('staged snapshots are sealed copies: mutation attempts do not take effect, caller/parser objects stay unfrozen', async () => {
    const files = projectFiles();
    files.set('/proj/leaf.dxf', fixture('leaf.dxf'));
    const callerState = readDxf(fixture('leaf.dxf'));
    const outcome = await stageXrefLoad(
      { references: [{ blockName: 'L', path: 'leaf.dxf' }], hostPath: '/proj/host.dxf' },
      { reader: fakeReader(files), parse: () => callerState },
    );
    const snap = outcome.snapshot!;
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.nodes[0]!)).toBe(true);
    expect(Reflect.set(snap.nodes[0]!, 'status', 'missing')).toBe(false);
    expect(snap.nodes[0]!.status).toBe('loaded');
    const file = snap.files['path:/proj/leaf.dxf']!;
    expect(file.state).not.toBe(callerState); // the snapshot owns a copy
    expect(Object.isFrozen(callerState)).toBe(false); // the parser's object was not frozen in place
    expect(Reflect.set(file, 'byteLength', 1)).toBe(false);
    expect(file.byteLength).toBeGreaterThan(1);
  });

  it('committed snapshots are a separate sealed graph from staged output, and earlier publications never change', async () => {
    const store = new XrefStore();
    const first = await store.load({ hostState: hostState(), hostPath: HOST_PATH }, { reader: fakeReader() });
    expect(first.committed).toBe(true);
    expect(first.current).not.toBe(first.staged);
    expect(first.current!.nodes[0]).not.toBe(first.staged!.nodes[0]);
    expect(Reflect.set(first.staged!.nodes[0]!, 'status', 'missing')).toBe(false);
    expect(first.current!.nodes[0]!.status).toBe('loaded');
    const kept = first.current!;
    const reader2 = fakeReader();
    reader2.files.set('/proj/parts/child.dxf', fixture('child.dxf').replace('9.0', '8.0'));
    const second = await store.refresh({ hostState: hostState(), hostPath: HOST_PATH }, { reader: reader2 });
    expect(second.committed).toBe(true);
    expect(store.current).not.toBe(kept);
    expect(kept.generation).toBe(1);
    expect(kept.nodes.map((n) => n.status)).toEqual(['loaded', 'loaded', 'loaded']);
    expect(Reflect.set(kept.nodes[0]!, 'status', 'missing')).toBe(false);
    expect(kept.nodes[0]!.status).toBe('loaded');
  });
});

/** A reader whose reads stay pending until the test resolves them (and which ignores abort). */
class DeferredReader implements XrefFileReader {
  readonly pending: Array<{ path: string; resolve: (r: XrefReadResult) => void }> = [];
  readonly files = projectFiles();
  readText(path: string): Promise<XrefReadResult> {
    return new Promise<XrefReadResult>((resolve) => {
      this.pending.push({ path, resolve });
    });
  }
  /** Resolve every currently pending read from the fixture map, repeatedly, until none remain. */
  async drain(): Promise<void> {
    for (let round = 0; round < 50; round += 1) {
      await new Promise((r) => setImmediate(r));
      const batch = this.pending.splice(0);
      if (!batch.length) return;
      for (const p of batch) {
        const text = this.files.get(p.path);
        p.resolve(text ?? (() => { throw new Error('unexpected path ' + p.path); })());
      }
    }
    throw new Error('drain did not settle');
  }
}

describe('stale publication (20.1)', () => {
  it('an older load finishing after a newer one does not overwrite it, even though its reader ignored abort', async () => {
    const store = new XrefStore();
    const deferred = new DeferredReader();
    const slow = store.load({ hostState: hostState(), hostPath: HOST_PATH }, { reader: deferred });
    const fast = await store.load({ hostState: hostState(), hostPath: HOST_PATH }, { reader: fakeReader() });
    expect(fast.committed).toBe(true);
    expect(store.generation).toBe(1);
    await deferred.drain();
    const staleResult = await slow;
    expect(staleResult.committed).toBe(false);
    expect(staleResult.stale).toBe(true);
    expect(staleResult.preserved).toBe(true);
    expect(store.current).toBe(fast.current);
    expect(store.generation).toBe(1);
  });

  it('a newer FAILED attempt supersedes an older in-flight completion', async () => {
    const store = new XrefStore();
    const deferred = new DeferredReader();
    const slow = store.load({ hostState: hostState(), hostPath: HOST_PATH }, { reader: deferred });
    const failing = await store.load({ references: [{ blockName: 'GONE', path: 'gone.dxf' }], hostPath: '/proj/host.dxf' }, { reader: fakeReader() });
    expect(failing.committed).toBe(false);
    await deferred.drain();
    const staleResult = await slow;
    expect(staleResult.stale).toBe(true);
    expect(staleResult.committed).toBe(false);
    expect(store.current).toBeNull();
  });

  it('host replacement invalidates an in-flight attempt and its result is not resurrected', async () => {
    const store = new XrefStore();
    const deferred = new DeferredReader();
    const slow = store.load({ hostState: hostState(), hostPath: HOST_PATH }, { reader: deferred });
    store.bindHost('/proj/other/host.dxf');
    await deferred.drain();
    const result = await slow;
    expect(result.stale).toBe(true);
    expect(result.committed).toBe(false);
    expect(store.current).toBeNull();
    expect(store.boundHost).toBe('/proj/other/host.dxf');
    // A load for the new host (explicitly bound) commits normally.
    const next = await store.load({ references: [{ blockName: 'L', path: '/proj/shared/leaf.dxf' }], hostPath: '/proj/other/host.dxf' }, { reader: fakeReader() }, { hostKey: '/proj/other/host.dxf' });
    expect(next.committed).toBe(true);
  });

  it('host closure drops the graph and invalidates an in-flight refresh', async () => {
    const store = new XrefStore();
    const first = await store.load({ hostState: hostState(), hostPath: HOST_PATH }, { reader: fakeReader() });
    expect(first.committed).toBe(true);
    const deferred = new DeferredReader();
    const slow = store.refresh({ hostState: hostState(), hostPath: HOST_PATH }, { reader: deferred });
    store.close();
    expect(store.current).toBeNull();
    await deferred.drain();
    const result = await slow;
    expect(result.stale).toBe(true);
    expect(result.committed).toBe(false);
    expect(store.current).toBeNull(); // not resurrected
  });

  it('cancellation arriving after staging but before publication preserves the last good graph', async () => {
    const store = new XrefStore();
    const first = await store.load({ hostState: hostState(), hostPath: HOST_PATH }, { reader: fakeReader() });
    const kept = first.current;
    const controller = new AbortController();
    const files = projectFiles();
    files.set('/proj/leaf.dxf', fixture('leaf.dxf'));
    const result = await store.refresh(
      { references: [{ blockName: 'L', path: 'leaf.dxf' }], hostPath: '/proj/host.dxf' },
      {
        reader: fakeReader(files),
        parse: (text: string) => {
          queueMicrotask(() => controller.abort()); // fires after staging, before publication
          return readDxf(text);
        },
      },
      { signal: controller.signal },
    );
    expect(result.committed).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(store.current).toBe(kept);
  });
});

describe('atomic store and refresh (20.1 semantics)', () => {
  it('commits a successful load, then a failed refresh preserves the last successful snapshot exactly', async () => {
    const reader = fakeReader();
    const store = new XrefStore();
    const first = await store.load({ hostState: hostState(), hostPath: HOST_PATH }, { reader });
    expect(first.committed).toBe(true);
    expect(store.current!.generation).toBe(1);
    const kept = store.current;
    reader.files.delete('/proj/shared/leaf.dxf');
    const failed = await store.refresh({ hostState: hostState(), hostPath: HOST_PATH }, { reader });
    expect(failed.committed).toBe(false);
    expect(failed.preserved).toBe(true);
    expect(failed.failures).toEqual([expect.objectContaining({ kind: 'missing', resolvedPath: '/proj/shared/leaf.dxf' })]);
    expect(store.current).toBe(kept);
    expect(store.generation).toBe(1);
    reader.files.set('/proj/shared/leaf.dxf', fixture('leaf.dxf'));
    const second = await store.refresh({ hostState: hostState(), hostPath: HOST_PATH }, { reader });
    expect(second.committed).toBe(true);
    expect(store.generation).toBe(2);
    expect(store.current).not.toBe(kept);
  });

  it('a PARTIAL refresh never publishes: it returns an inspection candidate and keeps the last good graph', async () => {
    const reader = fakeReader();
    const store = new XrefStore();
    const first = await store.load({ hostState: hostState(), hostPath: HOST_PATH }, { reader });
    const kept = first.current;
    reader.files.delete('/proj/shared/leaf.dxf'); // an existing resolved dependency becomes missing
    const result = await store.refresh({ hostState: hostState(), hostPath: HOST_PATH }, { reader }, { mode: 'partial' });
    expect(result.committed).toBe(false);
    expect(result.preserved).toBe(true);
    expect(store.current).toBe(kept);
    expect(result.staged).not.toBeNull();
    expect(result.staged).not.toBe(kept);
    expect(result.staged!.nodes.map((n) => n.status)).toEqual(['loaded', 'missing', 'loaded']);
    expect(result.staged!.failures).toEqual([expect.objectContaining({ kind: 'missing', resolvedPath: '/proj/shared/leaf.dxf' })]);
  });

  it('a partial refresh where a dependency becomes DENIED is likewise candidate-only', async () => {
    const reader = fakeReader();
    const store = new XrefStore();
    await store.load({ hostState: hostState(), hostPath: HOST_PATH }, { reader });
    const kept = store.current;
    const result = await store.refresh(
      { hostState: hostState(), hostPath: HOST_PATH },
      { reader, authorize: (p) => !p.endsWith('leaf.dxf') },
      { mode: 'partial' },
    );
    expect(result.committed).toBe(false);
    expect(store.current).toBe(kept);
    expect(result.staged!.failures).toEqual([expect.objectContaining({ kind: 'denied', resolvedPath: '/proj/shared/leaf.dxf' })]);
  });

  it('a partial LOAD (no last-good graph yet) may publish the partial snapshot', async () => {
    const reader = fakeReader();
    reader.files.delete('/proj/shared/leaf.dxf');
    const store = new XrefStore();
    const result = await store.load({ hostState: hostState(), hostPath: HOST_PATH }, { reader }, { mode: 'partial' });
    expect(result.committed).toBe(true);
    expect(store.current!.nodes.map((n) => n.status)).toEqual(['loaded', 'missing', 'loaded']);
    expect(store.current!.failures).toEqual([expect.objectContaining({ kind: 'missing' })]);
  });

  it('a complete partial refresh on a fresh store commits', async () => {
    const store = new XrefStore();
    const result = await store.refresh({ hostState: hostState(), hostPath: HOST_PATH }, { reader: fakeReader() }, { mode: 'partial' });
    expect(result.committed).toBe(true);
    expect(store.current!.generation).toBe(1);
  });

  it('a cancelled refresh preserves the current snapshot', async () => {
    const reader = fakeReader();
    const store = new XrefStore();
    await store.load({ hostState: hostState(), hostPath: HOST_PATH }, { reader });
    const kept = store.current;
    const controller = new AbortController();
    controller.abort();
    const result = await store.refresh({ hostState: hostState(), hostPath: HOST_PATH }, { reader }, { signal: controller.signal });
    expect(result).toMatchObject({ committed: false, preserved: true, cancelled: true });
    expect(store.current).toBe(kept);
  });

  it('partial load still refuses to commit on a fatal limit', async () => {
    const store = new XrefStore();
    const result = await store.load({ hostState: hostState(), hostPath: HOST_PATH }, { reader: fakeReader() }, { mode: 'partial', limits: { maxTotalBytes: 10 } });
    expect(result.committed).toBe(false);
    expect(store.current).toBeNull();
  });
});

describe('20.1 round-2 review regressions', () => {
  const hostId = { id: 'HOST', owningLocation: '/proj/host.dxf', version: 'v1' };

  it('item 1: a read whose version disagrees with the identified snapshot is rejected, never tagged with the identified version', async () => {
    const reader: XrefFileReader & { calls: string[] } = {
      calls: [],
      identify: async (path: string) => (path === '/proj/host.dxf' ? hostId : { id: 'F1', owningLocation: '/proj/leaf.dxf', version: 'v1' }),
      async readText(path: string): Promise<XrefReadResult> {
        this.calls.push(path);
        return { text: fixture('leaf.dxf'), version: 'v2' }; // content is NOT the identified v1 snapshot
      },
    };
    const outcome = await stageXrefLoad({ references: [{ blockName: 'L', path: 'leaf.dxf' }], hostPath: '/proj/host.dxf' }, { reader });
    expect(outcome.snapshot!.nodes[0]!.status).toBe('inconsistent-version');
    expect(outcome.snapshot!.stats.filesLoaded).toBe(0);
    expect(Object.keys(outcome.snapshot!.files)).toEqual([]);
  });

  it('item 1 (store preservation): the same disagreement on refresh leaves the last good graph published', async () => {
    let readVersion = 'v1';
    const reader: XrefFileReader = {
      identify: async (path: string) => (path === HOST_PATH ? { id: 'HOST', owningLocation: HOST_PATH, version: 'v1' } : { id: `F:${path}`, owningLocation: path, version: 'v1' }),
      async readText(): Promise<XrefReadResult> {
        return { text: fixture('leaf.dxf'), version: readVersion };
      },
    };
    const store = new XrefStore();
    const refs: XrefReferenceInput[] = [{ blockName: 'L', path: '/proj/shared/leaf.dxf' }];
    const first = await store.load({ references: refs, hostPath: HOST_PATH }, { reader });
    expect(first.committed).toBe(true);
    const kept = store.current;
    readVersion = 'v2';
    const second = await store.refresh({ references: refs, hostPath: HOST_PATH }, { reader });
    expect(second.committed).toBe(false);
    expect(store.current).toBe(kept);
    expect(second.staged!.nodes[0]!.status).toBe('inconsistent-version');
  });

  it('item 2: one identity with two owning locations is refused on the second alias; the single stable anchor is kept', async () => {
    const files = projectFiles();
    files.set('/proj/left/parent.dxf', fixture('child.dxf')); // refs grand.dxf
    files.set('/proj/right/parent.dxf', fixture('child.dxf'));
    files.set('/left/grand.dxf', fixture('grand.dxf'));
    const reader = fakeReader(files, (path) => {
      if (path === '/proj/host.dxf') return hostId;
      if (path === '/proj/left/parent.dxf') return { id: 'SHARED', owningLocation: '/left/parent.dxf', version: 'v1' };
      if (path === '/proj/right/parent.dxf') return { id: 'SHARED', owningLocation: '/right/parent.dxf', version: 'v1' };
      if (path === '/left/grand.dxf') return { id: 'G', owningLocation: path, version: 'v1' };
      return null;
    });
    const refs: XrefReferenceInput[] = [
      { blockName: 'L', path: 'left/parent.dxf' },
      { blockName: 'R', path: 'right/parent.dxf' },
    ];
    const outcome = await stageXrefLoad({ references: refs, hostPath: '/proj/host.dxf' }, { reader });
    const [l, r] = outcome.snapshot!.nodes;
    expect(l!.status).toBe('loaded');
    expect(l!.children[0]).toMatchObject({ status: 'loaded', resolvedPath: '/left/grand.dxf' });
    expect(r!.status).toBe('inconsistent-location');
    expect(outcome.failures).toEqual([expect.objectContaining({ kind: 'inconsistent-location', blockName: 'R' })]);
    expect(reader.calls).toEqual(['/proj/left/parent.dxf', '/left/grand.dxf']); // no read under the second anchor
    const record = outcome.snapshot!.files['id:SHARED']!;
    expect(record.owningLocation).toBe('/left/parent.dxf'); // the first, stable anchor
    expect(record.occurrences.map((o) => o.blockName)).toEqual(['L']); // the rejected alias is not recorded as a use
  });

  it('item 3: host identification returning null fails closed — the SELF edge is never read as external geometry', async () => {
    const files = projectFiles();
    files.set('/proj/drawings/host.dxf', fixture('host.dxf'));
    const reader = fakeReader(files, (_path, ctx) => {
      // The regression's adapter: null at depth 0 (the host), the
      // canonical host identity at depth 1 (a SELF root reference).
      return ctx.depth === 0 ? null : { id: 'HOST', owningLocation: '/proj/drawings/host.dxf', version: 'v1' };
    });
    const outcome = await stageXrefLoad({ references: [{ blockName: 'SELF', path: 'host.dxf' }], hostPath: '/proj/drawings/host.dxf' }, { reader });
    expect(reader.calls).toEqual([]);
    expect(outcome.snapshot).not.toBeNull(); // an explicit incomplete candidate
    expect(outcome.snapshot!.nodes[0]!.status).toBe('unresolved-location');
    expect(outcome.failures[0]).toMatchObject({ kind: 'unresolved-location', blockName: '' });
    expect(outcome.snapshot!.stats.filesLoaded).toBe(0);
  });

  it('item 3b: host identification throwing also fails closed', async () => {
    const reader: XrefFileReader & { calls: string[] } = {
      calls: [],
      identify: async () => {
        throw new Error('identity service unavailable');
      },
      async readText(path: string): Promise<XrefReadResult> {
        this.calls.push(path);
        return fixture('leaf.dxf');
      },
    };
    const outcome = await stageXrefLoad({ references: [{ blockName: 'L', path: '/proj/shared/leaf.dxf' }], hostPath: '/proj/host.dxf' }, { reader });
    expect(reader.calls).toEqual([]);
    expect(outcome.snapshot!.nodes[0]!.status).toBe('unresolved-location');
  });

  it('item 4: actual delivered bytes break the total budget fatally BEFORE any response-consistency diagnostic, in every mode', async () => {
    const reader: XrefFileReader = {
      async readText(): Promise<XrefReadResult> {
        return { text: '12345678901', byteLength: 999 }; // 11 actual bytes, false declaration
      },
    };
    const outcome = await stageXrefLoad(
      { references: [{ blockName: 'A', path: 'a.dxf' }], hostPath: '/proj/host.dxf' },
      { reader },
      { limits: { maxFileBytes: 1000, maxTotalBytes: 10 } },
    );
    expect(outcome.fatal).toBe(true);
    expect(outcome.snapshot).toBeNull();
    expect(outcome.failures[0]).toMatchObject({ kind: 'total-limit' });
    // And through the store, in partial mode: last good is preserved.
    const store = new XrefStore();
    const good = await store.load({ hostState: hostState(), hostPath: HOST_PATH }, { reader: fakeReader() });
    const kept = good.current;
    const result = await store.refresh(
      { references: [{ blockName: 'A', path: 'a.dxf' }], hostPath: '/proj/host.dxf' },
      { reader },
      { mode: 'partial', limits: { maxFileBytes: 1000, maxTotalBytes: 10 } },
    );
    expect(result.committed).toBe(false);
    expect(store.current).toBe(kept);
  });

  it('item 5: maxFiles counts admitted sources — a failed parse still consumes the slot, so the second distinct source is never read', async () => {
    const reader = fakeReader(projectFiles());
    const refs: XrefReferenceInput[] = [
      { blockName: 'BAD', path: 'bad.dxf' }, // /proj/drawings/bad.dxf: reads, parse fails
      { blockName: 'LEAF', path: '../shared/leaf.dxf' },
    ];
    const outcome = await stageXrefLoad({ references: refs, hostPath: '/proj/drawings/host.dxf' }, { reader }, { limits: { maxFiles: 1 } });
    expect(reader.calls).toEqual(['/proj/drawings/bad.dxf']);
    expect(outcome.fatal).toBe(true);
    expect(outcome.failures[0]).toMatchObject({ kind: 'total-limit' });
  });

  it('item 6: partial publication is initial-only — a second load in partial mode with a missing dependency preserves the graph', async () => {
    const reader = fakeReader();
    const store = new XrefStore();
    const first = await store.load({ hostState: hostState(), hostPath: HOST_PATH }, { reader });
    expect(first.committed).toBe(true);
    const kept = store.current;
    reader.files.delete('/proj/shared/leaf.dxf');
    const second = await store.load({ hostState: hostState(), hostPath: HOST_PATH }, { reader }, { mode: 'partial' });
    expect(second.committed).toBe(false);
    expect(second.preserved).toBe(true);
    expect(store.current).toBe(kept);
    expect(second.staged).not.toBeNull();
    expect(second.staged!.nodes.map((n) => n.status)).toEqual(['loaded', 'missing', 'loaded']);
  });

  it('item 7: identification refusals keep their missing/denied classification and schedule no read', async () => {
    const reader: XrefFileReader & { calls: string[] } = {
      calls: [],
      identify: async (path: string) => {
        if (path === '/proj/host.dxf') return hostId;
        if (path === '/proj/gone.dxf') throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
        if (path === '/proj/secret.dxf') throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        return { id: `F:${path}`, owningLocation: path, version: 'v1' };
      },
      async readText(path: string): Promise<XrefReadResult> {
        this.calls.push(path);
        return fixture('leaf.dxf');
      },
    };
    const refs: XrefReferenceInput[] = [
      { blockName: 'GONE', path: 'gone.dxf' },
      { blockName: 'SECRET', path: 'secret.dxf' },
    ];
    const outcome = await stageXrefLoad({ references: refs, hostPath: '/proj/host.dxf' }, { reader });
    expect(outcome.snapshot!.nodes.map((n) => n.status)).toEqual(['missing', 'denied']);
    expect(outcome.failures.map((f) => [f.kind, f.blockName, f.resolvedPath])).toEqual([
      ['missing', 'GONE', '/proj/gone.dxf'],
      ['denied', 'SECRET', '/proj/secret.dxf'],
    ]);
    expect(reader.calls).toEqual([]);
  });
});

describe('20.1 round-3 host evidence validation', () => {
  const HOST2 = '/proj/drawings/host.dxf';
  const VALID_HOST2: XrefFileIdentity = { id: 'HOST', owningLocation: HOST2, version: 'host-v1' };
  const invalidCases: ReadonlyArray<{ label: string; evidence: XrefFileIdentity; reference: XrefReferenceInput }> = [
    {
      label: 'empty identity with an absolute owning location',
      evidence: { id: '', owningLocation: HOST2, version: 'host-v1' },
      // A valid identification of SELF must not turn the invalid host
      // seed (`id:`) into permission to reload the host externally.
      reference: { blockName: 'SELF', path: 'host.dxf' },
    },
    {
      label: 'nonempty identity with a relative owning location',
      evidence: { id: 'HOST', owningLocation: 'relative/host.dxf', version: 'host-v1' },
      // An absolute non-host target, so no incidental cycle/path
      // failure can hide acceptance of the invalid owning location.
      reference: { blockName: 'LEAF', path: '/proj/shared/leaf.dxf' },
    },
  ];

  for (const origin of ['adapter', 'caller'] as const) {
    for (const { label, evidence, reference } of invalidCases) {
      it(`fails closed for ${label} (evidence from ${origin})`, async () => {
        const identified: Array<{ path: string; depth: number }> = [];
        const readPaths: string[] = [];
        const reader: XrefFileReader = {
          async identify(path: string, context: { depth: number }) {
            identified.push({ path, depth: context.depth });
            if (context.depth === 0) return evidence;
            if (path === HOST2) return VALID_HOST2;
            if (path === '/proj/shared/leaf.dxf') return { id: 'LEAF', owningLocation: path, version: 'leaf-v1' };
            throw new Error(`unexpected identification: ${path}`);
          },
          async readText(path: string): Promise<XrefReadResult> {
            readPaths.push(path);
            return fixture('leaf.dxf');
          },
        };
        const outcome = await stageXrefLoad(
          { references: [reference], hostPath: HOST2, ...(origin === 'caller' ? { hostIdentity: evidence } : {}) },
          { reader },
        );
        // Adapter evidence: exactly one identification (the host itself).
        // Caller evidence: the adapter is never consulted at all.
        expect(identified).toEqual(origin === 'adapter' ? [{ path: HOST2, depth: 0 }] : []);
        expect(readPaths).toEqual([]);
        expect(outcome.failures).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'unresolved-location', blockName: '', depth: 0 })]));
        expect(outcome.snapshot?.stats.filesLoaded ?? 0).toBe(0);
        expect(outcome.snapshot?.nodes.some((n) => n.status === 'loaded') ?? false).toBe(false);
        expect(outcome.snapshot?.nodes[0]?.status).toBe('unresolved-location');
        expect(outcome.snapshot?.hostIdentity).toBeUndefined(); // invalid evidence is not recorded as the host identity
      });
    }
  }

  it('valid host evidence control: a valid canonical host identity loads normally (adapter origin)', async () => {
    const files = projectFiles();
    files.set('/proj/shared/leaf.dxf', fixture('leaf.dxf'));
    const reader = fakeReader(files, (path) => {
      if (path === HOST2) return VALID_HOST2;
      if (path === '/proj/shared/leaf.dxf') return { id: 'LEAF', owningLocation: path, version: 'leaf-v1' };
      return null;
    });
    const outcome = await stageXrefLoad({ references: [{ blockName: 'LEAF', path: '/proj/shared/leaf.dxf' }], hostPath: HOST2 }, { reader });
    expect(outcome.failures).toEqual([]);
    expect(outcome.snapshot!.nodes[0]!.status).toBe('loaded');
    expect(outcome.snapshot!.hostIdentity).toBe('HOST');
  });

  it('store preservation: a refresh carrying invalid caller host evidence preserves the last good graph', async () => {
    const reader = fakeReader();
    const store = new XrefStore();
    const first = await store.load({ hostState: hostState(), hostPath: HOST_PATH, hostIdentity: { id: 'HOST', owningLocation: HOST_PATH } }, { reader });
    expect(first.committed).toBe(true);
    const kept = store.current;
    const result = await store.refresh(
      { hostState: hostState(), hostPath: HOST_PATH, hostIdentity: { id: '', owningLocation: HOST_PATH } },
      { reader },
    );
    expect(result.committed).toBe(false);
    expect(store.current).toBe(kept);
    expect(result.staged).not.toBeNull();
    expect(result.staged!.nodes.every((n) => n.status === 'unresolved-location')).toBe(true);
  });
});
