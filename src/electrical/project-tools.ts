/**
 * Project-wide AutoCAD Electrical-style operations on a set of drawings
 * ("sheets"): coil / contact cross-referencing across sheets, retagging and
 * wire numbering with project-wide uniqueness, and the Location View
 * (components grouped by installation / location code).
 *
 * Everything here is pure over `ProjectSheet` records (a Drawing plus its
 * sheet number and settings). Loading the sheets (open tabs, files through
 * the bridge) and writing them back is done by src/app/commands-electrical.ts.
 */
import type { Drawing, DrawingState } from '../core/document';
import type { Entity, InsertEntity, TextEntity } from '../core/entities';
import type { Point } from '../core/geometry';
import type { ProjectSettings } from '../app/project';
import { readWdSettings, findWdM, drawingUnitScale, type WdSettings } from './wdm';
import { nearestReference } from './ladder';
import { isCoil, isChild, isExtraPole, isParentComponent, isTerminal, isComponent } from './families';
import { tagPrefix } from './symbols';
import { nextTag, isFixedTag } from './tags';
import { descriptionOf, instLoc } from './attributes';
import { formatXref, xrefGraphics, withXrefGraphics, type XrefGraphicItem } from './xref';
import { planWireNumbers, fixedWireNumbers, withWireNumbers } from './wires';
import type { Report } from './reports';

// ------------------------------------------------------------------ sheets

export interface ProjectSheet {
  /** Display name (file base name). */
  name: string;
  /** Resolved file path, null for an unsaved drawing. */
  path: string | null;
  /** Index in project.drawings (-1 when the drawing is not part of the project). */
  index: number;
  doc: Drawing;
  /** Value of %S: the project entry's sheet, else the WD_M SHEET, else the position in the project. */
  sheet: string;
  /** Drawing settings (WD_M) with the project overrides applied and `sheet` filled in. */
  settings: WdSettings;
}

/** Drawing settings with the project-level overrides (tag format / mode, IEC codes, standard). */
export function withProjectSettings(s: WdSettings, ps: ProjectSettings | undefined): WdSettings {
  if (!ps) return s;
  return {
    ...s,
    tagFormat: ps.tagFormat ?? s.tagFormat,
    wireFormat: ps.wireFormat ?? s.wireFormat,
    tagMode: ps.tagMode ?? s.tagMode,
    iecProject: ps.iecProject ?? s.iecProject,
    iecInstallation: ps.installation ?? s.iecInstallation,
    iecLocation: ps.location ?? s.iecLocation,
    standard: ps.standard ?? s.standard,
  };
}

/** Build a sheet record for a drawing. `entrySheet` is the project entry's sheet value (if any). */
export function makeSheet(doc: Drawing, o: { name: string; path?: string | null; index: number; entrySheet?: string; projectSettings?: ProjectSettings }): ProjectSheet {
  const wd = withProjectSettings(readWdSettings(doc), o.projectSettings);
  const sheet = o.entrySheet || (findWdM(doc) ? wd.sheet : '') || (o.index >= 0 ? String(o.index + 1) : wd.sheet || '1');
  return { name: o.name, path: o.path ?? null, index: o.index, doc, sheet, settings: { ...wd, sheet } };
}

const byLadder = (a: InsertEntity, b: InsertEntity) => b.position.y - a.position.y || a.position.x - b.position.x;
const codes = (e: InsertEntity, s: ProjectSheet) => ({ inst: (e.attributes.INST ?? '').trim() || s.settings.iecInstallation, loc: (e.attributes.LOC ?? '').trim() || s.settings.iecLocation });

// ------------------------------------------------------- cross-reference

export interface ProjectXrefRef {
  sheet: ProjectSheet;
  insert: InsertEntity;
  ref: string | null;
  inst: string;
  loc: string;
}

export interface ProjectXrefContact extends ProjectXrefRef {
  kind: 'NO' | 'NC';
}

export interface ProjectXrefEntry {
  tag: string;
  inst: string;
  loc: string;
  coil: ProjectXrefRef | null;
  /** Further coils with the same tag and codes (a duplicate-tag problem). */
  duplicates: ProjectXrefRef[];
  contacts: ProjectXrefContact[];
}

const xkey = (tag: string, inst: string, loc: string) => `${inst}\u0001${loc}\u0001${tag}`;

/**
 * Group coils (parents) and contacts (children) of every sheet by tag,
 * installation and location. A child without INST / LOC codes of its own
 * falls back to a parent with the same tag anywhere in the project
 * (preferring its own sheet), like ACADE's tag-only match.
 */
