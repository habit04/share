export declare const SHIPPED_FUSES: Readonly<{ runAsNode: false; enableNodeOptionsEnvironmentVariable: false; enableNodeCliInspectArguments: false; enableEmbeddedAsarIntegrityValidation: true; onlyLoadAppFromAsar: true; grantFileProtocolExtraPrivileges: false }>;
export declare function shippedFuseProblems(executable: string): Promise<string[]>;
export declare function shipsFuses(version: string): boolean;
