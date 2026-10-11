import { describe, expect, it } from 'vitest';
import { ensureFileLimit, MAX_DRAWING_FILE_BYTES, MAX_PLUGIN_FILE_BYTES, MAX_PROJECT_FILE_BYTES } from '../src/io/file-limits';

describe('browser file metadata limits', () => {
  it('accepts each boundary and rejects oversized or invalid metadata before reading', () => {
    for (const maximum of [MAX_DRAWING_FILE_BYTES, MAX_PLUGIN_FILE_BYTES, MAX_PROJECT_FILE_BYTES]) {
      expect(() => ensureFileLimit({ name: 'drawing.dxf', size: maximum }, maximum)).not.toThrow();
      expect(() => ensureFileLimit({ name: 'drawing.dxf', size: maximum + 1 }, maximum)).toThrow(/drawing.dxf.*MiB file limit/);
      for (const size of [NaN, Infinity, -1, 0.5]) expect(() => ensureFileLimit({ name: 'bad', size }, maximum)).toThrow();
    }
  });
});