export function buildProjectXref(sheets: readonly ProjectSheet[]): ProjectXrefEntry[] {
  const map = new Map<string, ProjectXrefEntry>();
  const byTag = new Map<string, ProjectXrefEntry[]>();
  const entry = (tag: string, inst: string, loc: string) => {
    const k = xkey(tag, inst, loc);
    let e = map.get(k);
    if (!e) {
      e = { tag, inst, loc, coil: null, duplicates: [], contacts: [] };
      map.set(k, e);
    }
    return e;
  };
  const children: ProjectXrefContact[] = [];
  for (const s of sheets) {
    for (const e of s.doc.entities) {
      if (e.type !== 'insert' || !e.attributes.TAG1) continue;
      const c = codes(e, s);
      const r: ProjectXrefRef = { sheet: s, insert: e, ref: nearestReference(s.doc, e.position), ...c };
      if (isCoil(e)) {
        const x = entry(e.attributes.TAG1, c.inst, c.loc);
        if (x.coil) x.duplicates.push(r);
        else {
          x.coil = r;
          byTag.set(x.tag, [...(byTag.get(x.tag) ?? []), x]);
        }
      } else if (isChild(e)) children.push({ ...r, kind: /NC$/.test(e.block) ? 'NC' : 'NO' });
    }
  }
  for (const c of children) {
    const tag = c.insert.attributes.TAG1!;
    let x = map.get(xkey(tag, c.inst, c.loc));
    const own = !(c.insert.attributes.INST ?? '').trim() && !(c.insert.attributes.LOC ?? '').trim();
    if ((!x || !x.coil) && own) {
      const cands = byTag.get(tag) ?? [];
      x = cands.find((k) => k.coil!.sheet === c.sheet) ?? cands[0] ?? x;
    }
    (x ?? entry(tag, c.inst, c.loc)).contacts.push(c);
  }
  const order = (r: ProjectXrefRef) => [sheets.indexOf(r.sheet), r.ref ?? ''] as const;
  for (const x of map.values())
    x.contacts.sort((a, b) => {
      const [sa, ra] = order(a);
      const [sb, rb] = order(b);
      return sa - sb || ra.localeCompare(rb, undefined, { numeric: true });
    });
  return [...map.values()].sort((a, b) => a.tag.localeCompare(b.tag, undefined, { numeric: true }) || a.inst.localeCompare(b.inst) || a.loc.localeCompare(b.loc));
}

/** Cross-sheet format: the drawing's format when it already has %S, else "%S.<format>" (ACADE's separate cross-sheet format). */
export function crossSheetFormat(fmt: string): string {
  return /%S/.test(fmt) ? fmt : `%S.${fmt}`;
}

/**
 * Reference text for `target` as shown on `from`'s drawing: the drawing's
 * xrefFormat on the same sheet, the cross-sheet format on another sheet,
 * and the "+INST-LOC" prefix when the target sits in another installation /
 * location and the format does not show those codes itself (%I / %L).
 */
export function projectRefText(target: ProjectXrefRef, from: ProjectXrefRef): string {
  const fmt = from.sheet.settings.xrefFormat || '%N';
  const same = target.sheet === from.sheet;
  const f = same ? fmt : crossSheetFormat(fmt);
  const text = formatXref(target.ref, { xrefFormat: f, sheet: target.sheet.sheet, drawing: target.sheet.settings.drawingNumber || target.sheet.name.replace(/\.[^.]+$/, ''), inst: target.inst, loc: target.loc });
  const differs = target.inst !== from.inst || target.loc !== from.loc;
  if (differs && !/%[IL]/.test(fmt)) {
    const il = instLoc({ INST: target.inst, LOC: target.loc });
    if (il) return `${il} ${text}`;
  }
  return text;
}

/** What one sheet shows for the project cross-reference: graphics items and insert attributes. */
export function sheetXref(entries: readonly ProjectXrefEntry[], sheet: ProjectSheet): { items: XrefGraphicItem[]; attributes: Map<string, Record<string, string>> } {
  const items: XrefGraphicItem[] = [];
  const attributes = new Map<string, Record<string, string>>();
  for (const x of entries) {
    const coilHere = x.coil && x.coil.sheet === sheet ? x.coil : null;
    const contactsHere = x.contacts.filter((c) => c.sheet === sheet);
    if (!coilHere && contactsHere.length === 0) continue;
    const no = coilHere ? x.contacts.filter((c) => c.kind === 'NO').map((c) => projectRefText(c, coilHere)) : [];
    const nc = coilHere ? x.contacts.filter((c) => c.kind === 'NC').map((c) => projectRefText(c, coilHere)) : [];
    const contacts = contactsHere.map((c) => ({ insert: c.insert, text: x.coil ? projectRefText(x.coil, c) : 'no coil' }));
    items.push({ coil: coilHere?.insert ?? null, no, nc, contacts });
    if (coilHere) attributes.set(coilHere.insert.id, { XREFNO: no.join(','), XREFNC: nc.join(',') });
    for (const c of contacts) attributes.set(c.insert.id, { XREF: x.coil ? c.text : '' });
  }
  return { items, attributes };
}

