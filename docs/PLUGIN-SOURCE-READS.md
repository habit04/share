# Plugin source read reliability

Plugin manifest/code reads now use bounded held descriptors and independently validate the
canonical plugins root, file identity and paths before/after reading. Code remains limited to
2 MiB and manifests to 64 KiB. Source growth, shrinking, same-size modification, replacement,
escape and junction retargets refuse loading. Exact canonical spelling avoids Windows Unicode
folding that could treat distinct NTFS siblings as the same authorized directory.

Stable aliases inside the plugins root, logical source paths, trust hashes and API v1 behavior
are retained. No new filesystem grants are created. Ninety plugin/API/IPC/resource regressions,
type checks and scoped lint pass. Actual production IPC callback/native NTFS reproductions now
reject outside code; Electron/app-data dependencies are substituted in those callback tests,
so this is not a live Electron plugin installation proof.

Plugin lifecycle handles now revoke after synchronous unload hooks. Stale loads, confirmations
and disk reloads cannot overwrite or resurrect a newer entry. Owned prompts, dialogs and file
pickers cancel; retained callbacks/cleanup handles cannot affect newer plugins. Nested edits
roll back when their owner unloads, including return-value getters and hostile error formatting.
Already-issued external writes can only have their results suppressed. The lifecycle milestone
passed 153 targeted checks and 11 actual Chrome source/DOM checks, then independent review.

API v1 still executes trusted page code with page/bridge access. A trust hash and error handling
do not enforce capabilities. Full capability isolation requires a separate execution realm,
validated host RPC, explicit compatibility/migration and actual denied-operation tests.
