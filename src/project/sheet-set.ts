/**
 * P31A — Sheet-set model with stable drawing/layout links (pure module).
 *
 * A sheet set is an ordered collection of sheets; each sheet links to one
 * layout in one drawing file by path + layout name. Sheet ids are stable:
 * they are assigned at creation and never change across reorder, rename of
 * the drawing file, or serialization. Link integrity is checked explicitly
 * through a caller-supplied resolver — a missing or renamed target is
 * REPORTED as an issue, never silently dropped or retargeted.
 *
 * This module is deliberately isolated: it does not touch Drawing state, the
 * editor, or the filesystem. UI/host wiring is a later slice.
 *
 * Native-format interoperability is bounded: `toDstSubsetXml` /
 * `parseDstSubsetXml` cover a documented subset of the AutoCAD Sheet Set
 * (.dst) XML structure (set name, subsets, sheet number/title/layout/file).
 * Anything outside that subset is preserved verbatim in `opaqueFragments`
 * and re-emitted on write, so an import/export round trip never discards
 * unmodeled native data. AutoCAD's own acceptance of emitted files is a
 * separate Windows/native gate and is NOT claimed here.
 */

export interface SheetSetSheet {
  readonly id: string;
  readonly number: string;
  readonly title: string;
  /** Path of the drawing file, exactly as recorded — never rewritten by validation. */
  readonly drawingPath: string;
  /** Name of the layout inside the drawing this sheet publishes. */
  readonly layoutName: string;
  readonly subset?: string;
  readonly revision?: string;
  readonly customProperties?: Readonly<Record<string, string>>;
}

export interface SheetSet {
  readonly name: string;
  readonly description?: string;
  readonly customProperties?: Readonly<Record<string, string>>;
  readonly sheets: readonly SheetSetSheet[];
  /** Verbatim XML fragments from a DST import that this model does not interpret. */
  readonly opaqueFragments?: readonly string[];
}

export interface NewSheet {
  readonly number: string;
  readonly title: string;
  readonly drawingPath: string;
  readonly layoutName: string;
  readonly subset?: string;
  readonly revision?: string;
  readonly customProperties?: Readonly<Record<string, string>>;
}

let idCounter = 0;
/** Stable sheet id: random UUID where available, counter fallback. Ids are opaque. */
export function newSheetId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return `sheet-${c.randomUUID()}`;
  idCounter += 1;
  return `sheet-${Date.now().toString(36)}-${idCounter}`;
}

export function createSheetSet(init: {
  name: string;
  description?: string;
  customProperties?: Readonly<Record<string, string>>;
}): SheetSet {
  if (typeof init.name !== 'string' || init.name.length === 0) throw new Error('sheet set name must be a non-empty string');
  return {
    name: init.name,
    ...(init.description !== undefined ? { description: init.description } : {}),
    ...(init.customProperties ? { customProperties: { ...init.customProperties } } : {}),
    sheets: [],
  };
}

export function addSheet(set: SheetSet, sheet: NewSheet): SheetSet {
  const entry: SheetSetSheet = {
    id: newSheetId(),
    number: sheet.number,
    title: sheet.title,
    drawingPath: sheet.drawingPath,
    layoutName: sheet.layoutName,
    ...(sheet.subset !== undefined ? { subset: sheet.subset } : {}),
    ...(sheet.revision !== undefined ? { revision: sheet.revision } : {}),
    ...(sheet.customProperties ? { customProperties: { ...sheet.customProperties } } : {}),
  };
  return { ...set, sheets: [...set.sheets, entry] };
}

/** Move a sheet to a new index (clamped). Unknown id is a no-op returning the same set. */
export function moveSheet(set: SheetSet, sheetId: string, toIndex: number): SheetSet {
  const from = set.sheets.findIndex((s) => s.id === sheetId);
  if (from < 0) return set;
  const sheets = [...set.sheets];
  const [entry] = sheets.splice(from, 1);
  const target = Math.max(0, Math.min(sheets.length, Math.trunc(toIndex)));
  sheets.splice(target, 0, entry);
  return { ...set, sheets };
}

