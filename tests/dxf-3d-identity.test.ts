/**
 * 2D byte identity guard for 3D persistence (milestone 5): a drawing without solids must produce
 * the DXF it produced before 3D support.
 *
 * - Golden outputs: tests/golden/dxf-3d/<fixture>.dxf is the text `writeDxf` produced for
 *   tests/fixtures/<fixture>.dxf before 3D persistence (generated with the writer at the branch base
 *   and confirmed byte-identical). The comparison ignores only the line-ending style, which Git may
 *   convert on checkout; the writer's own CRLF is checked separately. A difference means the 2D
 *   output changed: regenerating a golden is a deliberate decision that needs a review of the diff,
 *   never a way to make this test pass (there is intentionally no update switch).
 * - Every fixture's output is also compared with the output for the same state carrying an empty
 *   model, and checked for any trace of the 3D records.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const GOLDEN = ['block-colors', 'hatch', 'polyline-widths', 'acad-table'];
const lf = (t: string) => t.replace(/\r\n/g, '\n');
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
    it(`matches the pre-3D golden output: ${name}`, () => {
      const text = writeDxf(readDxf(readFileSync(`tests/fixtures/${name}.dxf`, 'utf8')));
      expect(text.split('\n').every((line, i, all) => i === all.length - 1 || line.endsWith('\r'))).toBe(true);
      expect(lf(text)).toBe(lf(readFileSync(`tests/golden/dxf-3d/${name}.dxf`, 'utf8')));
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
