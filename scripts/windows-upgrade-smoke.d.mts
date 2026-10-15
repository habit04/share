export interface UpgradeCase { readonly name: string; readonly experimental3d: boolean; readonly importForeign3d: boolean }
export interface UpgradeSignature { status: string; publisher: string; thumbprint: string }
/** Raw PE string values, retained without semantic-version normalization. */
export interface UpgradeVersionInfo { version: string; fileVersion: string }
export interface UpgradeSignedExecutable extends UpgradeSignature, UpgradeVersionInfo { sha256: string; bytes: number }
export interface UpgradeTree { files: Array<{ path: string; directory?: boolean; bytes?: number; sha256?: string }>; bytes: number; sha256: string }
export interface UpgradeSnapshot extends UpgradeTree { label: string }
export interface UpgradeDriver {
  preflight(): Promise<unknown>;
  acquireBaseline(pin: typeof WINDOWS_UPGRADE_BASELINE): Promise<{ sha256: string; bytes: number }>;
  signature(role: string): Promise<UpgradeSignature>;
  identity(role: string, version: string): Promise<unknown>;
  uninstall(role: string): Promise<void>;
  install(role: string): Promise<void>;
  createProfile(settingsCase: UpgradeCase): Promise<void>;
  probe(settingsCase: UpgradeCase, phase: string, version: string): Promise<Record<string, unknown>>;
  snapshot(settingsCase: UpgradeCase, label: string): Promise<UpgradeSnapshot>;
  assertUnchanged(settingsCase: UpgradeCase, snapshot: UpgradeSnapshot): Promise<void>;
  restore(settingsCase: UpgradeCase, snapshot: UpgradeSnapshot): Promise<void>;
}
export const WINDOWS_UPGRADE_BASELINE: Readonly<{ version: '0.5.0'; publisher: 'Justin Rodriguez'; url: string; sha256: string; bytes: number }>;
export const WINDOWS_UPGRADE_REGISTRATION: Readonly<{ key: string; installationKey: string }>;
export const WINDOWS_UPGRADE_REGISTRY_QUERY: string;
export interface UpgradeRegistration { hive: string; view: string; key: string; name: string; version: string; icon: string; installationKey: string; installationPresent: boolean; location: string }
export function selectWindowsUpgradeRegistration(inventory: unknown, options: { target: string; candidateVersion: string }): UpgradeRegistration[];
export const WINDOWS_UPGRADE_CASES: readonly UpgradeCase[];
export const WINDOWS_UPGRADE_RECOVERY_INPUTS: readonly Readonly<{ file: string; lf: string; crlf: string }>[];
export interface UpgradeRecoveryProof {
  source: string; scope: string;
  inputs: Array<{ file: string; baselineGitSha256: string; baselineLoadedSha256: string; currentSha256: string; exactBytesEqual: boolean; baselineEncoding: string; currentEncoding: string }>;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}
export function isolatedWindowsPowerShellEnvironment(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function seedWindowsUpgradeRecoveryFixture(options: { profile: string; repo: string; baselineArchive?: string | null }): Promise<UpgradeRecoveryProof>;
export function assertWindowsUpgradeRecoveryFixture(profile: string, proof: unknown): void;
export function assertWindowsUpgradeHost(context: { platform: string; arch: string; env: NodeJS.ProcessEnv }): void;
export function needsWindowsUpgradeSmoke(version: string, platform?: string): boolean;
export function assertUpgradeSignature(record: unknown, publisher?: string): void;
export function assertWindowsInstallerVersion(record: unknown, expectedVersion: string): void;
export function assertWindowsApplicationVersion(record: unknown, expectedVersion: string): void;
export function verifyWindowsUpgradeInstaller(file: string, expectedVersion: string): UpgradeSignedExecutable;
export function verifyWindowsUpgradeApplication(file: string, expectedVersion: string): UpgradeSignedExecutable;
export function assertCleanWindowsUpgradeInventory(inventory: unknown): void;
export function assertCleanWindowsUpgradeHostBeforeInstall(options: { repo: string; outDir: string }): { hostedWindows: boolean; sourceSha: string; runId: string; inventory: unknown; noAutoCadEvidence: string; scope: string };
export function assertWindowsShippingPayloadTrust(record: unknown, expectedVersion: string, configuredPublisher?: string): void;
export function verifyWindowsShippingPayloadTrust(options: { executable: string; expectedVersion: string }): { expectedVersion: string; updaterPublishers: unknown; application: UpgradeSignedExecutable; helper: UpgradeSignature & { sha256: string; bytes: number } };
export function assertStableWindowsUpgradeRegistration(entries: unknown, expected?: Array<{ hive: string; view: string; key: string }> | null): Array<{ hive: string; view: string; key: string }>;
export function assertUpgradeProbe(record: unknown, options: { phase: string; version: string; settingsCase: UpgradeCase; upgraded?: boolean }): void;
export function executeWindowsUpgradeSequence(options: { expectedVersion: string }, driver: UpgradeDriver): Promise<{
  baseline: typeof WINDOWS_UPGRADE_BASELINE; expectedVersion: string; cleanHost: unknown;
  signatures: Array<UpgradeSignature & { role: string }>; identities: unknown[];
  cases: Array<{ name: string; first: unknown; preUpgrade: UpgradeSnapshot; upgraded?: unknown; preDowngrade?: UpgradeSnapshot; rollback?: unknown; beforeFinalCandidate?: UpgradeSnapshot }>;
  rollback: string; finalCandidateRestored: boolean; limitations: string[];
}>;
export function inventoryUpgradeTree(directory: string): UpgradeTree;
export function assertOwnedUpgradePath(file: string, scratchParent: string, prefix: string): string;
export function runWindowsUpgradeSmoke(options: { candidateInstaller: string; installedExecutable: string; expectedVersion: string; outDir: string; repo: string; verifyInstalledPayload: (executable: string) => Promise<unknown> }): ReturnType<typeof executeWindowsUpgradeSequence>;
