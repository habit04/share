export declare const SHIPPED_FUSES: Readonly<{ runAsNode: false; enableNodeOptionsEnvironmentVariable: false; enableNodeCliInspectArguments: false; onlyLoadAppFromAsar: true }>;
export declare function shippedFuseProblems(executable: string): Promise<string[]>;
export declare function allowInspectForTests(executable: string): Promise<void>;
export declare function shipsFuses(version: string): boolean;