/** New drawing state of a sheet with the project cross-reference written in (XREF layer + attributes). */
export function applyProjectXref(entries: readonly ProjectXrefEntry[], sheet: ProjectSheet, state: DrawingState = sheet.doc.snapshot): DrawingState {
  const { items, attributes } = sheetXref(entries, sheet);
  return withXrefGraphics(state, xrefGraphics(items, sheet.settings.xrefStyle), attributes);
}

export interface XrefProblem {
  kind: 'no-parent' | 'duplicate-parent' | 'no-children';
  tag: string;
  sheet: string;
  ref: string;
  detail: string;
}

/** Unresolved children, duplicate parents and (informational) coils without contacts. */
export function xrefProblems(entries: readonly ProjectXrefEntry[]): XrefProblem[] {
  const out: XrefProblem[] = [];
  for (const x of entries) {
    const il = instLoc({ INST: x.inst, LOC: x.loc });
    const name = `${il ? `${il} ` : ''}${x.tag}`;
    if (!x.coil) for (const c of x.contacts) out.push({ kind: 'no-parent', tag: x.tag, sheet: c.sheet.name, ref: c.ref ?? '', detail: `Contact ${name} has no parent coil in the project` });
    for (const d of x.duplicates) out.push({ kind: 'duplicate-parent', tag: x.tag, sheet: d.sheet.name, ref: d.ref ?? '', detail: `Parent ${name} is also on ${x.coil!.sheet.name} (${x.coil!.ref ?? '?'})` });
    if (x.coil && x.contacts.length === 0 && isCoil(x.coil.insert)) out.push({ kind: 'no-children', tag: x.tag, sheet: x.coil.sheet.name, ref: x.coil.ref ?? '', detail: `Coil ${name} has no contacts` });
  }
  return out;
}

// ------------------------------------------------------------------ retag

export interface ProjectRetagPlan {
  /** Per sheet (index into the sheets array): insert id -> new TAG1. */
  changes: Map<number, Map<string, string>>;
  renamed: Array<{ sheet: string; from: string; to: string }>;
  count: number;
}

/**
 * Project-wide RETAG. `all` renumbers every parent device of every sheet in
 * sheet and ladder order with the sheet's tag format (so %S gives
 * sheet-based tags); `duplicates` keeps existing unique tags and only
 * retags repeats (second and later occurrences) and blank tags. Fixed tags
 * (TAGFIXED) are never changed and are reserved project-wide. Children and
 * extra poles follow their parent, also across sheets. Uniqueness is per
 * installation / location code.
 */
