import type { DimensionEntity } from '../../core/dimension';
import { DIM_DEFAULTS, dimStyleOverrideCode, type DimStyle } from '../../core/dimension';
import { sourceTopologyAdmissionError } from './stroke-precision-error';

export const DIMENSION_PART_BOUND = 16;
export const DIMENSION_POINT_PREPARATION_BOUND = 389;
/** <=16 canonical parts with <=4 local points each, before original source work. */
export const DIMENSION_LOCAL_POINT_PREPARATION_BOUND = 64;
export const DIMENSION_PREPARATION_MAX_WORK = 1_000_000;
const MAX_TEXT_CHARACTERS = 16_384;
const MAX_STYLE_KEYS = 64;
const MAX_KEY_CHARACTERS = 64;
const ATOM = 68; // Current numeric atom <=64 plus radius/diameter/degree/sign markers.

const NUMERIC_KEYS = new Set([
  'textHeight', 'arrowSize', 'extOffset', 'extExtend', 'textGap', 'centerMark', 'scale',
  'decimals', 'lunit', 'angularDecimals', 'baselineSpacing', 'dimLineExtend',
  'dimLineWeight', 'extLineWeight', 'round', 'linearFactor', 'decimalSeparator',
  'altFactor', 'altDecimals', 'altLunit', 'tolPlus', 'tolMinus', 'tolDecimals',
  'tolScale', 'toleranceZeroSuppression',
]);
const BOOLEAN_KEYS = new Set([
  'suppressDimLine1', 'suppressDimLine2', 'suppressExt1', 'suppressExt2',
  'textInside', 'dimLineInside', 'suppressLeadingZeros', 'suppressTrailingZeros',
  'altUnits',
]);
const STRING_KEYS = new Set([
  'name', 'arrow', 'arrow2', 'textVertical', 'textAlign', 'textJustify', 'textStyle',
  'fit', 'post', 'altPost', 'altPlacement', 'tolerance',
]);
const COLOR_KEYS = new Set(['dimLineColor', 'extLineColor', 'textColor']);

function fail(message: string): never {
  throw sourceTopologyAdmissionError(`Stroke-scene expansion exceeds dimension ${message}`);
}

export interface DimensionPreparationBudget {
  readonly work: number;
  readonly outputCharacters: number;
  readonly inputCharacters: number;
  readonly inspectedStyleKeys: number;
  readonly inspectedStyleCharacters: number;
  readonly partBound: number;
  readonly pointBound: number;
}

interface StyleInspection {
  readonly style: DimStyle;
  readonly keys: number;
  readonly characters: number;
  readonly work: number;
}

/** Admission-only data scan before canonical Object.entries/Object.values allocation.
 * The for-in implementation has engine-owned enumeration costs; this is not a
 * global heap proof. Canonical resolution uses enumerable string keys and direct
 * arrow/arrow2 reads. Unknown symbols/nonenumerable fields remain untouched and
 * do not enter those canonical allocation inputs.
 */
function inspectStyleData(source: DimensionEntity, maxWork: number): StyleInspection {
  let keys = 0;
  let characters = 0;
  let work = 0;
  let enumerableKeys = 0;
  const spend = (amount: number): void => {
    work += amount;
    if (!Number.isSafeInteger(work) || work > maxWork) fail('style inspection work budget');
  };
  const inspectKey = (key: string): void => {
    keys++;
    characters += key.length;
    spend(1 + key.length);
  };
  const inspectString = (item: string): void => {
    if (item.length > MAX_TEXT_CHARACTERS) fail('style string budget');
    characters += item.length;
    spend(item.length);
  };
  const validateStyleValue = (key: string, item: unknown): void => {
    if (item === undefined) return;
    if (NUMERIC_KEYS.has(key) && !(typeof item === 'number' && Number.isFinite(item))) fail('style numeric value');
    if (BOOLEAN_KEYS.has(key) && typeof item !== 'boolean') fail('style boolean value');
    if (STRING_KEYS.has(key) && typeof item !== 'string') fail('style string value');
    if (COLOR_KEYS.has(key) && !(typeof item === 'number' && Number.isFinite(item)) && item !== 'ByLayer') fail('style color value');
    if (typeof item === 'string') inspectString(item);
  };
  const inspect = (value: unknown, overrides: boolean): void => {
    if (value === undefined && overrides) return;
    spend(1);
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('style data shape');
    const object = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== null && prototype !== Object.prototype) fail('style data prototype');

    if (!overrides) {
      // Bounded fixed-schema probes include nonenumerable arrow/arrow2 values;
      // the canonical resolver reads those directly as well as enumerable data.
      for (const schema of [NUMERIC_KEYS, BOOLEAN_KEYS, STRING_KEYS, COLOR_KEYS]) {
        for (const key of schema) {
          inspectKey(key);
          const descriptor = Object.getOwnPropertyDescriptor(object, key);
          if (descriptor && !('value' in descriptor)) fail('style accessor');
          if (descriptor) validateStyleValue(key, descriptor.value);
          else if (prototype && Object.getOwnPropertyDescriptor(prototype, key)) fail('inherited style field');
        }
      }
    }

    for (const key in object) {
      if (!Object.hasOwn(object, key)) fail('inherited style key');
      if (++enumerableKeys > MAX_STYLE_KEYS || key.length > MAX_KEY_CHARACTERS) fail('style key budget');
      inspectKey(key);
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !('value' in descriptor)) fail('style accessor');
      const item = descriptor.value as unknown;
      if (overrides) {
        // The current canonical lookup inspects a fixed <=64-variable schema.
        // Charge that finite search before it runs, instead of treating it as O(1).
        spend(64);
        if (dimStyleOverrideCode(key) === undefined &&
            !['DIMBLK1', 'DIMBLK2', 'TOLERANCE', 'ALTPLACEMENT'].includes(key)) fail('unknown style override');
        if (typeof item !== 'string' && !(typeof item === 'number' && Number.isFinite(item))) fail('style override value');
        if (typeof item === 'string') inspectString(item);
      } else if (!NUMERIC_KEYS.has(key) && !BOOLEAN_KEYS.has(key) &&
                 !STRING_KEYS.has(key) && !COLOR_KEYS.has(key)) {
        fail('unknown style key');
      }
      // Known style values were already checked/charged by the fixed probes.
    }
  };

  inspectKey('style');
  const style = Object.getOwnPropertyDescriptor(source, 'style');
  inspectKey('styleOverrides');
  const overrides = Object.getOwnPropertyDescriptor(source, 'styleOverrides');
  if (!style || !('value' in style) || (overrides && !('value' in overrides))) fail('style source accessor');
  inspect(style.value, false);
  inspect(overrides?.value, true);
  return { style: style.value as DimStyle, keys, characters, work };
}

