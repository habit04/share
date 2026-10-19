// Loader for the preserved PRE-FIX double of
// electron/windows-path-identity.cjs, used by the MIRROR test in
// enoent-controls.test.ts. The MIRROR's subject is the unfixed
// module (its assertion documents the pre-fix gap), so it must run
// against pre-fix code even when the repo's production module is
// the fixed one.
//
// The double is retained as DATA, not as a .cjs source file:
// fixtures/windows-path-identity-unfixed.cjs.txt holds the exact
// pre-fix source (public bf7 lineage: git blob
// 8f0c245471055627635ce6b923e97c8756289ab6). It is stored as text
// because a live .cjs under tests/ falls outside the repo's
// CommonJS lint exceptions (electron/**, scripts/**) — the very
// finding that commissioned this conversion.
//
// Integrity: the fixture bytes are verified on every load against
// the pinned SHA-256 below, computed over the CR-stripped content.
// The pin is deliberately line-ending-insensitive: the custody
// lineage of this module reached the reviewers CRLF-converted
// (221 CR bytes, zero code difference — see the bf7 port's
// DELTA-ANALYSIS), so a raw-byte pin would break on an innocent
// checkout normalization while a content pin still catches any
// real drift. The materialized module is the stripped bytes,
// byte-identical to git blob 8f0c2454. Any other drift throws —
// the double fails loud rather than silently testing the wrong
// code.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// SHA-256 of the pre-fix module with CR bytes stripped (the public
// bf7 blob 8f0c2454's own SHA-256).
export const UNFIXED_MODULE_SHA256 = '2752303205f79d144ab3ed7f41e42a5d4381c701ed79d16c0eec3fc7cab2a15e';

export interface UnfixedIdentityModule {
  coherentFileDigest: (
    value: string,
    options?: { fs?: unknown; maxBytes?: number; signal?: AbortSignal },
  ) => Promise<{ sha256: string; bytes: number }>;
}

let cached: UnfixedIdentityModule | null = null;

export function loadUnfixedIdentityModule(): UnfixedIdentityModule {
  if (cached) return cached;
  const fixturePath = fileURLToPath(new URL('./fixtures/windows-path-identity-unfixed.cjs.txt', import.meta.url));
  const stripped = fs.readFileSync(fixturePath, 'utf8').replace(/\r/g, '');
  const digest = createHash('sha256').update(stripped, 'utf8').digest('hex');
  if (digest !== UNFIXED_MODULE_SHA256) {
    throw new Error(
      `Save33 ENOENT pre-fix double fixture drifted: CR-stripped sha256 ${digest} != pinned ${UNFIXED_MODULE_SHA256} (blob 8f0c2454).`,
    );
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jcad-enoent-unfixed-'));
  const modulePath = path.join(dir, 'windows-path-identity.cjs');
  fs.writeFileSync(modulePath, stripped, 'utf8');
  cached = require(modulePath) as UnfixedIdentityModule;
  return cached;
}
