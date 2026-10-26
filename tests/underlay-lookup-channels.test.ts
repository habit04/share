/** C pins — withUnderlaySizeChannel discards the captured lookup's
 * other side channels (#63 review P2, vector part at plot-vector.ts's
 * page-tier wrap).
 *
 * The wrapper historically re-created a callable carrying ONLY
 * textGeometry (a live getter) and the new underlaySizeOf. On the
 * composed P20+P28 head the captured lookup also carries the P20 A.2
 * provenance channels — forDef (def-scope hook) and sources (per-file
 * provenance) — attached as own properties, and expansion through the
 * wrapped lookup silently lost the file scoping (Codex's raster cases:
 * wrong layer states and dangling names borrowing host defs). NOTE:
 * forDef/sources do not exist in THIS tree yet; the defect is latent
 * here and active on the composed head, so these pins are SYNTHETIC —
 * a fake captured lookup carrying the channels as own properties,
 * exactly the shape the composed tree's xref machinery attaches.
 *
 * The contract pinned: wrapping must preserve EVERY own channel of
 * the source lookup — by descriptor, so a getter stays live — with
 * forDef's results themselves wrapped (the size channel and the
 * sub-lookup's own channels survive nesting), and the supplied
 * sizeOf winning over any size channel the source already carries.
 */
import { describe, expect, it } from 'vitest';
import { withUnderlaySizeChannel, type BlockDef, type BlockLookup, type BlockLookupSources, type UnderlayEntity } from '../src/core/entities';
import type { TextGeometryContext } from '../src/core/text-metrics';

const sizeOf = (e: UnderlayEntity) => (e.definitionHandle === '41' ? { width: 612, height: 792 } : undefined);
const placement = { definitionHandle: '41' } as unknown as UnderlayEntity;

const def = (name: string): BlockDef => ({ name, basePoint: { x: 0, y: 0 }, entities: [], attributes: [] });

interface Channels {
  textGeometry?: TextGeometryContext;
  forDef?: (name: string, d: BlockDef) => BlockLookup;
  sources?: BlockLookupSources;
  [key: string]: unknown;
}

/** A captured-style lookup: a callable plus own-property channels,
 * attached the way the real producers attach them (Object.assign for
 * textGeometry in plot-fonts, defineProperty values in xref). */
function capturedLookup(blocks: Record<string, BlockDef>, channels: Channels): BlockLookup {
  const fn = ((name: string) => blocks[name]) as BlockLookup & Channels;
  for (const [key, value] of Object.entries(channels)) {
    Object.defineProperty(fn, key, { value, enumerable: true, configurable: true });
  }
  return fn as BlockLookup;
}

