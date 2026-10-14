# GPU integration handoff

The final combined candidate is owned by the **JCad 2D and reliability updates**
session (01a13308-2b7e-7e30-b0df-be06e79d84ce). This session owns the frozen
GPU leaf and its validation. The user authorized coordination and deliberate
integration on October 13, 2026. New GPU coverage stops after the current DIM gate.

## Candidate and ancestry

- Draft [PR #16](https://github.com/habit04/share/pull/16), branch
  feature/windows-gpu-compound-coverage, last fully green published source
  0423d095d50b1a9755c5f398d6708a5742604ebd. The frozen native-gate implementation
  is020b97da2118d4b8bc19177dfffd2ff2faebff9c.
- This leaf includes the PR #10/#12/#13/#14/#15 GPU stack, merged stable
  8dfe1caa (Windows v0.4.9), and only the pinned older PR #11 batch 3ce7e10a.
  Integrate the verified leaf once; preserve the integration owner's newer
  PR #11 work. Do not replay contained ancestor PR commits separately.
- The permanent DIM gate is committed at020b97da; all ten local checks pass
  (3,602tests/28conditional skips) and all78 Node harness tests pass. Final
  combined native/CI acceptance is still pending; no later feature work is started.

## Completed evidence

- Source 0423: all ten required local checks; 3,590 tests and 28 conditional skips;
  all three TypeScript projects, full lint, fixtures/workflows and both builds.
  All 61 Node harness tests and five native Windows preflights pass.
- Current source focused DIM evidence on actual Intel UHD and NVIDIA RTX A3000:
  each passed all five supported kinds, 29 comparisons, 12 visible edit/history
  transitions, five original exact-Canvas/zero-submission controls, fixed
  filled-arrow/color/order checks and first automatic context restoration.
  Actual private edited DXF Save As/IPC/Open passed with an independent original
  pre-save Canvas comparison of zero raw pixel differences. Native anchor
  re-materialization is explicitly field-specific; raw source equality is not claimed.
- Full native benchmark checkpoint 86e40da5 passed the original 32 workloads and
  permanent 40-case hatch gate on both adapters. Its first PR and push CI attempts
  passed all five jobs. See GPU-ROADMAP.md and the bound hatch record.
- Source0423 passed all five jobs on both first PR/push attempts
  (38491347075/38491341130). DIM was not wired into those CI producers; the final
  native-gate source requires its own combined benchmark and CI.

## Required before final handoff and merge

1. Completed: adopt the bounded DIM native gate and regressions; freeze new feature work.
2. Pass the required clean-source checks, existing native hardware benchmark
   and exact final-source CI, retaining all original assertions and fixtures.
3. The final integration owner resolves the strict DWG creation-date dependency,
   integrates the verified GPU leaf and embedded 3D head a4d5526380c844a93821fd7d61317856c715e5cb,
   and validates the combined source before merging. Shared text/layout/codec
   changes require fresh combined checks; earlier branch passes do not certify it.

Canvas stays the default. This is experimental development integration, not
production GPU completion. Broad hardware/performance/default-switch acceptance
is separately documented in GPU-ROADMAP.md. The GPU demo is distinct from the full
embedded 3D branch. Release publishing, installer creation/installation and
signing changes are outside this handoff.
