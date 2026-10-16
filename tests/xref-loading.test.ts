/**
 * Milestone 20: DXF external-reference loading / refresh core.
 *
 * All file access is a fake in-memory reader over the authored fixtures in
 * tests/fixtures/xref/, mapped onto a virtual project layout:
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
 * These are headless checks only; Windows/application validation is
 * pending (see docs/XREF-LOADING-CORE.md).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDxf, writeDxf } from '../src/io/dxf';
import {
  collectXrefReferences,
  normalizeCadPath,
  resolveXrefPath,
  cadPathKey,
  stageXrefLoad,
  externalContent,
  XrefStore,
  type XrefFileReader,
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
    ['/proj/drawings/bad.dxf', fixture('bad.dxf')],
  ]);
}

interface FakeReader extends XrefFileReader {
  readonly calls: string[];
  readonly files: Map<string, string>;
}

function fakeReader(files = projectFiles()): FakeReader {
  const calls: string[] = [];
  return {
    calls,
    files,
    async readText(resolvedPath: string): Promise<string> {
      calls.push(resolvedPath);
      const text = files.get(resolvedPath);
      if (text === undefined) {
        const error = new Error(`ENOENT: no such file or directory, open '${resolvedPath}'`) as Error & { code?: string };
        error.code = 'ENOENT';
        throw error;
      }
      return text;
    },
  };
}

const hostState = () => readDxf(fixture('host.dxf'));

describe('path resolution', () => {
  it('normalizes drive, UNC, rooted and relative paths and folds dot segments', () => {
    expect(normalizeCadPath('C:\\proj\\parts\\..\\shared\\leaf.dxf')).toBe('C:/proj/shared/leaf.dxf');
    expect(normalizeCadPath('\\\\server\\share\\a\\..\\b.dxf')).toBe('//server/share/b.dxf');
    expect(normalizeCadPath('/proj/./parts/child.dxf')).toBe('/proj/parts/child.dxf');
    expect(normalizeCadPath('../up.dxf')).toBe('../up.dxf');
    expect(normalizeCadPath('/../clamped.dxf')).toBe('/clamped.dxf');
  });

  it('resolves relative paths against the containing file, never the root drawing', () => {
    expect(resolveXrefPath('../parts/child.dxf', HOST_PATH)).toBe('/proj/parts/child.dxf');
    expect(resolveXrefPath('grand.dxf', '/proj/parts/child.dxf')).toBe('/proj/parts/grand.dxf');
    expect(resolveXrefPath('..\\shared\\leaf.dxf', HOST_PATH)).toBe('/proj/shared/leaf.dxf');
    expect(resolveXrefPath('C:\\abs\\file.dxf', HOST_PATH)).toBe('C:/abs/file.dxf');
    expect(resolveXrefPath('loose.dxf', null)).toBe('loose.dxf');
  });

  it('compares Windows-style paths case-insensitively and POSIX paths case-sensitively', () => {
    expect(cadPathKey('C:\\Proj\\Leaf.dxf')).toBe(cadPathKey('c:/proj/leaf.dxf'));
    expect(cadPathKey('/Proj/Leaf.dxf')).not.toBe(cadPathKey('/proj/leaf.dxf'));
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
    // The root overlay's own attached child IS carried: overlay on an edge
    // only stops that reference from being carried above its immediate host.
    expect(ovlroot!.children[0]).toMatchObject({ blockName: 'KID', resolvedPath: '/proj/drawings/kid.dxf', depth: 2, status: 'loaded' });
    expect(snap.stats.filesLoaded).toBe(5);
    expect(snap.stats.referencesSeen).toBe(5);
    expect(snap.stats.totalEntities).toBe(2 + 2 + 1 + 2 + 1); // child(line+insert) grand(1) leaf(2) overlay-root(line+insert) kid(1)
    expect(snap.stats.totalBytes).toBeGreaterThan(0);
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
    expect(outcome.snapshot!.files['/proj/drawings/inner.dxf']).toBeUndefined();
  });

  it('keeps loaded geometry separate from the host drawing and never mutates the host', async () => {
    const host = hostState();
    const before = JSON.stringify(host);
    const outcome = await stageXrefLoad({ hostState: host, hostPath: HOST_PATH }, { reader: fakeReader() });
    expect(JSON.stringify(host)).toBe(before);
    // The host's xref block definitions still hold no entities and their
    // original paths: nothing was merged in or rewritten.
    expect(host.blocks.CHILD!.entities).toHaveLength(0);
    expect(host.blocks.CHILD!.xref).toEqual({ path: '../parts/child.dxf' });
    expect(writeDxf(host)).toContain('..\\shared\\leaf.dxf');
    const content = externalContent(outcome.snapshot!);
    expect(content.map((c) => c.file.resolvedPath)).toEqual([
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
    // The child file's own model content is the line + the insert of its nested block.
    expect(content[0]!.entities.map((e) => e.type)).toEqual(['line', 'insert']);
  });

  it('loads a file referenced twice once, sharing the parsed state and recording both original paths', async () => {
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
    expect(a!.status).toBe('loaded');
    expect(b!.status).toBe('loaded');
    expect(a!.fileKey).toBe(b!.fileKey);
    expect(outcome.snapshot!.stats.filesLoaded).toBe(1);
    expect(outcome.snapshot!.files['/proj/leaf.dxf']!.originalPaths).toEqual(['leaf.dxf', './leaf.dxf']);
  });

  it('a drawing with no references stages an empty snapshot', async () => {
    const reader = fakeReader();
    const outcome = await stageXrefLoad({ references: [], hostPath: HOST_PATH }, { reader });
    expect(outcome.snapshot).toMatchObject({ nodes: [], failures: [], stats: { filesLoaded: 0, referencesSeen: 0 } });
    expect(reader.calls).toEqual([]);
  });
});

describe('failures', () => {
  it('reports a missing file with its attempted resolved path, as a per-node failure', async () => {
    const refs: XrefReferenceInput[] = [
      { blockName: 'GONE', path: 'gone.dxf' },
      { blockName: 'LEAF', path: 'leaf.dxf' },
    ];
    const files = projectFiles();
    files.set('/proj/leaf.dxf', fixture('leaf.dxf'));
    const outcome = await stageXrefLoad({ references: refs, hostPath: '/proj/host.dxf' }, { reader: fakeReader(files) });
    expect(outcome.fatal).toBe(false);
    expect(outcome.failures).toEqual([
      expect.objectContaining({ kind: 'missing', blockName: 'GONE', originalPath: 'gone.dxf', resolvedPath: '/proj/gone.dxf', depth: 1 }),
    ]);
    expect(outcome.snapshot!.nodes.map((n) => n.status)).toEqual(['missing', 'loaded']);
  });

  it('detects a two-file cycle and a self-cycle, with the chain, without looping', async () => {
    const outcome = await stageXrefLoad({ references: [{ blockName: 'A', path: 'cycle-a.dxf' }], hostPath: '/proj/host.dxf' }, { reader: fakeReader() });
    const a = outcome.snapshot!.nodes[0]!;
    expect(a.status).toBe('loaded');
    const b = a.children[0]!;
    expect(b).toMatchObject({ blockName: 'CYCLEB', status: 'loaded', resolvedPath: '/proj/cycle-b.dxf' });
    // cycle-b's own reference back to cycle-a is the cycle node.
    const back = b.children[0]!;
    expect(back).toMatchObject({ blockName: 'CYCLEA', status: 'cycle', resolvedPath: '/proj/cycle-a.dxf' });
    expect(outcome.failures).toEqual([
      expect.objectContaining({ kind: 'cycle', chain: ['/proj/cycle-a.dxf', '/proj/cycle-b.dxf', '/proj/cycle-a.dxf'] }),
    ]);

    const self = await stageXrefLoad({ references: [{ blockName: 'S', path: 'self-cycle.dxf' }], hostPath: '/proj/host.dxf' }, { reader: fakeReader() });
    expect(self.snapshot!.nodes[0]!.children[0]).toMatchObject({ status: 'cycle', resolvedPath: '/proj/self-cycle.dxf' });
    expect(self.failures[0]).toMatchObject({ kind: 'cycle' });
  });

  it('a denied read never reaches the reader', async () => {
    const reader = fakeReader();
    const outcome = await stageXrefLoad(
      { references: [{ blockName: 'SECRET', path: 'leaf.dxf' }], hostPath: '/proj/host.dxf' },
      { reader, authorize: (p) => !p.endsWith('leaf.dxf') },
    );
    expect(reader.calls).toEqual([]);
    expect(outcome.snapshot!.nodes[0]!.status).toBe('denied');
    expect(outcome.failures[0]).toMatchObject({ kind: 'denied', resolvedPath: '/proj/leaf.dxf' });
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
    expect(outcome.failures[0]).toMatchObject({ kind: 'unsupported-format', originalPath: 'legacy.dwg' });
  });

  it('reports an empty stored path as unresolved, without a read', async () => {
    const reader = fakeReader();
    const outcome = await stageXrefLoad({ references: [{ blockName: 'EMPTY', path: '' }], hostPath: '/proj/host.dxf' }, { reader });
    expect(reader.calls).toEqual([]);
    expect(outcome.snapshot!.nodes[0]).toMatchObject({ status: 'unresolved-path', resolvedPath: null });
  });
});

describe('resource limits', () => {
  const leafRefs: XrefReferenceInput[] = [{ blockName: 'LEAF', path: 'leaf.dxf' }];
  const leafFiles = () => {
    const files = projectFiles();
    files.set('/proj/leaf.dxf', fixture('leaf.dxf'));
    return files;
  };

  it('enforces the per-file byte limit before parsing', async () => {
    const outcome = await stageXrefLoad({ references: leafRefs, hostPath: '/proj/host.dxf' }, { reader: fakeReader(leafFiles()) }, { limits: { maxFileBytes: 64 } });
    expect(outcome.snapshot!.nodes[0]!.status).toBe('file-limit');
    expect(outcome.failures[0]).toMatchObject({ kind: 'file-limit' });
  });

  it('enforces the per-file entity limit after parsing', async () => {
    const outcome = await stageXrefLoad({ references: leafRefs, hostPath: '/proj/host.dxf' }, { reader: fakeReader(leafFiles()) }, { limits: { maxEntitiesPerFile: 1 } });
    expect(outcome.snapshot!.nodes[0]!.status).toBe('file-limit');
  });

  it('treats the cumulative byte limit as fatal: staging aborts with no snapshot', async () => {
    const outcome = await stageXrefLoad({ hostState: hostState(), hostPath: HOST_PATH }, { reader: fakeReader() }, { limits: { maxTotalBytes: 500 } });
    expect(outcome.fatal).toBe(true);
    expect(outcome.snapshot).toBeNull();
    expect(outcome.failures[0]).toMatchObject({ kind: 'total-limit' });
  });

  it('enforces the depth limit on nested references', async () => {
    const outcome = await stageXrefLoad({ hostState: hostState(), hostPath: HOST_PATH }, { reader: fakeReader() }, { limits: { maxDepth: 1 } });
    const child = outcome.snapshot!.nodes[0]!;
    expect(child.status).toBe('loaded');
    expect(child.children[0]).toMatchObject({ blockName: 'GRAND', status: 'depth-limit', depth: 2 });
    expect(outcome.failures.some((f) => f.kind === 'depth-limit')).toBe(true);
  });

  it('treats the reference-count limit as fatal', async () => {
    const outcome = await stageXrefLoad({ hostState: hostState(), hostPath: HOST_PATH }, { reader: fakeReader() }, { limits: { maxReferences: 2 } });
    expect(outcome.fatal).toBe(true);
    expect(outcome.snapshot).toBeNull();
    expect(outcome.failures[0]).toMatchObject({ kind: 'total-limit' });
  });

  it('rejects invalid limits as a programming error', async () => {
    await expect(stageXrefLoad({ references: leafRefs, hostPath: '/proj/host.dxf' }, { reader: fakeReader(leafFiles()) }, { limits: { maxDepth: 0 } })).rejects.toThrow(TypeError);
  });
});

describe('cancellation', () => {
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
      async readText(resolvedPath: string): Promise<string> {
        reads += 1;
        if (reads === 1) controller.abort();
        const text = files.get(resolvedPath);
        if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return text;
      },
    };
    const outcome = await stageXrefLoad({ hostState: hostState(), hostPath: HOST_PATH }, { reader }, { signal: controller.signal });
    expect(outcome.cancelled).toBe(true);
    expect(outcome.fatal).toBe(true);
    expect(outcome.snapshot).toBeNull();
    expect(reads).toBe(1);
  });
});

describe('atomic store and refresh', () => {
  it('commits a successful load, then a failed refresh preserves the last successful snapshot exactly', async () => {
    const reader = fakeReader();
    const store = new XrefStore();
    const first = await store.load({ hostState: hostState(), hostPath: HOST_PATH }, { reader });
    expect(first.committed).toBe(true);
    expect(store.current).toBe(first.current);
    expect(store.current!.generation).toBe(1);
    const kept = store.current;

    // The leaf file disappears and the child file changes on disk.
    reader.files.delete('/proj/shared/leaf.dxf');
    const changedChild = fixture('child.dxf').replace('9.0', '8.0');
    reader.files.set('/proj/parts/child.dxf', changedChild);

    const failed = await store.refresh({ hostState: hostState(), hostPath: HOST_PATH }, { reader });
    expect(failed.committed).toBe(false);
    expect(failed.preserved).toBe(true);
    expect(failed.failures).toEqual([expect.objectContaining({ kind: 'missing', resolvedPath: '/proj/shared/leaf.dxf' })]);
    expect(store.current).toBe(kept); // identity: the staged result was discarded, not swapped in
    expect(store.generation).toBe(1);
    expect(failed.current).toBe(kept);
    expect(failed.staged).not.toBe(kept); // staged diagnostics exist but were not committed

    // Restore the file: the next refresh commits the changed child.
    reader.files.set('/proj/shared/leaf.dxf', fixture('leaf.dxf'));
    const second = await store.refresh({ hostState: hostState(), hostPath: HOST_PATH }, { reader });
    expect(second.committed).toBe(true);
    expect(store.generation).toBe(2);
    expect(store.current).not.toBe(kept);
    const childFile = store.current!.files['/proj/parts/child.dxf']!;
    expect(childFile.byteLength).toBe(new TextEncoder().encode(changedChild).length);
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

  it('partial mode commits what loaded and records the failures in the snapshot', async () => {
    const reader = fakeReader();
    reader.files.delete('/proj/shared/leaf.dxf');
    const store = new XrefStore();
    const result = await store.load({ hostState: hostState(), hostPath: HOST_PATH }, { reader }, { mode: 'partial' });
    expect(result.committed).toBe(true);
    expect(store.current!.failures).toEqual([expect.objectContaining({ kind: 'missing', resolvedPath: '/proj/shared/leaf.dxf' })]);
    expect(store.current!.nodes.map((n) => n.status)).toEqual(['loaded', 'missing', 'loaded']);
    expect(externalContent(store.current!).map((c) => c.file.resolvedPath)).not.toContain('/proj/shared/leaf.dxf');
  });

  it('partial mode still refuses to commit on cancellation or a total limit', async () => {
    const reader = fakeReader();
    const store = new XrefStore();
    const result = await store.load({ hostState: hostState(), hostPath: HOST_PATH }, { reader }, { mode: 'partial', limits: { maxTotalBytes: 10 } });
    expect(result.committed).toBe(false);
    expect(store.current).toBeNull();
  });
});
