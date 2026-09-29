/**
 * Title block attribute mapping. AutoCAD Electrical maps project
 * description lines and drawing properties onto title block attributes
 * with a .wdt text file; this module reads and writes the same simple
 * format and applies it:
 *
 *   ; comment
 *   BLOCK = WD_TITLEBLOCK, MY_TB        (optional: title block names)
 *   CLIENT = LINE2                       (attribute = source code)
 *   TITLE = DWGDESC|PROJDESC             (first non-empty source)
 *   SHEET = %SHEET% OF %SHEETMAX%        (template with %CODE% fields)
 *   REVBY = "JD"                         (literal text)
 *
 * Source codes: LINE1..LINEn (project description lines, also by their
 * names PROJECT, CUSTOMER, JOB, DRAWN, CHECKED, APPROVED), PROJ (project
 * name), PROJDESC, DWGDESC, DWGNO (alias DWGNAM), SHEET, SHEETMAX, DATE,
 * REV, SEC, FILENAME, IEC_PROJ, IEC_INST, IEC_LOC.
 */
import type { DrawingState } from '../core/document';
import type { InsertEntity } from '../core/entities';
import { DESCRIPTION_LINES, baseName, type Project } from '../app/project';
import type { WdSettings } from './wdm';

export interface TitleBlockMapEntry {
  attribute: string;
  source: string;
}

export interface TitleBlockMapping {
  /** Title block names (BLOCK = ...); empty = the built-in WD_TITLEBLOCK or any block that defines mapped attributes. */
  blocks: string[];
  entries: TitleBlockMapEntry[];
}

/** Built-in mapping: the same fields titleBlockFields() fills, as .wdt text. */
export const DEFAULT_WDT = [
  '; Title block mapping (AutoCAD Electrical .wdt format): ATTRIBUTE = SOURCE',
  'BLOCK = WD_TITLEBLOCK',
  'PROJECT = LINE1|PROJ',
  'CUSTOMER = LINE2',
  'JOB = LINE3',
  'DRAWN = LINE4',
  'CHECKED = LINE5',
  'APPROVED = LINE6',
  'TITLE = DWGDESC|PROJDESC',
  'DWGNO = DWGNO|FILENAME',
  'SHEET = %SHEET% OF %SHEETMAX%',
  'DATE = DATE',
  'REV = REV',
].join('\n');

/** Parse .wdt text (unknown lines are ignored; attribute names are upper-cased). */
export function parseWdt(text: string): TitleBlockMapping {
  const out: TitleBlockMapping = { blocks: [], entries: [] };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const attr = line.slice(0, eq).trim().toUpperCase();
    const source = line.slice(eq + 1).trim();
    if (!attr) continue;
    if (attr === 'BLOCK') {
      out.blocks.push(...source.split(',').map((b) => b.trim()).filter(Boolean));
      continue;
    }
    const i = out.entries.findIndex((e) => e.attribute === attr);
    if (i >= 0) out.entries[i] = { attribute: attr, source };
    else out.entries.push({ attribute: attr, source });
  }
  return out;
}

/** .wdt text for a mapping. */
export function formatWdt(m: TitleBlockMapping): string {
  const lines = ['; Title block mapping (AutoCAD Electrical .wdt format): ATTRIBUTE = SOURCE'];
  if (m.blocks.length) lines.push(`BLOCK = ${m.blocks.join(', ')}`);
  for (const e of m.entries) lines.push(`${e.attribute} = ${e.source}`);
  return lines.join('\n') + '\n';
}

/** The project's mapping (its titleBlockMap text, else the built-in one). */
export function projectMapping(project: Pick<Project, 'titleBlockMap'>): TitleBlockMapping {
  const m = parseWdt(project.titleBlockMap?.trim() ? project.titleBlockMap : DEFAULT_WDT);
  return m.entries.length ? m : parseWdt(DEFAULT_WDT);
}

/**
 * Source values for one drawing: project lines and name, the project
 * drawing entry (description, sheet, number, revision, date) with the
 * drawing's own WD_M settings as fallback.
 */
