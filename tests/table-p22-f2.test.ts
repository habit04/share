/**
 * P22 F-2 — AC1015 cells are written in AutoCAD's own R2000 form.
 *
 * At the lead's native re-run, JCad's pre-F-2 legacy form (per-cell
 * 91/92/7, unconditional 140/170, no text group on covered cells) loaded in
 * AutoCAD with every cell's text EMPTY until a regen (entget showed 91=0),
 * and the title cell's height/alignment never appeared in any phase.
 * AutoCAD's R2000 form — the genuine control
 * tests/fixtures/interchange/r2000-table-autocad.dxf (the Recipe B table
 * saved at AC1015; see PROVENANCE.md) — is: 171..176 head with group 177
 * carrying the override flags (0x20 height, 0x1 alignment), 178, 145, the
 * text in 3-chunks + a group 1 EVERY cell carries ('' for merge-covered
 * cells, whose spans are 1, not 0), and 140/170 only where the cell departs
 * from its row role's style defaults, after the text.
 *
 * This is the golden test: the control's per-cell group layout, compared
 * canonicalised (reals/int via Number/parseInt, strings verbatim — the
 * compn canon), must equal the layout JCad writes for the same table.
 * The record HEAD is out of scope (AutoCAD's cached 92/310 binary data is
 * not JCad's to reproduce); the AC1032 CELL_VALUE form is unchanged (N-3).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDxf, writeDxf } from '../src/io/dxf';
import { decodeDxfBytes } from '../src/io/encoding';
import { setCellText } from '../src/core/table';
import { cadReferenceKind } from '../src/core/cad-graph';

type Pair = [number, string];

function records(text: string): Pair[][] {
  const lines = text.split(/\r?\n/);
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i]!, 10), lines[i + 1]!]);
  const out: Pair[][] = [];
  let cur: Pair[] | null = null;
  for (const p of pairs) {
    if (p[0] === 0) {
      cur = [p];
      out.push(cur);
    } else cur?.push(p);
  }
  return out;
}

function tableRecord(text: string): Pair[] {
  const rec = records(text).find((r) => r[0]![1] === 'ACAD_TABLE');
  expect(rec, 'an ACAD_TABLE record').toBeDefined();
  return rec!;
}

/** The per-cell chunks of an ACAD_TABLE record (171 .. end of cell), row-major. */
function cellChunksOf(text: string): Pair[][] {
  const rec = tableRecord(text);
  const sub = rec.findIndex(([c, v]) => c === 100 && v === 'AcDbTable');
  const gs = rec.slice(sub + 1);
  const chunks: Pair[][] = [];
  let cur: Pair[] | null = null;
  for (const p of gs) {
    if (p[0] === 171) {
      cur = [];
      chunks.push(cur);
    }
    if (p[0] === 280 || p[0] === 281) cur = null;
    cur?.push(p);
  }
  return chunks;
}

const REAL_CELL_CODES = new Set([140, 145]);
const INT_CELL_CODES = new Set([91, 92, 93, 90, 94, 170, 171, 172, 173, 174, 175, 176, 177, 178]);
const canonCell = (chunk: Pair[]): string[] =>
  chunk.map(([c, v]) => (REAL_CELL_CODES.has(c) ? `${c}=n:${Number(v)}` : INT_CELL_CODES.has(c) ? `${c}=i:${parseInt(v, 10)}` : `${c}=s:${v}`));

const r2000Text = () => decodeDxfBytes(readFileSync(join(import.meta.dirname, 'fixtures', 'interchange', 'r2000-table-autocad.dxf'))).text;
const r2018Text = () => decodeDxfBytes(readFileSync(join(import.meta.dirname, 'fixtures', 'interchange', 'r2018-table-autocad.dxf'))).text;
const group = (chunk: Pair[], code: number) => chunk.find(([c]) => c === code)?.[1];

describe("P22 F-2: AC1015 cells in AutoCAD's R2000 form (golden: the genuine AC1015 control)", () => {
  it("JCad's written per-cell layout equals the control's, cell for cell", () => {
    const written = writeDxf(readDxf(r2000Text()));
    expect(written).toContain('AC1015');
    expect(cellChunksOf(written).map(canonCell)).toEqual(cellChunksOf(r2000Text()).map(canonCell));
    // The grid: 141/142 as numbers (the control carries full precision; JCad
    // writes at its 10-decimal precision — equal within 1e-9).
    const grid = (t: string, code: number) => tableRecord(t).filter(([c]) => c === code).map(([, v]) => Number(v));
    for (const code of [141, 142]) {
      const mine = grid(written, code);
      const oracle = grid(r2000Text(), code);
      expect(mine).toHaveLength(oracle.length);
      mine.forEach((v, i) => expect(Math.abs(v - oracle[i]!)).toBeLessThan(1e-9));
    }
  });

  it('the shape pins: 177 flags, overrides after the text, covered cells carry an empty group 1', () => {
    const chunks = cellChunksOf(writeDxf(readDxf(r2000Text())));
    expect(chunks).toHaveLength(12);
    for (const chunk of chunks) {
      expect(chunk.filter(([c]) => c === 1)).toHaveLength(1);
      expect(chunk.some(([c]) => c === 91 || c === 92 || c === 7 || c === 301)).toBe(false);
    }
    // Merge-covered (0,1) and (0,2): virtual, spans 1, no overrides, empty text.
    for (const idx of [1, 2]) {
      expect(group(chunks[idx]!, 173)).toBe('1');
      expect(group(chunks[idx]!, 175)).toBe('1');
      expect(group(chunks[idx]!, 176)).toBe('1');
      expect(group(chunks[idx]!, 177)).toBe('0');
      expect(group(chunks[idx]!, 1)).toBe('');
    }
    // (2,2) 'BOLT': height override — 177 = 0x20, the 140 AFTER the group 1.
    const bolt = chunks[8]!;
    expect(group(bolt, 1)).toBe('BOLT');
    expect(parseInt(group(bolt, 177)!, 10)).toBe(0x20);
    expect(bolt.map(([c]) => c).indexOf(140)).toBeGreaterThan(bolt.map(([c]) => c).indexOf(1));
    expect(Number(group(bolt, 140))).toBeCloseTo(0.3, 12);
    // (3,0) 'B-200': alignment override — 177 = 0x1, the 170 after the group 1.
    const b200 = chunks[9]!;
    expect(group(b200, 1)).toBe('B-200');
    expect(parseInt(group(b200, 177)!, 10)).toBe(0x1);
    expect(b200.map(([c]) => c).indexOf(170)).toBeGreaterThan(b200.map(([c]) => c).indexOf(1));
    expect(group(b200, 170)).toBe('6');
  });

  it('the AC1032 cell-value form is unchanged by F-2', () => {
    const written = writeDxf(readDxf(r2018Text()));
    expect(written).toContain('AC1032');
    const chunks = cellChunksOf(written);
    expect(chunks.some((chunk) => chunk.some(([c, v]) => c === 301 && v === 'CELL_VALUE'))).toBe(true);
    expect(chunks.some((chunk) => chunk.some(([c]) => c === 177))).toBe(false);
  });

  it('the R2000 round trip is a fixed point', () => {
    const written = writeDxf(readDxf(r2000Text()));
    expect(writeDxf(readDxf(written))).toBe(written);
  });
});

/**
 * P22 F-2 successor — the AC1015 roundtrip chain (the lead's native re-run,
 * second round): the R2000-form entity alone still loads in AutoCAD with every
 * cell EMPTY (text = '', 91 = 0) until a regen. The lead's two probes on the
 * genuine control isolated the mechanism: removing the table's
 * extension-dictionary reference reproduces the empty census exactly, while
 * removing the entity's 92/310 cache changes nothing — at AC1015 AutoCAD
 * fills cell contents at load from the chain
 *   table xdict -> ACAD_XREC_ROUNDTRIP (XRECORD) -> ACDBDATATABLE
 *     -> one CELL_VALUE XRECORD per cell.
 * A chain the SOURCE file carries is retained and replayed verbatim by the
 * cad-graph merge (the control round trip above already contains it); what
 * was missing is GENERATION: a table whose source carries no chain (a
 * JCad-authored table, or one read from a chain-less file) was written with
 * no chain at all. These legs write the control's own model with the
 * retained graph dropped — the JCad-authored equivalent — and require the
 * generated chain to canon-equal the control's, object for object.
 */
