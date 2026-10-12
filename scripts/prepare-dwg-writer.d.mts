export const DWG_WRITER_PINS: { schemaVersion: number; crate: { name: string; version: string; url: string; sha256: string; commit: string; license: string }; toolchain: { version: string; target: string }; patches: SourcePatch[] };
export interface SourcePatch { path: string; beforeSha256: string; afterSha256: string; replacements: { before: string; after: string; count: number }[] }
export function sourceHash(bytes: Buffer | string): string;
export function readSourceArchive(file: string): Promise<Buffer>;
export function verifySourceArchive(bytes: Buffer, expected?: string): void;
export function crateEntries(bytes: Buffer, prefix?: string): Map<string, Buffer>;
export function exactSourcePatch(bytes: Buffer, patch: SourcePatch): Buffer;
export function patchedCrateEntries(bytes: Buffer, pins?: typeof DWG_WRITER_PINS): Map<string, Buffer>;
export function verifyPreparedSource(dir: string, entries: Map<string, Buffer>): Promise<void>;
export function prepareDwgWriter(options?: { root?: string; archivePath?: string }): Promise<string>;
