import { describe, expect, it } from 'vitest';
import {
  ShapePreparationSession,
  type ShapeBridge,
  type ShapeFaceCandidate,
} from '../src/app/shape-preparation';
import { itemizeParagraph, type ShapedItemDerivation } from '../src/core/text-pipeline';
import type { ShapeProductionData } from '../src/core/text-shaping-produce';
import type { TextAppearance } from '../src/core/text-metrics';

const APPEARANCE: TextAppearance = { kind: 'canvas', family: 'Fake', bold: false, italic: false, widthFactor: 1, oblique: 0 };

/** A synthetic face: covers a code-point set with fixed advances. */
function fakeCandidate(family: string, covered: (cp: number) => boolean): ShapeFaceCandidate {
  const cmap: number[] = new Array(0x10000).fill(0);
  for (let cp = 0; cp < 0x10000; cp += 1) if (covered(cp)) cmap[cp] = (cp % 0x2ff) + 1;
  const glyphCount = 0x300;
  return {
    descriptor: { family },
    faceIndex: 0,
    cmap,
    capitalHeight: 800,
    metrics: {
      advances: new Array(glyphCount).fill(600),
      glyphBounds: Array.from({ length: glyphCount }, () => [0, -200, 600, 800] as const),
      glyphBoundsKnown: new Array(glyphCount).fill(true),
      unitsPerEm: 1000,
    },
    programBytes: 100_000,
  };
}

/** Deterministic fake engine: one glyph per code point in the
    requested item range, clusters item-relative, fixed advance —
    reference and subitem productions therefore agree exactly,
    unless `disagree` makes subitem productions (a range that is
    not the whole context item) advance differently. */
function fakeBridge(candidatesByFamily: Map<string, ShapeFaceCandidate>, options: { disagree?: boolean; programSha?: string } = {}): ShapeBridge {
  return async (request) => {
    const candidate = candidatesByFamily.get(String(request.descriptor.family));
    if (!candidate) return { shaped: null, problem: 'unknown fake family' };
    const { text, itemStart, itemEnd } = request.shape;
    const glyphs: ShapeProductionData['glyphs'][number][] = [];
    let cursor = itemStart;
    for (const char of text.slice(itemStart, itemEnd)) {
      const cp = char.codePointAt(0)!;
      const advance = options.disagree && itemStart > 0 ? 601 : 600;
      glyphs.push({
        glyph: candidate.cmap[cp] ?? 0,
        clusterStart: cursor - itemStart,
        clusterEnd: cursor - itemStart + char.length,
        xAdvance: advance,
        yAdvance: 0,
        xOffset: 0,
        yOffset: 0,
      });
      cursor += char.length;
    }
    return {
      shaped: {
        glyphs,
        unitsPerEm: 1000,
        faceGlyphCount: 0x300,
        programSha256: options.programSha ?? 'ab'.repeat(32),
        programBytes: 100_000,
      },
    };
  };
}

function derivationOf(text: string): ShapedItemDerivation {
  const item = itemizeParagraph(text).items.find((entry) => entry.route === 'shaped');
  if (!item || item.route !== 'shaped') throw new Error('expected a shaped item');
  return item.derivation;
}

const arabic = (cp: number) => cp >= 0x600 && cp <= 0x6ff;

