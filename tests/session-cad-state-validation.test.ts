/** Actual session/proof owners; the file bridge is an explicit no-filesystem test double. */
import { describe, expect, it, vi } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import { SessionManager, type SessionHost } from '../src/app/sessions';
import { adoptOpenedSourceProof, captureOpenedSourceProof } from '../src/app/opened-source-proof';
import type { FileBridge } from '../src/app/editor';

function setup() {
  const doc = new Drawing();
  doc.load(doc.snapshot, 'C:\\session-graph-test\\active.dxf');
  const loadState = vi.fn((state: DrawingState, path: string | null) => doc.load(state, path));
  const host: SessionHost = { doc, viewport: { center: { x: 1, y: 2 }, scale: 8 }, selection: new Set(['selected']), loadState };
  const sessions = new SessionManager(host), active = sessions.current;
  const releaseOpenedSourceProof = vi.fn(async () => {});
  const bridge: FileBridge & { releaseOpenedSourceProof(proof: string): Promise<void> } = {
    platform: 'win32', openDxf: async () => null, saveDxf: async () => null, releaseOpenedSourceProof,
  };
  expect(adoptOpenedSourceProof(active, active.contentGeneration, bridge, 'original-proof', doc.filePath!)).toBe(true);
  const snapshot = () => ({ state: doc.snapshot, history: doc.history(), dirty: doc.dirty, path: doc.filePath, revision: doc.revision, active: sessions.active, count: sessions.count, selection: [...host.selection] });
  return { doc, sessions, active, bridge, releaseOpenedSourceProof, loadState, snapshot };
}
function orphan(state: DrawingState): DrawingState {
  return { ...state, entities: [{ id: 'orphan', cadIdentity: 'retained:orphan', type: 'point', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 } }] };
}
function invalidOrdinate(state: DrawingState): DrawingState {
  return { ...state, entities: [{ id: 'invalid-ordinate', type: 'dimension', kind: 'ordinate', layer: '0', color: 'ByLayer', p1: { x: 0, y: 0 }, p2: { x: 1, y: 1 }, linePoint: { x: 1, y: 3 }, rotation: 0, style: new Drawing().header.dimStyle, ordinateAxis: 'z' as 'x' }] };
}
async function expectOriginalProof(f: ReturnType<typeof setup>) {
  const captured = captureOpenedSourceProof(f.active, f.bridge, f.doc.filePath, 'in-place');
  expect(captured?.hint.proof).toBe('original-proof');
  await captured?.release();
  expect(f.releaseOpenedSourceProof).not.toHaveBeenCalled();
}

describe('graph validation precedes session ownership changes', () => {
  it('refuses a new parked state before adding a tab or loading the current drawing', async () => {
    const f = setup(), before = f.snapshot();
    expect(() => f.sessions.addInBackground(orphan(f.doc.snapshot), 'C:\\session-graph-test\\invalid.dxf')).toThrow(/require their retained object graph/);
    expect(f.snapshot()).toEqual(before); expect(f.loadState).not.toHaveBeenCalled();
    await expectOriginalProof(f);
  });
  it.each([false, true])('refuses an invalid replacement before retiring the %s active proof', async parked => {
    const f = setup();
    if (parked) { f.sessions.add(new Drawing().snapshot); f.sessions.switchTo(1); }
    const before = f.snapshot(), original = { ...f.active, undo: [...f.active.undo], redo: [...f.active.redo] };
    f.loadState.mockClear();
    expect(() => f.sessions.loadInto(f.active.id, orphan(f.active.state), 'C:\\session-graph-test\\invalid.dxf')).toThrow(/require their retained object graph/);
    expect(f.snapshot()).toEqual(before); expect(f.active).toEqual(original); expect(f.loadState).not.toHaveBeenCalled();
    await expectOriginalProof(f);
  });
  it.each(['state', 'undo', 'redo'] as const)('refuses an invalid parked %s before switching or closing the outgoing tab', async target => {
    const f = setup(), index = f.sessions.addInBackground(new Drawing().snapshot, 'C:\\session-graph-test\\parked.dxf');
    const parked = f.sessions.all[index]!;
    if (target === 'state') parked.state = orphan(parked.state);
    else parked[target] = [orphan(parked.state)];
    const before = f.snapshot();
    expect(() => f.sessions.switchTo(index)).toThrow(/require their retained object graph/);
    expect(f.snapshot()).toEqual(before);
    expect(() => f.sessions.close(0)).toThrow(/require their retained object graph/);
    expect(f.snapshot()).toEqual(before); expect(f.loadState).not.toHaveBeenCalled();
    await expectOriginalProof(f);
  });
  it.each(['state', 'undo', 'redo'] as const)('checks complete Drawing ordinate validation in parked %s before ownership changes', async target => {
    const f = setup(), index = f.sessions.addInBackground(new Drawing().snapshot, 'C:\\session-graph-test\\parked.dxf');
    const parked = f.sessions.all[index]!;
    if (target === 'state') parked.state = invalidOrdinate(parked.state);
    else parked[target] = [invalidOrdinate(parked.state)];
    const before = f.snapshot();
    expect(() => f.sessions.switchTo(index)).toThrow(/require an x or y datum axis/);
    expect(f.snapshot()).toEqual(before);
    expect(() => f.sessions.close(0)).toThrow(/require an x or y datum axis/);
    expect(f.snapshot()).toEqual(before); expect(f.loadState).not.toHaveBeenCalled();
    await expectOriginalProof(f);
  });
});
