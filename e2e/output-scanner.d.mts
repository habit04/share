export function createLineScanner(onLine: (line: string) => void, onOverflow: () => void, maxChars?: number): { write(chunk: Buffer): void; end(): void; readonly bufferedChars: number };
export function createOutputGate(allow?: { re: RegExp; max: number }[]): { scanner: () => ReturnType<typeof createLineScanner>; problems(): string[] };
export const BAD_OUTPUT: RegExp[];
