export function expectedInstallers(version: string, platform: string): string[];
export interface BuildProvenance { schemaVersion: number; platform: string; version: string; sourceSha: string; signing: string; artifacts: { name: string; bytes: number; sha256: string }[] }
export function writeBuildProvenance(dir: string, platform: string, version: string, sha: string, signing: string): Promise<BuildProvenance>;
export function verifyReleaseProvenance(dir: string, version: string, sha: string): Promise<{ schemaVersion: number; version: string; sourceSha: string; builds: BuildProvenance[] }>;
export function signingSummary(record: { sourceSha: string; builds: BuildProvenance[] }): string;
