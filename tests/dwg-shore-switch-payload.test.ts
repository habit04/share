/**
 * Private-fixture acceptance tests for the shore-switch DWG (AC1018) import fixes.
 *
 * The customer drawing and the Windows-captured reader payload are NOT part of the
 * repository. Set JCAD_DWG_PAYLOAD (dwg-payload-windows.json) and/or JCAD_DWG_FILE
 * (the original .dwg) to run these; without them every test is an explicit skip.
 * The payload path verifies conversion downstream of decoding (the exact
 * Windows-observed failure); the DWG path additionally exercises the actual
 * platform reader. Windows checks the native compatibility warning and incomplete
 * metadata projection explicitly. Other platforms use the documented fallback path.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { convertDwg, type DwgImportPayload } from '../src/io/dwg';
// @ts-expect-error plain JS reader shared with Electron/CLI
import { readDwgPayload } from '../scripts/dwg-reader.mjs';
import { validateGeometryBudget } from '../src/core/geometry-budget';
import { entityGeometryWork, type InsertEntity, type TextEntity } from '../src/core/entities';
import type { DrawingState } from '../src/core/document';

const PAYLOAD_PATH = process.env.JCAD_DWG_PAYLOAD;
const DWG_PATH = process.env.JCAD_DWG_FILE;
const DWG_SHA256 = 'b20e3ec369e01a554ea4591ba75c9256712f5c8ff8f3e83978b73479f46cd919';

function expectShoreSwitchDrawing(state: DrawingState, report: { counts: Record<string, Partial<Record<string, number>>> } | null): void {
  // The whole drawing is accepted by the geometry budget (no partial exclusion needed).
  expect(() => validateGeometryBudget(state)).not.toThrow();
  // None of the 81 formerly dropped TEXT records is dropped now.
  expect(report?.counts.TEXT?.dropped ?? 0).toBe(0);
  // Standalone attribute definitions are separate objects, not ordinary TEXT. The
  // fallback DTO omits their defaults, so report them rather than inventing labels.
  expect(report?.counts.ATTDEF?.dropped).toBe(4);
  // The signature reference is in model space, on its layer, at its position.
  const signature = state.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === '杨荐钦 - 签名');
  expect(signature, 'signature wrapper insert').toBeDefined();
  expect(signature!.layer).toBe('LY_Partlib2');
  expect(Math.abs(signature!.position.x - 8027.404056)).toBeLessThan(0.001);
  expect(Math.abs(signature!.position.y - 1066.97695)).toBeLessThan(0.001);
  // The nested signature geometry is retained: splines, lines, arcs and the two
  // filled hatches, whose work now tracks their tessellated vertex count.
  const nested = state.blocks['杨荐钦'];
  expect(nested, 'nested signature block').toBeDefined();
  const byType = new Map<string, number>();
  for (const e of nested!.entities) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  expect(byType.get('spline')).toBe(180);
  expect(byType.get('line')).toBe(22);
  expect(byType.get('arc')).toBe(3);
  expect(byType.get('hatch')).toBe(2);
  const hatchWork = nested!.entities.filter((e) => e.type === 'hatch').reduce((sum, e) => sum + entityGeometryWork(e), 0);
  expect(hatchWork).toBeGreaterThan(11_000); // the sampled boundary points are all retained
  expect(hatchWork).toBeLessThan(20_000); // was 107,298 under the whole-loop bulge multiplier
  // The six formerly dropped model-space TEXT records are back, strings and
  // (Middle, middle) justification intact.
  const modelTexts = state.entities.filter((e): e is TextEntity => e.type === 'text');
  for (const expected of ['出口美国项目', '江苏亚威变压器有限公司', '2026.10.15', '系统图']) {
    const found = modelTexts.some((t) => t.text === expected && t.justification?.horizontal === 4 && t.justification?.vertical === 2);
    expect(found, `model text ${expected} with (Middle, middle) justification`).toBe(true);
  }
  // The title-block definitions kept their (4,2) records too.
  const border = state.blocks['BorderBlock'];
  expect(border, 'BorderBlock').toBeDefined();
  expect(border!.entities.filter((e) => e.type === 'text' && e.justification?.horizontal === 4 && e.justification?.vertical === 2)).toHaveLength(36);
  const anon = state.blocks['ANON_U293'];
  expect(anon, 'ANON_U293 (source *U293)').toBeDefined();
  expect(anon!.entities.filter((e) => e.type === 'text' && e.justification?.horizontal === 4 && e.justification?.vertical === 2)).toHaveLength(36);
}

describe.skipIf(!PAYLOAD_PATH)('shore switch drawing — captured Windows payload', () => {
  it('converts with the signature retained and all 81 TEXT records restored', () => {
    const bytes = readFileSync(PAYLOAD_PATH!);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('ad2df98d6492b638a14a03e7acd6205f66b293d71f95d4a77597f7de17aff17d');
    const raw = JSON.parse(bytes.toString('utf8')) as { payload: DwgImportPayload };
    const { state, report } = convertDwg(raw.payload, 'shore switch drawing from china.dwg');
    expectShoreSwitchDrawing(state, report);
  }, 120_000);
});

describe.skipIf(!DWG_PATH)('shore switch drawing — original DWG through the platform reader', () => {
  it('decodes read-only (hash pinned), converts and validates', async () => {
    const bytes = readFileSync(DWG_PATH!);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(DWG_SHA256);
    const { payload } = (await readDwgPayload(new Uint8Array(bytes))) as { payload: DwgImportPayload };
    const { state, report } = convertDwg(payload, 'shore switch drawing from china.dwg');
    expectShoreSwitchDrawing(state, report);
    // Test the real platform path; a captured payload is a separate check above.
    if (process.platform === 'win32') {
      expect(payload.nativeMetadata).toMatchObject({ schemaVersion: 1, readError: 4, complete: false });
      expect(payload.nativeMetadata!.dxf.length).toBeGreaterThan(0);
      expect(report?.counts.CAD_METADATA?.unsupported ?? 0).toBeGreaterThan(0);
    } else {
      expect(payload.nativeMetadata).toBeUndefined();
      expect(report?.counts.XDATA?.unsupported ?? 0).toBeGreaterThan(0);
    }
    expect(createHash('sha256').update(readFileSync(DWG_PATH!)).digest('hex')).toBe(DWG_SHA256);
  }, 300_000);
});
