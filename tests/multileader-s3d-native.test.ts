/**
 * P18 slice 3 delta S3-D (RULING-P18-S3-D): native annotative layout —
 * extension-dictionary context objects + the corrected group-40 convention
 * (40 = drawing units per paper unit, a VERIFIED FACT on the lead's handbuilt
 * AutoCAD 2027 fixtures, no longer an assumption).
 *
 * The oracle is the lead's fixture package (intake-verified; the DXFs are
 * committed under tests/fixtures/, the package's evidence/ logs are NOT —
 * they echo a local working path, D4):
 *   E  p18-mleader-annotative-mtext.dxf            (c71cf391…)
 *   F  p18-mleader-annotative-block.dxf            (422b249c…)
 *   N  p18-mleader-annotative-mtext-NEGCTRL-1to2-removed.dxf (f11588e0…)
 * AutoCAD writes only the primary CONTEXT_DATA inline; the additional
 * contexts are ACDB_MLEADEROBJECTCONTEXTDATA_CLASS objects in OBJECTS behind
 * the entity's extension dictionary (… -> 'AcDbContextDataManager' (360) ->
 * 'ACDB_ANNOTATIONSCALES' (350) -> '*A<n>' entries (350) -> objects). The
 * default object is the one whose AcDbObjectContextData-level 290 = 1.
 *
 * At the S3-D base head (aa76a2b) the import-resolution legs FAIL: the
 * entity-section count is 1 for all three fixtures, the contexts are
 * invisible, F's block content is withheld by the slice-2 attribute-index
 * resolution against real 1-based 177 values / 44 = 0 widths, and the
 * display match applies the reciprocal convention.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LeaderEntity } from '../src/core/entities';
import { entityGeometryWork } from '../src/core/entities';
import { MAX_DRAWING_EXPANSION_WORK, validateGeometryBudget } from '../src/core/geometry-budget';
import { annotativeEntity, cannoscaleValue, mleaderContextForScale } from '../src/core/layouts';
import { readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf } from '../src/io/import-report';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const E = fixture('p18-mleader-annotative-mtext.dxf');
const F = fixture('p18-mleader-annotative-block.dxf');
const NEG = fixture('p18-mleader-annotative-mtext-NEGCTRL-1to2-removed.dxf');

/** Pair lines of a DXF text (code lines trimmed, value lines verbatim). */
const toPairs = (text: string): Array<[string, string]> => {
  const ls = text.split(/\r?\n/);
  const out: Array<[string, string]> = [];
  for (let i = 0; i + 1 < ls.length; i += 2) out.push([ls[i]!.trim(), ls[i + 1]!]);
  return out;
};
const fromPairs = (pairs: Array<[string, string]>): string => pairs.map(([c, v]) => `${c}\n${v}`).join('\n');
/** Records of a DXF text: each starts at a code-0 pair. */
const recordsOf = (text: string): Array<{ kind: string; groups: Array<[string, string]> }> => {
  const out: Array<{ kind: string; groups: Array<[string, string]> }> = [];
  for (const p of toPairs(text)) {
    if (p[0] === '0') out.push({ kind: p[1].trim(), groups: [] });
    else out[out.length - 1]?.groups.push(p);
  }
  return out;
};
const leaderOf = (state: ReturnType<typeof readDxf>): LeaderEntity =>
  state.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
const reportOf = (state: ReturnType<typeof readDxf>) =>
  (importReportOf(state)?.items ?? []).map((i) => ({ type: i.type, action: i.action, reason: i.reason }));
const ctxOpeners = (text: string): number => (text.match(/CONTEXT_DATA\{/g) ?? []).length;
const objectRecords = (text: string) => recordsOf(text).filter((r) => r.kind === 'ACDB_MLEADEROBJECTCONTEXTDATA_CLASS');
/** Model equality at the codec's own precision: the DXF writer's number
 *  format carries 10 significant decimals, so AutoCAD's 17-digit doubles
 *  (3.183069577080491) round-trip to the format's value (3.1830695771). The
 *  byte fixed point (second write === first) is asserted separately and is
 *  the strict claim; this rounding makes the model comparison honest. */
const rounded = (v: unknown): unknown => {
  if (typeof v === 'number') return Math.round(v * 1e10) / 1e10;
  if (Array.isArray(v)) return v.map(rounded);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rounded(x)]));
  return v;
};

