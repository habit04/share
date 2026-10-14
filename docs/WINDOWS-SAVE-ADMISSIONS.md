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

- Host limits: 32 non-batch pending reservations/shared active operations and 640 ordering
  records. Ordinary payloads retain 128 MiB each / 256 MiB queued; PDF exports have separate
  512 MiB payload / 512 MiB queued bounds and a 768 MiB combined retained-payload ceiling.
  Unclaimed/bound tickets expire after two minutes; running work joins cleanup.
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
  Hash reads use a fixed 256 KiB buffer and explicit 128 MiB per-file drawing/source bounds,
  with cancellation between chunks. Main-owned PDF exports seal a separate 512 MiB content
  budget, preserving the existing PDF ceiling without increasing reader/drawing/project limits.
  Cleanup may verify metadata alone; write/version checks cannot select that mode.
  Node has no portable openat/renameat API; a hostile external process can still race the final
  check and OS replacement. Dedicated case-sensitive directories, UNC shares and virtual/RAM
  drive providers need additional fixtures. Native identity-unavailable providers are not certified.
- Direct text/PDF exports use the same owner/order/native-target service; the final follow-up's
  validation is tracked below. Native DWG converter/reference equivalence and real-file
  verification reuse the completed external work in priorities 19/29.

A private native audit proved that dev/ino/size/mtime/ctime alone are insufficient on this Windows
filesystem: 10/64 same-size edited DXFs retained identical native fields after restoring mtime,
and the prior ordinary admission accepted stale overwrites in all ten. The drawings were valid
private copies with decoded TEXT values and independent hashes. Deterministic real-byte tests
hold those native fields constant rather than relying on a timing collision in CI. Repaired
native trials refuse all 64 ordinary and 64 project outside edits. A separate 64-trial native
probe refuses a real five-field collision. Both leave all host resources at zero after cleanup.

## Completed-open source protection

Open now returns an opaque main-owned proof for the exact completed held-descriptor bytes and
native version. A tab retains that proof outside drawing data, undo/history, DXF, project files
and recovery documents. Normal Save checks that original lineage before backup preparation and
each write guard. An outside edit made before a later admission refuses without replacing the
file or backup; two consecutive refused Saves retain dirty state and recovery. Reopening to
activate an existing tab releases its unused new proof instead of refreshing the old baseline.

Verified own commits advance the physical lineage with immutable owner/order evidence. A
successful one-use receipt updates only the matching saving session/content generation. Older
results cannot replace a newer Save As binding. A separate Save As creates its own lineage;
source aliases and hardlinks must still match the protected version. Missing/recovered source
evidence requires a separate copy or reopening. Omitted and null source contexts cannot freshly
adopt an active protected original. Earlier hosts without this protocol retain the old contract.

The registry reserves space before reads, backup or writes: 256 records globally, 128 per owner,
32 pending and 4 MiB retained characters (the combined character budget may refuse earlier).
No live baseline is evicted. Borrowed proofs and retired pending reservations stay charged until
their read/write cleanup joins. Each lineage retains one latest snapshot, rather than a growing
chain of previous saves. A producer error after verified replacement releases its unused token;
the physical own-byte lineage remains known, while the renderer keeps dirty/recovery state.

Validation includes 31 backend and 28 renderer regressions, 16 production IPC cases on actual
Windows files, and the existing DWG IPC contract using mock conversion. The actual rebuilt
desktop passes 14 new Open/edit/save/recovery workflows, including real rename overlap and a
public three-sheet project update followed by Undo/Redo and normal Save. The existing seven
2D workflows also pass with this protocol. Native picker answers and controlled private outside
edits are test injections; IPC, codecs, files, backups and recovery are real. Independent native
protocol probes cover 32-save constant retention, failed producers and late hardlink lineages.
These checks do not certify a native DWG converter, installed build, every provider or freedom
from Node's final check-to-rename race.

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

