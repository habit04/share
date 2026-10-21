// Manual-battery config for the Save33 ENOENT suite: run from this
// folder (or pass --config tests/save33-enoent/vitest.config.ts)
// with ENOENT_MODULE set to the module under test. The plain repo
// suite does not use this file — the root vite.config.ts picks the
// two test files up directly.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['enoent-controls.test.ts', 'enoent-matrix.test.ts'],
    testTimeout: 20_000,
  },
});
