import type { EntityBase, Layer } from './entities';

/** An opacity byte (0 transparent, 255 opaque), or CAD inheritance. */
export type TransparencySpec = 'ByLayer' | 'ByBlock' | number;
export const LAYER_TRANSPARENCY_APP = 'AcCmTransparency';

/** Serialized AcCmTransparency: method in the high byte, alpha in the low byte. */
export function transparencyFromDxf(value: unknown): TransparencySpec | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return undefined;
  if (value === 0) return 'ByLayer';
  if (value === 0x01000000) return 'ByBlock';
  if (value >= 0x02000000 && value <= 0x020000ff) return value - 0x02000000;
  return undefined;
}

export function transparencyToDxf(value: TransparencySpec): number {
  if (value === 'ByLayer') return 0;
  if (value === 'ByBlock') return 0x01000000;
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error('Transparency alpha must be an integer from 0 to 255.');
  return 0x02000000 + value;
}

/** Keep the supplied identity, including a color-book/name separator; no palette lookup. */
export function validColorName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2049 && !/[\r\n\0]/.test(value);
}

export function explicitAlpha(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255 ? value : undefined;
}

/** CAD inheritance chooses a source alpha; block-reference opacity is not multiplied. */
export function resolveAlpha(e: Pick<EntityBase, 'layer' | 'transparency' | 'transparencyLayer'>, layers: readonly Layer[]): number {
  const own = explicitAlpha(e.transparency);
  if (own !== undefined) return own / 255;
  if (e.transparency === 'ByBlock') return 1; // no enclosing block remains
  const layer = layers.find((item) => item.name === (e.transparencyLayer ?? e.layer));
  return (explicitAlpha(layer?.transparency) ?? 255) / 255;
}

export function inheritedTransparency(e: EntityBase, ins: EntityBase): Pick<EntityBase, 'transparency' | 'transparencyLayer'> {
  if (e.transparency !== 'ByBlock') return {
    ...(e.transparency !== undefined ? { transparency: e.transparency } : {}),
    ...(e.transparencyLayer !== undefined ? { transparencyLayer: e.transparencyLayer } : {}),
  };
  if (ins.transparency === undefined || ins.transparency === 'ByLayer') return { transparency: 'ByLayer', transparencyLayer: ins.transparencyLayer ?? ins.layer };
  return { transparency: ins.transparency };
}

/** Appearance shared by generated dimension, text, leader, table and image primitives. */
export function appearanceProperties(e: EntityBase): Pick<EntityBase, 'trueColor' | 'colorName' | 'colorLayer' | 'transparency' | 'transparencyLayer'> {
  return {
    ...(e.trueColor !== undefined ? { trueColor: e.trueColor } : {}),
    ...(e.colorName !== undefined ? { colorName: e.colorName } : {}),
    ...(e.colorLayer !== undefined ? { colorLayer: e.colorLayer } : {}),
    ...(e.transparency !== undefined ? { transparency: e.transparency } : {}),
    ...(e.transparencyLayer !== undefined ? { transparencyLayer: e.transparencyLayer } : {}),
  };
}

/** Keep an imported appearance when symbol creation moves geometry onto layer 0. */
export function bakeLayerAppearance<T extends EntityBase>(e: T, layers: readonly Layer[]): T {
  const colorLayer = layers.find((l) => l.name === (e.colorLayer ?? e.layer));
  const alphaLayer = layers.find((l) => l.name === (e.transparencyLayer ?? e.layer));
  return {
    ...e,
    ...(e.color === 'ByLayer' && e.trueColor === undefined && colorLayer?.colorName !== undefined ? {
      color: colorLayer.color, colorName: colorLayer.colorName,
      ...(colorLayer.trueColor !== undefined ? { trueColor: colorLayer.trueColor } : {}),
    } : {}),
    ...((e.transparency === undefined || e.transparency === 'ByLayer') && alphaLayer?.transparency !== undefined ? { transparency: Math.round(resolveAlpha(e, layers) * 255) } : {}),
  };
}
