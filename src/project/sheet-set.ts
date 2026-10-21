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
 * unmodeled native data. Attributes ON modeled elements are preserved the
 * same way: on the root element (`dstAttributes`), on subset elements and
 * their <Name> leaves (keyed by subset name), on each sheet element
 * (the sheet's `dstAttributes`), and on a sheet's leaf elements
 * (`dstLeafAttributes`, keyed by leaf tag). Unmodeled elements nested
 * inside a modeled LEAF are preserved via `opaqueFragments` too. Two
 * round-trip limits are stated plainly: preserved fragments re-emit at set
 * level (their original position is not preserved), and the DST form
 * preserves neither the interleaved order of sheets across subsets nor
 * sheet ids — fresh ids are minted on DST import. The JSON form DOES
 * preserve ids and every preserved-attribute record. AutoCAD's own
 * acceptance of emitted files is a separate Windows/native gate and is NOT
 * claimed here.
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
  /** Attributes carried on this sheet's <AcSmSheet> element in a DST import; re-emitted verbatim. */
  readonly dstAttributes?: Readonly<Record<string, string>>;
  /** Attributes carried on this sheet's leaf elements in a DST import, keyed by leaf tag; re-emitted verbatim. */
  readonly dstLeafAttributes?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface SheetSet {
  readonly name: string;
  readonly description?: string;
  readonly customProperties?: Readonly<Record<string, string>>;
  readonly sheets: readonly SheetSetSheet[];
  /** Verbatim XML fragments from a DST import that this model does not interpret. */
  readonly opaqueFragments?: readonly string[];
  /** Attributes carried on the root <AcSmSheetSet> element in a DST import; re-emitted verbatim. */
  readonly dstAttributes?: Readonly<Record<string, string>>;
  /** Attributes carried on <AcSmSubset> elements in a DST import, keyed by subset name; re-emitted verbatim. */
  readonly dstSubsetAttributes?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Attributes carried on subset <Name> leaves in a DST import, keyed by subset name; re-emitted verbatim. */
  readonly dstSubsetNameAttributes?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Attributes carried on the set's <Name> leaf in a DST import; re-emitted verbatim. */
  readonly dstNameAttributes?: Readonly<Record<string, string>>;
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
  if (!entry) return set;
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

/** Validate a record of string records (the keyed preserved-attribute maps). */
function nestedStringProps(v: unknown, what: string): Record<string, Record<string, string>> {
  if (!isRecord(v)) throw new Error(`${what} must be an object of string records`);
  const out: Record<string, Record<string, string>> = {};
  for (const [k, val] of Object.entries(v)) out[k] = stringProps(val, `${what}.${k}`);
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
      ...(s.dstAttributes !== undefined ? { dstAttributes: stringProps(s.dstAttributes, `sheets[${i}].dstAttributes`) } : {}),
      ...(s.dstLeafAttributes !== undefined ? { dstLeafAttributes: nestedStringProps(s.dstLeafAttributes, `sheets[${i}].dstLeafAttributes`) } : {}),
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
    ...(raw.dstAttributes !== undefined ? { dstAttributes: stringProps(raw.dstAttributes, 'dstAttributes') } : {}),
    ...(raw.dstSubsetAttributes !== undefined ? { dstSubsetAttributes: nestedStringProps(raw.dstSubsetAttributes, 'dstSubsetAttributes') } : {}),
    ...(raw.dstSubsetNameAttributes !== undefined ? { dstSubsetNameAttributes: nestedStringProps(raw.dstSubsetNameAttributes, 'dstSubsetNameAttributes') } : {}),
    ...(raw.dstNameAttributes !== undefined ? { dstNameAttributes: stringProps(raw.dstNameAttributes, 'dstNameAttributes') } : {}),
  };
}

// ------------------------------------------------------------- DST XML subset

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const xmlEscape = (s: string): string => s.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch] ?? ch);
const xmlUnescape = (s: string): string => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

interface XmlNode {
  readonly tag: string;
  /** Attributes in source order (name/value pairs, values unescaped). */
  readonly attrs: readonly (readonly [string, string])[];
  readonly children: readonly XmlNode[];
  readonly text: string;
  /** Exact source slice of this element, for opaque preservation. */
  readonly raw: string;
}

