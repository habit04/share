# Windows save admission and path reliability

The Windows app captures a main-owned save order before serialization, native pickers or
conversion. One-use tickets belong to a live renderer document and an authorized logical path.
Save, Save As, project saves and DWG copies bind before preparing output. Native canonical
parents and stored leaf names identify existing aliases without JavaScript Unicode folding.
Distinct dotted-I and composed/decomposed NTFS names retain separate grants and drawings.

The host serializes commits by native parent namespace. A completed newer save refuses an older
prepared alias, including names that did not exist when they were bound. Authorization, root,
parent and native file-version checks run again immediately before every rename attempt,
including Windows sharing-violation retries. Unsupported or changed identities fail explicitly.
Atomic writes preserve stored filename casing and exact previous bytes in backups.

Native file versions also carry a SHA256 of fresh bytes read through one held descriptor.
Restoring size/timestamps cannot reuse a cached content result. Calculation reads compare their
actual returned bytes with the original pin, and standalone opens recheck those bytes after
closing and decoding. A committed replacement becomes an own version only when its actual
digest matches the exact captured write payload. A later external edit is never adopted as a
successful own transition. Unverified replacements retain dirty/recovery state, require a
destination review and stop dependent project outputs.

Project backup preparation uses the same bound ticket and namespace queue without consuming
the drawing save. An older preparation cannot replace a newer save's backup. Copy failures keep
the existing Continue Without Backup choice; that choice cannot override a stale/version check.
Cancellation joins owned cleanup before releasing the reservation.

Returned drawing bytes and open identities are checked against the same held descriptor before
and after reading, then against the original path after close and decoding. Successful saves
produce owner-bound, single-use commit receipts. The renderer uses that captured identity
instead of resolving a possibly retargeted junction after saving. Missing leaves remain
provisional until a verified commit. Runtime alias evidence is never drawing or project data.

Page reload, renderer loss and window destruction retire the old owner. A compatibility Save As
captures its owner before opening its native picker. Tab replacement and edits during saving
retain the existing snapshot/generation rules; failed, stale or unverified saves keep dirty and
recovery state. Unverified recovered/imported source aliases require an explicit loss review.

## Bounds and remaining requirements

- Host limits: 32 ordinary pending reservations/shared active operations, 640 ordering records,
  128 MiB per payload and 256 MiB
  queued payloads. Unclaimed/bound tickets expire after two minutes; running work joins cleanup.
- Project calculations issue one opaque parent order before any project/tab snapshot or producer.
  Up to 512 declared sources share inherited child orders, with at most two parents/one per owner,
  128 MiB aggregate native input and 16 MiB retained pin characters. Missing sources with an existing
  parent remain explicit nonwritable skips. Duplicate native targets, changed roots or unauthorized
  paths refuse preparation. Closed DWGs remain skipped as in the released behavior.
- Every successfully read source remains part of the calculation basis, including unchanged files.
  Sealing reserves ordering capacity only for selected outputs without publishing attempted saves.
  Final preflight precedes tab/history changes; every copy/write guard rechecks all source pins and
  accepts version transitions only from this parent's proven commits. Automatic backups also repeat
  the host guard before replacement. Per-parent queues prevent one own rename racing its proof.
- Native metadata checks use bounded chunks and a host-wide eight-check scheduler, joining all
  started work on failure/cancellation. Whole-batch guards cost O(n²); a ten-minute hard lifetime
  still applies. Before the byte-digest extension, full native 32/65-file backup/write probes
  completed in 14.7/58.9 seconds on this
  machine, with all capacity/queue/byte counters zero after cleanup. These use tiny authored file
  bytes, not CAD conversion. Native 512-file binding passes; full 512-file writing is not certified
  within the hard lifetime. Those timings do not certify throughput with fresh digest checks.
  Counts are ceilings rather than a completion-time guarantee.
