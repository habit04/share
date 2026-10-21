/**
 * P31 wiring — AMENDMENT TO RULING-P31 (Matter 1) evidence probes.
 *
 * The seal collision: PreservedSignatureRecord.payload is a Uint8Array, which the
 * whole-state plain-data seal (core/immutable-data.ts) must refuse. The amendment
 * adopts ONE narrowed resolution: an opt-in root-key exemption, keyed by root +
 * field name only ('signatureRecord' at depth 0 of a DrawingState), invoked only
 * from the DrawingState seal path (core/geometry-budget.ts sealDrawingState and
 * the two whole-state seal sites in core/document.ts).
 *
 * These probes pin the exemption's exact scope, both directions:
 *  - NEGATIVE: a typed array in a non-exempt field (meta) still throws; a typed
 *    array inside a nested object merely NAMED 'signatureRecord' still throws;
 *    the default (no-exemption) seal still throws even for the name at root.
 *  - POSITIVE: a record-carrying Drawing constructs, transacts in model space
 *    and in paper space (through project()), applies a patched setSpace, loads,
 *    undoes and redoes — while a non-exempt part of the same state remains
 *    seal-protected.
 *  - POSTURE (invariant (d), stated honestly): the exempt record subtree is NOT
 *    seal-certified — it is not frozen, and mutation through a held record
 *    reference TAKES. Stickiness is an API-transition property, not seal
 *    enforcement; these probes assert that contrary posture as behaviour.
 *  - The capture-time defensive copy binds CAPTURE (drawing-signature.ts:60):
 *    mutating the source bytes after capture leaves the record unchanged.
 */
import { describe, expect, it } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import { sealImmutableData } from '../src/core/immutable-data';
import type { Entity, Layer } from '../src/core/entities';
import type { Layout } from '../src/core/layouts';
import {
  capturePreservedSignature,
  type PreservedSignatureRecord,
} from '../src/project/drawing-signature';

const layer0: Layer = { name: '0', color: 7, visible: true, locked: false, lineWeight: -1 };

const line = (id: string): Entity => ({
  id, type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 10, y: 5 },
});

const aRecord = (): PreservedSignatureRecord => capturePreservedSignature({
  payload: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
  contentDigest: 'a'.repeat(64),
  sourceFormat: 'DWG',
});

const baseState = (): DrawingState => ({
  entities: [line('e1')],
  layers: [layer0],
  blocks: {},
  currentLayer: '0',
});

const layout1: Layout = {
  name: 'Layout1',
  paper: { id: 'custom', width: 297, height: 210, units: 'mm', orientation: 'landscape' },
  plotScale: '1:1',
  margins: { left: 0, bottom: 0, right: 0, top: 0 },
  entities: [],
  viewports: [],
};

const SEAL_ERROR = /plain objects and arrays, not custom prototypes/;

describe('seal exemption — NEGATIVE probes (scope does not leak)', () => {
  it('a Uint8Array in a non-exempt field (meta) still throws at construction', () => {
    expect(() => new Drawing({
      ...baseState(),
      meta: { blob: new Uint8Array([1, 2, 3]) },
    })).toThrow(SEAL_ERROR);
  });

  it("a Uint8Array inside a nested object named 'signatureRecord' still throws (name alone at depth > 0 exempts nothing)", () => {
    expect(() => new Drawing({
      ...baseState(),
      meta: { signatureRecord: { status: 'preserved-unverified', payload: new Uint8Array([1]) } },
    })).toThrow(SEAL_ERROR);
  });

  it('the DEFAULT seal (no exemption argument) still throws for the record shape at root — the mechanism is opt-in', () => {
    expect(() => sealImmutableData({ signatureRecord: aRecord() })).toThrow(SEAL_ERROR);
    expect(() => sealImmutableData(baseState())).not.toThrow();
  });

  it('an exemption naming a DIFFERENT root key does not exempt signatureRecord', () => {
    expect(() => sealImmutableData(
      { ...baseState(), signatureRecord: aRecord() },
      new Set<PropertyKey>(['somethingElse']),
    )).toThrow(SEAL_ERROR);
  });
});

