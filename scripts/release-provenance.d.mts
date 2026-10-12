export function expectedInstallers(version: string, platform: string): string[];
export function expectedUpdateAssets(version: string, platform: string): string[];
export function isReleaseAsset(file: string): boolean;
export interface BuildProvenance { schemaVersion: number; platform: string; version: string; sourceSha: string; signing: string; executableFuses: import('./electron-fuse-policy.mjs').FuseEvidence[]; artifacts: { name: string; bytes: number; sha256: string }[] }
export function writeBuildProvenance(dir: string, platform: string, version: string, sha: string, signing: string, executableFuses?: import('./electron-fuse-policy.mjs').FuseEvidence[]): Promise<BuildProvenance>;
export type ReleasePolicy = 'all-platforms' | 'windows-only';
export function verifyReleaseProvenance(dir: string, version: string, sha: string, options?: { policy?: ReleasePolicy; requireSigning?: boolean }): Promise<{ schemaVersion: number; releasePolicy?: ReleasePolicy; version: string; sourceSha: string; builds: BuildProvenance[] }>;
export function signingSummary(record: { sourceSha: string; builds: Pick<BuildProvenance, 'platform' | 'signing'>[] }): string;
