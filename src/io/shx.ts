/**
 * Bounded, read-only SHX 1.0 programs. Geometry follows Autodesk's SHP special
 * codes; compiled shapes/unifont directory layouts are checked with authored
 * native COMPILE fixtures. Runtime font programs never enter drawing data.
 */
export const MAX_SHX_BYTES = 8 * 1024 * 1024;
export const MAX_SHX_RECORDS = 8192;
export const MAX_SHX_PROGRAM_BYTES = 2000;
export const MAX_SHX_SEGMENTS = 4096;
export const MAX_SHX_INSTRUCTIONS = 65536;
const MAX_TOTAL_PROGRAM_BYTES = 1024 * 1024;
export const MAX_SHX_GLYPH_WORK = 16384;
const MAX_DEPTH = 16;
const MAX_COORDINATE = 1e9;

export type ShxPoint = readonly [number, number];
export type ShxBounds = readonly [number, number, number, number];
export type ShxSegment =
  | { readonly kind: 'line'; readonly from: ShxPoint; readonly to: ShxPoint }
  | { readonly kind: 'arc'; readonly center: ShxPoint; readonly radius: number; readonly startAngle: number; readonly sweep: number };
interface Instruction { readonly op: number; readonly args: readonly number[] }
export interface ShxDefinition {
  readonly code: number;
  readonly name: string;
  readonly program: readonly number[];
  readonly instructions: readonly Instruction[];
  readonly problem: string | null;
}
export interface ShxFont {
  readonly format: 'shapes' | 'unifont';
  readonly version: '1.0';
  readonly byteLength: number;
  readonly instructionCount: number;
  readonly isFont: boolean;
  readonly name: string;
  readonly above: number;
  readonly below: number;
  readonly modes: number;
  /** Unifont 0=Unicode, 1=packed multibyte, 2=shape file. */
  readonly encoding: number | null;
  /** Unifont licensing bits; retained without granting embedding rights. */
  readonly fontType: number | null;
  readonly renderProblem: string | null;
  readonly definitions: Readonly<Record<number, ShxDefinition>>;
}
export type ShxGlyphResult =
  | { readonly ok: true; readonly segments: readonly ShxSegment[]; readonly bounds: ShxBounds | null; readonly advance: ShxPoint; readonly finalScale: number; readonly scaleDrift: boolean; readonly work: number }
  | { readonly ok: false; readonly problem: string };

const fail = (message: string): never => { throw new Error(`Invalid SHX: ${message}`); };
const signed = (byte: number): number => byte > 127 ? byte - 256 : byte;
const point = (x: number, y: number): ShxPoint => Object.freeze([x, y]);
const checkedCoordinate = (value: number): number => {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE) throw new Error('SHX geometry coordinate budget exceeded.');
  return value;
};

function instructions(program: readonly number[], unicode: boolean): { instructions: readonly Instruction[]; problem: string | null } {
  if (!program.length || program.length > MAX_SHX_PROGRAM_BYTES || program.at(-1) !== 0) fail('missing program terminator or oversized program');
  const result: Instruction[] = [];
  let i = 0, terminated = false;
  const take = (): number => { if (i >= program.length) return fail('truncated instruction operand'); return program[i++]!; };
  while (i < program.length) {
    const op = take(), args: number[] = [];
    if (op === 0) { if (i !== program.length) fail('data follows program terminator'); terminated = true; break; }
    if (op === 15) return { instructions: Object.freeze(result), problem: 'Unsupported SHX opcode 15; the original program is retained.' };
    if (op === 3 || op === 4) { args.push(take()); if (!args[0]) fail('zero scale divisor or multiplier'); }
    else if (op === 7) { args.push(take()); if (unicode) args[0] = args[0]! * 256 + take(); if (!args[0]) fail('zero subshape identifier'); }
    else if (op === 8 || op === 10) args.push(take(), take());
    else if (op === 11) args.push(take(), take(), take(), take(), take());
    else if (op === 12) args.push(take(), take(), take());
    else if (op === 9 || op === 13) {
      while (true) {
        const x = take(), y = take(); args.push(x, y);
        if (x === 0 && y === 0) break;
        if (op === 13) args.push(take());
      }
    }
    if (op === 10 && !args[0]) fail('invalid octant arc radius');
    if (op === 12 && args.some((value) => value === 128)) fail('invalid bulge arc operand');
    if (op === 13 && args.some((value) => value === 128)) fail('invalid polyarc operand');
    result.push(Object.freeze({ op, args: Object.freeze(args) }));
  }
  if (!terminated) fail('program terminator was consumed as an operand');
  if (result.at(-1)?.op === 14) fail('conditional instruction has no following instruction');
  return { instructions: Object.freeze(result), problem: null };
}

