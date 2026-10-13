/**
 * DIMSTYLE table records and the header $DIM* variables, in both directions: the record XDATA and
 * header variables the writer emits, the reader's record parser (arrowheads from JCAD_DIMSTYLE
 * XDATA or from BLOCK_RECORD handles) and the current style read from the header.
 */
import type { DimStyle, Entity } from '../../core/entities';
import { resolveDimStyle, arrowBlockName, arrowFromBlockName, namedDimStyles, DIM_VARIABLES, dimVarValue, withDimVars, dimStyleFromRecordPairs, STANDARD_DIMSTYLE } from '../../core/dimension';
import type { Pair, Obj } from './groups';
import type { DrawingState } from '../../core/document';
import { str, xdata } from './groups';
import { DIMSTYLE_APP } from './codes';

export function dimStyleXdata(s: DimStyle): Array<[string, string]> {
  const r = resolveDimStyle(s);
  const block = (a: typeof r.arrow) => arrowBlockName(a) || '.';
  const out: Array<[string, string]> = [
    ['DIMBLK1', block(r.arrow)],
    ['DIMBLK2', block(r.arrow2)],
  ];
  if (r.tolerance === 'basic') out.push(['TOLERANCE', 'basic']);
  if (r.altPlacement === 'below') out.push(['ALTPLACEMENT', 'below']);
  return out;
}

/** Apply JCAD_DIMSTYLE XDATA pairs (see DIMSTYLE_APP) to a style read from its record. */
export function applyDimStyleXdata(s: DimStyle, xd: readonly Pair[]): DimStyle {
  let out = s;
  const strs = xd.filter((p) => p.code === 1000).map((p) => p.value);
  for (let k = 0; k + 1 < strs.length; k += 2) {
    const key = strs[k]!.toUpperCase();
    const value = strs[k + 1]!;
    if (key === 'DIMBLK1') out = { ...out, arrow: arrowFromBlockName(value) };
    else if (key === 'DIMBLK2') out = { ...out, arrow2: arrowFromBlockName(value) };
    else if (key === 'TOLERANCE' && ['none', 'symmetrical', 'deviation', 'limits', 'basic'].includes(value)) out = { ...out, tolerance: value as DimStyle['tolerance'] };
    else if (key === 'ALTPLACEMENT' && (value === 'below' || value === 'after')) out = { ...out, altPlacement: value };
  }
  if (out.arrow2 !== undefined && out.arrow2 === (out.arrow ?? 'closed-filled')) out = { ...out, arrow2: undefined };
  return out;
}

/** Styles for the DIMSTYLE table: the drawing's named styles plus any a dimension uses that is not named. */
export function dimStylesToWrite(state: DrawingState, entities: readonly Entity[] = state.entities): DimStyle[] {
  const out = namedDimStyles(state);
  const seen = new Set(out.map((s) => s.name.toUpperCase()));
  for (const e of entities)
    if (e.type === 'dimension' && !seen.has(e.style.name.toUpperCase())) {
      seen.add(e.style.name.toUpperCase());
      out.push(e.style);
    }
  return out;
}

/** Header $DIM* variables of the current style: [name, group code, value]. */
export function dimHeaderVars(s: DimStyle): Array<[string, number, number | string]> {
  const out: Array<[string, number, number | string]> = [];
  for (const v of DIM_VARIABLES) out.push([v.name, v.headerCode, dimVarValue(s, v.name)]);
  out.push(['DIMBLK', 1, dimVarValue(s, 'DIMBLK')], ['DIMSAH', 70, dimVarValue(s, 'DIMSAH')], ['DIMTOL', 70, dimVarValue(s, 'DIMTOL')], ['DIMLIM', 70, dimVarValue(s, 'DIMLIM')], ['DIMTIH', 70, dimVarValue(s, 'DIMTIH')], ['DIMTOH', 70, dimVarValue(s, 'DIMTOH')], ['DIMZIN', 70, dimVarValue(s, 'DIMZIN')]);
  return out;
}

/** The current style: header $DIM* variables applied over `base` (the named record of the same name, or Standard). */
export function dimStyleFromHeader(headerVars: ReadonlyMap<string, Pair[]>, base: DimStyle): DimStyle {
  const val = (name: string): string | undefined => headerVars.get(`$${name}`)?.[0]?.value;
  return withDimVars({ ...base, name: val('DIMSTYLE') || base.name }, val);
}

/**
 * A DIMSTYLE table record: its DIM* group codes through dimStyleFromRecordPairs, arrowheads
 * from JCAD_DIMSTYLE XDATA or, for other programs' files, the 342/343/344 handles of arrow
 * blocks, named by the BLOCK_RECORD table among `tables` (the TABLES section's objects).
 */
export function readDimStyleRecord(o: Obj, tables: readonly Obj[]): DimStyle {
  const end = o.groups.findIndex((p) => p.code === 1001);
  const own = end < 0 ? o.groups : o.groups.slice(0, end);
  const name = str(o, 2) || 'Standard';
  let s = dimStyleFromRecordPairs(
    name,
    own.map((p) => [p.code, p.value] as const),
    STANDARD_DIMSTYLE,
  );
  // DIMTXSTY: the STYLE record whose handle group 340 names.
  const textStyleHandle = own.find((p) => p.code === 340)?.value?.toUpperCase();
  const textStyleRecord = textStyleHandle ? tables.find((t) => t.kind === 'STYLE' && str(t, 5).toUpperCase() === textStyleHandle) : undefined;
  if (textStyleRecord) s = { ...s, textStyle: str(textStyleRecord, 2, 'Standard') };
  if (s.scale === 0) s = { ...s, scale: 1 };
  const xd = xdata(o, DIMSTYLE_APP);
  if (xd) return applyDimStyleXdata(s, xd);
  const block = (code: number): string | undefined => {
    const h = own.find((p) => p.code === code)?.value?.toUpperCase();
    const rec = h ? tables.find((t) => t.kind === 'BLOCK_RECORD' && str(t, 5).toUpperCase() === h) : undefined;
    return rec ? str(rec, 2) : undefined;
  };
  const sah = Number(own.find((p) => p.code === 173)?.value ?? 0) !== 0;
  const b1 = sah ? block(343) : block(342);
  const b2 = sah ? block(344) : undefined;
  if (b1 !== undefined) s = { ...s, arrow: arrowFromBlockName(b1) };
  if (b2 !== undefined) s = { ...s, arrow2: arrowFromBlockName(b2) };
  return s;
}
