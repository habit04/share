export interface WindowsPayloadFile { path: string; bytes: number; sha256: string }
export interface WindowsPayloadInventory { files: WindowsPayloadFile[]; directories: string[]; inventorySha256: string }
export interface WindowsPayloadCriticalFiles { executable: WindowsPayloadFile; asar: WindowsPayloadFile; helper: WindowsPayloadFile; helperManifest: WindowsPayloadFile; helperSigning: string }
export interface WindowsPayloadProof extends WindowsPayloadInventory {
  schemaVersion: number; kind: string; expectedVersion: string;
  installer: { path: string; bytes: number; sha256: string }; extractionRoot: string; payloadRoot: string;
  extractionMode: string; archiveEvidence: WindowsPayloadArchiveEvidence;
  criticalFiles: WindowsPayloadCriticalFiles; signatureAndFuseEvidence: string;
}
export interface WindowsArchiveEntry { path: string; directory: boolean; bytes: number; link: boolean }
export interface WindowsPayloadArchiveEvidence { type: string; offset: number; physicalSize: number; tailSize: number; warnings: string[]; warningCount: number; listingSha256: string }
export interface WindowsPayloadExtractionOptions { installer: string; expectedVersion: string; scratchParent?: string; outDir?: string }
export interface WindowsInstalledPayloadResult {
  schemaVersion: number; expectedVersion: string; executable: string; payloadFilesMatched: number;
  inventorySha256: string; installer: WindowsPayloadProof['installer']; criticalFiles: WindowsPayloadCriticalFiles;
  uninstaller: Array<WindowsPayloadFile & { signature: { status: string; publisher: string } }>;
  exactPayloadMatch: boolean; signatureAndFuseEvidence: string;
}
export function parseWindowsArchiveListing(text: string): Array<Omit<WindowsArchiveEntry, 'link'>>;
export function parseWindowsInstallerArchiveListing(text: string, options: { archivePath: string; archiveBytes: number; role?: 'installer' | 'payload' }): { extractionMode: string; entries: Array<Omit<WindowsArchiveEntry, 'link'>>; evidence: WindowsPayloadArchiveEvidence };
export function validateWindowsArchiveEntries(entries: WindowsArchiveEntry[]): Array<Omit<WindowsArchiveEntry, 'link'>>;
export function inventoryWindowsPayload(directory: string): WindowsPayloadInventory;
export function extractWindowsInstallerPayload(options: WindowsPayloadExtractionOptions): Promise<WindowsPayloadProof>;
export function verifyInstalledWindowsPayload(options: { executable: string; payloadProof: WindowsPayloadProof }): Promise<WindowsInstalledPayloadResult>;
/** Dependency injection for unit tests; production exports use the installed pinned tool and native signature verifier. */
export function createWindowsPayloadVerifier(dependencies?: {
  getArchiveTool?: () => string | Promise<string>;
  runArchive?: (tool: string, args: string[]) => string | Promise<string>;
  verifyUninstaller?: (file: string) => { status: string; publisher: string } | Promise<{ status: string; publisher: string }>;
}): {
  extractWindowsInstallerPayload: typeof extractWindowsInstallerPayload;
  verifyInstalledWindowsPayload: typeof verifyInstalledWindowsPayload;
};