/** Snapshot and validate a compiled shape/font file; unsupported formats fail explicitly. */
export function parseShx(input: Uint8Array): ShxFont {
  if (!(input instanceof Uint8Array) || !input.length || input.length > MAX_SHX_BYTES) fail('invalid file size');
  const bytes = new Uint8Array(input);
  let signature = '';
  let start = 0;
  while (start < Math.min(bytes.length, 64) && bytes[start] !== 26) signature += String.fromCharCode(bytes[start++]!);
  if (bytes[start] !== 26) fail('missing signature terminator');
  start++;
  const match = /^AutoCAD-86 (shapes|unifont) 1\.0\r\n$/.exec(signature);
  if (!match) throw new Error('Unsupported SHX container; only shapes 1.0 and unifont 1.0 are decoded.');
  const format = match[1] as ShxFont['format'];
  const view = new DataView(bytes.buffer);
  const word = (offset: number): number => { if (offset < 0 || offset + 2 > bytes.length) return fail('truncated directory'); return view.getUint16(offset, true); };
  let offset = start;
  const first = format === 'shapes' ? word(offset) : 0;
  const last = format === 'shapes' ? word(offset + 2) : 65535;
  const count = word(offset + (format === 'shapes' ? 4 : 0));
  offset += format === 'shapes' ? 6 : 2;
  if (!count || count > MAX_SHX_RECORDS || first > last) fail('invalid directory count or range');
  const entries: Array<{ code: number; length: number }> = [];
  if (format === 'shapes') {
    for (let i = 0; i < count; i++) { entries.push({ code: word(offset), length: word(offset + 2) }); offset += 4; }
  }
  const definitions: Record<number, ShxDefinition> = Object.create(null);
  let minimum = 65535, maximum = 0, instructionCount = 0, totalProgramBytes = 0;
  for (let i = 0; i < count; i++) {
    const entry = format === 'shapes' ? entries[i]! : { code: word(offset), length: word(offset + 2) };
    if (format === 'unifont') offset += 4;
    if (Object.hasOwn(definitions, entry.code)) fail('duplicate shape identifier');
    if (entry.code < first || entry.code > last || entry.length < 2 || entry.length > MAX_SHX_PROGRAM_BYTES + 257 || offset + entry.length > bytes.length) fail('invalid shape record extent');
    const end = offset + entry.length;
    let zero = offset;
    while (zero < end && bytes[zero] !== 0) zero++;
    if (zero === end || zero - offset > 256) fail('invalid shape name');
    let name = '';
    for (let j = offset; j < zero; j++) { if (bytes[j]! < 32 || bytes[j] === 127) fail('control character in shape name'); name += String.fromCharCode(bytes[j]!); }
    totalProgramBytes += end - zero - 1;
    if (totalProgramBytes > MAX_TOTAL_PROGRAM_BYTES) fail('total program byte budget exceeded');
    const program = Object.freeze(Array.from(bytes.subarray(zero + 1, end)));
    const decoded = entry.code === 0 ? { instructions: Object.freeze([]), problem: null } : instructions(program, format === 'unifont');
    instructionCount += decoded.instructions.length;
    if (instructionCount > MAX_SHX_INSTRUCTIONS) fail('total instruction budget exceeded');
    definitions[entry.code] = Object.freeze({ code: entry.code, name, program, ...decoded });
    minimum = Math.min(minimum, entry.code); maximum = Math.max(maximum, entry.code);
    offset = end;
  }
  if (format === 'shapes') {
    if (offset + 3 !== bytes.length || bytes[offset] !== 69 || bytes[offset + 1] !== 79 || bytes[offset + 2] !== 70) fail('missing shape EOF marker or trailing file data');
  } else if (offset !== bytes.length) fail('trailing file data');
  if (format === 'shapes' && (minimum !== first || maximum !== last)) fail('directory range does not match records');
  const header = definitions[0];
  if (format === 'unifont' && !header) fail('missing Unicode font header');
  if (header && (header.program.length !== (format === 'unifont' ? 6 : 4) || header.program.at(-1) !== 0)) fail('invalid font header');
  const above = header?.program[0] ?? 0, below = header?.program[1] ?? 0, modes = header?.program[2] ?? 0;
  const encoding = format === 'unifont' ? header!.program[3]! : null;
  const fontType = format === 'unifont' ? header!.program[4]! : null;
  const isFont = !!header && encoding !== 2;
  const renderProblem = header && modes !== 0 && modes !== 2 ? 'Unsupported SHX font orientation mode.'
    : encoding !== null && encoding !== 0 && encoding !== 2 ? 'Packed multibyte SHX encoding is retained but not decoded.'
    : isFont && !above ? 'SHX font has no positive height above its baseline.' : null;
  return Object.freeze({ format, version: '1.0', byteLength: bytes.length, instructionCount, isFont, name: header?.name ?? '', above, below, modes, encoding, fontType, renderProblem, definitions: Object.freeze(definitions) });
}

