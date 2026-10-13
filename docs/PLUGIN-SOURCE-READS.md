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

API v1 still executes trusted page code with page/bridge access. A trust hash and error handling
do not enforce capabilities. Stale same-name load/lifecycle and disposed-API issues are separate
confirmed follow-up defects. Full capability isolation requires a separate execution realm,
validated host RPC, explicit compatibility/migration and actual denied-operation tests.