interface Chain {
  dict: Pair[];
  record: Pair[];
  data: Pair[];
  cells: Pair[][];
}

const HANDLE_CODES = new Set([5, 330, 340, 341, 342, 343, 344, 350, 360]);
const REAL_CHAIN_CODES = new Set([40]);
const INT_CHAIN_CODES = new Set([70, 90, 91, 92, 93, 94, 280, 281]);

/** The roundtrip chain hanging off an ACAD_TABLE record, or null when absent. */
function chainOf(text: string): Chain | null {
  const recs = records(text);
  const byHandle = new Map<string, Pair[]>();
  for (const rec of recs) {
    const handle = rec.find(([c]) => c === 5)?.[1];
    if (handle) byHandle.set(handle, rec);
  }
  const table = tableRecord(text);
  const tableHandle = table.find(([c]) => c === 5)?.[1];
  const xdictAt = table.findIndex(([c, v]) => c === 102 && v === '{ACAD_XDICTIONARY');
  if (xdictAt < 0) return null;
  const dictHandle = table[xdictAt + 1]?.[1];
  const dict = dictHandle ? byHandle.get(dictHandle) : undefined;
  if (!dict || dict[0]?.[1] !== 'DICTIONARY') return null;
  const entryAt = dict.findIndex(([c, v]) => c === 3 && v === 'ACAD_XREC_ROUNDTRIP');
  if (entryAt < 0) return null;
  const record = byHandle.get(dict[entryAt + 1]?.[1] ?? '');
  if (!record || record[0]?.[1] !== 'XRECORD') return null;
  const cellMarkAt = record.findIndex(([c, v]) => c === 102 && v === 'ACAD_ROUNDTRIP_PRE2007_TABLECELL');
  if (cellMarkAt < 0) return null;
  const data = byHandle.get(record[cellMarkAt + 1]?.[1] ?? '');
  if (!data || data[0]?.[1] !== 'ACDBDATATABLE') return null;
  const cells: Pair[][] = [];
  for (const [, handle] of data.filter(([c]) => c === 360)) {
    const cell = byHandle.get(handle);
    if (!cell || cell[0]?.[1] !== 'XRECORD') return null;
    cells.push(cell);
  }
  void tableHandle;
  return { dict, record, data, cells };
}

/** Canonical form of a chain: handles replaced by their structural role. */
function canonChain(text: string, chain: Chain): string[] {
  const table = tableRecord(text);
  const roles = new Map<string, string>();
  roles.set(table.find(([c]) => c === 5)![1], '@TABLE');
  roles.set(chain.dict.find(([c]) => c === 5)![1], '@DICT');
  roles.set(chain.record.find(([c]) => c === 5)![1], '@RECORD');
  roles.set(chain.data.find(([c]) => c === 5)![1], '@DATA');
  chain.cells.forEach((cell, i) => roles.set(cell.find(([c]) => c === 5)![1], `@CELL${i}`));
  const canonRecord = (rec: Pair[], tag: string): string[] => [
    tag,
    ...rec.slice(1).map(([c, v]) =>
      HANDLE_CODES.has(c) ? `${c}=h:${roles.get(v) ?? `?${v}`}`
        : REAL_CHAIN_CODES.has(c) ? `${c}=n:${Number(v)}`
          : INT_CHAIN_CODES.has(c) ? `${c}=i:${parseInt(v, 10)}`
            : `${c}=s:${v}`),
  ];
  return [
    ...canonRecord(chain.dict, 'DICTIONARY'),
    ...canonRecord(chain.record, 'XRECORD'),
    ...canonRecord(chain.data, 'ACDBDATATABLE'),
    ...chain.cells.flatMap((cell, i) => canonRecord(cell, `CELLVALUE${i}`)),
  ];
}

/** The control's table model with no retained graph: the JCad-authored equivalent. */
const bareState = () => ({ ...readDxf(r2000Text()), cadGraph: undefined });

