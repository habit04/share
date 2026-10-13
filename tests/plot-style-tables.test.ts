import { describe, expect, it, vi } from 'vitest';
import { readPlotStyleTable } from '../src/io/plot-styles';
import { resolvePlotStyle, type PlotStyleObject } from '../src/core/plot-styles';
import { fixtureAdler32, plotStyleProgram, plotStyleText } from './helpers/plot-style-fixture';

const object: PlotStyleObject = { rgb: [1, 0, 0], aci: 1, lineweightMm: 0.18 };
const read = (options: Parameters<typeof plotStyleText>[0] = {}) => readPlotStyleTable(plotStyleProgram(plotStyleText(options), options.kind));

describe('bounded native plot style tables', () => {
  it('reads 255 colour-dependent styles and native mm lineweights independently of display units', async () => {
    const table = await read({ weights: [0, 0.35, 2.11], root: { custom_lineweight_display_units: '1' } });
    expect(table.kind).toBe('ctb');
    expect(table.styles).toHaveLength(255);
    expect(table.styles[254]).toMatchObject({ name: 'Color_255', index: 254 });
    expect(table.lineweightsMm).toEqual([0, 0.35, 2.11]);
    expect(table.lineweightDisplayUnits).toBe(1);
    expect(table.issues).toEqual([]);
  });

  it('accepts newline termination and a single optional NUL without deleting the final closing section', async () => {
    const body = plotStyleText({ kind: 'stb' }).trimEnd();
    for (const suffix of ['', '\n', '\0', '\n\0']) expect((await readPlotStyleTable(plotStyleProgram(body + suffix, 'stb'))).styles).toHaveLength(2);
    await expect(readPlotStyleTable(plotStyleProgram(body + '\0\0', 'stb'))).rejects.toThrow('control');
  });

  it('snapshots source before asynchronous decompression and freezes every retained subtree', async () => {
    const source = plotStyleProgram(plotStyleText({ unknown: 'extension{\n child{\n  value="retained\n }\n}' }));
    const pending = readPlotStyleTable(source);
    source.fill(0);
    const table = await pending;
    expect(table.description).toBe('JCad authored table');
    expect(table.raw.extension).toEqual({ child: { value: '"retained' } });
    expect(Object.isFrozen(table)).toBe(true);
    expect(Object.isFrozen(table.styles[0])).toBe(true);
    expect(Object.isFrozen(table.raw.extension)).toBe(true);
    expect(Object.isFrozen((table.raw.extension as Record<string, unknown>).child)).toBe(true);
    expect(table.issues[0]?.path).toBe('table.extension');
  });

  it('preserves and reports unknown entry properties and native numeric annotations', async () => {
    const table = await read({ entries: { 0: { screen: '50 (opaque native data)', future_flag: 'strange' } } });
    expect(table.styles[0]?.screening).toBe(50);
    expect((table.raw.plot_style as Record<string, Record<string, string>>)[0]?.screen).toBe('50 (opaque native data)');
    expect(table.styles[0]?.issues.map((issue) => issue.path)).toEqual(['plot_style.0.future_flag', 'plot_style.0.screen']);
    expect(resolvePlotStyle(table, { ...object, aci: 2 }).issues).toEqual([]);
  });

  it('retains quoted string spaces and braces while allowing whitespace on numeric and boolean fields', async () => {
    const table = await read({ entries: { 0: { description: '"name ends in {  ', screen: '100  ', adaptive_linetype: 'TRUE  ' } } });
    expect(table.styles[0]?.description).toBe('name ends in {  ');
    expect((table.raw.plot_style as Record<string, Record<string, string>>)[0]?.screen).toBe('100  ');
    expect(table.styles[0]?.screening).toBe(100);
  });

  it('uses null-prototype source objects so authored unknown keys cannot change object prototypes', async () => {
    const table = await read({ unknown: '__proto__{\n polluted="true\n}\nconstructor="retained' });
    expect(Object.getPrototypeOf(table.raw)).toBeNull();
    expect(table.raw.__proto__).toEqual({ polluted: '"true' });
    expect(table.raw.constructor).toBe('"retained');
    expect(Object.hasOwn({}, 'polluted')).toBe(false);
  });

  it.each([
    ['unsupported header', (bytes: Uint8Array) => { bytes[19] = 88; }],
    ['compressed checksum', (bytes: Uint8Array) => { bytes[48] = bytes[48]! ^ 1; }],
    ['compressed length', (bytes: Uint8Array) => { new DataView(bytes.buffer).setUint32(56, 1, true); }],
    ['expanded length', (bytes: Uint8Array) => { new DataView(bytes.buffer).setUint32(52, 1, true); }],
    ['expanded limit', (bytes: Uint8Array) => { new DataView(bytes.buffer).setUint32(52, 2 * 1024 * 1024 + 1, true); }],
  ])('refuses %s corruption before accepting a table', async (_name, mutate) => {
    const bytes = plotStyleProgram(plotStyleText()); mutate(bytes);
    await expect(readPlotStyleTable(bytes)).rejects.toThrow();
  });

  it('refuses truncated, oversized, damaged zlib and unsupported text programs', async () => {
    const bytes = plotStyleProgram(plotStyleText());
    await expect(readPlotStyleTable(bytes.slice(0, -1))).rejects.toThrow('length');
    await expect(readPlotStyleTable(new Uint8Array(1024 * 1024 + 1))).rejects.toThrow('size');
    bytes[60] = 0;
    new DataView(bytes.buffer).setUint32(48, fixtureAdler32(bytes.subarray(60)), true);
    await expect(readPlotStyleTable(bytes)).rejects.toThrow();
    await expect(readPlotStyleTable(plotStyleProgram(new Uint8Array([0xff, 0xfe])))).rejects.toThrow('UTF-8');
  });

  it('refuses trailing data and concatenated zlib streams even with matching outer checksums and lengths', async () => {
    const original = plotStyleProgram(plotStyleText());
    const second = plotStyleProgram('extra').subarray(60);
    for (const suffix of [new Uint8Array([1, 2, 3]), second]) {
      const source = new Uint8Array(original.length + suffix.length);
      source.set(original); source.set(suffix, original.length);
      const header = new DataView(source.buffer);
      header.setUint32(48, fixtureAdler32(source.subarray(60)), true);
      header.setUint32(56, source.length - 60, true);
      await expect(readPlotStyleTable(source)).rejects.toThrow();
    }
  });

  it('bounds actual decompression, including a dishonest declared length', async () => {
    const bytes = plotStyleProgram('a'.repeat(4 * 1024 * 1024));
    new DataView(bytes.buffer).setUint32(52, 1024, true);
    await expect(readPlotStyleTable(bytes)).rejects.toThrow('exceeds');
  });

  it('feeds bounded input chunks so a native synchronous transform cannot expand the whole program before cancellation', async () => {
    const NativeDeflate = DecompressionStream, writes: number[] = [];
    class ObservedDeflate {
      readonly readable: ReadableStream<Uint8Array>;
      readonly writable: WritableStream<Uint8Array<ArrayBuffer>>;
      constructor(format: CompressionFormat) {
        const native = new NativeDeflate(format), writer = native.writable.getWriter();
        this.readable = native.readable;
        this.writable = new WritableStream({
          write: (bytes: Uint8Array<ArrayBuffer>) => { writes.push(bytes.byteLength); return writer.write(bytes); },
          close: () => writer.close(), abort: (reason) => writer.abort(reason),
        });
      }
    }
    vi.stubGlobal('DecompressionStream', ObservedDeflate);
    try {
      const table = await read();
      expect(table.styles).toHaveLength(255);
      expect(writes.length).toBeGreaterThan(1);
      expect(Math.max(...writes)).toBeLessThanOrEqual(1024);
    } finally { vi.unstubAllGlobals(); }
  });

  it('reports unavailable native decompression', async () => {
    vi.stubGlobal('DecompressionStream', undefined);
    try { await expect(read()).rejects.toThrow('unavailable'); }
    finally { vi.unstubAllGlobals(); }
  });

  it.each([
    ['duplicate', (body: string) => `${body}description="duplicate\n`],
    ['extra close', (body: string) => `${body}}\n`],
    ['unclosed', (body: string) => `${body}extension{\n`],
    ['bad syntax', (body: string) => `${body}garbage\n`],
    ['nested limit', (body: string) => `${body}${'nested{\n'.repeat(20)}${'}\n'.repeat(20)}`],
    ['line limit', (body: string) => `${body}description_extra="${'x'.repeat(4097)}\n`],
    ['line count', (body: string) => `${body}${'\n'.repeat(100001)}`],
    ['wrong kind', (body: string) => body.replace('aci_table_available=TRUE', 'aci_table_available=FALSE')],
    ['sparse weights', (body: string) => body.replace(' 1=0.25', ' 4=0.25')],
    ['sparse styles', (body: string) => body.replace(' 254{', ' 255{')],
    ['invalid number', (body: string) => body.replace('screen=100', 'screen=100.5')],
    ['invalid boolean', (body: string) => body.replace('adaptive_linetype=TRUE', 'adaptive_linetype=yes')],
    ['nonfinite number', (body: string) => body.replace('scale_factor=1.0', 'scale_factor=1e999')],
    ['invalid colour', (body: string) => body.replace('color=-1', 'color=-2147483649')],
    ['missing scalar', (body: string) => body.replace('  screen=100\n', '')],
    ['invalid join enum', (body: string) => body.replace('join_style=5', 'join_style=4')],
    ['negative weight', (body: string) => body.replace(' 0=0\n', ' 0=-1\n')],
  ])('rejects malformed %s tables', async (_name, transform) => {
    await expect(readPlotStyleTable(plotStyleProgram(transform(plotStyleText())))).rejects.toThrow();
  });

  it('requires exact dense CTB entries, bounded STB counts and the native Normal entry', async () => {
    await expect(read({ count: 254 })).rejects.toThrow('255');
    await expect(read({ kind: 'stb', count: 4097 })).rejects.toThrow('count');
    await expect(read({ kind: 'stb', entries: { 0: { name: '"Other' } } })).rejects.toThrow('Normal');
    await expect(read({ kind: 'stb', entries: { 1: { name: '"Normal' } } })).rejects.toThrow('duplicate');
  });

  it('refuses remapped or missing ACI names instead of applying another colour slot silently', async () => {
    const body = plotStyleText();
    await expect(readPlotStyleTable(plotStyleProgram(body.replace(' 0="Color_1\n', ' 0="Color_2\n')))).rejects.toThrow('remapped ACI');
    await expect(readPlotStyleTable(plotStyleProgram(body.replace(' 0="Color_1\n', ' 0="Missing\n')))).rejects.toThrow('remapped ACI');
  });
});