/**
 * Minimal XML parser for the DST subset. The open-tag scan is quote-aware —
 * a '>' or '/' inside a quoted attribute value neither ends the tag nor
 * fakes a self-closing element — and malformed attribute syntax (unquoted
 * or unterminated values) refuses the whole document, atomically.
 */
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
    let i = start + 1;
    let tag = '';
    while (i < xml.length && !/[\s/>]/.test(xml.charAt(i))) { tag += xml.charAt(i); i += 1; }
    if (!tag) throw new Error('DST XML: empty tag');
    const attrs: [string, string][] = [];
    let selfClosing = false;
    for (;;) {
      while (i < xml.length && /\s/.test(xml.charAt(i))) i += 1;
      if (i >= xml.length) throw new Error('DST XML: unterminated tag');
      const c = xml.charAt(i);
      if (c === '>') { i += 1; break; }
      if (c === '/') {
        if (xml.charAt(i + 1) !== '>') throw new Error('DST XML: malformed tag');
        selfClosing = true;
        i += 2;
        break;
      }
      let attrName = '';
      while (i < xml.length && !/[\s=/>]/.test(xml.charAt(i))) { attrName += xml.charAt(i); i += 1; }
      if (!attrName) throw new Error('DST XML: malformed attribute');
      while (i < xml.length && /\s/.test(xml.charAt(i))) i += 1;
      if (xml.charAt(i) !== '=') throw new Error(`DST XML: attribute ${attrName} has no value`);
      i += 1;
      while (i < xml.length && /\s/.test(xml.charAt(i))) i += 1;
      const quote = xml.charAt(i);
      if (quote !== '"' && quote !== "'") throw new Error(`DST XML: attribute ${attrName} value must be quoted`);
      i += 1;
      const endQuote = xml.indexOf(quote, i);
      if (endQuote < 0) throw new Error('DST XML: unterminated attribute value');
      attrs.push([attrName, xmlUnescape(xml.slice(i, endQuote))]);
      i = endQuote + 1;
    }
    if (selfClosing) return { node: { tag, attrs, children: [], text: '', raw: xml.slice(start, i) }, next: i };
    const children: XmlNode[] = [];
    let text = '';
    let cursor = i;
    for (;;) {
      const lt = xml.indexOf('<', cursor);
      if (lt < 0) throw new Error(`DST XML: unclosed <${tag}>`);
      text += xml.slice(cursor, lt);
      if (xml.startsWith('</', lt)) {
        const closeEnd = xml.indexOf('>', lt);
        if (closeEnd < 0) throw new Error('DST XML: unterminated close tag');
        const closeTag = xml.slice(lt + 2, closeEnd).trim();
        if (closeTag !== tag) throw new Error(`DST XML: expected </${tag}> but found </${closeTag}>`);
        return { node: { tag, attrs, children, text: xmlUnescape(text.trim()), raw: xml.slice(start, closeEnd + 1) }, next: closeEnd + 1 };
      }
      const child = parseElement(lt);
      children.push(child.node);
      cursor = child.next;
    }
  };
  return parseElement(pos).node;
}

/** A node's attributes as a record, or undefined when it has none. */
const attrsRecord = (node: XmlNode): Record<string, string> | undefined => {
  if (node.attrs.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of node.attrs) out[k] = v;
  return out;
};

/** Render a preserved-attribute record back onto an emitted tag (values escaped). */
const attrsXml = (rec: Readonly<Record<string, string>> | undefined): string => {
  if (!rec) return '';
  return Object.entries(rec).map(([k, v]) => ` ${k}="${xmlEscape(v)}"`).join('');
};

const childText = (node: XmlNode, tag: string): string | undefined =>
  node.children.find((c) => c.tag === tag)?.text;

const SHEET_CHILD_TAGS = new Set(['Number', 'Title', 'LayoutName', 'FilePath']);