describe('P22 F-2 successor: the AC1015 roundtrip chain is generated when the source carries none', () => {
  it("JCad's generated chain equals the control's, object for object", () => {
    const written = writeDxf(bareState());
    expect(written).toContain('AC1015');
    const mine = chainOf(written);
    expect(mine, 'a generated roundtrip chain').not.toBeNull();
    const oracle = chainOf(r2000Text());
    expect(oracle, "the control's roundtrip chain").not.toBeNull();
    expect(canonChain(written, mine!)).toEqual(canonChain(r2000Text(), oracle!));
  });

  it("the chain carries every cell's load-time census (text + flags)", () => {
    const written = writeDxf(bareState());
    const chain = chainOf(written);
    expect(chain).not.toBeNull();
    // XRECORD header: rows x cols of the table.
    expect(group(chain!.record, 90)).toBe('4');
    expect(group(chain!.record, 91)).toBe('3');
    // ACDBDATATABLE header: 4 schema columns, one row per grid cell.
    expect(group(chain!.data, 90)).toBe('4');
    expect(group(chain!.data, 91)).toBe('12');
    expect(chain!.cells).toHaveLength(12);
    const chunks = cellChunksOf(written);
    const sums = chain!.data.filter(([c]) => c === 40).map(([, v]) => Number(v));
    const alignFlags = chain!.data.filter(([c]) => c === 93).map(([, v]) => parseInt(v, 10));
    // The two 93 columns interleave in one record: first 12 values are the
    // first column, the next 12 the second (all-zero in the control too).
    const firstIntColumn = alignFlags.slice(0, 12);
    const secondIntColumn = alignFlags.slice(12, 24);
    expect(secondIntColumn).toEqual(new Array(12).fill(0));
    chunks.forEach((chunk, i) => {
      const text = chunk.filter(([c]) => c === 3 || c === 1).map(([, v]) => v).join('');
      const cell = chain!.cells[i]!;
      // CELL_VALUE content: 302 always carries the text; a group 1 only when non-empty.
      expect(group(cell, 302)).toBe(text);
      expect(group(cell, 1)).toBe(text === '' ? undefined : text);
      expect(group(cell, 93)).toBe(text === '' ? '7' : '6');
      expect(group(cell, 90)).toBe(text === '' ? '0' : '4');
      expect(group(cell, 94)).toBe('0');
      expect(group(cell, 300)).toBe('');
      // Datatable double column: the position-weighted sum of the content.
      const expected = [...text].reduce((acc, ch, at) => acc + (at + 1) * ch.charCodeAt(0), 0);
      expect(sums[i]).toBe(expected);
      // Datatable first int column: 1 exactly where the entity's 177 carries
      // the alignment-override bit (the control's B-200 cell).
      expect(firstIntColumn[i]).toBe(parseInt(group(chunk, 177)!, 10) & 1);
    });
  });

  it('a retained chain is replayed, never duplicated by a generated one', () => {
    const written = writeDxf(readDxf(r2000Text()));
    const recs = records(written);
    expect(recs.filter((r) => r[0]?.[1] === 'ACDBDATATABLE')).toHaveLength(1);
    expect(recs.filter((r) => r.some(([c, v]) => c === 102 && v === 'ACAD_ROUNDTRIP_PRE2007_TABLE'))).toHaveLength(1);
    expect(chainOf(written)).not.toBeNull();
  });

  it('the generated chain survives a re-read + re-write intact, exactly once', () => {
    // Byte identity is NOT the assertion: this control's model carries
    // annotation settings (CANNOSCALE + scale list) whose graph-less first
    // write is not byte-stable at base — the variable/scale dictionaries are
    // allocated on a different path once a graph exists (pre-existing,
    // chain-independent; the with-graph round trip above IS a byte fixed
    // point). The chain's own stability is what this leg pins: carried on
    // re-read, canon-identical, never duplicated.
    const written = writeDxf(bareState());
    const rewritten = writeDxf(readDxf(written));
    const before = chainOf(written);
    const after = chainOf(rewritten);
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(canonChain(rewritten, after!)).toEqual(canonChain(written, before!));
    expect(records(rewritten).filter((r) => r[0]?.[1] === 'ACDBDATATABLE')).toHaveLength(1);
  });

/**
 * The control text reshaped into the lead's defect shape: the table KEEPS an
 * extension dictionary (holding another application's entry, here a plain
 * XRECORD under ACAD_APP_MARK) but the dictionary carries NO
 * ACAD_XREC_ROUNDTRIP entry and the file carries no chain objects.
 */
function existingXdictText(): string {
  const recs = records(r2000Text());
  const byHandle = new Map(recs.filter((r) => r.find(([c]) => c === 5)).map((r) => [r.find(([c]) => c === 5)![1], r]));
  const table = tableRecord(r2000Text());
  const xAt = table.findIndex(([c, v]) => c === 102 && v === '{ACAD_XDICTIONARY');
  const dict = byHandle.get(table[xAt + 1]![1])!;
  const entryAt = dict.findIndex(([c, v]) => c === 3 && v === 'ACAD_XREC_ROUNDTRIP');
  const chainRecord = byHandle.get(dict[entryAt + 1]![1])!;
  const cellMarkAt = chainRecord.findIndex(([c, v]) => c === 102 && v === 'ACAD_ROUNDTRIP_PRE2007_TABLECELL');
  const data = byHandle.get(chainRecord[cellMarkAt + 1]![1])!;
  const drop = new Set<string>([
    chainRecord.find(([c]) => c === 5)![1],
    data.find(([c]) => c === 5)![1],
    ...data.filter(([c]) => c === 360).map(([, v]) => v),
  ]);
  const probeHandle = '7FE';
  const out: Pair[] = [];
  for (const rec of recs) {
    if (drop.has(rec.find(([c]) => c === 5)?.[1] ?? '')) continue;
    if (rec === dict) {
      for (let i = 0; i < rec.length; i++) {
        if (i === entryAt) {
          out.push([3, 'ACAD_APP_MARK'], [360, probeHandle]);
          i++;
          continue;
        }
        out.push(rec[i]!);
      }
      continue;
    }
    out.push(...rec);
    if (rec[0]![1] === 'SECTION' && rec[1]?.[1] === 'OBJECTS') {
      out.push([0, 'XRECORD'], [5, probeHandle], [330, dict.find(([c]) => c === 5)![1]], [100, 'AcDbXrecord'], [280, '1'], [1, 'kept']);
    }
  }
  return out.map(([c, v]) => `${c}\n${v}`).join('\n') + '\n';
}

describe('P22 F-2 final fix: an existing extension dictionary gains the chain IN that dictionary', () => {
  it('the ACAD_XREC_ROUNDTRIP entry joins the existing dictionary, reachable from the entity', () => {
    const written = writeDxf(readDxf(existingXdictText()));
    expect(written).toContain('AC1015');
    const table = tableRecord(written);
    const tableHandle = table.find(([c]) => c === 5)![1];
    const recs = records(written);
    const byHandle = new Map(recs.filter((r) => r.find(([c]) => c === 5)).map((r) => [r.find(([c]) => c === 5)![1], r]));
    const xAt = table.findIndex(([c, v]) => c === 102 && v === '{ACAD_XDICTIONARY');
    expect(xAt, "the entity's extension-dictionary block").toBeGreaterThanOrEqual(0);
    const dict = byHandle.get(table[xAt + 1]![1])!;
    const keys = dict.filter(([c]) => c === 3).map(([, v]) => v);
    // The existing dictionary keeps its other key AND gains the roundtrip key.
    expect(keys).toContain('ACAD_APP_MARK');
    expect(keys).toContain('ACAD_XREC_ROUNDTRIP');
    // The other key's object survives.
    const markAt = dict.findIndex(([c, v]) => c === 3 && v === 'ACAD_APP_MARK');
    expect(group(byHandle.get(dict[markAt + 1]![1])!, 1)).toBe('kept');
    // No second, parallel dictionary is created for this table: exactly one
    // DICTIONARY record is owned by the table entity.
    const ownedDicts = recs.filter((r) => r[0]![1] === 'DICTIONARY' && group(r, 330) === tableHandle);
    expect(ownedDicts).toHaveLength(1);
    expect(ownedDicts[0]).toBe(dict);
    // Reachability — the assertion that orphans at the parent head: the chain
    // resolves from the entity through ITS dictionary.
    const chain = chainOf(written);
    expect(chain, 'the chain reachable from the entity').not.toBeNull();
    expect(chain!.dict).toEqual(dict);
    expect(recs.filter((r) => r[0]?.[1] === 'ACDBDATATABLE')).toHaveLength(1);
    // The load census rides the chain: 4 rows x 3 cols, one CELL_VALUE per cell.
    expect(group(chain!.record, 90)).toBe('4');
    expect(group(chain!.record, 91)).toBe('3');
    expect(chain!.cells).toHaveLength(12);
    const chunks = cellChunksOf(written);
    chain!.cells.forEach((cell, i) => {
      const text = chunks[i]!.filter(([c]) => c === 3 || c === 1).map(([, v]) => v).join('');
      expect(group(cell, 302)).toBe(text);
    });
  });

  it('the fixed shape round-trips: still one dictionary, one chain, entry retained', () => {
    const written = writeDxf(readDxf(existingXdictText()));
    const rewritten = writeDxf(readDxf(written));
    const chain = chainOf(rewritten);
    expect(chain).not.toBeNull();
    expect(chainOf(written)).not.toBeNull();
    expect(canonChain(rewritten, chain!)).toEqual(canonChain(written, chainOf(written)!));
    const recs = records(rewritten);
    const table = tableRecord(rewritten);
    const tableHandle = table.find(([c]) => c === 5)![1];
    expect(recs.filter((r) => r[0]![1] === 'DICTIONARY' && group(r, 330) === tableHandle)).toHaveLength(1);
    expect(recs.filter((r) => r[0]![1] === 'ACDBDATATABLE')).toHaveLength(1);
  });
});

describe('P22 F-2 successor (continued)', () => {
  it('no chain is generated at AC1032 (the cell-value form is the load path there)', () => {
    // The graph-carrying state: its sourceVersion is what makes the write
    // AC1032. The R2018 model carries no chain, so any ACDBDATATABLE in the
    // output would be a (wrong) generation.
    const written = writeDxf(readDxf(r2018Text()));
    expect(written).toContain('AC1032');
    expect(records(written).some((r) => r[0]?.[1] === 'ACDBDATATABLE')).toBe(false);
    expect(tableRecord(written).some(([c, v]) => c === 102 && v === '{ACAD_XDICTIONARY')).toBe(false);
  });
});
});

/**
 * P22 PR #39 fix (Codex P1, lead ruling): the roundtrip chain is DERIVED
 * data. A chain the source file carries must not be replayed verbatim after
 * the model moved — on every AC1015 write its contents (the CELL_VALUE
 * xrecords and the ACDBDATATABLE rows/cols/cells) are regenerated from the
 * CURRENT model, reusing the existing dictionary/XRECORD/datatable/cell
 * handles where present, keeping unrelated keys in the dictionary, and
 * leaving an unchanged table's output byte-stable. Codex's three shapes:
 * edit a cell's text, add a row, and a JCad-authored table saved twice.
 */
