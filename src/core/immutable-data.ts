/**
 * Runtime counterpart of the drawing model's readonly data contract. Accepted data keeps its
 * identity (undo and geometry caches share it), but borrowed arrays and nested objects cannot
 * subsequently change it. Only objects traversed here qualify for identity memoization;
 * Object.isFrozen alone does not establish that an object's children are immutable.
 */
const sealed = new WeakSet<object>();

export function isImmutableData(value: object): boolean {
  return sealed.has(value);
}

/** Iterative and sharing-aware: new arrays are visited once; unchanged geometry is skipped. */
export function sealImmutableData<T>(value: T): T {
  if (!value || typeof value !== 'object' || sealed.has(value)) return value;
  type Frame = { value: object; keys: PropertyKey[] | null; index: number };
  const pending: Frame[] = [];
  const active = new WeakSet<object>();
  const enter = (object: object): void => {
    if (sealed.has(object) || active.has(object)) return;
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== null && prototype !== (Array.isArray(object) ? Array.prototype : Object.prototype)) {
      throw new TypeError('Drawing snapshot data must use plain objects and arrays, not custom prototypes.');
    }
    Object.freeze(object);
    active.add(object);
    pending.push({ value: object, keys: Array.isArray(object) ? null : Reflect.ownKeys(object), index: 0 });
  };
  enter(value);
  while (pending.length) {
    const frame = pending[pending.length - 1]!;
    const length = frame.keys?.length ?? (frame.value as unknown[]).length;
    if (frame.index >= length) {
      sealed.add(frame.value);
      active.delete(frame.value);
      pending.pop();
      continue;
    }
    const key = frame.keys ? frame.keys[frame.index]! : frame.index;
    frame.index += 1;
    const descriptor = Object.getOwnPropertyDescriptor(frame.value, key);
    // A frozen getter can still return changing geometry from a closure. Drawing snapshots
    // contain value data, so do not certify dynamic accessors as safe cache identities.
    if (descriptor && !('value' in descriptor)) throw new TypeError('Drawing snapshot data must use value properties, not accessors.');
    const child = descriptor?.value as unknown;
    if (child && typeof child === 'object') enter(child);
  }
  return value;
}
