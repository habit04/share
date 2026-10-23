/**
 * P18 FIX (PR #40 round), GROUP 1 — NATIVE GATE 340.
 *
 * The lead's native gate at 870d9f1 was RED: AutoCAD 2027 DISCARDS any drawing
 * carrying an annotative multileader whose context objects lack group 340
 * ('Unexpected DXF group code: 40 ... drawing discarded' — the header's group
 * 40 arrives where AutoCAD requires the 340 SCALE reference first). The rules
 * pinned here:
 *  (a) EVERY annotative MLEADER context object carries group 340 -> a SCALE
 *      object: on re-save the RETAINED source SCALE (fixtures E/F: B7 =
 *      '1:1' for the primary, 124 = '1:2' for the additional context); for
 *      authored scales a SCALE object is CREATED in the scale-list
 *      dictionary; when no SCALE can be referenced the whole context chain
 *      is WITHHELD and the withholding is reported through writeDxf's export
 *      report sink.
 *  (b) The READER captures group 340, so the model carries each context's
 *      source scale NAME (MLeaderNative.scaleName / MLeaderContext.scaleName)
 *      and round trips keep it.
 *  (c) Group 40 is written ONCE per context object (the annotative header's),
 *      not twice.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LeaderEntity } from '../src/core/entities';
import type { ImportReportItem } from '../src/io/import-report';
import { readDxf, writeDxf } from '../src/io/dxf';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const E = fixture('p18-mleader-annotative-mtext.dxf');
const F = fixture('p18-mleader-annotative-block.dxf');

const toPairs = (text: string): Array<[string, string]> => {
  const ls = text.split(/\r?\n/);
  const out: Array<[string, string]> = [];
  for (let i = 0; i + 1 < ls.length; i += 2) out.push([ls[i]!.trim(), ls[i + 1]!]);
  return out;
};
const recordsOf = (text: string): Array<{ kind: string; groups: Array<[string, string]> }> => {
  const out: Array<{ kind: string; groups: Array<[string, string]> }> = [];
  for (const p of toPairs(text)) {
    if (p[0] === '0') out.push({ kind: p[1].trim(), groups: [] });
    else out[out.length - 1]?.groups.push(p);
  }
  return out;
};
interface CtxObject { handle: string; header340?: string; header40s: number; scale40?: string }
const contextObjectsOf = (text: string): CtxObject[] =>
  recordsOf(text)
    .filter((r) => r.kind === 'ACDB_MLEADEROBJECTCONTEXTDATA_CLASS')
    .map((r) => {
      const annotAt = r.groups.findIndex(([c, v]) => c === '100' && v.trim() === 'AcDbAnnotScaleObjectContextData');
      const head: CtxObject = { handle: r.groups.find(([c]) => c === '5')![1]!.trim().toUpperCase(), header40s: 0 };
      for (let i = annotAt + 1; i < r.groups.length; i += 1) {
        const [c, v] = r.groups[i]!;
        if (c === '10') break;
        if (c === '340' && head.header340 === undefined) head.header340 = v.trim().toUpperCase();
        if (c === '40') { head.header40s += 1; head.scale40 = v.trim(); }
      }
      return head;
    });
const scaleHandlesOf = (text: string): Map<string, string> => {
  const m = new Map<string, string>();
  for (const r of recordsOf(text)) {
    if (r.kind !== 'SCALE') continue;
    const h = r.groups.find(([c]) => c === '5')![1]!.trim().toUpperCase();
    const name = r.groups.find(([c]) => c === '300')![1]!;
    m.set(h, name);
  }
  return m;
};
const leaderOf = (state: ReturnType<typeof readDxf>): LeaderEntity =>
  state.entities.find((e): e is LeaderEntity => e.type === 'leader')!;

describe('P18 FIX group 1(b): the reader captures group 340 as the scale name', () => {
  it('E: the primary carries scaleName 1:1, the additional context 1:2', () => {
    const n = leaderOf(readDxf(E)).mleader!;
    expect(n.scaleName).toBe('1:1');
    expect(n.contexts![0]!.scaleName).toBe('1:2');
  });
  it('F: the primary carries scaleName 1:1, the additional context 1:2', () => {
    const n = leaderOf(readDxf(F)).mleader!;
    expect(n.scaleName).toBe('1:1');
    expect(n.contexts![0]!.scaleName).toBe('1:2');
  });
});

describe('P18 FIX group 1(a): every context object carries a 340 to a SCALE', () => {
  it('E re-save keeps both retained SCALE references (B7 and 124)', () => {
    const out = writeDxf(readDxf(E));
    const objs = contextObjectsOf(out);
    expect(objs).toHaveLength(2);
    expect(objs.map((o) => o.header340).sort()).toEqual(['124', 'B7']);
    const scales = scaleHandlesOf(out);
    for (const o of objs) expect(scales.get(o.header340!)).toBeDefined();
  });
  it('F re-save keeps both retained SCALE references (B7 and 124)', () => {
    const out = writeDxf(readDxf(F));
    const objs = contextObjectsOf(out);
    expect(objs).toHaveLength(2);
    expect(objs.map((o) => o.header340).sort()).toEqual(['124', 'B7']);
  });
  it.each(['AC1015', 'AC1018', 'AC1032'])('%s: every context object 340 resolves to a SCALE record', (version) => {
    const text = E.replace('AC1032', version);
    const out = writeDxf(readDxf(text));
    expect(out).toContain(version);
    const objs = contextObjectsOf(out);
    expect(objs.length).toBe(2);
    const scales = scaleHandlesOf(out);
    for (const o of objs) {
      expect(o.header340).toBeDefined();
      expect(scales.has(o.header340!)).toBe(true);
    }
  });
  it('round trip: the (40, 340) census is identical after read-write-read-write', () => {
    const census = (t: string) => contextObjectsOf(t).map((o) => `${o.scale40}->${o.header340}`).sort();
    const once = writeDxf(readDxf(E));
    const twice = writeDxf(readDxf(once));
    expect(census(once)).toEqual(['1->B7', '2->124']);
    expect(census(twice)).toEqual(census(once));
  });
  it('an authored context (scaleFactor 4, no source scale) gets a SCALE created in the retained scale list', () => {
    const s = readDxf(E);
    const l = leaderOf(s);
    const authored = { ...l.mleader!.contexts![0]!, scaleFactor: 4 };
    delete (authored as { scaleName?: string }).scaleName;
    const edited: LeaderEntity = { ...l, mleader: { ...l.mleader!, contexts: [l.mleader!.contexts![0]!, authored] } };
    const out = writeDxf({ ...s, entities: s.entities.map((e) => (e.id === l.id ? edited : e)) });
    const objs = contextObjectsOf(out);
    expect(objs).toHaveLength(3);
    const scales = scaleHandlesOf(out);
    const created = objs.find((o) => o.scale40 === '4')!;
    expect(created.header340).toBeDefined();
    expect(scales.get(created.header340!)).toBe('1:4');
    // The created SCALE is filed in the retained ACAD_SCALELIST dictionary,
    // beside the source entries (the census of names keeps every source name).
    const names = [...scales.values()];
    for (const kept of ['1:1', '1:2', '1:5', '100:1']) expect(names).toContain(kept);
    const root = recordsOf(out).find((r) => r.kind === 'DICTIONARY'
      && r.groups.some(([c, v]) => c === '3' && v.trim() === 'ACAD_SCALELIST'))!;
    const dictHandle = root.groups[root.groups.findIndex(([c, v]) => c === '3' && v.trim() === 'ACAD_SCALELIST') + 1]![1]!.trim().toUpperCase();
    const dict = recordsOf(out).find((r) => r.groups.find(([c]) => c === '5')?.[1]?.trim().toUpperCase() === dictHandle)!;
    const targets = dict.groups.filter(([c]) => c === '350').map(([, v]) => v.trim().toUpperCase());
    expect(targets).toContain(created.header340!);
  });
});

describe('P18 FIX group 1(c): group 40 is written once per context object', () => {
  it('E and F re-saves: exactly one 40 in each context object header', () => {
    for (const src of [E, F]) {
      const out = writeDxf(readDxf(src));
      for (const o of contextObjectsOf(out)) expect(o.header40s).toBe(1);
    }
  });
});

describe('P18 FIX group 1(a): the withhold-and-report leg', () => {
  it('a source scale name that resolves nowhere withholds the chain and reports it', () => {
    const s = readDxf(E);
    const l = leaderOf(s);
    const orphaned = { ...l.mleader!.contexts![0]!, scaleName: 'Half Inch Scale' };
    const edited: LeaderEntity = { ...l, mleader: { ...l.mleader!, contexts: [orphaned] } };
    const items: ImportReportItem[] = [];
    const out = writeDxf(
      { ...s, cadGraph: undefined, entities: s.entities.map((e) => (e.id === l.id ? edited : e)) },
      { add: (item) => items.push(item) },
    );
    expect(contextObjectsOf(out)).toHaveLength(0);
    expect(items.some((i) => i.type === 'MULTILEADER' && i.reason.includes('Half Inch Scale'))).toBe(true);
  });
});