describe('P22 PR #39 fix: a retained roundtrip chain is regenerated from the current model', () => {
  const handleOf = (rec: Pair[]) => rec.find(([c]) => c === 5)?.[1];

  it('edit a cell text: the regenerated chain carries the NEW text, handles reused', () => {
    const state = readDxf(r2000Text());
    const edited = {
      ...state,
      entities: state.entities.map((e) => (e.type === 'table' ? setCellText(e, 2, 2, 'BOLT-M8') : e)),
    };
    const written = writeDxf(edited);
    const chain = chainOf(written);
    expect(chain, 'a roundtrip chain').not.toBeNull();
    // The load census (chain), not just the entity, carries the edit.
    expect(group(chain!.cells[8]!, 302)).toBe('BOLT-M8');
    expect(group(chain!.cells[8]!, 1)).toBe('BOLT-M8');
    expect(group(chain!.cells[8]!, 93)).toBe('6');
    // The datatable content sum for the edited cell is regenerated too.
    const sums = chain!.data.filter(([c]) => c === 40).map(([, v]) => Number(v));
    expect(sums[8]).toBe([...'BOLT-M8'].reduce((acc, ch, at) => acc + (at + 1) * ch.charCodeAt(0), 0));
    // Untouched cells keep their retained contents.
    expect(group(chain!.cells[9]!, 302)).toBe('B-200');
    expect(group(chain!.cells[3]!, 302)).toBe('PART');
    // Handle stability: dictionary, XRECORD, datatable and every CELL_VALUE
    // keep the handles the source file gave them.
    const oracle = chainOf(r2000Text())!;
    expect(handleOf(chain!.dict)).toBe(handleOf(oracle.dict));
    expect(handleOf(chain!.record)).toBe(handleOf(oracle.record));
    expect(handleOf(chain!.data)).toBe(handleOf(oracle.data));
    chain!.cells.forEach((cell, i) => expect(handleOf(cell)).toBe(handleOf(oracle.cells[i]!)));
  });

  it('add a row: the datatable rows/cells and the XRECORD counts follow the model', () => {
    const state = readDxf(r2000Text());
    const grown = {
      ...state,
      entities: state.entities.map((e) => (e.type === 'table'
        ? {
          ...e,
          rowHeights: [...e.rowHeights, e.rowHeights[2]!],
          cells: [...e.cells, [{ text: 'C-300' }, { text: 'WASHER' }, { text: '12' }]],
        }
        : e)),
    };
    const written = writeDxf(grown);
    const chain = chainOf(written);
    expect(chain, 'a roundtrip chain').not.toBeNull();
    expect(group(chain!.record, 90)).toBe('5');
    expect(group(chain!.record, 91)).toBe('3');
    expect(group(chain!.data, 91)).toBe('15');
    expect(chain!.cells).toHaveLength(15);
    expect(group(chain!.cells[12]!, 302)).toBe('C-300');
    expect(group(chain!.cells[13]!, 302)).toBe('WASHER');
    expect(group(chain!.cells[14]!, 302)).toBe('12');
    // The pre-existing cells keep their handles and contents.
    const oracle = chainOf(r2000Text())!;
    for (let i = 0; i < 12; i++) {
      expect(handleOf(chain!.cells[i]!)).toBe(handleOf(oracle.cells[i]!));
      expect(group(chain!.cells[i]!, 302)).toBe(group(oracle.cells[i]!, 302));
    }
  });

  it('a JCad-authored table saved twice: regenerated on the second save, once, byte-stable when unchanged', () => {
    const first = writeDxf(bareState());
    const firstChain = chainOf(first)!;
    expect(firstChain).not.toBeNull();
    // Edit a cell on the re-read state, then save again: the chain in the
    // second save is JCad's own retained chain — it must still regenerate.
    const reread = readDxf(first);
    const edited = {
      ...reread,
      entities: reread.entities.map((e) => (e.type === 'table' ? setCellText(e, 1, 0, 'PART-REVISED') : e)),
    };
    const second = writeDxf(edited);
    const recs = records(second);
    expect(recs.filter((r) => r[0]?.[1] === 'ACDBDATATABLE')).toHaveLength(1);
    const secondChain = chainOf(second)!;
    expect(secondChain).not.toBeNull();
    expect(group(secondChain.cells[3]!, 302)).toBe('PART-REVISED');
    // Handles are reused across the saves, not re-minted.
    expect(handleOf(secondChain.dict)).toBe(handleOf(firstChain.dict));
    expect(handleOf(secondChain.data)).toBe(handleOf(firstChain.data));
    secondChain.cells.forEach((cell, i) => expect(handleOf(cell)).toBe(handleOf(firstChain.cells[i]!)));
    // An unchanged third save is a byte fixed point.
    expect(writeDxf(readDxf(second))).toBe(second);
  });
});

/**
 * P22 PR #39 re-review (Codex P1 pair, lead ruling): regeneration touches
 * ONLY the recognized derived fields.
 * (1) A CELL_VALUE rewrite replaces only the recognized value groups and an
 *     ACDBDATATABLE rewrite only the counts/column entries — everything
 *     else (XDATA 1001..., unrecognized groups) survives byte-verbatim in
 *     position.
 * (2) Shrinking never dangles a pointer: a surplus cell record still
 *     referenced by a surviving object is kept as-is, detached from the
 *     chain; only proven-unreferenced records are deleted.
 * (3) After regeneration the final reference set is validated — every
 *     330/340/350/360 target defined — and a dangle that keeping cannot
 *     repair fails the save atomically.
 */