/** E with the entity's extension-dictionary 360 reference dangled (W3 leg). */
const danglingChainE = (): string => {
  const pairs = toPairs(E);
  const entAt = pairs.findIndex(([c, v]) => c === '0' && v.trim() === 'MULTILEADER');
  const subAt = pairs.findIndex((p, i) => i > entAt && p[0] === '102' && p[1].includes('ACAD_XDICTIONARY'));
  pairs[subAt + 1] = ['360', 'ZZZ9'];
  return fromPairs(pairs);
};
/** E with the additional (1:2) object's group 40 removed (W3 leg). */
const object40RemovedE = (): string => {
  const pairs = toPairs(E);
  const recAt = pairs.findIndex(([c, v], i) => c === '5' && v.trim() === '26D' && pairs[i - 1]?.[0] === '0');
  const markerAt = pairs.findIndex((p, i) => i > recAt && p[0] === '100' && p[1].trim() === 'AcDbAnnotScaleObjectContextData');
  const at40 = pairs.findIndex((p, i) => i > markerAt && p[0] === '40');
  pairs.splice(at40, 1);
  return fromPairs(pairs);
};
/** E plus a hand-added inline additional CONTEXT_DATA section (W4 both-dialects). */
const bothDialectsE = (): string => {
  const pairs = toPairs(E);
  const entAt = pairs.findIndex(([c, v]) => c === '0' && v.trim() === 'MULTILEADER');
  const openAt = pairs.findIndex((p, i) => i > entAt && p[0] === '300');
  const closeAt = pairs.findIndex((p, i) => i > openAt && p[0] === '301');
  const section = pairs.slice(openAt, closeAt + 1).map(([c, v]) => [c, v] as [string, string]);
  let textSeen = false;
  for (const p of section) {
    if (p[0] === '40') p[1] = '4';
    if (p[0] === '304' && !textSeen) { p[1] = 'INLINE-ALT'; textSeen = true; }
  }
  pairs.splice(closeAt + 1, 0, ...section);
  return fromPairs(pairs);
};
/** E with `count` extra clones of the 1:2 object (fresh handles, `*A<n>` entries, padded text). */
const manyContextsE = (count: number, text: string): string => {
  const pairs = toPairs(E);
  const scalesAt = pairs.findIndex(([c, v], i) => c === '5' && v.trim() === '26B' && pairs[i - 1]?.[0] === '0');
  let scalesEnd = scalesAt;
  while (scalesEnd < pairs.length && pairs[scalesEnd]?.[0] !== '0') scalesEnd += 1;
  const objAt = pairs.findIndex(([c, v], i) => c === '5' && v.trim() === '26D' && pairs[i - 1]?.[0] === '0');
  let objEnd = objAt;
  while (objEnd < pairs.length && pairs[objEnd]?.[0] !== '0') objEnd += 1;
  const template = pairs.slice(objAt - 1, objEnd);
  const additions: Array<[string, string]> = [];
  const clones: Array<[string, string]> = [];
  for (let k = 0; k < count; k += 1) {
    const handle = (0x300 + k).toString(16).toUpperCase();
    additions.push(['3', `*A${k + 3}`], ['350', handle]);
    let textSeen = false;
    for (const [c, v] of template) {
      if (c === '5') clones.push(['5', handle]);
      else if (c === '304' && !textSeen) { clones.push(['304', text]); textSeen = true; }
      else clones.push([c, v]);
    }
  }
  pairs.splice(objEnd, 0, ...clones);
  const at = pairs.findIndex(([c, v], i) => c === '5' && v.trim() === '26B' && pairs[i - 1]?.[0] === '0');
  let end = at;
  while (end < pairs.length && pairs[end]?.[0] !== '0') end += 1;
  pairs.splice(end, 0, ...additions);
  return fromPairs(pairs);
};

