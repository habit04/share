import type { FuseEvidence } from './electron-fuse-policy.mjs';
export const shippingFuseValues: Readonly<Record<string, boolean>>;
export function platformExecutables(platform: string): string[];
export function validateFuseEvidence(platform: string, evidence: unknown): FuseEvidence[];