/** Update a sheet's link/title fields. The id never changes. */
export function updateSheet(set: SheetSet, sheetId: string, patch: Partial<NewSheet>): SheetSet {
  return {
    ...set,
    sheets: set.sheets.map((s) => (s.id === sheetId ? { ...s, ...patch, id: s.id } : s)),
  };
}

export function removeSheet(set: SheetSet, sheetId: string): SheetSet {
  return { ...set, sheets: set.sheets.filter((s) => s.id !== sheetId) };
}

// ------------------------------------------------------------- link integrity

/** What the host knows about one drawing path: does it exist, and which layouts does it contain? */
export type SheetSetLinkResolver = (drawingPath: string) => { exists: boolean; layouts: readonly string[] };

export type SheetSetLinkIssueKind = 'missing-drawing' | 'missing-layout' | 'duplicate-number' | 'duplicate-id';

export interface SheetSetLinkIssue {
  readonly kind: SheetSetLinkIssueKind;
  readonly sheetId: string;
  readonly sheetNumber: string;
  readonly message: string;
}

/**
 * Validate every link in the set. Returns one issue per problem found; the
 * set itself is never modified — broken entries stay in place and are
 * reported, so nothing is silently discarded.
 */
export function validateSheetSetLinks(set: SheetSet, resolve: SheetSetLinkResolver): SheetSetLinkIssue[] {
  const issues: SheetSetLinkIssue[] = [];
  const seenNumbers = new Map<string, string>();
  const seenIds = new Set<string>();
  for (const sheet of set.sheets) {
    if (seenIds.has(sheet.id)) {
      issues.push({ kind: 'duplicate-id', sheetId: sheet.id, sheetNumber: sheet.number, message: `Sheet id ${sheet.id} is used more than once.` });
    }
    seenIds.add(sheet.id);
    const firstWithNumber = seenNumbers.get(sheet.number);
    if (firstWithNumber !== undefined) {
      issues.push({
        kind: 'duplicate-number', sheetId: sheet.id, sheetNumber: sheet.number,
        message: `Sheet number "${sheet.number}" is also used by sheet ${firstWithNumber}.`,
      });
    } else {
      seenNumbers.set(sheet.number, sheet.id);
    }
    const target = resolve(sheet.drawingPath);
    if (!target.exists) {
      issues.push({
        kind: 'missing-drawing', sheetId: sheet.id, sheetNumber: sheet.number,
        message: `Sheet ${sheet.number} links to drawing "${sheet.drawingPath}", which was not found. The link is kept as recorded.`,
      });
    } else if (!target.layouts.includes(sheet.layoutName)) {
      issues.push({
        kind: 'missing-layout', sheetId: sheet.id, sheetNumber: sheet.number,
        message: `Sheet ${sheet.number} links to layout "${sheet.layoutName}" in "${sheet.drawingPath}", which has layouts: ${target.layouts.join(', ') || '(none)'}.`,
      });
    }
  }
  return issues;
}

// ------------------------------------------------------------- fields bridge

/**
 * Values for the existing field evaluator (core/fields.ts `FieldContext.sheetSet`)
 * for one sheet: keys match the \AcSm names that evaluator looks up.
 */
export function sheetFieldValues(set: SheetSet, sheetId: string): Record<string, string> {
  const sheet = set.sheets.find((s) => s.id === sheetId);
  const values: Record<string, string> = { 'SheetSet.Name': set.name };
  if (set.description !== undefined) values['SheetSet.Description'] = set.description;
  if (sheet) {
    values['Sheet.Number'] = sheet.number;
    values['Sheet.Title'] = sheet.title;
    values['Sheet.Layout'] = sheet.layoutName;
    if (sheet.revision !== undefined) values['Sheet.Revision'] = sheet.revision;
    if (sheet.subset !== undefined) values['Sheet.Subset'] = sheet.subset;
    values['SheetSet.SheetCount'] = String(set.sheets.length);
    values['Sheet.SheetIndex'] = String(set.sheets.indexOf(sheet) + 1);
  }
  return values;
}