/** Parse the bounded DST subset. Unmodeled elements are preserved in `opaqueFragments`. */
export function parseDstSubsetXml(xml: string): SheetSet {
  const root = parseXml(xml);
  if (root.tag !== 'AcSmSheetSet') throw new Error(`DST XML: root must be <AcSmSheetSet>, found <${root.tag}>`);
  const opaque: string[] = [];
  const sheets: SheetSetSheet[] = [];
  const subsetAttributes: Record<string, Record<string, string>> = {};
  const subsetNameAttributes: Record<string, Record<string, string>> = {};
  const readSheet = (node: XmlNode, subset?: string): void => {
    const leafAttributes: Record<string, Record<string, string>> = {};
    for (const child of node.children) {
      if (!SHEET_CHILD_TAGS.has(child.tag)) { opaque.push(child.raw); continue; }
      const rec = attrsRecord(child);
      if (rec) leafAttributes[child.tag] = rec;
      // An unmodeled element nested inside a modeled leaf is preserved
      // verbatim, never silently discarded (the leaf's own text is still
      // the concatenation of its text nodes).
      for (const nested of child.children) opaque.push(nested.raw);
    }
    const sheetAttributes = attrsRecord(node);
    sheets.push({
      id: newSheetId(),
      number: childText(node, 'Number') ?? '',
      title: childText(node, 'Title') ?? '',
      drawingPath: childText(node, 'FilePath') ?? '',
      layoutName: childText(node, 'LayoutName') ?? '',
      ...(subset !== undefined ? { subset } : {}),
      ...(sheetAttributes ? { dstAttributes: sheetAttributes } : {}),
      ...(Object.keys(leafAttributes).length ? { dstLeafAttributes: leafAttributes } : {}),
    });
  };
  let name = '';
  let nameAttributes: Record<string, string> | undefined;
  for (const child of root.children) {
    if (child.tag === 'Name') {
      name = child.text;
      nameAttributes = attrsRecord(child);
      for (const nested of child.children) opaque.push(nested.raw);
    } else if (child.tag === 'AcSmSheet') readSheet(child);
    else if (child.tag === 'AcSmSubset') {
      const subsetName = childText(child, 'Name') ?? '';
      const subsetRec = attrsRecord(child);
      if (subsetRec) subsetAttributes[subsetName] = subsetRec;
      for (const sub of child.children) {
        if (sub.tag === 'AcSmSheet') readSheet(sub, subsetName);
        else if (sub.tag === 'Name') {
          const nameRec = attrsRecord(sub);
          if (nameRec) subsetNameAttributes[subsetName] = nameRec;
          for (const nested of sub.children) opaque.push(nested.raw);
        } else opaque.push(sub.raw);
      }
    } else opaque.push(child.raw);
  }
  if (!name) throw new Error('DST XML: sheet set <Name> is missing');
  const rootAttributes = attrsRecord(root);
  return {
    name,
    sheets,
    ...(opaque.length ? { opaqueFragments: opaque } : {}),
    ...(rootAttributes ? { dstAttributes: rootAttributes } : {}),
    ...(Object.keys(subsetAttributes).length ? { dstSubsetAttributes: subsetAttributes } : {}),
    ...(Object.keys(subsetNameAttributes).length ? { dstSubsetNameAttributes: subsetNameAttributes } : {}),
    ...(nameAttributes ? { dstNameAttributes: nameAttributes } : {}),
  };
}

/** Emit the bounded DST subset. Opaque fragments are re-emitted verbatim before the root closes. */
export function toDstSubsetXml(set: SheetSet): string {
  const leafXml = (s: SheetSetSheet, tag: 'Number' | 'Title' | 'LayoutName' | 'FilePath', value: string): string =>
    `<${tag}${attrsXml(s.dstLeafAttributes?.[tag])}>${xmlEscape(value)}</${tag}>`;
  const sheetXml = (s: SheetSetSheet): string =>
    `  <AcSmSheet${attrsXml(s.dstAttributes)}>${leafXml(s, 'Number', s.number)}${leafXml(s, 'Title', s.title)}` +
    `${leafXml(s, 'LayoutName', s.layoutName)}${leafXml(s, 'FilePath', s.drawingPath)}</AcSmSheet>`;
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<AcSmSheetSet${attrsXml(set.dstAttributes)}>`,
    `  <Name${attrsXml(set.dstNameAttributes)}>${xmlEscape(set.name)}</Name>`,
  ];
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
      lines.push(`  <AcSmSubset${attrsXml(set.dstSubsetAttributes?.[s.subset])}><Name${attrsXml(set.dstSubsetNameAttributes?.[s.subset])}>${xmlEscape(s.subset)}</Name>`);
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
