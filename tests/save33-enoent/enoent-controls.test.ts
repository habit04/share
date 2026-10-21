// Save33 ENOENT error-identity fix controls (test-only).
//
// Subject: a PRE-EXISTING gap in coherentFileDigest
// (electron/windows-path-identity.cjs), observed on Windows by the
// lead on BOTH custody and the option-B candidate: when the file is
// deleted mid-read on NTFS, the held handle's stat does not change,
// so the :97 handle recheck passes and the digest proceeds until a
// PATH lookup inside pathCheck hits the missing file — whose raw
// ENOENT then propagates to the caller instead of the module's own
// changed() error (ERR_WINDOWS_PATH_CHANGED, 'The file changed
// during its content check.').
//
// The fix wraps pathCheck's three path lookups (:78 stat(file),
// :79 realpath(file), :80 stat(canonicalPath)) in a lookup() helper
// that maps ENOENT / ENOTDIR / EPERM from those post-pin lookups to
// changed(). Everything before the version pin (initial realpath
// :64, open :69) keeps its raw error identity.
//
// NTFS emulation on Linux: POSIX unlink moves ctimeNs in the held
// inode, so :97 would catch a plain POSIX delete and the leak would
// not reproduce. The adapter's freezeHandleStat mode returns the
// open-time stat snapshot for every held-handle stat — the NTFS
// observable — so the digest survives :97 and reaches the path
// lookup, exactly as on Windows. See ntfs-adapter.ts.
//
// Module under test: process.env.ENOENT_MODULE (absolute path);
// defaults to the repo production module
// (electron/windows-path-identity.cjs). Expected per-arm outcomes
// for the manual battery (ENOENT_MODULE set), identical to the
// external battery this file was converted from:
//   unfixed — the key test FAILS (raw ENOENT surfaces; recorded as
//             the fail-first evidence); the gap-documentation mirror
//             PASSES; all preservation tests PASS.
//   fixed   — the key test PASSES; the mirror FAILS (the leak is
//             gone); all preservation tests PASS.
// In the plain repo suite (ENOENT_MODULE unset) every test targets
// the production module EXCEPT the mirror: the mirror's subject is
// the unfixed module (see its name), so it binds to the preserved
// pre-fix double (unfixed-double.ts; fixtures/) and passes — its
// assertions are unchanged and true of their target. That keeps
// the suite green on the fixed composition without deleting the
// one test that documents the gap.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createNtfsFs } from './ntfs-adapter';
import { loadUnfixedIdentityModule } from './unfixed-double';

const require = createRequire(import.meta.url);

const MODULE_PATH = process.env.ENOENT_MODULE
  ?? fileURLToPath(new URL('../../electron/windows-path-identity.cjs', import.meta.url));
const identityModule = require(MODULE_PATH);
const { coherentFileDigest } = identityModule;

// The mirror documents the UNFIXED module's behaviour. Battery mode
// (ENOENT_MODULE set) binds it to the targeted module, exactly as
// the external battery did; suite mode binds it to the preserved
// pre-fix double, so the assertion stays true of its target.
const mirrorDigest = process.env.ENOENT_MODULE
  ? coherentFileDigest
  : loadUnfixedIdentityModule().coherentFileDigest;

const WIN_FILE = 'C:\\proj\\file-0.dxf';
const CHANGED_MESSAGE = 'The file changed during its content check.';
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function makeTree(content: Buffer | null) {
  const rootPosix = fs.mkdtempSync(path.join(os.tmpdir(), 'jcad-enoent-controls-'));
  const projPosix = path.join(rootPosix, 'proj');
  fs.mkdirSync(projPosix);
  const posixFile = path.join(projPosix, 'file-0.dxf');
  if (content !== null) fs.writeFileSync(posixFile, content);
  return {
    rootPosix,
    posixFile,
    cleanup: () => fs.rmSync(rootPosix, { recursive: true, force: true }),
  };
}

function swapIn(posixFile: string, content: Buffer) {
  const temp = `${posixFile}.swap-tmp`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, posixFile);
}

// F2 scenario for the swap-during-close control: the swap step is
// injected so the F2 self-checks below can substitute a no-op or a
// throwing swap. hookState and the installed bytes are observed
// OUTSIDE the digest's settled outcome, so the assertions on them
// cannot be satisfied by the rejection alone.
async function swapDuringCloseScenario(swap: (posixPath: string) => void) {
  const tree = makeTree(Buffer.from('ORIGINAL'));
  const hookState = { ran: false };
  const c = createNtfsFs(tree.rootPosix, {
    onClose: async ({ posixPath }) => {
      hookState.ran = true;
      swap(posixPath);
    },
  });
  const outcome = await settle(coherentFileDigest(WIN_FILE, { fs: c.fs }));
  const installed = fs.readFileSync(tree.posixFile, 'utf8');
  return { tree, c, outcome, hookState, installed };
}

