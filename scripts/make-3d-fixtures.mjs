#!/usr/bin/env node
// Rebuild the committed 3D fixtures (tests/fixtures/3d/*.dxf) from tests/helpers/model3d-fixtures.ts.
//
// The builders are TypeScript that uses the in-process Manifold kernel and the editor's demo
// schematic, so they run under vitest (the repository's TypeScript runner): this script runs
// tests/model3d-fixtures.test.ts with JCAD_WRITE_3D_FIXTURES=1, which writes the files before the
// file's own checks read them back. Review the diff before committing regenerated fixtures.
//
//   npm run make:3d-fixtures
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const vitest = resolve(root, 'node_modules', 'vitest', 'vitest.mjs');
const result = spawnSync(process.execPath, [vitest, 'run', 'tests/model3d-fixtures.test.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, JCAD_WRITE_3D_FIXTURES: '1' },
});
process.exitCode = result.status ?? 1;