export function planProjectRetag(sheets: readonly ProjectSheet[], mode: 'all' | 'duplicates' = 'all'): ProjectRetagPlan {
  const used = new Map<string, Set<string>>();
  const usedFor = (il: string) => {
    let u = used.get(il);
    if (!u) used.set(il, (u = new Set()));
    return u;
  };
  type P = { si: number; e: InsertEntity; il: string; inst: string; loc: string };
  const parents: P[] = [];
  sheets.forEach((s, si) => {
    const list = s.doc.entities.filter((e): e is InsertEntity => isParentComponent(e)).sort(byLadder);
    for (const e of list) {
      const c = codes(e, s);
      parents.push({ si, e, il: instLoc({ INST: c.inst, LOC: c.loc }), ...c });
    }
  });
  for (const p of parents) if (isFixedTag(p.e) && p.e.attributes.TAG1) usedFor(p.il).add(p.e.attributes.TAG1);
  const todo: P[] = [];
  for (const p of parents) {
    if (isFixedTag(p.e)) continue;
    const t = p.e.attributes.TAG1 ?? '';
    if (mode === 'duplicates' && t && !usedFor(p.il).has(t)) usedFor(p.il).add(t);
    else todo.push(p);
  }
  const changes = new Map<number, Map<string, string>>();
  const setChange = (si: number, id: string, tag: string) => {
    let m = changes.get(si);
    if (!m) changes.set(si, (m = new Map()));
    m.set(id, tag);
  };
  // Children follow their parent: the same-sheet parent first, then a parent that kept the tag, then a renamed one elsewhere.
  const moved = new Map<string, Map<number, string>>();
  const renamed: ProjectRetagPlan['renamed'] = [];
  for (const p of todo) {
    const s = sheets[p.si]!;
    const t = nextTag(usedFor(p.il), tagPrefix(p.e.block), nearestReference(s.doc, p.e.position), { ...s.settings, iecInstallation: p.inst, iecLocation: p.loc });
    usedFor(p.il).add(t);
    const old = p.e.attributes.TAG1 ?? '';
    if (old === t) continue;
    setChange(p.si, p.e.id, t);
    renamed.push({ sheet: s.name, from: old, to: t });
    if (old) {
      const k = xkey(old, p.inst, p.loc);
      const m = moved.get(k) ?? new Map<number, string>();
      if (!m.has(p.si)) m.set(p.si, t);
      moved.set(k, m);
    }
  }
  const stayed = new Map<string, Set<number>>();
  for (const p of parents) {
    if (changes.get(p.si)?.has(p.e.id) || !p.e.attributes.TAG1) continue;
    const k = xkey(p.e.attributes.TAG1, p.inst, p.loc);
    stayed.set(k, (stayed.get(k) ?? new Set()).add(p.si));
  }
  sheets.forEach((s, si) => {
    for (const e of s.doc.entities) {
      if (e.type !== 'insert' || !(isChild(e) || isExtraPole(e)) || !e.attributes.TAG1) continue;
      const c = codes(e, s);
      const k = xkey(e.attributes.TAG1, c.inst, c.loc);
      const m = moved.get(k);
      if (!m) continue;
      const kept = stayed.get(k);
      const tag = kept?.has(si) ? undefined : (m.get(si) ?? (kept && kept.size ? undefined : m.values().next().value));
      if (tag && tag !== e.attributes.TAG1) setChange(si, e.id, tag);
    }
  });
  let count = 0;
  for (const m of changes.values()) count += m.size;
  return { changes, renamed, count };
}

/** Drawing state with new TAG1 values (insert id -> tag). Pure. */
export function withTags(state: DrawingState, tags: ReadonlyMap<string, string>): DrawingState {
  if (tags.size === 0) return state;
  return { ...state, entities: state.entities.map((e) => (e.type === 'insert' && tags.has(e.id) ? { ...e, attributes: { ...e.attributes, TAG1: tags.get(e.id)! } } : e)) };
}

// ------------------------------------------------------------ wire numbers

export interface ProjectWireOptions {
  /** Sequential numbering starts at sheet x step (sheet 3 -> 300) instead of the drawing's WIRE_START. */
  perSheet?: boolean;
  step?: number;
}

/**
 * Project-wide AEWIRENO: numbers unique across all sheets. Every fixed wire
 * number of the project is reserved first; each sheet then numbers its nets
 * with its own mode / format (%S = sheet) and, optionally, a sheet-based
 * sequential start. Returns the new wire number texts per sheet index.
 */
export function planProjectWireNumbers(sheets: readonly ProjectSheet[], o: ProjectWireOptions = {}): Map<number, TextEntity[]> {
  const used = new Set<string>();
  for (const s of sheets) for (const t of fixedWireNumbers(s.doc.entities)) used.add(t);
  const out = new Map<number, TextEntity[]>();
  sheets.forEach((s, si) => {
    const n = parseInt(s.sheet, 10);
    const start = o.perSheet ? (Number.isFinite(n) ? n : si + 1) * (o.step ?? 100) : s.settings.wireStart;
    out.set(si, planWireNumbers(s.doc.entities, { start, position: s.settings.wirePosition, format: s.settings.wireFormat, mode: s.settings.wireMode, sheet: s.sheet, used, unitScale: drawingUnitScale(s.doc) }));
  });
  return out;
}

export { withWireNumbers };

// ------------------------------------------------------------ location view

export interface LocationRow {
  inst: string;
  loc: string;
  tag: string;
  description: string;
  block: string;
  family: string;
  kind: 'device' | 'contact' | 'pole' | 'terminal';
  mfg: string;
  cat: string;
  /** Jumpers of a terminal (see cables.ts), e.g. "J1 > 3". */
  jumpers: string;
  drawing: string;
  sheet: string;
  ref: string;
  sheetIndex: number;
  entityId: string;
  position: Point;
}

export interface LocationGroup {
  inst: string;
  loc: string;
  /** "+INST-LOC", or "(no location)" */
  label: string;
  rows: LocationRow[];
  /** Devices counted once (parents and terminals; contacts and extra poles are not counted). */
  devices: number;
}

const NO_LOCATION = '(no location)';

