import type { PlotStyleEntry, PlotStyleIssue, PlotStyleRawSection, PlotStyleTable } from '../core/plot-styles';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_STYLES = 4096;
const MAX_LINEWEIGHTS = 1024;
const MAX_LINES = 100000;
const MAX_LINE_LENGTH = 4096;
const MAX_DEPTH = 16;
const HEADER_SUFFIX = 'VER1,compress\r\npmzlibcodec';
const enc = new TextEncoder();

function fail(message: string): never { throw new Error(`Invalid plot style table: ${message}`); }

function adler32(bytes: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Native CTBVER1/STBVER1 have a 60-byte header and a zlib stream, not a zip container. */
async function inflateBounded(bytes: Uint8Array<ArrayBuffer>, length: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') fail('native deflate decompression is unavailable');
  const stream = new DecompressionStream('deflate');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  // Observe both write promises even when decompression or the bounded read fails.
  // Small input writes also bound a platform transform's synchronous expansion before the
  // reader can cancel a dishonest stream; do not hand an entire compressed bomb to one write.
  const writing = (async () => {
    for (let at = 0; at < bytes.length; at += 1024) await writer.write(bytes.subarray(at, at + 1024));
    await writer.close();
  })();
  void writing.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > length || total > MAX_BODY_BYTES) fail('expanded body exceeds its declared length or size limit');
      chunks.push(value);
    }
    await writing;
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    void writer.abort(error).catch(() => undefined);
    throw error;
  }
  if (total !== length) fail('expanded body length does not match the header');
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

type RawSection = { [key: string]: string | RawSection };
function rawBody(text: string): PlotStyleRawSection {
  if (text.endsWith('\0')) text = text.slice(0, -1);
  if (text.includes('\0') || /[^\t\n\r\x20-\uFFFF]|[\x7F-\x9F]/.test(text)) fail('body contains control characters');
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_LINES) fail('body has too many lines');
  const root: RawSection = Object.create(null) as RawSection;
  const stack: RawSection[] = [root];
  for (let at = 0; at < lines.length; at++) {
    const original = lines[at]!;
    if (original.length > MAX_LINE_LENGTH) fail(`line ${at + 1} is too long`);
    const line = original.trimStart();
    if (!line.trim()) continue;
    if (line.trimEnd() === '}') {
      if (stack.length === 1) fail(`unexpected closing section at line ${at + 1}`);
      Object.freeze(stack.pop()!);
      continue;
    }
    const equals = line.indexOf('=');
    const section = equals < 0 && line.trimEnd().endsWith('{');
    const key = (section ? line.trimEnd().slice(0, -1) : equals >= 0 ? line.slice(0, equals) : '').trim();
    if (!/^[A-Za-z_][A-Za-z_0-9]*$|^(?:0|[1-9][0-9]*)$/.test(key) || key.length > 128) fail(`invalid key at line ${at + 1}`);
    const parent = stack[stack.length - 1]!;
    if (Object.hasOwn(parent, key)) fail(`duplicate key ${key}`);
    if (section) {
      if (stack.length >= MAX_DEPTH) fail('sections are nested too deeply');
      const child = Object.create(null) as RawSection;
      parent[key] = child;
      stack.push(child);
    } else {
      parent[key] = line.slice(equals + 1);
    }
  }
  if (stack.length !== 1) fail('unclosed section');
  return Object.freeze(root);
}

