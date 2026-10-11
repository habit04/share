/** Types for scripts/release-notes.mjs (plain JS so the release workflow runs it without a build). */
export function sectionFor(changelog: string, version: string): string | null;
export function releaseNotes(changelog: string, version: string, repo?: string): string;