// The F2 post-condition: the hook ran AND the replacement bytes are
// really installed at the path. A swap that silently did not happen
// makes this throw — see the self-checks.
function assertSwapInstalled(s: { hookState: { ran: boolean }; installed: string }) {
  expect(s.hookState.ran).toBe(true);
  expect(s.installed).toBe('REPLACED');
}

async function settle(promise: Promise<unknown>) {
  return promise.then(
    (value) => ({ resolved: true as const, value }),
    (error: unknown) => ({ resolved: false as const, error: error as { code?: string; message?: string } }),
  );
}

// 614,400 B = 3 read chunks at the 256 KiB HASH_CHUNK_BYTES, so the
// delete hook (first read) lands strictly mid-read.
function deleteMidReadSetup() {
  const tree = makeTree(Buffer.alloc(614_400, 0x41));
  let deleted = false;
  const c = createNtfsFs(tree.rootPosix, {
    freezeHandleStat: true,
    onRead: async ({ index, posixPath }) => {
      if (index === 1 && !deleted) {
        deleted = true;
        fs.rmSync(posixPath);
      }
    },
  });
  return { tree, c };
}

describe('the gap: NTFS-emulated delete mid-read', () => {
  it('KEY: delete mid-read rejects ERR_WINDOWS_PATH_CHANGED with the module message', async () => {
    const { tree, c } = deleteMidReadSetup();
    try {
      const outcome = await settle(coherentFileDigest(WIN_FILE, { fs: c.fs }));
      expect(outcome.resolved).toBe(false);
      if (!outcome.resolved) {
        expect(outcome.error.code).toBe('ERR_WINDOWS_PATH_CHANGED');
        expect(outcome.error.message).toBe(CHANGED_MESSAGE);
      }
      // Emulation pins: the :97 handle recheck RAN (before-stat + :97
      // = 2 handle stats) and passed against the frozen stat — so
      // the refusal provably came from a path lookup, not from :97.
      expect(c.counts.handleStat).toBe(2);
      // Path stats: 2 from the pre-read pathCheck (:84) + the first
      // lookup of the post-read pathCheck (:98), which is where the
      // missing file is hit.
      expect(c.counts.stat.get(WIN_FILE)).toBe(3);
    } finally {
      tree.cleanup();
    }
  });

  it('MIRROR (gap documentation): delete mid-read surfaces the raw fs ENOENT on the unfixed module', async () => {
    const { tree, c } = deleteMidReadSetup();
    try {
      const outcome = await settle(mirrorDigest(WIN_FILE, { fs: c.fs }));
      expect(outcome.resolved).toBe(false);
      if (!outcome.resolved) expect(outcome.error.code).toBe('ENOENT');
      expect(c.counts.handleStat).toBe(2);
      expect(c.counts.stat.get(WIN_FILE)).toBe(3);
    } finally {
      tree.cleanup();
    }
  });
});

describe('preservation (identical on custody and fixed)', () => {
  it('clean digest returns the correct sha256 of the file bytes', async () => {
    const tree = makeTree(Buffer.from('ORIGINAL'));
    try {
      const c = createNtfsFs(tree.rootPosix);
      const out = await coherentFileDigest(WIN_FILE, { fs: c.fs });
      expect(out.sha256).toBe(sha256('ORIGINAL'));
      expect(out.bytes).toBe(8);
      expect(c.counts.handleStat).toBe(2); // before + :97 recheck
    } finally {
      tree.cleanup();
    }
  });

  it('delete BEFORE open still surfaces the raw ENOENT (the pin boundary is respected)', async () => {
    const tree = makeTree(null); // the file never exists
    try {
      const c = createNtfsFs(tree.rootPosix);
      const outcome = await settle(coherentFileDigest(WIN_FILE, { fs: c.fs }));
      expect(outcome.resolved).toBe(false);
      if (!outcome.resolved) {
        expect(outcome.error.code).toBe('ENOENT');
        expect(outcome.error.message).not.toBe(CHANGED_MESSAGE);
      }
      // The failure is the pre-pin initial realpath (:64): exactly
      // one realpath attempt and no open ever happened.
      expect(c.counts.realpath.get(WIN_FILE)).toBe(1);
      expect(c.counts.open.get(WIN_FILE) ?? 0).toBe(0);
    } finally {
      tree.cleanup();
    }
  });

  it('append mid-read still rejects ERR_WINDOWS_PATH_CHANGED (via the :97 EOF probe)', async () => {
    const tree = makeTree(Buffer.alloc(614_400, 0x41));
    try {
      let appended = false;
      const c = createNtfsFs(tree.rootPosix, {
        onRead: async ({ index, posixPath }) => {
          if (index === 1 && !appended) {
            appended = true;
            fs.appendFileSync(posixPath, Buffer.from([0x01, 0x02, 0x03]));
          }
        },
      });
      const outcome = await settle(coherentFileDigest(WIN_FILE, { fs: c.fs }));
      expect(outcome.resolved).toBe(false);
      if (!outcome.resolved) {
        expect(outcome.error.code).toBe('ERR_WINDOWS_PATH_CHANGED');
        expect(outcome.error.message).toBe(CHANGED_MESSAGE);
      }
      // :97 fires before any post-read pathCheck: only the pre-read
      // pathCheck's 2 stats have run.
      expect(c.counts.stat.get(WIN_FILE)).toBe(2);
    } finally {
      tree.cleanup();
    }
  });

  it('swap during close still rejects ERR_WINDOWS_PATH_CHANGED (the post-close :102 check)', async () => {
    const s = await swapDuringCloseScenario((posixPath) => swapIn(posixPath, Buffer.from('REPLACED')));
    try {
      expect(s.outcome.resolved).toBe(false);
      if (!s.outcome.resolved) {
        expect(s.outcome.error.code).toBe('ERR_WINDOWS_PATH_CHANGED');
        expect(s.outcome.error.message).toBe(CHANGED_MESSAGE);
      }
      expect(s.c.counts.handleClose).toBe(1);
      // F2: the swap's success and the intended error are asserted
      // OUTSIDE the settled rejection — the hook provably ran and
      // the replacement bytes are really at the path.
      assertSwapInstalled(s);
    } finally {
      s.tree.cleanup();
    }
  });
});

