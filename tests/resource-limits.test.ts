import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { readLimitedFile, validateTextSize, validatePaperDimensions } = require('../electron/resource-limits.cjs');
const { hasTrustedPublisher } = require('../electron/update-policy.cjs');

describe('bounded file reads and plot dimensions', () => {
  const reader = (reportedSize: number, content: string) => {
    let offset = 0;
    const handle = {
      stat: async () => ({ size: reportedSize, isFile: () => true }),
      read: vi.fn(async (buffer: Buffer, at: number, length: number) => {
        const source = Buffer.from(content);
        const bytesRead = Math.min(length, source.length - offset);
        source.copy(buffer, at, offset, offset + bytesRead); offset += bytesRead;
        return { bytesRead };
      }),
      close: vi.fn(async () => undefined),
    };
    return { fs: { open: async () => handle }, handle };
  };
  it('rejects oversized input before reading and always closes the handle', async () => {
    const r = reader(101, 'abc');
    await expect(readLimitedFile(r.fs, 'drawing.dxf', 100)).rejects.toThrow(/size limit/);
    expect(r.handle.read).not.toHaveBeenCalled();
    expect(r.handle.close).toHaveBeenCalledOnce();
  });
  it('detects a file that grows after stat instead of silently truncating it', async () => {
    const r = reader(3, 'abcd');
    await expect(readLimitedFile(r.fs, 'drawing.dxf', 100)).rejects.toThrow(/File changed/);
    expect(r.handle.close).toHaveBeenCalledOnce();
  });
  it('reads an input at the exact byte boundary', async () => {
    const r = reader(3, 'abc');
    expect(await readLimitedFile(r.fs, 'drawing.dxf', 3, 'utf8')).toBe('abc');
  });
  it('keeps Unicode writes within the same byte limit used by reads', async () => {
    const text = '雷Δ'; // 5 UTF-8 bytes, 2 UTF-16 code units.
    expect(() => validateTextSize(text, 4, 'project')).toThrow(/project payload/);
    expect(() => validateTextSize(text, 5, 'project')).not.toThrow();
    const r = reader(5, text);
    expect(await readLimitedFile(r.fs, 'project.json', 5, 'utf8')).toBe(text);
    expect(() => validateTextSize(null, 5)).toThrow(/payload/);
  });
  it('rejects nonfinite, negative and oversized print dimensions', () => {
    for (const width of [Infinity, NaN, -1, 0, 201, '10']) expect(() => validatePaperDimensions({ width, height: 11 })).toThrow(/Paper dimensions/);
    expect(() => validatePaperDimensions({ width: 8.5, height: 11 })).not.toThrow();
    expect(() => validatePaperDimensions({})).not.toThrow();
  });
});
describe('update publisher policy', () => {
  it('requires a nonempty publisher identity from packaged update configuration', () => {
    for (const config of [undefined, {}, { publisherName: '' }, { publisherName: [] }, { publisherName: ['ACME', ''] }, { publisherName: 1 }]) expect(hasTrustedPublisher(config)).toBe(false);
    expect(hasTrustedPublisher({ publisherName: 'ACME LLC' })).toBe(true);
    expect(hasTrustedPublisher({ publisherName: ['ACME LLC', 'ACME Inc.'] })).toBe(true);
  });
});
