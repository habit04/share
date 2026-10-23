/**
 * P18 PR #43 FIX, ROUND 2 (Codex re-review of e5a3383: ONE NEW P1;
 * lead ruling) — MODELED SECTIONS ARE NEVER REPLAYED FROM THE OLD BODY.
 *
 * The surgical context merge copied leftover MODELED structures as opaque
 * data: on genuine fixtures E/F, setting an additional context's paths to
 * [] resurrected the old path [[0,0],[4,3]] on reopen, and clearing E's
 * additional-context text resurrected 'FIXTURE-E' (8731e4a's wholesale
 * regeneration saved both correctly — the surgical walk regressed them).
 * The ruling: classify every retained section as MODELED (the LEADER
 * clusters, the context text/MTEXT section, any field the model writes) or
 * UNMODELED. Modeled sections are ALWAYS taken from the regenerated
 * stream — never replayed from the old body — so a removal stays removed
 * and a count change is honored. Only truly unmodeled groups are preserved
 * in position, anchored to their neighbor; an unmodeled group whose anchor
 * section was removed and which cannot be placed unambiguously refuses the
 * save atomically ('unsupported multileader context layout'). The final
 * invariant asserts the output's modeled sections equal the regenerated
 * modeled sections exactly.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LeaderEntity } from '../src/core/entities';
import type { MLeaderContext } from '../src/core/multileader';
import { readDxf, writeDxf } from '../src/io/dxf';

const E = readFileSync(join(__dirname, 'fixtures', 'p18-mleader-annotative-mtext.dxf'), 'utf8');
const F = readFileSync(join(__dirname, 'fixtures', 'p18-mleader-annotative-block.dxf'), 'utf8');

type Pairs = Array<[string, string]>;
const toPairs = (text: string): Pairs => {
  const ls = text.split(/\r?\n/);
  const out: Pairs = [];
  for (let i = 0; i + 1 < ls.length; i += 2) out.push([ls[i]!.trim(), ls[i + 1]!]);
  return out;
};
const fromPairs = (pairs: Pairs): string => pairs.map(([c, v]) => `${c}\n${v}`).join('\n');
interface Rec { kind: string; groups: Pairs }
const recordsOf = (text: string): Rec[] => {
  const out: Rec[] = [];
  for (const p of toPairs(text)) {
    if (p[0] === '0') out.push({ kind: p[1].trim(), groups: [] });
    else out[out.length - 1]?.groups.push(p);
  }
  return out;
};
const handleOf = (r: Rec): string => r.groups.find(([c]) => c === '5')?.[1]?.trim().toUpperCase() ?? '';
const entryTarget = (r: Rec, key: string): string | undefined => {
  for (let i = 0; i + 1 < r.groups.length; i += 1) {
    if (r.groups[i]![0] === '3' && r.groups[i]![1].trim().toUpperCase() === key) return r.groups[i + 1]![1].trim().toUpperCase();
  }
  return undefined;
};
const chainOf = (text: string): { objects: string[] } => {
  const recs = recordsOf(text);
  const leader = recs.find((r) => r.kind === 'MULTILEADER')!;
  let ext = '';
  for (let i = 0; i + 1 < leader.groups.length; i += 1) {
    if (leader.groups[i]![0] === '102' && leader.groups[i]![1].includes('ACAD_XDICTIONARY')) ext = leader.groups[i + 1]![1].trim().toUpperCase();
  }
  const byHandle = new Map(recs.filter((r) => handleOf(r)).map((r) => [handleOf(r), r]));
  const manager = entryTarget(byHandle.get(ext)!, 'ACDBCONTEXTDATAMANAGER')!;
  const scales = entryTarget(byHandle.get(manager)!, 'ACDB_ANNOTATIONSCALES')!;
  const objects: string[] = [];
  const scalesRec = byHandle.get(scales)!;
  for (let i = 0; i + 1 < scalesRec.groups.length; i += 1) {
    if (scalesRec.groups[i]![0] === '3') objects.push(scalesRec.groups[i + 1]![1].trim().toUpperCase());
  }
  return { objects };
};
const leaderOf = (state: ReturnType<typeof readDxf>): LeaderEntity =>
  state.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
/** The context object's groups from its annotative subclass marker on. */
const annotRegion = (text: string, handle: string): Pairs => {
  const rec = recordsOf(text).find((r) => r.kind === 'ACDB_MLEADEROBJECTCONTEXTDATA_CLASS' && handleOf(r) === handle)!;
  const at = rec.groups.findIndex(([c, v]) => c === '100' && v.trim() === 'AcDbAnnotScaleObjectContextData');
  return rec.groups.slice(at);
};
/** Replace the leader's ONE additional context with `context`. */
const withAdditionalContext = (state: ReturnType<typeof readDxf>, context: MLeaderContext): ReturnType<typeof readDxf> => ({
  ...state,
  entities: state.entities.map((e) => (e.type === 'leader' && e.mleader
    ? { ...e, mleader: { ...e.mleader, contexts: [context] } }
    : e)),
});

