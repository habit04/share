/** Types for scripts/download-alerts.mjs (plain JS so the workflow can run it without a build). */

export interface ReleaseAsset {
  name: string;
  download_count?: number;
  browser_download_url?: string;
}

export interface Release {
  tag_name?: string;
  name?: string;
  draft?: boolean;
  assets?: ReleaseAsset[];
}

export interface AssetCounter {
  tag: string;
  name: string;
  count: number;
  url: string;
}

/** Installer counters keyed by `<tag>/<asset name>`. */
export type Snapshot = Record<string, AssetCounter>;

export interface CounterChange {
  key: string;
  tag: string;
  name: string;
  before: number;
  after: number;
  delta: number;
}

export interface TrackerState {
  counts: Record<string, number>;
  updated: string | null;
}

export interface RunResult {
  action: 'create' | 'paused' | 'reset' | 'none' | 'alert';
  changes: CounterChange[];
  issue?: number;
}

export const TRACKER_TITLE: string;
export const TRACKER_LABEL: string;

export function isInstaller(name: string): boolean;
export function snapshotFromReleases(releases: Release[]): Snapshot;
export function countsOf(snapshot: Snapshot): Record<string, number>;
export function diffCounts(prevCounts: Record<string, number> | null | undefined, snapshot: Snapshot): CounterChange[];
export function totalOf(snapshot: Snapshot): number;
export function parseState(body: string | null | undefined): TrackerState | null;
export function renderBody(snapshot: Snapshot, updatedIso: string): string;
export function renderComment(changes: CounterChange[], snapshot: Snapshot, sinceIso: string | null | undefined, nowIso: string): string;
export function compareTags(a: string, b: string): number;
export function main(argv?: string[], env?: NodeJS.ProcessEnv): Promise<RunResult>;
