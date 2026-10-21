#!/usr/bin/env node
/**
 * generate-unicode-tables.mjs — build src/core/unicode-tables.ts from
 * the vendored UCD 15.1.0 inputs in scripts/ucd-15.1.0/ (see RECEIPT.md
 * there and ENGINE-STEP2B-DESIGN.md §5 for the route and rationale).
 *
 * Plain node, no dependencies. Regeneration is a deliberate,
 * diff-reviewed act — this script is never run as part of a build.
 *
 * Method: for each property, expand the source file (explicit data
 * lines on top of its @missing defaults, in file order) to full
 * U+0000..U+10FFFF coverage, then run-length encode the coverage into
 * parallel starts[]/values[] arrays with the range end implied by the
 * next start and a sentinel start at 0x110000.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const UCD_DIR = join(HERE, 'ucd-15.1.0');
const OUT_PATH = join(HERE, '..', 'src', 'core', 'unicode-tables.ts');

const GENERATOR_VERSION = 'generate-unicode-tables 1.0.0';
const UNICODE_VERSION = '15.1.0';
const PIPELINE_DATA_VERSION = 'jcad-pipeline-1/ucd-15.1.0';
const MAX_CP = 0x10ffff;
const SENTINEL = 0x110000;

const read = (rel) => readFileSync(join(UCD_DIR, rel), 'utf8');
const fail = (msg) => {
  throw new Error(`generate-unicode-tables: ${msg}`);
};

/** Parse "RANGE ; field ; field ..." data lines (comments stripped). */
function dataLines(text, sourceName) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const fields = line.split(';').map((f) => f.trim());
    const m = /^([0-9A-Fa-f]+)(?:\.\.([0-9A-Fa-f]+))?$/.exec(fields[0]);
    if (!m) fail(`${sourceName}: cannot parse range in line: ${raw.trim()}`);
    const start = parseInt(m[1], 16);
    const end = m[2] ? parseInt(m[2], 16) : start;
    out.push({ start, end, fields: fields.slice(1) });
  }
  return out;
}

/** Parse "# @missing: START..END; <rest>" directives, in file order. */
function missingLines(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const m = /^#\s*@missing:\s*([0-9A-Fa-f]+)\.\.([0-9A-Fa-f]+);\s*(.+)$/.exec(raw.trim());
    if (m) out.push({ start: parseInt(m[1], 16), end: parseInt(m[2], 16), rest: m[3].trim() });
  }
  return out;
}

/** Apply a {start,end,value} assignment list to a coverage array. */
function apply(coverage, { start, end }, value) {
  for (let cp = start; cp <= end; cp++) coverage[cp] = value;
}

/** Run-length encode a full-coverage id array. */
function rle(coverage) {
  const starts = [0];
  const values = [coverage[0]];
  for (let cp = 1; cp <= MAX_CP; cp++) {
    if (coverage[cp] !== coverage[cp - 1]) {
      starts.push(cp);
      values.push(coverage[cp]);
    }
  }
  starts.push(SENTINEL);
  values.push(0); // sentinel value: never read (lookup clamps below it)
  return { starts, values };
}

/** Format a number array as wrapped TS literal lines. */
function fmtArray(name, nums, base, indent = '  ') {
  const parts = nums.map((n) => (base === 16 ? '0x' + n.toString(16) : String(n)));
  const rows = [];
  let row = [];
  let rowLen = indent.length;
  for (const p of parts) {
    const extra = (row.length ? 2 : 0) + p.length;
    if (row.length && rowLen + extra > 118) {
      rows.push(row);
      row = [];
      rowLen = indent.length;
    }
    row.push(p);
    rowLen += (row.length > 1 ? 2 : 0) + p.length;
  }
  if (row.length) rows.push(row);
  const body = rows.map((r) => indent + r.join(', ')).join(',\n');
  return `const ${name}: readonly number[] = [\n${body},\n];`;
}

/* ------------------------------------------------------------------ */
/* PropertyValueAliases: script long-name -> ISO 15924 code            */
/* ------------------------------------------------------------------ */

const pvaText = read('PropertyValueAliases.txt');
const scriptNameToCode = new Map();
const pvaScriptCodes = new Set();
for (const raw of pvaText.split('\n')) {
  const line = raw.split('#')[0].trim();
  if (!line.startsWith('sc')) continue;
  const fields = line.split(';').map((f) => f.trim());
  if (fields[0] !== 'sc' || fields.length < 3) continue;
  scriptNameToCode.set(fields[2], fields[1]);
  pvaScriptCodes.add(fields[1]);
}
if (scriptNameToCode.size === 0) fail('PropertyValueAliases: no sc entries parsed');

