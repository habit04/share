import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { evaluateShxGlyph, MAX_SHX_BYTES, parseShx, shxCharacterCode, shxTextCodes, type ShxGlyphResult } from '../src/io/shx';
import { ShxFontRegistry, MAX_SHX_PENDING_REQUESTS, MAX_SHX_RUN_WORK, type ShxResource } from '../src/render/shx-fonts';
import { fontRecords, shxFixture, type ShxFixtureRecord } from './helpers/shx-fixture';

const glyph = (bytes: Uint8Array, code: number, vertical = false) => evaluateShxGlyph(parseShx(bytes), code, { vertical });
function supported(result: ShxGlyphResult): Extract<ShxGlyphResult, { ok: true }> { expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.problem); return result; }
function boundsClose(actual: readonly number[] | null, expected: readonly number[]): void { expect(actual).not.toBeNull(); expected.forEach((value, i) => expect(actual![i]).toBeCloseTo(value, 10)); }
function fontWith(program: readonly number[], extra: readonly ShxFixtureRecord[] = []): Uint8Array { return shxFixture('unifont', [fontRecords[0]!, { code: 65, program }, ...extra]); }
function resource(bytes = shxFixture(), resolvedPath = 'C:\\private\\font.shx'): ShxResource {
  const sha256 = createHash('sha256').update(bytes).digest('hex'); return { bytes, resolvedPath, sha256, resourceId: JSON.stringify([resolvedPath, sha256]) };
}
afterEach(() => { vi.restoreAllMocks(); });
function deferredDigests() {
  const jobs: Array<{ bytes: Uint8Array; resolve: (value: ArrayBuffer) => void; reject: (reason: Error) => void }> = [];
  const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation((_algorithm, input) => new Promise<ArrayBuffer>((resolve, reject) => {
    if (!(input instanceof Uint8Array)) throw new Error('Unexpected digest input');
    jobs.push({ bytes: input, resolve, reject });
  }));
  const release = () => { for (const job of jobs.splice(0)) job.resolve(Uint8Array.from(createHash('sha256').update(job.bytes).digest()).buffer); };
  return { jobs, spy, release };
}