function scalar(raw: PlotStyleRawSection, key: string, path: string): string {
  const value = raw[key];
  if (typeof value !== 'string') fail(`missing scalar ${path}.${key}`);
  return value;
}
function section(raw: PlotStyleRawSection, key: string, path: string): PlotStyleRawSection {
  const value = raw[key];
  if (typeof value !== 'object' || value === null) fail(`missing section ${path}.${key}`);
  return value;
}
function stringValue(raw: PlotStyleRawSection, key: string, path: string, max: number): string {
  const value = scalar(raw, key, path);
  if (!value.startsWith('"')) fail(`expected string ${path}.${key}`);
  const result = value.slice(1);
  if (result.length > max) fail(`string ${path}.${key} exceeds its limit`);
  return result;
}
function numeric(raw: PlotStyleRawSection, key: string, path: string, min: number, max: number, integer = false, issues?: PlotStyleIssue[]): number {
  const value = scalar(raw, key, path).trim();
  // Some native writers append opaque numeric metadata; retain it in raw and report it.
  const match = /^([+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)(?:\s+(\([^\r\n]*\)))?$/.exec(value);
  const number = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(number) || number < min || number > max || integer && !Number.isInteger(number)) fail(`invalid number ${path}.${key}`);
  if (match?.[2]) issues?.push({ path: `${path}.${key}`, message: 'Numeric annotation is retained but is not interpreted.' });
  return number;
}
function booleanValue(raw: PlotStyleRawSection, key: string, path: string): boolean {
  const value = scalar(raw, key, path).trim();
  if (value !== 'TRUE' && value !== 'FALSE') fail(`invalid boolean ${path}.${key}`);
  return value === 'TRUE';
}
function denseSections(raw: PlotStyleRawSection, max: number, path: string): readonly PlotStyleRawSection[] {
  const keys = Object.keys(raw);
  if (!keys.length || keys.length > max) fail(`invalid entry count in ${path}`);
  return keys.map((_, index) => section(raw, String(index), path));
}
function unknownFields(raw: PlotStyleRawSection, known: readonly string[], path: string, issues: PlotStyleIssue[]): void {
  for (const key of Object.keys(raw)) if (!known.includes(key)) issues.push({ path: `${path}.${key}`, message: 'Unknown plot style property is retained but is not interpreted.' });
}
const ROOT_FIELDS = ['description', 'aci_table_available', 'scale_factor', 'apply_factor', 'custom_lineweight_display_units', 'aci_table', 'plot_style', 'custom_lineweight_table'];
const STYLE_FIELDS = ['name', 'localized_name', 'description', 'color', 'mode_color', 'color_policy', 'physical_pen_number', 'virtual_pen_number', 'screen', 'linepattern_size', 'linetype', 'adaptive_linetype', 'lineweight', 'fill_style', 'end_style', 'join_style'];