/** The formatter sees own enumerable values; absent/undefined fields get defaults.
 * This reads only fixed descriptors already validated above, and computes lengths
 * without producing formatted strings or invoking the canonical resolver/layout.
 */
function formattingInput<K extends keyof typeof DIM_DEFAULTS>(style: DimStyle, key: K): NonNullable<DimStyle[K]> {
  const descriptor = Object.getOwnPropertyDescriptor(style, key);
  return (descriptor?.enumerable && descriptor.value !== undefined ? descriptor.value : DIM_DEFAULTS[key]) as NonNullable<DimStyle[K]>;
}

/** Admission upper bound only; canonical dimensionTextLayout remains the sole formatter. */
export function preflightDimensionPreparation(
  source: DimensionEntity,
  maxWork: number,
  maxPoints: number,
  maxOperations: number,
): DimensionPreparationBudget {
  if (![maxWork, maxPoints, maxOperations].every(value => Number.isSafeInteger(value) && value >= 0)) return fail('budget');
  const styleInspection = inspectStyleData(source, maxWork);
  const textDescriptor = Object.getOwnPropertyDescriptor(source, 'text');
  if (textDescriptor && !('value' in textDescriptor)) return fail('text accessor');
  const text = textDescriptor?.value as string | undefined;
  const post = formattingInput(styleInspection.style, 'post');
  const altPost = formattingInput(styleInspection.style, 'altPost');
  const texts = [text ?? '', post, altPost];
  if (texts.some(value => typeof value !== 'string')) return fail('text type');
  const input = texts.reduce((sum, text) => sum + text.length, 0);
  if (input > MAX_TEXT_CHARACTERS) return fail('preparation text budget');
  if (maxPoints < DIMENSION_POINT_PREPARATION_BOUND) return fail('preparation point budget');
  if (maxOperations < DIMENSION_PART_BOUND) return fail('preparation part budget');

  const checked = (value: number): number => {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TEXT_CHARACTERS) return fail('text amplification budget');
    return value;
  };
  const replace = (template: string, token: string, size: number, append: boolean): number => {
    let count = 0;
    for (let index = 0; index < template.length; index++) {
      if (template.startsWith(token, index)) {
        count++;
        index += token.length - 1;
      }
    }
    return checked(count
      ? template.length - count * token.length + count * size
      : template.length + (append ? size : 0));
  };
  const altUnits = formattingInput(styleInspection.style, 'altUnits');
  const altPlacement = formattingInput(styleInspection.style, 'altPlacement');
  const tolerance = formattingInput(styleInspection.style, 'tolerance');
  const override = text !== undefined && text !== '' ? text : null;
  let output = 0;
  if (text === ' ') output = 0;
  else if (override !== null && !override.includes('<>')) output = override.length;
  else {
    const primary = replace(post, '<>', ATOM, true);
    let alternate = 0;
    if (altUnits && source.kind !== 'angular') {
      if (altPost === '.') alternate = ATOM + 2;
      else if (altPost.includes('<>')) alternate = replace(altPost, '<>', ATOM, true);
      else alternate = checked(replace(altPost, '[]', ATOM, true) + 2);
    }
    const after = alternate && altPlacement === 'after' ? alternate + 1 : 0;
    const below = alternate && altPlacement === 'below' ? alternate : 0;
    const wrap = (value: number): number => override === null ? value : replace(override, '<>', value, false);
    switch (tolerance) {
      case 'symmetrical':
        output = checked(wrap(checked(primary + 3 + ATOM)) + after + below);
        break;
      case 'deviation':
        output = checked(wrap(primary) + after + 2 * ATOM + below);
        break;
      case 'limits':
        output = checked((override === null ? 0 : replace(override, '<>', 0, false)) + 2 * primary + alternate);
        break;
      default:
        output = checked(wrap(primary) + after + below);
        break;
    }
  }
  output = checked(output);
  // Compiler, native lowerer and standalone source certification can each inspect
  // the bounded data/template input. Three canonical layouts also scan input and
  // produce bounded output. Reserve all of those passes before the first layout.
  const work = 3 * styleInspection.work + 6 * input + 3 * output + 3 * DIMENSION_PART_BOUND * 5;
  if (!Number.isSafeInteger(work) || work > maxWork) return fail('preparation-work budget');
  return {
    work,
    outputCharacters: output,
    inputCharacters: input,
    inspectedStyleKeys: styleInspection.keys,
    inspectedStyleCharacters: styleInspection.characters,
    partBound: DIMENSION_PART_BOUND,
    pointBound: DIMENSION_POINT_PREPARATION_BOUND,
  };
}
