export interface WasmMemoryLimits {
  origin: 'defined' | 'import';
  module?: string;
  name?: string;
  flags: number;
  minPages: number;
  maxPages: number | null;
  minBytes: number;
  maxBytes: number | null;
}
export interface NativeRuntimeVerification {
  directory: string;
  source: { repository: string; tag: string; commit: string };
  compiler: string;
  declarationCompiler: string;
  workflow: { repository: string; commit: string; runId: string; runAttempt: string };
  factorySha256: string;
  wasmSha256: string;
  memory: WasmMemoryLimits;
  masks: Array<{ text: string; flags: number; scale?: number; color?: { index?: number; method?: number; rgb?: number; name?: string; book_name?: string } }>;
}
export const NATIVE_SOURCE: Readonly<{ repository: string; tag: string; commit: string }>;
export function wasmMemoryLimits(bytes: Uint8Array): WasmMemoryLimits[];
export function verifyNativeRuntime(directory: string, fixturePath: string, expectedPath: string): Promise<NativeRuntimeVerification>;