- Renderer preparation separately bounds decoded input/output bytes, retained geometry work,
  characters/nodes/fields. It checks every captured open-source state/history/revision before
  mutation and permits only its planned transitions afterward. These bounds are not RSS estimates.
  Untitled tabs remain valid targets; duplicate open sheet rows refuse preparation. Edits to an
  open calculation source during an awaited write cancel dependent work immediately. Reentrant
  edits are preserved, and a write that already committed is reported with the resulting conflict.
  Files already committed are reported individually; this is not an
  atomic multi-file transaction, and Node cannot remove the final check-to-rename race.
- Runtime aliases retain at most 2,048 entries/4 MiB of characters. Conflicting verified
  mappings or exhausted capacity fail explicitly; evidence is not silently evicted.
- Commit receipts retain at most 64 unconsumed results per renderer owner. A missing receipt
  refuses marking a newly saved drawing clean rather than guessing its current file identity.
- Content checks retain native dev/ino/size/mtime/ctime plus actual-byte SHA256 evidence. Metadata
  lookups remain read-only and do not read contents; authorized admissions add the content pin.
  Hash reads use a fixed 256 KiB buffer and explicit 128 MiB per-file bounds, with cancellation
  between chunks. Cleanup may verify metadata alone; write/version checks cannot select that mode.
  Node has no portable openat/renameat API; a hostile external process can still race the final
  check and OS replacement. Dedicated case-sensitive directories, UNC shares and virtual/RAM
  drive providers need additional fixtures. Native identity-unavailable providers are not certified.
- Direct non-project text/PDF export producer ordering is a separate follow-up. Native DWG
  converter/reference equivalence and real-file verification remain with priorities 19/29.

A private native audit proved that dev/ino/size/mtime/ctime alone are insufficient on this Windows
filesystem: 10/64 same-size edited DXFs retained identical native fields after restoring mtime,
and the prior ordinary admission accepted stale overwrites in all ten. The drawings were valid
private copies with decoded TEXT values and independent hashes. Deterministic real-byte tests
hold those native fields constant rather than relying on a timing collision in CI. Repaired
native trials refuse all 64 ordinary and 64 project outside edits. A separate 64-trial native
probe refuses a real five-field collision. Both leave all host resources at zero after cleanup.

One separate confirmed requirement remains: a document opened earlier has no retained source
version for a later ordinary Save. A fresh admission protects the version found at that later
bind, allowing an external edit made before bind to be overwritten. A private actual Electron
case also proved that a second own save rotates away the first external-byte backup after
recovery has been cleared. Owner-bound completed-open evidence is the next reliability slice;
the in-flight admission checks do not certify this earlier-open baseline.

The portable-writer integrity repair is the completed eight-line admission loop from merged
PR #9 commit `b7c930447d0d081ae241fba2b58fac4b5271e85b`, integrated as `05feb08`.
Each admission hashes bounded actual executable/dependency bytes, even when timestamps match.
Three deterministic real-byte/controlled-stat regressions pass. A new native NTFS run accepted
19/64 changed binaries before the repair and 0/64 afterward despite 21 identity collisions.
This does not certify the portable writer or an installed release.

The earlier foundation/preparation suites pass 88 native tests. Renderer admission tests use a mocked
transport and passed 31 cases in that milestone. Actual production IPC callbacks additionally exercise native
Unicode files, junctions, backups, reloads, committed receipts, native DXF edit/undo/reopen and
sharing retries. The batch foundation has 47 new native regressions, plus separate renderer
transport and production IPC tests. Full branch and actual Electron gate results are recorded in
the checklist. The latest byte-digest/backend targeted gate passes 160 tests; renderer-related
targeted suites pass 248. Combined validation passes 3,468 tests / 28 conditional skips, all
three TypeScript checks, broad lint, fixtures and production build. Final source Electron passes
9 project, 17 save/recovery and 7 tracked 2D workflows with unchanged source/bundle hashes.
Native destination answers and a controlled post-rename outside edit are the app test injections;
codecs, IPC, files, backup/recovery and ordinary UI behavior are real. Owned processes are closed.
