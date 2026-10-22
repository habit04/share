/**
 * DXF reading basics: the tokenizer (group pairs, file structure checks, recovery of a file that
 * ends early), objects (the pairs grouped at each 0 code) and the group accessors every reader uses.
 */
import { ImportReportBuilder } from '../import-report';
import type { DxfReadOptions } from './reader';
import { isRealText, isRealCode } from './codes';
import { DXF_READ_LIMITS } from '../../model3d/file-format';
import * as g from '../../core/geometry';

// ---------------------------------------------------------------- reading

export interface Pair {
  code: number;
  value: string;
  /** 1-based line of the group code in the file (reader diagnostics). */
  line?: number;
}

/**
 * A DXF file that cannot be read. `truncated` marks a file that ends early (no EOF, a group
 * code without its value, an open section): `readDxf(text, { recover: true })` then opens what
 * was readable, marking the drawing as recovered.
 */
export class DxfReadError extends Error {
  constructor(
    message: string,
    /** 1-based line where the problem was found. */
    readonly line: number,
    readonly truncated = false,
  ) {
    super(message);
    this.name = 'DxfReadError';
  }
}

export const shortText = (t: string): string => (t.length > 40 ? `${t.slice(0, 40)}...` : t);

/** An optionally signed run of digits (a valid group code line, already trimmed). */
export function isIntegerText(t: string): boolean {
  let i = t.charCodeAt(0) === 43 || t.charCodeAt(0) === 45 ? 1 : 0;
  if (i >= t.length) return false;
  for (; i < t.length; i += 1) {
    const c = t.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return Number.isSafeInteger(Number(t));
}

/** Group pairs a DXF may hold when the caller sets no `maxPairs` (an allocation bound). */
export const DEFAULT_MAX_PAIRS = DXF_READ_LIMITS.maxPairs;
/** Records (0 groups) a DXF may hold when the caller sets no `maxRecords`. */
export const DEFAULT_MAX_RECORDS = DXF_READ_LIMITS.maxRecords;

/**
 * Why DXF text this program wrote would exceed the default read limits (so OPEN would refuse
 * it), or null. Counts lines and 0 groups without allocating; the save flow refuses drawings
 * whose 3D meshes push the file past them (model3d/save-guard.ts).
 */
export function defaultReadLimitExcess(text: string): string | null {
  if (text.length > DXF_READ_LIMITS.maxSourceLength) return `the file has ${text.length.toLocaleString('en-US')} characters; JCad opens at most ${DXF_READ_LIMITS.maxSourceLength.toLocaleString('en-US')}`;
  let lines = 0, records = 0, start = 0;
  for (;;) {
    const end = text.indexOf('\n', start);
    if (end < 0) break;
    if (lines % 2 === 0 && text.charCodeAt(start) === 48 && (end - start === 1 || (end - start === 2 && text.charCodeAt(start + 1) === 13))) records += 1;
    lines += 1;
    start = end + 1;
  }
  const pairs = Math.floor(lines / 2);
  if (pairs > DEFAULT_MAX_PAIRS) return `the file has ${pairs.toLocaleString('en-US')} group pairs; JCad opens at most ${DEFAULT_MAX_PAIRS.toLocaleString('en-US')}`;
  if (records > DEFAULT_MAX_RECORDS) return `the file has ${records.toLocaleString('en-US')} records; JCad opens at most ${DEFAULT_MAX_RECORDS.toLocaleString('en-US')}`;
  return null;
}

/**
 * Split DXF text into group pairs and check the file structure: every group code is an integer,
 * every code has a value, SECTION / ENDSEC pairs balance and the file ends with EOF. A file that
 * ends early throws a `truncated` DxfReadError unless `recover` is set; then the incomplete last
 * object is left out, open sections are closed and `report.recovered` tells what happened.
 */
export function tokenize(text: string, recover = false, report?: ImportReportBuilder, limits: DxfReadOptions = {}): Pair[] {
  if (text.startsWith('AutoCAD Binary DXF')) throw new DxfReadError('This is a binary DXF file. Save it as an ASCII DXF (DXFOUT, ASCII format) to open it.', 1);
  if (text.length > (limits.maxSourceLength ?? DXF_READ_LIMITS.maxSourceLength)) throw new DxfReadError('DXF exceeds the source text size limit.', 1);
  // Check before split(): many tiny lines or one enormous string must not allocate an unbounded array.
  let lineLength = 0, lineCount = 1;
  const maxLines = 2 * (limits.maxPairs ?? DEFAULT_MAX_PAIRS) + 2;
  for (let offset = 0; offset < text.length; offset += 1) {
    const ch = text.charCodeAt(offset);
    if (ch === 10 || ch === 13) {
      if (ch === 13 && text.charCodeAt(offset + 1) === 10) offset += 1;
      lineLength = 0;
      if (++lineCount > maxLines) throw new DxfReadError(`Line ${lineCount}: DXF exceeds the group pair limit.`, lineCount);
    } else if (++lineLength > (limits.maxStringLength ?? 1024 * 1024)) throw new DxfReadError(`Line ${lineCount}: DXF value exceeds the string length limit.`, lineCount);
  }
  const lines = text.split(/\r\n|\r|\n/);
  const pairs: Pair[] = [];
  let eof = false;
  let i = 0;
  /** A group code on the last line of a file that ends early, without its value (0 = a new object was starting). */
  let danglingCode: number | null = null;
  let records = 0;
  let recordKind = '';
  for (; i + 1 < lines.length; i += 2) {
    const rawCode = lines[i]!.trim();
    const code = Number(rawCode);
    if (!isIntegerText(rawCode) || code < 0 || code > 1071) {
      if (rawCode === '' && lines.slice(i).every((l) => l.trim() === '')) break; // trailing blank lines
      throw new DxfReadError(`Line ${i + 1}: "${shortText(rawCode)}" is not a DXF group code (a whole number was expected). The file is damaged or is not a DXF file.`, i + 1);
    }
    // Text chunks (1 / 3, MLEADER 304) keep trailing spaces: a 250-character MTEXT chunk may end in one.
    // trimEnd() strips exactly what /\s+$/ did, in one pass from the end; the regex tried every
    // start position and took quadratic time on a long run of spaces followed by any other
    // character (security review E-6: a crafted line froze the renderer).
    const raw = lines[i + 1]!;
    if (raw.length > (limits.maxStringLength ?? 1024 * 1024)) throw new DxfReadError(`Line ${i + 2}: DXF value exceeds the string length limit.`, i + 2);
    if (pairs.length >= (limits.maxPairs ?? DEFAULT_MAX_PAIRS)) throw new DxfReadError(`Line ${i + 1}: DXF exceeds the group pair limit.`, i + 1);
    if (code === 0 && ++records > (limits.maxRecords ?? DEFAULT_MAX_RECORDS)) throw new DxfReadError(`Line ${i + 1}: DXF exceeds the record limit.`, i + 1);
    // Complex LTYPE9 is literal embedded text; trailing spaces affect its glyph placement.
    // The cell-value text groups (302, its 303 continuations) are text chunks in the same
    // sense: a table cell's formatted text may end in spaces, and trimming it in the
    // retained graph made a re-save of a chain-carrying AC1015 table (P22 F-2 successor)
    // silently lose them while the entity's own group 1 kept them.
    const value = code === 1 || code === 3 || code === 302 || code === 303 || code === 304 || code === 9 && recordKind === 'LTYPE' ? raw : raw.trimEnd();
    if (code === 0) recordKind = value.trim();
    pairs.push({ code, value, line: i + 1 });
    if (code === 0 && value.trim() === 'EOF') {
      eof = true;
      break;
    }
  }
  if (pairs.length === 0) throw new DxfReadError('The file is empty or is not a DXF file.', 1);
  let truncatedAt: number | null = null;
  if (!eof) {
    let last = lines.length;
    while (last > 0 && lines[last - 1]!.trim() === '') last -= 1;
    truncatedAt = Math.max(1, last);
    if (i < lines.length && i === last - 1 && isIntegerText(lines[i]!.trim())) danglingCode = Number(lines[i]!.trim());
    // A last pair "0" + empty value is a new object that never got its type: the same boundary.
    const tail = pairs[pairs.length - 1]!;
    if (tail.code === 0 && tail.value.trim() === '') {
      pairs.pop();
      danglingCode = 0;
    }
  }
  // Section structure.
  let open: { name: string; line: number } | null = null;
  for (let k = 0; k < pairs.length; k += 1) {
    const p = pairs[k]!;
    if (p.code !== 0) continue;
    const v = p.value.trim();
    if (v === 'SECTION') {
      if (open) throw new DxfReadError(`Line ${p.line}: a new SECTION starts before section ${open.name} (line ${open.line}) is closed with ENDSEC. The file is damaged.`, p.line ?? 1);
      open = { name: pairs[k + 1]?.code === 2 ? pairs[k + 1]!.value.trim() : '?', line: p.line ?? 1 };
    } else if (v === 'ENDSEC') {
      if (!open) throw new DxfReadError(`Line ${p.line}: ENDSEC without a matching SECTION. The file is damaged.`, p.line ?? 1);
      open = null;
    } else if (v === 'EOF') {
      if (open) throw new DxfReadError(`Line ${p.line}: section ${open.name} (line ${open.line}) is not closed with ENDSEC before EOF. The file is damaged.`, p.line ?? 1);
    } else if (!open) throw new DxfReadError(`Line ${p.line}: "${shortText(v)}" appears outside any SECTION. The file is damaged or is not a DXF file.`, p.line ?? 1);
  }
  if (truncatedAt === null) return pairs;
  const message = `the file ends early at line ${truncatedAt} (no EOF marker${open ? `; section ${open.name} is not closed` : ''})`;
  if (!recover) throw new DxfReadError(`The file ends early at line ${truncatedAt}: ${open ? `section ${open.name} (line ${open.line}) is not closed and ` : ''}the end-of-file marker is missing. The file is truncated or damaged.`, truncatedAt, true);
  // Partial recovery: leave out the object the file ends in (it may be incomplete). The one
  // cheap certainty: a file that ends with a lone "0" group code (the next object was about to
  // start) was cut exactly at an object boundary, so the last object is complete and is kept.
  let lastZero = pairs.length - 1;
  while (lastZero >= 0 && pairs[lastZero]!.code !== 0) lastZero -= 1;
  if (open && danglingCode !== 0 && lastZero >= 0 && !['ENDSEC', 'EOF'].includes(pairs[lastZero]!.value.trim())) {
    const cut = pairs[lastZero]!;
    const kind = cut.value.trim();
    const groups = pairs.slice(lastZero + 1);
    if (kind !== 'SECTION') {
      report?.add({
        type: kind,
        action: 'dropped',
        reason: 'incomplete: the file ends inside this object',
        line: cut.line,
        ...(groups.find((x) => x.code === 5) ? { handle: groups.find((x) => x.code === 5)!.value.trim() } : {}),
        ...(groups.find((x) => x.code === 8) ? { layer: groups.find((x) => x.code === 8)!.value } : {}),
      });
    }
    pairs.length = lastZero;
    if (kind === 'SECTION') open = null;
  }
  if (open) pairs.push({ code: 0, value: 'ENDSEC', line: truncatedAt });
  pairs.push({ code: 0, value: 'EOF', line: truncatedAt });
  if (report) report.recovered = { line: truncatedAt, message };
  return pairs;
}

export interface Obj {
  kind: string;
  groups: Pair[];
  /** Line of the object's 0 group. */
  line?: number;
}

/** Group pairs into objects starting at each code 0. */
export function objects(pairs: Pair[], start: number, end: number): Obj[] {
  const out: Obj[] = [];
  let cur: Obj | null = null;
  for (let i = start; i < end; i += 1) {
    const p = pairs[i]!;
    if (p.code === 0) {
      cur = { kind: p.value, groups: [], line: p.line };
      out.push(cur);
    } else if (cur) cur.groups.push(p);
  }
  return out;
}

export const invalidPrecision = (name: string, value: string): boolean => !isIntegerText(value.trim()) || Number(value) < (name === 'DIMADEC' ? -1 : 0) || Number(value) > 8;

export const precisionRequirement = (name: string): string => `an integer from ${name === 'DIMADEC' ? -1 : 0} to 8`;

export const num = (o: Obj, code: number, dflt = 0): number => {
  const p = o.groups.find((x) => x.code === code);
  if (!p) return dflt;
  const v = isRealText(p.value) ? Number(p.value) : NaN;
  if (!Number.isNaN(v)) return v;
  // A coordinate that is not a number (NaN, garbage) must not silently become 0: the object is rejected.
  return isRealCode(code) && p.value.trim() !== '' ? NaN : dflt;
};

export const has = (o: Obj, code: number): boolean => o.groups.some((x) => x.code === code);

export const str = (o: Obj, code: number, dflt = ''): string => o.groups.find((x) => x.code === code)?.value ?? dflt;

export const pt = (o: Obj, xCode: number, dflt: g.Point = { x: 0, y: 0 }): g.Point => (has(o, xCode) ? { x: num(o, xCode), y: num(o, xCode + 10) } : dflt);

// ---------------------------------------------------------------- SPLINE / HATCH / LEADER / MLEADER / IMAGE / TABLE readers

export const int = (v: string | undefined, dflt = 0): number => {
  return v !== undefined && isIntegerText(v.trim()) ? Number(v) : dflt;
};

export const flt = (v: string | undefined, dflt = 0): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : dflt;
};

