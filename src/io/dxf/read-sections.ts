/**
 * The section readers, one per DXF section: HEADER ($ variables, the current dimension style,
 * the drawing dates and the DrawingHeader built from them), TABLES (LAYER, LTYPE, DIMSTYLE, STYLE,
 * VIEW), BLOCKS (block definitions with their ATTDEFs), ENTITIES (model space) and OBJECTS
 * (IMAGEDEF paths, layouts, object groups). reader.ts walks the sections in file order and calls
 * these; paper-space content goes to the layout reader (io/dxf-layouts.ts) on the way.
 */
import type { Pair, Obj } from './groups';
import type { ReadContext } from './read-core';
import { isRealCode, isRealText, isIntCode, PRECISION_NAMES, SUPPORTED_DIM_NAMES, PRECISION_CODES, isQuietXdataApp, UNSUPPORTED_DIM_CODES } from './codes';
import { isIntegerText, DxfReadError, shortText, invalidPrecision, precisionRequirement, str, num, has, pt, xdata } from './groups';
import { LAYER_TRANSPARENCY_APP, transparencyFromDxf, validColorName } from '../../core/appearance';
import { dimStyleFromHeader, readDimStyleRecord } from './dimstyles';
import { STANDARD_DIMSTYLE } from '../../core/dimension';
import { julianToDate } from '../../core/fields';
import type { DimStyle, BlockDef, Entity, Layer } from '../../core/entities';
import { LayoutReader } from '../dxf-layouts';
import { findLinetype } from '../../core/linetypes';
import { textStyleFromGroups } from '../encoding';
import { fontImportWarning } from '../font-warning';
import type { AttributeDefExt } from '../../electrical/symbol-builder-core';
import * as g from '../../core/geometry';
import { attdefFlagProps } from '../../electrical/symbol-builder-core';
import { readEntities } from './read-pass';
import { ImportReportBuilder } from '../import-report';
import type { Linetype, LinetypeShapeStyle } from '../../core/linetypes';
import { linetypeStyleRecords, hasComplexLinetypeData, readComplexLinetype, complexLinetypeWarning } from './complex-linetypes';
import type { NamedView, DrawingHeader } from '../../core/document';
import { DEFAULT_HEADER } from '../../core/document';
import type { LinearUnits } from '../../core/units';
import { isScaleName } from '../../core/layouts';
import type { TextStyle } from '../encoding';
import { readTextPlacement } from './read-text';
import { geometryProblem } from '../import-report';
import { commonProps } from './read-core';

export function readHeaderSection(pairs: Pair[], from: number, to: number, headerVars: Map<string, Pair[]>, ctx: ReadContext): string {
  let cur: Pair[] | null = null;
  for (let k = from; k < to; k += 1) {
    const q = pairs[k]!;
    if (q.code === 9) {
      cur = [];
      headerVars.set(q.value, cur);
    } else cur?.push(q);
  }
  for (const [variable, groups] of headerVars) {
    const invalid = groups.find((q) => isRealCode(q.code) ? !isRealText(q.value) || !Number.isFinite(Number(q.value)) : isIntCode(q.code) && !isIntegerText(q.value.trim()));
    if (invalid) throw new DxfReadError(`Line ${(invalid.line ?? 1) + 1}: ${variable} group ${invalid.code} contains an invalid number "${shortText(invalid.value)}".`, (invalid.line ?? 1) + 1);
    const value = groups[0];
    const name = variable.replace(/^\$/, '');
    if (value && PRECISION_NAMES.has(name) && invalidPrecision(name, value.value)) throw new DxfReadError(`Line ${(value.line ?? 1) + 1}: ${variable} precision "${shortText(value.value)}" must be ${precisionRequirement(name)}.`, (value.line ?? 1) + 1);
    if (value && name.startsWith('DIM') && !SUPPORTED_DIM_NAMES.has(name) && value.value !== '' && Number(value.value) !== 0) ctx.report?.add({ type: 'HEADER', action: 'simplified', reason: `${variable} is not modeled or written back; supported dimension variables are kept`, line: value.line });
  }
  const currentLayer = headerVars.get('$CLAYER')?.[0]?.value ?? '0';
  const hnum = (v: string, dflt: number) => {
    const raw = headerVars.get(v)?.[0]?.value;
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) ? n : dflt;
  };
  ctx.dimStyle = dimStyleFromHeader(headerVars, STANDARD_DIMSTYLE);
  const created = julianToDate(hnum('$TDCREATE', NaN));
  const saved = julianToDate(hnum('$TDUPDATE', NaN));
  ctx.fields = { ...(created ? { createDate: created } : {}), ...(saved ? { saveDate: saved } : {}), ...ctx.fields };
  return currentLayer;
}

