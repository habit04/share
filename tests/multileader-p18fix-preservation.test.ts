/**
 * P18 FIX (PR #40 round), GROUP 2 — CONTEXT-CHAIN PRESERVATION (Codex PR #40
 * P1). The same rule as P22's surgical regeneration: on save, the writer
 * replaces only the fields it models in a retained context chain and keeps
 * everything else — XDATA, unrecognized groups, unrelated extension-
 * dictionary keys — BYTE-VERBATIM; a retained node another object still
 * owns or references is never deleted (a referenced surplus object is kept
 * detached); the final reference set of the regenerated chain is validated
 * and a dangle fails the save atomically.
 *
 * The genuine Fixture E is the primary shape; payloads are injected into
 * its text so the retained graph carries them into the save.
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
/** Fixture E's chain handles, walked from the entity's extension subgroup. */
const chainOf = (text: string): { ext: string; scales: string; objects: string[] } => {
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
  return { ext, scales, objects };
};
const leaderOf = (state: ReturnType<typeof readDxf>): LeaderEntity =>
  state.entities.find((e): e is LeaderEntity => e.type === 'leader')!;
/** Pair index of the OBJECTS section's ENDSEC (E carries a trailing section
 *  after OBJECTS, so the file's last ENDSEC is not the OBJECTS one). */
const objectsEndsec = (pairs: Pairs): number => {
  let inObjects = false;
  for (let i = 0; i + 1 < pairs.length; i += 1) {
    if (pairs[i]![0] === '0' && pairs[i]![1].trim() === 'SECTION' && pairs[i + 1]![1].trim() === 'OBJECTS') inObjects = true;
    else if (inObjects && pairs[i]![0] === '0' && pairs[i]![1].trim() === 'ENDSEC') return i;
  }
  throw new Error('no OBJECTS section');
};

