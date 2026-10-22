// Node-only shims so pdfjs-dist can run under vitest. The browser and the
// Electron renderer (Chromium) have all of these natively; production code
// must NOT polyfill — this module is imported by the pdfjs test file only,
// before the adapter (pdfjs itself is loaded lazily by the adapter).
const U8 = Uint8Array.prototype as unknown as Record<string, unknown>;
if (!U8.toHex) {
  U8.toHex = function (this: Uint8Array) { return [...this].map((b) => b.toString(16).padStart(2, '0')).join(''); };
  U8.fromHex = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
  U8.toBase64 = function (this: Uint8Array) { return Buffer.from(this).toString('base64'); };
  U8.fromBase64 = (b64: string) => Uint8Array.from(Buffer.from(b64, 'base64'));
}
const M = Map.prototype as unknown as Record<string, unknown>;
if (!M.getOrInsert) {
  M.getOrInsert = function (this: Map<unknown, unknown>, k: unknown, v: unknown) { if (!this.has(k)) this.set(k, v); return this.get(k); };
  M.getOrInsertComputed = function (this: Map<unknown, unknown>, k: unknown, f: (k: unknown) => unknown) { if (!this.has(k)) this.set(k, f(k)); return this.get(k); };
}
const WM = WeakMap.prototype as unknown as Record<string, unknown>;
if (!WM.getOrInsert) {
  WM.getOrInsert = function (this: WeakMap<object, unknown>, k: object, v: unknown) { if (!this.has(k)) this.set(k, v); return this.get(k); };
  WM.getOrInsertComputed = function (this: WeakMap<object, unknown>, k: object, f: (k: object) => unknown) { if (!this.has(k)) this.set(k, f(k)); return this.get(k); };
}
const g = globalThis as Record<string, unknown>;
if (!g.Path2D) {
  g.Path2D = class Path2D {
    addPath(): void { /* stub */ }
    moveTo(): void { /* stub */ }
    lineTo(): void { /* stub */ }
    bezierCurveTo(): void { /* stub */ }
    quadraticCurveTo(): void { /* stub */ }
    rect(): void { /* stub */ }
    arc(): void { /* stub */ }
    arcTo(): void { /* stub */ }
    ellipse(): void { /* stub */ }
    closePath(): void { /* stub */ }
  };
}
if (!g.DOMMatrix) {
  g.DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
    static fromFloat32Array(): DOMMatrix { return new DOMMatrix(); }
    static fromFloat64Array(): DOMMatrix { return new DOMMatrix(); }
    multiply(): DOMMatrix { return this; }
    translate(): DOMMatrix { return this; }
    scale(): DOMMatrix { return this; }
  };
}
export {};