// ------------------------------------------------------------- JSON form

export function sheetSetToJson(set: SheetSet): string {
  return JSON.stringify(set, null, 2);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringProps(v: unknown, what: string): Record<string, string> {
  if (!isRecord(v)) throw new Error(`${what} must be an object of strings`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string') throw new Error(`${what}.${k} must be a string`);
    out[k] = val;
  }
  return out;
}

/** Parse the JSON form. Throws on any malformed input — no partial sets are fabricated. */
export function parseSheetSetJson(text: string): SheetSet {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw) || typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new Error('sheet set JSON must be an object with a non-empty string "name"');
  }
  if (!Array.isArray(raw.sheets)) throw new Error('sheet set JSON "sheets" must be an array');
  const sheets: SheetSetSheet[] = raw.sheets.map((s, i) => {
    if (!isRecord(s)) throw new Error(`sheets[${i}] must be an object`);
    for (const key of ['id', 'number', 'title', 'drawingPath', 'layoutName'] as const) {
      if (typeof s[key] !== 'string') throw new Error(`sheets[${i}].${key} must be a string`);
    }
    return {
      id: s.id as string,
      number: s.number as string,
      title: s.title as string,
      drawingPath: s.drawingPath as string,
      layoutName: s.layoutName as string,
      ...(typeof s.subset === 'string' ? { subset: s.subset } : {}),
      ...(typeof s.revision === 'string' ? { revision: s.revision } : {}),
      ...(s.customProperties !== undefined ? { customProperties: stringProps(s.customProperties, `sheets[${i}].customProperties`) } : {}),
    };
  });
  return {
    name: raw.name,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(raw.customProperties !== undefined ? { customProperties: stringProps(raw.customProperties, 'customProperties') } : {}),
    sheets,
    ...(Array.isArray(raw.opaqueFragments) && raw.opaqueFragments.every((f) => typeof f === 'string')
      ? { opaqueFragments: raw.opaqueFragments as string[] }
      : {}),
  };
}

// ------------------------------------------------------------- DST XML subset

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const xmlEscape = (s: string): string => s.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch]);
const xmlUnescape = (s: string): string => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

interface XmlNode {
  readonly tag: string;
  readonly children: readonly XmlNode[];
  readonly text: string;
  /** Exact source slice of this element, for opaque preservation. */
  readonly raw: string;
}

/** Minimal XML parser for the DST subset: elements and text only (no attributes are modeled). */
function parseXml(xml: string): XmlNode {
  let pos = xml.indexOf('<');
  if (pos < 0) throw new Error('DST XML: no root element');
  // Skip prolog / comments / doctype before the root.
  for (;;) {
    if (xml.startsWith('<?', pos) || xml.startsWith('<!--', pos) || xml.startsWith('<!', pos)) {
      const end = xml.startsWith('<!--', pos) ? xml.indexOf('-->', pos) : xml.indexOf('>', pos);
      if (end < 0) throw new Error('DST XML: unterminated prolog');
      pos = xml.indexOf('<', end);
      if (pos < 0) throw new Error('DST XML: no root element');
    } else break;
  }
  const parseElement = (start: number): { node: XmlNode; next: number } => {
    const openEnd = xml.indexOf('>', start);
    if (openEnd < 0) throw new Error('DST XML: unterminated tag');
    const openTag = xml.slice(start + 1, openEnd).trim();
    const selfClosing = openTag.endsWith('/');
    const tag = (selfClosing ? openTag.slice(0, -1) : openTag).split(/\s/)[0];
    if (!tag) throw new Error('DST XML: empty tag');
    if (selfClosing) return { node: { tag, children: [], text: '', raw: xml.slice(start, openEnd + 1) }, next: openEnd + 1 };
    const children: XmlNode[] = [];
    let text = '';
    let cursor = openEnd + 1;
    for (;;) {
      const lt = xml.indexOf('<', cursor);
      if (lt < 0) throw new Error(`DST XML: unclosed <${tag}>`);
      text += xml.slice(cursor, lt);
      if (xml.startsWith('</', lt)) {
        const closeEnd = xml.indexOf('>', lt);
        if (closeEnd < 0) throw new Error('DST XML: unterminated close tag');
        const closeTag = xml.slice(lt + 2, closeEnd).trim();
        if (closeTag !== tag) throw new Error(`DST XML: expected </${tag}> but found </${closeTag}>`);
        return { node: { tag, children, text: xmlUnescape(text.trim()), raw: xml.slice(start, closeEnd + 1) }, next: closeEnd + 1 };
      }
      const child = parseElement(lt);
      children.push(child.node);
      cursor = child.next;
    }
  };
  return parseElement(pos).node;
}

