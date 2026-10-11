import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFixtures } from '../scripts/check-fixtures.mjs';

describe('mandatory committed fixture inventory', () => {
  it('requires every committed regression input', () => {
    expect(checkFixtures(join(import.meta.dirname, '..'))).toEqual([]);
  });
  it('fails for missing, empty and escaped fixture inputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'jcad-fixtures-'));
    try {
      mkdirSync(join(root, 'fixtures'));
      writeFileSync(join(root, 'fixtures/empty.dwg'), '');
      expect(checkFixtures(root, { schemaVersion: 1, files: ['fixtures/missing.dwg', 'fixtures/empty.dwg', 'fixtures/../../escape.dwg'] })).toEqual([
        'missing required fixture: fixtures/missing.dwg', 'empty or non-file fixture: fixtures/empty.dwg', 'fixture escapes repository: fixtures/../../escape.dwg',
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
