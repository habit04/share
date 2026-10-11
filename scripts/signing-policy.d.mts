export const appleSigningNames: string[];
export const azureSigningNames: string[];
export function missingSigningInputs(names: string[], env: Record<string, unknown>): string[];
export function assertRequiredSigning(platform: string, required: boolean, env: Record<string, unknown>): { enabled: boolean; missing: string[] };
