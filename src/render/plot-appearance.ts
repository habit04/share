import { expandInsert, expandInsertTraced, type BlockLookup, type EntityBase, type InsertEntity, type Layer } from '../core/entities';
import { resolvePlotStyle, type PlotStyleObject, type PlotStyleTable } from '../core/plot-styles';
import { aciToCss } from './palette';

export type PlotAppearanceInput = Pick<EntityBase, 'layer' | 'color' | 'trueColor' | 'colorLayer' | 'lineWeight'>;
export interface PlotAppearanceOptions {
  readonly usePlotStyles?: boolean;
  readonly lineweights?: boolean;
  /** An explicit whole-plot STB selection; imported native assignments need reference integration. */
  readonly namedStyle?: string;
}

/** Keep ACI identity through ByLayer/ByBlock resolution; RGB proximity cannot identify a CTB slot. */
export function plotObjectProperties(entity: PlotAppearanceInput, layers: readonly Layer[], inheritedLineweightMm?: number): PlotStyleObject {
  const layer = layers.find((entry) => entry.name === entity.layer);
  const colorLayer = entity.colorLayer === undefined ? layer : layers.find((entry) => entry.name === entity.colorLayer);
  const trueColor = entity.trueColor ?? (entity.color === 'ByLayer' ? colorLayer?.trueColor : undefined);
  const index = entity.color === 'ByLayer' ? colorLayer?.color ?? 7 : entity.color || 7;
  const aci = index >= 1 && index <= 255 ? index : 7;
  const css = aci === 7 ? '#000000' : aciToCss(aci);
  const rgb: readonly [number, number, number] = trueColor === undefined
    ? [parseInt(css.slice(1, 3), 16) / 255, parseInt(css.slice(3, 5), 16) / 255, parseInt(css.slice(5, 7), 16) / 255]
    : [((trueColor >>> 16) & 255) / 255, ((trueColor >>> 8) & 255) / 255, (trueColor & 255) / 255];
  const width = entity.lineWeight === -2 ? inheritedLineweightMm ?? 0.25 : entity.lineWeight === -3 ? 0.25 : entity.lineWeight;
  const lineweightMm = width !== undefined && width >= 0 ? width : Math.max(0, layer?.lineWeight ?? 0.25);
  return { rgb, ...(trueColor === undefined ? { aci } : {}), lineweightMm };
}

/** Shared vector/raster interpretation leaves the source entity and table untouched. */
export function plotEntityAppearance(entity: PlotAppearanceInput, layers: readonly Layer[], table: PlotStyleTable, options: PlotAppearanceOptions, inheritedLineweightMm?: number) {
  return resolvePlotStyle(table, { ...plotObjectProperties(entity, layers, inheritedLineweightMm), plotStyleName: options.namedStyle },
    { usePlotStyles: options.usePlotStyles, plotLineweights: options.lineweights });
}

export function plotRgbCss(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((component) => Math.max(0, Math.min(255, Math.round(component * 255))).toString(16).padStart(2, '0')).join('')}`;
}

/** Resolve nested source ByBlock widths during uncached expansion, before any CTB override. */
export function expandPlotInsert(insert: InsertEntity, lookup: BlockLookup, layers: readonly Layer[]) {
  return expandInsert(insert, lookup, undefined, (parent) => plotObjectProperties(parent, layers).lineweightMm).entities;
}

/** expandPlotInsert with per-entity provenance (design A.2), for plot painters resolving layer state per source file. */
export function expandPlotInsertSourced(insert: InsertEntity, lookup: BlockLookup, layers: readonly Layer[]) {
  return expandInsertTraced(insert, lookup, (parent) => plotObjectProperties(parent, layers).lineweightMm).entities;
}