/** Groups after a subclass marker (or all groups when it is missing). */
export function afterSubclass(o: Obj, subclass: string): Pair[] {
  const i = o.groups.findIndex((x) => x.code === 100 && x.value === subclass);
  return i >= 0 ? o.groups.slice(i + 1) : o.groups;
}

/** Points from repeated x/y group pairs (e.g. 10/20). */
export function pointList(gs: readonly Pair[], xCode: number): g.Point[] {
  const out: g.Point[] = [];
  let x: number | null = null;
  for (const p of gs) {
    if (p.code === xCode) x = Number(p.value);
    else if (p.code === xCode + 10 && x !== null) {
      out.push({ x, y: Number(p.value) });
      x = null;
    }
  }
  return out;
}

/** Sequential reader over a group list. */
export class HatchReadError extends Error {}

export class Cursor {
  i = 0;
  constructor(readonly gs: readonly Pair[]) {}
  get code(): number | undefined {
    return this.gs[this.i]?.code;
  }
  take(code: number): string | undefined {
    const p = this.gs[this.i];
    if (p && p.code === code) {
      this.i += 1;
      return p.value;
    }
    return undefined;
  }
  /** Skip ahead to the next group with this code (within `limit` groups). */
  seek(code: number, limit = 12): string | undefined {
    for (let k = this.i; k < Math.min(this.gs.length, this.i + limit); k += 1) {
      if (this.gs[k]!.code === code) {
        this.i = k + 1;
        return this.gs[k]!.value;
      }
    }
    return undefined;
  }
  point(xCode: number): g.Point {
    const x = flt(this.required(this.seek(xCode), xCode));
    const y = flt(this.required(this.seek(xCode + 10, 3), xCode + 10));
    return { x, y };
  }
  required(value: string | undefined, code: number): string {
    if (value === undefined) throw new HatchReadError(`missing group ${code} in declared hatch data`);
    return value;
  }
  /** Declared collections cannot exceed the records still available to describe them. */
  count(value: string | undefined, code: number, groupsPerItem = 1): number {
    if (value === undefined) return 0;
    const pair = this.gs[this.i - 1];
    const location = pair?.line ? ` at value line ${pair.line + 1}` : '';
    if (!isIntegerText(value.trim()) || Number(value) < 0) throw new HatchReadError(`invalid hatch count group ${code}${location}: "${shortText(value)}" must be a nonnegative safe integer`);
    const n = Number(value);
    const available = Math.floor((this.gs.length - this.i) / groupsPerItem);
    if (n > available) throw new HatchReadError(`hatch count group ${code}${location} declares ${n} items, but only ${available} can fit in the remaining group records`);
    return n;
  }
  sourceHandles(value: string | undefined): void {
    const n = this.count(value, 97);
    for (let k = 0; k < n; k += 1) this.required(this.take(330), 330);
  }
}

/** XDATA of one application (1001 name) as its raw pairs. */
export function xdata(o: Obj, app: string): Pair[] | null {
  const i = o.groups.findIndex((x) => x.code === 1001 && x.value === app);
  if (i < 0) return null;
  const out: Pair[] = [];
  for (let k = i + 1; k < o.groups.length && o.groups[k]!.code !== 1001; k += 1) out.push(o.groups[k]!);
  return out;
}
