/**
 * P18 PR #43 FIX, ROUND 3 (lead native gate at b6cdd69: RED on exactly
 * R1 + R2; everything else at the gate was GREEN).
 *
 * R1 (BLOCKER): on genuine fixtures E and F, setting an additional
 * context's paths to [] made AutoCAD 2027 DISCARD the whole drawing
 * ('Premature end of object'). The genuine body carries a 271 INSIDE the
 * LEADER cluster, just before the closing 303; when the model removes the
 * cluster, the round-2 section merge treated that 271 as the removed
 * section's collapsible trailing edge and re-anchored it at the END of
 * the context body ('... 297=0 271=0 272=9 273=9') — outside any
 * 302...303 cluster, where the code is not grammatical. The ruling: a
 * removed cluster's interior groups go WITH the cluster (dropped), never
 * re-anchored outside it; no LEADER-interior code (271, 305) is ever
 * written outside a 302...303 cluster. A KEPT cluster retains its
 * interior 271 in place.
 *
 * R2: a no-edit re-save of JCad's OWN cleared-text output refused with
 * 'unsupported multileader context layout' (native fixture P1-E-notext,
 * context 26D — the only refusal in 61 no-edit re-saves). The cleared
 * output's tail carries 170/90 but NOT the 171/172 that only text
 * content emits, and the kept property segment (91/141/92/.../297)
 * follows immediately; the tail walk met the segment's leading 91 while
 * still expecting tail scalars and refused. The ruling: the property
 * segment anchors on its own leading codes (91/291/296) whether or not
 * 171/172 precede it.
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
/** Every context object's annot region in the file. */
const allAnnotRegions = (text: string): Pairs[] => recordsOf(text)
  .filter((r) => r.kind === 'ACDB_MLEADEROBJECTCONTEXTDATA_CLASS')
  .map((r) => {
    const at = r.groups.findIndex(([c, v]) => c === '100' && v.trim() === 'AcDbAnnotScaleObjectContextData');
    return r.groups.slice(at);
  });
/** LEADER-interior codes must occur only between a cluster's 302 and its
 *  matching 303. Returns the offending groups (empty when grammatical). */
const leaderInteriorOutsideCluster = (region: Pairs): Pairs => {
  const bad: Pairs = [];
  let depth = 0;
  for (const [code, value] of region) {
    if (code === '302') { depth += 1; continue; }
    if (code === '303') { depth -= 1; continue; }
    if (depth === 0 && (code === '271' || code === '305')) bad.push([code, value]);
  }
  return bad;
};
/** Replace the leader's ONE additional context with `context`. */
const withAdditionalContext = (state: ReturnType<typeof readDxf>, context: MLeaderContext): ReturnType<typeof readDxf> => ({
  ...state,
  entities: state.entities.map((e) => (e.type === 'leader' && e.mleader
    ? { ...e, mleader: { ...e.mleader, contexts: [context] } }
    : e)),
});

describe('P18 PR #43 fix round 3 (R1): a removed LEADER cluster takes its interior groups with it', () => {
  it("E: paths=[] drops the removed cluster's interior 271 — none is written, inside or outside a cluster", () => {
    const s = readDxf(E);
    const before = leaderOf(s).mleader!.contexts![0]!;
    const out = writeDxf(withAdditionalContext(s, { ...before, paths: [] }));
    const { objects } = chainOf(E);
    const region = annotRegion(out, objects[1]!);
    expect(region.some(([, v]) => v.trim() === 'LEADER{')).toBe(false);
    // The removed cluster's own 271 is absent entirely...
    expect(region.some(([c]) => c === '271')).toBe(false);
    // ...and no context body in the file writes a LEADER-interior code
    // outside a 302...303 cluster.
    for (const r of allAnnotRegions(out)) expect(leaderInteriorOutsideCluster(r)).toEqual([]);
    // The removal itself still holds on reopen.
    expect(leaderOf(readDxf(out)).mleader!.contexts![0]!.paths).toEqual([]);
  });

  it("F: paths=[] drops the removed cluster's interior 271 — none is written, inside or outside a cluster", () => {
    const s = readDxf(F);
    const before = leaderOf(s).mleader!.contexts![0]!;
    const out = writeDxf(withAdditionalContext(s, { ...before, paths: [] }));
    const { objects } = chainOf(F);
    const region = annotRegion(out, objects[1]!);
    expect(region.some(([, v]) => v.trim() === 'LEADER{')).toBe(false);
    expect(region.some(([c]) => c === '271')).toBe(false);
    for (const r of allAnnotRegions(out)) expect(leaderInteriorOutsideCluster(r)).toEqual([]);
    expect(leaderOf(readDxf(out)).mleader!.contexts![0]!.paths).toEqual([]);
  });

  it('a KEPT cluster retains its interior 271 in place, just before its 303 (no over-dropping)', () => {
    const out = writeDxf(readDxf(E));
    const { objects } = chainOf(E);
    for (const handle of objects) {
      const region = annotRegion(out, handle);
      const at271 = region.findIndex(([c]) => c === '271');
      expect(at271).toBeGreaterThan(-1);
      // In place: after the LEADER_LINE close (305), before the cluster
      // close (303), with the cluster open (302) ahead of it.
      expect(region[at271 - 1]![0]).toBe('305');
      expect(region[at271 + 1]![0]).toBe('303');
      expect(region.slice(0, at271).some(([c, v]) => c === '302' && v.trim() === 'LEADER{')).toBe(true);
      expect(leaderInteriorOutsideCluster(region)).toEqual([]);
    }
  });
});

describe('P18 PR #43 fix round 3 (R2): the property segment anchors without 171/172', () => {
  it('save -> reopen -> save of the cleared-text output succeeds and is byte-stable', () => {
    const s = readDxf(E);
    const before = leaderOf(s).mleader!.contexts![0]!;
    const cleared: MLeaderContext = { ...before, text: undefined, raw: undefined };
    const out1 = writeDxf(withAdditionalContext(s, cleared));
    const { objects } = chainOf(E);
    const handle = objects[1]!;
    // Precondition (round 2's finding): the cleared output's tail emits
    // no 171/172, and the property segment still follows the tail.
    const region1 = annotRegion(out1, handle);
    expect(region1.some(([c]) => c === '171')).toBe(false);
    expect(region1.some(([c]) => c === '172')).toBe(false);
    expect(region1.some(([c]) => c === '297')).toBe(true);
    // The no-edit re-save of that very output refused at b6cdd69 with
    // 'unsupported multileader context layout'; it must now succeed and
    // reproduce the context body byte for byte.
    let out2 = '';
    expect(() => { out2 = writeDxf(readDxf(out1)); }).not.toThrow();
    expect(annotRegion(out2, handle)).toEqual(region1);
    expect(out2).toBe(out1);
    // The property segment survived in position: after the tail scalars
    // (170/90, no 171/172) and before the cluster, in its genuine order.
    const codes = region1.map(([c]) => c);
    const at170 = codes.indexOf('170');
    const at302 = codes.indexOf('302');
    const segment = codes.slice(at170, at302);
    expect(segment.slice(0, 2)).toEqual(['170', '90']);
    expect(segment).toContain('91');
    expect(segment.indexOf('91')).toBeLessThan(segment.indexOf('297'));
  });
});