describe('P18 S3-D: Fixture E (MTEXT) imports its object contexts', () => {
  it('models the primary from the inline section and the 1:2 context from its object', () => {
    const notes: string[] = [];
    const s = readDxf(E, { notes });
    const l = leaderOf(s);
    expect(l.kind).toBe('mleader');
    expect(l.text).toBe('FIXTURE-E');
    expect(l.vertices).toEqual([{ x: 0, y: 0 }, { x: 4, y: 3 }]);
    expect(l.textPosition).toEqual({ x: 4.45, y: 3.091534788540245 });
    expect(l.textHeight).toBeCloseTo(0.18);
    const n = l.mleader!;
    expect(n.contentType).toBe('mtext');
    expect(n.scaleFactor).toBe(1);
    expect(n.landingGap).toBeCloseTo(0.09);
    expect(l.arrowSize).toBeCloseTo(0.18);
    const contexts = n.contexts!;
    expect(contexts).toHaveLength(1);
    const c = contexts[0]!;
    expect(c.scaleFactor).toBe(2);
    expect(c.textHeight).toBeCloseTo(0.36);
    expect(c.arrowSize).toBeCloseTo(0.36);
    expect(c.landingGap).toBeCloseTo(0.18);
    expect(c.text).toBe('FIXTURE-E');
    expect(c.paths).toEqual([[{ x: 0, y: 0 }, { x: 4, y: 3 }]]);
    expect(c.dogleg).toEqual({ x: 0.72, y: 0 });
    // Modelled: informational note only, no simplified entry.
    expect(notes.join(' ')).toMatch(/annotative contexts are kept as native data/);
    expect(reportOf(s).some((i) => i.action === 'simplified')).toBe(false);
  });

  it('the corrected match resolves the 1:2 context at CANNOSCALE 1:2 and the primary at 1:1', () => {
    const s = readDxf(E);
    const l = leaderOf(s);
    // mleaderContextForScale's argument IS the annotative factor f
    // (drawing units per paper unit): for scale name 1:2, f = 2.
    expect(mleaderContextForScale(l, 2)?.scaleFactor).toBe(2);
    expect(mleaderContextForScale(l, 1)?.scaleFactor).toBe(1);
    expect(mleaderContextForScale(l, 0.5)).toBeUndefined();
    // Display projection through annotativeEntity at the drawing's own
    // CANNOSCALE (E's header names 1:2): f = 1 / cannoscaleValue('1:2') = 2.
    expect(s.header?.cannoscale).toBe('1:2');
    const f = 1 / cannoscaleValue(s.header?.cannoscale);
    const at12 = annotativeEntity(l, f) as LeaderEntity;
    expect(at12).not.toBe(l);
    expect(at12.mleader?.scaleFactor).toBe(2);
    expect(at12.textHeight).toBeCloseTo(0.36);
    expect(at12.mleader?.contexts).toHaveLength(1);
    expect(at12.mleader?.contexts?.[0]?.scaleFactor).toBe(1);
    // At 1:1 the primary matches and the entity is returned unchanged.
    expect(annotativeEntity(l, 1 / cannoscaleValue('1:1'))).toBe(l);
  });
});