function model(raw: PlotStyleRawSection, kind: 'ctb' | 'stb'): PlotStyleTable {
  const issues: PlotStyleIssue[] = [];
  unknownFields(raw, ROOT_FIELDS, 'table', issues);
  if (booleanValue(raw, 'aci_table_available', 'table') !== (kind === 'ctb')) fail('header kind and ACI availability disagree');
  const description = stringValue(raw, 'description', 'table', 4096);
  const scaleFactor = numeric(raw, 'scale_factor', 'table', 0.000001, 1000000, false, issues);
  const applyFactor = booleanValue(raw, 'apply_factor', 'table');
  const lineweightDisplayUnits = numeric(raw, 'custom_lineweight_display_units', 'table', 0, 1, true) as 0 | 1;
  if (applyFactor && scaleFactor !== 1) issues.push({ path: 'table.scale_factor', message: 'Linetype/fill scale factor is retained but is not applied.' });
  const weights = section(raw, 'custom_lineweight_table', 'table');
  const count = Object.keys(weights).length;
  if (!count || count > MAX_LINEWEIGHTS) fail('invalid lineweight table count');
  const lineweightsMm = Object.freeze(Array.from({ length: count }, (_, index) => numeric(weights, String(index), 'custom_lineweight_table', 0, 100, false, issues)));
  if (lineweightsMm[0] !== 0) issues.push({ path: 'custom_lineweight_table.0', message: 'Nonzero reserved lineweight-table entry is retained; style index 0 still uses object lineweight.' });
  const sourceStyles = denseSections(section(raw, 'plot_style', 'table'), kind === 'ctb' ? 255 : MAX_STYLES, 'plot_style');
  if (kind === 'ctb' && sourceStyles.length !== 255) fail('CTB must have 255 dense ACI entries');
  let aciNames: readonly string[] | undefined;
  if (kind === 'ctb') {
    const aci = section(raw, 'aci_table', 'table');
    if (Object.keys(aci).length !== 255) fail('CTB ACI table must have 255 entries');
    aciNames = Array.from({ length: 255 }, (_, index) => stringValue(aci, String(index), 'aci_table', 255));
  } else if (raw.aci_table !== undefined) issues.push({ path: 'table.aci_table', message: 'STB ACI mapping is retained but is not used for named styles.' });
  const names = new Set<string>();
  const styles = Object.freeze(sourceStyles.map((source, index): PlotStyleEntry => {
    const path = `plot_style.${index}`, entryIssues: PlotStyleIssue[] = [];
    unknownFields(source, STYLE_FIELDS, path, entryIssues);
    const num = (key: string, min: number, max: number, integer = true) => numeric(source, key, path, min, max, integer, entryIssues);
    const name = stringValue(source, 'name', path, 255);
    if (!name || names.has(name)) fail(`empty or duplicate style name ${path}`);
    names.add(name);
    const entry = {
      index, name,
      localizedName: stringValue(source, 'localized_name', path, 255),
      description: stringValue(source, 'description', path, 4096),
      color: num('color', -2147483648, 4294967295),
      ...(source.mode_color !== undefined ? { modeColor: num('mode_color', -2147483648, 4294967295) } : {}),
      colorPolicy: num('color_policy', 0, 7),
      physicalPenNumber: num('physical_pen_number', 0, 32),
      virtualPenNumber: num('virtual_pen_number', 0, 255),
      screening: num('screen', 0, 100),
      linepatternSize: num('linepattern_size', 0.000001, 1000000, false),
      linetype: num('linetype', 0, 31),
      adaptiveLinetype: booleanValue(source, 'adaptive_linetype', path),
      lineweightIndex: num('lineweight', 0, lineweightsMm.length - 1),
      fillStyle: num('fill_style', 64, 73),
      endStyle: num('end_style', 0, 4),
      joinStyle: num('join_style', 0, 5),
    };
    if (entry.joinStyle === 4) fail(`invalid join style ${path}.join_style`);
    for (const [key, overridden] of [
      ['physical_pen_number', entry.physicalPenNumber !== 0], ['virtual_pen_number', entry.virtualPenNumber !== 0],
      ['linetype', entry.linetype !== 31], ['fill_style', entry.fillStyle !== 73],
      ['end_style', entry.endStyle !== 4], ['join_style', entry.joinStyle !== 5],
      ['adaptive_linetype', !entry.adaptiveLinetype], ['linepattern_size', entry.linepatternSize !== 0.5],
    ] as const) if (overridden) entryIssues.push({ path: `${path}.${key}`, message: 'Plot style override is retained but is not applied by the supported colour/lineweight subset.' });
    if (!(entry.colorPolicy & 1)) entryIssues.push({ path: `${path}.color_policy`, message: 'Device palette quantisation with dithering disabled is not simulated; screening remains disabled.' });
    if (entry.colorPolicy & 4) entryIssues.push({ path: `${path}.color_policy`, message: 'Named colour policy is retained; colour-book/device-specific treatment is not implemented.' });
    if (kind === 'stb' && index === 0 && (
      ![-1, -1006632961, 0xffffffff, 0xc3ffffff].includes(entry.color) || entry.colorPolicy !== 1 ||
      entry.screening !== 100 || entry.lineweightIndex !== 0
    )) entryIssues.push({ path, message: 'Native STB Normal cannot override object properties; authored override values are retained but are not applied.' });
    return Object.freeze({ ...entry, issues: Object.freeze(entryIssues.map((issue) => Object.freeze(issue))) });
  }));
  if (aciNames?.some((name, index) => name !== styles[index]!.name)) fail('remapped ACI table entries are not supported');
  if (kind === 'stb' && styles[0]?.name !== 'Normal') fail('STB first style must be Normal');
  return Object.freeze({ kind, description, styles, lineweightsMm, scaleFactor, applyFactor, lineweightDisplayUnits, raw, issues: Object.freeze(issues.map((issue) => Object.freeze(issue))) });
}

/** Read a captured source program. No filesystem access or plot/drawing mutation occurs here. */
export async function readPlotStyleTable(source: Uint8Array): Promise<PlotStyleTable> {
  if (!(source instanceof Uint8Array) || source.byteLength < 62 || source.byteLength > MAX_FILE_BYTES) fail('file size is outside the supported bounds');
  // Snapshot the complete input before the first asynchronous operation.
  const bytes = new Uint8Array(source);
  const kind = bytes[19] === 67 ? 'ctb' : bytes[19] === 83 ? 'stb' : fail('unsupported header');
  const expected = enc.encode(`PIAFILEVERSION_2.0,${kind === 'ctb' ? 'CTB' : 'STB'}${HEADER_SUFFIX}`);
  if (expected.length !== 48 || expected.some((value, at) => bytes[at] !== value)) fail('unsupported header');
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const checksum = header.getUint32(48, true), bodyLength = header.getUint32(52, true), compressedLength = header.getUint32(56, true);
  if (!bodyLength || bodyLength > MAX_BODY_BYTES || compressedLength !== bytes.length - 60) fail('invalid declared body lengths');
  const compressed = bytes.subarray(60);
  if (adler32(compressed) !== checksum) fail('compressed body checksum mismatch');
  const body = await inflateBounded(compressed, bodyLength);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); }
  catch { fail('body is not supported UTF-8 text'); }
  return model(rawBody(text), kind);
}
