/**
 * 2D byte identity guard for 3D persistence (milestone 5): a drawing without solids must produce
 * the DXF it produced before 3D support.
 *
 * - Exact output hashes are from the verified pre-integration fccba52 reader/writer (all 59
 *   dependency blobs authenticated against that commit). The earlier incoming 3D branch goldens
 *   predate the completed 2D/native preservation work and remain unchanged as provenance.
 *   Only checkout line endings are normalized; the writer's own CRLF is checked separately.
 *   There is intentionally no fixture/golden update switch.
 * - Q11 F2 rework exception (lead decision, APPROVED with conditions): the [1] output hashes
 *   below were updated once, because the pre-F2 writer fabricated a $CANNOSCALE '1:1' HEADER
 *   pair into every output and the rework removes that fabrication (the setting now lives in
 *   the variable dictionary, and these fixtures set none). Verified pair-by-pair against the
 *   b6abbace outputs: for each of the four, the delta is EXACTLY the deletion of the two pairs
 *   (9, $CANNOSCALE), (2, 1:1) at pair index 142 and nothing else. [0] input hashes and the
 *   [2] legacy goldens are byte-unchanged.
 * - P22 native-table exception (2026-10-21, P22 slice 1, same discipline as the F2 update):
 *   the acad-table [1] output hash was updated once more, because tables are now written
 *   natively (ACAD_TABLE + *T picture block + synthesized TABLESTYLE in an ACAD_TABLESTYLE
 *   dictionary) instead of INSERT + JCAD_TABLE xdata — that replacement is the slice's
 *   intended output change. Verified pair-by-pair against the fe9f6b8e output: the delta is
 *   exactly (a) the two CLASS registrations (TABLESTYLE, ACAD_TABLE), (b) the INSERT +
 *   JCAD_TABLE record replaced by the ACAD_TABLE record, (c) the *U1 picture block renamed
 *   *T1 with unchanged content, (d) the added dictionary + TABLESTYLE object, and
 *   (e) consequent handle renumbering including $HANDSEED — nothing else differs. The other
 *   three [1] hashes, every [0] input hash and the [2] legacy goldens are byte-unchanged,
 *   and every table-free fixture remains byte-identical to the pre-integration writer.
 * - P22 COMP-N N-2 exception (2026-10-21, same discipline): the acad-table [1] output hash was
 *   updated once more, because the *T picture block is now generated in the table's local frame
 *   (position (0, 0), rotation 0) instead of world coordinates — the lead's Windows gate found
 *   AutoCAD's TABLEDIT cannot pick a cell when the picture is stored in world coordinates
 *   (gate-a 20/22), while AutoCAD's own *T blocks are insertion-relative. Verified pair-by-pair
 *   against the 206728f3 output: the delta is EXACTLY 40 value lines, all inside the *T1
 *   BLOCK..ENDBLK span, all coordinate groups (10/20/11/21), each shifted by exactly the
 *   fixture table's position (-5 in x, -8 in y) — nothing else differs. The other three [1]
 *   hashes, every [0] input hash and the [2] legacy goldens are byte-unchanged.
 * - P22 COMP-N combined exception (2026-10-21, same discipline): the acad-table [1] output
 *   hash was updated once more at the COMP-N re-composition, because the two cleared
 *   COMP-N deltas compose on this fixture and N-3 Series 2 (the lead's optional item)
 *   writes the synthesized TABLESTYLE row-type group 90 as AutoCAD's normalised 4
 *   instead of 512. Verified pair-by-pair against the 7ab8ae70 output (the N-2 head):
 *   the delta is EXACTLY three value lines (512 -> 4, the three TABLESTYLE cell-style
 *   row blocks) — nothing else differs; verified against the N-3 head's output, the
 *   delta is exactly the N-2 exception's 40 local-frame coordinate lines (same census:
 *   10 x13 @ -5, 20 x13 @ -8, 11 x7 @ -5, 21 x7 @ -8, all inside the *T1 span). The
 *   other three [1] hashes, every [0] input hash and the [2] legacy goldens are
 *   byte-unchanged.
 * - P22 F-2 exception (2026-10-21, same discipline): the acad-table [1] output hash was
 *   updated once more on the rebased lineage, because AC1015 cells are now written in
 *   AutoCAD's own R2000 form (the lead's native re-run: the pre-F-2 form loaded with empty
 *   cell text until a regen and its unconditional 140/170 never appeared). Verified
 *   pair-by-pair against the b7a45e0 output (the rebased head before F-1/F-2/O-1): the
 *   delta is EXACTLY the per-cell form change over the fixture's 6 cells — per cell the
 *   groups 91, 92 and 7 are removed and 177 is added; the unconditional 140 is removed
 *   (6 pairs); the unconditional 170 is removed and re-stated only on the two cells whose
 *   attachment departs from their row role (net -4 pairs) — 22 pairs fewer in total, cell
 *   texts and order unchanged, and everything outside the ACAD_TABLE cell chunks,
 *   including every 141/142, byte-identical. F-1 does not touch this fixture (no
 *   multi-line cell) and O-1 does not (every text is under 250 chars). The other three
 *   [1] hashes, every [0] input hash and the [2] legacy goldens are byte-unchanged.
 * - Every fixture's output is also compared with the output for the same state carrying an empty
 *   model, and checked for any trace of the 3D records.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const GOLDEN = ['block-colors', 'hatch', 'polyline-widths', 'acad-table'];
const lf = (t: string) => t.replace(/\r\n/g, '\n');
const sha = (text: string) => createHash('sha256').update(lf(text)).digest('hex');
// Independently executed immutable fccba52b9c8ce25d90a2fcb96261ddc4502eae32 source.
// Tuple: fixture input, pre-integration output, unchanged incoming legacy golden.
const BASELINES: Readonly<Record<string, readonly [string, string, string]>> = {
  'block-colors': ['d44dd28a3a2d19a88de28c2b6ef18ce4622109b709c8add8ddf27826f37de98f', '826c47754d9e093493c812bc4ad8ef9767fabeec611b0eb40aa971340afe8c81', '712755e567e4b52f3dd87f501eccfe6269ef930d1a754f93019a917c41af4a6e'],
  hatch: ['99872d47f2af1a55fd8462083b25926fabd788fead26427f9d7202839b7aaa82', '0690ef325b7b5fa09e789a0db9d276f2427a0006851c56f64e2af8756bd55b67', '2f683468b3d721d2170c8dd2bc1c5c3eebaa20fffcb5891e9092e6a673e4e34b'],
  'polyline-widths': ['41ff2357bdb4653396400d44113273203ea0fdc10e8efec283b56ec5108818fb', '51f8507514c66efa3714ddb3cea5c9bf8271636d49f1e1628a69f4a182e76ba3', '67fbdf3d4849505709756959a95e0ed0a001619554d80209a7f5f58ee22c4dc5'],
  'acad-table': ['0e3a7e374c9372782fc73c1875fe3ba80f43836e4a6217cb681b36734ccbfd29', '6e7d055b0cf8a0aedd20877cfa7aa2732e678f696ebaa727edafdeef3bb1ac1c', '495a35c874461dfafc244d185ad1c3a070ebf93df346581a33b9ab0913a7c4b5'],
};
import { Drawing, type DrawingState } from '../src/core/document';
import { readDxf, writeDxf } from '../src/io/dxf';
import { EMPTY_MODEL3D, newSolid, withModel3D } from '../src/model3d/model';
import { boxMesh } from '../src/model3d/primitives';

const FIXTURES = ['all-entities', 'acad-layouts', 'block-colors', 'acad-table', 'polyline-widths', 'hatch'];

function section(text: string, name: string): string {
  const start = text.indexOf(`\r\n2\r\n${name}\r\n`);
  return text.slice(start, text.indexOf('\r\nENDSEC\r\n', start));
}

describe('DXF output of drawings without 3D solids', () => {
  for (const name of GOLDEN) {
    it(`matches the verified pre-integration 2D bytes: ${name}`, () => {
      const input = readFileSync(`tests/fixtures/${name}.dxf`, 'utf8'), baseline = BASELINES[name]!;
      expect(sha(input)).toBe(baseline[0]);
      expect(sha(readFileSync(`tests/golden/dxf-3d/${name}.dxf`, 'utf8'))).toBe(baseline[2]);
      const text = writeDxf(readDxf(input));
      expect(text.split('\n').every((line, i, all) => i === all.length - 1 || line.endsWith('\r'))).toBe(true);
      expect(sha(text)).toBe(baseline[1]);
    });
  }

  for (const name of [...FIXTURES, '(new drawing)']) {
    it(`is unchanged by an empty 3D model: ${name}`, () => {
      const state: DrawingState = name === '(new drawing)' ? new Drawing().snapshot : readDxf(readFileSync(`tests/fixtures/${name}.dxf`, 'utf8'));
      expect(state.model3d).toBeUndefined();
      const text = writeDxf(state);
      expect(writeDxf({ ...state, model3d: EMPTY_MODEL3D })).toBe(text);
      expect(writeDxf({ ...state, model3d: { version: 1, solids: [] } })).toBe(text);
      expect(writeDxf({ ...state, model3d: { version: 1, solids: [], dimensions: [] } })).toBe(text);
      expect(text).not.toContain('JCAD_3D');
      expect(text).not.toContain('AcDbPolyFaceMesh');
      expect(text).not.toMatch(/\r\nPOLYLINE\r\n(?:(?!\r\n0\r\n)[\s\S])*\r\n70\r\n64\r\n/);
      // Reading it back yields no 3D model either.
      expect(readDxf(text, { model3d: true }).model3d).toBeUndefined();
    });
  }

  it('adds exactly one APPID record and leaves the header alone when solids are present', () => {
    const plain = readDxf(readFileSync('tests/fixtures/all-entities.dxf', 'utf8'));
    const with3d = withModel3D(plain, { ...EMPTY_MODEL3D, solids: [newSolid({ mesh: boxMesh(1, 1, 1), feature: { kind: 'mesh', source: 'edited' } })] });
    const a = writeDxf(plain), b = writeDxf(with3d);
    const header = (t: string) => section(t, 'HEADER').replace(/\r\n\$HANDSEED\r\n5\r\n[0-9A-F]+/, '');
    expect(header(b)).toBe(header(a));
    const appids = (t: string) => [...section(t, 'TABLES').matchAll(/AcDbRegAppTableRecord\r\n2\r\n([^\r]+)/g)].map((m) => m[1]);
    expect(appids(b)).toEqual([...appids(a), 'JCAD_3D']);
    const count = (t: string) => /\r\nAPPID\r\n5\r\n9\r\n330\r\n0\r\n100\r\nAcDbSymbolTable\r\n70\r\n(\d+)/.exec(t)?.[1];
    expect(Number(count(b))).toBe(Number(count(a)) + 1);
  });
});
