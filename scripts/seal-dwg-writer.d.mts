export function signNativeHelper(file: string, win: unknown): Promise<void>;
export function verifyNativeHelperSignature(file: string, publisher: string): void;
export function sealDwgWriter(directory: string, options?: { win?: { signExts?: string[]; azureSignOptions?: { publisherName?: string; [key: string]: unknown } }; requireSigning?: boolean; platform?: string; sign?: typeof signNativeHelper; verify?: typeof verifyNativeHelperSignature }): Promise<'unsigned' | 'authenticode-verified'>;