describe('C: withUnderlaySizeChannel preserves every channel of the captured lookup', () => {
  it('the callable and the live textGeometry getter survive wrapping (existing behaviour, kept)', () => {
    let current = { tag: 'first' } as unknown as TextGeometryContext;
    const base = ((_: string) => undefined) as BlockLookup;
    Object.defineProperty(base, 'textGeometry', { get: () => current, configurable: true });
    const wrapped = withUnderlaySizeChannel(base, sizeOf);
    expect(wrapped('anything')).toBeUndefined();
    expect(wrapped.textGeometry).toBe(current);
    // Liveness: reportPlotStyles reads textGeometry.fontIssues AFTER
    // the vector write; the channel must track the source's getter,
    // never a value frozen at wrap time.
    current = { tag: 'second' } as unknown as TextGeometryContext;
    expect(wrapped.textGeometry).toBe(current);
    expect(wrapped.underlaySizeOf?.(placement)).toEqual({ width: 612, height: 792 });
  });

  it('sources is delegated, by reference', () => {
    const sources: BlockLookupSources = {
      sourceFileKeyForDef: (defName: string) => (defName === 'CHILD' ? 'file-b' : undefined),
      fileLayers: (fileKey: string) => (fileKey === 'file-b' ? [{ name: 'B0' } as never] : []),
    };
    const wrapped = withUnderlaySizeChannel(capturedLookup({}, { sources }), sizeOf);
    expect(wrapped.sources).toBe(sources);
    expect(wrapped.sources?.sourceFileKeyForDef('CHILD')).toBe('file-b');
    expect(wrapped.sources?.fileLayers('file-b')).toHaveLength(1);
  });

  it('forDef is delegated AND its result is itself wrapped (size channel + own channels)', () => {
    const innerSources: BlockLookupSources = {
      sourceFileKeyForDef: () => 'file-b',
      fileLayers: () => [],
    };
    const inner = capturedLookup({ INNER: def('INNER') }, { sources: innerSources });
    const outer = capturedLookup({ OUTER: def('OUTER') }, {
      forDef: (_name: string, d: BlockDef) => (d.name === 'OUTER' ? inner : outer),
    });
    const wrapped = withUnderlaySizeChannel(outer, sizeOf);
    expect(typeof wrapped.forDef).toBe('function');
    const scoped = wrapped.forDef!('OUTER', def('OUTER'));
    expect(scoped('INNER')).toBe(inner('INNER'));
    expect(scoped.sources).toBe(innerSources);
    // The whole point of the wrap: the size channel must reach the
    // def-scoped expansion too.
    expect(scoped.underlaySizeOf?.(placement)).toEqual({ width: 612, height: 792 });
  });

  it('forDef chains nest: forDef of a forDef result still carries the size channel', () => {
    const leaf = capturedLookup({ LEAF: def('LEAF') }, {});
    const mid = capturedLookup({}, { forDef: () => leaf });
    const top = capturedLookup({}, { forDef: () => mid });
    const wrapped = withUnderlaySizeChannel(top, sizeOf);
    const level1 = wrapped.forDef!('A', def('A'));
    expect(level1.underlaySizeOf?.(placement)).toEqual({ width: 612, height: 792 });
    expect(typeof level1.forDef).toBe('function');
    const level2 = level1.forDef!('B', def('B'));
    expect(level2('LEAF')).toBe(leaf('LEAF'));
    expect(level2.underlaySizeOf?.(placement)).toEqual({ width: 612, height: 792 });
  });

  it('any other own channel (string- or symbol-keyed) is forwarded, not dropped', () => {
    const sym = Symbol('futureChannel');
    const base = capturedLookup({}, { extraChannel: { deep: true } });
    Object.defineProperty(base, sym, { value: 'symbol-value', enumerable: false });
    const wrapped = withUnderlaySizeChannel(base, sizeOf) as BlockLookup & Record<string | symbol, unknown>;
    expect(wrapped.extraChannel).toEqual({ deep: true });
    expect(wrapped[sym]).toBe('symbol-value');
  });

  it("the supplied sizeOf wins over a size channel the source already carries", () => {
    const stale = () => ({ width: 1, height: 1 });
    const base = capturedLookup({}, {});
    Object.defineProperty(base, 'underlaySizeOf', { value: stale, configurable: true });
    const wrapped = withUnderlaySizeChannel(base, sizeOf);
    expect(wrapped.underlaySizeOf).toBe(sizeOf);
    expect(wrapped.underlaySizeOf?.(placement)).toEqual({ width: 612, height: 792 });
  });

  it('GUARD: a plain channel-less lookup wraps to a callable with only the size channel added', () => {
    const plain: BlockLookup = (name: string) => (name === 'B' ? def('B') : undefined);
    const wrapped = withUnderlaySizeChannel(plain, sizeOf);
    expect(wrapped('B')?.name).toBe('B');
    expect(wrapped('nope')).toBeUndefined();
    expect(wrapped.textGeometry).toBeUndefined();
    expect(wrapped.forDef).toBeUndefined();
    expect(wrapped.sources).toBeUndefined();
    expect(wrapped.underlaySizeOf?.(placement)).toEqual({ width: 612, height: 792 });
  });
});