export function readTablesSection(objs: Obj[], tables: TableRecords, dimStyles: Map<string, DimStyle>, headerVars: ReadonlyMap<string, Pair[]>, ctx: ReadContext, layoutReader: LayoutReader): void {
  const { layers, linetypes, views, textStyles } = tables;
  const report = ctx.report!;
  layoutReader.scanTables(objs);
  const complexStyles = linetypeStyleRecords(objs, tables.shapeStyles, report);
  for (const o of objs) {
    const invalid = o.groups.find((p) => isRealCode(p.code) ? !isRealText(p.value) || !Number.isFinite(Number(p.value)) : isIntCode(p.code) && !isIntegerText(p.value.trim()));
    if (invalid) { report.add({ type: o.kind, action: 'dropped', reason: `invalid numeric group ${invalid.code} at line ${(invalid.line ?? 1) + 1}: "${shortText(invalid.value)}"`, line: o.line }); continue; }
    const badPrecision = o.kind === 'DIMSTYLE' ? o.groups.find((p) => PRECISION_CODES[p.code] && invalidPrecision(PRECISION_CODES[p.code]!, p.value)) : undefined;
    if (badPrecision) { const name = PRECISION_CODES[badPrecision.code]!; report.add({ type: o.kind, action: 'dropped', reason: `invalid ${name} precision at line ${(badPrecision.line ?? 1) + 1}: "${shortText(badPrecision.value)}" must be ${precisionRequirement(name)}`, line: o.line }); continue; }
    if (o.kind === 'LAYER') {
      const name2 = str(o, 2);
      if (!name2) continue;
      const c = Math.trunc(num(o, 62, 7));
      const flags = Math.trunc(num(o, 70));
      const lt = str(o, 6);
      const tc = has(o, 420) ? Math.trunc(num(o, 420)) : NaN;
      const transparencyApp = o.groups.find((q) => q.code === 1001 && q.value.toLowerCase() === LAYER_TRANSPARENCY_APP.toLowerCase())?.value;
      const transparencyValue = transparencyApp ? xdata(o, transparencyApp)?.filter((q) => q.code === 1071).at(-1)?.value : undefined;
      const rawTransparency = transparencyValue !== undefined ? Number(transparencyValue) : has(o, 440) ? num(o, 440) : undefined;
      const transparency = transparencyFromDxf(rawTransparency);
      const colorName = str(o, 430);
      layers.push({
        ...(Number.isFinite(tc) ? { trueColor: tc & 0xffffff } : {}),
        ...(transparency !== undefined ? { transparency } : {}),
        ...(validColorName(colorName) ? { colorName } : {}),
        name: name2,
        color: Math.abs(c) || 7,
        visible: c >= 0 && (flags & 1) === 0, // negative colour = off, flag 1 = frozen
        frozen: (flags & 1) === 1 || undefined,
        locked: (flags & 4) === 4,
        ...(flags & 48 ? { xrefFlags: flags & 48 } : {}),
        // 370: hundredths of a millimetre; -3 (Default) and the entity-only -1 / -2 mean the default 0.25 mm.
        lineWeight: num(o, 370, 25) >= 0 ? num(o, 370, 25) / 100 : 0.25,
        ...(has(o, 290) && num(o, 290) === 0 ? { plot: false } : {}),
        linetype: lt && lt.toUpperCase() !== 'CONTINUOUS' ? lt : undefined,
      });
      const apps = o.groups.filter((q) => q.code === 1001 && !isQuietXdataApp(q.value) && q.value !== transparencyApp).map((q) => q.value);
      if (apps.length) report.add({ type: 'LAYER', action: 'simplified', reason: `layer extended metadata (${[...new Set(apps)].join(', ')}) is not kept`, ...(o.line ? { line: o.line } : {}) });
      if ((rawTransparency !== undefined || transparencyApp) && transparency === undefined) report.add({ type: 'LAYER', action: 'simplified', reason: 'invalid layer transparency is not kept; opaque is used', line: o.line });
      if (has(o, 430) && !validColorName(colorName)) report.add({ type: 'LAYER', action: 'simplified', reason: 'invalid named/color-book identity is not kept; RGB/ACI color is kept', line: o.line });
    } else if (o.kind === 'LTYPE') {
      const ltName = str(o, 2);
      if (hasComplexLinetypeData(o)) {
        const lt = readComplexLinetype(o, complexStyles);
        linetypes.push(lt);
        report.add({ type: 'LTYPE', action: 'kept', reason: complexLinetypeWarning(lt), ...(o.line ? { line: o.line } : {}) });
        const unknown = o.groups.filter((pair) => ![5, 330, 100, 2, 70, 3, 72, 73, 40, 49, 74, 75, 340, 46, 50, 44, 45, 9].includes(pair.code));
        if (unknown.length) report.add({ type: 'LTYPE', action: 'simplified', reason: `complex linetype "${lt.name}" extension metadata (groups ${[...new Set(unknown.map((pair) => pair.code))].join(', ')}) is not modeled; known descriptor fields are retained`, ...(o.line ? { line: o.line } : {}) });
        continue;
      }
      if (!ltName || /^(BYLAYER|BYBLOCK|CONTINUOUS)$/i.test(ltName)) continue;
      const pattern = o.groups.filter((x) => x.code === 49).map((x) => Number(x.value)).filter((v) => Number.isFinite(v));
      const std = findLinetype(ltName);
      if (std && std.pattern.length === pattern.length && std.pattern.every((v, k) => Math.abs(v - pattern[k]!) < 1e-9)) continue;
      linetypes.push({ name: ltName, description: str(o, 3), pattern });
    } else if (o.kind === 'DIMSTYLE') {
      const ds = readDimStyleRecord(o, objs);
      dimStyles.set(ds.name.toUpperCase(), ds);
      const unsupported = o.groups.filter((p) => UNSUPPORTED_DIM_CODES[p.code] && Number(p.value) !== 0).map((p) => UNSUPPORTED_DIM_CODES[p.code]);
      if (unsupported.length) report.add({ type: 'DIMSTYLE', action: 'simplified', reason: `${[...new Set(unsupported)].join(', ')} settings are not modeled or written back; supported style variables are kept`, ...(o.line ? { line: o.line } : {}) });
      const apps = o.groups.filter((p) => p.code === 1001 && !isQuietXdataApp(p.value)).map((p) => p.value);
      if (apps.length) report.add({ type: 'DIMSTYLE', action: 'simplified', reason: `extended style data (XDATA) of ${[...new Set(apps)].join(', ')} is not kept`, ...(o.line ? { line: o.line } : {}) });
    } else if (o.kind === 'STYLE') {
      const ts = textStyleFromGroups(o.groups);
      if (ts) textStyles[ts.name] = ts;
      if (ts && has(o, 5)) ctx.textStyleHandles!.set(str(o, 5).toUpperCase(), ts.name);
      const fontWarning = ts && fontImportWarning(ts);
      if (fontWarning) report.add({ type: 'STYLE', action: 'unsupported', reason: fontWarning, ...(o.line ? { line: o.line } : {}) });
    } else if (o.kind === 'VIEW') {
      const vname = str(o, 2);
      if (vname) views.push({ name: vname, center: pt(o, 10), height: num(o, 40, 10) || 10 });
    }
  }
  // The current style: header variables over the named record of the same name.
  const current = dimStyles.get(String(headerVars.get('$DIMSTYLE')?.[0]?.value ?? 'Standard').toUpperCase());
  if (current) ctx.dimStyle = dimStyleFromHeader(headerVars, current);
}

