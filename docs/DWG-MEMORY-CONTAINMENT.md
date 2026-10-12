# Desktop DWG memory containment

Desktop DWG reads run in a separate Electron utility process. Each process owns one worker that
loads LibreDWG, parses one input and returns a bounded result. After success, cancellation or
failure, the process exits before the next starts. A parser allocation failure or V8 fatal error
therefore has a recovery boundary outside the application's main process.

This is resource containment and crash recovery. The Node utility has ordinary application
permissions; it is not an OS capability sandbox for executing hostile extensions.

## Limits

| Resource | Desktop policy | Enforcement |
| --- | --- | --- |
| DWG input | 128 MiB per file | Check before acceptance and before parser use |
| Pending reads | Four total active and queued | Bounded host queue; only one process can parse |
| Reserved input | 128 MiB across accepted active and queued reads | Reserve before retaining a request |
| WASM linear memory | Shipped initial allocation 1 GiB; maximum 2 GiB | Restrict the sole defined, unshared wasm32 memory declaration before instantiation |
| Parser V8 heap/stack | 512 MiB old generation, 64 MiB young generation, 8 MiB stack | Inner worker `resourceLimits` |
| OS process memory | Abort at a sampled 3 GiB threshold | Parent samples every 100 ms; maximum of resident, peak resident and Windows private memory |
| Serialized result | 64 MiB | Bound V8-serialized bytes before parent-side reconstruction |
| Transport frame | 1 MiB | Acknowledge each input/output frame before sending the next |
| Startup | 15 seconds | Host deadline |
| Parsing | 60 seconds plus one second per input MiB | Host deadline; maximum 188 seconds for accepted files |

Input size alone does not predict decoded size. A valid drawing below 128 MiB may still exceed
the heap, result or work limits and be refused. Its original file and current drawing remain
untouched, and another file can be opened afterward.

The WASM policy checks the binary before native allocation and rejects an initial allocation
above the bound. It restricts growth initiated through JavaScript and direct WASM `memory.grow`
instructions because the engine enforces the module's maximum. Unexpected imported, shared,
multiple-memory or non-wasm32 modules fail validation rather than weakening the policy. The
runtime changes a checked in-memory copy; the committed vendor factory/WASM artifacts remain
available for their existing source/hash provenance checks.

The parent starts its memory watchdog before permitting LibreDWG initialization. Readiness
requires a valid OS measurement for the spawned utility PID. Its creation time binds future
measurements to the same process identity. Missing or invalid measurements fail closed after a
short startup grace during which parsing is prohibited. The watchdog continues observing the
process while native parsing blocks the child JavaScript event loop. Its OS memory figures are
reported by Electron in KiB and converted to bytes; overlapping figures are compared, not added.

Electron utility-process heap flags are not relied upon as the heap enforcement mechanism.
The V8 resource limits belong to the inner worker. Production uses Electron's utility process;
Node-only adapters for source tests or CLI use do not substitute for packaged runtime evidence.

## Validation

`tests/dwg-process-limits.test.ts` verifies the startup gate, measurement units, external/private
and peak memory, PID reuse, lost/malformed measurements, threshold failures and cleanup using
deterministic timers. `tests/dwg-wasm-memory.test.ts` checks memory-declaration rejection and
engine growth bounds. Host tests verify deadlines, queue/transport limits, cancellation and
recovery after a failed read; actual DWG fixtures verify that supported reads still return data.

`npm run check:dwg-containment` launches an unpackaged Electron main with actual utility processes
and OS measurements. On Linux, run it under `xvfb-run -a` when no display is available. Its five
required cases cover a real DWG read, immediate startup cancellation, damaged input, native
Buffer growth while the utility event loop is blocked, and an inner-worker V8 heap failure.
Every failure case is followed by another successful real read. The native-allocation case uses
an acknowledged test parser transport and a reduced injected watchdog threshold so that it can
exercise recovery without consuming the production 3 GiB budget; the actual OS metric guard and
host lifecycle are unchanged. The heap case checks the real inner-worker resource-limit API
with a 16 MiB test heap, rather than pretending utility `execArgv` flags enforce it.

The launcher creates a fresh bounded temporary fixture, validates the report belongs to that
run, enforces runtime/output deadlines and removes only its generated temporary directory.
It writes `e2e-output/dwg-containment.json` with process IDs, observed memory, heartbeat counts
and case results. The probe scripts are excluded from application packaging.

Before publishing, the exact release source must pass both the unpackaged containment probe
and separate installed/extracted binary checks on Windows, Linux, Intel Mac and Apple Silicon Mac.
These provide different evidence:

- The unpackaged probe forces a blocked child's native-memory threshold failure and an
  inner-worker heap failure on the actual OS and pinned Electron version. It confirms external
  observations, a responsive parent, process cleanup and subsequent successful reads. Its
  reduced thresholds and synthetic allocation code are source-test inputs.
- The installed application's fixed `--probe-dwg <fixture>` sequence reads a real drawing,
  cancels a pending read, rejects a malformed eight-byte input and reopens the real drawing.
  The reopened version/entity/block counts must match the initial read. Its success output
  includes `isolated=1 recovery=1`, required by the packaged smoke policy from v0.4.5 onward.
  This exercises the production utility API, initial OS measurement gate, enforced worker heap
  policy, WASM imports and process recovery with the shipped ASAR/fuses/signature configuration.

The shipping sequence does not force native-memory or heap exhaustion in the installed binary.
Report those forced-failure cases as unpackaged Electron evidence, alongside the separate
shipping read/cancel/malformed-input/reopen evidence. No arbitrary allocation test entry point
or synthetic parser code is added to the distributed application. Test cleanup must stop only
the processes it created, and release artifacts must not retain private customer drawings.

Record workflow links and their exact tested commits in the pull request/release. This document
describes the implemented policy; passing source tests do not stand in for installer results.

## Remaining limits

The 3 GiB threshold is sampled, not an OS-enforced allocation cap. An allocation can exceed it
between observations, and the main process's own scheduling can delay an observation. On
platforms without Windows private-memory figures, the watchdog observes resident memory rather
than all virtual reservations. Severe system-wide memory pressure may affect other processes
before the watchdog runs. The engine-enforced WASM bound applies to the reader's one linear
memory, not all native allocations, JavaScript objects or reconstructed drawing data.

The bounded result prevents unlimited cross-process cloning; it does not make parsing or
renderer conversion free of allocations. Once accepted, normal drawing geometry/work budgets
still apply when the renderer converts and validates the result.

The browser edition retains its separate cancellable-worker policy of 128 MiB input and a
60-second deadline. This desktop change does not establish browser heap limits, browser process
isolation or a browser WASM maximum.

API references: [Electron memory information](https://www.electronjs.org/docs/latest/api/structures/memory-info),
[process identity and metrics](https://www.electronjs.org/docs/latest/api/structures/process-metric),
and [utility-process lifecycle](https://www.electronjs.org/docs/latest/api/utility-process).
