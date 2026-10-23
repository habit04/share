/**
 * P18 PR #43 FIX (Codex PR #43 P1) — CONTEXT-BODY SURGICAL REGENERATION.
 *
 * Regenerating a retained MLEADER context used to replace its whole body,
 * dropping every group the model does not carry: a 309 marker or a 999
 * comment after the context's first 40 survived the read (bbb811's reader
 * retains them in the graph) but vanished on a no-edit save. The fix applies
 * the P22 table rule to the context body: only the recognized derived fields
 * are replaced, in place; every other group stays byte-verbatim in position
 * (fixture E's genuine body also carries a whole unmodelled segment — the
 * 91/141/92/.../297 property block after group 172, a 271 before the
 * cluster's 303, and 272/273 after it — which the same walk preserves). An
 * unmodelled group INSIDE a run that must regenerate (the point run of a
 * LEADER_LINE) cannot be placed safely, so the save refuses atomically with
 * 'unsupported multileader context layout'.
 *
 * The genuine Fixture E is the shape, as in the group-2 preservation tests;
 * payloads are injected into its text so the retained graph carries them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LeaderEntity } from '../src/core/entities';
import { readDxf, writeDxf } from '../src/io/dxf';

const E = readFileSync(join(__dirname, 'fixtures', 'p18-mleader-annotative-mtext.dxf'), 'utf8');

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
/** Splice `pair` into fixture E right after the first body 40 of the
 *  additional context object (the position Codex's shapes name). Returns the
 *  injected text and the region index the pair lands at. */
const injectAfterFirst40 = (pair: [string, string]): { text: string; handle: string } => {
  const { objects } = chainOf(E);
  const handle = objects[1]!;
  const pairs = toPairs(E);
  const start = pairs.findIndex(([c, v], i) => c === '0' && v.trim() === 'ACDB_MLEADEROBJECTCONTEXTDATA_CLASS'
    && pairs.slice(i, i + 5).some(([c2, v2]) => c2 === '5' && v2.trim().toUpperCase() === handle));
  let at = start + 1;
  // walk to the annot marker, then to the first 40 after it (the body's scale)
  while (!(pairs[at]![0] === '100' && pairs[at]![1].trim() === 'AcDbAnnotScaleObjectContextData')) at += 1;
  while (pairs[at]![0] !== '40') at += 1;
  return { text: fromPairs([...pairs.slice(0, at + 1), pair, ...pairs.slice(at + 1)]), handle };
};

describe('P18 PR #43 fix (1): context bodies regenerate surgically', () => {
  it("Codex's 309 injection after the context's first 40 survives a no-edit save byte-identical, in position", () => {
    const { text, handle } = injectAfterFirst40(['309', 'CODEX-309-MARKER']);
    const s = readDxf(text);
    expect(leaderOf(s).mleader?.contexts).toHaveLength(1);
    const control = annotRegion(writeDxf(readDxf(E)), handle);
    const out = annotRegion(writeDxf(s), handle);
    // The control region's index 2 is the body's first 40 (scale): the
    // marker must sit immediately after it, with everything else unchanged.
    expect(control[2]![0]).toBe('40');
    expect(out).toEqual([...control.slice(0, 3), ['309', 'CODEX-309-MARKER'], ...control.slice(3)]);
  });

  it("Codex's 999 injection after the context's first 40 survives a no-edit save byte-identical, in position", () => {
    const { text, handle } = injectAfterFirst40(['999', 'CODEX-999-NOTE']);
    const s = readDxf(text);
    expect(leaderOf(s).mleader?.contexts).toHaveLength(1);
    const control = annotRegion(writeDxf(readDxf(E)), handle);
    const out = annotRegion(writeDxf(s), handle);
    expect(control[2]![0]).toBe('40');
    expect(out).toEqual([...control.slice(0, 3), ['999', 'CODEX-999-NOTE'], ...control.slice(3)]);
    // And a second save keeps it too (the fixed point includes the marker).
    const out2 = annotRegion(writeDxf(readDxf(writeDxf(s))), handle);
    expect(out2).toEqual(out);
  });

  it('an unmodelled group inside a LEADER_LINE point run refuses the save atomically', () => {
    const { objects } = chainOf(E);
    const handle = objects[1]!;
    const pairs = toPairs(E);
    const start = pairs.findIndex(([c, v], i) => c === '0' && v.trim() === 'ACDB_MLEADEROBJECTCONTEXTDATA_CLASS'
      && pairs.slice(i, i + 5).some(([c2, v2]) => c2 === '5' && v2.trim().toUpperCase() === handle));
    let at = start + 1;
    while (!(pairs[at]![0] === '304' && pairs[at]![1].trim() === 'LEADER_LINE{')) at += 1;
    // pairs[at + 1] is the run's first 10; split the triple: the 999 lands
    // between the point's 10 and its 20 — inside the run.
    expect(pairs[at + 1]![0]).toBe('10');
    const injected = fromPairs([...pairs.slice(0, at + 2), ['999', 'CODEX-SPLIT'], ...pairs.slice(at + 2)]);
    const s = readDxf(injected);
    expect(leaderOf(s).mleader?.contexts).toHaveLength(1);
    expect(() => writeDxf(s)).toThrow(/unsupported multileader context layout/);
  });
});
