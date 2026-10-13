# Plugin source read reliability

Plugin manifest/code reads now use bounded held descriptors and independently validate the
canonical plugins root, file identity and paths before/after reading. A fresh explicit-position
pass compares every captured raw byte through the same held descriptor, using at most 64 KiB
scratch memory. Original EOF, file/version, root and canonical-path checks repeat afterward.
Code remains limited to 2 MiB and manifests to 64 KiB. Source growth, shrinking, same-size modification, replacement,
escape and junction retargets refuse loading. Exact canonical spelling avoids Windows Unicode
folding that could treat distinct NTFS siblings as the same authorized directory.

Stable aliases inside the plugins root, logical source paths, trust hashes and API v1 behavior
are retained. No new filesystem grants are created. Ninety plugin/API/IPC/resource regressions,
type checks and scoped lint pass. Actual production IPC callback/native NTFS reproductions now
reject outside code; Electron/app-data dependencies are substituted in those callback tests,
so this is not a live Electron plugin installation proof.

The #24 final-gate audit exposed a native timestamp collision in the older stat-only reader.
An independent 64-trial Windows probe accepted changed bytes in all 25 genuine collisions
of dev/ino/size/mtimeNs/ctimeNs (14 manifests, 11 code files). The repaired identical harness
refuses all 64 edits, including 38 genuine unmasked collisions; every descriptor closes.
Deterministic actual-byte/fixed-stat regressions separately cover both files, invalid UTF-8
bytes decoding to the same string, partial reads, EOF growth and verification cleanup.
The six targeted plugin/API/IPC/resource suites pass 132 tests without weakened assertions.

Six actual source-Electron IPC checks additionally verify exact 64 KiB/2 MiB boundaries,
oversize refusal and real changed manifest/code bytes under deliberately masked stat
observations. Drawing/history/selection/dirty/trust state remains unchanged; all source/bundle
hashes remain fixed and the owned app closes. These masked app checks and the unmasked native
component trials are distinct evidence. No plugin body, installer or capability sandbox was
created or executed by these checks. A last OS check-to-use race remains possible.

Plugin lifecycle handles now revoke after synchronous unload hooks. Stale loads, confirmations
and disk reloads cannot overwrite or resurrect a newer entry. Owned prompts, dialogs and file
pickers cancel; retained callbacks/cleanup handles cannot affect newer plugins. Nested edits
roll back when their owner unloads, including return-value getters and hostile error formatting.
Already-issued external writes can only have their results suppressed. The lifecycle milestone
passed 153 targeted checks and 11 actual Chrome source/DOM checks, then independent review.

API v1 still executes trusted page code with page/bridge access. A trust hash and error handling
do not enforce capabilities. Full capability isolation requires a separate execution realm,
validated host RPC, explicit compatibility/migration and actual denied-operation tests.