/* ------------------------------------------------------------------ */
/* Bidi_Class (extracted/DerivedBidiClass.txt)                        */
/* ------------------------------------------------------------------ */

const BIDI_CLASS_NAMES = [
  'L', 'R', 'AL', 'EN', 'ES', 'ET', 'AN', 'CS', 'B', 'S', 'WS', 'ON',
  'LRE', 'LRO', 'RLE', 'RLO', 'PDF', 'NSM', 'BN', 'LRI', 'RLI', 'FSI', 'PDI',
];
const BIDI_LONG_TO_SHORT = {
  Left_To_Right: 'L', Right_To_Left: 'R', Arabic_Letter: 'AL',
  European_Number: 'EN', European_Separator: 'ES', European_Terminator: 'ET',
  Arabic_Number: 'AN', Common_Separator: 'CS', Paragraph_Separator: 'B',
  Segment_Separator: 'S', White_Space: 'WS', Other_Neutral: 'ON',
  Left_To_Right_Embedding: 'LRE', Left_To_Right_Override: 'LRO',
  Right_To_Left_Embedding: 'RLE', Right_To_Left_Override: 'RLO',
  Pop_Directional_Format: 'PDF', Nonspacing_Mark: 'NSM',
  Boundary_Neutral: 'BN', Left_To_Right_Isolate: 'LRI',
  Right_To_Left_Isolate: 'RLI', First_Strong_Isolate: 'FSI',
  Pop_Directional_Isolate: 'PDI',
};
const bidiId = (short) => {
  const id = BIDI_CLASS_NAMES.indexOf(short);
  if (id < 0) fail(`Bidi_Class: unknown value ${short}`);
  return id;
};
const bidiText = read('extracted/DerivedBidiClass.txt');
const bidiCoverage = new Uint16Array(SENTINEL);
for (const miss of missingLines(bidiText)) {
  const short = BIDI_LONG_TO_SHORT[miss.rest];
  if (short === undefined) fail(`Bidi_Class @missing: unknown value ${miss.rest}`);
  apply(bidiCoverage, miss, bidiId(short));
}
const bidiData = dataLines(bidiText, 'DerivedBidiClass.txt');
for (const line of bidiData) {
  // Data lines carry the short code directly (the @missing comments
  // above use the long names).
  if (!BIDI_CLASS_NAMES.includes(line.fields[0])) fail(`Bidi_Class: unknown value ${line.fields[0]}`);
  apply(bidiCoverage, line, bidiId(line.fields[0]));
}
const bidiRle = rle(bidiCoverage);

/* ------------------------------------------------------------------ */
/* Script (Scripts.txt) + Script_Extensions (ScriptExtensions.txt)    */
/* ------------------------------------------------------------------ */

const scriptsText = read('Scripts.txt');
const scxText = read('ScriptExtensions.txt');
const scriptsData = dataLines(scriptsText, 'Scripts.txt');
const scxData = dataLines(scxText, 'ScriptExtensions.txt');

const scriptCodeOfName = (name) => {
  const code = scriptNameToCode.get(name);
  if (code === undefined) fail(`Scripts: no ISO code in PropertyValueAliases for "${name}"`);
  return code;
};
// Collect the full code set first so ids are stable (sorted order).
const scriptCodes = new Set(['Zzzz', 'Zyyy', 'Zinh']);
for (const line of scriptsData) scriptCodes.add(scriptCodeOfName(line.fields[0]));
for (const line of scxData) {
  for (const code of line.fields[0].split(/\s+/)) {
    if (!pvaScriptCodes.has(code)) fail(`ScriptExtensions: unknown code ${code}`);
    scriptCodes.add(code);
  }
}
const SCRIPT_NAMES = [...scriptCodes].sort();
const scriptId = (code) => SCRIPT_NAMES.indexOf(code);

const scriptCoverage = new Uint16Array(SENTINEL).fill(scriptId('Zzzz'));
for (const miss of missingLines(scriptsText)) {
  // Scripts.txt declares only the global @missing (= Unknown).
  apply(scriptCoverage, miss, scriptId(scriptCodeOfName(miss.rest)));
}
for (const line of scriptsData) apply(scriptCoverage, line, scriptId(scriptCodeOfName(line.fields[0])));

