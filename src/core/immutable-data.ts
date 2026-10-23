/**
 * Runtime counterpart of the drawing model's readonly data contract. Accepted data keeps its
 * identity (undo and geometry caches share it), but borrowed arrays and nested objects cannot
 * subsequently change it. Only objects traversed here qualify for identity memoization;
 * Object.isFrozen alone does not establish that an object's children are immutable.
 *
 * Root-key exemption (opt-in, AMENDMENT TO RULING-P31): a caller sealing a whole composite
 * root may name root keys whose subtrees are EXEMPT from certification. An exempt subtree is
 * not traversed, not frozen and not added to the sealed set — isImmutableData on the root
 * then certifies "sealed EXCEPT the exempt subtrees", and no caller may describe an exempt
 * subtree itself as sealed or immutable. The exemption is keyed by root + field name ONLY,
 * never by value shape: it applies solely to the named own properties of the exact object
 * passed as the root of THIS call, at depth 0. A custom prototype, an accessor, or a
 * Uint8Array anywhere else — inside any other field, or inside a nested object that merely
 * shares an exempt name — still throws exactly as without the exemption. With no exemption
 * argument the behaviour is byte-for-byte the original seal, for every caller. A root sealed
 * WITH an exemption is recorded as a partial seal in a separate set (never the unconditional
 * sealed fast-path set), so a later strict seal re-walks and fully certifies it (PR #41 (3)).
 */
const sealed = new WeakSet<object>();
/**
 * Roots sealed WITH root-key exemptions (PR #41 (3)): such a seal is
 * PARTIAL — it certifies "sealed EXCEPT the exempt subtrees" — and the
 * root is recorded HERE, never in the unconditional `sealed` fast-path
 * set, so a later strict seal (no exemption argument) re-walks it and
 * certifies the previously exempt subtrees like everything else. A
 * partial root completed inside a later walk WITHOUT the exemption is
 * promoted into `sealed` at that frame's completion.
 */
const partiallySealed = new WeakSet<object>();

export function isImmutableData(value: object): boolean {
  return sealed.has(value) || partiallySealed.has(value);
}

/** Iterative and sharing-aware: new arrays are visited once; unchanged geometry is skipped. */
export function sealImmutableData<T>(value: T, exemptRootKeys?: ReadonlySet<PropertyKey>): T {
  if (!value || typeof value !== 'object' || sealed.has(value)) return value;
  type Frame = { value: object; keys: PropertyKey[] | null; index: number; exempt?: ReadonlySet<PropertyKey>; partial?: boolean };
  const pending: Frame[] = [];
  const active = new WeakSet<object>();
  const enter = (object: object, isRoot = false): void => {
    if (sealed.has(object) || active.has(object)) return;
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== null && prototype !== (Array.isArray(object) ? Array.prototype : Object.prototype)) {
      throw new TypeError('Drawing snapshot data must use plain objects and arrays, not custom prototypes.');
    }
    Object.freeze(object);
    active.add(object);
    pending.push({
      value: object,
      keys: Array.isArray(object) ? null : Reflect.ownKeys(object),
      index: 0,
      exempt: isRoot ? exemptRootKeys : undefined,
      partial: isRoot && exemptRootKeys !== undefined ? true : undefined,
    });
  };
  enter(value, true);
  while (pending.length) {
    const frame = pending[pending.length - 1]!;
    const length = frame.keys?.length ?? (frame.value as unknown[]).length;
    if (frame.index >= length) {
      // Only the root frame of an exempting call completes partially;
      // every other completed object was walked in full and is promoted
      // into the unconditional set (leaving the partial set behind).
      if (frame.partial) {
        partiallySealed.add(frame.value);
      } else {
        sealed.add(frame.value);
        partiallySealed.delete(frame.value);
      }
      active.delete(frame.value);
      pending.pop();
      continue;
    }
    const key = frame.keys ? frame.keys[frame.index]! : frame.index;
    frame.index += 1;
    // Exempt root key (root frame only): the subtree is outside certification entirely —
    // its descriptor is not inspected and its value is never entered.
    if (frame.exempt?.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(frame.value, key);
    // A frozen getter can still return changing geometry from a closure. Drawing snapshots
    // contain value data, so do not certify dynamic accessors as safe cache identities.
    if (descriptor && !('value' in descriptor)) throw new TypeError('Drawing snapshot data must use value properties, not accessors.');
    const child = descriptor?.value as unknown;
    if (child && typeof child === 'object') enter(child);
  }
  return value;
}
