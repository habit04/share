// Original authoring inputs selectively retain frozen978384 fixtures/tests; focused native Intel/NVIDIA passed0423.
export const dimensionKinds = ['linear', 'aligned', 'radius', 'diameter', 'angular'];
export const standardDimensionStyle = { name: 'Standard', textHeight: 0.18, arrowSize: 0.18, extOffset: 0.0625, extExtend: 0.18, textGap: 0.09, centerMark: 0.09, scale: 1, decimals: 4, lunit: 2, angularDecimals: 0 };
const dimensionStyle = { ...standardDimensionStyle, textHeight: 0.35, arrowSize: 0.35, dimLineColor: 3, extLineColor: 5, textColor: 3, dimLineWeight: 0.01, extLineWeight: 10 };
const dimension = (id, patch = {}) => ({ id, type: 'dimension', kind: 'linear', layer: '0', color: 3, trueColor: 0xd19a66,
  p1: { x: -8, y: -4 }, p2: { x: -1, y: -4 }, linePoint: { x: -4.5, y: -2 }, rotation: 0, style: dimensionStyle, lineWeight: 0.5, ...patch });
export function originalDimensionEntities(unsupported = false) {
  return [
    { id: 'L', type: 'line', layer: '0', color: 7, a: { x: -9, y: 0 }, b: { x: 10, y: 0 }, lineWeight: 1 },
    dimension('linear', { textPosition: { x: -5, y: -2 } }),
    dimension('aligned', { kind: 'aligned', p1: { x: -8, y: 1 }, p2: { x: -4, y: 4 }, linePoint: { x: -7, y: 4 }, style: { ...dimensionStyle, arrow: 'closed-blank', extLineColor: 2 } }),
    dimension('radius', { kind: 'radius', p1: { x: 2, y: 2 }, p2: { x: 4, y: 2 }, linePoint: { x: 5, y: 3 }, style: { ...dimensionStyle, textColor: 1 } }),
    dimension('diameter', { kind: 'diameter', p1: { x: 2, y: -2 }, p2: { x: 4, y: -2 }, linePoint: { x: 6, y: -4 } }),
    dimension('angular', { kind: 'angular', center: { x: 7, y: 2 }, p1: { x: 10, y: 2 }, p2: { x: 7, y: 5 }, linePoint: { x: 9.5, y: 4.5 }, style: { ...dimensionStyle, ...(unsupported ? { arrow: 'dot' } : {}) } }),
    { id: 'ORDER', type: 'line', layer: '0', color: 1, a: { x: -8, y: -2 }, b: { x: -6, y: -2 }, lineWeight: 0.25 },
  ];
}
const rotationReason = 'Unsupported Canvas stroke construction: native context rotation is unproved';
/** @typedef {{name:string,entities:any[],center:{x:number,y:number},scale:number,twist:number,lineweights:boolean,selection:string[],expectedGPU:boolean,reason?:string,reasonPending?:boolean,provenance?:string,dependency?:string,originalCpuViewport?:any,nativeReplay?:string}} DimensionNativeCase */
/** @returns {{common:DimensionNativeCase,individual:DimensionNativeCase[],controls:DimensionNativeCase[]}} */
export function nativeDimensionCases() {
  const common = { entities: originalDimensionEntities(), center: { x: 0, y: 0 }, scale: 40, lineweights: true, selection: [] };
  const origin = { x: 1e12, y: -1e12 }, p = (x, y) => ({ x: origin.x + x, y: origin.y + y });
  const precision = [
    { id: 'L', type: 'line', layer: '0', color: 7, a: p(-1 / 16, 1 / 8192), b: p(1 / 16, 1 / 8192) },
    { id: 'precision-dimension', type: 'dimension', kind: 'linear', layer: '0', color: 3, p1: p(-1 / 32, -1 / 32), p2: p(1 / 32, -1 / 32), linePoint: p(0, 0), rotation: 0, style: { ...standardDimensionStyle, scale: 1 / 256 } },
  ];
  return {
    common: { ...common, name: 'dimensions-common-zero', twist: 0, expectedGPU: true, dependency: 'Requires all five immutable opaque top-level dimensions, original closed-blank aligned arrow, filled arrows, stroke TEXT and angular native ARC/source/shader gates' },
    individual: dimensionKinds.map((kind) => ({ ...common, name: `dimension-${kind}-zero`, entities: common.entities.filter((entity) => entity.type === 'line' || entity.id === kind), twist: 0, expectedGPU: true, dependency: `Requires ${kind} admission under current source/native certificates` })),
    controls: [
      { ...common, name: 'dimensions-original-017', twist: 0.17, expectedGPU: false, reason: rotationReason, provenance: '978384 gpu-dimension-fixtures original common camera/source' },
      { ...common, name: 'dimensions-original-clip-063', center: { x: 2.125, y: -1.375 }, twist: 0.63, expectedGPU: false, reason: rotationReason, provenance: '978384 gpu-dimension-validation original nonzero-camera clip pose' },
      { ...common, name: 'dimensions-original-precision-063', entities: precision, center: origin, scale: 4096, twist: 0.63, lineweights: false, expectedGPU: false, reasonPending: true, provenance: '978384 gpu-dimension-fixtures original trillion-world precision input; first actual source guard must be verified' },
      { ...common, name: 'dimensions-original-selected-arrow-037', entities: [{ id: 'dimension', type: 'dimension', kind: 'linear', layer: '0', color: 'ByLayer', p1: { x: -3, y: -1 }, p2: { x: 3, y: -1 }, linePoint: { x: 0, y: 1 }, rotation: 0, text: ' ', style: { ...standardDimensionStyle, arrowSize: 1, suppressExt1: true, suppressExt2: true } }], scale: 30, twist: 0.37, selection: ['dimension'], expectedGPU: false, reasonPending: true,
        originalCpuViewport: { width: 320, height: 240, dpr: [1, 2], ratios: [0.8, 1, 1.25], pan: { xPhysical: 110, yPhysical: -105 } }, nativeReplay: 'Original source/center/scale/twist/selection retained; actual owned hardware viewport/DPR reported separately, not an exact original CPU replay', provenance: '978384 tests/gpu-renderer2d.test.ts:745 original selected-arrow geometry/control' },
      { ...common, name: 'dimensions-original-giant-close-zoom', entities: [{ id: 'dimension', type: 'dimension', kind: 'linear', layer: '0', color: 'ByLayer', p1: p(0, 0), p2: p(1 / 8192, 0), linePoint: p(0, 1 / 8192), rotation: 0, style: standardDimensionStyle }], center: origin, scale: 65536, twist: 0.2, expectedGPU: false, reasonPending: true,
        originalCpuViewport: { width: 320, height: 240, dpr: 1 }, provenance: '978384 gpu-dimension-strokes.test.ts:477 inherited camera.twist.2; original tiny anchors and unscaled Standard layout retained' },
    ],
  };
}
// Fixed oracle from ORIGINAL linear foot a2=(-1,-2), arrowParts direction(1,0), size.35.
// No original point is reconstructed from GPU mesh/local coordinates.
export const fixedDimensionOracles = {
  rightFilledArrow: { owner: 'linear', points: [{ x: -1, y: -2 }, { x: -1.35, y: -2 + 0.35 / 6 }, { x: -1.35, y: -2 - 0.35 / 6 }], rgb: [209, 154, 102], background: [33, 40, 48], expectedPaint: 'fill only; no extruded outline', basis: 'src/core/dimension.ts arrowParts/linearParts and src/render/draw.ts filled closed polyline' },
  roles: [
    { label: 'same-ACI dimension role keeps parent truecolor', point: { x: -2, y: -2 }, rgb: [209, 154, 102] },
    { label: 'different-ACI extension role overrides parent truecolor', point: { x: -8, y: -3 }, rgb: [0, 0, 255] },
    { label: 'later ORDER red covers earlier linear dimension brown', point: { x: -7, y: -2 }, rgb: [255, 0, 0] },
  ],
  textRegion: { owner: 'linear', corners: [{ x: -5.8, y: -1.95 }, { x: -4.2, y: -1.84 }], rgb: [209, 154, 102], provenance: 'Canvas-reference ink region from original explicit textPosition(-5,-2)/height.35 above the dimension-line band; not an independent font/content oracle' },
  expectedFormattedText: ['7.0000', '5.0000', 'R2.0000', '%%c4.0000', '90%%d'],
};


