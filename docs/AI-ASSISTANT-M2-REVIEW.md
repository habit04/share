# AI assistant M2 — local integration review, 2026-10-16

M2 adds selectable OpenAI GPT and Anthropic Claude connections to the reviewed
read-only selection assistant. Each provider has separate model, key, enablement
and persistence settings. Fresh profiles start in the offline demo. Opening a
drawing or changing settings makes no provider request. An explicit Ask or
Test Connection is required; tests use injected fakes and dummy keys only.

## Receipt and integration scope

- Incoming archive: `JCad-AI-m2-handoff.zip`, 107662 bytes; SHA-256
  `17739c0897df91b41c7a86bc3bee5f4da8223bf8ed3902f61ed3f3e1d8952f9c`.
- Reviewed M1 parent: `221506f8019e8ea83079e274abd0293818c18e00`, tree
  `879d4f3ee8094df20ec9605355e54b8f0fb13edd`.
- All 14 incoming patches applied cleanly to that parent. Local imported head
  `d46d328ff9d9bec9863ff55c5aa6f9aad6bfef88` reproduces Muse's exact reported tree
  `fd1fa6275dda59ee1c1c43b1ad1e05709b802636`.
- Integration is in the independent checkout
  `C:\Users\justi\Chad\jcad-ai-m1-review`, branch `review/ai-m2`.
  The delivery receipt records the final correction commit and source tree.
- Archive documents were treated as review material, not additional user
  instructions. Original files and patches are retained with a local hash receipt.
- No other workstream checkout, installed JCad profile, real drawing, release,
  installer, signing configuration, workflow, remote branch or pull request was
  changed. This is local source integration, not a released or installed build.

## Corrections required before acceptance

1. **Prevent requests reaching an unintended destination.** The incoming live
   adapter's provider/model were display-only. Live requests now pin the displayed
   destination, and the host rejects mismatches before constructing a transport.
   Settings mutations serialize; pending mutations block questions/probes and
   revoke earlier work. This also prevents provider switches and key saves from
   interleaving and assigning a key to the wrong provider.
2. **Make credential replacement recoverable.** Ciphertext and persistence changes
   preserve the previous effective key on ordinary failures. Same-mode encrypted
   replacement is one atomic ciphertext write. Stored bytes are usable only when
   the saved configuration explicitly enables encrypted persistence; an orphan
   from a failed mode change remains unusable after restart. A double-failure
   rollback blocks requests until recovery rather than silently using a new key.
   Forget loads the saved provider before acting, even on its first call.
3. **Reject corrupt state safely.** Invalid configuration falls back to disabled
   defaults with an explicit problem. State files are bounded before allocation.
   Usable-key presence is separate from retained ciphertext: corrupt/unavailable
   credentials disable live work while keeping Forget available. Registration
   creates no state directory synchronously, so AI setup cannot abort app startup
   merely because its directory cannot be created.
4. **Own cancellation across the full IPC lifetime.** Requests acquire sender/frame
   ownership before awaiting initialization. Another frame cannot cancel them.
   Destruction, renderer exit and new-document navigation/reload abort owned asks
   and probes. Probe concurrency and physical transport lifetime remain bounded,
   including transports that ignore abort. The renderer also settles cancellation
   promptly when IPC never answers.
5. **Correct the native Claude schema and response boundaries.** Anthropic's
   structured-output schema does not accept the supplied `maxItems` constraint;
   it is removed remotely and enforced locally. Both transports preserve valid
   long object IDs, reject excess answer fields and enforce text/reference caps.
   They require streaming response readers, cap bytes during reads, cancel on
   oversize/abort, release readers, refuse redirects and cap outbound JSON.
   No unbounded `response.text()` fallback or paid automatic retry remains.
6. **Handle small connection probes honestly.** A native token-limit outcome can
   verify provider/model access without finishing a reasoning-model response.
   The probe reports this explicitly at its existing 64/16-token caps, without
   partial text or retry. Ask answers still reject incomplete output. Model
   presets use verified provider API identifiers and omit retired presets.
