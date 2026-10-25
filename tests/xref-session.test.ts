/**
 * P20 slice 1 — xref session controller (design sections 1-2, A.3).
 *
 * The controller is tested against a fake FileBridge subset (the five
 * broker methods, in-memory, with per-path error scripting and a read
 * gate) plus a fake session host. No Electron, no DOM, no real files
 * beyond the DXF fixtures. Broker error conventions follow the existing
 * adapter tests: message-prefixed ERR_XREF_* errors the adapter maps to
 * the codes the core classifies by.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setPathPlatform } from '../src/app/paths';
import { readDxf } from '../src/io/dxf';
import type { DrawingState, BlockDef } from '../src/core/document';
import { collectXrefReferences } from '../src/io/xref-loading';
import {
  XrefSessionController,
  XrefSessionRegistry,
  type XrefBinding,
} from '../src/app/xref-session';
import { registerXrefCommands } from '../src/app/commands-xref';
import type { CommandDef, FileBridge } from '../src/app/editor/types';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'xref', name), 'utf8');

const HOST_PATH = '/proj/drawings/host.dxf';

function projectFiles(): Map<string, string> {
  return new Map<string, string>([
    [HOST_PATH, fixture('host.dxf')],
    ['/proj/parts/child.dxf', fixture('child.dxf')],
    ['/proj/parts/grand.dxf', fixture('grand.dxf')],
    ['/proj/shared/leaf.dxf', fixture('leaf.dxf')],
    ['/proj/drawings/overlay-root.dxf', fixture('overlay-root.dxf')],
    ['/proj/drawings/kid.dxf', fixture('kid.dxf')],
    ['/proj/drawings/overlay-parent.dxf', fixture('overlay-parent.dxf')],
    ['/proj/drawings/inner.dxf', fixture('inner.dxf')],
    ['/proj/cycle-a.dxf', fixture('cycle-a.dxf')],
    ['/proj/cycle-b.dxf', fixture('cycle-b.dxf')],
    ['/proj/drawings/bad.dxf', fixture('broken/bad.dxf')],
    ['/proj/host-dwg.dxf', fixture('host-dwg.dxf')],
  ]);
}

const hash = (text: string): string => {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return String(h >>> 0);
};
const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/'));

class FakeBroker {
  readonly calls: Array<{ method: string; path?: string }> = [];
  readonly denyIdentify = new Set<string>();
  readonly denyRead = new Set<string>();
  readonly readVersionOverride = new Map<string, string>();
  private gate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;

  constructor(readonly files: Map<string, string>) {}

  holdReads(): void { this.gate = new Promise<void>((resolve) => { this.releaseGate = resolve; }); }
  releaseReads(): void { this.releaseGate?.(); this.gate = null; }
  count(method: string): number { return this.calls.filter((c) => c.method === method).length; }
  paths(method: string): string[] { return this.calls.filter((c) => c.method === method).map((c) => c.path!); }

  async beginXrefContext(_info: { docId: string; contentGeneration: number | string; hostAnchor: string }): Promise<{ token: string }> {
    this.calls.push({ method: 'begin' });
    return { token: `tok-${this.count('begin')}` };
  }
  async identifyXref(_token: string, path: string): Promise<{ ticket: string; identity: { id: string; owningLocation: string; version: string } }> {
    this.calls.push({ method: 'identify', path });
    if (this.denyIdentify.has(path)) throw new Error('ERR_XREF_DENIED: not readable by name');
    const text = this.files.get(path);
    if (text === undefined) throw new Error('ERR_XREF_MISSING: no readable file');
    return { ticket: path, identity: { id: `id:${path}`, owningLocation: path, version: `v:${hash(text)}` } };
  }
  async readXref(_token: string, ticket: string, _maxBytes: number): Promise<{ text: string; byteLength: number; version: string }> {
    this.calls.push({ method: 'read', path: ticket });
    if (this.gate) await this.gate;
    if (this.denyRead.has(ticket)) throw new Error('ERR_XREF_DENIED: not readable by name');
    const text = this.files.get(ticket);
    if (text === undefined) throw new Error('ERR_XREF_MISSING: no readable file');
    return { text, byteLength: Buffer.byteLength(text, 'utf8'), version: this.readVersionOverride.get(ticket) ?? `v:${hash(text)}` };
  }
  async cancelXref(_token: string): Promise<boolean> { this.calls.push({ method: 'cancel' }); return true; }
  async closeXrefContext(_token: string): Promise<boolean> { this.calls.push({ method: 'close' }); return true; }
}

interface Harness {
  controller: XrefSessionController;
  broker: FakeBroker;
  host: { binding: XrefBinding; state: DrawingState };
  logs: string[];
  changes: () => number;
}

function harness(opts: {
  hostName?: string;
  hostPath?: string;
  files?: Map<string, string>;
  bridge?: () => FileBridge | null;
} = {}): Harness {
  const hostPath = opts.hostPath ?? HOST_PATH;
  const broker = new FakeBroker(opts.files ?? projectFiles());
  const host = {
    binding: { docId: 'doc-1', contentGeneration: 1, filePath: hostPath } as XrefBinding,
    state: readDxf(fixture(opts.hostName ?? 'host.dxf')),
  };
  const logs: string[] = [];
  let changeCount = 0;
  const controller = new XrefSessionController({
    bridge: opts.bridge ?? (() => broker as unknown as FileBridge),
    getBinding: () => host.binding,
    getState: () => host.state,
    onSnapshotChanged: () => { changeCount += 1; },
    log: (text) => logs.push(text),
  });
  return { controller, broker, host, logs, changes: () => changeCount };
}

const layer0 = { name: '0', color: 7, visible: true, locked: false, lineWeight: -1 };
const xrefBlock = (name: string, path: string, overlay = false): BlockDef => ({
  name, basePoint: { x: 0, y: 0 }, entities: [], attributes: [], xref: { path, ...(overlay ? { overlay: true } : {}) },
});
const synthState = (blocks: Record<string, BlockDef>): DrawingState => ({
  entities: [], layers: [layer0], blocks, currentLayer: '0',
}) as DrawingState;

beforeAll(() => setPathPlatform('posix'));
afterAll(() => setPathPlatform(null));

describe('controller lifecycle (S)', () => {
  it('S1: an unsaved or relative-path host is inert and never touches the broker', async () => {
    const h = harness();
    h.host.binding = { docId: 'doc-1', contentGeneration: 1, filePath: null };
    h.controller.bind();
    await h.controller.whenIdle();
    expect(h.controller.status().live).toBe(false);
    expect(h.controller.status().inertReason).toBe('unsaved-host');
    expect(h.broker.calls).toEqual([]);
    h.host.binding = { docId: 'doc-1', contentGeneration: 1, filePath: 'drawings/host.dxf' };
    h.controller.bind();
    await h.controller.whenIdle();
    expect(h.controller.status().inertReason).toBe('unsaved-host');
    expect(h.broker.calls).toEqual([]);
  });

  it('S2: a bridge without the xref methods is inert (no-bridge)', async () => {
    const h = harness({ bridge: () => null });
    h.controller.bind();
    await h.controller.whenIdle();
    expect(h.controller.status().live).toBe(false);
    expect(h.controller.status().inertReason).toBe('no-bridge');
    const h2 = harness({ bridge: () => ({}) as FileBridge });
    h2.controller.bind();
    await h2.controller.whenIdle();
    expect(h2.controller.status().inertReason).toBe('no-bridge');
  });

  it('S3: opening a live host with references runs exactly one initial load; with zero references, no broker context at all', async () => {
    const h = harness();
    h.controller.bind();
    await h.controller.whenIdle();
    expect(h.broker.count('begin')).toBe(1);
    const status = h.controller.status();
    expect(status.live).toBe(true);
    expect(status.phase).toBe('ready');
    expect(status.generation).toBe(1);
    expect(status.nodes.map((n) => [n.blockName, n.status])).toEqual([
      ['CHILD', 'loaded'], ['GRAND', 'loaded'], ['LEAFWIN', 'loaded'], ['OVLROOT', 'loaded'], ['KID', 'loaded'],
    ]);
    expect(h.changes()).toBeGreaterThan(0);

    const empty = harness({ hostName: 'leaf.dxf', hostPath: '/proj/shared/leaf.dxf' });
    empty.controller.bind();
    await empty.controller.whenIdle();
    expect(empty.broker.calls).toEqual([]);
    expect(empty.controller.status().phase).toBe('idle');
    expect(empty.controller.status().nodes).toEqual([]);
  });

  it('S4: bind with an unchanged triple is a no-op (no new attempt, same snapshot object)', async () => {
    const h = harness();
    h.controller.bind();
    await h.controller.whenIdle();
    const snap = h.controller.snapshot();
    h.controller.bind();
    await h.controller.whenIdle();
    expect(h.broker.count('begin')).toBe(1);
    expect(h.controller.snapshot()).toBe(snap);
  });

  it('S5: a bridge appearing later activates the same controller on the next bind, without reconstruction', async () => {
    let bridge: FileBridge | null = null;
    const broker = new FakeBroker(projectFiles());
    const h = harness({ bridge: () => bridge });
    h.controller.bind();
    await h.controller.whenIdle();
    expect(h.controller.status().inertReason).toBe('no-bridge');
    bridge = broker as unknown as FileBridge;
    h.controller.bind();
    await h.controller.whenIdle();
    expect(h.controller.status().live).toBe(true);
    expect(h.controller.status().phase).toBe('ready');
    expect(broker.count('begin')).toBe(1);
  });

  it('S7: Save As re-anchors at the new location; same-named content resolves per folder', async () => {
    const files = new Map<string, string>([
      ['/saveas/a/host.dxf', fixture('saveas/a/host.dxf')],
      ['/saveas/a/child.dxf', fixture('saveas/a/child.dxf')],
      ['/saveas/b/host.dxf', fixture('saveas/b/host.dxf')],
      ['/saveas/b/child.dxf', fixture('saveas/b/child.dxf')],
    ]);
    const h = harness({ hostName: 'saveas/a/host.dxf', hostPath: '/saveas/a/host.dxf', files });
    h.controller.bind();
    await h.controller.whenIdle();
    const snapA = h.controller.snapshot()!;
    const fileA = snapA.files[snapA.nodes[0]!.fileKey!]!;
    expect((fileA.state.entities[0] as { b: { x: number; y: number } }).b).toEqual({ x: 10, y: 0 }); // folder A: horizontal
    h.host.binding = { docId: 'doc-1', contentGeneration: 1, filePath: '/saveas/b/host.dxf' };
    h.host.state = readDxf(fixture('saveas/b/host.dxf'));
    h.controller.bind();
    await h.controller.whenIdle();
    const snapB = h.controller.snapshot()!;
    expect(snapB).not.toBe(snapA);
    expect(snapB.hostPath).toBe('/saveas/b/host.dxf');
    const fileB = snapB.files[snapB.nodes[0]!.fileKey!]!;
    expect((fileB.state.entities[0] as { b: { x: number; y: number } }).b).toEqual({ x: 0, y: 10 }); // folder B: vertical
  });

  it('S8: an in-place content-generation change drops the graph; the old stamp context is unreachable', async () => {
    const states = new Map<string, DrawingState>([['doc-1', readDxf(fixture('host.dxf'))]]);
    const bindings = new Map<string, XrefBinding>([['doc-1', { docId: 'doc-1', contentGeneration: 1, filePath: HOST_PATH }]]);
    const broker = new FakeBroker(projectFiles());
    const registry = new XrefSessionRegistry({
      bridge: () => broker as unknown as FileBridge,
      getBinding: (docId) => bindings.get(docId) ?? null,
      getState: (docId) => states.get(docId) ?? null,
    });
    registry.bind('doc-1');
    const controller = registry.controller('doc-1')!;
    await controller.whenIdle();
    const ctxBefore = registry.currentContextFor({ docId: 'doc-1', contentGeneration: 1 });
    expect(ctxBefore).toBeTruthy();
    bindings.set('doc-1', { docId: 'doc-1', contentGeneration: 2, filePath: HOST_PATH });
    states.set('doc-1', readDxf(fixture('host.dxf')));
    registry.bind('doc-1');
    await controller.whenIdle();
    expect(registry.currentContextFor({ docId: 'doc-1', contentGeneration: 1 })).toBeNull();
    expect(registry.currentContextFor({ docId: 'doc-1', contentGeneration: 2 })).toBeTruthy();
    expect(controller.status().binding.contentGeneration).toBe(2);
  });

  it('S9: tab close disposes the controller; a late completion publishes nothing', async () => {
    const h = harness();
    h.broker.holdReads();
    h.controller.bind();
    await Promise.resolve();
    const disposed = h.controller.dispose();
    h.broker.releaseReads();
    await disposed;
    await h.controller.whenIdle();
    expect(h.controller.snapshot()).toBeNull();
    expect(h.changes()).toBe(0);
    expect(h.broker.count('close')).toBeGreaterThan(0);
  });

  it('S10: status() shape — partial load nodes, and a preserved refresh keeps the committed nodes while lastAttempt records the failure', async () => {
    const files = projectFiles();
    files.delete('/proj/shared/leaf.dxf');
    const h = harness({ files });
    h.controller.bind();
    await h.controller.whenIdle();
    let status = h.controller.status();
    expect(status.nodes.find((n) => n.blockName === 'LEAFWIN')).toMatchObject({ status: 'missing', originalPath: '..\\shared\\leaf.dxf' });
    expect(status.nodes.find((n) => n.blockName === 'LEAFWIN')!.message).toBeTruthy();
    expect(status.stats?.filesLoaded).toBe(4);
    // Restore the leaf, load fully, then break the child: the refresh is preserved.
    h.broker.files.set('/proj/shared/leaf.dxf', fixture('leaf.dxf'));
    await h.controller.reload();
    expect(h.controller.status().generation).toBe(2);
    h.broker.files.delete('/proj/parts/child.dxf');
    const result = await h.controller.reload();
    expect(result!.preserved).toBe(true);
    status = h.controller.status();
    expect(status.phase).toBe('ready');
    expect(status.nodes.find((n) => n.blockName === 'CHILD')!.status).toBe('loaded'); // displayed graph unchanged
    expect(status.lastAttempt).toMatchObject({ kind: 'refresh', committed: false, preserved: true });
    expect(status.lastAttempt!.failures.some((f) => f.kind === 'missing' && f.blockName === 'CHILD')).toBe(true);
  });
});

describe('reload semantics (R)', () => {
  it('R1: a content change at the same path commits a new generation with no v1/v2 mixing', async () => {
    const h = harness();
    h.controller.bind();
    await h.controller.whenIdle();
    const ctxBefore = h.controller.context()!;
    h.broker.files.set('/proj/parts/child.dxf', fixture('child-b.dxf')); // different content, same stored path inside? path refs grand.dxf still resolves
    const result = await h.controller.reload();
    expect(result!.committed).toBe(true);
    expect(h.controller.status().generation).toBe(2);
    const ctxAfter = h.controller.context()!;
    expect(ctxAfter).not.toBe(ctxBefore);
    // The new graph carries ONLY the new content: the child file's state
    // is the replacement text (marker line at x=100), not a v1/v2 mix.
    const snap = h.controller.snapshot()!;
    const childFile = snap.files[snap.nodes.find((n) => n.blockName === 'CHILD')!.fileKey!]!;
    const firstLine = childFile.state.entities.find((e) => e.type === 'line') as { a: { x: number } } | undefined;
    expect(firstLine!.a.x).toBe(100);
  });

  it('R2: a replaced file whose read version disagrees with its identify version is a typed inconsistency; last-good stays published', async () => {
    const h = harness();
    h.controller.bind();
    await h.controller.whenIdle();
    const kept = h.controller.snapshot();
    h.broker.readVersionOverride.set('/proj/parts/child.dxf', 'v:someone-else');
    const result = await h.controller.reload();
    expect(result!.committed).toBe(false);
    expect(result!.failures.some((f) => f.kind === 'inconsistent-version')).toBe(true);
    expect(h.controller.snapshot()).toBe(kept);
  });

  it('R3: good-to-missing on reload is preserved — the published snapshot object is identical', async () => {
    const h = harness();
    h.controller.bind();
    await h.controller.whenIdle();
    const kept = h.controller.snapshot();
    h.broker.files.delete('/proj/parts/child.dxf');
    const result = await h.controller.reload();
    expect(result!.preserved).toBe(true);
    expect(h.controller.snapshot()).toBe(kept);
  });

  it('R4: a host-state path correction is picked up on reload (references are re-collected from current state)', async () => {
    const h = harness();
    h.broker.files.set('/proj/parts/child-b.dxf', fixture('child-b.dxf'));
    h.controller.bind();
    await h.controller.whenIdle();
    const childBlock = h.host.state.blocks['CHILD']!;
    h.host.state = { ...h.host.state, blocks: { ...h.host.state.blocks, CHILD: { ...childBlock, xref: { path: '../parts/child-b.dxf' } } } };
    await h.controller.reload();
    expect(h.broker.paths('read')).toContain('/proj/parts/child-b.dxf');
    expect(h.controller.status().nodes.find((n) => n.blockName === 'CHILD')!.resolvedPath).toBe('/proj/parts/child-b.dxf');
  });

  it('R5: with no graph yet, XREFRELOAD takes the load path (a partial result publishes)', async () => {
    let bridge: FileBridge | null = null;
    const broker = new FakeBroker(projectFiles());
    broker.files.delete('/proj/shared/leaf.dxf');
    const h = harness({ bridge: () => bridge });
    h.controller.bind(); // inert: no bridge yet, no graph
    await h.controller.whenIdle();
    expect(h.controller.snapshot()).toBeNull();
    bridge = broker as unknown as FileBridge;
    const result = await h.controller.reload();
    expect(result!.committed).toBe(true);
    // Partial publication happened (LEAFWIN missing yet a graph exists) — only the load path allows that.
    expect(h.controller.snapshot()).toBeTruthy();
    expect(h.controller.status().nodes.find((n) => n.blockName === 'LEAFWIN')!.status).toBe('missing');
  });

  it('R6: XREFRELOAD during an in-flight attempt aborts and restarts; the late gated completion publishes nothing', async () => {
    const h = harness();
    h.controller.bind();
    await h.controller.whenIdle();
    h.broker.holdReads();
    const first = h.controller.reload();
    const second = h.controller.reload();
    h.broker.releaseReads();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1!.stale || r1!.cancelled).toBe(true);
    expect(r2!.committed).toBe(true);
    expect(h.controller.status().generation).toBe(2);
  });

  it('R7: cancelling a reload preserves the last-good graph object-for-object', async () => {
    const h = harness();
    h.controller.bind();
    await h.controller.whenIdle();
    const kept = h.controller.snapshot();
    h.broker.holdReads();
    const aborted = h.controller.reload();
    const cancelling = h.controller.reload(); // abort-and-restart; this one will fail (broker emptied below)
    h.broker.files.clear();
    h.broker.releaseReads();
    await Promise.all([aborted, cancelling]);
    expect(h.controller.snapshot()).toBe(kept);
  });
});

describe('missing and denied stay distinct (M)', () => {
  it('M1: a missing file reports missing, never a substitute', async () => {
    const files = projectFiles();
    files.delete('/proj/parts/child.dxf');
    const h = harness({ files });
    h.controller.bind();
    await h.controller.whenIdle();
    expect(h.controller.status().nodes.find((n) => n.blockName === 'CHILD')!.status).toBe('missing');
    expect(h.controller.status().lastAttempt!.failures.some((f) => f.kind === 'missing' && f.blockName === 'CHILD')).toBe(true);
    expect(h.broker.paths('read')).not.toContain('/proj/parts/grand.dxf'); // no orphan child of a missing parent
  });

  it('M2: denied at identify time and at read time both report denied, never missing', async () => {
    const h = harness();
    h.broker.denyIdentify.add('/proj/parts/child.dxf');
    h.controller.bind();
    await h.controller.whenIdle();
    expect(h.controller.status().nodes.find((n) => n.blockName === 'CHILD')!.status).toBe('denied');

    const h2 = harness();
    h2.broker.denyRead.add('/proj/parts/child.dxf');
    h2.controller.bind();
    await h2.controller.whenIdle();
    expect(h2.controller.status().nodes.find((n) => n.blockName === 'CHILD')!.status).toBe('denied');
  });

  it('M3: an unparseable file reports parse-error', async () => {
    const files = projectFiles();
    files.set('/proj/parts/child.dxf', fixture('broken/bad.dxf'));
    const h = harness({ files });
    h.controller.bind();
    await h.controller.whenIdle();
    expect(h.controller.status().nodes.find((n) => n.blockName === 'CHILD')!.status).toBe('parse-error');
  });

  it('M7: a DWG reference reports unsupported-format, its bytes are never read, and a DXF sibling still loads', async () => {
    const files = projectFiles();
    files.set('/proj/drawings/host-dwg.dxf', fixture('host-dwg.dxf'));
    const h = harness({ hostName: 'host-dwg.dxf', hostPath: '/proj/drawings/host-dwg.dxf', files });
    h.controller.bind();
    await h.controller.whenIdle();
    const nodes = h.controller.status().nodes;
    expect(nodes.find((n) => n.blockName === 'DWGREF')!.status).toBe('unsupported-format');
    expect(nodes.find((n) => n.blockName === 'CHILD')!.status).toBe('loaded');
    expect(h.broker.paths('read').some((p) => p.endsWith('part.dwg'))).toBe(false);
  });

  it('M4: unresolved path and unresolved location stay distinct and typed', async () => {
    const h = harness();
    h.host.state = synthState({ X: xrefBlock('X', 'C:leaf.dxf') });
    h.controller.bind();
    await h.controller.whenIdle();
    expect(h.controller.status().nodes.find((n) => n.blockName === 'X')!.status).toBe('unresolved-path');

    const h2 = harness();
    h2.broker.denyIdentify.add(HOST_PATH); // host identity cannot be established
    h2.controller.bind();
    await h2.controller.whenIdle();
    // Fail-closed is a typed graph, published under the partial rule like
    // any other typed failure set: every root unresolved-location, and
    // nothing was ever read.
    expect(h2.controller.snapshot()).toBeTruthy();
    expect(h2.controller.status().nodes.length).toBeGreaterThan(0);
    expect(h2.controller.status().nodes.every((n) => n.status === 'unresolved-location')).toBe(true);
    expect(h2.broker.paths('read')).toEqual([]);
  });

  it('M4: an inconsistent version at first load is its own typed status', async () => {
    const h = harness();
    h.broker.readVersionOverride.set('/proj/parts/child.dxf', 'v:other');
    h.controller.bind();
    await h.controller.whenIdle();
    expect(h.controller.status().nodes.find((n) => n.blockName === 'CHILD')!.status).toBe('inconsistent-version');
  });

  it('M4: a cycle is reported as cycle with the chain, not as missing or a hang', async () => {
    const h = harness({ hostName: 'cycle-a.dxf', hostPath: '/proj/cycle-a.dxf' });
    h.controller.bind();
    await h.controller.whenIdle();
    const root = h.controller.status().nodes[0]!;
    expect(root.status).toBe('loaded');
    const failures = h.controller.status().lastAttempt!.failures;
    expect(failures.some((f) => f.kind === 'cycle')).toBe(true);
  });

  it('M4: a nested overlay that is not carried reports not-carried-overlay and its file is never read', async () => {
    const h = harness();
    h.host.state = synthState({ OP: xrefBlock('OP', 'overlay-parent.dxf') });
    h.controller.bind();
    await h.controller.whenIdle();
    const snap = h.controller.snapshot()!;
    expect(snap.nodes[0]).toMatchObject({ blockName: 'OP', status: 'loaded' });
    expect(snap.nodes[0]!.children[0]).toMatchObject({ blockName: 'INNER', status: 'not-carried-overlay' });
    expect(h.broker.paths('read')).not.toContain('/proj/drawings/inner.dxf');
  });
});

const chainDxf = (nextPath: string | null): string => `999
Generated chain fixture for P20 slice 1 (depth/file limits).
0
SECTION
2
HEADER
9
$ACADVER
1
AC1015
0
ENDSEC
0
SECTION
2
TABLES
0
TABLE
2
LAYER
70
1
0
LAYER
2
0
70
0
62
7
6
Continuous
0
ENDTAB
0
ENDSEC
0
SECTION
2
BLOCKS
${nextPath ? `0
BLOCK
8
0
2
N
70
4
10
0.0
20
0.0
30
0.0
3
N
1
${nextPath}
0
ENDBLK
` : ''}0
ENDSEC
0
SECTION
2
ENTITIES
${nextPath ? `0
INSERT
8
0
2
N
10
0.0
20
0.0
30
0.0
` : `0
LINE
8
0
10
0.0
20
0.0
30
0.0
11
1.0
21
1.0
31
0.0
`}0
ENDSEC
0
EOF
`;

describe('limits stay typed (M)', () => {
  it('M4: depth beyond the cap reports depth-limit and the capped file is never read', async () => {
    const files = new Map<string, string>();
    files.set('/proj/chain/host.dxf', chainDxf('d1.dxf'));
    for (let i = 1; i <= 8; i += 1) files.set(`/proj/chain/d${i}.dxf`, chainDxf(`d${i + 1}.dxf`));
    const h = harness({ files, hostPath: '/proj/chain/host.dxf' });
    h.host.state = readDxf(chainDxf('d1.dxf'));
    h.controller.bind();
    await h.controller.whenIdle();
    const failures = h.controller.status().lastAttempt!.failures;
    expect(failures.some((f) => f.kind === 'depth-limit')).toBe(true);
    expect(h.broker.paths('read')).not.toContain('/proj/chain/d9.dxf');
  });

  it('M4: more distinct files than the cap fails as a typed total-limit — never as missing, and nothing publishes', async () => {
    // The per-file cap reports node-level 'file-limit' (pinned by the core
    // floor suites); the distinct-count cap is a staging fatal whose kind
    // is 'total-limit'. Both stay distinct in the typed vocabulary.
    const files = new Map<string, string>();
    files.set('/proj/host.dxf', fixture('leaf.dxf'));
    const blocks: Record<string, BlockDef> = {};
    for (let i = 0; i < 65; i += 1) {
      blocks[`R${i}`] = xrefBlock(`R${i}`, `leafs/leaf${i}.dxf`);
      files.set(`/proj/leafs/leaf${i}.dxf`, fixture('leaf.dxf'));
    }
    const h = harness({ files, hostPath: '/proj/host.dxf' });
    h.host.state = synthState(blocks);
    h.controller.bind();
    await h.controller.whenIdle();
    const status = h.controller.status();
    expect(h.controller.snapshot()).toBeNull();
    expect(status.phase).toBe('failed');
    expect(status.lastAttempt!.failures.some((f) => f.kind === 'total-limit')).toBe(true);
    expect(status.lastAttempt!.failures.some((f) => f.kind === 'missing')).toBe(false);
  });
});

describe('lifecycle safety (L)', () => {
  it('L1: rebinding during a gated load publishes nothing from the old binding', async () => {
    const files = new Map<string, string>([
      ['/saveas/a/host.dxf', fixture('saveas/a/host.dxf')],
      ['/saveas/a/child.dxf', fixture('saveas/a/child.dxf')],
      ['/saveas/b/host.dxf', fixture('saveas/b/host.dxf')],
      ['/saveas/b/child.dxf', fixture('saveas/b/child.dxf')],
    ]);
    const h = harness({ hostName: 'saveas/a/host.dxf', hostPath: '/saveas/a/host.dxf', files });
    h.broker.holdReads();
    h.controller.bind();
    h.host.binding = { docId: 'doc-1', contentGeneration: 1, filePath: '/saveas/b/host.dxf' };
    h.host.state = readDxf(fixture('saveas/b/host.dxf'));
    h.controller.bind();
    h.broker.releaseReads();
    await h.controller.whenIdle();
    expect(h.controller.snapshot()!.hostPath).toBe('/saveas/b/host.dxf');
    expect(h.controller.status().generation).toBe(1); // only the B attempt ever committed
  });

  it('L2: a trigger storm (open, Save As, reload, close) settles disposed with no unhandled rejection', async () => {
    const h = harness();
    h.broker.holdReads();
    h.controller.bind();
    const reloading = h.controller.reload();
    const disposing = h.controller.dispose();
    h.broker.releaseReads();
    await Promise.all([reloading, disposing]);
    await h.controller.whenIdle();
    expect(h.controller.snapshot()).toBeNull();
  });

  it('L3+L4+L6: loading never mutates the host, never writes a referenced file, and leaves stored records byte-identical', async () => {
    const h = harness();
    const before = JSON.stringify(h.host.state);
    const refsBefore = collectXrefReferences(h.host.state);
    h.controller.bind();
    await h.controller.whenIdle();
    await h.controller.reload();
    await h.controller.reload();
    expect(JSON.stringify(h.host.state)).toBe(before);
    expect(collectXrefReferences(h.host.state)).toEqual(refsBefore);
    const methods = new Set(h.broker.calls.map((c) => c.method));
    expect([...methods].every((m) => ['begin', 'identify', 'read', 'cancel', 'close'].includes(m))).toBe(true);
  });

  it('G1: a drawing with no references produces no broker traffic, even on XREFRELOAD', async () => {
    const h = harness({ hostName: 'leaf.dxf', hostPath: '/proj/shared/leaf.dxf' });
    h.controller.bind();
    await h.controller.whenIdle();
    const result = await h.controller.reload();
    expect(result).toBeNull();
    expect(h.broker.calls).toEqual([]);
  });
});

describe('commands (L5)', () => {
  it('registers exactly XREFRELOAD and XREFSTATUS; XREFSTATUS prints the node table; an inert XREFRELOAD logs its reason', async () => {
    const defs: CommandDef[] = [];
    const fakeEd = { register: (def: CommandDef) => defs.push(def) };
    registerXrefCommands(fakeEd as never);
    expect(defs.map((d) => d.name)).toEqual(['XREFRELOAD', 'XREFSTATUS']);

    const h = harness();
    const registry = new XrefSessionRegistry({
      bridge: () => h.broker as unknown as FileBridge,
      getBinding: () => h.host.binding,
      getState: () => h.host.state,
    });
    registry.bind('doc-1');
    await registry.controller('doc-1')!.whenIdle();
    const lines: string[] = [];
    const edStub = {
      xrefSessions: registry,
      sessions: { current: { docId: 'doc-1' } },
      log: (text: string) => lines.push(text),
    };
    defs.find((d) => d.name === 'XREFSTATUS')!.run(edStub as never);
    expect(lines.join('\n')).toContain('CHILD');
    expect(lines.join('\n')).toContain('loaded');

    const inert = harness({ bridge: () => null });
    const inertRegistry = new XrefSessionRegistry({
      bridge: () => null,
      getBinding: () => inert.host.binding,
      getState: () => inert.host.state,
    });
    inertRegistry.bind('doc-1');
    const inertLines: string[] = [];
    const inertEd = {
      xrefSessions: inertRegistry,
      sessions: { current: { docId: 'doc-1' } },
      log: (text: string) => inertLines.push(text),
    };
    await defs.find((d) => d.name === 'XREFRELOAD')!.run(inertEd as never);
    expect(inertLines.join('\n')).toContain('no-bridge');
  });

  it('the controller API exposes no merge, detach, unload or retype operation', () => {
    const methods = Object.getOwnPropertyNames(XrefSessionController.prototype);
    expect(methods.some((m) => /merge|detach|unload|retype|bindReference/i.test(m))).toBe(false);
  });
});
