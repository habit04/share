/** CTB/STB values are plot-time inputs; they do not change drawing entity properties. */
export interface PlotStyleRawSection {
  readonly [key: string]: string | PlotStyleRawSection;
}

export interface PlotStyleIssue {
  readonly path: string;
  readonly message: string;
}

export interface PlotStyleEntry {
  readonly index: number;
  readonly name: string;
  readonly localizedName: string;
  readonly description: string;
  /** Native signed colour words, kept separately because mode_color can carry the actual RGB. */
  readonly color: number;
  readonly modeColor?: number;
  readonly colorPolicy: number;
  readonly physicalPenNumber: number;
  readonly virtualPenNumber: number;
  readonly screening: number;
  readonly linepatternSize: number;
  readonly linetype: number;
  readonly adaptiveLinetype: boolean;
  readonly lineweightIndex: number;
  readonly fillStyle: number;
  readonly endStyle: number;
  readonly joinStyle: number;
  readonly issues: readonly PlotStyleIssue[];
}

export interface PlotStyleTable {
  readonly kind: 'ctb' | 'stb';
  readonly description: string;
  readonly styles: readonly PlotStyleEntry[];
  /** Native table values are always millimetres, even with inch display units. Index 0 means object. */
  readonly lineweightsMm: readonly number[];
  readonly scaleFactor: number;
  readonly applyFactor: boolean;
  readonly lineweightDisplayUnits: 0 | 1;
  /** Bounded, immutable source tree including unsupported properties and numeric annotations. */
  readonly raw: PlotStyleRawSection;
  /** Table-wide issues; individual entry issues are returned only when that entry is used. */
  readonly issues: readonly PlotStyleIssue[];
}

export interface PlotStyleObject {
  readonly rgb: readonly [number, number, number];
  /** Resolved ACI 1..255. Absent for explicit or layer-inherited TrueColor, which bypasses CTB. */
  readonly aci?: number;
  readonly lineweightMm: number;
  /** Resolved named style after ByLayer/ByBlock handling. Omitted uses STB Normal. */
  readonly plotStyleName?: string;
}

export interface ResolvedPlotStyle {
  readonly rgb: readonly [number, number, number];
  readonly lineweightMm: number;
  readonly applied: boolean;
  readonly styleName?: string;
  readonly issues: readonly PlotStyleIssue[];
}

const OBJECT_COLORS = new Set([-1, -1006632961, 0xffffffff, 0xc3ffffff]);

/** Decode supported native RGB colour words. Unknown colour models are preserved and reported. */
function styleRgb(style: PlotStyleEntry): readonly [number, number, number] | null | undefined {
  // The native object's colour sentinels take priority even when mode_color is present.
  // mode_color carries the actual RGB only for an explicit colour override.
  if (OBJECT_COLORS.has(style.color)) return null;
  const color = style.modeColor ?? style.color;
  if (OBJECT_COLORS.has(color)) return undefined;
  const tag = color >>> 24;
  // Native older CTBs use FF; newer mode_color values and STBs use C2/C3 RGB words.
  if (tag !== 0xff && tag !== 0xc2 && tag !== 0xc3) return undefined;
  return [((color >>> 16) & 255) / 255, ((color >>> 8) & 255) / 255, (color & 255) / 255];
}

/** Apply the verified colour/screening/grayscale/lineweight subset without editing an object. */
export function resolvePlotStyle(
  table: PlotStyleTable,
  object: PlotStyleObject,
  options: { readonly usePlotStyles?: boolean; readonly plotLineweights?: boolean } = {},
): ResolvedPlotStyle {
  const unchanged = (issues: readonly PlotStyleIssue[] = []): ResolvedPlotStyle => ({
    rgb: object.rgb,
    lineweightMm: options.plotLineweights === false ? 0 : object.lineweightMm,
    applied: false,
    issues,
  });
  if (options.usePlotStyles === false) return unchanged();
  if (table.kind === 'ctb' && object.aci === undefined) return unchanged();
  let style: PlotStyleEntry | undefined;
  if (table.kind === 'ctb') {
    if (!Number.isInteger(object.aci) || object.aci! < 1 || object.aci! > 255) {
      return unchanged([{ path: 'object.aci', message: 'Resolve ByLayer/ByBlock to ACI 1..255 before applying a CTB.' }]);
    }
    style = table.styles[object.aci! - 1];
  } else {
    const name = object.plotStyleName ?? 'Normal';
    style = table.styles.find((entry) => entry.name === name);
    if (!style) return unchanged([{ path: 'object.plotStyleName', message: `Named plot style ${JSON.stringify(name)} is absent; object properties are used.` }]);
    // Normal is immutable in native STBs and never overrides object properties.
    if (style.index === 0) return unchanged([...table.issues, ...style.issues]);
  }
  if (!style) return unchanged([{ path: 'plot_style', message: 'Requested plot style is absent; object properties are used.' }]);
  const issues = [...table.issues, ...style.issues];
  const override = styleRgb(style);
  let rgb = override ?? object.rgb;
  if (override === undefined) issues.push({ path: `plot_style.${style.index}.color`, message: 'Unsupported plot colour model; object colour is used.' });
  if (style.colorPolicy & 2) {
    const y = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    rgb = [y, y, y];
  }
  // Autodesk documents that screening requires dithering. PDF/Canvas retain continuous colour;
  // physical pen-device palette quantisation is a separate, reported capability.
  if (style.colorPolicy & 1 && style.screening !== 100) {
    const s = style.screening / 100;
    rgb = [1 - (1 - rgb[0]) * s, 1 - (1 - rgb[1]) * s, 1 - (1 - rgb[2]) * s];
  }
  const lineweightMm = options.plotLineweights === false ? 0 : style.lineweightIndex === 0 ? object.lineweightMm : table.lineweightsMm[style.lineweightIndex]!;
  return { rgb, lineweightMm, applied: true, styleName: style.name, issues };
}