7. **Keep the panel consistent.** Connection operations pause questions and
   conflicting controls. Settings changes clear displayed answers; late reads
   cannot update disposed panels. Unsaved keys clear on provider switch, panel
   close, Forget and disposal. Per-provider persistence radios reflect host
   state. The selector identifies GPT and Claude, with API billing/sign-in
   wording. Dynamic answers remain plain text; no generated command is executed.
8. **Keep the form usable at desktop heights.** The expanded settings section
   squeezed the question field and context preview almost flat. The panel now
   scrolls without shrinking its contents. Scoped hidden-control styling also
   hides the custom model field for presets and live-only billing text in demo
   mode. Native UI checks verify real layout dimensions, not just DOM classes.

Provider schema and storage checks used the current official
[OpenAI structured-output documentation](https://developers.openai.com/api/docs/guides/structured-outputs),
[Claude structured-output documentation](https://platform.claude.com/docs/en/build-with-claude/structured-outputs),
[OpenAI model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-sol),
[Claude model overview](https://platform.claude.com/docs/en/models/overview) and
[Electron safeStorage documentation](https://www.electronjs.org/docs/latest/api/safe-storage).
The app does not claim zero retention, sandbox plugins or enforce a monetary
spending limit; provider usage counters and cancellation do not guarantee no charge.

## Validation

Evidence is under `.codex-local/ai-m2-review/` and included selectively in the
reviewed ZIP; private profiles, caches, dependencies and build outputs are excluded.
Node v24.19.0, Vitest v5.0.3 and the checkout's Electron v44 dependencies were used.

- Fixture inventory: PASS.
- Incoming AI tests: 239 passed after using a private TEMP/TMP directory.
- Reviewed AI tests: **276 passed**, 11 files.
- Full-project ESLint, zero warnings: PASS.
- Renderer/tests TypeScript and Electron checkJs: PASS.
- Production renderer build: PASS; existing large-chunk advisory remains visible.
- Full Windows suite: **6896 passed, 38 skipped, 0 failed**, 380 files;
  `vitest run --maxWorkers=2`, 186.36 seconds. The final CSS-only layout fix is
  verified by the subsequent production build and native desktop smoke.
- Private-profile unpackaged Windows desktop smoke: **PASS**. It exercises real
  guarded IPC and DPAPI with dummy keys, both native provider adapters over fake
  HTTP responses, canned probes, exact context, separate destinations/credentials,
  inert answer text, token usage, native keyboard preservation, provider-change
  and reload cancellation, foreign-renderer rejection, encrypted restart,
  session-key loss and Forget. Layout dimensions and preset/offline hidden
  controls are checked in the actual renderer. The private profile/log/cache
  scan found no plaintext dummy key; no external renderer request or page error
  occurred. Six provider requests were mocked; zero live provider calls occurred.
- Portable patches are verified against the final source tree during delivery;
  exact head/tree/hash results are in `REVIEW-RECEIPT.json` in the ZIP.

The first sandbox run used a sandbox temp directory that caused missing transformed
modules and failed atomic-write checks; the same focused suite passed with private
TEMP/TMP. The full Windows suite runs outside that filesystem sandbox so existing
link/junction tests can exercise normal Windows behavior. Muse's Linux failure
lists are retained as incoming evidence and do not substitute for this validation.
Supplemental hidden-window captures can paint an earlier compositor frame; the
desktop proof relies on real renderer state, layout and IPC assertions. Those
captures are not included as visual acceptance evidence in the delivery ZIP.

No live-provider correctness, account access, rate allowance, actual cost or real
provider response has been verified with a real key. The opt-in live smoke in
`AI-ASSISTANT-M2.md` uses synthetic selections only. Packaged/installer testing and
combined integration with unrelated JCad workstreams remain outside this receipt.