describe('bounded SHX containers', () => {
  it('matches exact native COMPILE bytes for the two original SHP sources', () => {
    expect(createHash('sha256').update(shxFixture('shapes')).digest('hex')).toBe('14d1b70144de445bc343f67a12ac6c26c69a174966cf8aaf2fab9e829a32b5b5');
    expect(createHash('sha256').update(shxFixture()).digest('hex')).toBe('61f12e234db1c069d8497ae3f8c4b01ecef907472c0b4c28542c3ccc06edac47');
  });
  it('keeps shape identities and Unicode font metadata in immutable snapshots', () => {
    const bytes = shxFixture(), font = parseShx(bytes); bytes.fill(0);
    expect(font).toMatchObject({ format: 'unifont', version: '1.0', isFont: true, above: 10, below: 2, modes: 2, encoding: 0, fontType: 0, renderProblem: null });
    expect(font.definitions[65]!.program).toEqual(fontRecords[2]!.program.map((byte) => byte & 255));
    expect(Object.isFrozen(font.definitions[65]!.program)).toBe(true);
    expect(Object.isFrozen(font.definitions)).toBe(true);
    const shapes = parseShx(shxFixture('shapes'));
    expect(shapes.isFont).toBe(false); expect(shapes.definitions[200]!.name).toBe('JCADBOX');
  });
  it('retains unknown encoding, orientation and licensing metadata with explicit fallback', () => {
    const font = parseShx(shxFixture('unifont', [{ ...fontRecords[0]!, program: [10, 2, 9, 1, 3, 0] }, fontRecords[2]!]));
    expect(font).toMatchObject({ modes: 9, encoding: 1, fontType: 3 });
    expect(evaluateShxGlyph(font, 65)).toMatchObject({ ok: false, problem: expect.stringMatching(/orientation/) });
    expect(parseShx(shxFixture('unifont', [{ ...fontRecords[0]!, program: [10, 2, 2, 1, 0, 0] }, fontRecords[2]!])).renderProblem).toMatch(/multibyte/);
  });
  it.each(['bigfont', 'shapes 1.1', 'unifont 2.0'])('refuses unsupported container %s', (kind) => {
    const name = kind.includes(' ') ? kind : `${kind} 1.0`;
    expect(() => parseShx(Buffer.from(`AutoCAD-86 ${name}\r\n\x1a\0\0`))).toThrow(/Unsupported/);
  });
  it.each([0, MAX_SHX_BYTES + 1])('bounds file size %i', (size) => { expect(() => parseShx(new Uint8Array(size))).toThrow(/size/); });
  it('rejects duplicate identifiers and mismatched shape ranges', () => {
    expect(() => parseShx(shxFixture('unifont', [...fontRecords, fontRecords[2]!]))).toThrow(/duplicate/);
    const bytes = Buffer.from(shxFixture('shapes')); bytes.writeUInt16LE(199, bytes.indexOf(26) + 1);
    expect(() => parseShx(bytes)).toThrow(/range/);
  });
  it('rejects missing headers, corrupt records, truncated directories and trailing data', () => {
    expect(() => parseShx(shxFixture('unifont', [fontRecords[2]!]))).toThrow(/header/);
    expect(() => parseShx(shxFixture('unifont', [{ ...fontRecords[0]!, program: [10, 2, 0, 0] }]))).toThrow(/header/);
    const bytes = shxFixture();
    for (const length of [3, 25, 30, bytes.length - 1]) expect(() => parseShx(bytes.subarray(0, length))).toThrow();
    expect(() => parseShx(Buffer.concat([bytes, Buffer.from([0])]))).toThrow(/trailing/);
  });
  it.each([[8, 1, 0], [9, 1, 2, 0], [3, 0, 0], [14, 0], [12, 128, 0, 0, 0], [1, 0, 2, 0]].map((program) => [program]))('rejects malformed instructions %j', (program) => {
    expect(() => parseShx(fontWith(program))).toThrow(/Invalid SHX/);
  });
  it('retains unsupported opcode programs without returning invented geometry', () => {
    const bytes = fontWith([15, 25, 0]), font = parseShx(bytes);
    expect(font.definitions[65]!.program).toEqual([15, 25, 0]);
    expect(evaluateShxGlyph(font, 65)).toMatchObject({ ok: false, problem: expect.stringMatching(/opcode 15/) });
  });
  it('bounds total decoded instruction work independently of file byte size', () => {
    const records = Array.from({ length: 70 }, (_, i) => ({ code: i + 32, program: [...Array(1000).fill(0x10), 0] }));
    expect(() => parseShx(shxFixture('unifont', [fontRecords[0]!, ...records]))).toThrow(/instruction budget/);
  });
});

