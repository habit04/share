export const GPU2D_COMPARISON_LABELS: readonly (readonly [string, 'gpu' | 'canvas'])[];
export const GPU2D_STARTUP_DXF: string;
export function compareShippingGpu2dPair(pair: unknown): { label: string; renderer: 'gpu' | 'canvas'; width: number; height: number; rawPixels: number; rasterFraction: number; canvasMissed: number; gpuMissed: number; glCalls: unknown; referenceBytes: Buffer; actualBytes: Buffer };
export function classifyShippingGpu2dAdapter(adapter: unknown): 'software' | 'nvidia' | 'intel' | 'unknown-or-other';
export function preflightShippingGpu2dRecord(record: unknown, options?: { requireAdapter?: string }): unknown[];
export function validateShippingGpu2dRecord(record: unknown, options?: { requireAdapter?: string }): ReturnType<typeof compareShippingGpu2dPair>[];
export function runShippingGpu2dSmoke(args?: string[]): Promise<unknown>;
