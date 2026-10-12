export function verifySignedDwgWriter(options?: {
  root?: string;
  sourceSha?: string;
  publisher?: string;
  head?: () => string;
  verifySignature?: (file: string, publisher: string) => void;
}): Promise<{
  schemaVersion: number;
  sourceSha: string;
  version: string;
  signing: string;
  publisher: string;
  integrityManifestSha256: string;
  engine: unknown;
  files: Array<{ name: string; size: number; sha256: string }>;
}>;