describe('seal exemption — POSITIVE scope probes (record-carrying states work)', () => {
  it('construction + model-space transact with a record present; non-exempt parts stay seal-protected', () => {
    const record = aRecord();
    const doc = new Drawing({ ...baseState(), signatureRecord: record });
    expect(doc.snapshot.signatureRecord).toBe(record);
    doc.transact((s) => ({ ...s, entities: [...s.entities, line('e2')] }));
    expect(doc.snapshot.entities).toHaveLength(2);
    expect(doc.snapshot.signatureRecord?.status).toBe('invalidated-by-edit');
    // Non-exempt parts of the same state remain sealed: root and entities frozen,
    // mutation through the state handle is refused.
    expect(Object.isFrozen(doc.snapshot)).toBe(true);
    expect(Object.isFrozen(doc.snapshot.entities)).toBe(true);
    expect(Object.isFrozen(doc.snapshot.entities[0])).toBe(true);
    expect(() => {
      (doc.snapshot.entities[0] as { layer: string }).layer = 'ZZ';
    }).toThrow(TypeError);
  });

  it('paper-space transact through project() with a record present does not throw and invalidates', () => {
    const doc = new Drawing({
      ...baseState(),
      layouts: [layout1],
      space: { layout: 'Layout1' },
      signatureRecord: aRecord(),
    });
    doc.transact((s) => ({ ...s, entities: [...s.entities, line('p1')] }));
    expect(doc.snapshot.signatureRecord?.status).toBe('invalidated-by-edit');
    expect(doc.snapshot.layouts?.[0]?.entities.map((e) => e.id)).toEqual(['p1']);
    // Model space is untouched by the paper-space edit.
    expect(doc.snapshot.entities.map((e) => e.id)).toEqual(['e1']);
  });

  it('a patched setSpace with a record present does not throw (the patched-path seal is exempting)', () => {
    const doc = new Drawing({
      ...baseState(),
      layouts: [layout1],
      signatureRecord: aRecord(),
    });
    doc.setSpace({ layout: 'Layout1' }, (s) => ({ ...s, meta: { ...(s.meta ?? {}), viaPatch: true } }));
    expect(doc.snapshot.space).toEqual({ layout: 'Layout1' });
    expect(doc.snapshot.meta?.viaPatch).toBe(true);
    expect(doc.snapshot.signatureRecord?.status).toBe('invalidated-by-edit');
  });

  it('load adopts a record-carrying state without throwing and WITHOUT invalidating it', () => {
    const record = aRecord();
    const doc = new Drawing();
    doc.load({ ...baseState(), signatureRecord: record });
    expect(doc.snapshot.signatureRecord).toBe(record);
    expect(doc.snapshot.signatureRecord?.status).toBe('preserved-unverified');
    expect(doc.canUndo()).toBe(false);
  });

  it('undo/redo travel with a record present; the restored snapshots are the sealed originals', () => {
    const record = aRecord();
    const doc = new Drawing({ ...baseState(), signatureRecord: record });
    const pristine = doc.snapshot;
    doc.transact((s) => ({ ...s, entities: [...s.entities, line('e2')] }));
    expect(doc.undo()).toBe(true);
    expect(doc.snapshot).toBe(pristine);
    expect(doc.snapshot.signatureRecord).toBe(record);
    expect(doc.redo()).toBe(true);
    expect(doc.snapshot.signatureRecord?.status).toBe('invalidated-by-edit');
  });
});

describe('seal exemption — POSTURE (invariant (d): the exempt subtree is NOT seal-certified)', () => {
  it('the record and its payload are NOT frozen, and mutation through a held reference takes', () => {
    const record = aRecord();
    const state: DrawingState = { ...baseState(), signatureRecord: record };
    const doc = new Drawing(state);
    const held = doc.snapshot.signatureRecord!;
    expect(Object.isFrozen(held)).toBe(false);
    expect(Object.isFrozen(held.payload)).toBe(false);
    // The contrary posture, asserted as behaviour: the seal does NOT protect the
    // record subtree. (Invalidation stickiness comes from the C2 API transitions,
    // never from seal enforcement.)
    held.payload[0] = 0x99;
    expect(record.payload[0]).toBe(0x99);
    (held as { status: string }).status = 'preserved-unverified';
    expect(record.status).toBe('preserved-unverified');
  });
});

describe('defensive copy — binds CAPTURE (AMENDMENT TO RULING-P31)', () => {
  it('mutating the source Uint8Array after capturePreservedSignature leaves the record bytes unchanged', () => {
    const source = new Uint8Array([0x01, 0x02, 0x03]);
    const record = capturePreservedSignature({
      payload: source,
      contentDigest: 'b'.repeat(64),
      sourceFormat: 'DWG',
    });
    source[0] = 0xff;
    source[1] = 0xff;
    expect(record.payload).not.toBe(source);
    expect(Array.from(record.payload)).toEqual([0x01, 0x02, 0x03]);
  });
});
