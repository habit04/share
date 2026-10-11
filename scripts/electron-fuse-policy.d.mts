export interface FusePolicy { role: 'shipping' | 'test'; version: string; RunAsNode: false; EnableNodeOptionsEnvironmentVariable: false; EnableNodeCliInspectArguments: boolean; EnableEmbeddedAsarIntegrityValidation: true; OnlyLoadAppFromAsar: true; GrantFileProtocolExtraPrivileges: false }
export function assertFusePolicy(wire: Record<string | number, unknown>, role?: string): FusePolicy;
export function verifyExecutableFuses(executable: string, role?: string): Promise<FusePolicy>;
export interface FuseEvidence { path: string; policy: FusePolicy }
export function platformExecutables(platform: string): string[];
export function validateFuseEvidence(platform: string, evidence: unknown): FuseEvidence[];
export function verifyPlatformFuses(dir: string, platform: string): Promise<FuseEvidence[]>;
