// ESLint flat config: the renderer and tests (TypeScript), the Electron main process and preload
// (CommonJS), the Node scripts and the example plugins. `npm run lint` (CI runs it with
// --max-warnings=0). The rules catch mistakes; formatting is left alone (no stylistic rules).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', 'dist-node/**', 'release/**', 'site-dist/**', 'screenshots/**', 'e2e-output/**', 'packaged-smoke-output/**', '.claude/**', '.codex-local/**', 'src/render/fonts/**', 'vendor/libredwg-web-bg/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Shared rule adjustments for every file.
    rules: {
      // Intentional: `catch {}` around optional work, empty arrow callbacks, `while (...) {}` scans.
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-empty-function': 'off',
      // `_name` marks a deliberately unused parameter or destructured rest.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      // Control characters in regular expressions are deliberate (DXF / PDF / MTEXT parsing).
      'no-control-regex': 'off',
      // A `let` that a callback reads before the single assignment (`let sm; host.onLoad = () => sm.x; sm = make()`) stays a let.
      'prefer-const': ['error', { destructuring: 'all', ignoreReadBeforeAssign: true }],
      // Byte order marks and no-break spaces in regular expressions and strings are deliberate.
      'no-irregular-whitespace': ['error', { skipStrings: true, skipRegExps: true, skipTemplates: true, skipComments: true }],
      // `const ed = this` for callbacks that need the editor next to their own `this` is the house style.
      '@typescript-eslint/no-this-alias': 'off',
      // `const crypto = require('node:crypto')` in the main process shadows the browser-style global on purpose.
      'no-redeclare': ['error', { builtinGlobals: false }],
    },
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', '*.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      // Test doubles and DXF / LibreDWG records are loosely typed on purpose in places.
      '@typescript-eslint/no-explicit-any': 'off',
      // `foo!` after a check the compiler cannot follow (noUncheckedIndexedAccess) is the house style.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['electron/**/*.cjs', 'scripts/**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'e2e/**/*.mjs', 'eslint.config.js'],
    // Playwright callbacks run in the page, so browser globals appear next to Node ones.
    languageOptions: { sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['scripts/types/**/*.d.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // The landing page script (site/), a plain browser script.
    files: ['site/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    // Example plugins: plain scripts that receive the free variable `jcad` (docs/PLUGIN-API.md).
    files: ['examples/plugins/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, jcad: 'readonly' } },
  },
);
