/** Types for scripts/release-notes.mjs (plain JS so the release workflow runs it without a build). */
/** The macOS signing statuses a macOS build records (scripts/release-provenance.mjs). */
export const MAC_SIGNING: string[];
export function sectionFor(changelog: string, version: string): string | null;
export function releaseNotes(changelog: string, version: string, repo?: string, options?: { macSigning?: string }): string;
export interface ReleaseRecord { sourceSha: string; builds: { platform: string; signing: string }[] }
export function readProvenance(path: string): { macSigning: string; release: ReleaseRecord | null } | null;