// Script_Extensions: per code point, the listed set; an entry becomes
// an override only when the set differs from { script(cp) }.
const scxSetIds = new Map(); // serialized sorted id list -> set index (1-based in output)
const scxSets = []; // array of sorted id arrays
const scxCoverage = new Int32Array(SENTINEL); // 0 = no override
for (const line of scxData) {
  const ids = [...new Set(line.fields[0].split(/\s+/).map(scriptId))].sort((a, b) => a - b);
  const key = ids.join(',');
  let setIndex = scxSetIds.get(key);
  if (setIndex === undefined) {
    scxSets.push(ids);
    setIndex = scxSets.length; // 1-based; 0 means "no override"
    scxSetIds.set(key, setIndex);
  }
  for (let cp = line.start; cp <= line.end; cp++) {
    const only = scriptCoverage[cp];
    if (ids.length === 1 && ids[0] === only) continue; // scx == {sc}: not an override
    scxCoverage[cp] = setIndex;
  }
}
const scriptRle = rle(scriptCoverage);
const scxRle = rle(scxCoverage);

/* ------------------------------------------------------------------ */
/* Grapheme_Cluster_Break (auxiliary/GraphemeBreakProperty.txt)      */
/* ------------------------------------------------------------------ */

const GCB_NAMES = ['CN', 'OT', 'CR', 'LF', 'EX', 'ZWJ', 'RI', 'PP', 'SM', 'L', 'V', 'T', 'LV', 'LVT'];
const GCB_VALUE_TO_ID = {
  Other: 'OT', Control: 'CN', CR: 'CR', LF: 'LF', Extend: 'EX', ZWJ: 'ZWJ',
  Regional_Indicator: 'RI', Prepend: 'PP', SpacingMark: 'SM',
  L: 'L', V: 'V', T: 'T', LV: 'LV', LVT: 'LVT',
};
const gcbText = read('auxiliary/GraphemeBreakProperty.txt');
const gcbCoverage = new Uint16Array(SENTINEL);
const gcbId = (v) => {
  const short = GCB_VALUE_TO_ID[v];
  if (short === undefined) fail(`GraphemeBreakProperty: unknown value ${v}`);
  return GCB_NAMES.indexOf(short);
};
for (const miss of missingLines(gcbText)) apply(gcbCoverage, miss, gcbId(miss.rest));
const gcbData = dataLines(gcbText, 'GraphemeBreakProperty.txt');
for (const line of gcbData) apply(gcbCoverage, line, gcbId(line.fields[0]));
const gcbRle = rle(gcbCoverage);

/* ------------------------------------------------------------------ */
/* Extended_Pictographic (emoji/emoji-data.txt)                       */
/* ------------------------------------------------------------------ */

const extPictCoverage = new Uint8Array(SENTINEL);
let extPictLines = 0;
for (const line of dataLines(read('emoji/emoji-data.txt'), 'emoji-data.txt')) {
  if (line.fields[0] === 'Extended_Pictographic') {
    extPictLines++;
    apply(extPictCoverage, line, 1);
  }
}
const extPictRle = rle(extPictCoverage);

/* ------------------------------------------------------------------ */
/* Indic_Conjunct_Break (DerivedCoreProperties.txt, InCB section)     */
/* ------------------------------------------------------------------ */

const INCB_NAMES = ['Consonant', 'Extend', 'Linker', 'None'];
const coreText = read('DerivedCoreProperties.txt');
const coreLines = coreText.split('\n');
const incbStart = coreLines.findIndex((l) => l.includes('# Derived Property: Indic_Conjunct_Break'));
if (incbStart < 0) fail('DerivedCoreProperties: InCB section not found');
let incbEnd = coreLines.length;
for (let i = incbStart + 1; i < coreLines.length; i++) {
  if (coreLines[i].includes('# Derived Property:')) { incbEnd = i; break; }
}
const incbSection = coreLines.slice(incbStart, incbEnd).join('\n');
const incbCoverage = new Uint16Array(SENTINEL).fill(INCB_NAMES.indexOf('None'));
for (const miss of missingLines(incbSection)) {
  // Format here is "@missing: 0000..10FFFF; InCB; None".
  const fields = miss.rest.split(';').map((f) => f.trim());
  const value = fields[fields.length - 1];
  if (!INCB_NAMES.includes(value)) fail(`InCB @missing: unknown value ${miss.rest}`);
  apply(incbCoverage, miss, INCB_NAMES.indexOf(value));
}
let incbLines = 0;
for (const line of dataLines(incbSection, 'DerivedCoreProperties.txt (InCB)')) {
  if (line.fields[0] !== 'InCB') continue;
  const value = line.fields[1];
  if (!INCB_NAMES.includes(value)) fail(`InCB: unknown value ${value}`);
  incbLines++;
  apply(incbCoverage, line, INCB_NAMES.indexOf(value));
}
const incbRle = rle(incbCoverage);