describe('P22 PR #39 re-review: regeneration is surgical, shrinking never dangles, output is validated', () => {
  const handleOf = (rec: Pair[]) => rec.find(([c]) => c === 5)?.[1];
  const flatPairs = (text: string): Pair[] => {
    const lines = text.split(/\r?\n/);
    const pairs: Pair[] = [];
    for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i]!, 10), lines[i + 1]!]);
    return pairs;
  };
  const emitText = (pairs: Pair[]): string => pairs.map(([c, v]) => `${c}\n${v}`).join('\n') + '\n';
  const recordSpan = (pairs: Pair[], type: string, handle: string): { start: number; end: number } => {
    const starts: number[] = [];
    pairs.forEach((p, i) => { if (p[0] === 0) starts.push(i); });
    for (let s = 0; s < starts.length; s++) {
      const start = starts[s]!, end = starts[s + 1] ?? pairs.length;
      const slice = pairs.slice(start, end);
      if (slice[0]?.[1] === type && slice.find(([c]) => c === 5)?.[1] === handle) return { start, end };
    }
    throw new Error(`record ${type} ${handle} not found`);
  };
  /** Append groups at the end of the record (type, handle). */
  const plantInto = (text: string, type: string, handle: string, extra: Pair[]): string => {
    const pairs = flatPairs(text);
    const { end } = recordSpan(pairs, type, handle);
    pairs.splice(end, 0, ...extra);
    return emitText(pairs);
  };
  /** Insert a whole new record right after the record (type, handle). */
  const plantAfter = (text: string, type: string, handle: string, record: Pair[]): string => {
    const pairs = flatPairs(text);
    const { end } = recordSpan(pairs, type, handle);
    pairs.splice(end, 0, ...record);
    return emitText(pairs);
  };
  /** Set the value of the (unique) group `code` inside the record (type, handle). */
  const corruptGroup = (text: string, type: string, handle: string, code: number, value: string): string => {
    const pairs = flatPairs(text);
    const { start, end } = recordSpan(pairs, type, handle);
    for (let i = start; i < end; i++) if (pairs[i]![0] === code) { pairs[i] = [code, value]; return emitText(pairs); }
    throw new Error(`group ${code} not found in ${type} ${handle}`);
  };
  const shrinkLastRow = (state: ReturnType<typeof readDxf>) => ({
    ...state,
    entities: state.entities.map((e) => (e.type === 'table'
      ? { ...e, rowHeights: e.rowHeights.slice(0, 3), cells: e.cells.slice(0, 3) }
      : e)),
  });
  /** The final reference set of a written file: dangling 330/340/350/360 targets (null handle '0' excepted). */
  const danglingOf = (text: string): string[] => {
    const recs = records(text);
    const canon = (s: string) => s.trim().toUpperCase().replace(/^0+(?=.)/, '');
    const defined = new Set<string>();
    for (const r of recs) for (const [c, v] of r) if (c === 5 || c === 105) defined.add(canon(v));
    const bad = new Set<string>();
    for (const r of recs) for (const [c, v] of r) {
      if (c !== 330 && c !== 340 && c !== 350 && c !== 360) continue;
      if (!/^[0-9A-Fa-f]+$/.test(v.trim())) continue;
      const h = canon(v);
      if (h !== '0' && !defined.has(h)) bad.add(h);
    }
    return [...bad];
  };

  it('no-edit roundtrip: XDATA on a CELL_VALUE and an unrecognized datatable group survive byte-verbatim; derived groups are regenerated, not replayed', () => {
    const oracle = chainOf(r2000Text())!;
    const cell0 = handleOf(oracle.cells[0]!)!;
    const dataHandle = handleOf(oracle.data)!;
    let planted = plantInto(r2000Text(), 'XRECORD', cell0, [[1001, 'CODEX_REVIEW'], [1000, 'KEEP-ME']]);
    planted = plantInto(planted, 'ACDBDATATABLE', dataHandle, [[1001, 'CODEX_REVIEW'], [1000, 'DATA-KEEP']]);
    // Corrupt two derived values in the retained records: if the save
    // replayed them, the corruption would reach the output; regeneration
    // derives both from the model instead.
    planted = corruptGroup(planted, 'XRECORD', cell0, 302, 'STALE-VALUE');
    planted = corruptGroup(planted, 'ACDBDATATABLE', dataHandle, 91, '99');
    const written = writeDxf(readDxf(planted));
    const chain = chainOf(written)!;
    expect(chain).not.toBeNull();
    // Regenerated groups are compared canonically (AutoCAD pads integer
    // values in the source file; JCad's emission does not — the file's
    // standing canon); preserved groups are compared as exact pairs.
    const canonPairs = (rec: Pair[]): string[] => rec.map(([c, v]) =>
      HANDLE_CODES.has(c) ? `${c}=h:${v}` : REAL_CHAIN_CODES.has(c) ? `${c}=n:${Number(v)}` : INT_CHAIN_CODES.has(c) ? `${c}=i:${parseInt(v, 10)}` : `${c}=s:${v}`);
    // The CELL_VALUE: regenerated value groups (the model's text, not the
    // stale retained one) with the XDATA byte-identical in its position.
    expect(canonPairs(chain.cells[0]!)).toEqual(canonPairs([...oracle.cells[0]!, [1001, 'CODEX_REVIEW'], [1000, 'KEEP-ME']]));
    expect(chain.cells[0]!.slice(-2)).toEqual([[1001, 'CODEX_REVIEW'], [1000, 'KEEP-ME']]);
    // The datatable: regenerated counts/entries with the planted
    // unrecognized groups byte-identical at the end of the record.
    expect(canonPairs(chain.data)).toEqual(canonPairs([...oracle.data, [1001, 'CODEX_REVIEW'], [1000, 'DATA-KEEP']]));
    expect(chain.data.slice(-2)).toEqual([[1001, 'CODEX_REVIEW'], [1000, 'DATA-KEEP']]);
    expect(group(chain.data, 91)).toBe('12');
    // Every other cell regenerates to its oracle record.
    for (let i = 1; i < 12; i++) expect(canonPairs(chain.cells[i]!)).toEqual(canonPairs(oracle.cells[i]!));
    // And the planted shape is itself a fixed point.
    expect(writeDxf(readDxf(written))).toBe(written);
  });

  it('340 -> surplus CELL_VALUE + delete a row: the referenced record is kept detached, the save succeeds, the reference set is closed', () => {
    const oracle = chainOf(r2000Text())!;
    const dataHandle = handleOf(oracle.data)!;
    const lastCell = handleOf(oracle.cells[11]!)!;
    const planted = plantAfter(r2000Text(), 'ACDBDATATABLE', dataHandle,
      [[0, 'XRECORD'], [5, '7F00'], [330, 'C'], [100, 'AcDbXrecord'], [280, '1'], [340, lastCell]]);
    const written = writeDxf(shrinkLastRow(readDxf(planted)));
    const chain = chainOf(written)!;
    expect(chain).not.toBeNull();
    expect(chain.cells).toHaveLength(9);
    const recs = records(written);
    const byHandle = new Map(recs.map((r) => [handleOf(r), r]));
    // The referenced surplus record survives byte-verbatim (kept as-is)...
    expect(byHandle.get(lastCell)).toEqual(oracle.cells[11]);
    // ...detached: the regenerated datatable no longer lists it.
    expect(chain.data.filter(([c]) => c === 360).map(([, v]) => v)).not.toContain(lastCell);
    // The unreferenced surplus records are gone.
    expect(byHandle.has(handleOf(oracle.cells[9]!)!)).toBe(false);
    expect(byHandle.has(handleOf(oracle.cells[10]!)!)).toBe(false);
    // The referencing object survives with its pointer intact, and the
    // final reference set is closed.
    expect(byHandle.get('7F00')).toBeDefined();
    expect(group(byHandle.get('7F00')!, 340)).toBe(lastCell);
    expect(danglingOf(written)).toEqual([]);
  });

  it('a surplus-to-surplus reference does not resurrect either record', () => {
    const oracle = chainOf(r2000Text())!;
    const cell10 = handleOf(oracle.cells[10]!)!;
    const cell11 = handleOf(oracle.cells[11]!)!;
    const planted = plantInto(r2000Text(), 'XRECORD', cell11, [[340, cell10]]);
    const written = writeDxf(shrinkLastRow(readDxf(planted)));
    const recs = records(written);
    const handles = new Set(recs.map((r) => handleOf(r)));
    expect(handles.has(cell10)).toBe(false);
    expect(handles.has(cell11)).toBe(false);
    expect(danglingOf(written)).toEqual([]);
  });

  it('a chain handle with no record cannot be kept: the save fails atomically, naming the handle, with no output', () => {
    // Constructed shape: the datatable's retained handle column names a
    // handle (2DF) for which NO CELL_VALUE record exists anywhere in the
    // drawing, and a surviving object holds a 340 to the same handle.
    // Keeping cannot repair this — there is no record to keep — so the
    // save must fail atomically rather than emit a file whose reference
    // set dangles. (In the current architecture this corrupt-chain shape
    // is refused by the cad-graph layer's hard-reference check before
    // regeneration; the post-regeneration final-set validation is the
    // in-merge net for the same class. Either way the outcome pinned
    // here is: a throw naming the handle, and no output produced.)
    const oracle = chainOf(r2000Text())!;
    const dataHandle = handleOf(oracle.data)!;
    // Corrupt the LAST 360 of the datatable (the handle column's final
    // entry) to name a handle with no record.
    const pairs = flatPairs(r2000Text());
    const starts: number[] = [];
    pairs.forEach((p, i) => { if (p[0] === 0) starts.push(i); });
    let span: { start: number; end: number } | undefined;
    for (let s = 0; s < starts.length; s++) {
      const start = starts[s]!, end = starts[s + 1] ?? pairs.length;
      const slice = pairs.slice(start, end);
      if (slice[0]?.[1] === 'ACDBDATATABLE' && slice.find(([c]) => c === 5)?.[1] === dataHandle) span = { start, end };
    }
    expect(span).toBeDefined();
    let last360 = -1;
    for (let i = span!.start; i < span!.end; i++) if (pairs[i]![0] === 360) last360 = i;
    expect(pairs[last360]?.[1]).toBe(handleOf(oracle.cells[11]!)!);
    pairs[last360] = [360, '2DF'];
    let planted = emitText(pairs);
    planted = plantAfter(planted, 'ACDBDATATABLE', dataHandle,
      [[0, 'XRECORD'], [5, '7F00'], [330, 'C'], [100, 'AcDbXrecord'], [280, '1'], [340, '2DF']]);
    const shrunk = shrinkLastRow(readDxf(planted));
    expect(() => writeDxf(shrunk)).toThrowError(/Cannot save/);
    expect(() => writeDxf(shrunk)).toThrowError(/2DF/);
  });
});