export function readBlocksSection(objs: Obj[], blocks: Record<string, BlockDef>, ctx: ReadContext, layoutReader: LayoutReader): void {
  let k = 0;
  while (k < objs.length) {
    const o = objs[k]!;
    if (o.kind !== 'BLOCK') {
      k += 1;
      continue;
    }
    let m = k + 1;
    while (m < objs.length && objs[m]!.kind !== 'ENDBLK') m += 1;
    const inner = objs.slice(k + 1, m);
    const attributes: AttributeDefExt[] = inner
      .filter((x) => x.kind === 'ATTDEF')
      .flatMap((x) => {
        const { id: _id, layer, ...appearance } = commonProps(x);
        const placement = { ...appearance, ...(has(x, 8) ? { layer } : {}), ...readTextPlacement(x, 74) };
        const problem = geometryProblem({ ...placement, id: 'attribute', type: 'text', layer: str(x, 8, '0'), color: 'ByLayer', text: str(x, 1) });
        if (problem) {
          ctx.report?.add({ type: 'ATTDEF', action: 'dropped', reason: `invalid attribute placement: ${problem}`, where: `block "${str(o, 2)}"`, ...(has(x, 5) ? { handle: str(x, 5) } : {}) });
          return [];
        }
        return [{
          tag: str(x, 2),
          prompt: str(x, 3),
          default: str(x, 1),
          ...placement,
          invisible: (Math.trunc(num(x, 70)) & 1) === 1,
          // constant / verify / preset (bits 2, 4, 8)
          ...attdefFlagProps(Math.trunc(num(x, 70))),
        }];
      });
    const bname = str(o, 2);
    const anonymousLayout = /^\*(MODEL_SPACE|PAPER_SPACE)/i.test(bname);
    const dimensionPicture = /^\*D\d*$/i.test(bname);
    if (bname && !anonymousLayout && !dimensionPicture) {
      ctx.where = `block "${bname}"`;
      blocks[bname] = {
        name: bname,
        basePoint: { x: num(o, 10), y: num(o, 20) },
        entities: readEntities(
          inner.filter((x) => x.kind !== 'ATTDEF'),
          ctx,
        ),
        attributes,
        description: str(o, 4) || undefined,
        ...((Math.trunc(num(o, 70)) & 4) === 4 ? { xref: { path: str(o, 1), ...((Math.trunc(num(o, 70)) & 8) === 8 ? { overlay: true } : {}) } } : {}),
      };
    }
    else if (anonymousLayout) layoutReader.layoutBlock(bname, inner);
    ctx.where = undefined;
    k = m + 1;
  }
}