describe('F2 hardening: swap-hook assertions cannot pass vacuously', () => {
  it('self-check: a no-op swap is caught by the post-condition (the rejection alone would miss it)', async () => {
    const s = await swapDuringCloseScenario(() => { /* deliberate no-op swap */ });
    try {
      // With no real swap, nothing changed, so the digest RESOLVES:
      // a control that only asserted the rejection could never
      // notice its swap had silently stopped working. The F2
      // post-condition must throw instead.
      expect(s.outcome.resolved).toBe(true);
      expect(() => assertSwapInstalled(s)).toThrow();
    } finally {
      s.tree.cleanup();
    }
  });

  it('self-check: a throwing swap hook fails loudly with its own error, not a swallowed pass', async () => {
    const sentinel = new Error('swap hook forced failure');
    const s = await swapDuringCloseScenario(() => { throw sentinel; });
    try {
      expect(s.outcome.resolved).toBe(false);
      if (!s.outcome.resolved) expect(s.outcome.error as unknown).toBe(sentinel);
      expect(s.hookState.ran).toBe(true);
    } finally {
      s.tree.cleanup();
    }
  });
});

describe('F2 hardening: adapter closes the acquired FD when a setup hook fails', () => {
  it('afterOpen failure: open() rejects with the initiating error object and no FD leaks', async () => {
    const tree = makeTree(Buffer.from('ORIGINAL'));
    try {
      const sentinel = new Error('afterOpen forced failure');
      const c = createNtfsFs(tree.rootPosix, {
        afterOpen: async () => { throw sentinel; },
      });
      const outcome = await settle(c.fs.open(WIN_FILE, fs.constants.O_RDONLY));
      expect(outcome.resolved).toBe(false);
      if (!outcome.resolved) {
        expect(outcome.error as unknown).toBe(sentinel);
        expect((sentinel as { cleanupFailed?: boolean }).cleanupFailed).toBeUndefined();
      }
      expect(c.counts.openHandles).toBe(0);
    } finally {
      tree.cleanup();
    }
  });

  it('freeze-capture failure: open() rejects with the initiating error object and no FD leaks', async () => {
    const tree = makeTree(Buffer.from('ORIGINAL'));
    try {
      const sentinel = new Error('freeze capture forced failure');
      const c = createNtfsFs(tree.rootPosix, {
        freezeHandleStat: true,
        freezeError: sentinel,
      });
      const outcome = await settle(c.fs.open(WIN_FILE, fs.constants.O_RDONLY));
      expect(outcome.resolved).toBe(false);
      if (!outcome.resolved) {
        expect(outcome.error as unknown).toBe(sentinel);
        expect((sentinel as { cleanupFailed?: boolean }).cleanupFailed).toBeUndefined();
      }
      expect(c.counts.openHandles).toBe(0);
    } finally {
      tree.cleanup();
    }
  });

  it('a successful open/close balances the live-FD counter', async () => {
    const tree = makeTree(Buffer.from('ORIGINAL'));
    try {
      const c = createNtfsFs(tree.rootPosix);
      const handle = await c.fs.open(WIN_FILE, fs.constants.O_RDONLY);
      expect(c.counts.openHandles).toBe(1);
      await handle.close();
      expect(c.counts.openHandles).toBe(0);
      expect(c.counts.handleClose).toBe(1);
    } finally {
      tree.cleanup();
    }
  });
});