describe('per-object plot style subset', () => {
  it('selects ACI 1 and 255 after inheritance resolution and leaves unmodified object styles intact', async () => {
    const table = await read({ entries: { 0: { color: '-16777216', color_policy: '5', lineweight: '2' }, 254: { color: String(0xc20000ff | 0) } } });
    expect(resolvePlotStyle(table, object)).toMatchObject({ rgb: [0, 0, 0], lineweightMm: 0.5, applied: true });
    expect(resolvePlotStyle(table, { ...object, aci: 255 }).rgb).toEqual([0, 0, 1]);
    expect(resolvePlotStyle(table, { ...object, aci: 2 })).toMatchObject({ rgb: [1, 0, 0], lineweightMm: 0.18 });
    expect(object).toEqual({ rgb: [1, 0, 0], aci: 1, lineweightMm: 0.18 });
  });

  it('bypasses CTB for explicit and inherited TrueColor instead of guessing an ACI from RGB', async () => {
    const table = await read({ entries: { 0: { color: '-16777216', lineweight: '2' } } });
    const explicit = { rgb: [1, 0, 0] as const, lineweightMm: 0.35 };
    const inherited = { rgb: [1, 0, 0] as const, lineweightMm: 0.7 };
    expect(resolvePlotStyle(table, explicit)).toMatchObject({ ...explicit, applied: false });
    expect(resolvePlotStyle(table, inherited)).toMatchObject({ ...inherited, applied: false });
    expect(resolvePlotStyle(table, object).rgb).toEqual([0, 0, 0]);
  });

  it('honours mode_color over a legacy approximation, and both native object-colour sentinels', async () => {
    const table = await read({ entries: { 0: { color: '-16777216', mode_color: String(0xc2ff0000 | 0) }, 1: { color: '-1006632961', mode_color: '-1' }, 2: { color: '-1', mode_color: String(0xc2ff0000 | 0) } } });
    expect(resolvePlotStyle(table, object).rgb).toEqual([1, 0, 0]);
    expect(resolvePlotStyle(table, { ...object, aci: 2, rgb: [0, 0, 1] }).rgb).toEqual([0, 0, 1]);
    expect(resolvePlotStyle(table, { ...object, aci: 3, rgb: [0, 1, 0] }).rgb).toEqual([0, 1, 0]);
  });

  it('retains and reports named-colour policy while applying the available native RGB override', async () => {
    const table = await read({ entries: { 0: { color: '-16777216', color_policy: '5' } } });
    expect(table.styles[0]?.colorPolicy).toBe(5);
    expect(resolvePlotStyle(table, object)).toMatchObject({ rgb: [0, 0, 0], issues: [{ path: 'plot_style.0.color_policy' }] });
  });

  it('converts grayscale before screening, includes 0/100 endpoints and respects dithering', async () => {
    const table = await read({ entries: { 0: { color_policy: '3', screen: '50' }, 1: { screen: '0' }, 2: { screen: '0', color_policy: '0' } } });
    expect(resolvePlotStyle(table, object).rgb[0]).toBeCloseTo(0.6495);
    expect(resolvePlotStyle(table, object).rgb[1]).toBeCloseTo(0.6495);
    expect(resolvePlotStyle(table, { ...object, aci: 2 }).rgb).toEqual([1, 1, 1]);
    expect(resolvePlotStyle(table, { ...object, aci: 3 })).toMatchObject({ rgb: [1, 0, 0], issues: [{ path: 'plot_style.2.color_policy' }] });
    expect(resolvePlotStyle(table, { ...object, aci: 4 }).rgb).toEqual([1, 0, 0]);
  });

  it('uses named STB assignments independently of ACI and keeps Normal in colour', async () => {
    const table = await read({ kind: 'stb', entries: { 1: { color: '-16777216', color_policy: '5', lineweight: '1' } } });
    expect(resolvePlotStyle(table, object)).toMatchObject({ rgb: [1, 0, 0], lineweightMm: 0.18, applied: false });
    expect(resolvePlotStyle(table, { ...object, aci: undefined, plotStyleName: 'Style_1' })).toMatchObject({ rgb: [0, 0, 0], lineweightMm: 0.25, applied: true });
    expect(resolvePlotStyle(table, { ...object, plotStyleName: 'Missing' })).toMatchObject({ rgb: object.rgb, applied: false, issues: [{ path: 'object.plotStyleName' }] });
  });

  it('reports authored Normal overrides instead of silently applying an invalid native STB default', async () => {
    const table = await read({ kind: 'stb', entries: { 0: { color: '-16777216', lineweight: '1', future_flag: 'TRUE' } } });
    const result = resolvePlotStyle(table, object);
    expect(result).toMatchObject({ rgb: object.rgb, lineweightMm: 0.18, applied: false });
    expect(result.issues.map((issue) => issue.path)).toEqual(['plot_style.0.future_flag', 'plot_style.0']);
  });

  it('independently honours disabled plot styles and disabled lineweights', async () => {
    const table = await read({ entries: { 0: { color: '-16777216', lineweight: '2' } } });
    expect(resolvePlotStyle(table, object, { usePlotStyles: false })).toMatchObject({ rgb: object.rgb, lineweightMm: 0.18, applied: false });
    expect(resolvePlotStyle(table, object, { plotLineweights: false })).toMatchObject({ rgb: [0, 0, 0], lineweightMm: 0, applied: true });
    expect(resolvePlotStyle(table, object, { usePlotStyles: false, plotLineweights: false }).lineweightMm).toBe(0);
  });

  it('retains nonzero native weight-table slot 0 and reports its ambiguity instead of rejecting the table', async () => {
    const table = await read({ weights: [0.254, 0.05] });
    expect(table.lineweightsMm).toEqual([0.254, 0.05]);
    expect(resolvePlotStyle(table, object)).toMatchObject({ lineweightMm: object.lineweightMm, issues: [{ path: 'custom_lineweight_table.0' }] });
  });

  it('reports unsupported active overrides while retaining original values and inactive entry diagnostics', async () => {
    const table = await read({ entries: { 0: { color: String(0xc1000000 | 0), linetype: '1', physical_pen_number: '2', fill_style: '64', end_style: '1' } }, root: { apply_factor: 'TRUE', scale_factor: '2.0' } });
    const resolved = resolvePlotStyle(table, object);
    expect(resolved.rgb).toEqual(object.rgb);
    expect(resolved.issues.map((issue) => issue.path)).toEqual(['table.scale_factor', 'plot_style.0.physical_pen_number', 'plot_style.0.linetype', 'plot_style.0.fill_style', 'plot_style.0.end_style', 'plot_style.0.color']);
    expect((table.raw.plot_style as Record<string, Record<string, string>>)[0]?.color).toBe(String(0xc1000000 | 0));
    expect(resolvePlotStyle(table, { ...object, aci: 2 }).issues.map((issue) => issue.path)).toEqual(['table.scale_factor']);
  });

  it.each([0, 256, -1, 1.5, NaN])('reports unresolved/invalid ACI %s instead of indexing another style', async (aci) => {
    expect(resolvePlotStyle(await read(), { ...object, aci })).toMatchObject({ applied: false, issues: [{ path: 'object.aci' }] });
  });
});
