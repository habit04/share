// Keep Electron's global Process augmentation out of renderer/test typechecking.
// The implementation is separately checked against the full Playwright API.
export interface OriginDiagnosticApplication {
  process(): unknown;
  /** Used only by the best-effort CDP target probe; its absence is recorded, not fatal. */
  context?: () => unknown;
  windows(): unknown[];
  on(event: 'window', listener: (page: unknown) => void): unknown;
  off(event: 'window', listener: (page: unknown) => void): unknown;
  evaluate: unknown;
}
export declare function originFailureDiagnostics(app: OriginDiagnosticApplication, options: { profile: string; output?: string; launch: number }): {
  capture(error: unknown): Promise<void>;
  stop(): void;
};