describe('ShapePreparationSession', () => {
  it('serves a ready run for a whole-item single-face preparation', async () => {
    const candidate = fakeCandidate('FakeArabic', arabic);
    const session = new ShapePreparationSession(fakeBridge(new Map([['FakeArabic', candidate]])), () => [candidate]);
    const contextId = {};
    const text = 'سلام';
    expect(session.lookup(contextId, text, derivationOf(text)).state).toBe('missing');
    await session.prepareParagraph(contextId, text, APPEARANCE);
    const state = session.lookup(contextId, text, derivationOf(text));
    expect(state.state).toBe('ready');
    if (state.state !== 'ready') return;
    expect(state.subitems).toHaveLength(1);
    expect(state.subitems[0]!.run.advanceX).toBe(600 * 4);
    expect(state.subitems[0]!.run.binding.programSha256).toBe('ab'.repeat(32));
  });

  it('splits coverage across the fallback chain and admits each subitem', async () => {
    const aOnly = fakeCandidate('A', (cp) => cp === 0x627);
    const bOnly = fakeCandidate('B', (cp) => cp === 0x628);
    const bridge = fakeBridge(new Map([['A', aOnly], ['B', bOnly]]));
    // Per-family program hashes: wrap the bridge so each family
    // reports its own program identity.
    const perFamily: ShapeBridge = async (request) => {
      const result = await bridge(request);
      if (result && result.shaped) {
        return { shaped: { ...result.shaped, programSha256: (request.descriptor.family === 'A' ? 'aa' : 'bb').repeat(32) } };
      }
      return result;
    };
    const session = new ShapePreparationSession(perFamily, () => [aOnly, bOnly]);
    const contextId = {};
    const text = 'اب';
    await session.prepareParagraph(contextId, text, APPEARANCE);
    const state = session.lookup(contextId, text, derivationOf(text));
    expect(state.state).toBe('ready');
    if (state.state !== 'ready') return;
    expect(state.subitems).toHaveLength(2);
    expect(state.subitems.map((s) => s.run.binding.programSha256)).toEqual(['aa'.repeat(32), 'bb'.repeat(32)]);
  });

  it('refuses a subitem whose production disagrees with the whole-context reference (the mark-split gate)', async () => {
    const aOnly = fakeCandidate('A', (cp) => cp === 0x627);
    const bOnly = fakeCandidate('B', arabic);
    const bridge = fakeBridge(new Map([['A', aOnly], ['B', bOnly]]), { disagree: true });
    const session = new ShapePreparationSession(bridge, () => [aOnly, bOnly]);
    const contextId = {};
    const text = 'اب';
    await session.prepareParagraph(contextId, text, APPEARANCE);
    const state = session.lookup(contextId, text, derivationOf(text));
    expect(state.state).toBe('refused');
    if (state.state !== 'refused') return;
    expect(state.problem.length).toBeGreaterThan(0);
  });

  it('refuses with a named problem when no face covers part of the item', async () => {
    const partial = fakeCandidate('P', (cp) => cp === 0x627);
    const session = new ShapePreparationSession(fakeBridge(new Map([['P', partial]])), () => [partial]);
    const contextId = {};
    const text = 'اب';
    await session.prepareParagraph(contextId, text, APPEARANCE);
    const state = session.lookup(contextId, text, derivationOf(text));
    expect(state.state).toBe('refused');
    if (state.state !== 'refused') return;
    expect(state.problem).toContain('no-face-coverage');
  });

  it('refuses on face identity drift between productions', async () => {
    const aOnly = fakeCandidate('A', (cp) => cp === 0x627);
    const bOnly = fakeCandidate('B', arabic);
    let calls = 0;
    const base = fakeBridge(new Map([['A', aOnly], ['B', bOnly]]));
    const drifting: ShapeBridge = async (request) => {
      calls += 1;
      const result = await base(request);
      // The second production (candidate A's subitem, after its
      // reference established A's identity) reports a different
      // program hash than the reference did.
      if (result && result.shaped && calls === 2) {
        return { shaped: { ...result.shaped, programSha256: 'cd'.repeat(32) } };
      }
      return result;
    };
    const session = new ShapePreparationSession(drifting, () => [aOnly, bOnly]);
    const contextId = {};
    const text = 'اب';
    await session.prepareParagraph(contextId, text, APPEARANCE);
    const state = session.lookup(contextId, text, derivationOf(text));
    expect(state.state).toBe('refused');
    if (state.state !== 'refused') return;
    expect(state.problem).toContain('face-identity-drift');
  });

  it('makes no bridge calls for direct-only text', async () => {
    let calls = 0;
    const bridge: ShapeBridge = async () => {
      calls += 1;
      return null;
    };
    const session = new ShapePreparationSession(bridge, () => []);
    const contextId = {};
    await session.prepareParagraph(contextId, 'Hello 123', APPEARANCE);
    expect(calls).toBe(0);
  });

  it('ledgers every production through its full lifecycle (nothing leaks)', async () => {
    const candidate = fakeCandidate('FakeArabic', arabic);
    const session = new ShapePreparationSession(fakeBridge(new Map([['FakeArabic', candidate]])), () => [candidate]);
    const contextId = {};
    await session.prepareParagraph(contextId, 'سلام', APPEARANCE);
    // Every job reserved, ran, validated, and exit-joined: the
    // ledger holds no jobs, no active workers, and no charge.
    expect(session.ledger.jobCount).toBe(0);
    expect(session.ledger.activeWorkerCount).toBe(0);
    expect(session.ledger.totalChargedBytes).toBe(0);
  });
});
