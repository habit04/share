import type { SpawnSyncReturns } from 'node:child_process';
export function needsPackagedOrigin(version: string): boolean;
export function processResult(result: Pick<SpawnSyncReturns<Buffer>, 'status' | 'signal' | 'error'>): string;