const childText = (node: XmlNode, tag: string): string | undefined =>
  node.children.find((c) => c.tag === tag)?.text;

const SHEET_CHILD_TAGS = new Set(['Number', 'Title', 'LayoutName', 'FilePath']);

/** Parse the bounded DST subset. Unmodeled elements are preserved in `opaqueFragments`. */
export function parseDstSubsetXml(xml: string): SheetSet {
  const root = parseXml(xml);
  if (root.tag !== 'AcSmSheetSet') throw new Error(`DST XML: root must be <AcSmSheetSet>, found <${root.tag}>`);
  const opaque: string[] = [];
  const sheets: SheetSetSheet[] = [];
  const readSheet = (node: XmlNode, subset?: string): void => {
    for (const child of node.children) {
      if (!SHEET_CHILD_TAGS.has(child.tag)) opaque.push(child.raw);
    }
    sheets.push({
      id: newSheetId(),
      number: childText(node, 'Number') ?? '',
      title: childText(node, 'Title') ?? '',
      drawingPath: childText(node, 'FilePath') ?? '',
      layoutName: childText(node, 'LayoutName') ?? '',
      ...(subset !== undefined ? { subset } : {}),
    });
  };
  let name = '';
  for (const child of root.children) {
    if (child.tag === 'Name') name = child.text;
    else if (child.tag === 'AcSmSheet') readSheet(child);
    else if (child.tag === 'AcSmSubset') {
      const subsetName = childText(child, 'Name') ?? '';
      for (const sub of child.children) {
        if (sub.tag === 'AcSmSheet') readSheet(sub, subsetName);
        else if (sub.tag !== 'Name') opaque.push(sub.raw);
      }
    } else opaque.push(child.raw);
  }
  if (!name) throw new Error('DST XML: sheet set <Name> is missing');
  return { name, sheets, ...(opaque.length ? { opaqueFragments: opaque } : {}) };
}

/** Emit the bounded DST subset. Opaque fragments are re-emitted verbatim before the root closes. */
export function toDstSubsetXml(set: SheetSet): string {
  const sheetXml = (s: SheetSetSheet): string =>
    `  <AcSmSheet><Number>${xmlEscape(s.number)}</Number><Title>${xmlEscape(s.title)}</Title>` +
    `<LayoutName>${xmlEscape(s.layoutName)}</LayoutName><FilePath>${xmlEscape(s.drawingPath)}</FilePath></AcSmSheet>`;
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<AcSmSheetSet>', `  <Name>${xmlEscape(set.name)}</Name>`];
  const subsets = new Map<string, SheetSetSheet[]>();
  for (const s of set.sheets) {
    if (s.subset !== undefined) {
      const list = subsets.get(s.subset) ?? [];
      list.push(s);
      subsets.set(s.subset, list);
    }
  }
  const emitted = new Set<string>();
  for (const s of set.sheets) {
    if (s.subset !== undefined) {
      if (emitted.has(s.subset)) continue;
      emitted.add(s.subset);
      lines.push(`  <AcSmSubset><Name>${xmlEscape(s.subset)}</Name>`);
      for (const sub of subsets.get(s.subset)!) lines.push(`  ${sheetXml(sub)}`);
      lines.push('  </AcSmSubset>');
    } else {
      lines.push(sheetXml(s));
    }
  }
  for (const fragment of set.opaqueFragments ?? []) lines.push(`  ${fragment}`);
  lines.push('</AcSmSheetSet>');
  return lines.join('\n');
}