/**
 * P22 PR #39 re-review 2 (Codex residual P1 variants, lead ruling):
 * (1) ONE source of truth for reference kinds: the regeneration keep-scan
 *     (liveness) and the post-regeneration validation derive their code
 *     list from the reader's cadReferenceKind() — every code it models,
 *     plus the owner codes 330/360 — never a hand-maintained subset
 *     (Codex hit 345, 349, 390 and 480, which the subsets missed).
 * (2) An unrecognized datatable/CELL_VALUE layout is parsed TOLERANTLY:
 *     999 comments and unknown groups are skipped in place (kept
 *     byte-verbatim in their relative order) while the derived values
 *     around them regenerate. The wholesale-rebuild fallback is gone;
 *     only derived values that cannot be located at all refuse the save,
 *     atomically, with an 'unsupported table data layout' error.
 */
describe('P22 PR #39 re-review 2: reference kinds from cadReferenceKind; unrecognized layouts tolerated, never rebuilt wholesale', () => {
  const handleOf = (rec: Pair[]) => rec.find(([c]) => c === 5)?.[1];
  const flatPairs = (text: string): Pair[] => {
    const lines = text.split(/\r?\n/);
    const pairs: Pair[] = [];
    for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i]!, 10), lines[i + 1]!]);
    return pairs;
  };
  const emitText = (pairs: Pair[]): string => pairs.map(([c, v]) => `${c}\n${v}`).join('\n') + '\n';
  const recordSpan = (pairs: Pair[], type: string, handle: string): { start: number; end: number } => {
    const starts: number[] = [];
    pairs.forEach((p, i) => { if (p[0] === 0) starts.push(i); });
    for (let s = 0; s < starts.length; s++) {
      const start = starts[s]!, end = starts[s + 1] ?? pairs.length;
      const slice = pairs.slice(start, end);
      if (slice[0]?.[1] === type && slice.find(([c]) => c === 5)?.[1] === handle) return { start, end };
    }
    throw new Error(`record ${type} ${handle} not found`);
  };
  /** Append groups at the end of the record (type, handle). */
  const plantInto = (text: string, type: string, handle: string, extra: Pair[]): string => {
    const pairs = flatPairs(text);
    const { end } = recordSpan(pairs, type, handle);
    pairs.splice(end, 0, ...extra);
    return emitText(pairs);
  };
  /** Insert a whole new record right after the record (type, handle). */
  const plantAfter = (text: string, type: string, handle: string, record: Pair[]): string => {
    const pairs = flatPairs(text);
    const { end } = recordSpan(pairs, type, handle);
    pairs.splice(end, 0, ...record);
    return emitText(pairs);
  };
  /** Insert groups right after the first group in the record matching `after`. */
  const insertInto = (text: string, type: string, handle: string, after: (p: Pair) => boolean, extra: Pair[]): string => {
    const pairs = flatPairs(text);
    const { start, end } = recordSpan(pairs, type, handle);
    for (let i = start; i < end; i++) if (after(pairs[i]!)) { pairs.splice(i + 1, 0, ...extra); return emitText(pairs); }
    throw new Error(`anchor group not found in ${type} ${handle}`);
  };
  /** Remove the first group in the record matching `match`. */
  const removeFrom = (text: string, type: string, handle: string, match: (p: Pair) => boolean): string => {
    const pairs = flatPairs(text);
    const { start, end } = recordSpan(pairs, type, handle);
    for (let i = start; i < end; i++) if (match(pairs[i]!)) { pairs.splice(i, 1); return emitText(pairs); }
    throw new Error(`group to remove not found in ${type} ${handle}`);
  };
  /** Rewrite every group in the record through `fn`. */
  const rewriteIn = (text: string, type: string, handle: string, fn: (p: Pair) => Pair): string => {
    const pairs = flatPairs(text);
    const { start, end } = recordSpan(pairs, type, handle);
    for (let i = start; i < end; i++) pairs[i] = fn(pairs[i]!);
    return emitText(pairs);
  };
  /** Set the value of the first group `code` inside the record (type, handle). */
  const corruptGroup = (text: string, type: string, handle: string, code: number, value: string): string => {
    const pairs = flatPairs(text);
    const { start, end } = recordSpan(pairs, type, handle);
    for (let i = start; i < end; i++) if (pairs[i]![0] === code) { pairs[i] = [code, value]; return emitText(pairs); }
    throw new Error(`group ${code} not found in ${type} ${handle}`);
  };
  const shrinkLastRow = (state: ReturnType<typeof readDxf>) => ({
    ...state,
    entities: state.entities.map((e) => (e.type === 'table'
      ? { ...e, rowHeights: e.rowHeights.slice(0, 3), cells: e.cells.slice(0, 3) }
      : e)),
  });
  const canonPairs = (rec: Pair[]): string[] => rec.map(([c, v]) =>
    HANDLE_CODES.has(c) ? `${c}=h:${v}` : REAL_CHAIN_CODES.has(c) ? `${c}=n:${Number(v)}` : INT_CHAIN_CODES.has(c) ? `${c}=i:${parseInt(v, 10)}` : `${c}=s:${v}`);
  /** Dangling targets over EVERY code the reader models as a reference (test-side scan). */
  const danglingFullOf = (text: string): string[] => {
    const recs = records(text);
    const canon = (s: string) => s.trim().toUpperCase().replace(/^0+(?=.)/, '');
    const defined = new Set<string>();
    for (const r of recs) for (const [c, v] of r) if (c === 5 || c === 105) defined.add(canon(v));
    const bad = new Set<string>();
    for (const r of recs) for (const [c, v] of r) {
      if (!cadReferenceKind(c)) continue;
      if (!/^[0-9A-Fa-f]+$/.test(v.trim())) continue;
      const h = canon(v);
      if (h !== '0' && !defined.has(h)) bad.add(`${c}:${h}`);
    }
    return [...bad];
  };
  /** Every code cadReferenceKind() models, enumerated from the function itself. */
  const REFERENCE_CODES: number[] = (() => {
    const out: number[] = [];
    for (let code = 0; code <= 1100; code++) if (cadReferenceKind(code)) out.push(code);
    return out;
  })();
  const carrierWith = (group: Pair): Pair[] =>
    [[0, 'XRECORD'], [5, '7F00'], [330, 'C'], [100, 'AcDbXrecord'], [280, '1'], group];

  it('the reference-code universe is the reader’s: 63 modelled codes, incl. 345/349/390/480', () => {
    expect(REFERENCE_CODES).toHaveLength(63);
    for (const code of [320, 330, 340, 341, 342, 343, 344, 345, 349, 350, 360, 390, 480, 481, 1005]) {
      expect(REFERENCE_CODES, `code ${code} is modelled`).toContain(code);
    }
  });

  it('liveness, EVERY modelled code: a surplus CELL_VALUE referenced via that code is kept detached', () => {
    const oracle = chainOf(r2000Text())!;
    const dataHandle = handleOf(oracle.data)!;
    const lastCell = handleOf(oracle.cells[11]!)!;
    for (const code of REFERENCE_CODES) {
      const planted = plantAfter(r2000Text(), 'ACDBDATATABLE', dataHandle, carrierWith([code, lastCell]));
      const written = writeDxf(shrinkLastRow(readDxf(planted)));
      const recs = records(written);
      const byHandle = new Map(recs.map((r) => [handleOf(r), r]));
      // Kept, as-is (the retained record, byte-equal to the source's)...
      expect(byHandle.get(lastCell), `code ${code}: referenced surplus record kept`).toEqual(oracle.cells[11]);
      // ...detached: the regenerated datatable no longer lists it.
      const chain = chainOf(written)!;
      expect(chain.data.filter(([c]) => c === 360).map(([, v]) => v), `code ${code}: detached from the chain`).not.toContain(lastCell);
      // The referencing object survives with its pointer intact.
      expect(byHandle.get('7F00')!.some(([c, v]) => c === code && v === lastCell), `code ${code}: pointer intact`).toBe(true);
      // And the final reference set — scanned over every modelled code — is closed.
      expect(danglingFullOf(written), `code ${code}: output reference set closed`).toEqual([]);
    }
  }, 300_000);

  it("Codex's codes by name: 345, 349, 390 and 480 each keep the referenced surplus CELL_VALUE", () => {
    const oracle = chainOf(r2000Text())!;
    const dataHandle = handleOf(oracle.data)!;
    const lastCell = handleOf(oracle.cells[11]!)!;
    for (const code of [345, 349, 390, 480]) {
      const planted = plantAfter(r2000Text(), 'ACDBDATATABLE', dataHandle, carrierWith([code, lastCell]));
      const written = writeDxf(shrinkLastRow(readDxf(planted)));
      const byHandle = new Map(records(written).map((r) => [handleOf(r), r]));
      expect(byHandle.get(lastCell), `code ${code}: kept`).toEqual(oracle.cells[11]);
      expect(byHandle.get('7F00')!.some(([c, v]) => c === code && v === lastCell), `code ${code}: pointer intact`).toBe(true);
      expect(danglingFullOf(written), `code ${code}: output closed`).toEqual([]);
    }
  });

  it('validation, EVERY modelled code: a dangling target via that code never reaches the file', () => {
    const oracle = chainOf(r2000Text())!;
    const dataHandle = handleOf(oracle.data)!;
    for (const code of REFERENCE_CODES) {
      const planted = plantAfter(r2000Text(), 'ACDBDATATABLE', dataHandle, carrierWith([code, '2DF']));
      let written: string | undefined;
      let error: Error | undefined;
      try { written = writeDxf(readDxf(planted)); } catch (err) { error = err as Error; }
      if (error) {
        // The save refuses, naming the dangling handle (the graph layer's
        // hard-reference refusal, or the post-regeneration validation).
        expect(error.message, `code ${code}: refusal names the handle`).toContain('2DF');
      } else {
        // The graph layer neutralized the unresolved reference (soft kinds
        // are rewritten to the null handle): no live dangle survives.
        expect(written, `code ${code}: written`).toBeDefined();
        expect(records(written!).some((r) => r.some(([c, v]) => c === code && v === '2DF')), `code ${code}: no live dangle`).toBe(false);
        expect(danglingFullOf(written!), `code ${code}: output reference set closed`).toEqual([]);
      }
    }
  }, 300_000);

  it('validation catches what only the post-regeneration set can: an arbitrary-kind (320) dangle fails the save, naming the handle', () => {
    const oracle = chainOf(r2000Text())!;
    const dataHandle = handleOf(oracle.data)!;
    // A 320 group is an 'arbitrary' reference: the merge carries it
    // verbatim, so only the final reference-set validation can catch its
    // dangling target.
    const planted = plantAfter(r2000Text(), 'ACDBDATATABLE', dataHandle, carrierWith([320, '2DF']));
    expect(() => writeDxf(readDxf(planted))).toThrowError(/dangling handle reference/);
    expect(() => writeDxf(readDxf(planted))).toThrowError(/2DF/);
  });

  it('datatable tolerance: 999 comments between 70 and 90, between 90 and 91, and before the first segment survive in place; derived values regenerate; XDATA on a cell survives', () => {
    const oracle = chainOf(r2000Text())!;
    const dataHandle = handleOf(oracle.data)!;
    const cell0 = handleOf(oracle.cells[0]!)!;
    let planted = insertInto(r2000Text(), 'ACDBDATATABLE', dataHandle, ([c]) => c === 70, [[999, 'TOLERANT-1']]);
    planted = insertInto(planted, 'ACDBDATATABLE', dataHandle, ([c]) => c === 90, [[999, 'TOLERANT-2']]);
    planted = insertInto(planted, 'ACDBDATATABLE', dataHandle, ([c]) => c === 1, [[999, 'TOLERANT-3']]);
    planted = plantInto(planted, 'XRECORD', cell0, [[1001, 'CODEX_REVIEW'], [1000, 'KEEP-ME']]);
    // Corrupt derived values in both records: regeneration must derive
    // them from the model, not replay them.
    planted = corruptGroup(planted, 'ACDBDATATABLE', dataHandle, 40, '999999');
    planted = corruptGroup(planted, 'XRECORD', cell0, 302, 'STALE-VALUE');
    const written = writeDxf(readDxf(planted));
    const chain = chainOf(written)!;
    expect(chain).not.toBeNull();
    // The datatable equals the oracle body with the three 999s spliced in
    // at exactly the planted positions (counts and column runs around
    // them regenerated: the corrupted content sum is the model's again).
    const expected = [...oracle.data];
    expected.splice(expected.findIndex(([c]) => c === 1) + 1, 0, [999, 'TOLERANT-3']);
    expected.splice(expected.findIndex(([c]) => c === 90) + 1, 0, [999, 'TOLERANT-2']);
    expected.splice(expected.findIndex(([c]) => c === 70) + 1, 0, [999, 'TOLERANT-1']);
    expect(canonPairs(chain.data)).toEqual(canonPairs(expected));
    expect(chain.data.filter(([c]) => c === 999).map(([, v]) => v)).toEqual(['TOLERANT-1', 'TOLERANT-2', 'TOLERANT-3']);
    expect(group(chain.data, 91)).toBe('12');
    // The cell regenerates (no stale text) with its XDATA byte-identical at the end.
    expect(canonPairs(chain.cells[0]!)).toEqual(canonPairs([...oracle.cells[0]!, [1001, 'CODEX_REVIEW'], [1000, 'KEEP-ME']]));
    // The planted shape is itself a fixed point.
    expect(writeDxf(readDxf(written))).toBe(written);
  });

  it('CELL_VALUE tolerance: a 999 between the 93 and the 90 — inside the derived run — survives; the run regenerates from the model, never replays', () => {
    const oracle = chainOf(r2000Text())!;
    const cell0 = handleOf(oracle.cells[0]!)!;
    // PINNED PLACEMENT: the 999 sits between the value run's first group
    // (93) and its second (90), inside the derived run's boundary region.
    // Pinned semantics: the regenerated run is emitted as one block where
    // the old run began; tolerated unknown groups inside the region keep
    // their relative order right after it — never dropped, never
    // duplicated, and a re-save is a fixed point.
    let planted = insertInto(r2000Text(), 'XRECORD', cell0, ([c]) => c === 93, [[999, 'IN-RUN']]);
    planted = corruptGroup(planted, 'XRECORD', cell0, 302, 'STALE-VALUE');
    const written = writeDxf(readDxf(planted));
    const chain = chainOf(written)!;
    expect(chain).not.toBeNull();
    expect(canonPairs(chain.cells[0]!)).toEqual(canonPairs([...oracle.cells[0]!, [999, 'IN-RUN']]));
    expect(chain.cells[0]!.filter(([c]) => c === 302)).toEqual([[302, 'P22 CONTROL TABLE']]);
    expect(chain.cells[0]!.filter(([c]) => c === 999)).toEqual([[999, 'IN-RUN']]);
    expect(writeDxf(readDxf(written))).toBe(written);
  });

  it("unlocatable derived values refuse the save atomically with an 'unsupported table data layout' error", () => {
    const oracle = chainOf(r2000Text())!;
    const dataHandle = handleOf(oracle.data)!;
    // Shape 1: the counts 90 is gone — the derived counts cannot be located.
    const noCount = removeFrom(r2000Text(), 'ACDBDATATABLE', dataHandle, ([c]) => c === 90);
    expect(() => writeDxf(readDxf(noCount))).toThrowError(/unsupported table data layout/);
    // Shape 2: every column segment carries an unrecognized type — no
    // known segment's value run can be located.
    const noSegments = rewriteIn(r2000Text(), 'ACDBDATATABLE', dataHandle, ([c, v]) => (c === 92 ? [92, '77'] : [c, v]));
    expect(() => writeDxf(readDxf(noSegments))).toThrowError(/unsupported table data layout/);
  });
});