/**
 * Location View: every component of the project grouped by installation and
 * location code (the component's INST / LOC, else the drawing default).
 * `jumperText` lets the terminal rows show their jumpers.
 */
export function locationView(sheets: readonly ProjectSheet[], opts: { includeContacts?: boolean; jumperText?: (e: InsertEntity, all: readonly Entity[]) => string } = {}): LocationGroup[] {
  const groups = new Map<string, LocationGroup>();
  sheets.forEach((s, si) => {
    for (const e of s.doc.entities) {
      if (!isComponent(e)) continue;
      const child = isChild(e);
      const pole = isExtraPole(e);
      if ((child || pole) && opts.includeContacts === false) continue;
      const c = codes(e, s);
      const k = `${c.inst}\u0001${c.loc}`;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { inst: c.inst, loc: c.loc, label: instLoc({ INST: c.inst, LOC: c.loc }) || NO_LOCATION, rows: [], devices: 0 }));
      const term = isTerminal(e);
      const kind: LocationRow['kind'] = term ? 'terminal' : child ? 'contact' : pole ? 'pole' : 'device';
      if (kind === 'device' || kind === 'terminal') g.devices += 1;
      g.rows.push({
        inst: c.inst,
        loc: c.loc,
        tag: term && !e.attributes.TAG1 ? `${e.attributes.TAGSTRIP || 'TB'}:${e.attributes.TERM01 ?? ''}` : (e.attributes.TAG1 ?? ''),
        description: descriptionOf(e.attributes),
        block: e.block,
        family: tagPrefix(e.block),
        kind,
        mfg: e.attributes.MFG ?? '',
        cat: e.attributes.CAT ?? '',
        jumpers: term && opts.jumperText ? opts.jumperText(e, s.doc.entities) : '',
        drawing: s.name,
        sheet: s.sheet,
        ref: nearestReference(s.doc, e.position) ?? '',
        sheetIndex: si,
        entityId: e.id,
        position: e.position,
      });
    }
  });
  const list = [...groups.values()];
  for (const g of list) g.rows.sort((a, b) => a.tag.localeCompare(b.tag, undefined, { numeric: true }) || a.sheetIndex - b.sheetIndex || a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  return list.sort((a, b) => (a.label === NO_LOCATION ? 1 : 0) - (b.label === NO_LOCATION ? 1 : 0) || a.inst.localeCompare(b.inst) || a.loc.localeCompare(b.loc));
}

/** Location View as a report (one row per component, grouped rows first by location) for CSV / table output. */
export function locationViewReport(groups: readonly LocationGroup[], filter?: string): Report {
  const rows: string[][] = [];
  for (const g of groups) {
    if (filter && g.label !== filter) continue;
    for (const r of g.rows) rows.push([r.inst, r.loc, r.tag, r.kind, r.description, r.mfg, r.cat, r.jumpers, r.drawing, r.sheet, r.ref]);
  }
  return { title: 'Location View', columns: ['Installation', 'Location', 'Tag', 'Type', 'Description', 'Manufacturer', 'Catalog', 'Jumpers', 'Drawing', 'Sheet', 'Rung'], rows };
}

/** Installation / location codes used on one sheet (for the Project Manager). */
export function sheetCodes(sheet: ProjectSheet): { inst: string[]; loc: string[] } {
  const inst = new Set<string>();
  const loc = new Set<string>();
  for (const e of sheet.doc.entities) {
    if (!isComponent(e)) continue;
    const c = codes(e, sheet);
    if (c.inst) inst.add(c.inst);
    if (c.loc) loc.add(c.loc);
  }
  return { inst: [...inst].sort(), loc: [...loc].sort() };
}

// ------------------------------------------------------ project status cache

/** What the Project Manager shows per drawing after a project-wide command ran (keyed by resolved path or name). */
export interface SheetStatus {
  inst: string[];
  loc: string[];
  /** Unresolved children / duplicate parents found by the last project-wide AEXREF (undefined = not run). */
  xrefIssues?: number;
  xrefTime?: string;
}

export const projectStatus = new Map<string, SheetStatus>();

/** Remember codes (and cross-reference problems when given) for the sheets. */
export function recordProjectStatus(sheets: readonly ProjectSheet[], problems?: readonly XrefProblem[]): void {
  const time = new Date().toLocaleTimeString();
  for (const s of sheets) {
    const key = s.path ?? s.name;
    const prev = projectStatus.get(key);
    const st: SheetStatus = { ...prev, ...sheetCodes(s) };
    if (problems) {
      st.xrefIssues = problems.filter((p) => p.sheet === s.name && p.kind !== 'no-children').length;
      st.xrefTime = time;
    }
    projectStatus.set(key, st);
  }
}
