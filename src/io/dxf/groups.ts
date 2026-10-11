/**
 * DXF reading basics: the tokenizer (group pairs, file structure checks, recovery of a file that
 * ends early), objects (the pairs grouped at each 0 code) and the group accessors every reader uses.
 */
import * as g from '../../core/geometry';
import { ImportReportBuilder } from '../import-report';
import { isRealCode } from './codes';

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

const shortText = (t: string): string => (t.length > 40 ? `${t.slice(0, 40)}...` : t);

/** An optionally signed run of digits (a valid group code line, already trimmed). */
function isIntegerText(t: string): boolean {
  let i = t.charCodeAt(0) === 43 || t.charCodeAt(0) === 45 ? 1 : 0;
  if (i >= t.length) return false;
  for (; i < t.length; i += 1) {
    const c = t.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

/**
 * Split DXF text into group pairs and check the file structure: every group code is an integer,
 * every code has a value, SECTION / ENDSEC pairs balance and the file ends with EOF. A file that
 * ends early throws a `truncated` DxfReadError unless `recover` is set; then the incomplete last
 * object is left out, open sections are closed and `report.recovered` tells what happened.
 */
export function tokenize(text: string, recover = false, report?: ImportReportBuilder): Pair[] {
  if (text.startsWith('AutoCAD Binary DXF')) throw new DxfReadError('This is a binary DXF file. Save it as an ASCII DXF (DXFOUT, ASCII format) to open it.', 1);
  const lines = text.split(/\r\n|\r|\n/);
  const pairs: Pair[] = [];
  let eof = false;
  let i = 0;
  /** A group code on the last line of a file that ends early, without its value (0 = a new object was starting). */
  let danglingCode: number | null = null;
  for (; i + 1 < lines.length; i += 2) {
    const rawCode = lines[i]!.trim();
    const code = parseInt(rawCode, 10);
    if (Number.isNaN(code) || !isIntegerText(rawCode)) {
      if (rawCode === '' && lines.slice(i).every((l) => l.trim() === '')) break; // trailing blank lines
      throw new DxfReadError(`Line ${i + 1}: "${shortText(rawCode)}" is not a DXF group code (a whole number was expected). The file is damaged or is not a DXF file.`, i + 1);
    }
    // Text chunks (1 / 3, MLEADER 304) keep trailing spaces: a 250-character MTEXT chunk may end in one.
    const raw = lines[i + 1]!;
    const value = code === 1 || code === 3 || code === 304 ? raw : raw.replace(/\s+$/, '');
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
    if (i < lines.length && i === last - 1 && isIntegerText(lines[i]!.trim())) danglingCode = parseInt(lines[i]!.trim(), 10);
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

export const num = (o: Obj, code: number, dflt = 0): number => {
  const p = o.groups.find((x) => x.code === code);
  if (!p) return dflt;
  const v = parseFloat(p.value);
  if (!Number.isNaN(v)) return v;
  // A coordinate that is not a number (NaN, garbage) must not silently become 0: the object is rejected.
  return isRealCode(code) && p.value.trim() !== '' ? NaN : dflt;
};
export const has = (o: Obj, code: number): boolean => o.groups.some((x) => x.code === code);
export const str = (o: Obj, code: number, dflt = ''): string => o.groups.find((x) => x.code === code)?.value ?? dflt;
export const pt = (o: Obj, xCode: number, dflt: g.Point = { x: 0, y: 0 }): g.Point => (has(o, xCode) ? { x: num(o, xCode), y: num(o, xCode + 10) } : dflt);

export const int = (v: string | undefined, dflt = 0): number => {
  const n = v === undefined ? NaN : parseInt(v, 10);
  return Number.isNaN(n) ? dflt : n;
};
export const flt = (v: string | undefined, dflt = 0): number => {
  const n = v === undefined ? NaN : parseFloat(v);
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
    if (p.code === xCode) x = parseFloat(p.value);
    else if (p.code === xCode + 10 && x !== null) {
      out.push({ x, y: parseFloat(p.value) });
      x = null;
    }
  }
  return out;
}

/** Sequential reader over a group list. */
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
    const x = flt(this.seek(xCode));
    const y = flt(this.seek(xCode + 10, 3));
    return { x, y };
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