/**
 * P22 PR #39 re-review 3 (Codex P1; lead ruling): the tolerant datatable
 * parse consumed only the FIRST contiguous value run of a derived column.
 * A 999 comment (or any unknown group) planted after the first value of a
 * derived ACDBDATATABLE column — the 40 content sums, either 93 column,
 * the 360 cell handles — split the run: the writer emitted the 12
 * regenerated values and then replayed the 11 stale ones behind the
 * comment, writing 23 values against the declared 91 = 12 (probe at
 * 690aa79: every split column tallies 23; the unsplit control tallies
 * 12/12/12/12). Ruling, simplest safe form — no clever parsing:
 * (1) ANY non-derived group INSIDE a derived value run (between the
 *     column's first and last value) refuses the save atomically with
 *     'unsupported table data layout'. Groups OUTSIDE the runs (before a
 *     column's first value, after its last value, between whole columns)
 *     stay preserved exactly as re-review 2 pinned them.
 * (2) Belt-and-braces invariant, checked on the rewritten body before it
 *     is committed: every regenerated column's value count must equal the
 *     declared cell count (the 91 the rewrite itself emits, derived from
 *     the model); any mismatch refuses with the same error.
 */
describe('P22 PR #39 re-review 3: a split derived column refuses atomically; outside-the-run groups stay preserved', () => {
  const handleOf = (rec: Pair[]) => rec.find(([c]) => c === 5)?.[1];
  const flatPairs = (text: string): Pair[] => {
    const lines = text.split(/\r?\n/);
    const pairs: Pair[] = [];
    for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i]!, 10), lines[i + 1]!]);
    return pairs;
  };
  const emitText = (pairs: Pair[]): string => pairs.map(([c, v]) => `${c}\n${v}`).join('\n') + '\n';
  const recordSpan = (pairs: Pair[], type: string, handle: string): { start: number; end: number } => {
    const starts: number[] = [];
    pairs.forEach((p, i) => { if (p[0] === 0) starts.push(i); });
    for (let s = 0; s < starts.length; s++) {
      const start = starts[s]!, end = starts[s + 1] ?? pairs.length;
      const slice = pairs.slice(start, end);
      if (slice[0]?.[1] === type && slice.find(([c]) => c === 5)?.[1] === handle) return { start, end };
    }
    throw new Error(`record ${type} ${handle} not found`);
  };
  /** Insert groups right after the n-th (1-based) group with `code` in the record (type, handle). */
  const insertAfterNth = (text: string, type: string, handle: string, code: number, n: number, extra: Pair[]): string => {
    const pairs = flatPairs(text);
    const { start, end } = recordSpan(pairs, type, handle);
    let seen = 0;
    for (let i = start; i < end; i++) {
      if (pairs[i]![0] === code) { seen += 1; if (seen === n) { pairs.splice(i + 1, 0, ...extra); return emitText(pairs); } }
    }
    throw new Error(`group ${code} occurrence ${n} not found in ${type} ${handle}`);
  };
  const canonPairs = (rec: Pair[]): string[] => rec.map(([c, v]) =>
    HANDLE_CODES.has(c) ? `${c}=h:${v}` : REAL_CHAIN_CODES.has(c) ? `${c}=n:${Number(v)}` : INT_CHAIN_CODES.has(c) ? `${c}=i:${parseInt(v, 10)}` : `${c}=s:${v}`);
  /** Value tallies per column segment of a datatable body, in segment order. */
  const columnTallies = (data: Pair[]): Array<{ seg: number; code: number; count: number }> => {
    const out: Array<{ seg: number; code: number; count: number }> = [];
    let cur: { seg: number; code: number; count: number } | undefined;
    for (const [c, v] of data) {
      if (c === 92) {
        const type = parseInt(v, 10);
        cur = { seg: type, code: type === 2 ? 40 : type === 6 ? 360 : 93, count: 0 };
        out.push(cur);
        continue;
      }
      if (cur && c === cur.code) cur.count += 1;
    }
    return out;
  };
  const dataHandleOf = () => handleOf(chainOf(r2000Text())!.data)!;

  it("split 40 column: a 999 after the first content sum refuses the save atomically with 'unsupported table data layout' (no file written)", () => {
    const planted = insertAfterNth(r2000Text(), 'ACDBDATATABLE', dataHandleOf(), 40, 1, [[999, 'SPLIT-40']]);
    expect(() => writeDxf(readDxf(planted))).toThrowError(/unsupported table data layout/);
  });

  it('split first 93 column (alignment flags): a 999 after the first flag refuses the save atomically', () => {
    const planted = insertAfterNth(r2000Text(), 'ACDBDATATABLE', dataHandleOf(), 93, 1, [[999, 'SPLIT-93-FLAGS']]);
    expect(() => writeDxf(readDxf(planted))).toThrowError(/unsupported table data layout/);
  });

  it('split second 93 column (zeros): a 999 after the first zero refuses the save atomically', () => {
    // The zeros column's first value is the record's 13th 93 (12 flags precede it).
    const planted = insertAfterNth(r2000Text(), 'ACDBDATATABLE', dataHandleOf(), 93, 13, [[999, 'SPLIT-93-ZEROS']]);
    expect(() => writeDxf(readDxf(planted))).toThrowError(/unsupported table data layout/);
  });

  it('split 360 column: a 999 after the first cell handle refuses the save atomically', () => {
    const planted = insertAfterNth(r2000Text(), 'ACDBDATATABLE', dataHandleOf(), 360, 1, [[999, 'SPLIT-360']]);
    expect(() => writeDxf(readDxf(planted))).toThrowError(/unsupported table data layout/);
  });

  it('split 40 column with an UNKNOWN group (301) inside the run refuses the save atomically, exactly like a 999', () => {
    const planted = insertAfterNth(r2000Text(), 'ACDBDATATABLE', dataHandleOf(), 40, 1, [[301, 'SPLIT-UNKNOWN']]);
    expect(() => writeDxf(readDxf(planted))).toThrowError(/unsupported table data layout/);
  });

  it('a 999 after the LAST value of the 40 column (between whole columns) is OUTSIDE the run: preserved in place, the save succeeds, every column keeps exactly the declared count', () => {
    const oracle = chainOf(r2000Text())!;
    const planted = insertAfterNth(r2000Text(), 'ACDBDATATABLE', dataHandleOf(), 40, 12, [[999, 'BETWEEN-COLUMNS']]);
    const written = writeDxf(readDxf(planted));
    const chain = chainOf(written)!;
    expect(chain).not.toBeNull();
    // The body equals the oracle's with the 999 spliced in right after the
    // final content sum — counts and all four column runs regenerated.
    const expected = [...oracle.data];
    expected.splice(expected.map(([c]) => c).lastIndexOf(40) + 1, 0, [999, 'BETWEEN-COLUMNS']);
    expect(canonPairs(chain.data)).toEqual(canonPairs(expected));
    expect(group(chain.data, 91)).toBe('12');
    expect(columnTallies(chain.data).map(({ count }) => count)).toEqual([12, 12, 12, 12]);
    // The planted shape is itself a fixed point.
    expect(writeDxf(readDxf(written))).toBe(written);
  });

  it('the ordinary control still saves byte-normally: the unmodified round trip is the fixed point and every column carries the declared 12 values', () => {
    const written = writeDxf(readDxf(r2000Text()));
    expect(writeDxf(readDxf(written))).toBe(written);
    const chain = chainOf(written)!;
    expect(group(chain.data, 91)).toBe('12');
    expect(columnTallies(chain.data).map(({ count }) => count)).toEqual([12, 12, 12, 12]);
  });
});