describe('SHX geometry and state', () => {
  it('executes ordered signed vectors and XY sequences', () => {
    const shapes = shxFixture('shapes');
    expect(supported(glyph(shapes, 200))).toMatchObject({ bounds: [0, 0, 4, 4], advance: [0, 0], scaleDrift: false });
    expect(supported(glyph(shapes, 204))).toMatchObject({ bounds: [-3, 0, 2, 5], advance: [2, 2] });
    expect(supported(glyph(shapes, 205))).toMatchObject({ bounds: [0, 0, 4.5, 2.5], advance: [4.5, 1] });
  });
  it('uses the current arc start point, exact extrema and clockwise octants', () => {
    const circle = supported(glyph(shxFixture('shapes'), 201));
    expect(circle.bounds).toEqual([-8, -4, 0, 4]); expect(circle.segments[0]).toMatchObject({ kind: 'arc', center: [-4, 0], radius: 4, sweep: Math.PI * 2 });
    const clockwise = supported(glyph(fontWith([10, 4, -0x40, 0]), 65));
    boundsClose(clockwise.bounds, [0, -4, 8, 4]); expect(clockwise.advance[0]).toBeCloseTo(0); expect(clockwise.segments[0]).toMatchObject({ sweep: -Math.PI * 2 });
    // Native COMPILE of authored 10,4,-012,0 yields 0A 04 92 00.
    const quarter = supported(glyph(fontWith([10, 4, 0x92, 0]), 65));
    expect(quarter.segments[0]).toMatchObject({ kind: 'arc', startAngle: Math.PI / 4, sweep: -Math.PI / 2 });
    boundsClose(quarter.bounds, [0, -4 * Math.SQRT2, 4 - 2 * Math.SQRT2, 0]);
    const zeroOctant = supported(glyph(fontWith([10, 4, 0x80, 0]), 65)); boundsClose(zeroOctant.bounds, [-8, -4, 0, 4]);
  });
  it('converts signed bulges to analytic arcs, including pen-up moves and straight segments', () => {
    const arc = supported(glyph(shxFixture('shapes'), 202));
    boundsClose(arc.bounds, [0, -4, 8, 0]); expect(arc.advance).toEqual([8, 0]);
    expect(arc.segments[0]).toMatchObject({ kind: 'arc', center: [4, 0], radius: 4, sweep: Math.PI });
    const opposite = supported(glyph(fontWith([12, 8, 0, -127, 0]), 65)); boundsClose(opposite.bounds, [0, 0, 8, 4]);
    const moved = supported(glyph(fontWith([2, 12, 8, 0, 127, 1, 12, 2, 0, 0, 0]), 65)); expect(moved.segments).toHaveLength(1); expect(moved.bounds).toEqual([8, 0, 10, 0]);
  });
  it('preserves shared subshape position, draw mode and restored scales', () => {
    expect(supported(glyph(shxFixture('shapes'), 203))).toMatchObject({ bounds: [0, 0, 4, 4], advance: [6, 0] });
    expect(supported(glyph(shxFixture(), 68))).toMatchObject({ bounds: [0, 0, 8, 10], advance: [12, 0] });
    expect(supported(glyph(shxFixture(), 69))).toMatchObject({ bounds: [0, 0, 4, 5], advance: [7, 0], finalScale: 1, scaleDrift: false });
    const off = supported(glyph(fontWith([2, 7, 0, 66, 0], [{ code: 66, program: [8, 4, 0, 0] }]), 65)); expect(off.segments).toEqual([]); expect(off.advance).toEqual([4, 0]);
  });
  it('skips an entire conditional instruction in horizontal text', () => {
    expect(supported(glyph(shxFixture(), 70))).toMatchObject({ bounds: [0, 0, 6, 0], advance: [8, 0] });
    expect(supported(glyph(shxFixture(), 70, true))).toMatchObject({ bounds: [0, 0, 6, 20], advance: [8, 20] });
  });
  it.each([[6, 0], [5, 0], [5, 5, 5, 5, 5, 0], [7, 0, 65, 0], [7, 0, 66, 0]].map((program) => [program]))('refuses unsafe stack/subshape state %j', (program) => { expect(glyph(fontWith(program), 65).ok).toBe(false); });
  it('marks persistent scale drift and bounds cumulative work', () => {
    expect(supported(glyph(fontWith([4, 2, 8, 1, 0, 0]), 65))).toMatchObject({ finalScale: 2, scaleDrift: true });
    expect(glyph(fontWith([...Array(10).fill([4, 255]).flat(), 8, 127, 127, 0]), 65)).toMatchObject({ ok: false, problem: expect.stringMatching(/budget/) });
  });
  it('keeps fractional arc data while refusing unverified interpretation', () => {
    const font = parseShx(fontWith([11, 56, 28, 0, 3, 0x12, 0]));
    expect(evaluateShxGlyph(font, 65)).toMatchObject({ ok: false, problem: expect.stringMatching(/Fractional/) });
    expect(font.definitions[65]!.program).toEqual([11, 56, 28, 0, 3, 0x12, 0]);
  });
  it.each([9, 13])('charges pen-up list opcode%i work through nested subshapes', (op) => {
    const pair = op === 9 ? [1, 0, 255, 0] : [1, 0, 0, 255, 0, 0];
    const list = Array.from({ length: op === 9 ? 495 : 325 }, () => pair).flat();
    const middle = [...Array.from({ length: 666 }, () => [7, 0, 1]).flat(), 0], root = [...Array.from({ length: 5 }, () => [7, 0, 2]).flat(), 0];
    const font = parseShx(shxFixture('unifont', [fontRecords[0]!, { code: 1, program: [2, op, ...list, 0, 0, 0] }, { code: 2, program: middle }, { code: 65, program: root }]));
    expect(evaluateShxGlyph(font, 65)).toMatchObject({ ok: false, problem: expect.stringMatching(/evaluation work budget/) });
  });
});

