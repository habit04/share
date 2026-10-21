/**
 * P31 wiring acceptance tests — RULING-P31 C1–C3.
 *
 * The preserved-signature record lives on DrawingState.signatureRecord.
 * Detection happens at exactly two state-replacement points, per the ruling:
 * Drawing.commitTransition (the shared choke point for transact /
 * transactDrawing) and the private outsideHistory path (public settings:
 * setHeader, setCurrentLayer, setSpace, patchQuiet, ensureBlocks). At both
 * points noteSignatureEdit is applied UNCONDITIONALLY to any present record
 * (fail closed); invalidation folds into the prepared next state so undo
 * restores record and content together; a refused transition leaves the
 * record untouched; a no-op transition invalidates nothing; with no record
 * present the hooks are inert.
 *
 * Acceptance examples (1)–(5) from PROPOSAL-P31 as extended by the ruling.
 * State-level only (C6): no persistence claim is made or tested here.
 */
import { describe, expect, it } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import { drawingContentDigest } from '../src/project/canonical-digest';
import {
  capturePreservedSignature,
  verifyPreservedSignature,
  type PreservedSignatureRecord,
} from '../src/project/drawing-signature';
import type { Entity, Layer } from '../src/core/entities';

const layer0: Layer = { name: '0', color: 7, visible: true, locked: false, lineWeight: -1 };
const layer1: Layer = { name: 'L1', color: 3, visible: true, locked: false, lineWeight: -1 };

const line = (id: string): Entity => ({
  id, type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 10, y: 5 },
});

const baseState = (): DrawingState => ({
  entities: [line('e1')],
  layers: [layer0, layer1],
  blocks: {},
  currentLayer: '0',
});

/** A Drawing whose initial state already carries a record captured over its own content digest. */
const signedDrawing = (): { doc: Drawing; record: PreservedSignatureRecord } => {
  const state = baseState();
  const record = capturePreservedSignature({
    payload: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    contentDigest: drawingContentDigest(state),
    sourceFormat: 'DWG',
  });
  const doc = new Drawing({ ...state, signatureRecord: record });
  return { doc, record };
};

describe('P31 wiring — acceptance examples (RULING-P31)', () => {
  it('(1) a captured record verifies content-match over the drawing state, status unchanged', () => {
    const { doc, record } = signedDrawing();
    expect(doc.snapshot.signatureRecord?.status).toBe('preserved-unverified');
    expect(verifyPreservedSignature(record, drawingContentDigest(doc.snapshot))).toBe('content-match');
    expect(doc.snapshot.signatureRecord).toBe(record);
  });

  it('(2) a transact edit invalidates in the same undo step; undo restores content and status together', () => {
    const { doc, record } = signedDrawing();
    doc.transact((s) => ({ ...s, entities: [...s.entities, line('e2')] }));
    expect(doc.snapshot.entities).toHaveLength(2);
    expect(doc.snapshot.signatureRecord?.status).toBe('invalidated-by-edit');
    // the preserved payload is kept; only the status changes
    expect(Array.from(doc.snapshot.signatureRecord?.payload ?? [])).toEqual(Array.from(record.payload));
    expect(doc.undo()).toBe(true);
    expect(doc.snapshot.entities).toHaveLength(1);
    expect(doc.snapshot.signatureRecord?.status).toBe('preserved-unverified');
    expect(doc.redo()).toBe(true);
    expect(doc.snapshot.entities).toHaveLength(2);
    expect(doc.snapshot.signatureRecord?.status).toBe('invalidated-by-edit');
  });

  it('(2b) transactDrawing invalidates through the same shared choke point', () => {
    const { doc } = signedDrawing();
    doc.transactDrawing((s) => ({ ...s, layers: s.layers.map((l) => ({ ...l, color: 9 })) }));
    expect(doc.snapshot.signatureRecord?.status).toBe('invalidated-by-edit');
  });

  it('(3) an out-of-band content change verifies tampered; an excluded-field-only change stays content-match (C5)', () => {
    const { doc, record } = signedDrawing();
    const tampered: DrawingState = {
      ...doc.snapshot,
      entities: [{ ...line('e1'), b: { x: 99, y: 5 } }],
    };
    expect(verifyPreservedSignature(record, drawingContentDigest(tampered))).toBe('tampered');
    const excludedOnly: DrawingState = { ...doc.snapshot, meta: { producer: 'someone-else' } };
    expect(verifyPreservedSignature(record, drawingContentDigest(excludedOnly))).toBe('content-match');
  });

  it('(4) a drawing without a record gains none and behaves identically through edits and settings', () => {
    const doc = new Drawing(baseState());
    doc.transact((s) => ({ ...s, entities: [...s.entities, line('e2')] }));
    doc.setHeader({ ltscale: 2 });
    doc.setCurrentLayer('L1');
    expect(doc.snapshot.signatureRecord).toBeUndefined();
    expect('signatureRecord' in doc.snapshot).toBe(false);
    expect(doc.snapshot.entities).toHaveLength(2);
    expect(doc.snapshot.currentLayer).toBe('L1');
  });

  it('(5) a header-variable change through the public settings path invalidates in the same operation', () => {
    const { doc } = signedDrawing();
    doc.setHeader({ ltscale: 2 });
    expect(doc.snapshot.header?.ltscale).toBe(2);
    expect(doc.snapshot.signatureRecord?.status).toBe('invalidated-by-edit');
  });
});