export function readEntitiesSection(objs: Obj[], ctx: ReadContext, layoutReader: LayoutReader): Entity[] {
  ctx.where = 'model space';
  const entities = readEntities(layoutReader.splitEntities(objs), ctx, true);
  ctx.where = undefined;
  return entities;
}

export function readObjectsSection(objs: Obj[], imageDefs: Map<string, string>, layoutReader: LayoutReader, report: ImportReportBuilder): void {
  for (const o of objs) if (o.kind === 'IMAGEDEF' && has(o, 5)) imageDefs.set(str(o, 5).toUpperCase(), str(o, 1));
  layoutReader.scanObjects(objs);
  // Named object groups (GROUP command) are not modelled: the objects stay, the grouping goes.
  for (const o of objs) {
    if (o.kind !== 'GROUP') {
      if (!['SECTION', 'DICTIONARY', 'ACDBDICTIONARYWDFLT', 'ACDBPLACEHOLDER', 'LAYOUT', 'IMAGEDEF', 'IMAGEDEF_REACTOR', 'TABLESTYLE'].includes(o.kind)) report.add({ type: o.kind, action: 'dropped', reason: 'object metadata is not modeled or written back; linked drawing geometry is kept when supported', ...(has(o, 5) ? { handle: str(o, 5) } : {}), ...(o.line ? { line: o.line } : {}) });
      continue;
    }
    const desc = str(o, 300);
    report.add({ type: 'GROUP', action: 'dropped', reason: `object group${desc ? ` "${desc}"` : ''} is not kept (its objects are)`, ...(has(o, 5) ? { handle: str(o, 5) } : {}), ...(o.line ? { line: o.line } : {}) });
  }
}