The completed-open milestone subsequently passes 3,546 tests / 28 conditional skips, all three
TypeScript checks, broad lint, fixtures and production build. Its rebuilt desktop passes the
14 new workflows plus the existing seven 2D workflows described above, with production hashes
unchanged and owned processes closed. These are separate from the earlier 33-workflow run.
Nine additional actual Windows checks validate the corrected general-E2E proof/backup harness;
the DWG IPC unit suite explicitly labels POSIX identity protocol doubles and retains real native
Windows checks. Full local general E2E needs a matching native helper, absent in this worktree;
[all four corrected-head CI jobs at 26c9dac pass](https://github.com/habit04/share/actions/runs/38417374158),
including the full Windows Electron workflow. These results precede the export follow-up.

## Direct text and PDF export follow-up

Confirmed old defects used native Windows files and the production main handlers: a delayed
raster PDF could overwrite a newer vector PDF; an older native text picker could obtain a
fresh order after a newer export; text export could overwrite an opened drawing without its
source protection; a retired raster owner could still write. That initial component probe
mocked dialog/hidden PDF conversion and did not establish actual desktop producer behavior.

Generic text and PDF writes now share drawing saves' owner, target ledger, native namespace
and content guards. Text/project intent is captured before the picker. A renderer PDF order
is issued before the Plot options dialog, and the selected output is bound before fonts,
images, compression or raster production. Drawing/resource state is captured after the Plot
choice and before its destination picker, retaining the existing plot-choice timing. Modern
bound output cannot acquire a new ticket or fresh baseline when it arrives at the writer;
legacy payload-only main calls capture before their own picker/conversion. Direct CSV report
commands capture before project reads and report serialization, using the original bridge and
report source snapshots through awaits. Detached report reads release their unused Open proofs
after parsing, including errors, so repeated reports cannot consume live-tab proof capacity.

Native choices are rechecked before grants. Generic exports refuse every active opened-source
alias/hardlink rather than adopting a drawing proof. Every atomic replacement repeats source,
namespace, digest and order checks and returns a one-use verified receipt. Export receipts do
not install renderer drawing aliases, bind a drawing path, clear dirty/history/recovery or mint
opened-source proofs. Obvious empty/all-hidden model plots still skip the destination dialog.
Unverified text replacements report destination review rather than claiming no file was saved.
Project JSON keeps its 8 MiB bound and exact prior backup; ordinary text
keeps the 128 MiB drawing/text ceiling and no automatic backup. Unexpected project extensions
retain their original order while applying project size/backup policy.

PDF payload and queued snapshot ceilings are 512 MiB each; the ordinary queued arena remains
256 MiB, and combined retained payloads are capped at 768 MiB. These are admission budgets,
not estimates of process memory or IPC transfer costs. PDF content pins seal their larger
budget; drawing/source pins cannot request it through the renderer. Cancellation aborts owned
hidden conversion and joins bind/producer/descriptor/writer cleanup. Renderer export cleanup
also joins its sends and receipt handling, including concurrent cancellation/finally calls.

Final local validation passes 3,663 tests / 28 conditional skips, all three TypeScript projects,
lint, fixtures and production build. Export coverage adds 110 regressions and 11 actual Windows
workflows, with real vector/native raster PDFs and controlled dialog/font/conversion timing.
The previous 14 opened-source + seven tracked 2D workflows also pass on that export build.
A subsequent CJS-only plugin-byte repair passes seven additional regressions, 132 targeted
checks, 64/64 unmasked native changed-file refusals and six actual Electron IPC checks; those
app runs are separate snapshots with an unchanged renderer. See `PLUGIN-SOURCE-READS.md`.
All owned processes close and production hashes remain unchanged within each proof.

Native file tests accept an existing PDF above 128 MiB and refuse a real file above 512 MiB
before additional hashing; scratch, arenas and joined descriptor cleanup are checked. Payload
budget tests use reduced limits. Actual desktop PDFs are small; there is no full 512 MiB native
IPC or installed-build claim. Original deadlines/guards remain. Two obsolete source-contract
checks now trace the guarded shared writer and invoke paper validation; the large private file
is joined and emptied before recursive fixture cleanup. Exact-final-head CI must pass before
integration, separately from the earlier green 26c9dac run.