export function titleBlockSources(project: Project, drawingIndex: number, wd?: Pick<WdSettings, 'sheet' | 'drawingNumber' | 'drawingDescription' | 'iecProject' | 'iecInstallation' | 'iecLocation'>, fileName = '', today = new Date().toISOString().slice(0, 10)): Record<string, string> {
  const v: Record<string, string> = {};
  const lines = project.descriptions ?? [];
  const n = Math.max(lines.length, DESCRIPTION_LINES.length);
  for (let i = 0; i < n; i += 1) {
    v[`LINE${i + 1}`] = lines[i] ?? '';
    if (DESCRIPTION_LINES[i]) v[DESCRIPTION_LINES[i]!] = lines[i] ?? '';
  }
  const d = drawingIndex >= 0 ? project.drawings[drawingIndex] : undefined;
  v.PROJ = project.name;
  v.PROJDESC = project.description ?? '';
  v.DWGDESC = d?.description || wd?.drawingDescription || '';
  const file = d ? baseName(d.file) : fileName;
  v.FILENAME = file.replace(/\.[^.]+$/, '');
  v.DWGNO = d?.dwgno || wd?.drawingNumber || '';
  v.DWGNAM = v.DWGNO;
  v.SHEET = d?.sheet || (drawingIndex >= 0 ? String(drawingIndex + 1) : wd?.sheet || '1');
  v.SHEETMAX = String(Math.max(1, project.drawings.length));
  v.DATE = d?.date || today;
  v.REV = d?.rev ?? '';
  v.SEC = d?.section ?? '';
  v.IEC_PROJ = wd?.iecProject ?? project.settings?.iecProject ?? '';
  v.IEC_INST = wd?.iecInstallation ?? project.settings?.installation ?? '';
  v.IEC_LOC = wd?.iecLocation ?? project.settings?.location ?? '';
  return v;
}

/** Evaluate one source expression: alternatives "A|B", templates "%A% OF %B%", literals "text". */
export function evalSource(source: string, values: Readonly<Record<string, string>>): string {
  for (const alt of source.split('|')) {
    const a = alt.trim();
    let out: string;
    if (/^".*"$/.test(a) || /^'.*'$/.test(a)) out = a.slice(1, -1);
    else if (a.includes('%')) {
      let any = false;
      out = a.replace(/%([A-Z0-9_]+)%/gi, (_m, k: string) => {
        const val = values[k.toUpperCase()] ?? '';
        if (val) any = true;
        return val;
      });
      if (!any) out = '';
    } else out = values[a.toUpperCase()] ?? '';
    if (out) return out;
  }
  return '';
}

/** Attribute values from a mapping (attribute -> value, '' when every source is empty). */
export function mappedValues(m: TitleBlockMapping, values: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of m.entries) out[e.attribute] = evalSource(e.source, values);
  return out;
}

/** Title block inserts of a drawing for a mapping. */
export function titleBlockInserts(state: DrawingState, m: TitleBlockMapping): InsertEntity[] {
  const mapped = new Set(m.entries.map((e) => e.attribute));
  return state.entities.filter((e): e is InsertEntity => {
    if (e.type !== 'insert') return false;
    if (m.blocks.length) return m.blocks.some((b) => b.toUpperCase() === e.block.toUpperCase());
    if (e.block === 'WD_TITLEBLOCK') return true;
    const def = state.blocks[e.block];
    return !!def && def.attributes.filter((a) => mapped.has(a.tag)).length >= 2 && !e.attributes.TAG1;
  });
}

/**
 * Write mapped values into the title block(s) of a drawing state (only
 * attributes the block defines). Returns the new state and how many title
 * blocks were found / changed; the state is unchanged when nothing differs.
 */
export function applyTitleBlockMapping(state: DrawingState, m: TitleBlockMapping, values: Readonly<Record<string, string>>): { state: DrawingState; found: number; changed: number } {
  const fields = mappedValues(m, values);
  const tbs = titleBlockInserts(state, m);
  let changed = 0;
  const rep = new Map<string, InsertEntity>();
  for (const tb of tbs) {
    const def = state.blocks[tb.block];
    const allowed = new Set(def?.attributes.map((a) => a.tag) ?? Object.keys(tb.attributes));
    const attrs = { ...tb.attributes };
    let diff = false;
    for (const [k, v] of Object.entries(fields)) {
      // Empty sources never clear a value typed into the title block by hand.
      if (!v || !allowed.has(k) || (attrs[k] ?? '') === v) continue;
      attrs[k] = v;
      diff = true;
    }
    if (diff) {
      changed += 1;
      rep.set(tb.id, { ...tb, attributes: attrs });
    }
  }
  if (!changed) return { state, found: tbs.length, changed };
  return { state: { ...state, entities: state.entities.map((e) => rep.get(e.id) ?? e) }, found: tbs.length, changed };
}