/* ------------------------------------------------------------------ */
/* Bidi paired brackets (BidiBrackets.txt)                            */
/* ------------------------------------------------------------------ */

const bracketEntries = [];
for (const line of dataLines(read('BidiBrackets.txt'), 'BidiBrackets.txt')) {
  const pair = parseInt(line.fields[0], 16);
  const type = line.fields[1];
  if (type !== 'o' && type !== 'c') fail(`BidiBrackets: unknown type ${type}`);
  if (line.start !== line.end) fail('BidiBrackets: range line where a single code point was expected');
  bracketEntries.push([line.start, pair, type === 'o' ? 1 : 0]);
}
bracketEntries.sort((a, b) => a[0] - b[0]);

/* ------------------------------------------------------------------ */
/* Emit                                                               */
/* ------------------------------------------------------------------ */

const typeUnion = (names) => names.map((n) => `'${n}'`).join(' | ');
const out = [];
out.push(`/**
 * GENERATED FILE — do not edit by hand.
 *
 * Unicode Character Database ${UNICODE_VERSION} tables for the §2
 * paragraph pipeline (bidi, script itemization, grapheme safety),
 * generated by scripts/${GENERATOR_VERSION.split(' ')[0]}.mjs
 * (${GENERATOR_VERSION}) from the vendored UCD inputs in
 * scripts/ucd-${UNICODE_VERSION}/ (see RECEIPT.md there). Regeneration
 * is a deliberate, diff-reviewed act — never a build step.
 *
 * Data © 2023 Unicode®, Inc. Unicode and the Unicode Logo are
 * registered trademarks of Unicode, Inc. in the U.S. and other
 * countries. For terms of use, see
 * https://www.unicode.org/terms_of_use.html (Unicode License v3 /
 * Unicode-DFS).
 *
 * Encoding: per property, parallel starts[]/values[] run-length
 * arrays; a code point's value is the values entry whose start is
 * the greatest start <= the code point (the final start is the
 * 0x110000 sentinel). Lookups are binary searches.
 */
export const PIPELINE_DATA_VERSION = '${PIPELINE_DATA_VERSION}';

/** Index of the run containing \`codePoint\` (greatest start <= cp). */
function rleIndex(starts: readonly number[], codePoint: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= codePoint) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
`);

out.push(`/* ---------------- Bidi_Class ---------------- */`);
out.push(`export type BidiClass = ${typeUnion(BIDI_CLASS_NAMES)};`);
out.push(`const BIDI_CLASS_NAMES: readonly BidiClass[] = [${BIDI_CLASS_NAMES.map((n) => `'${n}'`).join(', ')}];`);
out.push(fmtArray('BIDI_STARTS', bidiRle.starts, 16));
out.push(fmtArray('BIDI_VALUES', bidiRle.values, 10));
out.push(`export function bidiClass(codePoint: number): BidiClass {
  return BIDI_CLASS_NAMES[BIDI_VALUES[rleIndex(BIDI_STARTS, codePoint)]!]!;
}
`);

out.push(`/* ---------------- Script ---------------- */`);
out.push(`const SCRIPT_NAMES: readonly string[] = [${SCRIPT_NAMES.map((n) => `'${n}'`).join(', ')}];`);
out.push(fmtArray('SCRIPT_STARTS', scriptRle.starts, 16));
out.push(fmtArray('SCRIPT_VALUES', scriptRle.values, 10));
out.push(`/** ISO 15924 script code for a code point ('Zyyy' Common, 'Zinh' Inherited, 'Zzzz' Unknown). */
export function script(codePoint: number): string {
  return SCRIPT_NAMES[SCRIPT_VALUES[rleIndex(SCRIPT_STARTS, codePoint)]!]!;
}
`);

out.push(`/* ---------------- Script_Extensions ---------------- */`);
out.push(`const SCX_SETS: readonly (readonly number[])[] = [
${scxSets.map((set) => `  [${set.join(', ')}],`).join('\n')}
];`);
out.push(fmtArray('SCX_STARTS', scxRle.starts, 16));
out.push(fmtArray('SCX_VALUES', scxRle.values, 10));
out.push(`/**
 * The full Script_Extensions set for a code point, or null when it
 * equals the singleton { script(codePoint) } (the common case).
 */
export function scriptExtensions(codePoint: number): readonly string[] | null {
  const setIndex = SCX_VALUES[rleIndex(SCX_STARTS, codePoint)]!;
  if (setIndex === 0) return null;
  return SCX_SETS[setIndex - 1]!.map((id) => SCRIPT_NAMES[id]!);
}
`);