describe('P18 FIX group 2: context-chain preservation', () => {
  it('a CODEX_REVIEW XDATA payload on a context object survives a no-edit save byte-verbatim', () => {
    const { objects } = chainOf(E);
    const pairs = toPairs(E);
    // Append the payload at the end of the ADDITIONAL object's record.
    const recs = recordsOf(E);
    const target = recs.find((r) => handleOf(r) === objects[1])!;
    const start = pairs.findIndex(([c, v], i) => c === '0' && v.trim() === target.kind
      && pairs.slice(i, i + 4).some(([c2, v2]) => c2 === '5' && v2.trim().toUpperCase() === objects[1]));
    let end = start + 1;
    while (end < pairs.length && pairs[end]![0] !== '0') end += 1;
    const injected = fromPairs([
      ...pairs.slice(0, end),
      ['1001', 'CODEX_REVIEW'], ['1000', 'PAYLOAD-KEPT-VERBATIM'],
      ...pairs.slice(end),
    ]);
    const s = readDxf(injected);
    expect(leaderOf(s).mleader?.contexts).toHaveLength(1);
    const out = writeDxf(s);
    const outRecs = recordsOf(out);
    const obj = outRecs.filter((r) => r.kind === 'ACDB_MLEADEROBJECTCONTEXTDATA_CLASS')
      .find((r) => {
        const at = r.groups.findIndex(([c, v]) => c === '100' && v.trim() === 'AcDbAnnotScaleObjectContextData');
        // The writer formats the factor as a decimal ('2.0'); compare numerically.
        return Number(r.groups.slice(at).find(([c]) => c === '40')?.[1]) === 2;
      })!;
    expect(obj).toBeDefined();
    const at = obj.groups.findIndex(([c]) => c === '1001');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(obj.groups[at]).toEqual(['1001', 'CODEX_REVIEW']);
    expect(obj.groups[at + 1]).toEqual(['1000', 'PAYLOAD-KEPT-VERBATIM']);
    // And the round trip is stable: a second save keeps the payload too.
    const out2 = writeDxf(readDxf(out));
    expect(out2).toContain('PAYLOAD-KEPT-VERBATIM');
  });

  it('an unrelated XRECORD key in the extension dictionary saves cleanly', () => {
    const { ext } = chainOf(E);
    const pairs = toPairs(E);
    const start = pairs.findIndex(([c, v], i) => c === '0' && v.trim() === 'DICTIONARY'
      && pairs.slice(i, i + 4).some(([c2, v2]) => c2 === '5' && v2.trim().toUpperCase() === ext));
    let end = start + 1;
    while (end < pairs.length && pairs[end]![0] !== '0') end += 1;
    // The XRECORD goes just before the OBJECTS section's ENDSEC.
    const endsec = objectsEndsec(pairs);
    const injected = fromPairs([
      ...pairs.slice(0, end),
      ['3', 'CODEX_NOTES'], ['350', '7AA'],
      ...pairs.slice(end, endsec),
      ['0', 'XRECORD'], ['5', '7AA'], ['330', ext], ['100', 'AcDbXrecord'], ['300', 'kept-notes'],
      ...pairs.slice(endsec),
    ]);
    const s = readDxf(injected);
    expect(leaderOf(s).mleader?.contexts).toHaveLength(1);
    const out = writeDxf(s);
    const outRecs = recordsOf(out);
    const outExt = outRecs.find((r) => r.kind === 'DICTIONARY'
      && r.groups.some(([c, v]) => c === '3' && v.trim() === 'AcDbContextDataManager'))!;
    expect(outExt).toBeDefined();
    const target = entryTarget(outExt, 'CODEX_NOTES');
    expect(target).toBeDefined();
    const xrec = outRecs.find((r) => r.kind === 'XRECORD' && handleOf(r) === target);
    expect(xrec).toBeDefined();
    expect(xrec!.groups.some(([c, v]) => c === '300' && v === 'kept-notes')).toBe(true);
    // The model round-trips whole through the saved file.
    expect(leaderOf(readDxf(out)).mleader?.contexts).toHaveLength(1);
  });

  it('a surplus context object referenced by another record is kept detached; unreferenced it is dropped', () => {
    const { scales, objects } = chainOf(E);
    const pairs = toPairs(E);
    const recs = recordsOf(E);
    // A third object: a copy of the additional object under a fresh handle,
    // listed in the scales dictionary as *A3.
    const srcObj = recs.find((r) => handleOf(r) === objects[1])!;
    const scalesStart = pairs.findIndex(([c, v], i) => c === '0' && v.trim() === 'DICTIONARY'
      && pairs.slice(i, i + 4).some(([c2, v2]) => c2 === '5' && v2.trim().toUpperCase() === scales));
    let scalesEnd = scalesStart + 1;
    while (scalesEnd < pairs.length && pairs[scalesEnd]![0] !== '0') scalesEnd += 1;
    const endsec = objectsEndsec(pairs);
    const objStart = pairs.findIndex(([c, v], i) => c === '0' && v.trim() === srcObj.kind
      && pairs.slice(i, i + 4).some(([c2, v2]) => c2 === '5' && v2.trim().toUpperCase() === objects[1]));
    let objEnd = objStart + 1;
    while (objEnd < pairs.length && pairs[objEnd]![0] !== '0') objEnd += 1;
    const copyPairs: Pairs = pairs.slice(objStart, objEnd).map(([c, v]) =>
      c === '5' ? ['5', '7AB'] : [c, v]);
    const withThird = fromPairs([
      ...pairs.slice(0, scalesEnd),
      ['3', '*A3'], ['350', '7AB'],
      ...pairs.slice(scalesEnd, endsec),
      ...copyPairs,
      ...pairs.slice(endsec),
    ]);
    // The reader models all three contexts; removing the last from the MODEL
    // makes the third object surplus at write time.
    const dropLast = (text: string): string => {
      const s = readDxf(text);
      const l = leaderOf(s);
      expect(l.mleader?.contexts).toHaveLength(2);
      const edited: LeaderEntity = { ...l, mleader: { ...l.mleader!, contexts: [l.mleader!.contexts![0]!] } };
      return writeDxf({ ...s, entities: s.entities.map((e) => (e.id === l.id ? edited : e)) });
    };
    // Unreferenced surplus: dropped, the written scales dictionary lists the
    // two modelled objects only.
    const outA = dropLast(withThird);
    const objsA = recordsOf(outA).filter((r) => r.kind === 'ACDB_MLEADEROBJECTCONTEXTDATA_CLASS');
    expect(objsA).toHaveLength(2);
    expect(objsA.some((r) => handleOf(r) === '7AB')).toBe(false);
    // Referenced surplus: an XRECORD naming the surplus object by group 340
    // keeps it — detached (the scales dictionary does not list it), payload
    // and handle intact.
    const thirdPairs = toPairs(withThird);
    const thirdEndsec = objectsEndsec(thirdPairs);
    const withReferencer = fromPairs([
      ...thirdPairs.slice(0, thirdEndsec),
      ['0', 'XRECORD'], ['5', '7AC'], ['330', '0'], ['100', 'AcDbXrecord'], ['340', '7AB'], ['300', 'owner-note'],
      ...thirdPairs.slice(thirdEndsec),
    ]);
    const outB = dropLast(withReferencer);
    const objsB = recordsOf(outB).filter((r) => r.kind === 'ACDB_MLEADEROBJECTCONTEXTDATA_CLASS');
    expect(objsB).toHaveLength(3);
    const kept = objsB.find((r) => handleOf(r) === '7AB')!;
    expect(kept).toBeDefined();
    // The scales dictionary (walked properly via chainOf) lists exactly the
    // two modelled objects — the kept surplus is detached from the chain.
    const listed = chainOf(outB).objects;
    expect(listed).not.toContain('7AB');
    expect(listed).toHaveLength(2);
  });
});