export function drawingHeader(headerVars: ReadonlyMap<string, Pair[]>, dimStyle: DimStyle, linetypes: Linetype[], views: NamedView[]): DrawingHeader {
  const hnum = (v: string, dflt: number) => {
    const raw = headerVars.get(v)?.[0]?.value;
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) ? n : dflt;
  };
  const hpt = (v: string, dflt: g.Point): g.Point => {
    const grp = headerVars.get(v);
    if (!grp) return dflt;
    const x = grp.find((q) => q.code === 10);
    const y = grp.find((q) => q.code === 20);
    return x && y ? { x: Number(x.value), y: Number(y.value) } : dflt;
  };
  const lunits = Math.trunc(hnum('$LUNITS', DEFAULT_HEADER.units.lunits));
  const celweightRaw = Math.trunc(hnum('$CELWEIGHT', -1));
  const celtype = headerVars.get('$CELTYPE')?.[0]?.value || 'ByLayer';
  const header: DrawingHeader = {
    units: {
      lunits: (lunits >= 1 && lunits <= 5 ? lunits : 2) as LinearUnits,
      luprec: Math.max(0, Math.trunc(hnum('$LUPREC', DEFAULT_HEADER.units.luprec))),
      insunits: Math.trunc(hnum('$INSUNITS', DEFAULT_HEADER.units.insunits)),
      auprec: Math.max(0, Math.trunc(hnum('$AUPREC', 0))),
      ...(headerVars.has('$AUNITS') ? { aunits: hnum('$AUNITS', 0) } : {}),
    },
    ltscale: hnum('$LTSCALE', 1) || 1,
    ...(headerVars.has('$CELTSCALE') ? { celtscale: hnum('$CELTSCALE', 1) } : {}),
    ...(headerVars.has('$TEXTSTYLE') ? { textStyle: headerVars.get('$TEXTSTYLE')?.[0]?.value || 'Standard' } : {}),
    limits: { min: hpt('$LIMMIN', DEFAULT_HEADER.limits.min), max: hpt('$LIMMAX', DEFAULT_HEADER.limits.max) },
    pdmode: Math.trunc(hnum('$PDMODE', 0)),
    pdsize: hnum('$PDSIZE', 0),
    // Header DIM* variables over the named record of the current style.
    dimStyle,
    linetypes,
    views,
    celtype: /^BYLAYER$/i.test(celtype) ? 'ByLayer' : celtype,
    celweight: celweightRaw >= 0 ? celweightRaw / 100 : undefined,
    // A scale name ("1:4", "1/8\" = 1'-0\""): printable, short and without markup characters, or it is ignored.
    ...(isScaleName(headerVars.get('$CANNOSCALE')?.[0]?.value) ? { cannoscale: headerVars.get('$CANNOSCALE')![0]!.value } : {}),
    ...(hnum('$ANNOALLVISIBLE', 1) === 0 ? { annoAllVisible: false } : {}),
  };
  return header;
}

/** What the TABLES section adds to the drawing besides the dimension styles. */
export interface TableRecords {
  layers: Layer[];
  linetypes: Linetype[];
  views: NamedView[];
  textStyles: Record<string, TextStyle>;
  shapeStyles: Record<string, LinetypeShapeStyle>;
}