// Fixed exact source-safety inventory reviewed at0423 and replayed on actual Intel/NVIDIA.
// The original reasonPending metadata above is retained solely to bind historical full fixture hashes.
// Huge/nonzero-twist controls prove refusal only, never a zero-twist huge-world/highzoom certificate.
export const originalDimensionControlEvidence = Object.freeze(Object.fromEntries(Object.entries({
  "dimensions-original-017": {
    "sourceSha": "0423d095d50b1a9755c5f398d6708a5742604ebd",
    "fixtureSha": "de423ceab1ffd3969d2721caf27d1a3d36e4c0b9e9761e90cc5158fb2b4987ee",
    "reason": "Unsupported Canvas stroke construction: native context rotation is unproved",
    "kind": "source-construction-refusal",
    "provenance": "Lead reviewed exact captured source/pose/reason and zero-GL/rawRGBA evidence in .codex-local/dimension-native-validation-draft/native-control-diagnostics-default-lO3wZG/result.json; source guard src/render/gpu-prototype/native-float-stroke-bound.ts:129 nativeFloatStrokeBound nonzero view.twist guard in preceding original LINE; huge-world arithmetic is not separately certified by this control. Diagnostic SHA256 299ae106a8e6830563638f919b9256fc4b82787e5ffec79c63d181fdb26dd4a6."
  },
  "dimensions-original-clip-063": {
    "sourceSha": "0423d095d50b1a9755c5f398d6708a5742604ebd",
    "fixtureSha": "fbee042540b1672ee88894897a1bd94c0bb5564afc1648a21866b0c0da92e7fd",
    "reason": "Unsupported Canvas stroke construction: native context rotation is unproved",
    "kind": "source-construction-refusal",
    "provenance": "Lead reviewed exact captured source/pose/reason and zero-GL/rawRGBA evidence in .codex-local/dimension-native-validation-draft/native-control-diagnostics-default-lO3wZG/result.json; source guard src/render/gpu-prototype/native-float-stroke-bound.ts:129 nativeFloatStrokeBound nonzero view.twist guard in preceding original LINE; huge-world arithmetic is not separately certified by this control. Diagnostic SHA256 299ae106a8e6830563638f919b9256fc4b82787e5ffec79c63d181fdb26dd4a6."
  },
  "dimensions-original-precision-063": {
    "sourceSha": "0423d095d50b1a9755c5f398d6708a5742604ebd",
    "fixtureSha": "a1b8eb6588cc16895d1dfe2cbae5bc515eccbb140a43d8fa7f70494be8a3c55e",
    "reason": "Unsupported Canvas stroke construction: native context rotation is unproved",
    "kind": "source-construction-refusal",
    "provenance": "Lead reviewed exact captured source/pose/reason and zero-GL/rawRGBA evidence in .codex-local/dimension-native-validation-draft/native-control-diagnostics-default-lO3wZG/result.json; source guard src/render/gpu-prototype/native-float-stroke-bound.ts:129 nativeFloatStrokeBound nonzero view.twist guard in preceding original LINE; huge-world arithmetic is not separately certified by this control. Diagnostic SHA256 299ae106a8e6830563638f919b9256fc4b82787e5ffec79c63d181fdb26dd4a6."
  },
  "dimensions-original-selected-arrow-037": {
    "sourceSha": "0423d095d50b1a9755c5f398d6708a5742604ebd",
    "fixtureSha": "8cddcb693acbf71fb19604624ab9bf17264ecc63d6c5dece4961647ba57182d9",
    "reason": "Unsupported Canvas stroke construction: dimension highlight requires Canvas",
    "kind": "source-construction-refusal",
    "provenance": "Lead reviewed exact captured source/pose/reason and zero-GL/rawRGBA evidence in .codex-local/dimension-native-validation-draft/native-control-diagnostics-default-lO3wZG/result.json; source guard src/render/gpu-prototype/stroke-scene.ts:379 lowerStrokeScene selected/hovered DIM preflight. Diagnostic SHA256 299ae106a8e6830563638f919b9256fc4b82787e5ffec79c63d181fdb26dd4a6."
  },
  "dimensions-original-giant-close-zoom": {
    "sourceSha": "0423d095d50b1a9755c5f398d6708a5742604ebd",
    "fixtureSha": "772b3e0d32ba560a00ff359e6d0a26348d68d6bb93c30cd5d5bb92697ee4bb20",
    "reason": "Unsupported Canvas stroke construction: dimension native context rotation is unproved",
    "kind": "source-construction-refusal",
    "provenance": "Lead reviewed exact captured source/pose/reason and zero-GL/rawRGBA evidence in .codex-local/dimension-native-validation-draft/native-control-diagnostics-default-lO3wZG/result.json; source guard src/render/gpu-prototype/dimension-native-source.ts:134 certifyDimensionNativeSource nonzero view.twist preflight; this does not establish a zero-twist extreme-zoom certificate. Diagnostic SHA256 299ae106a8e6830563638f919b9256fc4b82787e5ffec79c63d181fdb26dd4a6."
  }
}).map(([name, evidence]) => [name, Object.freeze(evidence)])));
