/**
 * P20 slice 1 — production-wiring rig (adjudication B1).
 *
 * Every other lane battery injects a fake getState/getBinding into the
 * controller or registry, which is exactly how the production defect at
 * editor.ts:79 (registry getState reading a non-existent `.doc` off the
 * DocumentSession) shipped green: through the REAL Editor the accessor
 * threw on every call, the throw was swallowed by the Editor's onChange
 * guard, no load was ever scheduled, and XREFRELOAD rejected.
 *
 * This rig drives the production path end to end: a real Editor, its own
 * XrefSessionRegistry (no injected accessors), a scripted FileBridge with
 * the five xref methods, sessions.add of a referencing host, and the
 * registered XREFRELOAD command. It fails at cd76ae03 (status stays
 * live/idle at generation 0 with zero nodes; reload rejects with the
 * TypeError) and passes only when a load is actually scheduled through
 * the editor wiring.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setPathPlatform } from '../src/app/paths';
import { readDxf } from '../src/io/dxf';
import type { Editor as EditorType } from '../src/app/editor';
import type { FileBridge } from '../src/app/editor/types';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'xref', name), 'utf8');
const hash = (text: string): string => { let h = 0; for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0; return String(h >>> 0); };

function makeBridge(files: Map<string, string>): FileBridge {
  const broker = {
    async beginXrefContext() { return { token: 'tok' }; },
    async identifyXref(_token: string, path: string) {
      const text = files.get(path);
      if (text === undefined) throw new Error('ERR_XREF_MISSING: no readable file');
      return { ticket: path, identity: { id: `id:${path}`, owningLocation: path, version: `v:${hash(text)}` } };
    },
    async readXref(_token: string, ticket: string) {
      const text = files.get(ticket);
      if (text === undefined) throw new Error('ERR_XREF_MISSING: no readable file');
      return { text, byteLength: Buffer.byteLength(text, 'utf8'), version: `v:${hash(text)}` };
    },
    async cancelXref() { return true; },
    async closeXrefContext() { return true; },
  };
  return broker as unknown as FileBridge;
}

const projectFiles = (): Map<string, string> => new Map<string, string>([
  ['/proj/drawings/host.dxf', fixture('host.dxf')],
  ['/proj/parts/child.dxf', fixture('child.dxf')],
  ['/proj/parts/grand.dxf', fixture('grand.dxf')],
  ['/proj/shared/leaf.dxf', fixture('leaf.dxf')],
  ['/proj/drawings/overlay-root.dxf', fixture('overlay-root.dxf')],
  ['/proj/drawings/kid.dxf', fixture('kid.dxf')],
]);

let Editor: typeof EditorType;
beforeAll(async () => {
  setPathPlatform('posix');
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
});
afterAll(() => setPathPlatform(null));

const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;

function rig(): { ed: EditorType; files: Map<string, string> } {
  const ed = new Editor(canvas());
  const files = projectFiles();
  ed.fileBridge = makeBridge(files);
  return { ed, files };
}

describe('production editor wiring (W)', () => {
  it('W1: sessions.add of a referencing host schedules a real load through the editor registry', async () => {
    const { ed } = rig();
    ed.sessions.add(readDxf(fixture('host.dxf')), '/proj/drawings/host.dxf');
    const session = ed.sessions.current;
    // Proven session semantics: a fresh add carries contentGeneration 0;
    // the stamp discipline is pinned against exactly this value.
    expect(session.contentGeneration).toBe(0);
    const controller = ed.xrefSessions.controller(session.docId)!;
    await controller.whenIdle();
    const status = controller.status();
    expect(status.live).toBe(true);
    expect(status.phase).toBe('ready');
    expect(status.generation).toBe(1);
    expect(status.nodes.length).toBeGreaterThan(0);
    expect(status.nodes.find((n) => n.blockName === 'CHILD')!.status).toBe('loaded');
    expect(controller.snapshot()).toBeTruthy();
    expect(controller.context()).toBeTruthy();
    // The provider seam serves exactly this session stamp — and no other.
    expect(ed.xrefSessions.currentContextFor({ docId: session.docId, contentGeneration: 0 })).toBeTruthy();
    expect(ed.xrefSessions.currentContextFor({ docId: session.docId, contentGeneration: 1 })).toBeNull();
  });

  it('W2: XREFRELOAD through the registered command reloads the graph (generation 2)', async () => {
    const { ed, files } = rig();
    ed.sessions.add(readDxf(fixture('host.dxf')), '/proj/drawings/host.dxf');
    const session = ed.sessions.current;
    const controller = ed.xrefSessions.controller(session.docId)!;
    await controller.whenIdle();
    expect(controller.status().generation).toBe(1);
    // Change the child on disk, then reload via the production command path.
    files.set('/proj/parts/child.dxf', fixture('child-b.dxf'));
    await ed.runCommand('XREFRELOAD');
    await controller.whenIdle();
    const status = controller.status();
    expect(status.phase).toBe('ready');
    expect(status.generation).toBe(2);
    expect(status.nodes.find((n) => n.blockName === 'CHILD')!.resolvedPath).toBe('/proj/parts/child.dxf');
    expect(controller.context()!.generation).toBe(2);
  });
});