describe('SHX runtime resource identity and measurement', () => {
  it('normalizes exact advance and ink by the font header height', async () => {
    const registry = new ShxFontRegistry(), id = await registry.register(resource());
    expect(registry.run(id, 'A A', 10)).toMatchObject({ ok: true, advance: 26, left: 0, right: 24, ascent: 10, descent: 0 });
    expect(registry.run(id, 'C', 20)).toMatchObject({ ok: true, advance: 20, left: -10, right: 10, ascent: 20, descent: 0 });
    expect(registry.run(id, 'E', 10)).toMatchObject({ ok: true, advance: 7, right: 4, ascent: 5 });
  });
  it('keeps same-named fonts in separate folders isolated by path and content', async () => {
    const registry = new ShxFontRegistry(), first = resource(), second = resource(shxFixture('unifont', [{ ...fontRecords[0]!, program: [20, 2, 2, 0, 0, 0] }, ...fontRecords.slice(1)]), 'C:\\other\\font.shx');
    const a = await registry.register(first), b = await registry.register(second); expect(a).not.toBe(b);
    expect(registry.run(a, 'A', 10)).toMatchObject({ advance: 10 }); expect(registry.run(b, 'A', 10)).toMatchObject({ advance: 5 });
  });
  it('snapshots caller bytes, verifies hashes, invalidates caches and blocks late registration', async () => {
    const registry = new ShxFontRegistry(), original = resource(), epoch = registry.cacheKey;
    let changes = 0; const dispose = registry.subscribe(() => { changes++; });
    const pending = registry.register(original); original.bytes.fill(0); const id = await pending;
    expect(registry.cacheKey).not.toBe(epoch); expect(registry.run(id, 'A', 10).ok).toBe(true);
    expect(Object.isFrozen(registry.font(id)!.definitions[65]!.program)).toBe(true);
    await expect(registry.register({ ...resource(), sha256: '0'.repeat(64), resourceId: JSON.stringify(['C:\\private\\font.shx', '0'.repeat(64)]) })).rejects.toThrow(/match/);
    const late = registry.register(resource(shxFixture(), 'C:\\late\\font.shx')); registry.clear(); await expect(late).rejects.toThrow(/cleared/);
    expect(registry.font(id)).toBeUndefined(); expect(changes).toBe(2); dispose();
  });
  it('falls back whole runs for missing glyphs, scale drift, nonhorizontal advances and invalid input', async () => {
    const registry = new ShxFontRegistry(), id = await registry.register(resource(fontWith([4, 2, 8, 1, 0, 0])));
    expect(registry.run(id, 'A', 10)).toMatchObject({ ok: false, problem: expect.stringMatching(/scale/) });
    expect(registry.run(id, 'B', 10).ok).toBe(false); expect(registry.run(id, 'A'.repeat(4097), 10).ok).toBe(false);
    expect(registry.run(id, 'A', Infinity).ok).toBe(false); expect(registry.run('absent', 'A', 10).ok).toBe(false);
  });
  it('bounds scaled ink geometry even when the glyph returns to zero advance', async () => {
    const registry = new ShxFontRegistry(), id = await registry.register(resource(fontWith([4, 255, 4, 255, 4, 255, 0x10, 0x14, 0x18, 0x1c, 3, 255, 3, 255, 3, 255, 0])));
    expect(registry.run(id, 'A', 1e9)).toMatchObject({ ok: false, problem: expect.stringMatching(/geometry budget/) });
  });
  it('bounds large-radius shallow arcs independently of their small visible ink box', async () => {
    const registry = new ShxFontRegistry(), id = await registry.register(resource(fontWith([4, 255, 4, 255, 12, 15, 0, 1, 3, 255, 3, 255, 0])));
    expect(registry.run(id, 'A', 1e6)).toMatchObject({ ok: false, problem: expect.stringMatching(/arc geometry budget/) });
  });
  it('refuses small raw vertical advances when height scaling makes them significant', async () => {
    const registry = new ShxFontRegistry(), id = await registry.register(resource(fontWith([3, 255, 3, 255, 3, 255, 3, 255, 8, 0, 1, 4, 255, 4, 255, 4, 255, 4, 255, 0])));
    expect(registry.run(id, 'A', 1e9)).toMatchObject({ ok: false, problem: expect.stringMatching(/vertical advance/) });
  });
  it('retains legacy font headers and limits byte-encoded text to verified characters', () => {
    const font = parseShx(shxFixture('shapes', [{ code: 0, name: 'Original legacy font', program: [10, 2, 0, 0] }, { code: 65, program: [8, 8, 10, 2, 8, 2, -10, 0] }, { code: 258, program: [0] }]));
    expect(font).toMatchObject({ isFont: true, above: 10, encoding: null });
    expect(shxCharacterCode(font, 'A')).toBe(65); expect(shxCharacterCode(font, '⌀')).toBe(258); expect(shxCharacterCode(font, 'é')).toBeNull();
  });
  it('resolves native dimension controls while preserving distinct literal Unicode characters', () => {
    const font = parseShx(shxFixture());
    expect(shxTextCodes(font, '%%c%%D%%p%%%')).toEqual([0x2205, 0xb0, 0xb1, 37]);
    expect(shxTextCodes(font, '∅⌀')).toEqual([0x2205, 0x2300]);
    expect(shxTextCodes(font, '%%uA%%u%%065')).toEqual([65, 65]);
    expect(shxTextCodes(font, '%%missing')).toBeNull();
    expect(shxCharacterCode(font, '😀')).toBeNull();
  });
  it('reports the final decoded glyph for numeric spaces, trailing decorations and escaped percent text', async () => {
    const extra = [37, 48, 50, 51].map((code) => ({ code, program: [2, 8, 2, 0, 0] }));
    const registry = new ShxFontRegistry(), id = await registry.register(resource(shxFixture('unifont', [...fontRecords, ...extra])));
    expect(registry.run(id, 'A%%032', 10)).toMatchObject({ ok: true, terminalSpace: true, advance: 16 });
    expect(registry.run(id, 'A %%u', 10)).toMatchObject({ ok: true, terminalSpace: true });
    expect(registry.run(id, 'A%%%032', 10)).toMatchObject({ ok: true, terminalSpace: false });
    expect(registry.run(id, '', 10)).toMatchObject({ ok: true, terminalSpace: false });
  });
  it('charges cumulative run work even when pen-up glyphs produce no segments', async () => {
    const list = Array.from({ length: 495 }, () => [1, 0, 255, 0]).flat();
    const root = [...Array.from({ length: 4 }, () => [7, 0, 1]).flat(), 0];
    const bytes = shxFixture('unifont', [fontRecords[0]!, { code: 1, program: [2, 9, ...list, 0, 0, 0] }, ...Array.from({ length: 26 }, (_, i) => ({ code: 65 + i, program: root }))]);
    const registry = new ShxFontRegistry(), id = await registry.register(resource(bytes));
    const first = supported(registry.glyph(id, 65)); expect(first.segments).toEqual([]); expect(first.work).toBeGreaterThan(MAX_SHX_RUN_WORK / 26);
    expect(registry.run(id, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 1)).toMatchObject({ ok: false, problem: expect.stringMatching(/cumulative.*work budget/) });
    // Cached glyph reuse must not bypass the bounded run contract.
    expect(registry.run(id, 'A'.repeat(26), 1)).toMatchObject({ ok: false, problem: expect.stringMatching(/cumulative.*work budget/) });
  });
  it('reserves pending slots before hashing, deduplicates verified bytes and keeps reservations across clear', async () => {
    const controlled = deferredDigests(), registry = new ShxFontRegistry();
    const first = resource(), one = registry.register(first), duplicate = registry.register(first);
    const pending = [one, duplicate, ...Array.from({ length: MAX_SHX_PENDING_REQUESTS - 1 }, (_, i) => registry.register(resource(shxFixture(), `C:\\private\\pending${i}.shx`)))];
    const settlements = Promise.allSettled(pending);
    await Promise.resolve(); expect(controlled.jobs).toHaveLength(MAX_SHX_PENDING_REQUESTS);
    await expect(registry.register(resource(shxFixture(), 'C:\\private\\excess.shx'))).rejects.toThrow(/pending.*budget/);
    const different = resource(); different.bytes[0] = 0;
    await expect(registry.register(different)).rejects.toThrow(/pending.*identity/);
    registry.clear();
    await expect(registry.register(resource(shxFixture(), 'C:\\private\\after-clear.shx'))).rejects.toThrow(/pending.*budget/);
    expect(controlled.jobs).toHaveLength(MAX_SHX_PENDING_REQUESTS);
    controlled.release(); expect((await settlements).every((result) => result.status === 'rejected' && /cleared/.test(String(result.reason)))).toBe(true);
    const retry = registry.register(resource()); await Promise.resolve(); expect(controlled.jobs).toHaveLength(1); controlled.release(); await retry;
  });
  it('reserves pending bytes before copies and releases them on digest rejection', async () => {
    const controlled = deferredDigests(), registry = new ShxFontRegistry(), bytes = new Uint8Array(6 * 1024 * 1024);
    bytes.set(shxFixture());
    const jobs = [registry.register(resource(bytes, 'C:\\private\\large1.shx')), registry.register(resource(bytes, 'C:\\private\\large2.shx'))];
    const settlements = Promise.allSettled(jobs); await Promise.resolve(); expect(controlled.jobs).toHaveLength(2);
    await expect(registry.register(resource(bytes, 'C:\\private\\large3.shx'))).rejects.toThrow(/pending.*budget/);
    for (const job of controlled.jobs.splice(0)) job.reject(new Error('Intentional hash failure'));
    expect((await settlements).every((result) => result.status === 'rejected')).toBe(true);
    const retry = registry.register(resource()); await Promise.resolve(); controlled.release(); await retry;
  });
  it('reuses loaded private snapshots without hashing and rejects forged bytes under an existing identity', async () => {
    const registry = new ShxFontRegistry(), original = resource(), id = await registry.register(original), controlled = deferredDigests();
    expect(await registry.register(original)).toBe(id); expect(controlled.spy).not.toHaveBeenCalled();
    original.bytes.fill(0); await expect(registry.register(original)).rejects.toThrow(/identity/); expect(controlled.spy).not.toHaveBeenCalled();
  });
  it('captures loaded resources independently of clear, pending jobs and subsequent font selection', async () => {
    const registry = new ShxFontRegistry(), id = await registry.register(resource()), controlled = deferredDigests();
    let originalChanges = 0; registry.subscribe(() => { originalChanges++; });
    const pendingResource = resource(shxFixture(), 'C:\\private\\not-ready.shx'), pending = registry.register(pendingResource);
    const settlement = Promise.allSettled([pending]); await Promise.resolve();
    const captured = registry.capture(), epoch = captured.cacheKey;
    expect(captured.font(pendingResource.resourceId)).toBeUndefined();
    registry.clear(); controlled.release(); await settlement;
    expect(captured.run(id, 'AA', 10)).toMatchObject({ ok: true, advance: 20, right: 18 });
    expect(captured.font(id)).not.toBeUndefined(); expect(registry.font(id)).toBeUndefined(); expect(captured.cacheKey).toBe(epoch);
    const fresh = registry.register(resource(shxFixture('unifont', [{ ...fontRecords[0]!, program: [20, 2, 2, 0, 0, 0] }, ...fontRecords.slice(1)])));
    await Promise.resolve(); controlled.release(); const newId = await fresh;
    expect(registry.run(newId, 'AA', 10)).toMatchObject({ advance: 10 }); expect(captured.run(id, 'AA', 10)).toMatchObject({ advance: 20 });
    expect(captured.font(newId)).toBeUndefined(); expect(originalChanges).toBe(2);
    expect(() => captured.clear()).toThrow(/read-only/); await expect(captured.register(resource())).rejects.toThrow(/read-only/);
  });
});
