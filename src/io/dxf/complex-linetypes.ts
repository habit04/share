/** Native complex LTYPE descriptors and their bounded STYLE resource references. */
import type { Linetype, ComplexLinetypeElement, LinetypeShapeStyle, LinetypeStyleReference } from '../../core/linetypes';
import { MAX_LINETYPE_ELEMENTS, MAX_LINETYPE_TEXT, complexLinetypeProblem, linetypeShapeStyleProblem } from '../../core/linetypes';
import { shapeStyleFromGroups, textStyleFromGroups, encodeDxfText } from '../encoding';
import { DxfReadError, isIntegerText, str, has } from './groups';
import type { Obj } from './groups';
import type { ImportReportBuilder } from '../import-report';
import type { Writer } from './write-core';
import { isIntCode, isRealCode, isRealText } from './codes';

const elementFields: Readonly<Record<number, keyof ComplexLinetypeElement>> = { 74: 'flags', 75: 'shapeNumber', 46: 'scale', 50: 'rotation', 44: 'offsetX', 45: 'offsetY', 9: 'text' };
const complexCodes = new Set([75, 340, 46, 50, 44, 45, 9]);
const nativeHandle = (value: string) => /^[0-9a-f]{1,16}$/i.test(value) && !/^0+$/.test(value);

/** Pre-index all STYLEs: native LTYPE records normally precede the STYLE table. */
export function linetypeStyleRecords(objects: readonly Obj[], shapeStyles: Record<string, LinetypeShapeStyle>, report: ImportReportBuilder): ReadonlyMap<string, LinetypeStyleReference | null> {
  const references = new Map<string, LinetypeStyleReference | null>();
  for (let i = 0; i < objects.length; i++) {
    const object = objects[i]!;
    if (object.kind !== 'STYLE') continue;
    if (object.groups.some((pair) => isRealCode(pair.code) ? !isRealText(pair.value) || !Number.isFinite(Number(pair.value)) : isIntCode(pair.code) && !isIntegerText(pair.value.trim()))) continue;
    const handle = str(object, 5).trim().toUpperCase(), shape = shapeStyleFromGroups(object.groups);
    let reference: LinetypeStyleReference | undefined;
    if (shape) {
      const sourceId = nativeHandle(handle) && !Object.hasOwn(shapeStyles, handle) ? handle : `STYLE@${object.line ?? i}`;
      shapeStyles[sourceId] = shape;
      reference = { kind: 'shape', sourceId };
      const problem = linetypeShapeStyleProblem(shape);
      report.add({ type: 'STYLE', action: 'kept', reason: problem ? `shape-file STYLE is retained; export requires repair: ${problem}` : `shape-file STYLE "${shape.font}" is retained; shapes are not rendered`, ...(object.line ? { line: object.line } : {}) });
      const extra = object.groups.filter((pair) => ![5, 330, 100, 2, 70, 40, 41, 50, 71, 42, 3, 4].includes(pair.code));
      if (extra.length) report.add({ type: 'STYLE', action: 'simplified', reason: `shape-file STYLE extension metadata (groups ${[...new Set(extra.map((pair) => pair.code))].join(', ')}) is not modeled; the shape-file resource is retained`, ...(object.line ? { line: object.line } : {}) });
    } else {
      const text = textStyleFromGroups(object.groups);
      if (text) reference = { kind: 'text', name: text.name, ...(nativeHandle(handle) ? { sourceHandle: handle } : {}) };
    }
    if (nativeHandle(handle)) references.set(handle, references.has(handle) ? null : reference ?? null);
  }
  return references;
}

export function hasComplexLinetypeData(object: Obj): boolean {
  return object.groups.some((pair) => pair.code === 74 && Number(pair.value) !== 0 || complexCodes.has(pair.code));
}

