export function assertCiContext(env: Readonly<Record<string, string | undefined>>, platform: string, arch: string): void;
export function assertGeneratedInputsOnly(changedPaths: readonly string[]): void;
export function verifyPackedNotices(archive: string, repo: string): Array<{ path: string; bytes: number; sha256: string }>;