describe('P18 S3-D: Fixture F (block) imports its object contexts', () => {
  it('models the block, its attributes, and the 1:2 object placement', () => {
    const notes: string[] = [];
    const s = readDxf(F, { notes });
    const l = leaderOf(s);
    const n = l.mleader!;
    expect(n.contentType).toBe('block');
    // Trailing attributes resolve by their ATTDEF handle (the 177 values in
    // the real file are the 1-based ordinals 1 and 2; the stored model index
    // is the definition position). 44 = 0 is no width, not a zero width.
    expect(n.block).toEqual({
      name: 'TAGBLOCK',
      position: { x: 5.36, y: 3 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      attributes: [
        { index: 0, tag: 'PART', value: 'P-100' },
        { index: 1, tag: 'REV', value: 'A' },
      ],
    });
    const contexts = n.contexts!;
    expect(contexts).toHaveLength(1);
    const c = contexts[0]!;
    expect(c.scaleFactor).toBe(2);
    expect(c.textHeight).toBeCloseTo(0.36);
    expect(c.arrowSize).toBeCloseTo(0.36);
    expect(c.landingGap).toBeCloseTo(0.18);
    expect(c.paths).toEqual([[{ x: 0, y: 0 }, { x: 4, y: 3 }]]);
    expect(c.block?.position.x).toBeCloseTo(6.72, 9);
    expect(c.block?.position.y).toBe(3);
    expect(c.block?.scale).toEqual({ x: 2, y: 2 });
    expect(c.block?.rotation).toBe(0);
    expect(notes.join(' ')).toMatch(/block content is kept as native data/);
    expect(notes.join(' ')).toMatch(/annotative contexts are kept as native data/);
    expect(reportOf(s).some((i) => i.action === 'simplified')).toBe(false);
  });
});

describe('P18 S3-D: the negative control imports as single-context', () => {
  it('no contexts field, no annotative note, no simplified entry', () => {
    const notes: string[] = [];
    const s = readDxf(NEG, { notes });
    const l = leaderOf(s);
    expect(l.mleader?.contentType).toBe('mtext');
    expect(l.mleader?.scaleFactor).toBe(1);
    expect(l.mleader?.contexts).toBeUndefined();
    expect(l.text).toBe('FIXTURE-E');
    expect(notes.join(' ')).not.toMatch(/annotative contexts/);
    expect(reportOf(s).some((i) => i.action === 'simplified')).toBe(false);
  });
});

describe('P18 S3-D: write-back emits the AutoCAD object layout', () => {
  it('E: one inline section, a chain, objects for ALL contexts, fixed point', () => {
    const s = readDxf(E);
    const out = writeDxf(s);
    expect(ctxOpeners(out)).toBe(1);
    const objs = objectRecords(out);
    expect(objs).toHaveLength(2);
    // Object order: the primary's object first (290 = 1, 40 = 1), then the
    // additional (290 = 0, 40 = 2) — group 40 verbatim.
    const flagAndScale = objs.map((o) => {
      const at = o.groups.findIndex(([c, v]) => c === '100' && v.trim() === 'AcDbObjectContextData');
      const flag = o.groups.slice(at).find(([c]) => c === '290')?.[1];
      const scale = o.groups.slice(at).find(([c]) => c === '40')?.[1];
      return [flag?.trim(), scale?.trim()];
    });
    expect(flagAndScale).toEqual([['1', '1'], ['0', '2']]);
    // The chain: the entity names a dictionary whose entry is the manager.
    expect(out).toContain('AcDbContextDataManager');
    expect(out).toContain('ACDB_ANNOTATIONSCALES');
    expect(out).toContain('*A1');
    expect(out).toContain('*A2');
    // 340 (P18 FIX group 1 — the native gate superseded RULING-P18-S3-D
    // (5)(vi)(beta)): the writer creates no scale list for E (the source
    // list is retained), and EVERY object carries its 340 to the RETAINED
    // source SCALE — B7 ('1:1') for the primary's object, 124 ('1:2') for
    // the additional's, exactly as the source file carries them.
    const refs = objs.map((o) => {
      const at = o.groups.findIndex(([c, v]) => c === '100' && v.trim() === 'AcDbAnnotScaleObjectContextData');
      return o.groups[at + 1]?.[0] === '340' ? o.groups[at + 1]![1].trim() : undefined;
    });
    expect(refs).toEqual(['B7', '124']);
    // Reimport resolves the same model; a second write is byte-identical.
    const back = readDxf(out);
    expect(rounded(leaderOf(back).mleader)).toEqual(rounded(leaderOf(s).mleader));
    expect(writeDxf(back)).toBe(out);
  });

  it('F: block contexts ride the object layout too, fixed point', () => {
    const s = readDxf(F);
    const out = writeDxf(s);
    expect(ctxOpeners(out)).toBe(1);
    const objs = objectRecords(out);
    expect(objs).toHaveLength(2);
    const back = readDxf(out);
    expect(rounded(leaderOf(back).mleader)).toEqual(rounded(leaderOf(s).mleader));
    expect(writeDxf(back)).toBe(out);
  });

  it('negative control: the writer emits no apparatus (the disclosed normalisation)', () => {
    // The WRITER's own emission is asserted on the graph-free state: for a
    // default-only file the writer writes inline-only — the default object
    // duplicates the primary and its omission is the normalisation
    // RULING-P18-S3-D (3)(iv) discloses (the cad-graph retained-raw path,
    // which may carry the source apparatus for a graph-carrying state, is
    // untouched by this delta and is not what this leg measures).
    const s = readDxf(NEG);
    const bare = { ...s, cadGraph: undefined } as ReturnType<typeof readDxf>;
    const out = writeDxf(bare);
    expect(objectRecords(out)).toHaveLength(0);
    expect(out).not.toContain('AcDbContextDataManager');
    expect(ctxOpeners(out)).toBe(1);
    const back = readDxf(out);
    // The graph-free normalisation also drops the primary's source scale
    // NAME (P18 FIX group 1): it rode on the omitted default object's 340,
    // and with no apparatus written there is nothing to capture it from.
    expect(rounded(leaderOf(back).mleader)).toEqual(rounded({ ...leaderOf(s).mleader, scaleName: undefined }));
    // On the graph-carrying path the round trip is a fixed point too, and
    // the reimport stays single-context (whatever the retained-raw path
    // carries, the MODEL never gains a contexts field from it).
    const gen1 = writeDxf(s);
    const backG = readDxf(gen1);
    expect(leaderOf(backG).mleader?.contexts).toBeUndefined();
    expect(writeDxf(backG)).toBe(gen1);
  });

  it('authored drawing: every object carries its 340 — the cannoscale one to the list SCALE, the other to a SCALE created for it', () => {
    // No cadGraph, header CANNOSCALE 1:2 (P18 FIX group 1): the writer
    // creates the scale list holding the current scale AND a SCALE for the
    // other context's scale — an object without a 340 is what AutoCAD
    // discards the drawing for, so neither object goes without one.
    const s = readDxf(E);
    const authored = {
      ...s,
      cadGraph: undefined,
      header: { ...s.header!, cannoscale: '1:2' },
    } as ReturnType<typeof readDxf>;
    const out = writeDxf(authored);
    const objs = objectRecords(out);
    expect(objs).toHaveLength(2);
    const scales = recordsOf(out).filter((r) => r.kind === 'SCALE');
    expect(scales).toHaveLength(2);
    const handleOf = (name: string): string | undefined =>
      scales.find((r) => r.groups.find(([c]) => c === '300')?.[1].trim() === name)?.groups.find(([c]) => c === '5')?.[1].trim();
    expect(handleOf('1:2')).toBeDefined();
    expect(handleOf('1:1')).toBeDefined();
    const refOf = (o: (typeof objs)[number]): string | undefined => {
      const at = o.groups.findIndex(([c, v]) => c === '100' && v.trim() === 'AcDbAnnotScaleObjectContextData');
      return o.groups[at + 1]?.[0] === '340' ? o.groups[at + 1]![1].trim() : undefined;
    };
    expect(refOf(objs[0]!)).toBe(handleOf('1:1'));
    expect(refOf(objs[1]!)).toBe(handleOf('1:2'));
  });
});

describe('P18 S3-D: object-path withholding legs', () => {
  const withheldShape = (text: string): void => {
    const notes: string[] = [];
    const s = readDxf(text, { notes });
    const l = leaderOf(s);
    expect(l.mleader).toBeUndefined();
    expect(l.text).toBe('FIXTURE-E');
    expect(l.vertices).toEqual([{ x: 0, y: 0 }, { x: 4, y: 3 }]);
    expect(notes.join(' ')).toMatch(/annotative contexts are not kept/);
    expect(reportOf(s)).toContainEqual({
      type: 'MULTILEADER',
      action: 'simplified',
      reason: 'its annotative contexts are not kept; the leader and its text are',
    });
  };
  it('a dangled 360 reference withholds whole-entity (W3)', () => {
    withheldShape(danglingChainE());
  });
  it('a context object with its group 40 removed withholds whole-entity (W3)', () => {
    withheldShape(object40RemovedE());
  });
  it('inline additional sections AND an engaged chain withhold, never merge (W4)', () => {
    withheldShape(bothDialectsE());
  });
});

describe('P18 S3-D: the retained-object question (RULING-P18-S3-D (3)(vii))', () => {
  it('a WITHHELD entity’s OBJECTS context objects do NOT survive a save', () => {
    // REQUIRED TEST, outcome reported verbatim in the delivery either way.
    // Observed at the S3-D head: the withheld (dangling-join) entity saves
    // as its legacy leader; its source context objects do NOT survive via
    // the generic retained-object path — the output carries ZERO context
    // objects and no scales dictionary. The withheld state is stable: the
    // reimport withholds again and the second write is byte-identical.
    // Per the ruling this does not block the delta; it rides as a named
    // limitation in the composed README if it persists.
    const s = readDxf(danglingChainE());
    expect(leaderOf(s).mleader).toBeUndefined();
    const out = writeDxf(s);
    expect(objectRecords(out)).toHaveLength(0);
    expect(out).not.toContain('ACDB_ANNOTATIONSCALES');
    const back = readDxf(out);
    expect(leaderOf(back).mleader).toBeUndefined();
    expect(writeDxf(back)).toBe(out);
  });
});

describe('P18 S3-D: object-sourced geometry charge (O-B proof)', () => {
  it('charges object contexts proportionally under the S3-C term set', () => {
    const base = entityGeometryWork(leaderOf(readDxf(E)));
    const s = readDxf(manyContextsE(10, 'X'.repeat(100)));
    const l = leaderOf(s);
    expect(l.mleader?.contexts).toHaveLength(11);
    // Per cloned context: 2 leader-line path points + 100 text chars + 0 raw.
    expect(entityGeometryWork(l) - base).toBe(10 * (2 + 100));
  });
  it('an object-sourced flood is refused by the existing budget, not truncated', () => {
    // 211 contexts x (2 points + 5000 chars) of charge exceeds the cap; the
    // refusal rides the existing GeometryBudgetError on the import path
    // itself — the drawing is refused whole, never imported truncated.
    expect(entityGeometryWork(leaderOf(readDxf(manyContextsE(150, 'X'.repeat(5000)))))).toBeLessThan(MAX_DRAWING_EXPANSION_WORK);
    expect(() => readDxf(manyContextsE(210, 'X'.repeat(5000)))).toThrow(/budget/i);
    expect(() => validateGeometryBudget(readDxf(manyContextsE(210, 'X'.repeat(5000))))).toThrow(/budget/i);
  });
});
