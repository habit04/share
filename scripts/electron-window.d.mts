// Keep Electron's global Process augmentation out of renderer/test typechecking.
// The implementation is separately checked against the full Playwright API.
// applicationWindow's page stays `any`: its script consumers were written against
// the untyped page (Playwright's evaluate generics would otherwise re-infer
// result types across them); the implementation itself only needs the two
// members in the parameter shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberate, see above
export declare function applicationWindow(app: { windows(): { isClosed(): boolean; url(): string }[] }, timeout?: number): Promise<any>;

export interface ClosableApplication {
  close(): Promise<unknown>;
  process(): { pid?: number; exitCode?: number | null; signalCode?: string | null; once?: (event: string, listener: () => void) => void };
}

export interface CloseApplicationResult {
  outcome: 'closed' | 'rejected' | 'timeout';
  ms: number;
  error?: unknown;
  detail?: string;
}

export declare function closeApplication(app: ClosableApplication, timeout?: number): Promise<CloseApplicationResult>;
