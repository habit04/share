export const GPU3D_STARTUP_DXF: string;
export const GPU3D_FIXTURE_SHA256: string;
export const GPU3D_STATE_LABELS: readonly string[];
export const GPU3D_IMAGE_LABELS: readonly string[];
export function decodeShippingGpu3dPng(value: unknown): { bytes: Buffer; width: number; height: number; rgba: Buffer };
export function preflightShippingGpu3dRecord(record: unknown, options?: { requireAdapter?: string }): { label: string; png: string; rawGpuInk: number | null }[];
export function validateShippingGpu3dRecord(record: unknown, options?: { requireAdapter?: string }): { label: string; rawGpuInk: number | null; bytes: Buffer; width: number; height: number }[];
export function runShippingGpu3dSmoke(args?: string[]): Promise<unknown>;
