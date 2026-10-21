// Save33 ENOENT fix — F3 bounded coverage matrix (test-only).
// Companion to enoent-controls.test.ts; see FIX-SCOPE §2 for the
// site table. Faults are injected one at a time through
// fault-adapter.ts against a real file.
//
// Matrix (all cells run against BOTH the unfixed and the fixed
// file):
//   (i)  mapped: each post-pin lookup site (1 = stat(file),
//        2 = realpath(file), 3 = stat(canonicalPath)) × each mapped
//        code (ENOENT, ENOTDIR, EPERM) → on the FIXED file the
//        digest rejects ERR_WINDOWS_PATH_CHANGED with the module
//        message; on the UNFIXED file these 9 cells FAIL (the raw
//        injected code surfaces — the exact custody split).
//   (ii) pre-pin boundaries stay raw: initial realpath, open, and
//        the before-stat pin failures propagate the ORIGINAL error
//        object (identity, ===) on both files.
//   (iii) unmapped post-pin failures keep object identity: EACCES,
//        EIO, and a cancellation-shaped error from any lookup site
//        propagate as the SAME object on both files.
//   (iv) handle closure: the opened handle's close() runs exactly
//        once on success and on every refusal path exercised here.
//   (v)  retained final check: the post-close pathCheck still runs
//        and still rejects on a swap-during-close (FIX-SCOPE §1 —
//        with option B withdrawn this is the fixed file's own
//        retained :102 invocation).
//
// Module under test: process.env.ENOENT_MODULE (absolute path);
// defaults to the repo production module
// (electron/windows-path-identity.cjs).
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createFaultFs } from './fault-adapter';

const require = createRequire(import.meta.url);

const MODULE_PATH = process.env.ENOENT_MODULE
  ?? fileURLToPath(new URL('../../electron/windows-path-identity.cjs', import.meta.url));
const identityModule = require(MODULE_PATH);
const { coherentFileDigest } = identityModule;

const WIN_FILE = 'C:\\proj\\file-0.dxf';
const CHANGED_MESSAGE = 'The file changed during its content check.';

function makeTree(content: Buffer) {
  const rootPosix = fs.mkdtempSync(path.join(os.tmpdir(), 'jcad-enoent-matrix-'));
  const projPosix = path.join(rootPosix, 'proj');
  fs.mkdirSync(projPosix);
  const posixFile = path.join(projPosix, 'file-0.dxf');
  fs.writeFileSync(posixFile, content);
  return { rootPosix, posixFile, cleanup: () => fs.rmSync(rootPosix, { recursive: true, force: true }) };
}

function injected(code: string) {
  return Object.assign(new Error(`injected ${code}`), { code });
}

async function settle(promise: Promise<unknown>) {
  return promise.then(
    (value) => ({ resolved: true as const, value }),
    (error: unknown) => ({ resolved: false as const, error: error as { code?: string; message?: string } }),
  );
}

const SITES = [1, 2, 3] as const;
const MAPPED_CODES = ['ENOENT', 'ENOTDIR', 'EPERM'] as const;
// Sites that must have run exactly once before the faulting site
// fires (the fault is injected at the first pathCheck invocation).
const RAN_BEFORE: Record<number, { site1: number; site2: number; site3: number }> = {
  1: { site1: 1, site2: 0, site3: 0 },
  2: { site1: 1, site2: 1, site3: 0 },
  3: { site1: 1, site2: 1, site3: 1 },
};

describe('F3(i): mapped codes at each post-pin lookup site → ERR_WINDOWS_PATH_CHANGED (fixed); raw on custody', () => {
  for (const site of SITES) {
    for (const code of MAPPED_CODES) {
      it(`site ${site} × ${code}`, async () => {
        const tree = makeTree(Buffer.from('ORIGINAL'));
        try {
          const f = createFaultFs(tree.rootPosix, { failSite: site, error: injected(code) });
          const outcome = await settle(coherentFileDigest(WIN_FILE, { fs: f.fs }));
          expect(outcome.resolved).toBe(false);
          if (!outcome.resolved) {
            expect(outcome.error.code).toBe('ERR_WINDOWS_PATH_CHANGED');
            expect(outcome.error.message).toBe(CHANGED_MESSAGE);
          }
          // Position: the faulting site fired once; earlier sites
          // ran once; later sites never ran.
          expect(f.attempts.site1).toBe(RAN_BEFORE[site]!.site1);
          expect(f.attempts.site2).toBe(RAN_BEFORE[site]!.site2);
          expect(f.attempts.site3).toBe(RAN_BEFORE[site]!.site3);
          // F3(iv): the held handle was closed exactly once; no leak.
          expect(f.counts.handleClose).toBe(1);
          expect(f.counts.openHandles).toBe(0);
        } finally {
          tree.cleanup();
        }
      });
    }
  }
});

