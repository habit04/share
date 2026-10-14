/**
 * 2D byte identity guard for 3D persistence (milestone 5): a drawing without solids must produce
 * the DXF it produced before 3D support.
 *
 * - Exact output hashes are from the verified pre-integration fccba52 reader/writer (all 59
 *   dependency blobs authenticated against that commit). The earlier incoming 3D branch goldens
 *   predate the completed 2D/native preservation work and remain unchanged as provenance.
 *   Only checkout line endings are normalized; the writer's own CRLF is checked separately.
 *   There is intentionally no fixture/golden update switch.
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
  'block-colors': ['d44dd28a3a2d19a88de28c2b6ef18ce4622109b709c8add8ddf27826f37de98f', '6ea83f9d5b4ca1bcc220953a4e308b15e33829183fc9bf4ec0ec01379848a3c1', '712755e567e4b52f3dd87f501eccfe6269ef930d1a754f93019a917c41af4a6e'],
  hatch: ['99872d47f2af1a55fd8462083b25926fabd788fead26427f9d7202839b7aaa82', 'eb83d0613f5bc107a2762c8b89c5328c69e345e8f18817ce3b9f65a79dee0cf4', '2f683468b3d721d2170c8dd2bc1c5c3eebaa20fffcb5891e9092e6a673e4e34b'],
  'polyline-widths': ['41ff2357bdb4653396400d44113273203ea0fdc10e8efec283b56ec5108818fb', 'f26d5d03e3340e5d9cc7f689f69e1569011dc4dd4d05fc2c2a21a7a31f2a736b', '67fbdf3d4849505709756959a95e0ed0a001619554d80209a7f5f58ee22c4dc5'],
  'acad-table': ['0e3a7e374c9372782fc73c1875fe3ba80f43836e4a6217cb681b36734ccbfd29', '1281c26362e7e8fb61fab1cae24f160ab0ae9c29dac5d489523d5a2a4ad050e4', '495a35c874461dfafc244d185ad1c3a070ebf93df346581a33b9ab0913a7c4b5'],
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
