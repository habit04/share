import type { TextPlacement } from '../../core/text-placement';
import { textJustification } from '../../core/text-placement';
import * as g from '../../core/geometry';
import { has, num, str, type Obj } from './groups';

/** TEXT vertical code is 73; attributes use 74 (73 is their field length). */
export function readTextPlacement(o: Obj, verticalCode = 73): TextPlacement & { rotation: number; style?: string } {
  const h = num(o, 72, 0);
  const v = num(o, verticalCode, 0);
  const wf = num(o, 41, 1);
  const oblique = g.rad(num(o, 51, 0));
  const style = str(o, 7);
  const first = { x: num(o, 10), y: num(o, 20) };
  const second = has(o, 11) ? { x: num(o, 11), y: num(o, 21) } : undefined;
  const useSecond = (h !== 0 || v !== 0) && h !== 3 && h !== 5 && second !== undefined;
  return {
    position: useSecond ? second : first,
    ...(useSecond ? { firstAlignmentPoint: first } : {}),
    height: num(o, 40, 0.125),
    rotation: g.rad(num(o, 50, 0)),
    align: h === 1 || h === 4 ? 'center' : h === 2 ? 'right' : 'left',
    ...(h !== 0 || v !== 0 ? { justification: textJustification(h, v) } : {}),
    ...(second ? { alignmentPoint: second } : {}),
    // Native omission means entity defaults, even when STYLE has different creation defaults.
    // DXFOUT commonly removes explicit 1/0; importing must not reapply STYLE width/slant.
    widthFactor: wf,
    oblique,
    ...(style && !/^standard$/i.test(style) ? { style } : {}),
  };
}
