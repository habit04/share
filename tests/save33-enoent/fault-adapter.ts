// Fault-injection adapter for the F3 coverage matrix (test-only).
// Wraps the NTFS counting adapter (ntfs-adapter.ts) and injects ONE
// fault at ONE named position of coherentFileDigest's fs traffic,
// with per-position attempt counters so a test can assert which
// sites ran before the fault fired. Converted from the external
// battery's fault-adapter.cjs to the repo's ESM test conventions;
// behaviour is unchanged.
//
// Positions (custody line numbers, FIX-SCOPE §2):
//   preRealpath — fs.realpath(file) before the pin (:64)
//   open        — fs.open(file) before the pin (:69)
//   beforeStat  — the held handle's first stat, the pin (:71)
//   site1       — pathCheck lookup 1: fs.stat(file) (:78)
//   site2       — pathCheck lookup 2: fs.realpath(file) (:79)
//   site3       — pathCheck lookup 3: fs.stat(canonicalPath) (:80)
//
// Site attribution for fs.stat relies on pathCheck's fixed call
// pattern — stat, realpath, stat per invocation — and on the
// digest performing no other fs.stat after open (verified against
// the module source): post-open stats therefore alternate
// site1, site3, site1, site3, … A site fault fires only on that
// site's FIRST invocation (the pre-read pathCheck), so the digest
// rejects at the first check and later sites' attempts stay 0.
//
// fault = {
//   failPreRealpath?: Error, failOpen?: Error,
//   failBeforeStat?: Error,
//   failSite?: 1|2|3, error?: Error,   // for failSite
//   baseHooks?: hooks for createNtfsFs (e.g. onClose swap)
// }
import { createNtfsFs } from './ntfs-adapter';
import type { NtfsFsApi, NtfsFsCounts, NtfsFsHooks } from './ntfs-adapter';

export interface FaultSpec {
  failPreRealpath?: Error;
  failOpen?: Error;
  failBeforeStat?: Error;
  failSite?: 1 | 2 | 3;
  error?: Error;
  baseHooks?: NtfsFsHooks;
}

export interface FaultAttempts {
  preRealpath: number;
  open: number;
  beforeStat: number;
  site1: number;
  site2: number;
  site3: number;
}

export function createFaultFs(posixRoot: string, fault: FaultSpec = {}): { fs: NtfsFsApi; counts: NtfsFsCounts; attempts: FaultAttempts } {
  const base = createNtfsFs(posixRoot, fault.baseHooks ?? {});
  const attempts: FaultAttempts = { preRealpath: 0, open: 0, beforeStat: 0, site1: 0, site2: 0, site3: 0 };
  let opened = false;
  let statAfterOpen = 0;
  const api: NtfsFsApi = {
    constants: base.fs.constants,
    realpath: async (winPath) => {
      if (!opened) {
        attempts.preRealpath += 1;
        if (fault.failPreRealpath && attempts.preRealpath === 1) throw fault.failPreRealpath;
        return base.fs.realpath(winPath);
      }
      attempts.site2 += 1;
      if (fault.failSite === 2 && attempts.site2 === 1) throw fault.error;
      return base.fs.realpath(winPath);
    },
    stat: (winPath, options) => {
      statAfterOpen += 1;
      const isLogical = statAfterOpen % 2 === 1;
      if (isLogical) attempts.site1 += 1; else attempts.site3 += 1;
      const site = isLogical ? 1 : 3;
      const siteCount = isLogical ? attempts.site1 : attempts.site3;
      if (fault.failSite === site && siteCount === 1) throw fault.error;
      return base.fs.stat(winPath, options);
    },
    lstat: (winPath, options) => base.fs.lstat(winPath, options),
    open: async (winPath, flags) => {
      attempts.open += 1;
      if (fault.failOpen) throw fault.failOpen;
      const handle = await base.fs.open(winPath, flags);
      opened = true;
      let statCalls = 0;
      return {
        stat: async (...args: [{ bigint?: boolean }?]) => {
          statCalls += 1;
          if (statCalls === 1) {
            attempts.beforeStat += 1;
            if (fault.failBeforeStat) throw fault.failBeforeStat;
          }
          return handle.stat(...args);
        },
        read: (...args: any[]) => handle.read(...args),
        close: (...args: any[]) => handle.close(...args),
      };
    },
  };
  return { fs: api, counts: base.counts, attempts };
}