describe('P31 wiring — C2 totality and C3 atomicity/inertness', () => {
  it('outsideHistory invalidates the record in the current state AND in every rewritten history snapshot', () => {
    const { doc } = signedDrawing();
    doc.transact((s) => ({ ...s, entities: [...s.entities, line('e2')] }));
    expect(doc.snapshot.signatureRecord?.status).toBe('invalidated-by-edit');
    // The undo snapshot still holds the pristine record — until a settings
    // change rewrites every snapshot through outsideHistory.
    doc.setHeader({ ltscale: 3 });
    const history = doc.history();
    expect(history.undo).toHaveLength(1);
    expect(history.undo[0]?.signatureRecord?.status).toBe('invalidated-by-edit');
    // Undoing the geometry edit must not resurrect a trustworthy record.
    expect(doc.undo()).toBe(true);
    expect(doc.snapshot.entities).toHaveLength(1);
    expect(doc.snapshot.signatureRecord?.status).toBe('invalidated-by-edit');
  });

  it('setCurrentLayer (outsideHistory) invalidates in the same operation', () => {
    const { doc } = signedDrawing();
    doc.setCurrentLayer('L1');
    expect(doc.snapshot.currentLayer).toBe('L1');
    expect(doc.snapshot.signatureRecord?.status).toBe('invalidated-by-edit');
  });

  it('patchQuiet (outsideHistory) invalidates in the same operation', () => {
    const { doc } = signedDrawing();
    doc.patchQuiet((s) => ({ ...s, meta: { note: 'quiet' } }));
    expect(doc.snapshot.signatureRecord?.status).toBe('invalidated-by-edit');
  });

  it('a REFUSED transition leaves the record and the document untouched', () => {
    const { doc } = signedDrawing();
    const before = doc.snapshot;
    const badDim: Entity = {
      id: 'bad-dim', type: 'dimension', layer: '0', color: 'ByLayer', kind: 'ordinate',
      p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, linePoint: { x: 0, y: -5 },
    } as Entity;
    expect(() => doc.transact((s) => ({ ...s, entities: [...s.entities, badDim] }))).toThrow(/datum axis/);
    expect(doc.snapshot).toBe(before);
    expect(doc.snapshot.signatureRecord?.status).toBe('preserved-unverified');
    expect(doc.canUndo()).toBe(false);
  });

  it('a no-op transition invalidates nothing and records no history', () => {
    const { doc, record } = signedDrawing();
    doc.transact((s) => s);
    expect(doc.snapshot.signatureRecord).toBe(record);
    expect(doc.snapshot.signatureRecord?.status).toBe('preserved-unverified');
    expect(doc.canUndo()).toBe(false);
  });

  it('an already-invalidated record stays invalidated (stickiness across further edits)', () => {
    const { doc } = signedDrawing();
    doc.transact((s) => ({ ...s, entities: [...s.entities, line('e2')] }));
    doc.transact((s) => ({ ...s, entities: [...s.entities, line('e3')] }));
    expect(doc.snapshot.signatureRecord?.status).toBe('invalidated-by-edit');
    doc.undo();
    doc.undo();
    expect(doc.snapshot.signatureRecord?.status).toBe('preserved-unverified');
  });
});