const directions: readonly ShxPoint[] = [[1, 0], [1, .5], [1, 1], [.5, 1], [0, 1], [-.5, 1], [-1, 1], [-1, .5], [-1, 0], [-1, -.5], [-1, -1], [-.5, -1], [0, -1], [.5, -1], [1, -1], [1, -.5]];
const TAU = Math.PI * 2;
const normalizedAngle = (angle: number): number => ((angle % TAU) + TAU) % TAU;
function arcBounds(segment: Extract<ShxSegment, { kind: 'arc' }>): ShxBounds {
  const { center: [x, y], radius: r, startAngle: start, sweep } = segment;
  const angles = [start, start + sweep];
  for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI / 2, distance = normalizedAngle(sweep < 0 ? start - angle : angle - start);
    if (distance <= Math.abs(sweep) + 1e-12) angles.push(angle);
  }
  const xs = angles.map((angle) => checkedCoordinate(x + r * Math.cos(angle))), ys = angles.map((angle) => checkedCoordinate(y + r * Math.sin(angle)));
  return Object.freeze([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
}

/** Execute one glyph without guessing unsupported geometry or discarding partial programs. */
export function evaluateShxGlyph(font: ShxFont, code: number, options: { vertical?: boolean } = {}): ShxGlyphResult {
  try {
    if (!Number.isInteger(code) || code < 1 || code > 65535 || !Object.hasOwn(font.definitions, code)) throw new Error(`SHX shape ${code} is missing.`);
    if (font.renderProblem) throw new Error(font.renderProblem);
    if (options.vertical && font.modes !== 2) throw new Error('This SHX resource does not support vertical text.');
    let x = 0, y = 0, scale = 1, pen = true, steps = 0;
    const spendWork = (): void => { if (++steps > MAX_SHX_GLYPH_WORK) throw new Error('SHX evaluation work budget exceeded.'); };
    const stack: ShxPoint[] = [], active = new Set<number>(), segments: ShxSegment[] = [];
    let bounds: [number, number, number, number] | null = null;
    const append = (segment: ShxSegment): void => {
      if (segments.length >= MAX_SHX_SEGMENTS) throw new Error('SHX segment budget exceeded.');
      const box = segment.kind === 'line' ? [Math.min(segment.from[0], segment.to[0]), Math.min(segment.from[1], segment.to[1]), Math.max(segment.from[0], segment.to[0]), Math.max(segment.from[1], segment.to[1])] : arcBounds(segment);
      bounds = bounds ? [Math.min(bounds[0], box[0]!), Math.min(bounds[1], box[1]!), Math.max(bounds[2], box[2]!), Math.max(bounds[3], box[3]!)] : [...box] as [number, number, number, number];
      segments.push(Object.freeze(segment));
    };
    const move = (dx: number, dy: number): void => {
      spendWork();
      const nextX = checkedCoordinate(x + dx * scale), nextY = checkedCoordinate(y + dy * scale);
      if (pen && (x !== nextX || y !== nextY)) append({ kind: 'line', from: point(x, y), to: point(nextX, nextY) });
      x = nextX; y = nextY;
    };
    const arc = (radius: number, startAngle: number, sweep: number): void => {
      spendWork();
      const r = checkedCoordinate(radius * scale), center = point(checkedCoordinate(x - r * Math.cos(startAngle)), checkedCoordinate(y - r * Math.sin(startAngle)));
      if (!(r > 0)) throw new Error('Invalid SHX arc radius.');
      if (pen) append({ kind: 'arc', center, radius: r, startAngle, sweep });
      x = checkedCoordinate(center[0] + r * Math.cos(startAngle + sweep)); y = checkedCoordinate(center[1] + r * Math.sin(startAngle + sweep));
    };
    const bulge = (dx: number, dy: number, amount: number): void => {
      spendWork();
      if (!amount) { move(dx, dy); return; }
      const vx = dx * scale, vy = dy * scale, chord = Math.hypot(vx, vy), b = amount / 127;
      if (!chord) throw new Error('SHX bulge arc has no chord.');
      const center = point(checkedCoordinate(x + vx / 2 - vy * (1 - b * b) / (4 * b)), checkedCoordinate(y + vy / 2 + vx * (1 - b * b) / (4 * b)));
      const r = checkedCoordinate(chord * (1 + b * b) / (4 * Math.abs(b)));
      if (pen) append({ kind: 'arc', center, radius: r, startAngle: Math.atan2(y - center[1], x - center[0]), sweep: 4 * Math.atan(b) });
      x = checkedCoordinate(x + vx); y = checkedCoordinate(y + vy);
    };
    const execute = (id: number): void => {
      const definition = font.definitions[id];
      if (!definition) throw new Error(`SHX subshape ${id} is missing.`);
      if (definition.problem) throw new Error(definition.problem);
      if (active.has(id) || active.size >= MAX_DEPTH) throw new Error('SHX subshape cycle or recursion budget exceeded.');
      active.add(id);
      for (let i = 0; i < definition.instructions.length; i++) {
        spendWork();
        const { op, args: a } = definition.instructions[i]!;
        if (op >= 16) { const d = directions[op & 15]!; move(d[0] * (op >>> 4), d[1] * (op >>> 4)); }
        else if (op === 1) pen = true;
        else if (op === 2) pen = false;
        else if (op === 3 || op === 4) { scale = checkedCoordinate(op === 3 ? scale / a[0]! : scale * a[0]!); if (!(scale > 0) || scale < 1e-12) throw new Error('SHX scale budget exceeded.'); }
        else if (op === 5) { if (stack.length === 4) throw new Error('SHX position stack overflow.'); stack.push(point(x, y)); }
        else if (op === 6) { const old = stack.pop(); if (!old) throw new Error('SHX position stack underflow.'); [x, y] = old; }
        else if (op === 7) execute(a[0]!);
        else if (op === 8) move(signed(a[0]!), signed(a[1]!));
        else if (op === 9) { for (let j = 0; j < a.length - 2; j += 2) move(signed(a[j]!), signed(a[j + 1]!)); }
        else if (op === 10) { const value = a[1]!, encoded = value & 127, start = (encoded >>> 4) * Math.PI / 4, sweep = ((encoded & 15) || 8) * Math.PI / 4 * (value & 128 ? -1 : 1); if ((encoded & 15) > 7) throw new Error('Invalid SHX arc octant count.'); arc(a[0]!, start, sweep); }
        else if (op === 11) throw new Error('Fractional SHX arcs are retained pending native interpretation validation.');
        else if (op === 12) bulge(signed(a[0]!), signed(a[1]!), signed(a[2]!));
        else if (op === 13) { for (let j = 0; j < a.length - 2; j += 3) bulge(signed(a[j]!), signed(a[j + 1]!), signed(a[j + 2]!)); }
        else if (op === 14) { if (font.modes !== 2) throw new Error('Conditional SHX commands require a verified dual-orientation font.'); if (!options.vertical) i++; }
      }
      active.delete(id);
    };
    execute(code);
    if (stack.length) throw new Error('SHX position stack was not restored.');
    return Object.freeze({ ok: true, segments: Object.freeze(segments), bounds: bounds ? Object.freeze(bounds) : null, advance: point(x, y), finalScale: scale, scaleDrift: Math.abs(scale - 1) > 1e-12, work: steps });
  } catch (error) { return Object.freeze({ ok: false, problem: error instanceof Error ? error.message : 'Unsupported SHX glyph.' }); }
}

/** Correct SHX character identifiers; no saved TEXT string is rewritten. */
export function shxCharacterCode(font: ShxFont, character: string): number | null {
  const code = character.codePointAt(0);
  if (code === undefined || Array.from(character).length !== 1 || !font.isFont) return null;
  if (font.format === 'unifont') return code <= 65535 ? code : null;
  if (code >= 32 && code <= 126) return code;
  return code === 0xb0 ? 256 : code === 0xb1 ? 257 : code === 0x2300 || code === 0x2205 ? 258 : null;
}

/** TEXT %% codes are resolved before Unicode lookup, without aliasing literal characters. */
export function shxTextCodes(font: ShxFont, text: string): readonly number[] | null {
  const codes: number[] = [];
  for (let i = 0; i < text.length;) {
    if (text.startsWith('%%', i)) {
      const control = text[i + 2]?.toLowerCase();
      if (control === 'c' || control === 'd' || control === 'p') {
        codes.push(font.format === 'unifont' ? (control === 'c' ? 0x2205 : control === 'd' ? 0xb0 : 0xb1) : (control === 'c' ? 258 : control === 'd' ? 256 : 257));
        i += 3; continue;
      }
      if (control === 'u' || control === 'o' || control === 'k') { i += 3; continue; }
      if (control === '%') { codes.push(37); i += 3; continue; }
      const numeric = /^\d{3}/.exec(text.slice(i + 2));
      if (numeric) { const code = Number(numeric[0]); if (!code) return null; codes.push(code); i += 5; continue; }
      return null;
    }
    const character = String.fromCodePoint(text.codePointAt(i)!);
    const code = shxCharacterCode(font, character);
    if (code === null) return null;
    codes.push(code); i += character.length;
  }
  return Object.freeze(codes);
}