describe('F3(ii): pre-pin boundaries propagate the original error object (both files)', () => {
  it('initial realpath failure stays raw (identity), open never attempted', async () => {
    const tree = makeTree(Buffer.from('ORIGINAL'));
    try {
      const sentinel = injected('EACCES');
      const f = createFaultFs(tree.rootPosix, { failPreRealpath: sentinel });
      const outcome = await settle(coherentFileDigest(WIN_FILE, { fs: f.fs }));
      expect(outcome.resolved).toBe(false);
      if (!outcome.resolved) expect(outcome.error as unknown).toBe(sentinel);
      expect(f.attempts.open).toBe(0);
      expect(f.counts.openHandles).toBe(0);
    } finally {
      tree.cleanup();
    }
  });

  it('open failure stays raw (identity)', async () => {
    const tree = makeTree(Buffer.from('ORIGINAL'));
    try {
      const sentinel = injected('ENOENT');
      const f = createFaultFs(tree.rootPosix, { failOpen: sentinel });
      const outcome = await settle(coherentFileDigest(WIN_FILE, { fs: f.fs }));
      expect(outcome.resolved).toBe(false);
      if (!outcome.resolved) expect(outcome.error as unknown).toBe(sentinel);
      expect(f.counts.openHandles).toBe(0);
    } finally {
      tree.cleanup();
    }
  });

  it('before-stat (the pin) failure stays raw (identity); the handle is still closed once', async () => {
    const tree = makeTree(Buffer.from('ORIGINAL'));
    try {
      const sentinel = injected('EIO');
      const f = createFaultFs(tree.rootPosix, { failBeforeStat: sentinel });
      const outcome = await settle(coherentFileDigest(WIN_FILE, { fs: f.fs }));
      expect(outcome.resolved).toBe(false);
      if (!outcome.resolved) expect(outcome.error as unknown).toBe(sentinel);
      expect(f.counts.handleClose).toBe(1);
      expect(f.counts.openHandles).toBe(0);
    } finally {
      tree.cleanup();
    }
  });
});

describe('F3(iii): unmapped post-pin failures propagate as the SAME object (both files)', () => {
  const unmapped: Array<{ label: string; make: () => Error }> = [
    { label: 'EACCES', make: () => injected('EACCES') },
    { label: 'EIO', make: () => injected('EIO') },
    {
      label: 'cancellation-shaped (AbortError)',
      make: () => {
        const e = new Error('The operation was aborted.');
        e.name = 'AbortError';
        (e as { code?: string }).code = 'ABORT_ERR';
        return e;
      },
    },
  ];
  for (const site of SITES) {
    for (const { label, make } of unmapped) {
      it(`site ${site} × ${label} → object identity`, async () => {
        const tree = makeTree(Buffer.from('ORIGINAL'));
        try {
          const sentinel = make();
          const f = createFaultFs(tree.rootPosix, { failSite: site, error: sentinel });
          const outcome = await settle(coherentFileDigest(WIN_FILE, { fs: f.fs }));
          expect(outcome.resolved).toBe(false);
          if (!outcome.resolved) expect(outcome.error as unknown).toBe(sentinel);
          expect(f.counts.handleClose).toBe(1);
          expect(f.counts.openHandles).toBe(0);
        } finally {
          tree.cleanup();
        }
      });
    }
  }
});

describe('F3(iv)+(v): closure on success; the retained post-close final check', () => {
  it('success: handle closed exactly once, no leak', async () => {
    const tree = makeTree(Buffer.from('ORIGINAL'));
    try {
      const f = createFaultFs(tree.rootPosix, {});
      const out = await coherentFileDigest(WIN_FILE, { fs: f.fs });
      expect(out.bytes).toBe(8);
      expect(f.counts.handleClose).toBe(1);
      expect(f.counts.openHandles).toBe(0);
      // All three pathCheck invocations ran: site1 ×3, site2 ×3,
      // site3 ×3.
      expect(f.attempts.site1).toBe(3);
      expect(f.attempts.site2).toBe(3);
      expect(f.attempts.site3).toBe(3);
    } finally {
      tree.cleanup();
    }
  });

  it('retained final check: swap during close rejects via the post-close pathCheck', async () => {
    const tree = makeTree(Buffer.from('ORIGINAL'));
    try {
      const f = createFaultFs(tree.rootPosix, {
        baseHooks: {
          onClose: async ({ posixPath }: { posixPath: string }) => {
            const temp = `${posixPath}.swap-tmp`;
            fs.writeFileSync(temp, Buffer.from('REPLACED'));
            fs.renameSync(temp, posixPath);
          },
        },
      });
      const outcome = await settle(coherentFileDigest(WIN_FILE, { fs: f.fs }));
      expect(outcome.resolved).toBe(false);
      if (!outcome.resolved) {
        expect(outcome.error.code).toBe('ERR_WINDOWS_PATH_CHANGED');
        expect(outcome.error.message).toBe(CHANGED_MESSAGE);
      }
      // The post-close invocation RAN: it reached its first lookup
      // (site1 attempt 3) and refused there on the version key, so
      // its realpath (site2) never ran a third time. Path stats:
      // 2 + 2 + 1 = 5 on the file's win path.
      expect(f.attempts.site1).toBe(3);
      expect(f.attempts.site2).toBe(2);
      expect(f.attempts.site3).toBe(2);
      expect(f.counts.stat.get(WIN_FILE)).toBe(5);
      expect(f.counts.handleClose).toBe(1);
      expect(f.counts.openHandles).toBe(0);
    } finally {
      tree.cleanup();
    }
  });
});
