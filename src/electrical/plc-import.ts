/**
 * PLC I/O spreadsheet import / export (AutoCAD Electrical's "PLC I/O
 * Utility" in its simplest form): a CSV or TSV table with one row per I/O
 * point — Address, Description 1-3, Wire number, Device tag and optionally
 * Module and I/O type — becomes PLC modules (tools/plc.ts) with the point
 * descriptions filled in. Header names are detected loosely; quoted cells
 * (with "" escapes and line breaks) are supported.
 */
import type { PlcModuleSettings, PlcPoint } from '../tools/plc';

export interface PlcIoRow {
  address: string;
  kind: 'input' | 'output';
  module: string;
  desc1: string;
  desc2: string;
  desc3: string;
  wire: string;
  device: string;
  /** 1-based source line of the row. */
  line: number;
}

export type PlcField = 'address' | 'desc1' | 'desc2' | 'desc3' | 'wire' | 'device' | 'module' | 'kind';

/** Split delimited text into rows of cells. The delimiter is detected from the first line (tab, semicolon or comma). */
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const count = (ch: string) => firstLine.split(ch).length - 1;
  const delim = delimiter ?? (count('\t') > 0 ? '\t' : count(';') > count(',') ? ';' : ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (c === delim) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim()));
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Header patterns per field (normalised header text: lower case, letters and digits only). */
const HEADERS: Array<[PlcField, RegExp]> = [
  ['address', /^(address|addr|ioaddress|ioaddr|plcaddress|point|tagaddress)$/],
  ['desc1', /^(description1?|desc1?|iodescription|text1?|comment1?|line1)$/],
  ['desc2', /^(description2|desc2|text2|comment2|line2)$/],
  ['desc3', /^(description3|desc3|text3|comment3|line3)$/],
  ['wire', /^(wire|wireno|wirenumber|wirenum|wire#|wiretag)$/],
  ['device', /^(device|devicetag|tag|component|componenttag|tag1|devtag)$/],
  ['module', /^(module|moduletag|rack|card|slot|plc)$/],
  ['kind', /^(type|iotype|kind|direction|inout|io)$/],
];

/** Column index per field from a header row, or null when there is no Address column. */
export function detectColumns(header: readonly string[]): Partial<Record<PlcField, number>> | null {
  const out: Partial<Record<PlcField, number>> = {};
  header.forEach((h, i) => {
    const n = norm(h);
    for (const [field, re] of HEADERS) {
      if (out[field] !== undefined) continue;
      if (re.test(n)) {
        out[field] = i;
        break;
      }
    }
  });
  return out.address === undefined ? null : out;
}

/** Input or output from an explicit type cell or the address (I:, %I, X, IN / O:, %Q, Q, Y, OUT). */
export function kindOf(address: string, type = ''): 'input' | 'output' {
  const t = type.trim().toUpperCase();
  if (/^(I|IN|INPUT|DI|AI)/.test(t)) return 'input';
  if (/^(O|OUT|OUTPUT|DO|AO|Q)/.test(t)) return 'output';
  const a = address.trim().toUpperCase();
  if (/^(%?Q|O:|O\d|Y|OUT|DO|AO|%?QW)/.test(a)) return 'output';
  return 'input';
}

export interface PlcImport {
  rows: PlcIoRow[];
  columns: Partial<Record<PlcField, number>>;
  warnings: string[];
}

/** Parse a PLC I/O table. Without a recognisable header the columns are taken in the documented order. */
export function parsePlcIo(text: string): PlcImport {
  const table = parseDelimited(text).filter((r) => r.some((c) => c !== ''));
  const warnings: string[] = [];
  if (table.length === 0) return { rows: [], columns: {}, warnings: ['The file is empty.'] };
  let columns = detectColumns(table[0]!);
  let start = 1;
  if (!columns) {
    columns = { address: 0, desc1: 1, desc2: 2, desc3: 3, wire: 4, device: 5 };
    start = 0;
    warnings.push('No header row found: columns read as Address, Description 1-3, Wire number, Device tag.');
  }
  const cell = (r: string[], f: PlcField) => (columns![f] === undefined ? '' : (r[columns![f]!] ?? ''));
  const rows: PlcIoRow[] = [];
  const seen = new Set<string>();
  for (let i = start; i < table.length; i += 1) {
    const r = table[i]!;
    const address = cell(r, 'address');
    if (!address) {
      warnings.push(`Line ${i + 1}: no address, skipped.`);
      continue;
    }
    if (seen.has(address.toUpperCase())) warnings.push(`Line ${i + 1}: address ${address} appears twice.`);
    seen.add(address.toUpperCase());
    rows.push({
      address,
      kind: kindOf(address, cell(r, 'kind')),
      module: cell(r, 'module'),
      desc1: cell(r, 'desc1'),
      desc2: cell(r, 'desc2'),
      desc3: cell(r, 'desc3'),
      wire: cell(r, 'wire'),
      device: cell(r, 'device'),
      line: i + 1,
    });
  }
  return { rows, columns, warnings };
}

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The table as CSV with the standard header (Module, Address, I/O, Description 1-3, Wire number, Device tag). */
export function plcRowsToCsv(rows: readonly PlcIoRow[]): string {
  const head = ['Module', 'Address', 'I/O', 'Description 1', 'Description 2', 'Description 3', 'Wire number', 'Device tag'];
  const body = rows.map((r) => [r.module, r.address, r.kind === 'output' ? 'Output' : 'Input', r.desc1, r.desc2, r.desc3, r.wire, r.device].map(csvCell).join(','));
  return [head.join(','), ...body].join('\r\n') + '\r\n';
}

/** Address prefix used to group points into modules when there is no Module column: "I:0/3" -> "I:0/", "%IX1.7" -> "%IX1.". */
export function addressGroup(address: string): string {
  const m = /^(.*?)(\d+)$/.exec(address.trim());
  return m ? m[1]! : address.trim();
}

export interface PlcModuleOptions {
  /** Maximum points per module (a longer group is split). */
  pointsPerModule: number;
  spacing: number;
  /** Tag of the first module; the trailing number increments (PLC1, PLC2 ...). */
  firstTag: string;
  rungs: boolean;
}

export const DEFAULT_PLC_IMPORT: PlcModuleOptions = { pointsPerModule: 16, spacing: 0.5, firstTag: 'PLC1', rungs: false };

function tagSeq(first: string): () => string {
  const m = /^(.*?)(\d+)$/.exec(first);
  let n = m ? parseInt(m[2]!, 10) : 1;
  const prefix = m ? m[1]! : first;
  let firstUsed = false;
  return () => {
    if (!firstUsed) {
      firstUsed = true;
      return m ? first : `${first}${n}`;
    }
    n += 1;
    return `${prefix}${n}`;
  };
}

/**
 * Module settings for the imported points: grouped by the Module column
 * (else by address prefix and I/O kind), split at `pointsPerModule`, in
 * file order. Each module carries its points in `io`.
 */
export function modulesFromRows(rows: readonly PlcIoRow[], o: PlcModuleOptions = DEFAULT_PLC_IMPORT): PlcModuleSettings[] {
  const groups = new Map<string, PlcIoRow[]>();
  for (const r of rows) {
    const key = `${r.module || addressGroup(r.address)}\u0001${r.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const next = tagSeq(o.firstTag || 'PLC1');
  const out: PlcModuleSettings[] = [];
  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i += Math.max(1, o.pointsPerModule)) {
      const chunk = list.slice(i, i + Math.max(1, o.pointsPerModule));
      const first = chunk[0]!;
      const io: PlcPoint[] = chunk.map((r) => ({ address: r.address, desc: [r.desc1, r.desc2, r.desc3], wire: r.wire || undefined, device: r.device || undefined }));
      out.push({
        tag: first.module && i === 0 && !out.some((m) => m.tag === first.module) ? first.module : next(),
        kind: first.kind,
        points: io.length,
        addressPrefix: addressGroup(first.address),
        firstAddress: 0,
        spacing: o.spacing,
        description: first.kind === 'output' ? 'DIGITAL OUTPUT MODULE' : 'DIGITAL INPUT MODULE',
        io,
        rungs: o.rungs,
      });
    }
  }
  return out;
}

/** Rows back from report rows of the PLC I/O report (Module, Address, I/O, Wire No., Device, Description, Rung). */
export function rowsFromPlcReport(rows: readonly string[][]): PlcIoRow[] {
  return rows.map((r, i) => ({ module: r[0] ?? '', address: r[1] ?? '', kind: r[2] === 'Output' ? 'output' : 'input', wire: r[3] ?? '', device: (r[4] ?? '').split(',')[0]!.trim(), desc1: r[5] ?? '', desc2: '', desc3: '', line: i + 1 }));
}
