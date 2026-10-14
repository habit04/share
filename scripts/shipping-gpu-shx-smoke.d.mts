export interface ShxFontPin {
  name: string;
  bytes: number;
  sha256: string;
  above: number;
  below: number;
  oracle: { right: number; middle: number; fitted: number; box: number[] };
}
export const SHX_FIXTURE_SHA256: string;
export const SHX_FIXTURE_BYTES: number;
export const SHX_FONTS: readonly ShxFontPin[];
export const SHX_COMPARISON_LABELS: readonly (readonly [string, 'canvas' | 'either'])[];
export interface ShxGlCalls { draws: number; uploads: number; clear: number; uploadBytes: number }
export interface ShxPair {
  label: string;
  renderer: 'canvas' | 'gpu';
  referencePng: string;
  actualPng: string;
  glCalls: ShxGlCalls;
  documentUnchanged: boolean;
  beforeResourcePng?: string;
  firstAutomaticFrame?: boolean;
  epochChanged?: boolean;
  currentResourceBound?: boolean;
}
export interface ShxComparison {
  label: string; renderer: 'canvas' | 'gpu'; width: number; height: number; rawPixels: number;
  rasterFraction: number; canvasMissed: number; gpuMissed: number; glCalls: ShxGlCalls;
  referenceBytes: Buffer; actualBytes: Buffer; beforeResourceBytes?: Buffer; fontChangedPixels: number | null;
}
export interface ShxOptions { requireAdapter?: 'intel' | 'nvidia' }
export function classifyShippingShxAdapter(adapter: unknown): 'not-created' | 'software' | 'nvidia' | 'intel' | 'unknown-or-other';
export function preflightShippingShxRecord(record: unknown, options?: ShxOptions): ShxPair[];
export function compareShippingShxPair(pair: ShxPair): ShxComparison;
export function validateShippingShxRecord(record: unknown, options?: ShxOptions): ShxComparison[];
export function runShippingShxSmoke(args?: string[]): Promise<Record<string, unknown>>;