/** Descriptor presence/ordering is retained; unresolved handles explicitly prevent export. */
export function readComplexLinetype(object: Obj, styles: ReadonlyMap<string, LinetypeStyleReference | null>): Linetype {
  const fail = (message: string): never => { throw new DxfReadError(`Invalid complex linetype "${str(object, 2)}": ${message}`, object.line ?? 1); };
  const pattern: number[] = [], elements: ComplexLinetypeElement[] = [];
  let fields = new Set<number>();
  for (const pair of object.groups) {
    if (pair.code === 49) {
      if (pattern.length >= MAX_LINETYPE_ELEMENTS) fail('element count exceeds the safe limit');
      pattern.push(Number(pair.value)); elements.push({ flags: 0 }); fields = new Set();
    } else if (elementFields[pair.code] || pair.code === 340) {
      if (!elements.length || fields.has(pair.code)) fail(`misplaced or duplicate element group ${pair.code}`);
      fields.add(pair.code);
      const index = elements.length - 1;
      if (pair.code === 340) {
        const handle = pair.value.trim().toUpperCase();
        if (handle.length > 255) fail('STYLE reference exceeds the safe limit');
        elements[index] = { ...elements[index]!, style: styles.get(handle) ?? { kind: 'unresolved', sourceHandle: handle } };
      } else {
        const field = elementFields[pair.code]!;
        if (field === 'text' && pair.value.length > MAX_LINETYPE_TEXT) fail('embedded text exceeds the safe limit');
        elements[index] = { ...elements[index]!, [field]: field === 'text' ? pair.value : Number(pair.value) };
      }
    }
  }
  const counts = object.groups.filter((pair) => pair.code === 73);
  if (counts.length !== 1 || !isIntegerText(counts[0]!.value.trim()) || Number(counts[0]!.value) !== pattern.length) fail('group73 does not match group49 elements');
  for (const code of [70, 72, 40]) if (object.groups.filter((pair) => pair.code === code).length > 1) fail(`duplicate header group ${code}`);
  return { name: str(object, 2), description: str(object, 3), pattern, complex: {
    ...(has(object, 70) ? { flags: Number(str(object, 70)) } : {}),
    ...(has(object, 72) ? { alignment: Number(str(object, 72)) } : {}),
    ...(has(object, 40) ? { totalPatternLength: Number(str(object, 40)) } : {}), elements } };
}

export function complexLinetypeWarning(lt: Linetype): string {
  const problem = complexLinetypeProblem(lt);
  return problem ? `complex linetype "${lt.name}" is retained with its dash fallback; export requires repair: ${problem}`
    : `complex linetype "${lt.name}" text/shapes and STYLE references are retained; embedded elements are not rendered, so only dashes are shown`;
}

/** Called before writing any descriptor or passing numeric data through Writer formatting. */
export function writeComplexLinetypeElements(w: Writer, lt: Linetype, shapeHandles: ReadonlyMap<string, string>): void {
  const problem = complexLinetypeProblem(lt);
  if (problem) throw new Error(`Cannot preserve complex linetype "${lt.name}": ${problem}.`);
  for (let i = 0; i < lt.pattern.length; i++) {
    w.pair(49, lt.pattern[i]!);
    const element = lt.complex?.elements[i];
    w.pair(74, element?.flags ?? 0);
    if (!element) continue;
    if (element.shapeNumber !== undefined) w.pair(75, element.shapeNumber);
    if (element.style) {
      const handle = element.style.kind === 'text' ? w.textStyleHandles.get(element.style.name.toUpperCase())
        : element.style.kind === 'shape' ? shapeHandles.get(element.style.sourceId) : undefined;
      if (!handle) throw new Error(`Cannot preserve complex linetype "${lt.name}": its STYLE resource is missing.`);
      w.pair(340, handle);
    }
    if (element.scale !== undefined) w.pair(46, element.scale);
    if (element.rotation !== undefined) w.pair(50, element.rotation);
    if (element.offsetX !== undefined) w.pair(44, element.offsetX);
    if (element.offsetY !== undefined) w.pair(45, element.offsetY);
    if (element.text !== undefined) w.pair(9, encodeDxfText(element.text));
  }
}
