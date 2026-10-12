import type { SpawnSyncReturns } from 'node:child_process';
export function needsPackagedOrigin(version: string): boolean;
export function processResult(result: Pick<SpawnSyncReturns<Buffer>, 'status' | 'signal' | 'error'>): string;
export function childSucceeded(result: Pick<SpawnSyncReturns<Buffer>, 'status' | 'signal' | 'error'>): boolean;
export function dwgProbeSucceeded(result: Pick<SpawnSyncReturns<Buffer>, 'status' | 'signal' | 'error'>, line: string): boolean;
export function validateSmokeArchitecture(hostArch: string, expectedArch?: string, nativeOnly?: boolean): void;
export function macDmgTargets(files: string[], options: { hostArch: string; expectedArch?: string; nativeOnly?: boolean; rosetta?: boolean }): string[];