describe('P18 PR #43 fix round 2: modeled sections come from the model, never the old body', () => {
  it("Codex removal regression (E): the additional context's paths set to [] stay removed on reopen", () => {
    const s = readDxf(E);
    const before = leaderOf(s).mleader!.contexts![0]!;
    expect(before.paths).toEqual([[{ x: 0, y: 0 }, { x: 4, y: 3 }]]);
    const out = writeDxf(withAdditionalContext(s, { ...before, paths: [] }));
    const reopened = leaderOf(readDxf(out)).mleader!.contexts![0]!;
    expect(reopened.paths).toEqual([]);
    // And the written additional object carries no LEADER cluster at all.
    const { objects } = chainOf(E);
    const region = annotRegion(out, objects[1]!);
    expect(region.some(([, v]) => v.trim() === 'LEADER{')).toBe(false);
  });

  it("Codex removal regression (F): the additional context's paths set to [] stay removed on reopen", () => {
    const s = readDxf(F);
    const before = leaderOf(s).mleader!.contexts![0]!;
    expect(before.paths).toEqual([[{ x: 0, y: 0 }, { x: 4, y: 3 }]]);
    const out = writeDxf(withAdditionalContext(s, { ...before, paths: [] }));
    const reopened = leaderOf(readDxf(out)).mleader!.contexts![0]!;
    expect(reopened.paths).toEqual([]);
    const { objects } = chainOf(F);
    const region = annotRegion(out, objects[1]!);
    expect(region.some(([, v]) => v.trim() === 'LEADER{')).toBe(false);
  });

  it("Codex removal regression (E): the additional context's cleared text stays cleared on reopen", () => {
    const s = readDxf(E);
    const before = leaderOf(s).mleader!.contexts![0]!;
    expect(before.text).toBe('FIXTURE-E');
    const cleared: MLeaderContext = { ...before, text: undefined, raw: undefined };
    const out = writeDxf(withAdditionalContext(s, cleared));
    const reopened = leaderOf(readDxf(out)).mleader!.contexts![0]!;
    expect(reopened.text).toBeUndefined();
    // The written additional object carries no text section and none of the
    // modeled tail scalars (171/172) that only text content emits.
    const { objects } = chainOf(E);
    const region = annotRegion(out, objects[1]!);
    expect(region.some(([, v]) => v.includes('FIXTURE-E'))).toBe(false);
    expect(region.some(([c]) => c === '171')).toBe(false);
    expect(region.some(([c]) => c === '172')).toBe(false);
    // The primary context is untouched by the additional context's edit.
    expect(leaderOf(readDxf(out)).text).toBe('FIXTURE-E');
  });

  it('an unmodeled group anchored inside a removed modeled section refuses the save atomically', () => {
    // A 999 inside the additional context's TEXT section: while the text
    // survives, it is preserved in position (control); once the model
    // removes the text section, the marker's anchor is gone and it cannot
    // be placed unambiguously — the save refuses, per the ruling.
    const { objects } = chainOf(E);
    const handle = objects[1]!;
    const pairs = toPairs(E);
    const start = pairs.findIndex(([c, v], i) => c === '0' && v.trim() === 'ACDB_MLEADEROBJECTCONTEXTDATA_CLASS'
      && pairs.slice(i, i + 5).some(([c2, v2]) => c2 === '5' && v2.trim().toUpperCase() === handle));
    let at = start + 1;
    while (!(pairs[at]![0] === '100' && pairs[at]![1].trim() === 'AcDbAnnotScaleObjectContextData')) at += 1;
    while (!(pairs[at]![0] === '304' && pairs[at]![1].includes('FIXTURE-E'))) at += 1;
    const injected = fromPairs([...pairs.slice(0, at + 1), ['999', 'INSIDE-TEXT-SECTION'], ...pairs.slice(at + 1)]);
    const s = readDxf(injected);
    const before = leaderOf(s).mleader!.contexts![0]!;
    expect(before.text).toBe('FIXTURE-E');
    // Control: a no-edit save keeps the marker and the text.
    const control = annotRegion(writeDxf(s), handle);
    expect(control.some(([c, v]) => c === '999' && v === 'INSIDE-TEXT-SECTION')).toBe(true);
    // Removing the anchor section refuses atomically.
    const cleared: MLeaderContext = { ...before, text: undefined, raw: undefined };
    expect(() => writeDxf(withAdditionalContext(s, cleared))).toThrow(/unsupported multileader context layout/);
  });
});
