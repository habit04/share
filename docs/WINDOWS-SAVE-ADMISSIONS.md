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

- Host limits: 32 pending reservations, 512 ordering records, 128 MiB per payload and 256 MiB
  queued payloads. Unclaimed/bound tickets expire after two minutes; running work joins cleanup.
- Closed project files reserve their orders before any read or global calculation. A batch
  exceeding available reservations is refused before changes. Larger batches require a separate
  bounded batch-order protocol; they are not silently processed with newly issued late orders.
- Runtime aliases retain at most 2,048 entries/4 MiB of characters. Conflicting verified
  mappings or exhausted capacity fail explicitly; evidence is not silently evicted.
- Commit receipts retain at most 64 unconsumed results per renderer owner. A missing receipt
  refuses marking a newly saved drawing clean rather than guessing its current file identity.
- File versions use native dev/ino/size/mtime/ctime evidence, rather than a content hash.
  Node has no portable openat/renameat API; a hostile external process can still race the final
  check and OS replacement. Dedicated case-sensitive directories, UNC shares and virtual/RAM
  drive providers need additional fixtures. Native identity-unavailable providers are not certified.
- Direct non-project text/PDF export producer ordering is a separate follow-up. Native DWG
  converter/reference equivalence and real-file verification remain with priorities 19/29.

The portable-writer integrity repair is the completed eight-line admission loop from merged
PR #9 commit `b7c930447d0d081ae241fba2b58fac4b5271e85b`, integrated as `05feb08`.
Each admission hashes bounded actual executable/dependency bytes, even when timestamps match.
Three deterministic real-byte/controlled-stat regressions pass. A new native NTFS run accepted
19/64 changed binaries before the repair and 0/64 afterward despite 21 identity collisions.
This does not certify the portable writer or an installed release.

The foundation/preparation suites pass 88 native tests. Renderer admission tests use a mocked
transport and pass 31 cases. Actual production IPC callbacks additionally exercise native
Unicode files, junctions, backups, reloads, committed receipts, native DXF edit/undo/reopen and
sharing retries. Full branch and actual Electron gate results are recorded in the checklist.
