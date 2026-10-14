// Original HATCH authoring inputs and separate native source admission controls.
// Original authoring geometry copied selectively from frozen4027 src/app/gpu-hatch-fixtures.ts.
const rectangle = (x, y, width, height = width) => ({ points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }] });
const hatch = (id, pattern, loops, patch = {}) => ({ id, type: 'hatch', layer: '0', color: 3, solid: false, pattern, scale: 8, angle: 0, lineWeight: 0.5, loops, ...patch });
const line = (origin = { x: 0, y: 0 }) => ({ id: 'L', type: 'line', layer: '0', color: 7, lineWeight: 1, a: { x: origin.x - 8, y: origin.y }, b: { x: origin.x + 12, y: origin.y } });
const commonEntities = () => [
  line(),
  hatch('H-LINE', 'LINE', [rectangle(-7, -3, 4), rectangle(-6, -2, 2), rectangle(-5.5, -1.5, 1)], { color: 1, origin: { x: 0, y: 0.25 }, lineWeight: 1 }),
  hatch('H-NET', 'NET', [{ points: [{ x: -1, y: -3 }, { x: 3, y: -3 }, { x: 3, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }] }], { color: 2, origin: { x: 0.25, y: 0.25 } }),
  hatch('H-ANSI31', 'ANSI31', [rectangle(-7, 2, 4)], { color: 3 }),
  hatch('H-ANSI37', 'ANSI37', [rectangle(-1, 2, 4)], { trueColor: 0xa050f0, color: 5 }),
  hatch('H-FILE', 'ANSI31', [rectangle(5, -3, 4), rectangle(6, -2, 2)], { color: 4, double: true, origin: { x: 999, y: 999 }, angle: 1.3, scale: 0.00001, patternLines: [
    { angle: 0, base: { x: 0.25, y: 0.25 }, offset: { x: 0.25, y: 1 }, dashes: [0.75, -0.25] },
    { angle: Math.PI / 2, base: { x: 0.25, y: 0.25 }, offset: { x: -1, y: 0 }, dashes: [] },
  ] }),
  { id: 'ORDER-AFTER', type: 'line', layer: '0', color: 6, trueColor: 0xff8040, lineWeight: 1, a: { x: -8, y: -1 }, b: { x: 10, y: 4 } },
];
const fallbackEntities = () => [
  line(),
  hatch('H-DOTS', 'LINE', [rectangle(-7, -3, 3)], { color: 1, patternLines: [{ angle: 0, base: { x: 0.25, y: 0.25 }, offset: { x: 0, y: 0.5 }, dashes: [0, -0.5] }] }),
  hatch('H-SOLID', 'SOLID', [rectangle(-3, -3, 3), rectangle(-2.5, -2.5, 2)], { color: 3, solid: true, transparency: 170 }),
  hatch('H-DENSE', 'LINE', [rectangle(1, -3, 3), rectangle(1.5, -2.5, 2)], { color: 4, scale: 0.000001 }),
  hatch('H-CURVED', 'ANSI31', [{ points: [{ x: -6, y: 3 }, { x: -4, y: 3 }], bulges: [1, 1] }], { color: 2 }),
  hatch('H-ALPHA', 'NET', [rectangle(-3, 2, 3)], { color: 5, transparency: 100 }),
  hatch('H-SHORT', 'LINE', [rectangle(1, 2, 0.008, 3)], { color: 6 }),
  { id: 'ORDER-AFTER', type: 'line', layer: '0', color: 2, lineWeight: 1, a: { x: -8, y: -1 }, b: { x: 5, y: 5 } },
];
const phaseEntities = () => {
  const origin = { x: 1e12, y: -1e12 };
  return [line(origin), hatch('H-PHASE', 'LINE', [rectangle(origin.x - 2, origin.y - 2, 4), rectangle(origin.x - 1, origin.y - 1, 2)], { color: 3, origin: { x: origin.x, y: origin.y + 0.25 } }),
    { id: 'ORDER-AFTER', type: 'line', layer: '0', color: 1, lineWeight: 1, a: { x: origin.x - 2, y: origin.y - 1 }, b: { x: origin.x + 2, y: origin.y + 1 } }];
};
export const commonIds = ['H-LINE', 'H-NET', 'H-ANSI31', 'H-ANSI37', 'H-FILE'];
export const nativeRotationReason = 'Unsupported Canvas stroke construction: native context rotation is unproved';
export const isolatedFallbacks = [
  { id: 'H-DOTS', reason: 'Hatch pattern dots require Canvas' },
  { id: 'H-SOLID', reason: 'Unsupported transparency (H-SOLID)' },
  { id: 'H-DENSE', reason: 'Dense hatch fill requires Canvas' },
  { id: 'H-CURVED', reason: 'Unsupported hatch boundary loop' },
  { id: 'H-ALPHA', reason: 'Unsupported transparency (H-ALPHA)' },
  { id: 'H-SHORT', reason: 'Hatch dots or short strokes require Canvas' },
];
/** Separate names preserve the original source/poses rather than changing their admission claims. */
export function nativeHatchCases() {
  return [
    { name: 'hatches-common-zero', entities: commonEntities(), center: { x: 1, y: 1.5 }, scale: 40, twist: 0, supported: true, source: 'frozen4027 common geometry; new separate zero-twist reference' },
    { name: 'hatches-common-original', entities: commonEntities(), center: { x: 1, y: 1.5 }, scale: 40, twist: 0.17, supported: false, reason: nativeRotationReason, source: 'frozen4027 original common source and camera unchanged' },
    { name: 'hatches-common-original-high-zoom', entities: commonEntities(), center: { x: 2, y: 3 }, scale: 10000, twist: 0.43, supported: false, reason: nativeRotationReason, source: 'original unsafe high-zoom/twist pair retained as separate Canvas control; actual hardware DPR is reported' },
    { name: 'hatches-fallback-original', entities: fallbackEntities(), center: { x: 0, y: 1 }, scale: 45, twist: 0.23, supported: false, reason: nativeRotationReason, source: 'frozen4027 original mixed unsupported source and camera unchanged' },
    { name: 'hatches-phase-original', entities: phaseEntities(), center: { x: 1e12, y: -1e12 }, scale: 80, twist: 0.43, supported: false, reason: nativeRotationReason, source: 'frozen4027 original large-world source and camera unchanged' },
    { name: 'hatches-phase-zero', entities: phaseEntities(), center: { x: 1e12, y: -1e12 }, scale: 80, twist: 0, supported: false, reason: 'Unvalidated large-world hatch phase', source: 'separate zero-twist guard isolation; original authoring geometry retained' },
  ];
}
/** Independent known color/phase/intersection interiors; hardware rasters must prove them. */
export const hatchInteriorProbes = [
  { label: 'outer-ink', point: { x: -6.5, y: -0.75 }, rgb: [255, 0, 0] },
  { label: 'middle-hole', point: { x: -5.75, y: -0.75 }, rgb: [33, 40, 48] },
  { label: 'nested-island', point: { x: -5, y: -0.75 }, rgb: [255, 0, 0] },
  { label: 'net-over-earlier-white', point: { x: 0.25, y: 0 }, rgb: [255, 255, 0] },
  { label: 'concave-notch', point: { x: 2, y: 0.25 }, rgb: [33, 40, 48] },
  { label: 'file-ink', point: { x: 6.5, y: 0.25 }, rgb: [0, 255, 255] },
  { label: 'file-dash-gap', point: { x: 7.125, y: 0.25 }, rgb: [33, 40, 48] },
  { label: 'file-hole', point: { x: 6.5, y: -0.75 }, rgb: [33, 40, 48] },
  { label: 'file-outer-ink', point: { x: 8.5, y: -0.75 }, rgb: [0, 255, 255] },
  { label: 'later-orange-over-hatch', point: { x: -3.5, y: 0.25 }, rgb: [255, 128, 64] },
];
