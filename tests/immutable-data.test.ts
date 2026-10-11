import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { entityGeometryWork, type TextEntity } from '../src/core/entities';
import { isImmutableData, sealImmutableData } from '../src/core/immutable-data';

const textFields = { id: 'source', type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, height: 1, rotation: 0, align: 'left' };

describe('plain immutable drawing data', () => {
  it('preserves ordinary objects, null-prototype records, arrays and shared identities', () => {
    const point = { x: 1, y: 2 };
    const record = Object.assign(Object.create(null) as Record<string, unknown>, { point });
    const array = [point, record];
    const value = { array, record };
    expect(sealImmutableData(value)).toBe(value);
    expect(value.array).toBe(array);
    expect(value.record).toBe(record);
    expect(array[0]).toBe(point);
    for (const item of [value, array, record, point]) {
      expect(isImmutableData(item)).toBe(true);
      expect(Object.isFrozen(item)).toBe(true);
    }
    expect(() => { point.x = 3; }).toThrow(TypeError);
    expect(() => { record.newValue = true; }).toThrow(TypeError);
  });

  it('rejects inherited text before it can bypass a drawing work cache', () => {
    const prototype = { text: 'X' };
    const entity = Object.assign(Object.create(prototype), textFields) as TextEntity;
    expect(entityGeometryWork(entity)).toBe(2);
    expect(() => new Drawing({ entities: [entity] })).toThrow(/custom prototypes/);
    expect(isImmutableData(entity)).toBe(false);
    prototype.text = 'X'.repeat(1_000_000);
    expect(entityGeometryWork(entity)).toBe(1_000_001);
  });

  it('rejects inherited getter-backed data without certifying or invoking the getter', () => {
    let reads = 0;
    const prototype = Object.defineProperty({}, 'text', { get: () => { reads += 1; return 'changing'; } });
    const entity = Object.assign(Object.create(prototype), textFields) as TextEntity;
    expect(() => sealImmutableData(entity)).toThrow(/custom prototypes/);
    expect(reads).toBe(0);
    expect(isImmutableData(entity)).toBe(false);
    expect(Object.isFrozen(entity)).toBe(false);
  });

  it('rejects custom array prototypes even when every entry is plain data', () => {
    const array = [{ x: 0, y: 0 }];
    Object.setPrototypeOf(array, Object.create(Array.prototype));
    expect(() => sealImmutableData(array)).toThrow(/custom prototypes/);
    expect(isImmutableData(array)).toBe(false);
    expect(Object.isFrozen(array)).toBe(false);
  });

  it('keeps the document and history intact when a transaction contains inherited data', () => {
    const doc = new Drawing();
    doc.addEntities([{ ...textFields, text: 'keep' } as TextEntity]);
    const state = doc.snapshot, history = doc.history(), revision = doc.revision;
    doc.dirty = false;
    const entity = Object.assign(Object.create({ text: 'X' }), textFields, { id: 'inherited' }) as TextEntity;
    expect(() => doc.transact((current) => ({ ...current, entities: [...current.entities, entity] }))).toThrow(/custom prototypes/);
    expect(doc.snapshot).toBe(state);
    expect(doc.history()).toEqual(history);
    expect(doc.revision).toBe(revision);
    expect(doc.dirty).toBe(false);
  });
});
