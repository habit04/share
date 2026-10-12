export function writeDependencyNotices(packages: { name: string; version: string; source: string | null; manifest_path: string; license: string | null }[], file: string, runtimeRoot: string): Promise<void>;
export function bundleIntegrity(directory: string, metadata?: Record<string, unknown>): Promise<{ schemaVersion: number; files: { name: string; size: number; sha256: string }[] }>;
export function buildDwgWriter(options?: { root?: string }): Promise<{ schemaVersion: number; files: { name: string; size: number; sha256: string }[] }>;