out.push(`/* ---------------- Grapheme_Cluster_Break ---------------- */`);
out.push(`export type GraphemeBreak = ${typeUnion(GCB_NAMES)};`);
out.push(`const GCB_NAMES: readonly GraphemeBreak[] = [${GCB_NAMES.map((n) => `'${n}'`).join(', ')}];`);
out.push(fmtArray('GCB_STARTS', gcbRle.starts, 16));
out.push(fmtArray('GCB_VALUES', gcbRle.values, 10));
out.push(`export function graphemeBreak(codePoint: number): GraphemeBreak {
  return GCB_NAMES[GCB_VALUES[rleIndex(GCB_STARTS, codePoint)]!]!;
}
`);

out.push(`/* ---------------- Extended_Pictographic ---------------- */`);
out.push(fmtArray('EXT_PICT_STARTS', extPictRle.starts, 16));
out.push(fmtArray('EXT_PICT_VALUES', extPictRle.values, 10));
out.push(`export function extendedPictographic(codePoint: number): boolean {
  return EXT_PICT_VALUES[rleIndex(EXT_PICT_STARTS, codePoint)] === 1;
}
`);

out.push(`/* ---------------- Indic_Conjunct_Break ---------------- */`);
out.push(`export type IndicConjunctBreak = ${typeUnion(INCB_NAMES)};`);
out.push(`const INCB_NAMES: readonly IndicConjunctBreak[] = [${INCB_NAMES.map((n) => `'${n}'`).join(', ')}];`);
out.push(fmtArray('INCB_STARTS', incbRle.starts, 16));
out.push(fmtArray('INCB_VALUES', incbRle.values, 10));
out.push(`export function indicConjunctBreak(codePoint: number): IndicConjunctBreak {
  return INCB_NAMES[INCB_VALUES[rleIndex(INCB_STARTS, codePoint)]!]!;
}
`);

out.push(`/* ---------------- Bidi paired brackets ---------------- */`);
out.push(`/** Flat [codePoint, pair, openFlag] triples from BidiBrackets.txt. */`);
out.push(fmtArray('BIDI_BRACKET_TRIPLES', bracketEntries.flat(), 16));
out.push(`const BIDI_BRACKETS: ReadonlyMap<number, { readonly pair: number; readonly open: boolean }> = (() => {
  const map = new Map<number, { readonly pair: number; readonly open: boolean }>();
  for (let i = 0; i < BIDI_BRACKET_TRIPLES.length; i += 3) {
    map.set(BIDI_BRACKET_TRIPLES[i]!, {
      pair: BIDI_BRACKET_TRIPLES[i + 1]!,
      open: BIDI_BRACKET_TRIPLES[i + 2] === 1,
    });
  }
  return map;
})();
/**
 * The Bidi_Paired_Bracket entry for a code point: its counterpart
 * and whether this code point is the opening bracket, or null when
 * the code point is not a paired bracket.
 */
export function bidiBracket(codePoint: number): { readonly pair: number; readonly open: boolean } | null {
  return BIDI_BRACKETS.get(codePoint) ?? null;
}
/**
 * BD16 matching key: bracket pairing compares the open bracket's
 * Bidi_Paired_Bracket value (or its canonical equivalent) against
 * the closing bracket (or its canonical equivalent). Exactly two
 * bracket characters have canonical decompositions in UCD 15.1.0
 * (UnicodeData.txt: 2329 -> 3008, 232A -> 3009 — verified against
 * the full bracket set); every other code point is its own key.
 */
const BRACKET_CANONICAL_EQUIVALENTS: ReadonlyMap<number, number> = new Map([
  [0x2329, 0x3008],
  [0x232a, 0x3009],
]);
export function bidiBracketMatchKey(codePoint: number): number {
  return BRACKET_CANONICAL_EQUIVALENTS.get(codePoint) ?? codePoint;
}
`);

writeFileSync(OUT_PATH, out.join('\n'));
const stats = {
  bidiLines: bidiData.length,
  bidiRuns: bidiRle.values.length - 1,
  scriptLines: scriptsData.length,
  scriptRuns: scriptRle.values.length - 1,
  scripts: SCRIPT_NAMES.length,
  scxLines: scxData.length,
  scxSets: scxSets.length,
  scxRuns: scxRle.values.length - 1,
  gcbLines: gcbData.length,
  gcbRuns: gcbRle.values.length - 1,
  extPictLines,
  extPictRuns: extPictRle.values.length - 1,
  incbLines,
  incbRuns: incbRle.values.length - 1,
  bracketEntries: bracketEntries.length,
};
console.log('generate-unicode-tables:', JSON.stringify(stats, null, 2));
